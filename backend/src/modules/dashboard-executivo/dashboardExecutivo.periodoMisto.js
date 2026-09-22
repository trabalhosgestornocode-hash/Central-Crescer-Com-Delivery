// PERÍODO MISTO (Marketplace + Full Service no mesmo mês) — puro, sem I/O.
//
// O Financeiro do iFood é um SNAPSHOT ACUMULADO do mês (dia 1 → data do
// lançamento; ver calc.js#snapshotFinanceiroMaisRecente). Logo a parte de um
// mês que pertence a cada regime NÃO é uma soma de dias: é a DIFERENÇA entre
// acumulados. Para MP 01–12 e FS 13–30:
//
//     Marketplace  = acumulado em 12/09                (dia 1 → 12)
//     Full Service = acumulado em 30/09 − acumulado em 12/09
//     Mês          = acumulado em 30/09                (= MP + FS, sem dupla contagem)
//
// Isso só é exato se existir um snapshot NA VÉSPERA da troca (12/09). Sem ele a
// divisão é indisponível — e devolvemos o motivo, nunca um palpite: atribuir
// tudo a um regime reinterpretaria dados de outro.
//
// O Lançamento Mensal (`distribuicao_mensal`) é um total do mês espalhado em
// fatias UNIFORMES por dia (calc.js#distribuirValorMensal). A quebra por regime
// dessas fatias seria um artefato da divisão uniforme, não um fato — por isso um
// lote que atravessa a troca também é "indisponível", e a criação de um lote
// assim é bloqueada no service.
//
// Consolidação (NUNCA média de percentuais): parte dos VALORES em reais e divide
// pela base elegível no fim. Metas compostas por média PONDERADA PELO
// FATURAMENTO de cada regime (ver `comporMetas`).

import {
  situacaoOperou, diaAnterior, totalDeducoesIndicador, indicadorAplicavel,
} from "./dashboardExecutivo.calc.js";

/** camelCase (API) -> coluna (banco) dos 6 campos financeiros acumulados. */
export const CAMPOS_FINANCEIROS = {
  valorVendasIfood: "valor_vendas_ifood",
  taxasComissoes: "taxas_comissoes",
  servicosPromocoes: "servicos_promocoes",
  taxasEntregadores: "taxas_entregadores",
  ajustesFavorLoja: "ajustes_favor_loja",
  ajustesContraLoja: "ajustes_contra_loja",
};

export const MOTIVOS_DIVISAO_INDISPONIVEL = {
  SNAPSHOT_DE_VIRADA_AUSENTE: "snapshot_de_virada_ausente",
  ACUMULADO_INCONSISTENTE: "acumulado_inconsistente",
  LANCAMENTO_MENSAL_ATRAVESSA_TROCA: "lancamento_mensal_atravessa_troca",
};

const TOLERANCIA = 0.005;
const num = (v) => (v == null ? null : Number(v));
const vazio = () => Object.fromEntries(Object.keys(CAMPOS_FINANCEIROS).map((k) => [k, null]));

function valoresDe(linha) {
  return Object.fromEntries(Object.entries(CAMPOS_FINANCEIROS).map(([k, col]) => [k, num(linha?.[col])]));
}

function datasEntre(deExclusivo, ateInclusivo) {
  const datas = [];
  let d = deExclusivo;
  for (let i = 0; i < 40 && d < ateInclusivo; i += 1) {
    const [a, m, dia] = d.split("-").map(Number);
    const prox = new Date(Date.UTC(a, m - 1, dia + 1));
    d = `${prox.getUTCFullYear()}-${String(prox.getUTCMonth() + 1).padStart(2, "0")}-${String(prox.getUTCDate()).padStart(2, "0")}`;
    if (d <= ateInclusivo) datas.push(d);
  }
  return datas;
}

/**
 * Divide o Financeiro do mês pelos segmentos de modelo (já recortados no mês e
 * cobrindo-o por inteiro, em ordem).
 *
 * @param {Array<object>} linhas linhas CRUAS do mês da unidade
 * @param {Array<{modelo: string, inicio: string, fim: string}>} segmentos
 * @returns {{disponivel: true, fonte: 'snapshot'|'lancamento_mensal'|'sem_dado',
 *            segmentos: Array<{modelo,inicio,fim,semDado:boolean,valores:Record<string,number|null>}>,
 *            acumulado: Record<string,number|null>}
 *         | {disponivel: false, motivo: string, detalhe: object}}
 */
export function dividirFinanceiroPorSegmento(linhas, segmentos) {
  const todas = linhas ?? [];
  const reais = todas.filter((r) =>
    situacaoOperou(r.situacao) && r.origem_lancamento !== "distribuicao_mensal" && r.valor_vendas_ifood != null);

  if (reais.length) return dividirPorSnapshot(todas, reais, segmentos);

  const lote = todas.filter((r) =>
    situacaoOperou(r.situacao) && r.origem_lancamento === "distribuicao_mensal" && r.valor_vendas_ifood != null);
  if (lote.length) return dividirPorLoteMensal(lote, segmentos);

  return {
    disponivel: true, fonte: "sem_dado",
    segmentos: segmentos.map((s) => ({ ...s, semDado: true, valores: vazio() })),
    acumulado: vazio(),
  };
}

function dividirPorSnapshot(todas, reais, segmentos) {
  const ultimoAte = (dataIso) => reais
    .filter((r) => r.data_lancamento <= dataIso)
    .reduce((mais, r) => (!mais || r.data_lancamento > mais.data_lancamento ? r : mais), null);
  const diasNaoOperados = new Set(todas.filter((r) => !situacaoOperou(r.situacao)).map((r) => r.data_lancamento));

  const pontos = []; // acumulado no fim de cada segmento (null = nada apurado até ali)
  const n = segmentos.length;
  for (let i = 0; i < n; i += 1) {
    const seg = segmentos[i];
    const snap = ultimoAte(seg.fim);
    if (i < n - 1) {
      // Virada: o snapshot precisa cobrir até o ÚLTIMO dia deste regime. Aceita um snapshot mais
      // antigo só se TODOS os dias entre ele e a virada foram dias sem operação (nada a acumular).
      const de = snap ? snap.data_lancamento : diaAnterior(segmentos[0].inicio);
      const lacuna = datasEntre(de, seg.fim);
      if (lacuna.some((d) => !diasNaoOperados.has(d))) {
        return {
          disponivel: false, motivo: MOTIVOS_DIVISAO_INDISPONIVEL.SNAPSHOT_DE_VIRADA_AUSENTE,
          detalhe: { dataNecessaria: seg.fim, modelo: seg.modelo },
        };
      }
    }
    pontos.push(snap);
  }

  const resultado = [];
  for (let i = 0; i < n; i += 1) {
    const cur = pontos[i];
    const prev = i === 0 ? null : pontos[i - 1];
    const semNovoSnapshot = !cur || (prev && cur.data_lancamento === prev.data_lancamento);
    if (semNovoSnapshot) { resultado.push({ ...segmentos[i], semDado: true, valores: vazio() }); continue; }

    const vc = valoresDe(cur);
    const vp = prev ? valoresDe(prev) : null;
    const valores = {};
    for (const k of Object.keys(CAMPOS_FINANCEIROS)) {
      if (vc[k] == null) valores[k] = null;
      else if (!vp) valores[k] = vc[k];
      else valores[k] = vp[k] == null ? null : vc[k] - vp[k];
      if (valores[k] != null && valores[k] < -TOLERANCIA) {
        return {
          disponivel: false, motivo: MOTIVOS_DIVISAO_INDISPONIVEL.ACUMULADO_INCONSISTENTE,
          detalhe: { campo: k, data: cur.data_lancamento },
        };
      }
    }
    resultado.push({ ...segmentos[i], semDado: false, valores });
  }

  const ultimo = pontos.reduce((mais, p) => (p && (!mais || p.data_lancamento > mais.data_lancamento) ? p : mais), null);
  return { disponivel: true, fonte: "snapshot", segmentos: resultado, acumulado: valoresDe(ultimo) };
}

function dividirPorLoteMensal(lote, segmentos) {
  const daFatia = (seg) => lote.filter((r) => r.data_lancamento >= seg.inicio && r.data_lancamento <= seg.fim);
  const comFatia = segmentos.filter((s) => daFatia(s).length > 0);
  if (comFatia.length > 1) {
    return {
      disponivel: false, motivo: MOTIVOS_DIVISAO_INDISPONIVEL.LANCAMENTO_MENSAL_ATRAVESSA_TROCA,
      detalhe: { modelos: comFatia.map((s) => s.modelo) },
    };
  }
  const somar = (rows, col) => {
    const xs = rows.map((r) => r[col]).filter((x) => x != null);
    return xs.length ? xs.reduce((s, x) => s + Number(x), 0) : null;
  };
  const resultado = segmentos.map((seg) => {
    const rows = daFatia(seg);
    if (!rows.length) return { ...seg, semDado: true, valores: vazio() };
    return {
      ...seg, semDado: false,
      valores: Object.fromEntries(Object.entries(CAMPOS_FINANCEIROS).map(([k, col]) => [k, somar(rows, col)])),
    };
  });
  const dado = resultado.find((s) => !s.semDado);
  return { disponivel: true, fonte: "lancamento_mensal", segmentos: resultado, acumulado: dado ? { ...dado.valores } : vazio() };
}

/**
 * Consolida os segmentos em valores do período. Só usa VALORES em reais.
 *  - faturamento, taxas e comissões, serviços e promoções, ajustes: o acumulado do período
 *    (= soma dos segmentos; componentes aplicáveis a ambos os modelos);
 *  - taxas de entregadores: SÓ dos segmentos onde o componente existe (Marketplace);
 *  - Total de Deduções: Σ por segmento de `totalDeducoesIndicador(modeloDoSegmento, …)` — cada dia
 *    entra com as parcelas do SEU regime;
 *  - `baseEntregadores`: faturamento só dos segmentos onde entregadores se aplica (denominador do %).
 * @param {Extract<ReturnType<typeof dividirFinanceiroPorSegmento>, {disponivel: true}>} divisao
 */
export function consolidarSegmentos(divisao) {
  const segs = divisao.segmentos;
  const comEntregadores = segs.filter((s) => indicadorAplicavel(s.modelo, "taxas_entregadores"));

  let taxasEntregadores = null;
  const parciais = comEntregadores.filter((s) => !s.semDado).map((s) => s.valores.taxasEntregadores);
  if (parciais.length && parciais.every((p) => p != null)) taxasEntregadores = parciais.reduce((a, b) => a + b, 0);

  const totaisPorSegmento = segs.filter((s) => !s.semDado).map((s) => totalDeducoesIndicador(s.modelo, {
    taxas_comissoes: s.valores.taxasComissoes,
    servicos_promocoes: s.valores.servicosPromocoes,
    taxas_entregadores: s.valores.taxasEntregadores,
  })).filter((t) => t != null);
  const totalDeducoes = totaisPorSegmento.length ? totaisPorSegmento.reduce((a, b) => a + b, 0) : null;

  const baseEntregadores = comEntregadores.reduce((s, x) => s + (x.valores.valorVendasIfood ?? 0), 0);

  return {
    cardValores: { ...divisao.acumulado, taxasEntregadores },
    totalDeducoes,
    baseEntregadores,
  };
}

/**
 * Meta composta de um período misto: média das metas de cada regime PONDERADA
 * PELO FATURAMENTO do regime, considerando só os regimes onde o indicador se
 * aplica. Equivale a somar a meta em R$ de cada regime e dividir pela base
 * elegível total:  meta = Σ(metaᵢ × faturamentoᵢ) / Σ faturamentoᵢ.
 * (Vale para `metaIdeal` e `limite`.) Sem faturamento algum nos regimes
 * elegíveis, usa o último regime aplicável — não há resultado a avaliar.
 *
 * @param {Array<{modelo: string, peso: number, metas: Record<string, {metaIdeal: number|null, limite: number}>}>} partes
 * @param {string[]} indicadores
 * @returns {Record<string, {metaIdeal: number|null, limite: number}>}
 */
export function comporMetas(partes, indicadores) {
  const resultado = {};
  for (const ind of indicadores) {
    const elegiveis = partes.filter((p) => indicadorAplicavel(p.modelo, ind) && p.metas?.[ind]);
    if (!elegiveis.length) continue;
    const pesoTotal = elegiveis.reduce((s, p) => s + Math.max(0, p.peso ?? 0), 0);
    if (pesoTotal <= 0) { resultado[ind] = { ...elegiveis[elegiveis.length - 1].metas[ind] }; continue; }
    const pond = (campo) => {
      const itens = elegiveis.filter((p) => Number.isFinite(p.metas[ind][campo]));
      if (itens.length !== elegiveis.length) return null; // algum regime sem o campo -> não inventa
      return itens.reduce((s, p) => s + p.metas[ind][campo] * Math.max(0, p.peso ?? 0), 0) / pesoTotal;
    };
    resultado[ind] = { metaIdeal: pond("metaIdeal"), limite: pond("limite") };
  }
  return resultado;
}
