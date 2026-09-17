// comunicacao_conversas — o BINDING entre uma thread de WhatsApp e uma
// linha de agente_conversas, sem alterar a tabela do Agente (ver
// justificativa completa no comentário da seção 5 da migration 082).
//
// Este módulo NUNCA lê/escreve agente_conversas diretamente — quem cria a
// conversa do Agente é sempre agente/agente.conversas.service.js (a
// autoridade daquela tabela); este repo só guarda o `agente_conversa_id`
// resultante e resolve "qual thread de WhatsApp corresponde a este
// contato".

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

/**
 * Thread ATIVA existente para este contato+organização+unidade, se houver.
 * @param {{contatoId: string, organizacaoId: string, unidadeId: string|null}} params
 */
export async function buscarConversaAtiva({ contatoId, organizacaoId, unidadeId }, deps = {}) {
  const db = deps.supabase ?? supabase;
  let q = db.from("comunicacao_conversas").select("*")
    .eq("contato_id", contatoId).eq("organizacao_id", organizacaoId).eq("status", "ATIVA");
  q = unidadeId ? q.eq("unidade_id", unidadeId) : q.is("unidade_id", null);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  return data;
}

/**
 * Cria a thread, já apontando para uma conversa do Agente existente
 * (`agenteConversaId` — criada por agente.conversas.service.js, nunca por
 * aqui).
 * @param {{contatoId: string, organizacaoId: string, unidadeId: string|null, perfilOperacionalId: string|null, agenteConversaId: string|null}} params
 */
export async function criarConversa(params, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_conversas").insert({
    contato_id: params.contatoId, organizacao_id: params.organizacaoId, unidade_id: params.unidadeId ?? null,
    perfil_operacional_id: params.perfilOperacionalId ?? null, agente_conversa_id: params.agenteConversaId ?? null,
  }).select("*").single();
  if (error) throw ApiError.internal(error.message);
  return data;
}

/** @param {string} id */
export async function encerrarConversa(id, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { error } = await db.from("comunicacao_conversas").update({ status: "ENCERRADA" }).eq("id", id);
  if (error) throw ApiError.internal(error.message);
}
