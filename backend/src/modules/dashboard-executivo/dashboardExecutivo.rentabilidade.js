// PROTEÇÃO DA PRECIFICAÇÃO — motor slim, conceito EXCLUSIVO do Simulador de
// Preço. Calculado só a partir dos preços da tabela Balcão e da tabela iFood.
//
// NÃO tem meta, NÃO tem limite, NÃO tem status. Não é indicador logístico e
// nunca entra na tabela de Indicadores de Rentabilidade nem sobrescreve as
// metas/limites de marketplace/full_service (`metas_indicadores`).
//
// Percentuais em 0–100. Precisão integral; arredondar só na apresentação.
import { margemEstimadaIfood } from './dashboardExecutivo.calc.js';

const numero = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const finito = (v) => Number.isFinite(v) ? v : null;

/**
 * @param {{precoBalcao: number|null, precoIfood: number|null, ticketMedioIfood: number|null}} p
 * @returns {{
 *   diferencaPrecoReais: number|null,
 *   protecaoPrecificacaoPct: number|null,
 *   ticketMedioIfood: number|null,
 *   ticketMedioEquivalenteBalcao: number|null,
 *   protecaoFinanceiraReais: number|null
 * }}
 */
export function calcularProtecaoPrecificacao({ precoBalcao, precoIfood, ticketMedioIfood }) {
  const b = numero(precoBalcao), i = numero(precoIfood);
  const ticket = numero(ticketMedioIfood);
  // Denominador é o preço do iFood: ((iFood − Balcão) / iFood) × 100.
  const diferencaPrecoReais = b != null && i > 0 ? finito(i - b) : null;
  const protecaoPrecificacaoPct = diferencaPrecoReais != null ? finito(diferencaPrecoReais / i * 100) : null;
  // Ticket equivalente no Balcão: projeção proporcional do Ticket real do iFood.
  const ticketMedioEquivalenteBalcao = ticket != null && b != null && i > 0 ? finito(ticket * (b / i)) : null;
  const protecaoFinanceiraReais = ticketMedioEquivalenteBalcao != null ? finito(ticket - ticketMedioEquivalenteBalcao) : null;
  return {
    diferencaPrecoReais, protecaoPrecificacaoPct,
    ticketMedioIfood: ticket, ticketMedioEquivalenteBalcao, protecaoFinanceiraReais,
  };
}

// Comparação de margem do produto de referência (Simulador). Usa as deduções
// REAIS do mês (Taxas e Comissões + Serviços e Promoções apuradas), não metas.
export function calcularComparacaoProduto(precos, { taxasComissoesPct = null, servicosPromocoesPct = null } = {}) {
  const b = precos.balcao, i = precos.ifood;
  const balcaoValido = b.preco != null && b.custo != null;
  return {
    balcao: {
      ...b,
      margemEstimada: balcaoValido ? b.preco - b.custo : null,
      margemEstimadaPct: balcaoValido ? (b.preco - b.custo) / b.preco * 100 : null,
    },
    ifood: {
      ...i,
      // Deduções REAIS apuradas no mês (percentual sobre o faturamento) — eco
      // dos valores usados na margem, para a UI do Simulador não recalcular.
      taxasComissoesPct, servicosPromocoesPct,
      ...margemEstimadaIfood({
        preco: i.preco, custo: i.custo,
        taxaComissoesPct: i.preco != null && i.custo != null ? taxasComissoesPct : null,
        servicosPromocoesPct,
      }),
    },
  };
}
