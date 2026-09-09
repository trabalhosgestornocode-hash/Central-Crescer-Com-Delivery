// Helpers compartilhados entre os serviços do Parser Food Delivery
// (service.js, entregadores.js, lancamentos.js) — extraídos de service.js
// sem mudança de comportamento, para não duplicar a resolução de unidade
// nem a gravação de auditoria.
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

const TABELA_AUDIT = "parser_fd_auditoria";

// ---------------------------------------------------------------------------
// UNIDADE-ALVO — mesmo princípio do Dashboard iFood/Bonificação Mensal:
// nunca confia em unidadeId vindo do cliente sem checar contra a sessão.
// ---------------------------------------------------------------------------
export async function resolverUnidade({ organizacaoId, unidadeId }) {
  if (!unidadeId) throw ApiError.badRequest("Selecione uma unidade para acessar o Parser Food Delivery.");
  const { data: unidade, error } = await supabase.from("unidades")
    .select("id, nome, organizacao_id").eq("id", unidadeId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!unidade || unidade.organizacao_id !== organizacaoId) throw ApiError.forbidden("Você não tem acesso a esta unidade.");
  return unidade;
}

/**
 * Auditoria genérica das ações da camada de ajustes (lançamentos e
 * entregadores) — reaproveita `parser_fd_auditoria`, mesma regra de ouro do
 * projeto: falha de auditoria NUNCA derruba a operação (só loga).
 * @param {{
 *   organizacaoId: string, unidadeId: string, acao: string, motivo?: string|null,
 *   lancamentoId?: string|null, entregadorId?: string|null, pedidoId?: string|null,
 *   numeroPedido?: string|null, importacaoId?: string|null,
 *   valorAntes?: number|null, valorDepois?: number|null,
 *   dadosAntes?: object|null, dadosDepois?: object|null,
 *   classificacaoAntes?: string|null, classificacaoDepois?: string|null,
 *   usuario?: {id?: string, nome?: string, email?: string}|null
 * }} p
 */
export async function registrarAuditoriaGenerica({
  organizacaoId, unidadeId, acao, motivo = null,
  lancamentoId = null, entregadorId = null, pedidoId = null,
  numeroPedido = null, importacaoId = null,
  valorAntes = null, valorDepois = null, dadosAntes = null, dadosDepois = null,
  classificacaoAntes = null, classificacaoDepois = null, usuario,
}) {
  const { error } = await supabase.from(TABELA_AUDIT).insert({
    importacao_id: importacaoId, organizacao_id: organizacaoId, unidade_id: unidadeId, acao, motivo,
    lancamento_id: lancamentoId, entregador_id: entregadorId, pedido_id: pedidoId, numero_pedido: numeroPedido,
    valor_antes: valorAntes, valor_depois: valorDepois, dados_antes: dadosAntes, dados_depois: dadosDepois,
    classificacao_antes: classificacaoAntes, classificacao_depois: classificacaoDepois,
    usuario_id: usuario?.id || null, usuario_nome: usuario?.nome || null, usuario_email: usuario?.email || null,
  });
  if (error) console.error("[parser-food-delivery] falha ao registrar auditoria:", error.message);
}
