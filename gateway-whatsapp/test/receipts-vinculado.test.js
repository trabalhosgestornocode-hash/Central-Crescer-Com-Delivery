// Receipts contrato v2 ("VINCULADO"): o Gateway leva providerInstanceId + correlationId (idempotencyKey do envio) quando ambos existem; senão v1 legado.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { criarObservadorEntrega } from "../src/entregaProvider.js";

const PN = "5511888880001@s.whatsapp.net";
const INSTANCIA = "instancia-saci-01";
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function montar({ resultados = [], providerInstanceId = INSTANCIA, semInstancia = false } = {}) {
  const chamadas = []; const logs = []; const agendados = [];
  const fila = [...resultados];
  const opcoes = {
    notificar: async (p) => { chamadas.push(p); const r = fila.length ? fila.shift() : { resultado: "APLICADO" }; if (r instanceof Error) throw r; return r; },
    emitir: (nivel, evento, dados) => logs.push({ nivel, evento, dados }),
    agora: () => 1_700_000_000_000,
    agendar: (fn, ms) => { const h = { fn, ms, unref() {} }; agendados.push(h); return h; },
    cancelar: () => {},
  };
  if (!semInstancia) opcoes.providerInstanceId = providerInstanceId;
  return { obs: criarObservadorEntrega(opcoes), chamadas, logs, agendados };
}
const chaves = (o) => Object.keys(o).sort();
const BASE_V2 = ["ackTipo", "contratoStatus", "correlationId", "ocorridoEm", "providerInstanceId", "providerMessageId", "status"];
const BASE_V1 = ["ackTipo", "contratoStatus", "ocorridoEm", "providerMessageId", "status"];

describe("v2 vinculado: formato do payload", () => {
  test("com instancia + correlationId rastreado: contratoStatus 2 e exatamente as chaves do contrato", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "3EB0A", correlationId: "chave-envio-1" });
    t.obs.aoReceiptWs({ attrs: { id: "3EB0A", from: PN } });
    await tick();
    assert.equal(t.chamadas.length, 1);
    const p = t.chamadas[0];
    assert.equal(p.contratoStatus, 2);
    assert.equal(p.providerInstanceId, INSTANCIA);
    assert.equal(p.correlationId, "chave-envio-1");
    assert.equal(p.providerMessageId, "3EB0A");
    assert.equal(p.status, "DELIVERED");
    assert.equal(p.ackTipo, "entrega");
    assert.equal(p.ocorridoEm, new Date(1_700_000_000_000).toISOString());
    assert.deepEqual(chaves(p), BASE_V2);
  });
  test("SERVER_ACK, DELIVERED, READ e PROVIDER_ERROR carregam os campos v2; erroCodigo so no PROVIDER_ERROR", async () => {
    const t = montar();
    for (const id of ["S", "D", "R", "E"]) t.obs.rastrear({ providerMessageId: id, correlationId: `k-${id}` });
    t.obs.aoAckWs({ attrs: { id: "S", class: "message" } });
    t.obs.aoMessagesUpdate([{ key: { id: "D", fromMe: true, remoteJid: PN }, update: { status: 3 } }]);
    t.obs.aoReceiptWs({ attrs: { id: "R", from: PN, type: "read" } });
    t.obs.aoAckWs({ attrs: { id: "E", class: "message", error: "479" } });
    await tick();
    const por = Object.fromEntries(t.chamadas.map((c) => [c.status, c]));
    assert.deepEqual(Object.keys(por).sort(), ["DELIVERED", "PROVIDER_ERROR", "READ", "SERVER_ACK"]);
    for (const [st, id] of [["SERVER_ACK", "S"], ["DELIVERED", "D"], ["READ", "R"], ["PROVIDER_ERROR", "E"]]) {
      assert.equal(por[st].contratoStatus, 2, st);
      assert.equal(por[st].providerInstanceId, INSTANCIA, st);
      assert.equal(por[st].correlationId, `k-${id}`, st);
      assert.deepEqual(chaves(por[st]), st === "PROVIDER_ERROR" ? [...BASE_V2, "erroCodigo"].sort() : BASE_V2, st);
    }
    assert.equal(por.PROVIDER_ERROR.erroCodigo, "479");
  });
});

describe("fallback v1 legado", () => {
  test("id rastreado SEM correlationId => v1 exatamente como antes", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "M1" }); t.obs.rastrear({ providerMessageId: "M2", correlationId: "" });
    t.obs.aoReceiptWs({ attrs: { id: "M1", from: PN } }); t.obs.aoReceiptWs({ attrs: { id: "M2", from: PN } });
    await tick();
    assert.equal(t.chamadas.length, 2);
    for (const p of t.chamadas) { assert.equal(p.contratoStatus, 1); assert.deepEqual(chaves(p), BASE_V1); }
  });
  test("observador SEM providerInstanceId (ausente ou null) => v1 mesmo com correlationId rastreado", async () => {
    for (const providerInstanceId of [undefined, null, ""]) {
      const t = montar({ providerInstanceId, semInstancia: providerInstanceId === undefined }); t.obs.rastrear({ providerMessageId: "M1", correlationId: "k1" });
      t.obs.aoReceiptWs({ attrs: { id: "M1", from: PN, type: "read" } });
      await tick();
      assert.equal(t.chamadas.length, 1);
      assert.equal(t.chamadas[0].contratoStatus, 1);
      assert.deepEqual(chaves(t.chamadas[0]), BASE_V1);
      assert.equal(JSON.stringify(t.chamadas[0]).includes("k1"), false);
    }
  });
  test("v1 PROVIDER_ERROR mantem erroCodigo e nenhuma chave v2", async () => {
    const t = montar({ providerInstanceId: null }); t.obs.rastrear({ providerMessageId: "E" });
    t.obs.aoAckWs({ attrs: { id: "E", class: "message", error: "500" } });
    await tick();
    assert.deepEqual(chaves(t.chamadas[0]), [...BASE_V1, "erroCodigo"].sort());
  });
});

describe("correlacao por id", () => {
  test("dois ids rastreados com chaves diferentes nunca trocam o correlationId (qualquer ordem/fonte)", async () => {
    const t = montar();
    t.obs.rastrear({ providerMessageId: "A", correlationId: "chave-A" });
    t.obs.rastrear({ providerMessageId: "B", correlationId: "chave-B" });
    t.obs.aoReceiptWs({ attrs: { id: "B", from: PN, type: "read" } });
    t.obs.aoReceiptWs({ attrs: { id: "A", from: PN } });
    t.obs.aoAckWs({ attrs: { id: "B", class: "message" } });
    t.obs.aoMessagesUpdate([{ key: { id: "A", fromMe: true, remoteJid: PN }, update: { status: 2 } }]);
    await tick();
    assert.equal(t.chamadas.length, 4);
    for (const c of t.chamadas) assert.equal(c.correlationId, `chave-${c.providerMessageId}`);
  });
  test("re-rastrear o mesmo id com nova chave usa a chave mais recente para ESSE id, sem afetar o outro", async () => {
    const t = montar();
    t.obs.rastrear({ providerMessageId: "A", correlationId: "velha" }); t.obs.rastrear({ providerMessageId: "B", correlationId: "chave-B" });
    t.obs.rastrear({ providerMessageId: "A", correlationId: "nova" });
    t.obs.aoReceiptWs({ attrs: { id: "A", from: PN } }); t.obs.aoReceiptWs({ attrs: { id: "B", from: PN } });
    await tick();
    assert.deepEqual(t.chamadas.map((c) => [c.providerMessageId, c.correlationId]), [["A", "nova"], ["B", "chave-B"]]);
  });
  test("id NAO rastreado nunca e encaminhado (nenhum payload v2 inventado), nem com outros ids rastreados", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "A", correlationId: "chave-A" });
    t.obs.aoReceiptWs({ attrs: { id: "X", from: PN, type: "read" } });
    t.obs.aoAckWs({ attrs: { id: "X", class: "message" } });
    t.obs.aoMessagesUpdate([{ key: { id: "X", fromMe: true, remoteJid: PN }, update: { status: 3 } }]);
    t.obs.aoMessageReceiptUpdate([{ key: { id: "X", fromMe: true }, receipt: { readTimestamp: 1_700_000_000 } }]);
    await tick();
    assert.equal(t.chamadas.length, 0);
    assert.equal(t.obs.metricas().naoRastreados, 4);
  });
});

describe("retry e sigilo", () => {
  test("retry apos NAO_ENCONTRADA reenvia o MESMO payload v2 (mesma instancia e correlationId) em todas as tentativas", async () => {
    const t = montar({ resultados: [{ resultado: "NAO_ENCONTRADA" }, { resultado: "NAO_ENCONTRADA" }, { resultado: "APLICADO" }] });
    t.obs.rastrear({ providerMessageId: "M1", correlationId: "chave-1" });
    t.obs.aoReceiptWs({ attrs: { id: "M1", from: PN, type: "read" } });
    await tick(); t.agendados[0].fn(); await tick(); t.agendados[1].fn(); await tick();
    assert.equal(t.chamadas.length, 3);
    assert.equal(t.chamadas[0].contratoStatus, 2);
    assert.deepEqual(t.chamadas[1], t.chamadas[0]);
    assert.deepEqual(t.chamadas[2], t.chamadas[0]);
    assert.equal(t.obs.metricas().persistidos, 1);
  });
  test("payload nunca contem segredo, telefone ou JID (mesmo com jidMascarado e remoteJid completo nos sinais)", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "M1", correlationId: "chave-1", jidMascarado: "+55••01" });
    t.obs.aoReceiptWs({ attrs: { id: "M1", from: PN, type: "read", participant: PN } });
    t.obs.aoMessagesUpdate([{ key: { id: "M1", fromMe: true, remoteJid: PN }, update: { status: 3 } }]);
    t.obs.aoAckWs({ attrs: { id: "M1", class: "message", from: PN } });
    await tick();
    assert.ok(t.chamadas.length >= 3);
    for (const p of t.chamadas) {
      const s = JSON.stringify(p);
      assert.equal(/@s\.whatsapp\.net|@lid|@g\.us|5511888880001|••|secret|segredo|token|hmac|authorization/i.test(s), false, s);
      assert.deepEqual(chaves(p).filter((k) => !BASE_V2.includes(k)), []);
    }
  });
});
