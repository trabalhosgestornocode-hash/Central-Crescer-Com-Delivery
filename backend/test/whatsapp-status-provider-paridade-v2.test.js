// Paridade do contrato v2 (vinculado): todo payload v2 do observador do Gateway passa no validador do backend, com instancia/correlacao preservadas.
process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x";
process.env.SUPABASE_ANON_KEY ??= "x";
process.env.NODE_ENV ??= "test";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validarEventoStatusProvider, CONTRATO_STATUS_VERSAO_VINCULADO } from "../src/modules/comunicacao/comunicacao.statusProvider.js";
import { criarObservadorEntrega, CONTRATO_STATUS_VERSAO_VINCULADO as GW_V2 } from "../../gateway-whatsapp/src/entregaProvider.js";

const INSTANCIA = "instancia-saci-01";
const PN = "5511888880001@s.whatsapp.net";
const tick = () => new Promise((r) => setImmediate(r));

async function gerar() {
  const payloads = [];
  const obs = criarObservadorEntrega({ notificar: async (p) => { payloads.push(p); return { resultado: "APLICADO" }; }, emitir() {}, providerInstanceId: INSTANCIA });
  for (const id of ["S", "D", "R", "E"]) obs.rastrear({ providerMessageId: `3EB0${id}`, correlationId: `saida:org-1:msg-${id}` });
  obs.aoAckWs({ attrs: { id: "3EB0S", class: "message", t: "1700000000", from: PN } });
  obs.aoMessagesUpdate([{ key: { id: "3EB0D", fromMe: true, remoteJid: PN }, update: { status: 3 } }]);
  obs.aoReceiptWs({ attrs: { id: "3EB0R", type: "read", t: "1700000000" } });
  obs.aoAckWs({ attrs: { id: "3EB0E", class: "message", error: "479" } });
  await tick();
  return payloads;
}

describe("paridade v2 Gateway <-> backend", () => {
  test("a versao vinculada e a mesma nos dois lados", () => {
    assert.equal(GW_V2, 2);
    assert.equal(GW_V2, CONTRATO_STATUS_VERSAO_VINCULADO);
  });
  test("os 4 status v2 do Gateway validam ok e o evento carrega a mesma instancia/correlacao", async () => {
    const payloads = await gerar();
    assert.equal(payloads.length, 4);
    assert.deepEqual(payloads.map((p) => p.status).sort(), ["DELIVERED", "PROVIDER_ERROR", "READ", "SERVER_ACK"]);
    for (const p of payloads) {
      assert.equal(p.contratoStatus, 2);
      const v = validarEventoStatusProvider(p);
      assert.equal(v.ok, true, JSON.stringify(p) + JSON.stringify(v));
      assert.equal(v.evento.providerInstanceId, p.providerInstanceId);
      assert.equal(v.evento.correlationId, p.correlationId);
      assert.equal(v.evento.providerInstanceId, INSTANCIA);
      assert.equal(v.evento.contrato, 2);
      assert.equal(v.evento.providerMessageId, p.providerMessageId);
      assert.equal(v.evento.status, p.status);
    }
  });
  test("v2 do Gateway sem uma das duas chaves seria rejeitado pelo backend (o Gateway nunca emite v2 parcial)", async () => {
    const [p] = await gerar();
    const { providerInstanceId, ...semInstancia } = p;
    const { correlationId, ...semCorrelacao } = p;
    assert.deepEqual(validarEventoStatusProvider(semInstancia), { ok: false, erro: "providerInstanceId_ausente" });
    assert.deepEqual(validarEventoStatusProvider(semCorrelacao), { ok: false, erro: "correlationId_ausente" });
  });
  test("v1 do Gateway (sem instancia) continua valido e sem chaves v2 no evento", async () => {
    const payloads = [];
    const obs = criarObservadorEntrega({ notificar: async (p) => { payloads.push(p); return { resultado: "APLICADO" }; }, emitir() {} });
    obs.rastrear({ providerMessageId: "3EB0Z", correlationId: "k" });
    obs.aoReceiptWs({ attrs: { id: "3EB0Z", type: "read" } });
    await tick();
    const v = validarEventoStatusProvider(payloads[0]);
    assert.equal(v.ok, true);
    assert.equal("providerInstanceId" in v.evento, false);
    assert.equal("correlationId" in v.evento, false);
  });
});
