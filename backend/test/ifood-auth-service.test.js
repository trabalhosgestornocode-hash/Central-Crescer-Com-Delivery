// Fluxo OAuth distribuído do iFood — iniciar (userCode) e concluir (token).
// Sem rede real, sem banco real. Verifica em especial que o verifier NUNCA
// vaza para a resposta e que ele é destruído ao fim do fluxo.
import test from "node:test";
import assert from "node:assert/strict";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-client-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-client-secret";
process.env.IFOOD_ANALYTICS_CLIENT_ID = "";
process.env.IFOOD_ANALYTICS_CLIENT_SECRET = "";

const auth = await import("../src/modules/ifood/ifoodAuth.service.js");
const { IFOOD_ERROS, ifoodErro } = await import("../src/modules/ifood/ifood.errors.js");
const { decifrar } = await import("../src/shared/cripto.js");

const TENANT = { organizacaoId: "org-1", unidadeId: "uni-1", usuarioId: "user-1" };
const daquiA = (ms) => new Date(Date.now() + ms).toISOString();

function httpFalso(map) {
  const chamadas = [];
  return {
    chamadas,
    async postForm(caminho, campos) {
      chamadas.push({ caminho, campos });
      const entrada = map[caminho];
      if (!entrada) throw new Error(`sem stub para ${caminho}`);
      if (entrada.erro) throw entrada.erro;
      return entrada;
    },
  };
}

function repoFalso(overrides = {}) {
  const estado = { sessao: null, conexao: null, credencial: null, fechamentos: [] };
  const repo = {
    estado,
    async expirarSessoesVencidas() { return []; },
    async criarSessaoOAuth(args) {
      estado.sessao = {
        id: "sess-1", status: "pending",
        organizacao_id: args.organizacaoId, unidade_id: args.unidadeId, app_type: args.appType,
        user_code: args.userCode,
        authorization_code_verifier_cifrado: args.verifierCifrado,
        verification_url: args.verificationUrl, verification_url_complete: args.verificationUrlComplete,
        expira_em: args.expiraEm,
      };
      return estado.sessao;
    },
    async obterSessaoOAuth({ appType }) {
      if (!estado.sessao) throw ifoodErro(IFOOD_ERROS.IFOOD_OAUTH_SESSAO_NAO_ENCONTRADA);
      if (appType && estado.sessao.app_type !== appType) throw ifoodErro(IFOOD_ERROS.IFOOD_OAUTH_SESSAO_NAO_ENCONTRADA);
      return { ...estado.sessao };
    },
    async reivindicarSessaoOAuth() {
      const x = estado.sessao;
      if (!x || x.status !== "pending" || x.verifier_consumido_em) return null;
      x.verifier_consumido_em = new Date().toISOString();   // síncrono = atômico, como o UPDATE condicional
      return { id: x.id };
    },
    async fecharSessaoOAuth({ status, anularVerifier = true }) {
      estado.fechamentos.push({ status, anularVerifier });
      estado.sessao = { ...estado.sessao, status, ...(anularVerifier ? { authorization_code_verifier_cifrado: null } : {}) };
      return estado.sessao;
    },
    async obterOuCriarConexao() {
      estado.conexao = estado.conexao ?? { id: "conx-1", status: "pendente" };
      return estado.conexao;
    },
    async salvarCredencial(args) { estado.credencial = args; return args; },
    ...overrides,
  };
  return repo;
}

// =====================================================================
// ETAPA 1 — iniciar
// =====================================================================
test("iniciarConexao: devolve sessionId/userCode/urls/expiraEm e NUNCA o verifier", async () => {
  const http = httpFalso({
    "/authentication/v1.0/oauth/userCode": {
      userCode: "HJLX-LPSQ", authorizationCodeVerifier: "VERIF-SECRETO",
      verificationUrl: "https://portal.ifood/x", verificationUrlComplete: "https://portal.ifood/x?c=HJLX-LPSQ",
      expiresIn: 600,
    },
  });
  const repo = repoFalso();
  const r = await auth.iniciarConexao({ ...TENANT, appType: "financial", deps: { http, repo } });

  assert.equal(r.sessionId, "sess-1");
  assert.equal(r.userCode, "HJLX-LPSQ");
  assert.equal(r.verificationUrlComplete, "https://portal.ifood/x?c=HJLX-LPSQ");
  assert.ok(new Date(r.expiraEm).getTime() > Date.now());

  const chaves = JSON.stringify(r).toLowerCase();
  assert.equal(chaves.includes("verif-secreto"), false, "verifier em claro na resposta");
  assert.equal(chaves.includes("verifier"), false);

  // No banco: cifrado, e decifra de volta ao valor certo.
  const guardado = repo.estado.sessao.authorization_code_verifier_cifrado;
  assert.notEqual(guardado, "VERIF-SECRETO");
  assert.equal(decifrar(guardado), "VERIF-SECRETO");

  // Só o clientId foi ao iFood (nunca secret nesta chamada).
  assert.deepEqual(http.chamadas[0].campos, { clientId: "fin-client-id" });
});

test("iniciarConexao: appType inválido -> IFOOD_APP_TYPE_INVALIDO", async () => {
  await assert.rejects(
    () => auth.iniciarConexao({ ...TENANT, appType: "xpto", deps: { http: httpFalso({}), repo: repoFalso() } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_APP_TYPE_INVALIDO,
  );
});

test("iniciarConexao: app sem credencial de ENV -> IFOOD_APP_SEM_CREDENCIAL (não chama o iFood)", async () => {
  const http = httpFalso({});
  await assert.rejects(
    () => auth.iniciarConexao({ ...TENANT, appType: "analytics", deps: { http, repo: repoFalso() } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_APP_SEM_CREDENCIAL,
  );
  assert.equal(http.chamadas.length, 0);
});

test("iniciarConexao: falha ao gerar userCode -> IFOOD_USER_CODE_FALHOU", async () => {
  const http = httpFalso({ "/authentication/v1.0/oauth/userCode": { erro: ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL) } });
  await assert.rejects(
    () => auth.iniciarConexao({ ...TENANT, appType: "financial", deps: { http, repo: repoFalso() } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_USER_CODE_FALHOU,
  );
});

// =====================================================================
// ETAPA 2 — concluir
// =====================================================================
async function prepararSessao(repo, { status = "pending", expiraEm = daquiA(5 * 60 * 1000), appType = "financial" } = {}) {
  await repo.criarSessaoOAuth({
    organizacaoId: TENANT.organizacaoId, unidadeId: TENANT.unidadeId, appType,
    userCode: "HJLX-LPSQ",
    verifierCifrado: (await import("../src/shared/cripto.js")).cifrar("VERIF-SECRETO"),
    verificationUrl: null, verificationUrlComplete: null, expiraEm,
  });
  repo.estado.sessao.status = status;
}

test("concluirAutorizacao: troca o code por token, grava CIFRADO, fecha 'authorized' e anula o verifier", async () => {
  const repo = repoFalso();
  await prepararSessao(repo);
  const http = httpFalso({
    "/authentication/v1.0/oauth/token": { accessToken: "AT-1", refreshToken: "RT-1", expiresIn: 21600, type: "bearer" },
  });

  const r = await auth.concluirAutorizacao({
    ...TENANT, appType: "financial", sessaoId: "sess-1", authorizationCode: "AUTH-CODE-123", deps: { http, repo },
  });

  assert.deepEqual(r, { appType: "financial", status: "authorized", conexaoStatus: "pendente" });
  // credencial gravada cifrada
  assert.notEqual(repo.estado.credencial.accessTokenCifrado, "AT-1");
  assert.equal(decifrar(repo.estado.credencial.accessTokenCifrado), "AT-1");
  assert.equal(decifrar(repo.estado.credencial.refreshTokenCifrado), "RT-1");
  // sessão fechada como authorized, verifier anulado
  assert.deepEqual(repo.estado.fechamentos.at(-1), { status: "authorized", anularVerifier: true });
  assert.equal(repo.estado.sessao.authorization_code_verifier_cifrado, null);
  // o secret FOI enviado nesta chamada (troca de token), mas nunca é logado
  assert.equal(http.chamadas[0].campos.clientSecret, "fin-client-secret");
  assert.equal(http.chamadas[0].campos.authorizationCodeVerifier, "VERIF-SECRETO");
});

test("concluirAutorizacao: sessão expirada -> marca 'expired' e IFOOD_OAUTH_SESSAO_EXPIRADA", async () => {
  const repo = repoFalso();
  await prepararSessao(repo, { expiraEm: daquiA(-1000) });
  await assert.rejects(
    () => auth.concluirAutorizacao({ ...TENANT, appType: "financial", sessaoId: "sess-1", authorizationCode: "AUTH-CODE", deps: { http: httpFalso({}), repo } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_OAUTH_SESSAO_EXPIRADA,
  );
  assert.equal(repo.estado.fechamentos.at(-1).status, "expired");
});

test("concluirAutorizacao: sessão não-pending -> IFOOD_OAUTH_SESSAO_JA_USADA", async () => {
  const repo = repoFalso();
  await prepararSessao(repo, { status: "authorized" });
  await assert.rejects(
    () => auth.concluirAutorizacao({ ...TENANT, appType: "financial", sessaoId: "sess-1", authorizationCode: "AUTH-CODE", deps: { http: httpFalso({}), repo } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_OAUTH_SESSAO_JA_USADA,
  );
});

test("concluirAutorizacao: verifier já consumido (null) -> IFOOD_OAUTH_SESSAO_JA_USADA", async () => {
  const repo = repoFalso();
  await prepararSessao(repo);
  repo.estado.sessao.authorization_code_verifier_cifrado = null;
  await assert.rejects(
    () => auth.concluirAutorizacao({ ...TENANT, appType: "financial", sessaoId: "sess-1", authorizationCode: "AUTH-CODE", deps: { http: httpFalso({}), repo } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_OAUTH_SESSAO_JA_USADA,
  );
});

test("concluirAutorizacao: authorizationCode recusado pelo iFood -> fecha 'failed' e IFOOD_OAUTH_CODIGO_INVALIDO", async () => {
  const repo = repoFalso();
  await prepararSessao(repo);
  const http = httpFalso({ "/authentication/v1.0/oauth/token": { erro: ifoodErro(IFOOD_ERROS.IFOOD_OAUTH_CODIGO_INVALIDO) } });
  await assert.rejects(
    () => auth.concluirAutorizacao({ ...TENANT, appType: "financial", sessaoId: "sess-1", authorizationCode: "ruim", deps: { http, repo } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_OAUTH_CODIGO_INVALIDO,
  );
  assert.equal(repo.estado.fechamentos.at(-1).status, "failed");
  assert.equal(repo.estado.credencial, null, "nenhuma credencial gravada em falha");
});

test("concluirAutorizacao: appType diferente do da sessão -> IFOOD_OAUTH_SESSAO_NAO_ENCONTRADA", async () => {
  const repo = repoFalso();
  await prepararSessao(repo, { appType: "financial" });
  await assert.rejects(
    () => auth.concluirAutorizacao({ ...TENANT, appType: "analytics", sessaoId: "sess-1", authorizationCode: "AUTH", deps: { http: httpFalso({}), repo } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_APP_SEM_CREDENCIAL || e.codigo === IFOOD_ERROS.IFOOD_OAUTH_SESSAO_NAO_ENCONTRADA,
  );
});

// =====================================================================
// CHECKPOINT DISTRIBUÍDO — concorrência, isolamento e higiene de logs
// =====================================================================
test("concorrência: duas conclusões simultâneas da MESMA sessão -> só uma troca o código", async () => {
  const repo = repoFalso();
  await prepararSessao(repo);
  const http = httpFalso({
    "/authentication/v1.0/oauth/token": { accessToken: "AT-1", refreshToken: "RT-1", expiresIn: 21600, type: "bearer" },
  });
  const args = { ...TENANT, appType: "financial", sessaoId: "sess-1", authorizationCode: "AUTH-CODE-123", deps: { http, repo } };

  const r = await Promise.allSettled([auth.concluirAutorizacao(args), auth.concluirAutorizacao(args)]);

  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  const rej = r.find((x) => x.status === "rejected");
  assert.equal(rej.reason.codigo, IFOOD_ERROS.IFOOD_OAUTH_SESSAO_JA_USADA);
  assert.equal(http.chamadas.length, 1, "o iFood recebeu mais de uma troca de código");
});

test("tentativa reutilizada depois de concluída -> IFOOD_OAUTH_SESSAO_JA_USADA, sem nova chamada ao iFood", async () => {
  const repo = repoFalso();
  await prepararSessao(repo);
  const http = httpFalso({ "/authentication/v1.0/oauth/token": { accessToken: "AT-1", refreshToken: "RT-1", expiresIn: 21600 } });
  const args = { ...TENANT, appType: "financial", sessaoId: "sess-1", authorizationCode: "AUTH-CODE-123", deps: { http, repo } };
  await auth.concluirAutorizacao(args);
  await assert.rejects(() => auth.concluirAutorizacao(args), (e) => e.codigo === IFOOD_ERROS.IFOOD_OAUTH_SESSAO_JA_USADA);
  assert.equal(http.chamadas.length, 1);
});

test("sessão criada por OUTRA unidade -> IFOOD_OAUTH_SESSAO_NAO_ENCONTRADA, sem chamar o iFood", async () => {
  // Fake que, como o repositório real, filtra a sessão por organização + unidade.
  const base = repoFalso();
  await prepararSessao(base);
  const repo = {
    ...base,
    async obterSessaoOAuth({ organizacaoId, unidadeId, appType }) {
      const x = base.estado.sessao;
      if (!x || x.organizacao_id !== organizacaoId || x.unidade_id !== unidadeId || (appType && x.app_type !== appType)) {
        throw ifoodErro(IFOOD_ERROS.IFOOD_OAUTH_SESSAO_NAO_ENCONTRADA);
      }
      return { ...x };
    },
  };
  const http = httpFalso({});
  for (const outro of [{ unidadeId: "uni-2" }, { organizacaoId: "org-2" }]) {
    await assert.rejects(
      () => auth.concluirAutorizacao({ ...TENANT, ...outro, appType: "financial", sessaoId: "sess-1", authorizationCode: "AUTH-CODE", deps: { http, repo } }),
      (e) => e.codigo === IFOOD_ERROS.IFOOD_OAUTH_SESSAO_NAO_ENCONTRADA,
    );
  }
  assert.equal(http.chamadas.length, 0);
  assert.equal(base.estado.sessao.status, "pending", "sessão de outra unidade não pode ser alterada");
});

test("logs do fluxo completo não contêm verifier, clientSecret, tokens nem authorizationCode", async () => {
  const saidas = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => saidas.push(a.join(" "));
  try {
    const repo = repoFalso();
    const http = httpFalso({
      "/authentication/v1.0/oauth/userCode": { userCode: "HJLX-LPSQ", authorizationCodeVerifier: "VERIF-SECRETO", expiresIn: 600 },
      "/authentication/v1.0/oauth/token": { accessToken: "AT-SECRETO", refreshToken: "RT-SECRETO", expiresIn: 21600, type: "bearer" },
    });
    await auth.iniciarConexao({ ...TENANT, appType: "financial", deps: { http, repo } });
    await auth.concluirAutorizacao({ ...TENANT, appType: "financial", sessaoId: "sess-1", authorizationCode: "AUTH-CODE-SECRETO", deps: { http, repo } });
  } finally { Object.assign(console, orig); }
  const tudo = saidas.join(" | ");
  for (const segredo of ["VERIF-SECRETO", "fin-client-secret", "AT-SECRETO", "RT-SECRETO", "AUTH-CODE-SECRETO"]) {
    assert.equal(tudo.includes(segredo), false, `vazou em log: ${segredo}`);
  }
});
