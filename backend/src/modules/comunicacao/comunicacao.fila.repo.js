// Fila (comunicacao_mensagens) — I/O puro. O claim é ATÔMICO via a função
// SQL `comunicacao_claim_mensagens` (migration 082) — nunca um
// "SELECT depois UPDATE" feito em dois passos do Node (ver o comentário da
// migration para o motivo).

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { STATUS_MENSAGEM, CANAIS, DIRECAO } from "./comunicacao.constants.js";

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
 * PROCESSING -> SENDING. Gravado ANTES de chamar o provider — é o rastro
 * durável que existe precisamente para o cenário "processo morre no meio
 * do envio" (ver comunicacao.entrega.js). A partir daqui, se o lease
 * expirar sem resolução, `expirarEntregasIncertas` (nunca o claim) é quem
 * decide o destino — nunca um reenvio automático.
 * @param {string} id
 */
export async function marcarEnviando(id, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { error } = await db.from("comunicacao_mensagens")
    .update({ status: STATUS_MENSAGEM.SENDING }).eq("id", id);
  if (error) throw ApiError.internal(error.message);
}

/** @param {string} id @param {{providerMessageId: string}} info */
export async function marcarEnviado(id, { providerMessageId }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { error } = await db.from("comunicacao_mensagens").update({
    status: STATUS_MENSAGEM.SENT, enviado_em: new Date().toISOString(), provider_message_id: providerMessageId,
  }).eq("id", id);
  if (error) throw ApiError.internal(error.message);
}

/**
 * Move para DELIVERY_UNKNOWN toda mensagem SENDING cujo lease expirou sem
 * resolução — via a RPC dedicada (migration 082), nunca via UPDATE direto
 * do Node (mantém a decisão no mesmo lugar que audita/documenta a regra).
 * NUNCA chamada pelo caminho normal de claim — só por uma varredura
 * explícita (aqui, ou pelo processo persistente do Checkpoint C).
 * @param {{worker: string}} params
 */
export async function expirarEntregasIncertas({ worker }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.rpc("comunicacao_expirar_entregas_incertas", { p_worker: worker });
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

/**
 * Marca ESTA linha (que o worker atual ainda segura, dentro do próprio
 * lease) como DELIVERY_UNKNOWN — usado quando o próprio processo, ainda
 * vivo, recebe um erro AMBÍGUO do provider (não confunda com
 * `expirarEntregasIncertas`, que é para leases de workers MORTOS). Nunca
 * volta sozinha para SCHEDULED.
 * @param {string} id @param {{erro: string}} params
 */
export async function marcarEntregaIncerta(id, { erro }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { error } = await db.from("comunicacao_mensagens")
    .update({ status: STATUS_MENSAGEM.DELIVERY_UNKNOWN, entrega_incerta_em: new Date().toISOString(), erro }).eq("id", id);
  if (error) throw ApiError.internal(error.message);
}

/**
 * Registra falha CONHECIDA (RETRYAVEL ou PERMANENTE — nunca chamada para
 * INCERTO, que vai para DELIVERY_UNKNOWN via `marcarEnviando`+lease, não
 * por aqui). Se `permanente` ou `tentativas >= max_tentativas`, termina em
 * FAILED (nunca mais reivindicável — quebra o loop, teste 15). Senão,
 * volta para SCHEDULED com backoff (exponencial, teto configurável) —
 * reaparece para o claim mais tarde, nunca imediatamente (teste 14).
 * @param {string} id
 * @param {{erro: string, permanente?: boolean, backoffBaseMs?: number, backoffMaxMs?: number}} params
 */
export async function marcarFalha(id, { erro, permanente = false, backoffBaseMs = 30_000, backoffMaxMs = 30 * 60_000 }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const atual = await db.from("comunicacao_mensagens").select("tentativas, max_tentativas").eq("id", id).single();
  if (atual.error) throw ApiError.internal(atual.error.message);
  const esgotou = permanente || atual.data.tentativas >= atual.data.max_tentativas;

  if (esgotou) {
    const { error } = await db.from("comunicacao_mensagens").update({
      status: STATUS_MENSAGEM.FAILED, falhou_em: new Date().toISOString(), erro, erro_permanente: true,
    }).eq("id", id);
    if (error) throw ApiError.internal(error.message);
    return { status: STATUS_MENSAGEM.FAILED };
  }

  const backoffMs = Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.max(0, atual.data.tentativas - 1));
  const { error } = await db.from("comunicacao_mensagens").update({
    status: STATUS_MENSAGEM.SCHEDULED,
    disponivel_em: new Date(Date.now() + backoffMs).toISOString(),
    erro,
  }).eq("id", id);
  if (error) throw ApiError.internal(error.message);
  return { status: STATUS_MENSAGEM.SCHEDULED, disponivelEmMs: backoffMs };
}

/** @param {string} id @param {{motivo: string}} params */
export async function marcarBloqueado(id, { motivo }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { error } = await db.from("comunicacao_mensagens")
    .update({ status: STATUS_MENSAGEM.BLOCKED, erro: motivo }).eq("id", id);
  if (error) throw ApiError.internal(error.message);
}

/** Cancela todas as mensagens SCHEDULED de um alerta (ex.: pendência resolvida). */
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
 * Quantas mensagens de SAÍDA já foram enviadas para este tipo+alerta nas
 * últimas `janelaHoras` — usado pelo cooldown. Conta por `tipo` (não por
 * `alertaId`) porque o cooldown é "não repita este TIPO de aviso para este
 * contato tão cedo", não "não repita esta linha específica".
 * @param {{contatoId: string, tipo: string, janelaHoras: number}} params
 */
export async function contarEnviosRecentes({ contatoId, tipo, janelaHoras }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const desde = new Date(Date.now() - janelaHoras * 3600_000).toISOString();
  const { count, error } = await db.from("comunicacao_mensagens")
    .select("id", { count: "exact", head: true })
    .eq("contato_id", contatoId).eq("tipo", tipo).eq("direcao", DIRECAO.SAIDA)
    .not("enviado_em", "is", null).gte("enviado_em", desde);
  if (error) throw ApiError.internal(error.message);
  return count ?? 0;
}

/** Quantas mensagens SAÍDA enviadas para este contato hoje (para o limite `max_por_contato_por_dia`). */
export async function contarEnviosHoje({ contatoId }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const inicioDoDia = new Date(); inicioDoDia.setHours(0, 0, 0, 0);
  const { count, error } = await db.from("comunicacao_mensagens")
    .select("id", { count: "exact", head: true })
    .eq("contato_id", contatoId).eq("direcao", DIRECAO.SAIDA)
    .not("enviado_em", "is", null).gte("enviado_em", inicioDoDia.toISOString());
  if (error) throw ApiError.internal(error.message);
  return count ?? 0;
}

/** Quantas mensagens proativas foram enviadas no último minuto (para o limite `max_proativas_por_minuto`). */
export async function contarEnviosProativosUltimoMinuto(deps = {}) {
  const db = deps.supabase ?? supabase;
  const desde = new Date(Date.now() - 60_000).toISOString();
  const { count, error } = await db.from("comunicacao_mensagens")
    .select("id", { count: "exact", head: true })
    .eq("direcao", DIRECAO.SAIDA).not("enviado_em", "is", null).gte("enviado_em", desde);
  if (error) throw ApiError.internal(error.message);
  return count ?? 0;
}

/** Existe alguma mensagem ATIVA (SCHEDULED/PROCESSING/SENT) equivalente (mesmo alerta)? Base da checagem de duplicidade. */
export async function existeEnvioAtivoParaAlerta(alertaId, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_mensagens")
    .select("id").eq("alerta_id", alertaId)
    .in("status", [STATUS_MENSAGEM.SCHEDULED, STATUS_MENSAGEM.PROCESSING, STATUS_MENSAGEM.SENT])
    .limit(1);
  if (error) throw ApiError.internal(error.message);
  return (data ?? []).length > 0;
}
