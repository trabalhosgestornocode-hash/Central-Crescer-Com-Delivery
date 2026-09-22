// Laço serial do worker de comunicação — invólucro OPERACIONAL puro.
//
// NÃO implementa nenhuma regra de negócio: detecção de pendência, agendamento,
// policy, claim, rate-limit, cooldown, jitter, horário comercial, retry e
// provider já existem em comunicacao.alertas.service.js/whatsapp.service.js.
// Este módulo só decide QUANDO chamar executarCiclo() e nunca chama
// whatsapp.service.js/Gateway/provider diretamente.
//
// GATE GLOBAL MAIS FORTE que o já existente dentro de processarProximoLote:
// aqui, modo !== NORMAL significa que executarCiclo() NEM É CHAMADO — zero
// detecção persistida, zero agendamento, zero claim, zero provider durante a
// fase de validação do worker. Lê o modo pela MESMA função que o resto do
// módulo usa (comunicacao.config.js#modoAtual) — nenhuma segunda fonte de
// verdade.
//
// SEM setInterval: o próximo tick só é agendado DEPOIS que o anterior (e seu
// eventual executarCiclo) termina — nunca dois ciclos simultâneos na mesma
// instância. Segurança entre instâncias continua sendo o claim atômico do
// banco (FOR UPDATE SKIP LOCKED), não este laço.

import { MODOS } from "../modules/comunicacao/comunicacao.constants.js";

export const ESTADOS = Object.freeze({
  BOOTING: "BOOTING",
  IDLE: "IDLE",
  RUNNING: "RUNNING",
  DISABLED: "DISABLED",
  STOPPING: "STOPPING",
  ERROR: "ERROR",
});

const GRACE_PERIOD_PADRAO_MS = 12_000;

function resumoDoResultado(resultado) {
  const lote = Array.isArray(resultado?.lote) ? resultado.lote : [];
  return {
    detectados: resultado?.deteccao?.criados ?? 0,
    escalonados: resultado?.deteccao?.escalonados ?? 0,
    resolvidos: resultado?.deteccao?.resolvidos ?? 0,
    agendados: resultado?.agendamento?.agendados ?? 0,
    semDestinatario: resultado?.agendamento?.semDestinatario ?? 0,
    semHabilitacao: resultado?.agendamento?.semHabilitacao ?? 0,
    claimed: lote.length,
    sent: lote.filter((j) => j.resultado === "ENVIADO").length,
    blocked: lote.filter((j) => j.resultado === "BLOQUEADO" || j.resultado === "ADIADO").length,
    failed: lote.filter((j) => String(j.resultado).startsWith("FALHOU")).length,
    unknown: lote.filter((j) => j.resultado === "ENTREGA_INCERTA").length,
  };
}

/**
 * @param {{
 *   executarCiclo: Function, modoAtual: Function, whatsAppService: object,
 *   intervalMs: number, agora?: () => Date, log?: Function,
 *   gracePeriodMs?: number,
 * }} params
 */
export function criarLoopWorker({
  executarCiclo, modoAtual, whatsAppService, intervalMs,
  agora = () => new Date(), log = () => {}, gracePeriodMs = GRACE_PERIOD_PADRAO_MS,
}) {
  let estado = ESTADOS.BOOTING;
  let lastCycleAt = null;
  let lastCycleStatus = null;
  let parando = false;
  let promiseCicloAtual = null;
  let resolverSleepAtual = null;
  let promiseLoop = null;

  function dormir(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { resolverSleepAtual = null; resolve(); }, ms);
      resolverSleepAtual = () => { clearTimeout(timer); resolverSleepAtual = null; resolve(); };
    });
  }

  async function executarUmTick() {
    const modo = await modoAtual();
    log("info", "comunicacao.cycle_started", { mode: modo });

    if (modo !== MODOS.NORMAL) {
      estado = ESTADOS.DISABLED;
      log("info", "comunicacao.cycle_skipped", { reason: "global_disabled" });
      lastCycleAt = agora().toISOString();
      lastCycleStatus = "skipped";
      log("info", "comunicacao.cycle_completed", { status: "skipped" });
      return;
    }

    estado = ESTADOS.RUNNING;
    const p = executarCiclo({ whatsAppService, agora: agora() });
    promiseCicloAtual = p;
    try {
      const resultado = await p;
      lastCycleStatus = "completed";
      log("info", "comunicacao.cycle_completed", { status: "completed", ...resumoDoResultado(resultado) });
    } catch (e) {
      lastCycleStatus = "failed";
      log("error", "comunicacao.cycle_failed", { erro: String(e?.message ?? e).slice(0, 300) });
    } finally {
      promiseCicloAtual = null;
      lastCycleAt = agora().toISOString();
      estado = parando ? ESTADOS.STOPPING : ESTADOS.IDLE;
    }
  }

  async function loopPrincipal() {
    estado = ESTADOS.IDLE;
    log("info", "comunicacao.worker_ready", {});
    while (!parando) {
      // eslint-disable-next-line no-await-in-loop
      await executarUmTick();
      if (parando) break;
      // eslint-disable-next-line no-await-in-loop
      await dormir(intervalMs);
    }
  }

  /** Inicia o laço. Retorna a promise do laço (resolve quando `encerrar()` termina de drenar). */
  function iniciar() {
    log("info", "comunicacao.worker_boot", { intervalMs });
    promiseLoop = loopPrincipal();
    return promiseLoop;
  }

  /**
   * SIGTERM/SIGINT: marca STOPPING, impede ciclo novo, acorda um sleep em
   * andamento imediatamente (não espera o intervalo terminar à toa), espera
   * (até `gracePeriodMs`) um ciclo em voo terminar NATURALMENTE — nunca
   * cancela nem reverte status de mensagem (leases no banco cuidam de
   * qualquer coisa que não termine a tempo).
   * @param {string} sinal
   */
  async function encerrar(sinal) {
    if (parando) return;
    parando = true;
    estado = ESTADOS.STOPPING;
    log("warn", "comunicacao.worker_stopping", { sinal, cicloEmVoo: !!promiseCicloAtual });

    if (resolverSleepAtual) resolverSleepAtual();
    if (promiseCicloAtual) {
      await Promise.race([promiseCicloAtual.catch(() => {}), dormir(gracePeriodMs)]);
    }
    if (promiseLoop) await promiseLoop.catch(() => {});

    log("info", "comunicacao.worker_stopped", { sinal });
  }

  function obterEstado() {
    return { estado, lastCycleAt, lastCycleStatus };
  }

  return { iniciar, encerrar, obterEstado };
}
