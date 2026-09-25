// Recibos (incidente 25/09/2026) — contrato do observador de entrega com sinais REAIS do Baileys, em ordem/duplicidade/ids alheios/retry.
// Só o que entregaProvider.test.js NÃO cobre: sequência ponta a ponta por fonte, READ só com sinal explícito, read-self, played, lote misto,
// ids de outros chats, e o destino da chave de dedupe quando os retries se esgotam (comportamento ATUAL documentado).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { criarObservadorEntrega } from "../src/entregaProvider.js";

const PN = "5511888880001@s.whatsapp.net";
const OUTRO_PN = "5511777770002@s.whatsapp.net";
const GRUPO = "120363000000000001@g.us";
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function montar({ resultados = [] } = {}) {
  const chamadas = []; const logs = []; const agendados = [];
  const fila = [...resultados];
  const obs = criarObservadorEntrega({
    notificar: async (p) => { chamadas.push(p); const r = fila.length ? fila.shift() : { resultado: "APLICADO" }; if (r instanceof Error) throw r; return r; },
    emitir: (nivel, evento, dados) => logs.push({ nivel, evento, dados }),
    agora: () => 1_700_000_000_000,
    agendar: (fn, ms) => { const h = { fn, ms, unref() {} }; agendados.push(h); return h; },
    cancelar: () => {},
  });
  return { obs, chamadas, logs, agendados };
}
const upd = (id, status) => ({ key: { id, fromMe: true, remoteJid: PN }, update: { status } });
const statuses = (t) => t.chamadas.map((c) => c.status);

describe("mapeamento por fonte: messages.update (chat direto)", () => {
  test("status 2/3/4/5 => SERVER_ACK/DELIVERED/READ/READ(reproducao), na ordem em que chegam, cada (id,status) UMA vez", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "M1" });
    t.obs.aoMessagesUpdate([upd("M1", 2)]); t.obs.aoMessagesUpdate([upd("M1", 3)]); t.obs.aoMessagesUpdate([upd("M1", 4)]); t.obs.aoMessagesUpdate([upd("M1", 5)]);
    await tick();
    assert.deepEqual(statuses(t), ["SERVER_ACK", "DELIVERED", "READ"], "PLAYED vira READ mas é o MESMO (id,status) de READ => deduplicado");
    assert.deepEqual(t.chamadas.map((c) => c.ackTipo), ["sender", "entrega", "leitura"]);
  });
  test("READ NUNCA é produzido sem sinal explícito de leitura: SERVER_ACK/DELIVERED/PENDING/desconhecido/read-self/retry/readTimestamp=0 não geram READ", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "M1" });
    t.obs.aoMessagesUpdate([upd("M1", 1), upd("M1", 2), upd("M1", 3), upd("M1", 99), upd("M1", "4"), upd("M1", null)]);
    t.obs.aoReceiptWs({ attrs: { id: "M1", from: PN } });
    t.obs.aoReceiptWs({ attrs: { id: "M1", from: PN, type: "sender" } });
    t.obs.aoReceiptWs({ attrs: { id: "M1", from: PN, type: "read-self" } });
    t.obs.aoReceiptWs({ attrs: { id: "M1", from: PN, type: "retry" } });
    t.obs.aoAckWs({ attrs: { id: "M1", class: "message" } });
    t.obs.aoMessageReceiptUpdate([{ key: { id: "M1", fromMe: true }, receipt: { userJid: PN, receiptTimestamp: 1_700_000_000 } }]);
    t.obs.aoMessageReceiptUpdate([{ key: { id: "M1", fromMe: true }, receipt: { userJid: PN, readTimestamp: 0 } }]);
    await tick();
    assert.equal(statuses(t).includes("READ"), false);
    assert.deepEqual(statuses(t).sort(), ["DELIVERED", "SERVER_ACK"]);
  });
  test("status como string ('4') não é sinal (só o número do WAMessageStatus)", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "M1" });
    t.obs.aoMessagesUpdate([upd("M1", "4")]);
    await tick();
    assert.equal(t.chamadas.length, 0);
  });
});

describe("mapeamento por fonte: nó cru do ws e message-receipt.update", () => {
  test("ws <receipt>: sem type => DELIVERED; 'read' => READ(leitura); 'played' => READ(reproducao); 'sender' => SERVER_ACK; 'read-self'/'inactive' => nada (read-self NÃO vira READ)", async () => {
    const t = montar(); for (const id of ["A", "B", "C", "D", "E", "F"]) t.obs.rastrear({ providerMessageId: id });
    t.obs.aoReceiptWs({ attrs: { id: "A", from: PN } });
    t.obs.aoReceiptWs({ attrs: { id: "B", from: PN, type: "read" } });
    t.obs.aoReceiptWs({ attrs: { id: "C", from: PN, type: "played" } });
    t.obs.aoReceiptWs({ attrs: { id: "D", from: PN, type: "sender" } });
    t.obs.aoReceiptWs({ attrs: { id: "E", from: PN, type: "read-self" } });
    t.obs.aoReceiptWs({ attrs: { id: "F", from: PN, type: "inactive" } });
    await tick();
    const por = Object.fromEntries(t.chamadas.map((c) => [c.providerMessageId, [c.status, c.ackTipo]]));
    assert.deepEqual(por, { A: ["DELIVERED", "entrega"], B: ["READ", "leitura"], C: ["READ", "reproducao"], D: ["SERVER_ACK", "sender"] });
    assert.equal(t.obs.metricas().persistidos, 4);
  });
  test("recibo de mensagem RECEBIDA (fromMe=false, ex.: read-self por messages.update status 4) é ignorado ANTES de contar", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "M1" });
    t.obs.aoMessagesUpdate([{ key: { id: "M1", fromMe: false, remoteJid: PN }, update: { status: 4 } }]);
    await tick();
    assert.equal(t.chamadas.length, 0);
    assert.equal(t.obs.metricas().naoRastreados, 0);
    assert.equal(t.obs.metricas().recebidos, 0);
  });
  test("message-receipt.update: readTimestamp vence receiptTimestamp (só READ é enviado); só receiptTimestamp => DELIVERED", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "G1" }); t.obs.rastrear({ providerMessageId: "G2" });
    t.obs.aoMessageReceiptUpdate([
      { key: { id: "G1", fromMe: true, remoteJid: GRUPO }, receipt: { userJid: PN, receiptTimestamp: 1_699_999_990, readTimestamp: 1_699_999_995 } },
      { key: { id: "G2", fromMe: true, remoteJid: GRUPO }, receipt: { userJid: PN, receiptTimestamp: 1_699_999_990 } },
    ]);
    await tick();
    assert.deepEqual(t.chamadas.map((c) => [c.providerMessageId, c.status]), [["G1", "READ"], ["G2", "DELIVERED"]]);
    assert.equal(t.chamadas[0].ocorridoEm, new Date(1_699_999_995_000).toISOString());
  });
  test("grupo: recibo de outro participante do MESMO id não gera segundo evento (dedupe por id+status)", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "G1" });
    t.obs.aoMessageReceiptUpdate([
      { key: { id: "G1", fromMe: true, remoteJid: GRUPO }, receipt: { userJid: PN, readTimestamp: 1_699_999_990 } },
      { key: { id: "G1", fromMe: true, remoteJid: GRUPO }, receipt: { userJid: OUTRO_PN, readTimestamp: 1_699_999_999 } },
    ]);
    await tick();
    assert.equal(t.chamadas.length, 1);
    assert.equal(t.obs.metricas().duplicados, 1);
  });
});

describe("ordem e duplicidade (encaminhado como projetado: o BANCO decide a monotonicidade)", () => {
  test("sequência fora de ordem READ, DELIVERED, SERVER_ACK, DELIVERED, READ => 3 chamadas, na ordem de chegada, sem repetir", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "M1" });
    t.obs.aoReceiptWs({ attrs: { id: "M1", from: PN, type: "read" } });
    t.obs.aoReceiptWs({ attrs: { id: "M1", from: PN } });
    t.obs.aoAckWs({ attrs: { id: "M1", class: "message" } });
    t.obs.aoReceiptWs({ attrs: { id: "M1", from: PN } });
    t.obs.aoReceiptWs({ attrs: { id: "M1", from: PN, type: "read" } });
    await tick();
    assert.deepEqual(statuses(t), ["READ", "DELIVERED", "SERVER_ACK"]);
    assert.equal(t.obs.metricas().duplicados, 2);
  });
  test("o Gateway NÃO suprime DELIVERED tardio depois de READ (a regressão é barrada pelo backend/095, não aqui)", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "M1" });
    t.obs.aoMessagesUpdate([upd("M1", 4)]); t.obs.aoMessagesUpdate([upd("M1", 3)]);
    await tick();
    assert.deepEqual(statuses(t), ["READ", "DELIVERED"]);
  });
  test("ws.ack e messages.update SERVER_ACK do mesmo id são UM evento (o primeiro a chegar define o ackTipo)", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "M1" });
    t.obs.aoAckWs({ attrs: { id: "M1", class: "message" } });
    t.obs.aoMessagesUpdate([upd("M1", 2)]);
    await tick();
    assert.equal(t.chamadas.length, 1);
    assert.equal(t.chamadas[0].ackTipo, "ack_servidor");
  });
});

describe("ids desconhecidos / de outros chats", () => {
  test("id não rastreado: contado como nao_rastreado, NÃO encaminhado, e não polui o dedupe (rastrear depois ainda encaminha)", async () => {
    const t = montar();
    t.obs.aoReceiptWs({ attrs: { id: "X1", from: PN, type: "read" } });
    t.obs.aoMessagesUpdate([upd("X1", 3)]);
    t.obs.aoMessageReceiptUpdate([{ key: { id: "X1", fromMe: true }, receipt: { readTimestamp: 1_700_000_000 } }]);
    t.obs.aoAckWs({ attrs: { id: "X1", class: "message" } });
    await tick();
    assert.equal(t.chamadas.length, 0);
    assert.equal(t.obs.metricas().naoRastreados, 4);
    assert.equal(t.logs.filter((l) => l.evento === "provider_receipt_nao_rastreado").length, 1, "log amostrado (1 por intervalo)");
    t.obs.rastrear({ providerMessageId: "X1" });
    t.obs.aoReceiptWs({ attrs: { id: "X1", from: PN, type: "read" } });
    await tick();
    assert.deepEqual(statuses(t), ["READ"]);
  });
  test("recibos de ids de OUTROS chats (celular/outro contato), inclusive dentro de lote com item nosso, nunca são encaminhados nem misturados", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "MEU" });
    t.obs.aoReceiptWs({ attrs: { id: "DOCELULAR", from: OUTRO_PN, type: "read" } });
    t.obs.aoMessagesUpdate([{ key: { id: "OUTROCHAT", fromMe: true, remoteJid: OUTRO_PN }, update: { status: 4 } }]);
    t.obs.aoReceiptWs({ attrs: { id: "MEU", from: PN, type: "read" }, content: [{ tag: "list", attrs: {}, content: [{ tag: "item", attrs: { id: "DOCELULAR2" } }, { tag: "item", attrs: { id: "OUTROCHAT" } }] }] });
    await tick();
    assert.deepEqual(t.chamadas.map((c) => c.providerMessageId), ["MEU"]);
    assert.equal(t.obs.metricas().naoRastreados, 4);
  });
  test("DOCUMENTA: a correlação é SÓ por id (o remoteJid não é verificado); o id do WhatsApp é único por mensagem, então só entraria por colisão", async () => {
    const t = montar(); t.obs.rastrear({ providerMessageId: "MEU", jidMascarado: "+55••01" });
    t.obs.aoReceiptWs({ attrs: { id: "MEU", from: OUTRO_PN } });
    await tick();
    assert.equal(t.chamadas.length, 1);
    assert.equal(t.logs.find((l) => l.evento === "provider_receipt_received").dados.remoteJidTipo, "pn");
  });
});

describe("retry após NAO_ENCONTRADA e destino da chave de dedupe (comportamento ATUAL)", () => {
  test("cronograma 1s/3s/10s/30s: 5 tentativas no total, depois PARA (esgotada)", async () => {
    const t = montar({ resultados: Array.from({ length: 8 }, () => ({ resultado: "NAO_ENCONTRADA" })) });
    t.obs.rastrear({ providerMessageId: "M1" });
    t.obs.aoReceiptWs({ attrs: { id: "M1", from: PN } });
    await tick();
    for (let i = 0; i < 4; i++) { t.agendados[i].fn(); await tick(); }
    assert.deepEqual(t.agendados.map((a) => a.ms), [1000, 3000, 10_000, 30_000]);
    assert.equal(t.chamadas.length, 5);
    assert.equal(t.obs.metricas().esgotados, 1);
    assert.equal(t.obs.metricas().retriesPendentes, 0);
  });
  test("CORRIGIDO: após esgotar sem o backend conhecer o id, um receipt LEGÍTIMO reenviado (mesmo id+status) NÃO é engolido como 'duplicado' — tenta de novo", async () => {
    const t = montar({ resultados: Array.from({ length: 5 }, () => ({ resultado: "NAO_ENCONTRADA" })) });
    t.obs.rastrear({ providerMessageId: "M1" });
    t.obs.aoReceiptWs({ attrs: { id: "M1", from: PN } });
    await tick();
    for (let i = 0; i < 4; i++) { t.agendados[i].fn(); await tick(); }
    assert.equal(t.obs.metricas().esgotados, 1);
    assert.equal(t.chamadas.length, 5);
    // o backend agora JÁ conhece o id (org corrigida/finalização atrasada); o WhatsApp reenvia o mesmo recibo:
    t.obs.aoReceiptWs({ attrs: { id: "M1", from: PN } });
    t.obs.aoMessagesUpdate([upd("M1", 3)]);
    await tick();
    assert.equal(t.chamadas.length, 6, "o recibo reenviado tenta de novo (uma chamada; os retries seguem o cronograma normal)");
    assert.equal(t.obs.metricas().duplicados, 1, "só o SEGUNDO evento do mesmo instante (messages.update logo depois) é duplicado do que acabou de ser tentado");
    // um status DIFERENTE (READ) do mesmo id ainda passa: só a chave id+status esgotada fica presa
    t.obs.aoReceiptWs({ attrs: { id: "M1", from: PN, type: "read" } });
    await tick();
    assert.equal(statuses(t).at(-1), "READ");
  });
  test("mesma retenção para o 400 de contrato e para ESTADO_NAO_ELEGIVEL: a chave fica presa (repetição idêntica não chama o backend)", async () => {
    const e400 = Object.assign(new Error("x"), { detalheInterno: { status: 400 } });
    const t = montar({ resultados: [e400, { resultado: "ESTADO_NAO_ELEGIVEL" }] });
    t.obs.rastrear({ providerMessageId: "M1" }); t.obs.rastrear({ providerMessageId: "M2" });
    t.obs.aoReceiptWs({ attrs: { id: "M1", from: PN } }); t.obs.aoReceiptWs({ attrs: { id: "M2", from: PN } });
    await tick();
    t.obs.aoReceiptWs({ attrs: { id: "M1", from: PN } }); t.obs.aoReceiptWs({ attrs: { id: "M2", from: PN } });
    await tick();
    assert.equal(t.chamadas.length, 2);
    assert.equal(t.agendados.length, 0);
  });
  test("sucesso no meio dos retries encerra o ciclo: 1 persistido, 0 esgotados, e o retry reenvia o MESMO payload", async () => {
    const t = montar({ resultados: [{ resultado: "NAO_ENCONTRADA" }, { resultado: "APLICADO" }] });
    t.obs.rastrear({ providerMessageId: "M1" });
    t.obs.aoReceiptWs({ attrs: { id: "M1", from: PN, type: "read" } });
    await tick(); t.agendados[0].fn(); await tick();
    const m = t.obs.metricas();
    assert.equal(m.persistidos, 1); assert.equal(m.esgotados, 0); assert.equal(t.chamadas.length, 2);
    assert.deepEqual(t.chamadas[0], t.chamadas[1]);
  });
});
