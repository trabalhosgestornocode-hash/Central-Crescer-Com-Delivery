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
  "merchant_id",   // só para agrupar por loja no servidor (origem Sanduíches/Saladas); nunca sai na resposta
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

/**
 * Lojas ADICIONAIS da conexão da unidade (migration 117): só merchant, rótulo e estado — nada de token nem id de usuário.
 * Sem a tabela (migration ainda não aplicada) o erro sobe e o chamador trata como "sem lojas adicionais".
 */
export async function listarLojasExtras({ organizacaoId, unidadeId, conexaoId, db = supabase }) {
  if (!organizacaoId || !unidadeId || !conexaoId) throw ApiError.internal("Escopo de tenant ausente na consulta de lojas do Checklist.");
  const { data, error } = await db.from("ifood_conexao_lojas").select("merchant_id, rotulo, estado")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).eq("conexao_id", conexaoId).neq("estado", "desativada");
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

/**
 * Nome da loja como o próprio iFood informa nos detalhes de um pedido (`merchant.name`), um por merchant do tenant.
 * Só esse campo é lido do payload (nunca cliente, endereço, itens ou pagamento). Serve de rótulo quando não há um configurado.
 * @returns {Promise<Map<string,string>>}
 */
export async function obterNomesDasLojas({ organizacaoId, unidadeId, merchantIds, db = supabase }) {
  if (!organizacaoId || !unidadeId) throw ApiError.internal("Escopo de tenant ausente na consulta de nomes de lojas do Checklist.");
  const nomes = new Map();
  for (const merchantId of merchantIds ?? []) {
    const { data, error } = await db.from("ifood_pedidos").select("nome:details_payload->merchant->>name")
      .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).eq("merchant_id", merchantId)
      .not("details_payload", "is", null).limit(1);
    if (error) throw ApiError.internal(error.message);
    const nome = data?.[0]?.nome;
    if (typeof nome === "string" && nome.trim()) nomes.set(merchantId, nome);
  }
  return nomes;
}

// ---------------------------------------------------------------------------
// Metas da unidade (migration 120). Leitura direta; escrita SÓ pela função do banco (versão + histórico juntos).
// ---------------------------------------------------------------------------

const COLUNAS_METAS = [
  "unidade_id", "versao", "preparo_meta_min", "preparo_aviso_pct", "entrega_meta_min", "entrega_aviso_pct",
  "vida_meta_min", "vida_aviso_pct", "atualizado_em", "atualizado_por_nome",
].join(", ");

/** Erro de "migration ainda não aplicada" (tabela ou função ausente no schema). */
export const objetoAusente = (error) =>
  ["42P01", "42883", "PGRST202", "PGRST205"].includes(error?.code)
  || /relation .* does not exist|could not find the (table|function)|schema cache/i.test(error?.message ?? "");

function erroDeMetas(error) {
  if (objetoAusente(error)) {
    const e = new ApiError(503, "As metas da unidade ainda não podem ser salvas neste ambiente (migration 120 pendente).");
    e.codigo = "METAS_INDISPONIVEIS";
    return e;
  }
  return ApiError.internal(error.message);
}

/** Linha de metas da unidade, ou null (a unidade ainda não salvou). Lança 503 METAS_INDISPONIVEIS sem a migration. */
export async function obterMetas({ organizacaoId, unidadeId, db = supabase }) {
  if (!organizacaoId || !unidadeId) throw ApiError.internal("Escopo de tenant ausente na consulta de metas do Checklist.");
  const { data, error } = await db.from("checklist_metas").select(COLUNAS_METAS)
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).maybeSingle();
  if (error) throw erroDeMetas(error);
  return data ?? null;
}

/**
 * Grava uma nova versão (ou acusa conflito). Devolve a linha da função:
 * `{ resultado: 'salvo'|'sem_alteracao'|'conflito', versao_atual, metas_atual, atualizado_em_atual, atualizado_por_atual }`.
 */
export async function salvarMetas({ organizacaoId, unidadeId, versaoEsperada, metas, origem, autor, db = supabase }) {
  if (!organizacaoId || !unidadeId) throw ApiError.internal("Escopo de tenant ausente ao salvar metas do Checklist.");
  const { data, error } = await db.rpc("checklist_metas_salvar", {
    p_organizacao_id: organizacaoId,
    p_unidade_id: unidadeId,
    p_versao_esperada: versaoEsperada,
    p_preparo_meta: metas.preparo.meta, p_preparo_aviso: metas.preparo.avisoPct,
    p_entrega_meta: metas.entrega.meta, p_entrega_aviso: metas.entrega.avisoPct,
    p_vida_meta: metas.vida.meta, p_vida_aviso: metas.vida.avisoPct,
    p_origem: origem,
    p_perfil_id: autor?.perfilId ?? null,
    p_usuario_id: autor?.usuarioId ?? null,
    p_nome: autor?.nome ?? null,
    p_impersonado_por: autor?.impersonadoPor ?? null,
  });
  if (error) throw erroDeMetas(error);
  return Array.isArray(data) ? data[0] ?? null : data ?? null;
}

/** Histórico de alterações (mais recente primeiro). Sem ids de usuário na resposta: só o nome gravado na hora. */
export async function listarHistoricoMetas({ organizacaoId, unidadeId, limite = 50, db = supabase }) {
  if (!organizacaoId || !unidadeId) throw ApiError.internal("Escopo de tenant ausente no histórico de metas do Checklist.");
  const { data, error } = await db.from("checklist_metas_historico")
    .select("versao, anterior, novo, origem, alterado_em, alterado_por_nome, impersonado_por")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .order("versao", { ascending: false }).limit(limite);
  if (error) throw erroDeMetas(error);
  return data ?? [];
}

/** Todas as versões até `ateIso` (ordem crescente) — a linha do tempo usada para avaliar pedidos passados. */
export async function listarVersoesMetas({ organizacaoId, unidadeId, ateIso, db = supabase }) {
  if (!organizacaoId || !unidadeId) throw ApiError.internal("Escopo de tenant ausente no histórico de metas do Checklist.");
  const { data, error } = await db.from("checklist_metas_historico").select("versao, novo, alterado_em")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .lte("alterado_em", ateIso).order("versao", { ascending: true }).limit(5000);
  if (error) throw erroDeMetas(error);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Pedidos de um PERÍODO (Dashboard Operacional). Mesma lista positiva de colunas do resumo ao vivo.
// ---------------------------------------------------------------------------

/** Página da consulta (o PostgREST limita cada resposta) e teto do período inteiro. */
export const PAGINA_PERIODO = 1000;
export const LIMITE_LINHAS_PERIODO = 60_000;

/**
 * Pedidos do tenant com `criado_em` em [desdeIso, ateIso). A janela já vem com folga: o DIA de cada pedido é decidido
 * no cálculo pelo carimbo oficial de recebimento, nunca por `criado_em`. Paginado por `criado_em` + `order_id`
 * (ordem total e estável: nenhum pedido aparece duas vezes nem some entre páginas).
 * Acima de LIMITE_LINHAS_PERIODO lança 422 (indicador calculado sobre parte do período seria enganoso).
 */
export async function listarPedidosDoPeriodo({ organizacaoId, unidadeId, desdeIso, ateIso, db = supabase }) {
  if (!organizacaoId || !unidadeId) throw ApiError.internal("Escopo de tenant ausente na consulta do Dashboard Operacional.");
  const linhas = [];
  for (let inicio = 0; ; inicio += PAGINA_PERIODO) {
    const { data, error } = await db.from("ifood_pedidos").select(COLUNAS_PEDIDO_CHECKLIST)
      .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
      .gte("criado_em", desdeIso).lt("criado_em", ateIso)
      .order("criado_em", { ascending: true }).order("order_id", { ascending: true })
      .range(inicio, inicio + PAGINA_PERIODO - 1);
    if (error) throw ApiError.internal(error.message);
    linhas.push(...(data ?? []));
    if (linhas.length > LIMITE_LINHAS_PERIODO) {
      const e = new ApiError(422, "Pedidos demais neste período para calcular com segurança. Escolha um intervalo menor.");
      e.codigo = "PERIODO_GRANDE_DEMAIS";
      throw e;
    }
    if (!data || data.length < PAGINA_PERIODO) break;
  }
  return linhas;
}

/** Primeiro pedido registrado da unidade (cobertura: antes disso não há dado — nada é inferido). */
export async function obterPrimeiroPedidoEm({ organizacaoId, unidadeId, db = supabase }) {
  if (!organizacaoId || !unidadeId) throw ApiError.internal("Escopo de tenant ausente na consulta do Dashboard Operacional.");
  const { data, error } = await db.from("ifood_pedidos").select("criado_em")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .order("criado_em", { ascending: true }).limit(1);
  if (error) throw ApiError.internal(error.message);
  return data?.[0]?.criado_em ?? null;
}

/** Nome da unidade (só para o cabeçalho dos relatórios), sempre conferindo a organização. */
export async function obterNomeUnidade({ organizacaoId, unidadeId, db = supabase }) {
  if (!organizacaoId || !unidadeId) throw ApiError.internal("Escopo de tenant ausente na consulta da unidade.");
  const { data, error } = await db.from("unidades").select("nome").eq("id", unidadeId).eq("organizacao_id", organizacaoId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  return data?.nome ?? null;
}
