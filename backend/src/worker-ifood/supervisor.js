// Supervisor do loop de Events do iFood — HOST-AGNÓSTICO: não registra sinal, não cria servidor, NUNCA chama
// process.exit. Usado pelo modo embarcado (Web Service), onde o Events é um subsistema DEGRADÁVEL:
//
//   WEB saudável / EVENTS degradado   -> aceitável
//   EVENTS falhou / WEB caiu          -> inaceitável
//
// O que ele faz:
//   * dá vida ao loop serial de sempre (criarLoopDoPoller): lease, polling, persistência, ACK, backoff por ciclo;
//   * se o PRÓPRIO loop terminar ou quebrar (algo que o loop não capturou), registra, marca `degraded` e cria
//     um loop novo depois de um backoff crescente — sem derrubar nada;
//   * traduz o resultado de cada ciclo em estado operacional e guarda o mínimo para observabilidade;
//   * para graciosamente: espera o ciclo em voo até o prazo e só então libera o lease.
//
// Estados: starting -> active | waiting_lease | degraded -> stopping -> stopped.
//   waiting_lease: outra instância tem o lease (deploy com duas instâncias). É NORMAL, não é erro.
// O estado `disabled` é do host (flag desligada): o supervisor nem é criado.
//
// Nunca guarda nem loga token, segredo, header ou payload: só códigos, contagens e horários.

import { ifoodLog, mascararId } from "../modules/ifood/ifood.logsafe.js";

export const ESTADOS_EVENTS = Object.freeze({
  DISABLED: "disabled",
  STARTING: "starting",
  ACTIVE: "active",
  WAITING_LEASE: "waiting_lease",
  DEGRADED: "degraded",
  STOPPING: "stopping",
  STOPPED: "stopped",
});

const REINICIO_BASE_MS = 5_000;
const REINICIO_MAX_MS = 5 * 60_000;

const msg = (e) => String(e?.message ?? e).slice(0, 200);

/** Resultado de um ciclo (poller.executarCiclo) -> estado do subsistema. */
export function estadoDoCiclo(r) {
  switch (r?.estado) {
    case "OK": case "SEM_MERCHANTS": case "SEM_CONEXOES_APTAS": return { estado: ESTADOS_EVENTS.ACTIVE, motivo: null };
    case "LEASE_DE_OUTRO": return { estado: ESTADOS_EVENTS.WAITING_LEASE, motivo: "lease_de_outra_instancia" };
    case "LEASE_PERDIDO": return { estado: ESTADOS_EVENTS.WAITING_LEASE, motivo: "lease_perdido" };
    case "PARCIAL": return { estado: ESTADOS_EVENTS.DEGRADED, motivo: "conexoes_com_falha" };
    case "RATE_LIMITED": return { estado: ESTADOS_EVENTS.DEGRADED, motivo: "rate_limited" };
    default: return { estado: ESTADOS_EVENTS.DEGRADED, motivo: r?.codigo ? `erro:${r.codigo}` : "erro" };
  }
}

/**
 * @param {{
 *   poller: { encerrar: () => Promise<boolean>, info?: object },
 *   criarLoop: (callbacks: { aoFinalizarCiclo: Function, aoAgendarProximo: Function }) => { iniciar: () => Promise<void>, parar: (o?: object) => Promise<object> },
 *   log?: Function, agora?: () => Date, dormir?: (ms: number, aoCriar: (acordar: Function) => void) => Promise<void>,
 *   reinicioBaseMs?: number, reinicioMaxMs?: number, intervaloMs?: number | null,
 * }} p
 */
export function criarSupervisorEvents({
  poller, criarLoop, log = ifoodLog, agora = () => new Date(), dormir,
  reinicioBaseMs = REINICIO_BASE_MS, reinicioMaxMs = REINICIO_MAX_MS, intervaloMs = null,
}) {
  const estado = {
    estado: ESTADOS_EVENTS.STARTING, motivo: null, desde: agora().toISOString(),
    ultimoCicloEm: null, ultimoCicloOkEm: null, ultimoResultado: null, ultimaDuracaoMs: null,
    ultimoErro: null, proximaTentativaEm: null,
    reinicios: 0,
    conexoes: { processadas: 0, ignoradas: 0, comFalha: 0 },
  };
  let reiniciosSeguidos = 0;
  let parando = false;
  let loopAtual = null;
  let loopRodando = false;
  let promessa = null;
  let parada = null;
  let acordar = null;

  const iso = () => agora().toISOString();

  // Espera interrompível pela parada. SEM unref: num worker dedicado é o que mantém o processo vivo entre
  // reinícios; no Web Service o servidor HTTP já mantém — e a parada sempre acorda e limpa este timer.
  const esperar = dormir
    ? (ms) => dormir(ms, (fn) => { acordar = fn; })
    : (ms) => new Promise((resolve) => {
      const t = setTimeout(() => { acordar = null; resolve(); }, ms);
      acordar = () => { clearTimeout(t); acordar = null; resolve(); };
    });

  function mudar(novo, motivo = null) {
    if (estado.estado === novo && estado.motivo === motivo) return;
    const de = estado.estado;
    estado.estado = novo; estado.motivo = motivo; estado.desde = iso();
    const nivel = novo === ESTADOS_EVENTS.DEGRADED ? "warn" : "info";
    log(nivel, "events.supervisor_estado", { de, para: novo, motivo });
  }

  // Callbacks do loop: NUNCA lançam (uma exceção aqui viraria falha do loop).
  function aoFinalizarCiclo(r) {
    try {
      const inicio = poller.info?.ultimoCiclo ? Date.parse(poller.info.ultimoCiclo) : null;
      estado.ultimoCicloEm = iso();
      estado.ultimaDuracaoMs = inicio ? Math.max(0, agora().getTime() - inicio) : null;
      estado.ultimoResultado = r?.estado ?? null;
      estado.conexoes = {
        processadas: Math.max(0, (r?.grupos ?? 0) - (r?.conexoesComFalha?.length ?? 0)),
        ignoradas: r?.conexoesIgnoradas?.length ?? 0,
        comFalha: r?.conexoesComFalha?.length ?? 0,
      };
      const e = estadoDoCiclo(r);
      if (e.estado === ESTADOS_EVENTS.ACTIVE) { estado.ultimoCicloOkEm = estado.ultimoCicloEm; reiniciosSeguidos = 0; }
      if (r?.estado === "ERRO" || r?.estado === "RATE_LIMITED") estado.ultimoErro = { codigo: r?.codigo ?? r.estado, em: estado.ultimoCicloEm };
      if (!parando) mudar(e.estado, e.motivo);
      log("info", "events.ciclo_resumo", {
        estado: r?.estado ?? null, duracaoMs: estado.ultimaDuracaoMs, polls: r?.polls ?? 0, eventos: r?.eventos ?? 0,
        novos: r?.novos ?? 0, acks: r?.acks ?? 0, ...estado.conexoes,
      });
    } catch (e) {
      log("warn", "events.supervisor_registro_falhou", { erro: msg(e) });
    }
  }

  function aoAgendarProximo(esperaMs) {
    try { estado.proximaTentativaEm = new Date(agora().getTime() + esperaMs).toISOString(); } catch { /* só observabilidade */ }
  }

  async function supervisionar() {
    while (!parando) {
      let motivo;
      let erro;
      loopAtual = criarLoop({ aoFinalizarCiclo, aoAgendarProximo });
      loopRodando = true;
      try {
        await loopAtual.iniciar();
        motivo = "loop_retornou";
      } catch (e) {
        motivo = "loop_falhou";
        erro = e;
      } finally {
        loopRodando = false;
      }
      if (parando) break;

      // O loop serial já captura erro de ciclo; chegar aqui é algo inesperado. Nunca encerra o processo.
      reiniciosSeguidos += 1;
      estado.reinicios += 1;
      const esperaMs = Math.min(reinicioMaxMs, reinicioBaseMs * 2 ** Math.min(reiniciosSeguidos - 1, 10));
      estado.ultimoErro = { codigo: erro?.codigo ?? motivo, em: iso() };
      estado.proximaTentativaEm = new Date(agora().getTime() + esperaMs).toISOString();
      log("error", "events.supervisor_loop_terminou", { motivo, erro: erro === undefined ? null : msg(erro), reinicios: estado.reinicios, esperaMs });
      mudar(ESTADOS_EVENTS.DEGRADED, motivo);
      await esperar(esperaMs);
    }
  }

  return {
    /** Começa a supervisionar. Idempotente. A promise devolvida NUNCA rejeita. */
    iniciar() {
      promessa ??= supervisionar().catch((e) => {
        // Defesa em profundidade: nem um erro do próprio supervisor sobe para o processo.
        log("error", "events.supervisor_falhou", { erro: msg(e) });
        mudar(ESTADOS_EVENTS.DEGRADED, "supervisor_falhou");
      });
      return promessa;
    },

    /**
     * Para: nenhum ciclo novo; espera o ciclo em voo até `prazoMs`; libera o lease SÓ se o ciclo terminou.
     * Idempotente: chamadas repetidas devolvem a mesma parada. Nunca rejeita.
     * @returns {Promise<{drenado: boolean, leaseLiberado: boolean}>}
     */
    parar({ prazoMs = 7_000 } = {}) {
      if (parada) return parada;
      parando = true;
      mudar(ESTADOS_EVENTS.STOPPING);
      acordar?.();
      parada = (async () => {
        let r;
        try {
          if (loopAtual && loopRodando) r = await loopAtual.parar({ prazoMs });
          else r = { drenado: true, leaseLiberado: (await poller.encerrar()) === true };   // entre reinícios: nada em voo
        } catch (e) {
          log("error", "events.supervisor_erro_na_parada", { erro: msg(e) });
          r = { drenado: false, leaseLiberado: false };
        }
        mudar(ESTADOS_EVENTS.STOPPED);
        log(r.drenado ? "info" : "warn", "events.supervisor_parado", r.drenado ? r : { ...r, aviso: "ciclo em voo além do prazo: lease mantido até vencer (TTL)" });
        return r;
      })();
      return parada;
    },

    /** Foto do estado (cópia), sem segredo. Titular do lease mascarado. */
    obterEstado() {
      const lease = poller.info?.lease;
      return {
        ...estado,
        conexoes: { ...estado.conexoes },
        ultimoErro: estado.ultimoErro ? { ...estado.ultimoErro } : null,
        intervaloMs,
        lease: lease ? { souTitular: lease.souTitular === true, titular: mascararId(lease.titular), ate: lease.ate ?? null } : null,
      };
    },
  };
}
