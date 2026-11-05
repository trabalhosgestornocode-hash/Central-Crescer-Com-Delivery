// PAINEL ADMINISTRATIVO — motor de ATENÇÃO FINANCEIRA DA REDE (puro, sem I/O).
//
// Serve a "Visão Geral da Rede": a central que classifica cada unidade em
// EM_DIA / ATENCAO / CRITICA / SEM_DADOS a partir do MESMO par (metaIdeal,
// limite) por modelo logístico que `dashboardExecutivo.calc.js#statusIndicadorRentabilidade`
// já usa nos 4 cards de rentabilidade do Dashboard iFood e que
// `administrativo.service.js#lucratividadeSemanal` já usa no ranking semanal.
// NÃO inventa limite novo: a banda de "crítico" é derivada do PRÓPRIO gap
// homologado (limite − metaIdeal) — ver `bandaCritica`.
//
// NÃO reimplementa faturamento/deduções/receita líquida: isso continua vindo
// de `administrativo.lucratividade.js#lucratividadeDaUnidade` (que por sua vez
// delega a `dashboardExecutivo.calc.js`). Este arquivo só soma o que falta:
// classificação de 4 estados, impacto financeiro estimado, composição das
// deduções (para o gráfico) e a ordem de prioridade de intervenção.

import {
  snapshotFinanceiroMaisRecente, diaAnterior, totalDeducoes,
} from "../dashboard-executivo/dashboardExecutivo.calc.js";

const n = (v) => (v == null ? 0 : Number(v));
const R2 = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);

// ---------------------------------------------------------------------------
// CLASSIFICAÇÃO DE 4 ESTADOS
// ---------------------------------------------------------------------------

/**
 * Tamanho da banda de ATENÇÃO, acima do limite homologado: o mesmo tamanho do
 * gap (limite − metaIdeal) que já define a banda SAUDÁVEL abaixo do limite.
 * Sem metaIdeal cadastrada, usa o próprio limite como banda (crítico só acima
 * do DOBRO do limite) — nunca um número fixo novo, sempre derivado do que já
 * está homologado em `metas_indicadores`.
 * @param {{metaIdeal: number|null, limite: number}} meta
 */
export function bandaCritica(meta) {
  if (meta?.limite == null) return null;
  return meta.metaIdeal != null ? Math.max(0, meta.limite - meta.metaIdeal) : meta.limite;
}

export const SITUACAO_FINANCEIRA = {
  sem_dados: { chave: "sem_dados", rotulo: "Sem dados" },
  em_dia: { chave: "em_dia", rotulo: "Em dia" },
  atencao: { chave: "atencao", rotulo: "Atenção" },
  critica: { chave: "critica", rotulo: "Crítica" },
};

/**
 * Classifica a unidade em 4 estados a partir do % de deduções e da meta do
 * modelo. `atual <= limite` é sempre EM_DIA (mesma régua do Dashboard iFood:
 * "dentro da meta" e "dentro do limite" não alertam). Acima do limite,
 * ATENÇÃO até `limite + bandaCritica`; CRÍTICA depois disso.
 * @param {number|null} deducoesPct @param {{metaIdeal: number|null, limite: number|null}|null} meta
 */
export function classificarAtencaoFinanceira(deducoesPct, meta) {
  if (deducoesPct == null || meta?.limite == null) return SITUACAO_FINANCEIRA.sem_dados;
  if (deducoesPct <= meta.limite) return SITUACAO_FINANCEIRA.em_dia;
  const banda = bandaCritica(meta);
  if (banda != null && deducoesPct > meta.limite + banda) return SITUACAO_FINANCEIRA.critica;
  return SITUACAO_FINANCEIRA.atencao;
}

/**
 * Impacto financeiro ESTIMADO: só o excedente em reais sobre o LIMITE
 * homologado (nunca sobre a meta ideal) — dentro do limite, impacto é zero.
 * É uma ESTIMATIVA sobre o percentual do período, não uma perda contábil
 * realizada linha a linha.
 * @param {number|null} faturamento @param {number|null} deducoesPct @param {{limite: number|null}|null} meta
 */
export function impactoFinanceiroEstimado(faturamento, deducoesPct, meta) {
  if (faturamento == null || deducoesPct == null || meta?.limite == null) return null;
  const excessoPp = deducoesPct - meta.limite;
  if (excessoPp <= 0) return 0;
  return R2((excessoPp / 100) * faturamento);
}

// ---------------------------------------------------------------------------
// COMPOSIÇÃO DAS DEDUÇÕES (gráfico) — mesmo recorte de bloco de `valorDoBloco`,
// só que devolvendo os componentes em vez do total. `inicio` de um mês é
// sempre dia 01 -> a base do delta é 0 (o acumulado reinicia no mês), igual ao
// caso análogo em `administrativo.lucratividade.js`.
// ---------------------------------------------------------------------------

/**
 * @param {Array<object>} linhasDoMes linhas DIÁRIAS da unidade, só do mês do recorte
 * @param {string} inicio AAAA-MM-01 @param {string} ate corte (dataAlvo ou fim do mês)
 * @returns {{taxasComissoes: number|null, servicosPromocoes: number|null, outrosAjustes: number|null, total: number|null}}
 */
export function composicaoDeducoesDoBloco(linhasDoMes, inicio, ate) {
  const fim = snapshotFinanceiroMaisRecente(linhasDoMes, ate);
  if (!fim || fim.valor_vendas_ifood == null) return { taxasComissoes: null, servicosPromocoes: null, outrosAjustes: null, total: null };
  const base = inicio.slice(8, 10) === "01" ? null : snapshotFinanceiroMaisRecente(linhasDoMes, diaAnterior(inicio));
  const delta = (campo) => {
    const vf = fim[campo];
    return vf == null ? null : Number(vf) - n(base?.[campo]);
  };
  const taxasComissoes = totalDeducoes({ taxasComissoes: delta("taxas_comissoes"), servicosPromocoes: null, taxasEntregadores: delta("taxas_entregadores"), ajustesContraLoja: null });
  const servicosPromocoes = delta("servicos_promocoes");
  const outrosAjustes = delta("ajustes_contra_loja");
  const total = totalDeducoes({
    taxasComissoes: delta("taxas_comissoes"), servicosPromocoes, taxasEntregadores: delta("taxas_entregadores"), ajustesContraLoja: outrosAjustes,
  });
  return { taxasComissoes, servicosPromocoes, outrosAjustes, total };
}

/** Soma componentes de várias unidades (operações independentes -> aditivo). `null` só se NENHUMA unidade informou aquele componente. */
export function somarComposicaoDeducoes(composicoes) {
  const lista = composicoes ?? [];
  const soma = (campo) => {
    const comDado = lista.filter((c) => c?.[campo] != null);
    return comDado.length ? R2(comDado.reduce((s, c) => s + Number(c[campo]), 0)) : null;
  };
  return {
    taxasComissoes: soma("taxasComissoes"),
    servicosPromocoes: soma("servicosPromocoes"),
    outrosAjustes: soma("outrosAjustes"),
  };
}

// ---------------------------------------------------------------------------
// FILTROS DA VISÃO GERAL DA REDE
// ---------------------------------------------------------------------------

const normaliza = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * Aplica os filtros globais (empresa, unidade, modalidade, situação, busca) à
 * lista de unidades já enriquecidas. Cada indicador/ranking/gráfico da tela
 * recebe a lista JÁ filtrada — nunca filtra depois de agregar.
 * @param {Array<object>} unidades @param {{organizacaoId?: string|null, unidadeId?: string|null, modalidade?: string|null, situacao?: string|null, busca?: string|null}} f
 */
export function filtrarUnidadesRede(unidades, f = {}) {
  let lista = unidades ?? [];
  if (f.organizacaoId) lista = lista.filter((u) => u.organizacaoId === f.organizacaoId);
  if (f.unidadeId) lista = lista.filter((u) => u.unidadeId === f.unidadeId);
  if (f.modalidade) lista = lista.filter((u) => u.modeloLogistico === f.modalidade);
  if (f.situacao) lista = lista.filter((u) => u.situacaoFinanceira?.chave === f.situacao);
  if (f.busca) {
    const termo = normaliza(f.busca);
    lista = lista.filter((u) => normaliza(u.nome).includes(termo) || normaliza(u.empresaNome).includes(termo));
  }
  return lista;
}

// ---------------------------------------------------------------------------
// PRIORIDADE DE INTERVENÇÃO
// ---------------------------------------------------------------------------

const ORDEM_SEVERIDADE = { critica: 3, atencao: 2, em_dia: 1, sem_dados: 0 };

/**
 * Ordena por prioridade de intervenção: 1º a GRAVIDADE (situação), 2º o
 * IMPACTO FINANCEIRO absoluto, 3º o desvio em pontos percentuais (critério
 * de desempate determinístico). Persistência (dias consecutivos acima do
 * limite) entra quando houver histórico disponível — ver `persistenciaDias`.
 * @param {Array<object>} unidades cada uma com `situacaoFinanceira`, `impactoFinanceiroEstimado`, `folgaLimitePp`
 */
export function ordenarPrioridadeIntervencao(unidades) {
  return [...(unidades ?? [])].sort((a, b) => {
    const sevA = ORDEM_SEVERIDADE[a.situacaoFinanceira?.chave] ?? 0;
    const sevB = ORDEM_SEVERIDADE[b.situacaoFinanceira?.chave] ?? 0;
    if (sevA !== sevB) return sevB - sevA;
    const impA = a.impactoFinanceiroEstimado ?? 0;
    const impB = b.impactoFinanceiroEstimado ?? 0;
    if (impA !== impB) return impB - impA;
    const folgaA = a.folgaLimitePp ?? 0;
    const folgaB = b.folgaLimitePp ?? 0;
    return folgaA - folgaB;
  });
}

/** Contagem de unidades por situação financeira — para o card e o gráfico de distribuição. */
export function contagemPorSituacao(unidades) {
  const base = { sem_dados: 0, em_dia: 0, atencao: 0, critica: 0 };
  for (const u of unidades ?? []) {
    const chave = u.situacaoFinanceira?.chave ?? "sem_dados";
    base[chave] = (base[chave] ?? 0) + 1;
  }
  return base;
}
