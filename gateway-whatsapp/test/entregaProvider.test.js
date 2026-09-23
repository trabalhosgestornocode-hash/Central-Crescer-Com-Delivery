// H.4-B.4 — observador de entrega: mapeamento dos sinais do Baileys, rastreio, dedupe, retry limitado, sem vazamento nos logs.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  criarObservadorEntrega, classificarStatusBaileys, classificarTipoReceipt, tipoDeJid, STATUS_EVENTO, STATUS_BAILEYS, CONTRATO_STATUS_VERSAO,
} from "../src/entregaProvider.js";

const PN = "5511888880001@s.whatsapp.net";
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function montar({ resultados = [], contexto = () => ({ socketGeneration: 3, leaseEpoch: 12 }), atrasosRetryMs } = {}) {
  const chamadas = []; const logs = []; const agendados = [];
  let relogio = 1_700_000_000_000;
  const fila = [...resultados];
  const obs = criarObservadorEntrega({
    notificar: async (p) => {
      chamadas.push(p);
      const r = fila.length ? fila.shift() : { resultado: "APLICADO" };
      if (r instanceof Error) throw r;
      return r;
    },
    emitir: (nivel, evento, dados) => logs.push({ nivel, evento, dados }),
    contexto, agora: () => relogio,
    agendar: (fn, ms) => { const h = { fn, ms, unref() {} }; agendados.push(h); return h; },
    cancelar: (h) => { h.cancelado = true; },
    ...(atrasosRetryMs ? { atrasosRetryMs } : {}),
  });
  return { obs, chamadas, logs, agendados, avancar: (ms) => { relogio += ms; } };
}
const erroHttp = (status) => Object.assign(new Error("INDISPONIVEL"), { codigo: "WHATSAPP_GATEWAY_UNAVAILABLE", detalheInterno: { status } });

describe("mapeamento dos sinais do Baileys 6.7.24", () => {
  test("WAMessageStatus -> evento (PENDING não é sinal do provider)", () => {
    assert.deepEqual(classificarStatusBaileys(STATUS_BAILEYS.ERROR), { status: "PROVIDER_ERROR", ackTipo: "ack_erro" });
    assert.equal(classificarStatusBaileys(STATUS_BAILEYS.PENDING), null);
    assert.equal(classificarStatusBaileys(STATUS_BAILEYS.SERVER_ACK).status, "SERVER_ACK");
    assert.equal(classificarStatusBaileys(STATUS_BAILEYS.DELIVERY_ACK).status, "DELIVERED");
    assert.equal(classificarStatusBaileys(STATUS_BAILEYS.READ).status, "READ");
    assert.equal(classificarStatusBaileys(STATUS_BAILEYS.PLAYED).status, "READ");
    assert.equal(classificarStatusBaileys(undefined), null);
    assert.equal(classificarStatusBaileys(99), null);
  });
  test("type do <receipt> -> evento (mesma tabela do Baileys; retry/inactive/read-self não são status da NOSSA mensagem)", () => {
    assert.equal(classificarTipoReceipt(undefined).status, "DELIVERED");
    assert.equal(classificarTipoReceipt("sender").status, "SERVER_ACK");
    assert.equal(classificarTipoReceipt("read").status, "READ");
    assert.equal(classificarTipoReceipt("played").status, "READ");
    for (const t of ["read-self", "retry", "inactive", "hist_sync", "peer_msg", "server-error", "qualquer"]) assert.equal(classificarTipoReceipt(t), null, t);
  });
  test("vocabulário fechado e tipo de JID", () => {
    assert.deepEqual([...STATUS_EVENTO], ["SERVER_ACK", "DELIVERED", "READ", "PROVIDER_ERROR"]);
    assert.equal(tipoDeJid(PN), "pn"); assert.equal(tipoDeJid("1@lid"), "lid"); assert.equal(tipoDeJid("1@g.us"), "group");
    assert.equal(tipoDeJid("status@broadcast"), "broadcast"); assert.equal(tipoDeJid(undefined), "outro");
  });
});

describe("observador — correlação por providerMessageId", () => {
  test("recibo de id rastreado é enviado no contrato; id desconhecido NÃO altera nada nem chama o backend", async () => {
    const t = montar();
    t.obs.rastrear({ providerMessageId: "WA1", correlationId: "wa:alerta:1:v1", jidMascarado: "+55••••••••01" });
    t.obs.aoMessagesUpdate([{ key: { id: "OUTRO", fromMe: true, remoteJid: PN }, update: { status: 3 } }, { key: { id: "WA1", fromMe: true, remoteJid: PN }, update: { status: 3 } }]);
    await tick();
    assert.equal(t.chamadas.length, 1);
    assert.deepEqual(Object.keys(t.chamadas[0]).sort(), ["ackTipo", "contratoStatus", "ocorridoEm", "providerMessageId", "status"]);
    assert.equal(t.chamadas[0].contratoStatus, CONTRATO_STATUS_VERSAO);
    assert.equal(t.chamadas[0].providerMessageId, "WA1");
    assert.equal(t.chamadas[0].status, "DELIVERED");
    assert.equal(t.obs.metricas().naoRastreados, 1);
  });
  test("recibo de mensagem RECEBIDA (key.fromMe=false, ex.: read-self) é ignorado mesmo com id rastreado", async () => {
    const t = montar();
    t.obs.rastrear({ providerMessageId: "WA1" });
    t.obs.aoMessagesUpdate([{ key: { id: "WA1", fromMe: false }, update: { status: 4 } }]);
    await tick();
    assert.equal(t.chamadas.length, 0);
  });
  test("update sem status (edição etc.) e PENDING são ignorados", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "WA1" });
    t.obs.aoMessagesUpdate([{ key: { id: "WA1" }, update: { message: {} } }, { key: { id: "WA1" }, update: { status: 1 } }, null, {}]);
    await tick();
    assert.equal(t.chamadas.length, 0);
  });
  test("rastreio expira (TTL) e é limitado (não cresce sem fim)", async () => {
    const t = montar();
    t.obs.rastrear({ providerMessageId: "WA1" });
    t.avancar(49 * 3600_000);
    t.obs.aoMessagesUpdate([{ key: { id: "WA1", fromMe: true }, update: { status: 3 } }]);
    await tick();
    assert.equal(t.chamadas.length, 0);
    const pequeno = criarObservadorEntrega({ notificar: async () => ({}), emitir() {}, maxRastreados: 3 });
    for (let i = 0; i < 10; i++) pequeno.rastrear({ providerMessageId: `W${i}` });
    assert.equal(pequeno.metricas().rastreados, 3);
  });
});

describe("observador — duplicados e ordem", () => {
  test("o MESMO evento pelo ws e pelo ev é enviado UMA vez; ack do servidor + sender receipt idem", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "WA1" });
    t.obs.aoReceiptWs({ attrs: { id: "WA1", from: PN, t: "1700000000" } });
    t.obs.aoMessagesUpdate([{ key: { id: "WA1", fromMe: true }, update: { status: 3 } }]);
    t.obs.aoMessagesUpdate([{ key: { id: "WA1", fromMe: true }, update: { status: 3 } }]);
    t.obs.aoAckWs({ attrs: { id: "WA1", class: "message", from: PN } });
    t.obs.aoReceiptWs({ attrs: { id: "WA1", from: PN, type: "sender" } });
    await tick();
    assert.deepEqual(t.chamadas.map((c) => c.status).sort(), ["DELIVERED", "SERVER_ACK"]);
    assert.equal(t.obs.metricas().duplicados, 3);
  });
  test("READ chega antes de DELIVERED: os dois são enviados (o banco é quem decide; nunca regride)", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "WA1" });
    t.obs.aoReceiptWs({ attrs: { id: "WA1", from: PN, type: "read" } });
    t.obs.aoReceiptWs({ attrs: { id: "WA1", from: PN } });
    await tick();
    assert.deepEqual(t.chamadas.map((c) => c.status), ["READ", "DELIVERED"]);
  });
  test("recibo em lote: ids dos <item> também são correlacionados", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "WA2" });
    t.obs.aoReceiptWs({ attrs: { id: "WA1", from: PN, type: "read" }, content: [{ tag: "list", attrs: {}, content: [{ tag: "item", attrs: { id: "WA2" } }] }] });
    await tick();
    assert.deepEqual(t.chamadas.map((c) => c.providerMessageId), ["WA2"]);
  });
  test("message-receipt.update (grupo): readTimestamp=READ, receiptTimestamp=DELIVERED, timestamp em segundos vira ISO", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "WG1" }); t.obs.rastrear({ providerMessageId: "WG2" });
    t.obs.aoMessageReceiptUpdate([
      { key: { id: "WG1", fromMe: true, remoteJid: "1@g.us" }, receipt: { userJid: PN, readTimestamp: 1_699_999_990 } },
      { key: { id: "WG2", fromMe: true, remoteJid: "1@g.us" }, receipt: { userJid: PN, receiptTimestamp: 1_699_999_991 } },
      { key: { id: "WG1", fromMe: false }, receipt: { readTimestamp: 1 } },
      { key: { id: "WG1", fromMe: true }, receipt: {} },
    ]);
    await tick();
    assert.deepEqual(t.chamadas.map((c) => [c.providerMessageId, c.status, c.ocorridoEm]), [["WG1", "READ", new Date(1_699_999_990_000).toISOString()], ["WG2", "DELIVERED", new Date(1_699_999_991_000).toISOString()]]);
  });
  test("timestamp absurdo/futuro do provider cai para o relógio do Gateway", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "WA1" });
    t.obs.aoReceiptWs({ attrs: { id: "WA1", from: PN, t: "99999999999" } });
    await tick();
    assert.equal(t.chamadas[0].ocorridoEm, new Date(1_700_000_000_000).toISOString());
  });
});

describe("observador — erro do provider e ack", () => {
  test("ack com error vira PROVIDER_ERROR com código numérico; sem error vira SERVER_ACK; erro exótico vira 'desconhecido'", async () => {
    const t = montar(); for (const id of ["A", "B", "C"]) t.obs.rastrear({ providerMessageId: id });
    t.obs.aoAckWs({ attrs: { id: "A", class: "message", error: "479" } });
    t.obs.aoAckWs({ attrs: { id: "B", class: "message" } });
    t.obs.aoAckWs({ attrs: { id: "C", class: "message", error: "<script>" } });
    await tick();
    const por = Object.fromEntries(t.chamadas.map((c) => [c.providerMessageId, c]));
    assert.equal(por.A.status, "PROVIDER_ERROR"); assert.equal(por.A.erroCodigo, "479");
    assert.equal(por.B.status, "SERVER_ACK"); assert.equal("erroCodigo" in por.B, false);
    assert.equal(por.C.erroCodigo, "desconhecido");
  });
  test("o mesmo erro pelo ev (status 0 + messageStubParameters) e pelo ws é UM evento", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "A" });
    t.obs.aoAckWs({ attrs: { id: "A", class: "message", error: "479" } });
    t.obs.aoMessagesUpdate([{ key: { id: "A", fromMe: true }, update: { status: 0, messageStubParameters: ["479"] } }]);
    await tick();
    assert.equal(t.chamadas.length, 1);
  });
});

describe("observador — entrega ao backend (retry limitado, sem exceção destrutiva)", () => {
  test("NAO_ENCONTRADA (receipt ganhou da finalização do envio): retry agendado com backoff e sucesso depois", async () => {
    const t = montar({ resultados: [{ resultado: "NAO_ENCONTRADA" }, { resultado: "NAO_ENCONTRADA" }, { resultado: "APLICADO" }] });
    t.obs.rastrear({ providerMessageId: "WA1" });
    t.obs.aoReceiptWs({ attrs: { id: "WA1", from: PN } });
    await tick();
    assert.equal(t.chamadas.length, 1);
    assert.deepEqual(t.agendados.map((a) => a.ms), [1000]);
    t.agendados[0].fn(); await tick();
    assert.deepEqual(t.agendados.map((a) => a.ms), [1000, 3000]);
    t.agendados[1].fn(); await tick();
    assert.equal(t.chamadas.length, 3);
    assert.equal(t.logs.filter((l) => l.evento === "provider_receipt_persistido").length, 1);
    assert.equal(t.agendados.length, 2, "sem retry novo após o sucesso");
  });
  test("esgota os retries (4) e para: log de esgotamento, sem exceção", async () => {
    const t = montar({ resultados: Array.from({ length: 10 }, () => ({ resultado: "NAO_ENCONTRADA" })) });
    t.obs.rastrear({ providerMessageId: "WA1" });
    t.obs.aoReceiptWs({ attrs: { id: "WA1", from: PN } });
    await tick();
    for (let i = 0; i < 4; i++) { t.agendados[i].fn(); await tick(); }
    assert.equal(t.chamadas.length, 5);
    assert.deepEqual(t.agendados.map((a) => a.ms), [1000, 3000, 10_000, 30_000]);
    assert.equal(t.logs.filter((l) => l.evento === "provider_receipt_entrega_esgotada").length, 1);
    assert.equal(t.obs.metricas().esgotados, 1);
  });
  test("falha de transporte (backend fora) também é retentada; 400 (contrato) NÃO", async () => {
    const t = montar({ resultados: [erroHttp(503), { resultado: "APLICADO" }] });
    t.obs.rastrear({ providerMessageId: "WA1" });
    t.obs.aoReceiptWs({ attrs: { id: "WA1", from: PN } });
    await tick();
    assert.equal(t.agendados.length, 1);
    t.agendados[0].fn(); await tick();
    assert.equal(t.chamadas.length, 2);
    const r = montar({ resultados: [erroHttp(400)] });
    r.obs.rastrear({ providerMessageId: "WA9" });
    r.obs.aoReceiptWs({ attrs: { id: "WA9", from: PN } });
    await tick();
    assert.equal(r.agendados.length, 0);
    assert.equal(r.logs.filter((l) => l.evento === "provider_receipt_rejeitado_contrato").length, 1);
  });
  test("ESTADO_NAO_ELEGIVEL / AMBIGUA: sem retry (só aviso)", async () => {
    for (const resultado of ["ESTADO_NAO_ELEGIVEL", "AMBIGUA"]) {
      const t = montar({ resultados: [{ resultado }] });
      t.obs.rastrear({ providerMessageId: "WA1" });
      t.obs.aoReceiptWs({ attrs: { id: "WA1", from: PN } });
      await tick();
      assert.equal(t.agendados.length, 0, resultado);
      assert.equal(t.logs.filter((l) => l.evento === "provider_receipt_nao_aplicado").length, 1);
    }
  });
  test("encerrar() cancela retries pendentes", async () => {
    const t = montar({ resultados: [{ resultado: "NAO_ENCONTRADA" }] });
    t.obs.rastrear({ providerMessageId: "WA1" });
    t.obs.aoReceiptWs({ attrs: { id: "WA1", from: PN } });
    await tick();
    t.obs.encerrar();
    assert.equal(t.agendados[0].cancelado, true);
    assert.equal(t.obs.metricas().retriesPendentes, 0);
  });
  test("entradas malformadas nunca lançam", () => {
    const t = montar();
    assert.doesNotThrow(() => { t.obs.aoMessagesUpdate(undefined); t.obs.aoMessagesUpdate([undefined, null, 1]); t.obs.aoMessageReceiptUpdate(null); t.obs.aoAckWs(undefined); t.obs.aoReceiptWs({}); t.obs.aoReceiptWs(null); });
  });
});

describe("observador — logs sanitizados e correlação", () => {
  test("provider_receipt_received traz id, tipo/ack, status interno, timestamp, geração e epoch — e NUNCA telefone/JID completo", async () => {
    const t = montar();
    t.obs.rastrear({ providerMessageId: "WA1", correlationId: "wa:alerta:1:v1", jidMascarado: "+55••••••••01" });
    t.obs.aoReceiptWs({ attrs: { id: "WA1", from: PN, type: "read", t: "1700000000" } });
    await tick();
    const l = t.logs.find((x) => x.evento === "provider_receipt_received");
    assert.equal(l.dados.providerMessageId, "WA1");
    assert.equal(l.dados.ackTipo, "leitura"); assert.equal(l.dados.statusInterno, "READ");
    assert.equal(l.dados.fonte, "ws.receipt"); assert.equal(l.dados.socketGeneration, 3); assert.equal(l.dados.leaseEpoch, 12);
    assert.equal(l.dados.remoteJidTipo, "pn"); assert.equal(l.dados.correlationId, "wa:alerta:1:v1");
    assert.match(l.dados.ocorridoEm, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(/5511888880001|whatsapp\.net/.test(JSON.stringify(t.logs)), false);
  });
  test("contexto que lança não derruba o observador", async () => {
    const t = montar({ contexto: () => { throw new Error("x"); } });
    t.obs.rastrear({ providerMessageId: "WA1" });
    t.obs.aoReceiptWs({ attrs: { id: "WA1", from: PN } });
    await tick();
    assert.equal(t.chamadas.length, 1);
  });
});
