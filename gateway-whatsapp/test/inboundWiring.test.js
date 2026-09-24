// C.9.3 — a fiação do escopo de inbound na sessão: o PADRÃO não muda nada; DIRECT_ONLY chega ao socket; o
// encaminhamento de mensagens ao backend segue como antes e o diagnóstico nunca o atrapalha.
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { proto } from "baileys";
import { criarSessaoBaileys } from "../src/baileysSession.js";
import { criarInboundGateway } from "../src/inboundScope.js";

const AUTH_SESSION_ID_FAKE = "11111111-1111-4111-8111-111111111111";
const CIPHERTEXT = proto.WebMessageInfo.StubType.CIPHERTEXT;

function fabricaFalsa() {
  const criados = []; const opcoes = [];
  const fabrica = (o) => {
    opcoes.push(o);
    const socket = { ev: new EventEmitter(), ws: new EventEmitter(), user: null, sendMessage: mock.fn(async () => ({ key: { id: "x" } })), readMessages: mock.fn(async () => {}), end: mock.fn(async () => {}) };
    criados.push(socket);
    return socket;
  };
  fabrica.criados = criados; fabrica.opcoes = opcoes;
  return fabrica;
}
const authAdapterFalso = () => ({
  async carregar() { return { status: "absent" }; }, inicializarCreds() {}, comoAuthState() { return { creds: {}, keys: { get: async () => ({}), set: async () => {} } }; },
  async aoAtualizarCreds() {}, async aguardarPersistenciasPendentes() {}, obterAuthSessionIdAtual() { return AUTH_SESSION_ID_FAKE; },
});
const backendFalso = () => ({
  notificarHeartbeat: mock.fn(async () => {}), notificarMensagemRecebida: mock.fn(async () => {}), notificarStatusProvider: mock.fn(async () => {}),
  definirEstadoDesejado: mock.fn(async () => ({ ok: true })), obterEstadoSessao: mock.fn(async () => ({ status: "DISCONNECTED", desiredConnectionState: "DISCONNECTED" })),
  resetarAuthState: mock.fn(async () => ({ ok: true })), confirmarAuthState: mock.fn(async () => ({})),
});
const configFalso = () => ({ reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "teste", gatewayVersion: "0.0.0-test" });
// Checkpoint G.0.1 — notificarMensagemRecebida passa pela fila de concorrência limitada (src/filaConcorrenciaLimitada.js):
// a chamada real acontece alguns microtasks depois do messages.upsert. `drenar()` espera esses microtasks assentarem
// (as mocks aqui resolvem na hora, sem I/O real). Nome distinto de `tick` (já usado nesta suíte para o timer injetado).
async function drenar() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

async function abrir(inbound) {
  const fabricaSocket = fabricaFalsa(); const backendClient = backendFalso();
  const sessao = criarSessaoBaileys({ authAdapter: authAdapterFalso(), backendClient, config: configFalso(), fabricaSocket, DisconnectReasonLoggedOut: 401, ...(inbound ? { inbound } : {}) });
  await sessao.conectar();
  return { sessao, fabricaSocket, backendClient, socket: fabricaSocket.criados[0], opcoes: fabricaSocket.opcoes[0] };
}

describe("fiação do escopo de inbound", () => {
  test("SEM a dependência `inbound` (todos os testes/produção antigos): opções do socket idênticas às de antes — sem shouldIgnoreJid", async () => {
    const { opcoes } = await abrir(undefined);
    assert.deepEqual(Object.keys(opcoes).sort(), ["auth", "logger", "printQRInTerminal"]);
  });

  test("PADRÃO (ALL_SUPPORTED, sem diagnóstico): idem — o Baileys usa o próprio default", async () => {
    const { opcoes } = await abrir(criarInboundGateway({ emitir() {} }));
    assert.deepEqual(Object.keys(opcoes).sort(), ["auth", "logger", "printQRInTerminal"]);
    assert.equal("shouldIgnoreJid" in opcoes, false);
  });

  test("DIRECT_ONLY: shouldIgnoreJid chega ao socket e ignora só o que não é suportado", async () => {
    const { opcoes } = await abrir(criarInboundGateway({ escopoBruto: "DIRECT_ONLY", emitir() {} }));
    assert.equal(typeof opcoes.shouldIgnoreJid, "function");
    assert.equal(opcoes.shouldIgnoreJid("120363000000000001@g.us"), true);
    assert.equal(opcoes.shouldIgnoreJid("5511888880001@s.whatsapp.net"), false);
    assert.deepEqual(Object.keys(opcoes).sort(), ["auth", "logger", "printQRInTerminal", "shouldIgnoreJid"]);
  });

  test("DIAGNÓSTICO ligado em ALL_SUPPORTED: o socket recebe as MESMAS opções de antes (nenhum shouldIgnoreJid) — só o logger é envolvido", async () => {
    const { opcoes } = await abrir(criarInboundGateway({ diagHabilitado: true, emitir() {}, agendar: () => ({ unref() {} }), consoleAlvo: { error() {} } }));
    assert.deepEqual(Object.keys(opcoes).sort(), ["auth", "logger", "printQRInTerminal"]);
    assert.equal("shouldIgnoreJid" in opcoes, false);
    assert.equal(typeof opcoes.logger.child, "function");
    for (const n of ["trace", "debug", "info", "warn", "error"]) assert.equal(typeof opcoes.logger[n], "function");
  });

  test("a SESSÃO observa o socket que criou (ws CB:*) quando o diagnóstico está ligado — e não anexa nada quando desligado", async () => {
    const ligado = criarInboundGateway({ diagHabilitado: true, emitir() {}, agendar: () => ({ unref() {} }), consoleAlvo: { error() {} } });
    const a = await abrir(ligado);
    a.socket.ws.emit("CB:message", { attrs: { from: "120363000000000001@g.us" } });
    a.socket.ws.emit("CB:receipt", { attrs: { from: "5511888880001@s.whatsapp.net" } });
    assert.equal(ligado.snapshot().stanzas.group.message, 1);
    assert.equal(ligado.snapshot().stanzas.direct_pn.receipt, 1);
    const desligado = criarInboundGateway({ emitir() {} });
    const b = await abrir(desligado);
    assert.deepEqual(b.socket.ws.eventNames(), ["CB:message", "CB:ack,class:message", "CB:receipt"], "diagnóstico desligado: só o rastreador de ORIGEM do Checkpoint F (CB:message, passivo) e os 2 leitores PUROS de entrega da H.4-B.4 (ack/recibo das mensagens que enviamos) estão no ws");
  });

  test("valor inválido de escopo: opções de antes (nunca DIRECT_ONLY por acidente)", async () => {
    const { opcoes } = await abrir(criarInboundGateway({ escopoBruto: "direct-only", emitir() {} }));
    assert.equal("shouldIgnoreJid" in opcoes, false);
  });
});

describe("messages.upsert — encaminhamento ao backend e contadores", () => {
  const msg = (jid, extra = {}) => ({ key: { remoteJid: jid, id: "ID1", fromMe: false }, message: { conversation: "oi" }, ...extra });

  test("o encaminhamento ao backend é o de sempre (independe do escopo/diagnóstico)", async () => {
    const { socket, backendClient } = await abrir(criarInboundGateway({ diagHabilitado: true, emitir() {}, agendar: () => ({ unref() {} }) }));
    socket.ev.emit("messages.upsert", { messages: [msg("5511888880001@s.whatsapp.net")], type: "notify" });
    await drenar();
    assert.equal(backendClient.notificarMensagemRecebida.mock.callCount(), 1);
    assert.equal(backendClient.notificarMensagemRecebida.mock.calls[0].arguments[0].telefoneE164, "+5511888880001");
  });

  test("com diagnóstico, a mensagem é contada por tipo (só número) — inclusive a falha de decrypt", async () => {
    const eventos = []; let tick;
    const inbound = criarInboundGateway({ diagHabilitado: true, emitir: (n, e, d) => eventos.push({ e, d }), agendar: (fn) => { tick = fn; return { unref() {} }; } });
    const { socket } = await abrir(inbound);
    socket.ev.emit("messages.upsert", { messages: [msg("5511888880001@s.whatsapp.net"), msg("5511888880001@s.whatsapp.net", { messageStubType: CIPHERTEXT, messageStubParameters: ["No matching sessions found for message"], message: undefined })], type: "append" });
    tick();
    assert.equal(eventos.length, 1);
    const d = eventos[0].d.tipos.find((x) => x.tipo === "direct_pn");
    assert.equal(d.decryptTentado, 2); assert.equal(d.decryptFalha, 1); assert.equal(d.entregues, 2); assert.equal(d.emitidasDireto, 2);
    assert.deepEqual(d.motivos, [{ motivo: "sem_sessao_compativel", n: 1 }]);
    assert.ok(!/5511|whatsapp\.net/.test(JSON.stringify(eventos[0].d)));
  });

  test("um diagnóstico que lança NÃO impede o encaminhamento", async () => {
    const quebrado = { opcoesSocket: () => ({}), aoMensagens() { throw new Error("contador quebrado"); } };
    const { socket, backendClient } = await abrir(quebrado);
    assert.doesNotThrow(() => socket.ev.emit("messages.upsert", { messages: [msg("5511888880001@s.whatsapp.net")], type: "notify" }));
    await drenar();
    assert.equal(backendClient.notificarMensagemRecebida.mock.callCount(), 1);
  });

  test("fromMe continua ignorado como antes", async () => {
    const { socket, backendClient } = await abrir(criarInboundGateway({ emitir() {} }));
    socket.ev.emit("messages.upsert", { messages: [{ key: { remoteJid: "5511888880001@s.whatsapp.net", id: "E", fromMe: true }, message: {} }], type: "notify" });
    await drenar();
    assert.equal(backendClient.notificarMensagemRecebida.mock.callCount(), 0);
  });
});

describe("C.9.4 — pipeline: encaminhada ao backend e a DÍVIDA do Checkpoint F (caracterização)", () => {
  const msg = (jid, extra = {}) => ({ key: { remoteJid: jid, id: "ID1", fromMe: false }, message: { conversation: "oi" }, ...extra });

  test("`encaminhadas` conta só o que realmente vai ao backend (fromMe não vai) e é por TIPO; `entregues` conta todas as que chegaram ao listener", async () => {
    const inbound = criarInboundGateway({ diagHabilitado: true, emitir() {}, agendar: () => ({ unref() {} }), consoleAlvo: { error() {} } });
    const { socket, backendClient } = await abrir(inbound);
    socket.ev.emit("messages.upsert", { messages: [
      msg("5511888880001@s.whatsapp.net"), msg("100000000000002@lid"), msg("120363000000000001@g.us"),
      { key: { remoteJid: "5511888880001@s.whatsapp.net", id: "E", fromMe: true }, message: {} },
    ], type: "notify" });
    await drenar();
    const m = inbound.snapshot().mensagens;
    assert.equal(m.direct_pn.entregues, 2); assert.equal(m.direct_pn.encaminhadas, 1, "a fromMe não é encaminhada");
    assert.equal(m.direct_lid_other.encaminhadas, 1); assert.equal(m.group.encaminhadas, 1);
    assert.equal(backendClient.notificarMensagemRecebida.mock.callCount(), 3, "encaminhadas conta == chamadas reais ao backend");
  });

  test("DÍVIDA do Checkpoint F QUITADA: LID, grupo e status NUNCA viram 'telefone' (antes deJid(remoteJid) os transformava em '+1000…', '+1203…', '+status')", async () => {
    const { socket, backendClient } = await abrir(criarInboundGateway({ emitir() {} }));
    socket.ev.emit("messages.upsert", { messages: [
      msg("5511888880001@s.whatsapp.net"), msg("100000000000002@lid"), msg("120363000000000001@g.us"), msg("status@broadcast"),
    ], type: "notify" });
    await drenar();
    const enviados = backendClient.notificarMensagemRecebida.mock.calls.map((c) => c.arguments[0].telefoneE164);
    assert.equal(enviados[0], "+5511888880001", "PN: telefone de verdade");
    assert.equal(enviados[1], null, "LID NÃO é telefone");
    assert.equal(enviados[2], null, "id de GRUPO NÃO é telefone");
    assert.equal(enviados[3], null, "status@broadcast NÃO é telefone");
    // O payload agora é o CONTRATO (origemTipo, origemJidTipo, fromMe, falhaDecrypt...): ver test/inboundContrato.test.js.
    for (const c of backendClient.notificarMensagemRecebida.mock.calls) assert.deepEqual(Object.keys(c.arguments[0]).sort(), ["contratoInbound", "falhaDecrypt", "fromMe", "motivoFalhaDecrypt", "origemJidTipo", "origemTipo", "providerMessageId", "recebidoEm", "stubSistema", "telefoneE164", "telefoneOrigem", "texto", "tipoConteudo"]);
  });

  test("um stub de falha de decrypt (CIPHERTEXT, sem conteúdo) liberado do buffer é encaminhado, mas AGORA marcado como falhaDecrypt (o backend o põe em quarentena, nunca como mensagem normal)", async () => {
    const { socket, backendClient } = await abrir(criarInboundGateway({ emitir() {} }));
    socket.ev.emit("messages.upsert", { messages: [msg("120363000000000001@g.us", { messageStubType: CIPHERTEXT, messageStubParameters: ["Bad MAC"], message: undefined })], type: "append" });
    await drenar();
    assert.equal(backendClient.notificarMensagemRecebida.mock.callCount(), 1);
    const e = backendClient.notificarMensagemRecebida.mock.calls[0].arguments[0];
    assert.deepEqual([e.falhaDecrypt, e.motivoFalhaDecrypt, e.origemJidTipo, e.telefoneE164, e.origemTipo], [true, "bad_mac", "group", null, "OFFLINE_NORMAL"]);
  });
});
