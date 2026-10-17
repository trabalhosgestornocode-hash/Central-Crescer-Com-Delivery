// Repositório da conciliação (B7): referências, classificações manuais e exceções de sangria. Escopo org+unidade explícito em tudo.
// Sem DELETE: cancelamento/revogação/desativação são mudanças de estado com motivo (e a auditoria guarda antes/depois).
import { supabase } from "../../../config/supabase.js";
import { exigirContexto } from "./contexto.js";
import { falha, unid } from "./repositorio.util.js";

const fimDoMes = (mes) => { const [a, m] = mes.split("-").map(Number); return `${mes}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, "0")}`; };

export async function listarReferencias(ctxIn, { mes, incluirCanceladas = false } = {}, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  let q = unid(db.from("fin_referencias").select("*"), ctx);
  if (mes) q = q.gte("data", `${mes}-01`).lte("data", fimDoMes(mes));
  if (!incluirCanceladas) q = q.eq("status", "ativa");
  const { data, error } = await q.order("data").order("created_at").limit(5000);
  falha(error);
  return data ?? [];
}

/** Insere só as referências cuja chave ainda não existe (idempotência); devolve contagens. */
export async function inserirReferencias(ctxIn, itens, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const chaves = itens.map((i) => i.chave_origem).filter(Boolean);
  let existentes = new Set();
  if (chaves.length) {
    const { data, error } = await unid(db.from("fin_referencias").select("chave_origem"), ctx).in("chave_origem", chaves);
    falha(error);
    existentes = new Set((data ?? []).map((x) => x.chave_origem));
  }
  const novos = itens.filter((i) => !i.chave_origem || !existentes.has(i.chave_origem)).map((i) => ({ ...i, organizacao_id: ctx.organizacaoId, unidade_id: ctx.unidadeId, criado_por: ctx.usuarioId }));
  if (novos.length) { const { error } = await db.from("fin_referencias").insert(novos); falha(error); }
  return { gravados: novos.length, ignorados: itens.length - novos.length };
}

export async function cancelarReferencia(ctxIn, id, motivo, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_referencias").update({ status: "cancelada", cancelada_por: ctx.usuarioId, cancelada_em: new Date().toISOString(), motivo_cancelamento: motivo }).eq("id", id).eq("status", "ativa"), ctx).select().maybeSingle();
  falha(error);
  return data;
}

export async function listarResolucoes(ctxIn, { mes, incluirRevogadas = false } = {}, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  let q = unid(db.from("fin_conciliacao_resolucoes").select("*"), ctx);
  if (mes) q = q.gte("chave", `${mes}-01`).lte("chave", fimDoMes(mes));
  if (!incluirRevogadas) q = q.eq("status", "vigente");
  const { data, error } = await q.order("created_at").limit(5000);
  falha(error);
  return data ?? [];
}
export async function inserirResolucao(ctxIn, r, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.from("fin_conciliacao_resolucoes").insert({ ...r, organizacao_id: ctx.organizacaoId, unidade_id: ctx.unidadeId, criado_por: ctx.usuarioId }).select().single();
  falha(error);
  return data;
}
export async function revogarResolucao(ctxIn, id, motivo, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_conciliacao_resolucoes").update({ status: "revogada", revogada_por: ctx.usuarioId, revogada_em: new Date().toISOString(), motivo_revogacao: motivo }).eq("id", id).eq("status", "vigente"), ctx).select().maybeSingle();
  falha(error);
  return data;
}

export async function listarExcecoesSangria(ctxIn, { apenasAtivas = false } = {}, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  let q = unid(db.from("fin_sangria_excecoes").select("*"), ctx);
  if (apenasAtivas) q = q.eq("ativa", true);
  const { data, error } = await q.order("created_at");
  falha(error);
  return data ?? [];
}
export async function inserirExcecaoSangria(ctxIn, e, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.from("fin_sangria_excecoes").insert({ ...e, organizacao_id: ctx.organizacaoId, unidade_id: ctx.unidadeId, aprovada_por: ctx.usuarioId }).select().single();
  falha(error);
  return data;
}
export async function desativarExcecaoSangria(ctxIn, id, motivo, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_sangria_excecoes").update({ ativa: false, desativada_por: ctx.usuarioId, desativada_em: new Date().toISOString(), motivo_desativacao: motivo }).eq("id", id).eq("ativa", true), ctx).select().maybeSingle();
  falha(error);
  return data;
}
