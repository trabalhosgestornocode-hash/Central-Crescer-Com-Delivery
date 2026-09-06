// Limite de CORPO da rota de Fechamento Mensal (F7). Bug real em produção:
// POST /api/v1/bonificacao-mensal/fechamento-mensal/preview caía no limite
// `padrao` de 1 MB — os 2 PDFs mensais em base64 passam de 1 MB fácil — e a UI
// mostrava "Arquivo(s) grande(s) demais para esta operação." (HTTP 413).
//
// A correção estende o mesmo teto do lançamento diário
// (LIMITES_CORPO.bonificacaoMensalImportacao = 50 MB) para o prefixo
// /fechamento-mensal. Estes testes provam que:
//   - a rota do fechamento aceita corpo grande (não 413);
//   - a rota do lançamento diário continua aceitando (não regrediu);
//   - o resto da API continua no teto de 1 MB (não subimos globalmente);
//   - o teto de 50 MB ainda existe (corpo absurdo ainda é 413).
//
// Rodar: node --test test/bonificacao-mensal-fechamento-upload.test.js
process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const { createApp } = await import("../src/app.js");

let srv, base;
before(async () => {
  srv = http.createServer(await createApp()).listen(0);
  await new Promise((r) => srv.once("listening", r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv?.close());

/** POST um JSON de ~sizeBytes e devolve só o status. */
async function postJsonDeTamanho(path, sizeBytes) {
  const filler = "a".repeat(Math.max(0, sizeBytes - 20));
  const body = JSON.stringify({ _: filler });
  const res = await fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });
  return res.status;
}

const MB = 1024 * 1024;
const NAO_413 = (s) => s !== 413; // 401/400 = passou pelo parser de corpo

describe("Fechamento Mensal (F7) — limite de corpo da rota", () => {
  test("/fechamento-mensal/preview aceita ~3 MB (não 413)", async () => {
    const s = await postJsonDeTamanho("/api/v1/bonificacao-mensal/fechamento-mensal/preview", 3 * MB);
    assert.ok(NAO_413(s), `esperava != 413, veio ${s}`);
  });

  test("/fechamento-mensal (confirmar) aceita ~3 MB (não 413)", async () => {
    const s = await postJsonDeTamanho("/api/v1/bonificacao-mensal/fechamento-mensal", 3 * MB);
    assert.ok(NAO_413(s), `esperava != 413, veio ${s}`);
  });

  test("/fechamento-mensal/consolidar (sem PDF) também casa o prefixo — não 413", async () => {
    const s = await postJsonDeTamanho("/api/v1/bonificacao-mensal/fechamento-mensal/consolidar", 2 * MB);
    assert.ok(NAO_413(s), `veio ${s}`);
  });

  test("corpo pequeno (500 KB) nunca dá 413", async () => {
    const s = await postJsonDeTamanho("/api/v1/bonificacao-mensal/fechamento-mensal/preview", 512 * 1024);
    assert.ok(NAO_413(s), `veio ${s}`);
  });

  test("corpo absurdo (60 MB) ainda é barrado — o teto de 50 MB continua valendo", async () => {
    const s = await postJsonDeTamanho("/api/v1/bonificacao-mensal/fechamento-mensal/preview", 60 * MB);
    assert.equal(s, 413);
  });
});

describe("regressão — lançamento diário e resto da API", () => {
  test("/bonificacao-mensal/importar/preview (diário) continua aceitando ~3 MB", async () => {
    const s = await postJsonDeTamanho("/api/v1/bonificacao-mensal/importar/preview", 3 * MB);
    assert.ok(NAO_413(s), `lançamento diário regrediu: veio ${s}`);
  });

  test("rota comum da Bonificação (metas) continua no teto de 1 MB → 413 com 3 MB", async () => {
    const s = await postJsonDeTamanho("/api/v1/bonificacao-mensal/metas/faturamento", 3 * MB);
    assert.equal(s, 413, "não subimos o limite globalmente");
  });

  test("rota fora da Bonificação continua no teto de 1 MB", async () => {
    const s = await postJsonDeTamanho("/api/v1/unidade/dados", 3 * MB);
    assert.equal(s, 413);
  });
});
