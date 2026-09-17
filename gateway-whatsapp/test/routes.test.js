// Testes de integração das rotas HTTP do Gateway (Backend -> Gateway),
// SEM Baileys real: a "sessão" injetada é um fake determinístico. Sobe um
// servidor Express real numa porta efêmera e fala HTTP de verdade — é o que
// garante que express.raw()+exigirHmac()+rotas realmente compõem do jeito
// que server.js monta em produção.
import { test, describe, after, before, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { exigirHmac, assinarRequisicao, _resetarNonces } from "../src/hmac.js";
import { criarRotas, health } from "../src/routes.js";

const SEGREDO = "s".repeat(32);

function sessaoFalsa() {
  return {
    conectar: mock.fn(async () => {}),
    desconectar: mock.fn(async () => {}),
    getStatus: mock.fn(async () => ({ conectado: true, provider: "baileys", telefone: "+5511999990000", atualizadoEm: "now" })),
    enviar: mock.fn(async () => ({ providerMessageId: "wa-1", enviadoEm: "now" })),
    markAsRead: mock.fn(async () => {}),
    getMessageStatus: mock.fn(async () => ({ status: "SENT" })),
    _status: () => "CONNECTED",
  };
}

describe("routes — Backend -> Gateway", () => {
  let servidor;
  let baseUrl;
  let sessao;

  before(async () => {
    sessao = sessaoFalsa();
    const app = express();
    app.get("/health", health);
    app.use("/internal", express.raw({ type: "*/*", limit: 256 * 1024 }), exigirHmac(SEGREDO), criarRotas(sessao));
    await new Promise((resolve) => {
      servidor = createServer(app).listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  });

  after(() => servidor.close());

  async function chamarAssinado(metodo, caminho, corpoObj) {
    const corpo = corpoObj === undefined ? "" : JSON.stringify(corpoObj);
    const headers = assinarRequisicao({ segredo: SEGREDO, metodo, caminho, corpo });
    if (corpo) headers["Content-Type"] = "application/json";
    return fetch(`${baseUrl}${caminho}`, { method: metodo, headers, body: corpo || undefined });
  }

  test("/health responde sem HMAC", async () => {
    const r = await fetch(`${baseUrl}/health`);
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.equal(json.service, "gateway-whatsapp");
  });

  test("rota interna sem HMAC é recusada com 401", async () => {
    const r = await fetch(`${baseUrl}/internal/whatsapp/status`);
    assert.equal(r.status, 401);
  });

  test("POST /internal/whatsapp/connect assinado chama sessao.conectar()", async () => {
    _resetarNonces();
    const r = await chamarAssinado("POST", "/internal/whatsapp/connect", {});
    assert.equal(r.status, 200);
    assert.equal(sessao.conectar.mock.calls.length, 1);
  });

  test("POST /internal/whatsapp/disconnect assinado chama sessao.desconectar()", async () => {
    _resetarNonces();
    const r = await chamarAssinado("POST", "/internal/whatsapp/disconnect", {});
    assert.equal(r.status, 200);
    assert.equal(sessao.desconectar.mock.calls.length, 1);
  });

  test("GET /internal/whatsapp/status assinado devolve o status", async () => {
    _resetarNonces();
    const r = await chamarAssinado("GET", "/internal/whatsapp/status");
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.equal(json.conectado, true);
  });

  test("POST /internal/whatsapp/messages (text) chama sessao.enviar() com o conteúdo mapeado", async () => {
    _resetarNonces();
    const r = await chamarAssinado("POST", "/internal/whatsapp/messages", {
      telefoneE164: "+5511999990000", tipo: "text", texto: "oi", idempotencyKey: "k1",
    });
    assert.equal(r.status, 200);
    const chamada = sessao.enviar.mock.calls[0].arguments[0];
    assert.deepEqual(chamada.conteudo, { text: "oi" });
  });

  test("POST /internal/whatsapp/messages com tipo desconhecido devolve 400 sem chamar enviar()", async () => {
    _resetarNonces();
    const antes = sessao.enviar.mock.calls.length;
    const r = await chamarAssinado("POST", "/internal/whatsapp/messages", { telefoneE164: "+551199999", tipo: "bulk-broadcast" });
    assert.equal(r.status, 400);
    assert.equal(sessao.enviar.mock.calls.length, antes);
  });

  test("POST /internal/whatsapp/messages/:id/read assinado chama markAsRead", async () => {
    _resetarNonces();
    const r = await chamarAssinado("POST", "/internal/whatsapp/messages/wa-1/read", { telefoneE164: "+5511999990000" });
    assert.equal(r.status, 200);
    assert.equal(sessao.markAsRead.mock.calls.length, 1);
  });

  test("GET /internal/whatsapp/messages/:id/status assinado devolve o status", async () => {
    _resetarNonces();
    const r = await chamarAssinado("GET", "/internal/whatsapp/messages/wa-1/status");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: "SENT" });
  });

  test("não existe rota de bulk/broadcast/groups/contacts", async () => {
    _resetarNonces();
    for (const rota of ["/internal/whatsapp/bulk", "/internal/whatsapp/broadcast", "/internal/whatsapp/groups", "/internal/whatsapp/contacts"]) {
      const r = await chamarAssinado("GET", rota);
      assert.equal(r.status, 404, `esperava 404 para ${rota}`);
    }
  });
});
