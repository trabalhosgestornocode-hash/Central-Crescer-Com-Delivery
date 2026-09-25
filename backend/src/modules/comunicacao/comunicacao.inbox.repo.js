// Inbox da Central de Comunicação — I/O das tabelas `comunicacao_inbox_mensagens` / `comunicacao_inbox_leituras` (migration 096).
// SÓ conteúdo de responsáveis AUTORIZADOS chega aqui (quem decide é comunicacao.inbox.service.js). Nunca lê/escreve `whatsapp_inbound_mensagens` (090)
// nem `comunicacao_mensagens` (outbox). O `organizacaoId` vem SEMPRE da config do backend, nunca do payload.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

const COLUNAS_MENSAGEM = "id, contato_id, tipo_conteudo, texto, origem_tipo, recebido_em";

/** Retenção do TEXTO recebido, em dias (COMUNICACAO_INBOX_RETENCAO_DIAS; padrão 30; limitado a 1..365). */
export function retencaoDias(env = process.env) {
  const n = Number(String(env.COMUNICACAO_INBOX_RETENCAO_DIAS ?? "").trim());
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 30;
}

/** Nunca lê além da retenção: o texto vencido não aparece nem antes de a purga rodar. */
export function dentroDaRetencao(desde, deps = {}) {
  const corte = (deps.agora?.() ?? new Date()).getTime() - retencaoDias(deps.env ?? process.env) * 86_400_000;
  return new Date(Math.max(Date.parse(desde) || 0, corte)).toISOString();
}

/** Purga real das mensagens vencidas (função SQL 096, em lote). Devolve quantas linhas removeu — nunca conteúdo. */
export async function purgarVencidas({ dias = retencaoDias(), limite = 5000 } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.rpc("comunicacao_inbox_purgar", { p_retencao_dias: dias, p_limite: limite });
  if (error) throw ApiError.internal(error.message);
  return Number(data) || 0;
}

/**
 * Registro idempotente e atômico (RPC 096) por (organizacao_id, provider_message_id).
 * @returns {Promise<{inserido: boolean, id: string}>}
 */
export async function registrarMensagem({ organizacaoId, contatoId, providerMessageId, origemTipo, tipoConteudo, texto, recebidoEm, dias = retencaoDias() }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.rpc("comunicacao_inbox_registrar", {
    p_organizacao_id: organizacaoId, p_contato_id: contatoId, p_provider_message_id: providerMessageId, p_origem_tipo: origemTipo,
    p_tipo_conteudo: tipoConteudo, p_texto: texto ?? null, p_recebido_em: recebidoEm, p_retencao_dias: dias,
  });
  if (error) throw ApiError.internal(error.message);
  const r = Array.isArray(data) ? data[0] : data;
  if (!r || typeof r.inserido !== "boolean") throw ApiError.internal("resposta inesperada de comunicacao_inbox_registrar");
  return { inserido: r.inserido, id: r.id };
}

/** Resumo por conversa (última recebida, prévia e não lidas) da organização da conexão. */
export async function resumoPorContato(organizacaoId, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.rpc("comunicacao_inbox_resumo", { p_organizacao_id: organizacaoId, p_retencao_dias: retencaoDias(deps.env ?? process.env) });
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

/** Mensagens recebidas de UM contato desde `desde` (ISO), da mais antiga para a mais nova. */
export async function listarMensagensDoContato({ organizacaoId, contatoId, desde, limite = 500 }, deps = {}) {
  if (!organizacaoId) return [];   // fail-closed: sem organização da conexão não há inbox a mostrar
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_inbox_mensagens").select(COLUNAS_MENSAGEM)
    .eq("organizacao_id", organizacaoId).eq("contato_id", contatoId).gte("recebido_em", dentroDaRetencao(desde, deps)).order("recebido_em", { ascending: true }).limit(limite);
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

/** Mensagens recebidas (de qualquer contato) desde `desde` — "mensagens hoje" e o histórico. O texto só vem com `comTexto`. */
export async function listarMensagensDesde({ organizacaoId, desde, limite = 1000, comTexto = false }, deps = {}) {
  if (!organizacaoId) return [];   // fail-closed (mesma regra)
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_inbox_mensagens").select(comTexto ? COLUNAS_MENSAGEM : "id, contato_id, tipo_conteudo, recebido_em")
    .eq("organizacao_id", organizacaoId).gte("recebido_em", dentroDaRetencao(desde, deps)).order("recebido_em", { ascending: true }).limit(limite);
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

/** Marca a conversa como lida até `ate`, NA ORGANIZAÇÃO da conexão (nunca retrocede — a função SQL usa greatest). */
export async function marcarLida({ organizacaoId, contatoId, ate, porPerfilId = null }, deps = {}) {
  if (!organizacaoId) return;   // sem organização não há inbox: nada a marcar
  const db = deps.supabase ?? supabase;
  const { error } = await db.rpc("comunicacao_inbox_marcar_lida", { p_organizacao_id: organizacaoId, p_contato_id: contatoId, p_ate: ate, p_por: porPerfilId });
  if (error) throw ApiError.internal(error.message);
}
