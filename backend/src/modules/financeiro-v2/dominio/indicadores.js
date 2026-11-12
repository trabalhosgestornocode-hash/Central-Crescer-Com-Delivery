// Definições CENTRALIZADAS de indicadores. DRE, Visão Geral e qualquer tela futura consomem ESTAS definições —
// nenhuma tela implementa fórmula própria. Todo total sai acompanhado da lista de registros que o compõem.
//
// Econômico (resultado, por competência) e financeiro (caixa, por data efetiva) são famílias SEPARADAS:
// transferência interna, pagamento e recebimento nunca entram no resultado; venda e despesa nunca entram no caixa.
//
// Taxas e retenções (Execução 01B): cada componente é UM lançamento, classificado pela natureza econômica.
//   - RESULTADO_ECONOMICO conta cada lançamento uma única vez, na sua natureza (visão da DRE).
//   - FATURAMENTO_LIQUIDO_GERENCIAL é a visão do CANAL: receita − deduções comerciais − despesas retidas no repasse.
//     É outra leitura dos MESMOS lançamentos; não se soma às despesas de novo:
//         RESULTADO_ECONOMICO = FATURAMENTO_LIQUIDO_GERENCIAL + OUTRAS_RECEITAS − DESPESAS_FORA_DO_REPASSE
import { CODIGO, falhar } from "./erros.js";
import {
  CLASSIFICACAO, NATUREZA_LANCAMENTO as N, NATUREZA_MOVIMENTACAO, SENTIDO, SITUACAO_LANCAMENTO, SITUACAO_MOVIMENTACAO, SITUACAO_TITULO, TIPO,
} from "./catalogos.js";
import { somarLista } from "./dinheiro.js";
import { competenciaDe } from "./tempo.js";

const lancamentos = (natureza, extra = () => true) => (d, comp, filtro) =>
  d.lancamentos.filter((l) => l.natureza === natureza && l.situacao === SITUACAO_LANCAMENTO.ATIVO && l.competencia === comp && extra(l)
    && (!filtro.canal || l.canal === filtro.canal) && (!filtro.classificacao || l.classificacao === filtro.classificacao))
    .map((l) => ({ registroTipo: TIPO.LANCAMENTO, registroId: l.id, valorCentavos: l.valorCentavos, origem: l.origem, categoria: l.categoria, classificacao: l.classificacao, canal: l.canal ?? null }));

const movimentacoes = (sentido) => (d, comp) =>
  d.movimentacoes.filter((m) => m.sentido === sentido && m.natureza !== NATUREZA_MOVIMENTACAO.TRANSFERENCIA_INTERNA
    && m.situacao !== SITUACAO_MOVIMENTACAO.ESTORNADA && competenciaDe(m.dataEfetiva) === comp)
    .map((m) => ({ registroTipo: TIPO.MOVIMENTACAO, registroId: m.id, valorCentavos: m.valorCentavos, origem: null }));

const titulos = (colecao, tipo) => (d, comp) =>
  d[colecao].filter((t) => t.situacao !== SITUACAO_TITULO.CANCELADA && t.saldoCentavos > 0 && t.competencia === comp)
    .map((t) => ({ registroTipo: tipo, registroId: t.id, valorCentavos: t.saldoCentavos, origem: null }));

const SIMPLES = {
  RECEITA_BRUTA: { familia: "ECONOMICO", definicao: "Soma das receitas operacionais (vendas) ativas na competência.", itens: lancamentos(N.RECEITA, (l) => l.classificacao === CLASSIFICACAO.RECEITA_OPERACIONAL) },
  OUTRAS_RECEITAS: { familia: "ECONOMICO", definicao: "Receitas fora da operação de vendas (outros efeitos gerenciais positivos).", itens: lancamentos(N.RECEITA, (l) => l.classificacao !== CLASSIFICACAO.RECEITA_OPERACIONAL) },
  DEDUCOES: { familia: "ECONOMICO", definicao: "Soma dos lançamentos ativos de natureza DEDUCAO na competência (descontos comerciais, devoluções, tributos sobre vendas).", itens: lancamentos(N.DEDUCAO) },
  DESPESAS: { familia: "ECONOMICO", definicao: "Soma dos lançamentos ativos de natureza DESPESA na competência, retidos no repasse ou não.", itens: lancamentos(N.DESPESA) },
  RETENCOES_DE_CANAL: { familia: "ECONOMICO", definicao: "Despesas que o canal/processador descontou do repasse (comissões, taxas, mensalidades, anúncios, antecipação).", itens: lancamentos(N.DESPESA, (l) => l.retidoNoRepasse === true) },
  DESPESAS_FORA_DO_REPASSE: { familia: "ECONOMICO", definicao: "Despesas pagas pela empresa, não descontadas de repasse.", itens: lancamentos(N.DESPESA, (l) => l.retidoNoRepasse !== true) },
  ENTRADAS_DE_CAIXA: { familia: "FINANCEIRO", definicao: "Entradas válidas nas contas financeiras no mês, sem transferências internas.", itens: movimentacoes(SENTIDO.ENTRADA) },
  SAIDAS_DE_CAIXA: { familia: "FINANCEIRO", definicao: "Saídas válidas das contas financeiras no mês, sem transferências internas.", itens: movimentacoes(SENTIDO.SAIDA) },
  SALDO_A_PAGAR: { familia: "POSICAO", definicao: "Saldo em aberto das obrigações da competência.", itens: titulos("obrigacoes", TIPO.OBRIGACAO) },
  SALDO_A_RECEBER: { familia: "POSICAO", definicao: "Saldo em aberto dos recebíveis da competência.", itens: titulos("recebiveis", TIPO.RECEBIVEL) },
};

/** Indicadores compostos: soma algébrica de indicadores simples (sinal explícito). Nenhum lançamento entra duas vezes. */
const COMPOSTOS = {
  RESULTADO_ECONOMICO: {
    familia: "ECONOMICO",
    definicao: "RECEITA_BRUTA + OUTRAS_RECEITAS − DEDUCOES − DESPESAS da competência. Lançamentos patrimoniais ficam de fora.",
    partes: [["RECEITA_BRUTA", 1], ["OUTRAS_RECEITAS", 1], ["DEDUCOES", -1], ["DESPESAS", -1]],
  },
  FATURAMENTO_LIQUIDO_GERENCIAL: {
    familia: "ECONOMICO",
    definicao: "Visão do canal: RECEITA_BRUTA − DEDUCOES − RETENCOES_DE_CANAL. Não se subtrai das despesas outra vez.",
    partes: [["RECEITA_BRUTA", 1], ["DEDUCOES", -1], ["RETENCOES_DE_CANAL", -1]],
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
 * @param {{canal?:string|null, classificacao?:string|null}} [filtro] recorte por canal/classificação (só indicadores econômicos)
 */
export function compor(indicador, competencia, dados, filtro = {}) {
  const simples = SIMPLES[indicador];
  const composto = COMPOSTOS[indicador];
  if (!simples && !composto) falhar(CODIGO.ENTRADA_INVALIDA, "Indicador desconhecido.", { indicador });
  const def = simples ?? composto;
  const recorte = { canal: filtro.canal ?? null, classificacao: filtro.classificacao ?? null };
  if ((recorte.canal || recorte.classificacao) && def.familia !== "ECONOMICO") {
    falhar(CODIGO.ENTRADA_INVALIDA, "Recorte por canal ou classificação só existe para indicadores econômicos.", { indicador });
  }
  const partes = simples ? [[indicador, 1]] : composto.partes;
  const itens = partes.flatMap(([nome, sinal]) => SIMPLES[nome].itens(dados, competencia, recorte).map((i) => ({ ...i, sinal, parte: nome })));
  return {
    indicador,
    familia: def.familia,
    definicao: def.definicao,
    competencia,
    filtro: recorte,
    totalCentavos: somarLista(itens, (i) => i.sinal * i.valorCentavos),
    itens,
  };
}
