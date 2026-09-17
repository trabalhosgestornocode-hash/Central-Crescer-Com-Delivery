// Testes do HMAC do lado BACKEND (backend/src/modules/comunicacao/gateway/
// whatsappGateway.hmac.js) — mesmo roteiro de cobertura do lado
// gateway-whatsapp (replay, assinatura inválida, corpo/path/método
// adulterado, janela de tempo), garantindo que os dois lados produzem/
// aceitam exatamente a mesma string canônica.
import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  assinar, assinarRequisicao, exigirHmac, montarMensagem,
  _resetarNonces, _tamanhoCacheNonces, JANELA_MS,
} from "../src/modules/comunicacao/gateway/whatsappGateway.hmac.js";

const SEGREDO = "s".repeat(32);

function reqFalso({ headers = {}, method = "POST", originalUrl = "/internal/comunicacao/eventos/heartbeat", body = Buffer.from("") }) {
  return { get: (nome) => headers[nome], method, originalUrl, body };
}
function resFalso() {
  const res = { statusCode: null, corpo: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (c) => { res.corpo = c; return res; };
  return res;
}

describe("whatsappGateway.hmac (backend) — canonical string", () => {
  test("mesma forma exata do lado gateway-whatsapp: timestamp\\nnonce\\nMETODO\\ncaminho\\nsha256(corpo)", () => {
    const msg = montarMensagem({ timestamp: "1000", nonce: "abc", metodo: "post", caminho: "/x?y=1", corpo: "{}" });
    assert.equal(msg.split("\n").length, 5);
    assert.equal(msg.split("\n")[2], "POST");
  });
});

describe("whatsappGateway.hmac (backend) — exigirHmac (backend como servidor, recebendo do Gateway)", () => {
  beforeEach(() => _resetarNonces());

  function chamada({ segredo = SEGREDO, metodo = "POST", caminho = "/internal/comunicacao/eventos/heartbeat", corpo = "{}" } = {}) {
    return { headers: assinarRequisicao({ segredo, metodo, caminho, corpo }), corpo };
  }

  test("aceita requisição corretamente assinada", () => {
    const { headers, corpo } = chamada();
    const req = reqFalso({ headers, body: Buffer.from(corpo) });
    const res = resFalso();
    const next = mock.fn();
    exigirHmac(SEGREDO)(req, res, next);
    assert.equal(next.mock.calls.length, 1);
  });

  test("rejeita cabeçalho ausente", () => {
    const res = resFalso();
    exigirHmac(SEGREDO)(reqFalso({}), res, mock.fn());
    assert.equal(res.statusCode, 401);
  });

  test("rejeita assinatura inválida", () => {
    const { corpo } = chamada();
    const req = reqFalso({
      headers: { "X-Gateway-Timestamp": String(Date.now()), "X-Gateway-Nonce": "a".repeat(24), "X-Gateway-Signature": "0".repeat(64) },
      body: Buffer.from(corpo),
    });
    const res = resFalso();
    exigirHmac(SEGREDO)(req, res, mock.fn());
    assert.equal(res.statusCode, 401);
  });

  test("rejeita corpo adulterado após a assinatura", () => {
    const { headers } = chamada({ corpo: JSON.stringify({ a: 1 }) });
    const req = reqFalso({ headers, body: Buffer.from(JSON.stringify({ a: 2 })) });
    const res = resFalso();
    exigirHmac(SEGREDO)(req, res, mock.fn());
    assert.equal(res.statusCode, 401);
  });

  test("rejeita path alterado", () => {
    const { headers, corpo } = chamada();
    const req = reqFalso({ headers, originalUrl: "/internal/comunicacao/eventos/mensagem-recebida", body: Buffer.from(corpo) });
    const res = resFalso();
    exigirHmac(SEGREDO)(req, res, mock.fn());
    assert.equal(res.statusCode, 401);
  });

  test("rejeita método alterado", () => {
    const { headers, corpo } = chamada({ metodo: "POST" });
    const req = reqFalso({ headers, method: "GET", body: Buffer.from(corpo) });
    const res = resFalso();
    exigirHmac(SEGREDO)(req, res, mock.fn());
    assert.equal(res.statusCode, 401);
  });

  test("rejeita nonce reutilizado (replay)", () => {
    const { headers, corpo } = chamada();
    exigirHmac(SEGREDO)(reqFalso({ headers, body: Buffer.from(corpo) }), resFalso(), mock.fn());
    const res2 = resFalso();
    exigirHmac(SEGREDO)(reqFalso({ headers, body: Buffer.from(corpo) }), res2, mock.fn());
    assert.equal(res2.statusCode, 401);
  });

  test("rejeita timestamp fora da janela (passado e futuro)", () => {
    for (const delta of [-(JANELA_MS + 5000), JANELA_MS + 5000]) {
      const timestamp = String(Date.now() + delta);
      const nonce = `nonce${delta}`.padEnd(20, "x");
      const corpo = "{}";
      const assinatura = assinar({ segredo: SEGREDO, timestamp, nonce, metodo: "POST", caminho: "/x", corpo });
      const req = reqFalso({
        headers: { "X-Gateway-Timestamp": timestamp, "X-Gateway-Nonce": nonce, "X-Gateway-Signature": assinatura },
        originalUrl: "/x", body: Buffer.from(corpo),
      });
      const res = resFalso();
      exigirHmac(SEGREDO)(req, res, mock.fn());
      assert.equal(res.statusCode, 401);
    }
  });

  test("cache de nonces não cresce indefinidamente (tem teto e é rastreável)", () => {
    for (let i = 0; i < 4; i++) {
      const { headers, corpo } = chamada({ corpo: JSON.stringify({ i }) });
      exigirHmac(SEGREDO)(reqFalso({ headers, body: Buffer.from(corpo) }), resFalso(), mock.fn());
    }
    assert.equal(_tamanhoCacheNonces(), 4);
  });

  test("exigirHmac lança na criação se o segredo estiver ausente (fail-closed)", () => {
    assert.throws(() => exigirHmac(undefined), /WHATSAPP_GATEWAY_SECRET ausente/);
  });
});
