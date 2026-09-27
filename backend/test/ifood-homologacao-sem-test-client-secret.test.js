// Homologação ligada, mas IFOOD_TEST_CLIENT_SECRET ausente — mesma regra do
// cenário "sem client id": falha controlada, nunca fallback silencioso.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);

process.env.IFOOD_HOMOLOGATION_MODE = "true";
process.env.IFOOD_TEST_CLIENT_ID = "test-app-id";
delete process.env.IFOOD_TEST_CLIENT_SECRET;
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-real-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-real-secret";

const { credenciaisDoApp } = await import("../src/modules/ifood/ifoodToken.service.js");
const { IFOOD_ERROS } = await import("../src/modules/ifood/ifood.errors.js");

test("credenciaisDoApp('analytics') lança IFOOD_APP_SEM_CREDENCIAL sem IFOOD_TEST_CLIENT_SECRET", () => {
  assert.throws(() => credenciaisDoApp("analytics"), (e) => e.codigo === IFOOD_ERROS.IFOOD_APP_SEM_CREDENCIAL);
});

test("credenciaisDoApp('financial') lança IFOOD_APP_SEM_CREDENCIAL sem IFOOD_TEST_CLIENT_SECRET", () => {
  assert.throws(() => credenciaisDoApp("financial"), (e) => e.codigo === IFOOD_ERROS.IFOOD_APP_SEM_CREDENCIAL);
});
