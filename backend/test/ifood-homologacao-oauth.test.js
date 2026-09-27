// OAuth distribuído (POST /oauth/userCode e POST /oauth/token) em modo de
// homologação — prova que o fluxo NÃO MUDA (mesmas rotas, mesmo grant, sem
// client_credentials, sem redirect URI inventada), só a credencial externa
// resolvida troca. O `app_type` gravado no banco continua sendo 'analytics'
// ou 'financial' — quem grava é ifood.repository.js, que recebe o appType
// como veio do controller, nunca "test" (ver ifoodAuth.service.js).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);
process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";

process.env.IFOOD_HOMOLOGATION_MODE = "true";
process.env.IFOOD_TEST_CLIENT_ID = "test-app-id";
process.env.IFOOD_TEST_CLIENT_SECRET = "test-app-secret";
// Reais também presentes — o teste prova que NÃO são usados em homologação.
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
      const entrada = map[caminho];
      if (!entrada) throw new Error(`sem stub para ${caminho}`);
      return entrada;
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

test("iniciarConexao('analytics') em homologação chama /oauth/userCode com o clientId de TESTE", async () => {
  const http = httpFalso({ [IFOOD_ROTAS.userCode]: { userCode: "CODE-1", authorizationCodeVerifier: "V", expiresIn: 600 } });
  const repo = repoFalso();
  const r = await auth.iniciarConexao({ ...TENANT, appType: "analytics", deps: { http, repo } });

  assert.equal(r.appType, "analytics");                              // appType lógico preservado
  assert.deepEqual(http.chamadas[0].campos, { clientId: "test-app-id" });
  assert.equal(repo.estado.sessao.app_type, "analytics");             // banco continua gravando 'analytics'
});

test("iniciarConexao('financial') em homologação chama /oauth/userCode com o MESMO clientId de teste", async () => {
  const http = httpFalso({ [IFOOD_ROTAS.userCode]: { userCode: "CODE-2", authorizationCodeVerifier: "V", expiresIn: 600 } });
  const repo = repoFalso();
  const r = await auth.iniciarConexao({ ...TENANT, appType: "financial", deps: { http, repo } });

  assert.equal(r.appType, "financial");
  assert.deepEqual(http.chamadas[0].campos, { clientId: "test-app-id" });
  assert.equal(repo.estado.sessao.app_type, "financial");             // banco continua gravando 'financial'
});

test("trocarAuthorizationCodePorToken('analytics') em homologação usa clientId/clientSecret de TESTE", async () => {
  const http = httpFalso({ [IFOOD_ROTAS.token]: { accessToken: "AT", refreshToken: "RT", expiresIn: 21600 } });
  await token.trocarAuthorizationCodePorToken({ appType: "analytics", authorizationCode: "AC", verifier: "V", http });

  assert.equal(http.chamadas[0].campos.clientId, "test-app-id");
  assert.equal(http.chamadas[0].campos.clientSecret, "test-app-secret");
  assert.equal(http.chamadas[0].campos.grantType, "authorization_code");   // grant NÃO muda
});

test("trocarAuthorizationCodePorToken('financial') em homologação usa clientId/clientSecret de TESTE", async () => {
  const http = httpFalso({ [IFOOD_ROTAS.token]: { accessToken: "AT", refreshToken: "RT", expiresIn: 21600 } });
  await token.trocarAuthorizationCodePorToken({ appType: "financial", authorizationCode: "AC", verifier: "V", http });

  assert.equal(http.chamadas[0].campos.clientId, "test-app-id");
  assert.equal(http.chamadas[0].campos.clientSecret, "test-app-secret");
});

test("nenhuma rota inventada: só userCode e token são chamados, sem redirect_uri nem client_credentials", async () => {
  const http = httpFalso({ [IFOOD_ROTAS.token]: { accessToken: "AT", expiresIn: 21600 } });
  await token.trocarAuthorizationCodePorToken({ appType: "financial", authorizationCode: "AC", verifier: "V", http });

  assert.equal(http.chamadas[0].caminho, "/authentication/v1.0/oauth/token");
  assert.equal("redirect_uri" in http.chamadas[0].campos, false);
  assert.notEqual(http.chamadas[0].campos.grantType, "client_credentials");
});
