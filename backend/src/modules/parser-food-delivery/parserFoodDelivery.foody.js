// Ponte Parser → fechamentos Foody (Fase C) — SOMENTE LEITURA, atrás de flag própria, desligada por padrão.
//
//   FOODY_CENTRAL_PARSER_ENABLED=true  E  unidade em FOODY_CENTRAL_PARSER_UNIDADES (uuid, vírgula; Subway e Açaí entram um a um)
//
// Com a flag desligada, `carregarFonteLogistica` devolve null SEM consultar nada e a resposta do Parser fica byte a byte igual.
// Com a flag ligada, o Parser ganha um bloco ADICIONAL `fonteLogistica` (foody.fonte.js) — nunca altera pedidos, resumo,
// entregadores, lançamentos nem o dashboard operacional do Excel: a conciliação e o pagamento continuam 100% do Excel.
// Isolamento: só lê fechamentos da MESMA organização e unidade do contexto (e confere cada linha). Falha de leitura nunca
// derruba o Parser: o bloco volta com `erro`.
import { resolverFontePorDia } from "../foody/foody.fonte.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FLAG_PARSER = "FOODY_CENTRAL_PARSER_ENABLED";
export const FLAG_PARSER_UNIDADES = "FOODY_CENTRAL_PARSER_UNIDADES";

export function fonteFoodyNoParserPermitida(env, unidadeId) {
  if (String(env?.[FLAG_PARSER] ?? "").trim().toLowerCase() !== "true") return false;
  const lista = new Set(String(env?.[FLAG_PARSER_UNIDADES] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => UUID.test(s)));
  return lista.has(String(unidadeId ?? "").toLowerCase());
}

/**
 * @param {{ db, env?, organizacaoId, unidadeId, dataInicio, dataFim, pedidosElegiveis, todos, resumoPorDia, custoReal }} p
 * @returns {Promise<object|null>} null = flag desligada (nada consultado)
 */
export async function carregarFonteLogistica({ db, env = process.env, organizacaoId, unidadeId, dataInicio, dataFim, pedidosElegiveis, todos, resumoPorDia, custoReal }) {
  if (!fonteFoodyNoParserPermitida(env, unidadeId)) return null;
  try {
    const { data, error } = await db.from("foody_fechamentos_logisticos")
      .select("organizacao_id, unidade_id, competencia, versao, status, estado_valores, indicadores")
      .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
      .gte("competencia", dataInicio).lte("competencia", dataFim)
      .order("competencia", { ascending: true }).order("versao", { ascending: false })
      .limit(5000);
    if (error) return { erro: "FONTE_FOODY_INDISPONIVEL" };
    const linhas = data ?? [];
    if (linhas.some((r) => r.organizacao_id !== organizacaoId || r.unidade_id !== unidadeId)) return { erro: "FONTE_FOODY_TENANT_DIVERGENTE" };
    const operacao = linhas.map((r) => r.indicadores?.operacao).find(Boolean) ?? "subway";
    return resolverFontePorDia({ de: dataInicio, ate: dataFim, operacao, fechamentos: linhas,
      excel: { pedidosElegiveis, todos, resumoPorDia, custoReal } });
  } catch {
    return { erro: "FONTE_FOODY_INDISPONIVEL" };
  }
}
