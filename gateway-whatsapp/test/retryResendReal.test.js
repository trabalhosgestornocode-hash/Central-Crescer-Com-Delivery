// INTEGRAÇÃO com o Baileys 6.7.24 REAL (socket real ↔ servidor WebSocket LOCAL; Signal/libsignal REAL; nenhuma rede
// externa; JIDs sintéticos). Reproduz exatamente o incidente "Aguardando mensagem" e prova cada etapa da correção:
//
//   1. o Gateway envia uma mensagem (sendMessage real → stanza cifrada para cada aparelho do destinatário);
//   2. o aparelho 2 do destinatário PERDEU a sessão (chaves novas) e NÃO consegue decifrar a original — é o estado em
//      que o WhatsApp mostra "Aguardando mensagem";
//   3. ele manda um RETRY RECEIPT;
//   4. o Baileys chama getMessage → cache HIT (src/retryCache.js) → força sessão nova (consulta de pré-chave que o
//      servidor falso responde com o bundle NOVO do aparelho) → REENVIA;
//   5. o aparelho 2 DECIFRA o reenvio e lê o MESMO texto.
//
// Controle negativo: o mesmo cenário com a flag DESLIGADA (comportamento de produção até hoje) — o Baileys força a
// sessão, mas NADA é reenviado: o aparelho fica preso em "Aguardando mensagem".
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { initAuthCreds, proto, Curve, encodeBigEndian, getBinaryNodeChild, getBinaryNodeChildren, xmppPreKey, xmppSignedPreKey, unpadRandomMax16, jidDecode } from "baileys";
import { makeLibSignalRepository } from "../node_modules/baileys/lib/Signal/libsignal.js";
import { criarGatewayFalso, capturarConsole, MEU_JID } from "../test-support/inboundHarness.js";
import { criarLoggerBaileysSilencioso } from "../src/logger-baileys-silencioso.js";
import { criarCacheRetry, criarCacheTtl } from "../src/retryCache.js";
import { identidadeDe } from "../src/inboundScope.js";
import { criarBackendRetryFalso } from "../test-support/backendRetryFalso.js";

const PAR_USER = "5511888880001";
const PAR_PN = `${PAR_USER}@s.whatsapp.net`;
const PAR_APARELHO_2 = `${PAR_USER}:2@s.whatsapp.net`;
const TEXTO = "Alerta Crescer (teste de integração): pendência de recebimento 0042";

/** Um aparelho fictício: chaves próprias e um repositório libsignal real (o lado "celular do destinatário"). */
function criarAparelho() {
  const creds = initAuthCreds();
  const store = {};
  const keys = {
    async get(tipo, ids) { const o = {}; for (const id of ids) if (store[tipo]?.[id] !== undefined) o[id] = store[tipo][id]; return o; },
    async set(d) { for (const t of Object.keys(d)) { store[t] ??= {}; for (const id of Object.keys(d[t])) { if (d[t][id] === null) delete store[t][id]; else store[t][id] = d[t][id]; } } },
  };
  const preKeyId = 1 + Math.floor(Math.random() * 1000);
  const preKey = Curve.generateKeyPair();
  store["pre-key"] = { [String(preKeyId)]: preKey };
  const repo = makeLibSignalRepository({ creds, keys });
  return {
    repo,
    /** o <user> que o servidor devolve numa consulta de pré-chave (formato de Utils/signal.js#parseAndInjectE2ESessions) */
    bundle: (jid) => ({ tag: "user", attrs: { jid }, content: [
      { tag: "registration", attrs: {}, content: encodeBigEndian(creds.registrationId) },
      { tag: "type", attrs: {}, content: Buffer.from([5]) },
      { tag: "identity", attrs: {}, content: creds.signedIdentityKey.public },
      xmppSignedPreKey(creds.signedPreKey),
      xmppPreKey(preKey, preKeyId),
    ] }),
    /** decifra a <enc> que o Gateway mandou para ESTE aparelho */
    async decifrar(enc) {
      const bytes = await repo.decryptMessage({ jid: MEU_JID, type: enc.attrs.type, ciphertext: enc.content });
      return proto.Message.decode(unpadRandomMax16(bytes));
    },
  };
}

/** <enc> destinada a um aparelho dentro de uma stanza <message> do Gateway. */
function encPara(stanza, jidAparelho) {
  const participantes = getBinaryNodeChild(stanza, "participants");
  const to = participantes ? getBinaryNodeChildren(participantes, "to").find((n) => n.attrs.jid === jidAparelho) : null;
  if (to) return getBinaryNodeChild(to, "enc");
  return stanza.attrs.to === jidAparelho ? getBinaryNodeChild(stanza, "enc") : null;
}

async function cenario({ habilitado }) {
  const cap = capturarConsole();
  const eventos = [];
  const backend = criarBackendRetryFalso();
  const retryCache = criarCacheRetry({
    backendClient: backend, chaveEncriptacaoEnv: randomBytes(32).toString("base64"), obterContextoLease: () => ({ ...backend.lease }),
    habilitado, emitir: (nivel, evento, dados) => eventos.push({ evento, dados }), esperaPendenteMs: 500,
  });
  // Aparelhos conhecidos pelo "servidor": o primário do destinatário, o aparelho 2, e o celular da NOSSA conta (para a cópia DSM).
  const aparelhos = new Map();
  const aparelho = (jid) => { if (!aparelhos.has(jid)) aparelhos.set(jid, criarAparelho()); return aparelhos.get(jid); };
  const consultasPreChave = [];
  // Lista de aparelhos já conhecida (a mesma estrutura que o Baileys guarda após um usync) — sem usync neste servidor falso.
  const userDevicesCache = criarCacheTtl({ ttlMs: 60_000 });
  userDevicesCache.set(PAR_USER, [{ user: PAR_USER, device: 2 }]);
  userDevicesCache.set(jidDecode(MEU_JID).user, []);

  const gw = await criarGatewayFalso({
    logger: retryCache.envolverLogger(criarLoggerBaileysSilencioso()),
    opcoesBaileys: { ...retryCache.opcoesSocket({ obterGeracaoSocket: () => 1 }), userDevicesCache },
    defaultQueryTimeoutMs: 5_000,
  });
  retryCache.observarSocket(gw.sock, { obterGeracaoSocket: () => 1, obterIdentidade: () => identidadeDe(gw.sock.authState?.creds?.me) });
  // O "servidor": responde as consultas de pré-chave (iq xmlns=encrypt type=get) com o bundle ATUAL de cada aparelho.
  gw.aoNoDoCliente((no) => {
    if (no?.tag !== "iq" || no.attrs?.xmlns !== "encrypt" || no.attrs?.type !== "get") return;
    const pedidos = getBinaryNodeChildren(getBinaryNodeChild(no, "key"), "user").map((u) => u.attrs.jid);
    consultasPreChave.push(pedidos);
    gw.sock.ws.emit(`TAG:${no.attrs.id}`, { tag: "iq", attrs: { id: no.attrs.id, type: "result", from: "s.whatsapp.net" }, content: [
      { tag: "list", attrs: {}, content: pedidos.map((jid) => aparelho(jid).bundle(jid)) },
    ] });
  });

  const stanzasMensagem = () => gw.enviados.filter((n) => n.tag === "message");
  return { gw, cap, eventos, backend, retryCache, aparelho, aparelhos, consultasPreChave, stanzasMensagem, fim: async () => { cap.restaurar(); await gw.encerrar(); } };
}

async function enviarComoGateway(c) {
  // o MESMO par de chamadas de baileysSession.js#enviar(): marcar → sendMessage real → registrar o fullMsg.message
  const fullMsg = await c.gw.sock.sendMessage(PAR_PN, { text: TEXTO });
  c.retryCache.registrarEnvio({ providerMessageId: fullMsg.key.id, mensagem: fullMsg.message, destinoJid: PAR_PN, socketGeneration: 1 });
  await c.gw.aguardarQuiescencia({ estavelMs: 300, maxMs: 8_000 });
  return fullMsg.key.id;
}

function retryReceipt(id, de) {
  return { tag: "receipt", attrs: { id, from: de, type: "retry", t: "1700000000" }, content: [
    { tag: "retry", attrs: { count: "1", id, t: "1700000000", v: "1" } },
    { tag: "registration", attrs: {}, content: encodeBigEndian(4242) },
  ] };
}

describe("reenvio sob retry receipt — Baileys 6.7.24 real", { timeout: 60_000 }, () => {
  test("HIT: retry recebido → getMessage → mensagem encontrada → reenvio → o aparelho DECIFRA o mesmo texto", async () => {
    const c = await cenario({ habilitado: true });
    try {
      // (1) envio real
      const id = await enviarComoGateway(c);
      const original = c.stanzasMensagem().find((s) => s.attrs.id === id);
      assert.ok(original, "o Gateway enviou a stanza original");
      const encOriginalAp2 = encPara(original, PAR_APARELHO_2);
      assert.ok(encOriginalAp2, "a original foi cifrada também para o aparelho 2");
      assert.equal(c.backend.linhas.size, 1, "conteúdo persistido (cifrado) no 'banco'");

      // (2) o aparelho 2 perde a sessão (reinstalação/troca de chaves): NÃO decifra a original → "Aguardando mensagem"
      c.aparelhos.set(PAR_APARELHO_2, criarAparelho());
      await assert.rejects(c.aparelho(PAR_APARELHO_2).decifrar(encOriginalAp2), "o aparelho não consegue ler a original");

      // (3) ele pede retry
      const consultasAntes = c.consultasPreChave.length;
      c.gw.sock.ws.emit("CB:receipt", retryReceipt(id, PAR_APARELHO_2));
      await c.gw.aguardarQuiescencia({ estavelMs: 400, maxMs: 10_000 });

      // (4) evidências de cada etapa
      const nomes = c.eventos.map((e) => e.evento);
      const recebido = c.eventos.find((e) => e.evento === "whatsapp.retry.received")?.dados;
      assert.ok(recebido, "ETAPA retry recebido");
      assert.deepEqual({ r: recebido.remoteJidType, d: recebido.dispositivo, propria: recebido.deContaPropria, c: recebido.retryCount }, { r: "PN", d: "companion", propria: false, c: 1 });
      const achada = c.eventos.find((e) => e.evento === "whatsapp.retry.message_found")?.dados;
      assert.ok(achada, "ETAPA getMessage chamado + mensagem encontrada");
      assert.equal(achada.destinoVerificado, true);
      assert.ok(nomes.includes("whatsapp.retry.resend_requested"), "ETAPA reenvio solicitado ao Baileys");
      assert.ok(nomes.includes("whatsapp.retry.resend_sent"), "ETAPA reenvio de fato enviado (logger do Baileys)");
      assert.deepEqual(c.consultasPreChave.slice(consultasAntes), [[PAR_APARELHO_2]], "sessão nova forçada SÓ com o aparelho que pediu");
      const reenvios = c.stanzasMensagem().filter((s) => s.attrs.id === id);
      assert.equal(reenvios.length, 2, "a MESMA mensagem (mesmo id) saiu de novo no fio");
      const reenvio = reenvios[1];
      assert.equal(reenvio.attrs.to, PAR_APARELHO_2, "endereçada só ao aparelho que pediu");
      assert.equal(reenvio.attrs.device_fanout, "false");

      // (5) o aparelho decifra o reenvio — o destinatário passa a VER a mensagem
      const lida = await c.aparelho(PAR_APARELHO_2).decifrar(encPara(reenvio, PAR_APARELHO_2));
      assert.equal(lida.extendedTextMessage?.text, TEXTO);

      const m = c.retryCache.metricas();
      assert.deepEqual({ rec: m.retryRecebido, hit: m.cacheHit, miss: m.cacheMiss, env: m.reenvioEnviado, taxa: m.cacheHitRate }, { rec: 1, hit: 1, miss: 0, env: 1, taxa: 1 });
      // Evidência opcional para o checkpoint (só eventos sanitizados + forma do fio; nunca texto/telefone/ciphertext).
      if (process.env.RETRY_EVIDENCIA_ARQUIVO) {
        const fio = c.gw.enviados.filter((n) => ["message", "receipt", "iq"].includes(n.tag)).map((n) => ({
          tag: n.tag, idIgualAoEnvio: n.attrs.id === id, type: n.attrs.type ?? null, xmlns: n.attrs.xmlns ?? null,
          para: n.attrs.to === PAR_APARELHO_2 ? "aparelho_2_destinatario" : (n.attrs.to ? "outro" : null),
          encs: n.tag === "message" ? (getBinaryNodeChildren(getBinaryNodeChild(n, "participants"), "to").map((t) => getBinaryNodeChild(t, "enc")?.attrs.type)) : undefined,
        }));
        writeFileSync(process.env.RETRY_EVIDENCIA_ARQUIVO, JSON.stringify({ eventos: c.eventos, fio, aparelhoDecifrou: lida.extendedTextMessage?.text === TEXTO, metricas: m }, null, 2));
      }
      assert.equal(c.backend.linhas.get(id).reenvios, 1, "o banco contou o reenvio");
      assert.ok(!JSON.stringify(c.eventos).includes(TEXTO) && !JSON.stringify(c.eventos).includes(PAR_USER), "nenhum evento carrega texto ou telefone");
    } finally { await c.fim(); }
  });

  test("CONTROLE (flag desligada = produção hoje): retry recebido, sessão forçada, mas NENHUM reenvio — aparelho fica preso", async () => {
    const c = await cenario({ habilitado: false });
    try {
      const id = await enviarComoGateway(c);
      c.aparelhos.set(PAR_APARELHO_2, criarAparelho());
      c.gw.sock.ws.emit("CB:receipt", retryReceipt(id, PAR_APARELHO_2));
      await c.gw.aguardarQuiescencia({ estavelMs: 400, maxMs: 10_000 });
      assert.ok(c.eventos.some((e) => e.evento === "whatsapp.retry.received"), "a observação passiva vê o retry mesmo desligada");
      assert.equal(c.stanzasMensagem().filter((s) => s.attrs.id === id).length, 1, "só a original — nada reenviado");
      assert.equal(c.backend.chamadas.salvar.length, 0, "desligada não grava conteúdo");
    } finally { await c.fim(); }
  });

  test("restart do PROCESSO entre o envio e o retry: memória vazia, o banco serve e o aparelho decifra", async () => {
    const c = await cenario({ habilitado: true });
    try {
      const id = await enviarComoGateway(c);
      c.retryCache._memoria.clear(); // o que um restart apaga
      c.aparelhos.set(PAR_APARELHO_2, criarAparelho());
      c.gw.sock.ws.emit("CB:receipt", retryReceipt(id, PAR_APARELHO_2));
      await c.gw.aguardarQuiescencia({ estavelMs: 400, maxMs: 10_000 });
      assert.equal(c.eventos.find((e) => e.evento === "whatsapp.retry.message_found")?.dados.fonte, "banco");
      const reenvio = c.stanzasMensagem().filter((s) => s.attrs.id === id)[1];
      assert.ok(reenvio, "reenviado");
      assert.equal((await c.aparelho(PAR_APARELHO_2).decifrar(encPara(reenvio, PAR_APARELHO_2))).extendedTextMessage?.text, TEXTO);
    } finally { await c.fim(); }
  });
});
