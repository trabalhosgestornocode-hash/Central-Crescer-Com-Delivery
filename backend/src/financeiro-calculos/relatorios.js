// Projeções (DRE gerencial, ranking de categorias, séries) construídas sobre o motor. PURAS e sem nomes de categoria no código:
// os detalhes de cada linha são as categorias que carregam o papel correspondente.
import { PAPEL, SENTIDO, STATUS } from "./planoContas.js";
import { apurar, REGIME } from "./motor.js";
import { razaoEmBps, dividirArredondando } from "./dinheiro.js";

/** Junta lançamentos do banco com o plano de contas → entrada do motor. Sem categoria = papel null (pendente). */
export function paraEntradaMotor(lancamentos, categoriasPorId) {
  return lancamentos.map((l) => ({
    id: l.id, contaId: l.conta_id ?? l.contaId, sentido: l.sentido, valorCentavos: Number(l.valor_centavos ?? l.valorCentavos),
    papel: l.categoria_id ? (categoriasPorId.get(l.categoria_id)?.papel ?? null) : null,
    status: l.status, categoriaId: l.categoria_id ?? null, data: l.data_movimento ?? l.data, descricao: l.descricao,
  }));
}

/** Saldos de abertura do período viram a linha "saldo anterior" (fora do movimento do mês). */
export function aberturasComoLancamentos(aberturas, de, ate) {
  return aberturas
    .filter((a) => (!de || a.data_referencia >= de) && (!ate || a.data_referencia <= ate))
    .map((a, i) => ({ id: `abertura-${i}`, contaId: a.conta_id, sentido: SENTIDO.ENTRADA, valorCentavos: Number(a.valor_centavos), papel: PAPEL.SALDO_ANTERIOR, status: STATUS.REALIZADO }));
}

function liquidoDaCategoria(ls, papel) {
  const porCat = new Map();
  for (const l of ls) {
    if (l.papel !== papel || (l.status !== undefined && l.status !== STATUS.REALIZADO)) continue;
    const k = l.categoriaId ?? "_";
    porCat.set(k, (porCat.get(k) ?? 0) + (l.sentido === SENTIDO.ENTRADA ? l.valorCentavos : -l.valorCentavos));
  }
  return porCat;
}

/**
 * DRE gerencial em REGIME DE CAIXA. Linhas `detalhe` não somam nas linhas de total (somaNoTotal=false).
 * `lancamentos`: entrada do motor (com categoriaId). `categoriasPorId`: Map id → { nome }.
 */
export function montarDre(lancamentos, categoriasPorId) {
  const r = apurar(lancamentos);
  const rec = r.receitaOperacional;
  const pct = (c) => (rec > 0 ? razaoEmBps(c, rec) : null);
  const detalhes = (papel, sinal) => [...liquidoDaCategoria(lancamentos, papel)]
    .map(([id, c]) => ({ categoriaId: id === "_" ? null : id, nome: id === "_" ? "Sem categoria" : (categoriasPorId.get(id)?.nome ?? id), centavos: sinal * c }))
    .filter((d) => d.centavos !== 0).sort((a, b) => b.centavos - a.centavos);
  const total = (id, rotulo, centavos, formula, extra = {}) => ({ id, rotulo, tipo: "total", centavos, percentualReceitaBps: pct(centavos), formula, somaNoTotal: true, ...extra });
  const linhas = [
    total("receita", "Receita operacional recebida", rec, "Σ entradas − Σ saídas das categorias de receita operacional", { detalhes: detalhes(PAPEL.RECEITA_OPERACIONAL, 1) }),
    total("custos", "Custos variáveis (compras e fretes)", r.custosVariaveis, "Σ saídas − Σ entradas das categorias de custo variável", { detalhes: detalhes(PAPEL.CUSTO_VARIAVEL, -1) }),
    total("desp_variaveis", "Despesas variáveis", r.despesasVariaveis, "Σ saídas − Σ entradas das categorias de despesa variável", { detalhes: detalhes(PAPEL.DESPESA_VARIAVEL, -1) }),
    total("tributos", "Tributos", r.tributos, "Σ saídas − Σ entradas das categorias de tributo", { detalhes: detalhes(PAPEL.TRIBUTO, -1) }),
    total("margem_contribuicao", "Margem de contribuição", r.margemContribuicao, "receita − custos variáveis − despesas variáveis − tributos", { destaque: true }),
    total("desp_fixas", "Despesas fixas", r.despesasFixas, "Σ saídas − Σ entradas das categorias de despesa fixa", { detalhes: detalhes(PAPEL.DESPESA_FIXA, -1) }),
    total("pessoal", "Despesas com pessoal", r.despesasPessoal, "Σ saídas − Σ entradas das categorias de pessoal", { detalhes: detalhes(PAPEL.DESPESA_PESSOAL, -1) }),
    total("desp_financeiras", "Despesas financeiras", r.despesasFinanceiras, "Σ saídas − Σ entradas das categorias de despesa financeira", { detalhes: detalhes(PAPEL.DESPESA_FINANCEIRA, -1) }),
    total("resultado", "Resultado gerencial", r.resultadoGerencial, "margem de contribuição − fixas − pessoal − financeiras", { destaque: true }),
    { id: "margem_liquida", rotulo: "Margem líquida", tipo: "percentual", bps: r.margemLiquidaBps, formula: "resultado gerencial ÷ receita operacional (percentual, não moeda)", somaNoTotal: false },
  ];
  return { regime: REGIME, avisos: [
    "Regime de caixa: a receita é o recebimento líquido (não a venda bruta) e os custos são compras e fretes pagos (não o CMV consumido).",
    ...(r.parcial ? [`${r.contagem.semPapel} lançamento(s) sem classificação ficaram fora destes totais.`] : []),
  ], parcial: r.parcial, linhas, apuracao: r };
}

/** Compara dois períodos linha a linha (variação absoluta; percentual só quando a base não é zero). */
export function compararDres(atual, anterior) {
  const idx = new Map(anterior.linhas.map((l) => [l.id, l]));
  return atual.linhas.map((l) => {
    const b = idx.get(l.id);
    if (l.tipo === "percentual") return { id: l.id, atualBps: l.bps, anteriorBps: b?.bps ?? null, deltaPontosBps: l.bps != null && b?.bps != null ? l.bps - b.bps : null };
    const delta = l.centavos - (b?.centavos ?? 0);
    return { id: l.id, atual: l.centavos, anterior: b?.centavos ?? null, delta, deltaBps: b && b.centavos !== 0 ? dividirArredondando(BigInt(delta) * 10000n, Math.abs(b.centavos)) : null };
  });
}

/** Ranking de custos e despesas por categoria (líquido), com participação sobre o total de saídas operacionais. */
export function rankingCategorias(lancamentos, categoriasPorId, { incluir = [PAPEL.CUSTO_VARIAVEL, PAPEL.DESPESA_VARIAVEL, PAPEL.TRIBUTO, PAPEL.DESPESA_FIXA, PAPEL.DESPESA_PESSOAL, PAPEL.DESPESA_FINANCEIRA] } = {}) {
  const itens = [];
  for (const papel of incluir) {
    for (const [id, c] of liquidoDaCategoria(lancamentos, papel)) {
      const centavos = -c;
      if (centavos !== 0) itens.push({ categoriaId: id === "_" ? null : id, nome: id === "_" ? "Sem categoria" : (categoriasPorId.get(id)?.nome ?? id), papel, centavos });
    }
  }
  const total = itens.reduce((s, i) => s + i.centavos, 0);
  itens.sort((a, b) => b.centavos - a.centavos);
  let acum = 0;
  return { totalCentavos: total, itens: itens.map((i) => { acum += i.centavos; return { ...i, participacaoBps: total > 0 ? razaoEmBps(i.centavos, total) : null, acumuladaBps: total > 0 ? razaoEmBps(acum, total) : null }; }) };
}

/** Série de entradas × saídas por 'dia' ou 'mes' (exclui saldo anterior e transferências internas pareadas se informadas). */
export function serieMovimento(lancamentos, { agrupar = "dia", excluirTransferencias = true } = {}) {
  const m = new Map();
  for (const l of lancamentos) {
    if (l.status !== undefined && l.status !== STATUS.REALIZADO) continue;
    if (l.papel === PAPEL.SALDO_ANTERIOR) continue;
    if (excluirTransferencias && l.papel === PAPEL.TRANSFERENCIA) continue;
    const k = agrupar === "mes" ? String(l.data).slice(0, 7) : String(l.data).slice(0, 10);
    const x = m.get(k) ?? { periodo: k, entradas: 0, saidas: 0 };
    if (l.sentido === SENTIDO.ENTRADA) x.entradas += l.valorCentavos; else x.saidas += l.valorCentavos;
    m.set(k, x);
  }
  return [...m.values()].sort((a, b) => a.periodo.localeCompare(b.periodo)).map((x) => ({ ...x, saldo: x.entradas - x.saidas }));
}

/** Movimento por conta no período (entradas, saídas e variação), com transferências identificadas. */
export function movimentoPorConta(lancamentos, contas) {
  const m = new Map(contas.map((c) => [c.id, { contaId: c.id, nome: c.nome, entradas: 0, saidas: 0, transferenciasEntrada: 0, transferenciasSaida: 0 }]));
  for (const l of lancamentos) {
    if (l.status !== undefined && l.status !== STATUS.REALIZADO) continue;
    if (l.papel === PAPEL.SALDO_ANTERIOR) continue;
    const x = m.get(l.contaId);
    if (!x) continue;
    if (l.sentido === SENTIDO.ENTRADA) { x.entradas += l.valorCentavos; if (l.papel === PAPEL.TRANSFERENCIA) x.transferenciasEntrada += l.valorCentavos; }
    else { x.saidas += l.valorCentavos; if (l.papel === PAPEL.TRANSFERENCIA) x.transferenciasSaida += l.valorCentavos; }
  }
  return [...m.values()].map((x) => ({ ...x, variacao: x.entradas - x.saidas }));
}
