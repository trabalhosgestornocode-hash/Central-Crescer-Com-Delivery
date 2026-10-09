// Checklist Operacional — resposta do endpoint montada com o CÁLCULO REAL do backend (puro, sem I/O), para os
// testes dos modos de exibição. Pedidos de teste: só aparecem em teste, nunca na tela de verdade.

import { montarResumo } from "../../backend/src/modules/checklist-operacional/checklistOperacional.calc.js";

export const ORG = "00000000-0000-4000-8000-0000000000e1";
export const UNIDADE = { id: "00000000-0000-4000-8000-0000000000c1", nome: "Unidade de teste Centro" };
export const OUTRA_UNIDADE = { id: "00000000-0000-4000-8000-0000000000b2", nome: "Unidade de teste Norte" };

/** Uma linha de `ifood_pedidos` com os carimbos oficiais, `min` minutos antes de `agora`. */
function linhaEm(agora, over = {}) {
  const iso = (min) => (min == null ? null : new Date(agora - min * 60_000).toISOString());
  const { criado = 60, confirmado = criado - 1, pronto = null, saida = null, conclusao = null, cancelado = null, ...resto } = over;
  return {
    order_id: `o-${resto.display_id ?? Math.random()}`, display_id: "0000", status_oficial: "CONCLUDED",
    status_oficial_em: iso(conclusao ?? cancelado ?? confirmado), order_type: "DELIVERY", delivery_by: "IFOOD",
    order_timing: "IMMEDIATE", is_test: false,
    order_created_at: iso(criado), placed_event_created_at: iso(criado), confirmed_event_at: iso(confirmado),
    ready_event_at: iso(pronto), dispatch_event_at: iso(saida), cancel_event_at: iso(cancelado),
    primeiro_evento_em: iso(criado), criado_em: iso(criado), ...resto,
  };
}

/** Um dia movimentado: concluídos, um cancelado e pedidos em todas as etapas (inclusive um aberto há mais de 4 h). */
export function pedidosDoDia(agora) {
  const l = (o) => linhaEm(agora, o);
  return [
    // concluídos (status CONCLUDED; conclusão = status_oficial_em)
    l({ display_id: "4101", criado: 180, confirmado: 179, pronto: 168, saida: 164, conclusao: 140 }),
    l({ display_id: "4102", criado: 150, confirmado: 149, pronto: 140, saida: 136, conclusao: 118 }),
    l({ display_id: "4103", criado: 120, confirmado: 119, pronto: 106, saida: 101, conclusao: 80 }),
    l({ display_id: "4104", criado: 95, confirmado: 94, pronto: 85, saida: 82, conclusao: 66 }),
    l({ display_id: "4105", criado: 70, confirmado: 69, pronto: 60, saida: 57, conclusao: 35 }),
    l({ display_id: "4106", criado: 55, confirmado: 54, pronto: 45, saida: 43, conclusao: 24 }),
    // cancelado
    l({ display_id: "4107", status_oficial: "CANCELLED", criado: 50, confirmado: 49, cancelado: 44 }),
    // em andamento
    l({ display_id: "4110", status_oficial: "PLACED", criado: 2, confirmado: null }),
    l({ display_id: "4111", status_oficial: "CONFIRMED", criado: 9, confirmado: 8 }),
    l({ display_id: "4112", status_oficial: "SEPARATION_STARTED", criado: 15, confirmado: 14 }),
    l({ display_id: "4113", status_oficial: "READY_TO_PICKUP", criado: 20, confirmado: 19, pronto: 6 }),
    l({ display_id: "4114", status_oficial: "DISPATCHED", criado: 30, confirmado: 29, pronto: 18, saida: 12 }),
    l({ display_id: "4115", status_oficial: "DISPATCHED", criado: 48, confirmado: 47, pronto: 36, saida: 27 }),
    l({ display_id: "4116", status_oficial: "CONFIRMED", criado: 300, confirmado: 299 }), // aberto há mais de 4 h
  ];
}

/** Dia de pico: `n` pedidos em andamento (etapas variadas) + os concluídos/cancelado do dia comum. */
export function pedidosEmMassa(agora, n) {
  const status = ["PLACED", "CONFIRMED", "SEPARATION_STARTED", "READY_TO_PICKUP", "DISPATCHED"];
  const ativos = Array.from({ length: n }, (_, i) => {
    const s = status[i % status.length];
    const criado = 3 + ((i * 7) % 170);
    return linhaEm(agora, {
      display_id: String(5000 + i), status_oficial: s, criado,
      confirmado: s === "PLACED" ? null : criado - 1,
      pronto: s === "READY_TO_PICKUP" || s === "DISPATCHED" ? Math.max(0, criado - 12) : null,
      saida: s === "DISPATCHED" ? Math.max(0, criado - 15) : null,
    });
  });
  return [...pedidosDoDia(agora).filter((p) => p.status_oficial === "CONCLUDED" || p.status_oficial === "CANCELLED"), ...ativos];
}

/** `data` de GET /api/v1/checklist-operacional/resumo. */
export function respostaResumo(agora, { pedidos = pedidosDoDia(agora), integracao, unidadeId = UNIDADE.id } = {}) {
  const r = montarResumo({ pedidos, agoraMs: agora });
  return {
    versao: 1, origem: "api", servidorEm: new Date(agora).toISOString(), atualizarEmS: 30,
    integracao: integracao ?? { estado: "ao_vivo", motivo: null, mensagem: null, ultimaSincronizacao: new Date(agora - 12_000).toISOString() },
    semPedidosNoDia: r.contagemDia.recebidos === 0 && r.pedidosAtivos.length === 0,
    ...r,
    avaliacoes: { disponivel: false, motivo: "As avaliações do iFood ainda não estão conectadas à Central." },
    tempoReal: { habilitado: false, avisosAtivos: false, topico: `unidade:${unidadeId}`, evento: "ifood_pedido.estado_atualizado" },
  };
}
