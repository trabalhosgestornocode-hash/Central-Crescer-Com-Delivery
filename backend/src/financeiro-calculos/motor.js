// Motor financeiro PURO (regime de caixa). Sem I/O, sem relógio, sem banco.
// Entrada: lançamentos { id, contaId, sentido, valorCentavos, papel, status, classificacaoPendente?, parId? }
// Saída: totais por papel, indicadores com fórmula/origem, ponte resultado→caixa, saldos por conta.
// Regras: só `status = realizado` entra no caixa; valor ausente nunca vira zero; divisão por zero → null.

import { PAPEL, SENTIDO, STATUS, PAPEIS } from "./planoContas.js";
import { dividirArredondando, razaoEmBps, somar, formatarBps } from "./dinheiro.js";

export const REGIME = Object.freeze({ id: "caixa", rotulo: "Regime de caixa (gerencial)" });

function validarLancamento(l) {
  if (!l || typeof l !== "object") throw new TypeError("lançamento inválido");
  if (l.sentido !== SENTIDO.ENTRADA && l.sentido !== SENTIDO.SAIDA) throw new TypeError(`sentido inválido (${l.id})`);
  if (!Number.isSafeInteger(l.valorCentavos) || l.valorCentavos < 0) throw new TypeError(`valorCentavos deve ser inteiro >= 0 (${l.id})`);
  if (l.papel != null && !PAPEIS.includes(l.papel)) throw new TypeError(`papel inválido (${l.id}): ${l.papel}`);
}

const vazio = () => ({ entradas: 0, saidas: 0, quantidade: 0 });

/** Totais por papel + entradas/saídas globais. Lançamentos sem papel contam como pendentes (fora dos indicadores). */
export function totalizar(lancamentos) {
  const porPapel = Object.fromEntries(PAPEIS.map((p) => [p, vazio()]));
  const semPapel = vazio();
  let entradasTotais = 0;
  let saidasTotais = 0;
  let considerados = 0;
  let ignorados = 0;
  for (const l of lancamentos) {
    validarLancamento(l);
    if (l.status !== undefined && l.status !== STATUS.REALIZADO) { ignorados++; continue; }
    considerados++;
    const alvo = l.papel ? porPapel[l.papel] : semPapel;
    alvo.quantidade++;
    if (l.sentido === SENTIDO.ENTRADA) { alvo.entradas += l.valorCentavos; entradasTotais += l.valorCentavos; }
    else { alvo.saidas += l.valorCentavos; saidasTotais += l.valorCentavos; }
  }
  if (!Number.isSafeInteger(entradasTotais) || !Number.isSafeInteger(saidasTotais)) throw new RangeError("totais fora da faixa segura");
  return { porPapel, semPapel, entradasTotais, saidasTotais, considerados, ignorados };
}

const liquidoReceita = (v) => v.entradas - v.saidas; // estorno (saída em receita) reduz receita
const liquidoCusto = (v) => v.saidas - v.entradas; // devolução (entrada em custo) reduz custo

/** Apuração completa. `lancamentos` já deve estar filtrado por organização, unidade e período. */
export function apurar(lancamentos) {
  const t = totalizar(lancamentos);
  const p = t.porPapel;

  const receita = liquidoReceita(p[PAPEL.RECEITA_OPERACIONAL]);
  const custos = liquidoCusto(p[PAPEL.CUSTO_VARIAVEL]);
  const despVar = liquidoCusto(p[PAPEL.DESPESA_VARIAVEL]);
  const tributos = liquidoCusto(p[PAPEL.TRIBUTO]);
  const despFixas = liquidoCusto(p[PAPEL.DESPESA_FIXA]);
  const pessoal = liquidoCusto(p[PAPEL.DESPESA_PESSOAL]);
  const despFin = liquidoCusto(p[PAPEL.DESPESA_FINANCEIRA]);

  const margemContribuicao = receita - custos - despVar - tributos;
  const resultado = margemContribuicao - despFixas - pessoal - despFin;
  const estruturaFixa = despFixas + pessoal + despFin;

  const finEntradas = p[PAPEL.FINANCIAMENTO].entradas;
  const finSaidas = p[PAPEL.FINANCIAMENTO].saidas;
  const transfEntradas = p[PAPEL.TRANSFERENCIA].entradas;
  const transfSaidas = p[PAPEL.TRANSFERENCIA].saidas;
  const transfLiquidasExternas = transfSaidas - transfEntradas;

  const saldoAnterior = p[PAPEL.SALDO_ANTERIOR].entradas - p[PAPEL.SALDO_ANTERIOR].saidas;
  const variacaoCaixa = t.entradasTotais - p[PAPEL.SALDO_ANTERIOR].entradas - (t.saidasTotais - p[PAPEL.SALDO_ANTERIOR].saidas);
  const saldoFinal = variacaoCaixa + saldoAnterior;

  const margemContribuicaoBps = razaoEmBps(margemContribuicao, receita);
  const margemLiquidaBps = razaoEmBps(resultado, receita);
  // PE = estrutura fixa / (MC / receita) = estrutura fixa × receita / MC — sem arredondar a % antes.
  const pontoEquilibrio = margemContribuicao > 0 ? dividirArredondando(BigInt(estruturaFixa) * BigInt(receita), margemContribuicao) : null;

  // Ponte resultado → caixa. Fecha por construção só se nada ficou sem papel.
  const ponte = [
    { id: "resultado", rotulo: "Resultado gerencial", centavos: resultado },
    { id: "fin_entradas", rotulo: "Entradas de financiamentos", centavos: finEntradas },
    { id: "fin_saidas", rotulo: "Pagamentos de financiamentos", centavos: -finSaidas },
    { id: "transf_externas", rotulo: "Transferências líquidas externas", centavos: -transfLiquidasExternas },
  ];
  const variacaoPelaPonte = somar(ponte.map((x) => x.centavos));
  const pendentes = t.semPapel.quantidade;
  const diferencaPonte = variacaoCaixa - variacaoPelaPonte;

  return {
    regime: REGIME,
    totaisPorPapel: p,
    contagem: { considerados: t.considerados, ignoradosPorStatus: t.ignorados, semPapel: pendentes },
    receitaOperacional: receita,
    custosVariaveis: custos,
    despesasVariaveis: despVar,
    tributos,
    despesasFixas: despFixas,
    despesasPessoal: pessoal,
    despesasFinanceiras: despFin,
    margemContribuicao,
    resultadoGerencial: resultado,
    entradasTotais: t.entradasTotais,
    saidasTotais: t.saidasTotais,
    financiamentos: { entradas: finEntradas, saidas: finSaidas },
    transferencias: { entradas: transfEntradas, saidas: transfSaidas, liquidasExternas: transfLiquidasExternas },
    saldoAnterior,
    variacaoCaixa,
    saldoFinal,
    margemContribuicaoBps,
    margemLiquidaBps,
    pontoEquilibrio,
    ponteResultadoCaixa: { linhas: ponte, variacaoCaixa, diferenca: diferencaPonte, fecha: diferencaPonte === 0, saldoAnterior, saldoFinal },
    // Apresentação defensiva: a margem é percentual, nunca moeda (inconsistência histórica I-1).
    apresentacao: { margemContribuicao: formatarBps(margemContribuicaoBps), margemLiquida: formatarBps(margemLiquidaBps) },
    parcial: pendentes > 0,
  };
}

/** Catálogo de indicadores: fórmula e origem verificáveis. `geracaoCaixaOperacional` é alias documentado do resultado. */
export const INDICADORES = Object.freeze([
  { id: "receitaOperacional", unidade: "moeda", formula: "Σ entradas − Σ saídas dos lançamentos com papel receita_operacional", origem: "Lançamentos realizados (regime de caixa): recebimentos líquidos, NÃO vendas brutas" },
  { id: "custosVariaveis", unidade: "moeda", formula: "Σ saídas − Σ entradas do papel custo_variavel", origem: "Compras, fretes, descartáveis e tarifas pagos. NÃO é CMV consumido" },
  { id: "margemContribuicao", unidade: "moeda", formula: "receita − custos variáveis − despesas variáveis − tributos", origem: "Derivado" },
  { id: "margemContribuicaoPct", unidade: "percentual", formula: "margem de contribuição ÷ receita", origem: "Derivado; precisão integral até o resultado" },
  { id: "resultadoGerencial", unidade: "moeda", formula: "margem de contribuição − despesas fixas − pessoal − despesas financeiras", origem: "Derivado" },
  { id: "margemLiquidaPct", unidade: "percentual", formula: "resultado gerencial ÷ receita (percentual, nunca moeda)", origem: "Derivado" },
  { id: "pontoEquilibrio", unidade: "moeda", formula: "(fixas + pessoal + financeiras) ÷ (margem de contribuição ÷ receita)", origem: "Derivado; arredonda só o resultado final" },
  { id: "geracaoCaixaOperacional", unidade: "moeda", formula: "idem resultadoGerencial", origem: "Equivalência documentada com o resultado gerencial (a planilha original usa a mesma fórmula)", aliasDe: "resultadoGerencial" },
  { id: "variacaoCaixa", unidade: "moeda", formula: "entradas − saídas, excluído o saldo anterior", origem: "Lançamentos realizados" },
  { id: "saldoFinal", unidade: "moeda", formula: "variação do caixa + saldo anterior informado", origem: "Saldo calculado; só é saldo conciliado com extrato externo" },
]);

/**
 * Saldos por conta. `aberturas`: Map|objeto contaId → centavos | null (null = abertura DESCONHECIDA).
 * Abertura desconhecida NÃO vira zero: o saldo sai marcado como parcial.
 */
export function saldosPorConta(contas, aberturas, lancamentos) {
  const ab = aberturas instanceof Map ? aberturas : new Map(Object.entries(aberturas ?? {}));
  const mov = new Map();
  for (const l of lancamentos) {
    validarLancamento(l);
    if (l.papel === PAPEL.SALDO_ANTERIOR) continue; // saldo anterior vive em fin_saldos_abertura
    if (l.status !== undefined && l.status !== STATUS.REALIZADO) continue;
    const m = mov.get(l.contaId) ?? { entradas: 0, saidas: 0 };
    if (l.sentido === SENTIDO.ENTRADA) m.entradas += l.valorCentavos; else m.saidas += l.valorCentavos;
    mov.set(l.contaId, m);
  }
  const contasOut = contas.map((c) => {
    const m = mov.get(c.id) ?? { entradas: 0, saidas: 0 };
    const abertura = ab.has(c.id) ? ab.get(c.id) : null;
    const variacao = m.entradas - m.saidas;
    const conhecida = abertura !== null && abertura !== undefined;
    return {
      contaId: c.id, nome: c.nome, entradas: m.entradas, saidas: m.saidas, variacao,
      aberturaCentavos: conhecida ? abertura : null,
      saldoCentavos: conhecida ? abertura + variacao : null,
      saldoSemAberturaCentavos: variacao,
      parcial: !conhecida,
    };
  });
  const todasConhecidas = contasOut.every((c) => !c.parcial);
  return {
    contas: contasOut,
    totalCentavos: todasConhecidas ? somar(contasOut.map((c) => c.saldoCentavos)) : null,
    parcial: !todasConhecidas,
  };
}

/** Transferências vinculadas devem fechar em zero consolidado. Retorna violações. */
export function validarParesTransferencia(lancamentos) {
  const grupos = new Map();
  for (const l of lancamentos) {
    if (l.papel !== PAPEL.TRANSFERENCIA || !l.parId) continue;
    const g = grupos.get(l.parId) ?? [];
    g.push(l);
    grupos.set(l.parId, g);
  }
  const violacoes = [];
  for (const [parId, g] of grupos) {
    const liquido = g.reduce((s, l) => s + (l.sentido === SENTIDO.ENTRADA ? l.valorCentavos : -l.valorCentavos), 0);
    const contas = new Set(g.map((l) => l.contaId));
    if (g.length !== 2) violacoes.push({ parId, motivo: "par deve ter exatamente 2 pernas" });
    else if (liquido !== 0) violacoes.push({ parId, motivo: "par não fecha em zero", liquido });
    else if (contas.size !== 2) violacoes.push({ parId, motivo: "pernas na mesma conta" });
  }
  return violacoes;
}
