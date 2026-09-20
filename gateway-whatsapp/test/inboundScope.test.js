// C.9.3 / C.9.3-R — classificação de JID, política de escopo, contadores sanitizados e a cola de produção
// (unitário, sem rede).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { proto } from "baileys";
import {
  classificarJid, classificarMotivoFalha, interpretarEscopo, criarPoliticaInbound, criarContadoresInbound, criarInboundGateway,
  ESCOPO_ALL_SUPPORTED, ESCOPO_DIRECT_ONLY, TIPOS_NAO_SUPORTADOS_V1, TIPOS_JID,
} from "../src/inboundScope.js";

const CIPHERTEXT = proto.WebMessageInfo.StubType.CIPHERTEXT;
const sem = (o) => JSON.stringify(o);
const VAZAMENTO = /5511|1000000000|whatsapp\.net|120363|@lid|@g\.us|TESTMSG|ID-SECRETO|@newsletter|@broadcast/;

describe("classificarJid — helpers oficiais do Baileys 6.7.24", () => {
  const tabela = [
    ["5511888880001@s.whatsapp.net", "direct_pn"],
    ["5511888880001:12@s.whatsapp.net", "direct_pn"],      // dispositivo
    ["100000000000001@lid", "direct_lid_other"],            // LID (chat direto) sem identidade conhecida ⇒ other
    ["100000000000001:3@lid", "direct_lid_other"],
    ["120363000000000001@g.us", "group"],
    ["status@broadcast", "status"],                         // antes de @broadcast genérico
    ["5511999990000@broadcast", "broadcast"],
    ["120363000000000009@newsletter", "newsletter"],
    ["1234@bot", "meta_ai"],
    ["13135550002@c.us", "meta_ai"],                        // META_AI_JID
    ["server@c.us", "technical"],
    ["0@c.us", "technical"],
    ["@s.whatsapp.net", "technical"],                       // o servidor (o Baileys nunca o ignora)
    ["algo@futuro.tipo", "unknown"],
    ["", "unknown"], [null, "unknown"], [undefined, "unknown"], [123, "unknown"], [{}, "unknown"],
  ];
  for (const [jid, esperado] of tabela) {
    test(`${JSON.stringify(jid)} → ${esperado}`, () => assert.equal(classificarJid(jid), esperado));
  }
  test("todo tipo devolvido pertence ao vocabulário fechado", () => {
    for (const [jid] of tabela) assert.ok(TIPOS_JID.includes(classificarJid(jid)));
    assert.deepEqual([...TIPOS_JID], ["direct_pn", "direct_lid_self", "direct_lid_other", "group", "status", "broadcast", "newsletter", "meta_ai", "technical", "unknown"]);
  });
});

describe("interpretarEscopo", () => {
  test("padrão = ALL_SUPPORTED (comportamento anterior) para vazio/ausente", () => {
    for (const v of [undefined, null, "", "   "]) assert.deepEqual(interpretarEscopo(v), { escopo: ESCOPO_ALL_SUPPORTED, valido: true });
  });
  test("valores explícitos", () => {
    assert.deepEqual(interpretarEscopo("DIRECT_ONLY"), { escopo: ESCOPO_DIRECT_ONLY, valido: true });
    assert.deepEqual(interpretarEscopo(" ALL_SUPPORTED "), { escopo: ESCOPO_ALL_SUPPORTED, valido: true });
  });
  test("valor inválido (inclusive booleano/minúsculas) cai no padrão e é SINALIZADO — nunca vira DIRECT_ONLY por engano", () => {
    for (const v of ["direct_only", "true", "1", "DIRECT", "ALL", "yes", "off"]) assert.deepEqual(interpretarEscopo(v), { escopo: ESCOPO_ALL_SUPPORTED, valido: false });
  });
});

describe("criarPoliticaInbound", () => {
  const todos = ["5511888880001@s.whatsapp.net", "100000000000001@lid", "120363000000000001@g.us", "status@broadcast", "5511999990000@broadcast", "120363000000000009@newsletter", "1234@bot", "13135550002@c.us", "server@c.us", "@s.whatsapp.net", "algo@futuro.tipo", undefined, null, ""];

  test("ALL_SUPPORTED nunca ignora nada (equivale ao default `() => false` do Baileys)", () => {
    const p = criarPoliticaInbound({ escopo: ESCOPO_ALL_SUPPORTED });
    for (const j of todos) assert.strictEqual(p.shouldIgnoreJid(j), false);
  });

  test("DIRECT_ONLY ignora EXATAMENTE group/status/broadcast/newsletter; todo o resto passa (fail-safe)", () => {
    const p = criarPoliticaInbound({ escopo: ESCOPO_DIRECT_ONLY });
    const ignorados = todos.filter((j) => p.shouldIgnoreJid(j));
    assert.deepEqual(ignorados, ["120363000000000001@g.us", "status@broadcast", "5511999990000@broadcast", "120363000000000009@newsletter"]);
    assert.deepEqual([...TIPOS_NAO_SUPORTADOS_V1].sort(), ["broadcast", "group", "newsletter", "status"]);
  });

  test("chat direto (PN e LID, com dispositivo) NUNCA é ignorado — consentimento/opt-out/Agente Crescer", () => {
    const p = criarPoliticaInbound({ escopo: ESCOPO_DIRECT_ONLY });
    for (const j of ["5511888880001@s.whatsapp.net", "5511888880001:7@s.whatsapp.net", "100000000000001@lid", "100000000000001:2@lid"]) assert.strictEqual(p.shouldIgnoreJid(j), false);
  });

  test("meta_ai/technical/unknown passam (fail-safe) e o predicado só CONTA o que foi ignorado", () => {
    const contadores = criarContadoresInbound();
    const p = criarPoliticaInbound({ escopo: ESCOPO_DIRECT_ONLY, contadores });
    for (const j of ["server@c.us", "@s.whatsapp.net", "1234@bot", "algo@futuro.tipo", undefined]) assert.strictEqual(p.shouldIgnoreJid(j), false);
    assert.deepEqual(contadores.snapshot().stanzas, {}, "nada foi ignorado ⇒ nada a contar aqui");
    p.shouldIgnoreJid("120363000000000001@g.us");
    assert.equal(contadores.snapshot().stanzas.group.ignoradas, 1);
  });

  test("devolve sempre boolean estrito e nunca lança, mesmo com lixo", () => {
    const p = criarPoliticaInbound({ escopo: ESCOPO_DIRECT_ONLY, contadores: { aoStanza() { throw new Error("contador quebrado"); } } });
    for (const j of [Symbol("x"), () => {}, { toString() { throw new Error("x"); } }, NaN, "\u0000", "a".repeat(10_000), "x@g.us"]) {
      let r; assert.doesNotThrow(() => { r = p.shouldIgnoreJid(j); });
      assert.strictEqual(typeof r, "boolean");
    }
  });
});

describe("contadores sanitizados", () => {
  test("classificarMotivoFalha usa vocabulário FECHADO e nunca devolve o texto do erro", () => {
    assert.equal(classificarMotivoFalha("No matching sessions found for message"), "sem_sessao_compativel");
    assert.equal(classificarMotivoFalha("Bad MAC"), "bad_mac");
    assert.equal(classificarMotivoFalha("Message absent from node"), "sem_conteudo");
    assert.equal(classificarMotivoFalha("erro com 5511999990000@s.whatsapp.net dentro"), "outro");
    assert.equal(classificarMotivoFalha(undefined), "outro");
  });

  test("mensagens por tipo: decryptTentado/Ok/Falha, motivo, enfileirada/direto; nada de JID/ID/texto no resultado", () => {
    const c = criarContadoresInbound();
    const msg = (jid, falha, txt) => ({ key: { remoteJid: jid, id: "ID-SECRETO-1" }, ...(falha ? { messageStubType: CIPHERTEXT, messageStubParameters: [txt] } : {}) });
    c.aoMensagemEmitida(msg("5511888880001@s.whatsapp.net", false), undefined, true);
    c.aoMensagemEmitida(msg("5511888880001@s.whatsapp.net", true, "No matching sessions found for message"), undefined, true);
    c.aoMensagemEmitida(msg("100000000000001@lid", false), undefined, false);
    c.aoMensagemEmitida(msg("120363000000000001@g.us", true, "algo com 5511999990000@s.whatsapp.net"), undefined, true);
    c.aoMensagemEmitida(msg("status@broadcast", false), undefined, false);
    const { mensagens } = c.snapshot();
    const fm = (tentado, falha) => ({ fromMe: { sim: { tentado: 0, falha: 0 }, nao: { tentado: 0, falha: 0 }, desconhecido: { tentado, falha } } });   // as mensagens do teste não trazem key.fromMe
    const base = { entregues: 0, encaminhadas: 0 };
    assert.deepEqual(mensagens.direct_pn, { decryptTentado: 2, decryptOk: 1, decryptFalha: 1, motivos: { sem_sessao_compativel: 1 }, enfileiradas: 2, emitidasDireto: 0, ...base, ...fm(2, 1) });
    assert.deepEqual(mensagens.direct_lid_other, { decryptTentado: 1, decryptOk: 1, decryptFalha: 0, motivos: {}, enfileiradas: 0, emitidasDireto: 1, ...base, ...fm(1, 0) });
    assert.deepEqual(mensagens.group, { decryptTentado: 1, decryptOk: 0, decryptFalha: 1, motivos: { outro: 1 }, enfileiradas: 1, emitidasDireto: 0, ...base, ...fm(1, 1) });
    assert.deepEqual(mensagens.status, { decryptTentado: 1, decryptOk: 1, decryptFalha: 0, motivos: {}, enfileiradas: 0, emitidasDireto: 1, ...base, ...fm(1, 0) });
    assert.ok(!VAZAMENTO.test(sem(c.snapshot())), sem(c.snapshot()));
  });

  test("retries: total, comPreChave e semPreChave por tipo (recebem só o TIPO, nunca o JID)", () => {
    const c = criarContadoresInbound();
    c.aoRetry("direct_pn", false);
    c.aoRetry("direct_pn", true);
    c.aoRetry("group", true);
    c.aoRetry("unknown", true);
    const { retries } = c.snapshot();
    assert.deepEqual(retries.direct_pn, { total: 2, comPreChave: 1, semPreChave: 1 });
    assert.deepEqual(retries.group, { total: 1, comPreChave: 1, semPreChave: 0 });
    assert.deepEqual(retries.unknown, { total: 1, comPreChave: 1, semPreChave: 0 });
    assert.ok(!VAZAMENTO.test(sem(c.snapshot())));
  });

  test("stanzas por espécie; haMudancas/marcarEmitido controlam o ruído", () => {
    const c = criarContadoresInbound();
    assert.equal(c.haMudancas(), false);
    c.aoStanza("direct_pn", false, "message"); c.aoStanza("direct_pn", false, "receipt"); c.aoStanza("group", true);
    assert.deepEqual(c.snapshot().stanzas.direct_pn, { message: 1, receipt: 1, notification: 0, ignoradas: 0 });
    assert.deepEqual(c.snapshot().stanzas.group, { message: 0, receipt: 0, notification: 0, ignoradas: 1 });
    assert.equal(c.haMudancas(), true);
    c.marcarEmitido();
    assert.equal(c.haMudancas(), false);
  });
});

describe("criarInboundGateway — cola de produção", () => {
  test("PADRÃO (ALL_SUPPORTED, sem diagnóstico): opcoesSocket() é {} e TODOS os ganchos são no-op", () => {
    const logger = { level: "silent", child() { return this; }, info() {} };
    const g = criarInboundGateway({ emitir() {} });
    assert.deepEqual(g.opcoesSocket(), {});
    assert.equal("shouldIgnoreJid" in g.opcoesSocket(), false, "NUNCA shouldIgnoreJid: undefined (o merge de defaults do Baileys o sobrescreveria)");
    assert.equal(g.escopo, ESCOPO_ALL_SUPPORTED);
    assert.equal(g.filtroAtivo, false);
    assert.equal(g.diagnostico, false);
    assert.strictEqual(g.envolverLogger(logger), logger, "diagnóstico desligado devolve o MESMO logger (nenhum wrapper)");
    const ws = new EventEmitter();
    g.observarSocket({ ws });
    assert.equal(ws.eventNames().length, 0, "nenhum listener em ws");
    assert.equal(g.snapshot(), undefined);
    g.parar();
  });

  test("DIAGNÓSTICO ligado em ALL_SUPPORTED: continua SEM injetar shouldIgnoreJid (a única coisa nova é observar)", () => {
    const g = criarInboundGateway({ diagHabilitado: true, emitir() {}, agendar: () => ({ unref() {} }), consoleAlvo: { error() {} } });
    assert.deepEqual(g.opcoesSocket(), {});
    assert.equal(g.filtroAtivo, false);
    assert.equal(g.diagnostico, true);
    g.parar();
  });

  test("DIRECT_ONLY entrega uma função de verdade; valor inválido cai no padrão e sinaliza", () => {
    const g = criarInboundGateway({ escopoBruto: "DIRECT_ONLY", emitir() {} });
    assert.equal(typeof g.opcoesSocket().shouldIgnoreJid, "function");
    assert.equal(g.opcoesSocket().shouldIgnoreJid("120363000000000001@g.us"), true);
    assert.equal(g.filtroAtivo, true);
    const inv = criarInboundGateway({ escopoBruto: "direct_only", emitir() {} });
    assert.equal(inv.valido, false);
    assert.deepEqual(inv.opcoesSocket(), {});
  });

  test("observarSocket: conta stanzas por espécie e por TIPO, sem interferir nas demais escutas", () => {
    const g = criarInboundGateway({ diagHabilitado: true, emitir() {}, agendar: () => ({ unref() {} }), consoleAlvo: { error() {} } });
    const ws = new EventEmitter();
    let baileysViu = 0;
    ws.on("CB:message", () => { baileysViu++; });        // o "handler do Baileys"
    g.observarSocket({ ws });
    ws.emit("CB:message", { tag: "message", attrs: { from: "5511888880001@s.whatsapp.net" } });
    ws.emit("CB:message", { tag: "message", attrs: { from: "120363000000000001@g.us" } });
    ws.emit("CB:receipt", { tag: "receipt", attrs: { from: "100000000000001@lid" } });
    ws.emit("CB:notification", { tag: "notification", attrs: { from: "@s.whatsapp.net" } });
    ws.emit("CB:message", { tag: "message", attrs: {} });      // sem from ⇒ unknown, não lança
    ws.emit("CB:message", null);                                // lixo ⇒ não lança
    assert.equal(baileysViu, 4, "as 4 emissões de CB:message chegaram ao handler do Baileys");
    const st = g.snapshot().stanzas;
    assert.equal(st.direct_pn.message, 1); assert.equal(st.group.message, 1); assert.equal(st.direct_lid_other.receipt, 1);
    assert.equal(st.technical.notification, 1); assert.equal(st.unknown.message, 2);
    assert.ok(!VAZAMENTO.test(sem(g.snapshot())));
  });

  test("envolverLogger: conta 'sent retry receipt' por tipo, repassa TUDO ao logger original e preserva o contrato", () => {
    const chamadas = [];
    const mk = () => ({ level: "silent", child: () => mk(), trace: (...a) => chamadas.push(["trace", a]), debug: (...a) => chamadas.push(["debug", a]), info: (...a) => chamadas.push(["info", a]), warn: (...a) => chamadas.push(["warn", a]), error: (...a) => chamadas.push(["error", a]), fatal() {} });
    const g = criarInboundGateway({ diagHabilitado: true, emitir() {}, agendar: () => ({ unref() {} }), consoleAlvo: { error() {} } });
    const l = g.envolverLogger(mk());
    assert.equal(l.level, "silent");
    for (const n of ["trace", "debug", "info", "warn", "error", "fatal", "child"]) assert.equal(typeof l[n], "function");
    l.info({ msgAttrs: { from: "5511888880001@s.whatsapp.net", id: "TESTMSG1" }, retryCount: 1 }, "sent retry receipt");
    l.child({ class: "baileys" }).info({ msgAttrs: { from: "120363000000000001@g.us" }, retryCount: 2 }, "sent retry receipt");
    l.info({ x: 1 }, "outra mensagem");
    l.error({ err: 1 }, "erro");
    assert.equal(chamadas.length, 4, "as 4 chamadas chegaram ao logger original (pai e child)");
    const r = g.snapshot().retries;
    assert.deepEqual(r.direct_pn, { total: 1, comPreChave: 0, semPreChave: 1 });
    assert.deepEqual(r.group, { total: 1, comPreChave: 1, semPreChave: 0 });
    assert.ok(!VAZAMENTO.test(sem(g.snapshot())));
  });

  test("Bad MAC da libsignal: conta só 'Session error:… Bad MAC', repassa sempre e restaura o console no parar()", () => {
    const vistos = []; const alvo = { error: (...a) => vistos.push(a[0]) };
    const original = alvo.error;
    const g = criarInboundGateway({ diagHabilitado: true, emitir() {}, agendar: () => ({ unref() {} }), consoleAlvo: alvo });
    assert.notStrictEqual(alvo.error, original);
    alvo.error("Session error:Error: Bad MAC Error: Bad MAC", "stack");
    alvo.error("Session error:Error: outra coisa");
    alvo.error("Failed to decrypt message with any known session...");
    alvo.error(new Error("nao string"));
    assert.equal(vistos.length, 4, "nada é engolido");
    assert.equal(g.snapshot().badMacLinhas, 1);
    g.parar();
    assert.strictEqual(alvo.error, original);
  });

  test("resumo `inbound.contadores`: só quando houve mudança; categorias reais; só números/vocabulário fechado; cumulativo", () => {
    const eventos = []; let tick;
    const g = criarInboundGateway({ diagHabilitado: true, emitir: (n, e, d) => eventos.push({ n, e, d }), agendar: (fn) => { tick = fn; return { unref() {} }; }, consoleAlvo: { error() {} } });
    tick(); assert.equal(eventos.length, 0, "sem mudança: sem ruído");
    const ws = new EventEmitter(); const ev = new EventEmitter(); g.observarSocket({ ws, ev });
    ws.emit("CB:message", { attrs: { from: "5511888880001@s.whatsapp.net" } });
    ws.emit("CB:message", { attrs: { from: "120363000000000001@g.us" } });
    const msgs = [
      { key: { remoteJid: "5511888880001@s.whatsapp.net", id: "TESTMSG1" } },
      { key: { remoteJid: "5511888880001@s.whatsapp.net" }, messageStubType: CIPHERTEXT, messageStubParameters: ["No matching sessions found for message"] },
      { key: { remoteJid: "120363000000000001@g.us" }, messageStubType: CIPHERTEXT, messageStubParameters: ["No matching sessions found for message"] },
    ];
    ev.emit("messages.upsert", { messages: msgs, type: "append" });   // decrypt + emitido (buffer inativo)
    g.aoMensagens(msgs);                                               // entregue ao listener do Gateway
    g.envolverLogger({ level: "x", child() { return this; }, info() {} }).info({ msgAttrs: { from: "120363000000000001@g.us" }, retryCount: 2 }, "sent retry receipt");
    tick();
    assert.deepEqual(eventos.map((x) => x.e).sort(), ["inbound.contadores", "inbound.fila_offline"], "o ciclo da fila também mudou (2 nós vistos)");
    const { e, d } = eventos.find((x) => x.e === "inbound.contadores");
    assert.equal(e, "inbound.contadores");
    assert.equal(d.escopo, ESCOPO_ALL_SUPPORTED); assert.equal(d.filtroAtivo, false);
    assert.deepEqual(d.tipos.map((t) => t.tipo), ["direct_pn", "group"]);
    const dir = d.tipos.find((t) => t.tipo === "direct_pn"); const grp = d.tipos.find((t) => t.tipo === "group");
    assert.deepEqual({ ...dir, motivos: undefined }, { tipo: "direct_pn", stanzasMensagem: 1, stanzasReceipt: 0, stanzasNotificacao: 0, ignoradas: 0, decryptTentado: 2, decryptOk: 1, decryptFalha: 1, motivos: undefined, enfileiradas: 0, emitidasDireto: 2, entregues: 2, encaminhadas: 0, fromMe: [{ v: "sim", tentado: 0, falha: 0 }, { v: "nao", tentado: 0, falha: 0 }, { v: "desconhecido", tentado: 2, falha: 1 }], retryTotal: 0, retryComPreChave: 0, retrySemPreChave: 0 });
    assert.deepEqual(dir.motivos, [{ motivo: "sem_sessao_compativel", n: 1 }]);
    assert.equal(grp.decryptFalha, 1); assert.equal(grp.retryComPreChave, 1); assert.equal(grp.retrySemPreChave, 0); assert.equal(grp.retryTotal, 1); assert.equal(grp.ignoradas, 0);
    assert.ok(!VAZAMENTO.test(sem(d)), sem(d));
    tick(); assert.equal(eventos.length, 2, "sem novas mudanças: não repete");
  });

  test("falha no emissor/contador/ganchos nunca propaga", () => {
    const g = criarInboundGateway({ diagHabilitado: true, emitir() { throw new Error("log caiu"); }, agendar: () => ({ unref() {} }), consoleAlvo: { error() {} } });
    g.aoMensagens([{ key: { remoteJid: "x@g.us" } }]);
    assert.doesNotThrow(() => g.emitirResumo());
    assert.doesNotThrow(() => g.aoMensagens(null));
    assert.doesNotThrow(() => g.observarSocket({ ws: { on() { throw new Error("ws quebrado"); } } }));
    assert.doesNotThrow(() => g.observarSocket(undefined));
  });
});

describe("canário — contrato do Baileys 6.7.24 que a política assume", () => {
  const raiz = dirname(createRequire(import.meta.url).resolve("baileys/package.json"));
  const src = readFileSync(join(raiz, "lib", "Socket", "messages-recv.js"), "utf8");
  const corpo = (nome) => { const i = src.indexOf(`const ${nome} = async`); assert.ok(i > 0, `${nome} não encontrado`); return src.slice(i, i + 4000); };

  test("handleMessage consulta shouldIgnoreJid ANTES de qualquer decrypt e responde só com ACK", () => {
    const c = corpo("handleMessage");
    const gate = c.indexOf("shouldIgnoreJid(node.attrs.from)");
    const decrypt = c.indexOf("decryptMessageNode(");
    assert.ok(gate > 0 && decrypt > gate, "o gate precisa vir antes do decryptMessageNode");
    assert.ok(/shouldIgnoreJid\(node\.attrs\.from\)[\s\S]{0,200}sendMessageAck\(node\)[\s\S]{0,60}return;/.test(c), "ignorar = ack + return");
  });

  test("receipts e notificações também passam pelo gate, e o JID técnico '@s.whatsapp.net' é sempre poupado pelo Baileys", () => {
    for (const nome of ["handleReceipt", "handleNotification"]) {
      const c = corpo(nome);
      assert.ok(/shouldIgnoreJid\(remoteJid\) && remoteJid !== '@s\.whatsapp\.net'/.test(c), nome);
    }
  });

  test("o merge de defaults do Baileys sobrescreve com undefined (por isso NUNCA passamos shouldIgnoreJid: undefined)", () => {
    const socketSrc = readFileSync(join(raiz, "lib", "Socket", "index.js"), "utf8");
    assert.ok(/\.\.\.DEFAULT_CONNECTION_CONFIG,\s*\.\.\.config/.test(socketSrc), "merge esperado {...DEFAULT, ...config}");
  });

  test("o diagnóstico depende destes contratos do Baileys: mensagem 'sent retry receipt' com msgAttrs/retryCount e os eventos CB:*", () => {
    assert.ok(/logger\.info\(\{ msgAttrs: node\.attrs, retryCount \}, 'sent retry receipt'\)/.test(src), "log de retry receipt mudou");
    for (const ev of ["CB:message", "CB:receipt", "CB:notification"]) assert.ok(src.includes(`ws.on('${ev}'`), ev);
  });
});
