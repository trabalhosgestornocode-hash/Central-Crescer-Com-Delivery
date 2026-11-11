// Ajuda de uso das telas — conteúdo e bloco HTML. Rodar: node --test frontend/test/ajuda.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AJUDA, GLOSSARIO, ajudaDe } from "../src/financeiro/ajuda.js";

describe("conteúdo da ajuda", () => {
  test("as telas do dia a dia e de conferência têm ajuda completa", () => {
    for (const k of ["visao-geral", "receitas", "vendas-diarias", "contas-a-pagar", "fluxo-de-caixa", "conciliacao", "conciliacao-saidas", "contas", "configuracoes", "plano-de-contas", "periodos", "importacao", "relatorios"]) {
      const a = ajudaDe(k);
      assert.ok(a, k); assert.ok(a.paraQue.length > 30, k); assert.ok(a.passos.length >= 3 && a.passos.length <= 5, k);
    }
  });
  test("todo termo citado existe no glossário, com explicação", () => {
    for (const [k, a] of Object.entries(AJUDA)) for (const t of a.termos ?? []) { assert.ok(GLOSSARIO[t], `${k}: ${t}`); assert.ok(GLOSSARIO[t][1].length > 20); }
  });
  test("sem jargão técnico no texto mostrado", () => {
    const tudo = JSON.stringify([AJUDA, GLOSSARIO]);
    for (const j of ["Σ", "RPC", "endpoint", "migration", "residual"]) assert.equal(tudo.includes(j), false, j);
  });
  test("as 22 telas do Financeiro têm ajuda, cada uma com 3 a 5 passos", () => {
    assert.ok(Object.keys(AJUDA).length >= 22, `só ${Object.keys(AJUDA).length}`);
    for (const [k, a] of Object.entries(AJUDA)) { assert.ok(a.passos.length >= 3 && a.passos.length <= 5, k); assert.ok(a.paraQue.length > 30, k); }
  });
  test("chave desconhecida → null", () => assert.equal(ajudaDe("nao-existe"), null));
});
