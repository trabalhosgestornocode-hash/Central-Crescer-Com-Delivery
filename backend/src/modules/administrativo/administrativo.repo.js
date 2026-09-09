// PAINEL ADMINISTRATIVO — camada de I/O cross-tenant (Fase F).
//
// SÓ leitura, SÓ batch. NENHUMA regra de negócio aqui — a projeção de status,
// a criticidade e a conformidade vivem em administrativo.status.js /
// administrativo.monitores.js. Este arquivo:
//   * descobre o universo MONITORADO (unidades elegíveis de um monitor);
//   * carrega os lançamentos de TODAS essas unidades num punhado de queries
//     em lote (nunca `for unidade: SELECT`).
//
// Usa `supabase` (service_role) igual a plataforma.* — o Painel Administrativo
// é cross-tenant por AUTORIZAÇÃO explícita (`requirePainelAdministrativo`), não
// por bypass dos middlewares multi-tenant.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

const TABELA_LANC = "lancamentos_financeiros_diarios";

// Colunas que o painel lê de cada lançamento. As 5 primeiras são a projeção de
// STATUS (motor de pendência); as demais são o FINANCEIRO — `valor_vendas_ifood`
// é o faturamento (snapshot acumulado), `origem_lancamento` separa o diário da
// distribuição mensal, `ajustes_contra_loja` fecha o total de deduções e
// `ajustes_favor_loja` (crédito) entra só na receita líquida.
//
// Vêm na MESMA query em lote que já existia: o ranking financeiro não custa
// nenhuma consulta a mais, só colunas a mais.
const COLUNAS_LANC = [
  "unidade_id", "data_lancamento", "status", "situacao", "valor_vendas_ifood",
  "origem_lancamento", "taxas_comissoes", "servicos_promocoes",
  "taxas_entregadores", "ajustes_favor_loja", "ajustes_contra_loja",
].join(", ");

// O Painel Administrativo mede OPERAÇÃO REAL: só organização `status='ativa'`
// entra no monitoramento padrão. `teste` (trial), `bloqueada`, `suspensa`,
// `cancelada` e `eh_modelo` ficam de fora.
const STATUS_ORG_MONITORADO = new Set(["ativa"]);
// Chamada TÉCNICA/diagnóstica (`incluirTeste`) também aceita orgs em trial —
// nunca exposto no fluxo HTTP normal da Fase F.
const STATUS_ORG_COM_TESTE = new Set(["ativa", "teste"]);
const statusOrgPermitidos = (incluirTeste) => (incluirTeste ? STATUS_ORG_COM_TESTE : STATUS_ORG_MONITORADO);

// PostgREST tem limite prático de URL — fatiar o `.in(...)` grande.
const LOTE_IN = 200;
const emLotes = (arr, n = LOTE_IN) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/**
 * Universo MONITORADO de um monitor: unidades que
 *   * estão ATIVAS (`unidades.ativo = true`),
 *   * cuja organização está ATIVA (`status='ativa'`, salvo `incluirTeste`) e não é modelo,
 *   * têm o módulo do monitor EFETIVO (`organizacao_modulos` ∩ `unidade_modulos`
 *     — a mesma regra de `modulosEfetivosDaUnidade`, nunca só `unidade_modulos`).
 *
 * `incluirTeste = false` (padrão) tira as unidades `eh_teste` — fixtures de
 * QA/E2E não entram na conformidade real.
 *
 * @param {{ moduloId: string, incluirTeste?: boolean }} p
 * @param {{ supabase?: any }} [deps]
 * @returns {Promise<Array<{
 *   unidadeId: string, unidadeNome: string, unidadeCriadaEm: string|null, ehTeste: boolean,
 *   organizacaoId: string, empresaNome: string|null, organizacaoStatus: string|null,
 *   modeloLogistico: string|null
 * }>>}
 */
export async function listarUnidadesElegiveis({ moduloId, incluirTeste = false }, deps = {}) {
  const db = deps.supabase ?? supabase;

  const [orgModRes, uniModRes, orgsRes] = await Promise.all([
    db.from("organizacao_modulos").select("organizacao_id").eq("modulo_id", moduloId),
    db.from("unidade_modulos").select("unidade_id").eq("modulo_id", moduloId),
    db.from("organizacoes").select("id, nome, status, eh_modelo"),
  ]);
  for (const r of [orgModRes, uniModRes, orgsRes]) {
    if (r.error) throw ApiError.internal(r.error.message);
  }

  const orgsComModulo = new Set((orgModRes.data ?? []).map((r) => r.organizacao_id));
  const unidadesComModulo = new Set((uniModRes.data ?? []).map((r) => r.unidade_id));

  const statusOk = statusOrgPermitidos(incluirTeste);
  const orgById = new Map();
  for (const o of orgsRes.data ?? []) {
    if (o.eh_modelo) continue;                                   // catálogo-modelo nunca opera
    if (!statusOk.has(o.status)) continue;                       // teste/bloqueada/suspensa/cancelada fora
    if (!orgsComModulo.has(o.id)) continue;                      // empresa sem o módulo
    orgById.set(o.id, o);
  }
  if (!orgById.size) return [];

  const orgIds = [...orgById.keys()];
  const unidades = [];
  for (const lote of emLotes(orgIds)) {
    const { data, error } = await db.from("unidades")
      .select("id, nome, organizacao_id, ativo, created_at, eh_teste, modelo_logistico_ifood")
      .in("organizacao_id", lote)
      .eq("ativo", true);
    if (error) throw ApiError.internal(error.message);
    unidades.push(...(data ?? []));
  }

  return unidades
    .filter((u) => unidadesComModulo.has(u.id) && orgById.has(u.organizacao_id))
    .filter((u) => incluirTeste || !u.eh_teste)
    .map((u) => {
      const org = orgById.get(u.organizacao_id);
      return {
        unidadeId: u.id,
        unidadeNome: u.nome ?? null,
        unidadeCriadaEm: u.created_at ?? null,
        ehTeste: u.eh_teste ?? false,
        organizacaoId: u.organizacao_id,
        empresaNome: org?.nome ?? null,
        organizacaoStatus: org?.status ?? null,
        modeloLogistico: u.modelo_logistico_ifood ?? null,
      };
    });
}

/**
 * Uma organização pelo id — para o detalhe da empresa. `null` se não existe,
 * não está ATIVA (`status='ativa'`; trial/bloqueada/suspensa/cancelada fora) ou
 * é modelo — o Painel Administrativo não expõe empresa fora do monitoramento
 * como válida, mesmo sendo cross-tenant.
 * @param {string} organizacaoId
 * @param {{ supabase?: any }} [deps]
 */
export async function obterOrganizacaoOperacional(organizacaoId, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("organizacoes")
    .select("id, nome, status, eh_modelo, created_at").eq("id", organizacaoId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!data || data.eh_modelo || !STATUS_ORG_MONITORADO.has(data.status)) return null;
  return { organizacaoId: data.id, nome: data.nome ?? null, status: data.status, criadaEm: data.created_at ?? null };
}

/**
 * Lançamentos de VÁRIAS unidades num intervalo — UMA query por lote de
 * unidades (nunca por unidade). Devolve só as colunas que `statusMes`/a
 * projeção usam.
 * @param {{ unidadeIds: string[], desdeIso: string, ateIso: string }} p
 * @param {{ supabase?: any }} [deps]
 * @returns {Promise<Map<string, Array<{data_lancamento: string, status: string, situacao: string, valor_vendas_ifood: number|null}>>>}
 */
export async function carregarLancamentosDaFrota({ unidadeIds, desdeIso, ateIso }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const porUnidade = new Map(unidadeIds.map((id) => [id, []]));
  if (!unidadeIds.length) return porUnidade;

  for (const lote of emLotes(unidadeIds)) {
    const { data, error } = await db.from(TABELA_LANC)
      .select(COLUNAS_LANC)
      .in("unidade_id", lote)
      .gte("data_lancamento", desdeIso)
      .lte("data_lancamento", ateIso);
    if (error) throw ApiError.internal(error.message);
    for (const row of data ?? []) {
      const lista = porUnidade.get(row.unidade_id);
      if (lista) lista.push(row);
    }
  }
  return porUnidade;
}

/**
 * Linhas de `metas_indicadores` para uma frota — UMA query. `metas_indicadores`
 * é uma tabela de CONFIGURAÇÃO (poucas linhas: por org/unidade × modelo × 4
 * indicadores), então traz tudo e filtra em memória — a cascata
 * unidade > organização > global é resolvida por
 * `dashboardExecutivo.metas.service.js#escolherMetas`, a fonte única da regra.
 * @param {{ organizacaoIds: string[] }} p
 * @param {{ supabase?: any }} [deps]
 * @returns {Promise<Array<{organizacao_id: string|null, unidade_id: string|null, modelo_logistico: string, indicador: string, meta_ideal: number, limite: number}>>}
 */
export async function carregarMetasIndicadores({ organizacaoIds }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const permitidas = new Set(organizacaoIds ?? []);
  const { data, error } = await db.from("metas_indicadores")
    .select("organizacao_id, unidade_id, modelo_logistico, indicador, meta_ideal, limite");
  if (error) throw ApiError.internal(error.message);
  // Só as linhas globais (org null) e as das organizações da frota importam.
  return (data ?? []).filter((r) => r.organizacao_id == null || permitidas.has(r.organizacao_id));
}

/**
 * Lançamentos de UMA unidade num intervalo (detalhe / calendário). Uma query.
 * @param {{ unidadeId: string, desdeIso: string, ateIso: string }} p
 * @param {{ supabase?: any }} [deps]
 */
export async function carregarLancamentosDaUnidade({ unidadeId, desdeIso, ateIso }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from(TABELA_LANC)
    .select(COLUNAS_LANC)
    .eq("unidade_id", unidadeId)
    .gte("data_lancamento", desdeIso)
    .lte("data_lancamento", ateIso);
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

/** Uma unidade elegível pelo id — para o detalhe/calendário. `null` se fora do universo. */
export async function obterUnidadeElegivel({ unidadeId, moduloId, incluirTeste = false }, deps = {}) {
  const todas = await listarUnidadesElegiveis({ moduloId, incluirTeste }, deps);
  return todas.find((u) => u.unidadeId === unidadeId) ?? null;
}
