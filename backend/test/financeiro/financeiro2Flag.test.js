import { test } from "node:test";
import assert from "node:assert/strict";
import { financeiro2Habilitado, organizacoesFinanceiro2 } from "../../src/shared/financeiro2.flag.js";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000004";
test("flag do Financeiro 2.0: ausente ou vazio = desligado para todas (fail-closed)", () => {
  for (const env of [{}, { FINANCEIRO_2_ORGANIZACOES: "" }, { FINANCEIRO_2_ORGANIZACOES: " , " }]) assert.equal(financeiro2Habilitado(A, env), false);
});
test("liga só para as organizações listadas; maiúsculas e espaços normalizados", () => {
  const env = { FINANCEIRO_2_ORGANIZACOES: ` ${A.toUpperCase()} ` };
  assert.equal(financeiro2Habilitado(A, env), true);
  assert.equal(financeiro2Habilitado(B, env), false);
});
test("curinga e lixo nunca ligam nada", () => {
  for (const v of ["*", "todas", "true", "1", "' or 1=1", `${A}x`]) {
    assert.equal(organizacoesFinanceiro2({ FINANCEIRO_2_ORGANIZACOES: v }).size, 0, v);
    assert.equal(financeiro2Habilitado(A, { FINANCEIRO_2_ORGANIZACOES: v }), false, v);
  }
});
test("organização inválida ou ausente nunca é liberada", () => {
  const env = { FINANCEIRO_2_ORGANIZACOES: A };
  for (const o of [undefined, null, "", "x", 123]) assert.equal(financeiro2Habilitado(o, env), false);
});
