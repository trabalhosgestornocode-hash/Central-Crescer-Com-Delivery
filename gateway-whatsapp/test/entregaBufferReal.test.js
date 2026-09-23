// H.4-B.4 (item 9) — os recibos LIVE ficam presos no buffer offline do Baileys 6.7.24? Prova por execução com o pipeline REAL
// (socket Baileys real ↔ servidor WebSocket local; nós montados como o servidor faria; nenhuma rede externa):
//   A) recibo entra no buffer?           SIM enquanto há buffer ativo E o nó é tagueado `offline` (fila offline) — só assim.
//   B/C) messages.update / message-receipt.update?   os dois são bufferáveis (BUFFERABLE_EVENT) — mesmo comportamento.
//   D) descartado?                       NÃO: fica retido no buffer.
//   E) chega ao handler depois?          SIM: no fim da fila offline OU quando um nó VIVO passa por processNodeWithBuffer (buffer()+flush()).
//   F) preso para sempre?                SÓ se nunca vier nem o marcador nem um nó vivo — e o leitor de `ws` (aoReceiptWs/aoAckWs) NÃO depende disso.
// Recovery NÃO é usado: nenhum `offline_batch` extra, nenhum flush manual.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { criarGatewayFalso, capturarConsole } from "../test-support/inboundHarness.js";
import { criarObservadorEntrega } from "../src/entregaProvider.js";

const PN = "5511888880001@s.whatsapp.net";
const GRUPO = "120363000000000001@g.us";

async function abrir() {
  const cap = capturarConsole();
  const gw = await criarGatewayFalso({});
  const updates = []; const receiptsGrupo = [];
  gw.sock.ev.on("messages.update", (u) => updates.push(...u));
  gw.sock.ev.on("message-receipt.update", (u) => receiptsGrupo.push(...u));
  return { gw, updates, receiptsGrupo, fim: async () => { cap.restaurar(); await gw.encerrar(); } };
}
const recibo = (attrs) => ({ tag: "receipt", attrs: { t: "1700000000", ...attrs } });

describe("recibos × buffer de eventos do Baileys real", { timeout: 60_000 }, () => {
  test("A/D/F — recibo tagueado OFFLINE com buffer ativo fica RETIDO (não chega ao handler, não é descartado)", async () => {
    const t = await abrir();
    try {
      assert.equal(t.gw.bufferando(), true);
      t.gw.sock.ws.emit("CB:receipt", recibo({ id: "WAOFF1", from: PN, offline: "1" }));
      await t.gw.espera(200);
      assert.equal(t.updates.length, 0, "retido: o handler NÃO recebeu");
      assert.equal(t.gw.bufferando(), true, "nada liberou o buffer");
    } finally { await t.fim(); }
  });

  test("E — um recibo VIVO (sem `offline`) faz buffer()+flush(): ele MESMO chega ao handler e LIBERA o retido antes dele", async () => {
    const t = await abrir();
    try {
      t.gw.sock.ws.emit("CB:receipt", recibo({ id: "WAOFF1", from: PN, offline: "1" }));
      await t.gw.espera(150);
      assert.equal(t.updates.length, 0);
      t.gw.sock.ws.emit("CB:receipt", recibo({ id: "WAVIVO1", from: PN }));
      await t.gw.espera(200);
      const ids = t.updates.map((u) => u.key.id).sort();
      assert.deepEqual(ids, ["WAOFF1", "WAVIVO1"], "vivo entregue E o retido liberado");
      assert.equal(t.gw.bufferando(), false, "o nó vivo liberou o buffer (sem recovery, sem flush manual)");
      const vivo = t.updates.find((u) => u.key.id === "WAVIVO1");
      assert.equal(vivo.update.status, 3, "receipt sem `type` = DELIVERY_ACK (3)");
      assert.equal(vivo.key.fromMe, true);
    } finally { await t.fim(); }
  });

  test("E — o fim da fila offline (CB:ib,,offline) também libera o recibo retido", async () => {
    const t = await abrir();
    try {
      t.gw.sock.ws.emit("CB:receipt", recibo({ id: "WAOFF2", from: PN, type: "read", offline: "2" }));
      await t.gw.espera(150);
      assert.equal(t.updates.length, 0);
      t.gw.emitirOfflineFim(1);
      await t.gw.espera(150);
      assert.deepEqual(t.updates.map((u) => [u.key.id, u.update.status]), [["WAOFF2", 4]], "type=read = READ (4)");
    } finally { await t.fim(); }
  });

  test("B/C — message-receipt.update (grupo) segue a MESMA regra: retido se offline, entregue por um nó vivo", async () => {
    const t = await abrir();
    try {
      t.gw.sock.ws.emit("CB:receipt", recibo({ id: "WAG1", from: GRUPO, participant: PN, type: "read", offline: "1" }));
      await t.gw.espera(150);
      assert.equal(t.receiptsGrupo.length, 0, "retido");
      t.gw.sock.ws.emit("CB:receipt", recibo({ id: "WAG2", from: GRUPO, participant: PN }));
      await t.gw.espera(200);
      const porId = Object.fromEntries(t.receiptsGrupo.map((u) => [u.key.id, u.receipt]));
      assert.ok(porId.WAG1.readTimestamp > 0 && porId.WAG2.receiptTimestamp > 0);
      assert.equal(t.updates.length, 0, "grupo NÃO gera messages.update");
    } finally { await t.fim(); }
  });

  test("F — o leitor de `ws` entrega o recibo de uma mensagem RASTREADA mesmo com o buffer preso (sem flush, sem recovery)", async () => {
    const t = await abrir();
    try {
      const chamadas = []; const logs = [];
      const obs = criarObservadorEntrega({ notificar: async (p) => { chamadas.push(p); return { resultado: "APLICADO" }; }, emitir: (n, e, d) => logs.push({ e, d }) });
      t.gw.sock.ws.on("CB:receipt", (no) => obs.aoReceiptWs(no));
      t.gw.sock.ws.on("CB:ack,class:message", (no) => obs.aoAckWs(no));
      t.gw.sock.ev.on("messages.update", (u) => obs.aoMessagesUpdate(u));
      obs.rastrear({ providerMessageId: "WAMEU1", correlationId: "wa:alerta:x:v1", jidMascarado: "+55••••••••01" });

      t.gw.sock.ws.emit("CB:ack,class:message", { tag: "ack", attrs: { class: "message", id: "WAMEU1", from: PN, t: "1700000000" } });
      t.gw.sock.ws.emit("CB:receipt", recibo({ id: "WAMEU1", from: PN, offline: "1" }));   // tagueado offline: o Baileys o RETÉM
      t.gw.sock.ws.emit("CB:receipt", recibo({ id: "WAOUTRO", from: PN, offline: "1" }));  // não é nosso: ignorado
      await t.gw.espera(250);
      assert.equal(t.updates.length, 0, "o buffer do Baileys segue retendo");
      assert.equal(t.gw.bufferando(), true, "o leitor de ws NÃO flushou nada");
      assert.deepEqual(chamadas.map((c) => c.status).sort(), ["DELIVERED", "SERVER_ACK"]);
      assert.ok(chamadas.every((c) => c.providerMessageId === "WAMEU1" && c.contratoStatus === 1));
      assert.equal(logs.filter((l) => l.e === "provider_receipt_received").length, 2);
      assert.equal(obs.metricas().naoRastreados, 1);
      obs.encerrar();
    } finally { await t.fim(); }
  });
});
