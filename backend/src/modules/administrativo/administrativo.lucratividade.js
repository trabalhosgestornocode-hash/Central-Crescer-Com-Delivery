// PAINEL ADMINISTRATIVO — motor de LUCRATIVIDADE SEMANAL (puro, sem I/O).
//
// Recorte por BLOCO SEMANAL FIXO DO MÊS, para as abas Lucratividade e
// Rentabilidade da área Relatórios:
//   Semana 1: 01–07 · Semana 2: 08–14 · Semana 3: 15–21 · Semana 4: 22–último dia
// NUNCA cruza meses; nunca há "Semana 5" (dias 22+ pertencem sempre à Semana 4).
// A Semana 4 tem 7, 8, 9 ou 10 dias (fevereiro, meses de 30/31) — os valores são
// SEMPRE os reais do período, sem normalizar nem tirar média diária.
//
// NÃO reimplementa nenhuma fórmula de negócio: faturamento, deduções e receita
// líquida saem das MESMAS funções do Dashboard iFood
// (`dashboardExecutivo.calc.js`). O que é próprio daqui é só o RECORTE DE
// PERÍODO: como `valor_vendas_ifood` (e os componentes de dedução) são um
// snapshot MENSAL acumulado, o valor de uma semana é a diferença entre o
// acumulado no fim do bloco e o acumulado na véspera do primeiro dia (0 na
// Semana 1, porque o acumulado reinicia no dia 1). Como o bloco não cruza meses,
// é sempre um único cálculo.
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
// BLOCO SEMANAL FIXO DO MÊS — comparação de CALENDÁRIO, sem fuso
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

/** Último dia do mês (`mes` 1-based). */
const ultimoDiaDoMes = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).getUTCDate();

/** Primeiro dia de cada bloco. Semana 4 nunca começa depois do dia 22. */
const DIA_INICIO_BLOCO = { 1: 1, 2: 8, 3: 15, 4: 22 };

/** Índice do bloco (1..4) a partir do dia do mês. Dias 22+ -> sempre 4. */
export const indiceBloco = (dia) => (dia <= 7 ? 1 : dia <= 14 ? 2 : dia <= 21 ? 3 : 4);

/**
 * Bloco semanal fixo do mês (Semana 1: 01–07 · 2: 08–14 · 3: 15–21 · 4: 22–fim)
 * que contém `dataIso`.
 * @param {string} dataIso AAAA-MM-DD
 * @returns {{ ano: number, mes: number, indice: 1|2|3|4, inicio: string, fim: string }}
 */
export function semanaDe(dataIso) {
  const [ano, mes, dia] = String(dataIso).split("-").map(Number);
  const indice = indiceBloco(dia);
  const d0 = DIA_INICIO_BLOCO[indice];
  const df = indice < 4 ? d0 + 6 : ultimoDiaDoMes(ano, mes);
  return { ano, mes, indice, inicio: `${ano}-${pad(mes)}-${pad(d0)}`, fim: `${ano}-${pad(mes)}-${pad(df)}` };
}

/** Ordinal linear do bloco (…, ago/S4, set/S1, set/S2, …) para navegar sem fuso. */
const ordinalBloco = ({ ano, mes, indice }) => ((ano * 12) + (mes - 1)) * 4 + (indice - 1);

/**
 * Desloca `n` blocos (±) na régua fixa. Semana 4 -> Semana 1 do mês seguinte;
 * Semana 1 -> Semana 4 do mês anterior (inclusive virada de ano). Devolve o
 * `inicio` (AAAA-MM-DD) do bloco alvo.
 * @param {string} inicioIso qualquer data dentro do bloco de origem
 * @param {number} n deslocamento em blocos
 */
export function deslocarSemana(inicioIso, n) {
  const ord = ordinalBloco(semanaDe(inicioIso)) + Math.trunc(n);
  const indice = ((ord % 4) + 4) % 4 + 1;
  const meses = Math.floor(ord / 4);
  const ano = Math.floor(meses / 12);
  const mes = (((meses % 12) + 12) % 12) + 1;
  return semanaDe(`${ano}-${pad(mes)}-${pad(DIA_INICIO_BLOCO[indice])}`).inicio;
}

// ---------------------------------------------------------------------------
// VALOR DE UMA SEMANA (BLOCO) POR UNIDADE
// ---------------------------------------------------------------------------

/**
 * Diferença entre o acumulado no fim do bloco e o acumulado na véspera do
 * início (0 quando o bloco começa no dia 1 — o acumulado reinicia no mês).
 * `null` quando não há snapshot diário no fim do bloco — nunca 0.
 * @param {Array<object>} linhasDoMes linhas DIÁRIAS da unidade, só do mês do bloco
 */
function valorDoBloco(linhasDoMes, de, ate) {
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
 * Lucratividade de UMA unidade num BLOCO semanal [inicio..fim] (mesmo mês),
 * cortada em `ateDataIso` (D-1: a semana em curso mostra só o que já venceu).
 *
 * @param {Array<object>} linhas linhas CRUAS da unidade (>= o mês do bloco anterior carregado)
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

  // O bloco nunca cruza meses -> um único cálculo, só as linhas do mês do bloco.
  const ym = inicio.slice(0, 7);
  const calc = (rows) => valorDoBloco(
    rows.filter((r) => String(r.data_lancamento).slice(0, 7) === ym), inicio, fimEfetivo);

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
