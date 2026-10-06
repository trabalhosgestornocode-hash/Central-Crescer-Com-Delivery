// Dashboard iFood — lançamento por MÚLTIPLOS CANAIS de uma mesma unidade
// (ex.: Sanduíches + Saladas). Funções PURAS (sem I/O): normalização da
// entrada por canal e consolidação na linha da unidade.
//
// Modelo (migration 108): `lancamentos_financeiros_diarios` continua sendo o
// CONSOLIDADO DA UNIDADE — todos os consumidores atuais leem só ele. Os
// valores de cada canal ficam em `lancamentos_financeiros_canais`, com os
// MESMOS nomes de coluna. Todos os valores são ACUMULADOS DO MÊS até a data
// (mesma lógica do lançamento padrão, ver calc.js#listaDesempenhoDiario e
// #snapshotFinanceiroMaisRecente).
//
// Regras centrais:
//   * Somáveis entre canais: pedidos, valor bruto, novos clientes, financeiro
//     oficial, taxas e comissões, serviços e promoções, ajustes a favor/contra
//     (e taxas de entregadores quando o escopo da unidade é "canal").
//   * Taxa de entregadores COMPARTILHADA (escopo "unidade") é informada UMA
//     vez e nunca somada por canal.
//   * Derivados (ticket médio, percentuais, deduções, receita) são sempre
//     recalculados sobre o consolidado — nunca média de canais.
//   * "Não informado" (null) nunca vira 0: um consolidado com qualquer canal
//     desconhecido naquele campo é desconhecido (null), não uma soma parcial —
//     uma soma parcial de acumulados inventaria uma queda no dia seguinte.

import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import {
  situacaoOperou, ticketMedio, percentual, totalDeducoes, receitaLiquida,
  ultimoDesempenhoConhecido, snapshotFinanceiroMaisRecente, desempenhoParaTicketMedio,
} from "./dashboardExecutivo.calc.js";
import { avaliarQuedaAcumulado, ultimoValorConciliadoAntesDe } from "./dashboardExecutivo.confiabilidade.js";

export const ESTRUTURA = Object.freeze({ PADRAO: "padrao", MULTICANAL: "multicanal" });
/**
 * Produto (Checkpoint F): a única modalidade multicanal oferecida é
 * "Sanduíches + Saladas" — as duas fontes de venda de UMA unidade, somadas
 * no consolidado. Os nomes são criados pelo sistema quando o SuperAdmin liga
 * a opção na unidade (nunca detectados pelo nome da empresa/unidade). A
 * estrutura interna continua genérica (tabelas de canais da migration 108).
 */
export const CANAIS_SANDUICHES_SALADAS = Object.freeze(["Sanduíches", "Saladas"]);
export const ESCOPO_ENTREGADORES = Object.freeze({ UNIDADE: "unidade", CANAL: "canal" });
export const SITUACAO_CANAL = Object.freeze({
  COM_VENDAS: "com_vendas", SEM_VENDAS: "sem_vendas", NAO_INFORMADO: "nao_informado",
});
const SITUACOES_CANAL = Object.values(SITUACAO_CANAL);

// [chave da API, coluna do banco] — mesma ordem/nomes da linha consolidada.
const CAMPOS_DESEMPENHO = [
  ["qtdVendas", "qtd_vendas"], ["valorVendasBruto", "valor_vendas_bruto"], ["novosClientes", "novos_clientes"],
];
const CAMPOS_FINANCEIRO = [
  ["valorVendasIfood", "valor_vendas_ifood"], ["taxasComissoes", "taxas_comissoes"],
  ["servicosPromocoes", "servicos_promocoes"], ["taxasEntregadores", "taxas_entregadores"],
  ["ajustesFavorLoja", "ajustes_favor_loja"], ["ajustesContraLoja", "ajustes_contra_loja"],
];
const CAMPOS_INTEIROS = new Set(["qtdVendas", "novosClientes"]);
// Ajustes são exceção, não regra: `null` num canal que FOI informado = "não
// houve ajuste" (mesma semântica de normalizarDadosLancamento/receitaLiquida).
const CAMPOS_AJUSTE = new Set(["ajustesFavorLoja", "ajustesContraLoja"]);

const ROTULO = {
  qtdVendas: "Quantidade de vendas", valorVendasBruto: "Valor bruto das vendas", novosClientes: "Novos clientes",
  valorVendasIfood: "Valor das vendas (iFood)", taxasComissoes: "Taxas e comissões",
  servicosPromocoes: "Serviços e promoções", taxasEntregadores: "Taxas de entregadores",
  ajustesFavorLoja: "Ajustes a favor da loja", ajustesContraLoja: "Ajustes contra a loja",
};

const vazio = (x) => x === undefined || x === null || x === "";

// ---------------------------------------------------------------------------
// ESTRUTURA
// ---------------------------------------------------------------------------

/**
 * Estrutura configurada da unidade. Sem linha de configuração = padrão (o
 * comportamento de sempre) — nenhuma unidade vira multicanal "por baixo".
 * @param {{estrutura?: string}|null|undefined} config — linha crua de dashboard_ifood_unidade_config
 */
export function estruturaDaUnidade(config) {
  return config?.estrutura === ESTRUTURA.MULTICANAL ? ESTRUTURA.MULTICANAL : ESTRUTURA.PADRAO;
}

/** @param {{taxas_entregadores_escopo?: string}|null|undefined} config */
export function escopoEntregadoresDaUnidade(config) {
  return config?.taxas_entregadores_escopo === ESCOPO_ENTREGADORES.CANAL ? ESCOPO_ENTREGADORES.CANAL : ESCOPO_ENTREGADORES.UNIDADE;
}

/**
 * Estrutura com que o formulário de UM DIA abre. Um dia já lançado abre
 * SEMPRE na estrutura com que foi criado (`estrutura_lancamento`, imutável no
 * banco) — mudar a configuração da unidade depois nunca reinterpreta o
 * histórico. Só um dia ainda sem lançamento segue a configuração atual.
 * @param {{lancamento?: {estrutura_lancamento?: string}|null, config?: object|null}} p
 */
export function estruturaDoDia({ lancamento, config }) {
  if (lancamento) return lancamento.estrutura_lancamento === ESTRUTURA.MULTICANAL ? ESTRUTURA.MULTICANAL : ESTRUTURA.PADRAO;
  return estruturaDaUnidade(config);
}

/**
 * Canais que participam do lançamento de um mês: os ATIVOS e também os
 * inativos que já têm valor lançado NAQUELE mês. Sem isso, desativar um canal
 * no meio do mês tiraria o acumulado dele da soma e o consolidado "cairia"
 * do nada. Ordem estável: `ordem`, depois nome.
 * @param {Array<{id: string, nome: string, ordem?: number, ativo?: boolean}>} canais
 * @param {Set<string>|Iterable<string>} [idsComValorNoMes]
 */
export function canaisParticipantes(canais, idsComValorNoMes = []) {
  const comValor = idsComValorNoMes instanceof Set ? idsComValorNoMes : new Set(idsComValorNoMes);
  return (canais ?? [])
    .filter((c) => c.ativo !== false || comValor.has(c.id))
    .slice()
    .sort((a, b) => (Number(a.ordem ?? 0) - Number(b.ordem ?? 0)) || String(a.nome).localeCompare(String(b.nome), "pt-BR"));
}

// ---------------------------------------------------------------------------
// ACUMULADO ANTERIOR POR CANAL
// ---------------------------------------------------------------------------

/**
 * Junta cada valor por canal à data/situação/origem do seu dia consolidado —
 * formato que as funções de calc.js já entendem (mesmos nomes de coluna).
 * @param {Array<{id: string, data_lancamento: string, situacao: string, origem_lancamento?: string}>} linhasDoMes
 * @param {Array<{lancamento_id: string, canal_id: string}>} linhasCanaisDoMes
 */
export function linhasDoCanalComData(linhasDoMes, linhasCanaisDoMes) {
  const dia = new Map((linhasDoMes ?? []).map((r) => [r.id, r]));
  const porCanal = new Map();
  for (const f of linhasCanaisDoMes ?? []) {
    const pai = dia.get(f.lancamento_id);
    if (!pai) continue;
    const linha = { ...f, data_lancamento: pai.data_lancamento, situacao: pai.situacao, origem_lancamento: pai.origem_lancamento ?? "diario" };
    if (!porCanal.has(f.canal_id)) porCanal.set(f.canal_id, []);
    porCanal.get(f.canal_id).push(linha);
  }
  return porCanal;
}

/**
 * Último acumulado de DESEMPENHO conhecido de cada canal antes de uma data
 * (mesmo mês) — usado quando o canal está "Sem vendas" (repete o acumulado:
 * delta do dia = 0, nunca grava 0 literal no acumulado).
 *
 * `conhecido=false` quando o acumulado do canal NÃO pode ser deduzido: o
 * canal não tem valor próprio antes da data E o mês já tem dia lançado no
 * modo padrão antes dela (unidade que virou multicanal no meio do mês — o
 * que cada canal vendeu nos dias padrão está só no consolidado). Nesse caso
 * o desempenho do canal fica "não informado", nunca um 0 inventado. Sem
 * nenhum dia padrão antes, o canal realmente começa o mês do zero.
 * @param {{linhasDoMes: object[], linhasCanaisDoMes: object[], antesDeDataIso: string, canalIds: string[]}} p
 * @returns {Map<string, {conhecido: boolean, qtdVendas: number|null, valorVendasBruto: number|null, novosClientes: number|null}>}
 */
export function desempenhoAnteriorPorCanal({ linhasDoMes, linhasCanaisDoMes, antesDeDataIso, canalIds }) {
  const mesAlvo = antesDeDataIso.slice(0, 7);
  const haDiaPadraoAntes = (linhasDoMes ?? []).some((r) =>
    r.data_lancamento < antesDeDataIso && r.data_lancamento.slice(0, 7) === mesAlvo
    && (r.estrutura_lancamento ?? ESTRUTURA.PADRAO) === ESTRUTURA.PADRAO);
  const porCanal = linhasDoCanalComData(linhasDoMes, linhasCanaisDoMes);
  const resultado = new Map();
  for (const canalId of canalIds ?? []) {
    const linhas = (porCanal.get(canalId) ?? []).filter((r) => r.data_lancamento < antesDeDataIso && r.data_lancamento.slice(0, 7) === mesAlvo);
    const conhecido = linhas.length > 0 || !haDiaPadraoAntes;
    resultado.set(canalId, conhecido
      ? { conhecido, ...ultimoDesempenhoConhecido(linhas, antesDeDataIso) }
      : { conhecido, qtdVendas: null, valorVendasBruto: null, novosClientes: null });
  }
  return resultado;
}

/**
 * Último snapshot FINANCEIRO de cada canal no mês (antes da data) — só para
 * PRÉ-PREENCHER o formulário de um canal "Sem vendas" num dia com Financeiro:
 * o extrato do iFood continua tendo acumulado do mês mesmo sem venda no dia,
 * então o valor é sempre conferido/informado pelo usuário, nunca gravado
 * sozinho. Mesmas regras de `snapshotFinanceiroMaisRecente` (só dias que
 * operaram, nunca fatia de lançamento mensal).
 * @returns {Map<string, object|null>}
 */
export function snapshotFinanceiroAnteriorPorCanal({ linhasDoMes, linhasCanaisDoMes, antesDeDataIso, canalIds }) {
  const porCanal = linhasDoCanalComData(linhasDoMes, linhasCanaisDoMes);
  const resultado = new Map();
  for (const canalId of canalIds ?? []) {
    const linhas = (porCanal.get(canalId) ?? []).filter((r) => r.data_lancamento < antesDeDataIso);
    const snap = snapshotFinanceiroMaisRecente(linhas.filter((r) => r.origem_lancamento !== "distribuicao_mensal"));
    resultado.set(canalId, snap ?? null);
  }
  return resultado;
}

// ---------------------------------------------------------------------------
// NORMALIZAÇÃO DA ENTRADA POR CANAL
// ---------------------------------------------------------------------------

/**
 * Valida e normaliza `body.canais` de um dia multicanal. Autoridade é sempre
 * o servidor: o cliente nunca manda o consolidado.
 *
 * Regras:
 *  - Todo canal participante aparece exatamente uma vez; canal desconhecido
 *    (inclusive de outra unidade) é recusado.
 *  - Unidade "Sem operação"/"Zero vendas": a pergunta por canal não existe —
 *    todo canal vira "sem_vendas", desempenho repete o acumulado do canal e o
 *    financeiro é o 0 sintético (espelha a linha consolidada desses dias).
 *  - "com_vendas": desempenho opcional (vazio = não informado); financeiro
 *    exigido só ao FINALIZAR num dia elegível (`exigirFinanceiro`).
 *  - "sem_vendas": desempenho = acumulado anterior do canal (ignora o que
 *    veio); financeiro com a MESMA regra de "com_vendas" — o extrato do mês
 *    continua existindo, nunca vira 0.
 *  - "nao_informado": todos os valores null. Num dia com Financeiro
 *    elegível, impede FINALIZAR (rascunho continua permitido).
 *  - Taxa de entregadores por canal só no escopo "canal"; no escopo
 *    "unidade" mandar valor no canal é recusado (seria contado duas vezes).
 *
 * @param {unknown} canaisBody
 * @param {{
 *   participantes: Array<{id: string, nome: string}>,
 *   situacaoUnidade: string, statusAlvo: "rascunho"|"finalizado", exigirFinanceiro: boolean,
 *   escopoEntregadores: "unidade"|"canal", entregadoresAplicavel?: boolean,
 *   desempenhoAnterior?: Map<string, {qtdVendas: number|null, valorVendasBruto: number|null, novosClientes: number|null}>,
 * }} ctx
 * @returns {Array<{canalId: string, nome: string, situacaoCanal: string} & Record<string, number|null>>}
 */
export function normalizarCanais(canaisBody, ctx) {
  const {
    participantes, situacaoUnidade, statusAlvo, exigirFinanceiro, escopoEntregadores,
    entregadoresAplicavel = true, desempenhoAnterior = new Map(),
  } = ctx;
  if (!participantes?.length) throw ApiError.badRequest("Esta unidade não tem canais configurados para o lançamento.");

  const anteriorDe = (canalId) => desempenhoAnterior.get(canalId) ?? { qtdVendas: null, valorVendasBruto: null, novosClientes: null };
  const desempenhoRepetido = (canalId) => {
    const a = anteriorDe(canalId);
    return { qtdVendas: a.qtdVendas ?? null, valorVendasBruto: a.valorVendasBruto ?? null, novosClientes: a.novosClientes ?? null };
  };
  const entregadoresPorCanal = escopoEntregadores === ESCOPO_ENTREGADORES.CANAL;

  // Unidade sem operação/zero vendas: não existe pergunta por canal — o que
  // vier no corpo é ignorado e cada canal espelha a linha consolidada.
  if (!situacaoOperou(situacaoUnidade)) {
    return participantes.map((canal) => ({
      canalId: canal.id, nome: canal.nome, situacaoCanal: SITUACAO_CANAL.SEM_VENDAS, ...desempenhoRepetido(canal.id),
      valorVendasIfood: 0, taxasComissoes: 0, servicosPromocoes: 0,
      taxasEntregadores: entregadoresPorCanal ? 0 : null, ajustesFavorLoja: 0, ajustesContraLoja: 0,
    }));
  }

  const recebidos = Array.isArray(canaisBody) ? canaisBody : null;
  if (!recebidos) throw ApiError.badRequest("Informe os valores de cada canal.");

  const porId = new Map(participantes.map((c) => [c.id, c]));
  const vistos = new Map();
  for (const item of recebidos) {
    const corpo = v.corpo(item);
    const canalId = v.uuid(corpo.canalId, "Canal");
    if (!porId.has(canalId)) throw ApiError.badRequest("Canal não pertence a esta unidade ou não participa deste lançamento.");
    if (vistos.has(canalId)) throw ApiError.badRequest(`Canal "${porId.get(canalId).nome}" informado mais de uma vez.`);
    vistos.set(canalId, corpo);
  }
  const faltando = participantes.filter((c) => !vistos.has(c.id));
  if (faltando.length) throw ApiError.badRequest(`Informe a situação do canal ${faltando.map((c) => `"${c.nome}"`).join(", ")}.`);

  const exigir = exigirFinanceiro && statusAlvo === "finalizado";

  return participantes.map((canal) => {
    const b = vistos.get(canal.id);
    const base = { canalId: canal.id, nome: canal.nome };

    const situacaoCanal = v.umDe(b.situacaoCanal, `Situação do canal "${canal.nome}"`, SITUACOES_CANAL);
    if (situacaoCanal === SITUACAO_CANAL.NAO_INFORMADO) {
      if (exigir) {
        throw ApiError.badRequest(
          `O canal "${canal.nome}" está como "Não informado". Neste dia o Financeiro consolidado da unidade precisa de todos os canais — informe os valores (ou marque "Sem vendas") ou salve como rascunho.`,
          { canalId: canal.id, canalNaoInformado: true },
        );
      }
      return {
        ...base, situacaoCanal,
        ...Object.fromEntries([...CAMPOS_DESEMPENHO, ...CAMPOS_FINANCEIRO].map(([chave]) => [chave, null])),
      };
    }

    const rotulo = (chave) => `${canal.nome}: ${ROTULO[chave]}`;
    const opcional = (chave) => {
      const n = v.numeroOpcionalNulo(b[chave], rotulo(chave), { min: 0, max: 1e9 });
      return n != null && CAMPOS_INTEIROS.has(chave) ? Math.trunc(n) : n;
    };
    const financeiro = (chave) => (exigir ? v.numero(b[chave], rotulo(chave), { min: 0, max: 1e9 }) : opcional(chave));

    const desempenho = situacaoCanal === SITUACAO_CANAL.SEM_VENDAS
      ? desempenhoRepetido(canal.id)
      : { qtdVendas: opcional("qtdVendas"), valorVendasBruto: opcional("valorVendasBruto"), novosClientes: opcional("novosClientes") };

    let taxasEntregadores = null;
    if (entregadoresPorCanal) {
      taxasEntregadores = entregadoresAplicavel ? financeiro("taxasEntregadores") : opcional("taxasEntregadores");
    } else if (!vazio(b.taxasEntregadores)) {
      throw ApiError.badRequest(`Taxas de entregadores são compartilhadas pela unidade — informe uma vez só, fora do canal "${canal.nome}".`);
    }

    return {
      ...base, situacaoCanal, ...desempenho,
      valorVendasIfood: financeiro("valorVendasIfood"),
      taxasComissoes: financeiro("taxasComissoes"),
      servicosPromocoes: financeiro("servicosPromocoes"),
      taxasEntregadores,
      ajustesFavorLoja: opcional("ajustesFavorLoja"),
      ajustesContraLoja: opcional("ajustesContraLoja"),
    };
  });
}

// ---------------------------------------------------------------------------
// CONSOLIDAÇÃO
// ---------------------------------------------------------------------------

/** Soma em centavos (sem resíduo de ponto flutuante); inteiros somam direto. */
function somar(valores, inteiro) {
  if (inteiro) return valores.reduce((s, x) => s + Number(x), 0);
  return valores.reduce((s, x) => s + Math.round(Number(x) * 100), 0) / 100;
}

/**
 * Consolida os canais normalizados na linha da unidade (mesmas chaves que
 * `normalizarDadosLancamento` consome).
 *  - Campos estritos (desempenho, financeiro oficial, taxas, serviços,
 *    entregadores por canal): soma; null se QUALQUER canal for null.
 *  - Ajustes: null se algum canal estiver "não informado"; senão soma dos
 *    conhecidos (null = sem ajuste), null só se todos forem null.
 *  - Taxa de entregadores no escopo "unidade": o valor compartilhado, uma
 *    vez só — nunca somado aos canais.
 * @param {ReturnType<typeof normalizarCanais>} canais
 * @param {{escopoEntregadores: "unidade"|"canal", taxasEntregadoresUnidade?: number|null}} opts
 */
export function consolidarCanais(canais, { escopoEntregadores, taxasEntregadoresUnidade = null }) {
  const lista = canais ?? [];
  const algumNaoInformado = lista.some((c) => c.situacaoCanal === SITUACAO_CANAL.NAO_INFORMADO);
  const estrito = (chave) => {
    if (!lista.length || lista.some((c) => c[chave] == null)) return null;
    return somar(lista.map((c) => c[chave]), CAMPOS_INTEIROS.has(chave));
  };
  const ajuste = (chave) => {
    if (algumNaoInformado) return null;
    const conhecidos = lista.map((c) => c[chave]).filter((x) => x != null);
    return conhecidos.length ? somar(conhecidos, false) : null;
  };
  const consolidado = {};
  for (const [chave] of [...CAMPOS_DESEMPENHO, ...CAMPOS_FINANCEIRO]) {
    consolidado[chave] = CAMPOS_AJUSTE.has(chave) ? ajuste(chave) : estrito(chave);
  }
  consolidado.taxasEntregadores = escopoEntregadores === ESCOPO_ENTREGADORES.CANAL
    ? estrito("taxasEntregadores")
    : (taxasEntregadoresUnidade == null ? null : Number(taxasEntregadoresUnidade));
  return consolidado;
}

/**
 * Corpo do lançamento CONSOLIDADO para `normalizarDadosLancamento` — os
 * valores da unidade vêm SEMPRE da soma dos canais (nunca do cliente), e as
 * validações existentes (inconsistências, queda de acumulado, exigência de
 * Financeiro) passam a valer sobre o consolidado exatamente como hoje.
 * @param {object} body — corpo original (situação, status, observação, confirmações…)
 * @param {ReturnType<typeof consolidarCanais>} consolidado
 */
export function corpoConsolidado(body, consolidado) {
  const { canais: _canais, ...resto } = body ?? {};
  const valores = Object.fromEntries(Object.entries(consolidado).map(([k, x]) => [k, x == null ? undefined : x]));
  return { ...resto, ...valores };
}

/**
 * Derivados do consolidado — recalculados sobre as SOMAS, nunca média de
 * canais. Ex.: ticket = Σ valor bruto ÷ Σ pedidos.
 * @param {ReturnType<typeof consolidarCanais>} c
 */
export function resumoConsolidado(c) {
  const totalDed = totalDeducoes({
    taxasComissoes: c.taxasComissoes, servicosPromocoes: c.servicosPromocoes,
    taxasEntregadores: c.taxasEntregadores, ajustesContraLoja: c.ajustesContraLoja,
  });
  const base = c.valorVendasIfood;
  const receita = base == null ? null : receitaLiquida(base, totalDed, c.ajustesFavorLoja);
  return {
    ticketMedio: ticketMedio(c.valorVendasBruto, c.qtdVendas),
    totalDeducoes: totalDed,
    receitaLiquida: receita,
    percentuais: {
      taxasComissoes: percentual(c.taxasComissoes, base),
      servicosPromocoes: percentual(c.servicosPromocoes, base),
      taxasEntregadores: percentual(c.taxasEntregadores, base),
      totalDeducoes: percentual(totalDed, base),
      receitaLiquida: percentual(receita, base),
    },
  };
}

/**
 * Linhas snake_case de `lancamentos_financeiros_canais` para a função
 * atômica `dashboard_ifood_salvar_lancamento_multicanal` (migration 108).
 * @param {ReturnType<typeof normalizarCanais>} canais
 */
export function linhasCanaisParaGravacao(canais) {
  return (canais ?? []).map((c) => {
    const linha = { canal_id: c.canalId, situacao_canal: c.situacaoCanal };
    for (const [chave, coluna] of [...CAMPOS_DESEMPENHO, ...CAMPOS_FINANCEIRO]) linha[coluna] = c[chave] ?? null;
    return linha;
  });
}

// ---------------------------------------------------------------------------
// CHECKPOINT D — apoio ao lançamento multicanal no service
// ---------------------------------------------------------------------------

const COLUNAS_VALOR_CANAL = [...CAMPOS_DESEMPENHO, ...CAMPOS_FINANCEIRO];
const numOuNulo = (x) => (x == null ? null : Number(x));

/** Linha crua de `lancamentos_financeiros_canais` -> formato da API (camelCase). */
export function valorCanalParaApi(f) {
  const r = { canalId: f.canal_id, situacaoCanal: f.situacao_canal };
  for (const [chave, coluna] of COLUNAS_VALOR_CANAL) r[chave] = numOuNulo(f[coluna]);
  return r;
}

/**
 * Escopo da taxa de entregadores DE UM DIA multicanal já lançado — gravado no
 * próprio dia (`escopo_entregadores_lancamento`, imutável). Um dia novo usa a
 * configuração atual da unidade. Nunca reinterpreta o histórico.
 */
export function escopoEntregadoresDoDia({ lancamento, config }) {
  if (lancamento) return lancamento.escopo_entregadores_lancamento === ESCOPO_ENTREGADORES.CANAL ? ESCOPO_ENTREGADORES.CANAL : ESCOPO_ENTREGADORES.UNIDADE;
  return escopoEntregadoresDaUnidade(config);
}

/**
 * Validação PREVENTIVA de queda de acumulado POR CANAL — a mesma régua de
 * `avaliarQuedaAcumulado` (confiabilidade.js) usada no consolidado, aplicada
 * à série de cada canal. O `campo` vira `canal:<id>:<campo>` (rastro de
 * auditoria) e a mensagem ganha o nome do canal. Só os campos financeiros
 * acumulados do consolidado; entregadores só no escopo "canal".
 * @param {{canais: object[], linhasDoMes: object[], linhasCanaisDoMes: object[], dataIso: string, escopoEntregadores: string, entregadoresAplicavel: boolean}} p
 */
export function quedasPorCanal({ canais, linhasDoMes, linhasCanaisDoMes, dataIso, escopoEntregadores, entregadoresAplicavel }) {
  const porCanal = linhasDoCanalComData(linhasDoMes, linhasCanaisDoMes);
  const campos = [
    ["valorVendasIfood", "valor_vendas_ifood"], ["taxasComissoes", "taxas_comissoes"], ["servicosPromocoes", "servicos_promocoes"],
    ...(escopoEntregadores === ESCOPO_ENTREGADORES.CANAL && entregadoresAplicavel ? [["taxasEntregadores", "taxas_entregadores"]] : []),
  ];
  const sinais = [];
  for (const c of canais ?? []) {
    if (c.situacaoCanal === SITUACAO_CANAL.NAO_INFORMADO) continue;
    const linhas = (porCanal.get(c.canalId) ?? []).filter((r) => r.data_lancamento < dataIso);
    for (const [chave, coluna] of campos) {
      const sinal = avaliarQuedaAcumulado({
        campo: chave, rotulo: `${ROTULO[chave]} (${c.nome})`, valorNovo: c[chave],
        ultimoConhecido: ultimoValorConciliadoAntesDe(linhas, coluna, dataIso),
      });
      if (sinal) sinais.push({ ...sinal, campo: `canal:${c.canalId}:${chave}`, canalId: c.canalId, canal: c.nome });
    }
  }
  return sinais;
}

/**
 * Alterações por canal entre o que está gravado e o que vai ser gravado —
 * uma entrada por (canal, campo) que de fato mudou. Alimenta a auditoria
 * (`campo = canal:<id>:<coluna>`) e a regra de "correção" de um dia
 * finalizado (`exigeCorrecao`: mudou um valor que JÁ existia — completar um
 * campo vazio não é correção, mesma regra de `precisaCorrecao` no service).
 * @param {object[]} antes  linhas cruas do dia (snake_case)
 * @param {object[]} depois linhas a gravar (snake_case, de linhasCanaisParaGravacao)
 */
export function diffCanais(antes, depois) {
  const porCanal = new Map((antes ?? []).map((f) => [f.canal_id, f]));
  const mudancas = [];
  for (const d of depois ?? []) {
    const a = porCanal.get(d.canal_id) ?? {};
    for (const coluna of ["situacao_canal", ...COLUNAS_VALOR_CANAL.map(([, col]) => col)]) {
      const de = a[coluna] ?? null;
      const para = d[coluna] ?? null;
      const igual = de == null || para == null ? de === para : (coluna === "situacao_canal" ? de === para : Number(de) === Number(para));
      if (!igual) mudancas.push({ canalId: d.canal_id, coluna, anterior: de, novo: para, exigeCorrecao: de != null });
    }
  }
  return mudancas;
}

/**
 * Etapa em que um rascunho multicanal deve reabrir — a primeira com algo
 * OBRIGATÓRIO faltando (Desempenho é opcional, nunca é o alvo). Mesmo papel
 * de `primeiroPassoIncompletoIndex` no formulário padrão.
 * @returns {"situacao"|"financeiro"|"conferencia"}
 */
export function etapaIncompletaMulticanal({ situacao, motivoSemOperacao, mostrarFinanceiro, canais, taxasEntregadoresUnidade = null, escopoEntregadores, entregadoresAplicavel = true }) {
  if (!situacao) return "situacao";
  if (situacao === "sem_operacao" && !motivoSemOperacao) return "situacao";
  if (!situacaoOperou(situacao)) return "conferencia";
  if (!canais?.length || canais.some((c) => !c.situacaoCanal)) return "situacao";
  if (mostrarFinanceiro) {
    const faltaCanal = canais.some((c) => c.situacaoCanal === SITUACAO_CANAL.NAO_INFORMADO
      || c.valorVendasIfood == null || c.taxasComissoes == null || c.servicosPromocoes == null
      || (escopoEntregadores === ESCOPO_ENTREGADORES.CANAL && entregadoresAplicavel && c.taxasEntregadores == null));
    const faltaCompartilhado = escopoEntregadores !== ESCOPO_ENTREGADORES.CANAL && entregadoresAplicavel && taxasEntregadoresUnidade == null;
    if (faltaCanal || faltaCompartilhado) return "financeiro";
  }
  return "conferencia";
}

/**
 * Composição POR CANAL do mês para a Visão Geral (campo opcional
 * `composicaoCanais` do GET /mes). Usa exatamente os MESMOS dias que os
 * cards consolidados já usam — o snapshot financeiro mais recente e o par de
 * Desempenho do ticket médio (calc.js) — e decompõe esses dias pelos canais
 * gravados neles. Por construção a soma dos canais é o card consolidado.
 *
 * Indisponível (com motivo) quando o dia de referência não tem composição:
 * foi lançado no modo padrão, é fatia de lançamento mensal, ou não há dado.
 * Participação = valor do canal ÷ total do dia (nunca média de canais).
 */
export function composicaoCanaisDoMes({ linhasDoMes, linhasCanaisDoMes, canais }) {
  const porId = new Map((canais ?? []).map((c) => [c.id, c]));
  const filhosDe = (id) => (linhasCanaisDoMes ?? []).filter((f) => f.lancamento_id === id);
  const ordenar = (lista) => lista.slice().sort((a, b) =>
    (Number(porId.get(a.canal_id)?.ordem ?? 0) - Number(porId.get(b.canal_id)?.ordem ?? 0))
    || String(porId.get(a.canal_id)?.nome ?? "").localeCompare(String(porId.get(b.canal_id)?.nome ?? ""), "pt-BR"));
  const indisponivel = (motivo) => ({ disponivel: false, motivo });
  const linhaReal = (dataIso) => (linhasDoMes ?? []).find((r) => r.data_lancamento === dataIso && r.origem_lancamento !== "distribuicao_mensal") ?? null;

  const financeiro = (() => {
    const snap = snapshotFinanceiroMaisRecente(linhasDoMes);
    if (!snap) return indisponivel("sem_financeiro");
    const dia = snap.origem_lancamento === "distribuicao_mensal" || !snap.id ? null : linhaReal(snap.data_lancamento);
    if (!dia) return indisponivel("lancamento_mensal");
    if (dia.estrutura_lancamento !== ESTRUTURA.MULTICANAL) return indisponivel("dia_sem_canais");
    const escopo = escopoEntregadoresDoDia({ lancamento: dia });
    const total = numOuNulo(dia.valor_vendas_ifood);
    return {
      disponivel: true,
      dataReferencia: dia.data_lancamento,
      escopoEntregadores: escopo,
      canais: ordenar(filhosDe(dia.id)).map((f) => ({
        canalId: f.canal_id, nome: porId.get(f.canal_id)?.nome ?? null, situacaoCanal: f.situacao_canal,
        valorVendasIfood: numOuNulo(f.valor_vendas_ifood), taxasComissoes: numOuNulo(f.taxas_comissoes),
        servicosPromocoes: numOuNulo(f.servicos_promocoes), taxasEntregadores: numOuNulo(f.taxas_entregadores),
        ajustesFavorLoja: numOuNulo(f.ajustes_favor_loja), ajustesContraLoja: numOuNulo(f.ajustes_contra_loja),
        participacaoVendasPct: percentual(f.valor_vendas_ifood, total),
      })),
      // Custo compartilhado (escopo "unidade"): vem só da linha consolidada.
      compartilhado: { taxasEntregadores: escopo === ESCOPO_ENTREGADORES.UNIDADE ? numOuNulo(dia.taxas_entregadores) : null },
      total: { valorVendasIfood: total },
    };
  })();

  const desempenho = (() => {
    if (!desempenhoParaTicketMedio(linhasDoMes)) return indisponivel("sem_desempenho");
    const reais = (linhasDoMes ?? []).filter((r) => r.origem_lancamento !== "distribuicao_mensal" && r.qtd_vendas != null && r.valor_vendas_bruto != null);
    const dia = reais.reduce((m, r) => (!m || r.data_lancamento > m.data_lancamento ? r : m), null);
    if (!dia) return indisponivel("lancamento_mensal");
    if (dia.estrutura_lancamento !== ESTRUTURA.MULTICANAL) return indisponivel("dia_sem_canais");
    const totalBruto = numOuNulo(dia.valor_vendas_bruto);
    return {
      disponivel: true,
      dataReferencia: dia.data_lancamento,
      canais: ordenar(filhosDe(dia.id)).map((f) => ({
        canalId: f.canal_id, nome: porId.get(f.canal_id)?.nome ?? null, situacaoCanal: f.situacao_canal,
        qtdVendas: numOuNulo(f.qtd_vendas), valorVendasBruto: numOuNulo(f.valor_vendas_bruto), novosClientes: numOuNulo(f.novos_clientes),
        ticketMedio: ticketMedio(f.valor_vendas_bruto, f.qtd_vendas),
        participacaoBrutoPct: percentual(f.valor_vendas_bruto, totalBruto),
      })),
      total: { qtdVendas: numOuNulo(dia.qtd_vendas), valorVendasBruto: totalBruto, ticketMedio: ticketMedio(dia.valor_vendas_bruto, dia.qtd_vendas) },
    };
  })();

  return { financeiro, desempenho };
}
