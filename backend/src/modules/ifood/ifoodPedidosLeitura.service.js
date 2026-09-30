// Pedidos iFood — LISTAGEM para a tela do app (somente leitura, somente banco local).
//
// Não chama a API do iFood, não dispara ação, não muda estado: só lê `ifood_pedidos` do tenant
// (organização + unidade do Context Token) e devolve um DTO enxuto. O estado exibido é o OFICIAL
// (status_oficial), que só muda por evento — o mesmo que o iFood vê.
//
// DADO PESSOAL NUNCA SAI DAQUI: cliente, documento, endereço, itens e pagamentos ficam no banco
// (backend-only). O DTO é montado por lista POSITIVA de campos (`paraPedidoDaLista`).

import * as repositorio from "./ifoodOrder.repository.js";

export const LIMITE_PEDIDOS_LISTA = 50;

const numOuNull = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** PURA: linha de `ifood_pedidos` -> item da lista (lista positiva de campos, sem PII). */
export function paraPedidoDaLista(p) {
  return {
    orderId: p.order_id,
    displayId: p.display_id ?? null,
    status: p.status_oficial ?? null,
    statusEm: p.status_oficial_em ?? null,
    tipo: p.order_type ?? null,
    entregaPor: p.delivery_by ?? null,
    canal: p.sales_channel ?? null,
    isTest: p.is_test === true,
    criadoEm: p.order_created_at ?? p.criado_em ?? null,
    total: numOuNull(p.total_order_amount),
    acaoPendente: (p.action_state ?? "none") !== "none",
    acaoIncerta: p.action_uncertain === true,
  };
}

/** Pedidos mais recentes do tenant (sem paginação: é a fila operacional, não o histórico). */
export async function listarPedidos({ organizacaoId, unidadeId, repo = repositorio, limite = LIMITE_PEDIDOS_LISTA }) {
  const linhas = await repo.listarPedidosDoTenant({ organizacaoId, unidadeId, limite });
  return { pedidos: (linhas ?? []).map(paraPedidoDaLista), limite };
}
