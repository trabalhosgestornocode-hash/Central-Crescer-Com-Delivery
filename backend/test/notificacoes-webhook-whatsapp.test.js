// Webhook da Meta — HOMOLOGAÇÃO SINTÉTICA: servidor HTTP real em porta efêmera, banco falso, nenhuma rede externa.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";

const { montarWebhookWhatsapp, CAMINHO_WEBHOOK_WHATSAPP } = await import("../src/modules/notificacoes/notificacoes.webhookWhatsapp.js");
const SEG = "app-secret-ficticio", VT = "verifica-ficticio";
const ASS = (c, s = SEG) => "sha256=" + crypto.createHmac("sha256", s).update(c).digest("hex");
const corpo = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.A", status: "delivered", recipient_id: "5511912345678" }, { id: "wamid.A", status: "read" }, { id: "wamid.B", status: "failed", errors: [{ code: 131026 }] }] } }] }] });

function subir(env, rpc) {
  const dep = { supabase: { rpc } };
  const m = montarWebhookWhatsapp(env, dep);
  const app = express();
  if (m) app.use(m.path, m.router);
  app.use(express.json());
  return new Promise((ok) => { const s = http.createServer(app).listen(0, "127.0.0.1", () => ok({ s, url: `http://127.0.0.1:${s.address().port}${CAMINHO_WEBHOOK_WHATSAPP}`, m })); });
}
const banco = () => { const chaves = new Set(); const chamadas = [];
  return { chamadas, chaves, rpc: async (nome, { p }) => { chamadas.push(nome); let n = 0; for (const e of p) if (!chaves.has(e.chave)) { chaves.add(e.chave); n++; } return { data: n, error: null }; } }; };

describe("webhook WhatsApp (Meta)", () => {
  let b, srv, log;
  const orig = { log: console.log, warn: console.warn };
  before(async () => { b = banco(); srv = await subir({ WHATSAPP_CLOUD_APP_SECRET: SEG, WHATSAPP_CLOUD_VERIFY_TOKEN: VT }, b.rpc); log = []; console.log = (...a) => log.push(a.join(" ")); console.warn = console.log; });
  after(() => { console.log = orig.log; console.warn = orig.warn; srv.s.close(); });

  test("sem WHATSAPP_CLOUD_APP_SECRET a rota não existe", async () => {
    const x = await subir({}, b.rpc); assert.equal(x.m, null);
    assert.equal((await fetch(x.url, { method: "POST", body: corpo })).status, 404); x.s.close();
  });
  test("handshake: token certo devolve o desafio; errado/ausente → 403", async () => {
    const ok = await fetch(`${srv.url}?hub.mode=subscribe&hub.verify_token=${VT}&hub.challenge=777`);
    assert.deepEqual([ok.status, await ok.text()], [200, "777"]);
    assert.equal((await fetch(`${srv.url}?hub.mode=subscribe&hub.verify_token=x&hub.challenge=777`)).status, 403);
    assert.equal((await fetch(srv.url)).status, 403);
  });
  test("handshake sem VERIFY_TOKEN configurado nunca responde", async () => {
    const x = await subir({ WHATSAPP_CLOUD_APP_SECRET: SEG }, b.rpc);
    assert.equal((await fetch(`${x.url}?hub.mode=subscribe&hub.verify_token=&hub.challenge=1`)).status, 403); x.s.close();
  });
  test("assinatura inválida/ausente/corpo adulterado → 401 e NADA chega ao banco", async () => {
    const antes = b.chamadas.length;
    for (const h of [{}, { "X-Hub-Signature-256": "sha256=00" }, { "X-Hub-Signature-256": ASS(corpo, "outro") }, { "X-Hub-Signature-256": ASS(corpo + " ") }])
      assert.equal((await fetch(srv.url, { method: "POST", headers: { "content-type": "application/json", ...h }, body: corpo })).status, 401);
    assert.equal(b.chamadas.length, antes);
  });
  test("JSON inválido com assinatura correta → 400, sem banco", async () => {
    const ruim = "{nao-json"; const antes = b.chamadas.length;
    assert.equal((await fetch(srv.url, { method: "POST", headers: { "X-Hub-Signature-256": ASS(ruim) }, body: ruim })).status, 400);
    assert.equal(b.chamadas.length, antes);
  });
  test("válido grava 3 eventos; reentrega (inclusive simultânea) não duplica; log sem telefone", async () => {
    const h = { "X-Hub-Signature-256": ASS(corpo), "content-type": "application/json" };
    const rs = await Promise.all(Array.from({ length: 8 }, () => fetch(srv.url, { method: "POST", headers: h, body: corpo })));
    assert.ok(rs.every((r) => r.status === 200));
    assert.deepEqual([...b.chaves].sort(), ["wamid.A:delivered", "wamid.A:read", "wamid.B:failed"]);
    assert.ok(!log.join("\n").includes("5511912345678"));
  });
  test("falha do banco → 500 (a Meta reentrega); a mensagem de erro não vaza", async () => {
    const x = await subir({ WHATSAPP_CLOUD_APP_SECRET: SEG }, async () => ({ data: null, error: { code: "XX000", message: "connection string postgres://segredo" } }));
    const r = await fetch(x.url, { method: "POST", headers: { "X-Hub-Signature-256": ASS(corpo) }, body: corpo });
    assert.equal(r.status, 500); assert.equal(await r.text(), ""); assert.ok(!log.join("\n").includes("postgres://")); x.s.close();
  });
  test("payload sem status (ex.: só mensagens recebidas) → 200 sem tocar o banco", async () => {
    const vazio = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: "5511912345678", text: { body: "oi" } }] } }] }] });
    const antes = b.chamadas.length;
    assert.equal((await fetch(srv.url, { method: "POST", headers: { "X-Hub-Signature-256": ASS(vazio) }, body: vazio })).status, 200);
    assert.equal(b.chamadas.length, antes);
  });
});
