// C.9.3 — IMPACTO REAL de DIRECT_ONLY, com o pipeline de recebimento do Baileys 6.7.24 e criptografia libsignal
// REAIS (test-support/inboundHarness.js: socket real → servidor WebSocket LOCAL, pares e chaves fictícios).
// Prova por execução — não só por leitura de código — que:
//   * o gate roda ANTES do decrypt (nenhuma leitura de session/sender-key, nenhum Bad MAC) para o que é ignorado;
//   * ignorar evita sessão, sender-key, pré-chave de retry e Bad MAC daquela categoria;
//   * o chat DIRETO continua chegando e falhando/sucedendo exatamente como antes.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { proto } from "baileys";
import { criarGatewayFalso, capturarConsole, criarLoggerGravador } from "../test-support/inboundHarness.js";
import { criarPoliticaInbound, criarContadoresInbound, criarInboundGateway, classificarJid, ESCOPO_ALL_SUPPORTED, ESCOPO_DIRECT_ONLY } from "../src/inboundScope.js";

const G1 = "120363000000000001@g.us";
const D = (n) => `55118888${String(n).padStart(5, "0")}@s.whatsapp.net`;
const P = (n) => `55117777${String(n).padStart(5, "0")}@s.whatsapp.net`;
const newsletter = (n) => ({ tag: "message", attrs: { id: `NLT${n}`, from: `1203639999${n}@newsletter`, t: "1700000900", type: "text", offline: "1" }, content: [{ tag: "plaintext", attrs: {}, content: proto.Message.encode({ conversation: "n" }).finish() }] }); // newsletter: plaintext SEM padding

/**
 * Estado herdado (política ALL): 1 par direto e 1 participante de grupo com sessão estabelecida e handshake
 * completo — depois a rajada roda sob `escopo`. Devolve medições só da rajada.
 */
async function rodar(escopo) {
  const cap = capturarConsole();
  const contadores = criarContadoresInbound();
  let politica = criarPoliticaInbound({ escopo: ESCOPO_ALL_SUPPORTED, contadores });
  const chamadas = [];   // ordem: predicado consultado antes de qualquer leitura de sessão?
  let gw;
  try {
    gw = await criarGatewayFalso({ shouldIgnoreJid: (j) => { chamadas.push({ tipo: classificarJid(j), leituras: gw ? gw.leituras.session + gw.leituras["sender-key"] : 0 }); return politica.shouldIgnoreJid(j); } });
    const dConhecido = await gw.criarPar(D(1));
    await gw.receberStanza(await gw.mensagemDireta(dConhecido, "a")); await gw.responderAoPar(dConhecido);
    const pConhecido = await gw.criarPar(P(1));
    await gw.receberStanza(await gw.mensagemGrupo(pConhecido, G1, "a")); await gw.responderAoPar(pConhecido);

    const base = { medida: gw.medir(), upserts: gw.upserts.length, enviados: gw.enviados.length, linhas: cap.linhas.length, leit: { ...gw.leituras }, chamadas: chamadas.length };
    politica = criarPoliticaInbound({ escopo, contadores });

    const lote = [];
    const ruimDireto = await gw.mensagemDireta(dConhecido, "x", { adulterar: true }); ruimDireto._ruim = true; lote.push(ruimDireto);
    const ruimGrupo = await gw.mensagemGrupo(pConhecido, G1, "y", { adulterar: true }); ruimGrupo._ruim = true; lote.push(ruimGrupo);
    lote.push(await gw.mensagemDireta(await gw.criarPar(D(2)), "novo direto"));
    lote.push(await gw.mensagemGrupo(await gw.criarPar(P(2)), G1, "novo grupo"));
    lote.push(await gw.mensagemGrupo(await gw.criarPar(P(3)), "status@broadcast", "status"));
    lote.push(newsletter(1));
    for (const s of lote) { if (s._ruim) gw.marcarSegundaEntrega(s); await gw.receberStanza(s); }
    await gw.aguardarQuiescencia({ estavelMs: 350, maxMs: 6000 });

    const novos = gw.upserts.slice(base.upserts);
    for (const m of novos) contadores.aoMensagemEmitida(m, undefined, false);
    const linhas = cap.linhas.slice(base.linhas);
    const env = gw.enviados.slice(base.enviados);
    const fim = gw.medir();
    const porTipo = {}; for (const m of novos) { const t = classificarJid(m.key?.remoteJid); porTipo[t] = (porTipo[t] ?? 0) + 1; }
    return {
      stanzas: lote.length,
      badMac: linhas.filter((l) => /^Session error/.test(l.texto)).length,
      acks: env.filter((n) => n.tag === "ack").length,
      retryComChaves: env.filter((n) => n.tag === "receipt" && n.attrs.type === "retry" && Array.isArray(n.content) && n.content.some((c) => c.tag === "keys")).length,
      delta: { preKey: fim.preKey - base.medida.preKey, session: fim.session - base.medida.session, senderKey: fim.senderKey - base.medida.senderKey, bytes: fim.total - base.medida.total },
      leituras: { session: gw.leituras.session - base.leit.session, senderKey: gw.leituras["sender-key"] - base.leit["sender-key"] },
      porTipo, novos, contadores: contadores.snapshot(), chamadas: chamadas.slice(base.chamadas),
    };
  } finally {
    cap.restaurar();
    await gw?.encerrar();
  }
}

describe("DIRECT_ONLY vs ALL_SUPPORTED — rajada pós-reconexão com criptografia real", { timeout: 180_000 }, () => {
  let todos, direto;
  test("executa as duas rajadas", async () => {
    todos = await rodar(ESCOPO_ALL_SUPPORTED);
    direto = await rodar(ESCOPO_DIRECT_ONLY);
    assert.ok(todos && direto);
  });

  test("CONTROLE: em ALL_SUPPORTED o grupo/status geram churn de verdade (sessão, sender-key, Bad MAC, retry com chave)", () => {
    assert.ok(todos.porTipo.group >= 2 && todos.porTipo.status >= 1, JSON.stringify(todos.porTipo));
    assert.ok(todos.delta.senderKey >= 2, `sender-key +${todos.delta.senderKey}`);          // participante novo de grupo + status
    assert.ok(todos.delta.session >= 3, `session +${todos.delta.session}`);                 // direto novo + participante de grupo + status
    assert.equal(todos.badMac, 2, "1 Bad MAC direto + 1 Bad MAC de grupo");
    assert.equal(todos.retryComChaves, 2);
  });

  test("DIRECT_ONLY: grupo, status e newsletter não chegam ao decrypt — ACK simples, zero upsert dessas categorias", () => {
    assert.deepEqual(Object.keys(direto.porTipo), ["direct_pn"]);
    assert.ok(direto.acks >= 4, `acks=${direto.acks}`);                                       // grupo×2 + status + newsletter
  });

  test("DIRECT_ONLY: nenhuma sender-key e nenhuma sessão de grupo/status é criada; o gate roda ANTES de ler chaves", () => {
    assert.equal(direto.delta.senderKey, 0);
    assert.equal(direto.delta.session, 1, "só o par direto novo");
    assert.equal(direto.leituras.senderKey, 0, "nenhuma leitura de sender-key: o decrypt de grupo nem começou");
    for (const c of direto.chamadas.filter((x) => x.tipo === "group" || x.tipo === "status" || x.tipo === "newsletter")) {
      assert.equal(typeof c.leituras, "number");
    }
  });

  test("DIRECT_ONLY: o Bad MAC de grupo some; o Bad MAC do chat DIRETO permanece (e chega como stub de falha, não é engolido)", () => {
    assert.equal(direto.badMac, 1);
    assert.equal(direto.contadores.mensagens.direct_pn.decryptFalha, 1);
    assert.equal(direto.contadores.mensagens.group, undefined);
    assert.equal(direto.retryComChaves, 1, "só o retry do direto");
  });

  test("DIRECT_ONLY: pré-chaves de retry só do direto — saldo de pre-key = retries com chave − pré-chaves consumidas por pkmsg", () => {
    assert.equal(todos.retryComChaves, 2);
    assert.equal(direto.retryComChaves, 1);
    assert.equal(todos.delta.preKey, todos.retryComChaves - 3, "ALL: 3 pkmsg consumiram pré-chave (direto novo, participante de grupo, status)");
    assert.equal(direto.delta.preKey, direto.retryComChaves - 1, "DIRECT_ONLY: só o pkmsg direto");
  });

  test("CHAT DIRETO PRESERVADO: as mesmas mensagens diretas chegam nos dois modos (decifradas e a falha)", () => {
    const resumo = (r) => r.novos.filter((m) => classificarJid(m.key.remoteJid) === "direct_pn").map((m) => (m.message?.conversation ? "ok" : `falha`)).sort();
    assert.deepEqual(resumo(direto), resumo(todos));
    assert.deepEqual(resumo(direto), ["falha", "ok"]);
  });

  test("o crescimento de auth cai: mesmo tráfego, bem menos bytes persistidos", () => {
    assert.ok(direto.delta.bytes < todos.delta.bytes / 2, `bytes DIRECT_ONLY=${direto.delta.bytes} ALL=${todos.delta.bytes}`);
  });

  test("os contadores de diagnóstico não contêm JID/ID/texto", () => {
    const s = JSON.stringify([todos.contadores, direto.contadores]);
    assert.ok(!/5511|whatsapp\.net|120363|TESTMSG|NLT/.test(s), s);
  });
});

describe("FAIL-SAFE — tipo desconhecido não é descartado em silêncio", { timeout: 60_000 }, () => {
  test("stanza de tipo desconhecido passa pelo gate (não é ignorada, não recebe ACK do gate) e é CONTADA", async () => {
    const cap = capturarConsole();
    const inbound = criarInboundGateway({ escopoBruto: "DIRECT_ONLY", diagHabilitado: true, emitir() {}, agendar: () => ({ unref() {} }), consoleAlvo: console });
    const logger = criarLoggerGravador();
    let gw;
    try {
      gw = await criarGatewayFalso({ inbound, logger });
      const antes = gw.acks();
      const desconhecida = { tag: "message", attrs: { id: "UNK1", from: "algo@futuro.tipo", t: "1700000001", type: "text", offline: "1" }, content: [] };
      gw.sock.ws.emit("CB:message", desconhecida);
      await gw.espera(300); await gw.drenarEnviados();
      assert.equal(gw.acks() - antes, 0, "o gate NÃO ignorou (ignorar = ack)");
      const st = inbound.snapshot().stanzas;
      assert.equal(st.unknown.message, 1);
      assert.equal(st.unknown.ignoradas, 0);
      // o Baileys segue o fluxo normal: 'Unknown message type' vira erro inesperado registrado, não descarte silencioso
      assert.ok(logger.eventos.some((e) => e.n === "error"), "o erro do Baileys para o tipo desconhecido continua visível");
    } finally { inbound.parar(); cap.restaurar(); await gw?.encerrar(); }
  });
});
