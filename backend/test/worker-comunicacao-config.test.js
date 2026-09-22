import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { lerIntervaloMs, carregarConfig, _INTERVALO_PADRAO_MS, _INTERVALO_MINIMO_MS } from "../src/worker-comunicacao/config.js";

describe("Checkpoint H.2-A — config do worker (fail-closed)", () => {
  test("ausente -> default (60000ms)", () => {
    assert.equal(lerIntervaloMs(undefined), _INTERVALO_PADRAO_MS);
    assert.equal(lerIntervaloMs(""), _INTERVALO_PADRAO_MS);
    assert.equal(lerIntervaloMs("   "), _INTERVALO_PADRAO_MS);
  });

  test("valor válido acima do mínimo -> usa o valor", () => {
    assert.equal(lerIntervaloMs("120000"), 120000);
    assert.equal(lerIntervaloMs(String(_INTERVALO_MINIMO_MS)), _INTERVALO_MINIMO_MS); // exatamente no mínimo
  });

  for (const invalido of ["0", "-1000", "60000.5", "abc", "NaN", "Infinity", "1e6", "60000x", "3000"]) {
    test(`inválido/abaixo do mínimo ("${invalido}") -> lança`, () => {
      assert.throws(() => lerIntervaloMs(invalido), /COMUNICACAO_WORKER_INTERVAL_MS/);
    });
  }

  test("mensagem de erro nomeia a variável ofensora", () => {
    assert.throws(() => lerIntervaloMs("-5"), (e) => e.message.includes("COMUNICACAO_WORKER_INTERVAL_MS"));
  });

  test("carregarConfig: monta intervalMs/gatewayUrl/segredoHmac/porta a partir de um env injetado", () => {
    const cfg = carregarConfig({
      COMUNICACAO_WORKER_INTERVAL_MS: "30000",
      WHATSAPP_GATEWAY_URL: "https://gateway.exemplo",
      WHATSAPP_GATEWAY_SECRET: "segredo-de-teste",
      PORT: "9090",
    });
    assert.deepEqual(cfg, {
      intervalMs: 30000, gatewayUrl: "https://gateway.exemplo", segredoHmac: "segredo-de-teste", porta: 9090,
    });
  });

  test("carregarConfig: propaga o erro fail-closed do intervalo inválido", () => {
    assert.throws(() => carregarConfig({ COMUNICACAO_WORKER_INTERVAL_MS: "0", WHATSAPP_GATEWAY_URL: "http://x", WHATSAPP_GATEWAY_SECRET: "s" }), /COMUNICACAO_WORKER_INTERVAL_MS/);
  });
});

describe("Checkpoint H.2-A.1 — provider (URL/HMAC) fail-closed no boot", () => {
  const BASE = { COMUNICACAO_WORKER_INTERVAL_MS: "60000" };

  test("WHATSAPP_GATEWAY_URL ausente -> lança", () => {
    assert.throws(() => carregarConfig({ ...BASE, WHATSAPP_GATEWAY_SECRET: "s" }), /WHATSAPP_GATEWAY_URL/);
  });

  test("WHATSAPP_GATEWAY_URL vazia/só espaços -> lança", () => {
    assert.throws(() => carregarConfig({ ...BASE, WHATSAPP_GATEWAY_URL: "", WHATSAPP_GATEWAY_SECRET: "s" }), /WHATSAPP_GATEWAY_URL/);
    assert.throws(() => carregarConfig({ ...BASE, WHATSAPP_GATEWAY_URL: "   ", WHATSAPP_GATEWAY_SECRET: "s" }), /WHATSAPP_GATEWAY_URL/);
  });

  test("WHATSAPP_GATEWAY_URL malformada -> lança", () => {
    assert.throws(() => carregarConfig({ ...BASE, WHATSAPP_GATEWAY_URL: "não-e-uma-url", WHATSAPP_GATEWAY_SECRET: "s" }), /WHATSAPP_GATEWAY_URL/);
  });

  test("WHATSAPP_GATEWAY_URL com esquema não permitido (javascript:/ftp:) -> lança", () => {
    assert.throws(() => carregarConfig({ ...BASE, WHATSAPP_GATEWAY_URL: "javascript:alert(1)", WHATSAPP_GATEWAY_SECRET: "s" }), /WHATSAPP_GATEWAY_URL/);
    assert.throws(() => carregarConfig({ ...BASE, WHATSAPP_GATEWAY_URL: "ftp://gateway.exemplo", WHATSAPP_GATEWAY_SECRET: "s" }), /WHATSAPP_GATEWAY_URL/);
  });

  test("WHATSAPP_GATEWAY_URL http:// é aceita (mesmo esquema do desenvolvimento local e da rede interna do Render)", () => {
    const cfg = carregarConfig({ ...BASE, WHATSAPP_GATEWAY_URL: "http://127.0.0.1:4000", WHATSAPP_GATEWAY_SECRET: "s" });
    assert.equal(cfg.gatewayUrl, "http://127.0.0.1:4000");
  });

  test("WHATSAPP_GATEWAY_URL https:// é aceita", () => {
    const cfg = carregarConfig({ ...BASE, WHATSAPP_GATEWAY_URL: "https://gateway.exemplo", WHATSAPP_GATEWAY_SECRET: "s" });
    assert.equal(cfg.gatewayUrl, "https://gateway.exemplo");
  });

  test("WHATSAPP_GATEWAY_SECRET ausente -> lança", () => {
    assert.throws(() => carregarConfig({ ...BASE, WHATSAPP_GATEWAY_URL: "http://x" }), /WHATSAPP_GATEWAY_SECRET/);
  });

  test("WHATSAPP_GATEWAY_SECRET vazio/só espaços -> lança", () => {
    assert.throws(() => carregarConfig({ ...BASE, WHATSAPP_GATEWAY_URL: "http://x", WHATSAPP_GATEWAY_SECRET: "" }), /WHATSAPP_GATEWAY_SECRET/);
    assert.throws(() => carregarConfig({ ...BASE, WHATSAPP_GATEWAY_URL: "http://x", WHATSAPP_GATEWAY_SECRET: "   " }), /WHATSAPP_GATEWAY_SECRET/);
  });

  test("mensagem de erro do segredo nunca ecoa nenhum valor (só nomeia a variável)", () => {
    assert.throws(() => carregarConfig({ ...BASE, WHATSAPP_GATEWAY_URL: "http://x" }),
      (e) => e.message.includes("WHATSAPP_GATEWAY_SECRET") && !e.message.includes("undefined:"));
  });

  test("config completa e válida -> carregarConfig não lança e devolve os 4 campos", () => {
    const cfg = carregarConfig({ ...BASE, WHATSAPP_GATEWAY_URL: "http://gateway-whatsapp:10000", WHATSAPP_GATEWAY_SECRET: "segredo-de-teste", PORT: "9090" });
    assert.deepEqual(cfg, { intervalMs: 60000, gatewayUrl: "http://gateway-whatsapp:10000", segredoHmac: "segredo-de-teste", porta: 9090 });
  });
});
