// Repositório do Financeiro 2.0 (migration 152): rateios, contas a receber e dívidas/empréstimos.
// Mesma regra dos demais: contexto validado, filtro explícito por organização + unidade, sem DELETE; rateio só por RPC.
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
const rpc = async (db, fn, args) => { const { data, error } = await db.rpc(fn, args); falha(error); return data; };
const base = (ctx) => ({ p_org: ctx.organizacaoId, p_unidade: ctx.unidadeId, p_usuario: ctx.usuarioId });
const lista = (tabela, ordem = "created_at") => (ctxIn, db = supabase) => { const ctx = exigirContexto(ctxIn); return paginar(() => unid(db.from(tabela).select("*"), ctx).order(ordem).order("id")); };
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

// ---- rateios ----
export const listarRateios = lista("fin_rateios");
export async function listarParcelasRateio(ctxIn, db = supabase) {
  const ctx = exigirContexto(ctxIn);
  return paginar(() => unid(db.from("fin_rateio_parcelas").select("*"), ctx).order("competencia").order("id"));
}
export const definirRateioRpc = (ctx, a, db = supabase) => rpc(db, "fin_rateio_definir", { ...base(exigirContexto(ctx)), p_obrigacao: a.obrigacaoId, p_valor_elegivel: a.valorElegivelCentavos,
  p_criterio: a.criterio, p_justificativa: a.justificativa, p_origem_documental: a.origemDocumental ?? null, p_parcelas: a.parcelas, p_chave: a.chave ?? null, p_origem: a.origem ?? "manual" });
export const aprovarRateioRpc = (ctx, id, db = supabase) => rpc(db, "fin_rateio_aprovar", { ...base(exigirContexto(ctx)), p_rateio: id });
export const cancelarRateioRpc = (ctx, id, motivo, db = supabase) => rpc(db, "fin_rateio_cancelar", { ...base(exigirContexto(ctx)), p_rateio: id, p_motivo: motivo });

// ---- contas a receber ----
export const listarRecebiveis = lista("fin_recebiveis", "competencia");
export const inserirRecebivel = inserir("fin_recebiveis");
export const atualizarRecebivel = atualizar("fin_recebiveis");
export const listarRecebimentos = lista("fin_recebimentos", "data");
export const inserirRecebimento = inserir("fin_recebimentos");
export const atualizarRecebimento = atualizar("fin_recebimentos");

// ---- dívidas ----
export const listarDividas = lista("fin_dividas", "credor");
export const inserirDivida = inserir("fin_dividas");
export const atualizarDivida = atualizar("fin_dividas");
export const listarEventosDivida = lista("fin_divida_eventos", "data");
export const inserirEventoDivida = inserir("fin_divida_eventos");
export const atualizarEventoDivida = atualizar("fin_divida_eventos");
