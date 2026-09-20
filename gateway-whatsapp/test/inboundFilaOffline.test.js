// C.9.4 — fila offline / buffer de eventos do Baileys 6.7.24 e atribuição REAL de decrypt por tipo de JID.
// Tudo com o pipeline REAL (socket Baileys → servidor WebSocket LOCAL, criptografia libsignal real, pares fictícios;
// nenhuma rede externa). Prova por execução:
//   * o buffer de eventos nasce ATIVO no boot (logado) e só é liberado por flush explícito;
//   * `CB:ib,,offline` (fim da fila offline) faz flush — mas o que é decifrado DEPOIS dele é re-enfileirado e fica RETIDO
//     até um nó VIVO (não-offline) ser processado (é o gate que mantém `messages.upsert` em zero);
//   * cada mensagem é atribuída ao TIPO de JID no ponto em que tipo + resultado do decrypt coexistem;
//   * direct_lid_self × direct_lid_other é decidido só em memória, sem expor nenhum identificador.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { proto } from "baileys";
import { criarGatewayFalso, capturarConsole, MEU_LID } from "../test-support/inboundHarness.js";
import { criarInboundGateway, classificarJid, identidadeDe, TIPOS_JID } from "../src/inboundScope.js";

const G1 = "120363000000000001@g.us";
const D = (n) => `55118888${String(n).padStart(5, "0")}@s.whatsapp.net`;
const P = (n) => `55117777${String(n).padStart(5, "0")}@s.whatsapp.net`;
const LID_OUTRO = (n) => `10000000000${String(n).padStart(4, "0")}@lid`;
const LID_PROPRIO_OUTRO_APARELHO = "100000000000001:7@lid";        // MESMO usuário do MEU_LID, outro dispositivo
const VAZAMENTO = /5511|1000000000|whatsapp\.net|120363|@lid|@g\.us|TESTMSG|NLT|@newsletter|@broadcast|\d{10,}/;
const SEM_ESPERA_PLACEHOLDER = { placeholderResendCache: { get: () => true, set() {}, del() {} } };   // pula o delay de 5 s do 1º retry

async function abrir({ diag = true, opcoesBaileys = {}, latenciaKeysMs = 0 } = {}) {
  const cap = capturarConsole();
  const eventos = [];
  const inbound = criarInboundGateway({ diagHabilitado: diag, emitir: (n, e, d) => eventos.push({ e, d }), agendar: () => ({ unref() {} }), consoleAlvo: console });
  const gw = await criarGatewayFalso({ inbound, opcoesBaileys, latenciaKeysMs });
  return { gw, inbound, eventos, cap, fim: async () => { inbound.parar(); cap.restaurar(); await gw.encerrar(); } };
}
const mens = (inbound, tipo) => inbound.snapshot().mensagens[tipo] ?? { decryptTentado: 0, decryptOk: 0, decryptFalha: 0, enfileiradas: 0, emitidasDireto: 0, entregues: 0, encaminhadas: 0, motivos: {} };

describe("FILA OFFLINE — o buffer do Baileys real retém messages.upsert", { timeout: 120_000 }, () => {
  test("BOOT: o buffer nasce ATIVO (logado); stanza offline SEM fim de fila é decifrada e fica RETIDA — upsert = 0", async () => {
    const t = await abrir();
    try {
      assert.equal(t.gw.bufferando(), true, "process.nextTick do socket: ev.buffer() quando creds.me existe");
      const d1 = await t.gw.criarPar(D(1));
      await t.gw.entregarSemFimOffline(await t.gw.mensagemDireta(d1, "a"));
      assert.equal(t.gw.upserts.length, 0, "nada chegou ao listener de messages.upsert");
      const m = mens(t.inbound, "direct_pn");
      assert.deepEqual([m.decryptTentado, m.decryptOk, m.decryptFalha, m.enfileiradas, m.entregues], [1, 1, 0, 1, 0], "decifrou, enfileirou, NÃO entregou");
      const f = t.inbound.estadoFila();
      assert.equal(f.bufferAtivo, true); assert.equal(f.mensagensRetidas, 1);
      assert.equal(f.offlineFimRecebido, 0); assert.equal(f.flushesEfetivos, 0);
    } finally { await t.fim(); }
  });

  test("CB:ib,,offline (fim da fila) → flush: as retidas são liberadas ao listener e receivedPendingNotifications sai", async () => {
    const t = await abrir();
    try {
      const d1 = await t.gw.criarPar(D(1));
      await t.gw.entregarSemFimOffline(await t.gw.mensagemDireta(d1, "a"));
      t.gw.emitirOfflineFim(1); await t.gw.espera(150);
      assert.equal(t.gw.upserts.length, 1);
      assert.equal(mens(t.inbound, "direct_pn").entregues, 1);
      const f = t.inbound.estadoFila();
      assert.equal(f.bufferAtivo, false); assert.equal(f.mensagensRetidas, 0);
      assert.equal(f.offlineFimRecebido, 1); assert.equal(f.offlineFimContagem, 1); assert.equal(f.receivedPendingNotifications, 1);
      assert.ok(f.flushesEfetivos >= 1);
    } finally { await t.fim(); }
  });

  test("ORDEM DE PRODUÇÃO (decrypt com I/O): o fim de offline chega ANTES do decrypt acabar ⇒ tudo decifrado depois fica RETIDO com a fila 'finalizada' (o gate)", async () => {
    const t = await abrir({ latenciaKeysMs: 8 });
    try {
      const d1 = await t.gw.criarPar(D(1)); const d2 = await t.gw.criarPar(D(2));
      const s = [await t.gw.mensagemDireta(d1, "a"), await t.gw.mensagemDireta(d2, "b"), await t.gw.mensagemGrupo(await t.gw.criarPar(P(1)), G1, "g")];
      for (const n of s) t.gw.sock.ws.emit("CB:message", n);     // o servidor despeja a fila offline…
      t.gw.emitirOfflineFim(s.length);                            // …e avisa o fim IMEDIATAMENTE (o Baileys ainda nem começou a decifrar)
      await t.gw.aguardarQuiescencia({ estavelMs: 400, maxMs: 8000 });
      assert.equal(t.gw.upserts.length, 0, "com o offline 'finalizado', nada foi entregue");
      const f = t.inbound.estadoFila();
      assert.equal(f.offlineFimRecebido, 1);
      assert.equal(f.bufferAtivo, true, "o buffer foi REARMADO por createBufferedFunction (upsertMessage) sem novo flush");
      assert.equal(f.mensagensRetidas, 3);
      assert.equal(mens(t.inbound, "direct_pn").enfileiradas, 2); assert.equal(mens(t.inbound, "group").enfileiradas, 1);
      assert.equal(mens(t.inbound, "direct_pn").entregues + mens(t.inbound, "group").entregues, 0);
      // Retidas não chegam ao backend
      assert.equal(mens(t.inbound, "direct_pn").encaminhadas, 0);
    } finally { await t.fim(); }
  });

  test("um nó VIVO (sem attrs.offline) faz flush (processNodeWithBuffer) e libera TUDO o que estava retido", async () => {
    const t = await abrir({ latenciaKeysMs: 8 });
    try {
      const d1 = await t.gw.criarPar(D(1));
      t.gw.sock.ws.emit("CB:message", await t.gw.mensagemDireta(d1, "a"));
      t.gw.emitirOfflineFim(1);
      await t.gw.aguardarQuiescencia({ estavelMs: 300, maxMs: 6000 });
      assert.equal(t.gw.upserts.length, 0); assert.equal(t.inbound.estadoFila().mensagensRetidas, 1);
      await t.gw.responderAoPar(d1);
      const viva = await t.gw.mensagemDireta(d1, "viva"); delete viva.attrs.offline;
      await t.gw.entregarSemFimOffline(viva);
      assert.equal(t.gw.upserts.length, 2, "a retida + a viva");
      const f = t.inbound.estadoFila();
      assert.equal(f.bufferAtivo, false); assert.equal(f.mensagensRetidas, 0);
      assert.equal(mens(t.inbound, "direct_pn").entregues, 2);
    } finally { await t.fim(); }
  });

  test("nós OFFLINE (attrs.offline) e VIVOS são contados separadamente — o vivo é o que faz flush no Baileys", async () => {
    const t = await abrir();
    try {
      const ws = t.gw.sock.ws;
      ws.emit("CB:receipt", { tag: "receipt", attrs: { from: D(1), id: "R1", offline: "1" } });
      ws.emit("CB:notification", { tag: "notification", attrs: { from: "@s.whatsapp.net", id: "N1", offline: "1" } });
      ws.emit("CB:receipt", { tag: "receipt", attrs: { from: D(1), id: "R2" } });
      await t.gw.espera(100);
      const f = t.inbound.estadoFila();
      assert.equal(f.nosOfflineVistos, 2); assert.equal(f.nosVivosVistos, 1);
    } finally { await t.fim(); }
  });

  test("offline_preview é contado; o Baileys responde ao preview (offline_batch) — só observamos", async () => {
    const t = await abrir();
    try {
      t.gw.emitirOfflinePreview(); await t.gw.espera(120); await t.gw.drenarEnviados();
      assert.equal(t.inbound.estadoFila().offlinePreviewRecebido, 1);
      assert.ok(t.gw.enviados.some((n) => n.tag === "ib" && Array.isArray(n.content) && n.content.some((c) => c.tag === "offline_batch")), "resposta do Baileys, intacta");
    } finally { await t.fim(); }
  });

  test("com history-sync desligado (padrão do Gateway) o Baileys faz flush(0) após o fim do offline — não há timer de 20 s", async () => {
    const t = await abrir();
    try {
      t.gw.emitirOfflineFim(0); await t.gw.espera(150);
      const f = t.inbound.estadoFila();
      assert.equal(f.receivedPendingNotifications, 1);
      assert.ok(f.bufferChamadasExternas >= 1, "chats.js chamou ev.buffer() (AwaitingInitialSync)");
      assert.equal(f.bufferAtivo, false, "…e já liberou (setTimeout 0), sem esperar 20 s");
    } finally { await t.fim(); }
  });

  test("os wrappers de ev são transparentes: mesmos retornos (flush→boolean, isBuffering) e nada quando o diagnóstico está DESLIGADO", async () => {
    const off = await abrir({ diag: false });
    try {
      for (const n of ["emit", "buffer", "flush"]) assert.ok(!/Observado$/.test(off.gw.sock.ev[n].name), `diag desligado: ev.${n} intacto`);
    } finally { await off.fim(); }
    const on = await abrir();
    try {
      assert.equal(on.gw.sock.ev.isBuffering(), true);
      assert.strictEqual(on.gw.sock.ev.flush(), true, "flush que liberou ⇒ true (retorno preservado)");
      assert.strictEqual(on.gw.sock.ev.flush(), false, "flush sem buffer ⇒ false");
      assert.equal(on.gw.sock.ev.isBuffering(), false);
      assert.equal(on.inbound.estadoFila().flushes, 2); assert.equal(on.inbound.estadoFila().flushesEfetivos, 1);
      const antes = on.inbound.estadoFila().bufferChamadasExternas;
      on.gw.sock.ev.buffer();
      assert.equal(on.gw.sock.ev.isBuffering(), true, "ev.buffer() envolvido AINDA arma o buffer do Baileys");
      assert.equal(on.inbound.estadoFila().bufferChamadasExternas, antes + 1);
    } finally { await on.fim(); }
  });
});

describe("ATRIBUIÇÃO REAL de decrypt por tipo de JID (Baileys + libsignal reais)", { timeout: 180_000 }, () => {
  test("direct_pn, direct_lid_other, direct_lid_self, group e status — ok e falha, contados no tipo certo, sem identificadores", async () => {
    const t = await abrir();
    try {
      const lote = [];
      const pn = await t.gw.criarPar(D(1)); lote.push(await t.gw.mensagemDireta(pn, "pn"));
      const pnRuim = await t.gw.mensagemDireta(await t.gw.criarPar(D(2)), "pn-ruim", { adulterar: true }); lote.push(pnRuim);
      lote.push(await t.gw.mensagemDireta(await t.gw.criarPar(LID_OUTRO(2)), "lid-outro"));
      lote.push(await t.gw.mensagemDireta(await t.gw.criarPar(LID_OUTRO(3)), "lid-outro-ruim", { adulterar: true }));
      lote.push(await t.gw.mensagemDireta(await t.gw.criarPar(LID_PROPRIO_OUTRO_APARELHO), "lid-self"));
      lote.push(await t.gw.mensagemGrupo(await t.gw.criarPar(P(1)), G1, "grupo"));
      lote.push(await t.gw.mensagemGrupo(await t.gw.criarPar(P(2)), G1, "grupo-ruim", { adulterar: true }));
      lote.push(await t.gw.mensagemGrupo(await t.gw.criarPar(P(3)), "status@broadcast", "status"));
      for (const s of lote) { if (s.attrs.id === pnRuim.attrs.id) t.gw.marcarSegundaEntrega(s); }
      for (const s of lote) await t.gw.receberStanza(s);
      await t.gw.aguardarQuiescencia({ estavelMs: 400, maxMs: 8000 });
      t.inbound.emitirResumo();

      const c = (tipo) => { const m = mens(t.inbound, tipo); return [m.decryptTentado, m.decryptOk, m.decryptFalha]; };
      assert.deepEqual(c("direct_pn"), [2, 1, 1]);
      assert.deepEqual(c("direct_lid_other"), [2, 1, 1]);
      assert.deepEqual(c("direct_lid_self"), [1, 1, 0], "mensagem do próprio usuário LID (outro dispositivo) é direct_lid_self");
      assert.deepEqual(c("group"), [2, 1, 1]);
      assert.deepEqual(c("status"), [1, 1, 0]);
      assert.equal(t.inbound.snapshot().mensagens.direct_lid, undefined, "a categoria antiga não existe mais");
      const resumo = t.eventos.find((x) => x.e === "inbound.contadores").d;
      for (const x of resumo.tipos) assert.ok(TIPOS_JID.includes(x.tipo), x.tipo);
      assert.ok(!VAZAMENTO.test(JSON.stringify(t.eventos)), JSON.stringify(t.eventos));
    } finally { await t.fim(); }
  });

  test("os motivos de falha vêm do stub REAL do Baileys, em vocabulário fechado (Bad MAC de sessão e de sender-key)", async () => {
    const t = await abrir();
    try {
      const d1 = await t.gw.criarPar(D(1)); await t.gw.receberStanza(await t.gw.mensagemDireta(d1, "a")); await t.gw.responderAoPar(d1);
      const ruim = await t.gw.mensagemDireta(d1, "x", { adulterar: true }); t.gw.marcarSegundaEntrega(ruim);
      await t.gw.receberStanza(ruim);
      const p1 = await t.gw.criarPar(P(1)); await t.gw.receberStanza(await t.gw.mensagemGrupo(p1, G1, "a")); await t.gw.responderAoPar(p1);
      const rg = await t.gw.mensagemGrupo(p1, G1, "y", { adulterar: true }); t.gw.marcarSegundaEntrega(rg);
      await t.gw.receberStanza(rg);
      await t.gw.aguardarQuiescencia({ estavelMs: 400, maxMs: 8000 });
      const vocab = ["bad_mac", "sem_sessao_compativel", "sem_sessao", "sem_conteudo", "chave_ja_usada", "prekey_invalida", "sender_key", "outro"];
      for (const tipo of ["direct_pn", "group"]) {
        const m = mens(t.inbound, tipo);
        assert.equal(m.decryptFalha, 1, tipo);
        const motivos = Object.keys(m.motivos);
        assert.equal(motivos.length, 1); assert.ok(vocab.includes(motivos[0]), motivos[0]);
        assert.equal(Object.values(m.motivos)[0], 1);
      }
      assert.ok(t.inbound.snapshot().badMacLinhas >= 1, "a linha Bad MAC da libsignal continua contada (global)");
    } finally { await t.fim(); }
  });
});

describe("RETRY receipts — pré-chave contada pela regra REAL do Baileys (retryCount > 1 || sem <enc>)", { timeout: 120_000 }, () => {
  test("retryTotal = comPreChave + semPreChave e cada categoria confere com o que FOI enviado (nós com <keys>)", async () => {
    const t = await abrir({ opcoesBaileys: SEM_ESPERA_PLACEHOLDER });
    try {
      // (a) direto com <enc> que falha: 1º retry ⇒ SEM pré-chave
      const d1 = await t.gw.criarPar(D(1)); await t.gw.receberStanza(await t.gw.mensagemDireta(d1, "a")); await t.gw.responderAoPar(d1);
      const a = await t.gw.mensagemDireta(d1, "a-ruim", { adulterar: true });
      await t.gw.receberStanza(a);
      await t.gw.aguardarQuiescencia({ estavelMs: 400, maxMs: 6000 });
      // (b) a MESMA falha de novo na mesma conexão ⇒ 2º retry ⇒ COM pré-chave
      t.gw.sock.ws.emit("CB:message", a); await t.gw.aguardarQuiescencia({ estavelMs: 400, maxMs: 6000 });
      // (c) stanza SEM <enc> (nem <unavailable>): forceIncludeKeys ⇒ COM pré-chave já no 1º retry
      const semEnc = t.gw.stanzaEnc({ from: D(3) }, []);
      t.gw.sock.ws.emit("CB:message", semEnc); await t.gw.aguardarQuiescencia({ estavelMs: 400, maxMs: 6000 });
      // (d) grupo com falha no 1º retry ⇒ SEM pré-chave
      const p1 = await t.gw.criarPar(P(1)); await t.gw.receberStanza(await t.gw.mensagemGrupo(p1, G1, "g")); await t.gw.responderAoPar(p1);
      await t.gw.receberStanza(await t.gw.mensagemGrupo(p1, G1, "g2", { adulterar: true }));
      await t.gw.aguardarQuiescencia({ estavelMs: 400, maxMs: 6000 });
      await t.gw.drenarEnviados();

      // verdade-terreno: os recibos de retry realmente enviados, classificados pelo destino, com/sem <keys>
      const real = {};
      for (const n of t.gw.enviados.filter((x) => x.tag === "receipt" && x.attrs.type === "retry")) {
        const tipo = classificarJid(n.attrs.to); const temKeys = Array.isArray(n.content) && n.content.some((c) => c.tag === "keys");
        const r = (real[tipo] ??= { total: 0, comPreChave: 0, semPreChave: 0 }); r.total++; if (temKeys) r.comPreChave++; else r.semPreChave++;
      }
      const contado = t.inbound.snapshot().retries;
      assert.deepEqual(contado, real, `contado=${JSON.stringify(contado)} real=${JSON.stringify(real)}`);
      assert.deepEqual(real.direct_pn, { total: 3, comPreChave: 2, semPreChave: 1 }, "(a) sem, (b) com, (c) com");
      assert.deepEqual(real.group, { total: 1, comPreChave: 0, semPreChave: 1 }, "(d) sem");
      for (const r of Object.values(contado)) assert.equal(r.total, r.comPreChave + r.semPreChave);
    } finally { await t.fim(); }
  });
});

describe("identidade só em memória (direct_lid_self × direct_lid_other)", () => {
  test("classificarJid compara ao usuário da identidade autenticada; sem identidade ⇒ other; nada é exposto", () => {
    const id = identidadeDe({ id: "5511999990000:1@s.whatsapp.net", lid: MEU_LID });
    assert.equal(classificarJid("100000000000001@lid", id), "direct_lid_self");
    assert.equal(classificarJid(LID_PROPRIO_OUTRO_APARELHO, id), "direct_lid_self");
    assert.equal(classificarJid(LID_OUTRO(2), id), "direct_lid_other");
    assert.equal(classificarJid("100000000000001@lid", undefined), "direct_lid_other");
    assert.equal(classificarJid("100000000000001@lid", identidadeDe(undefined)), "direct_lid_other");
    assert.equal(classificarJid("100000000000001@lid", identidadeDe({ id: "x", lid: 42 })), "direct_lid_other");
    assert.equal(classificarJid("5511999990000@s.whatsapp.net", id), "direct_pn", "PN nunca vira LID");
    assert.equal(classificarJid("120363000000000001@g.us", id), "group");
  });
  test("o resultado da classificação é só o NOME do tipo (nunca contém a identidade)", () => {
    const id = identidadeDe({ id: "5511999990000:1@s.whatsapp.net", lid: MEU_LID });
    for (const j of ["100000000000001@lid", LID_OUTRO(2), "5511999990000@s.whatsapp.net", G1]) assert.ok(TIPOS_JID.includes(classificarJid(j, id)));
  });
});

describe("canário — contrato do Baileys 6.7.24 do qual a hipótese da fila offline depende", () => {
  const raiz = dirname(createRequire(import.meta.url).resolve("baileys/package.json"));
  const ler = (...p) => readFileSync(join(raiz, "lib", ...p), "utf8");
  test("socket.js: buffer no boot quando logado; CB:ib,,offline faz flush; nada mais libera além dos gatilhos conhecidos", () => {
    const s = ler("Socket", "socket.js");
    assert.ok(/process\.nextTick\(\(\) => \{\s*if \(creds\.me\?\.id\) \{[\s\S]{0,120}ev\.buffer\(\);/.test(s));
    assert.ok(/ws\.on\('CB:ib,,offline', \(node\) => \{[\s\S]{0,300}ev\.flush\(\);[\s\S]{0,200}receivedPendingNotifications: true/.test(s));
  });
  test("event-buffer: createBufferedFunction só chama buffer() e NUNCA flush (o fim é 'controlado centralmente')", () => {
    const e = ler("Utils", "event-buffer.js");
    const i = e.indexOf("createBufferedFunction(work)");
    const corpo = e.slice(i, i + 400);
    assert.ok(/buffer\(\);/.test(corpo) && !/flush\(/.test(corpo.replace("controlled centrally", "")));
  });
  test("messages-recv: nó VIVO usa processNodeWithBuffer (buffer→flush); nó OFFLINE vai para a fila serial sem flush", () => {
    const m = ler("Socket", "messages-recv.js");
    assert.ok(/const processNodeWithBuffer = async[\s\S]{0,120}ev\.buffer\(\);[\s\S]{0,120}ev\.flush\(\);/.test(m));
    assert.ok(/if \(isOffline\) \{\s*offlineNodeProcessor\.enqueue\(type, node\);/.test(m));
    assert.ok(/await upsertMessage\(msg, node\.attrs\.offline \? 'append' : 'notify'\)/.test(m));
  });
  test("chats.js: com history-sync desligado o estado vai a Online com setTimeout(flush, 0); Socket/index.js deriva isso de syncFullHistory", () => {
    const c = ler("Socket", "chats.js");
    assert.ok(/setTimeout\(\(\) => ev\.flush\(\), 0\)/.test(c));
    assert.ok(/shouldSyncHistoryMessage = \(\) => !!newConfig\.syncFullHistory/.test(ler("Socket", "index.js")));
    assert.ok(/syncFullHistory: false/.test(ler("Defaults", "index.js")));
  });
  test("o stub de falha CIPHERTEXT também passa por upsertMessage (exceto 'Key used already or never filled' ⇒ só NACK)", () => {
    const m = ler("Socket", "messages-recv.js");
    assert.ok(/MISSING_KEYS_ERROR_TEXT\)\s*\{\s*return sendMessageAck\(node, NACK_REASONS\.ParsingError\);/.test(m));
  });
});
