// Resolução do acesso ao Dashboard Financeiro (financeiroAcesso.js) — puro, sem DOM nem rede.
// Regressão do bug "Financeiro antigo → Carregando… → Financeiro 2.0": o legado nunca é o estado padrão, erro de rede
// nunca vira "flag desligado" e o menu só existe para um estado já resolvido.
// Rodar: node --test frontend/test/financeiroAcesso.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ESTADO_FINANCEIRO as E, estadoDoStatus, resolverAcessoFinanceiro, menuDoEstado, rotaDeEntrada, ehRecusaDeAcesso,
  guardarStatusPreResolvido, consumirStatusPreResolvido,
} from "../src/financeiroAcesso.js";
import { MENU_FINANCEIRO } from "../src/financeiroMenu.js";

const httpQue = (fn) => ({ chamadas: 0, async get(url) { this.chamadas += 1; this.url = url; return fn(); } });
const erroHttp = (status, codigo) => Object.assign(new Error("x"), { status, details: codigo ? { codigo } : undefined });

describe("estadoDoStatus", () => {
  test("flag ligado → financeiro_2; desligado/ausente → legado", () => {
    assert.equal(estadoDoStatus({ habilitado: true, financeiro2: true }), E.FINANCEIRO_2);
    assert.equal(estadoDoStatus({ habilitado: true, financeiro2: false }), E.LEGADO);
    assert.equal(estadoDoStatus({ habilitado: true }), E.LEGADO);
  });
  test("só `true` estrito liga o 2.0 (\"true\", 1 não ligam)", () => {
    for (const v of ["true", 1, "sim", null]) assert.equal(estadoDoStatus({ financeiro2: v }), E.LEGADO);
  });
  test("resposta malformada é ERRO, nunca legado", () => {
    for (const s of [null, undefined, "ok", 42]) assert.equal(estadoDoStatus(s), E.ERRO);
  });
  test("habilitado:false explícito é recusa", () => assert.equal(estadoDoStatus({ habilitado: false, financeiro2: true }), E.NEGADO));
});

describe("resolverAcessoFinanceiro", () => {
  test("consulta o status UMA vez e devolve estado + status", async () => {
    const http = httpQue(async () => ({ data: { habilitado: true, financeiro2: true, nivel: "gestor", permissoes: ["gestao_financeira.ver"] } }));
    const r = await resolverAcessoFinanceiro(http);
    assert.equal(r.estado, E.FINANCEIRO_2);
    assert.equal(r.status.nivel, "gestor");
    assert.equal(http.chamadas, 1);
    assert.equal(http.url, "/api/v1/gestao-financeira/status");
  });
  test("falha de rede / 5xx / timeout = ERRO (nunca financeiro_legado)", async () => {
    for (const e of [new TypeError("Failed to fetch"), erroHttp(500), erroHttp(502), erroHttp(504), erroHttp(0)]) {
      const r = await resolverAcessoFinanceiro(httpQue(async () => { throw e; }));
      assert.equal(r.estado, E.ERRO, `erro ${e.status ?? e.message}`);
      assert.notEqual(r.estado, E.LEGADO);
    }
  });
  test("recusa do backend (403/409/FINANCEIRO_*) = access_denied", async () => {
    for (const e of [erroHttp(403), erroHttp(409), erroHttp(400, "FINANCEIRO_SEM_ACESSO")]) {
      assert.equal((await resolverAcessoFinanceiro(httpQue(async () => { throw e; }))).estado, E.NEGADO);
    }
  });
  test("ehRecusaDeAcesso não confunde erro de rede com recusa", () => {
    assert.equal(ehRecusaDeAcesso(new TypeError("Failed to fetch")), false);
    assert.equal(ehRecusaDeAcesso(erroHttp(500)), false);
    assert.equal(ehRecusaDeAcesso({ codigo: "FINANCEIRO_EXPIRADO" }), true);
  });
});

describe("menuDoEstado", () => {
  const ids = (estado) => menuDoEstado(estado).flatMap((s) => s.itens.map((i) => i.id));
  test("loading, erro e recusa: NENHUM menu (nem legado nem 2.0)", () => {
    for (const est of [E.LOADING, E.ERRO, E.NEGADO, undefined, null, "qualquer"]) assert.deepEqual(menuDoEstado(est), []);
  });
  test("2.0: seis módulos, painel primeiro, sem a seção legada \"FINANCEIRO\"", () => {
    const m = menuDoEstado(E.FINANCEIRO_2);
    assert.deepEqual(m.map((s) => s.secao), ["Visão Geral", "Receitas e Vendas", "Despesas e Pagamentos", "Caixa e Conciliação", "Custos e Resultados", "Controle e Relatórios"]);
    assert.equal(ids(E.FINANCEIRO_2)[0], "fin-painel");
    assert.equal(m.flatMap((s) => s.itens).find((i) => i.id === "fin-visao-geral").label, "Resumo de Caixa"); assert.equal(m.flatMap((s) => s.itens).find((i) => i.id === "fin-painel").label, "Painel do Mês");
  });
  test("legado: exatamente o menu de antes (lista simples, sem nenhum item fin2)", () => {
    const m = menuDoEstado(E.LEGADO);
    assert.deepEqual(m.map((s) => s.secao), ["FINANCEIRO"]);
    assert.deepEqual(ids(E.LEGADO), MENU_FINANCEIRO.filter((i) => !i.fin2).map((i) => i.id));
  });
});

describe("rotaDeEntrada", () => {
  test("2.0 entra direto no painel (não passa pela Visão Geral legada)", () => {
    assert.equal(rotaDeEntrada(E.FINANCEIRO_2, null), "fin-painel");
    assert.equal(rotaDeEntrada(E.FINANCEIRO_2, "fin-nao-existe"), "fin-painel");
  });
  test("rota pedida válida é respeitada", () => {
    assert.equal(rotaDeEntrada(E.FINANCEIRO_2, "fin-dre-referencia"), "fin-dre-referencia");
    assert.equal(rotaDeEntrada(E.LEGADO, "fin-dre"), "fin-dre");
  });
  test("legado: tela 2.0 pedida cai na 1ª do legado", () => {
    assert.equal(rotaDeEntrada(E.LEGADO, null), "fin-visao-geral");
    assert.equal(rotaDeEntrada(E.LEGADO, "fin-painel"), "fin-visao-geral");
  });
  test("estados não resolvidos não têm rota", () => {
    for (const est of [E.LOADING, E.ERRO, E.NEGADO]) assert.equal(rotaDeEntrada(est, "fin-painel"), null);
  });
});

describe("status pré-resolvido (evita a 2ª consulta igual na 1ª página)", () => {
  test("uma vez só, mesmo contexto, recente", () => {
    guardarStatusPreResolvido({ financeiro2: true }, "org:uni:p", 1000);
    assert.deepEqual(consumirStatusPreResolvido("org:uni:p", 2000), { financeiro2: true });
    assert.equal(consumirStatusPreResolvido("org:uni:p", 2001), null, "segunda leitura volta a consultar o servidor");
  });
  test("outro contexto (troca de organização/unidade) não reaproveita", () => {
    guardarStatusPreResolvido({ financeiro2: true }, "org-a:uni:p", 1000);
    assert.equal(consumirStatusPreResolvido("org-b:uni:p", 1001), null);
  });
  test("antigo demais não reaproveita", () => {
    guardarStatusPreResolvido({ financeiro2: true }, "k", 0);
    assert.equal(consumirStatusPreResolvido("k", 60_000), null);
  });
});
