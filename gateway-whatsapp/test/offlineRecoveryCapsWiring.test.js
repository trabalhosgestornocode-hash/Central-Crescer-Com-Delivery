// Checkpoint G.2.0 — prova de que os 5 caps do motor de OFFLINE_RECOVERY (agora configuráveis por env, ver
// src/config.js) chegam EXATAMENTE como o motor os receberia em 963ffd4 (quando nenhuma destas envs existia) e que
// server.js só os repassa quando o kill-switch está ligado. offlineRecovery.js e inboundScope.js são INALTERADOS
// por este checkpoint — não recriamos a suíte deles aqui, só a ponte nova (config.js -> server.js -> motor).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { criarMotorRecovery } from "../src/offlineRecovery.js";

const aqui = dirname(fileURLToPath(import.meta.url));

/** mesmo harness de relógio/timer falsos de test/offlineRecovery.test.js — timers só avançam via avancar(). */
function abrir(opcoesMotor) {
  let t = 1_700_000_000_000;
  const eventos = [];
  const timers = [];
  const est = { buffer: true, aberto: true, offlineFim: false, retidas: 5, fase: "OFFLINE_STALLED_OBSERVED", authOk: true, identidade: true, habilitado: true };
  const pedidos = [];
  const agendar = (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; };
  const cancelar = (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); };
  const motor = criarMotorRecovery({
    agora: () => t, emitir: (nivel, evento, dados) => eventos.push({ evento, dados }), obterEpoch: () => 1,
    agendar, cancelar, habilitado: () => est.habilitado, tickMs: 100,
    ...opcoesMotor,
  });
  const g = motor.novaGeracao({
    lerBufferAtivo: () => est.buffer, lerSocketAberto: () => est.aberto, lerOfflineFimRecebido: () => est.offlineFim,
    lerMensagensRetidas: () => est.retidas, lerFaseObservador: () => est.fase, lerAuthHeadroomOk: () => est.authOk,
    lerIdentidadeDisponivel: () => est.identidade, pedirBatch: () => pedidos.push(t),
  });
  function avancar(ms, passo = 100) { const alvo = t + ms; while (t < alvo) { t = Math.min(t + passo, alvo); motor.tick(g); } }
  function loteDeNos(n, unicos) { for (let i = 0; i < n; i++) motor.aoNo(g, { progressoUtil: i < unicos }); }
  const porNome = (n) => eventos.filter((x) => x.evento === n);
  return { motor, g, est, eventos, porNome, avancar, pedidos, loteDeNos };
}

describe("equivalência: campos undefined em offlineRecoveryLimites vs. chaves inexistentes (963ffd4)", () => {
  // cenário: 3 lotes com progresso, depois lotes sem progresso até o teto de 2 — idêntico nas duas construções.
  function cenario(a) {
    a.avancar(50); // início — pede o 1º batch
    for (let i = 0; i < 3; i++) { a.loteDeNos(10, 10); a.avancar(1000); } // 3 lotes com progresso
    a.loteDeNos(5, 0); a.avancar(1000); // sem progresso (1/2)
    a.loteDeNos(5, 0); a.avancar(1000); // sem progresso (2/2) — aborta
    return a.motor.estado();
  }

  test("SEM as 5 chaves (simula 963ffd4, antes deste checkpoint) e COM as 5 chaves = undefined (config.js sem nenhuma env) produzem o MESMO resultado", () => {
    const semChaves = abrir({ batchQuietMs: 1000, maxConsecutiveNoProgressBatches: 2 });
    const comChavesUndefined = abrir({
      batchQuietMs: 1000, maxConsecutiveNoProgressBatches: 2,
      maxRecoveryBatches: undefined, maxRecoveryNodes: undefined, maxRecoveryDurationMs: undefined,
    });
    const estadoSem = cenario(semChaves);
    const estadoCom = cenario(comChavesUndefined);
    assert.deepEqual(estadoCom, estadoSem);
    assert.equal(estadoSem.motivoFinal, "no_progress");
    assert.deepEqual(semChaves.pedidos, comChavesUndefined.pedidos, "mesmos instantes de pedirBatch nos dois");
  });
});

describe("caps do canário (1 batch / 120 nós / 15s / 1 sem-progresso / 5000ms de quietude) são honrados pelo motor tal como configurados", () => {
  test("com maxRecoveryBatches=1: o motor pede o 1º batch e para em max_batches assim que ele encerra com progresso (nunca pede um 2º)", () => {
    const a = abrir({ maxRecoveryBatches: 1, maxRecoveryNodes: 120, maxRecoveryDurationMs: 15_000, maxConsecutiveNoProgressBatches: 1, batchQuietMs: 5000 });
    a.avancar(50); // início — pede o batch #1
    assert.equal(a.pedidos.length, 1);
    a.loteDeNos(50, 50); // progresso — não é isto que vai parar o motor, é o teto de batches
    a.avancar(5000); // quietude do lote #1 atingida
    assert.equal(a.motor.estado().status, "DONE");
    assert.equal(a.motor.estado().motivoFinal, "max_batches");
    assert.equal(a.pedidos.length, 1, "nunca pediu um 2º batch — o canário é de EXATAMENTE 1 batch adicional");
  });

  test("com maxConsecutiveNoProgressBatches=1: um único lote sem progresso já aborta (mais restritivo que o default de 2)", () => {
    const a = abrir({ maxRecoveryBatches: 5, maxRecoveryNodes: 120, maxRecoveryDurationMs: 15_000, maxConsecutiveNoProgressBatches: 1, batchQuietMs: 5000 });
    a.avancar(50);
    a.loteDeNos(3, 0); // sem progresso
    a.avancar(5000);
    assert.equal(a.motor.estado().status, "DONE");
    assert.equal(a.motor.estado().motivoFinal, "no_progress");
  });
});

describe("server.js — wiring (Checkpoint G.2.0): mesmo padrão de teste por leitura de fonte já usado em test/offlineObserveOverlap.test.js, já que server.js nunca é importado em teste (efeitos colaterais: express, listen, socket)", () => {
  const server = readFileSync(join(aqui, "..", "src", "server.js"), "utf8");

  test("com o kill-switch desligado, offlineRecovery continua EXATAMENTE `false` — nenhuma mudança de comportamento", () => {
    assert.ok(/offlineRecovery: config\.offlineRecoveryHabilitado\s*\n\s*\? \{/.test(server), "a estrutura do ternário (condição inalterada) precisa continuar presente");
    assert.ok(/: false,\s*\n\}\);/.test(server), "o ramo `false` do ternário precisa continuar de pé, sem alteração, para o kill-switch");
  });

  test("com o kill-switch ligado, os 5 caps de config.offlineRecoveryLimites são espalhados junto dos callbacks já existentes (aoIniciar/lerAuthHeadroomOk)", () => {
    const bloco = server.match(/offlineRecovery: config\.offlineRecoveryHabilitado[\s\S]*?: false,/)?.[0];
    assert.ok(bloco, "bloco de wiring do offlineRecovery não encontrado em server.js");
    assert.match(bloco, /aoIniciar: \(\) => rastreadorOrigem\.promoverPendentesParaRecovery\(\)/);
    assert.match(bloco, /lerAuthHeadroomOk: \(\) => guardaAuthHeadroom\.ok\(\)/);
    assert.match(bloco, /\.\.\.config\.offlineRecoveryLimites,/);
  });

  test("nada além de offlineRecoveryLimites/aoIniciar/lerAuthHeadroomOk é passado no objeto do offlineRecovery — sem chaves inventadas", () => {
    const bloco = server.match(/offlineRecovery: config\.offlineRecoveryHabilitado[\s\S]*?: false,/)?.[0];
    const chaves = [...bloco.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).filter((k) => k !== "offlineRecovery");
    assert.deepEqual(chaves.sort(), ["aoIniciar", "lerAuthHeadroomOk"].sort());
  });
});
