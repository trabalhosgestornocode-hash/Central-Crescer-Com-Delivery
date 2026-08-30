// Testes da tela de Configurações — foco no que a Fase C precisa garantir:
//   * o cabeçalho vem de state.sessao.empresa / state.sessao.unidade,
//     NUNCA do literal "Subway Saci" nem de state.usuario/state.unidade;
//   * a visão consolidada (sem unidade) é rotulada como tal;
//   * o arquivo não contém mais nenhum resquício hardcoded da Subway nem a
//     chave "saci-config".
//
// Sem jsdom no projeto: montamos um fake mínimo de `document` suficiente
// para `renderConfiguracoes` (mesma abordagem dos mocks do resto da suíte).
//
// Rodar: node --test frontend/test/configuracoes.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// --- fake DOM mínimo ---------------------------------------------------
function elementoFake() {
  const node = {
    _html: "",
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    textContent: "",
    classList: { toggle: () => {}, add: () => {}, remove: () => {} },
  };
  return node;
}
const view = elementoFake();
globalThis.document = {
  querySelector: (sel) => (sel === "#view" ? view : null),
  querySelectorAll: () => [],
  createElement: () => elementoFake(),
  addEventListener: () => {},
  documentElement: { setAttribute: () => {} },
};
globalThis.localStorage = {
  _d: new Map(),
  getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
  setItem(k, v) { this._d.set(k, String(v)); },
  removeItem(k) { this._d.delete(k); },
};

const { state } = await import("../src/state.js");
const { renderConfiguracoes } = await import("../src/configuracoes.js");

const CONFIG_SRC = readFileSync(
  fileURLToPath(new URL("../src/configuracoes.js", import.meta.url)), "utf8",
);

describe("Configurações — cabeçalho multi-tenant", () => {
  beforeEach(() => {
    state.sessao.empresa = null;
    state.sessao.unidade = null;
  });

  test("subtítulo vem de state.sessao.empresa · state.sessao.unidade", () => {
    state.sessao.empresa = { id: "e1", nome: "Caramelle Café" };
    state.sessao.unidade = { id: "u1", nome: "Vilhena - RO" };
    renderConfiguracoes();
    assert.match(view.innerHTML, /Caramelle Café · Vilhena - RO/);
    assert.doesNotMatch(view.innerHTML, /Subway Saci/);
  });

  test("empresa diferente → outro nome, sem vazar a anterior", () => {
    state.sessao.empresa = { id: "e2", nome: "Grupo Norte" };
    state.sessao.unidade = { id: "u2", nome: "Loja Centro" };
    renderConfiguracoes();
    assert.match(view.innerHTML, /Grupo Norte · Loja Centro/);
    assert.doesNotMatch(view.innerHTML, /Caramelle|Vilhena/);
  });

  test("sem unidade selecionada → rótulo de visão consolidada", () => {
    state.sessao.empresa = { id: "e3", nome: "Rede X" };
    state.sessao.unidade = null;
    renderConfiguracoes();
    assert.match(view.innerHTML, /Rede X · todas as unidades/);
  });
});

// Ignora comentários de linha para checar só o que o código de fato usa.
const CODIGO = CONFIG_SRC.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

describe("Configurações — sem resquício hardcoded da Subway", () => {
  test("nenhum default hardcoded 'Subway Saci — Saci' (nome da unidade)", () => {
    assert.doesNotMatch(CONFIG_SRC, /Subway Saci . Saci|Subway Saci/);
  });
  test("nenhum placeholder/arquivo 'subwaysaci' / 'subway-saci'", () => {
    assert.doesNotMatch(CODIGO, /subway[-]?saci/i);
  });
  test("a chave global 'saci-config' foi eliminada", () => {
    assert.doesNotMatch(CONFIG_SRC, /saci-config/);
  });
  test("não depende mais de state.usuario / state.unidade (bare)", () => {
    assert.doesNotMatch(CODIGO, /state\.usuario\b/);
    assert.doesNotMatch(CODIGO, /state\.unidade\b/);
  });
  test("usa state.sessao.empresa e state.sessao.unidade", () => {
    assert.match(CODIGO, /state\.sessao\.empresa/);
    assert.match(CODIGO, /state\.sessao\.unidade/);
  });
  test("e-mail da loja não cai mais no e-mail do usuário logado", () => {
    // o fallback antigo era `d.email ?? (state.usuario || "")`
    assert.doesNotMatch(CODIGO, /email[^\n]*state\.usuario/);
  });
});
