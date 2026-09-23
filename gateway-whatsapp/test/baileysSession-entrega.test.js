// H.4-B.4 — enviar(): JID canônico do WhatsApp (fail-closed), providerMessageId pré-gerado e rastreado, logs send_start/send_resolved sanitizados.
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { criarSessaoBaileys } from "../src/baileysSession.js";
import { CODIGOS } from "../src/errors.js";

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const AUTH_ID = "11111111-1111-4111-8111-111111111111";
const TEL = "+5511987654321";
const CONTEUDO_SECRETO = "conteudo-que-nunca-pode-ir-ao-log";

function fabricaFalsa({ onWhatsApp, sendMessage } = {}) {
  const criados = [];
  const fabrica = () => {
    const socket = {
      ev: new EventEmitter(), ws: new EventEmitter(), user: { id: "5511999990000:1@s.whatsapp.net" },
      onWhatsApp: onWhatsApp ?? mock.fn(async (d) => [{ jid: `${d}@s.whatsapp.net`, exists: true }]),
      sendMessage: sendMessage ?? mock.fn(async (_j, _c, o) => ({ key: { id: o?.messageId } })),
      readMessages: mock.fn(async () => {}), end: mock.fn(async () => {}),
    };
    criados.push(socket); return socket;
  };
  fabrica.criados = criados; return fabrica;
}
function authFalso() {
  let creds = null;
  return {
    async carregar() { return { status: "absent" }; }, inicializarCreds(c) { creds = c; }, invalidarLocal() { creds = null; },
    comoAuthState() { return { creds, keys: { get: async () => ({}), set: async () => {} } }; },
    async aoAtualizarCreds(d) { if (creds) Object.assign(creds, d); else creds = d; },
    async aguardarPersistenciasPendentes() {}, obterAuthSessionIdAtual() { return AUTH_ID; },
  };
}
const backendFalso = () => ({
  notificarHeartbeat: mock.fn(async () => {}), notificarMensagemRecebida: mock.fn(async () => {}),
  notificarStatusProvider: mock.fn(async () => ({ ok: true, resultado: "APLICADO" })),
  definirEstadoDesejado: mock.fn(async () => ({ ok: true })), obterEstadoSessao: mock.fn(async () => ({ status: "DISCONNECTED", desiredConnectionState: "DISCONNECTED" })),
  resetarAuthState: mock.fn(async () => ({ ok: true })), confirmarAuthState: mock.fn(async () => ({})),
});
const leaseFalso = () => ({ souLeader: () => true, contexto: () => ({ gatewayProcessId: "proc", leaseEpoch: 12 }), notificarPerdaExterna: mock.fn(async () => {}) });

async function conectada(opcoesFabrica) {
  const fabricaSocket = fabricaFalsa(opcoesFabrica);
  const backendClient = backendFalso();
  const sessao = criarSessaoBaileys({
    authAdapter: authFalso(), backendClient, config: { reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "t", gatewayVersion: "0" },
    fabricaSocket, DisconnectReasonLoggedOut: 401, leaseManager: leaseFalso(),
  });
  await sessao.conectar();
  const socket = fabricaSocket.criados[0];
  socket.ev.emit("connection.update", { connection: "open" });
  socket.ev.emit("creds.update", { registered: true });
  await new Promise((r) => setImmediate(r));
  return { sessao, socket, backendClient };
}
async function capturandoLogs(fn) {
  const linhas = []; const original = console.log; const originalErr = console.error;
  console.log = (l) => linhas.push(String(l)); console.error = (l) => linhas.push(String(l));
  try { await fn(); } finally { console.log = original; console.error = originalErr; }
  return linhas.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const enviar = (sessao, extra = {}) => sessao.enviar({ tipo: "text", telefoneE164: TEL, conteudo: { text: CONTEUDO_SECRETO }, correlationId: "wa:alerta:abc:v1", ...extra });

describe("enviar() — destinatário canônico", () => {
  test("envia ao JID que o WHATSAPP respondeu (sem o 9º dígito), consultando só os dígitos", async () => {
    const onWhatsApp = mock.fn(async () => [{ jid: "551187654321@s.whatsapp.net", exists: true }]);
    const { sessao, socket } = await conectada({ onWhatsApp });
    await enviar(sessao);
    assert.deepEqual(onWhatsApp.mock.calls[0].arguments, ["5511987654321"]);
    assert.equal(socket.sendMessage.mock.calls[0].arguments[0], "551187654321@s.whatsapp.net", "JID canônico, não o concatenado");
  });

  test("fail-closed: consulta falha / número inexistente / retorno inesperado => sendMessage NUNCA é chamado e o erro é pré-envio", async () => {
    const casos = [
      [async () => { throw new Error("Connection Closed"); }, CODIGOS.CONSULTA_DESTINATARIO_FALHOU],
      [async () => undefined, CODIGOS.CONSULTA_DESTINATARIO_FALHOU],
      [async () => [], CODIGOS.DESTINATARIO_INEXISTENTE],
      [async () => [{ jid: "999@lid", exists: true }], CODIGOS.DESTINATARIO_NAO_VERIFICADO],
      [async () => ({ x: 1 }), CODIGOS.DESTINATARIO_NAO_VERIFICADO],
    ];
    for (const [impl, codigo] of casos) {
      const { sessao, socket } = await conectada({ onWhatsApp: mock.fn(impl) });
      await assert.rejects(enviar(sessao), (e) => e.codigo === codigo && e.preEnvio === true);
      assert.equal(socket.sendMessage.mock.calls.length, 0, codigo);
    }
  });

  test("a sessão cai DURANTE a consulta: NOT_CONNECTED pré-envio, sem sendMessage", async () => {
    let liberar;
    const onWhatsApp = mock.fn(() => new Promise((r) => { liberar = () => r([{ jid: "5511987654321@s.whatsapp.net", exists: true }]); }));
    const { sessao, socket } = await conectada({ onWhatsApp });
    const p = enviar(sessao);
    await tick();
    await sessao.desconectar();
    liberar();
    await assert.rejects(p, (e) => e.codigo === CODIGOS.NAO_CONECTADO && e.preEnvio === true);
    assert.equal(socket.sendMessage.mock.calls.length, 0);
  });
});

describe("enviar() — providerMessageId e logs", () => {
  test("o id é gerado ANTES do sendMessage (formato do Baileys), passado como messageId e rastreado: um ack imediato já é correlacionado", async () => {
    const { sessao, socket, backendClient } = await conectada();
    let idNoEnvio;
    socket.sendMessage = mock.fn(async (_j, _c, o) => {
      idNoEnvio = o.messageId;
      socket.ws.emit("CB:ack,class:message", { attrs: { class: "message", id: o.messageId, from: "5511987654321@s.whatsapp.net" } });   // o servidor responde ANTES de o envio resolver
      return { key: { id: o.messageId } };
    });
    const r = await enviar(sessao);
    await tick();
    assert.match(idNoEnvio, /^3EB0[0-9A-F]{18}$/);
    assert.equal(r.providerMessageId, idNoEnvio);
    assert.equal(backendClient.notificarStatusProvider.mock.calls.length, 1);
    assert.equal(backendClient.notificarStatusProvider.mock.calls[0].arguments[0].status, "SERVER_ACK");
  });

  test("send_start/send_resolved: correlationId, providerMessageId, JID mascarado, geração do socket, epoch da lease, durações — sem telefone completo nem conteúdo", async () => {
    const { sessao } = await conectada();
    const logs = await capturandoLogs(async () => { await enviar(sessao); });
    const ini = logs.find((l) => l.evento === "send_start");
    const fim = logs.find((l) => l.evento === "send_resolved");
    assert.ok(ini && fim);
    for (const l of [ini, fim]) {
      assert.equal(l.correlationId, "wa:alerta:abc:v1");
      assert.equal(l.socketGeneration, 1);
      assert.equal(l.leaseEpoch, 12);
      assert.match(l.jid, /^\+55•+21$/);
    }
    assert.match(ini.providerMessageId, /^3EB0/);
    assert.equal(fim.providerMessageId, ini.providerMessageId);
    assert.equal(typeof fim.durationMs, "number");
    assert.equal(typeof ini.lookupMs, "number");
    assert.equal(fim.idPreGeradoConfere, true);
    const bruto = JSON.stringify(logs);
    assert.equal(bruto.includes("5511987654321"), false, "telefone completo");
    assert.equal(bruto.includes("whatsapp.net"), false, "JID completo");
    assert.equal(bruto.includes(CONTEUDO_SECRETO), false, "conteúdo");
  });

  test("sendMessage rejeita: send_falhou (sem conteúdo), erro propagado como antes (INCERTO no backend), id continua rastreado", async () => {
    const { sessao } = await conectada({ sendMessage: mock.fn(async () => { throw new Error("boom"); }) });
    let erroCapturado;
    const logs = await capturandoLogs(async () => { try { await enviar(sessao); } catch (e) { erroCapturado = e; } });
    assert.equal(erroCapturado.message, "boom");
    assert.equal(erroCapturado.preEnvio, undefined, "depois do sendMessage começar NÃO é pré-envio");
    assert.ok(logs.find((l) => l.evento === "send_falhou"));
    assert.equal(logs.find((l) => l.evento === "send_resolved"), undefined);
  });

  test("id devolvido diferente do pré-gerado: também é rastreado e o log sinaliza", async () => {
    const { sessao, socket, backendClient } = await conectada({ sendMessage: mock.fn(async () => ({ key: { id: "OUTROID123" } })) });
    const logs = await capturandoLogs(async () => { await enviar(sessao); });
    assert.equal(logs.find((l) => l.evento === "send_resolved").idPreGeradoConfere, false);
    socket.ws.emit("CB:receipt", { attrs: { id: "OUTROID123", from: "5511987654321@s.whatsapp.net" } });
    await tick();
    assert.equal(backendClient.notificarStatusProvider.mock.calls.length, 1);
  });
});
