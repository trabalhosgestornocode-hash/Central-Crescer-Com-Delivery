// Apresentação da PROTEÇÃO DA PRECIFICAÇÃO — conceito EXCLUSIVO do Simulador de
// Preço. Não é indicador logístico; nunca aparece na aba Indicadores, nos cards
// principais nem na Visão Geral.
import { escapeHtml, fmtMoeda } from "./utils.js";
import { infoCalculoTip, moedaLonga, numLongo, NOTA_PRECISAO_SIMULADOR } from "./infoCalculo.js";

const decimal = (v) => v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Formatadores de 2 casas — usados na área de Rentabilidade (Simulador) e na
// tabela de Indicadores de Rentabilidade. NÃO substituem o `fmtPct` global de
// 1 casa (utils.js), usado no resto do Dashboard.
export const fmtPctRentabilidade = (v) => Number.isFinite(v) ? decimal(v) + "%" : "—";
export const fmtPpRentabilidade = (v) => Number.isFinite(v) ? decimal(v) + " p.p." : "—";
const d2 = (v) => Number.isFinite(v) ? decimal(v) : "—";

const tabela = (v) => escapeHtml(v ?? "não configurada");
export const estrategiaRentabilidade = (pp) =>
  'Balcão ' + tabela(pp?.precos?.tabelas?.balcao) + ' × iFood ' + tabela(pp?.precos?.tabelas?.ifood);

function metrica(label, principal, secundario, info = "") {
  return '<div class="dex-rent-kpi"><span>' + label + info + '</span><strong>' + principal + '</strong>'
    + (secundario ? '<small>' + secundario + '</small>' : '') + '</div>';
}

// --- tooltips de transparência (não alteram matemática) -------------------
const tipProtecaoPct = (pp) => {
  const pi = pp.precos.ifood.preco, pb = pp.precos.balcao.preco;
  if (!Number.isFinite(pi) || !Number.isFinite(pb)) return "";
  return infoCalculoTip({
    linhas: [["Preço iFood", fmtMoeda(pi)], ["Preço Balcão", fmtMoeda(pb)], ["Diferença", fmtMoeda(pi - pb)]],
    formula: "(Preço iFood − Preço Balcão) ÷ Preço iFood × 100",
    calculo: `(${d2(pi)} − ${d2(pb)}) ÷ ${d2(pi)} × 100 = ${numLongo(pp.protecaoPrecificacaoPct)}`,
    resultado: fmtPctRentabilidade(pp.protecaoPrecificacaoPct),
    observacao: "Proteção da Precificação não é meta nem limite logístico.",
  });
};

const tipTicketEquivalente = (pp) => {
  const pi = pp.precos.ifood.preco, pb = pp.precos.balcao.preco, t = pp.ticketMedioIfood, eq = pp.ticketMedioEquivalenteBalcao;
  if (!Number.isFinite(eq)) return "";
  const b = pp.ticketMedioBase;
  const linhas = [];
  if (b && Number.isFinite(b.valorVendasBruto) && Number.isFinite(b.qtdVendas)) {
    linhas.push(["Valor bruto de vendas", fmtMoeda(b.valorVendasBruto)], ["Quantidade de pedidos", String(b.qtdVendas)]);
  }
  linhas.push(["Ticket Médio real usado", moedaLonga(t)], ["Preço Balcão", fmtMoeda(pb)], ["Preço iFood", fmtMoeda(pi)]);
  return infoCalculoTip({
    linhas,
    formula: "Ticket Médio iFood × (Preço Balcão ÷ Preço iFood)",
    calculo: `${numLongo(t)} × (${d2(pb)} ÷ ${d2(pi)}) = ${numLongo(eq)}`,
    resultado: fmtMoeda(eq),
    observacao: "O cálculo usa o Ticket Médio bruto, antes do arredondamento visual.",
  });
};

const tipProtecaoTicket = (pp) => {
  const t = pp.ticketMedioIfood, eq = pp.ticketMedioEquivalenteBalcao, r = pp.protecaoFinanceiraReais;
  if (!Number.isFinite(r)) return "";
  return infoCalculoTip({
    linhas: [["Ticket Médio iFood (bruto)", moedaLonga(t)], ["Ticket Médio equivalente", moedaLonga(eq)]],
    formula: "Ticket Médio iFood − Ticket Médio equivalente Balcão",
    calculo: `${numLongo(t)} − ${numLongo(eq)} = ${numLongo(r)}`,
    resultado: fmtMoeda(r),
  });
};

// Margem estimada — reaproveitável para o card lateral e para o KPI do resultado.
export const tipMargem = (lado, canal) => {
  if (!lado || !Number.isFinite(lado.margemEstimada)) return "";
  if (canal === "balcao") {
    return infoCalculoTip({
      linhas: [["Preço", fmtMoeda(lado.preco)], ["Custo (ficha técnica)", fmtMoeda(lado.custo)]],
      formula: "Preço − Custo",
      calculo: `${d2(lado.preco)} − ${d2(lado.custo)} = ${numLongo(lado.margemEstimada)}`,
      resultado: fmtMoeda(lado.margemEstimada) + " · " + fmtPctRentabilidade(lado.margemEstimadaPct),
      observacao: "Margem estimada antes das demais despesas operacionais da loja.",
    });
  }
  return infoCalculoTip({
    linhas: [
      ["Preço iFood", fmtMoeda(lado.preco)], ["Custo (ficha técnica)", fmtMoeda(lado.custo)],
      ["Taxas e Comissões", fmtPctRentabilidade(lado.taxasComissoesPct)],
      ["Serviços e Promoções", fmtPctRentabilidade(lado.servicosPromocoesPct)],
    ],
    formula: "Preço × (1 − Taxas% − Serviços%) − Custo",
    calculo: `${d2(lado.preco)} × (1 − ${d2(lado.taxasComissoesPct)}% − ${d2(lado.servicosPromocoesPct)}%) − ${d2(lado.custo)} = ${numLongo(lado.margemEstimada)}`,
    resultado: fmtMoeda(lado.margemEstimada) + " · " + fmtPctRentabilidade(lado.margemEstimadaPct),
    observacao: "Margem estimada, não é lucro líquido. Não inclui taxas de entregadores, ajustes contra a loja, aluguel, folha, energia nem impostos.",
  });
};

export const tipReceitaAposDeducoes = (lado) => {
  if (!lado || !Number.isFinite(lado.receitaAposDeducoesConsideradas)) return "";
  return infoCalculoTip({
    linhas: [
      ["Preço iFood", fmtMoeda(lado.preco)],
      ["Taxas e Comissões", fmtPctRentabilidade(lado.taxasComissoesPct)],
      ["Serviços e Promoções", fmtPctRentabilidade(lado.servicosPromocoesPct)],
    ],
    formula: "Preço iFood × (1 − Taxas% − Serviços%)",
    calculo: `${d2(lado.preco)} × (1 − ${d2(lado.taxasComissoesPct)}% − ${d2(lado.servicosPromocoesPct)}%) = ${numLongo(lado.receitaAposDeducoesConsideradas)}`,
    resultado: fmtMoeda(lado.receitaAposDeducoesConsideradas),
  });
};

// RESULTADO DA SIMULAÇÃO — só números de precificação. Sem meta/limite logístico.
export function resultadoSimulacaoHtml(pp, inicial) {
  const mudou = pp.precos.tabelas.balcao !== inicial.precos.tabelas.balcao
    || pp.precos.tabelas.ifood !== inicial.precos.tabelas.ifood;
  const margemIfood = pp.comparacao?.ifood;
  return '<section class="dex-rent-simulacao-resultado">'
    + '<header><span class="dex-rent-eyebrow">Resultado da simulação</span><h4>' + estrategiaRentabilidade(pp) + '</h4></header>'
    + '<p>' + (mudou ? 'Simulação independente. Seleção do Dashboard: ' + estrategiaRentabilidade(inicial) + '.' : 'Mesmas tabelas da seleção atual do Dashboard.') + '</p>'
    + '<div class="dex-rent-simulacao-metricas">'
    + metrica('Diferença de preço', fmtMoeda(pp.diferencaPrecoReais), 'iFood − Balcão')
    + metrica('Proteção da precificação', fmtPctRentabilidade(pp.protecaoPrecificacaoPct), '(iFood − Balcão) ÷ iFood', tipProtecaoPct(pp))
    + metrica('Ticket Médio equivalente', fmtMoeda(pp.ticketMedioEquivalenteBalcao), 'Projeção proporcional no Balcão', tipTicketEquivalente(pp))
    + metrica('Proteção por Ticket Médio', fmtMoeda(pp.protecaoFinanceiraReais), 'Ticket real ' + fmtMoeda(pp.ticketMedioIfood), tipProtecaoTicket(pp))
    + (margemIfood && Number.isFinite(margemIfood.margemEstimada)
        ? metrica('Margem estimada iFood', fmtMoeda(margemIfood.margemEstimada) + ' · ' + fmtPctRentabilidade(margemIfood.margemEstimadaPct), 'Após custo, Taxas e Serviços', tipMargem(margemIfood, 'ifood'))
        : '')
    + '</div>'
    + '<p class="dex-rent-nota">Proteção da precificação é o percentual gerado pela diferença entre a tabela Balcão e a tabela iFood — não é meta nem limite logístico.</p>'
    + '<p class="dex-rent-nota dex-rent-nota-precisao">' + NOTA_PRECISAO_SIMULADOR + '</p>'
    + '</section>';
}
