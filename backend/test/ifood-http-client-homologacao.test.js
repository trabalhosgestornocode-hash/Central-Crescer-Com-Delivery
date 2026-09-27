// Header x-request-homologation — pedido pelo suporte iFood para testar
// endpoints em homologação. Precisa ser 100% opt-in por chamada: nunca
// injetado sozinho por causa de IFOOD_HOMOLOGATION_MODE, e nunca ausente
// quando explicitamente pedido.
import test from "node:test";
import assert from "node:assert/strict";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";

const { postForm, getJson } = await import("../src/modules/ifood/ifoodHttp.client.js");

function fetchFalso(resposta) {
  const chamadas = [];
  const impl = async (url, opts) => {
    chamadas.push({ url, headers: opts?.headers });
    return {
      ok: true, status: 200,
      headers: { get: (h) => (h.toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => JSON.stringify(resposta ?? {}),
    };
  };
  return { chamadas, impl };
}

test("getJson({homologacao: true}) adiciona x-request-homologation: true", async () => {
  const f = fetchFalso({ ok: true });
  await getJson("/merchant/v1.0/merchants", { accessToken: "t", homologacao: true, fetchImpl: f.impl });
  assert.equal(f.chamadas[0].headers["x-request-homologation"], "true");
});

test("getJson({homologacao: false}) NÃO adiciona o header", async () => {
  const f = fetchFalso({ ok: true });
  await getJson("/merchant/v1.0/merchants", { accessToken: "t", homologacao: false, fetchImpl: f.impl });
  assert.equal("x-request-homologation" in f.chamadas[0].headers, false);
});

test("getJson sem passar `homologacao` (modo normal) não injeta o header por acidente", async () => {
  const f = fetchFalso({ ok: true });
  await getJson("/merchant/v1.0/merchants", { accessToken: "t", fetchImpl: f.impl });
  assert.equal("x-request-homologation" in f.chamadas[0].headers, false);
});

test("postForm({homologacao: true}) adiciona x-request-homologation: true", async () => {
  const f = fetchFalso({ accessToken: "AT" });
  await postForm("/authentication/v1.0/oauth/token", { grantType: "x" }, { homologacao: true, fetchImpl: f.impl });
  assert.equal(f.chamadas[0].headers["x-request-homologation"], "true");
});

test("postForm sem `homologacao` (fluxo OAuth normal) não injeta o header — Fase 1 intocada", async () => {
  const f = fetchFalso({ userCode: "C" });
  await postForm("/authentication/v1.0/oauth/userCode", { clientId: "abc" }, { fetchImpl: f.impl });
  assert.equal("x-request-homologation" in f.chamadas[0].headers, false);
  // headers de sempre continuam lá, intactos.
  assert.equal(f.chamadas[0].headers["Content-Type"], "application/x-www-form-urlencoded");
});
