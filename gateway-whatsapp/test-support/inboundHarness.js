// (fora de test/ de propósito: `node --test test/` executaria este arquivo como se fosse um teste)
// Harness do C.9.3 — exercita o pipeline de RECEBIMENTO REAL do Baileys 6.7.24 (handleMessage →
// shouldIgnoreJid → decryptMessageNode → libsignal → adapter de auth) sem nenhuma rede externa:
//   * o socket Baileys real aponta para um servidor WebSocket LOCAL (127.0.0.1) que nunca conclui o
//     handshake Noise — ele só coleta o que o cliente envia (acks, retry receipts);
//   * as stanzas de "mensagem" são montadas com criptografia REAL (libsignal), por pares fictícios;
//   * nada aqui fala com o WhatsApp; nenhum dado é real (JIDs sintéticos).
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import makeWASocket, { initAuthCreds, proto, encodeWAMessage, decodeBinaryNode, generateSignalPubKey, getNextPreKeys } from "baileys";
import { makeLibSignalRepository } from "../node_modules/baileys/lib/Signal/libsignal.js";
import { criarAuthStateAdapter, serializarAuth } from "../src/authState.js";
import { medirAuthState } from "../src/authMetrics.js";
import { criarLoggerBaileysSilencioso } from "../src/logger-baileys-silencioso.js";

export const MEU_JID = "5511999990000:1@s.whatsapp.net";
export const MEU_LID = "100000000000001:1@lid";
export const MEU_JID_ENDERECO = "5511999990000@s.whatsapp.net";
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// O handshake Noise NUNCA conclui neste harness: o timer `connectTimeoutMs` do Baileys ficaria pendente por 10 min e o
// processo de teste não sairia. Só esse timer (valor único) recebe unref — só em teste, só neste helper.
const CONNECT_TIMEOUT_TESTE_MS = 600_123;
const setTimeoutOriginal = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => { const h = setTimeoutOriginal(fn, ms, ...args); if (ms === CONNECT_TIMEOUT_TESTE_MS) h.unref?.(); return h; };

/** keys store em memória (lado dos pares). */
function keysEmMemoria() {
  const s = {};
  return {
    async get(tipo, ids) { const o = {}; for (const id of ids) if (s[tipo]?.[id] !== undefined) o[id] = s[tipo][id]; return o; },
    async set(d) { for (const t of Object.keys(d)) { s[t] ??= {}; for (const id of Object.keys(d[t])) { if (d[t][id] === null) delete s[t][id]; else s[t][id] = d[t][id]; } } },
  };
}

/** console: captura (libsignal/Baileys escrevem "Session error"/"Failed to decrypt" aqui). */
export function capturarConsole() {
  const originais = {}; const linhas = [];
  for (const n of ["log", "info", "warn", "error", "debug"]) {
    originais[n] = console[n];
    console[n] = (...a) => { linhas.push({ nivel: n, texto: String(a[0]).slice(0, 80) }); };
  }
  return {
    linhas,
    restaurar() { for (const n of Object.keys(originais)) console[n] = originais[n]; },
    contar: (re) => linhas.filter((l) => re.test(l.texto)).length,
  };
}

export function criarLoggerGravador() {
  const eventos = [];
  const mk = () => ({ level: "trace", child: () => mk(), ...Object.fromEntries(["trace", "debug", "info", "warn", "error", "fatal"].map((n) => [n, (o, m) => eventos.push({ n, m: typeof o === "string" ? o : m, e: o?.err?.message ?? o?.error?.message })])) });
  const l = mk(); l.eventos = eventos; return l;
}

export async function criarGatewayFalso({ shouldIgnoreJid, logger = criarLoggerBaileysSilencioso(), inbound, opcoesBaileys = {}, meLid = MEU_LID, latenciaKeysMs = 0 } = {}) {
  const servidor = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(servidor, "listening");
  const quadros = [];
  servidor.on("connection", (c) => c.on("message", (d) => quadros.push(Buffer.from(d))));
  const porta = servidor.address().port;

  const backend = { async salvarAuthState() { return { authSessionId: "s" }; }, async carregarAuthState() { return { status: "absent" }; } };
  const adapter = criarAuthStateAdapter({ backendClient: backend, chaveEncriptacaoEnv: randomBytes(32).toString("base64") });
  const creds = initAuthCreds();
  creds.me = { id: MEU_JID, lid: meLid, name: "GW" };
  creds.registered = true;
  adapter.inicializarCreds(creds);
  const state = adapter.comoAuthState();
  const leituras = { session: 0, "sender-key": 0, "pre-key": 0 };   // keys.get por categoria — só o pipeline de decrypt lê 'session'/'sender-key'
  const getOriginal = state.keys.get;
  // `latenciaKeysMs` imita o I/O real do adapter de auth em produção (POST ao backend): cede o event loop entre as etapas do decrypt.
  state.keys.get = async (tipo, ids) => { if (tipo in leituras) leituras[tipo] += 1; if (latenciaKeysMs) await espera(latenciaKeysMs); return getOriginal(tipo, ids); };
  const { update } = await getNextPreKeys({ creds, keys: state.keys }, 60);   // pré-chaves "já enviadas ao servidor"
  await adapter.aoAtualizarCreds(update);

  // cache de contagem de retry INJETADO: o padrão do Baileys segura 5 s por 1º retry (requestPlaceholderResend) numa fila
  // serial — inviável em teste. `marcarSegundaEntrega` reproduz "a mesma mensagem falhou de novo na mesma conexão".
  const contagemRetry = new Map();
  const msgRetryCounterCache = { get: (k) => contagemRetry.get(k), set: (k, v) => { contagemRetry.set(k, v); }, del: (k) => { contagemRetry.delete(k); } };
  const marcarSegundaEntrega = (node) => contagemRetry.set(`${node.attrs.id}:${node.attrs.participant}`, 1);

  const sock = makeWASocket({
    msgRetryCounterCache,
    auth: state,
    waWebSocketUrl: `ws://127.0.0.1:${porta}/ws/chat`,
    logger: inbound?.envolverLogger?.(logger) ?? logger,
    printQRInTerminal: false,
    ...(shouldIgnoreJid ? { shouldIgnoreJid } : {}),
    ...(inbound?.opcoesSocket?.() ?? {}),   // NUNCA passar undefined: o merge de defaults do Baileys o sobrescreveria
    ...opcoesBaileys,                       // ex.: shouldSyncHistoryMessage, placeholderResendCache (só testes)
    connectTimeoutMs: CONNECT_TIMEOUT_TESTE_MS, defaultQueryTimeoutMs: 40, keepAliveIntervalMs: 600_000,
    retryRequestDelayMs: 0, fireInitQueries: false, markOnlineOnConnect: false, syncFullHistory: false,
  });
  for (let i = 0; i < 100 && !sock.ws.isOpen; i++) await espera(20);
  if (!sock.ws.isOpen) throw new Error("harness: o socket local não abriu");

  inbound?.observarSocket?.(sock);
  const upserts = [];       // mensagens que CHEGARAM ao ev (não ignoradas)
  sock.ev.on("messages.upsert", ({ messages }) => { upserts.push(...messages); try { inbound?.aoMensagens?.(messages); } catch { /* idem sessão */ } });
  const enviados = [];      // nós decodificados que o cliente enviou (acks, receipts)
  let lidos = 1;            // o quadro 0 é o ClientHello do Noise
  async function drenarEnviados() {
    while (lidos < quadros.length) {
      const q = quadros[lidos++];
      try { enviados.push(await decodeBinaryNode(q.subarray(3))); } catch { /* quadro não-nó */ }
    }
  }

  let seq = 0;
  const nextId = () => `TESTMSG${String(++seq).padStart(6, "0")}`;

  const OFFLINE_FIM = { tag: "ib", attrs: {}, content: [{ tag: "offline", attrs: { count: "0" } }] };
  /**
   * Entrega uma stanza como o servidor faria (nó "offline", como na rajada pós-reconexão) e espera o
   * desfecho: ACK do Baileys (mensagem ignorada) OU a mensagem aparecer em messages.upsert (decifrada
   * ou como stub de falha). O flush do buffer de eventos é o mesmo que o servidor dispara no fim do offline.
   */
  async function receberStanza(node) {
    const id = node.attrs.id;
    const antes = upserts.length;
    sock.ws.emit("CB:message", node);
    for (let i = 0; i < 120; i++) {
      await espera(25);
      sock.ws.emit("CB:ib,,offline", OFFLINE_FIM);
      await drenarEnviados();
      const ack = enviados.some((n) => n.tag === "ack" && n.attrs.id === id);
      const upsert = upserts.slice(antes).some((m) => m.key?.id === id);
      if (ack || upsert) break;
    }
    await espera(40);              // deixa o retry receipt / persistência em segundo plano assentarem
    await drenarEnviados();
  }
  /**
   * Entrega uma stanza SEM emitir nenhum sinal de fim de fila offline (nem nada que flush o buffer): é o que ocorre em
   * produção enquanto `CB:ib,,offline` não chega. Espera o pipeline assentar (decrypt, retry, persistência).
   */
  async function entregarSemFimOffline(node, { estavelMs = 300 } = {}) {
    sock.ws.emit("CB:message", node);
    await aguardarQuiescencia({ estavelMs, maxMs: 8000 });
  }
  /** o servidor avisa que a fila offline acabou (o Baileys faz flush do buffer inicial e emite receivedPendingNotifications). */
  function emitirOfflineFim(count = 0) { sock.ws.emit("CB:ib,,offline", { tag: "ib", attrs: {}, content: [{ tag: "offline", attrs: { count: String(count) } }] }); }
  function emitirOfflinePreview() { sock.ws.emit("CB:ib,,offline_preview", { tag: "ib", attrs: {}, content: [{ tag: "offline_preview", attrs: { count: "3" } }] }); }
  const bufferando = () => sock.ev.isBuffering();
  /** espera o pipeline em segundo plano (retry receipts, persistência) parar de produzir tráfego. */
  async function aguardarQuiescencia({ estavelMs = 500, maxMs = 25_000 } = {}) {
    const ini = Date.now(); let ultimo = -1; let desde = Date.now();
    while (Date.now() - ini < maxMs) {
      await drenarEnviados();
      const n = enviados.length + upserts.length + quadros.length;
      if (n !== ultimo) { ultimo = n; desde = Date.now(); } else if (Date.now() - desde >= estavelMs) break;
      await espera(50);
    }
  }
  const acks = (id) => enviados.filter((n) => n.tag === "ack" && (!id || n.attrs.id === id)).length;
  const retryReceipts = () => enviados.filter((n) => n.tag === "receipt" && n.attrs.type === "retry").length;
  const retryComChaves = () => enviados.filter((n) => n.tag === "receipt" && n.attrs.type === "retry" && Array.isArray(n.content) && n.content.some((c) => c.tag === "keys")).length;

  const medir = () => {
    const sn = adapter._snapshot();
    const m = medirAuthState({ creds: sn.creds, keys: sn.keysPorTipo }, { serializar: serializarAuth });
    const c = (n) => m.categories[n]?.entries ?? 0;
    return { preKey: c("pre-key"), session: c("session"), senderKey: c("sender-key"), senderKeyMemory: c("sender-key-memory"), total: m.plaintextBytes };
  };

  /** par fictício: tem seu próprio repositório libsignal e "abre sessão" conosco com uma pré-chave nossa. */
  let proximaPreKey = 1;
  async function criarPar(jid) {
    const credsPar = initAuthCreds();
    const repo = makeLibSignalRepository({ creds: credsPar, keys: keysEmMemoria() });
    const par = { jid, repo, credsPar };
    par.injetarSessaoConosco = async () => {
      const id = proximaPreKey++;
      const { [String(id)]: pk } = await state.keys.get("pre-key", [String(id)]);
      if (!pk) throw new Error("harness: acabaram as pré-chaves do gateway falso");
      await repo.injectE2ESession({ jid: MEU_JID_ENDERECO, session: {
        registrationId: creds.registrationId,
        identityKey: generateSignalPubKey(creds.signedIdentityKey.public),
        signedPreKey: { keyId: creds.signedPreKey.keyId, publicKey: generateSignalPubKey(creds.signedPreKey.keyPair.public), signature: creds.signedPreKey.signature },
        preKey: { keyId: id, publicKey: generateSignalPubKey(pk.public) },
      } });
    };
    par.cifrar = (texto) => repo.encryptMessage({ jid: MEU_JID_ENDERECO, data: encodeWAMessage({ conversation: texto }) });
    return par;
  }

  const stanzaEnc = (attrs, encs) => ({
    tag: "message",
    attrs: { id: nextId(), t: String(1_700_000_000 + seq), type: "text", offline: "1", ...attrs },
    content: encs.map(({ type, ciphertext }) => ({ tag: "enc", attrs: { v: "2", type }, content: ciphertext })),
  });

  /** mensagem DIRETA (chat 1:1): pkmsg na 1ª vez, depois "msg". `adulterar` estraga o MAC → Bad MAC. */
  async function mensagemDireta(par, texto, { adulterar = false } = {}) {
    if (!par._sessao) { await par.injetarSessaoConosco(); par._sessao = true; }
    const { type, ciphertext } = await par.cifrar(texto);
    if (adulterar) ciphertext[ciphertext.length - 1] ^= 0xff;
    return stanzaEnc({ from: par.jid }, [{ type, ciphertext }]);
  }

  /** mensagem de GRUPO (ou status): SKDM 1:1 (pkmsg/msg) + skmsg. from = grupo, participant = par. */
  async function mensagemGrupo(par, grupoJid, texto, { adulterar = false } = {}) {
    if (!par._sessao) { await par.injetarSessaoConosco(); par._sessao = true; }
    const { ciphertext: skmsg, senderKeyDistributionMessage } = await par.repo.encryptGroupMessage({ group: grupoJid, meId: par.jid, data: encodeWAMessage({ conversation: texto }) });
    const skdmMsg = encodeWAMessage({ senderKeyDistributionMessage: { groupId: grupoJid, axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage } });
    const skdm = await par.repo.encryptMessage({ jid: MEU_JID_ENDERECO, data: skdmMsg });
    if (adulterar) skdm.ciphertext[skdm.ciphertext.length - 1] ^= 0xff;
    return stanzaEnc({ from: grupoJid, participant: par.jid }, [{ type: skdm.type, ciphertext: skdm.ciphertext }, { type: "skmsg", ciphertext: skmsg }]);
  }

  /** o gateway responde ao par (completa o handshake: as próximas do par saem como "msg", não "pkmsg"). */
  async function responderAoPar(par) {
    const enc = await sock.signalRepository.encryptMessage({ jid: par.jid, data: encodeWAMessage({ conversation: "ok" }) });
    await par.repo.decryptMessage({ jid: MEU_JID_ENDERECO, type: enc.type, ciphertext: enc.ciphertext });
  }

  async function encerrar() {
    try { sock.end(undefined); } catch { /* já encerrado */ }
    for (const c of servidor.clients) c.terminate();
    await new Promise((r) => servidor.close(() => r()));
  }

  return { entregarSemFimOffline, emitirOfflineFim, emitirOfflinePreview, bufferando, marcarSegundaEntrega, sock, adapter, upserts, enviados, leituras, aguardarQuiescencia, acks, retryReceipts, retryComChaves, medir, criarPar, stanzaEnc, mensagemDireta, mensagemGrupo, responderAoPar, receberStanza, encerrar, espera, drenarEnviados };
}

export { proto };
