// iFood Events EMBARCADO no Web Service — ponte entre o boot/shutdown de src/server.js e o supervisor.
//
// MESMO ESPÍRITO de src/worker-comunicacao/lifecycle.js (worker de comunicação embutido):
//   * flag desligada (padrão) = "nada disso existe neste processo": runtime, poller, token e repositórios só
//     são importados DENTRO do branch habilitado. Sem a flag: zero polling, zero timer, zero chamada ao iFood.
//   * falhar aqui NUNCA derruba o backend: config inválida, banco fora ou iFood fora viram estado `degraded`
//     (logado alto e claro) e o resto da Central segue servindo.
//   * nunca registra handler de sinal nem chama process.exit: o shutdown é o do server.js, que chama
//     pararEventsIfoodEmbutido() no MESMO handler de SIGTERM/SIGINT de sempre.
//
// Flag própria — IFOOD_EVENTS_EMBEDDED_ENABLED=true. É independente de IFOOD_EVENTS_WORKER_ENABLED (worker
// dedicado, src/worker-ifood/index.js, que continua existindo como rota de escala). Se as duas estiverem
// ligadas em processos diferentes, o lease garante UM poller por vez — nunca dois.
//
// Boot: o chamador inicia isto DEPOIS do servidor HTTP estar ouvindo, sem `await` no caminho crítico.

import { carregarConfigWorkerIfood } from "./config.js";                       // puro
import { ifoodLog, mascararId } from "../modules/ifood/ifood.logsafe.js";      // puro
import { registrarEstadoEvents } from "../modules/ifood/ifoodEventsEstado.js"; // puro

// < fallback de 10 s do server.js; roda em paralelo com o grace (8 s) do worker de comunicação.
export const PRAZO_PARADA_EMBUTIDO_MS = 7_000;

/** O Events roda embarcado neste processo? Default: NÃO. Só o literal "true" liga (mesma regra das outras flags). */
export function eventsEmbutidoHabilitado(env = process.env) {
  return env.IFOOD_EVENTS_EMBEDDED_ENABLED === "true";
}

let pararAtual = null;   // parada do supervisor em execução, ou null

const msg = (e) => String(e?.message ?? e).slice(0, 300);

/**
 * Chamado uma vez, depois do `listen()`. Nunca rejeita e nunca bloqueia o boot.
 * @param {{
 *   env?: NodeJS.ProcessEnv, log?: Function,
 *   montarRuntime?: Function, criarSupervisor?: Function,
 * }} [p] `montarRuntime`/`criarSupervisor` são injetáveis SÓ para teste (sem Supabase nem iFood).
 */
export async function iniciarEventsIfoodEmbutido({ env = process.env, log = ifoodLog, montarRuntime, criarSupervisor } = {}) {
  if (!eventsEmbutidoHabilitado(env)) {
    registrarEstadoEvents(() => ({ estado: "disabled", motivo: "IFOOD_EVENTS_EMBEDDED_ENABLED != true" }));
    log("info", "events.embutido_desabilitado", { motivo: "IFOOD_EVENTS_EMBEDDED_ENABLED != true" });
    return { habilitado: false, estado: "disabled", motivo: "IFOOD_EVENTS_EMBEDDED_ENABLED != true" };
  }
  if (pararAtual) return { habilitado: true, estado: "already_started" };

  registrarEstadoEvents(() => ({ estado: "starting" }));
  try {
    const cfg = carregarConfigWorkerIfood(env);
    for (const a of cfg.avisos) log("warn", "events.config_ajustada", { aviso: a });

    const montar = montarRuntime ?? (await import("./runtime.js")).montarRuntimeEventsIfood;
    const runtime = await montar({ env, cfg });
    if (!runtime.ok) {
      // Configuração recusada (ex.: centralized_test fora do ambiente permitido): Events não roda, a Central sim.
      registrarEstadoEvents(() => ({ estado: "degraded", motivo: "config_recusada" }));
      log("error", "events.embutido_recusado", { motivo: runtime.motivo });
      return { habilitado: false, estado: "degraded", motivo: runtime.motivo };
    }

    const criar = criarSupervisor ?? (await import("./supervisor.js")).criarSupervisorEvents;
    const supervisor = criar({ poller: runtime.poller, criarLoop: runtime.criarLoop, log, intervaloMs: runtime.intervaloMs });
    registrarEstadoEvents(supervisor.obterEstado);
    pararAtual = (prazoMs) => supervisor.parar({ prazoMs });
    void supervisor.iniciar();   // fire-and-forget: a promise nunca rejeita

    log("info", "events.embutido_iniciado", {
      modo: runtime.modo, holder: mascararId(runtime.holder), intervaloMs: runtime.intervaloMs, leaseTtlS: runtime.leaseTtlS,
    });
    return { habilitado: true, estado: supervisor.obterEstado().estado };
  } catch (e) {
    registrarEstadoEvents(() => ({ estado: "degraded", motivo: "falha_ao_iniciar" }));
    log("error", "events.embutido_falhou_ao_iniciar", { erro: msg(e) });
    return { habilitado: false, estado: "degraded", motivo: "falha ao iniciar" };
  }
}

/**
 * Chamado pelo shutdown do server.js (o MESMO handler de SIGTERM/SIGINT — nunca registrar outro).
 * No-op se o Events nunca iniciou. Idempotente. Nunca rejeita.
 * @returns {Promise<{drenado: boolean, leaseLiberado: boolean} | null>}
 */
export async function pararEventsIfoodEmbutido(sinal, { prazoMs = PRAZO_PARADA_EMBUTIDO_MS, log = ifoodLog } = {}) {
  if (!pararAtual) return null;
  const parar = pararAtual;
  pararAtual = null;
  log("info", "events.embutido_parando", { sinal, prazoMs });
  try {
    return await parar(prazoMs);
  } catch (e) {
    log("error", "events.embutido_erro_na_parada", { erro: msg(e) });
    return { drenado: false, leaseLiberado: false };
  }
}
