// Sessão × cache de retry: o caminho REAL de enviar() registra o conteúdo, e o getMessage continua servindo depois de o
// socket ser recriado (reconexão) — item 4 do checkpoint. Também prova que, com a flag DESLIGADA, as opções do socket são
// exatamente as de antes (nenhum getMessage/msgRetryCounterCache injetado).
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { proto, generateWAMessageContent } from "baileys";
import { criarSessaoBaileys } from "../src/baileysSession.js";
import { criarCacheRetry } from "../src/retryCache.js";
import { criarBackendRetryFalso } from "../test-support/backendRetryFalso.js";

const AUTH_ID = "11111111-1111-4111-8111-111111111111";
const TEL = "+5511987654321";
const TEXTO = "alerta-de-teste-retry";
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function fabricaQueCapturaOpcoes() {
  const criados = [];
  const fabrica = (opcoes) => {
    const socket = {
      opcoes, ev: new EventEmitter(), ws: new EventEmitter(), user: { id: "5511999990000:1@s.whatsapp.net", lid: "100000000000001:1@lid" },
      onWhatsApp: mock.fn(async (d) => [{ jid: `${d}@s.whatsapp.net`, exists: true, lid: "123456789012345@lid" }]),
      // o retorno real do Baileys: fullMsg com `message` = proto.Message gerado a partir do conteúdo
      sendMessage: mock.fn(async (_jid, conteudo, o) => ({ key: { id: o?.messageId }, message: await generateWAMessageContent(conteudo, {}) })),
      readMessages: mock.fn(async () => {}), end: mock.fn(async () => {}),
    };
    criados.push(socket); return socket;
  };
  fabrica.criados = criados; return fabrica;
}
function authFalso() {
  let creds = null;
  return {
    async carregar() { return creds ? { status: "loaded", registered: true, authConfirmado: true } : { status: "absent" }; },
    inicializarCreds(c) { creds = c; }, invalidarLocal() { creds = null; },
    comoAuthState() { return { creds, keys: { get: async () => ({}), set: async () => {} } }; },
    async aoAtualizarCreds(d) { if (creds) Object.assign(creds, d); else creds = d; },
    async aguardarPersistenciasPendentes() {}, async garantirPersistido() { return { status: "limpo" }; }, obterAuthSessionIdAtual() { return AUTH_ID; },
  };
}
const backendSessaoFalso = () => ({
  notificarHeartbeat: mock.fn(async () => {}), notificarMensagemRecebida: mock.fn(async () => {}),
  notificarStatusProvider: mock.fn(async () => ({ ok: true, resultado: "APLICADO" })),
  definirEstadoDesejado: mock.fn(async () => ({ ok: true })), obterEstadoSessao: mock.fn(async () => ({})),
  resetarAuthState: mock.fn(async () => ({ ok: true })), confirmarAuthState: mock.fn(async () => ({})),
});

async function montar({ habilitado }) {
  const beRetry = criarBackendRetryFalso();
  const lease = { souLeader: () => true, contexto: () => ({ ...beRetry.lease }), notificarPerdaExterna: mock.fn(async () => {}) };
  const retryCache = criarCacheRetry({
    backendClient: beRetry, chaveEncriptacaoEnv: randomBytes(32).toString("base64"), obterContextoLease: () => lease.contexto(),
    habilitado, emitir: () => {}, esperaPendenteMs: 200,
  });
  const fabricaSocket = fabricaQueCapturaOpcoes();
  const sessao = criarSessaoBaileys({
    authAdapter: authFalso(), backendClient: backendSessaoFalso(), fabricaSocket, DisconnectReasonLoggedOut: 401, leaseManager: lease, retryCache,
    config: { reconnect: { baseMs: 5, tetoMs: 10 }, heartbeatMs: 1_000_000, providerInstanceId: "default", gatewayVersion: "0" },
  });
  await sessao.conectar();
  const abrir = (s) => { s.ev.emit("connection.update", { connection: "open" }); };
  abrir(fabricaSocket.criados[0]);
  fabricaSocket.criados[0].ev.emit("creds.update", { registered: true });
  for (let i = 0; i < 50 && sessao._status() !== "CONNECTED"; i++) await espera(5);
  return { sessao, fabricaSocket, beRetry, retryCache, abrir };
}

describe("sessão × cache de retry", () => {
  test("4. enviar() registra o conteúdo; o socket RECRIADO (reconexão) ainda serve a mensagem via getMessage", async () => {
    const { sessao, fabricaSocket, beRetry, abrir } = await montar({ habilitado: true });
    assert.equal(sessao._status(), "CONNECTED");
    const { providerMessageId } = await sessao.enviar({ tipo: "text", telefoneE164: TEL, conteudo: { text: TEXTO }, correlationId: "wa:alerta:x:v1" });
    for (let i = 0; i < 50 && beRetry.linhas.size === 0; i++) await espera(5);
    assert.equal(beRetry.linhas.size, 1, "persistido no 'banco'");
    assert.ok(beRetry.linhas.get(providerMessageId).destinoLidHash, "o LID que o WhatsApp informou entra como HMAC");

    // queda transitória (428) → reconexão automática → socket NOVO
    const s1 = fabricaSocket.criados[0];
    s1.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 428 } } } });
    for (let i = 0; i < 100 && fabricaSocket.criados.length < 2; i++) await espera(5);
    assert.equal(fabricaSocket.criados.length, 2, "reconectou com um socket novo");
    const s2 = fabricaSocket.criados[1];
    abrir(s2);

    assert.equal(s1.opcoes.msgRetryCounterCache, s2.opcoes.msgRetryCounterCache, "contador de retry com escopo de processo: sobrevive ao socket");
    const m = await s2.opcoes.getMessage({ remoteJid: "5511987654321@s.whatsapp.net", id: providerMessageId, fromMe: true, participant: "5511987654321@s.whatsapp.net" });
    assert.ok(m instanceof proto.Message);
    assert.equal(proto.Message.toObject(m).extendedTextMessage.text, TEXTO);
    // e pelo LID do destinatário (o retry pode chegar endereçado ao LID)
    const viaLid = await s2.opcoes.getMessage({ remoteJid: "123456789012345:0@lid", id: providerMessageId, fromMe: true, participant: "123456789012345:0@lid" });
    assert.ok(viaLid);
    await sessao.desconectar();
  });

  test("flag DESLIGADA: as opções do socket são as mesmas de antes (sem getMessage/msgRetryCounterCache) e nada é gravado", async () => {
    const { sessao, fabricaSocket, beRetry } = await montar({ habilitado: false });
    const opcoes = fabricaSocket.criados[0].opcoes;
    assert.deepEqual(Object.keys(opcoes).sort(), ["auth", "logger", "printQRInTerminal"]);
    await sessao.enviar({ tipo: "text", telefoneE164: TEL, conteudo: { text: TEXTO }, correlationId: "wa:alerta:y:v1" });
    await espera(20);
    assert.equal(beRetry.chamadas.salvar.length, 0);
    await sessao.desconectar();
  });

  test("uma falha do cache NUNCA derruba o envio (o envio já aconteceu)", async () => {
    const { sessao, retryCache } = await montar({ habilitado: true });
    retryCache.registrarEnvio = () => { throw new Error("bug no cache"); };
    const r = await sessao.enviar({ tipo: "text", telefoneE164: TEL, conteudo: { text: TEXTO }, correlationId: "wa:alerta:z:v1" });
    assert.ok(r.providerMessageId);
    await sessao.desconectar();
  });
});
