// Fila (comunicacao_mensagens) — I/O puro. O claim é ATÔMICO via a função
// SQL `comunicacao_claim_mensagens` (migration 082) — nunca um
// "SELECT depois UPDATE" feito em dois passos do Node (ver o comentário da
// migration para o motivo).
//
// CLAIM × ATTEMPT + FENCING (D.3-B/R, migration 087). Duas identidades:
//   CLAIM   = quem pode processar a linha agora  -> token `claim_geracao` (+1 no claim).
//   ATTEMPT = qual execução chegou à fronteira de envio -> `tentativas`, que só
//             sobe em `iniciarEnvio` (PROCESSING -> SENDING). Um adiamento gera
//             um claim e ZERO attempts.
// TODA transição DEPOIS do claim é uma função SQL compare-and-set: as de
// PROCESSING exigem (claimed_by, claim_geracao); as de SENDING exigem também o
// attempt (tentativas). Cada uma devolve a linha atualizada, ou `null` quando o
// worker PERDEU A POSSE (outro claim, lease expirado, estado diferente).
// `null` significa: ABORTAR — nunca enviar, nunca finalizar. Não existe mais
// nenhum UPDATE de estado "por id" para o worker (ver
// test/comunicacao-arquitetura-fencing.test.js).

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { STATUS_MENSAGEM, CANAIS, DIRECAO, RESULTADO_FINAL_ENVIO, DESTINO_SEM_ENVIO } from "./comunicacao.constants.js";
import * as tentativasRepo from "./comunicacao.tentativas.repo.js";

/** Estados que CONSOMEM cooldown/capacidade: já saiu, pode ter saído (UNKNOWN) ou está saindo (SENDING). */
const STATUS_CONSUMO = [
  STATUS_MENSAGEM.SENDING, STATUS_MENSAGEM.SENT, STATUS_MENSAGEM.DELIVERED,
  STATUS_MENSAGEM.READ, STATUS_MENSAGEM.DELIVERY_UNKNOWN,
];

/** Chama uma RPC `setof comunicacao_mensagens` e devolve a 1ª linha, ou `null` (= 0 linhas = perdeu a posse). */
async function rpcFenced(db, nome, args) {
  const { data, error } = await db.rpc(nome, args);
  if (error) throw ApiError.internal(error.message);
  return Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
}

/**
 * Agenda uma mensagem de saída. IDEMPOTENTE por `idempotencyKey`: se a
 * chave já existir, devolve a linha EXISTENTE em vez de criar uma nova —
 * um retry da mesma chamada de agendamento nunca duplica o envio lógico.
 * @param {{
 *   alertaId?: string|null, organizacaoId: string, unidadeId?: string|null,
 *   contatoId: string, destinatarioPerfilId?: string|null,
 *   tipo: string, conteudo: string, idempotencyKey: string,
 *   disponivelEm: Date, maxTentativas?: number,
 * }} params
 */
export async function agendarMensagem(params, deps = {}) {
  const db = deps.supabase ?? supabase;
  const existente = await db.from("comunicacao_mensagens")
    .select("*").eq("idempotency_key", params.idempotencyKey).maybeSingle();
  if (existente.error) throw ApiError.internal(existente.error.message);
  if (existente.data) return existente.data;

  const linha = {
    alerta_id: params.alertaId ?? null,
    organizacao_id: params.organizacaoId,
    unidade_id: params.unidadeId ?? null,
    contato_id: params.contatoId,
    destinatario_perfil_id: params.destinatarioPerfilId ?? null,
    canal: CANAIS.WHATSAPP,
    direcao: DIRECAO.SAIDA,
    tipo: params.tipo,
    conteudo: params.conteudo,
    idempotency_key: params.idempotencyKey,
    status: STATUS_MENSAGEM.SCHEDULED,
    disponivel_em: params.disponivelEm.toISOString(),
    max_tentativas: params.maxTentativas ?? 5,
  };
  const { data, error } = await db.from("comunicacao_mensagens").insert(linha).select("*").single();
  if (error) {
    // corrida: outro processo agendou com a MESMA chave entre o SELECT e o INSERT.
    if (String(error.code) === "23505") {
      const r = await db.from("comunicacao_mensagens").select("*").eq("idempotency_key", params.idempotencyKey).single();
      if (!r.error) return r.data;
    }
    throw ApiError.internal(error.message);
  }
  return data;
}

/**
 * Reivindica até `limite` mensagens elegíveis, ATOMICAMENTE (ver migration
 * 082 — FOR UPDATE SKIP LOCKED numa função só). Duas chamadas concorrentes
 * NUNCA reivindicam a mesma linha. Também recupera jobs PROCESSING cujo
 * lease anterior expirou (worker que morreu antes de tentar o envio —
 * seguro reivindicar de novo). Concede um novo lease de `leaseSegundos`.
 * Cada claim incrementa `claim_geracao` (o token do CLAIM) e NÃO consome
 * attempt: `tentativas` continua como estava. NUNCA devolve SENDING nem
 * DELIVERY_UNKNOWN.
 * @param {{limite: number, worker: string, leaseSegundos?: number}} params
 */
export async function claimJobs({ limite, worker, leaseSegundos = 120 }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.rpc("comunicacao_claim_mensagens", {
    p_limite: limite, p_worker: worker, p_lease_segundos: leaseSegundos,
  });
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

/**
 * FRONTEIRA ANTES DO PROVIDER — aqui NASCE o ATTEMPT. PROCESSING -> SENDING,
 * incrementando `tentativas`, só se este worker ainda é o dono do CLAIM (mesmo
 * `claimed_by` + `claim_geracao`, lease válido no relógio do BANCO, estado
 * ainda PROCESSING, tentativas não esgotadas). Devolve a linha em SENDING —
 * seu `tentativas` é o número do attempt recém-criado —, ou `null` = perdeu a
 * posse -> o provider NÃO pode ser chamado. Concede um lease novo para o envio.
 * @param {{id: string, worker: string, claimGeracao: number, leaseSegundos?: number}} params
 */
export async function iniciarEnvio({ id, worker, claimGeracao, leaseSegundos = 90 }, deps = {}) {
  const db = deps.supabase ?? supabase;
  return rpcFenced(db, "comunicacao_iniciar_envio", {
    p_id: id, p_worker: worker, p_claim_geracao: claimGeracao, p_lease_segundos: leaseSegundos,
  });
}

/**
 * Grava o resultado de um envio já tentado, só para o DONO do attempt
 * (`claimGeracao` + `tentativa`).
 *  - SENT              SENDING (ou confirmação TARDIA sobre DELIVERY_UNKNOWN do mesmo attempt)
 *  - DELIVERY_UNKNOWN  SENDING -> "não sei se saiu" (nunca retry automático)
 *  - FAILED            SENDING -> falha definitiva
 *  - RETRY             SENDING -> SCHEDULED com backoff (só p/ falha PRÉ-ENVIO comprovada);
 *                      esgotada a política de retries (tentativas >= max) vira FAILED
 * `null` = perdeu a posse (callback atrasado / attempt antigo): NADA foi sobrescrito.
 * @param {{id: string, worker: string, claimGeracao: number, tentativa: number, resultado: keyof typeof RESULTADO_FINAL_ENVIO, providerMessageId?: string|null, erro?: string|null, retryAposSegundos?: number|null}} params
 */
export async function finalizarEnvio({ id, worker, claimGeracao, tentativa, resultado, providerMessageId = null, erro = null, retryAposSegundos = null }, deps = {}) {
  if (!Object.values(RESULTADO_FINAL_ENVIO).includes(resultado)) {
    throw ApiError.internal(`finalizarEnvio: resultado inválido (${resultado})`);
  }
  const db = deps.supabase ?? supabase;
  return rpcFenced(db, "comunicacao_finalizar_envio", {
    p_id: id, p_worker: worker, p_claim_geracao: claimGeracao, p_tentativa: tentativa, p_resultado: resultado,
    p_provider_message_id: providerMessageId, p_erro: erro, p_retry_apos_segundos: retryAposSegundos,
  });
}

/**
 * Sai de PROCESSING SEM enviar, só para o dono do CLAIM: BLOCKED (veto
 * PERMANENTE de política), CANCELLED, FAILED ou SCHEDULED (ADIAMENTO de
 * condição transitória — `disponivel_em` mínimo +1min; NÃO consome attempt).
 * `null` = perdeu a posse.
 * @param {{id: string, worker: string, claimGeracao: number, destino: keyof typeof DESTINO_SEM_ENVIO, motivo?: string|null, disponivelEm?: Date|null}} params
 */
export async function encerrarProcessamento({ id, worker, claimGeracao, destino, motivo = null, disponivelEm = null }, deps = {}) {
  if (!Object.values(DESTINO_SEM_ENVIO).includes(destino)) {
    throw ApiError.internal(`encerrarProcessamento: destino inválido (${destino})`);
  }
  const db = deps.supabase ?? supabase;
  return rpcFenced(db, "comunicacao_encerrar_processamento", {
    p_id: id, p_worker: worker, p_claim_geracao: claimGeracao, p_destino: destino,
    p_motivo: motivo, p_disponivel_em: disponivelEm ? disponivelEm.toISOString() : null,
  });
}

/**
 * Move para DELIVERY_UNKNOWN toda mensagem SENDING cujo lease expirou sem
 * resolução — via a RPC dedicada (migration 082), nunca via UPDATE direto
 * do Node (mantém a decisão no mesmo lugar que audita/documenta a regra).
 * NUNCA chamada pelo caminho normal de claim — só por uma varredura
 * explícita. Fecha também, como DELIVERY_UNKNOWN, o attempt que ficou aberto
 * em comunicacao_tentativas (best-effort: é só trilha de auditoria).
 * @param {{worker: string}} params
 */
export async function expirarEntregasIncertas({ worker }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.rpc("comunicacao_expirar_entregas_incertas", { p_worker: worker });
  if (error) throw ApiError.internal(error.message);
  const linhas = data ?? [];
  for (const m of linhas) {
    try {
      await tentativasRepo.fecharComoIncerta({ mensagemId: m.id, tentativaNumero: m.tentativas, erroSanitizado: "lease expirou durante o envio (varredura)" }, deps);
    } catch { /* trilha de auditoria — nunca impede a varredura */ }
  }
  return linhas;
}

/**
 * Cancela as mensagens AINDA NÃO REIVINDICADAS (SCHEDULED) de um alerta
 * (ex.: pendência resolvida). Já é guardado por estado (`status =
 * SCHEDULED`): nunca toca uma linha que um worker segura. A linha que o
 * worker atual segura é cancelada por `encerrarProcessamento`, com token.
 */
export async function cancelarPendentesPorAlerta(alertaId, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_mensagens")
    .update({ status: STATUS_MENSAGEM.CANCELLED })
    .eq("alerta_id", alertaId).eq("status", STATUS_MENSAGEM.SCHEDULED)
    .select("id");
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

/**
 * Conta mensagens de SAÍDA que CONSOMEM capacidade desde `desdeIso`: as que
 * já saíram (SENT/DELIVERED/READ), as que estão saindo (SENDING) e as que
 * PODEM ter saído (DELIVERY_UNKNOWN — até serem reconciliadas, tratá-las
 * como "não enviadas" permitiria mandar de novo algo que talvez já chegou).
 * PROCESSING NÃO conta: nenhum efeito externo foi decidido ainda (e o job em
 * avaliação é o próprio PROCESSING). Limitação conhecida — dois workers em
 * paralelo avaliando contatos iguais antes de qualquer um chegar a SENDING;
 * mitigada por worker único (concorrência 1) e endereçada no D.3-D.
 */
function consumoDesde(query, desdeIso) {
  return query
    .eq("direcao", DIRECAO.SAIDA)
    .in("status", STATUS_CONSUMO)
    .or(`enviado_em.gte.${desdeIso},entrega_incerta_em.gte.${desdeIso},and(status.eq.${STATUS_MENSAGEM.SENDING},claimed_at.gte.${desdeIso})`);
}

/**
 * COOLDOWN: quantas mensagens de SAÍDA deste tipo para este contato impedem
 * uma nova agora. Conta por `tipo` (não por `alertaId`) porque o cooldown é
 * "não repita este TIPO de aviso para este contato tão cedo".
 *   - SENT/DELIVERED/READ: só dentro das últimas `janelaHoras`;
 *   - SENDING e DELIVERY_UNKNOWN: SEM limite de tempo enquanto não
 *     reconciliadas — "pode ter saído" não expira com o relógio; liberar o
 *     cooldown por passagem de tempo permitiria repetir algo que talvez já chegou.
 * @param {{contatoId: string, tipo: string, janelaHoras: number}} params
 */
export async function contarEnviosRecentes({ contatoId, tipo, janelaHoras }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const desde = new Date(Date.now() - janelaHoras * 3600_000).toISOString();
  const { count, error } = await db.from("comunicacao_mensagens")
    .select("id", { count: "exact", head: true })
    .eq("contato_id", contatoId).eq("tipo", tipo).eq("direcao", DIRECAO.SAIDA)
    .or(`status.in.(${STATUS_MENSAGEM.SENDING},${STATUS_MENSAGEM.DELIVERY_UNKNOWN}),and(status.in.(${STATUS_MENSAGEM.SENT},${STATUS_MENSAGEM.DELIVERED},${STATUS_MENSAGEM.READ}),enviado_em.gte.${desde})`);
  if (error) throw ApiError.internal(error.message);
  return count ?? 0;
}

/** Quantas mensagens SAÍDA consumiram capacidade para este contato hoje (para o limite `max_por_contato_por_dia`). */
export async function contarEnviosHoje({ contatoId }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const inicioDoDia = new Date(); inicioDoDia.setHours(0, 0, 0, 0);
  const { count, error } = await consumoDesde(
    db.from("comunicacao_mensagens").select("id", { count: "exact", head: true }).eq("contato_id", contatoId),
    inicioDoDia.toISOString(),
  );
  if (error) throw ApiError.internal(error.message);
  return count ?? 0;
}

/** Quantas mensagens proativas consumiram capacidade no último minuto (para o limite `max_proativas_por_minuto`). */
export async function contarEnviosProativosUltimoMinuto(deps = {}) {
  const db = deps.supabase ?? supabase;
  const desde = new Date(Date.now() - 60_000).toISOString();
  const { count, error } = await consumoDesde(
    db.from("comunicacao_mensagens").select("id", { count: "exact", head: true }),
    desde,
  );
  if (error) throw ApiError.internal(error.message);
  return count ?? 0;
}

/**
 * Existe alguma mensagem ATIVA equivalente (mesmo alerta)? Base da checagem
 * de duplicidade. "Ativa" inclui SENDING e DELIVERY_UNKNOWN: uma mensagem
 * que pode já ter saído (ou está saindo) NÃO libera criar outra igual.
 */
export async function existeEnvioAtivoParaAlerta(alertaId, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_mensagens")
    .select("id").eq("alerta_id", alertaId)
    .in("status", [
      STATUS_MENSAGEM.SCHEDULED, STATUS_MENSAGEM.PROCESSING, STATUS_MENSAGEM.SENDING,
      STATUS_MENSAGEM.SENT, STATUS_MENSAGEM.DELIVERY_UNKNOWN,
    ])
    .limit(1);
  if (error) throw ApiError.internal(error.message);
  return (data ?? []).length > 0;
}
