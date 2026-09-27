// Mesmo teste de OAuth acima, mas com homologação DESLIGADA — cada appType
// tem que usar sua própria credencial real (comportamento Fase 1, sem
// regressão).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);
process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";

process.env.IFOOD_HOMOLOGATION_MODE = "false";
process.env.IFOOD_ANALYTICS_CLIENT_ID = "an-real-id";
process.env.IFOOD_ANALYTICS_CLIENT_SECRET = "an-real-secret";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-real-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-real-secret";

const auth = await import("../src/modules/ifood/ifoodAuth.service.js");
const token = await import("../src/modules/ifood/ifoodToken.service.js");
const { IFOOD_ROTAS } = await import("../src/modules/ifood/ifood.constants.js");

const TENANT = { organizacaoId: "org-1", unidadeId: "uni-1", usuarioId: "user-1" };

function httpFalso(map) {
  const chamadas = [];
  return {
    chamadas,
    async postForm(caminho, campos) {
      chamadas.push({ caminho, campos });
      return map[caminho];
    },
  };
}

function repoFalso() {
  const estado = { sessao: null };
  return {
    estado,
    async expirarSessoesVencidas() { return []; },
    async criarSessaoOAuth(args) {
      estado.sessao = { id: "sess-1", status: "pending", app_type: args.appType, expira_em: args.expiraEm };
      return estado.sessao;
    },
  };
}

test("iniciarConexao('analytics') fora de homologação usa a credencial REAL de analytics", async () => {
  const http = httpFalso({ [IFOOD_ROTAS.userCode]: { userCode: "C", authorizationCodeVerifier: "V", expiresIn: 600 } });
  await auth.iniciarConexao({ ...TENANT, appType: "analytics", deps: { http, repo: repoFalso() } });
  assert.deepEqual(http.chamadas[0].campos, { clientId: "an-real-id" });
});

test("iniciarConexao('financial') fora de homologação usa a credencial REAL de financial", async () => {
  const http = httpFalso({ [IFOOD_ROTAS.userCode]: { userCode: "C", authorizationCodeVerifier: "V", expiresIn: 600 } });
  await auth.iniciarConexao({ ...TENANT, appType: "financial", deps: { http, repo: repoFalso() } });
  assert.deepEqual(http.chamadas[0].campos, { clientId: "fin-real-id" });
});

test("trocarAuthorizationCodePorToken('analytics') fora de homologação usa a credencial REAL", async () => {
  const http = httpFalso({ [IFOOD_ROTAS.token]: { accessToken: "AT", expiresIn: 21600 } });
  await token.trocarAuthorizationCodePorToken({ appType: "analytics", authorizationCode: "AC", verifier: "V", http });
  assert.equal(http.chamadas[0].campos.clientId, "an-real-id");
  assert.equal(http.chamadas[0].campos.clientSecret, "an-real-secret");
});

test("trocarAuthorizationCodePorToken('financial') fora de homologação usa a credencial REAL", async () => {
  const http = httpFalso({ [IFOOD_ROTAS.token]: { accessToken: "AT", expiresIn: 21600 } });
  await token.trocarAuthorizationCodePorToken({ appType: "financial", authorizationCode: "AC", verifier: "V", http });
  assert.equal(http.chamadas[0].campos.clientId, "fin-real-id");
  assert.equal(http.chamadas[0].campos.clientSecret, "fin-real-secret");
});
