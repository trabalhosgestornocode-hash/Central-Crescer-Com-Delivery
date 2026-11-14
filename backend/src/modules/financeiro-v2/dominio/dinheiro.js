// Dinheiro do Financeiro v2.
//
// REGRA: todo valor monetário é um INTEIRO de centavos (Number seguro). Ponto flutuante binário nunca entra em cálculo:
// números com casas decimais são recusados; texto decimal é convertido por análise de dígitos, sem parseFloat.
// Operações que dividem (proporção, rateio) usam BigInt e arredondamento EXPLÍCITO.
//
// Arredondamento padrão: METADE_PARA_CIMA (meio centavo se afasta do zero — prática comercial brasileira).
// METADE_PAR (bancário) existe para quando uma fonte externa declarar que o usa.
// Rateio usa "maiores restos": a soma das partes é SEMPRE igual ao total (nenhum centavo criado ou perdido).
import { CODIGO, falhar } from "./erros.js";

export const MOEDA_PADRAO = "BRL";
export const MOEDAS = Object.freeze({ BRL: "BRL" });

export const ARREDONDAMENTO = Object.freeze({ METADE_PARA_CIMA: "METADE_PARA_CIMA", METADE_PAR: "METADE_PAR" });

/**
 * Garante que `v` é um inteiro seguro de centavos.
 * @param {unknown} v
 * @param {string} [campo]
 * @param {{positivo?:boolean, naoNegativo?:boolean, naoZero?:boolean}} [regras]
 * @returns {number}
 */
export function exigirCentavos(v, campo = "valorCentavos", regras = {}) {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) {
    falhar(CODIGO.VALOR_INVALIDO, `${campo} deve ser um inteiro de centavos.`, { campo });
  }
  if (regras.positivo && v <= 0) falhar(CODIGO.VALOR_INVALIDO, `${campo} deve ser maior que zero.`, { campo });
  if (regras.naoNegativo && v < 0) falhar(CODIGO.VALOR_INVALIDO, `${campo} não pode ser negativo.`, { campo });
  if (regras.naoZero && v === 0) falhar(CODIGO.VALOR_INVALIDO, `${campo} não pode ser zero.`, { campo });
  return v;
}

function montar(negativo, inteiros, fracao, campo) {
  const cent = BigInt(inteiros) * 100n + BigInt((fracao ?? "").padEnd(2, "0") || "0");
  const n = Number(negativo ? -cent : cent);
  if (!Number.isSafeInteger(n)) falhar(CODIGO.VALOR_INVALIDO, `${campo} fora do intervalo suportado.`, { campo });
  return n === 0 ? 0 : n;
}

const DECIMAL = /^(-)?(\d{1,15})(?:\.(\d{1,2}))?$/;
/** "12345.67" → 1234567. Aceita só texto decimal canônico (ponto, até 2 casas). */
export function centavosDeDecimal(texto, campo = "valor") {
  const m = typeof texto === "string" ? DECIMAL.exec(texto.trim()) : null;
  if (!m) falhar(CODIGO.VALOR_INVALIDO, `${campo} não é um decimal válido (use texto, ex.: "1234.56").`, { campo });
  return montar(!!m[1], m[2], m[3], campo);
}

const TEXTO_BR = /^(-)?(?:R\$\s?)?(-)?(\d{1,3}(?:\.\d{3})+|\d{1,15})(?:,(\d{1,2}))?$/;
/** "R$ 12.345,67" → 1234567. Formato brasileiro (ponto de milhar, vírgula decimal). */
export function centavosDeTextoBR(texto, campo = "valor") {
  const m = typeof texto === "string" ? TEXTO_BR.exec(texto.trim()) : null;
  if (!m || (m[1] && m[2])) falhar(CODIGO.VALOR_INVALIDO, `${campo} não é um valor em reais válido (ex.: "1.234,56").`, { campo });
  return montar(!!(m[1] || m[2]), m[3].replaceAll(".", ""), m[4], campo);
}

export function somar(...valores) {
  let total = 0;
  for (const v of valores) {
    total += exigirCentavos(v, "parcela da soma");
    if (!Number.isSafeInteger(total)) falhar(CODIGO.VALOR_INVALIDO, "Soma fora do intervalo suportado.");
  }
  return total;
}

export const somarLista = (lista, seletor = (x) => x) => somar(...lista.map(seletor));

export function subtrair(a, b) {
  const r = exigirCentavos(a, "minuendo") - exigirCentavos(b, "subtraendo");
  if (!Number.isSafeInteger(r)) falhar(CODIGO.VALOR_INVALIDO, "Subtração fora do intervalo suportado.");
  return r;
}

/**
 * valor × numerador ÷ denominador, em centavos, com arredondamento explícito. Ex.: taxa de 1,99% = proporcao(v, 199, 10000).
 * @returns {number}
 */
export function proporcao(valorCentavos, numerador, denominador, modo = ARREDONDAMENTO.METADE_PARA_CIMA) {
  exigirCentavos(valorCentavos, "valorCentavos");
  if (!Number.isSafeInteger(numerador) || !Number.isSafeInteger(denominador) || denominador <= 0) {
    falhar(CODIGO.VALOR_INVALIDO, "Proporção exige numerador inteiro e denominador inteiro positivo.");
  }
  if (!Object.hasOwn(ARREDONDAMENTO, modo)) falhar(CODIGO.VALOR_INVALIDO, "Modo de arredondamento desconhecido.");
  const n = BigInt(valorCentavos) * BigInt(numerador);
  const d = BigInt(denominador);
  let q = n / d; // trunca em direção a zero
  const resto = n % d;
  const dobro = (resto < 0n ? -resto : resto) * 2n;
  const sobe = dobro > d || (dobro === d && (modo === ARREDONDAMENTO.METADE_PARA_CIMA || q % 2n !== 0n));
  if (sobe) q += n < 0n ? -1n : 1n;
  const r = Number(q);
  if (!Number.isSafeInteger(r)) falhar(CODIGO.VALOR_INVALIDO, "Proporção fora do intervalo suportado.");
  return r === 0 ? 0 : r;
}

/**
 * Divide `totalCentavos` proporcionalmente a `pesos` (inteiros ≥ 0) sem perder nem criar centavos.
 * Os centavos restantes vão para os maiores restos; empate → posição mais antiga.
 * @returns {number[]}
 */
export function ratear(totalCentavos, pesos) {
  exigirCentavos(totalCentavos, "totalCentavos", { naoNegativo: true });
  if (!Array.isArray(pesos) || pesos.length === 0 || pesos.some((p) => !Number.isSafeInteger(p) || p < 0)) {
    falhar(CODIGO.VALOR_INVALIDO, "Rateio exige uma lista de pesos inteiros não negativos.");
  }
  const somaPesos = pesos.reduce((a, p) => a + BigInt(p), 0n);
  if (somaPesos <= 0n) falhar(CODIGO.VALOR_INVALIDO, "Rateio exige ao menos um peso maior que zero.");
  const total = BigInt(totalCentavos);
  const partes = pesos.map((p, i) => ({ i, base: (total * BigInt(p)) / somaPesos, resto: (total * BigInt(p)) % somaPesos }));
  let sobra = total - partes.reduce((a, p) => a + p.base, 0n);
  const ordem = [...partes].sort((a, b) => (a.resto === b.resto ? a.i - b.i : a.resto > b.resto ? -1 : 1));
  for (const p of ordem) {
    if (sobra <= 0n) break;
    p.base += 1n;
    sobra -= 1n;
  }
  return partes.map((p) => Number(p.base));
}

/** 1234567 → "R$ 12.345,67" (somente apresentação; nunca reconverter para calcular). */
export function formatarBRL(valorCentavos) {
  exigirCentavos(valorCentavos);
  const abs = BigInt(Math.abs(valorCentavos));
  const inteiros = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const cent = (abs % 100n).toString().padStart(2, "0");
  return `${valorCentavos < 0 ? "-" : ""}R$ ${inteiros},${cent}`;
}
