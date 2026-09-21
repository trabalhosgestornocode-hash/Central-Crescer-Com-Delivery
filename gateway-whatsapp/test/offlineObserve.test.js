// C.9.6 — testes UNITÁRIOS do observador da fila offline (src/offlineObserve.js): sanitização, buckets, máquina de estados
// diagnóstica e watchdog em modo OBSERVE, com relógio e timer falsos. O observador NÃO faz nada além de observar e emitir: estes testes
// travam as regras de decisão (quando o failsafe futuro TERIA disparado) e a incapacidade estrutural de interferir.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  criarObservadorOffline, classificarAtributoOffline, bucketIdade, sanitizarAtributosPreview, FASE, PADROES, BUCKETS_IDADE, ENUM_SEGURO, CLASSES_VALOR_OFFLINE,
} from "../src/offlineObserve.js";
import { sanitizar } from "../src/logsafe.js";

const S = 1000;
const aqui = dirname(fileURLToPath(import.meta.url));
const nome = (e) => e.e;

/** observador com relógio/timer falsos; por padrão o buffer está ativo e o socket aberto */
function criar(extra = {}) {
  let t = 1_700_000_000_000; const eventos = []; const timers = []; const est = { buffer: true, aberto: true };
  const obs = criarObservadorOffline({
    agora: () => t, emitir: (n, e, d) => eventos.push({ n, e, d }), obterEpoch: () => 7,
    agendar: (fn, ms) => { const h = { fn, ms, cancelado: false, unref() {} }; timers.push(h); return h; }, cancelar: (h) => { h.cancelado = true; },
    ...extra,
  });
  const g = obs.novaGeracao({ lerBufferAtivo: () => est.buffer, lerSocketAberto: () => est.aberto });
  const api = {
    obs, g, eventos, timers, est,
    avancar: (ms) => { t += ms; },
    agora: () => t,
    tick: () => obs.tick(g),
    /** avança e dá um tick (o que o timer de 1 s faria); mantém a atividade do socket viva como o keep-alive faria */
    passar(ms) { t += ms; obs.aoAtividade(g); obs.tick(g); },
    preview: (no) => obs.aoPreview(g, no ?? { tag: "ib", attrs: {}, content: [{ tag: "offline_preview", attrs: { count: "100" } }] }),
    noOffline: (extra2 = {}) => obs.aoNo(g, { especie: "message", tipo: "direct_lid_other", offlineAttr: "1", t: String(Math.floor(t / 1000) - 3600), ...extra2 }),
    noVivo: () => obs.aoNo(g, { especie: "message", tipo: "direct_pn", offlineAttr: undefined, t: String(Math.floor(t / 1000)) }),
    upsert: (n = 1, buf = true) => { for (let i = 0; i < n; i++) obs.aoUpsert(g, buf); },
    porNome: (n) => eventos.filter((e) => e.e === n),
  };
  return api;
}

describe("classificações puras", () => {
  test("attrs.offline BRUTO: missing / empty / zero / one / other — o valor de `other` nunca sai", () => {
    const tabela = [[undefined, "missing"], [null, "missing"], ["", "empty"], ["0", "zero"], ["1", "one"], ["2", "other"], ["true", "other"], [" 1", "other"], ["01", "other"], [0, "zero"], [1, "one"], [true, "other"], [{}, "other"], [["1"], "other"]];
    for (const [v, esperado] of tabela) assert.equal(classificarAtributoOffline(v), esperado, JSON.stringify(v));
  });

  test("bucketIdade: fronteiras exatas, t ausente/inválido e relógio adiantado; o timestamp original nunca é devolvido", () => {
    const agora = 1_700_000_000_000;
    const t = (idadeMs) => String(Math.floor((agora - idadeMs) / 1000));
    assert.equal(bucketIdade(t(0), agora), "lt1m"); assert.equal(bucketIdade(t(59_000), agora), "lt1m");
    assert.equal(bucketIdade(t(60_000), agora), "m1a5"); assert.equal(bucketIdade(t(299_000), agora), "m1a5");
    assert.equal(bucketIdade(t(300_000), agora), "m5a30"); assert.equal(bucketIdade(t(30 * 60_000 - 1000), agora), "m5a30");
    assert.equal(bucketIdade(t(30 * 60_000), agora), "m30a120"); assert.equal(bucketIdade(t(119 * 60_000), agora), "m30a120");
    assert.equal(bucketIdade(t(120 * 60_000), agora), "h2a24"); assert.equal(bucketIdade(t(23 * 3600_000), agora), "h2a24");
    assert.equal(bucketIdade(t(24 * 3600_000), agora), "gt24h"); assert.equal(bucketIdade(t(400 * 24 * 3600_000), agora), "gt24h");
    for (const ausente of [undefined, null, ""]) assert.equal(bucketIdade(ausente, agora), "ausente");
    for (const ruim of ["abc", "12.5", "-5", "1e9", "99999999999999", { a: 1 }]) assert.equal(bucketIdade(ruim, agora), "invalido", JSON.stringify(ruim));
    assert.equal(bucketIdade(t(-100_000), agora), "lt1m", "relógio até 2 min adiantado");
    assert.equal(bucketIdade(t(-3_600_000), agora), "invalido", "1 h no futuro");
    assert.equal(bucketIdade(String(agora), agora), "invalido", "ms em vez de s");
    for (const r of ["", "5", "1700000000"]) assert.ok([...BUCKETS_IDADE].includes(bucketIdade(r || undefined, agora)));
  });
});

describe("sanitização EXPLÍCITA do offline_preview", () => {
  const no = (attrs, extra = {}) => ({ tag: "ib", attrs: {}, content: [{ tag: "offline_preview", attrs, ...extra }] });

  test("numéricos, booleanos e enum fechado saem com o valor; o resto NÃO", () => {
    const r = sanitizarAtributosPreview(no({ count: "180", message: "150", notification: "20", receipt: "10", appdata: "0", flag: "true", modo: "recent", vazio: "" }));
    const por = Object.fromEntries(r.atributos.map((a) => [a.nome, a]));
    assert.deepEqual(por.count, { nome: "count", classe: "numerico", valor: 180 });
    assert.deepEqual(por.appdata, { nome: "appdata", classe: "numerico", valor: 0 });
    assert.deepEqual(por.flag, { nome: "flag", classe: "booleano", valor: true });
    assert.deepEqual(por.modo, { nome: "modo", classe: "enum", valor: "recent" });
    assert.deepEqual(por.vazio, { nome: "vazio", classe: "desconhecido", tamanho: 0 });
    assert.equal(r.atributosIgnorados, 0);
  });

  test("identificador, telefone, timestamp, token e JID viram `sensivel` SEM valor; números grandes também", () => {
    const r = sanitizarAtributosPreview(no({ jid: "5511999990000@s.whatsapp.net", fone: "5511999990000", ts: "1700000000", tok: "abcdef0123456789ABCDEF", rec: "x:y", b64: "aGVsbG8gd29ybGQgZm9v", grande: "12345678", ok: "12345" }));
    const txt = JSON.stringify(r);
    for (const proibido of ["5511999990000", "s.whatsapp.net", "1700000000", "abcdef0123456789", "aGVsbG8g", "12345678"]) assert.ok(!txt.includes(proibido), `vazou ${proibido}`);
    const por = Object.fromEntries(r.atributos.map((a) => [a.nome, a]));
    for (const k of ["jid", "fone", "ts", "tok", "rec", "b64", "grande"]) { assert.equal(por[k].classe, "sensivel", k); assert.ok(!("valor" in por[k]), k); }
    assert.deepEqual(por.ok, { nome: "ok", classe: "numerico", valor: 12345 });
  });

  test("valor não numérico fora do vocabulário ⇒ `desconhecido` só com o tamanho (limitado a 64); nome fora do padrão ⇒ ignorado (nem o nome sai)", () => {
    const r = sanitizarAtributosPreview(no({ palavra: "qualquercoisa", "Nome-Ruim": "1", "com espaço": "2", "5511999990000@s.whatsapp.net": "3", ok2: "7" }));
    assert.deepEqual(r.atributos.map((a) => a.nome).sort(), ["ok2", "palavra"]);
    assert.equal(r.atributosIgnorados, 3);
    assert.deepEqual(r.atributos.find((a) => a.nome === "palavra"), { nome: "palavra", classe: "desconhecido", tamanho: 13 });
    assert.ok(!JSON.stringify(r).includes("5511999990000"));
  });

  test("no máximo 12 atributos; conta ignorados, filhos e atributos do nó ib; entrada lixo nunca lança", () => {
    const muitos = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`a${i}`, String(i)]));
    const r = sanitizarAtributosPreview({ tag: "ib", attrs: { x: "1" }, content: [{ tag: "offline_preview", attrs: muitos, content: [{ tag: "a" }, { tag: "b" }] }] });
    assert.equal(r.atributos.length, 12); assert.equal(r.atributosIgnorados, 8); assert.equal(r.filhos, 2); assert.equal(r.atributosNoIb, 1);
    for (const lixo of [undefined, null, 5, "x", [], {}, { content: "x" }, { content: [null, 1, "a"] }, { content: [{ tag: "offline_preview", attrs: null }] }, { content: [{ tag: "offline_preview", attrs: { a: {}, b: [1], c: () => 1, d: Symbol("x") } }] }]) {
      assert.doesNotThrow(() => sanitizarAtributosPreview(lixo));
    }
    assert.deepEqual(sanitizarAtributosPreview(null), { atributos: [], atributosIgnorados: 0, filhos: 0, atributosNoIb: 0 });
    assert.ok(ENUM_SEGURO.size > 0 && [...ENUM_SEGURO].every((v) => /^[a-z]{1,16}$/.test(v)), "vocabulário fechado e curto");
  });
});

describe("configuração", () => {
  test("recusa limites incoerentes (estagnação ≥ keep-alive; teto ≤ estagnação; ≤ 0)", () => {
    assert.throws(() => criarObservadorOffline({ emitir() {}, stallDetectionMs: 0 }), RangeError);
    assert.throws(() => criarObservadorOffline({ emitir() {}, stallDetectionMs: 30_000, absoluteMaxOfflineMs: 30_000 }), RangeError);
    assert.throws(() => criarObservadorOffline({ emitir() {}, stallDetectionMs: 36_000, absoluteMaxOfflineMs: 180_000 }), RangeError, "≥ 35 s: o Baileys derrubaria o socket antes do veredito");
    assert.throws(() => criarObservadorOffline({ emitir() {}, tickMs: 0 }), RangeError);
    assert.doesNotThrow(() => criarObservadorOffline({ emitir() {} }));
    assert.deepEqual([PADROES.stallDetectionMs, PADROES.absoluteMaxOfflineMs, PADROES.heartbeatMs, PADROES.tickMs], [30_000, 180_000, 60_000, 1_000]);
  });
});

describe("máquina de estados diagnóstica", () => {
  test("estado inicial CONNECTING; preview entra em OFFLINE_LOADING (gatilho registrado); nó offline também; timer só depois", () => {
    const a = criar();
    assert.equal(a.obs.estado().fase, FASE.CONNECTING); assert.equal(a.timers.length, 0, "sem fase offline não há timer");
    a.preview();
    assert.equal(a.obs.estado().fase, FASE.OFFLINE_LOADING); assert.equal(a.obs.estado().gatilho, "preview"); assert.equal(a.timers.length, 1);
    assert.equal(a.timers[0].ms, PADROES.tickMs);
    const b = criar(); b.noOffline();
    assert.equal(b.obs.estado().fase, FASE.OFFLINE_LOADING); assert.equal(b.obs.estado().gatilho, "no_offline");
    const c = criar(); c.noVivo();
    assert.equal(c.obs.estado().fase, FASE.CONNECTING, "nó vivo NÃO entra na fase offline"); assert.equal(c.obs.estado().nosVivos, 1);
  });

  test("A. FLUXO NORMAL: preview → nós → marcador em < 30 s ⇒ LIVE; nenhum stalled; timer cancelado; marcador registra as retidas que o flush oficial vai liberar", () => {
    const a = criar();
    a.preview(); for (let i = 0; i < 100; i++) a.noOffline(); a.upsert(90);
    a.passar(10 * S); a.obs.aoMarcador(a.g, 100);
    const e = a.obs.estado(); assert.equal(e.fase, FASE.LIVE); assert.equal(e.fim, true);
    a.est.buffer = false; a.obs.aoFlush(a.g, true);       // o flush oficial que o Baileys faz
    a.passar(10 * 60 * S);
    assert.equal(a.porNome("inbound.offline_stalled_observed").length, 0);
    assert.ok(a.timers.every((h) => h.cancelado), "timer cancelado ao virar LIVE");
    const m = a.porNome("inbound.offline_state").find((x) => x.d.gatilho === "marcador").d;
    assert.deepEqual([m.marcadorTardio, m.retidasAntesDoFlush, m.offlineFimContagem, m.fase], [false, 90, 100, "LIVE"]);
    assert.equal(a.obs.estado().flushesSemMarcador, 0, "o flush veio do marcador");
    assert.equal(a.porNome("inbound.offline_state").filter((x) => x.d.gatilho === "heartbeat").length, 0, "nenhum heartbeat em LIVE");
  });

  test("B. SEM MARCADOR: 29 s de silêncio não dispara; 30 s dispara UM inbound.offline_stalled_observed com o payload completo; ticks seguintes não repetem", () => {
    const a = criar();
    a.preview(); a.passar(0); for (let i = 0; i < 102; i++) a.noOffline(); a.upsert(80);
    a.passar(29 * S); assert.equal(a.porNome("inbound.offline_stalled_observed").length, 0);
    a.passar(1 * S);
    const ev = a.porNome("inbound.offline_stalled_observed"); assert.equal(ev.length, 1);
    const d = ev[0].d;
    assert.deepEqual(
      [d.socketGeneration, d.epoch, d.stallReason, d.secondsSinceProgress, d.secondsSinceOfflineStart, d.bufferAtivo, d.mensagensRetidas, d.offlinePreviewRecebido, d.offlineFimRecebido, d.nosOfflineVistos, d.nosVivosVistos, d.socketHealthy, d.entrada, d.limiteSemProgressoSegundos, d.limiteAbsolutoSegundos, d.RECOVERY_PATH_USED, d.observeOnly],
      [1, 7, "no_progress", 30, 30, true, 80, 1, false, 102, 0, true, 1, 30, 180, false, true],
    );
    assert.equal(a.obs.estado().fase, FASE.OFFLINE_STALLED_OBSERVED); assert.equal(a.obs.estado().observeWouldRecover, true);
    for (let i = 0; i < 20; i++) a.passar(1 * S);
    assert.equal(a.porNome("inbound.offline_stalled_observed").length, 1, "UMA vez por entrada, não a cada tick");
    assert.equal(a.obs.metricas().stallEventos, 1);
  });

  test("B2. o gatilho vale a partir do ÚLTIMO progresso, não do início (progresso = preview, nó, mensagem enfileirada, batch, flush efetivo, marcador)", () => {
    const a = criar();
    a.preview(); a.noOffline(); a.upsert(3); a.passar(20 * S); a.upsert(1);          // enfileirada há 0 s
    a.passar(29 * S); assert.equal(a.porNome("inbound.offline_stalled_observed").length, 0, "29 s desde a última enfileirada");
    a.passar(1 * S); assert.equal(a.porNome("inbound.offline_stalled_observed").length, 1);
  });

  test("B3. um 2º offline_preview é PROGRESSO (reinicia o relógio de silêncio) e também é contado como 2º batch inferido", () => {
    const a = criar(); a.preview(); a.upsert(3); a.passar(25 * S); a.preview();
    a.passar(20 * S); assert.equal(a.porNome("inbound.offline_stalled_observed").length, 0, "45 s desde o 1º preview, mas só 20 s desde o 2º");
    a.passar(10 * S); assert.equal(a.porNome("inbound.offline_stalled_observed").length, 1);
    assert.deepEqual([a.obs.estado().previews, a.obs.estado().batchesInferidos], [2, 2]);
    assert.deepEqual(a.porNome("inbound.offline_preview").map((x) => x.d.ordem), [1, 2]);
  });

  test("C. PROGRESSO REINICIA O RELÓGIO: um nó a cada 20 s nunca dispara no_progress", () => {
    const a = criar();
    a.preview(); a.upsert(2);
    for (let i = 0; i < 8; i++) { a.passar(20 * S); a.noOffline(); }
    assert.equal(a.porNome("inbound.offline_stalled_observed").length, 0);
    assert.equal(a.obs.estado().fase, FASE.OFFLINE_LOADING);
  });

  test("D. TETO ABSOLUTO: progresso lento contínuo por > 180 s dispara absolute_max (sem flush, só evento)", () => {
    const a = criar();
    a.preview(); a.upsert(2);
    let n = 0; while (a.porNome("inbound.offline_stalled_observed").length === 0 && n++ < 40) { a.passar(20 * S); a.noOffline(); }
    const ev = a.porNome("inbound.offline_stalled_observed"); assert.equal(ev.length, 1);
    assert.equal(ev[0].d.stallReason, "absolute_max"); assert.ok(ev[0].d.secondsSinceOfflineStart >= 180 && ev[0].d.secondsSinceProgress < 30);
  });

  test("condição base: sem buffer ativo, sem retidas, com marcador ou socket não saudável NÃO dispara (e o socket não saudável é contado)", () => {
    for (const [nomeCaso, mexer] of [
      ["buffer inativo", (a) => { a.est.buffer = false; }],
      ["nada retido", () => {}],
      ["socket fechado", (a) => { a.est.aberto = false; }],
    ]) {
      const a = criar(); a.preview(); a.noOffline(); if (nomeCaso !== "nada retido") a.upsert(5); mexer(a);
      a.passar(60 * S);
      assert.equal(a.porNome("inbound.offline_stalled_observed").length, 0, nomeCaso);
      assert.equal(a.obs.estado().fase, FASE.OFFLINE_LOADING, nomeCaso);
    }
    const s = criar(); s.preview(); s.upsert(5); s.est.aberto = false; s.passar(60 * S);
    assert.ok(s.obs.estado().ticksAdiadosPorSaude >= 1, "teria disparado, mas o socket não estava saudável");
    s.est.aberto = true; s.passar(1 * S); assert.equal(s.porNome("inbound.offline_stalled_observed").length, 1, "voltou a ser saudável ⇒ decide");
  });

  test("saúde do socket exige atividade recente (< 35 s): silêncio total ≥ 35 s = não saudável; um frame restaura", () => {
    const a = criar(); a.preview(); a.upsert(4);
    a.avancar(36 * S); a.tick();                                                    // sem aoAtividade: o Baileys estaria derrubando esse socket
    assert.equal(a.porNome("inbound.offline_stalled_observed").length, 0); assert.equal(a.obs.estado().socketHealthy, false);
    a.obs.aoAtividade(a.g); a.tick();
    assert.equal(a.porNome("inbound.offline_stalled_observed").length, 1);
  });

  test("E. SOCKET FECHA ANTES: timer cancelado, retidas perdidas registradas UMA vez, eventos tardios daquela geração ignorados", () => {
    const a = criar(); a.preview(); a.noOffline(); a.upsert(6); a.passar(5 * S);
    a.obs.aoFechado(a.g);
    assert.equal(a.obs.estado().fase, FASE.CLOSED); assert.ok(a.timers.every((h) => h.cancelado));
    const fech = a.porNome("inbound.offline_state").filter((x) => x.d.gatilho === "fechamento"); assert.equal(fech.length, 1);
    assert.equal(fech[0].d.retidasPerdidas, 6); assert.equal(a.obs.metricas().retidasPerdidas, 6);
    const antes = a.eventos.length;
    a.avancar(10 * 60 * S); a.tick(); a.noOffline(); a.upsert(5); a.obs.aoMarcador(a.g, 9); a.obs.aoFlush(a.g, true); a.obs.aoPreview(a.g, null); a.obs.aoFechado(a.g);
    assert.equal(a.eventos.length, antes, "nenhum evento tardio");
    assert.equal(a.obs.metricas().retidasPerdidas, 6, "não conta duas vezes");
  });

  test("F. SOCKET ANTIGO: nova geração fecha a anterior; callbacks tardios da geração 1 são ignorados e a 2 fica intacta", () => {
    const a = criar(); const g1 = a.g;
    a.preview(); a.noOffline(); a.upsert(4);
    const g2 = a.obs.novaGeracao({ lerBufferAtivo: () => true, lerSocketAberto: () => true });
    assert.equal(g2, 2); assert.equal(a.obs.estado().socketGeneration, 2); assert.equal(a.obs.estado().fase, FASE.CONNECTING);
    assert.equal(a.obs.metricas().retidasPerdidas, 4, "as 4 morreram com o buffer da geração 1");
    assert.ok(a.timers[0].cancelado, "timer da geração 1 cancelado");
    const antes = a.eventos.length;
    a.avancar(5 * 60 * S);
    a.obs.tick(g1); a.obs.aoNo(g1, { especie: "message", tipo: "group", offlineAttr: "1" }); a.obs.aoUpsert(g1, true); a.obs.aoMarcador(g1, 3); a.obs.aoFlush(g1, true); a.obs.aoPreview(g1, null); a.obs.aoAtividade(g1);
    a.obs.aoFechado(g1);                                                       // o fechamento TARDIO do socket velho não pode fechar o novo
    assert.equal(a.eventos.length, antes); const e = a.obs.estado();
    assert.deepEqual([e.socketGeneration, e.fase, e.nosOffline, e.retidas, e.previews, e.fim], [2, FASE.CONNECTING, 0, 0, 0, false]);
    a.obs.aoNo(g2, { especie: "message", tipo: "group", offlineAttr: "1" }); assert.equal(a.obs.estado().nosOffline, 1);
    assert.equal(a.eventos.filter((x) => x.e === "inbound.offline_state" && x.d.gatilho === "fechamento").length, 1, "a geração 1 emitiu o fechamento (presa) uma vez");
  });

  test("G. CORRIDA marcador × watchdog: qualquer ordem termina em estado determinístico e NUNCA registra recuperação usada", () => {
    // (i) marcador ANTES do tick
    let a = criar(); a.preview(); a.upsert(10); a.avancar(31 * S); a.obs.aoMarcador(a.g, 10); a.tick();
    assert.equal(a.obs.estado().fase, FASE.LIVE); assert.equal(a.porNome("inbound.offline_stalled_observed").length, 0);
    // (ii) tick ANTES do marcador ("tardio")
    a = criar(); a.preview(); a.upsert(10); a.avancar(31 * S); a.tick(); a.obs.aoMarcador(a.g, 10);
    assert.equal(a.obs.estado().fase, FASE.LIVE); assert.equal(a.porNome("inbound.offline_stalled_observed").length, 1);
    assert.equal(a.porNome("inbound.offline_state").find((x) => x.d.gatilho === "marcador").d.marcadorTardio, true);
    // (iii) mesmo instante, tick depois do marcador: sem stalled
    a = criar(); a.preview(); a.upsert(10); a.avancar(30 * S); a.obs.aoMarcador(a.g, 10); a.tick(); a.tick();
    assert.equal(a.porNome("inbound.offline_stalled_observed").length, 0);
    for (const x of a.eventos) if ("RECOVERY_PATH_USED" in x.d) assert.equal(x.d.RECOVERY_PATH_USED, false);
    for (const x of a.eventos) if ("observeOnly" in x.d) assert.equal(x.d.observeOnly, true);
  });

  test("H. NÓ VIVO: não é progresso nem fim; o flush que ele provoca no Baileys é REGISTRADO à parte (uma vez) e o watchdog não interfere", () => {
    const a = criar(); a.preview(); a.noOffline(); a.upsert(7);
    a.passar(20 * S); a.noVivo(); a.passar(9 * S);
    assert.equal(a.obs.estado().nosVivos, 1); assert.equal(a.porNome("inbound.offline_stalled_observed").length, 0, "nó vivo não conta como progresso, mas 29 s ainda < 30 s");
    a.est.buffer = false; a.obs.aoFlush(a.g, true);                        // o flush nativo (processNodeWithBuffer) que o nó vivo provocou
    const e = a.obs.estado(); assert.deepEqual([e.flushesSemMarcador, e.retidas, e.fase, e.fim], [1, 0, FASE.OFFLINE_LOADING, false]);
    assert.equal(a.porNome("inbound.offline_state").filter((x) => x.d.gatilho === "flush_sem_marcador").length, 1);
    a.est.buffer = true; a.upsert(2); a.obs.aoFlush(a.g, true);
    assert.equal(a.porNome("inbound.offline_state").filter((x) => x.d.gatilho === "flush_sem_marcador").length, 1, "só o 1º vira evento");
    a.passar(60 * S); assert.equal(a.porNome("inbound.offline_stalled_observed").length, 0, "nada retido ⇒ nada a observar");
  });

  test("I. attrs.offline: só BUCKETS por espécie (\"0\" também conta como offline, como no Baileys) — a decisão do Baileys não é tocada", () => {
    const a = criar();
    for (const v of ["1", "0", "", undefined, "7", null]) a.obs.aoNo(a.g, { especie: "message", tipo: "group", offlineAttr: v, t: undefined });
    a.obs.aoNo(a.g, { especie: "receipt", tipo: "group", offlineAttr: "0" }); a.obs.aoNo(a.g, { especie: "notification", tipo: "technical", offlineAttr: "1" });
    const e = a.obs.estado();
    assert.deepEqual(e.attrOffline.message, { missing: 2, empty: 1, zero: 1, one: 1, other: 1 });
    assert.deepEqual(e.attrOffline.receipt, { missing: 0, empty: 0, zero: 1, one: 0, other: 0 });
    assert.deepEqual(e.attrOffline.notification, { missing: 0, empty: 0, zero: 0, one: 1, other: 0 });
    assert.equal(e.nosOffline, 5, "\"1\", \"0\", \"7\" (mensagens) + recibo \"0\" + notificação \"1\": truthy = offline"); assert.equal(e.nosVivos, 3, "\"\", ausente e null = vivo");
    assert.ok(!JSON.stringify(e.attrOffline).includes("\"7\""), "o valor de `other` não é guardado");
  });

  test("o `tipo` agregado é sempre vocabulário fechado: um JID (ou lixo) vira 'unknown' e NUNCA aparece nos eventos; no máximo 16 tipos distintos", () => {
    const a = criar();
    for (const ruim of ["5511999990000@s.whatsapp.net", "100000000000001@lid", "Grupo-1", "a1", "x".repeat(40), 5, null, undefined, { jid: "x" }]) a.obs.aoNo(a.g, { especie: "message", tipo: ruim, offlineAttr: "1" });
    a.obs.aoNo(a.g, { especie: "message", tipo: "direct_lid_other", offlineAttr: "1" });
    assert.deepEqual(a.obs.estado().porTipo, { unknown: 9, direct_lid_other: 1 });
    for (let i = 0; i < 40; i++) a.obs.aoNo(a.g, { especie: "message", tipo: `tipo_${String.fromCharCode(97 + (i % 26))}x`, offlineAttr: "1" });
    assert.ok(Object.keys(a.obs.estado().porTipo).length <= 17, "teto de tipos distintos (16 + unknown)");
    const linha = JSON.stringify(a.obs.estado().porTipo); assert.ok(!/@|\d{5,}|Grupo/.test(linha), linha);
    a.preview(); a.noOffline(); a.passar(31 * S);
    const txt = JSON.stringify(a.eventos.map((x) => x.d)); assert.ok(!/@s\.whatsapp|@lid|5511999990000|Grupo-1/.test(txt), "nenhum identificador nos eventos");
  });

  test("idade das mensagens: buckets por origem (offline × vivo), só para mensagens; nada de timestamp", () => {
    const a = criar(); const agoraS = Math.floor(a.agora() / 1000);
    a.obs.aoNo(a.g, { especie: "message", tipo: "group", offlineAttr: "1", t: String(agoraS - 30) });
    a.obs.aoNo(a.g, { especie: "message", tipo: "group", offlineAttr: "1", t: String(agoraS - 400) });
    a.obs.aoNo(a.g, { especie: "message", tipo: "group", offlineAttr: "1", t: String(agoraS - 3 * 86400) });
    a.obs.aoNo(a.g, { especie: "message", tipo: "group", offlineAttr: "1" });
    a.obs.aoNo(a.g, { especie: "message", tipo: "group", offlineAttr: undefined, t: String(agoraS - 10) });
    a.obs.aoNo(a.g, { especie: "receipt", tipo: "group", offlineAttr: "1", t: String(agoraS - 10) });      // recibo: não entra na idade
    const i = a.obs.estado().idade;
    assert.deepEqual([i.offline.lt1m, i.offline.m5a30, i.offline.gt24h, i.offline.ausente, i.vivo.lt1m], [1, 1, 1, 1, 1]);
    assert.equal(Object.values(i.offline).reduce((x, y) => x + y, 0), 4); assert.equal(Object.values(i.vivo).reduce((x, y) => x + y, 0), 1);
  });

  test("marcos: 1º e 100º nó offline emitem UM evento cada (com T+ desde o socket e desde o preview), sem spam; o último nó só existe como offlineLastProgressAt", () => {
    const a = criar(); a.avancar(2 * S); a.preview(); a.avancar(3 * S);
    for (let i = 0; i < 150; i++) { a.noOffline(); if (i === 60) a.avancar(1 * S); }
    const m = a.porNome("inbound.offline_node_progress"); assert.equal(m.length, 2);
    assert.deepEqual(m.map((x) => x.d.milestone), [1, 100]);
    assert.deepEqual([m[0].d.offlineNodes, m[0].d.sinceSocketMs, m[0].d.sincePreviewMs], [1, 5000, 3000]);
    assert.deepEqual([m[1].d.offlineNodes, m[1].d.sinceSocketMs, m[1].d.sincePreviewMs], [100, 6000, 4000]);
    assert.ok(m[1].d.tiposAgregados.some((t) => t.nome === "direct_lid_other" && t.n === 100));
    assert.equal(a.obs.estado().offlineLastProgressAt, a.agora(), "expõe o instante do último progresso, sem inventar 'último nó'");
    assert.equal(a.eventos.filter((x) => /ultimo|last_node|ultimo_no/.test(x.e)).length, 0);
    const b = criar({ marcos: [1, 3, 5] }); for (let i = 0; i < 6; i++) b.noOffline();
    assert.deepEqual(b.porNome("inbound.offline_node_progress").map((x) => x.d.milestone), [1, 3, 5], "marcos configuráveis");
  });

  test("RETOMADA: progresso depois do stall volta a OFFLINE_LOADING; travar de novo é NOVA entrada e novo evento; teto por geração", () => {
    const a = criar({ maxEventosStallPorGeracao: 2 }); a.preview(); a.upsert(5);
    a.passar(31 * S); assert.equal(a.obs.estado().fase, FASE.OFFLINE_STALLED_OBSERVED);
    a.noOffline();
    assert.equal(a.obs.estado().fase, FASE.OFFLINE_LOADING); assert.equal(a.obs.estado().retomadas, 1);
    assert.equal(a.porNome("inbound.offline_state").filter((x) => x.d.gatilho === "retomada").length, 1);
    a.passar(31 * S); assert.equal(a.porNome("inbound.offline_stalled_observed").length, 2); assert.equal(a.porNome("inbound.offline_stalled_observed")[1].d.entrada, 2);
    a.noOffline(); a.passar(31 * S);
    assert.equal(a.obs.estado().stallEntradas, 3, "a 3ª entrada é contada");
    assert.equal(a.porNome("inbound.offline_stalled_observed").length, 2, "mas o evento respeita o teto por geração");
    assert.equal(a.obs.metricas().stallEventos, 2);
  });

  test("HEARTBEAT `inbound.offline_state` a cada 60 s SÓ em OFFLINE_LOADING/OFFLINE_STALLED_OBSERVED; enxuto; observeWouldRecover reflete a decisão", () => {
    const a = criar(); a.preview(); a.upsert(3);
    for (let i = 0; i < 59; i++) a.passar(1 * S);
    assert.equal(a.porNome("inbound.offline_state").filter((x) => x.d.gatilho === "heartbeat").length, 0, "antes de 60 s: nenhum");
    a.passar(1 * S);
    const hb = a.porNome("inbound.offline_state").filter((x) => x.d.gatilho === "heartbeat"); assert.equal(hb.length, 1);
    const d = hb[0].d;
    assert.deepEqual([d.fase, d.segundosDesdeInicioOffline, d.segundosDesdeProgresso, d.mensagensRetidas, d.nosOfflineVistos, d.nosVivosVistos, d.offlineFimRecebido, d.observeWouldRecover, d.observeOnly, d.RECOVERY_PATH_USED],
      ["OFFLINE_STALLED_OBSERVED", 60, 60, 3, 0, 0, false, true, true, false]);
    assert.ok(!("attrOffline" in d) && !("idade" in d), "heartbeat enxuto");
    for (let i = 0; i < 60; i++) a.passar(1 * S);
    assert.equal(a.porNome("inbound.offline_state").filter((x) => x.d.gatilho === "heartbeat").length, 2, "1 por minuto");
    const antesLive = a.porNome("inbound.offline_state").length; a.obs.aoMarcador(a.g, 3); for (let i = 0; i < 120; i++) a.passar(1 * S);
    assert.equal(a.porNome("inbound.offline_state").length, antesLive + 1, "só o evento do marcador; sem heartbeat em LIVE");
    const ok = criar(); ok.preview(); ok.noOffline(); ok.avancar(20 * S); ok.obs.aoAtividade(ok.g);
    assert.equal(ok.obs.estado().observeWouldRecover, false);
  });

  test("timer: um só por geração, tick de 1 s, unref, cancelado em LIVE e em CLOSED", () => {
    const a = criar(); a.preview(); a.noOffline(); a.upsert(2); a.preview();
    assert.equal(a.timers.length, 1); assert.equal(a.timers[0].ms, 1000); assert.equal(a.timers[0].cancelado, false);
    a.timers[0].fn(); a.timers[0].fn();                                           // o timer real chama tick(g) internamente
    const b = criar(); b.preview(); b.obs.aoMarcador(b.g, 1); assert.ok(b.timers.every((h) => h.cancelado));
  });
});

describe("eventos: segurança (logsafe real) e esquema fechado", () => {
  function cenarioCompleto() {
    const a = criar();
    a.preview({ tag: "ib", attrs: {}, content: [{ tag: "offline_preview", attrs: { count: "180", message: "150", jid: "5511999990000@s.whatsapp.net", fone: "5511999990000", tok: "abcdef0123456789ABCDEF" } }] });
    for (let i = 0; i < 101; i++) a.obs.aoNo(a.g, { especie: "message", tipo: i % 2 ? "group" : "direct_lid_other", offlineAttr: i % 3 === 0 ? "0" : "1", t: String(Math.floor(a.agora() / 1000) - 120) });
    a.obs.aoNo(a.g, { especie: "receipt", tipo: "direct_pn", offlineAttr: "1" }); a.noVivo();
    a.upsert(90); a.passar(31 * S); for (let i = 0; i < 61; i++) a.passar(1 * S);
    a.noOffline(); a.est.buffer = false; a.obs.aoFlush(a.g, true); a.obs.aoMarcador(a.g, 5); a.obs.aoFechado(a.g);
    return a;
  }
  const PROIBIDOS = ["5511999990000", "s.whatsapp.net", "abcdef0123456789", "@lid", "@g.us", "TESTMSG", "remoteJid", "participant"];

  test("nenhum identificador nas linhas de log (passando pelo logsafe REAL) e nenhum campo é mascarado", () => {
    const a = cenarioCompleto();
    assert.ok(a.eventos.length >= 8);
    for (const x of a.eventos) {
      const linha = JSON.stringify(sanitizar({ evento: x.e, ...x.d }));
      for (const p of PROIBIDOS) assert.ok(!linha.includes(p), `${x.e} vazou ${p}`);
      assert.ok(!/\d{9,}/.test(linha), `${x.e}: número longo`);
      assert.ok(!linha.includes("REDACTED"), `${x.e}: campo mascarado: ${linha}`);
    }
  });

  test("todo valor emitido é número, booleano, null ou vocabulário fechado (fase, gatilho, motivo, tipo, classe, bucket, especie, origem)", () => {
    const a = cenarioCompleto();
    const fechado = new Set([...Object.values(FASE), "heartbeat", "marcador", "fechamento", "retomada", "flush_sem_marcador", "no_progress", "absolute_max", "preview",
      "numerico", "booleano", "enum", "sensivel", "desconhecido", "message", "receipt", "notification", "offline", "vivo", ...BUCKETS_IDADE,
      "missing", "empty", "zero", "one", "other", "count", "message", "jid", "fone", "tok", "direct_pn", "direct_lid_other", "group", "inbound.offline_state",
      // C.9.7: histograma de valores (tipo int|classe; classes fechadas; grupos grossos de idade)
      "int", "classe", ...CLASSES_VALOR_OFFLINE, "lt2h", "sem"]);
    const visitar = (v, caminho) => {
      if (v === null || typeof v === "number" || typeof v === "boolean") return;
      if (typeof v === "string") { assert.ok(fechado.has(v), `string fora do vocabulário em ${caminho}: ${v}`); return; }
      if (Array.isArray(v)) { v.forEach((x, i) => visitar(x, `${caminho}[${i}]`)); return; }
      for (const [k, x] of Object.entries(v)) visitar(x, `${caminho}.${k}`);
    };
    for (const x of a.eventos) visitar(x.d, x.e);
  });

  test("esquema fechado dos eventos novos: só estas chaves (campo novo exige decisão explícita)", () => {
    const a = cenarioCompleto();
    const chaves = (e) => Object.keys(a.porNome(e)[0].d).sort();
    assert.deepEqual(chaves("inbound.offline_preview"), ["atributos", "atributosIgnorados", "atributosNoIb", "epoch", "fase", "filhos", "ordem", "sinceSocketMs", "socketGeneration"]);
    assert.deepEqual(chaves("inbound.offline_node_progress"), ["attrOffline", "attrOfflineValores", "epoch", "especies", "fase", "idade", "milestone", "offlineNodes", "sincePreviewMs", "sinceSocketMs", "socketGeneration", "tiposAgregados"]);
    assert.deepEqual(chaves("inbound.offline_stalled_observed"), ["RECOVERY_PATH_USED", "attrOffline", "attrOfflineValores", "bufferAtivo", "entrada", "epoch", "especies", "idade", "limiteAbsolutoSegundos", "limiteSemProgressoSegundos", "mensagensRetidas", "nosOfflineVistos", "nosVivosVistos", "observeOnly", "offlineFimRecebido", "offlinePreviewRecebido", "secondsSinceOfflineStart", "secondsSinceProgress", "socketGeneration", "socketHealthy", "stallReason", "tiposAgregados"]);
    const hb = a.porNome("inbound.offline_state").find((x) => x.d.gatilho === "heartbeat").d;
    assert.deepEqual(Object.keys(hb).sort(), ["RECOVERY_PATH_USED", "bufferAtivo", "epoch", "fase", "flushes", "flushesEfetivos", "flushesSemMarcador", "gatilho", "mensagensRetidas", "nosOfflineVistos", "nosVivosVistos", "observeOnly", "observeWouldRecover", "offlineFimRecebido", "offlinePreviewRecebido", "retomadas", "segundosDesdeAbertura", "segundosDesdeInicioOffline", "segundosDesdeProgresso", "socketGeneration", "socketHealthy", "stallEntradas"]);
  });

  test("um `emitir` que lança nunca interfere no observador (as transições continuam)", () => {
    const a = criar({ emitir: () => { throw new Error("log caiu"); } });
    assert.doesNotThrow(() => { a.preview(); a.noOffline(); a.upsert(3); a.passar(31 * S); a.obs.aoMarcador(a.g, 1); a.obs.aoFechado(a.g); });
    assert.equal(a.obs.estado().fase, FASE.CLOSED);
    const b = criar({ obterEpoch: () => { throw new Error("x"); } }); assert.doesNotThrow(() => { b.preview(); b.noOffline(); });
  });
});

describe("wiring em criarInboundGateway (sockets falsos): frame como prova de vida; observador só com o diagnóstico", () => {
  async function comSocket({ diag = true, observe = true } = {}) {
    const { EventEmitter } = await import("node:events");
    const { criarInboundGateway } = await import("../src/inboundScope.js");
    let t = 1_700_000_000_000; const eventos = []; const timers = [];
    const inbound = criarInboundGateway({
      diagHabilitado: diag, offlineObserve: observe, agora: () => t, emitir: (n, e, d) => eventos.push({ e, d }), consoleAlvo: { error() {} },
      agendar: (fn, ms) => { const h = { fn, ms, unref() {} }; timers.push(h); return h; }, cancelar() {},
    });
    const ws = new EventEmitter(); ws.isOpen = true; const ev = new EventEmitter(); ev.isBuffering = () => true;
    inbound.observarSocket({ ws, ev, user: null });
    const tickObserve = () => timers.find((h) => h.ms === 1000)?.fn();
    return { inbound, ws, ev, eventos, avancar: (ms) => { t += ms; }, tickObserve, timers };
  }

  test("W5. um FRAME recebido prova que o socket está vivo: sem frames por ≥ 35 s o socket é 'não saudável' e o stall não é declarado; com frames, é", async () => {
    for (const [comFrame, esperado] of [[true, 1], [false, 0]]) {
      const c = await comSocket();
      c.ws.emit("CB:ib,,offline_preview", { tag: "ib", attrs: {}, content: [{ tag: "offline_preview", attrs: { count: "9" } }] });
      c.ev.emit("messages.upsert", { messages: [{ key: { remoteJid: "120363000000000001@g.us", id: "A" } }], type: "append" });
      c.avancar(20_000); if (comFrame) c.ws.emit("frame", {});
      c.avancar(20_000); c.tickObserve();
      assert.equal(c.eventos.filter((x) => x.e === "inbound.offline_stalled_observed").length, esperado, comFrame ? "frame há 20 s ⇒ saudável" : "40 s de silêncio total ⇒ o Baileys estaria derrubando o socket");
      c.inbound.parar();
    }
  });

  test("W17. o observador só existe com o DIAGNÓSTICO ligado (sem ele, offlineObserve é ignorado); com ambos, expõe estado", async () => {
    const semDiag = await comSocket({ diag: false, observe: true });
    assert.equal(semDiag.inbound.offlineObserve, false); assert.equal(semDiag.inbound.estadoObserve(), undefined); assert.equal(semDiag.inbound.metricasObserve(), undefined);
    const off = await comSocket({ diag: true, observe: false });
    assert.equal(off.inbound.offlineObserve, false); assert.equal(off.inbound.estadoObserve(), undefined);
    const on = await comSocket({ diag: true, observe: true });
    assert.equal(on.inbound.offlineObserve, true); assert.equal(on.inbound.estadoObserve().fase, "CONNECTING");
    for (const c of [semDiag, off, on]) c.inbound.parar();
  });
});

describe("GUARDA ESTRUTURAL: o observador é incapaz de fazer flush / mexer no buffer / enviar / encaminhar", () => {
  const fonte = readFileSync(join(aqui, "..", "src", "offlineObserve.js"), "utf8").replace(/\r\n/g, "\n");
  const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  test("o arquivo não importa nada (nem o Baileys) e não referencia ev/ws/socket", () => {
    assert.ok(!/^\s*import\s/m.test(codigo) && !/\brequire\s*\(/.test(codigo), "sem imports");
    assert.ok(!/\b(ev|ws|socket|sock)\b\s*[.?\[]/.test(codigo), "nenhum acesso a ev/ws/socket");
  });

  test("nenhuma chamada a flush/buffer/emit/sendNode/sendMessage/end/close/query/relayMessage — só `emitir` injetado", () => {
    assert.ok(!/(?<![A-Za-z])flush\s*\(/i.test(codigo), "nenhum flush(...) (aoFlush é só um método de registro)");
    for (const proibido of [/\.buffer\s*\(/, /\.emit\s*\(/, /sendNode/, /sendMessage/, /\.end\s*\(/, /\.close\s*\(/, /relayMessage/, /\.query\s*\(/, /readMessages/, /offline_batch/, /createBufferedFunction/, /notificarMensagemRecebida/, /fetch\s*\(/]) {
      assert.ok(!proibido.test(codigo), `token proibido: ${proibido}`);
    }
  });

  test("as únicas funções externas chamadas são as injetadas: emitir, obterEpoch, agendar/cancelar, lerBufferAtivo/lerSocketAberto (leitura)", () => {
    const chamadas = new Set([...codigo.matchAll(/\b([a-zA-Z_]\w*)\s*\(/g)].map((m) => m[1]));
    const externas = ["emitir", "obterEpoch", "agendar", "cancelar", "lerBufferAtivo", "lerSocketAberto"];
    for (const e of ["emitir", "obterEpoch", "agendar", "cancelar"]) assert.ok(chamadas.has(e), `deveria usar a função injetada ${e}`);
    for (const c of ["flush", "buffer", "emit", "send", "sendNode", "end", "close"]) assert.ok(!chamadas.has(c), c);
  });

  describe("o WIRING em inboundScope.js também é só leitura/registro", () => {
    const wiring = readFileSync(join(aqui, "..", "src", "inboundScope.js"), "utf8").replace(/\r\n/g, "\n");
    const semComentarios = wiring.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    test("toda chamada ao observador é um método de REGISTRO/leitura da lista fechada (nenhum método capaz de agir)", () => {
      const usados = new Set([...semComentarios.matchAll(/\bobservador\??\.(\w+)/g)].map((m) => m[1]));
      const permitidos = new Set(["novaGeracao", "aoAtividade", "aoPreview", "aoNo", "aoUpsert", "aoFlush", "aoMarcador", "aoFechado", "estado", "metricas", "parar"]);
      for (const u of usados) assert.ok(permitidos.has(u), `método inesperado do observador: ${u}`);
      assert.ok(usados.size >= 8);
    });

    test("os leitores entregues ao observador (lerBufferAtivo/lerSocketAberto) só LEEM: ev.isBuffering() e ws.isOpen", () => {
      const i = semComentarios.indexOf("novaGeracao({"); assert.ok(i > 0);
      const bloco = semComentarios.slice(i, semComentarios.indexOf("});", i) + 3);
      assert.ok(/ev\.isBuffering\(\)/.test(bloco) && /ws\?\.isOpen/.test(bloco));
      for (const proibido of [/flush/i, /\.buffer\s*\(/, /\.emit\s*\(/, /sendNode/, /\.end\s*\(/, /\.close\s*\(/]) assert.ok(!proibido.test(bloco), `leitor não pode conter ${proibido}`);
    });

    test("o listener do marcador (prepend) só chama observador.aoMarcador; e nenhum novo ev.flush()/ev.buffer() direto foi introduzido", () => {
      const i = semComentarios.indexOf("const antesDoMarcador"); assert.ok(i > 0);
      const bloco = semComentarios.slice(i, semComentarios.indexOf("prependListener", i));   // só o corpo do handler
      assert.ok(/observador\.aoMarcador\(/.test(bloco) && !/flush|buffer\(|\.emit\(/.test(bloco));
      assert.ok(!/\bev\.flush\s*\(/.test(semComentarios) && !/\bev\.buffer\s*\(/.test(semComentarios));
    });
  });
});
