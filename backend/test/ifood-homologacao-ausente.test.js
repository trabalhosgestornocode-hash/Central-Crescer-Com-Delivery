// IFOOD_HOMOLOGATION_MODE AUSENTE do ambiente (nem "true" nem "false") — o
// padrão seguro é se comportar como Fase 1 (produção normal), nunca cair
// acidentalmente em homologação.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);

delete process.env.IFOOD_HOMOLOGATION_MODE;
process.env.IFOOD_ANALYTICS_CLIENT_ID = "an-real-id";
process.env.IFOOD_ANALYTICS_CLIENT_SECRET = "an-real-secret";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-real-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-real-secret";

const { config } = await import("../src/config/env.js");
const { estaEmHomologacaoIfood, credenciaisDoApp } = await import("../src/modules/ifood/ifoodToken.service.js");

test("config.ifood.homologacao === false quando a variável está ausente", () => {
  assert.equal(config.ifood.homologacao, false);
});

test("estaEmHomologacaoIfood() === false quando a variável está ausente", () => {
  assert.equal(estaEmHomologacaoIfood(), false);
});

test("credenciaisDoApp continua resolvendo as credenciais reais (comportamento Fase 1)", () => {
  assert.deepEqual(credenciaisDoApp("analytics"), { clientId: "an-real-id", clientSecret: "an-real-secret" });
  assert.deepEqual(credenciaisDoApp("financial"), { clientId: "fin-real-id", clientSecret: "fin-real-secret" });
});
