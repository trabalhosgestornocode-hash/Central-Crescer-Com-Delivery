// Garante que a taxonomia fixa de UM tenant saiu do config.js global:
//   * TABELAS (lista "AERO A"…) — agora vem do backend por empresa;
//   * IFOOD_LOJA (nome/URL da Subway) — removido junto da vitrine órfã.
// E que state.tabelasDisponiveis existe e reseta na troca de contexto.
//
// Rodar: node --test frontend/test/config-multitenant.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const config = await import("../src/config.js");
const { state } = await import("../src/state.js");
const { resetarEscopoDeContexto } = await import("../src/contextoEscopo.js");

const CONFIG_SRC = readFileSync(fileURLToPath(new URL("../src/config.js", import.meta.url)), "utf8");

describe("config.js — sem taxonomia fixa de tenant", () => {
  test("TABELAS não é mais exportado", () => {
    assert.equal(config.TABELAS, undefined);
  });
  test("IFOOD_LOJA não é mais exportado", () => {
    assert.equal(config.IFOOD_LOJA, undefined);
  });
  test("nenhuma lista hardcoded 'AERO A' / URL da loja Subway no arquivo", () => {
    assert.doesNotMatch(CONFIG_SRC, /AERO A|ifood\.com\.br\/delivery/);
  });
  test("CMV_LIMITES continua (é o default oficial do sistema)", () => {
    assert.deepEqual(config.CMV_LIMITES, { saudavel: 32, atencao: 40 });
  });
});

describe("state.tabelasDisponiveis — catálogo por empresa", () => {
  test("existe e começa vazio", () => {
    assert.deepEqual(state.tabelasDisponiveis, { balcao: [], ifood: [] });
  });
  test("reseta na troca de contexto", () => {
    state.tabelasDisponiveis = { balcao: ["E", "F"], ifood: ["Z1"] };
    resetarEscopoDeContexto();
    assert.deepEqual(state.tabelasDisponiveis, { balcao: [], ifood: [] });
  });
});
