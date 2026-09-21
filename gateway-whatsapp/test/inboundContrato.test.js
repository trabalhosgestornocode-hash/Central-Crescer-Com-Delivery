// Checkpoint F — testes do CONTRATO inbound do Gateway (src/inboundContrato.js): atribuição correta, telefone só com PN real,
// origem por mensagem e falha de decrypt explícita. O trecho com Baileys REAL prova a origem dentro de um flush consolidado.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { proto } from "baileys";
import {
  CONTRATO_INBOUND_VERSAO, ORIGENS_INBOUND, ORIGENS_DE_TELEFONE, ORIGEM_PADRAO, TIPOS_JID, MOTIVOS_FALHA_DECRYPT,
  telefoneDeJidPn, extrairTelefoneReal, criarRastreadorOrigem, observarOrigem, montarEventoInbound,
} from "../src/inboundContrato.js";
import { criarGatewayFalso, capturarConsole } from "../test-support/inboundHarness.js";
import { gerarMensagensOffline } from "../test-support/servidorOfflineFalso.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const MEU_LID = "100000000000009";
const MEU_PN = "5511999990009";
const IDENT = { lidUser: MEU_LID, pnUser: MEU_PN };
const E164 = /^\+[1-9][0-9]{7,14}$/;
const AGORA = () => new Date("2026-09-21T12:00:00.000Z");
const evento = (key, extra = {}, o = {}) => montarEventoInbound({ key: { id: "ID-1", ...key }, ...extra }, { origemTipo: "LIVE", identidade: IDENT, agora: AGORA, ...o });

describe("telefone só com evidência REAL de PN (tabela completa de JIDs)", () => {
  const tabela = [
    // [nome, key, esperado {tipo, fromMe, tel, origem}]
    ["PN externo", { remoteJid: "5511999990000@s.whatsapp.net", fromMe: false }, { tipo: "direct_pn", fromMe: false, tel: "+5511999990000", origem: "JID_PN" }],
    ["PN externo com device", { remoteJid: "5511999990000:12@s.whatsapp.net", fromMe: false }, { tipo: "direct_pn", fromMe: false, tel: "+5511999990000", origem: "JID_PN" }],
    ["PN próprio (fromMe=false)", { remoteJid: `${MEU_PN}@s.whatsapp.net`, fromMe: false }, { tipo: "direct_pn", fromMe: false, tel: null, origem: null }],
    ["PN próprio (fromMe=true)", { remoteJid: `${MEU_PN}@s.whatsapp.net`, fromMe: true }, { tipo: "direct_pn", fromMe: true, tel: null, origem: null }],
    ["PN externo enviado por mim (fromMe=true)", { remoteJid: "5511999990000@s.whatsapp.net", fromMe: true }, { tipo: "direct_pn", fromMe: true, tel: null, origem: null }],
    ["LID externo COM senderPn válido", { remoteJid: "100000000000001@lid", fromMe: false, senderPn: "5511999990001@s.whatsapp.net" }, { tipo: "direct_lid_other", fromMe: false, tel: "+5511999990001", origem: "SENDER_PN" }],
    ["LID externo SEM senderPn", { remoteJid: "100000000000001@lid", fromMe: false }, { tipo: "direct_lid_other", fromMe: false, tel: null, origem: null }],
    ["LID externo, senderPn é outro LID", { remoteJid: "100000000000001@lid", fromMe: false, senderPn: "100000000000002@lid" }, { tipo: "direct_lid_other", fromMe: false, tel: null, origem: null }],
    ["LID externo, senderPn de grupo", { remoteJid: "100000000000001@lid", fromMe: false, senderPn: "120363000000000001@g.us" }, { tipo: "direct_lid_other", fromMe: false, tel: null, origem: null }],
    ["LID externo, senderPn curto demais", { remoteJid: "100000000000001@lid", fromMe: false, senderPn: "123@s.whatsapp.net" }, { tipo: "direct_lid_other", fromMe: false, tel: null, origem: null }],
    ["LID externo, senderPn com letras", { remoteJid: "100000000000001@lid", fromMe: false, senderPn: "55abc@s.whatsapp.net" }, { tipo: "direct_lid_other", fromMe: false, tel: null, origem: null }],
    ["LID externo, senderPn é o meu PN", { remoteJid: "100000000000001@lid", fromMe: false, senderPn: `${MEU_PN}@s.whatsapp.net` }, { tipo: "direct_lid_other", fromMe: false, tel: null, origem: null }],
    ["LID externo, senderPn não string", { remoteJid: "100000000000001@lid", fromMe: false, senderPn: 5511999990001 }, { tipo: "direct_lid_other", fromMe: false, tel: null, origem: null }],
    ["LID externo fromMe=true com senderPn", { remoteJid: "100000000000001@lid", fromMe: true, senderPn: "5511999990001@s.whatsapp.net" }, { tipo: "direct_lid_other", fromMe: true, tel: null, origem: null }],
    ["LID PRÓPRIO (fromMe=true)", { remoteJid: `${MEU_LID}@lid`, fromMe: true }, { tipo: "direct_lid_self", fromMe: true, tel: null, origem: null }],
    ["LID PRÓPRIO (fromMe=false) mesmo com senderPn", { remoteJid: `${MEU_LID}@lid`, fromMe: false, senderPn: "5511999990001@s.whatsapp.net" }, { tipo: "direct_lid_self", fromMe: false, tel: null, origem: null }],
    ["grupo", { remoteJid: "120363000000000001@g.us", fromMe: false, participant: "100000000000001@lid" }, { tipo: "group", fromMe: false, tel: null, origem: null }],
    ["grupo com senderPn fabricado", { remoteJid: "120363000000000001@g.us", fromMe: false, senderPn: "5511999990001@s.whatsapp.net", participantPn: "5511999990001@s.whatsapp.net" }, { tipo: "group", fromMe: false, tel: null, origem: null }],
    ["status", { remoteJid: "status@broadcast", fromMe: false }, { tipo: "status", fromMe: false, tel: null, origem: null }],
    ["newsletter", { remoteJid: "120363000000000002@newsletter", fromMe: false }, { tipo: "newsletter", fromMe: false, tel: null, origem: null }],
    ["broadcast", { remoteJid: "1726876800@broadcast", fromMe: false }, { tipo: "broadcast", fromMe: false, tel: null, origem: null }],
    ["Meta AI / bot", { remoteJid: "13135550002@bot", fromMe: false }, { tipo: "meta_ai", fromMe: false, tel: null, origem: null }],
    ["JID técnico (servidor)", { remoteJid: "@s.whatsapp.net", fromMe: false }, { tipo: "technical", fromMe: false, tel: null, origem: null }],
    ["JID técnico (@c.us)", { remoteJid: "0@c.us", fromMe: false }, { tipo: "technical", fromMe: false, tel: null, origem: null }],
    ["JID desconhecido", { remoteJid: "foo@bar", fromMe: false }, { tipo: "unknown", fromMe: false, tel: null, origem: null }],
    ["remoteJid null", { remoteJid: null, fromMe: false }, { tipo: "unknown", fromMe: false, tel: null, origem: null }],
    ["remoteJid ausente", { fromMe: false }, { tipo: "unknown", fromMe: false, tel: null, origem: null }],
    ["remoteJid vazio", { remoteJid: "", fromMe: false }, { tipo: "unknown", fromMe: false, tel: null, origem: null }],
    ["remoteJid não string", { remoteJid: 5511999990000, fromMe: false }, { tipo: "unknown", fromMe: false, tel: null, origem: null }],
    ["malformado: só dígitos", { remoteJid: "5511999990000", fromMe: false }, { tipo: "unknown", fromMe: false, tel: null, origem: null }],
    ["malformado: sem usuário", { remoteJid: "@lid", fromMe: false }, { tipo: "direct_lid_other", fromMe: false, tel: null, origem: null }],
    ["malformado: dois servidores", { remoteJid: "5511999990000@s.whatsapp.net@lid", fromMe: false }, { tipo: "direct_lid_other", fromMe: false, tel: null, origem: null }],
    ["fromMe ausente ⇒ tratado como false (o Baileys sempre informa o boolean)", { remoteJid: "5511999990000@s.whatsapp.net" }, { tipo: "direct_pn", fromMe: false, tel: "+5511999990000", origem: "JID_PN" }],
  ];
  for (const [nome, key, esp] of tabela) {
    test(nome, () => {
      const e = evento(key);
      assert.deepEqual([e.origemJidTipo, e.fromMe, e.telefoneE164, e.telefoneOrigem], [esp.tipo, esp.fromMe, esp.tel, esp.origem]);
      assert.ok(TIPOS_JID.includes(e.origemJidTipo));
      if (e.telefoneE164 !== null) assert.ok(E164.test(e.telefoneE164) && ORIGENS_DE_TELEFONE.includes(e.telefoneOrigem));
    });
  }

  test("REGRESSÃO: um LID de 15 dígitos PASSA no regex de E.164 quando prefixado com '+', mas NUNCA vira telefone", () => {
    assert.ok(E164.test("+100000000000001"), "o problema real: os dígitos do LID parecem um telefone válido");
    const e = evento({ remoteJid: "100000000000001@lid", fromMe: false });
    assert.equal(e.telefoneE164, null); assert.equal(e.telefoneOrigem, null);
    for (const jid of ["100000000000001@lid", "120363000000000001@g.us", "status@broadcast", "120363000000000002@newsletter", "1726876800@broadcast"]) {
      assert.equal(evento({ remoteJid: jid, fromMe: false }).telefoneE164, null, jid);
    }
  });

  test("telefoneDeJidPn: só JID de TELEFONE; nunca lança", () => {
    for (const [jid, tel] of [["5511999990000@s.whatsapp.net", "+5511999990000"], ["5511999990000:3@s.whatsapp.net", "+5511999990000"], ["551199999000@s.whatsapp.net", "+551199999000"]]) assert.equal(telefoneDeJidPn(jid), tel, jid);
    for (const ruim of ["100000000000001@lid", "0511999990000@s.whatsapp.net", "1234567@s.whatsapp.net", "5511999990000", "", null, undefined, 5, {}, "a@s.whatsapp.net", "5511999990000@g.us", "1234567890123456@s.whatsapp.net"]) assert.equal(telefoneDeJidPn(ruim), null, String(ruim));
  });

  test("extrairTelefoneReal: entrada lixo nunca lança e nunca devolve telefone", () => {
    for (const lixo of [undefined, null, {}, { origemJidTipo: "direct_pn" }, { origemJidTipo: "direct_pn", fromMe: "false", remoteJid: "5511999990000@s.whatsapp.net" }, { origemJidTipo: "direct_lid_other", fromMe: 0, senderPn: "5511999990000@s.whatsapp.net" }]) {
      assert.deepEqual(extrairTelefoneReal(lixo), { telefoneE164: null, telefoneOrigem: null }, JSON.stringify(lixo));
    }
  });
});

describe("evento do contrato: campos, falha de decrypt e stubs", () => {
  test("forma EXATA do evento (chaves fechadas) e versão do contrato", () => {
    const e = evento({ remoteJid: "5511999990000@s.whatsapp.net", fromMe: false });
    assert.deepEqual(Object.keys(e).sort(), ["contratoInbound", "falhaDecrypt", "fromMe", "motivoFalhaDecrypt", "origemJidTipo", "origemTipo", "providerMessageId", "recebidoEm", "stubSistema", "telefoneE164", "telefoneOrigem"]);
    assert.deepEqual(e, { contratoInbound: CONTRATO_INBOUND_VERSAO, providerMessageId: "ID-1", origemTipo: "LIVE", origemJidTipo: "direct_pn", fromMe: false, telefoneE164: "+5511999990000", telefoneOrigem: "JID_PN", falhaDecrypt: false, motivoFalhaDecrypt: null, stubSistema: false, recebidoEm: "2026-09-21T12:00:00.000Z" });
  });

  test("falha de decrypt: stub CIPHERTEXT ⇒ falhaDecrypt=true + motivo do vocabulário FECHADO; o texto do erro nunca sai", () => {
    const CIPHER = proto.WebMessageInfo.StubType.CIPHERTEXT;
    const casos = [["Bad MAC Error: Bad MAC", "bad_mac"], ["No matching sessions found for message", "sem_sessao_compativel"], ["No session found to decrypt message", "sem_sessao"], ["Message absent from node", "sem_conteudo"], ["Key used already or never filled", "chave_ja_usada"], ["algo que nunca vimos: SEGREDO-XYZ", "outro"], [undefined, "outro"], [{ nao: "string" }, "outro"]];
    for (const [texto, motivo] of casos) {
      const e = evento({ remoteJid: "5511999990000@s.whatsapp.net", fromMe: false }, { messageStubType: CIPHER, messageStubParameters: [texto] });
      assert.deepEqual([e.falhaDecrypt, e.motivoFalhaDecrypt, e.stubSistema], [true, motivo, false]);
      assert.ok(MOTIVOS_FALHA_DECRYPT.includes(e.motivoFalhaDecrypt));
      assert.ok(!JSON.stringify(e).includes("SEGREDO-XYZ") && !/Bad MAC|matching sessions/.test(JSON.stringify(e)), "nenhum texto de erro no evento");
    }
    const ok = evento({ remoteJid: "5511999990000@s.whatsapp.net", fromMe: false }, { message: { conversation: "oi" } });
    assert.deepEqual([ok.falhaDecrypt, ok.motivoFalhaDecrypt], [false, null]);
  });

  test("outro stub de protocolo (não é CIPHERTEXT) ⇒ stubSistema=true, falhaDecrypt=false (não é texto de cliente)", () => {
    const e = evento({ remoteJid: "120363000000000001@g.us", fromMe: false }, { messageStubType: proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD });
    assert.deepEqual([e.stubSistema, e.falhaDecrypt, e.motivoFalhaDecrypt], [true, false, null]);
    assert.equal(evento({ remoteJid: "5511999990000@s.whatsapp.net", fromMe: false }, { message: { conversation: "x" } }).stubSistema, false);
  });

  test("sem id (ou id inválido) ⇒ null: sem id não há deduplicação", () => {
    for (const ruim of [{}, { id: "" }, { id: 5 }, { id: null }, { id: undefined }]) assert.equal(montarEventoInbound({ key: { remoteJid: "5511999990000@s.whatsapp.net", ...ruim } }, { origemTipo: "LIVE" }), null, JSON.stringify(ruim));
    assert.equal(montarEventoInbound(null), null); assert.equal(montarEventoInbound(undefined), null); assert.equal(montarEventoInbound({}), null);
  });

  test("origemTipo: enum fechado; valor desconhecido/ausente/inválido ⇒ OFFLINE_NORMAL (fail-safe, nunca LIVE por omissão); OFFLINE_RECOVERY é aceito no contrato", () => {
    assert.deepEqual(ORIGENS_INBOUND, ["LIVE", "OFFLINE_NORMAL", "OFFLINE_RECOVERY"]); assert.equal(ORIGEM_PADRAO, "OFFLINE_NORMAL");
    const base = { key: { id: "X", remoteJid: "5511999990000@s.whatsapp.net", fromMe: false } };
    for (const o of ["LIVE", "OFFLINE_NORMAL", "OFFLINE_RECOVERY"]) assert.equal(montarEventoInbound(base, { origemTipo: o }).origemTipo, o);
    for (const ruim of [undefined, null, "", "live", "RECOVERY", 5, {}, "OFFLINE"]) assert.equal(montarEventoInbound(base, { origemTipo: ruim }).origemTipo, "OFFLINE_NORMAL", String(ruim));
  });
});

describe("rastreador de origem (por mensagem, limitado, sem expor ids)", () => {
  test("LIVE × OFFLINE pela MESMA regra do Baileys (`!!attrs.offline`): '0' também é offline; ausente/vazio é ao vivo", () => {
    const r = criarRastreadorOrigem();
    r.registrar({ attrs: { id: "a", offline: "1" } }); r.registrar({ attrs: { id: "b", offline: "0" } }); r.registrar({ attrs: { id: "c" } }); r.registrar({ attrs: { id: "d", offline: "" } });
    assert.deepEqual(["a", "b", "c", "d"].map((i) => r.consumir(i)), ["OFFLINE_NORMAL", "OFFLINE_NORMAL", "LIVE", "LIVE"]);
  });

  test("consumir libera a entrada; id desconhecido/ausente/inválido ⇒ OFFLINE_NORMAL (nunca LIVE por omissão)", () => {
    const r = criarRastreadorOrigem(); r.registrar({ attrs: { id: "a" } });
    assert.equal(r.tamanho(), 1); assert.equal(r.consumir("a"), "LIVE"); assert.equal(r.tamanho(), 0); assert.equal(r.consumir("a"), "OFFLINE_NORMAL", "já consumida");
    for (const ruim of [undefined, null, "", 5, {}, "nunca-visto"]) assert.equal(r.consumir(ruim), "OFFLINE_NORMAL");
  });

  test("LIMITADO: descarta as mais antigas acima do teto; nó sem id/lixo é ignorado; novoSocket limpa", () => {
    const r = criarRastreadorOrigem({ max: 3 });
    for (const id of ["a", "b", "c", "d", "e"]) r.registrar({ attrs: { id } });
    assert.equal(r.tamanho(), 3); assert.equal(r.consumir("a"), "OFFLINE_NORMAL", "a mais antiga foi descartada"); assert.equal(r.consumir("e"), "LIVE");
    for (const lixo of [null, undefined, {}, { attrs: {} }, { attrs: { id: 5 } }, { attrs: { id: "" } }, "x"]) assert.doesNotThrow(() => r.registrar(lixo));
    assert.equal(r.tamanho(), 2); r.novoSocket(); assert.equal(r.tamanho(), 0);
    assert.throws(() => criarRastreadorOrigem({ max: 0 }), RangeError);
    const grande = criarRastreadorOrigem(); for (let i = 0; i < 20_000; i++) grande.registrar({ attrs: { id: `id${i}` } });
    assert.equal(grande.tamanho(), 5000, "teto padrão de 5.000");
  });

  test("id repetido: vale a ÚLTIMA origem vista (entrega ao vivo depois de offline não fica presa como offline)", () => {
    const r = criarRastreadorOrigem(); r.registrar({ attrs: { id: "x", offline: "1" } }); r.registrar({ attrs: { id: "x" } });
    assert.equal(r.consumir("x"), "LIVE");
  });

  test("observarOrigem: ws.prependListener (antes do handler do Baileys) e fallback ws.on; sem ws ⇒ false, nunca lança; reobservar limpa", () => {
    const r = criarRastreadorOrigem(); const ws = new EventEmitter(); const ordem = [];
    ws.on("CB:message", () => ordem.push("baileys"));
    assert.equal(observarOrigem({ ws }, { ...r, registrar: (n) => { ordem.push("origem"); r.registrar(n); }, novoSocket: () => r.novoSocket() }), true);
    ws.emit("CB:message", { attrs: { id: "z", offline: "1" } });
    assert.deepEqual(ordem, ["origem", "baileys"], "registra ANTES do handler do Baileys");
    const semPrepend = { on: (ev, fn) => { semPrepend.f = fn; } }; assert.equal(observarOrigem({ ws: semPrepend }, criarRastreadorOrigem()), true);
    assert.equal(observarOrigem({}, criarRastreadorOrigem()), false); assert.equal(observarOrigem(null, criarRastreadorOrigem()), false);
    assert.equal(observarOrigem({ ws: { prependListener() { throw new Error("x"); } } }, criarRastreadorOrigem()), false);
    r.registrar({ attrs: { id: "q" } }); observarOrigem({ ws: new EventEmitter() }, r); assert.equal(r.tamanho(), 0);
  });
});

describe("GUARDA ESTRUTURAL do contrato", () => {
  const tira = (s) => s.replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const contrato = tira(readFileSync(join(aqui, "..", "src", "inboundContrato.js"), "utf8"));
  const sessao = tira(readFileSync(join(aqui, "..", "src", "baileysSession.js"), "utf8"));

  test("o contrato não usa deJid nem split('@') para telefone; não loga, não faz flush/buffer/envio", () => {
    assert.ok(!/\bdeJid\b/.test(contrato) && !/split\(\s*["']@["']\s*\)/.test(contrato));
    for (const proibido of [/\bconsole\b/, /\blog\s*\(/, /\bflush\b/, /\.buffer\s*\(/, /sendMessage|sendNode|relayMessage/, /\bfetch\b/, /\.emit\s*\(/]) assert.ok(!proibido.test(contrato), `token proibido: ${proibido}`);
  });

  test("aoMessagesUpsert (sessão) NÃO usa deJid: o evento vem SÓ de montarEventoInbound; origem por consumir(id), nunca pelo type do upsert", () => {
    const i = sessao.indexOf("function aoMessagesUpsert"); assert.ok(i > 0);
    const corpo = sessao.slice(i, sessao.indexOf("function aoMessagesUpdate", i));
    assert.ok(!/\bdeJid\b/.test(corpo), "deJid fora do caminho do inbound");
    assert.ok(/montarEventoInbound\(/.test(corpo) && /rastreadorOrigem\.consumir\(/.test(corpo));
    assert.ok(!/\btype\b/.test(corpo.replace(/messageStub\w*/g, "")), "nenhuma decisão pelo `type` do upsert");
    assert.ok(/if \(m\.key\?\.fromMe\) continue;/.test(corpo), "fromMe continua sem ser encaminhado");
  });

  test("deJid deixa de ser fonte de telefone: a única chamada restante é ao PRÓPRIO número autenticado (socket.user.id)", () => {
    const usos = [...sessao.matchAll(/(?<!function )\bdeJid\(([^)]*)\)/g)].map((m) => m[1].trim());
    assert.deepEqual(usos, ["socket.user.id"]);
  });
});

describe("Baileys REAL: a origem é POR MENSAGEM dentro de um flush consolidado (type do upsert não serve)", { timeout: 120_000 }, () => {
  test("6 nós offline retidos + 1 nó vivo ⇒ o flush entrega 7 no MESMO messages.upsert; cada um sai com a sua origem; falha de decrypt explícita", async () => {
    const cap = capturarConsole(); const gw = await criarGatewayFalso({ opcoesBaileys: { placeholderResendCache: { get: () => true, set() {}, del() {} } } });
    try {
      const rastreador = criarRastreadorOrigem(); assert.equal(observarOrigem(gw.sock, rastreador), true);
      const nos = await gerarMensagensOffline(gw, 6, { pares: 2 });
      const par = await gw.criarPar("5511888800900@s.whatsapp.net"); const ruim = await gw.mensagemDireta(par, "adulterada", { adulterar: true });
      for (const n of [...nos, ruim]) gw.sock.ws.emit("CB:message", n);
      await gw.aguardarQuiescencia({ estavelMs: 500, maxMs: 20_000 });
      assert.equal(gw.upserts.length, 0, "nada liberado enquanto o buffer está ativo");
      const parV = await gw.criarPar("5511888800901@s.whatsapp.net"); const viva = await gw.mensagemDireta(parV, "viva"); delete viva.attrs.offline;
      await gw.entregarSemFimOffline(viva);
      assert.equal(gw.upserts.length, 8, "6 offline + 1 falha + 1 viva liberadas pelo flush nativo");
      assert.equal(new Set(gw.upsertsTipos.map((u) => u.tipo)).size, 1, "o type consolidado é UM só para o flush inteiro — não distingue as mensagens");
      const eventos = gw.upserts.map((m) => montarEventoInbound(m, { origemTipo: rastreador.consumir(m.key.id), identidade: IDENT }));
      const idsOffline = new Set([...nos, ruim].map((n) => n.attrs.id)); const idViva = viva.attrs.id;
      for (const e of eventos) assert.equal(e.origemTipo, idsOffline.has(e.providerMessageId) ? "OFFLINE_NORMAL" : "LIVE", "origem por mensagem");
      assert.equal(eventos.filter((e) => e.origemTipo === "LIVE").length, 1); assert.equal(eventos.find((e) => e.providerMessageId === idViva).origemTipo, "LIVE");
      const falha = eventos.find((e) => e.providerMessageId === ruim.attrs.id);
      assert.deepEqual([falha.falhaDecrypt, MOTIVOS_FALHA_DECRYPT.includes(falha.motivoFalhaDecrypt)], [true, true]);
      assert.ok(eventos.filter((e) => e.providerMessageId !== ruim.attrs.id).every((e) => e.falhaDecrypt === false));
      for (const e of eventos) { assert.equal(e.origemJidTipo, "direct_pn"); assert.match(e.telefoneE164, E164); assert.equal(e.telefoneOrigem, "JID_PN"); }
      assert.equal(rastreador.tamanho(), 0, "todas consumidas");
    } finally { cap.restaurar(); await gw.encerrar(); }
  });
});
