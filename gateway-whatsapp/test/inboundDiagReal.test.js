// C.9.3-R — o DIAGNÓSTICO com o pipeline REAL do Baileys 6.7.24 (harness local, criptografia real, dados fictícios):
//   * ligado em ALL_SUPPORTED ele só OBSERVA — o resultado (mensagens, deltas de auth) é idêntico ao de antes;
//   * conta por tipo: stanzas, recebidas, decrypt ok/falha, retries (com chave) e as linhas Bad MAC globais;
//   * nada que identifique alguém sai nos contadores nem no evento `inbound.contadores`.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { criarGatewayFalso, capturarConsole } from "../test-support/inboundHarness.js";
import { criarInboundGateway } from "../src/inboundScope.js";

const G1 = "120363000000000001@g.us";
const D = (n) => `55118888${String(n).padStart(5, "0")}@s.whatsapp.net`;
const P = (n) => `55117777${String(n).padStart(5, "0")}@s.whatsapp.net`;

async function rodar({ diag }) {
  const cap = capturarConsole();
  const eventos = [];
  const inbound = criarInboundGateway({ diagHabilitado: diag, emitir: (n, e, d) => eventos.push({ e, d }), agendar: () => ({ unref() {} }), consoleAlvo: console });
  let gw;
  try {
    gw = await criarGatewayFalso({ inbound });
    const d1 = await gw.criarPar(D(1)); await gw.receberStanza(await gw.mensagemDireta(d1, "a")); await gw.responderAoPar(d1);
    const p1 = await gw.criarPar(P(1)); await gw.receberStanza(await gw.mensagemGrupo(p1, G1, "a")); await gw.responderAoPar(p1);
    const base = { medida: gw.medir(), upserts: gw.upserts.length, linhas: cap.linhas.length, enviados: gw.enviados.length };

    const lote = [];
    const rd = await gw.mensagemDireta(d1, "x", { adulterar: true }); rd._ruim = true; lote.push(rd);
    const rg = await gw.mensagemGrupo(p1, G1, "y", { adulterar: true }); rg._ruim = true; lote.push(rg);
    lote.push(await gw.mensagemDireta(await gw.criarPar(D(2)), "novo"));
    lote.push(await gw.mensagemGrupo(await gw.criarPar(P(2)), G1, "novo grupo"));
    lote.push(await gw.mensagemGrupo(await gw.criarPar(P(3)), "status@broadcast", "st"));
    for (const s of lote) { if (s._ruim) gw.marcarSegundaEntrega(s); await gw.receberStanza(s); }
    await gw.aguardarQuiescencia({ estavelMs: 350, maxMs: 6000 });

    const fim = gw.medir();
    const linhas = cap.linhas.slice(base.linhas);
    inbound.emitirResumo();
    return {
      resultado: gw.upserts.slice(base.upserts).map((m) => (m.messageStubType ? "falha" : "ok")).sort(),
      delta: { preKey: fim.preKey - base.medida.preKey, session: fim.session - base.medida.session, senderKey: fim.senderKey - base.medida.senderKey },
      badMacConsole: linhas.filter((l) => /^Session error/.test(l.texto)).length,
      retriesEnviados: gw.enviados.slice(base.enviados).filter((n) => n.tag === "receipt" && n.attrs.type === "retry").length,
      snapshot: inbound.snapshot(), eventos,
    };
  } finally { inbound.parar(); cap.restaurar(); await gw?.encerrar(); }
}

describe("diagnóstico de inbound com o Baileys real", { timeout: 120_000 }, () => {
  let off, on;
  test("executa: diagnóstico desligado e ligado (mesmo tráfego)", async () => {
    off = await rodar({ diag: false });
    on = await rodar({ diag: true });
    assert.ok(off && on);
  });

  test("DESLIGADO: nenhum contador, nenhum evento", () => {
    assert.equal(off.snapshot, undefined);
    assert.equal(off.eventos.length, 0);
  });

  test("LIGADO só observa: mesmas mensagens, mesmos deltas de auth, mesmos Bad MAC e retries que desligado", () => {
    assert.deepEqual(on.resultado, off.resultado);
    assert.deepEqual(on.delta, off.delta);
    assert.equal(on.badMacConsole, off.badMacConsole);
    assert.equal(on.retriesEnviados, off.retriesEnviados);
  });

  test("por tipo: recebidas, decrypt ok/falha, retries com chave — bate com o que o Baileys realmente fez", () => {
    const m = on.snapshot.mensagens, r = on.snapshot.retries, s = on.snapshot.stanzas;
    // direto: setup(1 ok) + rajada(1 ok novo + 1 falha).  grupo: setup(1 ok) + rajada(1 ok novo + 1 falha).  status: 1 ok.
    assert.equal(m.direct_pn.decryptOk, 2);
    assert.equal(m.direct_pn.decryptFalha, 1);
    assert.equal(m.group.decryptOk, 2);
    assert.equal(m.group.decryptFalha, 1);
    assert.equal(m.status.decryptOk, 1);
    assert.equal(r.direct_pn.comChave, 1);
    assert.equal(r.group.comChave, 1);
    assert.deepEqual([s.direct_pn.message, s.group.message, s.status.message], [3, 3, 1], JSON.stringify(s));   // setup + rajada, uma stanza por mensagem
    for (const t of Object.keys(s)) assert.equal(s[t].ignoradas, 0, "ALL_SUPPORTED nunca ignora");
  });

  test("Bad MAC global (linhas da libsignal) é contado e confere com o console real", () => {
    assert.equal(on.snapshot.badMacLinhas, on.badMacConsole + 0, "as linhas da rajada");
    assert.ok(on.snapshot.badMacLinhas >= 2, `badMacLinhas=${on.snapshot.badMacLinhas}`);
  });

  test("o evento inbound.contadores tem só categorias reais e números — nenhum identificador", () => {
    assert.equal(on.eventos.length, 1);
    const { e, d } = on.eventos[0];
    assert.equal(e, "inbound.contadores");
    assert.equal(d.escopo, "ALL_SUPPORTED"); assert.equal(d.filtroAtivo, false);
    for (const t of d.tipos) assert.ok(["direct_pn", "direct_lid", "group", "status", "broadcast", "newsletter", "meta_ai", "technical", "unknown"].includes(t.tipo), t.tipo);
    const s = JSON.stringify(d);
    assert.ok(!/5511|1000000000|whatsapp\.net|120363|@lid|@g\.us|TESTMSG|@broadcast/.test(s), s);
  });
});
