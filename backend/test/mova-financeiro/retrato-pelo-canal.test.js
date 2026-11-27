// 27/11 (PR #236) — cliente do retrato dos membros (aviso diário): POST assinado (HMAC do canal do MOVA) em /internal/mova/membros.
// Servidor HTTP local com o MESMO verificador HMAC; nada sai da máquina. Falha, recusa ou resposta malformada ⇒ null (sem valores no aviso).
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { exigirHmac } from "../../src/modules/comunicacao/gateway/whatsappGateway.hmac.js";
import { criarRetratoPeloCanal } from "../../src/modules/fv2-integracao/mova.js";

const SEGREDO = "segredo-sintetico-do-canal-mova-0123456789";
const GRUPO = "120363000000000001@g.us";

async function servidor(responder) {
  const pedidos = [];
  const app = express();
  app.post("/internal/mova/membros", express.raw({ type: "*/*", limit: 4 * 1024 }), exigirHmac(SEGREDO), (req, res) => { pedidos.push(req.corpoJson); responder(req, res); });
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  return { url: `http://127.0.0.1:${srv.address().port}`, pedidos, fechar: () => new Promise((r) => srv.close(r)) };
}

test("RPC1 pedido assinado aceito pelo verificador; devolve só membros (strings) e verificadoEm", async () => {
  const s = await servidor((req, res) => res.json({ membros: ["5500000000001@s.whatsapp.net", 42, "5500000000002@s.whatsapp.net"], verificadoEm: "2026-11-27T13:00:00.000Z", extra: "ignorado" }));
  try {
    const r = await criarRetratoPeloCanal({ gatewayUrl: `${s.url}/`, segredo: SEGREDO })(GRUPO);
    assert.deepEqual(r, { membros: ["5500000000001@s.whatsapp.net", "5500000000002@s.whatsapp.net"], verificadoEm: "2026-11-27T13:00:00.000Z" });
    assert.deepEqual(s.pedidos, [{ grupoJid: GRUPO }], "o corpo leva só o grupo");
  } finally { await s.fechar(); }
});

test("RPC2 segredo errado (401), Gateway sem retrato (503), resposta malformada, Gateway fora ou lento ⇒ null", async () => {
  const ok = await servidor((req, res) => res.json({ membros: ["a@s.whatsapp.net"], verificadoEm: "2026-11-27T13:00:00.000Z" }));
  const indisponivel = await servidor((req, res) => res.status(503).json({ error: "MOVA_RETRATO_INDISPONIVEL" }));
  const malformada = await servidor((req, res) => res.json({ membros: "todos", verificadoEm: 1 }));
  const lento = await servidor(() => { /* nunca responde */ });
  try {
    assert.equal(await criarRetratoPeloCanal({ gatewayUrl: ok.url, segredo: "outro-segredo-qualquer-0123456789abcdef" })(GRUPO), null);
    assert.equal(ok.pedidos.length, 0, "o verificador recusou antes do handler");
    assert.equal(await criarRetratoPeloCanal({ gatewayUrl: indisponivel.url, segredo: SEGREDO })(GRUPO), null);
    assert.equal(await criarRetratoPeloCanal({ gatewayUrl: malformada.url, segredo: SEGREDO })(GRUPO), null);
    assert.equal(await criarRetratoPeloCanal({ gatewayUrl: "http://127.0.0.1:9", segredo: SEGREDO })(GRUPO), null);
    assert.equal(await criarRetratoPeloCanal({ gatewayUrl: lento.url, segredo: SEGREDO, timeoutMs: 200 })(GRUPO), null);
  } finally { for (const s of [ok, indisponivel, malformada, lento]) await s.fechar().catch(() => {}); }
});
