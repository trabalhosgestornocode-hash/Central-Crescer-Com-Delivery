// Repositório do domínio financeiro. REGRA: toda função recebe o contexto validado e filtra explicitamente por
// organizacao_id (+ unidade_id nas tabelas por unidade). O cliente é injetável (`db`) para testes sem banco.
// Sem DELETE: cancelamento é status; desvínculo de transferência é RPC.
import { supabase } from "../../../config/supabase.js";
import { ApiError } from "../../../shared/ApiError.js";
import { exigirContexto } from "./contexto.js";

import { falha, org, unid, PAGINA } from "./repositorio.util.js";

// ---- plano de contas (por organização) ----
export async function listarPlanoContas(ctxIn, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await org(db.from("fin_plano_contas").select("*"), ctx).order("tipo").order("natureza").order("nome");
  falha(error);
  return data ?? [];
}
export async function inserirCategoria(ctxIn, c, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.from("fin_plano_contas").insert({ ...c, organizacao_id: ctx.organizacaoId, criado_por: ctx.usuarioId, atualizado_por: ctx.usuarioId }).select().single();
  falha(error);
  return data;
}
export async function atualizarCategoria(ctxIn, id, campos, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await org(db.from("fin_plano_contas").update({ ...campos, atualizado_por: ctx.usuarioId }).eq("id", id), ctx).select().maybeSingle();
  falha(error);
  if (!data) throw ApiError.notFound("Categoria não encontrada.");
  return data;
}

// ---- contas (por unidade) ----
export async function listarContas(ctxIn, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_contas").select("*"), ctx).order("nome");
  falha(error);
  return data ?? [];
}
export async function inserirConta(ctxIn, c, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.from("fin_contas").insert({ ...c, organizacao_id: ctx.organizacaoId, unidade_id: ctx.unidadeId, criado_por: ctx.usuarioId, atualizado_por: ctx.usuarioId }).select().single();
  falha(error);
  return data;
}
export async function atualizarConta(ctxIn, id, campos, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_contas").update({ ...campos, atualizado_por: ctx.usuarioId }).eq("id", id), ctx).select().maybeSingle();
  falha(error);
  if (!data) throw ApiError.notFound("Conta não encontrada.");
  return data;
}

// ---- saldos de abertura ----
export async function listarAberturas(ctxIn, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_saldos_abertura").select("*"), ctx).order("data_referencia", { ascending: false });
  falha(error);
  return data ?? [];
}
export async function gravarAbertura(ctxIn, a, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.from("fin_saldos_abertura").upsert(
    { ...a, organizacao_id: ctx.organizacaoId, unidade_id: ctx.unidadeId, criado_por: ctx.usuarioId, origem: "manual" },
    { onConflict: "conta_id,data_referencia" },
  ).select().single();
  falha(error);
  return data;
}

// ---- lançamentos ----
export async function listarLancamentos(ctxIn, { de, ate, contaId, categoriaId, sentido, status, pendente, busca, limite = 200, deslocamento = 0 } = {}, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  let q = unid(db.from("fin_lancamentos").select("*", { count: "exact" }), ctx);
  if (de) q = q.gte("data_movimento", de);
  if (ate) q = q.lte("data_movimento", ate);
  if (contaId) q = q.eq("conta_id", contaId);
  if (categoriaId) q = q.eq("categoria_id", categoriaId);
  if (sentido) q = q.eq("sentido", sentido);
  if (status) q = q.eq("status", status);
  if (pendente != null) q = q.eq("classificacao_pendente", pendente);
  if (busca) q = q.ilike("descricao", `%${String(busca).replace(/[%_,()]/g, " ")}%`);
  const { data, error, count } = await q.order("data_movimento", { ascending: false }).order("created_at", { ascending: false }).range(deslocamento, deslocamento + Math.min(limite, 500) - 1);
  falha(error);
  return { itens: data ?? [], total: count ?? (data ?? []).length };
}

/** Todos os lançamentos do período (paginando) — base dos relatórios. */
export async function listarTodosLancamentos(ctxIn, { de, ate } = {}, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const todos = [];
  for (let desde = 0; ; desde += PAGINA) {
    let q = unid(db.from("fin_lancamentos").select("id, conta_id, categoria_id, sentido, valor_centavos, data_movimento, status, classificacao_pendente, descricao, revisao_motivos, nota_revisao, origem"), ctx);
    if (de) q = q.gte("data_movimento", de);
    if (ate) q = q.lte("data_movimento", ate);
    const { data, error } = await q.order("data_movimento").order("id").range(desde, desde + PAGINA - 1);
    falha(error);
    todos.push(...(data ?? []));
    if ((data ?? []).length < PAGINA) break;
  }
  return todos;
}
export async function obterLancamento(ctxIn, id, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_lancamentos").select("*").eq("id", id), ctx).maybeSingle();
  falha(error);
  return data;
}
export async function inserirLancamento(ctxIn, l, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.from("fin_lancamentos").insert({ ...l, organizacao_id: ctx.organizacaoId, unidade_id: ctx.unidadeId, origem: "manual", criado_por: ctx.usuarioId, atualizado_por: ctx.usuarioId }).select().single();
  falha(error);
  return data;
}
export async function atualizarLancamento(ctxIn, id, campos, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_lancamentos").update({ ...campos, atualizado_por: ctx.usuarioId }).eq("id", id), ctx).select().maybeSingle();
  falha(error);
  if (!data) throw ApiError.notFound("Lançamento não encontrado.");
  return data;
}

// ---- transferências ----
export async function listarTransferencias(ctxIn, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_transferencias").select("*"), ctx).order("created_at", { ascending: false }).limit(500);
  falha(error);
  return data ?? [];
}
export async function criarTransferenciaRpc(ctxIn, p, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.rpc("fin_criar_transferencia", {
    p_org: ctx.organizacaoId, p_unidade: ctx.unidadeId, p_usuario: ctx.usuarioId, p_conta_origem: p.contaOrigemId, p_conta_destino: p.contaDestinoId,
    p_valor_centavos: p.valorCentavos, p_data: p.data, p_descricao: p.descricao, p_categoria_id: p.categoriaId,
  });
  falha(error);
  return data;
}
export async function vincularTransferenciaRpc(ctxIn, saidaId, entradaId, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.rpc("fin_vincular_transferencia", { p_org: ctx.organizacaoId, p_unidade: ctx.unidadeId, p_usuario: ctx.usuarioId, p_saida: saidaId, p_entrada: entradaId });
  falha(error);
  return data;
}
/** Desvínculo MOTIVADO (122): só par ativo; as pernas continuam ativas e voltam a pendentes. */
export async function desvincularTransferenciaRpc(ctxIn, id, motivo, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.rpc("fin_desvincular_transferencia_motivada", { p_org: ctx.organizacaoId, p_unidade: ctx.unidadeId, p_usuario: ctx.usuarioId, p_transferencia: id, p_motivo: motivo });
  falha(error);
  return data === true;
}
/** Cancela a transferência INTEIRA (par + duas pernas) numa única transação; idempotente. */
export async function cancelarTransferenciaRpc(ctxIn, id, motivo, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.rpc("fin_cancelar_transferencia", { p_org: ctx.organizacaoId, p_unidade: ctx.unidadeId, p_usuario: ctx.usuarioId, p_transferencia: id, p_motivo: motivo });
  falha(error);
  return data;
}

// ---- importações ----
export async function inserirImportacao(ctxIn, i, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.from("fin_importacoes").insert({ ...i, organizacao_id: ctx.organizacaoId, unidade_id: ctx.unidadeId, criado_por: ctx.usuarioId }).select().single();
  falha(error);
  return data;
}
export async function obterImportacao(ctxIn, id, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_importacoes").select("*").eq("id", id), ctx).maybeSingle();
  falha(error);
  return data;
}
export async function listarImportacoes(ctxIn, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_importacoes").select("id, arquivo_nome, arquivo_hash, status, resumo, criado_por, confirmado_por, confirmado_em, created_at"), ctx).order("created_at", { ascending: false }).limit(100);
  falha(error);
  return data ?? [];
}
export async function atualizarPreviaImportacao(ctxIn, id, previa, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_importacoes").update({ previa }).eq("id", id).eq("status", "previa"), ctx).select("id").maybeSingle();
  falha(error);
  if (!data) throw ApiError.badRequest("A importação não está mais em estado de prévia.", { codigo: "IMPORTACAO_ESTADO_INVALIDO" });
}
export async function cancelarImportacao(ctxIn, id, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from("fin_importacoes").update({ status: "cancelada" }).eq("id", id).eq("status", "previa"), ctx).select("id").maybeSingle();
  falha(error);
  if (!data) throw ApiError.badRequest("Só uma prévia pode ser cancelada.", { codigo: "IMPORTACAO_ESTADO_INVALIDO" });
}
export async function confirmarImportacaoRpc(ctxIn, id, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.rpc("fin_confirmar_importacao", { p_org: ctx.organizacaoId, p_unidade: ctx.unidadeId, p_usuario: ctx.usuarioId, p_importacao: id });
  falha(error);
  return data;
}
/** Chaves já importadas nesta unidade (para idempotência/diff). */
export async function listarExistentesImportacao(ctxIn, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const out = [];
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await unid(db.from("fin_lancamentos").select("id, chave_origem, data_movimento, sentido, valor_centavos, descricao, conta_id").not("chave_origem", "is", null), ctx).order("id").range(desde, desde + PAGINA - 1);
    falha(error);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGINA) break;
  }
  return out;
}

export async function listarAuditoria(ctxIn, { entidade, entidadeId, limite = 100 } = {}, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  let q = unid(db.from("fin_auditoria").select("*"), ctx);
  if (entidade) q = q.eq("entidade", entidade);
  if (entidadeId) q = q.eq("entidade_id", entidadeId);
  const { data, error } = await q.order("id", { ascending: false }).limit(Math.min(limite, 500));
  falha(error);
  return data ?? [];
}

export * from "./repositorio.conciliacao.js";
export * from "./repositorio.periodos.js";
