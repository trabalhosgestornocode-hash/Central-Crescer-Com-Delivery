// Leitura da estrutura multicanal do Dashboard iFood (migration 108) — fonte
// ÚNICA usada tanto pelo lançamento (tenant, dashboardExecutivo.service.js)
// quanto pela configuração do SuperAdmin (plataforma.dashboardIfood.service.js).
// Só lê; quem grava são as RPCs atômicas da migration 108.
//
// Migration ainda não aplicada (tabela inexistente) => `ausente: true`: quem
// chama trata a unidade como PADRÃO — o caminho de hoje segue intacto.
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

export const TABELA_CONFIG = "dashboard_ifood_unidade_config";
export const TABELA_CANAIS = "dashboard_ifood_canais";
export const TABELA_VALORES_CANAIS = "lancamentos_financeiros_canais";

/** Tabela/função da migration 108 inexistente neste banco. */
export const objetoAusente = (error) =>
  ["42P01", "42883", "PGRST202", "PGRST205"].includes(error?.code)
  || /relation .* does not exist|could not find the (table|function)|schema cache/i.test(error?.message ?? "");

/**
 * Configuração + canais (inclusive inativos) de uma unidade.
 * @param {{unidadeId: string, db?: object}} p — `db` injetável (testes do SuperAdmin)
 * @returns {Promise<{ausente: true} | {ausente: false, config: object|null, canais: object[]}>}
 */
export async function lerConfigECanais({ unidadeId, db = supabase }) {
  const [cfgRes, canaisRes] = await Promise.all([
    db.from(TABELA_CONFIG).select("estrutura, taxas_entregadores_escopo, updated_at").eq("unidade_id", unidadeId).maybeSingle(),
    db.from(TABELA_CANAIS).select("id, nome, ordem, ativo").eq("unidade_id", unidadeId),
  ]);
  if (objetoAusente(cfgRes.error) || objetoAusente(canaisRes.error)) return { ausente: true };
  if (cfgRes.error) throw ApiError.internal(cfgRes.error.message);
  if (canaisRes.error) throw ApiError.internal(canaisRes.error.message);
  return { ausente: false, config: cfgRes.data ?? null, canais: canaisRes.data ?? [] };
}

/**
 * Valores por canal dos lançamentos informados (ids da linha consolidada).
 * Lista vazia sem consulta quando não há id; [] se a migration não existe.
 * @param {{lancamentoIds: string[], db?: object}} p
 */
export async function lerValoresCanais({ lancamentoIds, db = supabase }) {
  const ids = [...new Set((lancamentoIds ?? []).filter(Boolean))];
  if (!ids.length) return [];
  const { data, error } = await db.from(TABELA_VALORES_CANAIS).select("*").in("lancamento_id", ids);
  if (objetoAusente(error)) return [];
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}
