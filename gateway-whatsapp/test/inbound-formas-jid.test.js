// Incidente 2026-09-25 — contrato INBOUND do Gateway pelas funções REAIS (sessão Baileys real + rastreador de origem real + fila real +
// backendClient real com fetch simulado). Nenhuma rede, nenhum banco: o socket é um EventEmitter falso, exatamente como em inboundWiring.test.js.
// Aqui se prova, por forma de JID/evento, O QUE o Gateway envia ao backend em `POST /eventos/mensagem-recebida`.
import { test, describe, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHmac, createHash } from "node:crypto";
import { proto } from "baileys";
import { criarSessaoBaileys } from "../src/baileysSession.js";
import { criarBackendClient } from "../src/backendClient.js";

const AUTH_SESSION_ID_FAKE = "11111111-1111-4111-8111-111111111111";
const CIPHERTEXT = proto.WebMessageInfo.StubType.CIPHERTEXT;
const PN = "5511999990000@s.whatsapp.net";
const LID = "100000000000001@lid";
const SEGREDO_HMAC = "SEGREDO-HMAC-DE-TESTE-9f8e7d";
const MARCADOR_CREDS = "CREDS-PRIVADAS-NOISE-KEY-MARCADOR";
const MARCADOR_SIGNAL = "SIGNAL-IDENTITY-PRIVADA-MARCADOR";

function fabricaFalsa() {
  const criados = [];
  const fabrica = () => {
    const socket = { ev: new EventEmitter(), ws: new EventEmitter(), user: null, sendMessage: mock.fn(async () => ({ key: { id: "x" } })), readMessages: mock.fn(async () => {}), end: mock.fn(async () => {}) };
    criados.push(socket);
    return socket;
  };
  fabrica.criados = criados;
  return fabrica;
}
const authAdapterFalso = () => ({
  async carregar() { return { status: "absent" }; }, inicializarCreds() {},
  comoAuthState() { return { creds: { noiseKey: { private: MARCADOR_CREDS }, signedIdentityKey: { private: MARCADOR_SIGNAL }, me: { id: "5511999990009:3@s.whatsapp.net", lid: "100000000000009:3@lid" } }, keys: { get: async () => ({}), set: async () => {} } }; },
  async aoAtualizarCreds() {}, async aguardarPersistenciasPendentes() {}, obterAuthSessionIdAtual() { return AUTH_SESSION_ID_FAKE; },
});
const configFalso = () => ({ reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "teste", gatewayVersion: "0.0.0-test" });
async function drenar() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

/** Sessão real; `notificarMensagemRecebida` é a implementação REAL do backendClient, com `fetch` global simulado (captura, nunca sai da máquina). */
async function abrir() {
  const chamadas = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (url, init) => { chamadas.push({ url: String(url), init }); return { ok: true, status: 200, text: async () => "{}" }; };
  const real = criarBackendClient({ backendUrl: "http://127.0.0.1:9", segredoHmac: SEGREDO_HMAC, timeoutMs: 1000 });
  const backendClient = {
    notificarHeartbeat: mock.fn(async () => {}), notificarStatusProvider: mock.fn(async () => {}),
    definirEstadoDesejado: mock.fn(async () => ({ ok: true })), obterEstadoSessao: mock.fn(async () => ({ status: "DISCONNECTED", desiredConnectionState: "DISCONNECTED" })),
    resetarAuthState: mock.fn(async () => ({ ok: true })), confirmarAuthState: mock.fn(async () => ({})),
    notificarMensagemRecebida: mock.fn((p) => real.notificarMensagemRecebida(p)),
  };
  const fabricaSocket = fabricaFalsa();
  const sessao = criarSessaoBaileys({ authAdapter: authAdapterFalso(), backendClient, config: configFalso(), fabricaSocket, DisconnectReasonLoggedOut: 401 });
  const recebidosPeloHandler = [];
  sessao.onMessage((e) => recebidosPeloHandler.push(e));
  await sessao.conectar();
  const socket = fabricaSocket.criados[0];
  return {
    sessao, socket, backendClient, recebidosPeloHandler,
    enviados: () => backendClient.notificarMensagemRecebida.mock.calls.map((c) => c.arguments[0]),
    requisicoes: () => chamadas.filter((c) => c.url.endsWith("/internal/comunicacao/eventos/mensagem-recebida")),
    upsert: (messages, type = "notify") => socket.ev.emit("messages.upsert", { messages, type }),
    stanza: (id, offline) => socket.ws.emit("CB:message", { attrs: { id, ...(offline === undefined ? {} : { offline }) } }),
    restaurarFetch: () => { globalThis.fetch = fetchOriginal; },
  };
}
const msg = (jid, id, message = { conversation: "oi" }, keyExtra = {}, extra = {}) => ({ key: { remoteJid: jid, id, fromMe: false, ...keyExtra }, message, ...extra });

let ambiente = null;
afterEach(() => { ambiente?.restaurarFetch(); ambiente = null; });
async function novo() { ambiente = await abrir(); return ambiente; }

describe("(1) fromMe nunca é encaminhado", () => {
  test("fromMe=true (PN, LID, grupo) em notify e append: zero chamadas ao backend, zero handlers", async () => {
    const g = await novo();
    g.upsert([msg(PN, "E1", undefined, { fromMe: true }), msg(LID, "E2", undefined, { fromMe: true }), msg("120363000000000001@g.us", "E3", undefined, { fromMe: true })], "notify");
    g.upsert([msg(PN, "E4", undefined, { fromMe: true })], "append");
    await drenar();
    assert.equal(g.enviados().length, 0);
    assert.equal(g.requisicoes().length, 0);
    assert.equal(g.recebidosPeloHandler.length, 0);
  });

  test("fromMe=true misturado a uma resposta de cliente: só a resposta sai", async () => {
    const g = await novo();
    g.upsert([msg(PN, "E1", { conversation: "eco" }, { fromMe: true }), msg(PN, "C1", { conversation: "resposta" })]);
    await drenar();
    assert.deepEqual(g.enviados().map((e) => e.providerMessageId), ["C1"]);
  });
});

describe("(2) texto 1:1 de <telefone>@s.whatsapp.net", () => {
  test("é encaminhado com telefoneE164, telefoneOrigem JID_PN, texto e tipoConteudo texto", async () => {
    const g = await novo();
    g.upsert([msg(PN, "P1", { conversation: "Quero cancelar o alerta" })]);
    await drenar();
    const [e] = g.enviados();
    assert.equal(g.enviados().length, 1);
    assert.equal(e.telefoneE164, "+5511999990000");
    assert.equal(e.telefoneOrigem, "JID_PN");
    assert.equal(e.texto, "Quero cancelar o alerta");
    assert.equal(e.tipoConteudo, "texto");
    assert.equal(e.origemJidTipo, "direct_pn");
    assert.equal(e.fromMe, false);
    assert.equal(e.falhaDecrypt, false);
    assert.equal(e.providerMessageId, "P1");
  });

  test("JID com device (:12) vira o mesmo telefone, sem o device", async () => {
    const g = await novo();
    g.upsert([msg("5511999990000:12@s.whatsapp.net", "P2")]);
    await drenar();
    assert.equal(g.enviados()[0].telefoneE164, "+5511999990000");
  });
});

describe("(3) @lid: telefone só com key.senderPn, nunca inventado", () => {
  test("@lid COM senderPn: encaminhado com o telefone do senderPn (SENDER_PN) e o texto", async () => {
    const g = await novo();
    g.upsert([msg(LID, "L1", { conversation: "sou eu" }, { senderPn: "5511988887777@s.whatsapp.net" })]);
    await drenar();
    const [e] = g.enviados();
    assert.equal(e.origemJidTipo, "direct_lid_other");
    assert.equal(e.telefoneE164, "+5511988887777");
    assert.equal(e.telefoneOrigem, "SENDER_PN");
    assert.equal(e.texto, "sou eu");
  });

  test("@lid SEM senderPn: ainda é encaminhado (limitação documentada), com telefoneE164=null, telefoneOrigem=null e SEM texto; os dígitos do LID nunca viram telefone", async () => {
    const g = await novo();
    g.upsert([msg(LID, "L2", { conversation: "TEXTO-QUE-NAO-PODE-SAIR" })]);
    await drenar();
    assert.equal(g.enviados().length, 1, "o backend precisa saber que houve uma resposta de LID");
    const [e] = g.enviados();
    assert.equal(e.origemJidTipo, "direct_lid_other");
    assert.equal(e.telefoneE164, null);
    assert.equal(e.telefoneOrigem, null);
    assert.equal(e.tipoConteudo, "outro");
    assert.equal(e.texto, null);
    const corpo = g.requisicoes()[0].init.body;
    assert.ok(!corpo.includes("100000000000001"), "os dígitos do LID não aparecem em nenhum campo do corpo");
    assert.ok(!corpo.includes("TEXTO-QUE-NAO-PODE-SAIR"));
  });

  test("@lid com senderPn inválido (outro LID, curto, grupo): nunca inventa telefone", async () => {
    const g = await novo();
    g.upsert([
      msg(LID, "L3", undefined, { senderPn: "100000000000002@lid" }),
      msg(LID, "L4", undefined, { senderPn: "123@s.whatsapp.net" }),
      msg(LID, "L5", undefined, { senderPn: "120363000000000001@g.us" }),
    ]);
    await drenar();
    assert.equal(g.enviados().length, 3);
    for (const e of g.enviados()) assert.deepEqual([e.telefoneE164, e.telefoneOrigem], [null, null]);
  });
});

describe("(4) grupo e status/broadcast não são resposta de cliente", () => {
  test("grupo, status, broadcast e newsletter chegam ao backend SEM telefone e SEM texto, com o tipo de JID explícito (o backend decide; nada aqui é 'cliente')", async () => {
    const g = await novo();
    const jids = { group: "120363000000000001@g.us", status: "status@broadcast", broadcast: "1726876800@broadcast", newsletter: "120363000000000009@newsletter" };
    g.upsert(Object.entries(jids).map(([tipo, jid]) => msg(jid, `X-${tipo}`, { conversation: "SEGREDO-DE-GRUPO" }, { participant: "5511977776666@s.whatsapp.net", senderPn: "5511977776666@s.whatsapp.net" })));
    await drenar();
    assert.equal(g.enviados().length, 4);
    for (const e of g.enviados()) {
      const tipo = e.providerMessageId.replace("X-", "");
      assert.equal(e.origemJidTipo, tipo);
      assert.deepEqual([e.telefoneE164, e.telefoneOrigem, e.tipoConteudo, e.texto], [null, null, "outro", null], tipo);
    }
    for (const r of g.requisicoes()) { assert.ok(!r.init.body.includes("SEGREDO-DE-GRUPO")); assert.ok(!r.init.body.includes("5511977776666")); }
  });

  test("nenhum evento de grupo/status carrega telefone que passe no E.164 (regressão: deJid transformava '120363…@g.us' em '+120363…')", async () => {
    const g = await novo();
    g.upsert([msg("120363000000000001@g.us", "G1"), msg("status@broadcast", "S1")]);
    await drenar();
    for (const e of g.enviados()) assert.equal(e.telefoneE164, null);
  });
});

describe("(5) origem por mensagem; o `type` do messages.upsert nunca filtra nem decide a origem", () => {
  test("type 'append' (offline) e 'notify' (ao vivo) são AMBOS encaminhados", async () => {
    const g = await novo();
    g.upsert([msg(PN, "A1")], "append");
    g.upsert([msg(PN, "N1")], "notify");
    await drenar();
    assert.deepEqual(g.enviados().map((e) => e.providerMessageId).sort(), ["A1", "N1"]);
  });

  test("nó offline (attrs.offline) ⇒ OFFLINE_NORMAL; nó sem attrs.offline ⇒ LIVE — independente do type consolidado", async () => {
    const g = await novo();
    g.stanza("OFF-1", "1"); g.stanza("VIVA-1");
    g.upsert([msg(PN, "OFF-1"), msg(PN, "VIVA-1")], "append"); // type de um flush misto: o do 1º item; aqui 'append' para as duas
    await drenar();
    const porId = Object.fromEntries(g.enviados().map((e) => [e.providerMessageId, e.origemTipo]));
    assert.deepEqual(porId, { "OFF-1": "OFFLINE_NORMAL", "VIVA-1": "LIVE" });
  });

  test("type 'notify' com nó offline continua OFFLINE_NORMAL; type 'append' com nó vivo continua LIVE", async () => {
    const g = await novo();
    g.stanza("OFF-2", "1"); g.stanza("VIVA-2");
    g.upsert([msg(PN, "OFF-2")], "notify");
    g.upsert([msg(PN, "VIVA-2")], "append");
    await drenar();
    const porId = Object.fromEntries(g.enviados().map((e) => [e.providerMessageId, e.origemTipo]));
    assert.deepEqual(porId, { "OFF-2": "OFFLINE_NORMAL", "VIVA-2": "LIVE" });
  });

  test("sem stanza observada (origem desconhecida): OFFLINE_NORMAL fail-safe — nunca LIVE por omissão, mesmo com type 'notify'", async () => {
    const g = await novo();
    g.upsert([msg(PN, "SEM-NO")], "notify");
    await drenar();
    assert.equal(g.enviados()[0].origemTipo, "OFFLINE_NORMAL");
  });

  test("um upsert com type desconhecido/ausente também é encaminhado (o type nunca é lido)", async () => {
    const g = await novo();
    g.socket.ev.emit("messages.upsert", { messages: [msg(PN, "T1")] });
    g.upsert([msg(PN, "T2")], "qualquer-coisa");
    await drenar();
    assert.equal(g.enviados().length, 2);
  });
});

describe("(6) mesmo provider id repetido — CARACTERIZAÇÃO (o Gateway NÃO deduplica)", () => {
  test("mesmo id 2x no MESMO upsert: o Gateway encaminha 2 vezes, ambas com o mesmo providerMessageId (chave de idempotência do backend, migration 090)", async () => {
    const g = await novo();
    g.upsert([msg(PN, "DUP-1", { conversation: "a" }), msg(PN, "DUP-1", { conversation: "a" })]);
    await drenar();
    const ids = g.enviados().map((e) => e.providerMessageId);
    assert.deepEqual(ids, ["DUP-1", "DUP-1"], "sem dedupe local: a garantia de 'uma mensagem' é o índice único do backend");
    assert.equal(new Set(ids).size, 1, "mas a chave de idempotência é estável");
  });

  test("mesmo id em dois upserts: 2 encaminhamentos; o 2º perde a origem (consumida no 1º ⇒ OFFLINE_NORMAL), então a origem de um duplicado não é confiável", async () => {
    const g = await novo();
    g.stanza("DUP-2");
    g.upsert([msg(PN, "DUP-2")], "notify");
    g.upsert([msg(PN, "DUP-2")], "notify");
    await drenar();
    assert.deepEqual(g.enviados().map((e) => [e.providerMessageId, e.origemTipo]), [["DUP-2", "LIVE"], ["DUP-2", "OFFLINE_NORMAL"]]);
  });
});

describe("(7) extração de texto pelo caminho real da sessão", () => {
  const texto = async (message) => { const g = await novo(); g.upsert([{ ...msg(PN, "TX"), message }]); await drenar(); const [e] = g.enviados(); ambiente.restaurarFetch(); return e; };

  test("conversation", async () => { const e = await texto({ conversation: "olá" }); assert.deepEqual([e.tipoConteudo, e.texto], ["texto", "olá"]); });
  test("extendedTextMessage", async () => { const e = await texto({ extendedTextMessage: { text: "com link https://x.y" } }); assert.deepEqual([e.tipoConteudo, e.texto], ["texto", "com link https://x.y"]); });
  test("ephemeralMessage embrulhando texto", async () => {
    const e = await texto({ ephemeralMessage: { message: { extendedTextMessage: { text: "efêmera" } } } });
    assert.deepEqual([e.tipoConteudo, e.texto], ["texto", "efêmera"]);
  });
  test("viewOnceMessage embrulhando texto", async () => {
    const e = await texto({ viewOnceMessage: { message: { conversation: "uma vez" } } });
    assert.deepEqual([e.tipoConteudo, e.texto], ["texto", "uma vez"]);
  });
  test("viewOnceMessageV2 dentro de ephemeralMessage", async () => {
    const e = await texto({ ephemeralMessage: { message: { viewOnceMessageV2: { message: { conversation: "duplo" } } } } });
    assert.deepEqual([e.tipoConteudo, e.texto], ["texto", "duplo"]);
  });
  test("mídia (imagem com legenda, áudio, documento, figurinha): tipoConteudo midia, texto null, legenda e binário nunca saem", async () => {
    for (const m of [
      { imageMessage: { caption: "LEGENDA-SECRETA", jpegThumbnail: "BINARIO" } }, { audioMessage: { ptt: true } },
      { documentMessage: { fileName: "a.pdf" } }, { stickerMessage: {} },
    ]) {
      const e = await texto(m);
      assert.deepEqual([e.tipoConteudo, e.texto], ["midia", null], Object.keys(m)[0]);
      assert.ok(!JSON.stringify(e).includes("LEGENDA-SECRETA"));
    }
  });
  test("reação, enquete, mensagem vazia ou sem `message`: tipoConteudo outro, texto null; nunca lança", async () => {
    for (const m of [{ reactionMessage: { text: "👍" } }, { pollCreationMessage: { name: "?" } }, {}, undefined, { conversation: "   " }]) {
      const e = await texto(m);
      assert.deepEqual([e.tipoConteudo, e.texto], ["outro", null], JSON.stringify(m));
    }
  });
});

describe("(8) falha de decrypt e stubs não viram texto", () => {
  test("stub CIPHERTEXT (sem corpo) é marcado falhaDecrypt com motivo do vocabulário fechado, tipoConteudo outro, texto null", async () => {
    const g = await novo();
    g.upsert([msg(PN, "F1", undefined, {}, { messageStubType: CIPHERTEXT, messageStubParameters: ["Bad MAC Error: segredo interno"], message: undefined })], "append");
    await drenar();
    const [e] = g.enviados();
    assert.deepEqual([e.falhaDecrypt, e.motivoFalhaDecrypt, e.tipoConteudo, e.texto], [true, "bad_mac", "outro", null]);
    assert.ok(!g.requisicoes()[0].init.body.includes("segredo interno"), "o texto do erro nunca sai");
  });

  test("stub CIPHERTEXT que ainda traga `message` com texto: o texto NÃO é encaminhado", async () => {
    const g = await novo();
    g.upsert([msg(PN, "F2", { conversation: "TEXTO-DE-STUB" }, {}, { messageStubType: CIPHERTEXT, messageStubParameters: ["No matching sessions found for message"] })]);
    await drenar();
    const [e] = g.enviados();
    assert.deepEqual([e.falhaDecrypt, e.motivoFalhaDecrypt, e.texto], [true, "sem_sessao_compativel", null]);
    assert.ok(!g.requisicoes()[0].init.body.includes("TEXTO-DE-STUB"));
  });

  test("stub de sistema (não CIPHERTEXT): stubSistema=true, falhaDecrypt=false, sem texto", async () => {
    const g = await novo();
    g.upsert([msg(PN, "F3", { conversation: "TEXTO-DE-STUB" }, {}, { messageStubType: proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD })]);
    await drenar();
    const [e] = g.enviados();
    assert.deepEqual([e.stubSistema, e.falhaDecrypt, e.tipoConteudo, e.texto], [true, false, "outro", null]);
  });

  test("mensagem SEM id não é encaminhada (não há como deduplicar) e não derruba as demais do lote", async () => {
    const g = await novo();
    g.upsert([{ key: { remoteJid: PN, fromMe: false }, message: { conversation: "sem id" } }, msg(PN, "OK-1")]);
    await drenar();
    assert.deepEqual(g.enviados().map((e) => e.providerMessageId), ["OK-1"]);
  });
});

describe("(9) o que o Gateway realmente envia ao backend (HMAC) nunca contém segredos nem o auth state", () => {
  test("URL, método, corpo e headers: rota certa, JSON do evento, assinatura HMAC válida sobre o corpo, sem `conteudo`/creds/segredo", async () => {
    const g = await novo();
    g.upsert([msg(PN, "H1", { conversation: "olá backend" })]);
    await drenar();
    assert.equal(g.requisicoes().length, 1);
    const { url, init } = g.requisicoes()[0];
    assert.equal(url, "http://127.0.0.1:9/internal/comunicacao/eventos/mensagem-recebida");
    assert.equal(init.method, "POST");
    assert.deepEqual(Object.keys(init.headers).sort(), ["Content-Type", "X-Gateway-Nonce", "X-Gateway-Signature", "X-Gateway-Timestamp"]);
    // assinatura recalculada de forma independente (timestamp \n nonce \n MÉTODO \n caminho \n sha256(corpo))
    const h = init.headers;
    const esperado = createHmac("sha256", SEGREDO_HMAC).update([h["X-Gateway-Timestamp"], h["X-Gateway-Nonce"], "POST", "/internal/comunicacao/eventos/mensagem-recebida", createHash("sha256").update(init.body).digest("hex")].join("\n")).digest("hex");
    assert.equal(h["X-Gateway-Signature"], esperado);
    const corpo = JSON.parse(init.body);
    assert.equal(corpo.texto, "olá backend");
    assert.equal("conteudo" in corpo, false, "o `message` cru do Baileys fica só no handler interno, nunca vai ao backend");
    assert.deepEqual(Object.keys(corpo).sort(), ["contratoInbound", "falhaDecrypt", "fromMe", "motivoFalhaDecrypt", "origemJidTipo", "origemTipo", "providerMessageId", "recebidoEm", "stubSistema", "telefoneE164", "telefoneOrigem", "texto", "tipoConteudo"]);
  });

  test("nem o segredo HMAC, nem creds/chaves privadas, nem o próprio número/LID autenticado aparecem em corpo ou headers (texto, mídia, LID, grupo, falha de decrypt)", async () => {
    const g = await novo();
    g.upsert([
      msg(PN, "S1"), msg(PN, "S2", { imageMessage: { caption: "x" } }), msg(LID, "S3", undefined, { senderPn: "5511988887777@s.whatsapp.net" }),
      msg("120363000000000001@g.us", "S4"), msg(PN, "S5", undefined, {}, { messageStubType: CIPHERTEXT, messageStubParameters: ["Bad MAC"], message: undefined }),
    ]);
    await drenar();
    assert.equal(g.requisicoes().length, 5);
    for (const { init } of g.requisicoes()) {
      const tudo = init.body + JSON.stringify(init.headers);
      for (const proibido of [SEGREDO_HMAC, MARCADOR_CREDS, MARCADOR_SIGNAL, "noiseKey", "signedIdentityKey", "privateKey", "5511999990009", "100000000000009"]) {
        assert.ok(!tudo.includes(proibido), `vazou: ${proibido}`);
      }
      assert.ok(!Object.values(init.headers).some((v) => String(v) === SEGREDO_HMAC));
    }
  });

  test("uma falha do backend (fetch rejeita) não derruba o Gateway nem os próximos encaminhamentos", async () => {
    const g = await novo();
    const anterior = globalThis.fetch; let n = 0;
    globalThis.fetch = async (...a) => { n += 1; if (n === 1) throw new Error("rede caiu"); return anterior(...a); };
    g.upsert([msg(PN, "R1"), msg(PN, "R2")]);
    await drenar();
    assert.equal(g.backendClient.notificarMensagemRecebida.mock.callCount(), 2);
    globalThis.fetch = anterior;
  });
});
