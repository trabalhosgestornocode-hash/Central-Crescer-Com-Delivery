// Checkpoint G — INTEGRAÇÃO do motor de OFFLINE_RECOVERY com o Baileys 6.7.24 REAL (socket real → servidor
// WebSocket LOCAL, criptografia libsignal real, pares fictícios; nenhuma rede externa), reaproveitando o servidor
// de fila offline falso já existente (test-support/servidorOfflineFalso.js). O que se prova aqui é que o `pedirBatch`
// do motor realmente vira um `ib > offline_batch` no FIO (o mesmo frame que o Baileys manda sozinho) e que o
// Baileys real aceita e responde a esse pedido como responderia ao seu próprio — sem nenhum patch em node_modules.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { criarGatewayFalso, capturarConsole } from "../test-support/inboundHarness.js";
import { criarServidorOfflineFalso, gerarMensagensOffline } from "../test-support/servidorOfflineFalso.js";
import { criarInboundGateway } from "../src/inboundScope.js";
import { FASE_RECOVERY } from "../src/offlineRecovery.js";
import { criarGuardaAuthHeadroom } from "../src/authHeadroom.js";

// limites RÁPIDOS só para o teste — a mesma prática de offlineObserveIntegracao.test.js.
const OBSERVE_RAPIDO = { stallDetectionMs: 300, absoluteMaxOfflineMs: 5000, tickMs: 20, heartbeatMs: 3000, keepAliveLimiteMs: 5000 };
const RECOVERY_RAPIDO = { tickMs: 20, batchQuietMs: 250, maxRecoveryBatches: 5, maxRecoveryNodes: 1000, maxRecoveryDurationMs: 5000, maxConsecutiveNoProgressBatches: 2 };

async function abrir({ recovery = false, opcoesBaileys = {} } = {}) {
  const cap = capturarConsole(); const eventos = [];
  const inbound = criarInboundGateway({
    diagHabilitado: true, offlineObserve: OBSERVE_RAPIDO, consoleAlvo: console,
    emitir: (n, e, d) => eventos.push({ e, d }), obterEpoch: () => 21,
    // `recovery` pode ser `true` (usa os limites RÁPIDOS padrão deste arquivo) ou um objeto (config custom — ex.:
    // o teste de kill-switch, que precisa do MESMO objeto com `habilitado` sobrescrito, nunca um substituto).
    offlineRecovery: recovery === true ? { ...RECOVERY_RAPIDO } : recovery,
  });
  const gw = await criarGatewayFalso({ inbound, opcoesBaileys });
  const porNome = (n) => eventos.filter((x) => x.e === n);
  return { gw, inbound, eventos, porNome, fim: async () => { inbound?.parar(); cap.restaurar(); await gw.encerrar(); } };
}
async function esperar(cond, ms = 6000, passo = 20) { const ini = Date.now(); while (Date.now() - ini < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, passo)); } return cond(); }

describe("cenário 1 — sucesso: paginação controlada até o marcador oficial (Baileys REAL, sendNode REAL)", { timeout: 60_000 }, () => {
  test("250 itens em 3 lotes reais (100+100+50); o motor pede os 2 lotes extras via socket.sendNode; o marcador chega e o Baileys faz SEU flush — nenhum flush manual", async () => {
    const t = await abrir({ recovery: true });
    try {
      const nos = await gerarMensagensOffline(t.gw, 250, { pares: 30 });
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "fim_ao_esgotar" });
      srv.iniciar();
      assert.equal(await srv.aguardarBatches(1, 3000), true, "o Baileys respondeu sozinho ao 1º preview");

      assert.equal(await esperar(() => t.inbound.estadoRecovery()?.status === FASE_RECOVERY.RECOVERING, 4000), true, "o motor entrou em RECOVERING após o stall");
      assert.equal(await esperar(() => srv.estado.batches.length >= 3, 6000), true, "o motor pediu os 2 lotes extras (3 offline_batch no total, no fio)");
      assert.equal(srv.restante(), 0, "os 250 foram todos entregues");

      assert.equal(await esperar(() => t.gw.upserts.length === 250, 6000), true, "o Baileys fez o SEU flush oficial ao ver o marcador");
      const done = t.porNome("inbound.offline_recovery_completed");
      assert.equal(done.length, 1);
      assert.equal(done[0].d.reason, "marker_received");
      assert.ok(done[0].d.batchesRequested >= 2, "pelo menos os 2 lotes extras contados pelo motor");
      assert.equal(t.porNome("inbound.offline_recovery_aborted").length, 0, "nenhum abort");
      assert.equal(t.inbound.estadoRecovery().status, FASE_RECOVERY.DONE);

      // OBSERVE continua saudável e sem se confundir com o recovery (seção 52 do checkpoint).
      const obs = t.inbound.estadoObserve();
      assert.equal(obs.fase, "LIVE");
      assert.equal(t.inbound.metricasRecovery().sucesso, 1);
    } finally { await t.fim(); }
  });
});

describe("cenário 3/47 — 100% duplicado: aborta por falta de progresso, ZERO flush manual", { timeout: 60_000 }, () => {
  test("o servidor reentrega os MESMOS 100 nós (mesmo id) em cada lote extra ⇒ no_progress; nada é liberado por aqui", async () => {
    const t = await abrir({ recovery: true });
    try {
      const nos = await gerarMensagensOffline(t.gw, 100, { pares: 20 });
      // servidor MODELO: 1º lote são os 100 originais; os lotes seguintes são os MESMOS objetos (replay idêntico) — nunca envia o marcador.
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos: [...nos, ...nos, ...nos, ...nos], politica: "nunca_envia_fim" });
      srv.iniciar(); await srv.aguardarBatches(1, 3000);

      assert.equal(await esperar(() => t.inbound.estadoRecovery()?.status === FASE_RECOVERY.RECOVERING, 4000), true);
      assert.equal(await esperar(() => t.inbound.estadoRecovery()?.status === FASE_RECOVERY.DONE, 6000), true, "abortou");
      assert.equal(t.inbound.estadoRecovery().motivoFinal, "no_progress");
      const aborted = t.porNome("inbound.offline_recovery_aborted")[0].d;
      assert.equal(aborted.reason, "no_progress");
      assert.equal(t.gw.upserts.length, 0, "NADA foi liberado — sem flush manual, o buffer nativo segue intacto");
      assert.equal(t.gw.bufferando(), true);
    } finally { await t.fim(); }
  });
});

describe("cenário 4 — marcador antes do watchdog: recovery nunca inicia", { timeout: 30_000 }, () => {
  test("fluxo normal (60 nós, marcador rápido): fase nunca chega a OFFLINE_STALLED_OBSERVED ⇒ zero eventos de recovery", async () => {
    const t = await abrir({ recovery: true });
    try {
      const nos = await gerarMensagensOffline(t.gw, 60);
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "fim_ao_esgotar" });
      srv.iniciar(); await srv.aguardarBatches(1, 3000);
      assert.equal(await esperar(() => t.gw.upserts.length === 60, 5000), true);
      await t.gw.espera(600); // > 2x stallDetectionMs: dá tempo de sobra para o watchdog "errar" se fosse errar
      assert.equal(t.inbound.estadoRecovery().status, FASE_RECOVERY.IDLE);
      assert.equal(srv.estado.batches.length, 1, "nenhum offline_batch extra foi pedido");
      assert.equal(t.eventos.filter((x) => x.e.startsWith("inbound.offline_recovery_")).length, 0);
    } finally { await t.fim(); }
  });
});

describe("cenário 6/50 — socket fecha durante o recovery: cancela tudo, sem callback tardio", { timeout: 60_000 }, () => {
  test("fechar o socket em pleno RECOVERING ⇒ socket_closed; nenhum batch depois disso", async () => {
    const t = await abrir({ recovery: true });
    try {
      const nos = await gerarMensagensOffline(t.gw, 130);
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "nunca_envia_fim" });
      srv.iniciar(); await srv.aguardarBatches(1, 3000);
      assert.equal(await esperar(() => t.inbound.estadoRecovery()?.status === FASE_RECOVERY.RECOVERING, 4000), true);
      // `pedirBatch()` (socket.sendNode) é assíncrono no fio: espera o 1º pedido do motor REALMENTE chegar ao
      // servidor falso antes de fotografar "batchesAntes" — senão a foto pega uma corrida com o próprio envio.
      await esperar(() => srv.estado.batches.length >= 2, 3000);
      const batchesAntes = srv.estado.batches.length;
      await t.gw.sock.end(undefined);
      await t.gw.espera(300);
      assert.equal(t.inbound.estadoRecovery().status, FASE_RECOVERY.DONE);
      assert.equal(t.inbound.estadoRecovery().motivoFinal, "socket_closed");
      await t.gw.espera(500);
      assert.equal(srv.estado.batches.length, batchesAntes, "nenhum pedido depois do fechamento");
    } finally { await t.fim(); }
  });
});

describe("cenário 34 — nó vivo durante recovery: não compete, não flush", { timeout: 60_000 }, () => {
  test("um nó inequivocamente vivo chega durante RECOVERING ⇒ live_node; o flush que se segue é o NATIVO do Baileys (nó vivo), não o motor", async () => {
    const t = await abrir({ recovery: true });
    try {
      const nos = await gerarMensagensOffline(t.gw, 130);
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "nunca_envia_fim" });
      srv.iniciar(); await srv.aguardarBatches(1, 3000);
      assert.equal(await esperar(() => t.inbound.estadoRecovery()?.status === FASE_RECOVERY.RECOVERING, 4000), true);

      const par = await t.gw.criarPar("5511777770001@s.whatsapp.net");
      const viva = await t.gw.mensagemDireta(par, "viva"); delete viva.attrs.offline;
      await t.gw.entregarSemFimOffline(viva);

      assert.equal(await esperar(() => t.inbound.estadoRecovery()?.status === FASE_RECOVERY.DONE, 4000), true);
      assert.equal(t.inbound.estadoRecovery().motivoFinal, "live_node");
      assert.ok(t.gw.upserts.length >= 1, "o flush NATIVO do Baileys (provocado pelo nó vivo) liberou o que estava retido");
      assert.equal(t.porNome("inbound.offline_recovery_completed")[0].d.reason, "live_node");
    } finally { await t.fim(); }
  });
});

describe("cenário 67 — NÃO INTERFERÊNCIA: recovery desligado (kill-switch) é IDÊNTICO a recovery inexistente, mesmo em cenário de stall", { timeout: 90_000 }, () => {
  const SEM_ESPERA_PLACEHOLDER = { placeholderResendCache: { get: () => true, set() {}, del() {} } };
  const assinaturaFrames = (enviados) => enviados.map((n) => `${n.tag}|${n.attrs?.type ?? ""}|${(Array.isArray(n.content) ? n.content.map((c) => c.tag) : []).join(",")}`).sort();

  async function rodar(recoveryConstruido) {
    const t = await abrir({ recovery: recoveryConstruido && { ...RECOVERY_RAPIDO, habilitado: () => false }, opcoesBaileys: SEM_ESPERA_PLACEHOLDER });
    try {
      const { gw } = t;
      const nos = await gerarMensagensOffline(gw, 130, { pares: 15 });
      const srv = criarServidorOfflineFalso({ gw, nos, politica: "nunca_envia_fim" });
      srv.iniciar(); await srv.aguardarBatches(1, 3000);
      await gw.aguardarQuiescencia({ estavelMs: 500, maxMs: 20_000 });
      await gw.espera(800); // dá tempo de sobra para o watchdog observar o stall e, se fosse tentar, o motor "tentar" iniciar
      await gw.drenarEnviados();
      const foto = () => ({
        upserts: gw.upserts.length, bufferando: gw.bufferando(), frames: assinaturaFrames(gw.enviados),
        batches: srv.estado.batches.map((b) => b.count), auth: { ...gw.medir(), total: undefined },
      });
      return { foto: foto(), estadoRecovery: t.inbound.estadoRecovery(), stalled: t.porNome("inbound.offline_stalled_observed").length };
    } finally { await t.fim(); }
  }

  test("com offlineRecovery:false vs. com offlineRecovery construído mas habilitado()=>false: fio/buffer/auth idênticos; o motor nem tenta pedir batch", async () => {
    const semRecovery = await rodar(false);
    const comRecoveryDesligado = await rodar(true);
    assert.deepEqual(comRecoveryDesligado.foto, semRecovery.foto, "nenhuma diferença observável no fio/buffer/auth com o kill-switch desligado");
    assert.equal(semRecovery.estadoRecovery, undefined, "sem offlineRecovery, o módulo nem existe");
    assert.equal(comRecoveryDesligado.estadoRecovery.status, FASE_RECOVERY.IDLE, "existe, mas nunca saiu de IDLE");
    assert.equal(comRecoveryDesligado.foto.batches.length, 1, "só o offline_batch automático do Baileys — nenhum pedido do motor");
    assert.ok(semRecovery.stalled >= 1 && comRecoveryDesligado.stalled >= 1, "o watchdog OBSERVE continua funcionando igual nos dois casos");
  });
});

describe("Checkpoint G.0.1 (Partes K-T) — auth headroom REAL (src/authHeadroom.js) integrado ao motor via Baileys real", { timeout: 90_000 }, () => {
  /** guarda real, com uma fonte CONTROLÁVEL pelo teste (nunca a real authState.js — isso já é coberto em authState.test.js) */
  function guardaControlavel(corpoBytesInicial) {
    let corpoBytes = corpoBytesInicial;
    const guarda = criarGuardaAuthHeadroom({ obterUltimoTamanho: () => (corpoBytes === undefined ? null : { corpoBytes }) });
    return { guarda, setar: (v) => { corpoBytes = v; } };
  }

  test("headroom OK (baixo uso) ⇒ recovery inicia e completa normalmente", async () => {
    const { guarda } = guardaControlavel(1000); // uso desprezível
    const t = await abrir({ recovery: { ...RECOVERY_RAPIDO, lerAuthHeadroomOk: () => guarda.ok() } });
    try {
      const nos = await gerarMensagensOffline(t.gw, 130);
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "fim_ao_esgotar" });
      srv.iniciar(); await srv.aguardarBatches(1, 3000);
      assert.equal(await esperar(() => t.gw.upserts.length === 130, 6000), true);
      assert.equal(t.porNome("inbound.offline_recovery_completed")[0]?.d.reason, "marker_received");
    } finally { await t.fim(); }
  });

  test("headroom insuficiente ANTES do início ⇒ recovery nunca inicia (fila fica travada, exatamente como sem recovery)", async () => {
    const { guarda } = guardaControlavel(1_000_000); // > 85% de 1 MiB
    const t = await abrir({ recovery: { ...RECOVERY_RAPIDO, lerAuthHeadroomOk: () => guarda.ok() } });
    try {
      const nos = await gerarMensagensOffline(t.gw, 130);
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "nunca_envia_fim" });
      srv.iniciar(); await srv.aguardarBatches(1, 3000);
      await t.gw.aguardarQuiescencia({ estavelMs: 400, maxMs: 10_000 });
      await esperar(() => t.inbound.estadoObserve()?.fase === "OFFLINE_STALLED_OBSERVED", 4000);
      await t.gw.espera(500);
      assert.equal(t.inbound.estadoRecovery().status, FASE_RECOVERY.IDLE);
      assert.equal(srv.estado.batches.length, 1, "nenhum offline_batch extra — recovery nem tentou");
      assert.equal(t.porNome("inbound.offline_recovery_started").length, 0);
    } finally { await t.fim(); }
  });

  test("headroom cai DURANTE o recovery (entre lotes) ⇒ aborta com auth_headroom antes do próximo batch, sem flush manual", async () => {
    const { guarda, setar } = guardaControlavel(1000); // começa OK
    const t = await abrir({ recovery: { ...RECOVERY_RAPIDO, lerAuthHeadroomOk: () => guarda.ok() } });
    try {
      const nos = await gerarMensagensOffline(t.gw, 130);
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "nunca_envia_fim" });
      srv.iniciar(); await srv.aguardarBatches(1, 3000);
      assert.equal(await esperar(() => t.inbound.estadoRecovery()?.status === FASE_RECOVERY.RECOVERING, 4000), true, "iniciou com headroom OK");
      setar(1_000_000); // headroom piora no meio do recovery
      assert.equal(await esperar(() => t.inbound.estadoRecovery()?.status === FASE_RECOVERY.DONE, 4000), true);
      assert.equal(t.inbound.estadoRecovery().motivoFinal, "auth_headroom");
      assert.equal(t.porNome("inbound.offline_recovery_aborted")[0].d.reason, "auth_headroom");
      assert.equal(t.gw.upserts.length, 0, "nada foi liberado — sem flush manual");
    } finally { await t.fim(); }
  });

  test("métrica AUSENTE (nunca gravou auth-state) ⇒ fail-closed, recovery nunca inicia", async () => {
    const { guarda } = guardaControlavel(undefined); // obterUltimoTamanho() devolve null
    const t = await abrir({ recovery: { ...RECOVERY_RAPIDO, lerAuthHeadroomOk: () => guarda.ok() } });
    try {
      const nos = await gerarMensagensOffline(t.gw, 130);
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "nunca_envia_fim" });
      srv.iniciar(); await srv.aguardarBatches(1, 3000);
      await esperar(() => t.inbound.estadoObserve()?.fase === "OFFLINE_STALLED_OBSERVED", 4000);
      await t.gw.espera(500);
      assert.equal(t.inbound.estadoRecovery().status, FASE_RECOVERY.IDLE);
      assert.equal(srv.estado.batches.length, 1);
    } finally { await t.fim(); }
  });

  test("valor INVÁLIDO de corpoBytes (NaN) ⇒ fail-closed, recovery nunca inicia", async () => {
    const { guarda } = guardaControlavel(NaN);
    const t = await abrir({ recovery: { ...RECOVERY_RAPIDO, lerAuthHeadroomOk: () => guarda.ok() } });
    try {
      const nos = await gerarMensagensOffline(t.gw, 130);
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "nunca_envia_fim" });
      srv.iniciar(); await srv.aguardarBatches(1, 3000);
      await esperar(() => t.inbound.estadoObserve()?.fase === "OFFLINE_STALLED_OBSERVED", 4000);
      await t.gw.espera(500);
      assert.equal(t.inbound.estadoRecovery().status, FASE_RECOVERY.IDLE);
      assert.equal(srv.estado.batches.length, 1);
    } finally { await t.fim(); }
  });

  test("headroom baixo NÃO afeta o OBSERVE: o watchdog continua funcionando normalmente mesmo bloqueando o recovery", async () => {
    const { guarda } = guardaControlavel(1_000_000);
    const t = await abrir({ recovery: { ...RECOVERY_RAPIDO, lerAuthHeadroomOk: () => guarda.ok() } });
    try {
      const nos = await gerarMensagensOffline(t.gw, 130);
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "nunca_envia_fim" });
      srv.iniciar(); await srv.aguardarBatches(1, 3000);
      assert.equal(await esperar(() => t.porNome("inbound.offline_stalled_observed").length >= 1, 4000), true, "OBSERVE detectou o stall normalmente");
      assert.equal(t.inbound.estadoRecovery().status, FASE_RECOVERY.IDLE, "só o recovery ficou bloqueado");
    } finally { await t.fim(); }
  });
});
