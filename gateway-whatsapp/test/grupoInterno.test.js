// Exceção ESTREITA de grupo (src/grupoInterno.js): listagem só leitura + envio SOMENTE ao grupo interno configurado.
// Sem Baileys real, sem rede: socket falso injetado (mesmo ponto de injeção de server.js).
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import express from "express";
import { createServer } from "node:http";
import { criarSessaoBaileys } from "../src/baileysSession.js";
import { exigirHmac, assinarRequisicao } from "../src/hmac.js";
import { criarRotas } from "../src/routes.js";
import { REGEX_JID_GRUPO } from "../src/config.js";
import { CODIGOS } from "../src/errors.js";
import { mascararJidGrupo } from "../src/grupoInterno.js";

const AUTH_ID = "11111111-1111-4111-8111-111111111111";
const GRUPO = "120363000000000001@g.us";
const OUTRO_GRUPO = "120363000000000002@g.us";
const EU_PN = "5511999990000@s.whatsapp.net";
const EU_LID = "123456789012345@lid";

const metaGrupo = (over = {}) => ({
  id: GRUPO, subject: "Crescer Com Delivery - Central", size: 3, announce: false,
  participants: [
    { id: EU_PN, jid: EU_PN, lid: undefined, admin: null },
    { id: "5511888880000@s.whatsapp.net", jid: "5511888880000@s.whatsapp.net", admin: "superadmin" },
    { id: "5511777770000@s.whatsapp.net", jid: "5511777770000@s.whatsapp.net", admin: null },
  ],
  ...over,
});

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

async function sessao(opcoes = {}, { conectar = true, grupoInternoJid = GRUPO } = {}) {
  const fabricaSocket = fabricaFalsa(opcoes);
  const s = criarSessaoBaileys({
    authAdapter: authFalso(), backendClient: backendFalso(),
    config: { reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "t", gatewayVersion: "0", grupoInternoJid, grupoTimeoutMs: 50 },
    fabricaSocket, DisconnectReasonLoggedOut: 401, leaseManager: leaseFalso(),
  });
  if (conectar) {
    await s.conectar();
    const socket = fabricaSocket.criados[0];
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("creds.update", { registered: true });
    await new Promise((r) => setImmediate(r));
  }
  return { sessao: s, socket: fabricaSocket.criados[0] };
}

const rejeitaCom = async (p, codigo) => {
  const e = await p.then(() => null, (err) => err);
  assert.ok(e, "esperava erro");
  assert.equal(e.codigo, codigo);
  assert.equal(e.preEnvio, true, "todo bloqueio de grupo é pré-envio");
};

describe("config — WHATSAPP_GRUPO_INTERNO_JID", () => {
  test("aceita só JID de grupo (formato novo e antigo); recusa usuário, LID, broadcast, newsletter", () => {
    for (const ok of [GRUPO, "5511999990000-1600000000@g.us"]) assert.ok(REGEX_JID_GRUPO.test(ok), ok);
    for (const ruim of [EU_PN, EU_LID, "status@broadcast", "123@newsletter", "abc@g.us", "120363000000000001@g.us ", ""]) assert.ok(!REGEX_JID_GRUPO.test(ruim), ruim);
  });
  test("mascararJidGrupo nunca devolve o id inteiro", () => {
    assert.equal(mascararJidGrupo(GRUPO), "…0001@g.us");
  });
});

describe("sessao.listarGrupos()", () => {
  test("devolve só nome/JID/tamanho/somenteAdmins, ordenado por nome — nunca participantes", async () => {
    const { sessao: s } = await sessao();
    const r = await s.listarGrupos();
    assert.equal(r.grupoInternoJid, GRUPO);
    assert.deepEqual(r.grupos, [
      { jid: OUTRO_GRUPO, nome: "Amigos", participantes: 10, somenteAdminsEnviam: true },
      { jid: GRUPO, nome: "Crescer Com Delivery - Central", participantes: 3, somenteAdminsEnviam: false },
    ]);
    assert.ok(!JSON.stringify(r).includes("5511888880000"), "nenhum telefone de participante sai");
  });
  test("desconectado ⇒ NOT_CONNECTED (pré-envio)", async () => {
    const { sessao: s } = await sessao({}, { conectar: false });
    await rejeitaCom(s.listarGrupos(), CODIGOS.NAO_CONECTADO);
  });
  test("falha/timeout da consulta ⇒ GROUP_LOOKUP_FAILED", async () => {
    const { sessao: s } = await sessao({ groupFetchAllParticipating: mock.fn(() => new Promise(() => {})) });
    await rejeitaCom(s.listarGrupos(), CODIGOS.CONSULTA_GRUPO_FALHOU);
  });
});

describe("sessao.verificarGrupoInterno()", () => {
  test("grupo configurado: existe, participa, pode enviar", async () => {
    const { sessao: s } = await sessao();
    const r = await s.verificarGrupoInterno({ grupoJid: GRUPO });
    assert.deepEqual(r, { jid: GRUPO, nome: "Crescer Com Delivery - Central", participantes: 3, participa: true, souAdmin: false, somenteAdminsEnviam: false, podeEnviar: true });
  });
  test("participação reconhecida pelo LID (grupo addressing_mode=lid)", async () => {
    const meta = metaGrupo({ participants: [{ id: EU_LID, jid: "", lid: EU_LID, admin: "admin" }] });
    const { sessao: s } = await sessao({ groupMetadata: mock.fn(async () => meta) });
    const r = await s.verificarGrupoInterno({ grupoJid: GRUPO });
    assert.equal(r.participa, true);
    assert.equal(r.souAdmin, true);
  });
  test("outro grupo ⇒ GROUP_NOT_AUTHORIZED, sem consultar o WhatsApp", async () => {
    const { sessao: s, socket } = await sessao();
    await rejeitaCom(s.verificarGrupoInterno({ grupoJid: OUTRO_GRUPO }), CODIGOS.GRUPO_NAO_AUTORIZADO);
    assert.equal(socket.groupMetadata.mock.callCount(), 0);
  });
  test("sem grupo configurado ⇒ GROUP_NOT_AUTHORIZED", async () => {
    const { sessao: s } = await sessao({}, { grupoInternoJid: null });
    await rejeitaCom(s.verificarGrupoInterno({ grupoJid: GRUPO }), CODIGOS.GRUPO_NAO_AUTORIZADO);
  });
});

describe("sessao.enviarGrupoInterno()", () => {
  test("sucesso: consulta o grupo, envia UM texto ao JID configurado e devolve o providerMessageId", async () => {
    const { sessao: s, socket } = await sessao();
    const r = await s.enviarGrupoInterno({ grupoJid: GRUPO, texto: "olá", correlationId: "k1" });
    assert.equal(socket.sendMessage.mock.callCount(), 1);
    const [jid, conteudo] = socket.sendMessage.mock.calls[0].arguments;
    assert.equal(jid, GRUPO);
    assert.deepEqual(conteudo, { text: "olá" });
    assert.ok(r.providerMessageId);
    assert.equal(r.grupo.nome, "Crescer Com Delivery - Central");
    assert.equal(socket.onWhatsApp.mock.callCount(), 0, "grupo não passa pela resolução de contato individual");
  });

  const casosSemEnvio = [
    ["JID diferente do configurado", {}, { grupoJid: OUTRO_GRUPO }, CODIGOS.GRUPO_NAO_AUTORIZADO, {}],
    ["JID de usuário", {}, { grupoJid: EU_PN }, CODIGOS.GRUPO_NAO_AUTORIZADO, {}],
    ["grupo não configurado", {}, { grupoJid: GRUPO }, CODIGOS.GRUPO_NAO_AUTORIZADO, { grupoInternoJid: null }],
    ["grupo inexistente (404)", { groupMetadata: mock.fn(async () => { throw Object.assign(new Error("item-not-found"), { data: 404 }); }) }, { grupoJid: GRUPO }, CODIGOS.GRUPO_INEXISTENTE, {}],
    ["conta saiu do grupo (403)", { groupMetadata: mock.fn(async () => { throw Object.assign(new Error("forbidden"), { data: 403 }); }) }, { grupoJid: GRUPO }, CODIGOS.GRUPO_INEXISTENTE, {}],
    ["conta não aparece nos participantes", { groupMetadata: mock.fn(async () => metaGrupo({ participants: [{ id: "5511777770000@s.whatsapp.net", jid: "5511777770000@s.whatsapp.net", admin: null }] })) }, { grupoJid: GRUPO }, CODIGOS.GRUPO_INEXISTENTE, {}],
    ["grupo só-admins e a conta não é admin", { groupMetadata: mock.fn(async () => metaGrupo({ announce: true })) }, { grupoJid: GRUPO }, CODIGOS.GRUPO_SEM_PERMISSAO, {}],
    ["timeout da consulta", { groupMetadata: mock.fn(() => new Promise(() => {})) }, { grupoJid: GRUPO }, CODIGOS.CONSULTA_GRUPO_FALHOU, {}],
    ["metadados de outro grupo", { groupMetadata: mock.fn(async () => metaGrupo({ id: OUTRO_GRUPO })) }, { grupoJid: GRUPO }, CODIGOS.CONSULTA_GRUPO_FALHOU, {}],
  ];
  for (const [nome, opcoes, pedido, codigo, cfg] of casosSemEnvio) {
    test(`${nome} ⇒ ${codigo}, nada enviado`, async () => {
      const { sessao: s, socket } = await sessao(opcoes, cfg);
      await rejeitaCom(s.enviarGrupoInterno({ ...pedido, texto: "x" }), codigo);
      assert.equal(socket.sendMessage.mock.callCount(), 0);
    });
  }

  test("desconectado ⇒ NOT_CONNECTED, nada enviado", async () => {
    const { sessao: s } = await sessao({}, { conectar: false });
    await rejeitaCom(s.enviarGrupoInterno({ grupoJid: GRUPO, texto: "x" }), CODIGOS.NAO_CONECTADO);
  });

  test("envio individual (enviar) continua recusando JID de grupo como telefone", async () => {
    const { sessao: s, socket } = await sessao();
    await assert.rejects(s.enviar({ tipo: "text", telefoneE164: GRUPO, conteudo: { text: "x" } }));
    assert.equal(socket.sendMessage.mock.callCount(), 0);
  });
});

describe("rotas HMAC — /internal/whatsapp/grupos e /grupo-interno/*", () => {
  const SEGREDO = "g".repeat(32);
  let servidor, base, s, socket;
  before(async () => {
    ({ sessao: s, socket } = await sessao());
    const app = express();
    app.use("/internal", express.raw({ type: "*/*", limit: 256 * 1024 }), exigirHmac(SEGREDO), criarRotas(s));
    app.use((err, _req, res, _next) => res.status(err?.status ?? 500).json({ error: err?.codigo ?? "WHATSAPP_GATEWAY_UNAVAILABLE" }));
    await new Promise((r) => { servidor = createServer(app).listen(0, r); });
    base = `http://127.0.0.1:${servidor.address().port}`;
  });
  after(() => servidor.close());
  const chamar = (metodo, caminho, obj) => {
    const corpo = obj === undefined ? "" : JSON.stringify(obj);
    const headers = assinarRequisicao({ segredo: SEGREDO, metodo, caminho, corpo });
    if (corpo) headers["Content-Type"] = "application/json";
    return fetch(`${base}${caminho}`, { method: metodo, headers, body: corpo || undefined });
  };

  test("sem HMAC ⇒ 401 (nada de grupo é público)", async () => {
    const r = await fetch(`${base}/internal/whatsapp/grupos`);
    assert.equal(r.status, 401);
  });
  test("GET /grupos lista (no-store)", async () => {
    const r = await chamar("GET", "/internal/whatsapp/grupos");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal((await r.json()).grupos.length, 2);
  });
  test("POST /grupo-interno/verificar", async () => {
    const r = await chamar("POST", "/internal/whatsapp/grupo-interno/verificar", { grupoJid: GRUPO });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).podeEnviar, true);
  });
  test("POST /grupo-interno/messages para OUTRO grupo ⇒ 403, nada enviado", async () => {
    const antes = socket.sendMessage.mock.callCount();
    const r = await chamar("POST", "/internal/whatsapp/grupo-interno/messages", { grupoJid: OUTRO_GRUPO, texto: "x", idempotencyKey: "k" });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, "WHATSAPP_GATEWAY_GROUP_NOT_AUTHORIZED");
    assert.equal(socket.sendMessage.mock.callCount(), antes);
  });
  test("POST /grupo-interno/messages com texto vazio ⇒ 400", async () => {
    const r = await chamar("POST", "/internal/whatsapp/grupo-interno/messages", { grupoJid: GRUPO, texto: " ", idempotencyKey: "k" });
    assert.equal(r.status, 400);
  });
  test("POST /grupo-interno/messages para o grupo configurado ⇒ 200 com providerMessageId", async () => {
    const r = await chamar("POST", "/internal/whatsapp/grupo-interno/messages", { grupoJid: GRUPO, texto: "teste", idempotencyKey: "k2" });
    assert.equal(r.status, 200);
    assert.ok((await r.json()).providerMessageId);
  });
});
