// Credenciais do app TEST no Financial POR UNIDADE (IFOOD_FINANCIAL_HOMOLOGATION_UNITS).
//   * financial + unidade na allowlist -> IFOOD_TEST_CLIENT_ID/SECRET em userCode, troca e refresh;
//   * financial + outra unidade        -> IFOOD_FINANCIAL_CLIENT_ID/SECRET;
//   * order/analytics                  -> inalterados (mesmo na unidade da allowlist);
//   * TEST ausente                     -> IFOOD_APP_SEM_CREDENCIAL, sem chamar o iFood, sem fallback;
//   * IFOOD_HOMOLOGATION_MODE (global) -> comportamento legado preservado.
// Zero rede real e zero banco (http/repo falsos).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";

const { config } = await import("../src/config/env.js");
const tokenService = await import("../src/modules/ifood/ifoodToken.service.js");
const auth = await import("../src/modules/ifood/ifoodAuth.service.js");
const merchantService = await import("../src/modules/ifood/ifoodMerchant.service.js");
const { IFOOD_ERROS, ifoodErro } = await import("../src/modules/ifood/ifood.errors.js");
const { cifrar } = await import("../src/shared/cripto.js");
const { supabase } = await import("../src/config/supabase.js");
const { ifoodRouter } = await import("../src/modules/ifood/ifood.routes.js");
const { requireModulo } = await import("../src/middlewares/auth.js");
const { errorHandler } = await import("../src/middlewares/errorHandler.js");
const { MODULOS } = await import("../src/shared/modulos.js");
const { permissoesDoPapel } = await import("../src/shared/permissoes.js");

const UNI_A = "aaaaaaaa-0000-4000-8000-00000000000a"; // na allowlist (homologação Financial)
const UNI_B = "bbbbbbbb-0000-4000-8000-00000000000b"; // fora
const CRED = {
  test: { clientId: "TEST-ID-ficticio", clientSecret: "TEST-SECRET-ficticio" },
  financial: { clientId: "FIN-PROD-ID-ficticio", clientSecret: "FIN-PROD-SECRET-ficticio" },
  analytics: { clientId: "ANA-PROD-ID-ficticio", clientSecret: "ANA-PROD-SECRET-ficticio" },
  order: { clientId: "ORDER-PROD-ID-ficticio", clientSecret: "ORDER-PROD-SECRET-ficticio" },
};
const daquiA = (ms) => new Date(Date.now() + ms).toISOString();

// Config controlada por teste (restaura no fim).
const CHAVES = ["homologacao", "test", "financial", "analytics", "order", "orderPilotoUnidades", "financialHomologacaoUnidades", "financialFixture"];
const original = Object.fromEntries(CHAVES.map((k) => [k, config.ifood[k]]));
function definir(over = {}) {
  Object.assign(config.ifood, {
    homologacao: false, financialFixture: false,
    test: { ...CRED.test }, financial: { ...CRED.financial }, analytics: { ...CRED.analytics }, order: { ...CRED.order },
    orderPilotoUnidades: [UNI_A], financialHomologacaoUnidades: [UNI_A],
    ...over,
  });
}
after(() => Object.assign(config.ifood, original));

function silenciar() {
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const linhas = [];
  for (const k of Object.keys(orig)) console[k] = (...a) => linhas.push(a.map(String).join(" "));
  return { linhas, restaurar: () => Object.assign(console, orig) };
}
async function quieto(fn) { const s = silenciar(); try { return { r: await fn(), log: s.linhas.join("\n") }; } finally { s.restaurar(); } }

// http falso: registra cada POST de formulário (userCode e token).
function httpFalso() {
  const chamadas = [];
  return {
    chamadas,
    async postForm(caminho, campos, opts) {
      chamadas.push({ caminho, campos: { ...campos }, rotulo: opts?.rotulo });
      if (caminho.includes("userCode")) return { userCode: "ABCD-1234", authorizationCodeVerifier: "verifier-ficticio", verificationUrl: "https://portal.ifood.com.br/apps/code", expiresIn: 600 };
      return { accessToken: "AT-novo", refreshToken: "RT-novo", expiresIn: 21600 };
    },
    async getJson(caminho, opts) { chamadas.push({ caminho, accessToken: opts?.accessToken, homologacao: opts?.homologacao }); return [{ id: "55c8f464-e65f-4340-b2c7-62d143027040", name: "Loja Teste" }]; },
  };
}

function repoOAuth(unidadeDaSessao) {
  const estado = { sessao: null, credencial: null };
  return {
    estado,
    async expirarSessoesVencidas() { return []; },
    async criarSessaoOAuth(a) { estado.sessao = { id: "sess-1", organizacao_id: a.organizacaoId, unidade_id: a.unidadeId, app_type: a.appType, status: "pending", expira_em: a.expiraEm, authorization_code_verifier_cifrado: a.verifierCifrado, verification_url: a.verificationUrl }; return estado.sessao; },
    async obterSessaoOAuth() { return { id: "sess-1", unidade_id: unidadeDaSessao, app_type: "financial", status: "pending", expira_em: daquiA(300_000), authorization_code_verifier_cifrado: cifrar("verifier-ficticio") }; },
    async reivindicarSessaoOAuth() { return true; },
    async fecharSessaoOAuth() { return true; },
    async obterOuCriarConexao() { return { id: "conx-1", status: "pendente" }; },
    async salvarCredencial(a) { estado.credencial = a; return a; },
    async obterCredencial() { return estado.credencial; },
  };
}

function repoRefresh({ unidadeDaConexao, temLookup = true } = {}) {
  const estado = {
    lookups: 0,
    cred: { access_token_cifrado: cifrar("AT-velho"), refresh_token_cifrado: cifrar("RT-velho"), expira_em: daquiA(60_000), status: "ativa" }, // vence em 1 min -> renova
    atualizacoes: [],
  };
  const repo = {
    estado,
    async obterCredencial() { return { ...estado.cred }; },
    async salvarCredencial(a) { estado.cred = { access_token_cifrado: a.accessTokenCifrado, refresh_token_cifrado: a.refreshTokenCifrado ?? estado.cred.refresh_token_cifrado, expira_em: a.expiraEm, status: "ativa" }; return estado.cred; },
    async atualizarCredencial({ campos }) { estado.atualizacoes.push(campos); estado.cred = { ...estado.cred, ...campos }; return estado.cred; },
  };
  if (temLookup) repo.obterUnidadeDaConexao = async () => { estado.lookups += 1; return unidadeDaConexao; };
  return repo;
}

const usouTest = (c) => c.campos.clientId === CRED.test.clientId && c.campos.clientSecret === CRED.test.clientSecret;
const usouFinProd = (c) => c.campos.clientId === CRED.financial.clientId && c.campos.clientSecret === CRED.financial.clientSecret;
const SEGREDOS = Object.values(CRED).flatMap((c) => [c.clientId, c.clientSecret]).concat(["AT-novo", "RT-novo", "AT-velho", "RT-velho", "verifier-ficticio"]);
const semSegredo = (txt) => { for (const s of SEGREDOS) assert.ok(!txt.includes(s), `vazou ${s}`); };

// ===========================================================================
describe("credenciaisDoApp: seleção por appType + unidade", () => {
  before(() => definir());
  test("financial + unidade na allowlist -> app TEST", () => {
    assert.deepEqual(tokenService.credenciaisDoApp("financial", { unidadeId: UNI_A }), { ...CRED.test, origem: "test" });
    assert.equal(tokenService.fonteDaCredencial("financial", { unidadeId: UNI_A }), "test");
  });
  test("financial + unidade fora / sem unidade -> app Financial de produção (forma legada, sem origem)", () => {
    assert.deepEqual(tokenService.credenciaisDoApp("financial", { unidadeId: UNI_B }), CRED.financial);
    assert.deepEqual(tokenService.credenciaisDoApp("financial"), CRED.financial);
  });
  test("order e analytics NA unidade da allowlist continuam com as próprias credenciais", () => {
    assert.deepEqual(tokenService.credenciaisDoApp("order", { unidadeId: UNI_A }), CRED.order);
    assert.deepEqual(tokenService.credenciaisDoApp("analytics", { unidadeId: UNI_A }), CRED.analytics);
    assert.equal(tokenService.fonteDaCredencial("order", { unidadeId: UNI_A }), "app");
  });
  test("comparação do id normalizada (caixa/espaços)", () => {
    assert.equal(tokenService.credenciaisDoApp("financial", { unidadeId: ` ${UNI_A.toUpperCase()} ` }).origem, "test");
  });
});

describe("fail-closed: unidade da allowlist sem IFOOD_TEST_CLIENT_* -> erro, NUNCA produção", () => {
  for (const [nome, test_] of [["ID ausente", { clientId: null, clientSecret: "x" }], ["SECRET ausente", { clientId: "x", clientSecret: null }], ["ambos ausentes", {}]]) {
    test(`${nome}`, () => {
      definir({ test: test_ });
      assert.throws(() => tokenService.credenciaisDoApp("financial", { unidadeId: UNI_A }),
        (e) => e.codigo === IFOOD_ERROS.IFOOD_APP_SEM_CREDENCIAL && e.details?.origem === "test");
      // outra unidade segue normal
      assert.deepEqual(tokenService.credenciaisDoApp("financial", { unidadeId: UNI_B }), CRED.financial);
    });
  }
  test("userCode NÃO é chamado no iFood quando o TEST falta", async () => {
    definir({ test: {} });
    const h = httpFalso();
    await assert.rejects(() => auth.iniciarConexao({ organizacaoId: "o", unidadeId: UNI_A, appType: "financial", usuarioId: "u", deps: { repo: repoOAuth(UNI_A), http: h } }),
      (e) => e.codigo === IFOOD_ERROS.IFOOD_APP_SEM_CREDENCIAL);
    assert.equal(h.chamadas.length, 0);
  });
});

// ===========================================================================
describe("ciclo OAuth Financial: userCode, troca e refresh com o MESMO app", () => {
  before(() => definir());

  test("unidade A: userCode com app TEST e log só com a origem", async () => {
    const h = httpFalso();
    const { log } = await quieto(() => auth.iniciarConexao({ organizacaoId: "o", unidadeId: UNI_A, appType: "financial", usuarioId: "u", deps: { repo: repoOAuth(UNI_A), http: h } }));
    assert.equal(h.chamadas.length, 1);
    assert.equal(h.chamadas[0].campos.clientId, CRED.test.clientId);
    assert.match(log, /"origemCredencial":"test"/);
    semSegredo(log);
  });

  test("unidade B (controle negativo): userCode com app Financial de produção", async () => {
    const h = httpFalso();
    const { log } = await quieto(() => auth.iniciarConexao({ organizacaoId: "o", unidadeId: UNI_B, appType: "financial", usuarioId: "u", deps: { repo: repoOAuth(UNI_B), http: h } }));
    assert.equal(h.chamadas[0].campos.clientId, CRED.financial.clientId);
    assert.match(log, /"origemCredencial":"producao"/);
  });

  test("troca do authorizationCode usa a unidade da SESSÃO persistida: A -> TEST, B -> produção", async () => {
    for (const [uni, esperado] of [[UNI_A, usouTest], [UNI_B, usouFinProd]]) {
      const h = httpFalso();
      const repo = repoOAuth(uni);
      await quieto(() => auth.concluirAutorizacao({ organizacaoId: "o", unidadeId: uni, appType: "financial", sessaoId: "sess-1", authorizationCode: "COD", usuarioId: "u", deps: { repo, http: h } }));
      const troca = h.chamadas.find((c) => c.rotulo === "oauth.token.authorization_code");
      assert.ok(troca && esperado(troca), `unidade ${uni}`);
      assert.equal(troca.campos.grantType, "authorization_code");
      assert.ok(repo.estado.credencial, "credencial salva");
    }
  });

  test("a troca segue a sessão, não o parâmetro: sessão da unidade A nunca troca com produção", async () => {
    const h = httpFalso();
    // Defesa em profundidade: mesmo que o chamador passasse outra unidade, vale a da sessão persistida.
    await quieto(() => auth.concluirAutorizacao({ organizacaoId: "o", unidadeId: UNI_B, appType: "financial", sessaoId: "sess-1", authorizationCode: "COD", usuarioId: "u", deps: { repo: repoOAuth(UNI_A), http: h } }));
    assert.ok(usouTest(h.chamadas.find((c) => c.rotulo === "oauth.token.authorization_code")));
  });

  test("refresh proativo: unidade da CONEXÃO A -> TEST; B -> produção; log só com a origem", async () => {
    for (const [uni, esperado, origem] of [[UNI_A, usouTest, "test"], [UNI_B, usouFinProd, "app"]]) {
      const h = httpFalso();
      const repo = repoRefresh({ unidadeDaConexao: uni });
      const { r, log } = await quieto(() => tokenService.getValidAccessToken({ conexaoId: `conx-${uni.slice(0, 4)}`, appType: "financial", deps: { repo, http: h } }));
      assert.equal(r, "AT-novo");
      assert.equal(repo.estado.lookups, 1);
      const refresh = h.chamadas.find((c) => c.rotulo === "oauth.token.refresh");
      assert.ok(esperado(refresh), `unidade ${uni}`);
      assert.match(log, new RegExp(`"origemCredencial":"${origem}"`));
      semSegredo(log);
    }
  });

  test("refresh após 401 (comAccessTokenValido): unidade A renova com TEST e repete a chamada", async () => {
    const h = httpFalso();
    const repo = repoRefresh({ unidadeDaConexao: UNI_A });
    repo.estado.cred.expira_em = daquiA(3_600_000); // não vence: o refresh vem do 401
    let n = 0;
    const r = await quieto(() => tokenService.comAccessTokenValido({
      conexaoId: "conx-a", appType: "financial", deps: { repo, http: h },
      fn: async (at) => { n += 1; if (n === 1) throw ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO); return at; },
    }));
    assert.equal(r.r, "AT-novo");
    assert.ok(usouTest(h.chamadas.find((c) => c.rotulo === "oauth.token.refresh")));
  });

  test("sem descobrir a unidade da conexão -> NÃO renova (fail-closed) e NÃO marca reauth", async () => {
    for (const repo of [repoRefresh({ unidadeDaConexao: null }), repoRefresh({ temLookup: false })]) {
      const h = httpFalso();
      await assert.rejects(() => quieto(() => tokenService.getValidAccessToken({ conexaoId: "conx-x", appType: "financial", deps: { repo, http: h } })),
        (e) => e.codigo === IFOOD_ERROS.IFOOD_REFRESH_FALHOU);
      assert.equal(h.chamadas.length, 0, "nenhuma chamada ao iFood");
      assert.equal(repo.estado.atualizacoes.length, 0, "credencial não marcada reauth_required");
    }
  });

  test("allowlist vazia: refresh Financial idêntico ao anterior (sem consultar a unidade, produção)", async () => {
    definir({ financialHomologacaoUnidades: [] });
    const h = httpFalso();
    const repo = repoRefresh({ unidadeDaConexao: UNI_A });
    await quieto(() => tokenService.getValidAccessToken({ conexaoId: "conx-a", appType: "financial", deps: { repo, http: h } }));
    assert.equal(repo.estado.lookups, 0);
    assert.ok(usouFinProd(h.chamadas.find((c) => c.rotulo === "oauth.token.refresh")));
    definir();
  });

  test("refresh de Order/Analytics nunca consulta a unidade nem usa TEST (mesmo na unidade A)", async () => {
    for (const appType of ["order", "analytics"]) {
      const h = httpFalso();
      const repo = repoRefresh({ unidadeDaConexao: UNI_A });
      await quieto(() => tokenService.getValidAccessToken({ conexaoId: "conx-a", appType, deps: { repo, http: h } }));
      assert.equal(repo.estado.lookups, 0, appType);
      assert.equal(h.chamadas.find((c) => c.rotulo === "oauth.token.refresh").campos.clientId, CRED[appType].clientId, appType);
    }
  });
});

// ===========================================================================
describe("Merchant usa o token Financial da conexão (TEST na unidade A), sem header", () => {
  before(() => definir());
  test("credencial vencida da unidade A: renova com TEST e lista as lojas com o token novo", async () => {
    const h = httpFalso();
    const repo = { ...repoRefresh({ unidadeDaConexao: UNI_A }), async obterConexaoViva() { return { id: "conx-a", status: "pendente", merchant_id: null }; } };
    repo.obterCredencial = repoRefresh({ unidadeDaConexao: UNI_A }).obterCredencial;
    const r = await quieto(() => merchantService.listarMerchantsAutorizados({ organizacaoId: "o", unidadeId: UNI_A, deps: { repo, http: h } }));
    assert.equal(r.r.total, 1);
    assert.ok(usouTest(h.chamadas.find((c) => c.rotulo === "oauth.token.refresh")));
    const lista = h.chamadas.find((c) => String(c.caminho).includes("/merchants?"));
    assert.equal(lista.accessToken, "AT-novo");
    assert.notEqual(lista.homologacao, true);
  });
});

// ===========================================================================
describe("IFOOD_HOMOLOGATION_MODE (global, legado) preservado", () => {
  test("ligado: financial, analytics e order usam TEST em qualquer unidade", () => {
    definir({ homologacao: true });
    for (const appType of ["financial", "analytics", "order"]) {
      for (const unidadeId of [UNI_A, UNI_B, undefined]) {
        assert.deepEqual(tokenService.credenciaisDoApp(appType, { unidadeId }), { ...CRED.test, origem: "test" }, `${appType}/${unidadeId}`);
      }
    }
    definir();
  });
});

// ===========================================================================
describe("rota POST /oauth/start: só req.tenant decide (body/query não alteram)", async () => {
  const fromOriginal = supabase.from;
  const fetchOriginal = globalThis.fetch;
  let tenantAtual = { organizacaoId: "org-1", unidadeId: UNI_B };
  const enviados = [];
  before(() => definir());
  supabase.from = () => {
    const q = {
      insert: (linha) => { q._linha = linha; return q; }, select: () => q, eq: () => q, lt: () => q, update: () => q, in: () => q,
      single: async () => ({ data: { id: "sess-r", ...(q._linha ?? {}) }, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (ok, err) => Promise.resolve({ data: [], error: null }).then(ok, err),
    };
    return q;
  };
  globalThis.fetch = async (url, init) => {
    enviados.push({ url: String(url), corpo: String(init.body ?? "") });
    return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ userCode: "WXYZ-9999", authorizationCodeVerifier: "v", expiresIn: 600 }) };
  };
  const app = express();
  app.use(express.json());
  app.use("/api/v1", (req, _res, next) => {
    req.user = { id: "u-1" };
    req.acesso = { papel: "unit_manager", permissoes: permissoesDoPapel("unit_manager"), modulos: [MODULOS.IFOOD], impersonando: false };
    req.tenant = { ...tenantAtual };
    next();
  }, requireModulo(MODULOS.IFOOD), ifoodRouter);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  after(() => { server.close(); supabase.from = fromOriginal; globalThis.fetch = fetchOriginal; });
  const post = (url, corpo) => new Promise((resolve, reject) => {
    const dados = JSON.stringify(corpo);
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method: "POST", path: url, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(dados), "x-unidade-id": UNI_A } }, (res) => {
      let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, corpo: b }));
    });
    req.on("error", reject); req.write(dados); req.end();
  });

  test("tenant B pedindo unidadeId A no body, na query e em header -> userCode com app de PRODUÇÃO", async () => {
    tenantAtual = { organizacaoId: "org-1", unidadeId: UNI_B };
    const { r } = await quieto(() => post(`/api/v1/oauth/start?unidadeId=${UNI_A}`, { appType: "financial", unidadeId: UNI_A }));
    assert.equal(r.status, 201, r.corpo);
    const userCode = enviados.at(-1);
    assert.ok(userCode.url.includes("/oauth/userCode"));
    assert.match(userCode.corpo, new RegExp(`clientId=${CRED.financial.clientId}`));
    assert.doesNotMatch(userCode.corpo, new RegExp(CRED.test.clientId));
    semSegredo(r.corpo);
  });

  test("controle positivo: tenant A -> userCode com app TEST", async () => {
    tenantAtual = { organizacaoId: "org-1", unidadeId: UNI_A };
    const { r } = await quieto(() => post("/api/v1/oauth/start", { appType: "financial" }));
    assert.equal(r.status, 201, r.corpo);
    assert.match(enviados.at(-1).corpo, new RegExp(`clientId=${CRED.test.clientId}`));
  });
});
