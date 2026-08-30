// Resolver ÚNICO da tabela comercial OFICIAL de uma unidade.
//
// PRINCÍPIO (ver pedido original): "modelo logístico" (Marketplace/Full
// Service, unidades.modelo_logistico_ifood — migration 024) e "tabela
// comercial" (unidades.tabela_balcao/tabela_ifood — schema base) são
// configurações INDEPENDENTES. Este arquivo só resolve a segunda — nunca
// olha modelo_logistico_ifood, e nada aqui pode passar a olhar sem que isso
// seja uma decisão explícita e documentada (ver ETAPA 1 do pedido: procurar
// e remover qualquer vínculo automático entre os dois).
//
// NUNCA "primeira tabela encontrada": ausência de configuração é um estado
// real (unidade pendente de configurar), não um convite a adivinhar — quem
// chama decide o que fazer com `tabelaOficial: null` (ex.: cmv.service.js
// bloqueia telas operacionais; ferramentas do Agente podem devolver aviso).
//
// Dashboard comum, Produtos/CMV (cmv.service.js) e as tools do Agente Crescer
// (produtosCmvRanking.tool.js, produtoCmv.tool.js) usam ESTE resolver — nunca
// reimplementam "qual coluna ler" por conta própria.
import { supabase } from "../config/supabase.js";
import { ApiError } from "./ApiError.js";

export const CANAIS_TABELA_COMERCIAL = ["balcao", "ifood"];

/** @param {string} [canal] @returns {'balcao'|'ifood'} */
export function normalizarCanalTabela(canal) {
  return canal === "ifood" ? "ifood" : "balcao";
}

/**
 * Tabela comercial OFICIAL da unidade para um canal — fonte única de verdade.
 * @param {{unidadeId: string|null|undefined, canal?: string}} p
 * @param {{supabaseClient: typeof supabase}} [deps] injeção para teste.
 * @returns {Promise<{canal: 'balcao'|'ifood', tabelaOficial: string|null}>}
 */
export async function resolverTabelaComercialUnidade({ unidadeId, canal }, deps = { supabaseClient: supabase }) {
  const canalResolvido = normalizarCanalTabela(canal);
  if (!unidadeId) return { canal: canalResolvido, tabelaOficial: null };

  const coluna = canalResolvido === "ifood" ? "tabela_ifood" : "tabela_balcao";
  const { data, error } = await deps.supabaseClient.from("unidades").select(coluna).eq("id", unidadeId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  return { canal: canalResolvido, tabelaOficial: data?.[coluna] ?? null };
}

/**
 * As duas tabelas oficiais da unidade de uma vez (balcão + iFood) — usado
 * pela tela de Configurações e por respostas do Agente como "qual é minha
 * tabela oficial?" (nunca uma pergunta por canal nesses casos).
 * @param {{unidadeId: string|null|undefined}} p
 * @param {{supabaseClient: typeof supabase}} [deps]
 * @returns {Promise<{tabelaBalcao: string|null, tabelaIfood: string|null}>}
 */
export async function resolverTabelasComerciaisUnidade({ unidadeId }, deps = { supabaseClient: supabase }) {
  if (!unidadeId) return { tabelaBalcao: null, tabelaIfood: null };
  const { data, error } = await deps.supabaseClient
    .from("unidades").select("tabela_balcao, tabela_ifood").eq("id", unidadeId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  return { tabelaBalcao: data?.tabela_balcao ?? null, tabelaIfood: data?.tabela_ifood ?? null };
}

/**
 * CATÁLOGO de tabelas comerciais que ESTA EMPRESA de fato possui — as tabelas
 * distintas com preço cadastrado em `vw_produto_margem` (via produto_precos).
 *
 * É a fonte correta para "quais opções de tabela oferecer" (dropdown de
 * comparação, seletor de nova tabela oficial, simulador): uma empresa nova
 * sem preço "AERO A" nunca vê "AERO A". NÃO é uma lista global hardcoded.
 *
 * @param {{organizacaoId: string|null|undefined}} p
 * @param {{supabaseClient?: typeof supabase}} [deps]
 * @returns {Promise<{balcao: string[], ifood: string[]}>}
 */
export async function catalogoTabelasComerciais({ organizacaoId }, deps = {}) {
  const db = deps.supabaseClient ?? supabase;
  const vazio = { balcao: [], ifood: [] };
  if (!organizacaoId) return vazio;

  const { data, error } = await db
    .from("vw_produto_margem")
    .select("canal, tabela")
    .eq("organizacao_id", organizacaoId)
    .not("tabela", "is", null);
  if (error) throw ApiError.internal(error.message);

  const set = { balcao: new Set(), ifood: new Set() };
  for (const r of data ?? []) {
    const canal = r.canal === "ifood" ? "ifood" : "balcao";
    if (r.tabela) set[canal].add(r.tabela);
  }
  return {
    balcao: [...set.balcao].sort((a, b) => a.localeCompare(b, "pt-BR")),
    ifood: [...set.ifood].sort((a, b) => a.localeCompare(b, "pt-BR")),
  };
}
