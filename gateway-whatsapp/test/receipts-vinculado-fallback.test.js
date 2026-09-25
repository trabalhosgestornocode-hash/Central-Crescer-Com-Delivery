// Receipts v2 — rollout seguro em QUALQUER ordem de deploy: se o backend recusar o v2 (400: backend ainda antigo ou contrato divergente), o Gateway NÃO perde o
// receipt: reenvia UMA vez como v1 legado (que só alcança a org da conexão — fail-closed). Também registra quando um receipt sai sem vínculo (v1) para não ser silencioso.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { criarObservadorEntrega } from "../src/entregaProvider.js";

const PN = "5511888880001@s.whatsapp.net";
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const erro400 = () => Object.assign(new Error("recusado"), { detalheInterno: { status: 400 } });

function montar({ resultados = [] } = {}) {
  const chamadas = []; const logs = []; const fila = [...resultados];
  const obs = criarObservadorEntrega({
    notificar: async (p) => { chamadas.push(JSON.parse(JSON.stringify(p))); const r = fila.length ? fila.shift() : { resultado: "APLICADO" }; if (r instanceof Error) throw r; return r; },
    emitir: (nivel, evento, dados) => logs.push({ nivel, evento, dados }),
    providerInstanceId: "default", agora: () => 1_700_000_000_000, agendar: (fn, ms) => ({ fn, ms, unref() {} }), cancelar: () => {},
  });
  return { obs, chamadas, logs };
}

describe("v2 recusado pelo backend => reenvio único como v1", () => {
  test("backend antigo responde 400 ao v2 => o MESMO receipt sai como v1 (sem campos do v2) e é persistido; não fica preso", async () => {
    const t = montar({ resultados: [erro400(), { resultado: "APLICADO" }] });
    t.obs.rastrear({ providerMessageId: "M1", correlationId: "wa:manual:x:v1" });
    t.obs.aoReceiptWs({ attrs: { id: "M1", from: PN } });
    await tick();
    assert.equal(t.chamadas.length, 2);
    assert.equal(t.chamadas[0].contratoStatus, 2); assert.equal(t.chamadas[0].correlationId, "wa:manual:x:v1");
    assert.equal(t.chamadas[1].contratoStatus, 1);
    assert.ok(!("providerInstanceId" in t.chamadas[1]) && !("correlationId" in t.chamadas[1]), "o reenvio v1 não carrega os campos do v2");
    assert.equal(t.chamadas[1].providerMessageId, "M1"); assert.equal(t.chamadas[1].status, "DELIVERED");
    assert.ok(t.logs.some((l) => l.evento === "provider_receipt_v2_recusado_reenviando_v1" && l.nivel === "warn"));
    assert.ok(t.logs.some((l) => l.evento === "provider_receipt_persistido"));
    assert.equal(t.obs.metricas().rejeitados, 0, "não contou como rejeitado: foi entregue no v1");
  });
  test("se o v1 TAMBÉM levar 400 => para (sem laço): 1 v2 + 1 v1, contado como rejeitado", async () => {
    const t = montar({ resultados: [erro400(), erro400()] });
    t.obs.rastrear({ providerMessageId: "M2", correlationId: "wa:manual:y:v1" });
    t.obs.aoReceiptWs({ attrs: { id: "M2", from: PN, type: "read" } });
    await tick();
    assert.equal(t.chamadas.length, 2); assert.deepEqual(t.chamadas.map((c) => c.contratoStatus), [2, 1]);
    assert.equal(t.obs.metricas().rejeitados, 1);
  });
  test("400 num receipt que já era v1 (sem correlationId) => sem reenvio extra (comportamento antigo)", async () => {
    const t = montar({ resultados: [erro400()] });
    t.obs.rastrear({ providerMessageId: "M3" });
    t.obs.aoReceiptWs({ attrs: { id: "M3", from: PN } });
    await tick();
    assert.equal(t.chamadas.length, 1); assert.equal(t.chamadas[0].contratoStatus, 1); assert.equal(t.obs.metricas().rejeitados, 1);
  });
  test("resposta NAO_ENCONTRADA ao v2 NÃO faz fallback para v1 (não é recusa de contrato): segue o retry limitado com o MESMO v2", async () => {
    const agendados = [];
    const chamadas = [];
    const obs = criarObservadorEntrega({
      notificar: async (p) => { chamadas.push(p); return { resultado: "NAO_ENCONTRADA" }; }, emitir: () => {}, providerInstanceId: "default",
      agora: () => 1_700_000_000_000, agendar: (fn, ms) => { const h = { fn, ms, unref() {} }; agendados.push(h); return h; }, cancelar: () => {},
    });
    obs.rastrear({ providerMessageId: "M4", correlationId: "wa:manual:z:v1" });
    obs.aoReceiptWs({ attrs: { id: "M4", from: PN } });
    await tick(); agendados[0].fn(); await tick();
    assert.deepEqual(chamadas.map((c) => c.contratoStatus), [2, 2]);
  });
});

describe("receipt sem vínculo (v1) é CONTADO — não é silencioso", () => {
  test("id rastreado sem correlationId => legado contado; com correlationId => não conta", async () => {
    const t = montar();
    t.obs.rastrear({ providerMessageId: "A" }); t.obs.rastrear({ providerMessageId: "B", correlationId: "k-b" });
    t.obs.aoReceiptWs({ attrs: { id: "A", from: PN } }); t.obs.aoReceiptWs({ attrs: { id: "B", from: PN } });
    await tick();
    assert.equal(t.obs.metricas().legados, 1);
  });
});
