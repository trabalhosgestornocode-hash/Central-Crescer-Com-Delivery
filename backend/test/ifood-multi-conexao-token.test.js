// iFood — tokens INDEPENDENTES por conexão (Financial de homologação x Order de produção na mesma unidade).
// A renovação, a expiração e a falha de refresh de uma credencial nunca tocam a da outra conexão. Zero rede, zero banco.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const NORTH = "00000000-0000-0000-0000-0000000000b2";
process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_HOMOLOGATION_MODE = "false";
process.env.IFOOD_CENTRALIZED_TEST_MODE = "false";
process.env.IFOOD_FINANCIAL_HOMOLOGATION_UNITS = NORTH;
process.env.IFOOD_TEST_CLIENT_ID = "app-de-teste-id";
process.env.IFOOD_TEST_CLIENT_SECRET = "app-de-teste-secret";
process.env.IFOOD_ORDER_CLIENT_ID = "app-order-id";
process.env.IFOOD_ORDER_CLIENT_SECRET = "app-order-secret";
process.env.IFOOD_ORDER_PILOT_UNITS = NORTH;

const token = await import("../src/modules/ifood/ifoodToken.service.js");
const httpClient = await import("../src/modules/ifood/ifoodHttp.client.js");
const { cifrar, decifrar } = await import("../src/shared/cripto.js");
const { IFOOD_ERROS } = await import("../src/modules/ifood/ifood.errors.js");

const daquiA = (ms) => new Date(Date.now() + ms).toISOString();
const cred = ({ at, rt, expiraEmMs, status = "ativa" }) => ({ access_token_cifrado: cifrar(at), refresh_token_cifrado: cifrar(rt), expira_em: daquiA(expiraEmMs), status });

/** Repositório em memória: credenciais por (conexão, app). A unidade de cada conexão decide o app de teste do Financial. */
function repoFalso() {
  const creds = {
    "con-teste:financial": cred({ at: "AT-fin-velho", rt: "RT-fin", expiraEmMs: -60_000 }),       // EXPIRADA
    "con-real:order": cred({ at: "AT-order-bom", rt: "RT-order", expiraEmMs: 3_600_000 }),          // válida
  };
  const chave = (c, a) => `${c}:${a}`;
  return {
    creds,
    async obterUnidadeDaConexao() { return NORTH; },
    async obterCredencial({ conexaoId, appType }) { const c = creds[chave(conexaoId, appType)]; return c ? { ...c } : null; },
    async salvarCredencial(a) { creds[chave(a.conexaoId, a.appType)] = { ...(creds[chave(a.conexaoId, a.appType)] ?? {}), access_token_cifrado: a.accessTokenCifrado, expira_em: a.expiraEm, status: "ativa", ...(a.refreshTokenCifrado !== undefined ? { refresh_token_cifrado: a.refreshTokenCifrado } : {}) }; return creds[chave(a.conexaoId, a.appType)]; },
    async atualizarCredencial({ conexaoId, appType, campos, seAccessCifradoIgual }) {
      const c = creds[chave(conexaoId, appType)];
      if (!c) return null;
      if (seAccessCifradoIgual !== undefined && c.access_token_cifrado !== seAccessCifradoIgual) return null;
      creds[chave(conexaoId, appType)] = { ...c, ...campos };
      return creds[chave(conexaoId, appType)];
    },
  };
}
const resposta = (status, corpo) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) }, text: async () => JSON.stringify(corpo) });
function httpComFetch(fn) {
  const chamadas = [];
  const fetchImpl = async (url, init) => { chamadas.push({ url, corpo: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null }); return fn(chamadas.length); };
  return { chamadas, postForm: (c, campos, o) => httpClient.postForm(c, campos, { ...(o ?? {}), fetchImpl }), getJson: (c, o) => httpClient.getJson(c, { ...o, fetchImpl }) };
}
const silencio = async (fn) => { const o = { ...console }; console.log = console.warn = console.error = () => {}; try { return await fn(); } finally { Object.assign(console, o); } };

describe("tokens independentes por conexão", () => {
  test("Financial de homologação expirado é renovado com o app de TESTE; a credencial Order da outra conexão não é lida nem gravada", async () => {
    const repo = repoFalso();
    const orderAntes = JSON.stringify(repo.creds["con-real:order"]);
    const http = httpComFetch(() => resposta(200, { accessToken: "AT-fin-novo", refreshToken: "RT-fin-novo", expiresIn: 21600 }));
    const r = await silencio(() => token.getValidAccessToken({ conexaoId: "con-teste", appType: "financial", deps: { repo, http } }));
    assert.equal(r, "AT-fin-novo");
    assert.equal(http.chamadas.length, 1);
    assert.equal(http.chamadas[0].corpo.clientId, "app-de-teste-id", "refresh do Financial da North usa o app de teste");
    assert.equal(http.chamadas[0].corpo.refreshToken, "RT-fin");
    assert.equal(JSON.stringify(repo.creds["con-real:order"]), orderAntes, "a credencial Order ficou intacta");
  });

  test("Order válido NÃO renova (e não depende de o Financial estar expirado)", async () => {
    const repo = repoFalso();
    const http = httpComFetch(() => resposta(200, {}));
    assert.equal(await token.getValidAccessToken({ conexaoId: "con-real", appType: "order", deps: { repo, http } }), "AT-order-bom");
    assert.equal(http.chamadas.length, 0);
  });

  test("Order expirado é renovado com o app de PEDIDOS (nunca o de teste); o Financial fica como estava", async () => {
    const repo = repoFalso();
    repo.creds["con-real:order"] = cred({ at: "AT-order-velho", rt: "RT-order", expiraEmMs: 60_000 });
    const finAntes = JSON.stringify(repo.creds["con-teste:financial"]);
    const http = httpComFetch(() => resposta(200, { accessToken: "AT-order-novo", refreshToken: "RT-order-novo", expiresIn: 21600 }));
    const r = await silencio(() => token.getValidAccessToken({ conexaoId: "con-real", appType: "order", deps: { repo, http } }));
    assert.equal(r, "AT-order-novo");
    assert.equal(http.chamadas[0].corpo.clientId, "app-order-id");
    assert.equal(decifrar(repo.creds["con-real:order"].access_token_cifrado), "AT-order-novo");
    assert.equal(JSON.stringify(repo.creds["con-teste:financial"]), finAntes);
  });

  test("refresh do Financial recusado (invalid_grant): SÓ a credencial dele vai a reauth_required; o Order segue servindo", async () => {
    const repo = repoFalso();
    const http = httpComFetch(() => resposta(400, { error: "invalid_grant" }));
    const e = await silencio(() => token.getValidAccessToken({ conexaoId: "con-teste", appType: "financial", deps: { repo, http } }).catch((x) => x));
    assert.ok(e instanceof Error);
    assert.ok([IFOOD_ERROS.IFOOD_REFRESH_FALHOU, IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO].includes(e.codigo), String(e.codigo));
    assert.equal(repo.creds["con-teste:financial"].status, "reauth_required");
    assert.equal(repo.creds["con-real:order"].status, "ativa");
    assert.equal(await token.getValidAccessToken({ conexaoId: "con-real", appType: "order", deps: { repo, http } }), "AT-order-bom");
  });

  test("renovações simultâneas das duas conexões não se misturam (chaves distintas por conexão e app)", async () => {
    const repo = repoFalso();
    repo.creds["con-real:order"] = cred({ at: "AT-order-velho", rt: "RT-order", expiraEmMs: 60_000 });
    const http = httpComFetch((n) => resposta(200, { accessToken: `AT-${n}`, refreshToken: `RT-${n}`, expiresIn: 21600 }));
    const [fin, ord] = await silencio(() => Promise.all([
      token.getValidAccessToken({ conexaoId: "con-teste", appType: "financial", deps: { repo, http } }),
      token.getValidAccessToken({ conexaoId: "con-real", appType: "order", deps: { repo, http } }),
    ]));
    assert.notEqual(fin, ord);
    assert.equal(http.chamadas.length, 2, "uma renovação por credencial");
    const porCliente = Object.fromEntries(http.chamadas.map((c) => [c.corpo.clientId, c.corpo.refreshToken]));
    assert.deepEqual(porCliente, { "app-de-teste-id": "RT-fin", "app-order-id": "RT-order" });
  });
});
