// iFood — PROTEÇÃO DA CREDENCIAL ORDER ATIVA no OAuth multi-loja.
//
// Sem rede, sem banco, sem OAuth real: tokens JWT SINTÉTICOS (não assinados, `merchant_scope` montado no teste), repositório em memória e
// troca de código simulada. Prova que uma nova autorização NUNCA substitui a credencial que funciona (Sanduíches) por um token que não
// comprova cobrir as mesmas lojas, e que nada vaza token nos logs.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const UNIDADE = "00000000-0000-0000-0000-0000000000a1";
const ORG = "00000000-0000-0000-0000-0000000000f1";
process.env.IFOOD_ORDER_PILOT_UNITS = UNIDADE;
process.env.IFOOD_ORDER_CLIENT_ID = "order-client-id-de-teste";
process.env.IFOOD_ORDER_CLIENT_SECRET = "order-client-secret-de-teste";
process.env.IFOOD_TOKEN_SECRET = "segredo-de-teste-com-mais-de-16-caracteres";

const { cifrar, decifrar } = await import("../src/shared/cripto.js");
const authSvc = await import("../src/modules/ifood/ifoodAuth.service.js");
const tokenReal = await import("../src/modules/ifood/ifoodToken.service.js");
const { escopoDoAccessToken, coberturaDoToken, mascararMerchant } = await import("../src/modules/ifood/ifoodTokenEscopo.js");

const SAND = "a6e54f00-1111-4111-8111-0000000039b9";
const SALADAS = "04a17bf5-b9e6-4693-a862-a5715e9f9374";
const OUTRA = "bbbbbbbb-2222-4222-8222-00000000000b";
const agora = Date.now();

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** JWT sintético (assinatura falsa): só o payload importa para a leitura da claim. */
const jwt = ({ scope, expEmMs = 6 * 3600_000, extra = {} } = {}) =>
  `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ ...(scope ? { merchant_scope: scope } : {}), exp: Math.floor((agora + expEmMs) / 1000), iat: Math.floor(agora / 1000), ...extra })}.assinatura-falsa`;
const escopo = (...ids) => ids.flatMap((id) => [`${id}:order`, `${id}:events`]);
const ERRO = (codigo) => (e) => e?.codigo === codigo;

// ---------------------------------------------------------------------------
describe("leitura do escopo do token (pura)", () => {
  test("JWT com merchant_scope: merchants e módulos; sem devolver o token", () => {
    const e = escopoDoAccessToken(jwt({ scope: escopo(SAND) }));
    assert.equal(e.formato, "jwt");
    assert.equal(e.temEscopo, true);
    assert.deepEqual([...e.merchants.get(SAND)].sort(), ["events", "order"]);
    assert.ok(e.expMs > agora);
    assert.ok(!JSON.stringify(e).includes("assinatura-falsa"));
  });
  test("opaco, ausente, payload ilegível e JWT sem escopo", () => {
    assert.equal(escopoDoAccessToken("token-opaco").formato, "opaco");
    assert.equal(escopoDoAccessToken("").formato, "ausente");
    assert.equal(escopoDoAccessToken(null).formato, "ausente");
    assert.equal(escopoDoAccessToken("a.@@@.c").formato, "opaco");
    const semEscopo = escopoDoAccessToken(jwt());
    assert.equal(semEscopo.formato, "jwt");
    assert.equal(semEscopo.temEscopo, false);
  });
  test("entradas fora do formato são ignoradas (nunca inventam cobertura); `merchant_scoped` não é confundido", () => {
    const e = escopoDoAccessToken(jwt({ scope: ["lixo", `${SAND}`, `${SAND}:order`, 7], extra: { merchant_scoped: true } }));
    assert.deepEqual([...e.merchants.keys()], [SAND]);
    assert.deepEqual([...e.merchants.get(SAND)], ["order"]);
  });
  test("mascarar não expõe o id inteiro", () => {
    assert.equal(mascararMerchant(SAND), "a6e54f…39b9");
    assert.equal(mascararMerchant(undefined), "?");
  });
});

describe("prova de cobertura", () => {
  const atual = jwt({ scope: escopo(SAND) });
  test("novo cobre a principal (mesmos módulos): ok", () => {
    assert.equal(coberturaDoToken({ novo: jwt({ scope: escopo(SAND) }), atual, merchantsExigidos: [SAND] }).cobre, true);
  });
  test("novo cobre principal + Saladas: ok e informa a loja nova (mascarada)", () => {
    const r = coberturaDoToken({ novo: jwt({ scope: escopo(SAND, SALADAS) }), atual, merchantsExigidos: [SAND] });
    assert.equal(r.cobre, true);
    assert.deepEqual(r.novasLojas, [mascararMerchant(SALADAS)]);
  });
  test("novo SÓ com a Saladas: não cobre a Sanduíches", () => {
    const r = coberturaDoToken({ novo: jwt({ scope: escopo(SALADAS) }), atual, merchantsExigidos: [SAND] });
    assert.equal(r.cobre, false);
    assert.equal(r.motivo, "faltam_lojas");
    assert.deepEqual(r.faltando.map((f) => f.merchant), [mascararMerchant(SAND)]);
  });
  test("módulo faltando (só order, sem events) não cobre", () => {
    const r = coberturaDoToken({ novo: jwt({ scope: [`${SAND}:order`] }), atual, merchantsExigidos: [SAND] });
    assert.equal(r.cobre, false);
    assert.deepEqual(r.faltando[0].modulos, ["events"]);
  });
  test("token atual ilegível: exige order+events de cada loja exigida", () => {
    assert.equal(coberturaDoToken({ novo: jwt({ scope: [`${SAND}:order`] }), atual: "opaco", merchantsExigidos: [SAND] }).cobre, false);
    assert.equal(coberturaDoToken({ novo: jwt({ scope: escopo(SAND) }), atual: "opaco", merchantsExigidos: [SAND] }).cobre, true);
  });
  test("novo opaco, sem escopo ou vencido: sem prova", () => {
    assert.equal(coberturaDoToken({ novo: "opaco", atual, merchantsExigidos: [SAND] }).motivo, "token_novo_sem_escopo");
    assert.equal(coberturaDoToken({ novo: jwt(), atual, merchantsExigidos: [SAND] }).motivo, "token_novo_sem_escopo");
    assert.equal(coberturaDoToken({ novo: jwt({ scope: escopo(SAND), expEmMs: 10_000 }), atual, merchantsExigidos: [SAND] }).motivo, "token_novo_vencido");
  });
});

// ---------------------------------------------------------------------------
describe("concluirAutorizacao com credencial Order existente (OAuth simulado)", () => {
  /** @param {{tokenAtual?: string|null, extras?: string[]|Error, novo: object, appType?: string, casPerde?: boolean}} o */
  function amb({ tokenAtual = jwt({ scope: escopo(SAND) }), extras = [], novo, appType = "order", casPerde = false }) {
    const e = { sessao: null, gravacoes: [], salvos: [], logs: [], cred: tokenAtual === null ? null : { access_token_cifrado: cifrar(tokenAtual), refresh_token_cifrado: cifrar("refresh-atual"), status: "ativa" } };
    const conexao = { id: "con-1", organizacao_id: ORG, unidade_id: UNIDADE, status: "ativa", merchant_id: SAND };
    const repo = {
      async expirarSessoesVencidas() {},
      async criarSessaoOAuth(d) { e.sessao = { id: "sess-1", status: "pending", unidade_id: d.unidadeId, organizacao_id: d.organizacaoId, app_type: d.appType, authorization_code_verifier_cifrado: d.verifierCifrado, expira_em: d.expiraEm }; return e.sessao; },
      async obterSessaoOAuth() { return e.sessao; },
      async reivindicarSessaoOAuth() { return true; },
      async fecharSessaoOAuth({ status }) { e.sessao.status = status; },
      async obterOuCriarConexao() { return conexao; },
      async obterCredencial() { return e.cred; },
      async listarLojasExtrasVivasDaConexao() { if (extras instanceof Error) throw extras; return extras; },
      async atualizarCredencial(a) {
        if (casPerde || a.seAccessCifradoIgual !== e.cred?.access_token_cifrado) return false;
        e.gravacoes.push(a.campos); e.cred = { ...e.cred, ...a.campos }; return true;
      },
    };
    const http = { async postForm() { return { userCode: "ABCD-EFGH", authorizationCodeVerifier: "v", verificationUrl: "u", verificationUrlComplete: "uc", expiresIn: 600 }; } };
    const token = {
      ...tokenReal,
      async trocarAuthorizationCodePorToken() { return { accessToken: novo, refreshToken: "refresh-novo", expiresIn: 21_600, expiraEm: new Date(agora + 21_600_000).toISOString(), tokenType: "Bearer" }; },
      async salvarTokens(a) { e.salvos.push(a.appType); },
    };
    return { e, deps: { repo, http, token } };
  }
  const rodar = async (a, appType = "order") => {
    const ini = await authSvc.iniciarConexao({ organizacaoId: ORG, unidadeId: UNIDADE, appType, usuarioId: "u", deps: a.deps });
    return authSvc.concluirAutorizacao({ organizacaoId: ORG, unidadeId: UNIDADE, appType, sessaoId: ini.sessionId, authorizationCode: "codigo-do-portal", usuarioId: "u", deps: a.deps });
  };

  test("primeira conexão (sem credencial): grava como antes", async () => {
    const a = amb({ tokenAtual: null, novo: jwt({ scope: escopo(SAND) }) });
    assert.equal((await rodar(a)).status, "authorized");
    assert.deepEqual(a.e.salvos, ["order"]);
    assert.equal(a.e.gravacoes.length, 0);
  });

  test("novo token cobre a Sanduíches: substitui por troca condicional e mantém a sessão `authorized`", async () => {
    const novo = jwt({ scope: escopo(SAND, SALADAS) });
    const a = amb({ novo });
    assert.equal((await rodar(a)).status, "authorized");
    assert.equal(a.e.gravacoes.length, 1);
    assert.equal(decifrar(a.e.cred.access_token_cifrado), novo);
    assert.equal(decifrar(a.e.cred.refresh_token_cifrado), "refresh-novo");
    assert.equal(a.e.sessao.status, "authorized");
  });

  test("novo token só com a Saladas: RECUSA, credencial intacta, sessão `failed`", async () => {
    const atual = jwt({ scope: escopo(SAND) });
    const a = amb({ tokenAtual: atual, novo: jwt({ scope: escopo(SALADAS) }) });
    await assert.rejects(rodar(a), ERRO("IFOOD_CREDENCIAL_SEM_COBERTURA"));
    assert.equal(a.e.gravacoes.length, 0);
    assert.equal(decifrar(a.e.cred.access_token_cifrado), atual);
    assert.equal(decifrar(a.e.cred.refresh_token_cifrado), "refresh-atual");
    assert.equal(a.e.sessao.status, "failed");
  });

  test("novo token opaco ou sem merchant_scope ou vencido: RECUSA", async () => {
    for (const novo of ["token-opaco", jwt(), jwt({ scope: escopo(SAND), expEmMs: 5_000 })]) {
      const a = amb({ novo });
      await assert.rejects(rodar(a), ERRO("IFOOD_CREDENCIAL_SEM_COBERTURA"));
      assert.equal(a.e.gravacoes.length, 0);
    }
  });

  test("lojas adicionais vivas (ativa/liberada) também precisam estar no token novo", async () => {
    const a = amb({ extras: [SALADAS], novo: jwt({ scope: escopo(SAND) }) });
    await assert.rejects(rodar(a), ERRO("IFOOD_CREDENCIAL_SEM_COBERTURA"));
    const b = amb({ extras: [SALADAS], tokenAtual: jwt({ scope: escopo(SAND, SALADAS) }), novo: jwt({ scope: escopo(SAND, SALADAS) }) });
    assert.equal((await rodar(b)).status, "authorized");
  });

  test("falha ao ler as lojas adicionais: RECUSA (falha segura)", async () => {
    const a = amb({ extras: new Error("db fora"), novo: jwt({ scope: escopo(SAND) }) });
    await assert.rejects(rodar(a), ERRO("IFOOD_CREDENCIAL_SEM_COBERTURA"));
    assert.equal(a.e.gravacoes.length, 0);
  });

  test("credencial renovada durante a troca (compare-and-set perdido): RECUSA e não sobrescreve", async () => {
    const a = amb({ casPerde: true, novo: jwt({ scope: escopo(SAND) }) });
    await assert.rejects(rodar(a), ERRO("IFOOD_CREDENCIAL_SEM_COBERTURA"));
    assert.equal(a.e.gravacoes.length, 0);
    assert.equal(a.e.sessao.status, "failed");
  });

  test("token atual ilegível (opaco): exige order+events da principal no novo", async () => {
    const a = amb({ tokenAtual: "opaco-antigo", novo: jwt({ scope: [`${SAND}:order`] }) });
    await assert.rejects(rodar(a), ERRO("IFOOD_CREDENCIAL_SEM_COBERTURA"));
    const b = amb({ tokenAtual: "opaco-antigo", novo: jwt({ scope: escopo(SAND) }) });
    assert.equal((await rodar(b)).status, "authorized");
  });

  test("app Financial não passa pela proteção (comportamento anterior)", async () => {
    const a = amb({ novo: "qualquer" });
    // Financial exige configuração própria; a proteção só se aplica ao app Order: aqui basta provar o desvio por appType.
    const { gravarCredencialComProtecao } = await import("../src/modules/ifood/ifoodCredencialProtecao.js");
    const r = await gravarCredencialComProtecao({ conexao: { id: "con-1", merchant_id: SAND }, appType: "financial", tokens: { accessToken: "x" }, repo: a.deps.repo, token: a.deps.token, organizacaoId: ORG, unidadeId: UNIDADE, sessaoId: "s" });
    assert.deepEqual(r, { substituida: false });
    assert.deepEqual(a.e.salvos, ["financial"]);
    assert.equal(a.e.gravacoes.length, 0);
  });

  test("erro devolvido ao cliente e logs não carregam token, refresh nem merchant inteiro", async () => {
    const linhas = [];
    const orig = { log: console.log, warn: console.warn, info: console.info, error: console.error };
    for (const k of Object.keys(orig)) console[k] = (...x) => linhas.push(x.map((y) => (typeof y === "string" ? y : JSON.stringify(y))).join(" "));
    const novo = jwt({ scope: escopo(SALADAS) });
    let msg = "";
    try { await rodar(amb({ novo })); } catch (e) { msg = JSON.stringify({ m: e.message, d: e.detalhes ?? null }); } finally { Object.assign(console, orig); }
    const tudo = linhas.join("\n") + msg;
    assert.ok(msg.length > 0);
    for (const segredo of [novo, "refresh-novo", "assinatura-falsa", SAND, SALADAS]) assert.ok(!tudo.includes(segredo), "vazou dado sensível");
  });
});
