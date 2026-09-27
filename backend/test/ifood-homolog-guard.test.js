// Trava do ambiente de homologação iFood (backend/scripts/ifoodHomologGuard.mjs)
// e do comando `npm run dev:ifood-homolog`.
//
// Garante que nenhuma credencial Supabase de PRODUÇÃO consiga entrar no modo
// homologação — nem por SUPABASE_URL, nem por chave trocada, nem por mistura
// parcial de arquivos. Sem rede real: a prova ativa usa fetch falso.
//
// Rodar: node --test test/ifood-homolog-guard.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROJETO_TESTE_REF, PROJETO_PRODUCAO_REF,
  refDoJwt, ehChaveFormatoNovo, validarAmbienteHomologIfood, provarChavesNoProjetoTeste,
} from "../scripts/ifoodHomologGuard.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (ref) => `${b64({ alg: "HS256" })}.${b64({ ref, role: "anon" })}.assinatura`;

// Valores FALSOS, formato realista. Nenhum segredo de verdade.
const ANON_NOVA = "sb_publishable_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1";
const SERVICE_NOVA = "sb_secret_FAKEFAKEFAKEFAKEFAKEFAKEFAKE1";
const envOk = (extra = {}) => ({
  SUPABASE_URL: `https://${PROJETO_TESTE_REF}.supabase.co`,
  SUPABASE_ANON_KEY: ANON_NOVA,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_NOVA,
  IFOOD_HOMOLOGATION_MODE: "true",
  IFOOD_TEST_CLIENT_ID: "cid-fake",
  IFOOD_TEST_CLIENT_SECRET: "csecret-fake",
  IFOOD_TOKEN_SECRET: "segredo-de-teste-com-mais-de-16",
  ...extra,
});

describe("validação estática", () => {
  test("ambiente de TESTE completo passa (chaves no formato novo pedem prova ativa)", () => {
    const r = validarAmbienteHomologIfood(envOk());
    assert.equal(r.ok, true, r.erros.join("; "));
    assert.deepEqual(r.provaAtivaNecessaria, ["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);
    assert.equal(r.resumo.supabaseRef, PROJETO_TESTE_REF);
  });

  test("SUPABASE_URL de PRODUÇÃO é recusada", () => {
    const r = validarAmbienteHomologIfood(envOk({ SUPABASE_URL: `https://${PROJETO_PRODUCAO_REF}.supabase.co` }));
    assert.equal(r.ok, false);
    assert.match(r.erros.join(" "), /PRODUÇÃO/);
  });

  test("URL de qualquer outro projeto/host também é recusada", () => {
    for (const url of ["https://outroprojeto123.supabase.co", "http://localhost:54321", "https://evil.example.com", "", "lixo"]) {
      assert.equal(validarAmbienteHomologIfood(envOk({ SUPABASE_URL: url })).ok, false, url);
    }
  });

  test("MISTURA: URL de teste + JWT (anon/service) de PRODUÇÃO é recusada", () => {
    for (const chave of ["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
      const r = validarAmbienteHomologIfood(envOk({ [chave]: jwt(PROJETO_PRODUCAO_REF) }));
      assert.equal(r.ok, false, chave);
      assert.match(r.erros.join(" "), new RegExp(`${chave} pertence ao projeto de PRODUÇÃO`));
    }
  });

  test("JWT de teste passa sem prova ativa; JWT de terceiro projeto é recusado", () => {
    const ok = validarAmbienteHomologIfood(envOk({ SUPABASE_ANON_KEY: jwt(PROJETO_TESTE_REF), SUPABASE_SERVICE_ROLE_KEY: jwt(PROJETO_TESTE_REF) }));
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.provaAtivaNecessaria, []);
    const ruim = validarAmbienteHomologIfood(envOk({ SUPABASE_ANON_KEY: jwt("terceiroprojeto") }));
    assert.equal(ruim.ok, false);
  });

  test("chave em formato desconhecido ou ausente é recusada", () => {
    assert.equal(validarAmbienteHomologIfood(envOk({ SUPABASE_ANON_KEY: "abc123" })).ok, false);
    assert.equal(validarAmbienteHomologIfood(envOk({ SUPABASE_SERVICE_ROLE_KEY: "" })).ok, false);
    const { SUPABASE_ANON_KEY, ...semAnon } = envOk();
    assert.equal(validarAmbienteHomologIfood(semAnon).ok, false);
  });

  test("homologação: exige MODE exato 'true', app de teste e IFOOD_TOKEN_SECRET (>=16)", () => {
    assert.equal(validarAmbienteHomologIfood(envOk({ IFOOD_HOMOLOGATION_MODE: "1" })).ok, false);
    assert.equal(validarAmbienteHomologIfood(envOk({ IFOOD_HOMOLOGATION_MODE: undefined })).ok, false);
    assert.equal(validarAmbienteHomologIfood(envOk({ IFOOD_TEST_CLIENT_ID: "" })).ok, false);
    assert.equal(validarAmbienteHomologIfood(envOk({ IFOOD_TEST_CLIENT_SECRET: "" })).ok, false);
    assert.equal(validarAmbienteHomologIfood(envOk({ IFOOD_TOKEN_SECRET: "curta" })).ok, false);
    assert.equal(validarAmbienteHomologIfood(envOk({ IFOOD_TOKEN_SECRET: undefined })).ok, false);
  });

  test("IFOOD_API_BASE_URL só pode ser o host oficial (não envia credenciais a outro host)", () => {
    assert.equal(validarAmbienteHomologIfood(envOk({ IFOOD_API_BASE_URL: "https://merchant-api.ifood.com.br" })).ok, true);
    assert.equal(validarAmbienteHomologIfood(envOk({ IFOOD_API_BASE_URL: "https://evil.example.com" })).ok, false);
  });

  test("as mensagens de erro NUNCA contêm valores secretos", () => {
    const env = envOk({
      SUPABASE_URL: `https://${PROJETO_PRODUCAO_REF}.supabase.co`,
      SUPABASE_ANON_KEY: "sb_publishable_SEGREDOANON_PROD_XXXXXXXXXXXXXXX",
      IFOOD_TEST_CLIENT_SECRET: "",
      IFOOD_TOKEN_SECRET: "curta",
    });
    const saida = JSON.stringify(validarAmbienteHomologIfood(env));
    for (const segredo of ["SEGREDOANON_PROD", SERVICE_NOVA, "curta"]) assert.ok(!saida.includes(segredo), segredo);
  });

  test("helpers: refDoJwt e ehChaveFormatoNovo", () => {
    assert.equal(refDoJwt(jwt("abc")), "abc");
    assert.equal(refDoJwt("nao-e-jwt"), null);
    assert.equal(refDoJwt(undefined), null);
    assert.equal(ehChaveFormatoNovo("sb_secret_x"), true);
    assert.equal(ehChaveFormatoNovo("eyJhbGciOi..."), false);
  });
});

describe("prova ativa (somente leitura, fetch falso)", () => {
  const resp = (status) => async () => ({ status });

  test("HTTP 200 nas duas sondas comprova o projeto", async () => {
    const chamadas = [];
    const f = async (url, opts) => { chamadas.push({ url, opts }); return { status: 200 }; };
    const erros = await provarChavesNoProjetoTeste(envOk(), ["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"], f);
    assert.deepEqual(erros, []);
    assert.equal(chamadas.length, 2);
    for (const c of chamadas) {
      assert.equal(c.opts.method, "GET", "sondas são somente leitura");
      assert.equal(c.opts.body, undefined);
      assert.ok(c.url.startsWith(`https://${PROJETO_TESTE_REF}.supabase.co/`), "só fala com o projeto de TESTE");
    }
  });

  test("chave de outro projeto (401/403) é REJEITADA", async () => {
    for (const status of [401, 403, 404, 500]) {
      const erros = await provarChavesNoProjetoTeste(envOk(), ["SUPABASE_ANON_KEY"], resp(status));
      assert.equal(erros.length, 1, `HTTP ${status}`);
      assert.match(erros[0], /REJEITADA/);
    }
  });

  test("erro de rede/timeout REPROVA (não presume que está tudo bem)", async () => {
    const erros = await provarChavesNoProjetoTeste(envOk(), ["SUPABASE_SERVICE_ROLE_KEY"], async () => { throw new Error("ECONNREFUSED"); });
    assert.equal(erros.length, 1);
    assert.match(erros[0], /não foi possível comprovar/);
  });

  test("a mensagem de rejeição não vaza a chave", async () => {
    const erros = await provarChavesNoProjetoTeste(envOk(), ["SUPABASE_ANON_KEY"], resp(401));
    assert.ok(!erros.join(" ").includes(ANON_NOVA));
  });
});

describe("comando npm run dev:ifood-homolog", () => {
  const pkg = JSON.parse(readFileSync(path.join(AQUI, "../package.json"), "utf8"));
  const cmd = pkg.scripts["dev:ifood-homolog"];

  test("existe e usa SOMENTE .env.test-integracao + .env.ifood-homolog, nesta ordem", () => {
    assert.ok(cmd, "script dev:ifood-homolog ausente");
    const arquivos = [...cmd.matchAll(/--env-file=(\S+)/g)].map((m) => m[1]);
    assert.deepEqual(arquivos, [".env.test-integracao", ".env.ifood-homolog"]);
  });

  test("NÃO carrega o .env de produção (nem sob outro nome)", () => {
    assert.doesNotMatch(cmd, /--env-file=\.env(\s|$)/);
    assert.doesNotMatch(cmd, /--env-file=\S*producao/i);
  });

  test("passa pela trava antes de subir o servidor", () => {
    assert.match(cmd, /scripts\/dev-ifood-homolog\.mjs/);
    assert.doesNotMatch(cmd, /src\/server\.js/, "o comando não pode iniciar o servidor sem passar pela trava");
    const script = readFileSync(path.join(AQUI, "../scripts/dev-ifood-homolog.mjs"), "utf8");
    const iValida = script.indexOf("validarAmbienteHomologIfood(process.env)");
    const iProva = script.indexOf("provarChavesNoProjetoTeste(process.env");
    const iServer = script.indexOf('import("../src/server.js")');
    assert.ok(iValida > -1 && iProva > iValida && iServer > iProva, "ordem: validar -> provar -> importar o servidor");
    assert.match(script, /process\.exit\(1\)/);
  });

  test("os scripts de produção (dev/start) continuam intocados", () => {
    assert.equal(pkg.scripts.dev, "node --watch --env-file=.env src/server.js");
    assert.equal(pkg.scripts.start, "node src/server.js");
  });

  test("os arquivos de ambiente reais são ignorados pelo git (segredos nunca versionados)", () => {
    const gi = readFileSync(path.join(AQUI, "../../.gitignore"), "utf8");
    assert.match(gi, /^\.env\.\*/m);
  });
});
