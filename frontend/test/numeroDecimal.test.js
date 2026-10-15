import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  aplicarMascaraMoeda, formatarMoedaBRL, formatarMoedaDuranteDigitacao,
  numeroDecimal, numeroDecimalOuIndefinido,
} from "../src/numeroDecimal.js";

const espacoNormal = (texto) => texto.replace(/[\u00a0\u202f]/g, " ");

describe("parse BRL", () => {
  for (const [entrada, esperado] of [
    ["6523", 6523], ["339495", 339495], ["6523,5", 6523.5],
    ["6523,45", 6523.45], ["6.523,45", 6523.45],
    ["R$ 6.523,45", 6523.45], [`R$\u00a06.523,45`, 6523.45],
  ]) test(`${JSON.stringify(entrada)} -> ${esperado}`, () => assert.equal(numeroDecimal(entrada), esperado));

  test("numero vindo da API preserva centavos", () => assert.equal(numeroDecimal(1234.56), 1234.56));
  test("ponto nao vira separador decimal na entrada textual", () => assert.equal(numeroDecimal("6.523"), 6523));
  test("rejeita formatos invalidos e mais de duas casas", () => {
    for (const valor of ["12,3,4", "1,234.56", "12.34,56", "12,345", "abc"])
      assert.equal(Number.isNaN(numeroDecimal(valor)), true, valor);
  });
  test("vazio continua ausente; zero continua zero", () => {
    assert.equal(numeroDecimalOuIndefinido(""), undefined);
    assert.equal(numeroDecimal("0"), 0);
  });
});

describe("formatacao BRL", () => {
  test("inteiros nao viram centavos de maquininha", () => {
    assert.equal(espacoNormal(formatarMoedaBRL("6523")), "R$ 6.523,00");
    assert.equal(espacoNormal(formatarMoedaBRL("339495")), "R$ 339.495,00");
    assert.equal(numeroDecimal(formatarMoedaBRL("6523")), 6523);
    assert.equal(numeroDecimal(formatarMoedaBRL("339495")), 339495);
  });
  test("centavos explicitos sao completados no formato final", () => {
    assert.equal(espacoNormal(formatarMoedaBRL("6523,5")), "R$ 6.523,50");
    assert.equal(espacoNormal(formatarMoedaBRL("6523,45")), "R$ 6.523,45");
    assert.equal(numeroDecimal(formatarMoedaBRL("6523,45")), 6523.45);
  });
  test("durante a digitacao preserva virgula e centavos parciais", () => {
    assert.equal(formatarMoedaDuranteDigitacao("1234"), "R$ 1.234");
    assert.equal(formatarMoedaDuranteDigitacao("1234,"), "R$ 1.234,");
    assert.equal(formatarMoedaDuranteDigitacao("1234,5"), "R$ 1.234,5");
    assert.equal(formatarMoedaDuranteDigitacao("1234,56"), "R$ 1.234,56");
  });
  test("campo vazio nao ganha R$ 0,00, mas zero explicito ganha", () => {
    assert.equal(formatarMoedaBRL(""), "");
    assert.equal(espacoNormal(formatarMoedaBRL("0")), "R$ 0,00");
  });
  test("numero do backend reabre formatado sem perder centavos", () => {
    assert.equal(espacoNormal(formatarMoedaBRL(1234.56)), "R$ 1.234,56");
    assert.equal(numeroDecimal(formatarMoedaBRL(1234.56)), 1234.56);
  });
  test("negativo fica restrito aos campos que o permitem", () => {
    assert.equal(formatarMoedaDuranteDigitacao("-12,34"), "R$ 12,34");
    assert.equal(formatarMoedaDuranteDigitacao("-12,34", { permiteNegativo: true }), "R$ -12,34");
    assert.equal(numeroDecimal(formatarMoedaDuranteDigitacao("-12,34", { permiteNegativo: true })), -12.34);
  });
});

function inputFalso(valor = "") {
  const eventos = new Map();
  return {
    value: valor, selectionStart: valor.length,
    addEventListener(tipo, fn) { eventos.set(tipo, fn); },
    setSelectionRange(inicio) { this.selectionStart = inicio; },
    disparar(tipo) { eventos.get(tipo)?.(); },
  };
}

test("mascara trata digitacao, paste e blur e entrega valor parseavel", () => {
  const input = inputFalso();
  let estado = null;
  aplicarMascaraMoeda(input, { aoAlterar: (valor) => { estado = valor; } });
  input.value = "R$ 6.523,45"; input.selectionStart = input.value.length; input.disparar("input");
  assert.equal(input.value, "R$ 6.523,45");
  assert.equal(numeroDecimal(estado), 6523.45);
  input.value = "6523,5"; input.selectionStart = input.value.length; input.disparar("input"); input.disparar("blur");
  assert.equal(espacoNormal(input.value), "R$ 6.523,50");
  assert.equal(numeroDecimal(estado), 6523.5);
});

test("paste aceita todos os formatos previstos, inclusive espaco nao separavel", () => {
  for (const entrada of ["6523", "6523,45", "6.523,45", "R$ 6.523,45", `R$\u00a06.523,45`]) {
    const input = inputFalso();
    let estado = null;
    aplicarMascaraMoeda(input, { aoAlterar: (valor) => { estado = valor; } });
    input.value = entrada; input.selectionStart = entrada.length;
    input.disparar("input"); input.disparar("blur");
    assert.equal(espacoNormal(input.value), entrada === "6523" ? "R$ 6.523,00" : "R$ 6.523,45", entrada);
    assert.equal(numeroDecimal(estado), entrada === "6523" ? 6523 : 6523.45, entrada);
  }
});

test("formularios aplicam mascara apenas aos campos monetarios", async () => {
  const { readFile } = await import("node:fs/promises");
  const diario = await readFile(new URL("../src/dashboardExecutivoForm.js", import.meta.url), "utf8");
  const mensal = await readFile(new URL("../src/dashboardExecutivoMensal.js", import.meta.url), "utf8");
  for (const id of ["dex-valorbruto", "dex-vifood", "dex-taxas", "dex-entregadores", "dex-aj-favor", "dex-aj-contra"])
    assert.match(diario, new RegExp(`data-moeda[^>]*id="${id}"`), id);
  // Serviços e promoções: o input (com data-moeda) vem do seletor de sinal.
  const sinal = await readFile(new URL("../src/sinalServicos.js", import.meta.url), "utf8");
  assert.match(diario, /campoServicosHtml\(\{[^}]*atributosInput: 'id="dex-servicos"'/);
  assert.match(sinal, /data-moeda \$\{atributosInput\}/);
  assert.match(mensal, /data-moeda id="lm-valor"/);
  assert.match(mensal, /data-moeda id="lm-ed-valor"/);
  assert.doesNotMatch(diario, /data-moeda[^>]*id="dex-(qtd|novos)"/);
  assert.match(diario, /numeroDecimalOuIndefinido\(c\.valorVendasIfood\)/);
  assert.match(mensal, /valorTotalMensal: numeroDecimal\(lm\.valor\)/);
  assert.match(mensal, /valorTotalMensal: lote\.valorTotalMensal/);
  assert.doesNotMatch(mensal, /valorTotalMensal: String\(lote\.valorTotalMensal\)/);
  assert.match(mensal, /valorNormalizado === Number\(valorOriginal\)/);
});
