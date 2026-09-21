// C.9.4 — INVARIANTE: a instrumentação de inbound só OBSERVA. Ela nunca chama flush(), nunca arma/desarma o buffer por conta
// própria, nunca emite messages.upsert, nunca filtra e nunca altera a fila offline do Baileys. Corrigir a retenção é um
// checkpoint SEPARADO (depois do contrato do Checkpoint F): este arquivo trava que este commit não o faz por acidente.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { criarGatewayFalso, capturarConsole } from "../test-support/inboundHarness.js";
import { criarInboundGateway } from "../src/inboundScope.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const fonte = (rel) => readFileSync(join(aqui, "..", "src", rel), "utf8").replace(/\r\n/g, "\n");
// remove comentários de bloco e de linha (sem tocar em strings simples deste código)
const semComentarios = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const G1 = "120363000000000001@g.us";
const D = (n) => `55118888${String(n).padStart(5, "0")}@s.whatsapp.net`;

describe("a instrumentação não chama flush/buffer nem emite eventos (análise estática do código)", () => {
  const src = semComentarios(fonte("inboundScope.js"));

  test("toda chamada a flush/buffer é o REPASSE ao original (flushOriginal/bufOriginal.apply), acionado só pelo Baileys", () => {
    const chamadasFlush = src.match(/[\w.?]*flush\w*\s*(\.apply|\.call)?\s*\(/gi) ?? [];
    for (const c of chamadasFlush) assert.ok(/^(flushOriginal\.apply\(|flushObservado\(|ciclo\.aoFlush\(|aoFlush\(|function flushObservado\()/i.test(c.trim()) || /aoFlush|flushObservado/.test(c), `chamada de flush inesperada: ${c}`);
    assert.ok(!/\bev\.flush\s*\(/.test(src), "nenhum ev.flush() direto");
    assert.ok(!/\bsocket\??\.ev\??\.flush\s*\(/.test(src));
    assert.ok(!/\bev\.buffer\s*\(/.test(src), "nenhum ev.buffer() direto");
    assert.ok(!/\bcreateBufferedFunction\b/.test(src));
  });

  test("nenhum emit próprio de messages.upsert (só o repasse `emitOriginal.call` do que o Baileys emitiu)", () => {
    assert.ok(!/["']messages\.upsert["']\s*,\s*\{/.test(src), "não constrói/emite um messages.upsert");
    const emits = src.match(/[\w.?]*emit\w*\s*(\.call|\.apply)?\s*\(/g) ?? [];
    for (const e of emits) assert.ok(/^(emitOriginal\.call\(|emitObservado\(|emitir\(|function emitObservado\(|deps\.emitir\()/.test(e.trim()) || /emitirResumo|emitir\(|emitObservado|emitOriginal/.test(e), `emit inesperado: ${e}`);
  });

  test("a sessão só ganha a chamada de contagem `aoEncaminhada` (nenhum flush/filtro/alteração de payload)", () => {
    const s = semComentarios(fonte("baileysSession.js"));
    assert.ok(!/\.flush\s*\(/.test(s));
    assert.ok(/inbound\?\.aoEncaminhada\?\.\(m\)/.test(s));
    // Checkpoint F: o payload vem do CONTRATO (inboundContrato.montarEventoInbound) — nunca mais deJid(remoteJid) → telefone
    assert.ok(/notificarMensagemRecebida\(evento\)/.test(s) && /montarEventoInbound\(m,/.test(s) && !/deJid\(m\.key/.test(s));
  });

  test("em ALL_SUPPORTED (com diagnóstico) nenhum shouldIgnoreJid é injetado", () => {
    const g = criarInboundGateway({ diagHabilitado: true, emitir() {}, agendar: () => ({ unref() {} }), consoleAlvo: { error() {} } });
    assert.deepEqual(g.opcoesSocket(), {}); assert.equal(g.filtroAtivo, false); g.parar();
  });
});

describe("com mensagens RETIDAS, observar (resumos, snapshots, encaminhadas, timers) NÃO drena a fila offline", { timeout: 120_000 }, () => {
  async function cenarioRetido({ diag }) {
    const cap = capturarConsole(); const eventos = [];
    const inbound = criarInboundGateway({ diagHabilitado: diag, emitir: (n, e, d) => eventos.push({ e, d }), intervaloMs: 40, consoleAlvo: console });   // timer REAL de 40 ms
    const gw = await criarGatewayFalso({ inbound, latenciaKeysMs: 8 });
    const fim = async () => { inbound.parar(); cap.restaurar(); await gw.encerrar(); };
    try {
      const pares = [await gw.criarPar(D(1)), await gw.criarPar(D(2)), await gw.criarPar(D(3))];
      const s = [await gw.mensagemDireta(pares[0], "a"), await gw.mensagemDireta(pares[1], "b"), await gw.mensagemGrupo(pares[2], G1, "g")];
      for (const n of s) gw.sock.ws.emit("CB:message", n);
      gw.emitirOfflineFim(s.length);                       // fim do offline ANTES do decrypt: as três ficam retidas
      await gw.aguardarQuiescencia({ estavelMs: 400, maxMs: 8000 });
      return { gw, inbound, eventos, fim };
    } catch (e) { inbound.parar(); cap.restaurar(); await gw.encerrar(); throw e; }
  }

  test("ON × OFF: mesma retenção; observar muito, por mais de 1 s, não muda NADA (sem flush, sem upsert, buffer ainda ativo)", async () => {
    const off = await cenarioRetido({ diag: false });
    const on = await cenarioRetido({ diag: true });
    try {
      assert.equal(off.gw.upserts.length, 0); assert.equal(on.gw.upserts.length, 0, "retidas nos dois: o diagnóstico não altera a retenção");
      assert.equal(off.gw.bufferando(), true); assert.equal(on.gw.bufferando(), true);
      const antes = on.inbound.estadoFila();
      assert.equal(antes.mensagensRetidas, 3);
      // estressa TODA a superfície de observação
      for (let i = 0; i < 25; i++) {
        on.inbound.emitirResumo(); on.inbound.snapshot(); on.inbound.estadoFila();
        on.inbound.aoMensagens([]); on.inbound.aoEncaminhada({ key: { remoteJid: D(1) } });   // (contagem apenas)
      }
      await on.gw.espera(1200);                          // deixa o timer real (40 ms) rodar dezenas de vezes
      assert.equal(on.gw.upserts.length, 0, "nenhum upsert foi forçado");
      assert.equal(on.gw.bufferando(), true, "o buffer NÃO foi drenado");
      const depois = on.inbound.estadoFila();
      assert.equal(depois.flushes, antes.flushes, "ninguém chamou flush() durante a observação");
      assert.equal(depois.flushesEfetivos, antes.flushesEfetivos);
      assert.equal(depois.mensagensRetidas, 3);
      assert.equal(depois.bufferAtivo, true);
      // e o OFF (sem nenhuma instrumentação) está no MESMO estado observável
      assert.equal(off.gw.sock.ev.isBuffering(), on.gw.sock.ev.isBuffering());
    } finally { await on.fim(); await off.fim(); }
  });

  test("só um nó VIVO processado pelo próprio Baileys libera — e isso é igual com o diagnóstico ligado ou desligado", async () => {
    const res = {};
    for (const diag of [false, true]) {
      const t = await cenarioRetido({ diag });
      try {
        const par = await t.gw.criarPar(D(9));
        const viva = await t.gw.mensagemDireta(par, "viva"); delete viva.attrs.offline;
        await t.gw.entregarSemFimOffline(viva);
        res[diag] = { upserts: t.gw.upserts.length, bufferando: t.gw.bufferando() };
      } finally { await t.fim(); }
    }
    assert.deepEqual(res[true], res[false]);
    assert.deepEqual(res[true], { upserts: 4, bufferando: false });
  });
});
