// Homologação ligada, mas IFOOD_TEST_CLIENT_ID ausente — precisa falhar de
// forma controlada (IFOOD_APP_SEM_CREDENCIAL), igual à Fase 1 quando falta
// uma credencial real. Nunca deve cair para a credencial real por engano.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);

process.env.IFOOD_HOMOLOGATION_MODE = "true";
delete process.env.IFOOD_TEST_CLIENT_ID;
process.env.IFOOD_TEST_CLIENT_SECRET = "test-app-secret";
// Reais presentes — não podem ser usados como fallback silencioso.
process.env.IFOOD_ANALYTICS_CLIENT_ID = "an-real-id";
process.env.IFOOD_ANALYTICS_CLIENT_SECRET = "an-real-secret";

const { credenciaisDoApp } = await import("../src/modules/ifood/ifoodToken.service.js");
const { IFOOD_ERROS } = await import("../src/modules/ifood/ifood.errors.js");

test("credenciaisDoApp('analytics') lança IFOOD_APP_SEM_CREDENCIAL sem IFOOD_TEST_CLIENT_ID", () => {
  assert.throws(() => credenciaisDoApp("analytics"), (e) => e.codigo === IFOOD_ERROS.IFOOD_APP_SEM_CREDENCIAL);
});

test("credenciaisDoApp('financial') lança IFOOD_APP_SEM_CREDENCIAL sem IFOOD_TEST_CLIENT_ID", () => {
  assert.throws(() => credenciaisDoApp("financial"), (e) => e.codigo === IFOOD_ERROS.IFOOD_APP_SEM_CREDENCIAL);
});

test("o erro não vaza a credencial real de analytics nos detalhes", () => {
  try {
    credenciaisDoApp("analytics");
    assert.fail("deveria ter lançado");
  } catch (e) {
    assert.equal(e.codigo, IFOOD_ERROS.IFOOD_APP_SEM_CREDENCIAL);
    assert.ok(!JSON.stringify(e.details ?? {}).includes("an-real-id"));
  }
});
