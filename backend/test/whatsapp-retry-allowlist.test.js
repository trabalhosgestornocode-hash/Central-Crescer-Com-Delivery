// Allowlist do REENVIO SOB RETRY (homologação) — o backend decide por contato_id; o Gateway recebe só `retryResend: true`
// no corpo assinado por HMAC e guarda no cache APENAS o que veio marcado (e só com a flag dele ligada).
//
// Ponta a ponta REAL e isolado: backend (whatsapp.service → baileysGateway.provider → HTTP assinado) → rota REAL do Gateway
// (express.raw → exigirHmac → criarRotas) → sessão REAL (criarSessaoBaileys) com socket FALSO → cache de retry REAL com
// "banco" em memória. Nada sai da máquina: Gateway em 127.0.0.1, socket do WhatsApp falso, Supabase com valores sintáticos.
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
// Módulos REAIS do Gateway (import cross-package, mesmo padrão de whatsapp-retry-cache-routes.test.js).
import { proto, generateWAMessageContent } from "../../gateway-whatsapp/node_modules/baileys/lib/index.js";
import { criarSessaoBaileys } from "../../gateway-whatsapp/src/baileysSession.js";
import { criarCacheRetry } from "../../gateway-whatsapp/src/retryCache.js";
import { criarRotas } from "../../gateway-whatsapp/src/routes.js";
import { exigirHmac, _resetarNonces } from "../../gateway-whatsapp/src/hmac.js";
import { criarBackendRetryFalso } from "../../gateway-whatsapp/test-support/backendRetryFalso.js";
import { lerAllowlistRetryResend, ENV_RETRY_RESEND_CONTATOS } from "../src/modules/comunicacao/retryResendAllowlist.js";

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "teste-sem-rede";
process.env.SUPABASE_ANON_KEY = "teste-sem-rede";
const { criarWhatsAppService } = await import("../src/modules/comunicacao/whatsapp.service.js");
const { criarBaileysGatewayProvider } = await import("../src/modules/comunicacao/providers/baileysGateway.provider.js");

// ids FICTÍCIOS (nenhum contato real no repositório)
const CONTATO_TESTE = "0b8f8a52-4c55-4f4e-9a57-2a5d5e9f0a01"; // org A — o único autorizado
const CONTATO_OUTRO = "7d1e4b33-91a2-4c0f-8e44-0c6a3b2d9f02"; // org A — não autorizado
const CONTATO_OUTRA_ORG = "c3a9e0f1-5b7d-4e2a-b1c4-9f8e7d6c5b03"; // org B — não autorizado
const TEL = "+5511987654321";
const SEGREDO = "segredo-hmac-de-teste-".padEnd(40, "x");
const ENV_AUTORIZADO = { EFEITOS_EXTERNOS_LOCAL_PERMITIDOS: "true" }; // opt-in local explícito, só neste processo de teste
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const keyPn = (id) => ({ remoteJid: "5511987654321@s.whatsapp.net", id, fromMe: true, participant: "5511987654321@s.whatsapp.net" });

// ---------------- Gateway (sessão real, socket falso) ----------------
function fabricaSocket() {
  const criados = [];
  const f = (opcoes) => {
    const s = {
      opcoes, ev: new EventEmitter(), ws: new EventEmitter(), user: { id: "5511999990000:1@s.whatsapp.net" },
      onWhatsApp: mock.fn(async (d) => [{ jid: `${d}@s.whatsapp.net`, exists: true, lid: "123456789012345@lid" }]),
      sendMessage: mock.fn(async (_jid, conteudo, o) => ({ key: { id: o?.messageId }, message: await generateWAMessageContent(conteudo, {}) })),
      readMessages: mock.fn(async () => {}), end: mock.fn(async () => {}),
    };
    criados.push(s); return s;
  };
  f.criados = criados; return f;
}
function authFalso() {
  let creds = null;
  return {
    async carregar() { return creds ? { status: "loaded", registered: true, authConfirmado: true } : { status: "absent" }; },
    inicializarCreds(c) { creds = c; }, invalidarLocal() { creds = null; },
    comoAuthState() { return { creds, keys: { get: async () => ({}), set: async () => {} } }; },
    async aoAtualizarCreds(d) { if (creds) Object.assign(creds, d); else creds = d; },
    async aguardarPersistenciasPendentes() {}, async garantirPersistido() { return { status: "limpo" }; },
    obterAuthSessionIdAtual() { return "11111111-1111-4111-8111-111111111111"; },
  };
}
const backendSessaoFalso = () => ({
  notificarHeartbeat: mock.fn(async () => {}), notificarMensagemRecebida: mock.fn(async () => {}),
  notificarStatusProvider: mock.fn(async () => ({ ok: true, resultado: "APLICADO" })),
  definirEstadoDesejado: mock.fn(async () => ({ ok: true })), obterEstadoSessao: mock.fn(async () => ({})),
  resetarAuthState: mock.fn(async () => ({ ok: true })), confirmarAuthState: mock.fn(async () => ({})),
});

async function subirGateway({ habilitado, beRetry = criarBackendRetryFalso(), chave = randomBytes(32).toString("base64") }) {
  const lease = { souLeader: () => true, contexto: () => ({ ...beRetry.lease }), notificarPerdaExterna: mock.fn(async () => {}) };
  const retryCache = criarCacheRetry({ backendClient: beRetry, chaveEncriptacaoEnv: chave, obterContextoLease: () => lease.contexto(), habilitado, emitir: () => {}, esperaPendenteMs: 200 });
  const fabrica = fabricaSocket();
  const sessao = criarSessaoBaileys({
    authAdapter: authFalso(), backendClient: backendSessaoFalso(), fabricaSocket: fabrica, DisconnectReasonLoggedOut: 401, leaseManager: lease, retryCache,
    config: { reconnect: { baseMs: 5, tetoMs: 10 }, heartbeatMs: 1_000_000, providerInstanceId: "default", gatewayVersion: "0" },
  });
  await sessao.conectar();
  fabrica.criados[0].ev.emit("connection.update", { connection: "open" });
  fabrica.criados[0].ev.emit("creds.update", { registered: true });
  for (let i = 0; i < 50 && sessao._status() !== "CONNECTED"; i++) await espera(5);
  const app = express();
  app.use("/internal", express.raw({ type: "*/*" }), exigirHmac(SEGREDO), criarRotas(sessao, { retryCache }));
  const servidor = createServer(app);
  await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${servidor.address().port}`, sessao, fabrica, beRetry, chave, retryCache,
    socket: () => fabrica.criados.at(-1),
    async parar() { await sessao.desconectar(); await new Promise((r) => servidor.close(r)); },
  };
}

// ---------------- Backend (serviço + provider reais) ----------------
const servicoBackend = (gw, envAllowlist) => criarWhatsAppService({
  provider: criarBaileysGatewayProvider({ gatewayUrl: gw.url, segredoHmac: SEGREDO, env: ENV_AUTORIZADO }),
  semGateIdentidade: true, semGateModo: true,
  allowlistRetryResend: lerAllowlistRetryResend(envAllowlist),
});
let seq = 0;
const enviar = (svc, contatoId, extra = {}) => svc.enviarTexto({ telefoneE164: TEL, texto: "alerta-allowlist", idempotencyKey: `k-allow-${++seq}`, contatoId, ...extra });
async function guardados(gw) { await espera(40); return [...gw.beRetry.linhas.keys()]; }

describe("allowlist — leitura da configuração (fail closed, sem telefone)", () => {
  test("lista ausente/vazia ⇒ ninguém", () => {
    for (const env of [{}, { [ENV_RETRY_RESEND_CONTATOS]: "" }, { [ENV_RETRY_RESEND_CONTATOS]: "  " }]) {
      const a = lerAllowlistRetryResend(env);
      assert.equal(a.estado, "vazia"); assert.equal(a.permite(CONTATO_TESTE), false);
    }
  });
  test("13. telefone/JID/nome na lista ⇒ lista INTEIRA inválida ⇒ ninguém (nunca 'aproveita o resto')", () => {
    for (const intruso of [TEL, "5511987654321", "5511987654321@s.whatsapp.net", "Joao", "*"]) {
      const a = lerAllowlistRetryResend({ [ENV_RETRY_RESEND_CONTATOS]: `${CONTATO_TESTE},${intruso}` });
      assert.equal(a.estado, "invalida"); assert.equal(a.permite(CONTATO_TESTE), false, intruso);
    }
  });
  test("5/6. contatoId ausente ou que não é UUID ⇒ não", () => {
    const a = lerAllowlistRetryResend({ [ENV_RETRY_RESEND_CONTATOS]: CONTATO_TESTE });
    for (const v of [undefined, null, "", 42, {}, "nao-e-uuid", `${CONTATO_TESTE} `.repeat(2), TEL]) assert.equal(a.permite(v), false, JSON.stringify(v));
    assert.equal(a.permite(CONTATO_TESTE), true);
    assert.equal(a.permite(CONTATO_TESTE.toUpperCase()), true, "UUID não diferencia maiúsculas");
  });
  test("12. o estado exposto para log tem só contagem — nunca os ids", () => {
    const a = lerAllowlistRetryResend({ [ENV_RETRY_RESEND_CONTATOS]: `${CONTATO_TESTE},${CONTATO_OUTRO}` });
    const s = JSON.stringify({ estado: a.estado, total: a.total });
    assert.equal(s, '{"estado":"ativa","total":2}');
  });
});

describe("allowlist — serviço do backend decide; provider manda só o booleano", () => {
  function providerEspiao() {
    const chamadas = [];
    const reg = (m) => async (p) => { chamadas.push({ m, p }); return { providerMessageId: "wa-x", enviadoEm: "2026-10-02T00:00:00.000Z" }; };
    return { chamadas, provider: { connect: async () => {}, disconnect: async () => {}, getStatus: async () => ({}), sendText: reg("text"), sendImage: reg("image"), sendDocument: reg("document"), onMessage() {}, markAsRead: async () => {}, getMessageStatus: async () => ({}) } };
  }
  test("7. texto/imagem/documento: autorizado ⇒ retryResend true; não autorizado/sem contato ⇒ undefined; o resto do pedido é idêntico", async () => {
    const { chamadas, provider } = providerEspiao();
    const svc = criarWhatsAppService({ provider, semGateIdentidade: true, semGateModo: true, allowlistRetryResend: lerAllowlistRetryResend({ [ENV_RETRY_RESEND_CONTATOS]: CONTATO_TESTE }) });
    await svc.enviarTexto({ telefoneE164: TEL, texto: "t", idempotencyKey: "k1", contatoId: CONTATO_TESTE });
    await svc.enviarTexto({ telefoneE164: TEL, texto: "t", idempotencyKey: "k2", contatoId: CONTATO_OUTRO });
    await svc.enviarTexto({ telefoneE164: TEL, texto: "t", idempotencyKey: "k3" });
    await svc.enviarImagem({ telefoneE164: TEL, urlImagem: "https://x.invalid/a.png", idempotencyKey: "k4", contatoId: CONTATO_TESTE });
    await svc.enviarDocumento({ telefoneE164: TEL, urlDocumento: "https://x.invalid/a.pdf", idempotencyKey: "k5", contatoId: CONTATO_OUTRA_ORG });
    assert.deepEqual(chamadas.map((c) => c.p.retryResend), [true, undefined, undefined, true, undefined]);
    assert.ok(chamadas.every((c) => !("contatoId" in c.p)), "contato_id nunca vai ao provider/Gateway");
  });
  test("padrão (sem allowlist injetada, env sem a variável) ⇒ ninguém marcado", async () => {
    const { chamadas, provider } = providerEspiao();
    const antes = process.env[ENV_RETRY_RESEND_CONTATOS]; delete process.env[ENV_RETRY_RESEND_CONTATOS];
    try {
      const svc = criarWhatsAppService({ provider, semGateIdentidade: true, semGateModo: true });
      await svc.enviarTexto({ telefoneE164: TEL, texto: "t", idempotencyKey: "k6", contatoId: CONTATO_TESTE });
      assert.equal(chamadas[0].p.retryResend, undefined);
    } finally { if (antes !== undefined) process.env[ENV_RETRY_RESEND_CONTATOS] = antes; }
  });
  test("provider: só o booleano true entra no corpo assinado; qualquer outro valor deixa o corpo como antes", async () => {
    const corpos = [];
    const f = mock.method(globalThis, "fetch", async (_u, o) => { corpos.push(JSON.parse(o.body)); return new Response('{"providerMessageId":"wa-1","enviadoEm":"x"}', { status: 200 }); });
    try {
      const p = criarBaileysGatewayProvider({ gatewayUrl: "http://gateway.invalid", segredoHmac: SEGREDO, env: ENV_AUTORIZADO });
      for (const v of [true, "true", 1, null, undefined, false]) await p.sendText({ telefoneE164: TEL, texto: "t", idempotencyKey: `kp-${String(v)}`, retryResend: v });
    } finally { f.mock.restore(); }
    assert.deepEqual(corpos.map((c) => c.retryResend), [true, undefined, undefined, undefined, undefined, undefined]);
    assert.ok(corpos.slice(1).every((c) => !("retryResend" in c)));
  });
});

describe("allowlist — ponta a ponta (backend → HTTP+HMAC → Gateway → cache de retry)", () => {
  before(() => _resetarNonces());

  test("1. flag OFF + contato autorizado ⇒ envio normal, nada guardado, socket sem getMessage", async () => {
    const gw = await subirGateway({ habilitado: false });
    try {
      const svc = servicoBackend(gw, { [ENV_RETRY_RESEND_CONTATOS]: CONTATO_TESTE });
      const r = await enviar(svc, CONTATO_TESTE);
      assert.ok(r.providerMessageId);
      assert.equal(gw.socket().sendMessage.mock.callCount(), 1);
      assert.deepEqual(await guardados(gw), []);
      assert.equal(gw.socket().opcoes.getMessage, undefined);
    } finally { await gw.parar(); }
  });

  test("2. flag ON + lista vazia ⇒ envio normal, nada guardado, retry não encontra", async () => {
    const gw = await subirGateway({ habilitado: true });
    try {
      const svc = servicoBackend(gw, {});
      const r = await enviar(svc, CONTATO_TESTE);
      assert.equal(gw.socket().sendMessage.mock.callCount(), 1);
      assert.deepEqual(await guardados(gw), []);
      assert.equal(await gw.socket().opcoes.getMessage(keyPn(r.providerMessageId)), undefined);
    } finally { await gw.parar(); }
  });

  test("3/8. flag ON + contato autorizado ⇒ guardado e o getMessage devolve o conteúdo (reenvio possível)", async () => {
    const gw = await subirGateway({ habilitado: true });
    try {
      const svc = servicoBackend(gw, { [ENV_RETRY_RESEND_CONTATOS]: CONTATO_TESTE });
      const r = await enviar(svc, CONTATO_TESTE);
      assert.deepEqual(await guardados(gw), [r.providerMessageId]);
      const m = await gw.socket().opcoes.getMessage(keyPn(r.providerMessageId));
      assert.ok(m instanceof proto.Message);
      assert.equal(proto.Message.toObject(m).extendedTextMessage.text, "alerta-allowlist");
    } finally { await gw.parar(); }
  });

  test("4/5/6/9. flag ON + contato NÃO autorizado, sem contato ou com id inválido ⇒ enviado, NÃO guardado, getMessage não encontra", async () => {
    const gw = await subirGateway({ habilitado: true });
    try {
      const svc = servicoBackend(gw, { [ENV_RETRY_RESEND_CONTATOS]: CONTATO_TESTE });
      const ids = [];
      for (const c of [CONTATO_OUTRO, null, "nao-e-uuid", CONTATO_OUTRA_ORG]) ids.push((await enviar(svc, c)).providerMessageId);
      assert.equal(gw.socket().sendMessage.mock.callCount(), 4, "7. envio normal para todos");
      assert.deepEqual(await guardados(gw), []);
      for (const id of ids) assert.equal(await gw.socket().opcoes.getMessage(keyPn(id)), undefined);
    } finally { await gw.parar(); }
  });

  test("10. restart (backend e Gateway recriados com a mesma configuração) ⇒ mesma política; o autorizado continua servido pelo 'banco'", async () => {
    const beRetry = criarBackendRetryFalso();
    const chave = randomBytes(32).toString("base64");
    const env = { [ENV_RETRY_RESEND_CONTATOS]: CONTATO_TESTE };
    let sim; let nao;
    const gw1 = await subirGateway({ habilitado: true, beRetry, chave });
    try {
      const svc1 = servicoBackend(gw1, env);
      sim = (await enviar(svc1, CONTATO_TESTE)).providerMessageId;
      nao = (await enviar(svc1, CONTATO_OUTRO)).providerMessageId;
      await guardados(gw1);
    } finally { await gw1.parar(); }
    const gw2 = await subirGateway({ habilitado: true, beRetry, chave }); // processo novo: memória vazia, mesmo "banco"
    try {
      assert.ok(await gw2.socket().opcoes.getMessage(keyPn(sim)), "autorizado: vem do banco após o restart");
      assert.equal(await gw2.socket().opcoes.getMessage(keyPn(nao)), undefined);
      const svc2 = servicoBackend(gw2, env);
      const depois = (await enviar(svc2, CONTATO_OUTRO)).providerMessageId;
      assert.equal(await gw2.socket().opcoes.getMessage(keyPn(depois)), undefined, "a política relida é a mesma");
      assert.deepEqual([...beRetry.linhas.keys()], [sim]);
    } finally { await gw2.parar(); }
  });

  test("11. cross-org: autorizar o contato da org A não autoriza nenhum contato de outra org; conteúdo nunca vai a outro destinatário", async () => {
    const gw = await subirGateway({ habilitado: true });
    try {
      const svc = servicoBackend(gw, { [ENV_RETRY_RESEND_CONTATOS]: CONTATO_TESTE });
      const outraOrg = (await enviar(svc, CONTATO_OUTRA_ORG)).providerMessageId;
      const daA = (await enviar(svc, CONTATO_TESTE)).providerMessageId;
      assert.deepEqual(await guardados(gw), [daA]);
      assert.equal(await gw.socket().opcoes.getMessage(keyPn(outraOrg)), undefined);
      // retry da mensagem autorizada pedido por OUTRO usuário ⇒ destino divergente ⇒ não reenvia
      assert.equal(await gw.socket().opcoes.getMessage({ remoteJid: "5521900000000@s.whatsapp.net", id: daA, fromMe: true }), undefined);
    } finally { await gw.parar(); }
  });

  test("12/13. logs do caminho inteiro: nem contato_id, nem telefone, nem texto", async (t) => {
    const linhas = [];
    for (const m of ["log", "info", "warn", "error"]) t.mock.method(console, m, (...a) => linhas.push(a.map(String).join(" ")));
    const gw = await subirGateway({ habilitado: true });
    try {
      const svc = servicoBackend(gw, { [ENV_RETRY_RESEND_CONTATOS]: CONTATO_TESTE });
      await enviar(svc, CONTATO_TESTE);
      await enviar(svc, CONTATO_OUTRO);
      await guardados(gw);
    } finally { await gw.parar(); }
    const tudo = linhas.join("\n");
    assert.ok(linhas.length > 0, "o Gateway logou o envio");
    for (const proibido of [CONTATO_TESTE, CONTATO_OUTRO, TEL, "5511987654321", "alerta-allowlist"]) assert.ok(!tudo.includes(proibido), `log contém ${proibido}`);
  });
});

after(() => _resetarNonces());
