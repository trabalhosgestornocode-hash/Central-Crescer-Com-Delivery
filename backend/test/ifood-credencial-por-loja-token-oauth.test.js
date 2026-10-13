// Credenciais INDEPENDENTES por loja (migration 118) — TOKEN e OAuth, sem rede e sem banco.
//
// Token: a credencial PRÓPRIA da loja é outra credencial (leitura, refresh, single-flight, reauth e retry de 401 isolados da conexão);
// o refresh grava de forma CONDICIONAL (uma credencial mais nova nunca é sobrescrita). OAuth da Saladas: grava só na credencial dela,
// valida merchant_scope e módulos, nunca toca a credencial nem a conexão da Sanduíches e não habilita a loja no polling.
// Detalhes/ações/handshake usam o token do merchant. Tokens JWT sintéticos (não assinados); iFood simulado.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const UNIDADE = "00000000-0000-0000-0000-0000000000a1";
const OUTRA_UNIDADE = "00000000-0000-0000-0000-0000000000b1";
const ORG = "00000000-0000-0000-0000-0000000000f1";
process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_ORDER_PILOT_UNITS = UNIDADE;
process.env.IFOOD_ORDER_CLIENT_ID = "order-client-id-de-teste";
process.env.IFOOD_ORDER_CLIENT_SECRET = "order-client-secret-de-teste";
process.env.IFOOD_HOMOLOGATION_MODE = "false";
process.env.IFOOD_CENTRALIZED_TEST_MODE = "false";

const token = await import("../src/modules/ifood/ifoodToken.service.js");
const authSvc = await import("../src/modules/ifood/ifoodAuth.service.js");
const httpClient = await import("../src/modules/ifood/ifoodHttp.client.js");
const { IFOOD_ERROS } = await import("../src/modules/ifood/ifood.errors.js");
const { cifrar, decifrar } = await import("../src/shared/cripto.js");

const SAND = "a6e54f00-1111-4111-8111-0000000039b9";
const SALADAS = "04a17bf5-b9e6-4693-a862-a5715e9f9374";
const agora = Date.now();
const daquiA = (ms) => new Date(Date.now() + ms).toISOString();
const ERRO = (codigo) => (e) => e?.codigo === codigo;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = ({ scope, expEmMs = 6 * 3600_000 } = {}) => `${b64({ alg: "RS256" })}.${b64({ ...(scope ? { merchant_scope: scope } : {}), exp: Math.floor((agora + expEmMs) / 1000) })}.assinatura-falsa`;
const escopo = (...ids) => ids.flatMap((id) => [`${id}:order`, `${id}:events`]);

// ---------------------------------------------------------------------------
// Repositório em memória: UMA credencial por titular (conexão ou loja), com a mesma semântica do repositório real.
function repoFalso({ conexao, lojas = {} } = {}) {
  const creds = new Map();                         // chave -> credencial
  const chave = ({ conexaoId, lojaId }) => (lojaId ? `loja:${lojaId}` : `conexao:${conexaoId}`);
  const chamadas = [];
  if (conexao) creds.set(`conexao:${conexao.id}`, conexao.cred);
  for (const [id, c] of Object.entries(lojas)) creds.set(`loja:${id}`, c);
  return {
    creds, chamadas,
    async obterCredencial(a) { chamadas.push(["obter", chave(a)]); const c = creds.get(chave(a)); return c ? { ...c } : null; },
    async salvarCredencial(a) {
      chamadas.push(["salvar", chave(a)]);
      const antes = creds.get(chave(a)) ?? {};
      const nova = { ...antes, access_token_cifrado: a.accessTokenCifrado, expira_em: a.expiraEm, status: "ativa", ...(a.refreshTokenCifrado !== undefined ? { refresh_token_cifrado: a.refreshTokenCifrado } : {}) };
      creds.set(chave(a), nova);
      return nova;
    },
    async atualizarCredencial(a) {
      chamadas.push(["atualizar", chave(a), a.campos]);
      const c = creds.get(chave(a));
      if (!c) return null;
      if (a.seAccessCifradoIgual !== undefined && c.access_token_cifrado !== a.seAccessCifradoIgual) return null;
      const nova = { ...c, ...a.campos };
      creds.set(chave(a), nova);
      return nova;
    },
  };
}
const cred = ({ at = "AT-velho", rt = "RT-velho", expiraEmMs = 60_000, status = "ativa" } = {}) =>
  ({ access_token_cifrado: cifrar(at), refresh_token_cifrado: cifrar(rt), expira_em: daquiA(expiraEmMs), status });

function resposta(status, corpo) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) }, text: async () => (corpo === undefined ? "" : JSON.stringify(corpo)) };
}
function httpComFetch(fn) {
  const chamadas = [];
  const fetchImpl = async (url, init) => { chamadas.push({ url, corpo: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null }); return fn(url, init, chamadas.length); };
  return { chamadas, postForm: (c, campos, o) => httpClient.postForm(c, campos, { ...(o ?? {}), fetchImpl }), getJson: (c, o) => httpClient.getJson(c, { ...o, fetchImpl }) };
}
const OK_ROTACAO = { accessToken: "AT-novo", refreshToken: "RT-novo", type: "bearer", expiresIn: 21600 };
const quieto = async (fn) => { const o = { ...console }; for (const k of ["log", "warn", "error", "info"]) console[k] = () => {}; try { return await fn(); } finally { Object.assign(console, o); } };

// ===========================================================================
describe("token por loja", () => {
  test("com `lojaId` lê a credencial DA LOJA; sem `lojaId`, a da conexão — nunca uma pela outra", async () => {
    const repo = repoFalso({ conexao: { id: "c1", cred: cred({ at: "AT-sand", expiraEmMs: 3_600_000 }) }, lojas: { L1: cred({ at: "AT-sal", expiraEmMs: 3_600_000 }) } });
    assert.equal(await token.getValidAccessToken({ conexaoId: "c1", appType: "order", deps: { repo } }), "AT-sand");
    assert.equal(await token.getValidAccessToken({ conexaoId: "c1", lojaId: "L1", appType: "order", deps: { repo } }), "AT-sal");
  });

  test("loja SEM credencial própria: IFOOD_CREDENCIAL_NAO_ENCONTRADA — não cai para a credencial da conexão", async () => {
    const repo = repoFalso({ conexao: { id: "c1", cred: cred({ expiraEmMs: 3_600_000 }) } });
    await assert.rejects(token.getValidAccessToken({ conexaoId: "c1", lojaId: "L9", appType: "order", deps: { repo } }), ERRO("IFOOD_CREDENCIAL_NAO_ENCONTRADA"));
  });

  test("`reauth_required` na loja é só DELA: a conexão (Sanduíches) segue válida", async () => {
    const repo = repoFalso({ conexao: { id: "c1", cred: cred({ at: "AT-sand", expiraEmMs: 3_600_000 }) }, lojas: { L1: cred({ status: "reauth_required" }) } });
    await assert.rejects(token.getValidAccessToken({ conexaoId: "c1", lojaId: "L1", appType: "order", deps: { repo } }), ERRO("IFOOD_REFRESH_FALHOU"));
    assert.equal(await token.getValidAccessToken({ conexaoId: "c1", appType: "order", deps: { repo } }), "AT-sand");
  });

  test("refresh da loja inválido (400): marca reauth SÓ na credencial da loja; a da conexão não é tocada", async () => {
    const repo = repoFalso({ conexao: { id: "c1", cred: cred({ at: "AT-sand", expiraEmMs: 3_600_000 }) }, lojas: { L1: cred({ at: "AT-sal" }) } });
    const http = httpComFetch(() => resposta(400, { error: { code: "invalid_grant" } }));
    await quieto(() => assert.rejects(token.getValidAccessToken({ conexaoId: "c1", lojaId: "L1", appType: "order", deps: { repo, http } }), ERRO("IFOOD_REFRESH_FALHOU")));
    assert.equal(repo.creds.get("loja:L1").status, "reauth_required");
    assert.equal(repo.creds.get("conexao:c1").status, "ativa");
    assert.equal(decifrar(repo.creds.get("conexao:c1").access_token_cifrado), "AT-sand");
  });

  test("falha passageira (429) no refresh da loja: NÃO marca reauth em lugar nenhum", async () => {
    const repo = repoFalso({ lojas: { L1: cred() } });
    const http = httpComFetch(() => resposta(429, {}));
    await quieto(() => assert.rejects(token.getValidAccessToken({ conexaoId: "c1", lojaId: "L1", appType: "order", deps: { repo, http } })));
    assert.equal(repo.creds.get("loja:L1").status, "ativa");
  });

  test("renovação da loja grava na credencial DA LOJA (condicional) e deixa a da conexão intacta", async () => {
    const repo = repoFalso({ conexao: { id: "c1", cred: cred({ at: "AT-sand", expiraEmMs: 3_600_000 }) }, lojas: { L1: cred({ at: "AT-sal" }) } });
    const http = httpComFetch(() => resposta(200, OK_ROTACAO));
    assert.equal(await quieto(() => token.getValidAccessToken({ conexaoId: "c1", lojaId: "L1", appType: "order", deps: { repo, http } })), "AT-novo");
    assert.equal(decifrar(repo.creds.get("loja:L1").access_token_cifrado), "AT-novo");
    assert.equal(decifrar(repo.creds.get("loja:L1").refresh_token_cifrado), "RT-novo");
    assert.equal(decifrar(repo.creds.get("conexao:c1").access_token_cifrado), "AT-sand");
    assert.ok(repo.chamadas.filter((c) => c[0] === "atualizar").every((c) => c[1] === "loja:L1"), "nenhuma gravação na conexão");
    assert.ok(!repo.chamadas.some((c) => c[0] === "salvar"), "a renovação é condicional (sem upsert cego)");
  });

  test("refresh CONCORRENTE: uma credencial mais nova entrou durante a renovação -> NÃO é sobrescrita, devolve a mais nova", async () => {
    const repo = repoFalso({ conexao: { id: "c1", cred: cred({ at: "AT-velho" }) } });
    const http = httpComFetch(() => {
      // outra instância (ou uma nova autorização) grava o par novo enquanto a nossa chamada está em voo e a nossa resposta chega com sucesso
      repo.creds.set("conexao:c1", cred({ at: "AT-do-outro", rt: "RT-do-outro", expiraEmMs: 6 * 3_600_000 }));
      return resposta(200, OK_ROTACAO);
    });
    const r = await quieto(() => token.getValidAccessToken({ conexaoId: "c1", appType: "order", deps: { repo, http } }));
    assert.equal(r, "AT-do-outro");
    assert.equal(decifrar(repo.creds.get("conexao:c1").access_token_cifrado), "AT-do-outro");
    assert.equal(decifrar(repo.creds.get("conexao:c1").refresh_token_cifrado), "RT-do-outro");
  });

  test("single-flight: 5 renovações simultâneas da MESMA loja -> 1 POST; a loja e a conexão não compartilham a chave", async () => {
    const repo = repoFalso({ conexao: { id: "c1", cred: cred({ at: "AT-sand" }) }, lojas: { L1: cred({ at: "AT-sal" }) } });
    let liberar; const trava = new Promise((r) => { liberar = r; });
    const http = httpComFetch(async () => { await trava; return resposta(200, OK_ROTACAO); });
    const ps = [
      ...Array.from({ length: 5 }, () => token.getValidAccessToken({ conexaoId: "c1", lojaId: "L1", appType: "order", deps: { repo, http } })),
      token.getValidAccessToken({ conexaoId: "c1", appType: "order", deps: { repo, http } }),
    ];
    await new Promise((r) => setTimeout(r, 20));
    liberar();
    await quieto(() => Promise.all(ps));
    assert.equal(http.chamadas.length, 2, "uma renovação por titular (loja, conexão)");
  });

  test("comAccessTokenValido repassa `lojaId`; 401 -> renova a credencial DA LOJA e repete UMA vez", async () => {
    const repo = repoFalso({ lojas: { L1: cred({ at: "AT-sal", expiraEmMs: 3_600_000 }) } });
    const http = httpComFetch(() => resposta(200, OK_ROTACAO));
    const usados = [];
    const r = await quieto(() => token.comAccessTokenValido({
      conexaoId: "c1", lojaId: "L1", appType: "order", deps: { repo, http },
      fn: async (t) => { usados.push(t); if (t === "AT-sal") throw (await import("../src/modules/ifood/ifood.errors.js")).ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO); return "ok"; },
    }));
    assert.equal(r, "ok");
    assert.deepEqual(usados, ["AT-sal", "AT-novo"]);
    assert.equal(decifrar(repo.creds.get("loja:L1").access_token_cifrado), "AT-novo");
  });
});

// ===========================================================================
// OAuth direcionado à loja
// ===========================================================================
describe("OAuth da Saladas (loja-alvo), simulado", () => {
  function amb({ tokenNovo, credSand = jwt({ scope: escopo(SAND) }), credLoja = null, lojaEstado = "pendente", conexaoViva = true, lojaDeOutraUnidade = false } = {}) {
    const e = { sessao: null, salvos: [], atualizacoes: [], conexaoCriada: false, fechamentos: [], posts: 0, tentouGravarConexao: false };
    const conexao = { id: "con-1", organizacao_id: ORG, unidade_id: UNIDADE, status: "ativa", merchant_id: SAND };
    const loja = { id: "loja-1", conexao_id: "con-1", organizacao_id: ORG, unidade_id: UNIDADE, merchant_id: SALADAS, estado: lojaEstado };
    const credSandRow = { access_token_cifrado: cifrar(credSand), refresh_token_cifrado: cifrar("RT-sand"), status: "ativa" };
    const credLojaRow = credLoja ? { access_token_cifrado: cifrar(credLoja), refresh_token_cifrado: cifrar("RT-sal"), status: "ativa" } : null;
    const repo = {
      async expirarSessoesVencidas() {},
      async obterLojaAdicionalDaUnidade({ merchantId, lojaId }) {
        if (lojaDeOutraUnidade) return null;
        return (merchantId ?? "").toLowerCase() === SALADAS || lojaId === "loja-1" ? loja : null;
      },
      async criarSessaoOAuth(d) { e.sessao = { id: "sess-1", status: "pending", unidade_id: d.unidadeId, organizacao_id: d.organizacaoId, app_type: d.appType, loja_id: d.lojaId ?? null, authorization_code_verifier_cifrado: d.verifierCifrado, expira_em: d.expiraEm }; return e.sessao; },
      async obterSessaoOAuth() { return e.sessao; },
      async reivindicarSessaoOAuth() { return true; },
      async fecharSessaoOAuth({ status }) { e.fechamentos.push(status); e.sessao.status = status; },
      async obterConexaoViva() { return conexaoViva ? conexao : null; },
      async obterOuCriarConexao() { e.conexaoCriada = true; return conexao; },
      async obterCredencial({ lojaId }) { return lojaId ? credLojaRow : credSandRow; },
      async listarLojasExtrasVivasDaConexao() { return []; },
      async atualizarCredencial(a) { e.atualizacoes.push({ lojaId: a.lojaId ?? null, conexao: !a.lojaId }); return { ok: true }; },
    };
    const http = { async postForm() { e.posts += 1; return { userCode: "ABCD-EFGH", authorizationCodeVerifier: "v", verificationUrl: "u", verificationUrlComplete: "uc", expiresIn: 600 }; } };
    const tk = {
      ...token,
      async trocarAuthorizationCodePorToken() { return { accessToken: tokenNovo, refreshToken: "RT-novo", expiraEm: daquiA(6 * 3_600_000), tokenType: "Bearer" }; },
      async salvarTokens(a) { e.salvos.push({ lojaId: a.lojaId ?? null, conexaoId: a.conexaoId }); },
    };
    return { e, deps: { repo, http, token: tk } };
  }
  const iniciar = (a, extra = {}) => authSvc.iniciarConexao({ organizacaoId: ORG, unidadeId: UNIDADE, appType: "order", usuarioId: "u", deps: a.deps, ...extra });
  const concluir = (a, sessionId) => authSvc.concluirAutorizacao({ organizacaoId: ORG, unidadeId: UNIDADE, appType: "order", sessaoId: sessionId, authorizationCode: "codigo-do-portal", usuarioId: "u", deps: a.deps });

  test("início com `merchantId` da Saladas: a sessão guarda a loja-alvo; o estado da loja NÃO muda", async () => {
    const a = amb({ tokenNovo: jwt({ scope: escopo(SALADAS) }) });
    const ini = await iniciar(a, { merchantId: SALADAS.toUpperCase() });
    assert.equal(a.e.sessao.loja_id, "loja-1");
    assert.equal(ini.appType, "order");
    assert.ok(!("verifier" in ini) && !JSON.stringify(ini).includes("authorization_code_verifier"));
  });

  test("conclusão: token com a Saladas -> grava SÓ na credencial da loja; a conexão e a credencial da Sanduíches ficam intactas; a loja continua `pendente`", async () => {
    const a = amb({ tokenNovo: jwt({ scope: escopo(SALADAS) }) });
    const ini = await iniciar(a, { merchantId: SALADAS });
    const r = await concluir(a, ini.sessionId);
    assert.deepEqual(r, { appType: "order", status: "authorized", conexaoStatus: "ativa", lojaAlvo: true });
    assert.deepEqual(a.e.salvos, [{ lojaId: "loja-1", conexaoId: "con-1" }]);
    assert.equal(a.e.atualizacoes.length, 0);
    assert.equal(a.e.conexaoCriada, false, "o OAuth da loja nunca cria nem altera a conexão");
    assert.equal(a.e.sessao.status, "authorized");
  });

  test("token SÓ com a Sanduíches (sem a Saladas): RECUSA, nada gravado, sessão `failed`", async () => {
    const a = amb({ tokenNovo: jwt({ scope: escopo(SAND) }) });
    const ini = await iniciar(a, { merchantId: SALADAS });
    await assert.rejects(concluir(a, ini.sessionId), ERRO("IFOOD_CREDENCIAL_SEM_COBERTURA"));
    assert.equal(a.e.salvos.length + a.e.atualizacoes.length, 0);
    assert.equal(a.e.sessao.status, "failed");
  });

  test("token sem merchant_scope válido (opaco, sem escopo, módulo faltando, vencido): RECUSA", async () => {
    for (const tokenNovo of ["token-opaco", jwt(), jwt({ scope: [`${SALADAS}:order`] }), jwt({ scope: escopo(SALADAS), expEmMs: 5_000 })]) {
      const a = amb({ tokenNovo });
      const ini = await iniciar(a, { merchantId: SALADAS });
      await assert.rejects(concluir(a, ini.sessionId), ERRO("IFOOD_CREDENCIAL_SEM_COBERTURA"));
      assert.equal(a.e.salvos.length + a.e.atualizacoes.length, 0);
    }
  });

  test("token com as DUAS lojas serve (a Saladas está declarada); ainda grava só na credencial dela", async () => {
    const a = amb({ tokenNovo: jwt({ scope: escopo(SAND, SALADAS) }) });
    const ini = await iniciar(a, { merchantId: SALADAS });
    await concluir(a, ini.sessionId);
    assert.deepEqual(a.e.salvos, [{ lojaId: "loja-1", conexaoId: "con-1" }]);
  });

  test("reautorização da loja (credencial própria já existe): troca CONDICIONAL na credencial da loja, nunca na da conexão", async () => {
    const a = amb({ tokenNovo: jwt({ scope: escopo(SALADAS) }), credLoja: jwt({ scope: escopo(SALADAS) }) });
    const ini = await iniciar(a, { merchantId: SALADAS });
    await concluir(a, ini.sessionId);
    assert.deepEqual(a.e.atualizacoes, [{ lojaId: "loja-1", conexao: false }]);
    assert.equal(a.e.salvos.length, 0);
  });

  test("loja inexistente / de outra unidade: recusa ANTES de chamar o iFood (nenhum userCode gerado)", async () => {
    const a = amb({ tokenNovo: jwt({ scope: escopo(SALADAS) }), lojaDeOutraUnidade: true });
    await assert.rejects(iniciar(a, { merchantId: SALADAS }), ERRO("IFOOD_LOJA_NAO_ENCONTRADA"));
    assert.equal(a.e.posts, 0);
    assert.equal(a.e.sessao, null);
  });

  test("`merchantId` só vale para o app Order", async () => {
    const a = amb({ tokenNovo: jwt() });
    await assert.rejects(authSvc.iniciarConexao({ organizacaoId: ORG, unidadeId: UNIDADE, appType: "financial", usuarioId: "u", merchantId: SALADAS, deps: a.deps }), (e) => ["IFOOD_LOJA_OAUTH_INVALIDO", "IFOOD_APP_TYPE_INVALIDO"].includes(e?.codigo));
    assert.equal(a.e.posts, 0);
  });

  test("conexão da unidade inexistente na conclusão: recusa sem criar conexão e sem gravar", async () => {
    const a = amb({ tokenNovo: jwt({ scope: escopo(SALADAS) }), conexaoViva: false });
    const ini = await iniciar(a, { merchantId: SALADAS });
    await assert.rejects(concluir(a, ini.sessionId), ERRO("IFOOD_CONEXAO_NAO_ENCONTRADA"));
    assert.equal(a.e.conexaoCriada, false);
    assert.equal(a.e.salvos.length, 0);
    assert.equal(a.e.sessao.status, "failed");
  });

  test("sem `merchantId` (fluxo da conexão) continua protegido: token só da Saladas NÃO substitui a credencial da Sanduíches (PR #43)", async () => {
    const a = amb({ tokenNovo: jwt({ scope: escopo(SALADAS) }) });
    const ini = await iniciar(a);
    assert.equal(a.e.sessao.loja_id, null);
    await assert.rejects(concluir(a, ini.sessionId), ERRO("IFOOD_CREDENCIAL_SEM_COBERTURA"));
    assert.equal(a.e.atualizacoes.length + a.e.salvos.length, 0);
  });

  test("logs e erros do OAuth da loja não carregam token, refresh nem merchant inteiro", async () => {
    const linhas = [];
    const orig = { ...console };
    for (const k of ["log", "warn", "info", "error"]) console[k] = (...x) => linhas.push(x.map((y) => (typeof y === "string" ? y : JSON.stringify(y))).join(" "));
    const novo = jwt({ scope: escopo(SAND) });
    let msg = "";
    try { const a = amb({ tokenNovo: novo }); const ini = await iniciar(a, { merchantId: SALADAS }); await concluir(a, ini.sessionId); } catch (e) { msg = JSON.stringify({ m: e.message, d: e.detalhes ?? null }); } finally { Object.assign(console, orig); }
    const tudo = linhas.join("\n") + msg;
    assert.ok(msg.length > 0);
    for (const segredo of [novo, "RT-novo", "assinatura-falsa", SALADAS, SAND]) assert.ok(!tudo.includes(segredo), "vazou dado sensível");
  });
});

// ===========================================================================
// Pedidos: detalhes, ações e handshake usam o token do MERCHANT
// ===========================================================================
describe("pedidos: o token certo para cada merchant", () => {
  test("detalhes: pedido da Saladas (credencial própria) usa o token da loja; o da Sanduíches, o da conexão", async () => {
    const { buscarEPersistirDetalhes } = await import("../src/modules/ifood/ifoodOrder.service.js");
    const chamadas = [];
    const tk = { async comAccessTokenValido({ conexaoId, lojaId, fn }) { chamadas.push({ conexaoId, lojaId: lojaId ?? null }); return fn("tok"); } };
    const client = { async buscarDetalhesPedido() { throw Object.assign(new Error("parar aqui"), { codigo: "IFOOD_PEDIDO_NAO_ENCONTRADO" }); } };
    const repo = { async atualizarPedido() { return true; } };
    const pedido = { id: "p1", order_id: "o1", organizacao_id: ORG, unidade_id: UNIDADE, merchant_id: SALADAS };
    await buscarEPersistirDetalhes({ pedido, conexaoId: "con-1", lojaId: "loja-1", repo, token: tk, client, http: {}, log: () => {} }).catch(() => {});
    await buscarEPersistirDetalhes({ pedido, conexaoId: "con-1", repo, token: tk, client, http: {}, log: () => {} }).catch(() => {});
    assert.deepEqual(chamadas, [{ conexaoId: "con-1", lojaId: "loja-1" }, { conexaoId: "con-1", lojaId: null }]);
  });

  test("ações (motivos de cancelamento): `lojaId` da conexão resolvida chega ao token", async () => {
    const { listarMotivosCancelamento } = await import("../src/modules/ifood/ifoodOrderActions.service.js");
    const chamadas = [];
    const tk = { async comAccessTokenValido({ conexaoId, lojaId, fn }) { chamadas.push({ conexaoId, lojaId: lojaId ?? null }); return fn("tok"); } };
    const client = { async listarMotivosCancelamento() { return []; } };
    const mk = (conexao) => ({ async obterPedidoDoTenant() { return { merchant_id: SALADAS }; }, async obterConexaoAtivaDoMerchant() { return conexao; } });
    await listarMotivosCancelamento({ organizacaoId: ORG, unidadeId: UNIDADE, orderId: "o1", repo: mk({ id: "con-1", lojaId: "loja-1" }), token: tk, client, http: {} });
    await listarMotivosCancelamento({ organizacaoId: ORG, unidadeId: UNIDADE, orderId: "o2", repo: mk({ id: "con-1" }), token: tk, client, http: {} });
    assert.deepEqual(chamadas, [{ conexaoId: "con-1", lojaId: "loja-1" }, { conexaoId: "con-1", lojaId: null }]);
  });
});
