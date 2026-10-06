// Normalização PURA das respostas do módulo Financial do iFood (Fase 2 —
// Homologação). Nenhuma chamada de rede, nenhum acesso a banco — só
// transformação de um payload já recebido em algo estável para o frontend.
//
// Fonte do contrato: Referência de API oficial (Swagger) em
// https://developer.ifood.com.br/pt-BR/docs/references — módulo
// "Financial v3.0" (servidor https://merchant-api.ifood.com.br/financial/v3.0).
// Ver ifood.constants.js#IFOOD_ROTAS.financialSales para as duas divergências
// confirmadas entre o guia narrativo (Guias de documentação) e essa
// Referência de API — este mapper trata as duas formas possíveis do
// envelope de resposta.
//
// Convenção: chaves em PT-BR no nível de "container" (mesmo padrão de
// ifoodMerchant.service.js#sanitizarMerchant), mas os VALORES de enum
// (currentStatus, fullCode, billingEntries[].name, type, category...)
// ficam como o iFood devolve — são vocabulário técnico da API, traduzi-los
// seria inventar significado que a documentação não confirma.

import zlib from "node:zlib";
import { IFOOD_RECONCILIATION_ARQUIVO } from "./ifood.constants.js";
import { mascararId } from "./ifood.logsafe.js";

function numOuZero(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// "Não informado" != zero: para campo que a doc diz nunca vir nulo, ausência vira null, não 0.
function numOuNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * A resposta 200 das APIs Financial (Sales, Financial Events, ...) tem DUAS
 * formas documentadas oficialmente (guia narrativo x Referência de API — ver
 * ifood.constants.js): um objeto plano OU um array de 1 posição com esse
 * mesmo objeto. Aceita as duas sem lançar. Compartilhado por todas as APIs
 * deste módulo — o padrão se repetiu em Sales e Financial Events.
 */
function desembrulharEnvelope(resp) {
  if (Array.isArray(resp)) return resp[0] ?? {};
  return resp ?? {};
}

// `merchant.documents` (CNPJ/CPF do titular, MCC) NUNCA é mapeado: é PII e nenhum consumidor precisa dele.
function mapearMerchantDaVenda(m) {
  if (!m) return null;
  return {
    id: m.id ?? null,
    shortId: m.shortId ?? null,
    nome: m.name ?? null,
    tipo: m.type ?? null,
    timezone: m.timezone ?? null,
  };
}

// bag é obrigatório na doc: sem ele o valor bruto é desconhecido (null), nunca "venda de R$ 0".
// deliveryFee/serviceFee ausentes significam "não cobrado" (retirada / só alguns pedidos) -> 0.
function mapearValorBruto(sgv) {
  const itens = numOuNull(sgv?.bag);
  if (itens === null) return { itens: null, entrega: null, taxaServico: null, total: null };
  const entrega = numOuZero(sgv.deliveryFee);
  const taxaServico = numOuZero(sgv.serviceFee);
  // Valores em reais com 2 casas: arredonda a soma para não expor ruído de ponto flutuante (0.1 + 0.2).
  return { itens, entrega, taxaServico, total: Math.round((itens + entrega + taxaServico) * 100) / 100 };
}

function mapearBeneficios(b) {
  if (!b) return null;
  return {
    valorTotal: numOuZero(b.totalValue),
    itens: Array.isArray(b.benefits) ? b.benefits.map((x) => ({
      alvo: x?.target ?? null,
      valor: numOuZero(x?.value),
      patrocinadores: Array.isArray(x?.sponsorships)
        ? x.sponsorships.map((s) => ({ nome: s?.name ?? null, valor: numOuZero(s?.value) }))
        : [],
    })) : [],
  };
}

function mapearEntrega(d) {
  if (!d) return null;
  return {
    provedorInformacao: d.informationProvider?.name ?? null,
    tipo: d.type ?? null,
    parametros: d.deliveryParameters ? {
      prestadorLogistico: d.deliveryParameters.logisticProvider ?? null,
      produto: d.deliveryParameters.deliveryProduct ?? null,
      codigo: d.deliveryParameters.code ?? null,
      tipoAgendamento: d.deliveryParameters.schedulingType ?? null,
    } : null,
    precos: d.prices ? {
      bruto: numOuZero(d.prices.grossValue),
      desconto: numOuZero(d.prices.discount),
      liquido: numOuZero(d.prices.netValue),
    } : null,
  };
}

function mapearMetodoPagamento(m) {
  return {
    metodo: m?.method ?? null,
    moeda: m?.currency ?? null,
    tipo: m?.type ?? null,
    valor: numOuZero(m?.value),
    responsavel: m?.liability ?? null,
    bandeira: m?.card?.brand ?? null,
    carteira: m?.wallet?.name ?? null,
    trocoPara: m?.cash?.changeFor ?? null,
    parcelamento: m?.installment ? {
      maxParcelas: m.installment.maxInstallments ?? null,
      parcelas: Array.isArray(m.installment.installmentDetail)
        ? m.installment.installmentDetail.map((p) => ({ numero: p?.reference ?? null, valor: numOuZero(p?.amount) }))
        : [],
    } : null,
    tipoEstorno: m?.refundType ?? null,
  };
}

function mapearPagamentos(p) {
  if (!p || !Array.isArray(p.methods)) return [];
  return p.methods.map(mapearMetodoPagamento);
}

function mapearHistoricoStatus(h) {
  if (!Array.isArray(h)) return [];
  return h.map((x) => ({ status: x?.value ?? null, em: x?.createdAt ?? null, detalhe: x?.metadata ?? null }));
}

/** billingEntries não vem com um "crédito"/"débito" explícito — deriva do
 * sinal do valor (soma explicável, sem categorização inventada). */
function mapearResumoFinanceiro(bs) {
  if (!bs) return null;
  return {
    saldo: numOuNull(bs.saleBalance),
    lancamentos: Array.isArray(bs.billingEntries) ? bs.billingEntries.map((e) => {
      const valor = numOuNull(e?.value);
      return { nome: e?.name ?? null, valor, tipo: valor === null ? null : valor >= 0 ? "credito" : "debito" };
    }) : [],
  };
}

function mapearEventosPedido(oe) {
  if (!Array.isArray(oe)) return [];
  return oe.map((e) => ({
    id: e?.id ?? null,
    codigoCompleto: e?.fullCode ?? null,
    codigo: e?.code ?? null,
    em: e?.createdAt ?? null,
    // metadata varia de forma (objeto simples, ou aninhado com refund/payout
    // conforme o tipo do evento) — repassado como veio, sem achatar.
    detalhe: e?.metadata ?? null,
  }));
}

/** Uma venda (`sales[]`) -> forma normalizada, sem descartar campo técnico. */
export function mapearVenda(s) {
  return {
    id: s?.id ?? null,
    shortId: s?.shortId ?? null,
    criadoEm: s?.createdAt ?? null,
    tipo: s?.type ?? null,
    categoria: s?.category ?? null,
    canal: s?.salesChannel ?? null,
    status: s?.currentStatus ?? null,
    merchant: mapearMerchantDaVenda(s?.merchant),
    valorBruto: mapearValorBruto(s?.saleGrossValue),
    beneficios: mapearBeneficios(s?.benefits),
    entrega: mapearEntrega(s?.delivery),
    pagamentos: mapearPagamentos(s?.payments),
    historicoStatus: mapearHistoricoStatus(s?.orderStatusHistory),
    resumoFinanceiro: mapearResumoFinanceiro(s?.billingSummary),
    eventos: mapearEventosPedido(s?.orderEvents),
  };
}

/** Resposta completa de GET .../sales -> forma normalizada para o frontend. */
export function mapearRespostaSales(respostaBruta) {
  const env = desembrulharEnvelope(respostaBruta);
  const vendas = Array.isArray(env.sales) ? env.sales.map(mapearVenda) : [];
  return {
    periodo: { inicio: env.beginSalesDate ?? null, fim: env.endSalesDate ?? null },
    pagina: {
      atual: typeof env.page === "number" ? env.page : null,
      tamanho: typeof env.size === "number" ? env.size : vendas.length,
      total: typeof env.total === "number" ? env.total : vendas.length,
      totalPaginas: typeof env.pageCount === "number" ? env.pageCount : null,
    },
    vendas,
  };
}

// ===========================================================================
// Financial Events — GET /financial/v3.0/merchants/{id}/financial-events
// Mesma divergência de envelope de Sales (guia: objeto plano; Referência de
// API: array com 1 objeto) — reaproveita o mesmo desembrulho.
// ===========================================================================

/** amount.value/billing.baseValue/billing.feePercentage vêm como STRING no
 * JSON real (ex.: "-0.99") — nunca number. Converte com segurança. */
function numOuNulo(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Referência de API: businessId/businessType; guia: merchantId. O documento
// (businessDocument/merchantDocument = CNPJ ou CPF do titular) NUNCA é mapeado.
function mapearReceiver(r) {
  if (!r) return null;
  return {
    id: r.businessId ?? r.merchantId ?? null,
    tipo: r.businessType ?? null,
  };
}

/** Um evento financeiro -> forma normalizada, sem descartar campo técnico. */
export function mapearEventoFinanceiro(e) {
  const valor = numOuNulo(e?.amount?.value);
  return {
    nome: e?.name ?? null,
    descricao: e?.description ?? null,
    produto: e?.product ?? null,
    gatilho: e?.trigger ?? null,
    dataHora: e?.dateTime ?? null,
    competencia: e?.competence ?? null,
    periodoApuracao: e?.period ? { inicio: e.period.beginDate ?? null, fim: e.period.endDate ?? null } : null,
    referencia: e?.reference ? { tipo: e.reference.type ?? null, id: e.reference.id ?? null, data: e.reference.date ?? null } : null,
    // Ausente = desconhecido (null), nunca "sem impacto".
    temImpactoRepasse: typeof e?.hasTransferImpact === "boolean" ? e.hasTransferImpact : null,
    valor,
    // crédito/débito derivado do SINAL do valor (mesma regra de billingEntries
    // em Sales) — não é um campo que a API devolva pronto.
    tipoValor: valor === null ? null : valor >= 0 ? "credito" : "debito",
    faturamento: e?.billing ? {
      valorBase: numOuNulo(e.billing.baseValue),
      percentualTaxa: numOuNulo(e.billing.feePercentage),
      // Parcela (ex.: "1/3") — ORDER_PAYMENT parcelado vem em vários eventos; somar sem olhar isto duplica receita.
      parcela: e.billing.installments ? { referencia: e.billing.installments.reference ?? null, dataReferencia: e.billing.installments.referenceDate ?? null } : null,
    } : null,
    dataRepasseEsperada: e?.settlement?.expectedDate ?? null,
    comerciante: mapearReceiver(e?.receiver),
    pagamento: e?.payment ? { metodo: e.payment.method ?? null, bandeira: e.payment.brand ?? null, responsavel: e.payment.liability ?? null } : null,
  };
}

/** Resposta completa de GET .../financial-events -> forma normalizada. Não
 * tem `total`/`pageCount` (a API não devolve) — só `hasNextPage`. */
export function mapearRespostaFinancialEvents(respostaBruta) {
  const env = desembrulharEnvelope(respostaBruta); // mesmo desembrulho array/objeto
  const eventos = Array.isArray(env.financialEvents) ? env.financialEvents.map(mapearEventoFinanceiro) : [];
  return {
    pagina: {
      atual: typeof env.page === "number" ? env.page : null,
      tamanho: typeof env.size === "number" ? env.size : eventos.length,
      temProximaPagina: env.hasNextPage === true,
    },
    eventos,
  };
}

// ===========================================================================
// Settlements — GET /financial/v3.0/merchants/{id}/settlements
// SEM paginação (nem request nem resposta). `settlements[]` é uma UNIÃO de
// dois formatos confirmada no exemplo real do Swagger (não é suposição):
//   A) título avulso:  {id, type, amount, status, accountDetails,
//                        paymentDate, transactionId?}
//   B) período/cálculo: {startDateCalculation, endDateCalculation,
//                        closingItems: [ { mesmo shape de A, + product } ]}
// Achata os dois em UMA lista de "títulos" — cada um carrega seu próprio
// `periodoApuracao` (null pros avulsos, {inicio,fim} pros de período). Isso é
// uma normalização MINHA para facilitar a UI, não um campo que a API
// devolva — o "Ver detalhes" de cada título mostra o JSON bruto original.
// ===========================================================================

/** accountDetails pode vir `{}` (vazio) — vira null. Campos confirmados no
 * exemplo real (branchDigit/documentNumber NÃO estão na "Referência de
 * campos" genérica do guia — só apareceram no Swagger). */
function mapearContaBancaria(ad) {
  if (!ad || typeof ad !== "object" || Object.keys(ad).length === 0) return null;
  return {
    banco: ad.bankName ?? null,
    numeroBanco: ad.bankNumber ?? null,
    agencia: ad.branchCode ?? null,
    digitoAgencia: ad.branchDigit ?? null,
    conta: ad.accountNumber ?? null,
    digitoConta: ad.accountDigit ?? null,
    // Documento associado à conta (instituição financeira, nos exemplos
    // reais) — a API não documenta de quem é explicitamente.
    documento: ad.documentNumber ?? null,
  };
}

/** Um título avulso (formato A) OU um item de closingItems (formato B, tem
 * `product` a mais) -> forma normalizada comum. */
function mapearTitulo(item, periodoApuracao) {
  return {
    id: item?.id ?? null,
    tipo: item?.type ?? null,
    produto: item?.product ?? null, // só presente nos itens de closingItems
    valor: typeof item?.amount === "number" ? item.amount : numOuNulo(item?.amount),
    status: item?.status ?? null,
    transacaoId: item?.transactionId ?? null,
    dataPagamento: item?.paymentDate ?? null,
    periodoApuracao,
    contaBancaria: mapearContaBancaria(item?.accountDetails),
  };
}

/** Resposta completa de GET .../settlements -> forma normalizada. Sem
 * `pagina` — a API não pagina este endpoint. */
export function mapearRespostaSettlements(respostaBruta) {
  const env = desembrulharEnvelope(respostaBruta);
  const brutos = Array.isArray(env.settlements) ? env.settlements : [];

  const titulos = [];
  for (const s of brutos) {
    if (Array.isArray(s?.closingItems)) {
      // Formato B: grupo de período — achata cada item de closingItems,
      // carregando o período do grupo.
      const periodoApuracao = { inicio: s.startDateCalculation ?? null, fim: s.endDateCalculation ?? null };
      for (const item of s.closingItems) titulos.push(mapearTitulo(item, periodoApuracao));
    } else {
      // Formato A: título avulso, sem período de apuração.
      titulos.push(mapearTitulo(s, null));
    }
  }

  return {
    periodo: { inicio: env.beginDate ?? null, fim: env.endDate ?? null },
    saldo: typeof env.balance === "number" ? env.balance : numOuNulo(env.balance),
    merchantsConsolidados: Array.isArray(env.consolidatedMerchants) ? env.consolidatedMerchants : [],
    titulos,
  };
}

// ===========================================================================
// Anticipation — GET /financial/v3.0/merchants/{id}/anticipations
// MESMO envelope de Settlements (array com 1 objeto, `settlements[]` com
// grupos de período) — confirmado no exemplo real do Swagger — mas o item
// dentro de `closingItems[]` é um objeto DIFERENTE: sem `id`/`amount`/
// `transactionId`/`product`; usa `originalPaymentAmount`/
// `anticipatedPaymentAmount`/`feePercentage`/`feeAmount` e DUAS datas
// (`originalPaymentDate`/`anticipatedPaymentDate`). `accountDetails` tem o
// MESMO shape de Settlements — reaproveita mapearContaBancaria().
// SEM paginação no exemplo real (diverge da "Referência de campos", que
// genericamente listava page/size aqui — mesmo tipo de divergência já visto
// em Settlements).
// ===========================================================================

/** Um item de antecipação (avulso OU de closingItems — mesmo shape nos dois
 * casos, confirmado só pro formato de período no exemplo real). */
function mapearAntecipacao(item, periodoApuracao) {
  return {
    tipo: item?.type ?? null, // REPASSE_ANTECIPADO_DIARIO | REPASSE_ANTECIPADO_SEMANAL
    valorOriginal: numOuNulo(item?.originalPaymentAmount),
    valorAntecipado: numOuNulo(item?.anticipatedPaymentAmount),
    taxa: {
      valor: numOuNulo(item?.feeAmount),
      percentual: numOuNulo(item?.feePercentage),
    },
    status: item?.status ?? null, // SUCCEED | FAILED | PENDING
    dataPagamentoOriginal: item?.originalPaymentDate ?? null,
    dataPagamentoAntecipado: item?.anticipatedPaymentDate ?? null,
    periodoApuracao,
    contaBancaria: mapearContaBancaria(item?.accountDetails),
  };
}

/** Resposta completa de GET .../anticipations -> forma normalizada. Sem
 * `pagina` — a API não pagina este endpoint (mesmo caso de Settlements). */
export function mapearRespostaAnticipation(respostaBruta) {
  const env = desembrulharEnvelope(respostaBruta);
  const brutos = Array.isArray(env.settlements) ? env.settlements : [];

  const antecipacoes = [];
  for (const s of brutos) {
    if (Array.isArray(s?.closingItems)) {
      const periodoApuracao = { inicio: s.startDateCalculation ?? null, fim: s.endDateCalculation ?? null };
      for (const item of s.closingItems) antecipacoes.push(mapearAntecipacao(item, periodoApuracao));
    } else {
      antecipacoes.push(mapearAntecipacao(s, null));
    }
  }

  return {
    periodo: { inicio: env.beginDate ?? null, fim: env.endDate ?? null },
    saldo: typeof env.balance === "number" ? env.balance : numOuNulo(env.balance),
    antecipacoes,
  };
}

// ===========================================================================
// Reconciliation — GET /financial/v3.0/merchants/{id}/reconciliation
// Reconciliation On Demand — POST .../reconciliation/on-demand +
//                             GET .../reconciliation/on-demand/{requestId}
// Contratos DIFERENTES entre os dois fluxos (confirmado no Swagger real,
// colado pelo usuário em 2026-09-12 — o portal exigiu CAPTCHA e bloqueou a
// navegação automatizada, então o service.js documenta a fonte exata):
//   * Reconciliation (mês fechado): SEMPRE síncrono pro chamador — devolve
//     `downloadPath` na hora, sem status intermediário.
//   * On Demand: ASSÍNCRONO — POST devolve `requestId` (200, não 202); GET
//     por requestId devolve status created|enqueue|processed|error, e só em
//     "processed" vem `downloadPath`.
// Erro 400 de Reconciliation usa {error:{code,message,field,details}} (igual
// Sales/Events/Settlements); o POST on-demand usa {code,message} SEM
// wrapper; o 404 do GET-por-requestId usa {error:"404",message}. Três
// formas diferentes — não uniformizadas aqui de propósito (classificação de
// erro é só por status HTTP, ver ifood.errors.js).
// ===========================================================================

function mapearMetadadosArquivo(m) {
  if (!m || typeof m !== "object") return null;
  return {
    totalPedidosAssociadosIfood: numOuNulo(m.total_pedido_associado_ifood),
    sha256: m.sha256 ?? null,
    totalLinhas: numOuNulo(m.total_linhas),
    totalCodigoTransacao: numOuNulo(m.total_codigo_transacao),
  };
}

/** GET .../reconciliation?competence=. Resposta 200 é array com 1 objeto. */
export function mapearRespostaReconciliation(respostaBruta) {
  const env = desembrulharEnvelope(respostaBruta);
  return {
    downloadPath: env.downloadPath ?? null, // NUNCA logar — ver ifoodFinancial.download.js
    criadoEm: env.createdAt ?? null,
    metadados: mapearMetadadosArquivo(env.metadata),
  };
}

/** POST .../reconciliation/on-demand. Resposta 200 (não 202): {competence, merchantId, requestId}. */
export function mapearRespostaReconciliationSolicitada(resp) {
  return {
    requestId: resp?.requestId ?? null,
    competencia: resp?.competence ?? null,
  };
}

// Status do GET on-demand/{requestId}. Swagger (Referência de API, Financial
// v3.0, exemplos Created/Enqueued/Processed/No Financial Entries): created,
// enqueue, processed, error. A API REAL de homologação devolveu "enqueued"
// (2026-10-06, requestId 988e****f836) — sinônimo normalizado para o valor
// canônico "enqueue" (é o que a constraint da tabela da migration 106 aceita).
const SINONIMOS_STATUS_ON_DEMAND = Object.freeze({ enqueued: "enqueue" });
export const STATUS_ON_DEMAND_CONHECIDOS = Object.freeze(["created", "enqueue", "processed", "error"]);

export function normalizarStatusOnDemand(status) {
  if (typeof status !== "string" || !status.trim()) return null;
  const s = status.trim().toLowerCase();
  return SINONIMOS_STATUS_ON_DEMAND[s] ?? s;
}

const MAX_MENSAGEM_ERRO = 300;
/** Motivo do status "error" (`message` no Swagger; `errorMessage` na API real), sanitizado:
 * só string, sem URL (nunca uma URL assinada), UUIDs mascarados (a API real
 * devolve o merchantId inteiro: "No financial entries exist for merchant <uuid>
 * ..."), espaços colapsados, até 300 chars. Idempotente. */
const UUID_EM_TEXTO = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
export function sanitizarMensagemErroOnDemand(valor) {
  if (typeof valor !== "string") return null;
  const limpo = valor
    .replace(/https?:\/\/\S+/gi, "[url removida]")
    .replace(UUID_EM_TEXTO, (uuid) => mascararId(uuid))
    .replace(/\s+/g, " ")
    .trim();
  return limpo ? limpo.slice(0, MAX_MENSAGEM_ERRO) : null;
}

/** GET .../reconciliation/on-demand/{requestId}. */
export function mapearRespostaReconciliationStatus(resp) {
  const statusIfood = typeof resp?.status === "string" ? resp.status : null;
  const status = normalizarStatusOnDemand(statusIfood);
  const mensagemErro = sanitizarMensagemErroOnDemand(resp?.message) ?? sanitizarMensagemErroOnDemand(resp?.errorMessage);
  return {
    requestId: resp?.id ?? null,
    competencia: resp?.competence ?? null,
    status,
    statusIfood, // valor bruto, só para diagnóstico (ex.: "enqueued")
    // Só existe quando status === "processed". NUNCA logar — carrega
    // assinatura AWS temporária (ver ifoodFinancial.download.js).
    downloadPath: resp?.downloadPath ?? null,
    // Doc oficial: status "error" traz `message` (ex.: "No financial entries
    // found for the specified merchant and competence."). A API REAL de
    // homologação (2026-10-06, requestId 988e****f836) devolveu o motivo em
    // `errorMessage` — lido como alternativa; `message` tem precedência.
    mensagemErro,
    // "error" sem nenhum dos dois: guarda só os NOMES dos campos recebidos (nunca
    // valores) para descobrir se o iFood usou outro campo não documentado.
    camposRecebidosNoErro: status === "error" && !mensagemErro && resp && typeof resp === "object"
      ? Object.keys(resp).filter((k) => /^[A-Za-z0-9_]{1,40}$/.test(k)).slice(0, 20)
      : null,
  };
}

// --- Parse do arquivo baixado (CSV, opcionalmente gzip) -------------------
//
// NADA disto é documentado pelo iFood (nem o guia, nem o Swagger, nem a
// "Referência de campos" falam de encoding/delimitador/colunas do CSV) —
// são decisões MINHAS, defensivas e explícitas:
//   * gzip detectado por magic bytes (0x1F 0x8B), NUNCA pela extensão da
//     URL — o exemplo real do on-demand tem uma URL terminando em .csv put
//     mesmo que o conteúdo real venha comprimido;
//   * encoding assumido UTF-8;
//   * delimitador detectado automaticamente (`,` vs `;`) pela primeira
//     linha — o que aparecer mais vezes fora de aspas vence, `,` no empate;
//   * cabeçalho = primeira linha, como veio — os nomes de coluna NÃO são
//     traduzidos nem re-mapeados (eu não sei quais são os reais ainda).

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

function pareceGzip(buf) {
  return buf.length >= 2 && buf[0] === GZIP_MAGIC[0] && buf[1] === GZIP_MAGIC[1];
}

function detectarDelimitador(primeiraLinha) {
  const semAspas = primeiraLinha.replace(/"[^"]*"/g, "");
  const virgulas = (semAspas.match(/,/g) || []).length;
  const pontoVirgulas = (semAspas.match(/;/g) || []).length;
  return pontoVirgulas > virgulas ? ";" : ",";
}

/** Uma linha de CSV (com aspas) -> array de campos. RFC4180 simplificado:
 * aspas escapam delimitador/quebra de linha; "" dentro de aspas = aspas literal. */
function parsearLinhaCsv(linha, delimitador) {
  const campos = [];
  let atual = "";
  let dentroDeAspas = false;
  for (let i = 0; i < linha.length; i += 1) {
    const c = linha[i];
    if (dentroDeAspas) {
      if (c === '"' && linha[i + 1] === '"') { atual += '"'; i += 1; }
      else if (c === '"') dentroDeAspas = false;
      else atual += c;
    } else if (c === '"') {
      dentroDeAspas = true;
    } else if (c === delimitador) {
      campos.push(atual);
      atual = "";
    } else {
      atual += c;
    }
  }
  campos.push(atual);
  return campos;
}

/**
 * Descompacta (se gzip) os bytes brutos do arquivo de conciliação, com teto
 * de tamanho pós-descompactação. Compartilhado pelo parse (tabela + resumo)
 * e pela exportação do CSV — um só lugar decide gzip.
 * @param {Buffer} bufferBruto
 * @returns {{conteudo: Buffer, eraGzip: boolean}}
 */
export function descompactarArquivoConciliacao(bufferBruto) {
  let conteudo = bufferBruto;
  const eraGzip = pareceGzip(bufferBruto);
  if (eraGzip) {
    try {
      // maxOutputLength: corta a descompactação no teto em vez de materializar um "zip bomb" inteiro.
      conteudo = zlib.gunzipSync(bufferBruto, { maxOutputLength: IFOOD_RECONCILIATION_ARQUIVO.maxBytesDescompactado + 1 });
    } catch {
      throw new Error("Arquivo de conciliação: falha ao descompactar gzip.");
    }
  }
  if (conteudo.length > IFOOD_RECONCILIATION_ARQUIVO.maxBytesDescompactado) {
    throw new Error("Arquivo de conciliação excede o tamanho máximo permitido após descompactar.");
  }
  return { conteudo, eraGzip };
}

// --- Impacto no repasse (critério de homologação Financial) ----------------
//
// Doc oficial (API Reconciliation On Demand > "Impacto no repasse"): para
// chegar ao valor líquido que a loja tem a receber, consideram-se APENAS os
// lançamentos com `impacto_no_repasse = SIM`; os demais são informativos
// (ex.: meal voucher recebido pela loja, promoção incentivada pela loja).
// Valor da linha: coluna `valor` ("Valor do lançamento", double) — NÃO
// `valor_transacao`, que é o valor do título bancário inteiro e se repete
// em várias linhas.
//
// Nada é descartado: todas as linhas continuam na tabela; o resumo só separa
// os totais. Impacto fora de SIM/NÃO conta como "não informado" e fica FORA
// do total com impacto (nunca vira "sem impacto").

const COLUNA_IMPACTO = "impacto_no_repasse";
const COLUNA_VALOR = "valor";

/** Texto comparável: sem BOM, sem acento, minúsculo, aparado. */
export function normalizarTextoCsv(v) {
  return String(v ?? "").replace(/^﻿/, "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

/** "SIM" -> true, "NÃO"/"NAO" -> false (caixa e acento indiferentes); qualquer outra coisa -> null. */
export function interpretarImpactoNoRepasse(v) {
  const n = normalizarTextoCsv(v);
  if (n === "sim") return true;
  if (n === "nao") return false;
  return null;
}

/**
 * Célula numérica do CSV -> CENTAVOS (inteiro), ou null. Aceita "1234.56",
 * "-12,50", "1.234,56", "1,234.56": o separador decimal é o ÚLTIMO entre
 * ponto e vírgula; o outro é milhar. Centavos inteiros evitam ruído de ponto
 * flutuante ao somar milhares de linhas.
 */
export function valorCsvEmCentavos(v) {
  let t = String(v ?? "").trim().replace(/\s|R\$/g, "");
  if (!t) return null;
  const ultimoPonto = t.lastIndexOf(".");
  const ultimaVirgula = t.lastIndexOf(",");
  if (ultimoPonto >= 0 && ultimaVirgula >= 0) {
    t = ultimaVirgula > ultimoPonto ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  } else if (ultimaVirgula >= 0) {
    t = t.replace(",", ".");
  }
  if (!/^[-+]?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const centavosParaReais = (c) => c / 100;

/**
 * Resumo do impacto no repasse sobre TODAS as linhas de dado (não só as
 * exibidas na tabela). PURA.
 * @param {string[]} colunas cabeçalho como veio
 * @param {string[][]} linhasCampos campos de cada linha de dado
 */
export function resumirImpactoNoRepasse(colunas, linhasCampos) {
  const idxImpacto = colunas.findIndex((c) => normalizarTextoCsv(c) === COLUNA_IMPACTO);
  const idxValor = colunas.findIndex((c) => normalizarTextoCsv(c) === COLUNA_VALOR);
  const r = {
    colunaImpactoEncontrada: idxImpacto >= 0,
    colunaValorEncontrada: idxValor >= 0,
    totalLinhas: linhasCampos.length,
    linhasComImpacto: 0,
    linhasSemImpacto: 0,
    linhasImpactoNaoInformado: 0,
    linhasValorInvalido: 0,
    totalBruto: null,
    totalComImpacto: null,
    totalSemImpacto: null,
  };
  let bruto = 0;
  let comImpacto = 0;
  let semImpacto = 0;
  for (const campos of linhasCampos) {
    const impacto = idxImpacto >= 0 ? interpretarImpactoNoRepasse(campos[idxImpacto]) : null;
    if (impacto === true) r.linhasComImpacto += 1;
    else if (impacto === false) r.linhasSemImpacto += 1;
    else r.linhasImpactoNaoInformado += 1;
    if (idxValor < 0) continue;
    const c = valorCsvEmCentavos(campos[idxValor]);
    if (c === null) { r.linhasValorInvalido += 1; continue; }
    bruto += c;
    if (impacto === true) comImpacto += c;
    else if (impacto === false) semImpacto += c;
  }
  if (idxValor >= 0) {
    r.totalBruto = centavosParaReais(bruto);
    // Sem a coluna de impacto não há como separar — null, nunca "R$ 0 com impacto".
    r.totalComImpacto = idxImpacto >= 0 ? centavosParaReais(comImpacto) : null;
    r.totalSemImpacto = idxImpacto >= 0 ? centavosParaReais(semImpacto) : null;
  }
  return r;
}

/**
 * Descompacta (se gzip) e faz o parse de um arquivo de conciliação em bytes
 * brutos. PURA no sentido de não fazer rede/disco — só transforma o Buffer
 * já baixado (por ifoodFinancial.download.js).
 * @param {Buffer} bufferBruto
 * @returns {{colunas: string[], linhas: object[], totalLinhas: number, truncado: boolean, eraGzip: boolean, delimitador: string|null, resumoRepasse: object}}
 */
export function parsearArquivoConciliacao(bufferBruto) {
  const { conteudo, eraGzip } = descompactarArquivoConciliacao(bufferBruto);

  const texto = conteudo.toString("utf8").replace(/^﻿/, "");
  const linhasBrutas = texto.split(/\r\n|\n|\r/).filter((l) => l.length > 0);
  // Sem nenhuma linha, não há o que detectar (delimitador precisa de uma
  // primeira linha pra contar vírgulas/ponto-e-vírgulas) — null, nunca um
  // valor chutado.
  if (linhasBrutas.length === 0) {
    return { colunas: [], linhas: [], totalLinhas: 0, truncado: false, eraGzip, delimitador: null, resumoRepasse: resumirImpactoNoRepasse([], []) };
  }

  const delimitador = detectarDelimitador(linhasBrutas[0]);
  const colunas = parsearLinhaCsv(linhasBrutas[0], delimitador);

  // Todas as linhas são parseadas (o resumo cobre o arquivo inteiro); só a
  // TABELA é cortada no teto de exibição.
  const camposPorLinha = linhasBrutas.slice(1).map((linhaTexto) => parsearLinhaCsv(linhaTexto, delimitador));
  const truncado = camposPorLinha.length > IFOOD_RECONCILIATION_ARQUIVO.maxLinhasExibidas;
  const linhas = camposPorLinha.slice(0, IFOOD_RECONCILIATION_ARQUIVO.maxLinhasExibidas).map((campos) => {
    const linha = {};
    colunas.forEach((col, i) => { linha[col] = campos[i] ?? null; });
    return linha;
  });

  return {
    colunas, linhas, totalLinhas: camposPorLinha.length, truncado, eraGzip, delimitador,
    resumoRepasse: resumirImpactoNoRepasse(colunas, camposPorLinha),
  };
}
