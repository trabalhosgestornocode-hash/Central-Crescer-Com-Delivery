// Repositório de Events do iFood (Supabase) — migration 101.
//
// ISOLAMENTO MULTI-TENANT (organização -> unidade -> merchantId)
//   * O tenant NUNCA vem do evento: é resolvido pelo service a partir de
//     `ifood_conexoes` (merchant_id único entre conexões vivas — migration 056)
//     e gravado junto com o evento. Aqui só se persiste o que o service decidiu.
//   * Pedido: `ifood_pedidos.order_id` é UNIQUE (um pedido, um tenant). Toda
//     atualização de pedido filtra por id + organizacao_id + unidade_id.
//   * Backend usa service_role (ignora RLS): o isolamento efetivo é esta camada.
//
// Este módulo é a ÚNICA porta de acesso às tabelas ifood_eventos / ifood_pedidos /
// ifood_poller_lease. Sem regra de negócio: as decisões ficam em ifoodEvents.service.js.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

const T = { eventos: "ifood_eventos", pedidos: "ifood_pedidos", conexoes: "ifood_conexoes" };
const LOTE = 200; // ids por consulta .in(...)

const ok = (res) => {
  if (res.error) throw ApiError.internal(res.error.message);
  return res.data;
};

function emLotes(lista, tamanho = LOTE) {
  const out = [];
  for (let i = 0; i < lista.length; i += tamanho) out.push(lista.slice(i, i + tamanho));
  return out;
}

// =====================================================================
// MERCHANT -> TENANT
// =====================================================================

/**
 * Conexões vivas com merchant vinculado: a ÚNICA fonte de "qual merchant é de
 * qual organização/unidade". (uq_ifood_conexao_merchant_vivo garante 1:1.)
 * @returns {Promise<Array<{id, organizacao_id, unidade_id, merchant_id}>>}
 */
export async function listarConexoesComMerchant() {
  return ok(await supabase.from(T.conexoes)
    .select("id, organizacao_id, unidade_id, merchant_id")
    .eq("status", "ativa")
    .not("merchant_id", "is", null)) ?? [];
}

/**
 * Conexões ELEGÍVEIS para Events/Order no modo DISTRIBUÍDO: ativas, com merchant e COM credencial `order`
 * (conexão só com analytics/financial NÃO entra — ela não tem token de Events). Traz o status da credencial
 * (`credencial_order_status`): `reauth_required` continua na lista para ser MONITORADA — o poller a pula
 * sem chamar o iFood, e ela nunca impede as demais. `db` é injetável só para teste.
 * @returns {Promise<Array<{id, organizacao_id, unidade_id, merchant_id, credencial_order_status}>>}
 */
export async function listarConexoesElegiveisParaEvents({ db = supabase } = {}) {
  const linhas = ok(await db.from(T.conexoes)
    .select("id, organizacao_id, unidade_id, merchant_id, ifood_credenciais!inner(app_type, status)")
    .eq("status", "ativa")
    .not("merchant_id", "is", null)
    .eq("ifood_credenciais.app_type", "order")) ?? [];
  return linhas.map(({ ifood_credenciais: cred, ...c }) => {
    const credOrder = (Array.isArray(cred) ? cred : [cred]).find((x) => x?.app_type === "order");
    return { ...c, credencial_order_status: credOrder?.status ?? null };
  }).filter((c) => c.credencial_order_status !== null);
}

// =====================================================================
// EVENTOS
// =====================================================================

/**
 * Insere eventos com deduplicação ATÔMICA (ON CONFLICT (event_id) DO NOTHING).
 * Devolve só os `event_id` que foram de fato inseridos (os novos).
 * @param {Array<object>} linhas colunas de ifood_eventos
 * @returns {Promise<string[]>}
 */
export async function inserirEventos(linhas) {
  const inseridos = [];
  for (const lote of emLotes(linhas)) {
    const data = ok(await supabase.from(T.eventos)
      .upsert(lote, { onConflict: "event_id", ignoreDuplicates: true })
      .select("event_id"));
    for (const r of data ?? []) inseridos.push(r.event_id);
  }
  return inseridos;
}

export async function obterEventosPorIds(eventIds) {
  const out = [];
  for (const lote of emLotes(eventIds)) {
    out.push(...(ok(await supabase.from(T.eventos).select("*").in("event_id", lote)) ?? []));
  }
  return out;
}

/** O iFood entregou de novo eventos que já guardamos (observabilidade do throttling). */
export async function marcarReentregas(eventIds) {
  if (!eventIds.length) return 0;
  const { data, error } = await supabase.rpc("ifood_eventos_marcar_reentrega", { p_event_ids: eventIds });
  if (error) throw ApiError.internal(error.message);
  return data ?? 0;
}

/** Atualiza colunas de UM evento (status, processed_at, last_error, retry_count). */
export async function atualizarEvento(eventId, campos) {
  return ok(await supabase.from(T.eventos).update(campos).eq("event_id", eventId).select("event_id"));
}

/** Registra o ACK confirmado (HTTP 202). Só toca em quem ainda não tinha. */
export async function marcarAck(eventIds, quandoIso) {
  for (const lote of emLotes(eventIds)) {
    ok(await supabase.from(T.eventos)
      .update({ acknowledged_at: quandoIso })
      .in("event_id", lote)
      .is("acknowledged_at", null)
      .select("event_id"));
  }
}

/** Fila de reprocessamento: RECEBIDO/FALHOU com tentativas sobrando (tenant já resolvido). */
export async function listarEventosPendentes(limite, maxTentativas) {
  return ok(await supabase.from(T.eventos)
    .select("*")
    .in("processing_status", ["RECEBIDO", "FALHOU"])
    .lt("retry_count", maxTentativas)
    .not("organizacao_id", "is", null)
    .order("received_at", { ascending: true })
    .limit(limite)) ?? [];
}

// =====================================================================
// PEDIDOS (estrutura mínima)
// =====================================================================

export async function obterPedidoPorOrderId(orderId) {
  return ok(await supabase.from(T.pedidos).select("*").eq("order_id", orderId).maybeSingle());
}

/**
 * Garante o "esqueleto" do pedido (idempotente: order_id é UNIQUE) e o devolve.
 * O chamador compara organizacao_id/unidade_id do que voltou com o esperado —
 * divergência = pedido de OUTRO tenant (nunca é atualizado).
 */
export async function garantirPedido({ orderId, merchantId, organizacaoId, unidadeId, eventoEm }) {
  ok(await supabase.from(T.pedidos).upsert({
    order_id: orderId, merchant_id: merchantId,
    organizacao_id: organizacaoId, unidade_id: unidadeId,
    primeiro_evento_em: eventoEm ?? null, ultimo_evento_em: eventoEm ?? null,
  }, { onConflict: "order_id", ignoreDuplicates: true }).select("id"));
  return obterPedidoPorOrderId(orderId);
}

/**
 * COMPARE-AND-SET do estado oficial: só grava se `status_oficial_em` ainda for o
 * que o service leu (evita sobrescrever por corrida). Devolve true se gravou.
 */
export async function aplicarStatusPedido({ pedido, esperadoStatusEm, novo }) {
  let q = supabase.from(T.pedidos)
    .update({
      status_oficial: novo.status,
      status_oficial_evento_id: novo.eventId,
      status_oficial_em: novo.em,
      ultimo_evento_em: novo.ultimoEventoEm,
      ...(novo.extras ?? {}),      // carimbos de SLA e resolução da ação (ver extrasDoEvento)
    })
    .eq("id", pedido.id)
    .eq("organizacao_id", pedido.organizacao_id)
    .eq("unidade_id", pedido.unidade_id);
  q = esperadoStatusEm == null ? q.is("status_oficial_em", null) : q.eq("status_oficial_em", esperadoStatusEm);
  const data = ok(await q.select("id"));
  return (data ?? []).length > 0;
}

/** Atualiza os limites de tempo dos eventos vistos e as colunas extras (SLA/ação). Não altera o estado. */
export async function registrarEventoNoPedido({ pedido, eventoEm, extras }) {
  const patch = { ...(extras ?? {}) };
  if (eventoEm) {
    if (!pedido.primeiro_evento_em || eventoEm < pedido.primeiro_evento_em) patch.primeiro_evento_em = eventoEm;
    if (!pedido.ultimo_evento_em || eventoEm > pedido.ultimo_evento_em) patch.ultimo_evento_em = eventoEm;
  }
  if (!Object.keys(patch).length) return;
  ok(await supabase.from(T.pedidos).update(patch)
    .eq("id", pedido.id).eq("organizacao_id", pedido.organizacao_id).eq("unidade_id", pedido.unidade_id).select("id"));
}

// =====================================================================
// LEASE (um poller por vez — relógio do BANCO)
// =====================================================================

/** @returns {Promise<{adquirido: boolean, holder: string, leaseAte: string, geracao: number}>} */
export async function adquirirLease({ nome, holder, ttlS }) {
  const { data, error } = await supabase.rpc("ifood_lease_adquirir", { p_nome: nome, p_holder: holder, p_ttl_s: ttlS });
  if (error) throw ApiError.internal(error.message);
  const r = Array.isArray(data) ? data[0] : data;
  return { adquirido: r?.adquirido === true, holder: r?.lease_holder ?? null, leaseAte: r?.lease_ate ?? null, geracao: Number(r?.geracao ?? 0) };
}

export async function liberarLease({ nome, holder }) {
  const { data, error } = await supabase.rpc("ifood_lease_liberar", { p_nome: nome, p_holder: holder });
  if (error) throw ApiError.internal(error.message);
  return data === true;
}
