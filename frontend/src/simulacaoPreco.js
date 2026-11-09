// Cálculo PURO do Simulador de Preço (sem DOM, sem fetch) — testável isoladamente.
//
// Regras (pedidas pelo cliente):
//   * Nenhum percentual é assumido: comissão/taxas/promoção/tributos vêm da configuração DA EMPRESA.
//   * Componente não informado (null/undefined) NÃO entra na conta e é listado em `naoConsiderados`.
//   * A comissão do canal é o componente essencial: sem ela o resultado é PARCIAL (`parcial: true`).
//
// Percentuais chegam como fração (0.27 = 27%). Entrega em reais por pedido.

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pct = (v) => { const n = num(v); return n != null && n >= 0 && n < 1 ? n : null; };

export const COMPONENTES = [
  { chave: "comissao", rotulo: "Comissão do canal", essencial: true },
  { chave: "taxas", rotulo: "Taxas (pagamento/serviço)", essencial: false },
  { chave: "promocao", rotulo: "Promoções custeadas pela loja", essencial: false },
  { chave: "tributos", rotulo: "Tributos", essencial: false },
  { chave: "entrega", rotulo: "Custo de entrega por pedido", essencial: false },
];

/**
 * @param {{custo: number, preco: number, comissao?: number|null, taxas?: number|null, promocao?: number|null,
 *          tributos?: number|null, entrega?: number|null}} p
 */
export function simularPreco({ custo, preco, comissao = null, taxas = null, promocao = null, tributos = null, entrega = null }) {
  const c = num(custo) ?? 0;
  const p = num(preco);
  const fracs = { comissao: pct(comissao), taxas: pct(taxas), promocao: pct(promocao), tributos: pct(tributos) };
  const entregaReais = num(entrega) != null && entrega >= 0 ? entrega : null;
  const naoConsiderados = COMPONENTES
    .filter((k) => (k.chave === "entrega" ? entregaReais == null : fracs[k.chave] == null))
    .map((k) => k.chave);
  const parcial = fracs.comissao == null;

  const somaPct = Object.values(fracs).reduce((s, v) => s + (v ?? 0), 0);
  const deducoesPct = Object.fromEntries(Object.entries(fracs).map(([k, v]) => [k, v == null || p == null ? null : p * v]));
  const base = {
    parcial, naoConsiderados, somaPct, deducoesPct,
    custo: c, preco: p, entrega: entregaReais,
  };
  if (p == null || p <= 0) return { ...base, cmvPct: null, receitaLiquida: null, lucro: null, margemPct: null };
  const receitaLiquida = p * (1 - somaPct) - (entregaReais ?? 0);
  const lucro = receitaLiquida - c;
  return { ...base, cmvPct: (c / p) * 100, receitaLiquida, lucro, margemPct: (lucro / p) * 100 };
}

/**
 * Preço necessário para atingir uma margem de contribuição desejada (sobre o preço).
 *   lucro = preco·(1 − Σ%) − entrega − custo  ;  margem = lucro/preco
 *   => preco = (custo + entrega) / (1 − Σ% − margem)
 * Devolve null quando é matematicamente impossível (deduções + margem ≥ 100%).
 */
export function precoParaMargem({ custo, margemAlvoPct, comissao = null, taxas = null, promocao = null, tributos = null, entrega = null }) {
  const m = num(margemAlvoPct);
  if (m == null || m < 0 || m >= 100) return null;
  const somaPct = [comissao, taxas, promocao, tributos].reduce((s, v) => s + (pct(v) ?? 0), 0);
  const den = 1 - somaPct - m / 100;
  if (den <= 0) return null;
  return ((num(custo) ?? 0) + (num(entrega) != null && entrega >= 0 ? entrega : 0)) / den;
}

/** Preço para atingir um CMV-alvo (%), sem deduções: custo / alvo. */
export function precoParaCmv(custo, cmvAlvoPct) {
  const c = num(custo); const a = num(cmvAlvoPct);
  return c != null && c > 0 && a != null && a > 0 ? (c * 100) / a : null;
}

/** Cenário atual × proposto, lado a lado, com o mesmo conjunto de condições. */
export function compararCenarios({ custo, precoAtual, precoProposto, ...cond }) {
  const atual = simularPreco({ custo, preco: precoAtual, ...cond });
  const proposto = simularPreco({ custo, preco: precoProposto, ...cond });
  return {
    atual, proposto,
    deltaLucro: atual.lucro != null && proposto.lucro != null ? proposto.lucro - atual.lucro : null,
    deltaMargemPontos: atual.margemPct != null && proposto.margemPct != null ? proposto.margemPct - atual.margemPct : null,
  };
}

/** Comissão do canal a partir da resposta de /cmv/condicoes-comerciais. Null = não configurada. */
export function comissaoDoCanal(condicoes, canal) {
  const c = condicoes?.canais?.find((x) => x.canal === canal);
  return c ? c.comissao : null;
}
