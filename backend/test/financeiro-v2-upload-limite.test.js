// Limite de CORPO do envio de relatório do Financeiro v2 (validação de 17/11/2026): o parser global de 1 MB rodava antes do
// módulo e barrava relatórios reais da SAIPOS acima de ~760 KB (base64 > 1 MB). Agora só a rota de envio aceita até 8 MB.
// Rodar: node --test test/financeiro-v2-upload-limite.test.js
process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const { createApp } = await import("../src/app.js");
let srv, base;
before(async () => { srv = http.createServer(await createApp()).listen(0); await new Promise((r) => srv.once("listening", r)); base = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv?.close());
const MB = 1024 * 1024;
const post = async (path, tamanho) => (await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ _: "a".repeat(Math.max(0, tamanho - 20)) }) })).status;

test("envio de relatório do Financeiro v2 aceita ~3 MB (não 413)", async () => {
  assert.notEqual(await post("/api/v1/financeiro-v2/acoes/importacao/receber", 3 * MB), 413);
});
test("outras ações do Financeiro v2 continuam no teto padrão (2 MB → 413)", async () => {
  assert.equal(await post("/api/v1/financeiro-v2/acoes/vendas/registrar", 2 * MB), 413);
});
test("o teto de 8 MB continua valendo (10 MB → 413)", async () => {
  assert.equal(await post("/api/v1/financeiro-v2/acoes/importacao/receber", 10 * MB), 413);
});
