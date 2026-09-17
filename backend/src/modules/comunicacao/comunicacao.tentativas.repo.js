// comunicacao_tentativas — histórico por tentativa (auditoria/diagnóstico).
// NUNCA lida pelo claim nem pelo Policy Engine — comunicacao_mensagens
// continua sendo a única autoridade sobre o estado ATUAL. Ver comentário
// da tabela na migration 082 (seção 4.1).

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

/**
 * Registra o INÍCIO de uma tentativa — chamado logo após o claim, com o
 * `tentativas` já incrementado pela RPC (o número desta tentativa é
 * exatamente `job.tentativas`).
 * @param {{mensagemId: string, tentativaNumero: number, workerId: string, iniciadoEm: string}} params
 */
export async function registrarTentativaIniciada({ mensagemId, tentativaNumero, workerId, iniciadoEm }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_tentativas")
    .insert({ mensagem_id: mensagemId, tentativa_numero: tentativaNumero, worker_id: workerId, iniciado_em: iniciadoEm })
    .select("id").single();
  if (error) {
    // reclaim do mesmo (mensagem, tentativa) — não deveria acontecer (a RPC
    // sempre incrementa antes de devolver), mas não derruba o processamento
    // por causa de uma linha de auditoria.
    if (String(error.code) === "23505") return null;
    throw ApiError.internal(error.message);
  }
  return data.id;
}

/**
 * Registra o FIM de uma tentativa. `erroSanitizado` nunca deve carregar
 * token/credencial/payload sensível (mesmo princípio de shared/auditoria.js).
 * @param {{mensagemId: string, tentativaNumero: number, resultado: 'SENT'|'FAILED'|'DELIVERY_UNKNOWN'|'BLOCKED'|'ABANDONADA', providerMessageId?: string|null, erroClassificacao?: 'RETRYAVEL'|'PERMANENTE'|'INCERTO'|null, erroSanitizado?: string|null}} params
 */
export async function registrarTentativaFinalizada({ mensagemId, tentativaNumero, resultado, providerMessageId = null, erroClassificacao = null, erroSanitizado = null }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { error } = await db.from("comunicacao_tentativas")
    .update({ finalizado_em: new Date().toISOString(), resultado, provider_message_id: providerMessageId, erro_classificacao: erroClassificacao, erro_sanitizado: erroSanitizado })
    .eq("mensagem_id", mensagemId).eq("tentativa_numero", tentativaNumero);
  if (error) throw ApiError.internal(error.message);
}

/**
 * Fecha como ABANDONADA qualquer tentativa desta mensagem que ficou sem
 * `finalizado_em` — só pode existir se veio de um worker que morreu (um
 * novo claim só acontece depois que o lease anterior expirou, sob SKIP
 * LOCKED; nenhum processo vivo pode estar com essa linha em mãos ao mesmo
 * tempo). Chamado ANTES de registrar a tentativa nova, para nunca haver
 * duas linhas "em aberto" para a mesma mensagem.
 * @param {string} mensagemId
 */
export async function abandonarTentativasEmAberto(mensagemId, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_tentativas")
    .update({ finalizado_em: new Date().toISOString(), resultado: "ABANDONADA" })
    .eq("mensagem_id", mensagemId).is("finalizado_em", null)
    .select("id");
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

/** Tentativas de uma mensagem, mais antiga primeiro — para diagnóstico/telas futuras. */
export async function listarTentativas(mensagemId, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_tentativas")
    .select("*").eq("mensagem_id", mensagemId).order("tentativa_numero", { ascending: true });
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}
