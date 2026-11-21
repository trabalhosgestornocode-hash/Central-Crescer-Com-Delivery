// MOVA (15J): o envio PRIVADO registra o conteúdo no cache de retry — sem isto, o retry receipt do aparelho que não
// descriptografou vira "Aguardando mensagem" (visto na 15I). Sessão e socket SIMULADOS; nada vai ao WhatsApp.
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


async function montar({ falharEnvio = false, retryCache = null, autorizado = true } = {}) {
  const fabricaSocket = fabricaFalsa();
  const contato = { identidade: async () => ({ jid: DEST, lid: DEST_LID }), jidAutorizadoParaEnvio: async (j) => autorizado && j === DEST };
  const s = criarSessaoBaileys({
    authAdapter: authFalso(), backendClient: backendFalso(),
    config: { reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "t", gatewayVersion: "0", movaEnvioHabilitado: true },
    fabricaSocket, DisconnectReasonLoggedOut: 401, leaseManager: leaseFalso(), retryCache, mova: { contatoHomologacao: contato },
  });
  await s.conectar();
  const socket = fabricaSocket.criados[0];
  socket.ev.emit("connection.update", { connection: "open" });
  socket.ev.emit("creds.update", { registered: true });
  await new Promise((r) => setImmediate(r));
  socket.sendMessage = mock.fn(async (_j, c, o) => { if (falharEnvio) throw new Error("timeout"); return { key: { id: o.messageId }, message: { conversation: c.text } }; });
  return { s, socket };
}
const espiao = () => { const ch = []; return { ch, marcarEnvioIniciado: (id) => ch.push(["marcar", id]), cancelarEnvio: (id) => ch.push(["cancelar", id]),
  registrarEnvio: (a) => { ch.push(["registrar", a]); return Promise.resolve({ status: "ok" }); } }; };

test("15J envio privado do MOVA: marca antes e REGISTRA o conteúdo cifrado com o JID e o LID do contato verificado", async () => {
  const rc = espiao(); const { s, socket } = await montar({ retryCache: rc });
  const r = await s.enviarGrupoMova({ grupoJid: DEST, texto: "Olá!", correlationId: "mova-saida:x" });
  assert.equal(socket.sendMessage.mock.callCount(), 1);
  assert.deepEqual(rc.ch.map((c) => c[0]), ["marcar", "registrar"]);
  const reg = rc.ch[1][1];
  assert.deepEqual([reg.providerMessageId, reg.destinoJid, reg.destinoLid, reg.mensagem.conversation], [r.providerMessageId, DEST, DEST_LID, "Olá!"]);
});

test("15J falha no envio: cancela a marcação, propaga o erro (sem preEnvio ⇒ INCERTA no relé) e não registra nada", async () => {
  const rc = espiao(); const { s } = await montar({ retryCache: rc, falharEnvio: true });
  await assert.rejects(s.enviarGrupoMova({ grupoJid: DEST, texto: "x" }), (e) => e.preEnvio !== true);
  assert.deepEqual(rc.ch.map((c) => c[0]), ["marcar", "cancelar"]);
});

test("15J cache com defeito ou ausente nunca derruba o envio; destino não verificado continua recusado ANTES de enviar", async () => {
  const quebrado = { marcarEnvioIniciado: () => { throw new Error("x"); }, registrarEnvio: () => { throw new Error("y"); }, cancelarEnvio: () => { throw new Error("z"); } };
  const a = await montar({ retryCache: quebrado });
  assert.ok((await a.s.enviarGrupoMova({ grupoJid: DEST, texto: "x" })).providerMessageId);
  const b = await montar({ retryCache: null });
  assert.ok((await b.s.enviarGrupoMova({ grupoJid: DEST, texto: "x" })).providerMessageId);
  const rc = espiao(); const c = await montar({ retryCache: rc, autorizado: false });
  await assert.rejects(c.s.enviarGrupoMova({ grupoJid: DEST, texto: "x" }), (e) => e.codigo === CODIGOS.GRUPO_NAO_AUTORIZADO && e.preEnvio === true);
  assert.equal(c.socket.sendMessage.mock.callCount(), 0);
  assert.deepEqual(rc.ch, []);
});

test("15J com o CACHE REAL: depois do envio privado do MOVA, o getMessage do retry receipt devolve a mensagem (por PN e pelo LID do contato) — 'Aguardando mensagem' deixa de ficar sem resposta", async () => {
  const { randomBytes } = await import("node:crypto");
  const { proto, generateWAMessageContent } = await import("baileys");
  const { criarCacheRetry } = await import("../src/retryCache.js");
  const { criarBackendRetryFalso } = await import("../test-support/backendRetryFalso.js");
  const beRetry = criarBackendRetryFalso();
  const lease = { souLeader: () => true, contexto: () => ({ ...beRetry.lease }), notificarPerdaExterna: mock.fn(async () => {}) };
  const retryCache = criarCacheRetry({ backendClient: beRetry, chaveEncriptacaoEnv: randomBytes(32).toString("base64"), obterContextoLease: () => lease.contexto(), habilitado: true, emitir: () => {}, esperaPendenteMs: 200 });
  const criados = [];
  const fabricaSocket = (opcoes) => {
    const socket = { opcoes, ev: new EventEmitter(), ws: new EventEmitter(), user: { id: "5511999990000:1@s.whatsapp.net", lid: "100000000000001:1@lid" },
      onWhatsApp: mock.fn(async (d) => [{ jid: `${d}@s.whatsapp.net`, exists: true }]),
      sendMessage: mock.fn(async (_j, c, o) => ({ key: { id: o?.messageId }, message: await generateWAMessageContent(c, {}) })),
      readMessages: mock.fn(async () => {}), end: mock.fn(async () => {}) };
    criados.push(socket); return socket;
  };
  const contato = { identidade: async () => ({ jid: DEST, lid: DEST_LID }), jidAutorizadoParaEnvio: async (j) => j === DEST };
  const s = criarSessaoBaileys({ authAdapter: authFalso(), backendClient: backendFalso(), fabricaSocket, DisconnectReasonLoggedOut: 401, leaseManager: lease, retryCache,
    config: { reconnect: { baseMs: 5, tetoMs: 10 }, heartbeatMs: 1_000_000, providerInstanceId: "default", gatewayVersion: "0", movaEnvioHabilitado: true }, mova: { contatoHomologacao: contato } });
  await s.conectar();
  criados[0].ev.emit("connection.update", { connection: "open" });
  criados[0].ev.emit("creds.update", { registered: true });
  await new Promise((r) => setImmediate(r));
  const { providerMessageId } = await s.enviarGrupoMova({ grupoJid: DEST, texto: "Olá! Sou o MOVA.", correlationId: "mova-saida:x" });
  for (let i = 0; i < 50 && beRetry.linhas.size === 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(beRetry.linhas.size, 1, "conteúdo persistido (cifrado) para sobreviver a reinício");
  const porPn = await criados[0].opcoes.getMessage({ remoteJid: DEST, id: providerMessageId, fromMe: true, participant: DEST });
  assert.ok(porPn instanceof proto.Message);
  assert.equal(proto.Message.toObject(porPn).extendedTextMessage?.text ?? proto.Message.toObject(porPn).conversation, "Olá! Sou o MOVA.");
  const porLid = await criados[0].opcoes.getMessage({ remoteJid: `${DEST_LID.split("@")[0]}:0@lid`, id: providerMessageId, fromMe: true, participant: `${DEST_LID.split("@")[0]}:0@lid` });
  assert.ok(porLid, "o retry da 15I chegou endereçado ao LID");
  await s.desconectar();
});
