// Auth Provider iFood — CHECKPOINT A.
//
// Prova que Merchant/Financial/(futuros Events/Order) consomem UMA interface
// (`comAccessTokenValido`) sem saber se o token veio de authorization_code,
// refresh_token ou client_credentials, e que o modo centralizado de teste
// (Teste (C)) é seguro: token só em memória, cache por expiração, sem martelar
// o endpoint de token, sem segredo em log e bloqueado em produção/Render.
//
// Sem rede e sem banco: `http`/`repo` são fakes. O provider distribuído (oficial)
// segue coberto pelos testes já existentes (ifood-token-service.test.js etc.).
//
// Rodar: node --experimental-vm-modules --test test/ifood-auth-provider.test.js
import test from "node:test";
import assert from "node:assert/strict";

import { ifoodErro, IFOOD_ERROS, IfoodError } from "../src/modules/ifood/ifood.errors.js";
import { IFOOD_ROTAS, IFOOD_TOKEN } from "../src/modules/ifood/ifood.constants.js";
import {
  MODOS_AUTH, modoDeAutenticacao, criarProviderCentralizadoTeste,
} from "../src/modules/ifood/ifoodAuthProvider.js";
import * as tokenService from "../src/modules/ifood/ifoodToken.service.js";
import * as merchantService from "../src/modules/ifood/ifoodMerchant.service.js";
import {
  PROJETO_TESTE_REF, PROJETO_PRODUCAO_REF, centralizadoTestePermitido,
} from "../src/modules/ifood/ifood.ambienteTeste.js";
import { config } from "../src/config/env.js";

const SEGREDO = "SEGREDO-CENTRALIZADO-NAO-PODE-VAZAR";
const CLIENT_ID_C = "client-id-teste-c";
const TOKEN_A = "token-A-abcdefghijklmnopqrstuvwxyz";
const TOKEN_B = "token-B-abcdefghijklmnopqrstuvwxyz";

const cfgC = (extra = {}) => ({
  ifood: {
    centralizedTest: { modo: true, clientId: CLIENT_ID_C, clientSecret: SEGREDO },
    // Credenciais do Teste (D) — NUNCA podem ser usadas pelo provider centralizado.
    test: { clientId: "client-id-teste-D", clientSecret: "SEGREDO-D" },
    ...extra,
  },
});
const ENV_OK = { SUPABASE_URL: `https://${PROJETO_TESTE_REF}.supabase.co` };

/** http falso: `postForm` responde conforme `resposta(n)`; `getJson` conforme `lista(token)`. */
function fakeHttp({ resposta = () => ({ accessToken: TOKEN_A, type: "bearer", expiresIn: 21600 }), lista = () => [] } = {}) {
  const posts = [];
  const gets = [];
  return {
    posts, gets,
    async postForm(caminho, campos, opts) {
      posts.push({ caminho, campos, opts });
      const r = await resposta(posts.length);
      if (r instanceof Error) throw r;
      return r;
    },
    async getJson(caminho, opts) {
      gets.push({ caminho, opts });
      return lista(opts.accessToken, caminho);
    },
  };
}

/** relógio controlável */
function relogio(inicio = 1_800_000_000_000) {
  let t = inicio;
  return { agora: () => t, avancarS: (s) => { t += s * 1000; } };
}

function capturarConsole(fn) {
  const linhas = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => linhas.push(a.join(" "));
  console.warn = (...a) => linhas.push(a.join(" "));
  console.error = (...a) => linhas.push(a.join(" "));
  return Promise.resolve(fn()).finally(() => Object.assign(console, orig)).then((r) => ({ r, saida: linhas.join("\n") }));
}

const novo = (opts = {}) => criarProviderCentralizadoTeste({ cfg: cfgC(), env: ENV_OK, ...opts });
const rejeita = async (p, codigo) => assert.rejects(p, (e) => e instanceof IfoodError && e.codigo === codigo, `esperava ${codigo}`);

// ---------------------------------------------------------------------------
test("modo: distribuído é o PADRÃO e o modelo oficial; centralizado só com a flag própria", () => {
  assert.equal(modoDeAutenticacao({ ifood: {} }), MODOS_AUTH.DISTRIBUTED);
  assert.equal(modoDeAutenticacao({ ifood: { centralizedTest: { modo: false } } }), MODOS_AUTH.DISTRIBUTED);
  assert.equal(modoDeAutenticacao({ ifood: { homologacao: true } }), MODOS_AUTH.DISTRIBUTED, "IFOOD_HOMOLOGATION_MODE (Teste D) NÃO liga o centralizado");
  assert.equal(modoDeAutenticacao(cfgC()), MODOS_AUTH.CENTRALIZED_TEST);
  assert.equal(modoDeAutenticacao(undefined), config.ifood.centralizedTest.modo ? MODOS_AUTH.CENTRALIZED_TEST : MODOS_AUTH.DISTRIBUTED);
});

test("config: sem a env própria o centralizado está DESLIGADO por padrão (e é distinto de IFOOD_TEST_*)", () => {
  assert.equal(config.ifood.centralizedTest.modo, false);
  assert.ok("test" in config.ifood && "centralizedTest" in config.ifood);
  assert.notEqual(config.ifood.centralizedTest, config.ifood.test);
});

test("o processo de teste usa o provider DISTRIBUÍDO por padrão e ele cumpre o contrato", () => {
  const p = tokenService.provedorDeAutenticacao();
  assert.equal(p.modo, MODOS_AUTH.DISTRIBUTED);
  assert.equal(p, tokenService.distributedAuthProvider);
  assert.equal(p.escopoDoToken, "conexao");
  assert.equal(typeof p.getAccessToken, "function");
  assert.equal(typeof p.renovarAposRejeicao, "function");
  assert.equal(tokenService.modoDeAutenticacao(), MODOS_AUTH.DISTRIBUTED);
  assert.equal(tokenService.escopoDoToken(), "conexao");
});

// --- token centralizado -------------------------------------------------------
test("client_credentials: POST /oauth/token com grantType/clientId/clientSecret do Teste (C) — nunca do Teste (D)", async () => {
  const http = fakeHttp();
  const p = novo();
  const token = await p.getAccessToken({ deps: { http } });
  assert.equal(token, TOKEN_A);
  assert.equal(http.posts.length, 1);
  assert.equal(http.posts[0].caminho, IFOOD_ROTAS.token);
  assert.deepEqual(http.posts[0].campos, { grantType: "client_credentials", clientId: CLIENT_ID_C, clientSecret: SEGREDO });
  assert.ok(!JSON.stringify(http.posts).includes("client-id-teste-D"));
  assert.ok(!JSON.stringify(http.posts).includes("SEGREDO-D"));
});

test("escopo do token é o APP (não uma conexão/unidade); refresh token não existe nem é lido", () => {
  const p = novo();
  assert.equal(p.escopoDoToken, "app");
  assert.equal(p.modo, MODOS_AUTH.CENTRALIZED_TEST);
  assert.equal("refreshToken" in p, false);
});

test("cache por expiração: várias chamadas = UM pedido de token", async () => {
  const http = fakeHttp();
  const p = novo();
  for (let i = 0; i < 5; i += 1) assert.equal(await p.getAccessToken({ deps: { http } }), TOKEN_A);
  assert.equal(http.posts.length, 1);
});

test("expiração: renova só perto de vencer (margem) — antes disso segue no cache", async () => {
  const rel = relogio();
  const http = fakeHttp({ resposta: (n) => ({ accessToken: n === 1 ? TOKEN_A : TOKEN_B, expiresIn: 21600 }) });
  const p = novo({ agora: rel.agora });
  assert.equal(await p.getAccessToken({ deps: { http } }), TOKEN_A);

  rel.avancarS(21600 - IFOOD_TOKEN.margemRenovacaoMs / 1000 - 60);   // 1 min antes da margem
  assert.equal(await p.getAccessToken({ deps: { http } }), TOKEN_A);
  assert.equal(http.posts.length, 1, "não pode gerar token antes da hora (a doc do iFood avisa contra isso)");

  rel.avancarS(120);                                                  // entrou na margem
  assert.equal(await p.getAccessToken({ deps: { http } }), TOKEN_B);
  assert.equal(http.posts.length, 2);
});

test("sem expiresIn na resposta: usa o padrão de 6 h", async () => {
  const rel = relogio();
  const http = fakeHttp({ resposta: () => ({ accessToken: TOKEN_A }) });
  const p = novo({ agora: rel.agora });
  await p.getAccessToken({ deps: { http } });
  rel.avancarS(IFOOD_TOKEN.expiresInPadraoS - IFOOD_TOKEN.margemRenovacaoMs / 1000 - 1);
  await p.getAccessToken({ deps: { http } });
  assert.equal(http.posts.length, 1);
});

test("concorrência: 10 pedidos simultâneos = UM pedido de token (single-flight)", async () => {
  const http = fakeHttp({ resposta: () => new Promise((r) => setTimeout(() => r({ accessToken: TOKEN_A, expiresIn: 21600 }), 30)) });
  const p = novo();
  const tokens = await Promise.all(Array.from({ length: 10 }, () => p.getAccessToken({ deps: { http } })));
  assert.deepEqual([...new Set(tokens)], [TOKEN_A]);
  assert.equal(http.posts.length, 1);
});

test("falha do pedido de token não fica em cache: o próximo pedido tenta de novo", async () => {
  const http = fakeHttp({ resposta: (n) => (n === 1 ? ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL) : { accessToken: TOKEN_A, expiresIn: 21600 }) });
  const p = novo();
  await rejeita(p.getAccessToken({ deps: { http } }), IFOOD_ERROS.IFOOD_INDISPONIVEL);
  assert.equal(await p.getAccessToken({ deps: { http } }), TOKEN_A);
  assert.equal(http.posts.length, 2);
});

// --- erros ----------------------------------------------------------------------
test("401 no endpoint de token (credencial recusada) -> IFOOD_CENTRALIZADO_FALHOU, sem a mensagem do fluxo distribuído", async () => {
  const http = fakeHttp({ resposta: () => ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO) });
  await assert.rejects(novo().getAccessToken({ deps: { http } }), (e) => {
    assert.equal(e.codigo, IFOOD_ERROS.IFOOD_CENTRALIZADO_FALHOU);
    assert.doesNotMatch(e.message, /código de autorização/i);
    assert.equal(e.details?.causa, IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO);
    return true;
  });
});

test("400 e 403 no endpoint de token também viram IFOOD_CENTRALIZADO_FALHOU", async () => {
  for (const cod of [IFOOD_ERROS.IFOOD_OAUTH_CODIGO_INVALIDO, IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO, IFOOD_ERROS.IFOOD_REQUISICAO_INVALIDA]) {
    const http = fakeHttp({ resposta: () => ifoodErro(cod) });
    await rejeita(novo().getAccessToken({ deps: { http } }), IFOOD_ERROS.IFOOD_CENTRALIZADO_FALHOU);
  }
});

test("429 (rate limit), 5xx e timeout sobem como transitórios (IFOOD_RATE_LIMITED / IFOOD_INDISPONIVEL)", async () => {
  await rejeita(novo().getAccessToken({ deps: { http: fakeHttp({ resposta: () => ifoodErro(IFOOD_ERROS.IFOOD_RATE_LIMITED) }) } }), IFOOD_ERROS.IFOOD_RATE_LIMITED);
  await rejeita(novo().getAccessToken({ deps: { http: fakeHttp({ resposta: () => ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL, { detalhes: { motivo: "timeout" } }) }) } }), IFOOD_ERROS.IFOOD_INDISPONIVEL);
});

test("resposta sem accessToken -> IFOOD_RESPOSTA_INVALIDA; erro inesperado (não-iFood) sobe intacto", async () => {
  await rejeita(novo().getAccessToken({ deps: { http: fakeHttp({ resposta: () => ({ type: "bearer" }) }) } }), IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA);
  await assert.rejects(novo().getAccessToken({ deps: { http: fakeHttp({ resposta: () => new TypeError("boom") }) } }), /boom/);
});

test("sem credenciais do Teste (C): IFOOD_APP_SEM_CREDENCIAL (mesmo que o Teste (D) esteja configurado)", async () => {
  const p = criarProviderCentralizadoTeste({ cfg: { ifood: { centralizedTest: { modo: true }, test: { clientId: "d", clientSecret: "d" } } }, env: ENV_OK });
  await rejeita(p.getAccessToken({ deps: { http: fakeHttp() } }), IFOOD_ERROS.IFOOD_APP_SEM_CREDENCIAL);
});

// --- segredo fora do log --------------------------------------------------------
test("client secret e access token NUNCA aparecem em log (sucesso, 401 e renovação forçada)", async () => {
  const { saida } = await capturarConsole(async () => {
    const http = fakeHttp({ resposta: (n) => (n === 2 ? ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO) : { accessToken: n === 1 ? TOKEN_A : TOKEN_B, expiresIn: 21600 }) });
    const rel = relogio();
    const p = novo({ agora: rel.agora });
    await p.getAccessToken({ deps: { http } });
    rel.avancarS(31);
    await p.renovarAposRejeicao({ deps: { http }, tokenRejeitado: TOKEN_A }).catch(() => {});
  });
  assert.ok(saida.length > 0, "o teste precisa ter capturado algum log");
  for (const proibido of [SEGREDO, TOKEN_A, TOKEN_B, "SEGREDO-D"]) assert.ok(!saida.includes(proibido), `vazou: ${proibido.slice(0, 12)}…`);
});

// --- renovação após 401 -----------------------------------------------------------
test("renovarAposRejeicao: gera UM token novo e o devolve", async () => {
  const rel = relogio();
  const http = fakeHttp({ resposta: (n) => ({ accessToken: n === 1 ? TOKEN_A : TOKEN_B, expiresIn: 21600 }) });
  const p = novo({ agora: rel.agora });
  await p.getAccessToken({ deps: { http } });
  rel.avancarS(60);
  assert.equal(await p.renovarAposRejeicao({ deps: { http }, tokenRejeitado: TOKEN_A }), TOKEN_B);
  assert.equal(http.posts.length, 2);
});

test("renovarAposRejeicao: se outro request já renovou, reaproveita o token novo (sem pedir outro)", async () => {
  const http = fakeHttp({ resposta: (n) => ({ accessToken: n === 1 ? TOKEN_A : TOKEN_B, expiresIn: 21600 }) });
  const rel = relogio();
  const p = novo({ agora: rel.agora });
  await p.getAccessToken({ deps: { http } });
  rel.avancarS(60);
  await p.renovarAposRejeicao({ deps: { http }, tokenRejeitado: TOKEN_A });      // 1ª renovação -> B
  const t = await p.renovarAposRejeicao({ deps: { http }, tokenRejeitado: TOKEN_A }); // o 2º request ainda segurava A
  assert.equal(t, TOKEN_B);
  assert.equal(http.posts.length, 2);
});

test("401 persistente NÃO martela o endpoint de token: renovação forçada tem intervalo mínimo", async () => {
  const rel = relogio();
  const http = fakeHttp({ resposta: (n) => ({ accessToken: `token-${n}-abcdefghijklmnopqrstuvwxyz`, expiresIn: 21600 }) });
  const p = novo({ agora: rel.agora });
  let atual = await p.getAccessToken({ deps: { http } });
  for (let i = 0; i < 10; i += 1) {
    rel.avancarS(1);
    atual = await p.renovarAposRejeicao({ deps: { http }, tokenRejeitado: atual });
  }
  assert.ok(http.posts.length <= 2, `pedidos de token: ${http.posts.length} (esperado: 1 inicial + no máximo 1 forçado em 10 s)`);
});

// --- trava de runtime -------------------------------------------------------------
test("BLOQUEADO em produção/Render: banco de produção, Render, NODE_ENV=production e banco desconhecido", async () => {
  const http = fakeHttp();
  const casos = [
    { SUPABASE_URL: `https://${PROJETO_PRODUCAO_REF}.supabase.co` },
    { ...ENV_OK, RENDER: "true" },
    { ...ENV_OK, NODE_ENV: "production" },
    { SUPABASE_URL: "https://qualquer-outro.supabase.co" },
    { SUPABASE_URL: "" },
    {},
  ];
  for (const env of casos) {
    const p = criarProviderCentralizadoTeste({ cfg: cfgC(), env });
    await rejeita(p.getAccessToken({ deps: { http } }), IFOOD_ERROS.IFOOD_CENTRALIZADO_BLOQUEADO);
    await rejeita(p.renovarAposRejeicao({ deps: { http }, tokenRejeitado: "x" }), IFOOD_ERROS.IFOOD_CENTRALIZADO_BLOQUEADO);
  }
  assert.equal(http.posts.length, 0, "bloqueado NÃO pode nem chegar a pedir token ao iFood");
});

test("centralizadoTestePermitido: só com banco de teste, fora do Render e sem NODE_ENV=production", () => {
  assert.equal(centralizadoTestePermitido(ENV_OK).ok, true);
  assert.equal(centralizadoTestePermitido({ ...ENV_OK, NODE_ENV: "development" }).ok, true);
  const r = centralizadoTestePermitido({ SUPABASE_URL: `https://${PROJETO_PRODUCAO_REF}.supabase.co`, RENDER: "true", NODE_ENV: "production" });
  assert.equal(r.ok, false);
  assert.equal(r.motivos.length, 3);
});

// --- a INTERFACE COMUM: comAccessTokenValido ----------------------------------------
test("comAccessTokenValido usa o provider e entrega o token à API de negócio (que não sabe o modo)", async () => {
  const http = fakeHttp();
  const provider = novo();
  const visto = [];
  const r = await tokenService.comAccessTokenValido({
    conexaoId: null, appType: "financial", deps: { http, provider },
    fn: async (t) => { visto.push(t); return "ok"; },
  });
  assert.equal(r, "ok");
  assert.deepEqual(visto, [TOKEN_A]);
});

test("401 da API de negócio: renova UMA vez e repete UMA vez (sem loop)", async () => {
  const rel = relogio();
  const http = fakeHttp({ resposta: (n) => ({ accessToken: n === 1 ? TOKEN_A : TOKEN_B, expiresIn: 21600 }) });
  const provider = novo({ agora: rel.agora });
  const usados = [];
  const r = await tokenService.comAccessTokenValido({
    conexaoId: null, appType: "financial", deps: { http, provider },
    fn: async (t) => { usados.push(t); if (t === TOKEN_A) throw ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO); return "recuperou"; },
  });
  assert.equal(r, "recuperou");
  assert.deepEqual(usados, [TOKEN_A, TOKEN_B]);
});

test("401 persistente: 2 tentativas no total e o erro sobe (nunca loop infinito)", async () => {
  const rel = relogio();
  const http = fakeHttp({ resposta: (n) => ({ accessToken: n === 1 ? TOKEN_A : TOKEN_B, expiresIn: 21600 }) });
  const provider = novo({ agora: rel.agora });
  let tentativas = 0;
  await rejeita(tokenService.comAccessTokenValido({
    conexaoId: null, appType: "financial", deps: { http, provider },
    fn: async () => { tentativas += 1; throw ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO); },
  }), IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO);
  assert.equal(tentativas, 2);
});

test("erros que não são 401 (429, 5xx, 403) NÃO disparam renovação de token", async () => {
  for (const cod of [IFOOD_ERROS.IFOOD_RATE_LIMITED, IFOOD_ERROS.IFOOD_INDISPONIVEL, IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO]) {
    const http = fakeHttp();
    const provider = novo();
    await rejeita(tokenService.comAccessTokenValido({
      conexaoId: null, appType: "financial", deps: { http, provider },
      fn: async () => { throw ifoodErro(cod); },
    }), cod);
    assert.equal(http.posts.length, 1, `${cod} não pode gerar 2º token`);
  }
});

// --- Merchant sobre a interface comum -------------------------------------------------
const MERCHANT_SANDBOX = { id: "11111111-2222-3333-4444-555555555555", name: "Loja Sandbox iFood", corporateName: "Sandbox LTDA", type: "RESTAURANT", status: "AVAILABLE" };

function depsMerchantCentralizado(http, provider) {
  const repoQueNaoDeveSerUsado = new Proxy({}, { get: (_, k) => () => { throw new Error(`repo.${String(k)} não deveria ser chamado no modo centralizado`); } });
  const token = {
    // o Merchant só vê a interface comum (+ a pergunta "o token é do app ou da conexão?")
    comAccessTokenValido: (p) => tokenService.comAccessTokenValido({ ...p, deps: { ...p.deps, provider } }),
    escopoDoToken: () => provider.escopoDoToken,
  };
  return { repo: repoQueNaoDeveSerUsado, http, token };
}

test("Merchant no modo centralizado: GET /merchants com o token do app, SEM conexão por unidade, e cache entre chamadas", async () => {
  const http = fakeHttp({ lista: () => [MERCHANT_SANDBOX] });
  const provider = novo();
  const deps = depsMerchantCentralizado(http, provider);

  const a = await merchantService.listarMerchantsAutorizados({ organizacaoId: null, unidadeId: null, deps });
  const b = await merchantService.listarMerchantsAutorizados({ organizacaoId: null, unidadeId: null, deps });

  assert.equal(a.total, 1);
  assert.equal(a.merchants[0].id, MERCHANT_SANDBOX.id);
  assert.equal(a.merchants[0].nome, "Loja Sandbox iFood");
  assert.deepEqual(b, a);
  assert.equal(http.posts.length, 1, "duas descobertas = um único token");
  assert.ok(http.gets.every((g) => g.opts.accessToken === TOKEN_A), "GET /merchants usa o token do provider");
  assert.ok(http.gets[0].caminho.startsWith("/merchant/v1.0/merchants"));
});

test("Merchant no modo distribuído continua exigindo a conexão da unidade (comportamento oficial inalterado)", async () => {
  const repo = { obterConexaoViva: async () => null };
  const token = { comAccessTokenValido: async () => { throw new Error("não deveria chegar aqui"); }, escopoDoToken: () => "conexao" };
  await assert.rejects(
    merchantService.listarMerchantsAutorizados({ organizacaoId: "o", unidadeId: "u", deps: { repo, http: fakeHttp(), token } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_CONEXAO_NAO_ENCONTRADA,
  );
});

test("Merchant: descoberta de UM merchant (validação) também dispensa conexão no modo centralizado", async () => {
  const http = fakeHttp({ lista: () => MERCHANT_SANDBOX });
  const d = await merchantService.validarMerchant({
    organizacaoId: null, unidadeId: null, merchantId: MERCHANT_SANDBOX.id, deps: depsMerchantCentralizado(http, novo()),
  });
  assert.equal(d.id, MERCHANT_SANDBOX.id);
  assert.equal(d.nome, "Loja Sandbox iFood");
});

test("Merchant + 401 no GET /merchants: renova o token do app UMA vez e conclui", async () => {
  const rel = relogio();
  let n = 0;
  const http = fakeHttp({
    resposta: (i) => ({ accessToken: i === 1 ? TOKEN_A : TOKEN_B, expiresIn: 21600 }),
    lista: (t) => { n += 1; if (t === TOKEN_A) throw ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO); return [MERCHANT_SANDBOX]; },
  });
  const r = await merchantService.listarMerchantsAutorizados({
    organizacaoId: null, unidadeId: null, deps: depsMerchantCentralizado(http, novo({ agora: rel.agora })),
  });
  assert.equal(r.total, 1);
  assert.equal(n, 2);
  assert.equal(http.posts.length, 2);
});
