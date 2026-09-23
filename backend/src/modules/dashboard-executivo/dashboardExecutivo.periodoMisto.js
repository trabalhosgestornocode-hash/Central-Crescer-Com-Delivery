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
// RECONCILIAÇÃO GRANULAR (2026-09-22, investigação real Subway Feiraguay — ver
// dashboardExecutivo.confiabilidade.js para a causa raiz e os princípios).
// Cada um dos 6 campos financeiros, em CADA segmento, tem seu PRÓPRIO status:
//   conciliado | suspeito | nao_conciliavel | nao_aplicavel | sem_dado
// Um campo ruim NUNCA derruba os outros, nem o segmento inteiro, nem o mês —
// a Visão Geral/Indicadores/Diagnóstico propagam indisponibilidade só pelas
// dependências matemáticas REAIS (ex.: um percentual depende do faturamento
// do MESMO recorte; Total de Deduções em R$ não depende do faturamento).
//
// O Lançamento Mensal (`distribuicao_mensal`) é um total do mês espalhado em
// fatias UNIFORMES por dia (calc.js#distribuirValorMensal) — não é um
// acumulado, então não passa pela reconciliação de queda/reset. Um lote que
// atravessa a troca (não deveria acontecer — bloqueado na criação, ver
// service.js) não tem como ser dividido com segurança: todos os campos dos
// segmentos envolvidos ficam 'nao_conciliavel'.
//
// Consolidação (NUNCA média de percentuais): parte dos VALORES em reais e
// divide pela base elegível no fim. Metas compostas por média PONDERADA PELO
// FATURAMENTO de cada regime (ver `comporMetas`) — só quando o faturamento de
// TODOS os regimes elegíveis está conciliado (senão o peso seria inventado).

import { totalDeducoesIndicador, indicadorAplicavel, componentesTotalDeducoes } from "./dashboardExecutivo.calc.js";
import {
  caminharSequenciaAcumulada, reconciliarCampoSegmento, piorStatus, STATUS_CONCILIACAO,
} from "./dashboardExecutivo.confiabilidade.js";

/** camelCase (API) -> coluna (banco) dos 6 campos financeiros acumulados. */
export const CAMPOS_FINANCEIROS = {
  valorVendasIfood: "valor_vendas_ifood",
  taxasComissoes: "taxas_comissoes",
  servicosPromocoes: "servicos_promocoes",
  taxasEntregadores: "taxas_entregadores",
  ajustesFavorLoja: "ajustes_favor_loja",
  ajustesContraLoja: "ajustes_contra_loja",
};

/** Indicador de rentabilidade que cada campo financeiro alimenta (governa aplicabilidade por modelo). `null` = sempre aplicável. */
const INDICADOR_DO_CAMPO = {
  taxasComissoes: "taxas_comissoes", servicosPromocoes: "servicos_promocoes", taxasEntregadores: "taxas_entregadores",
};

const num = (v) => (v == null ? null : Number(v));
const somaOuNull = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) : null);

/** @typedef {{valor: number|null, status: string, ultimoValorValido: {valor:number,data:string}|null}} RegistroConsolidado */

/**
 * Reconcilia os 6 campos financeiros de cada segmento — fonte SNAPSHOT
 * (dia a dia real, ver `caminharSequenciaAcumulada`) ou LOTE MENSAL (fatias
 * uniformes, sem reconciliação de acumulado). Sem nenhuma das duas, todos os
 * campos de todos os segmentos ficam 'sem_dado'.
 *
 * @param {Array<object>} linhas linhas CRUAS do mês da unidade
 * @param {Array<{modelo: string, inicio: string, fim: string}>} segmentos já recortados no mês e cobrindo-o por inteiro, em ordem
 * @returns {{
 *   fonte: 'snapshot'|'lancamento_mensal'|'sem_dado',
 *   segmentos: Array<{modelo:string, inicio:string, fim:string,
 *     campos: Record<keyof CAMPOS_FINANCEIROS, {valorOficial:number|null, status:string, motivo:string|null, ultimoValorValido:{valor:number,data:string}|null, detalhe:object|null}>}>,
 * }}
 */
export function dividirFinanceiroPorSegmento(linhas, segmentos) {
  const todas = linhas ?? [];
  const temSnapshotReal = todas.some((r) => r.origem_lancamento !== "distribuicao_mensal" && r.valor_vendas_ifood != null);
  if (temSnapshotReal) return dividirPorSnapshot(todas, segmentos);

  const lote = todas.filter((r) => r.origem_lancamento === "distribuicao_mensal" && r.valor_vendas_ifood != null);
  if (lote.length) return dividirPorLoteMensal(lote, segmentos);

  const semDado = { valorOficial: null, status: STATUS_CONCILIACAO.SEM_DADO, motivo: null, ultimoValorValido: null, detalhe: null };
  return {
    fonte: "sem_dado",
    segmentos: segmentos.map((s) => ({
      ...s, campos: Object.fromEntries(Object.keys(CAMPOS_FINANCEIROS).map((k) => [k, { ...semDado }])),
    })),
    periodoDireto: Object.fromEntries(Object.keys(CAMPOS_FINANCEIROS).map((k) => [k, { ...semDado }])),
  };
}

function dividirPorSnapshot(todas, segmentos) {
  const resultado = segmentos.map((s) => ({ ...s, campos: {} }));
  const periodoDireto = {};
  const fimPeriodo = segmentos[segmentos.length - 1].fim;
  for (const [campoCamel, coluna] of Object.entries(CAMPOS_FINANCEIROS)) {
    const sequencia = caminharSequenciaAcumulada(todas, coluna);
    // PERÍODO DIRETO — o total do período INTEIRO não precisa do recorte por
    // segmento quando o campo se aplica aos DOIS modelos (faturamento, taxas,
    // serviços, ajustes): é sempre "o último ponto confiável", igual a ler o
    // snapshot mais recente direto — não fica refém de UM ponto de corte
    // faltando no meio do mês enquanto o total geral é perfeitamente
    // conhecido (reaproveita `reconciliarCampoSegmento` com
    // `ehPrimeiroSegmento=true`: é exatamente essa semântica de "sem
    // subtração, o valor do fim já é o total").
    periodoDireto[campoCamel] = reconciliarCampoSegmento(sequencia, null, fimPeriodo, true);
    segmentos.forEach((seg, i) => {
      const indicador = INDICADOR_DO_CAMPO[campoCamel];
      if (indicador && !indicadorAplicavel(seg.modelo, indicador)) {
        resultado[i].campos[campoCamel] = { valorOficial: null, status: STATUS_CONCILIACAO.NAO_APLICAVEL, motivo: null, ultimoValorValido: null, detalhe: null };
        return;
      }
      resultado[i].campos[campoCamel] = reconciliarCampoSegmento(sequencia, seg.inicio, seg.fim, i === 0);
    });
  }
  return { fonte: "snapshot", segmentos: resultado, periodoDireto };
}

/**
 * Lote mensal: fatias UNIFORMES por dia, não um acumulado — soma direto, sem
 * caminhada de reconciliação (não existe "queda de acumulado" numa fatia).
 * Um lote que atravessa a troca não tem como ser dividido com segurança —
 * granular mesmo assim: todos os campos dos segmentos envolvidos ficam
 * 'nao_conciliavel' (não é "o mês inteiro", é "os campos que dependem desta
 * fonte"; ver `MOTIVOS_INDISPONIVEL.LOTE_MENSAL_ATRAVESSA_TROCA`).
 */
export const MOTIVOS_INDISPONIVEL = {
  LOTE_MENSAL_ATRAVESSA_TROCA: "lote_mensal_atravessa_troca",
};

function dividirPorLoteMensal(lote, segmentos) {
  const daFatia = (seg) => lote.filter((r) => r.data_lancamento >= seg.inicio && r.data_lancamento <= seg.fim);
  const comFatia = segmentos.filter((s) => daFatia(s).length > 0);
  const atravessaTroca = comFatia.length > 1;

  const somar = (rows, col) => {
    const xs = rows.map((r) => r[col]).filter((x) => x != null).map(Number);
    return somaOuNull(xs);
  };
  const resultado = segmentos.map((seg) => {
    const indicadorAplicavelCampo = (campoCamel) => {
      const indicador = INDICADOR_DO_CAMPO[campoCamel];
      return !indicador || indicadorAplicavel(seg.modelo, indicador);
    };
    if (atravessaTroca) {
      return {
        ...seg,
        campos: Object.fromEntries(Object.keys(CAMPOS_FINANCEIROS).map((k) => [k, indicadorAplicavelCampo(k)
          ? { valorOficial: null, status: STATUS_CONCILIACAO.NAO_CONCILIAVEL, motivo: MOTIVOS_INDISPONIVEL.LOTE_MENSAL_ATRAVESSA_TROCA, ultimoValorValido: null, detalhe: { modelos: comFatia.map((s) => s.modelo) } }
          : { valorOficial: null, status: STATUS_CONCILIACAO.NAO_APLICAVEL, motivo: null, ultimoValorValido: null, detalhe: null }])),
      };
    }
    const rows = daFatia(seg);
    return {
      ...seg,
      campos: Object.fromEntries(Object.entries(CAMPOS_FINANCEIROS).map(([campoCamel, coluna]) => {
        if (!indicadorAplicavelCampo(campoCamel)) return [campoCamel, { valorOficial: null, status: STATUS_CONCILIACAO.NAO_APLICAVEL, motivo: null, ultimoValorValido: null, detalhe: null }];
        const valor = rows.length ? somar(rows, coluna) : null;
        return [campoCamel, valor == null
          ? { valorOficial: null, status: STATUS_CONCILIACAO.SEM_DADO, motivo: null, ultimoValorValido: null, detalhe: null }
          : { valorOficial: valor, status: STATUS_CONCILIACAO.CONCILIADO, motivo: null, ultimoValorValido: { valor, data: seg.fim }, detalhe: null }];
      })),
    };
  });
  // Período direto (lote mensal): soma de TODAS as fatias do mês, sem
  // depender de fronteira de segmento — fatias não são acumulado, então o
  // total do período nunca fica refém de um ponto de corte ausente.
  const periodoDireto = Object.fromEntries(Object.entries(CAMPOS_FINANCEIROS).map(([campoCamel, coluna]) => {
    const valor = somar(lote, coluna);
    return [campoCamel, valor == null
      ? { valorOficial: null, status: STATUS_CONCILIACAO.SEM_DADO, motivo: null, ultimoValorValido: null, detalhe: null }
      : { valorOficial: valor, status: STATUS_CONCILIACAO.CONCILIADO, motivo: null, ultimoValorValido: null, detalhe: null }];
  }));
  return { fonte: "lancamento_mensal", segmentos: resultado, periodoDireto };
}

/** Soma os valores oficiais dos segmentos elegíveis; status = pior entre eles; `ultimoValorValido` = melhor esforço (contexto, nunca oficial). */
function consolidarCampo(segmentosCampo) {
  const elegiveis = segmentosCampo.filter((c) => c.status !== STATUS_CONCILIACAO.NAO_APLICAVEL);
  if (!elegiveis.length) return { valor: null, status: STATUS_CONCILIACAO.NAO_APLICAVEL, ultimoValorValido: null };
  const status = piorStatus(...elegiveis.map((c) => c.status));
  if (status === STATUS_CONCILIACAO.CONCILIADO) {
    return { valor: somaOuNull(elegiveis.map((c) => num(c.valorOficial))), status, ultimoValorValido: null };
  }
  // Não-conciliado: soma de melhor esforço só como CONTEXTO (nunca alimenta % / meta / diagnóstico).
  const partes = elegiveis.map((c) => (c.status === STATUS_CONCILIACAO.CONCILIADO ? c.valorOficial : c.ultimoValorValido?.valor) ?? 0);
  const dataMaisRecente = elegiveis.map((c) => c.ultimoValorValido?.data ?? null).filter(Boolean).sort().pop() ?? null;
  return { valor: null, status, ultimoValorValido: dataMaisRecente ? { valor: partes.reduce((a, b) => a + b, 0), data: dataMaisRecente } : null };
}

/**
 * Consolida os segmentos reconciliados (`dividirFinanceiroPorSegmento`) em
 * valores do PERÍODO — granular: cada indicador carrega seu PRÓPRIO status,
 * nunca um apagão conjunto.
 *  - taxas de entregadores / sua base: só dos segmentos onde o componente se aplica (Marketplace);
 *  - Total de Deduções: por segmento, soma dos componentes APLICÁVEIS ao modelo
 *    daquele segmento (mesma regra de `totalDeducoesIndicador`), status = pior
 *    componente aplicável daquele segmento; depois soma os segmentos;
 *  - Receita Líquida: depende de faturamento + Total de Deduções (financeiro,
 *    inclui ajustes contra) + ajustes a favor — herda o pior dos três.
 * `porSegmento`: o MESMO cálculo (campos + Total de Deduções + Receita
 * Líquida), mas por REGIME — alimenta a "Conciliação do Período" e o
 * comparativo Marketplace × Full Service (nunca duplica a fórmula: reusa
 * `receitaLiquidaDoRecorte`/`totalDeducoesDoSegmento` com o recorte de um
 * segmento só).
 * @param {ReturnType<typeof dividirFinanceiroPorSegmento>} divisao
 * @returns {{
 *   campos: Record<keyof CAMPOS_FINANCEIROS, RegistroConsolidado>,
 *   totalDeducoes: RegistroConsolidado,
 *   receitaLiquida: RegistroConsolidado,
 *   baseEntregadores: RegistroConsolidado,
 *   porSegmento: Array<{modelo:string, inicio:string, fim:string, campos: Record<keyof CAMPOS_FINANCEIROS, RegistroConsolidado>, totalDeducoes: RegistroConsolidado, receitaLiquida: RegistroConsolidado}>,
 * }}
 */
export function consolidarSegmentos(divisao) {
  const segs = divisao.segmentos;
  const campos = {};
  for (const campoCamel of Object.keys(CAMPOS_FINANCEIROS)) {
    if (campoCamel === "taxasEntregadores") {
      // Único campo que genuinamente precisa de fronteira de segmento: o
      // total do período TEM que excluir a parte Full Service (não aplicável).
      campos[campoCamel] = consolidarCampo(segs.map((s) => s.campos[campoCamel]));
      continue;
    }
    // Demais campos (faturamento, taxas, serviços, ajustes) se aplicam aos
    // DOIS modelos — o total do PERÍODO não depende de nenhuma fronteira de
    // segmento, é sempre o último ponto confiável (ver `dividirPorSnapshot`
    // #periodoDireto). Um segmento sem ponto de corte no meio do mês não
    // pode derrubar um total que, pela via direta, é perfeitamente conhecido.
    const d = divisao.periodoDireto[campoCamel];
    campos[campoCamel] = { valor: d.valorOficial, status: d.status, ultimoValorValido: d.ultimoValorValido };
  }

  // Total de Deduções: cada SEGMENTO primeiro (só componentes aplicáveis ao
  // seu modelo), depois soma os segmentos — nunca aplica componentes de um
  // modelo aos dias do outro. Exposto TAMBÉM por segmento (não só o
  // consolidado) — a Conciliação do Período mostra o total de CADA regime.
  const totalDeducoesDoSegmento = (s) => {
    const aplicaveis = componentesTotalDeducoes(s.modelo).map((ind) => {
      const campoCamel = Object.keys(INDICADOR_DO_CAMPO).find((k) => INDICADOR_DO_CAMPO[k] === ind);
      return s.campos[campoCamel];
    });
    if (!aplicaveis.length) return { valor: null, status: STATUS_CONCILIACAO.NAO_APLICAVEL, ultimoValorValido: null };
    const status = piorStatus(...aplicaveis.map((c) => c.status));
    if (status === STATUS_CONCILIACAO.CONCILIADO) {
      return { valor: totalDeducoesIndicador(s.modelo, {
        taxas_comissoes: s.campos.taxasComissoes.valorOficial,
        servicos_promocoes: s.campos.servicosPromocoes.valorOficial,
        taxas_entregadores: s.campos.taxasEntregadores?.valorOficial,
      }), status, ultimoValorValido: null };
    }
    const partes = aplicaveis.map((c) => (c.status === STATUS_CONCILIACAO.CONCILIADO ? c.valorOficial : c.ultimoValorValido?.valor) ?? 0);
    return { valor: null, status, ultimoValorValido: { valor: partes.reduce((a, b) => a + b, 0), data: s.fim } };
  };
  const totalPorSegmento = segs.map(totalDeducoesDoSegmento);
  const totalDeducoes = consolidarCampo(totalPorSegmento.map((t) => ({ status: t.status, valorOficial: t.valor, ultimoValorValido: t.ultimoValorValido })));

  // Receita Líquida usa o total FINANCEIRO ("caixa real": taxas + serviços +
  // entregadores + ajustes CONTRA — nunca o total do INDICADOR acima, que
  // não inclui ajustes; mesma distinção de calc.js#totalDeducoes vs
  // #totalDeducoesIndicador). Mesma fórmula aplicada a QUALQUER "recorte" com
  // forma de `campos` (um segmento OU o consolidado) — não duplica a regra.
  //
  // Ajustes (favor/contra) são OPCIONAIS por natureza — a maioria dos meses
  // não tem nenhum. "Nunca informado" (sem_dado) não pode degradar o total
  // financeiro nem a Receita Líquida (mesma leniência de calc.js#totalDeducoes:
  // some só o que existe); só degrada quando EXISTE um ajuste e ELE PRÓPRIO é
  // suspeito/não-conciliável — aí é uma inconsistência real, não ausência.
  const ehAjusteDuvidoso = (c) => c.status === STATUS_CONCILIACAO.SUSPEITO || c.status === STATUS_CONCILIACAO.NAO_CONCILIAVEL;
  const valorOuZero = (c) => (c.status === STATUS_CONCILIACAO.CONCILIADO ? (c.valor ?? 0) : 0);

  function receitaLiquidaDoRecorte(camposDoRecorte) {
    const obrigatoriosFinanceiro = [camposDoRecorte.taxasComissoes, camposDoRecorte.servicosPromocoes, camposDoRecorte.taxasEntregadores]
      .filter((c) => c.status !== STATUS_CONCILIACAO.NAO_APLICAVEL);
    const statusFinanceiro = piorStatus(
      ...obrigatoriosFinanceiro.map((c) => c.status),
      ehAjusteDuvidoso(camposDoRecorte.ajustesContraLoja) ? camposDoRecorte.ajustesContraLoja.status : STATUS_CONCILIACAO.CONCILIADO,
    );
    const totalFinanceiro = statusFinanceiro === STATUS_CONCILIACAO.CONCILIADO
      ? obrigatoriosFinanceiro.reduce((s, c) => s + valorOuZero(c), 0) + valorOuZero(camposDoRecorte.ajustesContraLoja)
      : null;
    const statusReceita = piorStatus(
      camposDoRecorte.valorVendasIfood.status, statusFinanceiro,
      ehAjusteDuvidoso(camposDoRecorte.ajustesFavorLoja) ? camposDoRecorte.ajustesFavorLoja.status : STATUS_CONCILIACAO.CONCILIADO,
    );
    return statusReceita === STATUS_CONCILIACAO.CONCILIADO
      ? { valor: (camposDoRecorte.valorVendasIfood.valor ?? 0) - (totalFinanceiro ?? 0) + valorOuZero(camposDoRecorte.ajustesFavorLoja), status: statusReceita, ultimoValorValido: null }
      : { valor: null, status: statusReceita, ultimoValorValido: null };
  }

  // `campos` de um segmento tem a mesma forma de `campos` consolidado
  // (RegistroCampo com `.valorOficial`) — normaliza pra `.valor` só pra reusar `receitaLiquidaDoRecorte`.
  const comoCamposConsolidado = (s) => Object.fromEntries(
    Object.entries(s.campos).map(([k, c]) => [k, { valor: c.valorOficial, status: c.status, ultimoValorValido: c.ultimoValorValido }]),
  );
  const porSegmento = segs.map((s, i) => {
    const camposNormalizados = comoCamposConsolidado(s);
    return {
      modelo: s.modelo, inicio: s.inicio, fim: s.fim,
      campos: camposNormalizados,
      totalDeducoes: totalPorSegmento[i],
      receitaLiquida: receitaLiquidaDoRecorte(camposNormalizados),
    };
  });

  const receitaLiquida = receitaLiquidaDoRecorte(campos);

  const comEntregadores = segs.filter((s) => indicadorAplicavel(s.modelo, "taxas_entregadores"));
  const baseEntregadores = consolidarCampo(comEntregadores.map((s) => s.campos.valorVendasIfood));

  return { campos, totalDeducoes, receitaLiquida, baseEntregadores, porSegmento };
}

/**
 * Resumo de UM motivo (compat com o aviso discreto de sempre na UI) a partir
 * do consolidado granular — o PIOR problema entre faturamento, Total de
 * Deduções e Receita Líquida (os três que alimentam Meta/Indicadores/
 * Diagnóstico). NÃO substitui a granularidade: é só o resumo de mais alto
 * nível; o detalhe campo a campo continua disponível em `divisao`/`consolidado`
 * pra quem precisar (painéis de Conciliação/Comparativo).
 * @param {ReturnType<typeof consolidarSegmentos>} consolidado
 * @returns {{disponivel: boolean, motivo: string|null, detalhe: object|null}}
 */
export function resumirConciliacao(consolidado) {
  const relevantes = [consolidado.campos.valorVendasIfood, consolidado.totalDeducoes, consolidado.receitaLiquida];
  // Qualquer status != conciliado é "indisponível" pro resumo — inclusive
  // 'sem_dado' (ainda não há dado suficiente pra separar os regimes, não é
  // um problema de qualidade, mas o aviso continua sendo útil: orienta a
  // lançar o dia que falta). O `motivo` distingue os dois casos pra UI.
  const problematico = relevantes.find((c) => c.status !== STATUS_CONCILIACAO.CONCILIADO);
  if (!problematico) return { disponivel: true, motivo: null, detalhe: null };
  return { disponivel: false, motivo: problematico.status, detalhe: { ultimoValorValido: problematico.ultimoValorValido } };
}

/**
 * Meta composta de um período misto: média das metas de cada regime PONDERADA
 * PELO FATURAMENTO do regime, considerando só os regimes onde o indicador se
 * aplica E cujo faturamento (peso) está CONCILIADO — um peso não confiável
 * não entra na ponderação silenciosamente (a meta composta fica indisponível
 * para esse indicador, nunca com um peso inventado).
 * Equivale a somar a meta em R$ de cada regime e dividir pela base elegível
 * total: meta = Σ(metaᵢ × faturamentoᵢ) / Σ faturamentoᵢ. (Vale para
 * `metaIdeal` e `limite`.)
 *
 * @param {Array<{modelo: string, peso: number|null, pesoConciliado: boolean, metas: Record<string, {metaIdeal: number|null, limite: number}>}>} partes
 * @param {string[]} indicadores
 * @returns {Record<string, {metaIdeal: number|null, limite: number}>}
 */
export function comporMetas(partes, indicadores) {
  const resultado = {};
  for (const ind of indicadores) {
    const elegiveis = partes.filter((p) => indicadorAplicavel(p.modelo, ind) && p.metas?.[ind]);
    if (!elegiveis.length) continue;
    if (elegiveis.some((p) => !p.pesoConciliado)) continue; // peso não confiável -> sem meta composta (nunca inventa)
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
