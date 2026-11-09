// CMV teórico do iFood — camada de dados. Escopo SEMPRE organização + unidade do contexto da sessão.
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { carregarGrafo } from "../produtos/custo.js";
import { condicoesComerciais } from "../cmv/cmv.condicoes.js";
import { calcularCmvTeorico } from "./cmvTeorico.calc.js";

const MAX_DIAS = 92;
const PAGINA = 1000;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

/** Valida o período (datas ISO 'AAAA-MM-DD', no máximo 92 dias). Puro. */
export function validarPeriodo(de, ate) {
  if (!RE_DATA.test(String(de ?? "")) || !RE_DATA.test(String(ate ?? ""))) throw ApiError.badRequest("Informe o período (de/ate) no formato AAAA-MM-DD.");
  const d0 = Date.parse(`${de}T00:00:00-03:00`); const d1 = Date.parse(`${ate}T23:59:59.999-03:00`);
  if (!Number.isFinite(d0) || !Number.isFinite(d1) || d1 < d0) throw ApiError.badRequest("Período inválido.");
  if ((d1 - d0) / 86400000 > MAX_DIAS) throw ApiError.badRequest(`Período máximo de ${MAX_DIAS} dias.`);
  return { inicio: new Date(d0).toISOString(), fim: new Date(d1).toISOString() };
}

export async function cmvTeoricoIfood({ organizacaoId, unidadeId, de, ate, limiteCmvPct = null }) {
  if (!unidadeId) throw ApiError.badRequest("Selecione uma unidade.");
  const { inicio, fim } = validarPeriodo(de, ate);

  // A unidade precisa pertencer à organização do contexto (nunca confiar só no id recebido).
  const { data: und, error: eUnd } = await supabase.from("unidades").select("id").eq("id", unidadeId).eq("organizacao_id", organizacaoId).maybeSingle();
  if (eUnd) throw ApiError.internal(eUnd.message);
  if (!und) throw ApiError.forbidden("Unidade fora da sua empresa.");

  const pedidos = [];
  for (let from = 0; ; from += PAGINA) {
    const { data, error } = await supabase.from("ifood_pedidos")
      .select("order_id, items")
      .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
      .eq("status_oficial", "CONCLUDED").or("is_test.is.null,is_test.eq.false")
      .gte("order_created_at", inicio).lte("order_created_at", fim)
      .order("order_created_at", { ascending: true }).range(from, from + PAGINA - 1);
    if (error) throw ApiError.internal(error.message);
    pedidos.push(...(data ?? []));
    if (!data || data.length < PAGINA) break;
  }

  const [grafo, condicoes, produtos] = await Promise.all([
    carregarGrafo(organizacaoId),
    condicoesComerciais({ organizacaoId }),
    supabase.from("produtos").select("id, nome, codigo_pdv, vendavel, ativo").eq("organizacao_id", organizacaoId)
      .then(({ data, error }) => { if (error) throw ApiError.internal(error.message); return data ?? []; }),
  ]);
  const comissaoCanal = condicoes.canais.find((c) => c.canal === "ifood")?.comissao ?? null;
  const resultado = calcularCmvTeorico({ pedidos, produtos, grafo, comissaoCanal, limiteCmvPct });
  return { periodo: { de, ate }, unidade_id: unidadeId, total_pedidos_concluidos: pedidos.length, ...resultado };
}
