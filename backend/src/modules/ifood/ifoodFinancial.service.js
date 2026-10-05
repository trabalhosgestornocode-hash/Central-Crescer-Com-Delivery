// Módulo Financial do iFood — Fase 2 (Homologação).
//
// Camada ISOLADA (Bloco B do pedido): não recria nada da Fase 1, só
// REUTILIZA — conexão viva da unidade, merchant já vinculado, credencial
// lógica `financial`, comAccessTokenValido() (refresh único + 1 retry em
// 401), ifoodHttp.client (retry seletivo em 429/5xx, timeout, sanitização
// de log). Nada aqui grava no banco: cada chamada resolve, chama a API,
// normaliza (ifoodFinancial.mapper.js) e devolve — sem persistir payload
// bruto.
//
// HEADER x-request-homologation (homologação Financial): decidido POR UNIDADE,
// num lugar só — modoHomologacao() abaixo, que consulta
// ifoodFinancialHomologacao.js#usarHomologacaoFinancial(unidadeId do tenant).
// Vale para TODAS as APIs deste arquivo (Sales, Financial Events, Settlements,
// Anticipation, Reconciliation, On Demand: POST, status e download). Unidade fora
// da allowlist IFOOD_FINANCIAL_HOMOLOGATION_UNITS -> dado real, sem header.
// O parâmetro interno `homologacao` (boolean) só existe para a orquestração da
// conciliação repassar o MESMO modo às 5 fontes e para testes — o controller
// nunca o envia, e nada vindo do frontend chega até aqui.
//
// Contratos de API: ver ifood.constants.js#IFOOD_ROTAS (comentário com a
// fonte oficial e as divergências entre guia e Referência de API).

import { ifoodErro, IFOOD_ERROS } from "./ifood.errors.js";
import { ifoodLog, mascararId } from "./ifood.logsafe.js";
import { IFOOD_APPS, IFOOD_ROTAS, IFOOD_FINANCIAL_LIMITES } from "./ifood.constants.js";
import * as httpClient from "./ifoodHttp.client.js";
import * as repositorio from "./ifood.repository.js";
import * as tokenService from "./ifoodToken.service.js";
import {
  mapearRespostaSales, mapearRespostaFinancialEvents, mapearRespostaSettlements,
  mapearRespostaReconciliation, mapearRespostaReconciliationSolicitada, mapearRespostaReconciliationStatus,
  parsearArquivoConciliacao, descompactarArquivoConciliacao, mapearRespostaAnticipation,
} from "./ifoodFinancial.mapper.js";
import * as downloadModule from "./ifoodFinancial.download.js";
import * as solicitacoesModule from "./ifoodFinancial.solicitacoes.js";
import { usarHomologacaoFinancial } from "./ifoodFinancialHomologacao.js";
import { conciliarFinancial } from "./ifoodFinancial.reconciliation.js";
import crypto from "node:crypto";

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Modo da chamada ao iFood: true = ambiente de homologação (header
 * x-request-homologation), false = dado real. ÚNICO ponto de decisão do arquivo.
 * `homologacao` boolean explícito (interno) prevalece; senão decide a allowlist
 * por unidade (`deps.homologacaoFinancial` só para testes).
 */
function modoHomologacao({ unidadeId, homologacao, deps = {} }) {
  if (typeof homologacao === "boolean") return homologacao;
  return (deps.homologacaoFinancial ?? usarHomologacaoFinancial)(unidadeId) === true;
}
const RE_COMPETENCIA = /^\d{4}-\d{2}$/;

/**
 * Valida um período (inicio/fim, AAAA-MM-DD) contra o teto de dias de uma
 * API Financial específica. PURA — não chama rede nem banco. Reutilizável
 * pelas próximas APIs desta fase (Events: 33 dias, etc. — cada uma com o
 * seu próprio maxDias, nunca um teto genérico).
 *
 * @param {{inicio, fim}} p
 * @param {{maxDias: number, campo?: string}} opts
 * @returns {{inicio: string, fim: string, dias: number}}
 */
export function validarPeriodo({ inicio, fim }, { maxDias, campo = "o período" } = {}) {
  const i = typeof inicio === "string" ? inicio.trim() : "";
  const f = typeof fim === "string" ? fim.trim() : "";

  if (!RE_DATA.test(i) || !RE_DATA.test(f) || Number.isNaN(Date.parse(i)) || Number.isNaN(Date.parse(f))) {
    throw ifoodErro(IFOOD_ERROS.IFOOD_FINANCIAL_PERIODO_INVALIDO, {
      mensagem: `Informe ${campo} inicial e final no formato AAAA-MM-DD.`,
    });
  }

  const dIni = Date.parse(`${i}T00:00:00Z`);
  const dFim = Date.parse(`${f}T00:00:00Z`);
  if (dFim < dIni) {
    throw ifoodErro(IFOOD_ERROS.IFOOD_FINANCIAL_PERIODO_INVALIDO, {
      mensagem: "A data final não pode ser anterior à data inicial.",
    });
  }

  const dias = Math.round((dFim - dIni) / 86_400_000) + 1;
  if (maxDias && dias > maxDias) {
    throw ifoodErro(IFOOD_ERROS.IFOOD_FINANCIAL_PERIODO_INVALIDO, {
      mensagem: `O período não pode exceder ${maxDias} dias para esta consulta (${dias} informados).`,
    });
  }

  return { inicio: i, fim: f, dias };
}

/** page é 1-indexed na API Sales (confirmado na Referência de API — ver
 * ifood.constants.js). Qualquer valor inválido cai no padrão seguro: 1. */
function validarPagina(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

async function resolverConexaoComMerchant({ organizacaoId, unidadeId, repo }) {
  const conexao = await repo.obterConexaoViva({ organizacaoId, unidadeId });
  if (!conexao) throw ifoodErro(IFOOD_ERROS.IFOOD_CONEXAO_NAO_ENCONTRADA);
  // merchant SEMPRE da conexão da unidade — nunca aceito do chamador (Bloco N).
  if (!conexao.merchant_id) throw ifoodErro(IFOOD_ERROS.IFOOD_FINANCIAL_SEM_MERCHANT);
  return conexao;
}

/** Data local (AAAA-MM-DD) de um instante UTC no fuso da loja; null se não der para calcular. */
function dataLocal(isoUtc, timezone) {
  const ms = Date.parse(isoUtc ?? "");
  if (Number.isNaN(ms)) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "America/Sao_Paulo" }).format(new Date(ms));
  } catch {
    return null;
  }
}

/**
 * Confere se a resposta de Sales é mesmo da loja e do período pedidos. PURA.
 * Venda de outro merchant (ou sem merchant) é DESCARTADA — nunca segue como dado
 * da loja. Período divergente só marca a resposta como inválida.
 */
export function validarRespostaSales({ normalizado, merchantId, periodo }) {
  const daLoja = [];
  const recebidos = new Set();
  let descartadas = 0;
  for (const v of normalizado.vendas) {
    if (v?.merchant?.id && v.merchant.id === merchantId) { daLoja.push(v); continue; }
    descartadas += 1;
    recebidos.add(v?.merchant?.id ? mascararId(v.merchant.id) : "ausente");
  }

  const retornado = normalizado.periodo;
  const periodoConfere = retornado.inicio && retornado.fim
    ? retornado.inicio === periodo.inicio && retornado.fim === periodo.fim
    : null;
  const foraDoPeriodo = daLoja.filter((v) => {
    const d = dataLocal(v.criadoEm, v.merchant?.timezone);
    return d === null || d < periodo.inicio || d > periodo.fim;
  }).length;

  const motivos = [];
  if (descartadas > 0) motivos.push("MERCHANT_DIVERGENTE");
  if (periodoConfere === false) motivos.push("PERIODO_RETORNADO_DIVERGENTE");
  if (foraDoPeriodo > 0) motivos.push("VENDAS_FORA_DO_PERIODO");

  return {
    vendas: daLoja,
    validacao: {
      valida: motivos.length === 0,
      motivos,
      merchant: { esperado: mascararId(merchantId), recebidosDivergentes: [...recebidos], vendasDescartadas: descartadas },
      periodo: { solicitado: { inicio: periodo.inicio, fim: periodo.fim }, retornado, confere: periodoConfere, vendasForaDoPeriodo: foraDoPeriodo },
    },
  };
}

/**
 * API Sales — GET /financial/v3.0/merchants/{merchantId}/sales.
 *
 * Modo (modoHomologacao): unidade em homologação envia `x-request-homologation:
 * true` — o iFood devolve uma FIXTURE fixa (outro merchant, outro período); as
 * demais consultam o dado real da loja. `homologacao` boolean é só interno.
 *
 * @param {{organizacaoId, unidadeId, inicio, fim, page?, homologacao?: boolean, deps?: {repo, http, token}}} p
 * @returns {Promise<{periodo, pagina, vendas: object[], validacao: object}>}
 */
export async function listarSales({ organizacaoId, unidadeId, inicio, fim, page, homologacao, deps = {} }) {
  const repo = deps.repo ?? repositorio;
  const http = deps.http ?? httpClient;
  const token = deps.token ?? tokenService;
  const enviarHeaderHomologacao = modoHomologacao({ unidadeId, homologacao, deps });

  const conexao = await resolverConexaoComMerchant({ organizacaoId, unidadeId, repo });
  const periodo = validarPeriodo({ inicio, fim }, { maxDias: IFOOD_FINANCIAL_LIMITES.sales.maxDias, campo: "a data de venda" });
  const pagina = validarPagina(page);

  const resposta = await token.comAccessTokenValido({
    conexaoId: conexao.id, appType: IFOOD_APPS.FINANCIAL, deps: { repo, http },
    fn: (accessToken) => http.getJson(
      IFOOD_ROTAS.financialSales(conexao.merchant_id, periodo.inicio, periodo.fim, pagina),
      { accessToken, rotulo: "financial.sales", contexto: "financial", homologacao: enviarHeaderHomologacao },
    ),
  });

  const normalizado = mapearRespostaSales(resposta);
  const { vendas, validacao } = validarRespostaSales({ normalizado, merchantId: conexao.merchant_id, periodo });

  if (!validacao.valida) {
    ifoodLog("warn", "financial.sales.resposta_invalida", {
      organizacaoId, unidadeId, homologacao: enviarHeaderHomologacao,
      motivos: validacao.motivos, merchantEsperado: validacao.merchant.esperado,
      merchantsRecebidos: validacao.merchant.recebidosDivergentes, vendasDescartadas: validacao.merchant.vendasDescartadas,
      periodoRetornado: validacao.periodo.retornado, vendasForaDoPeriodo: validacao.periodo.vendasForaDoPeriodo,
    });
  }

  ifoodLog("info", "financial.sales.consultado", {
    organizacaoId, unidadeId, homologacao: enviarHeaderHomologacao,
    inicio: periodo.inicio, fim: periodo.fim, page: pagina,
    total: normalizado.pagina.total, retornados: normalizado.vendas.length, validas: vendas.length, valida: validacao.valida,
  });

  // O período exposto é o SOLICITADO; o que a API ecoou fica só em validacao.periodo.retornado.
  // `fonte` marca fixture x real: nenhum consumidor pode tratar "fixture" como dado da loja.
  return { fonte: enviarHeaderHomologacao ? "fixture" : "real", periodo: { inicio: periodo.inicio, fim: periodo.fim }, pagina: normalizado.pagina, vendas, validacao };
}

// ===========================================================================
// API Financial Events — GET /financial/v3.0/merchants/{merchantId}/financial-events
// ===========================================================================

function hojeISO() { return new Date().toISOString().slice(0, 10); }

/**
 * Ao contrário de Sales, beginDate/endDate são OPCIONAIS nesta API — a
 * documentação oficial diz que, se ausentes, o iFood assume "hoje" (1 dia).
 * Resolvo isso no servidor (sempre mando datas explícitas ao iFood) em vez
 * de omitir o query param condicionalmente — mais previsível de testar.
 * Exige as DUAS ou NENHUMA (evita uma faixa ambígua com só uma ponta).
 */
function resolverPeriodoEvents({ inicio, fim }) {
  const nenhumaInformada = !inicio && !fim;
  if (nenhumaInformada) {
    const hoje = hojeISO();
    return validarPeriodo({ inicio: hoje, fim: hoje }, { maxDias: IFOOD_FINANCIAL_LIMITES.events.maxDias, campo: "a data do evento" });
  }
  if (!inicio || !fim) {
    throw ifoodErro(IFOOD_ERROS.IFOOD_FINANCIAL_PERIODO_INVALIDO, {
      mensagem: "Informe as duas datas (inicial e final) ou nenhuma — nesse caso a consulta usa apenas o dia de hoje.",
    });
  }
  return validarPeriodo({ inicio, fim }, { maxDias: IFOOD_FINANCIAL_LIMITES.events.maxDias, campo: "a data do evento" });
}

/** size: padrão 100 (igual ao servidor), sem teto documentado — só valida
 * que é um inteiro positivo; qualquer coisa inválida cai no padrão. */
function validarTamanhoPagina(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n >= 1 ? n : 100;
}

/**
 * Confere se os eventos são da loja consultada. PURA. Cada evento traz
 * `receiver` (businessId/merchantId): de outro merchant -> DESCARTADO; sem
 * receiver -> mantido (a requisição já foi pelo merchant da conexão) e contado.
 */
export function validarRespostaFinancialEvents({ normalizado, merchantId }) {
  const daLoja = [];
  const recebidos = new Set();
  let descartados = 0;
  let semMerchant = 0;
  for (const e of normalizado.eventos) {
    const id = e?.comerciante?.id;
    if (!id) { semMerchant += 1; daLoja.push(e); continue; }
    if (id === merchantId) { daLoja.push(e); continue; }
    descartados += 1;
    recebidos.add(mascararId(id));
  }
  const motivos = descartados > 0 ? ["MERCHANT_DIVERGENTE"] : [];
  return {
    eventos: daLoja,
    validacao: {
      valida: motivos.length === 0,
      motivos,
      merchant: { esperado: mascararId(merchantId), recebidosDivergentes: [...recebidos], eventosDescartados: descartados, eventosSemMerchant: semMerchant },
    },
  };
}

/**
 * API Financial Events — GET /financial/v3.0/merchants/{merchantId}/financial-events.
 * `idSaldo` (filtro alternativo por período de apuração de saldo) existe na
 * spec oficial mas não está documentado o suficiente para eu implementar com
 * segurança — fica de fora deste incremento (ver ifood.constants.js).
 *
 * Modo: mesma regra de listarSales (modoHomologacao — decidido pela unidade).
 *
 * @param {{organizacaoId, unidadeId, inicio?, fim?, page?, size?, homologacao?: boolean, deps?: {repo, http, token}}} p
 * @returns {Promise<{periodo, pagina, eventos: object[], validacao: object}>}
 */
export async function listarFinancialEvents({ organizacaoId, unidadeId, inicio, fim, page, size, homologacao, deps = {} }) {
  const repo = deps.repo ?? repositorio;
  const http = deps.http ?? httpClient;
  const token = deps.token ?? tokenService;
  const enviarHeaderHomologacao = modoHomologacao({ unidadeId, homologacao, deps });

  const conexao = await resolverConexaoComMerchant({ organizacaoId, unidadeId, repo });
  const periodo = resolverPeriodoEvents({ inicio, fim });
  const pagina = validarPagina(page);
  const tamanho = validarTamanhoPagina(size);

  const resposta = await token.comAccessTokenValido({
    conexaoId: conexao.id, appType: IFOOD_APPS.FINANCIAL, deps: { repo, http },
    fn: (accessToken) => http.getJson(
      IFOOD_ROTAS.financialEvents(conexao.merchant_id, periodo.inicio, periodo.fim, pagina, tamanho),
      { accessToken, rotulo: "financial.events", contexto: "financial", homologacao: enviarHeaderHomologacao },
    ),
  });

  const normalizado = mapearRespostaFinancialEvents(resposta);
  const { eventos, validacao } = validarRespostaFinancialEvents({ normalizado, merchantId: conexao.merchant_id });

  if (!validacao.valida) {
    ifoodLog("warn", "financial.events.resposta_invalida", {
      organizacaoId, unidadeId, homologacao: enviarHeaderHomologacao, motivos: validacao.motivos,
      merchantEsperado: validacao.merchant.esperado, merchantsRecebidos: validacao.merchant.recebidosDivergentes,
      eventosDescartados: validacao.merchant.eventosDescartados,
    });
  }

  ifoodLog("info", "financial.events.consultado", {
    organizacaoId, unidadeId, homologacao: enviarHeaderHomologacao,
    inicio: periodo.inicio, fim: periodo.fim, page: pagina, size: tamanho,
    retornados: normalizado.eventos.length, validos: eventos.length, valida: validacao.valida,
    temProximaPagina: normalizado.pagina.temProximaPagina,
  });

  return { fonte: enviarHeaderHomologacao ? "fixture" : "real", periodo: { inicio: periodo.inicio, fim: periodo.fim }, pagina: normalizado.pagina, eventos, validacao };
}

// ===========================================================================
// API Settlements — GET /financial/v3.0/merchants/{merchantId}/settlements
// SEM paginação. Dois pares de data MUTUAMENTE EXCLUSIVOS (a doc exige um dos
// dois): `modo: "calculo"` -> período de liquidação/apuração (padrão — é o
// que o pedido chama de "período de liquidação"); `modo: "pagamento"` ->
// data em que o título foi efetivamente pago. As duas datas são SEMPRE
// obrigatórias aqui (a API não tem default como em Financial Events).
// ===========================================================================

// Reaproveitado por Settlements E Anticipation — as duas APIs usam o mesmo
// par mutuamente exclusivo de filtros de data ("calculo" = período de
// apuração/liquidação, "pagamento" = data em que o valor foi de fato pago).
const MODOS_PERIODO_FINANCEIRO = new Set(["calculo", "pagamento"]);

function validarModoPeriodoFinanceiro(valor) {
  return MODOS_PERIODO_FINANCEIRO.has(valor) ? valor : "calculo";
}

/**
 * API Settlements — GET /financial/v3.0/merchants/{merchantId}/settlements.
 * Sem limite de dias imposto aqui: a documentação oficial não define um teto
 * rígido para este endpoint (só uma recomendação informal de 30-90 dias na
 * "Referência de campos" — não é validado como erro, só sugerido na UI).
 *
 * @param {{organizacaoId, unidadeId, modo?, inicio, fim, deps?: {repo, http, token}}} p
 * @returns {Promise<{periodo, saldo, merchantsConsolidados, titulos: object[]}>}
 */
export async function listarSettlements({ organizacaoId, unidadeId, modo, inicio, fim, homologacao, deps = {} }) {
  const repo = deps.repo ?? repositorio;
  const http = deps.http ?? httpClient;
  const token = deps.token ?? tokenService;

  const conexao = await resolverConexaoComMerchant({ organizacaoId, unidadeId, repo });
  const modoValidado = validarModoPeriodoFinanceiro(modo);
  // Sem maxDias: a API exige as duas datas, mas não documenta um teto rígido
  // (validarPeriodo só aplica o limite quando maxDias é passado).
  const periodo = validarPeriodo({ inicio, fim }, { campo: modoValidado === "pagamento" ? "a data de pagamento" : "a data do período de liquidação" });

  const resposta = await token.comAccessTokenValido({
    conexaoId: conexao.id, appType: IFOOD_APPS.FINANCIAL, deps: { repo, http },
    fn: (accessToken) => http.getJson(
      IFOOD_ROTAS.financialSettlements(conexao.merchant_id, modoValidado, periodo.inicio, periodo.fim),
      { accessToken, rotulo: "financial.settlements", contexto: "settlements", homologacao: modoHomologacao({ unidadeId, homologacao, deps }) },
    ),
  });

  const normalizado = mapearRespostaSettlements(resposta);

  ifoodLog("info", "financial.settlements.consultado", {
    organizacaoId, unidadeId, modo: modoValidado,
    inicio: periodo.inicio, fim: periodo.fim, titulos: normalizado.titulos.length, saldo: normalizado.saldo,
  });

  return normalizado;
}

// ===========================================================================
// Reconciliation + Reconciliation On Demand — CONTRATOS DIFERENTES entre os
// dois (ver ifoodFinancial.mapper.js para o detalhe). Nunca persistem o
// arquivo bruto: cada chamada baixa, faz o parse, devolve e esquece — nada
// vai pro banco (Bloco N/R).
// ===========================================================================

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * competence: YYYY-MM. Regras confirmadas na doc oficial ("Mapeamento de
 * APIs" > Regra 3): só meses COMPLETOS (nunca o mês atual nem futuro) e
 * janela de até 24 meses no passado.
 */
function validarCompetencia(competencia) {
  const c = typeof competencia === "string" ? competencia.trim() : "";
  if (!RE_COMPETENCIA.test(c)) {
    throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA, { mensagem: "Informe a competência no formato AAAA-MM." });
  }
  const [ano, mes] = c.split("-").map(Number);
  if (mes < 1 || mes > 12) {
    throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA, { mensagem: "Mês inválido na competência." });
  }
  const competenciaData = new Date(Date.UTC(ano, mes - 1, 1));
  const hoje = new Date();
  const mesAtualData = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 1));

  if (competenciaData.getTime() >= mesAtualData.getTime()) {
    throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA, {
      mensagem: "Só é possível gerar conciliação de meses já fechados — o mês atual ainda está recebendo lançamentos.",
    });
  }
  const limiteAntigo = new Date(Date.UTC(mesAtualData.getUTCFullYear(), mesAtualData.getUTCMonth() - 24, 1));
  if (competenciaData.getTime() < limiteAntigo.getTime()) {
    throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA, {
      mensagem: "Competência fora da janela histórica permitida (até 24 meses no passado).",
    });
  }
  return c;
}

function validarRequestId(valor) {
  const r = typeof valor === "string" ? valor.trim() : "";
  if (!RE_UUID.test(r)) {
    throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA, { mensagem: "Identificador de solicitação (requestId) inválido." });
  }
  return r;
}

/**
 * Baixa e faz o parse do arquivo de conciliação, se houver downloadPath.
 * Verifica sha256 quando disponível (só a Reconciliation "normal" traz esse
 * hash — não sei se é do arquivo bruto ou já descompactado, então confiro
 * os dois e marco íntegro se QUALQUER um bater — ver mapper.js).
 */
async function baixarEParsear({ downloadPath, shaEsperado, download, rotulo }) {
  if (!downloadPath) return null;
  let bytesBrutos;
  try {
    bytesBrutos = await download.baixarArquivoConciliacao({ url: downloadPath });
  } catch (e) {
    ifoodLog("warn", `${rotulo}.download_falhou`, { erro: e?.message });
    throw e;
  }

  let parseado;
  try {
    parseado = parsearArquivoConciliacao(bytesBrutos);
  } catch (e) {
    throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA, { mensagem: "O arquivo de conciliação veio num formato que não conseguimos interpretar." });
  }

  // A doc não diz se o sha256 é do arquivo BRUTO (como baixado) ou do
  // conteúdo já descompactado — confere contra os bytes brutos, que é a
  // leitura mais literal de "hash do arquivo". Se não bater, é sinal real
  // (arquivo alterado, OU a hipótese acima está errada — qualquer um dos
  // dois casos é uma divergência que vale mostrar, não esconder).
  const integridadeVerificada = shaEsperado
    ? crypto.createHash("sha256").update(bytesBrutos).digest("hex") === shaEsperado
    : null;

  return {
    colunas: parseado.colunas,
    linhas: parseado.linhas,
    totalLinhas: parseado.totalLinhas,
    truncado: parseado.truncado,
    integridadeVerificada,
    // eraGzip/delimitador já eram computados por parsearArquivoConciliacao
    // e ficavam presos aqui dentro — repassados pro chamador (evidência de
    // homologação: "formato detectado" / "delimitador detectado", ver
    // frontend/src/ifoodEstado.js#montarEvidenciaHomologacao). Nenhum
    // cálculo novo, só para de descartar o que já existia.
    eraGzip: parseado.eraGzip,
    delimitador: parseado.delimitador,
    // Critério de homologação: só `impacto_no_repasse = SIM` compõe o líquido (ver mapper).
    resumoRepasse: parseado.resumoRepasse,
  };
}

/**
 * API Reconciliation — GET /financial/v3.0/merchants/{merchantId}/reconciliation.
 * Síncrona: já devolve `downloadPath` na primeira chamada, sem status
 * intermediário (diferente de On Demand).
 *
 * @param {{organizacaoId, unidadeId, competencia, deps?: {repo, http, token, download}}} p
 */
export async function obterReconciliation({ organizacaoId, unidadeId, competencia, homologacao, deps = {} }) {
  const repo = deps.repo ?? repositorio;
  const http = deps.http ?? httpClient;
  const token = deps.token ?? tokenService;
  const download = deps.download ?? downloadModule;

  const conexao = await resolverConexaoComMerchant({ organizacaoId, unidadeId, repo });
  const competenciaValidada = validarCompetencia(competencia);

  const resposta = await token.comAccessTokenValido({
    conexaoId: conexao.id, appType: IFOOD_APPS.FINANCIAL, deps: { repo, http },
    fn: (accessToken) => http.getJson(
      IFOOD_ROTAS.financialReconciliation(conexao.merchant_id, competenciaValidada),
      { accessToken, rotulo: "financial.reconciliation", contexto: "reconciliation", homologacao: modoHomologacao({ unidadeId, homologacao, deps }) },
    ),
  });

  const normalizado = mapearRespostaReconciliation(resposta);
  const arquivo = await baixarEParsear({
    downloadPath: normalizado.downloadPath, shaEsperado: normalizado.metadados?.sha256,
    download, rotulo: "financial.reconciliation",
  });

  ifoodLog("info", "financial.reconciliation.consultado", {
    organizacaoId, unidadeId, competencia: competenciaValidada,
    temArquivo: !!normalizado.downloadPath, linhas: arquivo?.totalLinhas ?? null,
  });

  // downloadPath NUNCA sai daqui pro frontend — só o resultado já parseado.
  return { competencia: competenciaValidada, criadoEm: normalizado.criadoEm, metadados: normalizado.metadados, arquivo };
}

// ---------------------------------------------------------------------------
// Reconciliation On Demand — fluxo completo de homologação:
//   solicitar (POST) -> guardar requestId por organização/unidade/conexão/
//   competência -> acompanhar status (o FRONTEND faz o polling com backoff,
//   ver frontend/src/ifoodReconciliacaoPolling.js) -> baixar o CSV pela rota
//   autenticada (nunca pela URL assinada).
//
// 409 (doc oficial: "solicitação recente já em progresso — reutilize o
// requestId anterior"): o iFood NÃO devolve o requestId no 409 (Swagger:
// "There is already a recent and valid request"). Por isso o requestId é
// persistido no momento do POST bem-sucedido; no 409 a Central retoma o
// registro guardado. Se o corpo do 409 trouxer um requestId (defensivo),
// ele é usado e registrado.
//
// Posse do requestId: status e download só aceitam um requestId registrado
// para a MESMA organização + unidade + conexão viva. requestId de outra
// unidade (ou digitado) -> 404, sem chamar o iFood.
// ---------------------------------------------------------------------------

const STATUS_ON_DEMAND_TERMINAIS = new Set(["processed", "error"]);

function registroParaSolicitacao(registro) {
  if (!registro) return null;
  return {
    requestId: registro.request_id,
    competencia: registro.competencia,
    status: registro.status,
    mensagemErro: registro.mensagem_erro ?? null,
    solicitadoEm: registro.solicitado_em ?? null,
    expiraEm: registro.expira_em ?? null,
    finalizado: STATUS_ON_DEMAND_TERMINAIS.has(registro.status),
  };
}

async function exigirSolicitacaoDaUnidade({ organizacaoId, unidadeId, conexao, requestId, solicitacoes }) {
  const registro = await solicitacoes.obterPorRequestId({ organizacaoId, unidadeId, conexaoId: conexao.id, requestId });
  if (!registro) {
    ifoodLog("warn", "financial.reconciliation.on_demand.request_id_desconhecido", { organizacaoId, unidadeId, requestId: mascararId(requestId) });
    throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_SOLICITACAO_NAO_ENCONTRADA);
  }
  return registro;
}

/**
 * API Reconciliation On Demand — ETAPA 1: solicita a geração.
 * POST /financial/v3.0/merchants/{merchantId}/reconciliation/on-demand.
 * Sucesso -> registra o requestId. 409 -> retoma o requestId registrado para
 * esta unidade/competência (`reutilizado: true`).
 *
 * @returns {Promise<{requestId, competencia, reutilizado: boolean}>}
 */
export async function solicitarReconciliationOnDemand({ organizacaoId, unidadeId, competencia, usuarioId, deps = {} }) {
  const repo = deps.repo ?? repositorio;
  const http = deps.http ?? httpClient;
  const token = deps.token ?? tokenService;
  const solicitacoes = deps.solicitacoes ?? solicitacoesModule;

  const conexao = await resolverConexaoComMerchant({ organizacaoId, unidadeId, repo });
  const competenciaValidada = validarCompetencia(competencia);
  const chave = { organizacaoId, unidadeId, conexaoId: conexao.id, competencia: competenciaValidada };

  let resposta;
  try {
    resposta = await token.comAccessTokenValido({
      conexaoId: conexao.id, appType: IFOOD_APPS.FINANCIAL, deps: { repo, http },
      fn: (accessToken) => http.postJson(
        IFOOD_ROTAS.financialReconciliationOnDemand(conexao.merchant_id), { competence: competenciaValidada },
        { accessToken, rotulo: "financial.reconciliation.on_demand.solicitar", contexto: "reconciliation", homologacao: modoHomologacao({ unidadeId, deps }) },
      ),
    });
  } catch (e) {
    if (e?.codigo !== IFOOD_ERROS.IFOOD_RECONCILIATION_EM_ANDAMENTO) throw e;

    const doIfood = typeof e.details?.requestId === "string" && RE_UUID.test(e.details.requestId) ? e.details.requestId : null;
    const registrado = await solicitacoes.obterVigente(chave);
    const requestId = doIfood ?? registrado?.request_id ?? null;
    if (!requestId) {
      // Solicitação recente existe no iFood, mas não foi feita por esta
      // Central (ou o registro expirou) — não há requestId para retomar.
      ifoodLog("warn", "financial.reconciliation.on_demand.conflito_sem_registro", { organizacaoId, unidadeId, competencia: competenciaValidada });
      throw e;
    }
    if (doIfood && registrado?.request_id !== doIfood) {
      await solicitacoes.registrar({ ...chave, merchantId: conexao.merchant_id, requestId: doIfood, usuarioId });
    }
    ifoodLog("info", "financial.reconciliation.on_demand.reutilizado", {
      organizacaoId, unidadeId, competencia: competenciaValidada, requestId: mascararId(requestId), origem: doIfood ? "ifood" : "registro",
    });
    return { requestId, competencia: competenciaValidada, reutilizado: true };
  }

  const normalizado = mapearRespostaReconciliationSolicitada(resposta);
  if (!normalizado.requestId || !RE_UUID.test(String(normalizado.requestId))) {
    throw ifoodErro(IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA, { detalhes: { motivo: "requestId ausente na solicitação de conciliação" } });
  }
  await solicitacoes.registrar({ ...chave, merchantId: conexao.merchant_id, requestId: normalizado.requestId, usuarioId });
  ifoodLog("info", "financial.reconciliation.on_demand.solicitado", {
    organizacaoId, unidadeId, competencia: competenciaValidada, requestId: mascararId(normalizado.requestId),
  });
  return { requestId: normalizado.requestId, competencia: competenciaValidada, reutilizado: false };
}

/**
 * Solicitação On Demand VIGENTE (até 24h) desta unidade para a competência —
 * usada pela UI ao reabrir/recarregar a tela para retomar o acompanhamento.
 * Não chama o iFood. `null` quando não há.
 */
export async function obterSolicitacaoReconciliationOnDemand({ organizacaoId, unidadeId, competencia, deps = {} }) {
  const repo = deps.repo ?? repositorio;
  const solicitacoes = deps.solicitacoes ?? solicitacoesModule;
  const conexao = await resolverConexaoComMerchant({ organizacaoId, unidadeId, repo });
  const competenciaValidada = validarCompetencia(competencia);
  const registro = await solicitacoes.obterVigente({ organizacaoId, unidadeId, conexaoId: conexao.id, competencia: competenciaValidada });
  return registroParaSolicitacao(registro);
}

/** GET de status no iFood (link de download novo a cada consulta — doc oficial). */
async function consultarStatusNoIfood({ conexao, requestId, repo, http, token, homologacao }) {
  const resposta = await token.comAccessTokenValido({
    conexaoId: conexao.id, appType: IFOOD_APPS.FINANCIAL, deps: { repo, http },
    fn: (accessToken) => http.getJson(
      IFOOD_ROTAS.financialReconciliationOnDemandStatus(conexao.merchant_id, requestId),
      { accessToken, rotulo: "financial.reconciliation.on_demand.status", contexto: "reconciliation", homologacao },
    ),
  });
  return mapearRespostaReconciliationStatus(resposta);
}

/**
 * API Reconciliation On Demand — ETAPA 2: consulta status por requestId.
 * GET .../reconciliation/on-demand/{requestId}. Se status === "processed",
 * baixa e faz o parse do arquivo automaticamente (tabela + resumo do impacto
 * no repasse). `arquivoDisponivel` habilita o botão "Baixar CSV".
 */
export async function consultarReconciliationOnDemand({ organizacaoId, unidadeId, requestId, deps = {} }) {
  const repo = deps.repo ?? repositorio;
  const http = deps.http ?? httpClient;
  const token = deps.token ?? tokenService;
  const download = deps.download ?? downloadModule;
  const solicitacoes = deps.solicitacoes ?? solicitacoesModule;

  const requestIdValidado = validarRequestId(requestId);
  const conexao = await resolverConexaoComMerchant({ organizacaoId, unidadeId, repo });
  const registro = await exigirSolicitacaoDaUnidade({ organizacaoId, unidadeId, conexao, requestId: requestIdValidado, solicitacoes });

  const normalizado = await consultarStatusNoIfood({ conexao, requestId: requestIdValidado, repo, http, token, homologacao: modoHomologacao({ unidadeId, deps }) });
  if (normalizado.status && normalizado.status !== registro.status) {
    await solicitacoes.atualizarStatus({
      organizacaoId, unidadeId, conexaoId: conexao.id, requestId: requestIdValidado,
      status: normalizado.status, mensagemErro: normalizado.mensagemErro,
    });
  }

  let arquivo = null;
  if (normalizado.status === "processed" && normalizado.downloadPath) {
    arquivo = await baixarEParsear({
      downloadPath: normalizado.downloadPath, shaEsperado: null,
      download, rotulo: "financial.reconciliation.on_demand",
    });
  }

  ifoodLog("info", "financial.reconciliation.on_demand.consultado", {
    organizacaoId, unidadeId, requestId: mascararId(requestIdValidado), status: normalizado.status,
    linhas: arquivo?.totalLinhas ?? null,
  });

  // downloadPath NUNCA sai daqui pro frontend.
  return {
    requestId: normalizado.requestId ?? requestIdValidado,
    competencia: normalizado.competencia ?? registro.competencia,
    status: normalizado.status,
    finalizado: STATUS_ON_DEMAND_TERMINAIS.has(normalizado.status),
    mensagemErro: normalizado.mensagemErro,
    arquivoDisponivel: normalizado.status === "processed" && !!normalizado.downloadPath,
    arquivo,
  };
}

/** Nome de arquivo seguro para Content-Disposition: só [A-Za-z0-9._-]. */
export function nomeArquivoConciliacao(competencia) {
  const c = RE_COMPETENCIA.test(String(competencia ?? "")) ? competencia : "competencia";
  return `conciliacao-ifood-${c}.csv`.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Exportação do CSV de conciliação (critério de homologação: "download/
 * exportação CSV" + "disponibilizar arquivo para download").
 *
 * PROXY SEGURO, sem guarda permanente: valida a posse do requestId, pede ao
 * iFood um link NOVO (GET de status — o link expira e é regenerado a cada
 * consulta), baixa no backend com teto de tamanho/timeout, descompacta o
 * .gz e devolve o CSV. A URL assinada e o access token nunca saem do backend.
 *
 * @returns {Promise<{nomeArquivo: string, conteudo: Buffer, contentType: string}>}
 */
export async function baixarArquivoReconciliationOnDemand({ organizacaoId, unidadeId, requestId, deps = {} }) {
  const repo = deps.repo ?? repositorio;
  const http = deps.http ?? httpClient;
  const token = deps.token ?? tokenService;
  const download = deps.download ?? downloadModule;
  const solicitacoes = deps.solicitacoes ?? solicitacoesModule;

  const requestIdValidado = validarRequestId(requestId);
  const conexao = await resolverConexaoComMerchant({ organizacaoId, unidadeId, repo });
  const registro = await exigirSolicitacaoDaUnidade({ organizacaoId, unidadeId, conexao, requestId: requestIdValidado, solicitacoes });

  const normalizado = await consultarStatusNoIfood({ conexao, requestId: requestIdValidado, repo, http, token, homologacao: modoHomologacao({ unidadeId, deps }) });
  if (normalizado.status !== "processed" || !normalizado.downloadPath) {
    throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_ARQUIVO_INDISPONIVEL);
  }

  const bytesBrutos = await download.baixarArquivoConciliacao({ url: normalizado.downloadPath });
  let conteudo;
  try {
    ({ conteudo } = descompactarArquivoConciliacao(bytesBrutos));
  } catch {
    throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA, { mensagem: "O arquivo de conciliação veio num formato que não conseguimos interpretar." });
  }

  const competenciaArquivo = normalizado.competencia ?? registro.competencia;
  ifoodLog("info", "financial.reconciliation.on_demand.arquivo_exportado", {
    organizacaoId, unidadeId, requestId: mascararId(requestIdValidado), competencia: competenciaArquivo, bytes: conteudo.length,
  });
  return { nomeArquivo: nomeArquivoConciliacao(competenciaArquivo), conteudo, contentType: "text/csv; charset=utf-8" };
}

// ===========================================================================
// API Anticipation — GET /financial/v3.0/merchants/{merchantId}/anticipations.
// SOMENTE LEITURA nesta fase (Bloco Q) — nenhum endpoint de solicitação de
// antecipação é chamado ou exposto aqui. Mesmo par de datas mutuamente
// exclusivo de Settlements — reaproveita validarModoPeriodoFinanceiro().
// ===========================================================================

/**
 * @param {{organizacaoId, unidadeId, modo?, inicio, fim, deps?: {repo, http, token}}} p
 * @returns {Promise<{periodo, saldo, antecipacoes: object[]}>}
 */
export async function listarAnticipations({ organizacaoId, unidadeId, modo, inicio, fim, homologacao, deps = {} }) {
  const repo = deps.repo ?? repositorio;
  const http = deps.http ?? httpClient;
  const token = deps.token ?? tokenService;

  const conexao = await resolverConexaoComMerchant({ organizacaoId, unidadeId, repo });
  const modoValidado = validarModoPeriodoFinanceiro(modo);
  // Sem maxDias: assim como Settlements, a doc não define um teto rígido de
  // período pra este endpoint.
  const periodo = validarPeriodo({ inicio, fim }, { campo: modoValidado === "pagamento" ? "a data de pagamento antecipado" : "o período de cálculo" });

  const resposta = await token.comAccessTokenValido({
    conexaoId: conexao.id, appType: IFOOD_APPS.FINANCIAL, deps: { repo, http },
    fn: (accessToken) => http.getJson(
      IFOOD_ROTAS.financialAnticipations(conexao.merchant_id, modoValidado, periodo.inicio, periodo.fim),
      { accessToken, rotulo: "financial.anticipations", contexto: "anticipations", homologacao: modoHomologacao({ unidadeId, homologacao, deps }) },
    ),
  });

  const normalizado = mapearRespostaAnticipation(resposta);

  ifoodLog("info", "financial.anticipations.consultado", {
    organizacaoId, unidadeId, modo: modoValidado,
    inicio: periodo.inicio, fim: periodo.fim, antecipacoes: normalizado.antecipacoes.length, saldo: normalizado.saldo,
  });

  return normalizado;
}

// ===========================================================================
// Bloco H — Conciliação Financeira consolidada. ORQUESTRA as 5 chamadas já
// existentes (Sales/Events/Settlements/Reconciliation/Anticipation) e passa
// os resultados JÁ NORMALIZADOS pra função PURA conciliarFinancial()
// (ifoodFinancial.reconciliation.js) — nenhuma lógica de conciliação mora
// aqui, só orquestração de I/O + resiliência.
//
// RESILIÊNCIA (Bloco 12): Promise.allSettled — uma fonte falhar (período
// inválido pra aquela API específica, indisponibilidade, sem dados) NUNCA
// derruba as outras 4. A fonte que falhou entra como `null` na conciliação
// (tratado como "incompleto", nunca como divergência) e aparece em
// `fontesComErro` pra a UI explicar o motivo.
// ===========================================================================

const FONTES_CONCILIACAO = ["sales", "events", "settlements", "reconciliation", "anticipations"];

/**
 * @param {{organizacaoId, unidadeId, inicio, fim, competencia?, deps?: {repo, http, token, download}}} p
 *   `competencia` (AAAA-MM) é opcional — se ausente, deriva do mês de
 *   `inicio` (a Reconciliation é mensal, as outras 4 são por intervalo de
 *   data; não há como unificar isso sem uma escolha — esta é a mais óbvia).
 */
export async function obterConciliacaoFinanceira({ organizacaoId, unidadeId, inicio, fim, competencia, deps = {} }) {
  const repo = deps.repo ?? repositorio;

  // Falha rápido e clara se não há conexão/merchant — evita 5 chamadas
  // paralelas que fracassariam todas pelo mesmo motivo.
  await resolverConexaoComMerchant({ organizacaoId, unidadeId, repo });

  const competenciaEfetiva = competencia || (typeof inicio === "string" ? inicio.slice(0, 7) : null);

  // UM modo para as 5 fontes (decidido pela unidade): nunca mistura dado real com
  // fixture na mesma conciliação.
  const homologacao = modoHomologacao({ unidadeId, deps });
  const resultados = await Promise.allSettled([
    listarSales({ organizacaoId, unidadeId, inicio, fim, homologacao, deps }),
    listarFinancialEvents({ organizacaoId, unidadeId, inicio, fim, homologacao, deps }),
    listarSettlements({ organizacaoId, unidadeId, modo: "calculo", inicio, fim, homologacao, deps }),
    competenciaEfetiva
      ? obterReconciliation({ organizacaoId, unidadeId, competencia: competenciaEfetiva, homologacao, deps })
      : Promise.reject(ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA, { mensagem: "Competência não informada nem derivável do período." })),
    listarAnticipations({ organizacaoId, unidadeId, modo: "calculo", inicio, fim, homologacao, deps }),
  ]);

  const [salesR, eventsR, settlementsR, reconciliationR, anticipationsR] = resultados;
  const extrair = (r) => (r.status === "fulfilled" ? r.value : null);

  const fontesComErro = resultados
    .map((r, i) => (r.status === "rejected" ? { fonte: FONTES_CONCILIACAO[i], codigo: r.reason?.codigo ?? null, mensagem: r.reason?.message ?? "Falha desconhecida." } : null))
    .filter(Boolean);

  const resultado = conciliarFinancial({
    periodo: { inicio: inicio ?? null, fim: fim ?? null },
    sales: extrair(salesR),
    events: extrair(eventsR),
    settlements: extrair(settlementsR),
    reconciliation: extrair(reconciliationR),
    anticipations: extrair(anticipationsR),
  });

  ifoodLog("info", "financial.conciliation.consultado", {
    organizacaoId, unidadeId, inicio, fim, competencia: competenciaEfetiva,
    statusGeral: resultado.conciliacao.statusGeral, fontesComErro: fontesComErro.map((f) => f.fonte),
  });

  return { ...resultado, fonte: homologacao ? "fixture" : "real", fontesComErro };
}
