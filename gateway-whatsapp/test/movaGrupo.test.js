// MOVA no Gateway: caminho à parte, só grupos autorizados, mesma sessão, sem interferir no inbound atual.
// Tudo sintético (JIDs e ids inventados).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTRATO_MOVA_VERSAO, criarEncaminhadorMova, lerGruposMova, montarEventoMova } from "../src/movaGrupo.js";
import { criarRastreadorOrigem } from "../src/inboundContrato.js";
import { criarSessaoBaileys } from "../src/baileysSession.js";
import { EventEmitter } from "node:events";
import { CODIGOS } from "../src/errors.js";

const G = "120363000000000001@g.us";
const OUTRO = "120363000000000099@g.us";
const msg = (extra = {}) => ({ key: { remoteJid: G, id: "ABCDEF0001", fromMe: false, participant: "100000000000001@lid", ...(extra.key ?? {}) }, pushName: "Pessoa Sintética", messageTimestamp: 1792076400, message: { conversation: "boleto alfa" }, ...extra, ...(extra.key ? { key: { remoteJid: G, id: "ABCDEF0001", fromMe: false, participant: "100000000000001@lid", ...extra.key } } : {}) });

test("configuração: vazio = desligado; JID fora do formato derruba o boot", () => {
  assert.deepEqual(lerGruposMova(""), []);
  assert.deepEqual(lerGruposMova(` ${G} , ${G} `), [G]);
  assert.throws(() => lerGruposMova("5500000000098@s.whatsapp.net"), /JIDs de grupo/);
});

test("payload: grupo autorizado com texto, participante, nome (não é prova) e origem por mensagem", () => {
  const p = montarEventoMova(msg(), { grupos: [G], origemTipo: "LIVE" });
  assert.deepEqual(p, {
    contratoMova: CONTRATO_MOVA_VERSAO, eventoId: "bly:ABCDEF0001", mensagemId: "ABCDEF0001", grupoId: G, participanteId: "100000000000001@lid",
    telefoneE164: null, nomeExibicao: "Pessoa Sintética", fromMe: false, tipo: "TEXTO", texto: "boleto alfa", respostaA: null, midia: null,
    recebidoEm: new Date(1792076400 * 1000).toISOString(), origemTipo: "LIVE",
  });
});

test("filtros: grupo não autorizado, privado, própria conta e stub não saem", () => {
  assert.equal(montarEventoMova(msg({ key: { remoteJid: OUTRO } }), { grupos: [G] }), null);
  assert.equal(montarEventoMova(msg({ key: { remoteJid: "5500000000099@s.whatsapp.net" } }), { grupos: [G] }), null);
  assert.equal(montarEventoMova(msg({ key: { fromMe: true } }), { grupos: [G] }), null);
  assert.equal(montarEventoMova(msg({ messageStubType: 1 }), { grupos: [G] }), null);
});

test("legenda, documento, áudio e mensagem respondida são preservados; mídia baixada pela sessão existente", async () => {
  const enviados = [];
  const sockets = [];
  const enc = criarEncaminhadorMova({ grupos: [G], notificar: async (p) => enviados.push(p), baixarMidia: async (_m, s) => { sockets.push(s); return Buffer.from("%PDF-sintetico"); } });
  const doc = msg({ key: { id: "DOC0000001" }, message: { documentMessage: { caption: "pago gama", mimetype: "application/pdf", fileName: "c.pdf", contextInfo: { stanzaId: "ABCDEF0001" } } } });
  const audio = msg({ key: { id: "AUD0000001" }, message: { audioMessage: { mimetype: "audio/ogg; codecs=opus" } } });
  const socketAtual = { id: "sock-1" };
  await Promise.all(enc.aoMensagens([doc, audio], { socket: socketAtual }));
  assert.deepEqual(enviados.map((p) => [p.tipo, p.texto, p.respostaA, p.midia.mime, p.midia.tamanhoBytes]), [["DOCUMENTO", "pago gama", "ABCDEF0001", "application/pdf", 14], ["AUDIO", null, null, "audio/ogg", 14]]);
  assert.equal(enviados[0].midia.base64, Buffer.from("%PDF-sintetico").toString("base64"));
  assert.deepEqual(sockets, [socketAtual, socketAtual]);                  // nenhuma conexão nova
});

test("reconexão: a mesma mensagem reentregue no socket novo sai uma vez por processo (o backend deduplica entre processos)", async () => {
  const enviados = [];
  const enc = criarEncaminhadorMova({ grupos: [G], notificar: async (p) => enviados.push(p.eventoId) });
  await Promise.all(enc.aoMensagens([msg()], { socket: { id: 1 } }));
  await Promise.all(enc.aoMensagens([msg()], { socket: { id: 2 } }));
  assert.deepEqual(enviados, ["bly:ABCDEF0001"]);
});

test("desligado: sem grupos nada é lido nem enviado; falha do backend nunca lança", async () => {
  let chamadas = 0;
  const off = criarEncaminhadorMova({ grupos: [], notificar: async () => { chamadas += 1; } });
  assert.equal(off.ativo, false);
  assert.deepEqual(off.aoMensagens([msg()]), []);
  const quebra = criarEncaminhadorMova({ grupos: [G], notificar: async () => { throw new Error("503"); } });
  await assert.doesNotReject(Promise.all(quebra.aoMensagens([msg({ key: { id: "X000000001" } })])));
  assert.equal(chamadas, 0);
});

test("rastreador: espiar não consome a origem que o fluxo inbound ainda vai consumir", () => {
  const r = criarRastreadorOrigem();
  r.registrar({ attrs: { id: "ABCDEF0001" } });
  assert.equal(r.espiar("ABCDEF0001"), "LIVE");
  assert.equal(r.consumir("ABCDEF0001"), "LIVE");
  assert.equal(r.espiar("ABCDEF0001"), "OFFLINE_NORMAL");
});

test("sessão: com MOVA ligado, o fluxo atual segue igual (grupo continua no inbound geral SEM conteúdo) e o MOVA recebe à parte, no mesmo socket", async () => {
  const sockets = [];
  const fabricaSocket = () => { const s = { ev: new EventEmitter(), ws: new EventEmitter(), user: null, end: async () => {} }; sockets.push(s); return s; };
  const geral = [];
  const movaRecebeu = [];
  const backendClient = {
    notificarHeartbeat: async () => {}, notificarMensagemRecebida: async (e) => { geral.push(e); }, notificarStatusProvider: async () => {},
    definirEstadoDesejado: async () => ({ ok: true }), obterEstadoSessao: async () => ({ status: "DISCONNECTED", desiredConnectionState: "DISCONNECTED" }),
    resetarAuthState: async () => ({ ok: true }), confirmarAuthState: async () => ({}),
  };
  const authAdapter = {
    async carregar() { return { status: "absent" }; }, inicializarCreds() {}, comoAuthState() { return { creds: {}, keys: { get: async () => ({}), set: async () => {} } }; },
    async aoAtualizarCreds() {}, async aguardarPersistenciasPendentes() {}, obterAuthSessionIdAtual() { return "11111111-1111-4111-8111-111111111111"; },
  };
  const sessao = criarSessaoBaileys({
    authAdapter, backendClient, config: { providerInstanceId: "teste", heartbeatIntervalMs: 60_000 }, fabricaSocket, DisconnectReasonLoggedOut: 401,
    agendar: () => 0, cancelar: () => {},
    mova: { aoMensagens: (messages, o) => { movaRecebeu.push({ n: messages.length, origem: o.origemDe(messages[0].key.id), socket: o.socket }); return []; } },
  });
  await sessao.conectar();
  assert.equal(sockets.length, 1);
  sockets[0].ws.emit("CB:message", { attrs: { id: "ABCDEF0001" } });          // nó vivo: origem LIVE
  sockets[0].ev.emit("messages.upsert", { messages: [msg()], type: "notify" });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(movaRecebeu.map((x) => [x.n, x.origem, x.socket === sockets[0]]), [[1, "LIVE", true]]);
  assert.equal(geral.length, 1, "o inbound geral continua recebendo a mensagem do grupo");
  assert.equal(geral[0].origemJidTipo, "group");
  assert.equal(geral[0].origemTipo, "LIVE", "a origem continua sendo consumida pelo fluxo atual");
  assert.ok(!geral[0].texto, "conteúdo de grupo continua fora da Central de Comunicação");
});

test("envio do MOVA: desligado por padrão; grupo fora da lista recusado; ligado e autorizado passa às checagens normais (conexão)", async () => {
  const fab = () => ({ ev: new EventEmitter(), ws: new EventEmitter(), user: null, end: async () => {} });
  const mk = (config) => criarSessaoBaileys({ authAdapter: { comoAuthState: () => ({}) }, backendClient: {}, config: { providerInstanceId: "t", ...config }, fabricaSocket: fab, DisconnectReasonLoggedOut: 401, agendar: () => 0, cancelar: () => {} });
  await assert.rejects(mk({}).enviarGrupoMova({ grupoJid: G, texto: "oi" }), (e) => e.codigo === CODIGOS.GRUPO_NAO_AUTORIZADO && e.preEnvio === true);
  await assert.rejects(mk({ movaEnvioHabilitado: true, movaGrupos: [G] }).enviarGrupoMova({ grupoJid: OUTRO, texto: "oi" }), (e) => e.codigo === CODIGOS.GRUPO_NAO_AUTORIZADO);
  await assert.rejects(mk({ movaEnvioHabilitado: true, movaGrupos: [G] }).enviarGrupoMova({ grupoJid: G, texto: "oi" }), (e) => e.codigo === CODIGOS.NAO_CONECTADO && e.preEnvio === true);
  await assert.rejects(mk({ movaEnvioHabilitado: true, movaGrupos: [G], grupoInternoJid: null }).enviarGrupoInterno({ grupoJid: G, texto: "oi" }), (e) => e.codigo === CODIGOS.GRUPO_NAO_AUTORIZADO, "o grupo do MOVA não vira grupo interno");
});
