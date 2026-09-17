// Testes de integração das rotas Gateway -> Backend
// (whatsappGateway.routes.js), com o repo em memória (a tabela real —
// whatsapp_conexoes — ainda não existe; migration 083 não foi aplicada em
// nenhum banco neste checkpoint) e o provider real fazendo o papel de
// receptor de "mensagem recebida".
import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { exigirHmac, assinarRequisicao, _resetarNonces } from "../src/modules/comunicacao/gateway/whatsappGateway.hmac.js";
import { criarWhatsappGatewayRouter } from "../src/modules/comunicacao/gateway/whatsappGateway.routes.js";
import { criarRepoEmMemoria } from "../src/modules/comunicacao/gateway/whatsappGateway.repo.js";
import { criarBaileysGatewayProvider } from "../src/modules/comunicacao/providers/baileysGateway.provider.js";

const SEGREDO = "s".repeat(32);
const ORG_ID = "org-teste-1";

describe("whatsappGateway.routes — eventos Gateway -> Backend", () => {
  let servidor, baseUrl, repo, provider;

  before(async () => {
    repo = criarRepoEmMemoria();
    provider = criarBaileysGatewayProvider({ gatewayUrl: "http://unused.invalid", segredoHmac: SEGREDO });
    const app = express();
    app.use("/internal/comunicacao", express.raw({ type: "*/*", limit: 256 * 1024 }), exigirHmac(SEGREDO), criarWhatsappGatewayRouter({ repo, organizacaoId: ORG_ID, provider }));
    await new Promise((resolve) => { servidor = createServer(app).listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  });
  after(() => servidor.close());

  async function chamarAssinado(metodo, caminho, corpoObj) {
    const corpo = corpoObj === undefined ? "" : JSON.stringify(corpoObj);
    const headers = assinarRequisicao({ segredo: SEGREDO, metodo, caminho, corpo });
    if (corpo) headers["Content-Type"] = "application/json";
    return fetch(`${baseUrl}${caminho}`, { method: metodo, headers, body: corpo || undefined });
  }

  test("sem HMAC, tudo recusado com 401 (rota não vira API pública)", async () => {
    const r = await fetch(`${baseUrl}/internal/comunicacao/eventos/heartbeat`, { method: "POST" });
    assert.equal(r.status, 401);
  });

  test("heartbeat assinado é registrado no repo (last_seen_at observável)", async () => {
    _resetarNonces();
    const r = await chamarAssinado("POST", "/internal/comunicacao/eventos/heartbeat", { status: "CONNECTED", telefone: "+5511999990000", gatewayVersion: "0.1.0" });
    assert.equal(r.status, 200);
    const snap = repo._snapshot(ORG_ID);
    assert.equal(snap.status, "CONNECTED");
    assert.ok(snap.lastSeenAt);
  });

  test("auth-state: POST grava só o ciphertext, GET devolve exatamente o que foi salvo", async () => {
    _resetarNonces();
    const blob = "v1:aWY=:YWJj:ZGVm";
    const rPost = await chamarAssinado("POST", "/internal/comunicacao/eventos/auth-state", { authStateEncrypted: blob, authStateVersion: "v1" });
    assert.equal(rPost.status, 200);

    _resetarNonces();
    const rGet = await chamarAssinado("GET", "/internal/comunicacao/auth-state");
    assert.equal(rGet.status, 200);
    assert.deepEqual(await rGet.json(), { authStateEncrypted: blob });
  });

  test("auth-state: POST sem authStateEncrypted é rejeitado com 400 (nunca grava lixo)", async () => {
    _resetarNonces();
    const r = await chamarAssinado("POST", "/internal/comunicacao/eventos/auth-state", { authStateVersion: "v1" });
    assert.equal(r.status, 400);
  });

  test("GET auth-state sem nada salvo ainda devolve objeto vazio, não erro", async () => {
    const repoVazio = criarRepoEmMemoria();
    const app = express();
    app.use("/internal/comunicacao", express.raw({ type: "*/*", limit: 256 * 1024 }), exigirHmac(SEGREDO), criarWhatsappGatewayRouter({ repo: repoVazio, organizacaoId: "outra-org" }));
    const srv = await new Promise((resolve) => { const s = createServer(app).listen(0, () => resolve(s)); });
    const url = `http://127.0.0.1:${srv.address().port}`;
    const headers = assinarRequisicao({ segredo: SEGREDO, metodo: "GET", caminho: "/internal/comunicacao/auth-state", corpo: "" });
    const r = await fetch(`${url}/internal/comunicacao/auth-state`, { headers });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {});
    srv.close();
  });

  test("mensagem-recebida assinada repassa o evento para o provider (onMessage)", async () => {
    _resetarNonces();
    const recebidos = [];
    provider.onMessage((m) => recebidos.push(m));
    const r = await chamarAssinado("POST", "/internal/comunicacao/eventos/mensagem-recebida", { providerMessageId: "m1", telefoneE164: "+5511999990000" });
    assert.equal(r.status, 200);
    assert.equal(recebidos.length, 1);
    assert.equal(recebidos[0].providerMessageId, "m1");
  });

  test("status-provider assinado é aceito", async () => {
    _resetarNonces();
    const r = await chamarAssinado("POST", "/internal/comunicacao/eventos/status-provider", { providerMessageId: "m1", status: "DELIVERED" });
    assert.equal(r.status, 200);
  });
});
