// Repositório das pendências documentais (migration 156). Mesma regra dos demais: contexto validado, filtro por organização + unidade,
// sem DELETE (cancela-se com motivo). Nenhuma função aqui toca lançamentos, pagamentos, recebimentos ou conciliações.
import { supabase } from "../../../config/supabase.js";
import { exigirContexto } from "./contexto.js";
import { falha, unid } from "./repositorio.util.js";

export async function listarPendenciasDocumentais(ctxIn, { competencia } = {}, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  let q = unid(db.from("fin_pendencias_documentais").select("*"), ctx).eq("status", "ativa");
  if (competencia) q = q.eq("competencia", competencia);
  const { data, error } = await q.order("created_at").order("id").limit(1000);
  falha(error); return data ?? [];
}
export async function buscarPendenciaDocumental(ctxIn, id, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_pendencias_documentais").select("*").eq("id", id), ctx).maybeSingle();
  falha(error); return data;
}
export async function inserirPendenciaDocumental(ctxIn, linha, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.from("fin_pendencias_documentais").insert({ ...linha, organizacao_id: ctx.organizacaoId, unidade_id: ctx.unidadeId, criado_por: ctx.usuarioId, atualizado_por: ctx.usuarioId }).select().single();
  falha(error); return data;
}
export async function atualizarPendenciaDocumental(ctxIn, id, campos, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_pendencias_documentais").update({ ...campos, atualizado_por: ctx.usuarioId }).eq("id", id), ctx).select().maybeSingle();
  falha(error); return data;
}
