// DRE GERENCIAL DE REFERÊNCIA — protótipo PURO e PARAMETRIZÁVEL (critério misto por categoria).
// Visão SEPARADA: não substitui o Fluxo de Caixa (regime de caixa) nem o DRE gerencial atual, e não é DRE por competência contábil.
// Nenhuma regra é fixa no código: linhas, critério por categoria e rateios chegam em `regras` (versionadas; `aprovada` informa
// se a contadora validou). Toda linha traz a ORIGEM de cada parcela (rastreabilidade).
//
//   Linha(L, mês) = Σ pagamentos do mês      das categorias com critério "caixa"       e linha L
//                 + Σ valor original          das obrigações com critério "competencia", competência = mês, SEM rateio, linha L
//                 + Σ rateios do mês          das obrigações rateadas, linha L
//                 + fontes de receita/dedução informadas (vendas, taxas retidas) para as linhas que as declaram
// Indicadores (fórmulas da referência): deduções, líquido, CMV, custos totais, variáveis, fixas, MC, MC%, resultado, margem, PE, PE financeiro.
import { dividirArredondando } from "./dinheiro.js";

export const CRITERIOS = Object.freeze(["caixa", "competencia", "fora"]);
const mesDe = (d) => String(d ?? "").slice(0, 7);

/**
 * @param regras { versao, aprovada, linhas:[{codigo, descricao, grupo}], porCategoria:{ [categoria]: { linha, criterio } },
 *                 grupos:{ deducoes:[cod], cmv:[cod], entregas:[cod], variaveis:[cod], fixas:[cod] },
 *                 fontes:{ [codigo]: "vendasBruto" | "descontos" | "taxasRetidas" } }
 * @param dados  { vendas:{ brutoCentavos, descontosCentavos, taxasRetidasCentavos }, obrigacoes:[{chave, categoria, competencia, valorCentavos, status}],
 *                 pagamentos:[{chave, obrigacaoChave, categoria, data, valorCentavos, status}], rateios:[{obrigacaoChave, categoria, competencia, valorCentavos, criterio}],
 *                 parcelasDividaCentavos: number|null }
 */
export function montarDreReferencia({ mes, regras, dados }) {
  const linhas = new Map(regras.linhas.map((l) => [l.codigo, { ...l, centavos: 0, origens: [] }]));
  const semRegra = new Map(), avisos = [];
  const rateadas = new Set((dados.rateios ?? []).map((r) => r.obrigacaoChave));
  const somar = (cod, v, origem) => { const l = linhas.get(cod); if (!l) { avisos.push(`linha inexistente nas regras: ${cod} (${origem.tipo} ${origem.id})`); return; } l.centavos += v; l.origens.push({ ...origem, centavos: v }); };
  const regra = (cat, id) => { const r = regras.porCategoria[cat]; if (!r) semRegra.set(cat, (semRegra.get(cat) ?? 0) + 1); else if (!CRITERIOS.includes(r.criterio)) avisos.push(`critério inválido para ${cat}: ${r.criterio} (${id})`); return r; };

  for (const o of dados.obrigacoes ?? []) {
    if (o.status === "cancelada") continue;
    const r = regra(o.categoria, o.chave); if (!r || r.criterio !== "competencia") continue;
    if (rateadas.has(o.chave)) continue;                              // entra só pelos rateios
    if (o.competencia === mes) somar(r.linha, o.valorCentavos, { tipo: "obrigacao", id: o.chave, criterio: "competencia" });
  }
  for (const p of dados.pagamentos ?? []) {
    if (p.status === "cancelado") continue;
    const r = regra(p.categoria, p.chave); if (!r || r.criterio !== "caixa") continue;
    if (mesDe(p.data) === mes) somar(r.linha, p.valorCentavos, { tipo: "pagamento", id: p.chave, criterio: "caixa" });
  }
  for (const rt of dados.rateios ?? []) {
    const r = regra(rt.categoria, rt.obrigacaoChave); if (!r || r.criterio === "fora") continue;
    if (rt.competencia === mes) somar(r.linha, rt.valorCentavos, { tipo: "rateio", id: rt.obrigacaoChave, criterio: rt.criterio ?? "rateio" });
  }
  for (const [cod, fonte] of Object.entries(regras.fontes ?? {})) {
    const v = { vendasBruto: dados.vendas?.brutoCentavos, descontos: dados.vendas?.descontosCentavos, taxasRetidas: dados.vendas?.taxasRetidasCentavos }[fonte];
    if (v == null) { avisos.push(`fonte ausente para ${cod}: ${fonte}`); continue; }
    somar(cod, v, { tipo: "fonte", id: fonte, criterio: "informado" });
  }

  const L = (cods) => (cods ?? []).reduce((s, c) => s + (linhas.get(c)?.centavos ?? 0), 0);
  const g = regras.grupos;
  const bruto = L(g.receita);
  const deducoes = L(g.deducoes), liquido = bruto - deducoes, cmv = L(g.cmv), entregas = L(g.entregas);
  const custosTotais = cmv + entregas, variaveis = L(g.variaveis), fixas = L(g.fixas);
  const mc = liquido - custosTotais - variaveis, resultado = mc - fixas;
  const bps = (n, d) => (d ? dividirArredondando(n * 10000, d) : null);
  const mcBps = bps(mc, bruto);
  const pe = mc > 0 && bruto ? dividirArredondando(fixas * bruto, mc) : null;              // fixas ÷ (MC ÷ bruto), arredonda só no fim
  const peFin = dados.parcelasDividaCentavos == null ? null : mc > 0 && bruto ? dividirArredondando((fixas + dados.parcelasDividaCentavos) * bruto, mc) : null;
  return {
    mes, regime: "gerencial de referência (critério misto por categoria)", versaoRegras: regras.versao, regrasAprovadas: Boolean(regras.aprovada),
    linhas: [...linhas.values()],
    indicadores: { faturamentoBruto: bruto, deducoes, faturamentoLiquido: liquido, cmv, entregas, custosTotais, despesasVariaveis: variaveis, despesasFixas: fixas,
      margemContribuicao: mc, margemContribuicaoBps: mcBps, resultadoGerencial: resultado, margemLiquidaBps: bps(resultado, bruto), pontoEquilibrio: pe,
      parcelasDivida: dados.parcelasDividaCentavos ?? null, pontoEquilibrioFinanceiro: peFin },
    pendencias: { categoriasSemRegra: Object.fromEntries(semRegra), avisos, parcial: semRegra.size > 0 || avisos.length > 0 || !regras.aprovada },
  };
}
