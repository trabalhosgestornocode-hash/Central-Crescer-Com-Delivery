// Regras puras de títulos (obrigações a pagar e recebíveis). Um título carrega quatro números que SEMPRE fecham:
//
//     saldoCentavos = valorBaseCentavos − liquidadoCentavos + ajustesCentavos
//
// valorBase: valor original da obrigação / líquido esperado original do recebível (nunca muda).
// liquidado: soma das liquidações VÁLIDAS (estornadas não contam).
// ajustes:   soma algébrica dos ajustes documentados (juros +, desconto −, taxa descoberta depois −...).
import { CODIGO, falhar } from "./erros.js";
import { SITUACAO_TITULO } from "./catalogos.js";
import { somar, subtrair } from "./dinheiro.js";

export const saldoDe = (t) => somar(subtrair(t.valorBaseCentavos, t.liquidadoCentavos), t.ajustesCentavos);

export function situacaoDe(titulo) {
  if (titulo.situacao === SITUACAO_TITULO.CANCELADA) return SITUACAO_TITULO.CANCELADA;
  if (titulo.saldoCentavos === 0) return SITUACAO_TITULO.QUITADA;
  return titulo.liquidadoCentavos > 0 ? SITUACAO_TITULO.PARCIAL : SITUACAO_TITULO.ABERTA;
}

function recompor(titulo, liquidadoCentavos, ajustesCentavos) {
  const novo = { ...titulo, liquidadoCentavos, ajustesCentavos };
  novo.saldoCentavos = saldoDe(novo);
  novo.situacao = situacaoDe(novo);
  return { liquidadoCentavos, ajustesCentavos, saldoCentavos: novo.saldoCentavos, situacao: novo.situacao };
}

function exigirVivo(titulo) {
  if (titulo.situacao === SITUACAO_TITULO.CANCELADA) falhar(CODIGO.OPERACAO_INVALIDA, "O título está cancelado.");
}

/** Mudanças ao aplicar uma liquidação. Nunca deixa o saldo negativo. */
export function aplicarLiquidacao(titulo, valorCentavos) {
  exigirVivo(titulo);
  if (valorCentavos <= 0) falhar(CODIGO.VALOR_INVALIDO, "Liquidação deve ser maior que zero.");
  if (valorCentavos > titulo.saldoCentavos) {
    falhar(CODIGO.LIQUIDACAO_EXCEDE_SALDO, "A liquidação é maior que o saldo do título.", { saldoCentavos: titulo.saldoCentavos, valorCentavos });
  }
  return recompor(titulo, somar(titulo.liquidadoCentavos, valorCentavos), titulo.ajustesCentavos);
}

/** Mudanças ao estornar uma liquidação válida. */
export function reverterLiquidacao(titulo, valorCentavos) {
  exigirVivo(titulo);
  if (valorCentavos <= 0 || valorCentavos > titulo.liquidadoCentavos) falhar(CODIGO.OPERACAO_INVALIDA, "Estorno incompatível com o que foi liquidado.");
  return recompor(titulo, subtrair(titulo.liquidadoCentavos, valorCentavos), titulo.ajustesCentavos);
}

/** Mudanças ao aplicar um ajuste (positivo aumenta o saldo; negativo reduz). */
export function aplicarAjuste(titulo, valorCentavos) {
  exigirVivo(titulo);
  if (valorCentavos === 0) falhar(CODIGO.VALOR_INVALIDO, "Ajuste não pode ser zero.");
  if (somar(titulo.saldoCentavos, valorCentavos) < 0) {
    falhar(CODIGO.AJUSTE_EXCEDE_SALDO, "O ajuste deixaria o saldo negativo.", { saldoCentavos: titulo.saldoCentavos, valorCentavos });
  }
  return recompor(titulo, titulo.liquidadoCentavos, somar(titulo.ajustesCentavos, valorCentavos));
}
