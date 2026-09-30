// App homologado de Order + Events (central-ccd) FORA de homologação: `order` entra no OAuth distribuído
// só quando IFOOD_ORDER_CLIENT_ID + IFOOD_ORDER_CLIENT_SECRET existem, e resolve para ESSA credencial —
// nunca a do financial, do analytics, do app de teste (Teste D) ou do centralizado (Teste C).
// Em homologação, `order` segue no Teste D. Sem rede, sem banco.
import test from "node:test";
import assert from "node:assert/strict";

process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_HOMOLOGATION_MODE = "false";
process.env.IFOOD_CENTRALIZED_TEST_MODE = "false";
process.env.IFOOD_ANALYTICS_CLIENT_ID = "analytics-id";
process.env.IFOOD_ANALYTICS_CLIENT_SECRET = "analytics-secret";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "financial-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "financial-secret";
process.env.IFOOD_TEST_CLIENT_ID = "teste-d-id";
process.env.IFOOD_TEST_CLIENT_SECRET = "teste-d-secret";
process.env.IFOOD_CENTRALIZED_TEST_CLIENT_ID = "teste-c-id";
process.env.IFOOD_CENTRALIZED_TEST_CLIENT_SECRET = "teste-c-secret";
process.env.IFOOD_ORDER_CLIENT_ID = "order-prod-id";
process.env.IFOOD_ORDER_CLIENT_SECRET = "order-prod-secret";

const { config } = await import("../src/config/env.js");
const tokenService = await import("../src/modules/ifood/ifoodToken.service.js");
const auth = await import("../src/modules/ifood/ifoodAuth.service.js");
const { validarAppType } = await import("../src/modules/ifood/ifood.validators.js");
const { IFOOD_APP_TYPES } = await import("../src/modules/ifood/ifood.constants.js");
const { IFOOD_ERROS } = await import("../src/modules/ifood/ifood.errors.js");
const { decifrar } = await import("../src/shared/cripto.js");

const ORDER = { clientId: "order-prod-id", clientSecret: "order-prod-secret" };
const OUTROS_IDS = ["analytics-id", "financial-id", "teste-d-id", "teste-c-id"];

// config é um objeto único do processo: cada teste ajusta e restaura o que mexe.
async function com(ajuste, fn) {
  const antes = JSON.parse(JSON.stringify(config.ifood));
  Object.assign(config.ifood, ajuste);
  try { return await fn(); } finally { Object.assign(config.ifood, antes); }
}
const recusaOrder = () => {
  assert.deepEqual(tokenService.appTypesDoOAuth(), ["analytics", "financial"]);
  assert.throws(() => validarAppType("order"), (e) => e.codigo === IFOOD_ERROS.IFOOD_APP_TYPE_INVALIDO);
  assert.throws(() => tokenService.credenciaisDoApp("order"), (e) => e.codigo === IFOOD_ERROS.IFOOD_APP_TYPE_INVALIDO);
};

test("env: IFOOD_ORDER_CLIENT_* viram config.ifood.order", () => {
  assert.deepEqual(config.ifood.order, ORDER);
});

test("fora de homologação, COM o app de Order: 'order' entra no OAuth e usa SÓ a credencial dele", () => {
  assert.equal(tokenService.modoDeAutenticacao(), "distributed");
  assert.deepEqual(tokenService.appTypesDoOAuth(), ["analytics", "financial", "order"]);
  assert.equal(validarAppType("order"), "order");
  const c = tokenService.credenciaisDoApp("order");
  assert.deepEqual(c, ORDER);
  assert.ok(!OUTROS_IDS.includes(c.clientId), "nunca outro app");
  assert.deepEqual(tokenService.credenciaisDoApp("financial"), { clientId: "financial-id", clientSecret: "financial-secret" }, "financial não muda");
  assert.deepEqual(tokenService.credenciaisDoApp("analytics"), { clientId: "analytics-id", clientSecret: "analytics-secret" }, "analytics não muda");
  assert.deepEqual([...IFOOD_APP_TYPES], ["analytics", "financial"], "UI/status não mudam");
});

test("fora de homologação, SEM o app de Order (ou só metade): 'order' recusado — sem fallback p/ financial, analytics, Teste D ou Teste C", async () => {
  // financial, analytics, Teste D e Teste C continuam configurados neste processo: nenhum deles pode ser usado.
  for (const order of [{ clientId: null, clientSecret: null }, { clientId: "x", clientSecret: null }, { clientId: null, clientSecret: "y" }]) {
    await com({ order }, recusaOrder);
  }
});

test("homologação: 'order' continua no Teste D, mesmo com o app de produção configurado", async () => {
  await com({ homologacao: true }, () => {
    assert.deepEqual(tokenService.appTypesDoOAuth(), ["analytics", "financial", "order"]);
    assert.deepEqual(tokenService.credenciaisDoApp("order"), { clientId: "teste-d-id", clientSecret: "teste-d-secret", origem: "test" });
  });
});

test("homologação sem Teste D: falha controlada — NÃO cai no app de Order de produção", async () => {
  await com({ homologacao: true, test: { clientId: null, clientSecret: null } }, () => {
    assert.throws(() => tokenService.credenciaisDoApp("order"), (e) => e.codigo === IFOOD_ERROS.IFOOD_APP_SEM_CREDENCIAL);
  });
});

test("Teste C nunca é credencial de OAuth: credenciaisDoApp não devolve o app centralizado em nenhum modo", async () => {
  for (const ajuste of [{}, { homologacao: true }, { centralizedTest: { modo: true, clientId: "teste-c-id", clientSecret: "teste-c-secret" } }]) {
    await com(ajuste, () => {
      for (const app of tokenService.appTypesDoOAuth()) {
        assert.notEqual(tokenService.credenciaisDoApp(app).clientId, "teste-c-id", `${JSON.stringify(ajuste)} ${app}`);
      }
    });
  }
});

test("refresh do slot 'order' fora de homologação usa a credencial do app de Order", async () => {
  const chamadas = [];
  const http = { async postForm(caminho, campos) { chamadas.push({ caminho, campos }); return { accessToken: "AT", refreshToken: "RT", expiresIn: 21600 }; } };
  await tokenService.renovarToken({ appType: "order", refreshToken: "RT-0", http });
  assert.deepEqual(chamadas[0].campos, { grantType: "refresh_token", ...ORDER, refreshToken: "RT-0" });
});

// ---- OAuth distribuído completo (userCode -> authorizationCode -> token) com appType 'order' ----
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
function httpFalso(map) {
  const chamadas = [];
  return { chamadas, async postForm(caminho, campos) { chamadas.push({ caminho, campos }); if (!map[caminho]) throw new Error(`sem stub ${caminho}`); return map[caminho]; } };
}

test("OAuth 'order' fora de homologação: userCode e troca com o app de Order; grava SÓ o slot 'order', cifrado", async () => {
  const repo = repoFalso();
  const http = httpFalso({
    "/authentication/v1.0/oauth/userCode": { userCode: "ABCD-1234", authorizationCodeVerifier: "verif-1", verificationUrl: "https://portal", verificationUrlComplete: "https://portal?c=ABCD-1234", expiresIn: 600 },
    "/authentication/v1.0/oauth/token": { accessToken: "AT-order", refreshToken: "RT-order", expiresIn: 21600 },
  });
  const T = { organizacaoId: "org-1", unidadeId: "uni-1", usuarioId: "user-1" };
  const ini = await auth.iniciarConexao({ ...T, appType: "order", deps: { repo, http } });
  assert.deepEqual(http.chamadas[0].campos, { clientId: "order-prod-id" }, "userCode só com o clientId do app de Order");
  const r = await auth.concluirAutorizacao({ ...T, appType: "order", sessaoId: ini.sessionId, authorizationCode: "AUTH-1", deps: { repo, http } });
  assert.equal(r.status, "authorized");
  const troca = http.chamadas[1].campos;
  assert.equal(troca.grantType, "authorization_code");
  assert.equal(troca.clientId, "order-prod-id");
  assert.equal(troca.clientSecret, "order-prod-secret");
  assert.equal(repo.estado.credenciais.length, 1);
  const cred = repo.estado.credenciais[0];
  assert.equal(cred.appType, "order");
  assert.equal(decifrar(cred.accessTokenCifrado), "AT-order");
  assert.equal(decifrar(cred.refreshTokenCifrado), "RT-order");
  assert.ok(!JSON.stringify(cred).includes("AT-order") && !JSON.stringify(cred).includes("order-prod-secret"), "nada em claro");
});

test("OAuth 'order' fora de homologação SEM o app de Order: recusado ANTES de qualquer chamada ao iFood", async () => {
  await com({ order: { clientId: null, clientSecret: null } }, async () => {
    const http = httpFalso({});
    await assert.rejects(
      auth.iniciarConexao({ organizacaoId: "o", unidadeId: "u", usuarioId: "x", appType: "order", deps: { repo: repoFalso(), http } }),
      (e) => e.codigo === IFOOD_ERROS.IFOOD_APP_TYPE_INVALIDO,
    );
    assert.equal(http.chamadas.length, 0);
  });
});
