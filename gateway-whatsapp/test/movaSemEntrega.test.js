// MOVA — vigia de entrega das respostas em grupo (28/11). Sessão e socket SIMULADOS; nada vai ao WhatsApp.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { criarSessaoBaileys } from "../src/baileysSession.js";
import { CODIGOS } from "../src/errors.js";

const AUTH_ID = "11111111-1111-4111-8111-111111111111";
const GRUPO = "120363000000000001@g.us";
const OUTRO_GRUPO = "120363000000000002@g.us";
const EU_PN = "5511999990000@s.whatsapp.net";
const DEST = "559990000001@s.whatsapp.net";
const DEST_LID = "987654321098765@lid";
const metaGrupo = (over = {}) => ({ id: GRUPO, subject: "x", size: 1, announce: false, participants: [{ id: EU_PN, jid: EU_PN, admin: null }], ...over });
function fabricaFalsa({ groupMetadata, groupFetchAllParticipating } = {}) {
  const criados = [];
  const fabrica = () => {
    const socket = {
      ev: new EventEmitter(), ws: new EventEmitter(), user: { id: "5511999990000:1@s.whatsapp.net", lid: "123456789012345:1@lid" },
      onWhatsApp: mock.fn(async (d) => [{ jid: `${d}@s.whatsapp.net`, exists: true }]),
      groupMetadata: groupMetadata ?? mock.fn(async () => metaGrupo()),
      groupFetchAllParticipating: groupFetchAllParticipating ?? mock.fn(async () => ({
        [GRUPO]: metaGrupo(),
        [OUTRO_GRUPO]: metaGrupo({ id: OUTRO_GRUPO, subject: "Amigos", size: 10, announce: true }),
      })),
      sendMessage: mock.fn(async (_jid, _c, opts) => ({ key: { id: opts?.messageId ?? "x" } })),
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
  notificarHeartbeat: mock.fn(async () => {}), notificarMensagemRecebida: mock.fn(async () => {}), notificarStatusProvider: mock.fn(async () => ({ ok: true })),
  definirEstadoDesejado: mock.fn(async () => ({ ok: true })), obterEstadoSessao: mock.fn(async () => ({ status: "DISCONNECTED", desiredConnectionState: "DISCONNECTED" })),
  resetarAuthState: mock.fn(async () => ({ ok: true })), confirmarAuthState: mock.fn(async () => ({})),
});
const leaseFalso = () => ({ souLeader: () => true, contexto: () => ({ gatewayProcessId: "proc", leaseEpoch: 12 }), notificarPerdaExterna: mock.fn(async () => {}) });



// 28/11 (caso real): resposta do MOVA aceita pelo servidor e entregue a NENHUM aparelho. A vigia avisa UMA vez (o backend reenvia uma
// cópia) e o próximo envio ao grupo redistribui a chave de remetente. Entrega de qualquer participante desliga o aviso.
const PRAZO = 777;
async function montarGrupo() {
  const fabricaSocket = fabricaFalsa();
  const timers = [];
  const agendar = (fn, ms) => { if (ms === PRAZO) { timers.push(fn); return { unref() {} }; } return setTimeout(fn, ms); };
  const aoSemEntrega = mock.fn(async () => {});
  const sets = [];
  const auth = authFalso();
  const comoAuthState = auth.comoAuthState.bind(auth);
  auth.comoAuthState = () => ({ ...comoAuthState(), keys: { get: async () => ({}), set: async (x) => { sets.push(x); } } });
  const s = criarSessaoBaileys({
    authAdapter: auth, backendClient: backendFalso(), agendar,
    config: { reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "t", gatewayVersion: "0", movaEnvioHabilitado: true, movaGrupos: [GRUPO], movaPrazoEntregaMs: PRAZO },
    fabricaSocket, DisconnectReasonLoggedOut: 401, leaseManager: leaseFalso(), mova: { contatoHomologacao: null }, aoSemEntrega,
  });
  await s.conectar();
  const socket = fabricaSocket.criados[0];
  socket.ev.emit("connection.update", { connection: "open" });
  socket.ev.emit("creds.update", { registered: true });
  await new Promise((r) => setImmediate(r));
  return { s, socket, timers, aoSemEntrega, sets };
}

test("SE-1 nenhuma entrega no prazo: avisa UMA vez com o id; o próximo envio ao grupo redistribui a chave", async () => {
  const g = await montarGrupo();
  const r = await g.s.enviarGrupoMova({ grupoJid: GRUPO, texto: "Proposta sintética", correlationId: "mova-resposta:abc" });
  g.socket.ws.emit("CB:ack,class:message", { attrs: { id: r.providerMessageId, class: "message" } }); // só o aceite do servidor
  assert.equal(g.timers.length, 1);
  g.timers[0]();
  await new Promise((x) => setImmediate(x));
  assert.equal(g.aoSemEntrega.mock.callCount(), 1);
  assert.deepEqual(g.aoSemEntrega.mock.calls[0].arguments[0], { providerMessageId: r.providerMessageId, correlationId: "mova-resposta:abc" });
  assert.equal(g.sets.length, 0);
  await g.s.enviarGrupoMova({ grupoJid: GRUPO, texto: "Reenvio sintético", correlationId: "mova-resposta:def" });
  assert.deepEqual(g.sets, [{ "sender-key-memory": { [GRUPO]: null } }], "chave redistribuída no envio seguinte");
});

test("SE-2 entrega de um participante: nenhum aviso; mensagem que não é do MOVA nem é vigiada", async () => {
  const g = await montarGrupo();
  const r = await g.s.enviarGrupoMova({ grupoJid: GRUPO, texto: "Resposta sintética", correlationId: "mova-resposta:ghi" });
  g.socket.ws.emit("CB:receipt", { attrs: { id: r.providerMessageId, from: GRUPO, participant: "123456789012@lid" } });
  g.timers[0]();
  await g.s.enviarGrupoMova({ grupoJid: GRUPO, texto: "Outro", correlationId: "grupo-interno:1" });
  assert.equal(g.timers.length, 1, "só a resposta do MOVA é vigiada");
  assert.equal(g.aoSemEntrega.mock.callCount(), 0);
});

test("SE-3 recibo 'sender' (a própria conta) não conta como entrega", async () => {
  const g = await montarGrupo();
  const r = await g.s.enviarGrupoMova({ grupoJid: GRUPO, texto: "x", correlationId: "mova-resposta:jkl" });
  g.socket.ws.emit("CB:receipt", { attrs: { id: r.providerMessageId, from: GRUPO, participant: "123456789012@lid", type: "sender" } });
  g.timers[0]();
  assert.equal(g.aoSemEntrega.mock.callCount(), 1);
});
