// Repositório de Order do iFood (Supabase) — migration 102.
//
// ISOLAMENTO MULTI-TENANT: toda leitura "do tenant" filtra por organizacao_id + unidade_id e toda
// escrita por id + organizacao_id + unidade_id. `order_id` é UNIQUE (um pedido, um tenant), então
// um orderId de outra unidade simplesmente não aparece (`obterPedidoDoTenant` devolve null).
// Sem regra de negócio aqui: as decisões ficam em ifoodOrder.service.js.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

const T = { pedidos: "ifood_pedidos", acoes: "ifood_pedido_acoes", conexoes: "ifood_conexoes" };

const ok = (res) => {
  if (res.error) throw ApiError.internal(res.error.message);
  return res.data;
};

/** Pedido SÓ se pertencer à organização/unidade informadas (senão null — nunca revela o de outro tenant). */
export async function obterPedidoDoTenant({ organizacaoId, unidadeId, orderId }) {
  return ok(await supabase.from(T.pedidos).select("*")
    .eq("order_id", orderId).eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).maybeSingle());
}

/** Conexão viva que liga o merchant do pedido à unidade (fonte do `conexaoId` para o token distribuído). */
export async function obterConexaoAtivaDoMerchant({ organizacaoId, unidadeId, merchantId }) {
  return ok(await supabase.from(T.conexoes).select("id, organizacao_id, unidade_id, merchant_id")
    .eq("status", "ativa").eq("merchant_id", merchantId)
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).maybeSingle());
}

/**
 * UPDATE com compare-and-set: só grava se as `condicoes` (colunas = valor) ainda valem.
 * Devolve true se gravou (1 linha).
 */
export async function atualizarPedido({ pedido, campos, condicoes = {} }) {
  let q = supabase.from(T.pedidos).update(campos)
    .eq("id", pedido.id).eq("organizacao_id", pedido.organizacao_id).eq("unidade_id", pedido.unidade_id);
  for (const [coluna, valor] of Object.entries(condicoes)) q = valor === null ? q.is(coluna, null) : q.eq(coluna, valor);
  return (ok(await q.select("id")) ?? []).length > 0;
}

/**
 * Candidatos à busca de detalhes: ainda sem sucesso, com tentativas sobrando e dentro da retenção
 * (o iFood só guarda os detalhes por 7 dias). O service aplica o backoff e a janela de 10 min.
 */
export async function listarPedidosComDetalhesPendentes({ limite, maxTentativas, apartirDeIso }) {
  return ok(await supabase.from(T.pedidos).select("*")
    .in("details_status", ["PENDENTE", "NAO_ENCONTRADO", "ERRO"])
    .lt("details_tentativas", maxTentativas)
    .gte("primeiro_evento_em", apartirDeIso)
    .order("details_ultima_tentativa_em", { ascending: true, nullsFirst: true })
    .limit(limite)) ?? [];
}

/**
 * Auditoria de ação (best-effort: quem chama captura a falha). Os campos da migration 103 só vão na
 * requisição quando preenchidos — assim o `confirm` continua funcionando num banco só com a 102.
 * NUNCA receber token/segredo: `requestPayload`/`responsePayload` chegam já sanitizados (ver ifoodAcoes.util.js).
 */
export async function registrarAcao({
  pedido, acao, resultado, httpStatus = null, erroCodigo = null,
  conexaoId = null, tentativa = null, requestedAt = null, respondedAt = null, erroMensagem = null,
  requestPayload = null, responsePayload = null, disputeId = null,
}) {
  const extras = {
    conexao_id: conexaoId, tentativa, requested_at: requestedAt, responded_at: respondedAt, error_message: erroMensagem,
    request_payload: requestPayload, response_payload: responsePayload, dispute_id: disputeId,
  };
  const linha = {
    pedido_id: pedido.id, organizacao_id: pedido.organizacao_id, unidade_id: pedido.unidade_id,
    order_id: pedido.order_id, acao, resultado, http_status: httpStatus, erro_codigo: erroCodigo,
    ...Object.fromEntries(Object.entries(extras).filter(([, v]) => v !== null && v !== undefined)),
  };
  ok(await supabase.from(T.acoes).insert(linha).select("id"));
}

// =====================================================================
// DISPUTAS (Handshake) — migration 103
// =====================================================================

const D = "ifood_disputas";

/** Qualquer tenant (o handler de eventos usa para detectar disputa que já pertence a OUTRO tenant). */
export async function obterDisputaPorDisputeId(disputeId) {
  return ok(await supabase.from(D).select("*").eq("dispute_id", disputeId).maybeSingle());
}

/** Disputa SÓ se for do tenant informado (senão null). */
export async function obterDisputaDoTenant({ organizacaoId, unidadeId, disputeId }) {
  return ok(await supabase.from(D).select("*")
    .eq("dispute_id", disputeId).eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).maybeSingle());
}

/** Cria a linha (idempotente por dispute_id — ON CONFLICT DO NOTHING) e devolve a EXISTENTE/NOVA. */
export async function garantirDisputa(linha) {
  ok(await supabase.from(D).upsert(linha, { onConflict: "dispute_id", ignoreDuplicates: true }).select("id"));
  return obterDisputaPorDisputeId(linha.dispute_id);
}

/** UPDATE com compare-and-set (colunas = valor); sempre filtrado por id + organização + unidade. */
export async function atualizarDisputa({ disputa, campos, condicoes = {} }) {
  let q = supabase.from(D).update(campos)
    .eq("id", disputa.id).eq("organizacao_id", disputa.organizacao_id).eq("unidade_id", disputa.unidade_id);
  for (const [coluna, valor] of Object.entries(condicoes)) q = valor === null ? q.is(coluna, null) : q.eq(coluna, valor);
  return (ok(await q.select("id")) ?? []).length > 0;
}

export async function listarDisputasDoTenant({ organizacaoId, unidadeId, status = null, limite = 100 }) {
  let q = supabase.from(D).select("*").eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .order("expires_at", { ascending: true, nullsFirst: false }).limit(limite);
  if (status?.length) q = q.in("status", status);
  return ok(await q) ?? [];
}
