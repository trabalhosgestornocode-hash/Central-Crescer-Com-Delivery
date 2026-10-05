// Selo "Ambiente de homologação iFood" da área Financial: só para a unidade que o
// BACKEND marcou (status.financialHomologacao, vindo de IFOOD_FINANCIAL_HOMOLOGATION_UNITS).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { montarEvidenciaHomologacao } from "../src/ifoodEstado.js";

const SRC = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/ifood.js"), "utf8");

test("selo Financial depende só de status.financialHomologacao (decisão do backend)", () => {
  const fn = SRC.slice(SRC.indexOf("function badgeHomologacaoFinancial("), SRC.indexOf("}", SRC.indexOf("function badgeHomologacaoFinancial(")) + 1);
  assert.match(fn, /if \(!statusApi\?\.financialHomologacao \|\| statusApi\?\.homologacao\) return "";/);
  assert.match(fn, /Ambiente de homologação iFood/);
  assert.doesNotMatch(fn, /localStorage|location|query|unidadeId/, "o frontend não decide nada sozinho");
});

test("o selo aparece só no cabeçalho da área Financial", () => {
  assert.equal((SRC.match(/badgeHomologacaoFinancial\(\)/g) ?? []).length, 1);
  assert.match(SRC, /<h2>Homologação Financeira\$\{badgeHomologacao\(\)\}\$\{badgeHomologacaoFinancial\(\)\}<\/h2>/);
});

test("evidência marca 'homologação' quando a unidade está em homologação Financial", () => {
  const base = { geradoEm: "2026-10-05T00:00:00Z", financeiro: {} };
  assert.equal(montarEvidenciaHomologacao({ ...base, status: { financialHomologacao: true } }).ambiente, "homologacao");
  assert.equal(montarEvidenciaHomologacao({ ...base, status: { financialHomologacao: false } }).ambiente, "producao");
  assert.equal(montarEvidenciaHomologacao({ ...base, status: {} }).ambiente, "producao");
});
