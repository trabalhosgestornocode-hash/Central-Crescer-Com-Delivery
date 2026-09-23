// CONFIABILIDADE DOS DADOS FINANCEIROS — camada GENÉRICA (não é uma regra
// "da Subway Feiraguay"). Detecta, campo a campo, se um snapshot ACUMULADO
// (valor_vendas_ifood, taxas_comissoes, servicos_promocoes, taxas_entregadores)
// pode ser usado com confiança num determinado ponto do mês.
//
// ORIGEM: investigação real (2026-09-22) do caso Subway Feiraguay — setembro/2026
// misto Marketplace (01–19) / Full Service (20+). O Dashboard mostrava "Dados
// insuficientes" no mês inteiro. Causa raiz comprovada via
// `lancamentos_financeiros_auditoria`: em 21/09 o campo `valor_vendas_ifood`
// (NULL até então) foi preenchido com o MESMO valor de `valor_vendas_bruto`
// (76.910,32) — quebrando o padrão de todo o resto do mês (iFood sempre >
// bruto) e, por ser um ACUMULADO, ficando MENOR que o snapshot do dia
// anterior (84.736,88). Não há evidência de estorno/correção legítima do
// iFood (pedidos e novos clientes do dia seguem crescendo normalmente) —
// o mais provável é erro de digitação ("Erro de preenchimento", motivo
// literal registrado pela própria unidade). Verificação mais ampla: existem
// outras 3 quedas de acumulado em setembro/2026, em unidades SEM troca de
// modelo — ou seja, é um problema de qualidade de dado do produto, não algo
// ligado à migration 089.
//
// PRINCÍPIO (bloco de decisão do usuário, 2026-09-22):
//   1. Uma queda no acumulado NUNCA vira estorno nem é corrigida sozinha —
//      só marca aquele CAMPO+SEGMENTO como não conciliável.
//   2. A indisponibilidade é GRANULAR: um campo ruim não pode derrubar
//      indicadores, metas, diagnóstico ou plano de ação que dependem de
//      outros dados válidos.
//   3. Um "congelamento" (valor cai a zero) NUNCA vira silenciosamente o
//      valor oficial do fechamento — o último valor válido é mostrado como
//      EVIDÊNCIA/CONTEXTO, nunca como o valor confirmado.
//
// Três conceitos, sempre juntos:
//   valorOficial       — só quando os dados realmente sustentam (status 'conciliado').
//   ultimoValorValido  — {valor, data} do último ponto que passou pelas validações
//                         (evidência, mesmo quando valorOficial é null).
//   status             — 'conciliado' | 'suspeito' | 'nao_conciliavel' | 'nao_aplicavel' | 'sem_dado'.

import { situacaoOperou } from "./dashboardExecutivo.calc.js";

/** Tolerância de ponto flutuante (nunca um limiar de negócio). */
export const TOLERANCIA_RECONCILIACAO = 0.005;

/** Abaixo disto (R$), uma queda de acumulado é ruído/arredondamento — não vira alerta nem status degradado. */
export const LIMIAR_QUEDA_IGNORAVEL_REAIS = 1;

/** Acima disto (R$), uma queda de acumulado é MATERIAL — exige confirmação reforçada + justificativa (ver `avaliarQuedaAcumulado`). */
export const LIMIAR_QUEDA_MATERIAL_REAIS = 50;

/** Um valor "não passa perto de zero" quando é maior que isto — separa reset/zeragem (regra B) de queda parcial (regra A). */
const LIMIAR_ZERO = 0.01;

export const STATUS_CONCILIACAO = {
  CONCILIADO: "conciliado",
  SUSPEITO: "suspeito",
  NAO_CONCILIAVEL: "nao_conciliavel",
  NAO_APLICAVEL: "nao_aplicavel",
  SEM_DADO: "sem_dado",
};

export const MOTIVO_INCONSISTENCIA = {
  QUEDA_INESPERADA: "queda_inesperada", // regra A
  RESET_ZERAGEM: "reset_zeragem", // regra B
};

/**
 * Linhas elegíveis para a caminhada de um campo acumulado: só dias que
 * OPERARAM (mesmo filtro de `snapshotFinanceiroMaisRecente`) e nunca fatia de
 * "Lançamento Mensal" (uma fatia é uma DIVISÃO UNIFORME do total, não um
 * acumulado real — comparar fatias entre si não tem o significado que esta
 * caminhada pressupõe).
 */
function linhasElegiveis(linhas) {
  return (linhas ?? [])
    .filter((r) => situacaoOperou(r.situacao) && r.origem_lancamento !== "distribuicao_mensal")
    .slice()
    .sort((a, b) => (a.data_lancamento < b.data_lancamento ? -1 : a.data_lancamento > b.data_lancamento ? 1 : 0));
}

/**
 * Caminha TODO o mês (não só as duas pontas de um segmento) validando um
 * campo acumulado dia a dia contra o último ponto CONFIÁVEL conhecido — não
 * contra o dia de calendário imediatamente anterior. Isso é o que permite
 * "auto-curar": se o acumulado cair (ou zerar) e DEPOIS voltar a crescer
 * acima do último ponto confiável, os dias seguintes voltam a ser
 * 'conciliado' automaticamente — sem precisar de uma segunda regra.
 *
 * @param {Array<object>} linhas linhas CRUAS do mês (qualquer unidade — já vem filtrado por quem chama)
 * @param {string} coluna nome da coluna snake_case (ex.: "valor_vendas_ifood")
 * @returns {Map<string, {valor: number|null, status: string, motivo: string|null, ultimoValido: {valor:number,data:string}|null, detalhe: object|null}>}
 *   chave = data_lancamento. `ultimoValido` é o estado ANTES de processar aquele dia
 *   (para um dia 'conciliado' ele é igual ao próprio dia; para um dia
 *   suspeito/não-conciliável ele é o último ponto confiável ANTERIOR).
 */
export function caminharSequenciaAcumulada(linhas, coluna) {
  const porData = new Map();
  let ultimoValido = null; // {valor, data}
  for (const row of linhasElegiveis(linhas)) {
    const bruto = row[coluna];
    if (bruto == null) {
      porData.set(row.data_lancamento, { valor: null, status: STATUS_CONCILIACAO.SEM_DADO, motivo: null, ultimoValido, detalhe: null });
      continue;
    }
    const valor = Number(bruto);
    // Uma queda de até `LIMIAR_QUEDA_IGNORAVEL_REAIS` é tratada como ruído/
    // arredondamento (a mesma régua usada no aviso preventivo, ver
    // `avaliarQuedaAcumulado`) — nunca degrada o status do dia sozinha.
    if (ultimoValido == null || valor >= ultimoValido.valor - LIMIAR_QUEDA_IGNORAVEL_REAIS) {
      const novoUltimo = { valor, data: row.data_lancamento };
      porData.set(row.data_lancamento, { valor, status: STATUS_CONCILIACAO.CONCILIADO, motivo: null, ultimoValido: novoUltimo, detalhe: null });
      ultimoValido = novoUltimo;
      continue;
    }
    // Queda: NÃO atualiza `ultimoValido` — os próximos dias continuam sendo
    // comparados contra o último ponto CONFIÁVEL, nunca contra este dia ruim.
    const suspeito = Math.abs(valor) <= LIMIAR_ZERO && ultimoValido.valor > LIMIAR_ZERO;
    porData.set(row.data_lancamento, {
      valor, status: suspeito ? STATUS_CONCILIACAO.SUSPEITO : STATUS_CONCILIACAO.NAO_CONCILIAVEL,
      motivo: suspeito ? MOTIVO_INCONSISTENCIA.RESET_ZERAGEM : MOTIVO_INCONSISTENCIA.QUEDA_INESPERADA,
      ultimoValido,
      detalhe: { dataAnterior: ultimoValido.data, valorAnterior: ultimoValido.valor, valorNovo: valor },
    });
  }
  return porData;
}

/**
 * O ponto (linha + status da caminhada) que representa o campo NA DATA
 * (ou no último dia com dado antes dela) — mesma prioridade de
 * `snapshotFinanceiroMaisRecente`: o dia exato se existir, senão o mais
 * recente anterior. `null` se não há nenhuma linha até essa data.
 * @param {Map<string, object>} sequencia de `caminharSequenciaAcumulada`
 * @param {string} dataIso
 */
function pontoAte(sequencia, dataIso) {
  let melhor = null;
  for (const [data, ponto] of sequencia) {
    if (data > dataIso) continue;
    if (!melhor || data > melhor.data) melhor = { data, ...ponto };
  }
  return melhor;
}

/**
 * Reconcilia UM campo acumulado num segmento [inicio, fim] (inclusive),
 * contra o fim do segmento ANTERIOR — só o valor do fim já É o total quando
 * `ehPrimeiroSegmento` é `true` (não há nada antes dele em toda a linha do
 * tempo). Para qualquer OUTRO segmento, um ponto de corte anterior ausente
 * NUNCA vira "o valor do fim é o total" (isso atribuiria ao segmento tudo
 * que pode ter acontecido no(s) segmento(s) anterior(es), sem nenhuma
 * evidência) — vira SEM_DADO: não dá pra separar sem um ponto de referência.
 *
 * @param {Map<string, object>} sequencia de `caminharSequenciaAcumulada` (campo já escolhido)
 * @param {string} inicioIso @param {string} fimIso
 * @param {boolean} [ehPrimeiroSegmento=false] `true` só para o 1º segmento de TODA a linha do tempo consultada
 * @returns {{
 *   valorOficial: number|null,
 *   status: string,
 *   motivo: string|null,
 *   ultimoValorValido: {valor:number, data:string}|null,
 *   detalhe: object|null,
 * }}
 */
export function reconciliarCampoSegmento(sequencia, inicioIso, fimIso, ehPrimeiroSegmento = false) {
  const fim = pontoAte(sequencia, fimIso);
  if (!fim) return { valorOficial: null, status: STATUS_CONCILIACAO.SEM_DADO, motivo: null, ultimoValorValido: null, detalhe: null };

  const inicio = inicioIso ? pontoAte(sequencia, diaAnteriorIso(inicioIso)) : null;

  if (ehPrimeiroSegmento) {
    if (fim.status === STATUS_CONCILIACAO.CONCILIADO) {
      return { valorOficial: fim.valor, status: STATUS_CONCILIACAO.CONCILIADO, motivo: null, ultimoValorValido: { valor: fim.valor, data: fim.data }, detalhe: null };
    }
    return {
      valorOficial: null, status: fim.status, motivo: fim.motivo,
      ultimoValorValido: fim.ultimoValido, detalhe: fim.detalhe,
    };
  }

  // Não é o 1º segmento e não há NENHUM ponto de corte anterior — não dá pra
  // saber quanto pertence a este segmento e quanto pertence ao(s) anterior(es)
  // (o caso que originou a antiga "snapshot da véspera ausente"): SEM_DADO,
  // nunca "o valor do fim é o total".
  if (!inicio) return { valorOficial: null, status: STATUS_CONCILIACAO.SEM_DADO, motivo: null, ultimoValorValido: fim.ultimoValido, detalhe: null };

  // Os DOIS pontos de corte precisam estar conciliados para a subtração valer.
  if (fim.status !== STATUS_CONCILIACAO.CONCILIADO) {
    return {
      valorOficial: null, status: fim.status, motivo: fim.motivo,
      ultimoValorValido: fim.ultimoValido && inicio.status === STATUS_CONCILIACAO.CONCILIADO
        ? { valor: Math.max(0, fim.ultimoValido.valor - inicio.valor), data: fim.ultimoValido.data }
        : fim.ultimoValido,
      detalhe: fim.detalhe,
    };
  }
  if (inicio.status !== STATUS_CONCILIACAO.CONCILIADO) {
    // O ponto de corte do segmento ANTERIOR não é confiável — o início deste
    // segmento também não é, então o total dele herda a mesma incerteza.
    return {
      valorOficial: null, status: inicio.status, motivo: inicio.motivo,
      ultimoValorValido: inicio.ultimoValido ? { valor: Math.max(0, fim.valor - inicio.ultimoValido.valor), data: fim.data } : null,
      detalhe: { ...inicio.detalhe, dependeDoSegmentoAnterior: true },
    };
  }

  return {
    valorOficial: fim.valor - inicio.valor, status: STATUS_CONCILIACAO.CONCILIADO, motivo: null,
    ultimoValorValido: { valor: fim.valor - inicio.valor, data: fim.data }, detalhe: null,
  };
}

function diaAnteriorIso(iso) {
  const [a, m, d] = String(iso).split("-").map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d - 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** Pior status entre dois — usado para propagar indisponibilidade só pelas dependências reais. */
const ORDEM_GRAVIDADE = {
  [STATUS_CONCILIACAO.CONCILIADO]: 0,
  [STATUS_CONCILIACAO.SEM_DADO]: 1,
  [STATUS_CONCILIACAO.SUSPEITO]: 2,
  [STATUS_CONCILIACAO.NAO_CONCILIAVEL]: 3,
  [STATUS_CONCILIACAO.NAO_APLICAVEL]: -1, // nunca "pior" — é neutro, ver `piorStatus`
};
export function piorStatus(...status) {
  const relevantes = status.filter((s) => s && s !== STATUS_CONCILIACAO.NAO_APLICAVEL);
  if (!relevantes.length) return STATUS_CONCILIACAO.NAO_APLICAVEL;
  return relevantes.reduce((pior, s) => (ORDEM_GRAVIDADE[s] > ORDEM_GRAVIDADE[pior] ? s : pior));
}

// ---------------------------------------------------------------------------
// DIVERGÊNCIA ENTRE A DATA ADMINISTRATIVA DA TROCA E OS DADOS OPERACIONAIS
// ---------------------------------------------------------------------------

/**
 * Detecta se um campo que só existe num dos modelos (ex.: taxas_entregadores,
 * só Marketplace) parou de acumular ANTES da vigência administrativa
 * registrada — sinal de que a operação pode ter mudado na prática antes da
 * data cadastrada. NUNCA corrige a vigência sozinho: só sinaliza.
 *
 * Critério: primeiro dia (dentro do segmento onde o campo é aplicável) cujo
 * status na caminhada é 'suspeito' com motivo 'reset_zeragem' — e esse dia é
 * anterior à vigência em mais de `toleranciaDias`.
 *
 * @param {Map<string, object>} sequencia de `caminharSequenciaAcumulada` do campo
 * @param {string} vigenciaInicioIso data em que o modelo NOVO passou a valer
 * @param {string} fimSegmentoAnteriorIso véspera da vigência (fim do segmento onde o campo ainda é aplicável)
 * @param {number} [toleranciaDias=1]
 * @returns {{divergente: boolean, dataMudancaOperacional: string|null, diasDeDivergencia: number|null}}
 */
export function detectarDivergenciaTransicao(sequencia, vigenciaInicioIso, fimSegmentoAnteriorIso, toleranciaDias = 1) {
  let primeiroReset = null;
  for (const [data, ponto] of sequencia) {
    if (data > fimSegmentoAnteriorIso) continue;
    if (ponto.status === STATUS_CONCILIACAO.SUSPEITO && ponto.motivo === MOTIVO_INCONSISTENCIA.RESET_ZERAGEM) {
      if (!primeiroReset || data < primeiroReset) primeiroReset = data;
    }
  }
  if (!primeiroReset) return { divergente: false, dataMudancaOperacional: null, diasDeDivergencia: null };
  const dias = Math.round((Date.parse(`${vigenciaInicioIso}T00:00:00Z`) - Date.parse(`${primeiroReset}T00:00:00Z`)) / 86400000);
  if (dias <= toleranciaDias) return { divergente: false, dataMudancaOperacional: primeiroReset, diasDeDivergencia: dias };
  return { divergente: true, dataMudancaOperacional: primeiroReset, diasDeDivergencia: dias };
}

// ---------------------------------------------------------------------------
// VALIDAÇÃO PREVENTIVA NO LANÇAMENTO (item E do pedido)
// ---------------------------------------------------------------------------

/**
 * Último ponto CONCILIADO conhecido de um campo acumulado, estritamente
 * antes de uma data — usado no formulário para avisar ANTES de salvar
 * ("o último Financeiro Oficial possui R$X e você informou R$Y"). Mesmo
 * espírito de `ultimoDesempenhoConhecido` (calc.js), mas usando a caminhada
 * (não pega cegamente "o dia de calendário anterior" — pega o último ponto
 * que de fato passou pelas validações).
 * @param {Array<object>} linhasDoMes @param {string} coluna @param {string} antesDeDataIso
 * @returns {{valor:number, data:string}|null}
 */
export function ultimoValorConciliadoAntesDe(linhasDoMes, coluna, antesDeDataIso) {
  const sequencia = caminharSequenciaAcumulada(linhasDoMes, coluna);
  const anterior = diaAnteriorIso(antesDeDataIso);
  const ponto = pontoAte(sequencia, anterior);
  if (!ponto) return null;
  return ponto.status === STATUS_CONCILIACAO.CONCILIADO ? { valor: ponto.valor, data: ponto.data } : (ponto.ultimoValido ?? null);
}

/**
 * Avalia se um NOVO valor de campo acumulado representa uma queda em relação
 * ao último ponto conhecido — a checagem PREVENTIVA (roda antes de salvar).
 * `null` quando não há o que avaliar (sem ponto anterior, ou sem queda real —
 * arredondamento abaixo de `LIMIAR_QUEDA_IGNORAVEL_REAIS` não conta).
 *
 * `nivel`:
 *   'leve'     — queda pequena (< LIMIAR_QUEDA_MATERIAL_REAIS): vira aviso comum
 *                (mesmo mecanismo de `inconsistencias()` + `confirmarAvisos`).
 *   'material' — queda relevante: exige confirmação REFORÇADA (flag própria +
 *                justificativa por escrito), nunca só um checkbox genérico.
 *
 * @param {{campo: string, rotulo: string, valorNovo: number, ultimoConhecido: {valor:number, data:string}|null}} p
 */
export function avaliarQuedaAcumulado({ campo, rotulo, valorNovo, ultimoConhecido }) {
  if (!ultimoConhecido || valorNovo == null) return null;
  const diferenca = Number(valorNovo) - ultimoConhecido.valor;
  if (diferenca >= -LIMIAR_QUEDA_IGNORAVEL_REAIS) return null;
  const nivel = Math.abs(diferenca) > LIMIAR_QUEDA_MATERIAL_REAIS ? "material" : "leve";
  const fmtR = (v) => `R$ ${Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return {
    campo, nivel, diferenca,
    valorAnterior: ultimoConhecido.valor, dataAnterior: ultimoConhecido.data, valorNovo: Number(valorNovo),
    mensagem: `Valor menor que o acumulado anterior em ${rotulo}. O último Financeiro Oficial possui ${fmtR(ultimoConhecido.valor)} `
      + `(em ${ultimoConhecido.data.split("-").reverse().join("/")}) e você informou ${fmtR(valorNovo)}. Verifique se o valor foi preenchido corretamente.`,
  };
}

/**
 * Sinal (nunca bloqueio isolado) de que `valor_vendas_ifood` foi preenchido
 * igual a `valor_vendas_bruto` — combinado com o histórico da PRÓPRIA
 * unidade no mês (nunca uma regra absoluta: unidades pequenas podem ter os
 * dois valores próximos legitimamente). Só dispara quando os dias anteriores
 * do mês mostram consistentemente iFood > bruto por uma margem — e o dia
 * novo quebra esse padrão ficando exatamente igual.
 * `dataAtualIso` exclui o próprio dia sendo avaliado do histórico usado para
 * estabelecer o padrão — senão um dia igual/duplicado "provaria" a si mesmo.
 * @param {{valorVendasIfood: number|null, valorVendasBruto: number|null, linhasDoMes: Array<object>, dataAtualIso?: string}} p
 * @returns {string|null}
 */
export function avisoIgualdadeSuspeitaComBruto({ valorVendasIfood, valorVendasBruto, linhasDoMes, dataAtualIso = null }) {
  if (valorVendasIfood == null || valorVendasBruto == null) return null;
  if (Math.abs(Number(valorVendasIfood) - Number(valorVendasBruto)) > TOLERANCIA_RECONCILIACAO) return null;
  const anteriores = linhasElegiveis(linhasDoMes)
    .filter((r) => r.data_lancamento !== dataAtualIso && r.valor_vendas_ifood != null && r.valor_vendas_bruto != null)
    .map((r) => Number(r.valor_vendas_ifood) - Number(r.valor_vendas_bruto));
  if (anteriores.length < 2) return null; // amostra pequena demais pra falar em "padrão"
  const margemMinima = Math.min(...anteriores);
  if (margemMinima <= TOLERANCIA_RECONCILIACAO) return null; // o padrão da própria unidade já inclui dias iguais/próximos — não é anomalia
  return "O valor do Financeiro Oficial (iFood) ficou igual ao valor bruto informado — isso é incomum nesta unidade "
    + "(nos demais dias do mês o iFood ficou acima do bruto). Verifique se os campos não foram trocados ou duplicados.";
}
