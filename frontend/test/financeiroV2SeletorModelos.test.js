// O seletor "Implantar o plano de contas" precisa oferecer exatamente os modelos que o backend implanta (sem dados reais).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MODELOS_DE_PLANO, formImplantarPlano } from "../financeiro-v2/telasAbertura.js";
import { MODELO_DE_PLANO } from "../../backend/src/modules/financeiro-v2/dominio/planoDeContas.js";

test("o seletor oferece todos os modelos do backend, incluindo SUBWAY, e o padrão continua ACAITERIA", () => {
  assert.deepEqual(MODELOS_DE_PLANO.map(([k]) => k).sort(), Object.keys(MODELO_DE_PLANO).sort());
  const html = formImplantarPlano();
  for (const k of ["ACAITERIA", "BASE", "SUBWAY"]) assert.match(html, new RegExp(`value="${k}"`), k);
  assert.match(html, /value="ACAITERIA"[^>]*selected/);
  assert.doesNotMatch(html, /value="SUBWAY"[^>]*selected/);
});
