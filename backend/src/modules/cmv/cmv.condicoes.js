// Condições comerciais da EMPRESA usadas pelo Simulador de Preço (comissão por canal etc.).
//
// Fonte única: `canais_venda` DA ORGANIZAÇÃO do contexto (nunca de outra, nunca um padrão embutido).
// Se a empresa não configurou um canal, ele simplesmente NÃO aparece — o simulador então marca o
// cálculo como PARCIAL em vez de assumir percentual. É de propósito: percentuais de uma empresa
// (ex.: franquias Subway) não podem vazar silenciosamente para outra.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

/** Puro: molda as linhas de canais_venda para a resposta da API. */
export function moldarCondicoes(linhas) {
  const canais = (linhas ?? [])
    .filter((l) => l.ativo !== false)
    .map((l) => ({ canal: l.canal, comissao: Number(l.comissao_pct) }))
    .filter((c) => Number.isFinite(c.comissao) && c.comissao >= 0 && c.comissao < 1)
    .sort((a, b) => a.canal.localeCompare(b.canal));
  return { configurado: canais.length > 0, canais };
}

export async function condicoesComerciais({ organizacaoId }) {
  const { data, error } = await supabase
    .from("canais_venda").select("canal, comissao_pct, ativo").eq("organizacao_id", organizacaoId);
  if (error) throw ApiError.internal(error.message);
  return moldarCondicoes(data);
}
