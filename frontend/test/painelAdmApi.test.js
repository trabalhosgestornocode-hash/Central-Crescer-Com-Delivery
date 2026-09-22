// Cliente da API do Painel Administrativo (painelAdmApi.js).
// Garante o contrato da Fase D: Bearer sim, x-context-token NUNCA (itens 8-9),
// e 403 propagado com `.status` para a UX de acesso revogado (item 17).
//
// Rodar: node --test frontend/test/painelAdmApi.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// supabaseClient.js precisa de `localStorage` + `window.supabase` no import.
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.sessionStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window ??= {};
globalThis.window.supabase = {
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "jwt-identidade-fake" } } }) },
  }),
};

const { painelAdmApi } = await import("../src/painelAdmApi.js");

let capturado;
const fetchOriginal = globalThis.fetch;

function stubFetch({ status = 200, body = { data: { ok: true } } } = {}) {
  globalThis.fetch = async (url, opcoes) => {
    capturado = { url, opcoes };
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => body,
    };
  };
}

beforeEach(() => { capturado = null; });
afterEach(() => { globalThis.fetch = fetchOriginal; });

describe("painelAdmApi.ping", () => {
  test("chama GET /api/v1/administrativo/ping", async () => {
    stubFetch();
    await painelAdmApi.ping();
    assert.match(capturado.url, /\/api\/v1\/administrativo\/ping$/);
  });

  test("envia Authorization: Bearer (a identidade) e nada de x-context-token", async () => {
    stubFetch();
    await painelAdmApi.ping();
    const h = capturado.opcoes.headers ?? {};
    assert.equal(h.Authorization, "Bearer jwt-identidade-fake");
    assert.ok(!Object.keys(h).some((k) => k.toLowerCase() === "x-context-token"), "nunca manda x-context-token");
  });

  test("NUNCA envia x-context-token, mesmo com um salvo no sessionStorage", async () => {
    globalThis.sessionStorage.getItem = (k) => (k === "cd.contextToken" ? "token-tenant-fake" : null);
    stubFetch();
    await painelAdmApi.ping();
    const h = capturado.opcoes.headers ?? {};
    assert.ok(!Object.keys(h).some((k) => k.toLowerCase() === "x-context-token"),
      "o cliente do Painel Administrativo é context-free por construção");
    globalThis.sessionStorage.getItem = () => null;
  });

  test("200 -> devolve o `data` do corpo", async () => {
    stubFetch({ body: { data: { ok: true, ambiente: "painel_administrativo" } } });
    const r = await painelAdmApi.ping();
    assert.equal(r.ambiente, "painel_administrativo");
  });

  test("403 -> lança erro com .status = 403 (para a UX de acesso revogado)", async () => {
    stubFetch({ status: 403, body: { error: "Acesso restrito ao Painel Administrativo da Crescer." } });
    await assert.rejects(() => painelAdmApi.ping(), (e) => {
      assert.equal(e.status, 403);
      assert.match(e.message, /Painel Administrativo/);
      return true;
    });
  });
});

describe("painelAdmApi — endpoints de monitoramento (Fase F/G)", () => {
  const rotaDe = (u) => new URL(u, "http://x").pathname + new URL(u, "http://x").search;

  test("visaoGeral / pendencias / empresas -> GET simples, Bearer, sem x-context-token", async () => {
    for (const [metodo, sufixo] of [["visaoGeral", "/visao-geral"], ["pendencias", "/pendencias"], ["empresas", "/empresas"]]) {
      stubFetch();
      await painelAdmApi[metodo]();
      assert.equal(rotaDe(capturado.url), "/api/v1/administrativo" + sufixo);
      const h = capturado.opcoes.headers ?? {};
      assert.equal(h.Authorization, "Bearer jwt-identidade-fake");
      assert.ok(!Object.keys(h).some((k) => k.toLowerCase() === "x-context-token"));
    }
  });

  test("monitoramentoDiario monta a query string só com os filtros preenchidos", async () => {
    stubFetch();
    await painelAdmApi.monitoramentoDiario({ data: "2026-09-14", status: "nao_realizado", organizacaoId: "", criticidade: "critico" });
    const r = rotaDe(capturado.url);
    assert.match(r, /^\/api\/v1\/administrativo\/monitoramento-diario\?/);
    assert.match(r, /data=2026-09-14/);
    assert.match(r, /status=nao_realizado/);
    assert.match(r, /criticidade=critico/);
    assert.ok(!/organizacaoId=/.test(r), "filtro vazio não entra na query");
  });

  test("monitoramentoDiario() sem filtros -> rota sem query string", async () => {
    stubFetch();
    await painelAdmApi.monitoramentoDiario();
    assert.equal(rotaDe(capturado.url), "/api/v1/administrativo/monitoramento-diario");
  });

  test("detalheEmpresa / calendarioUnidade usam o id na rota; calendário aceita ?mes", async () => {
    stubFetch();
    await painelAdmApi.detalheEmpresa("org-123");
    assert.equal(rotaDe(capturado.url), "/api/v1/administrativo/empresas/org-123");

    stubFetch();
    await painelAdmApi.calendarioUnidade("uni-9", "2026-08");
    assert.equal(rotaDe(capturado.url), "/api/v1/administrativo/unidades/uni-9/calendario?mes=2026-08");

    stubFetch();
    await painelAdmApi.calendarioUnidade("uni-9");
    assert.equal(rotaDe(capturado.url), "/api/v1/administrativo/unidades/uni-9/calendario");
  });

  test("nenhum endpoint envia x-context-token, mesmo com um no sessionStorage", async () => {
    globalThis.sessionStorage.getItem = (k) => (k === "cd.contextToken" ? "token-tenant-fake" : null);
    for (const chamar of [
      () => painelAdmApi.visaoGeral(),
      () => painelAdmApi.monitoramentoDiario({ status: "critico" }),
      () => painelAdmApi.detalheEmpresa("o1"),
      () => painelAdmApi.calendarioUnidade("u1", "2026-09"),
    ]) {
      stubFetch();
      await chamar();
      const h = capturado.opcoes.headers ?? {};
      assert.ok(!Object.keys(h).some((k) => k.toLowerCase() === "x-context-token"));
    }
    globalThis.sessionStorage.getItem = () => null;
  });

  test("403 em qualquer endpoint -> erro com .status = 403", async () => {
    stubFetch({ status: 403, body: { error: "Acesso restrito ao Painel Administrativo." } });
    await assert.rejects(() => painelAdmApi.visaoGeral(), (e) => e.status === 403);
  });
});

describe("painelAdmApi — período ativo (mes=AAAA-MM)", () => {
  const rotaDe = (u) => new URL(u, "http://x").pathname + new URL(u, "http://x").search;

  test("todo endpoint aceita `mes` e o põe na query string", async () => {
    const casos = [
      [() => painelAdmApi.visaoGeral({ mes: "2026-08" }), "/api/v1/administrativo/visao-geral?mes=2026-08"],
      [() => painelAdmApi.pendencias({ mes: "2026-08" }), "/api/v1/administrativo/pendencias?mes=2026-08"],
      [() => painelAdmApi.empresas({ mes: "2026-08" }), "/api/v1/administrativo/empresas?mes=2026-08"],
      [() => painelAdmApi.detalheEmpresa("o1", { mes: "2026-08" }), "/api/v1/administrativo/empresas/o1?mes=2026-08"],
      [() => painelAdmApi.calendarioUnidade("u1", "2026-08"), "/api/v1/administrativo/unidades/u1/calendario?mes=2026-08"],
    ];
    for (const [chamar, esperada] of casos) {
      stubFetch();
      await chamar();
      assert.equal(rotaDe(capturado.url), esperada);
    }
  });

  test("sem `mes`, a rota fica sem query string (mês corrente no backend)", async () => {
    for (const [chamar, esperada] of [
      [() => painelAdmApi.visaoGeral(), "/api/v1/administrativo/visao-geral"],
      [() => painelAdmApi.pendencias(), "/api/v1/administrativo/pendencias"],
      [() => painelAdmApi.empresas(), "/api/v1/administrativo/empresas"],
      [() => painelAdmApi.detalheEmpresa("o1"), "/api/v1/administrativo/empresas/o1"],
    ]) {
      stubFetch();
      await chamar();
      assert.equal(rotaDe(capturado.url), esperada);
    }
  });

  test("monitoramentoDiario combina `mes` com os demais filtros", async () => {
    stubFetch();
    await painelAdmApi.monitoramentoDiario({ mes: "2026-08", criticidade: "critico", status: "" });
    const r = rotaDe(capturado.url);
    assert.match(r, /mes=2026-08/);
    assert.match(r, /criticidade=critico/);
    assert.ok(!/status=/.test(r), "filtro vazio não entra na query");
  });

  test("período não muda a autenticação: Bearer sim, x-context-token nunca", async () => {
    globalThis.sessionStorage.getItem = (k) => (k === "cd.contextToken" ? "token-tenant-fake" : null);
    stubFetch();
    await painelAdmApi.visaoGeral({ mes: "2026-08" });
    const h = capturado.opcoes.headers ?? {};
    assert.equal(h.Authorization, "Bearer jwt-identidade-fake");
    assert.ok(!Object.keys(h).some((k) => k.toLowerCase() === "x-context-token"));
    globalThis.sessionStorage.getItem = () => null;
  });
});

describe("painelAdmApi.comunicacaoConfirmarConsentimento — Checkpoint H.4-A.3.2", () => {
  const rotaDe = (u) => new URL(u, "http://x").pathname;

  test("POST .../consentimento, Bearer, mesmo mecanismo de autenticação do resto do Painel", async () => {
    stubFetch();
    await painelAdmApi.comunicacaoConfirmarConsentimento("org-piloto");
    assert.equal(rotaDe(capturado.url), "/api/v1/administrativo/comunicacao/organizacoes/org-piloto/consentimento");
    assert.equal(capturado.opcoes.method, "POST");
    const h = capturado.opcoes.headers ?? {};
    assert.equal(h.Authorization, "Bearer jwt-identidade-fake");
    assert.ok(!Object.keys(h).some((k) => k.toLowerCase() === "x-context-token"));
  });

  test("o corpo enviado contém SOMENTE confirmacaoExplicita:true — nunca telefone/perfil/habilitado/modo/opt_out", async () => {
    stubFetch();
    await painelAdmApi.comunicacaoConfirmarConsentimento("org-piloto");
    const corpo = JSON.parse(capturado.opcoes.body);
    assert.deepEqual(corpo, { confirmacaoExplicita: true });
  });
});
