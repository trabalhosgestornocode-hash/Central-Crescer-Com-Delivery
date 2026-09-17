// Testes do BaileysGatewayProvider — sobe um servidor HTTP local (SEM
// Baileys, sem WhatsApp real) que simula respostas do gateway-whatsapp, e
// verifica: mapeamento dos 9 métodos do contrato, timeout, HTTP 4xx/5xx,
// resposta malformada, erro de rede, e a classificação RETRYAVEL/
// PERMANENTE/INCERTO (via preEnvio/permanente) exigida por
// comunicacao.entrega.js#classificarErroEnvio.
import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { criarBaileysGatewayProvider } from "../src/modules/comunicacao/providers/baileysGateway.provider.js";
import { exigirHmac } from "../src/modules/comunicacao/gateway/whatsappGateway.hmac.js";
import { classificarErroEnvio, permiteRetryAutomatico } from "../src/modules/comunicacao/comunicacao.entrega.js";
import { CLASSIFICACAO_ERRO } from "../src/modules/comunicacao/comunicacao.constants.js";
import express from "express";

const SEGREDO = "s".repeat(32);

describe("BaileysGatewayProvider — contrato e classificação de erro", () => {
  let servidor;
  let baseUrl;
  let respostaProgramada;
  let atrasoMs = 0;

  before(async () => {
    const app = express();
    app.use(express.raw({ type: "*/*", limit: 256 * 1024 }), exigirHmac(SEGREDO), (req, res) => {
      setTimeout(() => {
        const { status, corpo } = respostaProgramada();
        res.status(status).json(corpo);
      }, atrasoMs);
    });
    await new Promise((resolve) => { servidor = createServer(app).listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  });
  after(() => servidor.close());

  function providerComResposta(fn, { timeoutMs = 15_000 } = {}) {
    respostaProgramada = fn;
    return criarBaileysGatewayProvider({ gatewayUrl: baseUrl, segredoHmac: SEGREDO, timeoutMs });
  }

  test("implementa os 9 métodos exigidos pelo contrato WhatsAppProvider", () => {
    const provider = providerComResposta(() => ({ status: 200, corpo: {} }));
    for (const m of ["connect", "disconnect", "getStatus", "sendText", "sendImage", "sendDocument", "onMessage", "markAsRead", "getMessageStatus"]) {
      assert.equal(typeof provider[m], "function", `esperava método ${m}`);
    }
  });

  test("getStatus mapeia para GET /internal/whatsapp/status e devolve o corpo", async () => {
    const provider = providerComResposta(() => ({ status: 200, corpo: { conectado: true, provider: "baileys" } }));
    const r = await provider.getStatus();
    assert.equal(r.conectado, true);
  });

  test("sendText bem-sucedido devolve providerMessageId/enviadoEm", async () => {
    const provider = providerComResposta(() => ({ status: 200, corpo: { providerMessageId: "wa-1", enviadoEm: "now" } }));
    const r = await provider.sendText({ telefoneE164: "+5511999990000", texto: "oi", idempotencyKey: "k1" });
    assert.equal(r.providerMessageId, "wa-1");
  });

  test("HTTP 409 WHATSAPP_GATEWAY_NOT_CONNECTED -> preEnvio=true -> RETRYAVEL", async () => {
    const provider = providerComResposta(() => ({ status: 409, corpo: { error: "WHATSAPP_GATEWAY_NOT_CONNECTED" } }));
    await assert.rejects(
      () => provider.sendText({ telefoneE164: "+5511999990000", texto: "oi", idempotencyKey: "k1" }),
      (e) => {
        assert.equal(e.preEnvio, true);
        assert.equal(classificarErroEnvio(e), CLASSIFICACAO_ERRO.RETRYAVEL);
        assert.equal(permiteRetryAutomatico(classificarErroEnvio(e)), true);
        return true;
      },
    );
  });

  test("HTTP 410 WHATSAPP_GATEWAY_LOGGED_OUT -> preEnvio+permanente -> PERMANENTE (nunca retry)", async () => {
    const provider = providerComResposta(() => ({ status: 410, corpo: { error: "WHATSAPP_GATEWAY_LOGGED_OUT" } }));
    await assert.rejects(
      () => provider.sendText({ telefoneE164: "+5511999990000", texto: "oi", idempotencyKey: "k1" }),
      (e) => {
        assert.equal(classificarErroEnvio(e), CLASSIFICACAO_ERRO.PERMANENTE);
        assert.equal(permiteRetryAutomatico(classificarErroEnvio(e)), false);
        return true;
      },
    );
  });

  test("HTTP 400 WHATSAPP_GATEWAY_INVALID_MESSAGE -> PERMANENTE", async () => {
    const provider = providerComResposta(() => ({ status: 400, corpo: { error: "WHATSAPP_GATEWAY_INVALID_MESSAGE" } }));
    await assert.rejects(
      () => provider.sendText({ telefoneE164: "+5511999990000", texto: "oi", idempotencyKey: "k1" }),
      (e) => { assert.equal(classificarErroEnvio(e), CLASSIFICACAO_ERRO.PERMANENTE); return true; },
    );
  });

  test("HTTP 502 (falha no envio já tentado) -> SEM marcação -> INCERTO, NUNCA retry automático", async () => {
    const provider = providerComResposta(() => ({ status: 502, corpo: { error: "WHATSAPP_GATEWAY_SEND_FAILED" } }));
    await assert.rejects(
      () => provider.sendText({ telefoneE164: "+5511999990000", texto: "oi", idempotencyKey: "k1" }),
      (e) => {
        assert.equal(e.preEnvio, undefined);
        assert.equal(e.permanente, undefined);
        assert.equal(classificarErroEnvio(e), CLASSIFICACAO_ERRO.INCERTO);
        assert.equal(permiteRetryAutomatico(classificarErroEnvio(e)), false);
        return true;
      },
    );
  });

  test("resposta malformada (corpo não é JSON válido) não derruba o provider", async () => {
    respostaProgramada = null; // força um handler cru abaixo
    const app2 = express();
    app2.use(express.raw({ type: "*/*", limit: 256 * 1024 }), exigirHmac(SEGREDO), (req, res) => {
      res.status(200).setHeader("content-type", "application/json").end("{ isso nao é json");
    });
    const s2 = await new Promise((resolve) => { const srv = createServer(app2).listen(0, () => resolve(srv)); });
    const provider = criarBaileysGatewayProvider({ gatewayUrl: `http://127.0.0.1:${s2.address().port}`, segredoHmac: SEGREDO });
    const r = await provider.getStatus(); // 200 com corpo ilegível -> json vira {}
    assert.deepEqual(r, {});
    s2.close();
  });

  test("timeout (sem resposta) -> SEM marcação -> INCERTO (Gateway pode já ter processado)", async () => {
    atrasoMs = 200;
    const provider = providerComResposta(() => ({ status: 200, corpo: {} }), { timeoutMs: 30 });
    await assert.rejects(
      () => provider.sendText({ telefoneE164: "+5511999990000", texto: "oi", idempotencyKey: "k1" }),
      (e) => {
        assert.equal(e.preEnvio, undefined);
        assert.equal(e.permanente, undefined);
        assert.equal(classificarErroEnvio(e), CLASSIFICACAO_ERRO.INCERTO);
        return true;
      },
    );
    atrasoMs = 0;
  });

  test("erro de rede (gateway inalcançável) -> preEnvio=true -> RETRYAVEL", async () => {
    const provider = criarBaileysGatewayProvider({ gatewayUrl: "http://127.0.0.1:1", segredoHmac: SEGREDO, timeoutMs: 2000 });
    await assert.rejects(
      () => provider.sendText({ telefoneE164: "+5511999990000", texto: "oi", idempotencyKey: "k1" }),
      (e) => { assert.equal(e.preEnvio, true); assert.equal(classificarErroEnvio(e), CLASSIFICACAO_ERRO.RETRYAVEL); return true; },
    );
  });

  test("gatewayUrl/segredo ausentes -> preEnvio=true, nunca tenta rede", async () => {
    const provider = criarBaileysGatewayProvider({ gatewayUrl: "", segredoHmac: "" });
    await assert.rejects(
      () => provider.sendText({ telefoneE164: "+5511999990000", texto: "oi", idempotencyKey: "k1" }),
      (e) => { assert.equal(e.preEnvio, true); return true; },
    );
  });

  test("onMessage + _receberEventoMensagem entrega o evento aos handlers registrados", () => {
    const provider = providerComResposta(() => ({ status: 200, corpo: {} }));
    const recebidos = [];
    provider.onMessage((m) => recebidos.push(m));
    provider._receberEventoMensagem({ providerMessageId: "m1" });
    assert.equal(recebidos.length, 1);
    assert.equal(recebidos[0].providerMessageId, "m1");
  });
});
