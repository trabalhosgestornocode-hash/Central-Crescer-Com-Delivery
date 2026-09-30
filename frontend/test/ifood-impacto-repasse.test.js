// temImpactoRepasse: true -> "Sim", false -> "Não", null/ausente -> "Não informado".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rotuloImpactoRepasse } from "../src/ifoodEstado.js";

const SRC = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/ifood.js"), "utf8");

test("true -> Sim", () => assert.equal(rotuloImpactoRepasse(true), "Sim"));
test("false -> Não", () => assert.equal(rotuloImpactoRepasse(false), "Não"));
test("[9] null / undefined / não-boolean -> Não informado (nunca 'Não')", () => {
  for (const v of [null, undefined, "false", 0, ""]) assert.equal(rotuloImpactoRepasse(v), "Não informado", JSON.stringify(v));
});
test("ifood.js não usa mais o ternário truthy que transformava null em 'Não'", () => {
  assert.doesNotMatch(SRC, /temImpactoRepasse \? "Sim" : "Não"/);
  assert.doesNotMatch(SRC, /!e\.temImpactoRepasse \?/);
  assert.equal((SRC.match(/rotuloImpactoRepasse\(/g) ?? []).length, 2, "tabela de eventos + detalhe do evento");
  assert.match(SRC, /impacto no repasse não informado/);
});
