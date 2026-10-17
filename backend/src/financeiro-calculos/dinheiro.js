// Aritmética monetária exata: todo valor circula como INTEIRO em centavos (Number seguro) e
// toda divisão usa BigInt com arredondamento explícito. Nunca float em soma/divisão financeira.

export class ValorInvalidoError extends Error {
  constructor(mensagem, valor) {
    super(mensagem);
    this.name = "ValorInvalidoError";
    this.valor = valor;
  }
}

/**
 * Converte entrada (number | string pt-BR/en | bigint | null) em centavos inteiros.
 * - null/undefined/"" → null (valor AUSENTE; nunca vira zero automaticamente).
 * - number com mais de 2 casas significativas → erro (evita truncar centavo em silêncio).
 */
export function paraCentavos(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === "bigint") return Number(valor) * 100;
  if (typeof valor === "number") {
    if (!Number.isFinite(valor)) throw new ValorInvalidoError("valor não finito", valor);
    const c = Math.round(valor * 100);
    // tolera ruído de ponto flutuante do Excel (ex.: 150084.05999999994), rejeita 3ª casa real
    if (Math.abs(valor * 100 - c) > 1e-4) throw new ValorInvalidoError("valor com mais de 2 casas decimais", valor);
    return c;
  }
  if (typeof valor === "string") {
    let s = valor.trim().replace(/^R\$\s*/i, "").replace(/\s/g, "");
    if (s === "") return null;
    let negativo = false;
    if (s.startsWith("-")) { negativo = true; s = s.slice(1); }
    else if (s.startsWith("(") && s.endsWith(")")) { negativo = true; s = s.slice(1, -1); }
    if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
    if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new ValorInvalidoError("formato monetário inválido", valor);
    const [int, frac = ""] = s.split(".");
    const c = Number(int) * 100 + Number(frac.padEnd(2, "0"));
    if (!Number.isSafeInteger(c)) throw new ValorInvalidoError("valor fora da faixa segura", valor);
    return negativo ? -c : c;
  }
  throw new ValorInvalidoError("tipo de valor não suportado", valor);
}

/** Divisão inteira com arredondamento half-away-from-zero. Denominador 0 → null (indisponível). */
export function dividirArredondando(numerador, denominador) {
  const n = BigInt(numerador);
  const d = BigInt(denominador);
  if (d === 0n) return null;
  const sinal = (n < 0n) !== (d < 0n) ? -1n : 1n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = (2n * an + ad) / (2n * ad);
  return Number(sinal * q);
}

/** num/den em pontos-base (1% = 100 bps), sem arredondar nada antes. null se den = 0. */
export function razaoEmBps(numerador, denominador) {
  return dividirArredondando(BigInt(numerador) * 10000n, denominador);
}

/** Formata centavos em "1.234,56" (pt-BR). */
export function formatarCentavos(centavos) {
  if (centavos === null || centavos === undefined) return null;
  const neg = centavos < 0;
  const abs = Math.abs(centavos);
  const inteiro = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}${inteiro},${String(abs % 100).padStart(2, "0")}`;
}

/** Formata bps em "41,49%". */
export function formatarBps(bps) {
  if (bps === null || bps === undefined) return null;
  const neg = bps < 0;
  const abs = Math.abs(bps);
  return `${neg ? "-" : ""}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}%`;
}

export function somar(valores) {
  let t = 0;
  for (const v of valores) t += v;
  if (!Number.isSafeInteger(t)) throw new ValorInvalidoError("soma fora da faixa segura", t);
  return t;
}
