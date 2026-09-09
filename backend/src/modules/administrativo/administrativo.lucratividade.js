// PAINEL ADMINISTRATIVO — motor de LUCRATIVIDADE SEMANAL (puro, sem I/O).
//
// Recorte SEMANAL (segunda a domingo) do financeiro do iFood, para as abas
// Lucratividade e Rentabilidade da área Relatórios.
//
// NÃO reimplementa nenhuma fórmula de negócio: faturamento, deduções e receita
// líquida saem das MESMAS funções do Dashboard iFood
// (`dashboardExecutivo.calc.js`). O que é próprio daqui é só o RECORTE DE
// PERÍODO: como `valor_vendas_ifood` (e os componentes de dedução) são um
// snapshot MENSAL acumulado, o valor de uma semana é a diferença entre o
// acumulado no fim da semana e o acumulado na véspera do primeiro dia — por
// segmento de mês, porque uma semana seg–dom pode cruzar UMA virada de mês.
//
// Só linhas de origem DIÁRIA entram: `distribuicao_mensal` é uma fatia mensal
// estimada, sem granularidade de dia — uma unidade que só tem isso fica com a
// semana `null` ("sem dado diário"), nunca estimada nem contada como zero.

import {
  snapshotFinanceiroMaisRecente, totalDeducoes, receitaLiquida, diaAnterior,
} from "../dashboard-executivo/dashboardExecutivo.calc.js";

/** `null` (não sei) soma como 0, mas nunca vira 0 numa comparação. */
const n = (v) => (v == null ? 0 : Number(v));
const pad = (x) => String(x).padStart(2, "0");

/** Percentual `parte/base × 100`, `null` quando não dá pra calcular. */
export function percentual(parte, base) {
  if (parte == null || base == null || Number(base) <= 0) return null;
  return (Number(parte) / Number(base)) * 100;
}

// ---------------------------------------------------------------------------
// SEMANA (segunda a domingo) — comparação de CALENDÁRIO, sem fuso
// ---------------------------------------------------------------------------

const toUTC = (iso) => {
  const [a, m, d] = String(iso).split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d));
};
const fromUTC = (dt) => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;

/** Soma `dias` (pode ser negativo) a uma data ISO. */
export function somarDias(iso, dias) {
  const dt = toUTC(iso);
  dt.setUTCDate(dt.getUTCDate() + dias);
  return fromUTC(dt);
}

/** Primeiro dia (AAAA-MM-01) do mês de `iso`. */
export const primeiroDiaDoMes = (iso) => `${String(iso).slice(0, 7)}-01`;

/**
 * Semana (segunda a domingo) que contém `dataIso`.
 * @param {string} dataIso AAAA-MM-DD
 * @returns {{ inicio: string, fim: string }}
 */
export function semanaDe(dataIso) {
  const dt = toUTC(dataIso);
  const offset = (dt.getUTCDay() + 6) % 7;       // 0 = segunda
  const inicio = somarDias(fromUTC(dt), -offset);
  return { inicio, fim: somarDias(inicio, 6) };
}

/** Desloca uma semana `n` semanas (recebe e devolve a segunda-feira). */
export const deslocarSemana = (inicioIso, n) => somarDias(inicioIso, n * 7);

/**
 * Parte [inicio..fim] em segmentos que não cruzam virada de mês. Uma semana
 * seg–dom cruza no máximo um mês → 1 ou 2 segmentos.
 * @returns {Array<{ ym: string, de: string, ate: string }>}
 */
export function segmentosPorMes(inicio, fim) {
  const segs = [];
  let de = inicio;
  while (de <= fim) {
    const [a, m] = de.split("-").map(Number);
    const ultimoDoMes = fromUTC(new Date(Date.UTC(a, m, 0)));
    const ate = ultimoDoMes < fim ? ultimoDoMes : fim;
    segs.push({ ym: `${a}-${pad(m)}`, de, ate });
    de = somarDias(ate, 1);
  }
  return segs;
}

// ---------------------------------------------------------------------------
// VALOR DE UMA SEMANA POR UNIDADE
// ---------------------------------------------------------------------------

/**
 * Diferença entre o acumulado no fim do segmento e o acumulado na véspera do
 * início (0 quando o segmento começa no dia 1 — o acumulado reinicia no mês).
 * `null` quando não há snapshot diário no fim do segmento — nunca 0.
 * @param {Array<object>} linhasDoMes linhas DIÁRIAS da unidade, só do mês do segmento
 */
function valorDoSegmento(linhasDoMes, de, ate) {
  const fim = snapshotFinanceiroMaisRecente(linhasDoMes, ate);
  if (!fim || fim.valor_vendas_ifood == null) return null;
  const base = de.slice(8, 10) === "01"
    ? null
    : snapshotFinanceiroMaisRecente(linhasDoMes, diaAnterior(de));
  const delta = (campo) => {
    const vf = fim[campo];
    return vf == null ? null : Number(vf) - n(base?.[campo]);
  };
  const faturamento = Number(fim.valor_vendas_ifood) - n(base?.valor_vendas_ifood);
  const deducoes = totalDeducoes({
    taxasComissoes: delta("taxas_comissoes"),
    servicosPromocoes: delta("servicos_promocoes"),
    taxasEntregadores: delta("taxas_entregadores"),
    ajustesContraLoja: delta("ajustes_contra_loja"),
  });
  const ajustesFavor = delta("ajustes_favor_loja");
  return { faturamento, deducoes, receitaLiquida: receitaLiquida(faturamento, deducoes, ajustesFavor) };
}

const SEM_DADO = Object.freeze({
  faturamento: null, confirmado: null, provisorio: null, incluiProvisorio: false,
  deducoes: null, deducoesPct: null, receitaLiquida: null, rentabilidadePct: null, semDado: true,
});

/**
 * Lucratividade de UMA unidade numa semana [inicio..fim], cortada em `ateDataIso`
 * (D-1: a semana em curso mostra só o que já venceu).
 *
 * @param {Array<object>} linhas linhas CRUAS da unidade (>= o mês da semana anterior carregado)
 * @param {{ inicio: string, fim: string, ateDataIso?: string|null }} janela
 * @returns {{ faturamento: number|null, confirmado: number|null, provisorio: number|null,
 *   incluiProvisorio: boolean, deducoes: number|null, deducoesPct: number|null,
 *   receitaLiquida: number|null, rentabilidadePct: number|null, semDado: boolean }}
 */
export function lucratividadeDaUnidade(linhas, { inicio, fim, ateDataIso = null }) {
  const fimEfetivo = ateDataIso && ateDataIso < fim ? ateDataIso : fim;
  if (fimEfetivo < inicio) return { ...SEM_DADO };

  const diarias = (linhas ?? []).filter((r) => r.origem_lancamento !== "distribuicao_mensal");
  if (!diarias.length) return { ...SEM_DADO };

  const calc = (rows) => {
    const segs = segmentosPorMes(inicio, fimEfetivo).map(({ ym, de, ate }) =>
      valorDoSegmento(rows.filter((r) => String(r.data_lancamento).slice(0, 7) === ym), de, ate));
    if (segs.every((s) => s == null)) return null;
    const soma = (campo) => segs.reduce((acc, s) => acc + n(s?.[campo]), 0);
    return {
      faturamento: soma("faturamento"),
      deducoes: segs.some((s) => s?.deducoes != null) ? soma("deducoes") : null,
      receitaLiquida: segs.some((s) => s?.receitaLiquida != null) ? soma("receitaLiquida") : null,
    };
  };

  const total = calc(diarias);
  if (!total) return { ...SEM_DADO };

  const confirmadoCalc = calc(diarias.filter((r) => r.status === "finalizado"));
  const confirmado = confirmadoCalc?.faturamento ?? 0;
  const provisorio = total.faturamento - confirmado;

  return {
    faturamento: total.faturamento,
    confirmado,
    provisorio,
    incluiProvisorio: Math.abs(provisorio) > 0.005,
    deducoes: total.deducoes,
    deducoesPct: percentual(total.deducoes, total.faturamento),
    receitaLiquida: total.receitaLiquida,
    rentabilidadePct: percentual(total.receitaLiquida, total.faturamento),
    semDado: false,
  };
}

// ---------------------------------------------------------------------------
// TOTAL DE REDE (soma aditiva de operações independentes)
// ---------------------------------------------------------------------------

/**
 * Consolida TODAS as unidades da frota num único total de REDE. Faturamento e
 * receita líquida somam; `rentabilidadePct`/`deducoesPct` são RECALCULADOS
 * sobre os totais (média ponderada implícita, nunca média de percentuais).
 *
 * É o ÚNICO ponto que consolida unidades: os rankings e destaques competitivos
 * são por UNIDADE — a empresa nunca soma suas unidades para disputar posição.
 * @param {Array<ReturnType<typeof lucratividadeDaUnidade>>} unidades
 */
export function agregarRede(unidades) {
  const comDado = (unidades ?? []).filter((u) => !u.semDado && u.faturamento != null);
  if (!comDado.length) {
    return {
      faturamento: null, deducoes: null, deducoesPct: null,
      receitaLiquida: null, rentabilidadeReais: null, rentabilidadePct: null, unidadesComDado: 0,
    };
  }
  const soma = (campo) => comDado.reduce((s, u) => s + n(u[campo]), 0);
  const faturamento = soma("faturamento");
  const deducoes = comDado.some((u) => u.deducoes != null) ? soma("deducoes") : null;
  const receitaLiquida = comDado.some((u) => u.receitaLiquida != null) ? soma("receitaLiquida") : null;
  return {
    faturamento,
    deducoes,
    deducoesPct: percentual(deducoes, faturamento),
    receitaLiquida,
    rentabilidadeReais: receitaLiquida,
    rentabilidadePct: percentual(receitaLiquida, faturamento),
    unidadesComDado: comDado.length,
  };
}

/**
 * Folga da loja frente ao LIMITE do seu próprio modelo (Marketplace x Full
 * Service) — a medida de eficiência que permite comparar modelos diferentes.
 * `limite − % real`: positivo = dentro do limite (melhor). `null` sem meta.
 * @param {number|null} deducoesPct @param {{ limite: number|null }|null|undefined} meta
 */
export function folgaLimite(deducoesPct, meta) {
  if (deducoesPct == null || meta?.limite == null) return null;
  return Number(meta.limite) - Number(deducoesPct);
}
