// Modo de homologação iFood — IFOOD_HOMOLOGATION_MODE=true.
//
// Cenário: credenciais REAIS (analytics/financial) E de teste presentes ao
// mesmo tempo — prova que, em homologação, o app de teste tem PRIORIDADE e
// os dois appTypes resolvem para a MESMA credencial de teste, sem nunca
// escrever "test" em app_type (isso é responsabilidade do repository, não
// desta função — ver ifood-homologacao-oauth.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);

process.env.IFOOD_HOMOLOGATION_MODE = "true";
process.env.IFOOD_TEST_CLIENT_ID = "test-app-id";
process.env.IFOOD_TEST_CLIENT_SECRET = "test-app-secret";
// Reais também presentes — não podem vazar enquanto homologação está ligada.
process.env.IFOOD_ANALYTICS_CLIENT_ID = "an-real-id";
process.env.IFOOD_ANALYTICS_CLIENT_SECRET = "an-real-secret";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-real-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-real-secret";

const { config } = await import("../src/config/env.js");
const { estaEmHomologacaoIfood, credenciaisDoApp } = await import("../src/modules/ifood/ifoodToken.service.js");
const { IFOOD_ERROS } = await import("../src/modules/ifood/ifood.errors.js");

test("config.ifood.homologacao reflete IFOOD_HOMOLOGATION_MODE=true", () => {
  assert.equal(config.ifood.homologacao, true);
});

test("estaEmHomologacaoIfood() === true", () => {
  assert.equal(estaEmHomologacaoIfood(), true);
});

test("credenciaisDoApp('analytics') usa o app de teste, não o real", () => {
  assert.deepEqual(credenciaisDoApp("analytics"), {
    clientId: "test-app-id", clientSecret: "test-app-secret", origem: "test",
  });
});

test("credenciaisDoApp('financial') usa o MESMO app de teste que analytics", () => {
  assert.deepEqual(credenciaisDoApp("financial"), {
    clientId: "test-app-id", clientSecret: "test-app-secret", origem: "test",
  });
  assert.deepEqual(credenciaisDoApp("financial"), credenciaisDoApp("analytics"));
});

test("appType inválido continua lançando IFOOD_APP_TYPE_INVALIDO mesmo em homologação", () => {
  assert.throws(() => credenciaisDoApp("bogus"), (e) => e.codigo === IFOOD_ERROS.IFOOD_APP_TYPE_INVALIDO);
});
