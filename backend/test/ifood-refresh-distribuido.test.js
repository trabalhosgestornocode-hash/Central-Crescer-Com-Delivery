// Refresh token DISTRIBUÍDO — renovação, rotação, ausência de refresh novo,
// concorrência (mesmo processo e entre processos), erros HTTP reais (http client
// real sobre fetch falso), compare-and-set do reauth, repositório real com
// supabase falso. Zero rede real, zero banco.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-client-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-client-secret-NUNCA-LOGAR";
process.env.IFOOD_HOMOLOGATION_MODE = "false";
process.env.IFOOD_CENTRALIZED_TEST_MODE = "false";

const token = await import("../src/modules/ifood/ifoodToken.service.js");
const httpClient = await import("../src/modules/ifood/ifoodHttp.client.js");
const repositorio = await import("../src/modules/ifood/ifood.repository.js");
const connection = await import("../src/modules/ifood/ifoodConnection.service.js");
const { IFOOD_ERROS } = await import("../src/modules/ifood/ifood.errors.js");
const { cifrar, decifrar } = await import("../src/shared/cripto.js");
const { supabase } = await import("../src/config/supabase.js");

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const daquiA = (ms) => new Date(Date.now() + ms).toISOString();
const SEGREDOS = ["AT-velho", "RT-velho", "AT-novo", "RT-novo", "fin-client-secret-NUNCA-LOGAR"];

function cred({ at = "AT-velho", rt = "RT-velho", expiraEmMs = 60_000, status = "ativa" } = {}) {
  return { access_token_cifrado: cifrar(at), refresh_token_cifrado: rt === null ? null : cifrar(rt), expira_em: daquiA(expiraEmMs), status };
}

/** Repo em memória por conexão; `salvarCredencial` imita o repositório REAL (refresh undefined = preserva). */
function repoFalso(inicial = { "conx-A": cred() }) {
  const creds = { ...inicial };
  const chamadas = [];
  return {
    creds, chamadas,
    async obterCredencial({ conexaoId }) { chamadas.push(["obter", conexaoId]); return creds[conexaoId] ? { ...creds[conexaoId] } : null; },
    async salvarCredencial(a) {
      chamadas.push(["salvar", a.conexaoId, a]);
      const antes = creds[a.conexaoId] ?? {};
      creds[a.conexaoId] = {
        ...antes, access_token_cifrado: a.accessTokenCifrado, expira_em: a.expiraEm, status: "ativa",
        ...(a.refreshTokenCifrado !== undefined ? { refresh_token_cifrado: a.refreshTokenCifrado } : {}),
      };
      return creds[a.conexaoId];
    },
    async atualizarCredencial({ conexaoId, campos, seAccessCifradoIgual }) {
      chamadas.push(["atualizar", conexaoId, { campos, seAccessCifradoIgual }]);
      const c = creds[conexaoId];
      if (!c) return null;
      if (seAccessCifradoIgual !== undefined && c.access_token_cifrado !== seAccessCifradoIgual) return null;
      creds[conexaoId] = { ...c, ...campos };
      return creds[conexaoId];
    },
  };
}

function resposta(status, corpo) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) }, text: async () => (corpo === undefined ? "" : JSON.stringify(corpo)) };
}
/** http REAL (ifoodHttp.client) sobre um fetch falso. Registra método, url e corpo do form. */
function httpComFetch(fn) {
  const chamadas = [];
  const fetchImpl = async (url, init) => {
    chamadas.push({ url, metodo: init.method, corpo: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null, headers: init.headers });
    return fn(url, init, chamadas.length);
  };
  return {
    chamadas,
    postForm: (c, campos, o) => httpClient.postForm(c, campos, { ...(o ?? {}), fetchImpl }),
    getJson: (c, o) => httpClient.getJson(c, { ...o, fetchImpl }),
  };
}
const OK_ROTACAO = { accessToken: "AT-novo", refreshToken: "RT-novo", type: "bearer", expiresIn: 21600 };
const OK_SEM_REFRESH = { accessToken: "AT-novo", type: "bearer", expiresIn: 10800 };

function capturarLog() {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const linhas = [];
  for (const k of Object.keys(orig)) console[k] = (...a) => linhas.push(a.map(String).join(" "));
  return { linhas, restaurar: () => Object.assign(console, orig) };
}
async function logado(fn) { const c = capturarLog(); try { return { r: await fn().catch((e) => e), log: c.linhas.join("\n") }; } finally { c.restaurar(); } }

const renovar = (repo, http, conexaoId = "conx-A") => token.getValidAccessToken({ conexaoId, appType: "financial", deps: { repo, http } });
const forcar = (repo, http, conexaoId = "conx-A") => token.distributedAuthProvider.renovarAposRejeicao({ conexaoId, appType: "financial", deps: { repo, http } });

// ---------------------------------------------------------------------------
describe("renovação", () => {
  test("[1][4][5] refresh válido: POST /oauth/token com grantType=refresh_token + clientId + clientSecret + refreshToken; grava access e refresh NOVOS cifrados", async () => {
    const repo = repoFalso();
    const http = httpComFetch(() => resposta(200, OK_ROTACAO));
    const { r } = await logado(() => renovar(repo, http));
    assert.equal(r, "AT-novo");
    const [c] = http.chamadas;
    assert.equal(http.chamadas.length, 1);
    assert.equal(c.metodo, "POST");
    assert.equal(c.url, "https://mock.ifood.test/authentication/v1.0/oauth/token");
    assert.deepEqual(Object.keys(c.corpo).sort(), ["clientId", "clientSecret", "grantType", "refreshToken"]);
    assert.equal(c.corpo.grantType, "refresh_token");
    assert.equal(c.corpo.refreshToken, "RT-velho");
    assert.equal(c.headers["Content-Type"], "application/x-www-form-urlencoded");
    const gravada = repo.creds["conx-A"];
    assert.equal(decifrar(gravada.access_token_cifrado), "AT-novo");
    assert.equal(decifrar(gravada.refresh_token_cifrado), "RT-novo");
    assert.ok(!JSON.stringify(gravada).includes("AT-novo") && !JSON.stringify(gravada).includes("RT-novo"), "nada em claro no banco");
  });

  test("[6] SEM refresh novo na resposta: o refresh anterior é PRESERVADO (não vira null)", async () => {
    const repo = repoFalso();
    await logado(() => renovar(repo, httpComFetch(() => resposta(200, OK_SEM_REFRESH))));
    const [, , args] = repo.chamadas.find((c) => c[0] === "salvar");
    assert.equal(args.refreshTokenCifrado, undefined, "salvarTokens não manda refresh quando o iFood não devolve");
    assert.equal(decifrar(repo.creds["conx-A"].refresh_token_cifrado), "RT-velho");
  });

  test("[7] expiresIn da resposta define expira_em (sem tempo fixo)", async () => {
    const repo = repoFalso();
    const antes = Date.now();
    await logado(() => renovar(repo, httpComFetch(() => resposta(200, OK_SEM_REFRESH))));
    const ms = Date.parse(repo.creds["conx-A"].expira_em) - antes;
    assert.ok(ms > 10_790_000 && ms < 10_810_000, `expira_em deveria ser ~3h (10800s), veio ${ms}ms`);
  });

  test("token ainda válido (fora da margem de 10 min): getValidAccessToken NÃO renova", async () => {
    const repo = repoFalso({ "conx-A": cred({ expiraEmMs: 3_600_000 }) });
    const http = httpComFetch(() => resposta(200, OK_ROTACAO));
    assert.equal(await renovar(repo, http), "AT-velho");
    assert.equal(http.chamadas.length, 0);
  });

  test("renovação ANTECIPADA explícita (renovarAposRejeicao) com token ainda válido: renova e grava", async () => {
    const repo = repoFalso({ "conx-A": cred({ expiraEmMs: 3_600_000 }) });
    const { r } = await logado(() => forcar(repo, httpComFetch(() => resposta(200, OK_ROTACAO))));
    assert.equal(r, "AT-novo");
    assert.equal(decifrar(repo.creds["conx-A"].access_token_cifrado), "AT-novo");
  });
});

// ---------------------------------------------------------------------------
describe("falhas: definitivas marcam reauth (com compare-and-set); passageiras NÃO", () => {
  test("[2] refresh token ausente -> IFOOD_REFRESH_FALHOU, nenhuma chamada ao iFood, reauth_required", async () => {
    const repo = repoFalso({ "conx-A": cred({ rt: null }) });
    const http = httpComFetch(() => resposta(200, OK_ROTACAO));
    const { r } = await logado(() => renovar(repo, http));
    assert.equal(r.codigo, IFOOD_ERROS.IFOOD_REFRESH_FALHOU);
    assert.equal(http.chamadas.length, 0);
    assert.equal(repo.creds["conx-A"].status, "reauth_required");
  });

  for (const [nome, status] of [["[3][8] inválido (400)", 400], ["[9] expirado/revogado (401)", 401], ["[10] 403", 403]]) {
    test(`${nome} -> IFOOD_REFRESH_FALHOU, 1 chamada só, reauth_required via compare-and-set`, async () => {
      const repo = repoFalso();
      const http = httpComFetch(() => resposta(status, { error: { code: "X", message: "m" } }));
      const { r } = await logado(() => renovar(repo, http));
      assert.equal(r.codigo, IFOOD_ERROS.IFOOD_REFRESH_FALHOU);
      assert.equal(http.chamadas.length, 1);
      assert.equal(repo.creds["conx-A"].status, "reauth_required");
      const atualizar = repo.chamadas.find((c) => c[0] === "atualizar")[2];
      assert.ok(atualizar.seAccessCifradoIgual, "marca reauth só se ninguém gravou credencial nova");
    });
  }

  for (const [nome, fn] of [
    ["[11] 429", () => resposta(429, {})],
    ["[12] 500", () => resposta(500, {})],
    ["[13] timeout", () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; }],
  ]) {
    test(`${nome}: erro passageiro -> NÃO marca reauth_required e NÃO repete o refresh (semRetry)`, async () => {
      const repo = repoFalso();
      const http = httpComFetch(fn);
      const { r } = await logado(() => renovar(repo, http));
      assert.equal(r.codigo, IFOOD_ERROS.IFOOD_REFRESH_FALHOU);
      assert.equal(http.chamadas.length, 1, "um refresh que pode ter rotacionado nunca é repetido às cegas");
      assert.equal(repo.creds["conx-A"].status, "ativa");
      assert.ok(!repo.chamadas.some((c) => c[0] === "atualizar"));
    });
  }
});

// ---------------------------------------------------------------------------
describe("[17] concorrência", () => {
  test("mesmo processo: 5 renovações simultâneas da mesma credencial -> 1 POST, todas recebem o mesmo token", async () => {
    const repo = repoFalso();
    let liberar;
    const trava = new Promise((r) => { liberar = r; });
    const http = httpComFetch(async () => { await trava; return resposta(200, OK_ROTACAO); });
    const c = capturarLog();
    try {
      const ps = Array.from({ length: 5 }, () => renovar(repo, http));
      await new Promise((r) => setTimeout(r, 20));
      liberar();
      const rs = await Promise.all(ps);
      assert.deepEqual(rs, Array(5).fill("AT-novo"));
    } finally { c.restaurar(); }
    assert.equal(http.chamadas.length, 1);
    assert.equal(repo.chamadas.filter((x) => x[0] === "salvar").length, 1);
  });

  test("entre processos: o outro renovou antes (iFood rotacionou) -> nosso refresh falha, mas usamos a credencial nova e NÃO marcamos reauth", async () => {
    const repo = repoFalso();
    const http = httpComFetch(() => {
      // outro processo grava o par novo enquanto nossa chamada está em voo
      repo.creds["conx-A"] = { ...repo.creds["conx-A"], access_token_cifrado: cifrar("AT-do-outro"), refresh_token_cifrado: cifrar("RT-do-outro"), expira_em: daquiA(6 * 3_600_000), status: "ativa" };
      return resposta(400, { error: { code: "invalid_grant" } });
    });
    const { r } = await logado(() => renovar(repo, http));
    assert.equal(r, "AT-do-outro");
    assert.equal(repo.creds["conx-A"].status, "ativa");
    assert.equal(decifrar(repo.creds["conx-A"].refresh_token_cifrado), "RT-do-outro");
  });

  test("entre processos: nossa falha chega ANTES do outro gravar -> compare-and-set marca reauth, e o upsert do outro volta a 'ativa'", async () => {
    const repo = repoFalso();
    const { r } = await logado(() => renovar(repo, httpComFetch(() => resposta(400, {}))));
    assert.equal(r.codigo, IFOOD_ERROS.IFOOD_REFRESH_FALHOU);
    assert.equal(repo.creds["conx-A"].status, "reauth_required");
    await repo.salvarCredencial({ conexaoId: "conx-A", accessTokenCifrado: cifrar("AT-do-outro"), refreshTokenCifrado: cifrar("RT-do-outro"), expiraEm: daquiA(3_600_000) });
    assert.equal(repo.creds["conx-A"].status, "ativa");
  });

  test("[16][18] credenciais de unidades diferentes não compartilham single-flight nem refresh token", async () => {
    const repo = repoFalso({ "conx-A": cred({ rt: "RT-A" }), "conx-B": cred({ rt: "RT-B" }) });
    const http = httpComFetch((url, init) => resposta(200, { accessToken: `AT-de-${new URLSearchParams(init.body).get("refreshToken")}`, expiresIn: 21600 }));
    const c = capturarLog();
    let rs;
    try { rs = await Promise.all([renovar(repo, http, "conx-A"), renovar(repo, http, "conx-B")]); } finally { c.restaurar(); }
    assert.deepEqual(rs, ["AT-de-RT-A", "AT-de-RT-B"]);
    assert.equal(http.chamadas.length, 2);
    assert.equal(decifrar(repo.creds["conx-A"].access_token_cifrado), "AT-de-RT-A");
    assert.equal(decifrar(repo.creds["conx-B"].access_token_cifrado), "AT-de-RT-B");
  });
});

// ---------------------------------------------------------------------------
describe("[19] repositório REAL (supabase falso): atômico, preserva refresh, compare-and-set", () => {
  function comSupabaseFalso(fn) {
    const original = supabase.from;
    const ops = [];
    supabase.from = (tabela) => {
      const op = { tabela, filtros: [] };
      ops.push(op);
      const q = {
        upsert: (linha, opts) => { op.tipo = "upsert"; op.linha = linha; op.opts = opts; return q; },
        update: (campos) => { op.tipo = "update"; op.linha = campos; return q; },
        eq: (col, v) => { op.filtros.push([col, v]); return q; },
        select: () => q,
        single: async () => ({ data: op.linha, error: null }),
        maybeSingle: async () => ({ data: op.linha, error: null }),
      };
      return q;
    };
    return Promise.resolve(fn(ops)).finally(() => { supabase.from = original; });
  }

  test("salvarCredencial: UM upsert com access + expira_em + status juntos; refresh novo incluído quando existe", () => comSupabaseFalso(async (ops) => {
    await repositorio.salvarCredencial({ conexaoId: "c", appType: "financial", accessTokenCifrado: "AC", refreshTokenCifrado: "RC", expiraEm: "2026-09-30T00:00:00Z", tokenType: "bearer" });
    assert.equal(ops.length, 1);
    assert.equal(ops[0].tipo, "upsert");
    assert.deepEqual(ops[0].opts, { onConflict: "conexao_id,app_type" });
    assert.equal(ops[0].linha.access_token_cifrado, "AC");
    assert.equal(ops[0].linha.refresh_token_cifrado, "RC");
    assert.equal(ops[0].linha.status, "ativa");
  }));

  test("salvarCredencial SEM refresh novo: a coluna refresh_token_cifrado fica FORA do payload (nunca null)", () => comSupabaseFalso(async (ops) => {
    await repositorio.salvarCredencial({ conexaoId: "c", appType: "financial", accessTokenCifrado: "AC", refreshTokenCifrado: undefined, expiraEm: "2026-09-30T00:00:00Z" });
    assert.equal("refresh_token_cifrado" in ops[0].linha, false);
  }));

  test("atualizarCredencial com seAccessCifradoIgual filtra também pelo access gravado (compare-and-set)", () => comSupabaseFalso(async (ops) => {
    await repositorio.atualizarCredencial({ conexaoId: "c", appType: "financial", campos: { status: "reauth_required" }, seAccessCifradoIgual: "AC-lido" });
    assert.deepEqual(ops[0].filtros, [["conexao_id", "c"], ["app_type", "financial"], ["access_token_cifrado", "AC-lido"]]);
  }));
});

// ---------------------------------------------------------------------------
describe("segurança e ausência de rotina automática", () => {
  test("[14] nenhum token/secret em log: sucesso, rotação, falha definitiva e passageira", async () => {
    const logs = [];
    for (const fn of [() => resposta(200, OK_ROTACAO), () => resposta(200, OK_SEM_REFRESH), () => resposta(400, { error: { message: "RT-velho inválido" } }), () => resposta(500, {})]) {
      const { log } = await logado(() => renovar(repoFalso(), httpComFetch(fn)));
      logs.push(log);
    }
    const tudo = logs.join("\n");
    assert.match(tudo, /token\.renovado/);
    for (const s of SEGREDOS) assert.ok(!tudo.includes(s), `vazou no log: ${s}`);
  });

  test("[15] status para o frontend não carrega token (só status/expiraEm por app)", async () => {
    const repo = {
      async obterConexaoViva() { return { id: "conx-A", status: "ativa", merchant_id: "55c8f464-e65f-4340-b2c7-62d143027040", merchant_nome: "Loja" }; },
      async listarCredenciaisDaConexao() { return [{ app_type: "financial", status: "ativa", expira_em: daquiA(3_600_000), access_token_cifrado: cifrar("AT-novo"), refresh_token_cifrado: cifrar("RT-novo") }]; },
    };
    const s = await connection.obterStatus({ organizacaoId: "o", unidadeId: "u", deps: { repo } });
    const txt = JSON.stringify(s);
    assert.doesNotMatch(txt, /token|cifrad/i);
    for (const x of SEGREDOS) assert.ok(!txt.includes(x));
  });

  test("[20] nenhuma rotina automática de refresh: nenhum setInterval/cron chama renovação no src", () => {
    const dir = path.join(AQUI, "../src");
    const arquivos = [];
    const andar = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) andar(p); else if (p.endsWith(".js")) arquivos.push(p); } };
    andar(dir);
    for (const a of arquivos) {
      const src = readFileSync(a, "utf8");
      if (!/renovar|getValidAccessToken|refresh_token|REFRESH_TOKEN/.test(src)) continue;
      assert.doesNotMatch(src, /setInterval\s*\(|cron\.schedule|node-cron/, `rotina automática suspeita em ${path.relative(dir, a)}`);
    }
  });
});
