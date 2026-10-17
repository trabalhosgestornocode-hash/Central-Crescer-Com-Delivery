// Repositório dos períodos financeiros (B8). Abrir/fechar/reabrir são RPCs atômicas no banco (com trava de linha e impressão digital);
// aqui só se passa o contexto validado. A política de fechamento (fin_config) é lida e gravada por unidade.
import { supabase } from "../../../config/supabase.js";
import { exigirContexto } from "./contexto.js";
import { falha, unid } from "./repositorio.util.js";

const dia1 = (mes) => `${mes}-01`;

export async function listarPeriodos(ctxIn, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_periodos").select("*"), ctx).order("mes", { ascending: false }).limit(240);
  falha(error);
  return data ?? [];
}
export async function abrirPeriodoRpc(ctxIn, mes, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.rpc("fin_abrir_periodo", { p_org: ctx.organizacaoId, p_unidade: ctx.unidadeId, p_usuario: ctx.usuarioId, p_mes: dia1(mes) });
  falha(error);
  return data;
}
export async function fingerprintPeriodoRpc(ctxIn, mes, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.rpc("fin_fingerprint_periodo", { p_org: ctx.organizacaoId, p_unidade: ctx.unidadeId, p_mes: dia1(mes) });
  falha(error);
  return data;
}
export async function fecharPeriodoRpc(ctxIn, { mes, versao, fingerprint, snapshot, pendenciasConciliacao, reconhecoPendencias }, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.rpc("fin_fechar_periodo", {
    p_org: ctx.organizacaoId, p_unidade: ctx.unidadeId, p_usuario: ctx.usuarioId, p_mes: dia1(mes), p_versao: versao, p_fingerprint: fingerprint,
    p_snapshot: snapshot, p_pendencias_conciliacao: pendenciasConciliacao, p_reconheco_pendencias: reconhecoPendencias === true,
  });
  falha(error);
  return data;
}
export async function reabrirPeriodoRpc(ctxIn, { mes, versao, motivo }, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.rpc("fin_reabrir_periodo", { p_org: ctx.organizacaoId, p_unidade: ctx.unidadeId, p_usuario: ctx.usuarioId, p_mes: dia1(mes), p_versao: versao, p_motivo: motivo });
  falha(error);
  return data;
}

export async function obterConfig(ctxIn, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_config").select("*"), ctx).maybeSingle();
  falha(error);
  return data;
}
export async function gravarConfig(ctxIn, cfg, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.from("fin_config").upsert({ ...cfg, organizacao_id: ctx.organizacaoId, unidade_id: ctx.unidadeId }, { onConflict: "unidade_id" }).select().single();
  falha(error);
  return data;
}
