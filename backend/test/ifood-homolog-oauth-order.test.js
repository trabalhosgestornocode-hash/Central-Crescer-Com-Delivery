// OAuth distribuído com appType 'order' — SÓ em homologação (IFOOD_HOMOLOGATION_MODE=true).
// Em homologação, 'order' resolve para o mesmo app de teste (Teste D) de analytics/financial,
// e a credencial fica no slot 'order' da conexão: o poller distribuído usa a SUA credencial,
// nunca a do financial. Fora de homologação continua recusado (ver ifood-app-order.test.js).
// Sem rede real, sem banco real.
import test from "node:test";
import assert from "node:assert/strict";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_HOMOLOGATION_MODE = "true";
process.env.IFOOD_TEST_CLIENT_ID = "teste-d-client-id";
process.env.IFOOD_TEST_CLIENT_SECRET = "teste-d-client-secret";
process.env.IFOOD_CENTRALIZED_TEST_MODE = "false";

const auth = await import("../src/modules/ifood/ifoodAuth.service.js");
const tokenService = await import("../src/modules/ifood/ifoodToken.service.js");
const { validarAppType } = await import("../src/modules/ifood/ifood.validators.js");
const { IFOOD_APP_TYPES } = await import("../src/modules/ifood/ifood.constants.js");
const { decifrar } = await import("../src/shared/cripto.js");

const TENANT = { organizacaoId: "org-1", unidadeId: "uni-1", usuarioId: "user-1" };

function httpFalso(map) {
  const chamadas = [];
  return {
    chamadas,
    async postForm(caminho, campos) {
      chamadas.push({ caminho, campos });
      const r = map[caminho];
      if (!r) throw new Error(`sem stub para ${caminho}`);
      return r;
    },
  };
}

function repoFalso() {
  const estado = { sessao: null, credenciais: [] };
  return {
    estado,
    async expirarSessoesVencidas() { return []; },
    async criarSessaoOAuth(a) {
      estado.sessao = { id: "sess-1", status: "pending", app_type: a.appType, authorization_code_verifier_cifrado: a.verifierCifrado, expira_em: a.expiraEm };
      return estado.sessao;
    },
    async obterSessaoOAuth({ appType }) {
      if (appType && estado.sessao.app_type !== appType) throw new Error("sessão de outro appType");
      return { ...estado.sessao };
    },
    async reivindicarSessaoOAuth() { return { id: "sess-1" }; },
    async fecharSessaoOAuth({ status }) { estado.sessao = { ...estado.sessao, status }; return estado.sessao; },
    async obterOuCriarConexao() { return { id: "conx-1", status: "ativa" }; },
    async salvarCredencial(a) { estado.credenciais.push(a); return a; },
  };
}

const USER_CODE = { userCode: "ABCD-1234", authorizationCodeVerifier: "verif-1", verificationUrl: "https://portal", verificationUrlComplete: "https://portal?c=ABCD-1234", expiresIn: 600 };
const TOKEN = { accessToken: "AT-order", refreshToken: "RT-order", expiresIn: 21600 };

test("homologação: 'order' é aceito pelo validador HTTP e pelo service; UI/status seguem só analytics/financial", () => {
  assert.equal(validarAppType("order"), "order");
  assert.deepEqual(tokenService.appTypesDoOAuth(), ["analytics", "financial", "order"]);
  assert.deepEqual([...IFOOD_APP_TYPES], ["analytics", "financial"], "IFOOD_APP_TYPES (UI/status) não muda");
});

test("homologação: credenciaisDoApp('order') resolve para o app de TESTE (Teste D), igual a financial", () => {
  const order = tokenService.credenciaisDoApp("order");
  assert.deepEqual(order, { clientId: "teste-d-client-id", clientSecret: "teste-d-client-secret", origem: "test" });
  assert.deepEqual(tokenService.credenciaisDoApp("financial"), order);
});

test("homologação: iniciarConexao('order') pede userCode com o clientId do Teste D e abre sessão 'order'", async () => {
  const repo = repoFalso();
  const http = httpFalso({ "/authentication/v1.0/oauth/userCode": USER_CODE });
  const r = await auth.iniciarConexao({ ...TENANT, appType: "order", deps: { repo, http } });
  assert.equal(r.appType, "order");
  assert.equal(r.userCode, "ABCD-1234");
  assert.equal("verifier" in r || "authorizationCodeVerifier" in r, false, "verifier nunca sai");
  assert.deepEqual(http.chamadas[0].campos, { clientId: "teste-d-client-id" });
  assert.equal(repo.estado.sessao.app_type, "order");
});

test("homologação: concluirAutorizacao('order') troca o código com o Teste D e grava SÓ o slot 'order' (cifrado)", async () => {
  const repo = repoFalso();
  const http = httpFalso({ "/authentication/v1.0/oauth/userCode": USER_CODE, "/authentication/v1.0/oauth/token": TOKEN });
  const ini = await auth.iniciarConexao({ ...TENANT, appType: "order", deps: { repo, http } });
  const r = await auth.concluirAutorizacao({ ...TENANT, appType: "order", sessaoId: ini.sessionId, authorizationCode: "AUTH-CODE-D", deps: { repo, http } });
  assert.equal(r.status, "authorized");
  const troca = http.chamadas[1].campos;
  assert.equal(troca.grantType, "authorization_code");
  assert.equal(troca.clientId, "teste-d-client-id");
  assert.equal(troca.authorizationCodeVerifier, "verif-1");
  assert.equal(repo.estado.credenciais.length, 1);
  const cred = repo.estado.credenciais[0];
  assert.equal(cred.appType, "order");
  assert.equal(cred.conexaoId, "conx-1");
  assert.equal(decifrar(cred.accessTokenCifrado), "AT-order");
  assert.equal(decifrar(cred.refreshTokenCifrado), "RT-order");
  assert.ok(!JSON.stringify(cred).includes("AT-order"), "nada em claro");
  assert.equal(repo.estado.sessao.status, "authorized");
});

test("homologação: refresh do slot 'order' usa o Teste D (grantType=refresh_token)", async () => {
  const http = httpFalso({ "/authentication/v1.0/oauth/token": { accessToken: "AT-2", refreshToken: "RT-2", expiresIn: 21600 } });
  const t = await tokenService.renovarToken({ appType: "order", refreshToken: "RT-order", http });
  assert.equal(t.accessToken, "AT-2");
  assert.deepEqual(http.chamadas[0].campos, { grantType: "refresh_token", clientId: "teste-d-client-id", clientSecret: "teste-d-client-secret", refreshToken: "RT-order" });
});
