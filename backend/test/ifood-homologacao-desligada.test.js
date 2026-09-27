// Modo de homologação DESLIGADO explicitamente (IFOOD_HOMOLOGATION_MODE=false)
// com credenciais reais presentes — comportamento tem que ser IDÊNTICO à
// Fase 1: cada appType usa sua própria credencial real, sem o campo `origem`
// extra (contrato exato de config-ifood.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);

process.env.IFOOD_HOMOLOGATION_MODE = "false";
process.env.IFOOD_ANALYTICS_CLIENT_ID = "an-real-id";
process.env.IFOOD_ANALYTICS_CLIENT_SECRET = "an-real-secret";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-real-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-real-secret";
// Sem credenciais de teste — não deveriam ser necessárias fora de homologação.

const { config } = await import("../src/config/env.js");
const { estaEmHomologacaoIfood, credenciaisDoApp } = await import("../src/modules/ifood/ifoodToken.service.js");

test("config.ifood.homologacao === false com IFOOD_HOMOLOGATION_MODE=false", () => {
  assert.equal(config.ifood.homologacao, false);
});

test("estaEmHomologacaoIfood() === false", () => {
  assert.equal(estaEmHomologacaoIfood(), false);
});

test("credenciaisDoApp('analytics') usa a credencial REAL de analytics (sem campo origem)", () => {
  assert.deepEqual(credenciaisDoApp("analytics"), { clientId: "an-real-id", clientSecret: "an-real-secret" });
});

test("credenciaisDoApp('financial') usa a credencial REAL de financial (sem campo origem)", () => {
  assert.deepEqual(credenciaisDoApp("financial"), { clientId: "fin-real-id", clientSecret: "fin-real-secret" });
});
