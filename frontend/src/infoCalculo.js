// TRANSPARÊNCIA DE CÁLCULO — ícone "i" discreto + tooltip explicando de onde
// veio um valor financeiro derivado (origem, fórmula, valores brutos, resultado
// bruto e valor arredondado exibido).
//
// Reutiliza o mecanismo central de tooltip (tooltip.js): o ícone tem
// `.vd-tip` + `data-tip-html`; o balão flutuante (portal no <body>) é o mesmo
// de qualquer tooltip do sistema, só com a variante `.vd-tip-flutuante--rico`.
//
// NÃO altera nenhuma matemática — os cálculos continuam usando valor bruto e
// arredondando só na exibição. Aqui só EXPLICAMOS isso.
import { escapeHtml } from "./utils.js";

// Até 6 casas (o suficiente para tornar visível a diferença de arredondamento),
// mas sem zeros à toa: valores exatos ficam com 2 casas.
const nBR = (v) => Number.isFinite(v)
  ? v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 6 })
  : "—";

export const moedaLonga = (v) => Number.isFinite(v) ? "R$ " + nBR(v) : "—";
export const pctLongo = (v) => Number.isFinite(v) ? nBR(v) + "%" : "—";
export const numLongo = (v) => nBR(v);

export const NOTA_PRECISAO_SIMULADOR = "Os cálculos usam valores não arredondados. A interface exibe 2 casas decimais.";

/**
 * Ícone "i" com tooltip de transparência de cálculo.
 * @param {{
 *   titulo?: string,
 *   linhas?: Array<[string, string]>,   // [rótulo, valor] — valores brutos usados
 *   formula?: string,
 *   calculo?: string,                    // ex.: "(35,00 − 24,00) ÷ 35,00 × 100 = 31,428571"
 *   resultado: string,                   // valor final arredondado exibido no card
 *   observacao?: string,
 * }} p
 * @returns {string} HTML do ícone (span.vd-tip)
 */
export function infoCalculoTip({ titulo = "Como este valor foi calculado", linhas = [], formula, calculo, resultado, observacao }) {
  const rows = (linhas || [])
    .map(([k, v]) => `<div class="vd-tipc-linha"><span>${escapeHtml(k)}</span><b>${escapeHtml(String(v))}</b></div>`)
    .join("");
  const balao = '<div class="vd-tipc">'
    + `<div class="vd-tipc-tit">${escapeHtml(titulo)}</div>`
    + rows
    + (formula ? `<div class="vd-tipc-bloco"><span>Fórmula</span><code>${escapeHtml(formula)}</code></div>` : "")
    + (calculo ? `<div class="vd-tipc-bloco"><span>Cálculo</span><code>${escapeHtml(calculo)}</code></div>` : "")
    + `<div class="vd-tipc-linha vd-tipc-res"><span>Valor exibido</span><b>${escapeHtml(String(resultado))}</b></div>`
    + (observacao ? `<div class="vd-tipc-obs">${escapeHtml(observacao)}</div>` : "")
    + "</div>";

  // aria-label = versão linear do mesmo conteúdo, para leitor de tela.
  const aria = [titulo, ...(linhas || []).map(([k, v]) => `${k}: ${v}`),
    formula ? `Fórmula: ${formula}` : "", calculo ? `Cálculo: ${calculo}` : "",
    `Valor exibido: ${resultado}`, observacao || ""].filter(Boolean).join(". ");

  return '<span class="vd-tip vd-tip-calc" tabindex="0" role="button"'
    + ` aria-label="${escapeHtml(aria)}" data-tip-html="${escapeHtml(balao)}">i</span>`;
}
