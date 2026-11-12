// Definições CENTRALIZADAS de indicadores. DRE, Visão Geral e qualquer tela futura consomem ESTAS definições —
// nenhuma tela implementa fórmula própria. Todo total sai acompanhado da lista de registros que o compõem.
//
// Econômico (resultado, por competência) e financeiro (caixa, por data efetiva) são famílias SEPARADAS:
// transferência interna, pagamento e recebimento nunca entram no resultado; venda e despesa nunca entram no caixa.
import { CODIGO, falhar } from "./erros.js";
import { NATUREZA_LANCAMENTO as N, NATUREZA_MOVIMENTACAO, SENTIDO, SITUACAO_LANCAMENTO, SITUACAO_TITULO, TIPO } from "./catalogos.js";
import { somarLista } from "./dinheiro.js";
import { competenciaDe } from "./tempo.js";

const lancamentos = (natureza) => (d, comp) =>
  d.lancamentos.filter((l) => l.natureza === natureza && l.situacao === SITUACAO_LANCAMENTO.ATIVO && l.competencia === comp)
    .map((l) => ({ registroTipo: TIPO.LANCAMENTO, registroId: l.id, valorCentavos: l.valorCentavos, origem: l.origem }));

const movimentacoes = (sentido) => (d, comp) =>
  d.movimentacoes.filter((m) => m.sentido === sentido && m.natureza !== NATUREZA_MOVIMENTACAO.TRANSFERENCIA_INTERNA && competenciaDe(m.dataEfetiva) === comp)
    .map((m) => ({ registroTipo: TIPO.MOVIMENTACAO, registroId: m.id, valorCentavos: m.valorCentavos, origem: null }));

const titulos = (colecao, tipo) => (d, comp) =>
  d[colecao].filter((t) => t.situacao !== SITUACAO_TITULO.CANCELADA && t.saldoCentavos > 0 && t.competencia === comp)
    .map((t) => ({ registroTipo: tipo, registroId: t.id, valorCentavos: t.saldoCentavos, origem: null }));

const SIMPLES = {
  RECEITA_BRUTA: { familia: "ECONOMICO", definicao: "Soma dos lançamentos ativos de natureza RECEITA na competência.", itens: lancamentos(N.RECEITA) },
  DEDUCOES: { familia: "ECONOMICO", definicao: "Soma dos lançamentos ativos de natureza DEDUCAO na competência (taxas e descontos retidos).", itens: lancamentos(N.DEDUCAO) },
  DESPESAS: { familia: "ECONOMICO", definicao: "Soma dos lançamentos ativos de natureza DESPESA na competência.", itens: lancamentos(N.DESPESA) },
  ENTRADAS_DE_CAIXA: { familia: "FINANCEIRO", definicao: "Entradas nas contas financeiras no mês, sem transferências internas.", itens: movimentacoes(SENTIDO.ENTRADA) },
  SAIDAS_DE_CAIXA: { familia: "FINANCEIRO", definicao: "Saídas das contas financeiras no mês, sem transferências internas.", itens: movimentacoes(SENTIDO.SAIDA) },
  SALDO_A_PAGAR: { familia: "POSICAO", definicao: "Saldo em aberto das obrigações da competência.", itens: titulos("obrigacoes", TIPO.OBRIGACAO) },
  SALDO_A_RECEBER: { familia: "POSICAO", definicao: "Saldo em aberto dos recebíveis da competência.", itens: titulos("recebiveis", TIPO.RECEBIVEL) },
};

/** Indicadores compostos: soma algébrica de indicadores simples (sinal explícito). */
const COMPOSTOS = {
  RESULTADO_ECONOMICO: {
    familia: "ECONOMICO",
    definicao: "RECEITA_BRUTA − DEDUCOES − DESPESAS da competência.",
    partes: [["RECEITA_BRUTA", 1], ["DEDUCOES", -1], ["DESPESAS", -1]],
  },
  VARIACAO_DE_CAIXA: {
    familia: "FINANCEIRO",
    definicao: "ENTRADAS_DE_CAIXA − SAIDAS_DE_CAIXA do mês.",
    partes: [["ENTRADAS_DE_CAIXA", 1], ["SAIDAS_DE_CAIXA", -1]],
  },
};

export const INDICADOR = Object.freeze(Object.fromEntries([...Object.keys(SIMPLES), ...Object.keys(COMPOSTOS)].map((k) => [k, k])));

/**
 * @param {string} indicador
 * @param {string} competencia "AAAA-MM"
 * @param {{lancamentos:object[], movimentacoes:object[], obrigacoes:object[], recebiveis:object[]}} dados registros de UM escopo
 * @returns {{indicador:string, familia:string, definicao:string, competencia:string, totalCentavos:number, itens:Array<{registroTipo:string, registroId:string, valorCentavos:number, sinal:1|-1, parte:string}>}}
 */
export function compor(indicador, competencia, dados) {
  const simples = SIMPLES[indicador];
  const composto = COMPOSTOS[indicador];
  if (!simples && !composto) falhar(CODIGO.ENTRADA_INVALIDA, "Indicador desconhecido.", { indicador });
  const partes = simples ? [[indicador, 1]] : composto.partes;
  const itens = partes.flatMap(([nome, sinal]) => SIMPLES[nome].itens(dados, competencia).map((i) => ({ ...i, sinal, parte: nome })));
  const def = simples ?? composto;
  return {
    indicador,
    familia: def.familia,
    definicao: def.definicao,
    competencia,
    totalCentavos: somarLista(itens, (i) => i.sinal * i.valorCentavos),
    itens,
  };
}
