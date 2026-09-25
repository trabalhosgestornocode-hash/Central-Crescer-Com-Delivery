// I/O de LEITURA da Central de Comunicação (conversas, visão geral, cursores de atualização) e cache da foto de perfil.
// SÓ lê `comunicacao_mensagens` (outbox) e `comunicacao_inbox_*`; a única escrita é o cache da foto em `contatos_whatsapp`. Nunca decide política.
// Diferente do repo do histórico antigo, aqui o `conteudo` SAI — mas só para contatos que o roster autoriza (quem chama passa os ids já filtrados).

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

const COLUNAS_SAIDA = "id, organizacao_id, unidade_id, contato_id, tipo, conteudo, status, created_at, disponivel_em, enviado_em, entregue_em, lido_em, falhou_em, erro, metadados, updated_at";
const LOTE_IDS = 100;   // limite prático do tamanho da URL do PostgREST em filtros `in`

const emLotes = (ids) => { const l = [...new Set((ids ?? []).filter(Boolean))]; const out = []; for (let i = 0; i < l.length; i += LOTE_IDS) out.push(l.slice(i, i + LOTE_IDS)); return out; };
const falha = (error) => { throw ApiError.internal(error.message); };

export async function paginaConversa({ organizacaoId, contatoId, desde, antes }, deps = {}) {
  const { data, error } = await (deps.supabase ?? supabase).rpc("comunicacao_conversa_pagina", {
    p_organizacao_id: organizacaoId, p_contato_id: contatoId, p_desde: desde,
    p_antes_em: antes?.em ?? null, p_antes_direcao: antes?.direcao ?? null, p_antes_id: antes?.id ?? null, p_limite: 201,
  });
  if (error) falha(error);
  return data ?? [];
}

/** Evento de envio, separado da consulta por criação utilizada nos demais cards. */
export async function listarEnviadasDesde({ desde }, deps = {}) {
  const { data, error } = await (deps.supabase ?? supabase).from("comunicacao_mensagens")
    .select("id,contato_id,status,enviado_em,entregue_em,lido_em").eq("direcao", "saida")
    .in("status", ["SENT", "DELIVERED", "READ"]).gte("enviado_em", desde).order("enviado_em", { ascending: false }).limit(5000);
  if (error) falha(error);
  return data ?? [];
}

/** Saídas (todas as origens) dos contatos dados, desde `desde` — da mais nova para a mais antiga. */
export async function listarSaidasRecentes({ contatoIds, desde, limite = 3000 }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const out = [];
  for (const lote of emLotes(contatoIds)) {
    const { data, error } = await db.from("comunicacao_mensagens").select(COLUNAS_SAIDA)
      .eq("direcao", "saida").in("contato_id", lote).gte("created_at", desde).order("created_at", { ascending: false }).limit(limite);
    if (error) falha(error);
    out.push(...(data ?? []));
  }
  return out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, limite);
}

/** Saídas de UM contato desde `desde`, da mais antiga para a mais nova (a conversa). */
export async function listarSaidasDoContato({ contatoId, desde, limite = 500 }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_mensagens").select(COLUNAS_SAIDA)
    .eq("direcao", "saida").eq("contato_id", contatoId).gte("created_at", desde).order("created_at", { ascending: true }).limit(limite);
  if (error) falha(error);
  return data ?? [];
}

/** Últimas saídas que falharam ou ficaram sem confirmação (SEM conteúdo) — para o diagnóstico técnico. */
export async function listarUltimosErros({ limite = 5 }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_mensagens").select("id, status, erro, falhou_em, entrega_incerta_em, updated_at, tipo, metadados")
    .eq("direcao", "saida").in("status", ["FAILED", "DELIVERY_UNKNOWN"]).order("updated_at", { ascending: false }).limit(limite);
  if (error) falha(error);
  return data ?? [];
}

/** Uma saída pelo id (com conteúdo) — para devolver a bolha recém-criada ao operador. */
export async function obterSaida(id, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_mensagens").select(COLUNAS_SAIDA).eq("direcao", "saida").eq("id", id).maybeSingle();
  if (error) falha(error);
  return data ?? null;
}

/** Saídas (sem conteúdo) desde `desde` — para os cards do dia. */
export async function listarSaidasDesde({ desde, limite = 5000 }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_mensagens").select("id, organizacao_id, contato_id, tipo, status, metadados, created_at, enviado_em, entregue_em, lido_em, falhou_em")
    .eq("direcao", "saida").gte("created_at", desde).order("created_at", { ascending: false }).limit(limite);
  if (error) falha(error);
  return data ?? [];
}

/** Próximos envios AUTOMÁTICOS agendados (ainda SCHEDULED), do mais próximo ao mais distante. */
export async function listarProximosEnvios({ limite = 20 }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_mensagens").select("id, organizacao_id, unidade_id, contato_id, tipo, disponivel_em, metadados")
    .eq("direcao", "saida").eq("status", "SCHEDULED").order("disponivel_em", { ascending: true }).limit(limite);
  if (error) falha(error);
  return data ?? [];
}

/** Cache da foto de perfil por contato (metadado, nunca o binário). */
export async function obterFotos(contatoIds, deps = {}) {
  const db = deps.supabase ?? supabase;
  const mapa = new Map();
  for (const lote of emLotes(contatoIds)) {
    const { data, error } = await db.from("contatos_whatsapp").select("id, foto_url, foto_atualizada_em, foto_indisponivel_ate").in("id", lote);
    if (error) falha(error);
    for (const c of data ?? []) mapa.set(c.id, c);
  }
  return mapa;
}

/** Atualização PARCIAL: só as chaves informadas mudam (uma falha transitória grava só `indisponivelAte` e nunca apaga uma foto que já existe). */
export async function salvarFoto({ contatoId, url, atualizadaEm, indisponivelAte }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const campos = {};
  if (url !== undefined) campos.foto_url = url;
  if (atualizadaEm !== undefined) campos.foto_atualizada_em = atualizadaEm;
  if (indisponivelAte !== undefined) campos.foto_indisponivel_ate = indisponivelAte;
  if (!Object.keys(campos).length) return;
  const { error } = await db.from("contatos_whatsapp").update(campos).eq("id", contatoId);
  if (error) falha(error);
}

/** Cursor de mudança: instante do último item guardado no inbox e da última atualização de uma saída (receipts movem `updated_at`). */
export async function lerCursoresAtuais(deps = {}) {
  const db = deps.supabase ?? supabase;
  const [inbox, saida] = await Promise.all([
    db.from("comunicacao_inbox_mensagens").select("created_at").order("created_at", { ascending: false }).limit(1),
    db.from("comunicacao_mensagens").select("updated_at").eq("direcao", "saida").not("contato_id", "is", null).order("updated_at", { ascending: false }).limit(1),
  ]);
  if (inbox.error) falha(inbox.error);
  if (saida.error) falha(saida.error);
  return { inbox: inbox.data?.[0]?.created_at ?? null, saida: saida.data?.[0]?.updated_at ?? null };
}

const SOBREPOSICAO_CURSOR_MS = 5000;
const recuar = (iso) => new Date(Math.max(0, Date.parse(iso) - SOBREPOSICAO_CURSOR_MS)).toISOString();

/** Contatos com mudança desde os cursores (recebidas novas / saídas que avançaram de status). */
export async function contatosAlteradosDesde({ inbox, saida, limite = 200 }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const ids = new Set();
  // Uma direção antes vazia precisa incluir seu primeiro item. Lote saturado
  // retorna null para invalidar todo o roster, sem perder a conversa aberta.
  inbox ??= "1970-01-01T00:00:00.000Z";
  saida ??= "1970-01-01T00:00:00.000Z";
  if (inbox) {
    // SOBREPOSIÇÃO de 5 s: um insert que começou antes (created_at menor) mas commitou depois do cursor não pode ser perdido. O resultado é um conjunto de ids (dedup).
    const { data, error } = await db.from("comunicacao_inbox_mensagens").select("contato_id").gt("created_at", recuar(inbox)).limit(limite + 1);
    if (error) falha(error);
    if (data?.length > limite) return null;
    for (const r of data ?? []) ids.add(r.contato_id);
  }
  if (saida) {
    const { data, error } = await db.from("comunicacao_mensagens").select("contato_id").eq("direcao", "saida").gt("updated_at", recuar(saida)).limit(limite + 1);
    if (error) falha(error);
    if (data?.length > limite) return null;
    for (const r of data ?? []) if (r.contato_id) ids.add(r.contato_id);
  }
  return [...ids];
}
