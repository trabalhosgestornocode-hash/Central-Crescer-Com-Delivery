// Conta bloqueada (403 CONTA_INATIVA): só esse código dispara o encerramento sem reentrada; qualquer outro 403 é erro comum.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ehContaInativa, CODIGO_CONTA_INATIVA } from "../src/contaInativa.js";

describe("ehContaInativa", () => {
  test("403 com details.codigo CONTA_INATIVA (ou codigo na raiz): sim", () => {
    assert.equal(ehContaInativa(403, { error: "Usuário inativo.", details: { codigo: CODIGO_CONTA_INATIVA } }), true);
    assert.equal(ehContaInativa(403, { codigo: CODIGO_CONTA_INATIVA }), true);
  });
  test("falta de permissão, 401, 409, 500, sem corpo, outro código: NÃO (nenhum outro perfil é afetado)", () => {
    assert.equal(ehContaInativa(403, { error: "Permissão insuficiente para esta ação." }), false);
    assert.equal(ehContaInativa(403, { details: { codigo: "RENOVACAO_NAO_PERMITIDA" } }), false);
    assert.equal(ehContaInativa(403, { error: "Usuário inativo. Contate o administrador." }), false, "sem o código não dispara (texto não conta)");
    for (const s of [200, 401, 404, 409, 500]) assert.equal(ehContaInativa(s, { details: { codigo: CODIGO_CONTA_INATIVA } }), false);
    assert.equal(ehContaInativa(403, null), false); assert.equal(ehContaInativa(403, undefined), false);
  });
});
