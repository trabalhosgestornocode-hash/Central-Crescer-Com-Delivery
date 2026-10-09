// Montagem do poller de Events do iFood — COMPARTILHADA pelos dois hosts:
//
//   dedicado   src/worker-ifood/index.js      (Background Worker: processo próprio, lifecycle.js)
//   embarcado  src/worker-ifood/embedded.js   (Web Service: supervisor.js, nunca encerra o processo)
//
// Os dois usam o MESMO poller, service, repositórios, lease e loop. Só muda o host (quem dá vida ao loop e o
// que acontece quando ele termina). Nada aqui registra sinal, cria timer ou chama process.exit.
//
// Imports dinâmicos de propósito: este módulo só é carregado quando o Events vai de fato rodar — com a flag
// desligada nenhum módulo de token/repositório (que exigem a config do backend) entra no processo.

import { IFOOD_EVENTS } from "../modules/ifood/ifood.constants.js";

/** Prazo do POST de Broadcast do aviso do Checklist. */
export const TIMEOUT_BROADCAST_MS = 5_000;

/**
 * @param {{ env?: NodeJS.ProcessEnv, cfg: { intervaloMs: number, leaseTtlS: number } }} p
 *   `cfg` vem de carregarConfigWorkerIfood (intervalo e TTL já validados, com piso).
 * @returns {Promise<
 *   { ok: true, modo: string, holder: string, poller: object, criarLoop: (extras?: object) => object, intervaloMs: number, leaseTtlS: number }
 *   | { ok: false, motivo: string }>}
 */
export async function montarRuntimeEventsIfood({ env = process.env, cfg }) {
  const os = await import("node:os");
  const { randomBytes } = await import("node:crypto");
  const tokenService = await import("../modules/ifood/ifoodToken.service.js");
  const repoEvents = await import("../modules/ifood/ifoodEvents.repository.js");
  const repoOrder = await import("../modules/ifood/ifoodOrder.repository.js");
  const { criarPoller, criarLoopDoPoller } = await import("../modules/ifood/ifoodEvents.poller.js");
  const { MODOS_AUTH } = await import("../modules/ifood/ifoodAuthProvider.js");
  const { centralizadoTestePermitido } = await import("../modules/ifood/ifood.ambienteTeste.js");

  const modo = tokenService.modoDeAutenticacao();
  if (modo === MODOS_AUTH.CENTRALIZED_TEST) {
    const permitido = centralizadoTestePermitido(env);
    if (!permitido.ok) return { ok: false, motivo: `modo centralized_test não permitido (${permitido.motivos.join("; ")})` };
  }

  // Identidade desta instância no lease. Em deploy com duas instâncias, cada uma tem a sua.
  const holder = `${os.hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
  const repo = { ...repoEvents, ...repoOrder };
  // Order Details (Checkpoint C) exige a migration 102: só liga com IFOOD_ORDER_DETAILS_ENABLED=true.
  const detalhes = env.IFOOD_ORDER_DETAILS_ENABLED === "true" ? {} : null;
  const poller = criarPoller({ repo, token: tokenService, holder, leaseTtlS: cfg.leaseTtlS, detalhes });

  // Realtime do Checklist Operacional — SÓ com IFOOD_CHECKLIST_REALTIME_ENABLED=true (padrão desligado). Depois
  // que um pedido muda (já gravado), avisa SÓ o tópico privado da unidade — sinal de invalidação, a tela
  // reconsulta o resumo. Agendado e nunca aguardado: não atrasa o ciclo, o ACK nem o lease; falha só vira log
  // (ver ifoodPedidosAviso.js). Flag desligada: nem o módulo de Realtime é carregado aqui.
  const aviso = await import("../modules/ifood/ifoodPedidosAviso.js");
  const { ifoodLog } = await import("../modules/ifood/ifood.logsafe.js");
  if (aviso.checklistRealtimeHabilitado(env)) {
    const { emitirEventoRealtime } = await import("../modules/realtime/emitirEvento.js");
    // Prazo próprio do POST do aviso (o envio padrão, usado pelo Dashboard iFood, não muda).
    const fetchComPrazo = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_BROADCAST_MS) });
    aviso.registrarDestinoAvisoPedidos(({ organizacaoId, unidadeId }) => emitirEventoRealtime(
      { tipo: aviso.EVENTO_PEDIDOS_ATUALIZADOS, organizacaoId, unidadeId },
      {
        somenteUnidade: true,
        fetchImpl: fetchComPrazo,
        log: (_msg, err) => ifoodLog("warn", "pedidos.aviso_realtime_falhou", { erro: String(err?.message ?? err).slice(0, 200) }),
      },
    ));
    ifoodLog("info", "pedidos.aviso_realtime", { habilitado: true });
  } else {
    aviso.registrarDestinoAvisoPedidos(null);
    ifoodLog("info", "pedidos.aviso_realtime", { habilitado: false, motivo: `${aviso.FLAG_CHECKLIST_REALTIME} != true` });
  }

  return {
    ok: true, modo, holder, poller,
    criarLoop: (extras = {}) => criarLoopDoPoller({ poller, intervaloMs: cfg.intervaloMs, ...extras }),
    intervaloMs: Math.max(cfg.intervaloMs, IFOOD_EVENTS.intervaloMinimoMs),
    leaseTtlS: cfg.leaseTtlS,
  };
}
