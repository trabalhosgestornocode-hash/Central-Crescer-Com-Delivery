// Simulador de preço — cálculo puro: nada de percentual assumido; parcial quando falta a comissão.
// Rodar: node --test frontend/test/simulacaoPreco.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { simularPreco, precoParaMargem, precoParaCmv, compararCenarios, comissaoDoCanal } from "../src/simulacaoPreco.js";

const perto = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

test("com comissão configurada o resultado NÃO é parcial e bate com a fórmula legada (lucro = preço·(1−com) − custo)", () => {
  const r = simularPreco({ custo: 6, preco: 20, comissao: 0.27 });
  assert.equal(r.parcial, false);
  perto(r.lucro, 20 * (1 - 0.27) - 6);
  perto(r.cmvPct, 30); perto(r.margemPct, (r.lucro / 20) * 100);
});
test("SEM comissão configurada: cálculo PARCIAL e nenhum percentual é assumido (nada de 27%)", () => {
  const r = simularPreco({ custo: 6, preco: 20, comissao: null });
  assert.equal(r.parcial, true);
  assert.ok(r.naoConsiderados.includes("comissao"));
  perto(r.lucro, 20 - 6); // não desconta comissão alguma
  assert.equal(r.deducoesPct.comissao, null);
});
test("componentes ausentes ficam listados em naoConsiderados; informados entram na conta", () => {
  const r = simularPreco({ custo: 5, preco: 25, comissao: 0.2, taxas: 0.03, promocao: 0.05, tributos: 0.04, entrega: 2 });
  assert.deepEqual(r.naoConsiderados, []);
  perto(r.lucro, 25 * (1 - 0.32) - 2 - 5);
  const so = simularPreco({ custo: 5, preco: 25, comissao: 0.2 });
  assert.deepEqual(so.naoConsiderados.sort(), ["entrega", "promocao", "taxas", "tributos"]);
});
test("valores inválidos (negativos, ≥100%, NaN) são tratados como NÃO informados", () => {
  const r = simularPreco({ custo: 5, preco: 20, comissao: 1.5, taxas: -0.1, tributos: NaN });
  assert.equal(r.parcial, true);
  assert.ok(r.naoConsiderados.includes("taxas") && r.naoConsiderados.includes("tributos"));
});
test("preço zero/ausente não quebra: sem CMV/lucro/margem", () => {
  const r = simularPreco({ custo: 5, preco: 0, comissao: 0.2 });
  assert.equal(r.cmvPct, null); assert.equal(r.lucro, null); assert.equal(r.margemPct, null);
});
test("precoParaMargem: o preço devolvido realmente entrega a margem pedida", () => {
  const cond = { comissao: 0.27, taxas: 0.02, tributos: 0.04, entrega: 3 };
  const preco = precoParaMargem({ custo: 7, margemAlvoPct: 30, ...cond });
  const r = simularPreco({ custo: 7, preco, ...cond });
  perto(r.margemPct, 30, 1e-9);
});
test("precoParaMargem: impossível quando deduções + margem ≥ 100%", () => {
  assert.equal(precoParaMargem({ custo: 5, margemAlvoPct: 80, comissao: 0.3 }), null);
  assert.equal(precoParaMargem({ custo: 5, margemAlvoPct: 100 }), null);
  assert.equal(precoParaMargem({ custo: 5, margemAlvoPct: -1 }), null);
});
test("precoParaCmv: custo / alvo", () => {
  perto(precoParaCmv(6, 30), 20); assert.equal(precoParaCmv(0, 30), null); assert.equal(precoParaCmv(6, 0), null);
});
test("compararCenarios: atual × proposto com as mesmas condições", () => {
  const c = compararCenarios({ custo: 6, precoAtual: 18, precoProposto: 22, comissao: 0.25 });
  perto(c.deltaLucro, (22 - 18) * 0.75);
  assert.ok(c.deltaMargemPontos > 0);
});
test("comissaoDoCanal: lê SÓ o que a empresa configurou; canal ausente => null (nunca um padrão)", () => {
  const cond = { configurado: true, canais: [{ canal: "ifood", comissao: 0.23 }] };
  assert.equal(comissaoDoCanal(cond, "ifood"), 0.23);
  assert.equal(comissaoDoCanal(cond, "uber"), null);
  assert.equal(comissaoDoCanal(null, "ifood"), null);
  assert.equal(comissaoDoCanal({ configurado: false, canais: [] }, "balcao"), null);
});
