// Elegibilidade LOCAL das ações de pedido (ready, dispatch, cancel) — funções PURAS, sem I/O.
// Fica em módulo próprio para que scripts de preparação (D1: pré-ready) possam avaliar "o ready é elegível?" sem importar
// nenhum código capaz de ENVIAR a ação.

import { ifoodErro, IFOOD_ERROS } from "./ifood.errors.js";
import { STATUS_PEDIDO } from "./ifoodEvents.parser.js";

const S = STATUS_PEDIDO;
const TIPOS_READY = new Set(["TAKEOUT", "DINE_IN", "DELIVERY"]);      // "Obrigatório para TAKEOUT, DINE_IN e DELIVERY"
// Estados oficiais em que a ação JÁ foi executada (o evento correspondente já veio).
const JA_PRONTO = new Set([S.SEPARATION_ENDED, S.READY_TO_PICKUP, S.DISPATCHED, S.CONCLUDED]);
const JA_DESPACHADO = new Set([S.DISPATCHED, S.CONCLUDED]);

export const estadoInvalido = (detalhes) => ifoodErro(IFOOD_ERROS.IFOOD_PEDIDO_ESTADO_INVALIDO, { detalhes });
export const naoElegivel = (detalhes) => ifoodErro(IFOOD_ERROS.IFOOD_ACAO_NAO_ELEGIVEL, { detalhes });

/**
 * PURA: a ação é permitida para este pedido AGORA? (estado oficial + tipo + detalhes)
 * @returns {{tipo: 'OK'} | {tipo: 'JA_EXECUTADO'} | {tipo: 'AGUARDANDO_EVENTO', motivo: string}}  ou LANÇA (estado inválido / não elegível)
 */
export function avaliarElegibilidade(acao, pedido) {
  const st = pedido.status_oficial ?? null;
  const estado = pedido.action_state ?? "none";

  // Um cancelamento em andamento (aguardando evento) bloqueia as demais ações.
  if (acao !== "cancel" && /^cancel_(sending|requested)$/.test(estado)) throw estadoInvalido({ motivo: "cancelamento_em_andamento", statusOficial: st });

  if (acao === "ready") {
    if (JA_PRONTO.has(st)) return { tipo: "JA_EXECUTADO" };
    if (st !== S.CONFIRMED && st !== S.SEPARATION_STARTED) throw estadoInvalido({ statusOficial: st, exige: "CONFIRMED" });
    if (!pedido.order_type) throw estadoInvalido({ motivo: "detalhes_ausentes", statusOficial: st });
    if (!TIPOS_READY.has(pedido.order_type)) throw naoElegivel({ orderType: pedido.order_type });
    return { tipo: "OK" };
  }

  if (acao === "dispatch") {
    if (JA_DESPACHADO.has(st)) return { tipo: "JA_EXECUTADO" };
    if (st === S.CANCELLED || st === null || st === S.PLACED) throw estadoInvalido({ statusOficial: st });
    if (!pedido.order_type || !pedido.delivery_by) throw estadoInvalido({ motivo: "detalhes_ausentes", statusOficial: st });
    // "Apenas para entrega própria (DELIVERY com deliveredBy = MERCHANT)" — marketplace/TAKEOUT/DINE_IN não têm dispatch.
    if (pedido.order_type !== "DELIVERY" || pedido.delivery_by !== "MERCHANT") throw naoElegivel({ orderType: pedido.order_type, deliveredBy: pedido.delivery_by });
    if (st === S.READY_TO_PICKUP) return { tipo: "OK" };
    // dispatch ANTES do ready: nenhum POST. Se o ready já foi pedido e o evento ainda não chegou, é só esperar.
    if (/^ready_(sending|requested)$/.test(estado)) return { tipo: "AGUARDANDO_EVENTO", motivo: "ready_aguardando_evento" };
    throw estadoInvalido({ motivo: "ready_nao_comprovado", statusOficial: st, exige: "READY_TO_PICKUP" });
  }

  if (acao === "cancel") {
    if (st === S.CANCELLED) return { tipo: "JA_EXECUTADO" };
    if (st === null || st === S.CONCLUDED) throw estadoInvalido({ statusOficial: st });
    return { tipo: "OK" };
  }
  throw new Error(`ação desconhecida: ${acao}`);
}

/** Atalho para o pré-ready: `{elegivel, motivo}` sem lançar (o ready NÃO é enviado aqui). */
export function avaliarElegibilidadeReady(pedido) {
  try {
    const r = avaliarElegibilidade("ready", pedido);
    if (r.tipo === "OK") return { elegivel: true };
    return { elegivel: false, motivo: r.tipo };
  } catch (e) {
    return { elegivel: false, motivo: `${e.codigo}: ${JSON.stringify(e.details ?? {})}` };
  }
}
