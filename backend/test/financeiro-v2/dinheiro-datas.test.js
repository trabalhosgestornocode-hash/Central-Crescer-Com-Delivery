// Fase E — 2 (precisão monetária), 13 (datas e competências) e 14 (valores inválidos), regras puras.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO, ErroFinanceiro, dinheiro, tempo } from "../../src/modules/financeiro-v2/index.js";

const { ARREDONDAMENTO, centavosDeDecimal, centavosDeTextoBR, exigirCentavos, formatarBRL, proporcao, ratear, somar, subtrair } = dinheiro;
const lanca = (fn, codigo) => assert.throws(fn, (e) => e instanceof ErroFinanceiro && e.codigo === codigo);

test("soma em centavos é exata onde ponto flutuante erra", () => {
  assert.notEqual(0.1 + 0.2, 0.3); // o problema que o módulo evita
  assert.equal(somar(centavosDeDecimal("0.10"), centavosDeDecimal("0.20")), centavosDeDecimal("0.30"));
  assert.equal(somar(...Array(1000).fill(centavosDeDecimal("0.01"))), 1000);
  assert.equal(subtrair(centavosDeDecimal("1.00"), centavosDeDecimal("0.99")), 1);
});

test("conversão de texto decimal e de texto brasileiro, sem passar por float", () => {
  assert.equal(centavosDeDecimal("1234.5"), 123450);
  assert.equal(centavosDeDecimal("-0.07"), -7);
  assert.equal(centavosDeDecimal("19"), 1900);
  assert.equal(centavosDeTextoBR("R$ 1.234,56"), 123456);
  assert.equal(centavosDeTextoBR("-12,3"), -1230);
  assert.equal(centavosDeTextoBR("1234567,89"), 123456789);
  assert.equal(formatarBRL(123456789), "R$ 1.234.567,89");
  assert.equal(formatarBRL(-5), "-R$ 0,05");
  assert.equal(centavosDeTextoBR(formatarBRL(987654321)), 987654321);
});

test("valores monetários inválidos são recusados", () => {
  for (const ruim of [1.5, 0.1 + 0.2, NaN, Infinity, "100", null, undefined, 2 ** 53, 10n]) lanca(() => exigirCentavos(ruim), CODIGO.VALOR_INVALIDO);
  for (const ruim of ["1,5", "1.234", "abc", "", "1e3", " ", "1.2.3", 12.5, "0x10"]) lanca(() => centavosDeDecimal(ruim), CODIGO.VALOR_INVALIDO);
  for (const ruim of ["1.23,4", "12,345", "1,2,3", "R$", "--1,00", "1 000,00"]) lanca(() => centavosDeTextoBR(ruim), CODIGO.VALOR_INVALIDO);
  lanca(() => exigirCentavos(0, "v", { positivo: true }), CODIGO.VALOR_INVALIDO);
  lanca(() => exigirCentavos(-1, "v", { naoNegativo: true }), CODIGO.VALOR_INVALIDO);
  lanca(() => somar(Number.MAX_SAFE_INTEGER, 1), CODIGO.VALOR_INVALIDO);
});

test("arredondamento explícito: metade para cima (padrão) e metade par", () => {
  assert.equal(proporcao(1000, 199, 10000), 20); // 19,9 → 20
  assert.equal(proporcao(25, 1, 2), 13); // 12,5 → 13
  assert.equal(proporcao(-25, 1, 2), -13); // simétrico
  assert.equal(proporcao(25, 1, 2, ARREDONDAMENTO.METADE_PAR), 12);
  assert.equal(proporcao(35, 1, 2, ARREDONDAMENTO.METADE_PAR), 18);
  assert.equal(proporcao(1, 1, 3), 0);
  assert.equal(proporcao(2, 1, 3), 1);
  lanca(() => proporcao(100, 1, 0), CODIGO.VALOR_INVALIDO);
  lanca(() => proporcao(100, 0.5, 1), CODIGO.VALOR_INVALIDO);
  lanca(() => proporcao(100, 1, 2, "QUALQUER"), CODIGO.VALOR_INVALIDO);
});

test("rateio conserva o total: nenhum centavo criado ou perdido", () => {
  assert.deepEqual(ratear(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(ratear(1000, [1, 1, 1]), [334, 333, 333]);
  assert.deepEqual(ratear(5, [0, 3, 1]), [0, 4, 1]);
  for (const [total, pesos] of [[99999, [7, 13, 29, 51]], [1, [1, 1, 1, 1, 1]], [0, [2, 3]], [123457, Array(12).fill(1)]]) {
    const partes = ratear(total, pesos);
    assert.equal(partes.reduce((a, b) => a + b, 0), total);
    assert.ok(partes.every((p) => Number.isSafeInteger(p) && p >= 0));
  }
  lanca(() => ratear(100, []), CODIGO.VALOR_INVALIDO);
  lanca(() => ratear(100, [0, 0]), CODIGO.VALOR_INVALIDO);
  lanca(() => ratear(-1, [1]), CODIGO.VALOR_INVALIDO);
  lanca(() => ratear(100, [1.5]), CODIGO.VALOR_INVALIDO);
});

test("datas reais e competências válidas", () => {
  assert.equal(tempo.exigirData("2026-09-30"), "2026-09-30");
  assert.equal(tempo.exigirData("2028-02-29"), "2028-02-29"); // bissexto
  for (const ruim of ["2026-02-30", "2026-13-01", "2027-02-29", "26-09-01", "2026/09/01", "2026-9-1", "1999-12-31", "", null, 20260901, "2026-09-31"]) {
    lanca(() => tempo.exigirData(ruim), CODIGO.DATA_INVALIDA);
  }
  assert.equal(tempo.exigirCompetencia("2026-09"), "2026-09");
  for (const ruim of ["2026-13", "2026-00", "2026-9", "09/2026", "2026-09-01", null]) lanca(() => tempo.exigirCompetencia(ruim), CODIGO.DATA_INVALIDA);
  assert.equal(tempo.competenciaDe("2026-09-30"), "2026-09");
  assert.equal(tempo.somarMeses("2026-01-31", 1), "2026-02-28");
  assert.equal(tempo.somarMeses("2026-11-30", 3), "2027-02-28");
  assert.equal(tempo.somarMeses("2026-09-15", 0), "2026-09-15");
  assert.equal(tempo.hojeEm(new Date("2026-10-01T02:00:00.000Z")), "2026-09-30"); // 23h do dia 30 em Brasília
});
