// Repositório dos períodos financeiros (B8). Abrir/fechar/reabrir são RPCs atômicas no banco (com trava de linha e impressão digital);
// aqui só se passa o contexto validado. Fechar com pendências só por EXCEÇÃO (unidade+competência, SuperAdmin) — aqui apenas lida.
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

// Leitura SEM efeito colateral (GET de pré-fechamento não cria linha de período).
export async function obterPeriodo(ctxIn, mes, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_periodos").select("*"), ctx).eq("mes", dia1(mes)).maybeSingle();
  falha(error);
  return data;
}

// Exceções de fechamento com pendências (LD-007): só LEITURA aqui. A escrita é por funções DEFINER sem EXECUTE para o service_role.
export async function listarExcecoesFechamento(ctxIn, { mes, apenasAtivas = false } = {}, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  let q = unid(db.from("fin_excecoes_fechamento").select("*"), ctx);
  if (mes) q = q.eq("mes", dia1(mes));
  if (apenasAtivas) q = q.eq("status", "ativa");
  const { data, error } = await q.order("aprovada_em", { ascending: false }).limit(240);
  falha(error);
  return data ?? [];
}
// DESABILITADAS por padrão: o service_role NÃO tem EXECUTE nestas funções até a validação do MFA e a ligação do SuperAdmin (Agente 1).
export async function concederExcecaoFechamentoRpc(ctxIn, { mes, justificativa, validadeDias, pendenciasConciliacao, mfaEvidencia }, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.rpc("fin_conceder_excecao_fechamento", {
    p_org: ctx.organizacaoId, p_unidade: ctx.unidadeId, p_superadmin: ctx.usuarioId, p_mes: dia1(mes), p_justificativa: justificativa,
    p_validade_dias: validadeDias, p_pendencias_conciliacao: pendenciasConciliacao, p_mfa: mfaEvidencia,
  });
  falha(error);
  return data;
}
export async function revogarExcecaoFechamentoRpc(ctxIn, { excecaoId, motivo }, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.rpc("fin_revogar_excecao_fechamento", { p_org: ctx.organizacaoId, p_unidade: ctx.unidadeId, p_superadmin: ctx.usuarioId, p_excecao: excecaoId, p_motivo: motivo });
  falha(error);
  return data;
}
