// Testes de lifecycle/reconexão/heartbeat da sessão Baileys — SEM rede,
// SEM QR real, SEM conectar nenhuma conta. `fabricaSocket` é um fake
// determinístico injetado (mesmo mecanismo de dependência que server.js usa
// para injetar o `makeWASocket` real em produção).
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { criarSessaoBaileys, STATUS_CONEXAO, paraJid, deJid } from "../src/baileysSession.js";

const DISCONNECT_REASON_LOGGED_OUT = 401; // mesmo valor real do Baileys (DisconnectReason.loggedOut)
const DISCONNECT_REASON_CONNECTION_LOST = 408;

function socketFalsoFabrica() {
  const criados = [];
  function fabrica() {
    const ev = new EventEmitter();
    const socket = {
      ev,
      user: null,
      sendMessage: mock.fn(async (_jid, _conteudo) => ({ key: { id: `wa-${criados.length}-${Date.now()}` } })),
      readMessages: mock.fn(async () => {}),
      end: mock.fn(async () => {}),
    };
    criados.push(socket);
    return socket;
  }
  fabrica.criados = criados;
  return fabrica;
}

function authAdapterFalso() {
  return {
    async carregar() { return false; },
    inicializarCreds() {},
    comoAuthState() { return { creds: {}, keys: { get: async () => ({}), set: async () => {} } }; },
    async aoAtualizarCreds() {},
  };
}

function backendClientFalso() {
  return {
    notificarHeartbeat: mock.fn(async () => {}),
    notificarMensagemRecebida: mock.fn(async () => {}),
    notificarStatusProvider: mock.fn(async () => {}),
  };
}

function configFalso() {
  return {
    reconnect: { baseMs: 10, tetoMs: 40 },
    heartbeatMs: 1_000_000, // não dispara sozinho durante o teste
    providerInstanceId: "teste",
    gatewayVersion: "0.0.0-test",
  };
}

describe("baileysSession — helpers de JID", () => {
  test("paraJid/deJid são inversas para um E.164 simples", () => {
    assert.equal(paraJid("+5511999990000"), "5511999990000@s.whatsapp.net");
    assert.equal(deJid("5511999990000@s.whatsapp.net"), "+5511999990000");
  });
});

describe("baileysSession — lifecycle", () => {
  test("conectar() sem QR/rede real: vai para CONNECTING, depois 'open' vira CONNECTED", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });

    await sessao.conectar();
    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTING);

    fabricaSocket.criados[0].user = { id: "5511999990000:1@s.whatsapp.net" };
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });

    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTED);
    assert.equal((await sessao.getStatus()).telefone, "+5511999990000");
  });

  test("obterQrAtual(): null antes de qualquer QR, string após o evento, null de novo após 'open'", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });

    assert.equal(sessao.obterQrAtual(), null);

    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { qr: "2@qr-de-teste-fake==" });
    assert.equal(sessao.obterQrAtual(), "2@qr-de-teste-fake==");

    fabricaSocket.criados[0].user = { id: "5511999990000:1@s.whatsapp.net" };
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    assert.equal(sessao.obterQrAtual(), null, "QR precisa sumir assim que conecta — nunca reaproveitável");
  });

  test("obterQrAtual(): some também quando o socket fecha antes de conectar (expira, não fica preso em memória)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar: () => {},
    });

    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { qr: "2@qr-que-vai-expirar==" });
    assert.equal(sessao.obterQrAtual(), "2@qr-que-vai-expirar==");

    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_CONNECTION_LOST } } },
    });
    assert.equal(sessao.obterQrAtual(), null);
  });

  test("desconexão transitória agenda reconexão com backoff (nunca em LOGGED_OUT)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const chamadasAgendar = [];
    const agendar = (fn, ms) => { chamadasAgendar.push(ms); fn(); }; // executa na hora, só registra o atraso pedido
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar,
    });

    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_CONNECTION_LOST } } },
    });

    assert.equal(chamadasAgendar.length, 1);
    assert.ok(chamadasAgendar[0] > 0);
    // `conectar()` é assíncrono (aguarda authAdapter.carregar() e o import
    // dinâmico do Baileys antes de criar o socket) — dar um respiro real
    // para essa cadeia terminar antes de checar quantos sockets existem.
    await new Promise((resolve) => setTimeout(resolve, 20));
    // reconectou de fato — uma segunda instância de socket foi criada.
    assert.equal(fabricaSocket.criados.length, 2);
  });

  test("backoff cresce exponencialmente e respeita o teto configurado", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const chamadasAgendar = [];
    const agendar = (fn, ms) => { chamadasAgendar.push(ms); fn(); };
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(),
      config: { ...configFalso(), reconnect: { baseMs: 10, tetoMs: 25 } },
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar,
    });

    await sessao.conectar();
    const fechar = () => fabricaSocket.criados.at(-1).ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_CONNECTION_LOST } } },
    });
    fechar(); // tentativa 1: base*2^0=10
    fechar(); // tentativa 2: base*2^1=20
    fechar(); // tentativa 3: base*2^2=40 -> capado em 25 (teto)

    assert.ok(chamadasAgendar[0] <= 12); // 10 + até 20% de jitter
    assert.ok(chamadasAgendar[2] <= 25 + 0.01); // nunca ultrapassa o teto
  });

  test("LOGGED_OUT é terminal: NUNCA agenda reconexão automática", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const chamadasAgendar = [];
    const agendar = (fn, ms) => { chamadasAgendar.push(ms); fn(); };
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar,
    });

    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_LOGGED_OUT } } },
    });

    assert.equal(sessao._status(), STATUS_CONEXAO.LOGGED_OUT);
    assert.equal(chamadasAgendar.length, 0);
    assert.equal(fabricaSocket.criados.length, 1); // nenhum novo socket foi criado
  });

  test("QR recebido não muda o status para CONNECTED e dispara heartbeat com o qr", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });

    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { qr: "QR-STRING-FAKE-DE-TESTE" });

    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTING);
    assert.equal(backendClient.notificarHeartbeat.mock.calls.length, 1);
    assert.equal(backendClient.notificarHeartbeat.mock.calls[0].arguments[0].qr, "QR-STRING-FAKE-DE-TESTE");
  });
});

describe("baileysSession — envio", () => {
  async function sessaoConectada() {
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    return { sessao, socket: fabricaSocket.criados[0] };
  }

  test("enviar() chama sock.sendMessage com o JID correto e devolve providerMessageId", async () => {
    const { sessao, socket } = await sessaoConectada();
    const r = await sessao.enviar({ tipo: "text", telefoneE164: "+5511999990000", conteudo: { text: "oi" } });
    assert.equal(socket.sendMessage.mock.calls.length, 1);
    assert.equal(socket.sendMessage.mock.calls[0].arguments[0], "5511999990000@s.whatsapp.net");
    assert.ok(r.providerMessageId);
    assert.ok(r.enviadoEm);
  });

  test("enviar() sem estar conectado lança erro com preEnvio=true (retryável, nada saiu)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await assert.rejects(
      () => sessao.enviar({ tipo: "text", telefoneE164: "+5511999990000", conteudo: { text: "oi" } }),
      (e) => { assert.equal(e.preEnvio, true); return true; },
    );
  });

  test("markAsRead chama sock.readMessages com o JID correto", async () => {
    const { sessao, socket } = await sessaoConectada();
    await sessao.markAsRead({ providerMessageId: "abc", telefoneE164: "+5511999990000" });
    assert.equal(socket.readMessages.mock.calls.length, 1);
    assert.equal(socket.readMessages.mock.calls[0].arguments[0][0].remoteJid, "5511999990000@s.whatsapp.net");
  });
});

describe("baileysSession — eventos de mensagem", () => {
  test("messages.upsert ignora mensagens fromMe (eco do próprio envio)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await sessao.conectar();

    fabricaSocket.criados[0].ev.emit("messages.upsert", {
      messages: [{ key: { fromMe: true, id: "x" } }],
    });
    assert.equal(backendClient.notificarMensagemRecebida.mock.calls.length, 0);
  });

  test("messages.upsert notifica o backend para mensagem recebida de terceiro", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await sessao.conectar();

    fabricaSocket.criados[0].ev.emit("messages.upsert", {
      messages: [{ key: { fromMe: false, id: "m1", remoteJid: "5511999990000@s.whatsapp.net" } }],
    });
    assert.equal(backendClient.notificarMensagemRecebida.mock.calls.length, 1);
    assert.equal(backendClient.notificarMensagemRecebida.mock.calls[0].arguments[0].telefoneE164, "+5511999990000");
  });

  test("onMessage registra handler chamado para mensagem de terceiro", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await sessao.conectar();

    const handler = mock.fn();
    sessao.onMessage(handler);
    fabricaSocket.criados[0].ev.emit("messages.upsert", {
      messages: [{ key: { fromMe: false, id: "m1", remoteJid: "5511999990000@s.whatsapp.net" } }],
    });
    assert.equal(handler.mock.calls.length, 1);
  });

  test("messages.update alimenta getMessageStatus e notifica o backend", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await sessao.conectar();

    fabricaSocket.criados[0].ev.emit("messages.update", [{ key: { id: "m1" }, update: { status: 3 } }]);
    assert.deepEqual(await sessao.getMessageStatus("m1"), { status: 3 });
    assert.equal(backendClient.notificarStatusProvider.mock.calls.length, 1);
  });

  test("getMessageStatus para id desconhecido devolve UNKNOWN", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    assert.deepEqual(await sessao.getMessageStatus("nunca-existiu"), { status: "UNKNOWN" });
  });
});

describe("baileysSession — creds.update persiste via authAdapter", () => {
  test("emitir creds.update chama authAdapter.aoAtualizarCreds", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const authAdapter = authAdapterFalso();
    authAdapter.aoAtualizarCreds = mock.fn(authAdapter.aoAtualizarCreds);
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("creds.update", { fake: "creds" });
    assert.equal(authAdapter.aoAtualizarCreds.mock.calls.length, 1);
  });
});
