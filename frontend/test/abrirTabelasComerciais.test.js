// CTA "Selecionar tabelas oficiais" → Configurações → Tabelas Comerciais DA
// UNIDADE ANALISADA pelo Dashboard iFood (ver abrirTabelasComerciais.js).
//
// Usa o código REAL de sessão (sessao.js#trocarUnidadeDoContexto → POST
// /sessao/trocar-unidade) e de Configurações (abrirSecaoConfiguracoes("precos")
// → GET /unidade/tabelas-comerciais), com fetch/DOM falsos. O sinal de "qual
// unidade foi carregada" é o `x-context-token` enviado no GET das tabelas — é
// por ele (req.tenant.unidadeId) que o backend escolhe a unidade.
//
// Rodar: node --test frontend/test/abrirTabelasComerciais.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function elementoFake() {
  return {
    _html: "", get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
    querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {},
    textContent: "", classList: { toggle: () => {}, add: () => {}, remove: () => {} }, style: {}, dataset: {},
  };
}
const elementos = new Map();
const pegar = (sel) => { if (!elementos.has(sel)) elementos.set(sel, elementoFake()); return elementos.get(sel); };
globalThis.document = {
  querySelector: (sel) => pegar(sel), querySelectorAll: () => [], createElement: () => elementoFake(),
  getElementById: () => null, addEventListener: () => {}, dispatchEvent: () => true,
  documentElement: { setAttribute: () => {} },
};
globalThis.window = globalThis;
const armazenamento = () => ({ _d: new Map(), getItem(k) { return this._d.has(k) ? this._d.get(k) : null; }, setItem(k, v) { this._d.set(k, String(v)); }, removeItem(k) { this._d.delete(k); } });
globalThis.localStorage = armazenamento();
globalThis.sessionStorage = armazenamento();
globalThis.window.supabase = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "acc" } } }) } }) };

// --- "backend" -------------------------------------------------------------
const UNIDADES = {
  A: { id: "A", nome: "Unidade A", tabelas: { tabelaBalcao: "E", tabelaIfood: "Z4" } },
  B: { id: "B", nome: "Unidade B", tabelas: { tabelaBalcao: "E", tabelaIfood: null } },
};
const TOKEN_UNIDADE = { "tok-todas": null, "tok-A": "A", "tok-B": "B" };
const chamadas = [];
globalThis.fetch = async (url, opcoes = {}) => {
  const u = String(url);
  const ctx = opcoes.headers?.["x-context-token"] ?? null;
  chamadas.push({ url: u, metodo: opcoes.method ?? "GET", ctx, corpo: opcoes.body ? JSON.parse(opcoes.body) : null });
  const resp = (status, json) => ({ ok: status < 400, status, statusText: "", json: async () => json });
  if (u.includes("/api/config")) return resp(200, { supabaseUrl: "https://x.example", supabaseAnonKey: "anon" });
  if (u.endsWith("/api/v1/sessao/trocar-unidade")) {
    const { unidadeId } = JSON.parse(opcoes.body);
    const uni = UNIDADES[unidadeId];
    // mesma regra do backend: unidade fora do vínculo/inativa → 403, contexto intacto
    if (!uni) return resp(403, { error: "Você não tem acesso a esta unidade." });
    return resp(200, { data: { contextToken: `tok-${uni.id}`, empresa: { id: "org", nome: "Org" }, unidade: { id: uni.id, nome: uni.nome }, papel: "organization_admin", permissoes: ["configuracoes.ver", "configuracoes.gerenciar"], modulos: [] } });
  }
  if (u.endsWith("/api/v1/unidade/tabelas-comerciais")) {
    const uni = UNIDADES[TOKEN_UNIDADE[ctx]];
    return resp(200, { data: { ...(uni?.tabelas ?? { tabelaBalcao: null, tabelaIfood: null }), catalogo: { balcao: ["E"], ifood: ["Z4"] } } });
  }
  return resp(200, { data: {} });
};

const { state } = await import("../src/state.js");
const { trocarUnidadeDoContexto, aplicarContexto, contextTokenAtual } = await import("../src/sessao.js");
const { abrirSecaoConfiguracoes } = await import("../src/configuracoes.js");
const { abrirTabelasComerciaisDaUnidade } = await import("../src/abrirTabelasComerciais.js");

const esperar = () => new Promise((r) => setTimeout(r, 5));
const getsTabelas = () => chamadas.filter((c) => c.url.endsWith("/unidade/tabelas-comerciais") && c.metodo === "GET");

/** Mesma fiação de app.js (só `recarregarApp`/`irPara` são fakes — vivem no shell). */
function deps(log, extras = {}) {
  return {
    unidadeDaSessao: () => state.sessao.unidade?.id ?? null,
    trocarUnidade: (unidadeId) => { log.push(`trocar:${unidadeId}`); return trocarUnidadeDoContexto({ unidadeId }); },
    recarregarApp: async () => { log.push("recarregar:inicio"); await esperar(); log.push("recarregar:fim"); },
    irPara: (rota) => { log.push(`irPara:${rota}`); state.rota = rota; },
    rotaAtual: () => state.rota,
    abrirSecao: (id) => { log.push(`abrirSecao:${id}`); abrirSecaoConfiguracoes(id); },
    avisar: (msg) => log.push(`avisar:${msg}`),
    ...extras,
  };
}
function entrarEm(contextToken, unidade) {
  aplicarContexto({ contextToken, empresa: { id: "org", nome: "Org" }, unidade, papel: "organization_admin", permissoes: ["configuracoes.ver"], modulos: [] });
}

beforeEach(() => { chamadas.length = 0; state.rota = "dashboard-executivo"; pegar("#view").innerHTML = ""; pegar("#cfg-detalhe").innerHTML = ""; });

describe("CTA abre as Tabelas Comerciais da unidade analisada", () => {
  test("A) sessão em 'todas as unidades' + Dashboard na unidade B → troca autorizada e abre as tabelas de B", async () => {
    entrarEm("tok-todas", null);
    const log = [];
    const r = await abrirTabelasComerciaisDaUnidade({ unidadeId: "B" }, deps(log));
    await esperar();

    assert.deepEqual(r, { aberto: true, unidadeId: "B" });
    assert.deepEqual(log, ["trocar:B", "recarregar:inicio", "recarregar:fim", "irPara:configuracoes", "abrirSecao:precos"]);
    assert.equal(contextTokenAtual(), "tok-B");
    const troca = chamadas.find((c) => c.url.endsWith("/sessao/trocar-unidade"));
    assert.deepEqual(troca.corpo, { unidadeId: "B" });
    // Tabelas carregadas com o contexto de B — nunca o anterior
    assert.deepEqual(getsTabelas().map((c) => c.ctx), ["tok-B"]);
    assert.match(pegar("#view").innerHTML, /Tabelas Comerciais/);
    assert.match(pegar("#cfg-detalhe").innerHTML, /Precisa configurar/); // iFood de B está pendente
  });

  test("A') sessão na unidade A + evento da unidade B → mesma troca autorizada (nunca abre A)", async () => {
    entrarEm("tok-A", { id: "A", nome: "Unidade A" });
    const log = [];
    const r = await abrirTabelasComerciaisDaUnidade({ unidadeId: "B" }, deps(log));
    await esperar();
    assert.equal(r.aberto, true);
    assert.equal(log[0], "trocar:B");
    assert.deepEqual(getsTabelas().map((c) => c.ctx), ["tok-B"]);
  });

  test("B) sessão A + Dashboard A → fluxo normal, sem trocar contexto", async () => {
    entrarEm("tok-A", { id: "A", nome: "Unidade A" });
    const log = [];
    const r = await abrirTabelasComerciaisDaUnidade({ unidadeId: "A" }, deps(log));
    await esperar();
    assert.deepEqual(r, { aberto: true, unidadeId: "A" });
    assert.deepEqual(log, ["irPara:configuracoes", "abrirSecao:precos"]);
    assert.ok(!chamadas.some((c) => c.url.endsWith("/sessao/trocar-unidade")));
    assert.deepEqual(getsTabelas().map((c) => c.ctx), ["tok-A"]);
  });

  test("C) unidade não autorizada/indisponível → backend recusa, contexto intacto, nada é aberto", async () => {
    entrarEm("tok-A", { id: "A", nome: "Unidade A" });
    const log = [];
    const r = await abrirTabelasComerciaisDaUnidade({ unidadeId: "X" }, deps(log));
    await esperar();
    assert.deepEqual(r, { aberto: false, motivo: "troca_recusada" });
    assert.deepEqual(log, ["trocar:X", "avisar:Você não tem acesso a esta unidade."]);
    assert.equal(state.rota, "dashboard-executivo"); // fica no Dashboard
    assert.equal(contextTokenAtual(), "tok-A");
    assert.equal(state.sessao.unidade.id, "A");
    assert.equal(getsTabelas().length, 0);
  });

  test("contexto divergente após a recarga (troca concorrente) → não abre", async () => {
    entrarEm("tok-todas", null);
    const log = [];
    const r = await abrirTabelasComerciaisDaUnidade({ unidadeId: "B" }, deps(log, {
      recarregarApp: async () => { entrarEm("tok-A", { id: "A", nome: "Unidade A" }); },
    }));
    assert.deepEqual(r, { aberto: false, motivo: "contexto_divergente" });
    assert.ok(!log.includes("abrirSecao:precos"));
  });

  test("seção só abre DEPOIS da recarga do shell terminar (não é sobrescrita pela grade)", async () => {
    entrarEm("tok-todas", null);
    const log = [];
    await abrirTabelasComerciaisDaUnidade({ unidadeId: "B" }, deps(log));
    assert.ok(log.indexOf("recarregar:fim") < log.indexOf("irPara:configuracoes"));
  });

  test("app.js liga o evento com a unidade do detail, a troca autorizada e mostrarApp com rota inicial", () => {
    const app = readFileSync(fileURLToPath(new URL("../src/app.js", import.meta.url)), "utf8");
    assert.match(app, /addEventListener\(EVENTO_ABRIR_TABELAS_OFICIAIS, \(e\) => abrirTabelasComerciaisDaUnidade\(e\.detail \?\? \{\}, \{/);
    assert.match(app, /trocarUnidade: \(unidadeId\) => trocarUnidadeDoContexto\(\{ unidadeId \}\)/);
    assert.match(app, /recarregarApp: \(\) => mostrarApp\(\{ rotaInicial: "configuracoes" \}\)/);
    assert.match(app, /irPara\(rotaInicial \?\? primeiraRotaAcessivel\(\)\);\s*return carregar\(\);/);
  });
});
