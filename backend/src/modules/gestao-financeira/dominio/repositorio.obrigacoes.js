// Repositório do Financeiro 2.0 (migration 151): fornecedores, obrigações (contas a pagar), pagamentos e conciliação de saídas.
// MESMA REGRA dos demais repositórios: toda função recebe o contexto validado e filtra explicitamente por organização (+ unidade).
// Sem DELETE. Transições de estado (quitar, classificar, confirmar, cancelar, conciliar, revogar) só por RPC — o banco recusa UPDATE direto.
import { supabase } from "../../../config/supabase.js";
import { ApiError } from "../../../shared/ApiError.js";
import { exigirContexto } from "./contexto.js";
import { falha, org, unid, PAGINA } from "./repositorio.util.js";

async function paginar(montar) {
  const out = [];
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await montar().range(desde, desde + PAGINA - 1);
    falha(error);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGINA) break;
  }
  return out;
}
const rpc = async (db, fn, args) => { const { data, error } = await db.rpc(fn, args); falha(error); return data; };
const base = (ctx) => ({ p_org: ctx.organizacaoId, p_unidade: ctx.unidadeId, p_usuario: ctx.usuarioId });

// ---- fornecedores (por organização) ----
export async function listarFornecedores(ctxIn, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  return paginar(() => org(db.from("fin_fornecedores").select("*"), ctx).order("nome").order("id"));
}
export async function inserirFornecedor(ctxIn, f, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.from("fin_fornecedores").insert({ ...f, organizacao_id: ctx.organizacaoId, criado_por: ctx.usuarioId, atualizado_por: ctx.usuarioId }).select().single();
  falha(error);
  return data;
}

// ---- obrigações (por unidade) ----
export async function listarObrigacoes(ctxIn, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  return paginar(() => unid(db.from("fin_obrigacoes").select("*"), ctx).order("vencimento").order("id"));
}
export async function obterObrigacao(ctxIn, id, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_obrigacoes").select("*").eq("id", id), ctx).maybeSingle();
  falha(error);
  return data;
}
export async function inserirObrigacao(ctxIn, o, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.from("fin_obrigacoes").insert({ ...o, organizacao_id: ctx.organizacaoId, unidade_id: ctx.unidadeId, origem: "manual", criado_por: ctx.usuarioId, atualizado_por: ctx.usuarioId }).select().single();
  falha(error);
  return data;
}
export async function atualizarObrigacao(ctxIn, id, campos, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_obrigacoes").update({ ...campos, atualizado_por: ctx.usuarioId }).eq("id", id), ctx).select().maybeSingle();
  falha(error);
  if (!data) throw ApiError.notFound("Conta a pagar não encontrada.");
  return data;
}
export const quitarObrigacaoRpc = (ctx, id, db = supabase) => rpc(db, "fin_obrigacao_quitar", { ...base(exigirContexto(ctx)), p_obrigacao: id });
export const desfazerQuitacaoRpc = (ctx, id, motivo, db = supabase) => rpc(db, "fin_obrigacao_desfazer_quitacao", { ...base(exigirContexto(ctx)), p_obrigacao: id, p_motivo: motivo });
export const classificarObrigacaoRpc = (ctx, id, classificacao, db = supabase) => rpc(db, "fin_obrigacao_classificar", { ...base(exigirContexto(ctx)), p_obrigacao: id, p_classificacao: classificacao });
export const confirmarRegistroRpc = (ctx, id, db = supabase) => rpc(db, "fin_obrigacao_confirmar_registro", { ...base(exigirContexto(ctx)), p_obrigacao: id });
export const cancelarObrigacaoRpc = (ctx, id, motivo, db = supabase) => rpc(db, "fin_obrigacao_cancelar", { ...base(exigirContexto(ctx)), p_obrigacao: id, p_motivo: motivo });

// ---- pagamentos (por unidade) ----
export async function listarPagamentos(ctxIn, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  return paginar(() => unid(db.from("fin_pagamentos").select("*"), ctx).order("data_pagamento").order("id"));
}
export async function obterPagamento(ctxIn, id, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_pagamentos").select("*").eq("id", id), ctx).maybeSingle();
  falha(error);
  return data;
}
export async function inserirPagamento(ctxIn, p, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.from("fin_pagamentos").insert({ ...p, organizacao_id: ctx.organizacaoId, unidade_id: ctx.unidadeId, origem: "manual", criado_por: ctx.usuarioId, atualizado_por: ctx.usuarioId }).select().single();
  falha(error);
  return data;
}
export async function atualizarPagamento(ctxIn, id, campos, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_pagamentos").update({ ...campos, atualizado_por: ctx.usuarioId }).eq("id", id), ctx).select().maybeSingle();
  falha(error);
  if (!data) throw ApiError.notFound("Pagamento não encontrado.");
  return data;
}

// ---- conciliação de saídas (por unidade) ----
export async function listarVinculosSaidas(ctxIn, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  return paginar(() => unid(db.from("fin_conciliacao_saidas").select("*"), ctx).order("created_at").order("id"));
}
export async function inserirVinculosSaidas(ctxIn, linhas, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.from("fin_conciliacao_saidas")
    .insert(linhas.map((l) => ({ ...l, organizacao_id: ctx.organizacaoId, unidade_id: ctx.unidadeId, criado_por: ctx.usuarioId, atualizado_por: ctx.usuarioId }))).select();
  falha(error);
  return data ?? [];
}
/** Rejeitar uma sugestão/divergência (não precisa de função: o banco só permite sugerido|divergente → rejeitado). */
export async function rejeitarVinculosSaidas(ctxIn, grupo, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_conciliacao_saidas").update({ status: "rejeitado", rejeitado_por: ctx.usuarioId, rejeitado_em: new Date().toISOString(), atualizado_por: ctx.usuarioId })
    .eq("grupo", grupo).in("status", ["sugerido", "divergente"]), ctx).select("id");
  falha(error);
  return (data ?? []).length;
}
export const confirmarVinculoSaidaRpc = (ctx, grupo, justificativa, db = supabase) => rpc(db, "fin_conciliacao_saida_confirmar", { ...base(exigirContexto(ctx)), p_grupo: grupo, p_justificativa: justificativa ?? null });
export const revogarVinculoSaidaRpc = (ctx, grupo, motivo, db = supabase) => rpc(db, "fin_conciliacao_saida_revogar", { ...base(exigirContexto(ctx)), p_grupo: grupo, p_motivo: motivo });
export async function bloqueiosFechamentoRpc(ctxIn, mesIso, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  return (await rpc(db, "fin2_bloqueios_fechamento", { p_org: ctx.organizacaoId, p_unidade: ctx.unidadeId, p_mes: mesIso })) ?? [];
}

/** Saídas realizadas do extrato (fin_lancamentos) — candidatas à conciliação. Só os campos necessários (inclusive a origem: evidência). */
export async function listarSaidasExtrato(ctxIn, { de, ate } = {}, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  return paginar(() => {
    let q = unid(db.from("fin_lancamentos").select("id, conta_id, categoria_id, descricao, valor_centavos, data_movimento, status, sentido, classificacao_pendente, origem, chave_origem, importacao_id, referencia_origem"), ctx)
      .eq("sentido", "saida").eq("status", "realizado");
    if (de) q = q.gte("data_movimento", de);
    if (ate) q = q.lte("data_movimento", ate);
    return q.order("data_movimento").order("id");
  });
}
