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
import { STATUS_MENSAGEM, CANAIS, DIRECAO, RESULTADO_FINAL_ENVIO, DESTINO_SEM_ENVIO, RESULTADO_RESERVA } from "./comunicacao.constants.js";
import * as tentativasRepo from "./comunicacao.tentativas.repo.js";
import { PROPOSITO, propositoDaMensagem, chaveIdempotenciaInicial, chaveIdempotenciaReforco } from "./comunicacao.reforco.js";

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
 *   disponivelEm: Date, expiraEm?: Date|null, maxTentativas?: number,
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
    expira_em: params.expiraEm ? params.expiraEm.toISOString() : null,
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
 * ATOMICIDADE alerta -> mensagem (migration 088): cria a mensagem (idempotente pela
 * `idempotencyKey`) E move o alerta DETECTED -> SCHEDULED na MESMA transação do
 * banco — ou os dois, ou nada. Uma falha no meio não deixa alerta órfão (SCHEDULED
 * sem mensagem) nem mensagem sem alerta atualizado. Repetir a chamada N vezes gera
 * no máximo UMA mensagem por chave.
 *
 * O DESTINATÁRIO NÃO É PARÂMETRO: o banco o lê da habilitação da organização do alerta
 * (`comunicacao_habilitacoes.destinatario_*`, configurado explicitamente) e recusa se
 * ausente/inelegível. Ninguém aqui escolhe "o primeiro contato".
 *
 * Resultado (`acao`): CRIADA | JA_EXISTIA | ALERTA_NAO_DETECTED | ENTREGA_DESCONHECIDA
 * (já existe SENDING/DELIVERY_UNKNOWN do alerta: nada novo até reconciliar) |
 * MENSAGEM_EXPIRADA (a mensagem deste evento já expirou: NÃO recria — lembrete/nova
 * versão exige regra explícita) | NAO_HABILITADA | TIPO_NAO_PERMITIDO | SEM_DESTINATARIO |
 * DESTINATARIO_INELEGIVEL | CHAVE_EM_USO | ALERTA_INEXISTENTE.
 * @param {{alertaId: string, tipo: string, conteudo: string, idempotencyKey: string, disponivelEm: Date, expiraEm?: Date|null, maxTentativas?: number}} params
 * @returns {Promise<{acao: string, mensagem_id?: string, status?: string, status_alerta?: string}>}
 */
export async function agendarMensagemDoAlerta(params, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.rpc("comunicacao_agendar_mensagem_alerta", {
    p_alerta_id: params.alertaId,
    p_tipo: params.tipo, p_conteudo: params.conteudo, p_idempotency_key: params.idempotencyKey,
    p_disponivel_em: params.disponivelEm.toISOString(),
    p_expira_em: params.expiraEm ? params.expiraEm.toISOString() : null,
    p_max_tentativas: params.maxTentativas ?? 5,
  });
  if (error) throw ApiError.internal(error.message);
  if (!data || typeof data.acao !== "string") throw ApiError.internal("comunicacao_agendar_mensagem_alerta: resposta inválida");
  return data;
}

/**
 * Agenda o ÚNICO reforço de um alerta cujo 1º aviso já saiu (migration 092). Espelha
 * `agendarMensagemDoAlerta` (mesma atomicidade); as checagens vivem só no banco.
 * Resultado (`acao`): CRIADA | JA_EXISTIA | ALERTA_INEXISTENTE | CHAVE_INVALIDA | CHAVE_EM_USO |
 * ALERTA_SEM_PRIMEIRO_ENVIO | PRIMEIRA_MENSAGEM_NAO_ENVIADA | ENTREGA_EM_CURSO | NAO_HABILITADA |
 * TIPO_NAO_PERMITIDO | SEM_DESTINATARIO | DESTINATARIO_INELEGIVEL.
 * @param {{alertaId: string, conteudo: string, disponivelEm: Date, expiraEm?: Date|null, maxTentativas?: number}} params
 */
export async function agendarReforcoDoAlerta(params, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.rpc("comunicacao_agendar_reforco_alerta", {
    p_alerta_id: params.alertaId, p_conteudo: params.conteudo,
    p_idempotency_key: chaveIdempotenciaReforco(params.alertaId),
    p_disponivel_em: params.disponivelEm.toISOString(),
    p_expira_em: params.expiraEm ? params.expiraEm.toISOString() : null,
    p_max_tentativas: params.maxTentativas ?? 5,
  });
  if (error) throw ApiError.internal(error.message);
  if (!data || typeof data.acao !== "string") throw ApiError.internal("comunicacao_agendar_reforco_alerta: resposta inválida");
  return data;
}

/**
 * Agenda o PRIMEIRO aviso tardio D-1 (migration 094): a 1ª mensagem do alerta (chave `wa:alerta:{id}:v1`,
 * `proposito=inicial`, `origem=prazo_final_d1`). As checagens (tipo, DETECTED, nenhuma inicial, habilitação,
 * destinatário) vivem só no banco. Resultado (`acao`): CRIADA | JA_EXISTIA | MENSAGEM_EXPIRADA | INICIAL_JA_EXISTE |
 * ENTREGA_EM_CURSO | ALERTA_NAO_DETECTED | NAO_HABILITADA | TIPO_NAO_PERMITIDO | SEM_DESTINATARIO |
 * DESTINATARIO_INELEGIVEL | TIPO_NAO_SUPORTADO | CHAVE_INVALIDA | CHAVE_EM_USO | ALERTA_INEXISTENTE.
 * @param {{alertaId: string, conteudo: string, disponivelEm: Date, expiraEm?: Date|null, maxTentativas?: number}} params
 */
export async function agendarAvisoTardioD1(params, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.rpc("comunicacao_agendar_aviso_tardio_d1", {
    p_alerta_id: params.alertaId, p_conteudo: params.conteudo,
    p_idempotency_key: chaveIdempotenciaInicial(params.alertaId),
    p_disponivel_em: params.disponivelEm.toISOString(),
    p_expira_em: params.expiraEm ? params.expiraEm.toISOString() : null,
    p_max_tentativas: params.maxTentativas ?? 5,
  });
  if (error) throw ApiError.internal(error.message);
  if (!data || typeof data.acao !== "string") throw ApiError.internal("comunicacao_agendar_aviso_tardio_d1: resposta inválida");
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
 * FRONTEIRA ANTES DO PROVIDER, com RESERVA ATÔMICA de capacidade (migration 088):
 * sob um advisory lock, no MESMO banco/transação, verifica posse (token do claim),
 * TTL (`expira_em`, relógio do BANCO), cooldown (organização+unidade+tipo), cota
 * diária do contato e DUAS camadas de taxa por minuto — por ORGANIZAÇÃO (fairness) e GLOBAL
 * (o único número/sessão) — e, só se TODAS passam, faz PROCESSING -> SENDING (o ATTEMPT
 * nasce aqui). Dois workers nunca avaliam a capacidade sobre o mesmo estado: o segundo
 * enxerga o SENDING do primeiro.
 *
 * Resultado: INICIADO (+ `mensagem` = linha em SENDING; seu `tentativas` é o attempt) |
 * POSSE_PERDIDA | EXPIRADA | COOLDOWN | RATE_LIMIT_DIA | RATE_LIMIT_MINUTO_ORGANIZACAO |
 * RATE_LIMIT_MINUTO (global). Fora de INICIADO o provider NÃO pode ser chamado.
 * CONSOME capacidade: SENDING, SENT, DELIVERED, READ e DELIVERY_UNKNOWN. NÃO consome:
 * SCHEDULED, PROCESSING, CANCELLED, BLOCKED e FAILED (rejeição definitiva/comprovadamente
 * não enviada: nenhuma mensagem saiu do número).
 * Substitui `iniciarEnvio` no pipeline (que continua existindo, sem a reserva).
 * @param {{id: string, worker: string, claimGeracao: number, leaseSegundos?: number, cooldownHoras: number, maxPorContatoDia: number, maxPorMinuto: number, maxPorMinutoOrganizacao: number, inicioDia: Date}} params
 * @returns {Promise<{resultado: keyof typeof RESULTADO_RESERVA, mensagem?: object}>}
 */
export async function reservarEnvio({ id, worker, claimGeracao, leaseSegundos = 90, cooldownHoras, maxPorContatoDia, maxPorMinuto, maxPorMinutoOrganizacao, inicioDia }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.rpc("comunicacao_reservar_envio", {
    p_id: id, p_worker: worker, p_claim_geracao: claimGeracao, p_lease_segundos: leaseSegundos,
    p_cooldown_horas: cooldownHoras, p_max_por_contato_dia: maxPorContatoDia, p_max_por_minuto: maxPorMinuto,
    p_max_por_minuto_org: maxPorMinutoOrganizacao,
    p_inicio_dia: inicioDia.toISOString(),
  });
  if (error) throw ApiError.internal(error.message);
  // resposta desconhecida = NÃO iniciado (fail-closed): nunca "provavelmente ok".
  if (!data || !Object.values(RESULTADO_RESERVA).includes(data.resultado)) {
    throw ApiError.internal("comunicacao_reservar_envio: resposta inválida");
  }
  if (data.resultado === RESULTADO_RESERVA.INICIADO && !data.mensagem) {
    throw ApiError.internal("comunicacao_reservar_envio: INICIADO sem a linha da mensagem");
  }
  return data;
}

/**
 * RECONCILIAÇÃO HUMANA (contrato backend; sem UI ainda): tira UMA mensagem de
 * DELIVERY_UNKNOWN por decisão explícita de um operador, com motivo.
 *   ENVIADA      -> SENT   (o operador confirmou que chegou)
 *   NAO_ENVIADA  -> FAILED (o operador confirmou que NÃO chegou)
 * NUNCA reenvia: "não enviada" não recoloca a mesma mensagem na fila. Gerar outra
 * é um NOVO evento/versão explícito. O operador e o motivo ficam gravados em
 * `metadados.reconciliacao` (e na auditoria).
 * @param {{id: string, operadorPerfilId: string, resultado: 'ENVIADA'|'NAO_ENVIADA', motivo: string}} params
 * @returns {Promise<{acao: string, status?: string}>}
 */
export async function reconciliarEntrega({ id, operadorPerfilId, resultado, motivo }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.rpc("comunicacao_reconciliar_entrega", {
    p_id: id, p_operador: operadorPerfilId, p_resultado: resultado, p_motivo: motivo,
  });
  if (error) throw ApiError.badRequest(error.message, { codigo: "RECONCILIACAO_INVALIDA" });
  return data;
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
 * TTL (migration 088): cancela o que EXPIROU sem ter saído — SCHEDULED, ou PROCESSING
 * cujo lease venceu — como CANCELLED + erro 'EXPIRADA' (sem status novo), no relógio do
 * BANCO. SENDING e DELIVERY_UNKNOWN nunca são tocados. A MENSAGEM expira; a PENDÊNCIA não:
 * o trigger do banco devolve o alerta a DETECTED (nada é cancelado/resolvido aqui) e NENHUMA
 * mensagem nova é criada. `worker` é só rótulo de auditoria.
 * @param {{worker: string}} params
 */
export async function cancelarExpiradas({ worker }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.rpc("comunicacao_cancelar_expiradas", { p_worker: worker });
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
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

/**
 * Existe OUTRA mensagem deste alerta (que não `exceptId`) DO MESMO PROPÓSITO que já saiu,
 * está saindo ou PODE ter saído (SENDING/SENT/DELIVERED/READ/DELIVERY_UNKNOWN)? Base real da
 * checagem de duplicidade: enquanto houver uma entrega desconhecida do mesmo evento
 * lógico, nenhuma outra mensagem pode ser enviada para ele.
 *
 * PROPÓSITO (`inicial` | `reforco`): um alerta tem legitimamente 1 mensagem inicial + 1 reforço.
 * Uma segunda inicial continua duplicada da primeira, e um segundo reforço continua duplicado
 * do primeiro — só o reforço NÃO é duplicata da inicial (e vice-versa). Sem `proposito`
 * (chamadas antigas) = `inicial`, o comportamento histórico.
 * @param {{alertaId: string, exceptId: string, proposito?: string}} params
 */
export async function existeOutraEntregaDoAlerta({ alertaId, exceptId, proposito = PROPOSITO.INICIAL }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_mensagens")
    .select("id, metadados").eq("alerta_id", alertaId).neq("id", exceptId)
    .in("status", [
      STATUS_MENSAGEM.SENDING, STATUS_MENSAGEM.SENT, STATUS_MENSAGEM.DELIVERED,
      STATUS_MENSAGEM.READ, STATUS_MENSAGEM.DELIVERY_UNKNOWN,
    ]);
  if (error) throw ApiError.internal(error.message);
  return (data ?? []).some((m) => propositoDaMensagem(m) === proposito);
}

/**
 * 1ª mensagem (`wa:alerta:{id}:v1`) de um alerta — base do reforço (status, `enviado_em`).
 * `null` se não existe.
 * @param {string} alertaId
 */
export async function obterMensagemInicialDoAlerta(alertaId, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_mensagens")
    .select("id, status, enviado_em, metadados").eq("idempotency_key", chaveIdempotenciaInicial(alertaId)).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  return data ?? null;
}

// ---------------------------------------------------------------------------
// TESTE CONTROLADO (H.4-B.5) — mensagem de teste do Painel: SEM alerta, fora do scheduler/worker.
// ---------------------------------------------------------------------------
export const TIPO_MENSAGEM_TESTE = "teste_comunicacao";
export const PROPOSITO_TESTE = "teste";
export const ORIGEM_TESTE_PAINEL = "teste_painel";
export const chaveIdempotenciaTeste = (testeId) => `wa:teste:${testeId}:v1`;
const LEASE_TESTE_SEGUNDOS = 120;
const TTL_TESTE_MINUTOS = 10;

/**
 * Cria a mensagem do teste JÁ REIVINDICADA por quem a criou (PROCESSING, claim_geracao=1, lease de 2 min, max_tentativas=1) — assim ela nunca
 * fica disponível ao claim do worker (que só pega SCHEDULED ou PROCESSING com lease vencido; e `expira_em` de 10 min a exclui do claim e a deixa
 * para a varredura de TTL). SEM alerta: NUNCA cria/altera alerta D-1. IDEMPOTENTE por `wa:teste:{testeId}:v1` (UNIQUE do banco): só QUEM CRIA
 * (`criada: true`) pode chamar o provider — N chamadas simultâneas do mesmo teste ⇒ 1 criadora.
 * @returns {Promise<{criada: boolean, mensagem: object}>}
 */
export async function criarMensagemTeste({ testeId, organizacaoId, unidadeId, contatoId, destinatarioPerfilId = null, conteudo, atorPerfilId = null }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const agora = new Date();
  const worker = `teste_painel:${testeId}`;
  const linha = {
    alerta_id: null, organizacao_id: organizacaoId, unidade_id: unidadeId ?? null, contato_id: contatoId, destinatario_perfil_id: destinatarioPerfilId,
    canal: CANAIS.WHATSAPP, direcao: DIRECAO.SAIDA, tipo: TIPO_MENSAGEM_TESTE, conteudo, idempotency_key: chaveIdempotenciaTeste(testeId),
    status: STATUS_MENSAGEM.PROCESSING, disponivel_em: agora.toISOString(), expira_em: new Date(agora.getTime() + TTL_TESTE_MINUTOS * 60_000).toISOString(),
    max_tentativas: 1, claimed_by: worker, claimed_at: agora.toISOString(), claim_geracao: 1,
    claim_expira_em: new Date(agora.getTime() + LEASE_TESTE_SEGUNDOS * 1000).toISOString(),
    metadados: { proposito: PROPOSITO_TESTE, origem: ORIGEM_TESTE_PAINEL, teste_id: testeId, ator_perfil_id: atorPerfilId },
  };
  const { data, error } = await db.from("comunicacao_mensagens").insert(linha).select("*").single();
  // 23505 = a UNIQUE(idempotency_key) do banco: OUTRO chamador criou o mesmo teste primeiro — este NÃO é o criador.
  if (error && String(error.code) !== "23505") throw ApiError.internal(error.message);
  if (!error && data) return { criada: true, mensagem: data, worker };
  const existente = await db.from("comunicacao_mensagens").select("*").eq("idempotency_key", chaveIdempotenciaTeste(testeId)).maybeSingle();
  if (existente.error) throw ApiError.internal(existente.error.message);
  if (!existente.data) throw ApiError.internal("mensagem de teste: nem criada nem encontrada");
  return { criada: false, mensagem: existente.data, worker };
}

// ---------------------------------------------------------------------------
// ENVIO MANUAL (Central de Comunicação) — mensagem escrita por um OPERADOR HUMANO na conversa. MESMO outbox, MESMAS RPCs fenced e MESMOS recibos
// (095) do resto: nenhum segundo pipeline. Sem alerta, fora do scheduler/worker.
// ---------------------------------------------------------------------------
export const TIPO_MENSAGEM_MANUAL = "mensagem_manual";
export const PROPOSITO_MANUAL = "manual";
export const ORIGEM_MANUAL_PAINEL = "manual_painel";
export const chaveIdempotenciaManual = (envioId) => `wa:manual:${envioId}:v1`;
const LEASE_MANUAL_SEGUNDOS = 120;
/**
 * `expira_em` DEPOIS do fim do lease NUNCA pode existir: o claim (088) só pega PROCESSING de lease vencido se `expira_em > now()`. Com `expira_em` <= fim do
 * lease, uma requisição que morra entre criar e iniciar o envio deixa uma linha que o worker de automação JAMAIS reivindica (a varredura de TTL a cancela).
 */
const TTL_MANUAL_SEGUNDOS = 60;

/**
 * Cria a mensagem manual JÁ REIVINDICADA por quem a criou (PROCESSING, claim_geracao=1, max_tentativas=1). IDEMPOTENTE por `wa:manual:{envioId}:v1`
 * (UNIQUE do banco): só QUEM CRIA (`criada: true`) pode chamar o provider — duplo clique/reenvio da tela ⇒ 1 criadora, 1 envio.
 * O ator humano fica em `metadados` (id do perfil e nome), para auditoria e para a bolha mostrar "quem enviou".
 * @returns {Promise<{criada: boolean, mensagem: object, worker: string}>}
 */
export async function criarMensagemManual({ envioId, organizacaoId, unidadeId = null, contatoId, destinatarioPerfilId = null, conteudo, atorPerfilId = null, atorNome = null }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const agora = new Date();
  const worker = `manual_painel:${envioId}`;
  const linha = {
    alerta_id: null, organizacao_id: organizacaoId, unidade_id: unidadeId, contato_id: contatoId, destinatario_perfil_id: destinatarioPerfilId,
    canal: CANAIS.WHATSAPP, direcao: DIRECAO.SAIDA, tipo: TIPO_MENSAGEM_MANUAL, conteudo, idempotency_key: chaveIdempotenciaManual(envioId),
    status: STATUS_MENSAGEM.PROCESSING, disponivel_em: agora.toISOString(), expira_em: new Date(agora.getTime() + TTL_MANUAL_SEGUNDOS * 1000).toISOString(),
    max_tentativas: 1, claimed_by: worker, claimed_at: agora.toISOString(), claim_geracao: 1,
    claim_expira_em: new Date(agora.getTime() + LEASE_MANUAL_SEGUNDOS * 1000).toISOString(),
    metadados: { proposito: PROPOSITO_MANUAL, origem: ORIGEM_MANUAL_PAINEL, envio_id: envioId, ator_perfil_id: atorPerfilId, ator_nome: atorNome },
  };
  const { data, error } = await db.from("comunicacao_mensagens").insert(linha).select("*").single();
  // 23505 = a UNIQUE(idempotency_key) do banco: OUTRO chamador criou o mesmo envio primeiro — este NÃO é o criador.
  if (error && String(error.code) !== "23505") throw ApiError.internal(error.message);
  if (!error && data) return { criada: true, mensagem: data, worker };
  const existente = await db.from("comunicacao_mensagens").select("*").eq("idempotency_key", chaveIdempotenciaManual(envioId)).maybeSingle();
  if (existente.error) throw ApiError.internal(existente.error.message);
  if (!existente.data) throw ApiError.internal("mensagem manual: nem criada nem encontrada");
  return { criada: false, mensagem: existente.data, worker };
}

/** Mensagens de teste que contam para o LIMITE (todas menos as canceladas/bloqueadas antes de qualquer envio), da mais antiga para a mais nova. */
export async function listarMensagensTesteContabilizadas(deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_mensagens").select("id, status, created_at, tentativas")
    .eq("tipo", TIPO_MENSAGEM_TESTE).not("status", "in", "(CANCELLED,BLOCKED)").order("created_at", { ascending: true }).order("id", { ascending: true });
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

/** Marca (uma vez) que a auditoria de um marco do teste (ENTREGUE/LIDO) já foi gravada — evita duplicar no polling da tela. */
export async function marcarAuditoriaTeste({ id, marco }, deps = {}) {
  const db = deps.supabase ?? supabase;
  // Concorrência otimista: a RPC de receipts (095) também escreve em metadados e sempre move updated_at — se ele mudou entre a leitura e a escrita,
  // NADA é gravado e relemos (nunca sobrescreve provider_ack/provider_erro).
  for (let tentativa = 0; tentativa < 4; tentativa += 1) {
    const { data: atual, error: e1 } = await db.from("comunicacao_mensagens").select("metadados, updated_at").eq("id", id).maybeSingle();
    if (e1) throw ApiError.internal(e1.message);
    if (!atual) return false;
    const meta = atual.metadados ?? {};
    if (meta.auditoria_teste?.[marco]) return false;
    const novo = { ...meta, auditoria_teste: { ...(meta.auditoria_teste ?? {}), [marco]: true } };
    const { data, error } = await db.from("comunicacao_mensagens").update({ metadados: novo }).eq("id", id).eq("updated_at", atual.updated_at).select("id");
    if (error) throw ApiError.internal(error.message);
    if ((data ?? []).length === 1) return true;
  }
  return false;
}
