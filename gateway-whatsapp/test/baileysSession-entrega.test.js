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

test("23/11 grupo do MOVA: aceite/rejeição do servidor e entrega/leitura/retry POR PARTICIPANTE viram log grupo.recibo (sem número completo, sem conteúdo)", async () => {
  const G = "120363000000000001@g.us";
  const fabricaSocket = fabricaFalsa();
  const sessao = criarSessaoBaileys({
    authAdapter: authFalso(), backendClient: backendFalso(), fabricaSocket, DisconnectReasonLoggedOut: 401, leaseManager: leaseFalso(),
    config: { reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "t", gatewayVersion: "0", movaEnvioHabilitado: true, movaGrupos: [G] },
  });
  await sessao.conectar();
  const socket = fabricaSocket.criados[0];
  socket.groupMetadata = mock.fn(async () => ({ id: G, subject: "Grupo", participants: [{ id: "5511999990000@s.whatsapp.net" }, { id: "5511912345678@s.whatsapp.net" }], size: 2 }));
  socket.ev.emit("connection.update", { connection: "open" });
  socket.ev.emit("creds.update", { registered: true });
  await new Promise((r) => setImmediate(r));
  const linhas = await capturandoLogs(async () => {
    const { providerMessageId: id } = await sessao.enviarGrupoMova({ grupoJid: G, texto: CONTEUDO_SECRETO, correlationId: "mova-resposta:x" });
    socket.ws.emit("CB:ack,class:message", { attrs: { id, class: "message", from: G, t: "1" } });
    socket.ws.emit("CB:receipt", { attrs: { id, from: G, participant: "111122223333:2@lid" } });
    socket.ws.emit("CB:receipt", { attrs: { id, from: G, participant: "111122223333@lid", type: "read" } });
    socket.ws.emit("CB:receipt", { attrs: { id, from: G, participant: "5511912345678:5@s.whatsapp.net", type: "retry" } });
    socket.ws.emit("CB:ack,class:message", { attrs: { id: "OUTRA", class: "message", from: G, error: "421" } }); // não rastreada
    await tick();
  });
  const recibos = linhas.filter((l) => l.evento === "grupo.recibo");
  assert.deepEqual(recibos.map((r) => [r.tipo, r.participante, r.dispositivo]), [
    ["ack_servidor", null, null], ["entrega", "••3333@lid", 2], ["read", "••3333@lid", 0], ["retry", "••5678@pn", 5],
  ]);
  assert.match(recibos[3].severity, /^WARN/);
  const tudo = JSON.stringify(linhas);
  assert.ok(![CONTEUDO_SECRETO, "111122223333", "5511912345678"].some((x) => tudo.includes(x)));
  const start = linhas.find((l) => l.evento === "grupo.send_start");
  assert.equal(start.participantes, 2);
});

test("23/11 redistribuição da chave do grupo: UMA vez, só no grupo configurado e autorizado; outros grupos e demais chaves intactos; log sem material", async () => {
  const G = "120363000000000001@g.us", OUTRO = "120363000000000002@g.us";
  const store = {
    "sender-key-memory": { [G]: { "111122223333:0@lid": true, "444455556666:3@lid": true }, [OUTRO]: { "777788889999:0@lid": true } },
    session: { "5511912345678.0": "SEGREDO-SESSAO" }, "sender-key": { x: "SEGREDO-CHAVE" },
  };
  const keys = {
    async get(tipo, ids) { const o = {}; for (const i of ids) if (store[tipo]?.[i] !== undefined) o[i] = store[tipo][i]; return o; },
    async set(d) { for (const t of Object.keys(d)) for (const i of Object.keys(d[t])) { store[t] ??= {}; if (d[t][i] === null) delete store[t][i]; else store[t][i] = d[t][i]; } },
  };
  const fabricaSocket = fabricaFalsa();
  const sessao = criarSessaoBaileys({
    authAdapter: authFalso(), backendClient: backendFalso(), fabricaSocket, DisconnectReasonLoggedOut: 401, leaseManager: leaseFalso(),
    config: { reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "t", gatewayVersion: "0", movaEnvioHabilitado: true,
      movaGrupos: [G, OUTRO], movaRedistribuirChaveGrupo: G },
  });
  await sessao.conectar();
  const socket = fabricaSocket.criados[0];
  socket.authState = { keys };
  socket.groupMetadata = mock.fn(async (jid) => ({ id: jid, subject: "Grupo", participants: [{ id: "5511999990000@s.whatsapp.net" }, { id: "111122223333@lid" }, { id: "444455556666@lid" }], size: 3 }));
  // Simula o Baileys: marca na memória todo aparelho do grupo que ainda não tinha a chave.
  socket.sendMessage = mock.fn(async (jid, _c, { messageId }) => {
    const m = (await keys.get("sender-key-memory", [jid]))[jid] ?? {};
    await keys.set({ "sender-key-memory": { [jid]: { ...m, "111122223333:0@lid": true, "444455556666:3@lid": true, "444455556666:0@lid": true } } });
    return { key: { id: messageId } };
  });
  socket.ev.emit("connection.update", { connection: "open" });
  socket.ev.emit("creds.update", { registered: true });
  await new Promise((r) => setImmediate(r));
  const linhas = await capturandoLogs(async () => {
    await sessao.enviarGrupoMova({ grupoJid: G, texto: CONTEUDO_SECRETO, correlationId: "t1" });
    await sessao.enviarGrupoMova({ grupoJid: G, texto: CONTEUDO_SECRETO, correlationId: "t2" });
    await sessao.enviarGrupoMova({ grupoJid: OUTRO, texto: CONTEUDO_SECRETO, correlationId: "t3" });
  });
  const redis = linhas.filter((l) => l.evento === "grupo.chave_redistribuicao");
  assert.equal(redis.length, 1);
  assert.equal(redis[0].correlationId, "t1");
  assert.equal(redis[0].aparelhosComChaveAntes, 2);
  const dist = linhas.filter((l) => l.evento === "grupo.chave_distribuicao");
  assert.deepEqual(dist.map((d) => [d.correlationId, d.aparelhosConhecidos, d.chaveEnviadaAgora]), [["t1", 3, 3], ["t2", 3, 0], ["t3", 4, 3]]);
  assert.deepEqual(dist[0].aparelhos.map((a) => [a.participante, a.dispositivo]), [["••3333@lid", 0], ["••6666@lid", 3], ["••6666@lid", 0]]);
  assert.ok(store["sender-key-memory"][OUTRO]["777788889999:0@lid"], "o outro grupo não foi zerado");
  // demais chaves intactas
  assert.equal(store.session["5511912345678.0"], "SEGREDO-SESSAO");
  assert.equal(store["sender-key"].x, "SEGREDO-CHAVE");
  const tudo = JSON.stringify(linhas);
  assert.ok(![CONTEUDO_SECRETO, "SEGREDO", "111122223333", "444455556666"].some((x) => tudo.includes(x)));
});

test("23/11 redistribuição: grupo fora da lista autorizada nunca é tocado, mesmo configurado", async () => {
  const G = "120363000000000001@g.us", FORA = "120363000000000009@g.us";
  const store = { "sender-key-memory": { [FORA]: { "111122223333:0@lid": true } } };
  const keys = { async get(t, ids) { const o = {}; for (const i of ids) if (store[t]?.[i] !== undefined) o[i] = store[t][i]; return o; },
    async set(d) { for (const t of Object.keys(d)) for (const i of Object.keys(d[t])) { if (d[t][i] === null) delete store[t][i]; else store[t][i] = d[t][i]; } } };
  const fabricaSocket = fabricaFalsa();
  const sessao = criarSessaoBaileys({
    authAdapter: authFalso(), backendClient: backendFalso(), fabricaSocket, DisconnectReasonLoggedOut: 401, leaseManager: leaseFalso(),
    config: { reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "t", gatewayVersion: "0", movaEnvioHabilitado: true,
      movaGrupos: [G], movaRedistribuirChaveGrupo: FORA },
  });
  await sessao.conectar();
  const socket = fabricaSocket.criados[0];
  socket.authState = { keys };
  socket.ev.emit("connection.update", { connection: "open" });
  socket.ev.emit("creds.update", { registered: true });
  await new Promise((r) => setImmediate(r));
  await capturandoLogs(async () => { await assert.rejects(sessao.enviarGrupoMova({ grupoJid: FORA, texto: "x", correlationId: "f" })); });
  assert.deepEqual(store["sender-key-memory"][FORA], { "111122223333:0@lid": true });
});
