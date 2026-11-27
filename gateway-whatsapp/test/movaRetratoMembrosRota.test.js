// 27/11 (PR #236) — retrato dos membros SOB DEMANDA para o aviso diário (rota /internal/mova/membros → sessao.retratoMembrosMova).
// Somente leitura: só grupos de WHATSAPP_MOVA_GRUPOS_JID, só com a sessão conectada; falha ⇒ null (a rota responde 503). Nada é enviado.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { criarSessaoBaileys } from "../src/baileysSession.js";

const GRUPO = "120363000000000001@g.us";
const OUTRO = "120363000000000099@g.us";
const AUTH_ID = "11111111-1111-4111-8111-111111111111";

function montar({ retratarMembros, movaGrupos = [GRUPO], conectar = true } = {}) {
  const criados = [];
  const fabricaSocket = () => {
    const socket = { ev: new EventEmitter(), ws: new EventEmitter(), user: { id: "5511999990000:1@s.whatsapp.net" },
      sendMessage: mock.fn(async () => ({ key: { id: "x" } })), readMessages: mock.fn(async () => {}), end: mock.fn(async () => {}), groupMetadata: mock.fn(async () => ({})) };
    criados.push(socket); return socket;
  };
  let creds = null;
  const authAdapter = { async carregar() { return { status: "absent" }; }, inicializarCreds(c) { creds = c; }, invalidarLocal() { creds = null; },
    comoAuthState() { return { creds, keys: { get: async () => ({}), set: async () => {} } }; }, async aoAtualizarCreds(d) { creds = { ...(creds ?? {}), ...d }; },
    async aguardarPersistenciasPendentes() {}, obterAuthSessionIdAtual() { return AUTH_ID; } };
  const backendClient = { notificarHeartbeat: mock.fn(async () => {}), notificarMensagemRecebida: mock.fn(async () => {}), notificarStatusProvider: mock.fn(async () => ({ ok: true })),
    definirEstadoDesejado: mock.fn(async () => ({ ok: true })), obterEstadoSessao: mock.fn(async () => ({ status: "DISCONNECTED", desiredConnectionState: "DISCONNECTED" })),
    resetarAuthState: mock.fn(async () => ({ ok: true })), confirmarAuthState: mock.fn(async () => ({})) };
  const mova = retratarMembros === undefined ? null : { retratarMembros, aoMensagens: () => {} };
  const sessao = criarSessaoBaileys({ authAdapter, backendClient, fabricaSocket, DisconnectReasonLoggedOut: 401, mova,
    config: { reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "t", gatewayVersion: "0", movaGrupos },
    leaseManager: { souLeader: () => true, contexto: () => ({ gatewayProcessId: "p", leaseEpoch: 1 }), notificarPerdaExterna: mock.fn(async () => {}) } });
  const ligar = async () => {
    await sessao.conectar();
    const s = criados[0]; s.ev.emit("connection.update", { connection: "open" }); s.ev.emit("creds.update", { registered: true });
    await new Promise((r) => setImmediate(r));
    return s;
  };
  return { sessao, ligar, criados, conectar };
}

test("RMR1 grupo do MOVA com a sessão conectada: devolve o retrato do WhatsApp (mesmo socket), sem enviar nada", async () => {
  const retratarMembros = mock.fn(async (g) => ({ membros: ["5500000000001@s.whatsapp.net"], verificadoEm: "2026-11-27T13:00:00.000Z", grupo: g }));
  const m = montar({ retratarMembros });
  const socket = await m.ligar();
  const r = await m.sessao.retratoMembrosMova({ grupoJid: GRUPO });
  assert.deepEqual([r.membros, r.verificadoEm], [["5500000000001@s.whatsapp.net"], "2026-11-27T13:00:00.000Z"]);
  assert.equal(retratarMembros.mock.calls[0].arguments[1], socket, "usa o socket ATUAL da sessão");
  assert.equal(socket.sendMessage.mock.callCount(), 0, "somente leitura");
  await m.sessao.desconectar?.();
});

test("RMR2 recusas fail-closed (null ⇒ 503 na rota): grupo fora da lista, JID inválido, sessão desconectada, MOVA ausente, falha do WhatsApp", async () => {
  const ok = mock.fn(async () => ({ membros: ["a@s.whatsapp.net"], verificadoEm: "2026-11-27T13:00:00.000Z" }));
  const m = montar({ retratarMembros: ok });
  assert.equal(await m.sessao.retratoMembrosMova({ grupoJid: GRUPO }), null, "desconectada");
  await m.ligar();
  for (const grupoJid of [OUTRO, null, 123, ""]) assert.equal(await m.sessao.retratoMembrosMova({ grupoJid }), null, `grupo ${grupoJid}`);
  assert.equal(ok.mock.callCount(), 0, "o WhatsApp nem é consultado fora da lista");
  const semMova = montar({});
  await semMova.ligar();
  assert.equal(await semMova.sessao.retratoMembrosMova({ grupoJid: GRUPO }), null);
  const falha = montar({ retratarMembros: async () => { throw new Error("timeout"); } });
  await falha.ligar();
  assert.equal(await falha.sessao.retratoMembrosMova({ grupoJid: GRUPO }), null);
  for (const movaGrupos of [[], null]) {
    const semLista = montar({ retratarMembros: ok, movaGrupos });
    await semLista.ligar();
    assert.equal(await semLista.sessao.retratoMembrosMova({ grupoJid: GRUPO }), null, "sem WHATSAPP_MOVA_GRUPOS_JID nenhum grupo serve");
  }
});
