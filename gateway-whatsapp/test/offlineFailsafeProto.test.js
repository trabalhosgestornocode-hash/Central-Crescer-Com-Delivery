// C.9.5 — testes do PROTÓTIPO do failsafe OFFLINE_STALLED (test-support/offlineFailsafe.proto.js). O protótipo NÃO existe em
// src/: estes testes provam o PROJETO (máquina de estados, regra de estagnação, rótulos de origem, corrida, idempotência, DISABLED
// soberano) antes de qualquer implementação. A Parte "com o Baileys real" liga o protótipo a um socket real (local) e mostra que a
// liberação de recuperação é possível, rotulada e sem duplicar.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { criarFailsafeOffline, decidirEntrada, FASE, ORIGEM } from "../test-support/offlineFailsafe.proto.js";
import { criarGatewayFalso, capturarConsole } from "../test-support/inboundHarness.js";
import { criarServidorOfflineFalso, gerarMensagensOffline } from "../test-support/servidorOfflineFalso.js";
import { criarInboundGateway } from "../src/inboundScope.js";

const S = 1000;
function criar(extra = {}) {
  let t = 1_000_000; const eventos = []; let retidas = 0; let buffer = true; let saudavel = true; const chamadasLiberar = [];
  const f = criarFailsafeOffline({
    agora: () => t, socketSaudavel: () => saudavel, retidas: () => retidas, bufferAtivo: () => buffer,
    liberar: () => { chamadasLiberar.push(t); const r = retidas > 0; if (extra.aoLiberar) extra.aoLiberar(f); retidas = 0; buffer = false; return r; },
    aoEvento: (e) => eventos.push(e), ...extra.config,
  });
  return { f, eventos, chamadasLiberar, avancar: (ms) => { t += ms; }, definir: (o) => { if ("retidas" in o) retidas = o.retidas; if ("saudavel" in o) saudavel = o.saudavel; if ("buffer" in o) buffer = o.buffer; }, agora: () => t };
}

describe("configuração do failsafe", () => {
  test("recusa configuração incoerente (teto ≤ estagnação; estagnação ≥ limite de keep-alive; ≤ 0)", () => {
    assert.throws(() => criarFailsafeOffline({ stallDetectionMs: 0 }), RangeError);
    assert.throws(() => criarFailsafeOffline({ stallDetectionMs: 30_000, absoluteMaxOfflineMs: 30_000 }), RangeError);
    assert.throws(() => criarFailsafeOffline({ stallDetectionMs: 40_000, absoluteMaxOfflineMs: 180_000 }), RangeError, "≥ 35 s: o Baileys derrubaria o socket antes");
    assert.doesNotThrow(() => criarFailsafeOffline({}));
  });
});

describe("máquina de estados e regra OFFLINE_STALLED", () => {
  test("1. FLUXO NORMAL: preview → nós → marcador ⇒ LIVE pelo caminho oficial; o watchdog nunca libera nada", () => {
    const { f, chamadasLiberar, avancar, definir } = criar();
    const g = f.novoSocket(); assert.equal(f.fase(), FASE.CONNECTING);
    f.aoPreview(g); assert.equal(f.fase(), FASE.OFFLINE_LOADING);
    for (let i = 0; i < 100; i++) f.aoNoOffline(g);
    definir({ retidas: 100 });
    f.aoMarcadorAntes(g); assert.equal(f.contexto(), "MARCADOR"); definir({ retidas: 0, buffer: false }); f.aoMarcadorDepois(g);   // o flush oficial drenou
    assert.equal(f.fase(), FASE.LIVE);
    avancar(10 * 60 * S); assert.equal(f.tick(g), false, "já está LIVE: o watchdog não age");
    assert.equal(chamadasLiberar.length, 0);
    const m = f.metricas(); assert.equal(m.offline_normal_flush_total, 1); assert.equal(m.offline_recovery_flush_total, 0); assert.equal(m.recovery_path_used, false);
  });

  test("2. MARCADOR AUSENTE: sem progresso por stallDetectionMs ⇒ OFFLINE_STALLED ⇒ UM flush de recuperação ⇒ LIVE marcado RECOVERY_PATH_USED", () => {
    const { f, eventos, chamadasLiberar, avancar, definir } = criar();
    const g = f.novoSocket(); f.aoPreview(g); f.aoBatchSolicitado(g); for (let i = 0; i < 102; i++) f.aoNoOffline(g);
    definir({ retidas: 80 });
    avancar(29 * S); assert.equal(f.tick(g), false, "29 s de silêncio: ainda não");
    avancar(1 * S); assert.equal(f.tick(g), true, "30 s de silêncio: dispara");
    assert.equal(f.fase(), FASE.LIVE); assert.equal(chamadasLiberar.length, 1);
    const st = eventos.find((e) => e.evento === "offline_stalled");
    assert.deepEqual([st.retidas, st.segundosSemProgresso, st.motivo, st.socketSaudavel, st.nosOfflineVistos, st.batches], [80, 30, "sem_progresso", true, 102, 1]);
    const rec = eventos.find((e) => e.evento === "recovery_flush"); assert.equal(rec.RECOVERY_PATH_USED, true); assert.equal(rec.drenou, true);
    const m = f.metricas(); assert.equal(m.offline_stall_count, 1); assert.equal(m.offline_recovery_flush_total, 1); assert.equal(m.offline_recovery_messages, 80); assert.equal(m.recovery_path_used, true);
    assert.equal(f.tick(g), false, "depois de LIVE não repete");
  });

  test("3. FALSO POSITIVO: enquanto nós continuam chegando o watchdog NÃO dispara (progresso zera o relógio de silêncio)", () => {
    const { f, chamadasLiberar, avancar, definir } = criar();
    const g = f.novoSocket(); f.aoPreview(g); definir({ retidas: 5 });
    for (let i = 0; i < 6; i++) { avancar(25 * S); f.aoNoOffline(g); assert.equal(f.tick(g), false, `rodada ${i}: chegou nó há 0 s`); }
    assert.equal(chamadasLiberar.length, 0); assert.equal(f.fase(), FASE.OFFLINE_LOADING);
  });

  test("3c. BACKLOG DE PROCESSAMENTO: a rajada de nós já chegou, mas o processamento serial continua enfileirando ⇒ há progresso, não há estagnação", () => {
    const { f, chamadasLiberar, avancar, definir } = criar();
    const g = f.novoSocket(); f.aoPreview(g); for (let i = 0; i < 1000; i++) f.aoNoOffline(g); definir({ retidas: 1 });
    for (let i = 0; i < 4; i++) { avancar(20 * S); f.aoEnfileirada(g); assert.equal(f.tick(g), false, `20 s desde a última chegada, mas 0 s desde a última processada (rodada ${i})`); }
    assert.equal(chamadasLiberar.length, 0);
    avancar(30 * S); assert.equal(f.tick(g), true, "só quando o processamento TAMBÉM para");
  });

  test("3b. TETO ABSOLUTO: um gotejamento eterno (progresso sem fim) é cortado em absoluteMaxOfflineMs, com o motivo certo", () => {
    const { f, eventos, avancar, definir } = criar();
    const g = f.novoSocket(); f.aoPreview(g); definir({ retidas: 3 });
    let disparou = false;
    for (let i = 0; i < 20 && !disparou; i++) { avancar(20 * S); f.aoNoOffline(g); disparou = f.tick(g); }
    assert.equal(disparou, true);
    assert.equal(eventos.find((e) => e.evento === "offline_stalled").motivo, "teto_absoluto");
  });

  test("4. SOCKET NÃO SAUDÁVEL: adia (não libera num socket morrendo); quando volta a ser saudável, decide", () => {
    const { f, chamadasLiberar, avancar, definir } = criar();
    const g = f.novoSocket(); f.aoPreview(g); definir({ retidas: 9, saudavel: false });
    avancar(60 * S); assert.equal(f.tick(g), false); assert.equal(chamadasLiberar.length, 0); assert.equal(f.metricas().offline_stall_deferred_total, 1);
    definir({ saudavel: true }); assert.equal(f.tick(g), true); assert.equal(chamadasLiberar.length, 1);
  });

  test("4b. SOCKET CAIU antes do timeout: nada é liberado (o buffer morreu com o socket) e a PERDA é contada; tokens antigos são ignorados", () => {
    const { f, eventos, chamadasLiberar, avancar, definir } = criar();
    const velho = f.novoSocket(); f.aoPreview(velho); definir({ retidas: 40 });
    avancar(10 * S);
    const novo = f.novoSocket();                              // reconexão
    assert.equal(f.metricas().offline_retained_lost_total, 40); assert.ok(eventos.some((e) => e.evento === "offline_retained_lost" && e.retidas === 40));
    avancar(5 * 60 * S);
    assert.equal(f.tick(velho), false, "tick do socket velho é ignorado");
    f.aoNoOffline(velho); f.aoMarcadorAntes(velho); f.aoPreview(velho);   // eventos atrasados do socket velho
    assert.equal(f.fase(), FASE.CONNECTING, "nada do socket velho contamina o novo");
    assert.equal(chamadasLiberar.length, 0);
    assert.equal(f.tick(novo), false, "o socket novo ainda não viu a fase offline");
  });

  test("5a. CORRIDA — o marcador chega ANTES do tick: o marcador vence; o watchdog não faz flush", () => {
    const { f, chamadasLiberar, avancar, definir } = criar();
    const g = f.novoSocket(); f.aoPreview(g); definir({ retidas: 10 }); avancar(31 * S);
    f.aoMarcadorAntes(g); definir({ retidas: 0, buffer: false }); f.aoMarcadorDepois(g);
    assert.equal(f.tick(g), false); assert.equal(chamadasLiberar.length, 0);
    assert.equal(f.metricas().offline_normal_flush_total, 1); assert.equal(f.metricas().recovery_path_used, false);
  });

  test("5b. CORRIDA — o tick vence e o marcador chega DEPOIS (tardio): registrado, sem 2º flush, sem trocar o rótulo da recuperação", () => {
    const { f, chamadasLiberar, avancar, definir } = criar();
    const g = f.novoSocket(); f.aoPreview(g); definir({ retidas: 10 }); avancar(31 * S);
    assert.equal(f.tick(g), true);
    f.aoMarcadorAntes(g); f.aoMarcadorDepois(g);
    assert.equal(chamadasLiberar.length, 1, "exatamente UM flush de nossa parte");
    const m = f.metricas(); assert.equal(m.offline_late_marker_total, 1); assert.equal(m.offline_normal_flush_total, 0, "o marcador tardio não vira 'oficial'"); assert.equal(m.recovery_path_used, true);
  });

  test("5c. CORRIDA — o marcador chega DURANTE o flush de recuperação (reentrância): um só caminho, um só flush", () => {
    const ctx = criar({ aoLiberar: (f) => { f.aoMarcadorAntes(ctx.g); f.aoMarcadorDepois(ctx.g); } });
    const { f, chamadasLiberar, avancar, definir } = ctx;
    const g = f.novoSocket(); ctx.g = g; f.aoPreview(g); definir({ retidas: 7 }); avancar(31 * S);
    assert.equal(f.tick(g), true);
    assert.equal(chamadasLiberar.length, 1); assert.equal(f.metricas().offline_late_marker_total, 1); assert.equal(f.metricas().offline_normal_flush_total, 0);
  });

  test("5d. REENTRÂNCIA — um tick disparado de dentro do flush não executa um 2º flush", () => {
    const ctx = criar({ aoLiberar: (f) => { assert.equal(f.tick(ctx.g), false); } });
    const g = ctx.f.novoSocket(); ctx.g = g; ctx.f.aoPreview(g); ctx.definir({ retidas: 4 }); ctx.avancar(31 * S);
    assert.equal(ctx.f.tick(g), true); assert.equal(ctx.chamadasLiberar.length, 1);
  });

  test("5e. marcador VISTO mas o handler oficial não completou (aoMarcadorDepois nunca roda): o watchdog não compete com o caminho oficial", () => {
    const { f, chamadasLiberar, avancar, definir } = criar();
    const g = f.novoSocket(); f.aoPreview(g); definir({ retidas: 6 }); f.aoMarcadorAntes(g); avancar(10 * 60 * S);
    assert.equal(f.tick(g), false); assert.equal(chamadasLiberar.length, 0);
  });

  test("6b. retidas > 0 mas o buffer JÁ NÃO está ativo (um nó vivo drenou): estagnação registrada, porém NENHUM flush", () => {
    const { f, chamadasLiberar, avancar, definir } = criar();
    const g = f.novoSocket(); f.aoPreview(g); definir({ retidas: 12, buffer: false }); avancar(31 * S);
    assert.equal(f.tick(g), true); assert.equal(chamadasLiberar.length, 0);
    assert.equal(f.metricas().offline_recovery_flush_total, 0);
  });

  test("5f. RETENÇÃO RESIDUAL pós-marcador: mensagens processadas DEPOIS do flush oficial rearmam o buffer ⇒ o failsafe também vale em LIVE (com rótulo de recuperação)", () => {
    const { f, eventos, chamadasLiberar, avancar, definir } = criar();
    const g = f.novoSocket(); f.aoPreview(g); f.aoMarcadorAntes(g); definir({ retidas: 0, buffer: false }); f.aoMarcadorDepois(g);
    assert.equal(f.fase(), FASE.LIVE);
    definir({ retidas: 30, buffer: true }); f.aoEnfileirada(g);       // o processamento serial continuou e rearmou o buffer
    avancar(29 * S); assert.equal(f.tick(g), false, "ainda dentro da janela de silêncio");
    avancar(1 * S); assert.equal(f.tick(g), true); assert.equal(chamadasLiberar.length, 1);
    const rec = eventos.filter((e) => e.evento === "recovery_flush").at(-1); assert.equal(rec.motivo, "retencao_residual"); assert.equal(rec.RECOVERY_PATH_USED, true);
    const m = f.metricas(); assert.equal(m.offline_residual_recovery_total, 1); assert.equal(m.offline_normal_flush_total, 1); assert.equal(m.recovery_path_used, true);
  });

  test("5g. LIVE limpo (nada retido) nunca gera flush nem evento; e a recuperação residual tem TETO por socket", () => {
    const { f, eventos, chamadasLiberar, avancar, definir } = criar({ config: { maxRecuperacoesPorSocket: 2 } });
    const g = f.novoSocket(); f.aoPreview(g); f.aoMarcadorAntes(g); definir({ retidas: 0, buffer: false }); f.aoMarcadorDepois(g);
    const antes = eventos.length; avancar(10 * 60 * S); assert.equal(f.tick(g), false); assert.equal(eventos.length, antes, "nenhum evento");
    for (let i = 0; i < 5; i++) { definir({ retidas: 3, buffer: true }); avancar(31 * S); f.tick(g); }
    assert.equal(chamadasLiberar.length, 2, "no máximo 2 recuperações neste socket");
    assert.ok(eventos.some((e) => e.evento === "offline_recovery_teto_por_socket"));
  });

  test("5h. RESIDUAL: socket NÃO saudável adia; buffer já inativo (nada realmente preso) não faz flush", () => {
    const { f, chamadasLiberar, avancar, definir } = criar();
    const g = f.novoSocket(); f.aoPreview(g); f.aoMarcadorAntes(g); definir({ retidas: 0, buffer: false }); f.aoMarcadorDepois(g);
    definir({ retidas: 8, buffer: true, saudavel: false }); avancar(31 * S);
    assert.equal(f.tick(g), false, "socket não saudável"); assert.equal(chamadasLiberar.length, 0); assert.equal(f.metricas().offline_stall_deferred_total, 1);
    definir({ saudavel: true, buffer: false });
    assert.equal(f.tick(g), false, "retidas > 0 mas o buffer já não está ativo"); assert.equal(chamadasLiberar.length, 0);
  });

  test("5i. um FLUSH por qualquer caminho conta como progresso: o silêncio é medido desde o último flush", () => {
    const { f, chamadasLiberar, avancar, definir } = criar();
    const g = f.novoSocket(); f.aoPreview(g); f.aoMarcadorAntes(g); definir({ retidas: 0, buffer: false }); f.aoMarcadorDepois(g);
    definir({ retidas: 3, buffer: true }); avancar(25 * S); f.aoFlush(g);
    avancar(20 * S); assert.equal(f.tick(g), false, "45 s desde o marcador, mas só 20 s desde o último flush");
    avancar(10 * S); assert.equal(f.tick(g), true); assert.equal(chamadasLiberar.length, 1);
  });

  test("5j. REENTRÂNCIA no caminho RESIDUAL (a fase segue LIVE durante o flush): um tick disparado de dentro do flush não faz um 2º flush", () => {
    const ctx = criar({ aoLiberar: (f) => { assert.equal(f.tick(ctx.g), false); ctx.definir({ retidas: 5, buffer: true }); } });
    const g = ctx.f.novoSocket(); ctx.g = g; ctx.f.aoPreview(g); ctx.f.aoMarcadorAntes(g); ctx.definir({ retidas: 0, buffer: false }); ctx.f.aoMarcadorDepois(g);
    ctx.definir({ retidas: 5, buffer: true }); ctx.avancar(31 * S);
    assert.equal(ctx.f.tick(g), true); assert.equal(ctx.chamadasLiberar.length, 1, "apenas UM flush");
  });

  test("6. ESTAGNADO sem retidas: alerta e RECOVERY_PATH_USED, mas NENHUM flush desnecessário", () => {
    const { f, chamadasLiberar, avancar, definir, eventos } = criar();
    const g = f.novoSocket(); f.aoPreview(g); definir({ retidas: 0 }); avancar(31 * S);
    assert.equal(f.tick(g), true); assert.equal(chamadasLiberar.length, 0);
    assert.equal(f.metricas().offline_stall_without_retained_total, 1); assert.ok(eventos.some((e) => e.evento === "recovery_sem_retidas" && e.RECOVERY_PATH_USED === true));
  });

  test("7. REINÍCIO durante OFFLINE_LOADING/STALLED: instância nova começa em CONNECTING, sem retidas herdadas e sem flush espontâneo", () => {
    const a = criar(); const ga = a.f.novoSocket(); a.f.aoPreview(ga); a.definir({ retidas: 50 });   // "processo antigo" morre aqui
    const b = criar();                                                                                 // "processo novo"
    assert.equal(b.f.fase(), FASE.CONNECTING); b.avancar(10 * 60 * S);
    const gb = b.f.novoSocket(); assert.equal(b.f.tick(gb), false); assert.equal(b.chamadasLiberar.length, 0);
    b.f.aoPreview(gb); assert.equal(b.f.fase(), FASE.OFFLINE_LOADING, "e o novo preview reinicia a fase do zero");
  });
});

describe("origem das mensagens, persistência, duplicidade e DISABLED soberano", () => {
  test("8. rótulos: LIVE (sem attrs.offline) / OFFLINE_NORMAL (marcador ou nó vivo) / OFFLINE_RECOVERY (dentro do flush de recuperação)", () => {
    const rotulos = [];
    const ctx = criar({ aoLiberar: (f) => { rotulos.push(f.classificar({ veioDeNoOffline: true }), f.classificar({ veioDeNoOffline: false })); } });
    const { f, avancar, definir } = ctx;
    const g = f.novoSocket(); f.aoPreview(g); definir({ retidas: 2 });
    assert.equal(f.classificar({ veioDeNoOffline: false }), ORIGEM.LIVE);
    assert.equal(f.classificar({ veioDeNoOffline: true }), ORIGEM.OFFLINE_NORMAL, "fora de qualquer flush nosso");
    avancar(31 * S); f.tick(g);
    assert.deepEqual(rotulos, [ORIGEM.OFFLINE_RECOVERY, ORIGEM.LIVE], "mesmo DENTRO do flush de recuperação, uma mensagem de nó vivo continua LIVE");
    assert.equal(f.contexto(), null, "o contexto não vaza para depois do flush");
  });

  test("9. decidirEntrada: RECOVERY é persistida, marcada p/ revisão e NUNCA vai ao Agente nem gera envio; LIVE só com o modo liberado", () => {
    const rec = decidirEntrada({ origem: ORIGEM.OFFLINE_RECOVERY, duplicada: false, modoComunicacao: "NORMAL" });
    assert.deepEqual(rec, { persistir: true, contarDuplicada: false, encaminharAoAgente: false, permitirEnvio: false, marcarParaRevisaoHumana: true });
    const normal = decidirEntrada({ origem: ORIGEM.OFFLINE_NORMAL, duplicada: false, modoComunicacao: "NORMAL" });
    assert.equal(normal.encaminharAoAgente, false, "histórico oficial também não aciona automação até haver política explícita");
    const live = decidirEntrada({ origem: ORIGEM.LIVE, duplicada: false, modoComunicacao: "NORMAL" });
    assert.deepEqual([live.persistir, live.encaminharAoAgente, live.permitirEnvio], [true, true, true]);
  });

  test("10. DISABLED é SOBERANO: nem uma mensagem LIVE gera envio/Agente; nenhuma origem, nenhuma combinação", () => {
    for (const origem of Object.values(ORIGEM)) for (const duplicada of [false, true]) for (const falhaDecrypt of [false, true]) {
      const d = decidirEntrada({ origem, duplicada, modoComunicacao: "DISABLED", falhaDecrypt });
      assert.equal(d.permitirEnvio, false); assert.equal(d.encaminharAoAgente, false);
    }
    for (const modo of [undefined, null, "", "disabled", "X", "MODO_INVALIDO"]) assert.equal(decidirEntrada({ origem: ORIGEM.LIVE, duplicada: false, modoComunicacao: modo }).permitirEnvio, false, `fail-closed para ${String(modo)}`);
  });

  test("11. DUPLICADA (mesma mensagem em outra reconexão): zero persistência e zero ação; stub de falha de decrypt não é conteúdo", () => {
    for (const origem of Object.values(ORIGEM)) {
      const d = decidirEntrada({ origem, duplicada: true, modoComunicacao: "NORMAL" });
      assert.deepEqual([d.persistir, d.encaminharAoAgente, d.permitirEnvio, d.contarDuplicada, d.marcarParaRevisaoHumana], [false, false, false, true, false]);
    }
    const falha = decidirEntrada({ origem: ORIGEM.LIVE, duplicada: false, modoComunicacao: "NORMAL", falhaDecrypt: true });
    assert.deepEqual([falha.persistir, falha.encaminharAoAgente, falha.permitirEnvio], [false, false, false]);
  });

  test("12. métricas e eventos do failsafe: só números, booleanos, null e vocabulário fechado — sem identificadores", () => {
    const { f, eventos, avancar, definir } = criar();
    const g = f.novoSocket(); f.aoPreview(g); for (let i = 0; i < 5; i++) f.aoNoOffline(g); definir({ retidas: 5 }); avancar(31 * S); f.tick(g);
    const txt = JSON.stringify([f.metricas(), eventos]);
    assert.ok(!/@|\d{8,}|jid|lid|phone|telefone|remoteJid|participant/i.test(txt.replace(/offline_last_progress_at":\d+/, "")), txt);
    for (const e of eventos) for (const [k, v] of Object.entries(e)) assert.ok(["number", "boolean", "string"].includes(typeof v) || v === null, `${k}`);
  });
});

describe("integração com o Baileys REAL (local): recuperação rotulada, sem duplicar, e a PERDA que o failsafe evita", { timeout: 120_000 }, () => {
  async function abrir({ latenciaKeysMs = 0 } = {}) {
    const cap = capturarConsole();
    const inbound = criarInboundGateway({ diagHabilitado: true, emitir() {}, agendar: () => ({ unref() {} }), consoleAlvo: console });
    const gw = await criarGatewayFalso({ inbound, latenciaKeysMs });
    return { gw, inbound, fim: async () => { inbound.parar(); cap.restaurar(); await gw.encerrar(); } };
  }
  /** liga o protótipo ao socket real: marcador (antes/depois do handler do Baileys), nós, rótulos por mensagem. */
  function ligar(gw, inbound, relogio) {
    const rotulos = []; const mapa = new Map();
    const f = criarFailsafeOffline({
      agora: () => relogio.t, socketSaudavel: () => gw.sock.ws.isOpen === true,
      retidas: () => inbound.estadoFila().mensagensRetidas, bufferAtivo: () => gw.sock.ev.isBuffering(), liberar: () => gw.sock.ev.flush(),
    });
    const g = f.novoSocket();
    gw.sock.ws.prependListener("CB:ib,,offline", () => f.aoMarcadorAntes(g));   // roda ANTES do handler do Baileys (que faz o flush oficial)
    gw.sock.ws.on("CB:ib,,offline", () => f.aoMarcadorDepois(g));                // roda DEPOIS
    gw.sock.ws.on("CB:ib,,offline_preview", () => f.aoPreview(g));
    gw.sock.ws.on("CB:message", (no) => { const off = Boolean(no?.attrs?.offline); mapa.set(no.attrs.id, off); if (off) f.aoNoOffline(g); else f.aoNoVivo(g); });
    gw.sock.ev.on("messages.upsert", ({ messages }) => { for (const m of messages) rotulos.push(f.classificar({ veioDeNoOffline: mapa.get(m.key.id) === true })); });
    return { f, g, rotulos };
  }

  test("marcador AUSENTE (100 retidas): a recuperação libera as 100 — todas OFFLINE_RECOVERY, num único flush; marcador tardio e mensagem LIVE seguem normais", async () => {
    const t = await abrir(); const relogio = { t: 0 };
    try {
      const { f, g, rotulos } = ligar(t.gw, t.inbound, relogio);
      const nos = await gerarMensagensOffline(t.gw, 130);
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "nunca_envia_fim" });
      srv.iniciar(); await srv.aguardarBatches(1, 3000);
      await t.gw.aguardarQuiescencia({ estavelMs: 800, maxMs: 20_000 });
      assert.equal(t.gw.upserts.length, 0); assert.equal(f.fase(), FASE.OFFLINE_LOADING);
      relogio.t += 29_000; assert.equal(f.tick(g), false);
      relogio.t += 1_000;  assert.equal(f.tick(g), true, "30 s sem progresso, buffer ativo, marcador ausente, socket saudável");
      assert.equal(t.gw.upserts.length, 100, "as 100 retidas foram liberadas");
      assert.equal(t.gw.bufferando(), false);
      assert.equal(t.gw.upsertsTipos.length, 1, "UM evento consolidado");
      assert.equal(rotulos.length, 100); assert.ok(rotulos.every((r) => r === ORIGEM.OFFLINE_RECOVERY), "todas rotuladas como recuperação");
      const m = f.metricas(); assert.equal(m.recovery_path_used, true); assert.equal(m.offline_recovery_messages, 100); assert.equal(t.inbound.estadoFila().flushesEfetivos, 1);
      // o marcador finalmente chega (tardio): o Baileys tenta flush, que devolve false (nada retido) — nenhuma duplicata
      t.gw.emitirOfflineFim(100); await t.gw.espera(200);
      assert.equal(t.gw.upserts.length, 100, "nenhuma mensagem duplicada");
      assert.equal(f.metricas().offline_late_marker_total, 1);
      // uma mensagem LIVE depois: fluxo normal (buffer→flush do Baileys), rótulo LIVE, type notify
      const par = await t.gw.criarPar(D2(1000)); const viva = await t.gw.mensagemDireta(par, "viva"); delete viva.attrs.offline;
      await t.gw.entregarSemFimOffline(viva);
      assert.equal(t.gw.upserts.length, 101); assert.equal(rotulos.at(-1), ORIGEM.LIVE);
      assert.equal(t.gw.upsertsTipos.at(-1).tipo, "notify");
    } finally { await t.fim(); }
  });

  test("marcador PRESENTE: as mensagens saem pelo flush oficial e são rotuladas OFFLINE_NORMAL; o watchdog nada faz", async () => {
    const t = await abrir(); const relogio = { t: 0 };
    try {
      const { f, g, rotulos } = ligar(t.gw, t.inbound, relogio);
      const nos = await gerarMensagensOffline(t.gw, 40);
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "fim_ao_esgotar" });
      srv.iniciar(); await srv.aguardarBatches(1, 3000);
      await t.gw.aguardarQuiescencia({ estavelMs: 800, maxMs: 20_000 });
      assert.equal(t.gw.upserts.length, 40); assert.ok(rotulos.every((r) => r === ORIGEM.OFFLINE_NORMAL));
      assert.equal(f.fase(), FASE.LIVE); relogio.t += 10 * 60_000; assert.equal(f.tick(g), false);
      assert.equal(f.metricas().recovery_path_used, false); assert.equal(f.metricas().offline_normal_flush_total, 1);
    } finally { await t.fim(); }
  });

  test("RETENÇÃO RESIDUAL (marcador CHEGOU, mas o decrypt com I/O terminou depois do flush): o failsafe libera o que sobrou — rotulado OFFLINE_RECOVERY", async () => {
    const t = await abrir({ latenciaKeysMs: 8 }); const relogio = { t: 0 };
    try {
      const { f, g, rotulos } = ligar(t.gw, t.inbound, relogio);
      const nos = await gerarMensagensOffline(t.gw, 30);
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "fim_ao_esgotar" });
      srv.iniciar(); await srv.aguardarBatches(1, 3000);
      await t.gw.aguardarQuiescencia({ estavelMs: 800, maxMs: 20_000 });
      const fila = t.inbound.estadoFila();
      assert.equal(fila.offlineFimRecebido, 1); assert.equal(fila.bufferAtivo, true); assert.ok(fila.mensagensRetidas > 0, "sobrou retenção depois do marcador");
      assert.equal(f.fase(), FASE.LIVE, "o caminho oficial foi cumprido");
      const antes = t.gw.upserts.length; assert.ok(antes < 30);
      relogio.t += 29_000; assert.equal(f.tick(g), false);
      relogio.t += 1_000;  assert.equal(f.tick(g), true, "silêncio de 30 s com buffer ativo e retidas ⇒ recuperação residual");
      assert.equal(t.gw.upserts.length, 30, "as 30 chegaram ao listener");
      assert.equal(t.gw.bufferando(), false);
      const recup = rotulos.filter((r) => r === ORIGEM.OFFLINE_RECOVERY).length;
      assert.equal(recup, 30 - antes, "só o que ficou preso é rotulado como recuperação");
      assert.equal(rotulos.filter((r) => r === ORIGEM.OFFLINE_NORMAL).length, antes, "o que o marcador já liberou continua OFFLINE_NORMAL");
      const m = f.metricas(); assert.equal(m.offline_residual_recovery_total, 1); assert.equal(m.recovery_path_used, true); assert.equal(m.offline_normal_flush_total, 1);
    } finally { await t.fim(); }
  });

  test("PERDA (o risco que o failsafe evita): mensagens decifradas já tiveram o RECIBO DE ENTREGA enviado; se o socket fecha com elas retidas, NENHUMA chega ao app", async () => {
    const t = await abrir();
    try {
      const nos = await gerarMensagensOffline(t.gw, 100);
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "nunca_envia_fim" });
      srv.iniciar(); await srv.aguardarBatches(1, 3000);
      await t.gw.aguardarQuiescencia({ estavelMs: 800, maxMs: 20_000 });
      await t.gw.drenarEnviados();
      const recibosEntrega = t.gw.enviados.filter((n) => n.tag === "receipt" && n.attrs.type !== "retry").length;
      assert.equal(recibosEntrega, 100, "100 recibos de entrega já saíram para o servidor");
      assert.equal(t.gw.upserts.length, 0, "e o app não recebeu nenhuma");
      await t.gw.sock.end(undefined); await t.gw.espera(300);   // o fechamento natural do socket (stream_error) faz o mesmo
      assert.equal(t.gw.upserts.length, 0, "fechado o socket, o buffer some: as 100 estão perdidas");
    } finally { await t.fim(); }
  });
});

function D2(n) { return `55118888${String(n).padStart(5, "0")}@s.whatsapp.net`; }
