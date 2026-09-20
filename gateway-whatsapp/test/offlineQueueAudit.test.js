// C.9.5 — AUDITORIA + REPRODUÇÃO LOCAL da fila offline do Baileys 6.7.24 instalado.
// Tudo com o pipeline REAL (socket Baileys → servidor WebSocket LOCAL, criptografia libsignal real, pares fictícios; nenhuma
// rede externa, nenhuma sessão/auth/telefone reais). O "servidor" é um MODELO (test-support/servidorOfflineFalso.js): o que
// estes testes provam é o comportamento do CLIENTE diante dele — NUNCA o do servidor real do WhatsApp (desconhecido).
//
// Parte 1 — canários: fatos do código instalado (arquivo:função) que sustentam o projeto do failsafe.
// Parte 2 — cenários locais: L1 fluxo normal, L2 marcador nunca chega, L3 segundo batch (experimento), L4 offline="0".
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { criarGatewayFalso, capturarConsole } from "../test-support/inboundHarness.js";
import { criarServidorOfflineFalso, gerarMensagensOffline } from "../test-support/servidorOfflineFalso.js";
import { criarInboundGateway } from "../src/inboundScope.js";

const raiz = dirname(createRequire(import.meta.url).resolve("baileys/package.json"));
const lib = (...p) => readFileSync(join(raiz, "lib", ...p), "utf8");
const fatia = (src, ini, fim) => { const i = src.indexOf(ini); assert.ok(i >= 0, `não achei: ${ini}`); const j = fim ? src.indexOf(fim, i + ini.length) : src.length; return src.slice(i, j < 0 ? src.length : j); };
const D = (n) => `55118888${String(n).padStart(5, "0")}@s.whatsapp.net`;

async function abrir({ latenciaKeysMs = 0, opcoesBaileys = {} } = {}) {
  const cap = capturarConsole();
  const inbound = criarInboundGateway({ diagHabilitado: true, emitir() {}, agendar: () => ({ unref() {} }), consoleAlvo: console });
  const gw = await criarGatewayFalso({ inbound, latenciaKeysMs, opcoesBaileys });
  return { gw, inbound, fim: async () => { inbound.parar(); cap.restaurar(); await gw.encerrar(); } };
}

describe("PARTE 1 — canários do código instalado (Baileys 6.7.24)", () => {
  const socket = lib("Socket", "socket.js");
  const chats = lib("Socket", "chats.js");
  const recv = lib("Socket", "messages-recv.js");
  const buffer = lib("Utils", "event-buffer.js");

  test("versão instalada = 6.7.24", () => assert.equal(JSON.parse(readFileSync(join(raiz, "package.json"), "utf8")).version, "6.7.24"));

  test("offline_batch: UM ÚNICO ponto de envio no código (socket.js, handler de offline_preview), count fixo '100', sem laço nem contador de página", () => {
    const enviadores = readdirSync(join(raiz, "lib", "Socket")).filter((f) => f.endsWith(".js") && lib("Socket", f).includes("offline_batch"));
    assert.deepEqual(enviadores, ["socket.js"]);
    assert.equal((socket.match(/offline_batch/g) ?? []).length, 1, "uma só ocorrência");
    const h = fatia(socket, "ws.on('CB:ib,,offline_preview'", "ws.on('CB:ib,,edge_routing'");
    assert.ok(/count: '100'/.test(h), "count literal '100'");
    assert.ok(!/\b(while|for|setTimeout|setInterval|retry|page|pagina|offset|cursor)\b/i.test(h), "sem laço, timer, contador de página ou condição para novo lote");
    assert.ok(/logger\.info\('offline preview received', JSON\.stringify\(node\)\)/.test(h), "o único log do preview usa o logger do Baileys (silencioso no Gateway)");
  });

  test("CB:ib,,offline: flush só se didStartBuffer; depois emite receivedPendingNotifications=true; sem timer/fallback no handler", () => {
    const h = fatia(socket, "ws.on('CB:ib,,offline', (node)", "// update credentials when required");
    assert.ok(/if \(didStartBuffer\) \{\s*ev\.flush\(\);/.test(h));
    assert.ok(/ev\.emit\('connection\.update', \{ receivedPendingNotifications: true \}\)/.test(h));
    assert.ok(!/setTimeout|setInterval/.test(h));
  });

  test("NÃO existe timeout nem fallback para a AUSÊNCIA do marcador: os únicos timers de socket.js são keep-alive e QR", () => {
    const timers = [...socket.matchAll(/(setTimeout|setInterval)\(/g)].length;
    assert.equal(timers, 2, "startKeepAliveRequest (setInterval) e qrTimer (setTimeout)");
    // o único timer de sincronização (20 s) só é armado DEPOIS de receivedPendingNotifications=true e com history-sync habilitado
    const h = fatia(chats, "ev.on('connection.update', ({ connection, receivedPendingNotifications })", "return {\n        ...sock");
    const iGuarda = h.indexOf("if (!receivedPendingNotifications || syncState !== SyncState.Connecting)");
    const iTimer = h.indexOf("awaitingSyncTimeout = setTimeout(");
    assert.ok(iGuarda > 0 && iTimer > iGuarda, "o timer de 20 s vem depois da guarda que exige receivedPendingNotifications");
    assert.ok(/setTimeout\(\(\) => ev\.flush\(\), 0\)/.test(h), "history-sync desligado ⇒ flush(0) logo após o marcador");
  });

  test("quem chama ev.flush() no Baileys: marcador (socket.js), processNodeWithBuffer (nó VIVO) e a máquina de history-sync (chats.js) — nada mais", () => {
    const chamadas = [];
    for (const f of ["socket.js", "chats.js", "messages-recv.js", "groups.js", "communities.js", "newsletter.js", "messages-send.js", "business.js", "mex.js"]) {
      try { for (const m of lib("Socket", f).matchAll(/ev\.flush\(\)/g)) chamadas.push(`${f}@${m.index}`); } catch { /* arquivo inexistente nesta versão */ }
    }
    const porArquivo = chamadas.reduce((a, c) => { const f = c.split("@")[0]; a[f] = (a[f] ?? 0) + 1; return a; }, {});
    assert.deepEqual(porArquivo, { "socket.js": 1, "chats.js": 4, "messages-recv.js": 1 });
    assert.ok(/const processNodeWithBuffer = async[\s\S]{0,140}ev\.buffer\(\);[\s\S]{0,140}ev\.flush\(\);/.test(recv));
  });

  test("attrs.offline é lido SEMPRE por conversão truthy/falsy (nunca comparado a '1'): a string \"0\" conta como OFFLINE", () => {
    assert.ok(/const isOffline = !!node\.attrs\.offline;/.test(recv), "processNode");
    assert.ok(/upsertMessage\(msg, node\.attrs\.offline \? 'append' : 'notify'\)/.test(recv), "handleMessage");
    assert.equal((recv.match(/offline: !!attrs\.offline/g) ?? []).length, 2, "handleCall");
    assert.ok(!/offline\s*={2,3}\s*['"0-9]/.test(recv) && !/['"0-9]\s*={2,3}\s*[\w.]*offline/.test(recv), "nenhuma comparação explícita com valor");
    assert.ok(/attrs\[key\] = value;/.test(lib("WABinary", "decode.js")), "o decoder entrega valores de atributo como string");
  });

  test("o buffer é POR SOCKET (makeEventBuffer dentro de makeSocket); end() NÃO faz flush — o que estava retido morre com o socket", () => {
    assert.ok(/const ev = makeEventBuffer\(logger\);/.test(socket));
    const fim = fatia(socket, "const end = (error) =>", "const waitForSocketOpen");
    assert.ok(!/flush/.test(fim), "end() não libera o buffer");
    assert.ok(/ev\.removeAllListeners\('connection\.update'\)/.test(fim));
  });

  test("o `type` de um messages.upsert consolidado no flush é o do PRIMEIRO upsert do buffer (não é por mensagem)", () => {
    assert.ok(/const type = messageUpsertList\[0\]\.type;/.test(buffer));
  });

  test("a mensagem decifrada com sucesso recebe o RECIBO DE ENTREGA ANTES de entrar no buffer (upsertMessage) — retida ≠ não confirmada", () => {
    const h = fatia(recv, "// no type in the receipt => message delivered", "const fetchMessageHistory");
    const iRecibo = h.indexOf("await sendReceipt(msg.key.remoteJid, participant, [msg.key.id], type);");
    const iUpsert = h.indexOf("await upsertMessage(msg,");
    assert.ok(iRecibo >= 0 && iUpsert > iRecibo, "sendReceipt precede upsertMessage");
    const falha = fatia(recv, "if (msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT) {", "// no type in the receipt");
    assert.ok(/sendRetryRequest\(node, !encNode\)/.test(falha) && !/sendReceipt\(/.test(falha), "na FALHA só sai o retry receipt — nenhum recibo de entrega");
  });

  test("createBufferedFunction só chama buffer() (nunca flush) — cada upsertMessage REARMA o buffer", () => {
    const h = fatia(buffer, "createBufferedFunction(work) {", "on: (...args)");
    assert.ok(/buffer\(\);/.test(h) && !/flush\(\)/.test(h));
    assert.ok(/const upsertMessage = ev\.createBufferedFunction\(/.test(chats));
  });
});

describe("PARTE 2 / L1 — fluxo NORMAL: preview → batch → N nós → marcador → flush", { timeout: 120_000 }, () => {
  test("o Baileys responde ao preview com offline_batch count=100 NO FIO; nós entram no buffer; o marcador libera tudo", async () => {
    const t = await abrir();
    try {
      const nos = await gerarMensagensOffline(t.gw, 60);
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "fim_ao_esgotar" });
      srv.iniciar();
      assert.equal(await srv.aguardarBatches(1, 3000), true, "o cliente enviou offline_batch sozinho");
      assert.equal(srv.estado.batches.length, 1);
      assert.equal(srv.estado.batches[0].count, 100, "count=100 OBSERVADO no fio (do cliente real, localmente)");
      await t.gw.aguardarQuiescencia({ estavelMs: 600, maxMs: 15_000 });
      assert.equal(t.gw.upserts.length, 60, "todas entregues ao listener");
      const f = t.inbound.estadoFila();
      assert.equal(f.offlineFimRecebido, 1); assert.equal(f.offlineFimContagem, 60); assert.equal(f.receivedPendingNotifications, 1);
      assert.equal(f.bufferAtivo, false); assert.equal(f.mensagensRetidas, 0); assert.ok(f.flushesEfetivos >= 1);
      assert.ok(t.gw.upsertsTipos.every((u) => u.tipo === "append"), "nós offline ⇒ type 'append'");
    } finally { await t.fim(); }
  });

  test("L1b — o marcador NÃO garante liberação: com I/O no decrypt, o que termina DEPOIS do flush do marcador fica retido (buffer rearmado)", async () => {
    const t = await abrir({ latenciaKeysMs: 8 });
    try {
      const nos = await gerarMensagensOffline(t.gw, 30);
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "fim_ao_esgotar" });
      srv.iniciar();
      await srv.aguardarBatches(1, 3000);
      await t.gw.aguardarQuiescencia({ estavelMs: 800, maxMs: 20_000 });
      const f = t.inbound.estadoFila();
      assert.equal(f.offlineFimRecebido, 1, "o marcador CHEGOU");
      assert.equal(f.bufferAtivo, true, "e mesmo assim o buffer está ativo");
      assert.ok(f.mensagensRetidas > 0, `retidas após o marcador: ${f.mensagensRetidas}`);
      assert.ok(t.gw.upserts.length < 30);
    } finally { await t.fim(); }
  });
});

describe("PARTE 2 / L2 — marcador NUNCA chega (modelo do que se viu em produção)", { timeout: 180_000 }, () => {
  async function rodarEstagnado(opcoesBaileys) {
    const t = await abrir({ opcoesBaileys });
    const nos = await gerarMensagensOffline(t.gw, 130);
    const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "nunca_envia_fim" });
    srv.iniciar();
    await srv.aguardarBatches(1, 3000);
    await t.gw.aguardarQuiescencia({ estavelMs: 800, maxMs: 20_000 });
    return { t, srv };
  }

  test("REPRODUÇÃO LOCAL CONFIRMADA: 100 nós ⇒ 100 retidas, buffer ativo, zero flush, zero upsert — e continua assim depois de 22 s (com e sem history-sync)", async () => {
    const [a, b] = await Promise.all([rodarEstagnado({}), rodarEstagnado({ shouldSyncHistoryMessage: () => true })]);
    try {
      for (const { t, srv } of [a, b]) {
        assert.equal(srv.estado.nosEntregues, 100); assert.equal(srv.restante(), 30, "o servidor ainda tem 30 que ninguém pediu");
        assert.equal(srv.estado.batches.length, 1, "um único offline_batch");
        const f = t.inbound.estadoFila();
        assert.equal(f.nosOfflineVistos, 100); assert.equal(f.mensagensRetidas, 100); assert.equal(f.bufferAtivo, true);
        assert.equal(f.offlineFimRecebido, 0); assert.equal(f.flushes, 0); assert.equal(f.receivedPendingNotifications, 0);
        assert.equal(t.gw.upserts.length, 0);
      }
      await a.t.gw.espera(22_000);            // passa da janela de 20 s do único timer de sincronização do Baileys
      for (const { t, srv } of [a, b]) {
        assert.equal(srv.estado.batches.length, 1, "o cliente NUNCA pede um segundo lote sozinho");
        assert.equal(t.gw.bufferando(), true, "buffer segue ativo");
        assert.equal(t.gw.upserts.length, 0, "messages.upsert segue bloqueado");
        const f = t.inbound.estadoFila();
        assert.equal(f.flushes, 0); assert.equal(f.mensagensRetidas, 100); assert.equal(f.offlineFimRecebido, 0);
      }
    } finally { await a.t.fim(); await b.t.fim(); }
  });

  test("um nó VIVO ainda libera o buffer (o único desbloqueio nativo sem o marcador) — as retidas saem, com type do 1º upsert", async () => {
    const { t } = await rodarEstagnado({});
    try {
      const par = await t.gw.criarPar(D(999));
      const viva = await t.gw.mensagemDireta(par, "viva"); delete viva.attrs.offline;
      await t.gw.entregarSemFimOffline(viva);
      assert.equal(t.gw.upserts.length, 101);
      assert.equal(t.gw.bufferando(), false);
      assert.equal(t.gw.upsertsTipos.length, 1, "UM evento consolidado");
      assert.equal(t.gw.upsertsTipos[0].n, 101);
      assert.equal(t.gw.upsertsTipos[0].tipo, "append", "a mensagem VIVA (notify) saiu rotulada 'append': o type é do 1º upsert do buffer");
    } finally { await t.fim(); }
  });
});

describe("PARTE 2 / L3 — SEGUNDO BATCH (experimento local; NÃO é comportamento do Baileys nem de produção)", { timeout: 180_000 }, () => {
  test("Baileys sem alteração NÃO pede o 2º lote; com um 2º/3º offline_batch enviados PELO TESTE, o modelo entrega o restante, o marcador aparece e o flush ocorre", async () => {
    const t = await abrir();
    try {
      const nos = await gerarMensagensOffline(t.gw, 250);
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "fim_ao_esgotar" });
      srv.iniciar();
      await srv.aguardarBatches(1, 3000);
      await t.gw.aguardarQuiescencia({ estavelMs: 800, maxMs: 30_000 });
      // 1) Baileys SEM alteração
      assert.equal(await srv.aguardarBatches(2, 3000), false, "o cliente NÃO enviou um segundo offline_batch em 3 s");
      assert.equal(srv.estado.batches.length, 1);
      let f = t.inbound.estadoFila();
      assert.deepEqual([f.nosOfflineVistos, f.mensagensRetidas, f.offlineFimRecebido, f.flushes, t.gw.upserts.length], [100, 100, 0, 0, 0], "estagnado no 1º lote");
      assert.equal(srv.restante(), 150);
      // 2) EXPERIMENTO (só neste teste): o teste envia o 2º batch pelo socket real
      const batch = { tag: "ib", attrs: {}, content: [{ tag: "offline_batch", attrs: { count: "100" } }] };
      await t.gw.sock.sendNode(batch);
      assert.equal(await srv.aguardarBatches(2, 3000), true);
      await t.gw.aguardarQuiescencia({ estavelMs: 800, maxMs: 30_000 });
      f = t.inbound.estadoFila();
      assert.deepEqual([f.nosOfflineVistos, f.mensagensRetidas, f.offlineFimRecebido, f.flushes, t.gw.upserts.length], [200, 200, 0, 0, 0], "2º lote entregue; ainda sem marcador");
      await t.gw.sock.sendNode(batch);
      assert.equal(await srv.aguardarBatches(3, 3000), true);
      await t.gw.aguardarQuiescencia({ estavelMs: 800, maxMs: 30_000 });
      f = t.inbound.estadoFila();
      assert.equal(srv.restante(), 0); assert.equal(srv.estado.fimEnviado, true);
      assert.equal(f.offlineFimRecebido, 1, "o marcador finalmente apareceu (no MODELO)");
      assert.equal(f.nosOfflineVistos, 250); assert.equal(f.bufferAtivo, false); assert.equal(f.mensagensRetidas, 0);
      assert.ok(f.flushesEfetivos >= 1);
      assert.equal(t.gw.upserts.length, 250, "todas as 250 liberadas");
      assert.deepEqual(srv.estado.batches.map((b) => b.count), [100, 100, 100]);
    } finally { await t.fim(); }
  });
});

describe("PARTE 2 / L4 — attrs.offline: \"0\" entra na trilha OFFLINE (conversão truthy do Baileys)", { timeout: 120_000 }, () => {
  async function comAtributo(valor, tipoNo) {
    const t = await abrir();
    try {
      const par = await t.gw.criarPar(D(1));
      if (tipoNo === "message") {
        const no = await t.gw.mensagemDireta(par, "x");
        if (valor === undefined) delete no.attrs.offline; else no.attrs.offline = valor;
        await t.gw.entregarSemFimOffline(no);
      } else {
        const rec = { tag: "receipt", attrs: { from: D(1), id: "RCPT1", t: "1700000000", type: "read" }, content: undefined };
        if (valor !== undefined) rec.attrs.offline = valor;
        t.gw.sock.ws.emit("CB:receipt", rec);
        await t.gw.aguardarQuiescencia({ estavelMs: 400, maxMs: 8000 });
      }
      const f = t.inbound.estadoFila();
      return { flushes: f.flushes, nosOffline: f.nosOfflineVistos, nosVivos: f.nosVivosVistos, upserts: t.gw.upserts.length, tipos: t.gw.upsertsTipos.map((u) => u.tipo), bufferAtivo: f.bufferAtivo };
    } finally { await t.fim(); }
  }

  test("mensagem: \"1\" e \"0\" → trilha offline (type 'append', sem flush, retida); \"\" e ausente → trilha viva (flush, type 'notify')", async () => {
    const r = {};
    for (const v of ["1", "0", "", undefined]) r[String(v)] = await comAtributo(v, "message");
    assert.deepEqual(r["1"], { flushes: 0, nosOffline: 1, nosVivos: 0, upserts: 0, tipos: [], bufferAtivo: true });
    assert.deepEqual(r["0"], r["1"], "\"0\" se comporta EXATAMENTE como \"1\": string não vazia = truthy = offline");
    assert.equal(r[""].nosVivos, 1); assert.equal(r["undefined"].nosVivos, 1);
    for (const v of ["", "undefined"]) { assert.ok(r[v].flushes >= 1); assert.equal(r[v].upserts, 1); assert.deepEqual(r[v].tipos, ["notify"]); assert.equal(r[v].bufferAtivo, false); }
  });

  test("recibo: \"0\" também é enfileirado como offline (não faz o buffer/flush do nó vivo); \"\" e ausente fazem", async () => {
    const r = {};
    for (const v of ["1", "0", "", undefined]) r[String(v)] = await comAtributo(v, "receipt");
    assert.equal(r["1"].flushes, 0); assert.equal(r["0"].flushes, 0);
    assert.ok(r[""].flushes >= 1); assert.ok(r["undefined"].flushes >= 1);
    assert.equal(r["0"].nosOffline, 1); assert.equal(r[""].nosVivos, 1);
  });
});
