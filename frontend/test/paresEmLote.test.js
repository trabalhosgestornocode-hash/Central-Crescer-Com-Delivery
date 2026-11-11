// Seleção dos pares 1:1 seguros para o vínculo em lote. Rodar: node --test frontend/test/paresEmLote.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { paresEmLote } from "../src/financeiro/conferenciasModelo.js";

const L = (n, extra = {}) => ({ status: "um_para_um", saida: { data: "2026-09-05", conta: "A", valorCentavos: 1000 * n }, contrapartidas: [{ data: "2026-09-05", conta: "B", valorCentavos: 1000 * n }],
  vincular: { caminho: "/transferencias/vincular", corpo: { saidaId: `s${n}`, entradaId: `e${n}` } }, ...extra });

test("entram só os 1:1 com rota do servidor; total soma os valores", () => {
  const r = paresEmLote([L(1), L(2), { ...L(3), status: "um_para_varios" }, { ...L(4), status: "ambiguo" }]);
  assert.deepEqual(r.pares.map((p) => p.indice), [0, 1]); assert.equal(r.totalCentavos, 3000); assert.equal(r.ficaramFora, 0);
});
test("perna repetida em dois pares tira os dois do lote (decisão individual)", () => {
  const dup = { ...L(2), vincular: { caminho: "/transferencias/vincular", corpo: { saidaId: "s1", entradaId: "e2" } } };
  const r = paresEmLote([L(1), dup, L(5)]);
  assert.deepEqual(r.pares.map((p) => p.indice), [2]); assert.equal(r.ficaramFora, 2);
});
test("sem rota, valor diferente ou mais de uma contrapartida: fica fora", () => {
  const semRota = { ...L(1), vincular: undefined };
  const valor = { ...L(2), contrapartidas: [{ data: "x", conta: "B", valorCentavos: 1 }] };
  const duas = { ...L(3), contrapartidas: [...L(3).contrapartidas, ...L(3).contrapartidas] };
  assert.equal(paresEmLote([semRota, valor, duas]).pares.length, 0);
});
test("entrada vazia ou inválida não quebra", () => { assert.deepEqual(paresEmLote(undefined).pares, []); assert.deepEqual(paresEmLote([null, {}]).pares, []); });
