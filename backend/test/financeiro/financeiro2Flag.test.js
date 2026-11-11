import { test } from "node:test";
import assert from "node:assert/strict";
import { financeiro2Habilitado, organizacoesFinanceiro2Desligadas } from "../../src/shared/financeiro2.flag.js";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000004";
test("Financeiro 2.0 é o padrão: qualquer organização válida entra no modelo novo, sem lista de liberadas", () => {
  for (const env of [{}, { FINANCEIRO_2_DESLIGADO_ORGANIZACOES: "" }, { FINANCEIRO_2_DESLIGADO_ORGANIZACOES: " , " }]) { assert.equal(financeiro2Habilitado(A, env), true); assert.equal(financeiro2Habilitado(B, env), true); }
});
test("a variável antiga (lista de liberadas) não tem mais efeito", () => {
  assert.equal(financeiro2Habilitado(B, { FINANCEIRO_2_ORGANIZACOES: A }), true);
  assert.equal(financeiro2Habilitado(A, { FINANCEIRO_2_ORGANIZACOES: "" }), true);
});
test("chave de emergência desliga só a organização listada; maiúsculas e espaços normalizados", () => {
  const env = { FINANCEIRO_2_DESLIGADO_ORGANIZACOES: ` ${A.toUpperCase()} ` };
  assert.equal(financeiro2Habilitado(A, env), false);
  assert.equal(financeiro2Habilitado(B, env), true);
});
test("lixo e curinga na chave de emergência nunca desligam ninguém", () => {
  for (const v of ["*", "todas", "true", "1", "' or 1=1", `${A}x`]) {
    assert.equal(organizacoesFinanceiro2Desligadas({ FINANCEIRO_2_DESLIGADO_ORGANIZACOES: v }).size, 0, v);
    assert.equal(financeiro2Habilitado(A, { FINANCEIRO_2_DESLIGADO_ORGANIZACOES: v }), true, v);
  }
});
test("organização inválida ou ausente nunca é liberada (fail-closed no identificador)", () => {
  for (const o of [undefined, null, "", "x", 123]) assert.equal(financeiro2Habilitado(o, {}), false);
});
