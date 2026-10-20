// Decisão de setor (Financeiro × Operacional) — pura, sem DOM nem rede.
// Rodar: node --test frontend/test/setores.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decidirSetor, setoresValidos, chaveDoContexto, lerPreferencia, gravarPreferencia } from "../src/setores.js";
import { MENU_FINANCEIRO } from "../src/financeiroMenu.js";

const memoria = () => { const m = {}; return { getItem: (k) => m[k] ?? null, setItem: (k, v) => { m[k] = v; } }; };

describe("decidirSetor", () => {
  test("só operacional entra direto (fluxo original do franqueado)", () => {
    assert.deepEqual(decidirSetor({ setores: ["operacional"] }), { acao: "entrar", setor: "operacional", setores: ["operacional"] });
  });
  test("exclusivamente financeiro entra direto no financeiro", () => {
    const d = decidirSetor({ setores: ["financeiro"] });
    assert.equal(d.acao, "entrar"); assert.equal(d.setor, "financeiro");
  });
  test("dois setores sem escolha prévia => pergunta", () => {
    assert.equal(decidirSetor({ setores: ["financeiro", "operacional"] }).acao, "escolher");
  });
  test("dois setores com escolha prévia NO MESMO contexto e ainda autorizada => mantém", () => {
    const d = decidirSetor({ setores: ["financeiro", "operacional"], setorAtual: "financeiro" });
    assert.equal(d.acao, "entrar"); assert.equal(d.setor, "financeiro");
  });
  test("revogação: escolha prévia 'financeiro' mas o servidor só devolve operacional => operacional, nunca financeiro", () => {
    const d = decidirSetor({ setores: ["operacional"], setorAtual: "financeiro" });
    assert.equal(d.setor, "operacional");
  });
  test("nenhum setor => bloqueado (sem entrada indevida)", () => {
    assert.equal(decidirSetor({ setores: [] }).acao, "bloqueado");
  });
  test("falha ao consultar (null) NUNCA libera o financeiro", () => {
    const d = decidirSetor({ setores: null, setorAtual: "financeiro" });
    assert.equal(d.setor, "operacional");
  });
  test("impersonação e perfil de exibição: sempre operacional, mesmo que a lista traga financeiro", () => {
    assert.equal(decidirSetor({ setores: ["financeiro", "operacional"], impersonando: true }).setor, "operacional");
    assert.equal(decidirSetor({ setores: ["financeiro"], exibicao: true }).setor, "operacional");
  });
  test("valores desconhecidos do servidor são descartados", () => {
    assert.deepEqual(setoresValidos(["financeiro", "admin", "financeiro", 1, null]), ["financeiro"]);
    assert.deepEqual(setoresValidos("financeiro"), []);
  });
});

describe("contexto e preferência", () => {
  test("chave do contexto muda com a unidade (troca de unidade pergunta de novo)", () => {
    const a = chaveDoContexto({ empresa: { id: "e" }, unidade: { id: "u1" }, perfil: { id: "p" } });
    const b = chaveDoContexto({ empresa: { id: "e" }, unidade: { id: "u2" }, perfil: { id: "p" } });
    assert.notEqual(a, b);
  });
  test("preferência é só sugestão: grava/lê por usuário e ignora valor inválido", () => {
    const st = memoria();
    gravarPreferencia("u1", "financeiro", st);
    gravarPreferencia("u2", "hacker", st);
    assert.equal(lerPreferencia("u1", st), "financeiro");
    assert.equal(lerPreferencia("u2", st), null);
  });
  test("storage indisponível não quebra", () => {
    const quebrado = { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); } };
    assert.equal(lerPreferencia("u1", quebrado), null);
    assert.doesNotThrow(() => gravarPreferencia("u1", "financeiro", quebrado));
  });
});

describe("menu financeiro (contrato com o Agente 2)", () => {
  test("12 itens na ordem do contrato, ids únicos e prefixo fin-", () => {
    assert.deepEqual(MENU_FINANCEIRO.map((m) => m.label), [
      "Visão Geral", "Fluxo de Caixa", "Contas Financeiras", "Conciliação", "DRE Gerencial", "Indicadores",
      "Análise de Categorias", "Plano de Contas", "Períodos", "Importação", "Relatórios", "Configurações Financeiras",
    ]);
    assert.equal(new Set(MENU_FINANCEIRO.map((m) => m.id)).size, 12);
    assert.ok(MENU_FINANCEIRO.every((m) => m.id.startsWith("fin-") && m.tipo === "financeiro" && /^[a-z-]+$/.test(m.pagina)));
  });
});
