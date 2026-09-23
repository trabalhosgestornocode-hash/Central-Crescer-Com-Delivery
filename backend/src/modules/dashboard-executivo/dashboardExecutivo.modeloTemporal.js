// MODELO LOGÍSTICO TEMPORAL (Marketplace x Full Service) — puro, sem I/O.
//
// REGRA CENTRAL: o modelo logístico é uma propriedade do TEMPO, não só da
// unidade. Cada dado é interpretado pelo modelo vigente NA DATA dele — nunca
// pelo modelo atual (`unidades.modelo_logistico_ifood`).
//
// Fonte dos dados: `unidade_modelo_logistico_historico` (migration 024 + 089).
// Cada linha com `vigencia_inicio` é um PONTO DE TROCA: "a partir desta data
// (inclusive) vale `modelo_novo`; antes dela valia `modelo_anterior`". Os
// períodos de vigência são DERIVADOS desses pontos — o fim de um período é
// sempre a véspera da troca seguinte. Não existe `vigencia_fim` armazenado, logo
// não há como ter períodos sobrepostos ou com buraco.
//
// "Misto" NUNCA é um modelo persistido: é só o estado DERIVADO de um período
// consultado que atravessa uma troca (ver `estadoDoPeriodo`).

import { ApiError } from "../../shared/ApiError.js";
import { diaAnterior, MODELOS_LOGISTICOS, ROTULO_MODELO } from "./dashboardExecutivo.calc.js";

/** Estado derivado (nunca persistido) de um período que atravessa uma troca de modelo. */
export const MODELO_MISTO = "misto";
export const ROTULO_MISTO = "Operação mista";

/** Limite inferior de sanidade para a data de vigência (o produto é de 2026). */
export const VIGENCIA_MINIMA = "2020-01-01";

/**
 * @typedef {{vigenciaInicio: string, modeloAnterior: string, modeloNovo: string}} TrocaModelo
 * @typedef {{modelo: string, inicio: string|null, fim: string|null}} PeriodoModelo
 *   `inicio`/`fim` `null` = sem limite naquele lado (desde sempre / até hoje em aberto).
 */

const diaSeguinte = (iso) => {
  const [a, m, d] = String(iso).split("-").map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d + 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
};

/** Normaliza linhas cruas do banco (snake_case) para `TrocaModelo`, só as datadas, em ordem crescente. */
export function trocasDeLinhas(linhas) {
  return (linhas ?? [])
    .filter((r) => r.vigencia_inicio != null)
    .map((r) => ({
      vigenciaInicio: String(r.vigencia_inicio).slice(0, 10),
      modeloAnterior: r.modelo_anterior,
      modeloNovo: r.modelo_novo,
    }))
    .sort((a, b) => (a.vigenciaInicio < b.vigenciaInicio ? -1 : a.vigenciaInicio > b.vigenciaInicio ? 1 : 0));
}

/**
 * Períodos de vigência da unidade, em ordem, cobrindo todo o tempo sem buracos
 * nem sobreposições.
 *  - Sem nenhuma troca datada: UM período aberto com o modelo atual da unidade
 *    (comportamento anterior à migration 089, inalterado).
 *  - Com trocas: o 1º período vale `modeloAnterior` da 1ª troca (desde sempre);
 *    cada troca abre um período que vai até a véspera da seguinte.
 * @param {{modeloAtual: string, trocas?: TrocaModelo[]}} p
 * @returns {PeriodoModelo[]}
 */
export function montarLinhaDoTempo({ modeloAtual, trocas = [] }) {
  if (!trocas.length) return [{ modelo: modeloAtual, inicio: null, fim: null }];
  const periodos = [{ modelo: trocas[0].modeloAnterior, inicio: null, fim: diaAnterior(trocas[0].vigenciaInicio) }];
  trocas.forEach((t, i) => {
    const proxima = trocas[i + 1];
    periodos.push({ modelo: t.modeloNovo, inicio: t.vigenciaInicio, fim: proxima ? diaAnterior(proxima.vigenciaInicio) : null });
  });
  return periodos;
}

/**
 * Modelo vigente numa data. Regra: `inicio <= data AND (fim IS NULL OR fim >= data)`.
 * @param {PeriodoModelo[]} linhaDoTempo @param {string} dataIso
 * @returns {string} 'marketplace' | 'full_service'
 */
export function modeloNaData(linhaDoTempo, dataIso) {
  const periodo = linhaDoTempo.find((p) => (p.inicio == null || p.inicio <= dataIso) && (p.fim == null || p.fim >= dataIso));
  // Não acontece com uma linha do tempo montada por `montarLinhaDoTempo` (cobre todo o eixo).
  if (!periodo) throw new Error(`Linha do tempo do modelo logístico não cobre ${dataIso}.`);
  return periodo.modelo;
}

/**
 * Recorta a linha do tempo em [inicioIso, fimIso] (inclusive). Períodos
 * consecutivos do mesmo modelo são fundidos (Marketplace→Marketplace não é uma
 * troca real para o período).
 * @returns {Array<{modelo: string, inicio: string, fim: string}>}
 */
export function segmentosDoPeriodo(linhaDoTempo, inicioIso, fimIso) {
  const segmentos = [];
  for (const p of linhaDoTempo) {
    const inicio = p.inicio != null && p.inicio > inicioIso ? p.inicio : inicioIso;
    const fim = p.fim != null && p.fim < fimIso ? p.fim : fimIso;
    if (inicio > fim) continue;
    const ultimo = segmentos[segmentos.length - 1];
    if (ultimo && ultimo.modelo === p.modelo && diaSeguinte(ultimo.fim) === inicio) ultimo.fim = fim;
    else segmentos.push({ modelo: p.modelo, inicio, fim });
  }
  return segmentos;
}

/**
 * Estado do período consultado: um dos dois modelos, ou `misto` (derivado).
 * @param {Array<{modelo: string}>} segmentos
 * @returns {{tipo: string, misto: boolean, modelos: string[]}}
 */
export function estadoDoPeriodo(segmentos) {
  const modelos = [...new Set(segmentos.map((s) => s.modelo))];
  if (modelos.length > 1) return { tipo: MODELO_MISTO, misto: true, modelos };
  return { tipo: modelos[0], misto: false, modelos };
}

/** Rótulo de exibição de `marketplace` | `full_service` | `misto`. */
export const rotuloDoModelo = (tipo) => (tipo === MODELO_MISTO ? ROTULO_MISTO : (ROTULO_MODELO[tipo] ?? tipo));

/**
 * Valida o registro de uma NOVA troca de modelo com data de vigência.
 * Só se aceita uma troca NO FIM da cadeia (depois da última já registrada) —
 * nunca reescrever nem intercalar períodos passados.
 *
 * Dois usos (`modeloAnterior` é opcional):
 *  - TROCA: o modelo novo difere do vigente; o anterior é o vigente (informá-lo é opcional, e se vier tem de bater).
 *  - DECLARAÇÃO HISTÓRICA: a unidade JÁ opera no modelo pedido (trocou no passado, sem data registrada) e o
 *    usuário informa desde quando + qual era o modelo antes. Só vale se ainda NÃO há nenhuma troca datada
 *    (senão o passado já está definido) e exige `modeloAnterior` explícito — nunca se infere.
 *
 * @param {{linhaDoTempo: PeriodoModelo[], trocas: TrocaModelo[], modeloNovo: string, modeloAnterior?: string|null, vigenciaInicio: string, hojeIso: string}} p
 * @returns {{mudou: boolean, modeloAnterior: string, historica: boolean}}
 *   `mudou=false` quando o modelo novo já é o vigente e não é uma declaração histórica (nenhum ponto é criado).
 * @throws {ApiError} 400 para data inválida/futura/anterior à última troca ou modelos incoerentes.
 */
export function validarNovaTroca({ linhaDoTempo, trocas, modeloNovo, modeloAnterior: anteriorInformado = null, vigenciaInicio, hojeIso }) {
  if (!MODELOS_LOGISTICOS.includes(modeloNovo)) throw ApiError.badRequest("Modelo logístico inválido.");
  if (vigenciaInicio < VIGENCIA_MINIMA) throw ApiError.badRequest("A data de vigência é anterior ao permitido.");
  if (vigenciaInicio > hojeIso) {
    throw ApiError.badRequest("A data de vigência não pode ser futura. Informe hoje ou uma data passada (a troca agendada ainda não é suportada).");
  }
  // Modelo em aberto (o que vale desde a última troca até hoje).
  const modeloAberto = linhaDoTempo[linhaDoTempo.length - 1].modelo;
  let modeloAnterior = modeloAberto;
  let historica = false;
  if (anteriorInformado != null) {
    if (!MODELOS_LOGISTICOS.includes(anteriorInformado)) throw ApiError.badRequest("Modelo anterior inválido.");
    if (anteriorInformado === modeloNovo) throw ApiError.badRequest("O modelo anterior deve ser diferente do novo.");
    if (anteriorInformado !== modeloAberto) {
      // Só é coerente como declaração histórica: o modelo pedido JÁ é o vigente, sem troca datada ainda.
      if (modeloNovo !== modeloAberto || trocas.length) {
        throw ApiError.badRequest("O modelo anterior informado não corresponde ao modelo vigente da unidade.");
      }
      historica = true;
      modeloAnterior = anteriorInformado;
    }
  } else if (modeloNovo === modeloAberto) {
    return { mudou: false, modeloAnterior: modeloAberto, historica: false };
  }

  const ultima = trocas[trocas.length - 1];
  if (ultima && vigenciaInicio <= ultima.vigenciaInicio) {
    throw ApiError.badRequest(
      `A vigência deve começar depois da última troca registrada (${ultima.vigenciaInicio}). Períodos passados não podem ser reescritos.`,
    );
  }
  return { mudou: true, modeloAnterior, historica };
}

/**
 * Modelos em vigor nas datas informadas (únicos, na ordem em que aparecem).
 * Vazio -> `fallback`. Usado para decidir a aplicabilidade dos campos de um
 * lançamento mensal pelos dias que ele de fato cobre.
 * @param {PeriodoModelo[]} linhaDoTempo @param {string[]} datas @param {string[]} fallback
 */
export function modelosDasDatas(linhaDoTempo, datas, fallback = []) {
  const modelos = [...new Set((datas ?? []).map((d) => modeloNaData(linhaDoTempo, d)))];
  return modelos.length ? modelos : fallback;
}

/**
 * Descrição do período consultado para a API/UI: o estado derivado (nunca
 * persistido), os segmentos por modelo e a reconciliação financeira granular
 * (ver dashboardExecutivo.confiabilidade.js / periodoMisto.js — cada campo de
 * cada segmento tem seu próprio status; isto aqui não decide nada disso, só
 * empacota o que `dashboardExecutivo.service.js` já calculou).
 * `resumoConciliacao`/`fonteConciliacao`: resumo de UM motivo (o pior
 * problema, se houver) para o aviso discreto da UI — ver periodoMisto.js#resumirConciliacao.
 * `conciliacao`: detalhe campo a campo, para os painéis de Conciliação/Comparativo.
 * @param {{estado: ReturnType<typeof estadoDoPeriodo>, segmentos: Array<{modelo: string, inicio: string, fim: string}>, linhaDoTempo: PeriodoModelo[], resumoConciliacao: {disponivel:boolean,motivo:string|null,detalhe:object|null}|null, fonteConciliacao: string|null, conciliacao: object|null}} p
 */
export function descreverPeriodo({ estado, segmentos, linhaDoTempo, resumoConciliacao, fonteConciliacao, conciliacao }) {
  const aberto = linhaDoTempo[linhaDoTempo.length - 1];
  return {
    tipo: estado.tipo,
    misto: estado.misto,
    rotulo: rotuloDoModelo(estado.tipo),
    segmentos: segmentos.map((s, i) => ({
      modelo: s.modelo, rotulo: ROTULO_MODELO[s.modelo] ?? s.modelo, inicio: s.inicio, fim: s.fim,
      emAberto: i === segmentos.length - 1 && aberto.fim == null && aberto.modelo === s.modelo,
    })),
    divisaoDisponivel: resumoConciliacao ? resumoConciliacao.disponivel : true,
    divisaoMotivo: resumoConciliacao && !resumoConciliacao.disponivel ? resumoConciliacao.motivo : null,
    divisaoDetalhe: resumoConciliacao && !resumoConciliacao.disponivel ? resumoConciliacao.detalhe : null,
    fonteDivisao: fonteConciliacao,
    conciliacao,
  };
}
