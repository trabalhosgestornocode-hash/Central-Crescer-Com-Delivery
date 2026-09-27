// Trava de subida do modo CENTRALIZED_TEST (Teste (C)) e do comando dedicado.
//
// Garante que o app centralizado de teste NÃO consegue subir contra produção:
// nem por SUPABASE_URL/chaves, nem no Render, nem misturado com o Teste (D),
// nem com credenciais dos apps REAIS presentes (sinal de .env de produção).
//
// Rodar: node --test test/ifood-centralized-guard.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROJETO_TESTE_REF, PROJETO_PRODUCAO_REF, validarAmbienteCentralizadoTesteIfood,
} from "../scripts/ifoodHomologGuard.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));

const ANON = "sb_publishable_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1";
const SERVICE = "sb_secret_FAKEFAKEFAKEFAKEFAKEFAKEFAKE1";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (ref) => `${b64({ alg: "HS256" })}.${b64({ ref })}.sig`;

const envOk = (extra = {}) => ({
  SUPABASE_URL: `https://${PROJETO_TESTE_REF}.supabase.co`,
  SUPABASE_ANON_KEY: ANON,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  IFOOD_CENTRALIZED_TEST_MODE: "true",
  IFOOD_CENTRALIZED_TEST_CLIENT_ID: "cid-c-fake",
  IFOOD_CENTRALIZED_TEST_CLIENT_SECRET: "csecret-c-fake",
  ...extra,
});

describe("validação estática do modo centralizado de teste", () => {
  test("ambiente de TESTE completo passa", () => {
    const r = validarAmbienteCentralizadoTesteIfood(envOk());
    assert.equal(r.ok, true, r.erros.join("; "));
    assert.deepEqual(r.provaAtivaNecessaria, ["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);
  });

  test("NÃO exige IFOOD_TOKEN_SECRET (o token centralizado nunca é persistido)", () => {
    assert.equal(validarAmbienteCentralizadoTesteIfood(envOk({ IFOOD_TOKEN_SECRET: undefined })).ok, true);
  });

  test("SUPABASE_URL de PRODUÇÃO é recusada (EXIT 1 no comando)", () => {
    const r = validarAmbienteCentralizadoTesteIfood(envOk({ SUPABASE_URL: `https://${PROJETO_PRODUCAO_REF}.supabase.co` }));
    assert.equal(r.ok, false);
    assert.match(r.erros.join(" "), /PRODUÇÃO/);
  });

  test("MISTURA: URL de teste + chave JWT de produção é recusada", () => {
    for (const k of ["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
      assert.equal(validarAmbienteCentralizadoTesteIfood(envOk({ [k]: jwt(PROJETO_PRODUCAO_REF) })).ok, false, k);
    }
  });

  test("Render e NODE_ENV=production são recusados", () => {
    assert.equal(validarAmbienteCentralizadoTesteIfood(envOk({ RENDER: "true" })).ok, false);
    assert.equal(validarAmbienteCentralizadoTesteIfood(envOk({ NODE_ENV: "production" })).ok, false);
    assert.equal(validarAmbienteCentralizadoTesteIfood(envOk({ NODE_ENV: "development" })).ok, true);
  });

  test("modo + credenciais do Teste (C) são obrigatórios; MODE tem que ser exatamente 'true'", () => {
    assert.equal(validarAmbienteCentralizadoTesteIfood(envOk({ IFOOD_CENTRALIZED_TEST_MODE: "1" })).ok, false);
    assert.equal(validarAmbienteCentralizadoTesteIfood(envOk({ IFOOD_CENTRALIZED_TEST_MODE: undefined })).ok, false);
    assert.equal(validarAmbienteCentralizadoTesteIfood(envOk({ IFOOD_CENTRALIZED_TEST_CLIENT_ID: "" })).ok, false);
    assert.equal(validarAmbienteCentralizadoTesteIfood(envOk({ IFOOD_CENTRALIZED_TEST_CLIENT_SECRET: "" })).ok, false);
  });

  test("NÃO reutiliza silenciosamente o Teste (D): IFOOD_TEST_CLIENT_* sozinho não habilita nada", () => {
    const { IFOOD_CENTRALIZED_TEST_CLIENT_ID, IFOOD_CENTRALIZED_TEST_CLIENT_SECRET, ...semC } = envOk();
    const r = validarAmbienteCentralizadoTesteIfood({ ...semC, IFOOD_TEST_CLIENT_ID: "d", IFOOD_TEST_CLIENT_SECRET: "d" });
    assert.equal(r.ok, false);
    assert.match(r.erros.join(" "), /IFOOD_CENTRALIZED_TEST_CLIENT_ID ausente/);
  });

  test("modo de homologação (Teste (D), distribuído) não pode ser combinado", () => {
    const r = validarAmbienteCentralizadoTesteIfood(envOk({ IFOOD_HOMOLOGATION_MODE: "true" }));
    assert.equal(r.ok, false);
    assert.match(r.erros.join(" "), /IFOOD_HOMOLOGATION_MODE/);
  });

  test("credenciais dos apps REAIS no ambiente (sinal de .env de produção) são recusadas", () => {
    for (const nome of ["IFOOD_ANALYTICS_CLIENT_ID", "IFOOD_ANALYTICS_CLIENT_SECRET", "IFOOD_FINANCIAL_CLIENT_ID", "IFOOD_FINANCIAL_CLIENT_SECRET"]) {
      const r = validarAmbienteCentralizadoTesteIfood(envOk({ [nome]: "valor-real" }));
      assert.equal(r.ok, false, nome);
      assert.match(r.erros.join(" "), new RegExp(nome));
    }
  });

  test("IFOOD_API_BASE_URL só o host oficial", () => {
    assert.equal(validarAmbienteCentralizadoTesteIfood(envOk({ IFOOD_API_BASE_URL: "https://evil.example.com" })).ok, false);
    assert.equal(validarAmbienteCentralizadoTesteIfood(envOk({ IFOOD_API_BASE_URL: "https://merchant-api.ifood.com.br" })).ok, true);
  });

  test("as mensagens de erro NUNCA contêm valores secretos", () => {
    const env = envOk({
      SUPABASE_URL: `https://${PROJETO_PRODUCAO_REF}.supabase.co`,
      SUPABASE_SERVICE_ROLE_KEY: "sb_secret_SEGREDO_SERVICE_PROD_XXXXXXXXXXXX",
      IFOOD_FINANCIAL_CLIENT_SECRET: "SEGREDO-FINANCEIRO-REAL",
      IFOOD_CENTRALIZED_TEST_CLIENT_SECRET: "SEGREDO-C-NAO-VAZAR",
    });
    const saida = JSON.stringify(validarAmbienteCentralizadoTesteIfood(env));
    for (const s of ["SEGREDO_SERVICE_PROD", "SEGREDO-FINANCEIRO-REAL", "SEGREDO-C-NAO-VAZAR"]) assert.ok(!saida.includes(s), s);
  });
});

describe("comandos npm do modo centralizado", () => {
  const pkg = JSON.parse(readFileSync(path.join(AQUI, "../package.json"), "utf8"));

  for (const nome of ["dev:ifood-centralized-test", "ifood:centralized-check"]) {
    test(`${nome}: usa SOMENTE .env.test-integracao + .env.ifood-centralized-test, nesta ordem`, () => {
      const cmd = pkg.scripts[nome];
      assert.ok(cmd, `${nome} ausente`);
      assert.deepEqual([...cmd.matchAll(/--env-file=(\S+)/g)].map((m) => m[1]), [".env.test-integracao", ".env.ifood-centralized-test"]);
      assert.doesNotMatch(cmd, /--env-file=\.env(\s|$)/, "não pode carregar o .env de produção");
      assert.doesNotMatch(cmd, /ifood-homolog(?!\.mjs)/, "não mistura com o arquivo do Teste (D)");
    });
  }

  test("o servidor só é importado DEPOIS da validação e da prova ativa", () => {
    const s = readFileSync(path.join(AQUI, "../scripts/dev-ifood-centralized-test.mjs"), "utf8");
    const iVal = s.indexOf("validarAmbienteCentralizadoTesteIfood(process.env)");
    const iProva = s.indexOf("provarChavesNoProjetoTeste(process.env");
    const iServer = s.indexOf('import("../src/server.js")');
    assert.ok(iVal > -1 && iProva > iVal && iServer > iProva);
    assert.match(s, /process\.exit\(1\)/);
    assert.doesNotMatch(pkg.scripts["dev:ifood-centralized-test"], /src\/server\.js/);
  });

  test("o verificador do Checkpoint A importa a config só depois da trava e não toca em banco", () => {
    const s = readFileSync(path.join(AQUI, "../scripts/ifood-centralized-check.mjs"), "utf8");
    assert.ok(s.indexOf("validarAmbienteCentralizadoTesteIfood(process.env)") < s.indexOf('await import("../src/modules/ifood/ifoodMerchant.service.js")'));
    assert.doesNotMatch(s, /\.from\(|\.insert\(|\.update\(|\.delete\(|\.upsert\(/, "somente leitura, sem banco");
    assert.doesNotMatch(s, /console\.(log|error)\([^)]*(clientSecret|CLIENT_SECRET|accessToken)/, "nunca imprime segredo/token");
  });

  test("arquivo de ambiente do Teste (C) existe como modelo, ignorado pelo git, e sem valores versionados", () => {
    const gi = readFileSync(path.join(AQUI, "../../.gitignore"), "utf8");
    assert.match(gi, /^\.env\.\*/m);
    const ex = readFileSync(path.join(AQUI, "../.env.example"), "utf8");
    assert.match(ex, /# IFOOD_CENTRALIZED_TEST_MODE=true/);
    assert.match(ex, /# IFOOD_CENTRALIZED_TEST_CLIENT_SECRET=\s*$/m, "só o nome, comentado e sem valor");
  });
});

describe("E2E de Events no banco de teste (scripts/ifood-events-e2e-centralized.mjs)", () => {
  const pkg = JSON.parse(readFileSync(path.join(AQUI, "../package.json"), "utf8"));
  const s = readFileSync(path.join(AQUI, "../scripts/ifood-events-e2e-centralized.mjs"), "utf8");

  test("usa SOMENTE .env.test-integracao + .env.ifood-centralized-test (nunca o .env de produção)", () => {
    const cmd = pkg.scripts["ifood:events-e2e"];
    assert.ok(cmd);
    assert.deepEqual([...cmd.matchAll(/--env-file=(\S+)/g)].map((m) => m[1]), [".env.test-integracao", ".env.ifood-centralized-test"]);
    assert.doesNotMatch(cmd, /--env-file=\.env(\s|$)/);
  });

  test("recusa rodar sem --merchant e sem --ack-real; a trava vem ANTES de importar qualquer módulo do iFood", () => {
    assert.match(s, /if \(!merchantEsperado\) falhar/);
    assert.match(s, /if \(!ackReal\) falhar/);
    assert.ok(s.indexOf("validarAmbienteCentralizadoTesteIfood(process.env)") < s.indexOf('await import("../src/modules/ifood/ifoodHttp.client.js")'));
    assert.ok(s.indexOf("provarChavesNoProjetoTeste(process.env") < s.indexOf('await import("../src/modules/ifood/ifoodEvents.repository.js")'));
  });

  test("exige merchant único e binding único; só ESSE merchant participa; nunca apaga nada; libera o lease no fim", () => {
    assert.match(s, /lojas\.total !== 1 \|\| lojas\.merchants\[0\]\.id !== merchantEsperado/);
    assert.match(s, /bindings\.length !== 1/);
    assert.match(s, /listarConexoesComMerchant: async \(\) => \[b\]/);
    const codigo = s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    assert.doesNotMatch(codigo, /\.delete\(|truncate|drop table|delete from/i);
    assert.match(codigo, /finally \{[\s\S]*poller\.encerrar\(\)/);
    assert.doesNotMatch(codigo, /console\.(log|error)\([^)]*(clientSecret|CLIENT_SECRET|accessToken)/);
  });
});

describe("E2E de Order/Confirm no banco de teste (scripts/ifood-order-e2e-centralized.mjs)", () => {
  const pkg = JSON.parse(readFileSync(path.join(AQUI, "../package.json"), "utf8"));
  const s = readFileSync(path.join(AQUI, "../scripts/ifood-order-e2e-centralized.mjs"), "utf8");
  const codigo = s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  test("usa SOMENTE .env.test-integracao + .env.ifood-centralized-test (nunca o .env de produção)", () => {
    for (const nome of ["ifood:order-e2e", "ifood:order-check"]) {
      const cmd = pkg.scripts[nome];
      assert.ok(cmd, nome);
      assert.deepEqual([...cmd.matchAll(/--env-file=(\S+)/g)].map((m) => m[1]), [".env.test-integracao", ".env.ifood-centralized-test"]);
      assert.doesNotMatch(cmd, /--env-file=\.env(\s|$)/);
    }
  });

  test("a trava vem ANTES de importar módulos do iFood; exige --merchant, --order e --ack-real", () => {
    assert.match(s, /if \(!merchantEsperado \|\| !orderId\) falhar/);
    assert.match(s, /if \(!ackReal\) falhar/);
    assert.ok(s.indexOf("validarAmbienteCentralizadoTesteIfood(process.env)") < s.indexOf('await import("../src/modules/ifood/ifoodHttp.client.js")'));
  });

  test("o confirm REAL só acontece com --confirm-real e só em pedido de teste, PLACED, com detalhes e sem confirm anterior", () => {
    assert.match(s, /const confirmReal = process\.argv\.includes\("--confirm-real"\)/);
    assert.ok(codigo.indexOf("if (!confirmReal)") < codigo.indexOf("await confirmarPedido("));
    for (const re of [/p\.is_test !== true/, /p\.status_oficial !== "PLACED"/, /p\.details_status !== "OK"/, /p\.action_state !== "none"/]) assert.match(s, re);
    assert.equal((codigo.match(/await confirmarPedido\(/g) ?? []).length, 1, "um único POST /confirm");
    assert.doesNotMatch(codigo, /\.delete\(|truncate|drop table|delete from/i);
    assert.match(codigo, /finally \{[\s\S]*poller\.encerrar\(\)/);
    assert.doesNotMatch(codigo, /console\.(log|error)\([^)]*(clientSecret|CLIENT_SECRET|accessToken)/);
  });

  test("o script de leitura (order-check) não usa banco nem faz POST", () => {
    const c = readFileSync(path.join(AQUI, "../scripts/ifood-order-check.mjs"), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    assert.doesNotMatch(c, /config\/supabase|@supabase|\.repository|confirmarPedido|confirmarEventos|postJson|postForm/);
  });
});

describe("E2E das ações do Checkpoint D (scripts/ifood-order-action-e2e-centralized.mjs)", () => {
  const pkg = JSON.parse(readFileSync(path.join(AQUI, "../package.json"), "utf8"));
  const s = readFileSync(path.join(AQUI, "../scripts/ifood-order-action-e2e-centralized.mjs"), "utf8");
  const codigo = s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  test("usa SOMENTE .env.test-integracao + .env.ifood-centralized-test (nunca o .env de produção)", () => {
    const cmd = pkg.scripts["ifood:order-action"];
    assert.ok(cmd);
    assert.deepEqual([...cmd.matchAll(/--env-file=(\S+)/g)].map((m) => m[1]), [".env.test-integracao", ".env.ifood-centralized-test"]);
    assert.doesNotMatch(cmd, /--env-file=\.env(\s|$)/);
  });

  test("a trava de ambiente vem ANTES de importar qualquer módulo do iFood; exige --acao, --merchant, --order/--dispute e --ack-real", () => {
    assert.ok(s.indexOf("validarAmbienteCentralizadoTesteIfood(process.env)") < s.indexOf('await import("../src/modules/ifood/ifoodHttp.client.js")'));
    assert.ok(s.indexOf("provarChavesNoProjetoTeste(process.env") < s.indexOf('await import("../src/modules/ifood/ifoodEvents.repository.js")'));
    for (const re of [/if \(!ACOES\.includes\(acao\)\) falhar/, /if \(!merchantEsperado\) falhar/, /if \(!ackReal\) falhar/]) assert.match(s, re);
  });

  test("SEM --enviar-real é DRY-RUN: todo POST fica depois do `if (!enviarReal)`; salvaguardas isTest/merchant/tenant/detalhes/elegibilidade antes do envio", () => {
    assert.match(s, /const enviarReal = process\.argv\.includes\("--enviar-real"\)/);
    const idxDry = codigo.indexOf("if (!enviarReal)");
    assert.ok(idxDry > 0);
    for (const chamada of ["await fn({", "handshake.responderDisputa("]) assert.ok(codigo.indexOf(chamada) > idxDry, chamada);
    for (const re of [/p\.is_test !== true/, /pedido\?\.is_test !== true/, /p\.merchant_id !== merchantEsperado/, /p\.organizacao_id !== tenant\.organizacaoId/, /p\.details_status !== "OK"/, /avaliarElegibilidade\(nome, p\)/]) assert.match(s, re);
    assert.match(s, /lojas\.total !== 1 \|\| lojas\.merchants\[0\]\.id !== merchantEsperado/);
    assert.match(s, /bindings\.length !== 1/);
  });

  test("um único envio por execução; nunca apaga nada; libera o lease; não imprime segredo", () => {
    assert.equal((codigo.match(/await fn\(\{/g) ?? []).length, 1);
    assert.equal((codigo.match(/handshake\.responderDisputa\(/g) ?? []).length, 1);
    assert.doesNotMatch(codigo, /\.delete\(|truncate|drop table|delete from/i);
    assert.match(codigo, /finally \{[\s\S]*poller\.encerrar\(\)/);
    assert.doesNotMatch(codigo, /console\.(log|error)\([^)]*(clientSecret|CLIENT_SECRET|accessToken)/);
  });
});

describe("D1 — PRÉ-READY (scripts/ifood-order-e2e-centralized.mjs --d1)", () => {
  const s = readFileSync(path.join(AQUI, "../scripts/ifood-order-e2e-centralized.mjs"), "utf8");
  const codigo = s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  test("o script NUNCA envia readyToPickup: não importa o service de ações nem chama notificarPronto/despachar/cancelar", () => {
    assert.doesNotMatch(codigo, /ifoodOrderActions\.service|notificarPronto|notificarPedidoPronto|despachar|cancelar\(|solicitarCancelamento|readyToPickup/);
    assert.match(codigo, /ifoodOrderElegibilidade\.js/, "usa só a função pura de elegibilidade");
  });

  test("--d1 exige --confirm-real e a migration 103; fluxo único (confirm + CFM + detalhes + elegibilidade) e imprime o bloco PRÉ-READY com 'POST ready enviado: NÃO'", () => {
    assert.match(s, /if \(d1 && !confirmReal\) falhar/);
    assert.match(s, /MIGRATION 103 NÃO ESTÁ APLICADA/);
    assert.match(s, /CHECKPOINT D1 — PRÉ-READY/);
    assert.match(s, /POST ready enviado:\nNÃO/);
    assert.equal((codigo.match(/await confirmarPedido\(/g) ?? []).length, 1, "um único POST /confirm");
  });

  test("as salvaguardas do confirm continuam ANTES do POST (isTest, PLACED, detalhes, tenant, merchant, sem confirm anterior, SLA)", () => {
    const idxPost = codigo.indexOf("await confirmarPedido(");
    for (const re of [/p\.is_test !== true/, /p\.status_oficial !== "PLACED"/, /p\.details_status !== "OK"/, /p\.confirm_attempts \?\? 0\) !== 0/, /tenant do pedido diferente do binding/, /merchant do pedido diferente do esperado/, /SLA: pedido com/]) {
      const m = re.exec(codigo);
      assert.ok(m && m.index < idxPost, String(re));
    }
  });
});
