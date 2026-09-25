// Central de Comunicação — foto de perfil: sessao.fotoPerfil() e a rota HMAC POST /internal/whatsapp/perfil-foto.
// A ausência de foto NUNCA é erro: o Gateway devolve {url: null, motivo} e a interface usa o avatar de iniciais.
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import express from "express";
import { createServer } from "node:http";
import { criarSessaoBaileys } from "../src/baileysSession.js";
import { exigirHmac, assinarRequisicao } from "../src/hmac.js";
import { criarRotas } from "../src/routes.js";

const AUTH_ID = "11111111-1111-4111-8111-111111111111";
const TEL = "+5511987654321";
const URL_FOTO = "https://pps.whatsapp.net/v/t61/foto.jpg?e=1";

function fabricaFalsa({ onWhatsApp, profilePictureUrl } = {}) {
  const criados = [];
  const fabrica = () => {
    const socket = {
      ev: new EventEmitter(), ws: new EventEmitter(), user: { id: "5511999990000:1@s.whatsapp.net" },
      onWhatsApp: onWhatsApp ?? mock.fn(async (d) => [{ jid: `${d}@s.whatsapp.net`, exists: true }]),
      profilePictureUrl: profilePictureUrl ?? mock.fn(async () => URL_FOTO),
      sendMessage: mock.fn(async () => ({ key: { id: "x" } })), readMessages: mock.fn(async () => {}), end: mock.fn(async () => {}),
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

async function sessaoConectada(opcoes, { conectar = true } = {}) {
  const fabricaSocket = fabricaFalsa(opcoes);
  const sessao = criarSessaoBaileys({
    authAdapter: authFalso(), backendClient: backendFalso(), config: { reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "t", gatewayVersion: "0" },
    fabricaSocket, DisconnectReasonLoggedOut: 401, leaseManager: leaseFalso(),
  });
  if (conectar) {
    await sessao.conectar();
    const socket = fabricaSocket.criados[0];
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("creds.update", { registered: true });
    await new Promise((r) => setImmediate(r));
  }
  return { sessao, socket: fabricaSocket.criados[0] };
}

describe("sessao.fotoPerfil()", () => {
  test("foto disponível: devolve a URL, consultando o JID CANÔNICO em 'preview'", async () => {
    const onWhatsApp = mock.fn(async () => [{ jid: "551187654321@s.whatsapp.net", exists: true }]);   // sem o 9º dígito
    const { sessao, socket } = await sessaoConectada({ onWhatsApp });
    assert.deepEqual(await sessao.fotoPerfil({ telefoneE164: TEL }), { url: URL_FOTO, motivo: "ok" });
    assert.deepEqual(socket.profilePictureUrl.mock.calls[0].arguments.slice(0, 2), ["551187654321@s.whatsapp.net", "preview"]);
  });

  test("sem foto / privacidade (404 e 401) NÃO é erro: url null, motivo sem_foto", async () => {
    for (const data of [404, 401]) {
      const { sessao } = await sessaoConectada({ profilePictureUrl: mock.fn(async () => { throw Object.assign(new Error("x"), { data }); }) });
      assert.deepEqual(await sessao.fotoPerfil({ telefoneE164: TEL }), { url: null, motivo: "sem_foto" }, String(data));
    }
  });

  test("outro erro do provider ⇒ motivo 'erro' (nunca lança)", async () => {
    const { sessao } = await sessaoConectada({ profilePictureUrl: mock.fn(async () => { throw new Error("boom"); }) });
    assert.deepEqual(await sessao.fotoPerfil({ telefoneE164: TEL }), { url: null, motivo: "erro" });
  });

  test("URL que não é https (ou vazia) nunca é aceita", async () => {
    for (const url of ["http://x/y.jpg", "javascript:alert(1)", "", null, undefined, 5]) {
      const { sessao } = await sessaoConectada({ profilePictureUrl: mock.fn(async () => url) });
      assert.deepEqual(await sessao.fotoPerfil({ telefoneE164: TEL }), { url: null, motivo: "sem_foto" }, String(url));
    }
  });

  test("número fora do WhatsApp / consulta falhou ⇒ 'destinatario', sem consultar a foto", async () => {
    for (const onWhatsApp of [mock.fn(async () => []), mock.fn(async () => { throw new Error("rede"); })]) {
      const { sessao, socket } = await sessaoConectada({ onWhatsApp });
      assert.deepEqual(await sessao.fotoPerfil({ telefoneE164: TEL }), { url: null, motivo: "destinatario" });
      assert.equal(socket.profilePictureUrl.mock.callCount(), 0);
    }
  });

  test("sessão desconectada ⇒ 'nao_conectado', sem tocar no socket", async () => {
    const { sessao } = await sessaoConectada({}, { conectar: false });
    assert.deepEqual(await sessao.fotoPerfil({ telefoneE164: TEL }), { url: null, motivo: "nao_conectado" });
  });

  test("telefone inválido nunca chega ao provider", async () => {
    const { sessao, socket } = await sessaoConectada({});
    for (const t of ["", "5511987654321", "+55", null, undefined, "abc"]) assert.equal((await sessao.fotoPerfil({ telefoneE164: t })).url, null);
    assert.equal(socket.profilePictureUrl.mock.callCount(), 0);
  });
});

describe("POST /internal/whatsapp/perfil-foto", () => {
  const SEGREDO = "s".repeat(32);
  let servidor; let baseUrl; let sessao;
  before(async () => {
    sessao = { fotoPerfil: mock.fn(async () => ({ url: URL_FOTO, motivo: "ok" })) };
    const app = express();
    app.use("/internal", express.raw({ type: "*/*", limit: 256 * 1024 }), exigirHmac(SEGREDO), criarRotas(sessao));
    await new Promise((r) => { servidor = createServer(app).listen(0, () => r()); });
    baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  });
  after(() => servidor.close());
  const chamar = (corpoObj, { assinar = true } = {}) => {
    const caminho = "/internal/whatsapp/perfil-foto"; const corpo = JSON.stringify(corpoObj);
    const headers = assinar ? assinarRequisicao({ segredo: SEGREDO, metodo: "POST", caminho, corpo }) : {};
    headers["Content-Type"] = "application/json";
    return fetch(`${baseUrl}${caminho}`, { method: "POST", headers, body: corpo });
  };

  test("com HMAC devolve o resultado, sem cache", async () => {
    const r = await chamar({ telefoneE164: TEL });
    assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "no-store");
    assert.deepEqual(await r.json(), { url: URL_FOTO, motivo: "ok" });
    assert.deepEqual(sessao.fotoPerfil.mock.calls.at(-1).arguments[0], { telefoneE164: TEL });
  });

  test("sem HMAC é recusado e a sessão nunca é consultada", async () => {
    const antes = sessao.fotoPerfil.mock.callCount();
    const r = await chamar({ telefoneE164: TEL }, { assinar: false });
    assert.ok([401, 403].includes(r.status));
    assert.equal(sessao.fotoPerfil.mock.callCount(), antes);
  });

  test("telefone fora do E.164 ⇒ 400 sem consultar a sessão", async () => {
    const antes = sessao.fotoPerfil.mock.callCount();
    for (const t of [undefined, "", "5511987654321", "+55", "+abc"]) assert.equal((await chamar({ telefoneE164: t })).status, 400, String(t));
    assert.equal(sessao.fotoPerfil.mock.callCount(), antes);
  });
});
