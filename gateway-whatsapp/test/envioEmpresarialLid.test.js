// 17B — envio EMPRESARIAL (alertas/relatórios) endereçado pelo LID do destinatário verificado, atrás da flag WHATSAPP_ENVIO_VIA_LID.
// Evidência que motivou: nos logs de 21–22/11, 100% dos envios a destinatários fora da allowlist de retry geraram pedido de reenvio
// por LID segundos depois do envio e terminaram em retry.message_missing. O MOVA já envia por LID (PR #160) e a entrega funcionou.
// Aqui: regressão com a flag DESLIGADA (comportamento atual), com ela LIGADA, destinatário desconhecido, persistência para reenvio
// (cache real), falha de envio e confirmação do provedor. Tudo sintético, sem rede.
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { proto, generateWAMessageContent } from "baileys";
import { criarSessaoBaileys } from "../src/baileysSession.js";
import { criarCacheRetry } from "../src/retryCache.js";
import { CODIGOS } from "../src/errors.js";
import { criarBackendRetryFalso } from "../test-support/backendRetryFalso.js";

const AUTH_ID = "11111111-1111-4111-8111-111111111111";
const TEL = "+5511987654321";
const PN = "5511987654321@s.whatsapp.net";
const LID = "123456789012345@lid";
const TEXTO = "alerta-sintetico";
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function fabricaFalsa({ onWhatsApp }) {
  const criados = [];
  const fabrica = (opcoes) => {
    const socket = {
      opcoes, ev: new EventEmitter(), ws: new EventEmitter(), user: { id: "5511999990000:1@s.whatsapp.net", lid: "100000000000001:1@lid" },
      onWhatsApp: mock.fn(onWhatsApp),
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

/** @param {{viaLid?:boolean, onWhatsApp?:Function, comCache?:boolean, falharEnvio?:boolean}} o */
async function montar({ viaLid = false, onWhatsApp = async (d) => [{ jid: `${d}@s.whatsapp.net`, exists: true, lid: LID }], comCache = false, falharEnvio = false } = {}) {
  const beRetry = criarBackendRetryFalso();
  const lease = { souLeader: () => true, contexto: () => ({ ...beRetry.lease }), notificarPerdaExterna: mock.fn(async () => {}) };
  const retryCache = comCache ? criarCacheRetry({ backendClient: beRetry, chaveEncriptacaoEnv: randomBytes(32).toString("base64"), obterContextoLease: () => lease.contexto(), habilitado: true, emitir: () => {}, esperaPendenteMs: 200 }) : null;
  const fabricaSocket = fabricaFalsa({ onWhatsApp });
  const sessao = criarSessaoBaileys({
    authAdapter: authFalso(), backendClient: backendSessaoFalso(), fabricaSocket, DisconnectReasonLoggedOut: 401, leaseManager: lease, retryCache,
    config: { reconnect: { baseMs: 5, tetoMs: 10 }, heartbeatMs: 1_000_000, providerInstanceId: "default", gatewayVersion: "0", envioViaLid: viaLid },
  });
  await sessao.conectar();
  const socket = fabricaSocket.criados[0];
  socket.ev.emit("connection.update", { connection: "open" });
  socket.ev.emit("creds.update", { registered: true });
  await new Promise((r) => setImmediate(r));
  if (falharEnvio) socket.sendMessage = mock.fn(async () => { throw new Error("timeout"); });
  return { sessao, socket, beRetry, retryCache };
}
const alvoDoEnvio = (socket) => socket.sendMessage.mock.calls[0].arguments[0];

describe("17B envio empresarial × LID", () => {
  test("flag DESLIGADA (padrão): o envio continua no número, como antes — nada muda", async () => {
    const { sessao, socket } = await montar({ viaLid: false });
    const r = await sessao.enviar({ tipo: "text", telefoneE164: TEL, conteudo: { text: TEXTO }, correlationId: "wa:alerta:a:v1" });
    assert.equal(alvoDoEnvio(socket), PN);
    assert.ok(r.providerMessageId, "confirmação do provedor: id devolvido");
    await sessao.desconectar();
  });

  test("flag LIGADA + LID do destinatário verificado: endereça o LID; conteúdo e destinatário são os mesmos", async () => {
    const { sessao, socket } = await montar({ viaLid: true });
    const r = await sessao.enviar({ tipo: "text", telefoneE164: TEL, conteudo: { text: TEXTO }, correlationId: "wa:alerta:b:v1" });
    assert.equal(socket.sendMessage.mock.callCount(), 1);
    assert.equal(alvoDoEnvio(socket), LID);
    assert.deepEqual(socket.sendMessage.mock.calls[0].arguments[1], { text: TEXTO });
    assert.equal(r.providerMessageId, socket.sendMessage.mock.calls[0].arguments[2].messageId, "o id confirmado é o gerado antes do envio");
    await sessao.desconectar();
  });

  test("flag LIGADA sem LID, LID vazio ou malformado: mantém o número (nunca endereça um LID duvidoso)", async () => {
    for (const lid of [undefined, null, "", "abc@lid", "123@s.whatsapp.net", "123456789012345@lid; x", "123456789012345:3@lid"]) {
      const { sessao, socket } = await montar({ viaLid: true, onWhatsApp: async (d) => [{ jid: `${d}@s.whatsapp.net`, exists: true, ...(lid === undefined ? {} : { lid }) }] });
      await sessao.enviar({ tipo: "text", telefoneE164: TEL, conteudo: { text: TEXTO }, correlationId: "wa:alerta:c:v1" });
      assert.equal(alvoDoEnvio(socket), PN, `lid=${String(lid)}`);
      await sessao.desconectar();
    }
  });

  test("destinatário desconhecido (exists=false) ou não verificável: recusa ANTES de enviar, com a flag ligada ou não", async () => {
    for (const viaLid of [false, true]) {
      const a = await montar({ viaLid, onWhatsApp: async () => [{ jid: "5511987654321@s.whatsapp.net", exists: false }] });
      await assert.rejects(a.sessao.enviar({ tipo: "text", telefoneE164: TEL, conteudo: { text: TEXTO } }), (e) => e.codigo === CODIGOS.DESTINATARIO_INEXISTENTE && e.preEnvio === true);
      assert.equal(a.socket.sendMessage.mock.callCount(), 0);
      await a.sessao.desconectar();
      const b = await montar({ viaLid, onWhatsApp: async () => [] });
      await assert.rejects(b.sessao.enviar({ tipo: "text", telefoneE164: TEL, conteudo: { text: TEXTO } }), (e) => e.preEnvio === true);
      assert.equal(b.socket.sendMessage.mock.callCount(), 0);
      await b.sessao.desconectar();
    }
  });

  test("LID de OUTRO número nunca vira destino: o jid devolvido incoerente com o pedido é recusado antes de enviar", async () => {
    const { sessao, socket } = await montar({ viaLid: true, onWhatsApp: async () => [{ jid: "5599900001111@s.whatsapp.net", exists: true, lid: LID }] });
    await assert.rejects(sessao.enviar({ tipo: "text", telefoneE164: TEL, conteudo: { text: TEXTO } }), (e) => e.preEnvio === true);
    assert.equal(socket.sendMessage.mock.callCount(), 0);
    await sessao.desconectar();
  });

  test("persistência para reenvio (cache REAL, retryResend=true): guarda o conteúdo com número E LID; o getMessage acha por PN e por LID, também após reconexão", async () => {
    const { sessao, socket, beRetry } = await montar({ viaLid: true, comCache: true });
    const { providerMessageId } = await sessao.enviar({ tipo: "text", telefoneE164: TEL, conteudo: { text: TEXTO }, correlationId: "wa:alerta:d:v1", retryResend: true });
    assert.equal(alvoDoEnvio(socket), LID);
    for (let i = 0; i < 50 && beRetry.linhas.size === 0; i++) await espera(5);
    assert.equal(beRetry.linhas.size, 1, "persistido (cifrado) para sobreviver a reinício");
    assert.ok(beRetry.linhas.get(providerMessageId).destinoLidHash, "o LID entra como HMAC");
    const porPn = await socket.opcoes.getMessage({ remoteJid: PN, id: providerMessageId, fromMe: true, participant: PN });
    assert.ok(porPn instanceof proto.Message);
    assert.equal(proto.Message.toObject(porPn).extendedTextMessage.text, TEXTO);
    const porLid = await socket.opcoes.getMessage({ remoteJid: "123456789012345:0@lid", id: providerMessageId, fromMe: true, participant: "123456789012345:0@lid" });
    assert.ok(porLid, "o retry que chega endereçado ao LID é atendido");
    await sessao.desconectar();
  });

  test("retryResend=false (fora da allowlist): envia por LID e NADA é guardado (como antes)", async () => {
    const { sessao, beRetry } = await montar({ viaLid: true, comCache: true });
    await sessao.enviar({ tipo: "text", telefoneE164: TEL, conteudo: { text: TEXTO }, correlationId: "wa:alerta:e:v1", retryResend: false });
    await espera(30);
    assert.equal(beRetry.linhas.size, 0);
    await sessao.desconectar();
  });

  test("falha de entrega: o erro do envio propaga, nada é guardado para reenvio e o id não é confirmado", async () => {
    const { sessao, socket, beRetry } = await montar({ viaLid: true, comCache: true, falharEnvio: true });
    await assert.rejects(sessao.enviar({ tipo: "text", telefoneE164: TEL, conteudo: { text: TEXTO }, correlationId: "wa:alerta:f:v1", retryResend: true }), (e) => e.preEnvio !== true && /timeout/.test(e.message));
    assert.equal(socket.sendMessage.mock.callCount(), 1);
    await espera(30);
    assert.equal(beRetry.linhas.size, 0);
    await sessao.desconectar();
  });
});
