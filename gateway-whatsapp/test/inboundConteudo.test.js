// Central de Comunicação — extração de TIPO/TEXTO do inbound. A regra que importa é de PRIVACIDADE: texto só sai do Gateway para chat direto de
// cliente, com telefone real, sem fromMe/falha/stub. Todo o resto sai como `outro`/null — o backend ainda decide quem é autorizado.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { proto } from "baileys";
import { extrairConteudo, montarEventoInbound, TEXTO_MAX, TIPOS_CONTEUDO } from "../src/inboundContrato.js";

const PN = "5511999990000@s.whatsapp.net";
const SENDER_PN = "5511999990000@s.whatsapp.net";
const evento = (key, extra = {}) => montarEventoInbound({ key: { id: "ID-1", fromMe: false, ...key }, ...extra }, { origemTipo: "LIVE" });
const elegivel = { elegivel: true };

describe("extrairConteudo", () => {
  test("conversation e extendedTextMessage viram texto", () => {
    assert.deepEqual(extrairConteudo({ conversation: "oi" }, elegivel), { tipoConteudo: "texto", texto: "oi" });
    assert.deepEqual(extrairConteudo({ extendedTextMessage: { text: "resposta" } }, elegivel), { tipoConteudo: "texto", texto: "resposta" });
  });

  test("mensagem efêmera / view-once é desembrulhada", () => {
    assert.deepEqual(extrairConteudo({ ephemeralMessage: { message: { extendedTextMessage: { text: "efêmera" } } } }, elegivel), { tipoConteudo: "texto", texto: "efêmera" });
  });

  test("mídia sai só como 'midia' — sem legenda, sem binário", () => {
    for (const m of [{ imageMessage: { caption: "SEGREDO", jpegThumbnail: "AAAA" } }, { audioMessage: {} }, { documentMessage: { fileName: "x.pdf" } }, { stickerMessage: {} }, { videoMessage: { caption: "SEGREDO" } }]) {
      const r = extrairConteudo(m, elegivel);
      assert.deepEqual(r, { tipoConteudo: "midia", texto: null });
      assert.ok(!JSON.stringify(r).includes("SEGREDO"));
    }
  });

  test("não elegível ⇒ nunca devolve texto", () => {
    assert.deepEqual(extrairConteudo({ conversation: "oi" }, { elegivel: false }), { tipoConteudo: "outro", texto: null });
    assert.deepEqual(extrairConteudo({ conversation: "oi" }, {}), { tipoConteudo: "outro", texto: null });
    assert.deepEqual(extrairConteudo({ conversation: "oi" }), { tipoConteudo: "outro", texto: null });
    assert.deepEqual(extrairConteudo({ conversation: "oi" }, { elegivel: "true" }), { tipoConteudo: "outro", texto: null }, "só o booleano true libera");
  });

  test("texto vazio / só espaços / só NUL vira 'outro'; NUL no meio é removido; aparado", () => {
    assert.deepEqual(extrairConteudo({ conversation: "   " }, elegivel), { tipoConteudo: "outro", texto: null });
    assert.deepEqual(extrairConteudo({ conversation: "\u0000\u0000" }, elegivel), { tipoConteudo: "outro", texto: null });
    assert.deepEqual(extrairConteudo({ conversation: "  a\u0000b  " }, elegivel), { tipoConteudo: "texto", texto: "ab" });
  });

  test(`truncado em ${TEXTO_MAX} caracteres sem partir um par substituto (emoji)`, () => {
    const r = extrairConteudo({ conversation: "😀".repeat(TEXTO_MAX + 10) }, elegivel);
    assert.equal(Array.from(r.texto).length, TEXTO_MAX);
    assert.ok(!/[\ud800-\udbff]$/.test(r.texto), "não termina em meio-par substituto");
  });

  test("reação, protocolo, enquete e desconhecidos viram 'outro'; lixo nunca lança", () => {
    for (const m of [{ reactionMessage: { text: "👍" } }, { protocolMessage: { type: 0 } }, { pollCreationMessage: { name: "x" } }, {}, null, undefined, "texto", 5, []]) {
      assert.deepEqual(extrairConteudo(m, elegivel), { tipoConteudo: "outro", texto: null });
    }
  });

  test("vocabulário fechado", () => assert.deepEqual([...TIPOS_CONTEUDO], ["texto", "midia", "outro"]));
});

describe("montarEventoInbound — só chat direto de cliente com telefone real leva texto", () => {
  test("chat direto (PN): tipo e texto", () => {
    const e = evento({ remoteJid: PN }, { message: { conversation: "bom dia" } });
    assert.deepEqual([e.telefoneE164, e.tipoConteudo, e.texto], ["+5511999990000", "texto", "bom dia"]);
  });

  test("LID de outra pessoa COM telefone (senderPn): leva texto; LID SEM telefone: nunca", () => {
    const com = evento({ remoteJid: "100000000000002@lid", senderPn: SENDER_PN }, { message: { conversation: "oi" } });
    assert.deepEqual([com.telefoneOrigem, com.tipoConteudo, com.texto], ["SENDER_PN", "texto", "oi"]);
    const sem = evento({ remoteJid: "100000000000002@lid" }, { message: { conversation: "SEGREDO" } });
    assert.deepEqual([sem.telefoneE164, sem.tipoConteudo, sem.texto], [null, "outro", null]);
    assert.ok(!JSON.stringify(sem).includes("SEGREDO"));
  });

  test("grupo, status, broadcast e newsletter: NUNCA levam texto", () => {
    for (const jid of ["120363000000000001@g.us", "status@broadcast", "123456@broadcast", "120363000000000009@newsletter"]) {
      const e = evento({ remoteJid: jid }, { message: { conversation: "SEGREDO" } });
      assert.deepEqual([e.tipoConteudo, e.texto], ["outro", null], jid);
      assert.ok(!JSON.stringify(e).includes("SEGREDO"), jid);
    }
  });

  test("fromMe, falha de decrypt e stub de sistema: nunca levam texto", () => {
    const fromMe = evento({ remoteJid: PN, fromMe: true }, { message: { conversation: "SEGREDO" } });
    assert.deepEqual([fromMe.tipoConteudo, fromMe.texto], ["outro", null]);
    const falha = evento({ remoteJid: PN }, { messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT, messageStubParameters: ["Bad MAC"], message: { conversation: "SEGREDO" } });
    assert.deepEqual([falha.falhaDecrypt, falha.tipoConteudo, falha.texto], [true, "outro", null]);
    const stub = evento({ remoteJid: PN }, { messageStubType: proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD, message: { conversation: "SEGREDO" } });
    assert.deepEqual([stub.stubSistema, stub.tipoConteudo, stub.texto], [true, "outro", null]);
  });

  test("mensagem sem `message` (ex.: stub sem corpo) não lança e sai como 'outro'", () => {
    const e = evento({ remoteJid: PN });
    assert.deepEqual([e.tipoConteudo, e.texto], ["outro", null]);
  });
});
