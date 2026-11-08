// Repositório do Financeiro 2.0 (migration 153): faturamento por canal e ajustes até a base gerencial.
// Mesma regra dos demais: contexto validado, filtro explícito por organização + unidade, sem DELETE (cancela-se com motivo).
import { supabase } from "../../../config/supabase.js";
import { exigirContexto } from "./contexto.js";
import { falha, unid, PAGINA } from "./repositorio.util.js";

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
const lista = (tabela) => (ctxIn, { competencia } = {}, db = supabase) => {
  const ctx = exigirContexto(ctxIn);
  return paginar(() => { let q = unid(db.from(tabela).select("*"), ctx).eq("status", "ativa"); if (competencia) q = q.eq("competencia", competencia); return q.order("created_at").order("id"); });
};
const inserir = (tabela) => async (ctxIn, linha, db = supabase) => {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await db.from(tabela).insert({ ...linha, organizacao_id: ctx.organizacaoId, unidade_id: ctx.unidadeId, criado_por: ctx.usuarioId, atualizado_por: ctx.usuarioId }).select().single();
  falha(error); return data;
};
const atualizar = (tabela) => async (ctxIn, id, campos, db = supabase) => {
  const ctx = exigirContexto(ctxIn);
  const { data, error } = await unid(db.from(tabela).update({ ...campos, atualizado_por: ctx.usuarioId }).eq("id", id), ctx).select().maybeSingle();
  falha(error); return data;
};

export const listarVendasCanal = lista("fin_vendas_canal");
export const inserirVendaCanal = inserir("fin_vendas_canal");
export const atualizarVendaCanal = atualizar("fin_vendas_canal");
export const listarVendasAjustes = lista("fin_vendas_ajustes");
export const inserirVendaAjuste = inserir("fin_vendas_ajustes");
export const atualizarVendaAjuste = atualizar("fin_vendas_ajustes");


/** Insere referências (vendas diárias) e DEVOLVE as linhas gravadas (com id). Sem chave de idempotência: a regra de duplicidade é do serviço (dia + campo). */
export async function inserirReferenciasRetornando(ctxIn, itens, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  const linhas = itens.map((i) => ({ ...i, organizacao_id: ctx.organizacaoId, unidade_id: ctx.unidadeId, criado_por: ctx.usuarioId }));
  const { data, error } = await db.from("fin_referencias").insert(linhas).select();
  falha(error);
  return data ?? [];
}
