// Checklist Operacional — LEITURA do banco (somente SELECT, sempre com o tenant).
//
// Lê `ifood_pedidos` com lista POSITIVA de colunas: só carimbos oficiais, estado, tipo e o número curto do
// pedido. Cliente, documento, endereço, itens e pagamentos nunca são selecionados aqui.
//
// O vínculo unidade ↔ loja iFood e o estado do recebimento vêm das funções JÁ existentes do módulo iFood
// (ifood.repository.js), usadas sem alteração.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

export const COLUNAS_PEDIDO_CHECKLIST = [
  "order_id", "display_id", "status_oficial", "status_oficial_em", "order_type", "delivery_by", "order_timing", "is_test",
  "order_created_at", "placed_event_created_at", "confirmed_event_at", "ready_event_at", "dispatch_event_at", "cancel_event_at",
  "primeiro_evento_em", "criado_em",
].join(", ");

/** Teto de linhas por consulta: uma loja não recebe isso em 2 dias; acima disso o resumo avisa (truncado). */
export const LIMITE_LINHAS = 2000;

/**
 * Pedidos do tenant registrados a partir de `desdeIso` (janela do dia operacional + folga para pedidos sem
 * conclusão). `criado_em` = quando a Central registrou o pedido — só delimita a janela, nunca entra em cálculo.
 */
export async function listarPedidosDaJanela({ organizacaoId, unidadeId, desdeIso, db = supabase }) {
  if (!organizacaoId || !unidadeId) throw ApiError.internal("Escopo de tenant ausente na consulta do Checklist.");
  const { data, error } = await db.from("ifood_pedidos").select(COLUNAS_PEDIDO_CHECKLIST)
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .gte("criado_em", desdeIso)
    .order("criado_em", { ascending: false })
    .limit(LIMITE_LINHAS);
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

/**
 * Quantos pedidos REAIS do tenant registrados ANTES da janela ainda estão em estado oficial não terminal.
 * Não somem da tela por serem antigos: entram na contagem de ativos e no alerta crítico. Só contagem.
 */
export async function contarAbertosAntesDe({ organizacaoId, unidadeId, antesIso, db = supabase }) {
  if (!organizacaoId || !unidadeId) throw ApiError.internal("Escopo de tenant ausente na consulta do Checklist.");
  const { count, error } = await db.from("ifood_pedidos").select("order_id", { count: "exact", head: true })
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .lt("criado_em", antesIso)
    .or("status_oficial.is.null,status_oficial.not.in.(CONCLUDED,CANCELLED)")
    .not("is_test", "is", true);   // IS NOT TRUE: inclui null e false
  if (error) throw ApiError.internal(error.message);
  return count ?? 0;
}
