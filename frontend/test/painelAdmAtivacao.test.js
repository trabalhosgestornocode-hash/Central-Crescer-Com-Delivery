// Checkpoint H.4-B.1 — alavancas de envio no Painel Administrativo (frontend): contrato da API e construtores
// HTML->string (sem DOM/jsdom neste projeto, mesmo padrão de painelAdmComunicacao.test.js).
// Rodar: node --test frontend/test/painelAdmAtivacao.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.sessionStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window ??= {};
globalThis.window.supabase = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "jwt-identidade-fake" } } }) } }) };

const { painelAdmApi } = await import("../src/painelAdmApi.js");
const { htmlAtivacaoComunicacao, htmlDrawerComunicacao } = await import("../src/painelAdmViews.js");

let capturado;
const fetchOriginal = globalThis.fetch;
beforeEach(() => {
  capturado = null;
  globalThis.fetch = async (url, opcoes) => { capturado = { url, opcoes }; return { ok: true, status: 200, statusText: "200", json: async () => ({ data: { ok: true } }) }; };
});
afterEach(() => { globalThis.fetch = fetchOriginal; });
const rotaDe = (u) => new URL(u, "http://x").pathname;

describe("painelAdmApi — contrato das alavancas (Bearer, sem x-context-token)", () => {
  test("GET /comunicacao/ativacao", async () => {
    await painelAdmApi.comunicacaoAtivacao();
    assert.equal(rotaDe(capturado.url), "/api/v1/administrativo/comunicacao/ativacao");
    assert.equal(capturado.opcoes.headers.Authorization, "Bearer jwt-identidade-fake");
    assert.ok(!Object.keys(capturado.opcoes.headers).some((k) => k.toLowerCase() === "x-context-token"));
  });
  test("habilitar: PUT .../habilitacao com { habilitado:true, confirmacaoExplicita:true } e mais nada", async () => {
    await painelAdmApi.comunicacaoDefinirHabilitacao("org-1", true);
    assert.equal(rotaDe(capturado.url), "/api/v1/administrativo/comunicacao/organizacoes/org-1/habilitacao");
    assert.equal(capturado.opcoes.method, "PUT");
    assert.deepEqual(JSON.parse(capturado.opcoes.body), { habilitado: true, confirmacaoExplicita: true });
  });
  test("desabilitar: { habilitado:false } SEM confirmação; qualquer valor não-true vira desabilitar (nunca habilita por acidente)", async () => {
    for (const v of [false, undefined, "true", 1, null]) {
      await painelAdmApi.comunicacaoDefinirHabilitacao("org-1", v);
      assert.deepEqual(JSON.parse(capturado.opcoes.body), { habilitado: false }, String(v));
    }
  });
  test("modo: NORMAL leva confirmacaoExplicita; DISABLED não; qualquer outro valor vira DISABLED (kill switch por padrão)", async () => {
    await painelAdmApi.comunicacaoDefinirModo("NORMAL");
    assert.equal(rotaDe(capturado.url), "/api/v1/administrativo/comunicacao/modo");
    assert.equal(capturado.opcoes.method, "PUT");
    assert.deepEqual(JSON.parse(capturado.opcoes.body), { modo: "NORMAL", confirmacaoExplicita: true });
    for (const m of ["DISABLED", "REACTIVE_ONLY", "normal", undefined]) {
      await painelAdmApi.comunicacaoDefinirModo(m);
      assert.deepEqual(JSON.parse(capturado.opcoes.body), { modo: "DISABLED" }, String(m));
    }
  });
});


const ATIV_PRONTA = { modo: "DISABLED", organizacoesHabilitadas: 3, organizacoesComEnvioAutomatico: 2, pendenciasElegiveis: 4, gateway: "conectado" };
describe("API por empresa — contratos e autorização", () => {
  const casos = [
    ["comunicacaoPainelEmpresa", ["org/1"], "GET", "/org%2F1/whatsapp", null],
    ["comunicacaoCriarDestinatario", ["o1", { nome: "Contato", telefone: "11987654321", categorias: ["pendencia_d1"] }], "POST", "/o1/destinatarios", { nome: "Contato", telefone: "11987654321", categorias: ["pendencia_d1"] }],
    ["comunicacaoAtualizarDestinatario", ["o1", "ce/1", { nome: "Novo nome" }], "PUT", "/o1/destinatarios/ce%2F1", { nome: "Novo nome" }],
    ["comunicacaoDestinatarioCategorias", ["o1", "ce1", []], "PUT", "/o1/destinatarios/ce1/categorias", { categorias: [] }],
    ["comunicacaoDestinatarioAtivo", ["o1", "ce1", false], "PUT", "/o1/destinatarios/ce1/ativo", { ativo: false }],
    ["comunicacaoDestinatarioAutorizar", ["o1", "ce1"], "POST", "/o1/destinatarios/ce1/autorizar", { confirmacaoExplicita: true }],
    ["comunicacaoDestinatarioOptOut", ["o1", "ce1"], "POST", "/o1/destinatarios/ce1/opt-out", { confirmacaoExplicita: true }],
    ["comunicacaoEnvioAutomatico", ["o1", true], "PUT", "/o1/envio-automatico", { ligar: true, confirmacaoExplicita: true }],
    ["comunicacaoEnvioAutomatico", ["o1", false], "PUT", "/o1/envio-automatico", { ligar: false }],
    ["comunicacaoLimites", ["o1", { limiteDiarioOrg: 20, cooldownMinutos: null }], "PUT", "/o1/limites", { limiteDiarioOrg: 20, cooldownMinutos: null }],
    ["comunicacaoDryRun", ["o1"], "POST", "/o1/dry-run", {}],
  ];
  for (const [metodo, args, http, sufixo, corpo] of casos) {
    test(`${metodo}: ${http} ${sufixo} ${JSON.stringify(corpo)}`, async () => {
      await painelAdmApi[metodo](...args);
      assert.equal(rotaDe(capturado.url), `/api/v1/administrativo/comunicacao/organizacoes${sufixo}`);
      assert.equal(capturado.opcoes.method ?? "GET", http);
      assert.equal(capturado.opcoes.headers.Authorization, "Bearer jwt-identidade-fake");
      assert.ok(!Object.keys(capturado.opcoes.headers).some((k) => k.toLowerCase() === "x-context-token"));
      if (corpo !== null) assert.deepEqual(JSON.parse(capturado.opcoes.body), corpo);
    });
  }
});
describe("ativação global após o piloto", () => {
  test("sem dados não inventa estado", () => assert.equal(htmlAtivacaoComunicacao(null), ""));
  test("várias empresas podem ativar com confirmação inicialmente oculta", () => {
    const html = htmlAtivacaoComunicacao(ATIV_PRONTA);
    assert.match(html, /data-padm-acao="pedir-ativar-comunicacao"(?![^>]*disabled)/);
    assert.match(html, /class="padm-ativacao-confirmar" hidden/);
    for (const acao of ["cancelar", "confirmar"]) assert.ok(html.includes(`data-padm-acao="${acao}-ativar-comunicacao"`));
    assert.match(html, /2 empresa\(s\) com envio automático e 4 pendência/);
    assert.doesNotMatch(html, /ativar-piloto|allowlist/);
  });
  test("gateway ausente ou desconectado não permite ativar", () => {
    for (const gateway of [undefined, "desconectado", "instavel", "desconhecido"]) {
      assert.match(htmlAtivacaoComunicacao({ ...ATIV_PRONTA, gateway }), /data-padm-acao="pedir-ativar-comunicacao"[^>]*disabled/);
    }
  });
  test("modo NORMAL oferece desligamento imediato", () => {
    const html = htmlAtivacaoComunicacao({ ...ATIV_PRONTA, modo: "NORMAL" });
    assert.match(html, /data-padm-acao="desativar-comunicacao"/);
    assert.doesNotMatch(html, /pedir-ativar-comunicacao|confirmar-ativar-comunicacao/);
  });
  test("diagnóstico legado não reativa allowlist nem expõe telefone bruto", () => {
    const html = htmlAtivacaoComunicacao({ ...ATIV_PRONTA, pilotoLegado: { configurado: true, rotulo: "LEGACY — sem efeito", telefone: "+5511987654321" } });
    assert.match(html, /LEGACY — sem efeito/);
    assert.doesNotMatch(html, /5511987654321|ativar-piloto/);
  });
});
