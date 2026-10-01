// Constantes da integração oficial iFood.
//
// "Configuração de protocolo" mora aqui. Nenhum valor de negócio (clientId,
// clientSecret, merchantId, token) é fixado — eles vêm de ENV ou da própria
// API, sempre.
//
// A base URL é lida de process.env DIRETO (com default), não de config/env.js:
// mantém este módulo — e os testes do http client — desacoplados do resto da
// configuração. Um teste pode apontar IFOOD_API_BASE_URL para um mock.

export const IFOOD_API_BASE_URL_PADRAO = "https://merchant-api.ifood.com.br";

export function ifoodBaseUrl() {
  return (process.env.IFOOD_API_BASE_URL || IFOOD_API_BASE_URL_PADRAO).replace(/\/+$/, "");
}

// Rotas confirmadas (ver brief da integração). Merchant só é consumido em
// modo LEITURA nesta fase — nada de interrupções / opening-hours / preparo.
//
// Financial (Fase 2 — Homologação): confirmado em 2026-09-12 contra a
// Referência de API oficial (Swagger) em
// https://developer.ifood.com.br/pt-BR/docs/references — servidor
// "Financial v3.0": https://merchant-api.ifood.com.br/financial/v3.0.
// O guia narrativo ("Guias de documentação" > Financial > API Sales) diverge
// da Referência de API em dois pontos — a Referência (spec executável,
// "Try it out") venceu em ambos:
//   * paginação: guia diz zero-indexed (padrão 0); Referência diz
//     "The first page is 1" e o exemplo de resposta mostra page:1.
//   * envelope da resposta 200: o guia mostra um objeto plano; a Referência
//     mostra um ARRAY contendo esse mesmo objeto — ifoodFinancial.mapper.js
//     aceita as duas formas defensivamente.
// `size` NÃO é parâmetro de request desta API (fixo em 100 no servidor,
// conforme "Referência de campos" do módulo Financial) — por isso não há
// query param de tamanho de página aqui.
//
// PENDÊNCIA DE VALIDAÇÃO REAL (registrada em 2026-09-12, ainda não
// confirmada contra o primeiro request real ao ambiente de homologação):
//   1. paginação de Sales é de fato 1-indexed?
//   2. o envelope real é objeto OU array-com-objeto?
// Se o retorno real divergir, ajuste SÓ isto (esta função + o
// desembrulharEnvelopeSales de ifoodFinancial.mapper.js) — nunca a
// arquitetura do service/controller/rotas.
//
// Financial Events (Fase 2, incremento 2): mesmo servidor/versão. Path e
// parâmetros confirmados em 2026-09-12 contra a MESMA Referência de API —
// aqui page 1-indexed e size=100 (padrão) NÃO divergem do guia narrativo.
// `idSaldo` (filtro alternativo por período de apuração de saldo) existe na
// spec mas sua semântica não está documentada o suficiente para eu montar
// UI/validação em cima — fica de fora deste incremento, só registrado aqui.
export const IFOOD_ROTAS = {
  userCode: "/authentication/v1.0/oauth/userCode",
  token: "/authentication/v1.0/oauth/token",
  merchants: (page = 1, size = 100) =>
    `/merchant/v1.0/merchants?page=${encodeURIComponent(page)}&size=${encodeURIComponent(size)}`,
  merchant: (merchantId) => `/merchant/v1.0/merchants/${encodeURIComponent(merchantId)}`,
  merchantStatus: (merchantId) => `/merchant/v1.0/merchants/${encodeURIComponent(merchantId)}/status`,
  // GET /financial/v3.0/merchants/{merchantId}/sales?beginSalesDate=&endSalesDate=&page=
  financialSales: (merchantId, beginSalesDate, endSalesDate, page = 1) =>
    `/financial/v3.0/merchants/${encodeURIComponent(merchantId)}/sales`
    + `?beginSalesDate=${encodeURIComponent(beginSalesDate)}`
    + `&endSalesDate=${encodeURIComponent(endSalesDate)}`
    + `&page=${encodeURIComponent(page)}`,
  // GET /financial/v3.0/merchants/{merchantId}/financial-events?beginDate=&endDate=&page=&size=
  financialEvents: (merchantId, beginDate, endDate, page = 1, size = 100) =>
    `/financial/v3.0/merchants/${encodeURIComponent(merchantId)}/financial-events`
    + `?beginDate=${encodeURIComponent(beginDate)}`
    + `&endDate=${encodeURIComponent(endDate)}`
    + `&page=${encodeURIComponent(page)}`
    + `&size=${encodeURIComponent(size)}`,
  // GET /financial/v3.0/merchants/{merchantId}/settlements — confirmado em
  // 2026-09-12 direto no Swagger (portal exigiu CAPTCHA; usuário colou o
  // bloco Parameters + Example Value). SEM paginação (nem no request nem na
  // resposta — diferente de Sales/Events). Dois pares de data MUTUAMENTE
  // EXCLUSIVOS, um obrigatório:
  //   modo "calculo"   -> beginCalculationDate/endCalculationDate (período de
  //                       liquidação/apuração, semana segunda-domingo)
  //   modo "pagamento" -> beginPaymentDate/endPaymentDate (data em que o
  //                       título foi efetivamente pago)
  // Sem limite de dias documentado como regra dura aqui (a "Referência de
  // campos" só recomenda informalmente 30-90 dias) — não valido como erro.
  financialSettlements: (merchantId, modo, inicio, fim) => {
    const par = modo === "pagamento"
      ? `beginPaymentDate=${encodeURIComponent(inicio)}&endPaymentDate=${encodeURIComponent(fim)}`
      : `beginCalculationDate=${encodeURIComponent(inicio)}&endCalculationDate=${encodeURIComponent(fim)}`;
    return `/financial/v3.0/merchants/${encodeURIComponent(merchantId)}/settlements?${par}`;
  },
  // GET /financial/v3.0/merchants/{merchantId}/reconciliation?competence=yyyy-MM
  // Confirmado em 2026-09-12 direto no Swagger. Resposta 200 é array com 1
  // objeto {downloadPath, createdAt, metadata:{...snake_case...}} — o
  // arquivo em si NÃO vem no corpo, só uma URL assinada pra baixar à parte
  // (ifoodFinancial.download.js cuida disso). Sem paginação.
  financialReconciliation: (merchantId, competence) =>
    `/financial/v3.0/merchants/${encodeURIComponent(merchantId)}/reconciliation?competence=${encodeURIComponent(competence)}`,
  // POST /financial/v3.0/merchants/{merchantId}/reconciliation/on-demand
  // Corpo JSON {competence}. Resposta 200 (NÃO 202) com {competence,
  // merchantId, requestId}. 409 se já houver solicitação recente pendente
  // pra mesma competência (ver ifood.errors.js, contexto "reconciliation").
  // Events (Checkpoint B) — confirmado no portal iFood em 2026-09-27 (Events > Polling de eventos).
  // GET  /events/v1.0/events:polling        (200 = lista, 204 = vazio)  header x-polling-merchants
  // POST /events/v1.0/events/acknowledgment (202)  corpo: [{ "id": "..." }]
  eventsPolling: "/events/v1.0/events:polling",
  eventsAck: "/events/v1.0/events/acknowledgment",
  // Order (Checkpoint C) — portal iFood, Order > Endpoints / Detalhes de pedido / Guia de implementação (2026-09-27):
  // GET  /order/v1.0/orders/{id}          200 = detalhes · 404 = inválido/indisponível ainda/antigo (>7 dias)
  // POST /order/v1.0/orders/{id}/confirm  202 {"status":"ACCEPTED"} · obrigatório em até 8 min · resultado = evento CONFIRMED
  orderDetalhes: (orderId) => `/order/v1.0/orders/${encodeURIComponent(orderId)}`,
  orderConfirm: (orderId) => `/order/v1.0/orders/${encodeURIComponent(orderId)}/confirm`,
  // Checkpoint D — portal iFood, Order > Endpoints / Guia de implementação / Cancelamento / Plataforma de negociação (2026-09-27):
  // POST .../{id}/readyToPickup      202 {"status":"ACCEPTED"} — TAKEOUT, DINE_IN e DELIVERY
  // POST .../{id}/dispatch           202 — só DELIVERY com entrega própria (deliveredBy=MERCHANT), DEPOIS do readyToPickup
  // GET  .../{id}/cancellationReasons 200 {reasons:[{code,description}]} · 204 = nenhuma política
  // POST .../{id}/requestCancellation body {"reason":"<code>"} 202 · resultado = evento CANCELLED ou CANCELLATION_REQUEST_FAILED
  // POST .../disputes/{id}/accept|reject|alternative (Handshake) 201 {id,status,disputeId}
  orderReadyToPickup: (orderId) => `/order/v1.0/orders/${encodeURIComponent(orderId)}/readyToPickup`,
  orderDispatch: (orderId) => `/order/v1.0/orders/${encodeURIComponent(orderId)}/dispatch`,
  orderCancellationReasons: (orderId) => `/order/v1.0/orders/${encodeURIComponent(orderId)}/cancellationReasons`,
  orderRequestCancellation: (orderId) => `/order/v1.0/orders/${encodeURIComponent(orderId)}/requestCancellation`,
  disputeAccept: (disputeId) => `/order/v1.0/disputes/${encodeURIComponent(disputeId)}/accept`,
  disputeReject: (disputeId) => `/order/v1.0/disputes/${encodeURIComponent(disputeId)}/reject`,
  disputeAlternative: (disputeId) => `/order/v1.0/disputes/${encodeURIComponent(disputeId)}/alternative`,
  financialReconciliationOnDemand: (merchantId) =>
    `/financial/v3.0/merchants/${encodeURIComponent(merchantId)}/reconciliation/on-demand`,
  // GET .../reconciliation/on-demand/{requestId} — consulta o status.
  // status confirmado (4 valores, exemplos reais da Referência de API):
  //   "created"   -> aceito, ainda não começou
  //   "enqueue"   -> na fila de processamento
  //   "processed" -> pronto — SÓ agora a resposta traz `downloadPath`
  //                  (URL assinada da AWS S3, X-Amz-Expires=86400 = 24h)
  //   "error"     -> falhou — resposta traz `message` com o motivo
  // 404 se requestId não existir OU tiver expirado (TTL de 24h, igual ao
  // downloadPath — "Referência de campos" já documentava isso).
  financialReconciliationOnDemandStatus: (merchantId, requestId) =>
    `/financial/v3.0/merchants/${encodeURIComponent(merchantId)}/reconciliation/on-demand/${encodeURIComponent(requestId)}`,
  // GET /financial/v3.0/merchants/{merchantId}/anticipations — confirmado em
  // 2026-09-12 direto no Swagger (mesmo processo: CAPTCHA bloqueou a
  // navegação automatizada, usuário colou Parameters + Example Value).
  // MESMO par de datas mutuamente exclusivo de Settlements (mesmos nomes de
  // parâmetro: beginCalculationDate/endCalculationDate OU
  // beginAnticipatedPaymentDate/endAnticipatedPaymentDate). SEM paginação no
  // exemplo real — diverge da "Referência de campos", que genericamente
  // listava page/size pra esta API (mesmo tipo de divergência já visto em
  // Settlements).
  financialAnticipations: (merchantId, modo, inicio, fim) => {
    const par = modo === "pagamento"
      ? `beginAnticipatedPaymentDate=${encodeURIComponent(inicio)}&endAnticipatedPaymentDate=${encodeURIComponent(fim)}`
      : `beginCalculationDate=${encodeURIComponent(inicio)}&endCalculationDate=${encodeURIComponent(fim)}`;
    return `/financial/v3.0/merchants/${encodeURIComponent(merchantId)}/anticipations?${par}`;
  },
};

// Config do download+parse do arquivo de conciliação (downloadPath). Não é
// contrato do iFood — são limites MEUS de engenharia, documentados como tal:
//   * o arquivo pode vir .csv puro OU gzip (detecção por magic bytes, nunca
//     pela extensão da URL — a doc de homologação fala em CSV.gz, mas o
//     exemplo real do on-demand mostra uma URL terminando em .csv puro);
//   * teto de tamanho por segurança (arquivo de conciliação é um relatório
//     mensal, não deveria chegar perto disso — mas nunca baixar sem teto);
//   * encoding assumido UTF-8, delimitador (`,` ou `;`) detectado pela
//     primeira linha — NENHUM dos dois é documentado pelo iFood em lugar
//     nenhum que eu tenha encontrado (nem guia, nem Swagger, nem Referência
//     de campos) — ver ifoodFinancial.mapper.js#parsearArquivoConciliacao.
export const IFOOD_RECONCILIATION_ARQUIVO = {
  timeoutMs: 30_000,
  maxBytesDownload: 20 * 1024 * 1024,        // teto do download bruto (antes de descompactar)
  maxBytesDescompactado: 50 * 1024 * 1024,   // teto depois do gunzip — corta em vez de estourar memória
  maxLinhasExibidas: 2000, // a UI não tenta renderizar um CSV de 100k linhas
};

// Limites de período por API Financial, confirmados na documentação oficial
// (página "Referência de campos" do módulo Financial + troubleshooting de
// cada API). Cada API tem o seu próprio teto — não presuma um valor comum.
export const IFOOD_FINANCIAL_LIMITES = {
  sales: { maxDias: 90 },
  events: { maxDias: 33 },
};

// Os dois aplicativos distribuídos. `analytics` PODE ser autorizado nesta
// fase, mas nenhum dado de Analytics é consumido.
export const IFOOD_APPS = Object.freeze({ ANALYTICS: "analytics", FINANCIAL: "financial" });
export const IFOOD_APP_TYPES = Object.freeze(Object.values(IFOOD_APPS));

// App das APIs de negócio Events/Order. Events/Order trabalham com `appType = order` e pedem o token
// pelo Auth Provider — NUNCA emprestam o token do `financial`. O banco aceita `order` em app_type
// (CHECK ampliado pela migration 101); mas ele ainda NÃO é um app de OAuth exposto à UI/status/validadores
// (por isso fora de IFOOD_APP_TYPES): no modo distribuído, `order` só terá credencial quando o app real existir;
// no centralized_test usa o token do app centralizado (Teste (C)), sem credencial persistida por unidade.
export const IFOOD_APP_ORDER = "order";
export const IFOOD_APP_TYPES_PERSISTIVEIS = Object.freeze([...IFOOD_APP_TYPES, IFOOD_APP_ORDER]);

// grantType do corpo x-www-form-urlencoded (camelCase, conforme o iFood).
export const IFOOD_GRANT = Object.freeze({
  AUTHORIZATION_CODE: "authorization_code",
  REFRESH_TOKEN: "refresh_token",
  // SÓ do modo temporário CENTRALIZED_TEST (app centralizado de teste).
  // O produto usa o fluxo DISTRIBUÍDO (authorization_code + refresh_token).
  CLIENT_CREDENTIALS: "client_credentials",
});

export const IFOOD_HTTP = {
  timeoutMs: 20_000,           // AbortController por chamada
  maxTentativas: 3,            // só para 5xx / rede / 429-com-Retry-After
  backoffBaseMs: 700,
  maxRetryAfterMs: 30_000,     // teto do respeito ao Retry-After (não trava a request)
  maxRespostaBytes: 4 * 1024 * 1024,
  pageSizePadrao: 100,        // GET /merchants
  pageSizeMax: 200,
  // Teto de páginas percorridas em GET /merchants — trava contra loop se a
  // API nunca sinalizar "última página". 50 * 100 = 5000 lojas.
  maxPaginas: 50,
};

// Renovação de token: se faltar MENOS que isto para expirar, renova antes de usar.
export const IFOOD_TOKEN = {
  margemRenovacaoMs: 10 * 60 * 1000,   // 10 min
  // accessToken do iFood normalmente expira em 21600s (6h) — usado só como
  // fallback se a resposta vier sem expiresIn.
  expiresInPadraoS: 21_600,
};

// Sessão OAuth (userCode) expira em ~10 min no iFood. Guardamos o mesmo teto
// como fallback caso a resposta venha sem expiresIn.
export const IFOOD_OAUTH = {
  ttlPadraoS: 600,
};

// Rate limit das rotas que iniciam/concluem autorização.
export const IFOOD_RATE_LIMIT = {
  janelaMs: 60_000,
  maxStart: 5,
  maxComplete: 10,
  maxMerchants: 20,   // descoberta/detalhe de merchant (chamam a API externa)
  maxFinancial: 20,   // leituras Financial (Sales/Events/Settlements/... — chamam a API externa)
};

// Events (polling + ACK) — valores da documentação oficial + escolhas conservadoras nossas.
export const IFOOD_EVENTS = {
  // Doc: "Execute polling a cada 30 segundos" (mantém a loja online; rate limit 6000 RPM/token).
  intervaloPollingMs: 30_000,
  intervaloMinimoMs: 30_000,            // NUNCA abaixo disso, nem por configuração
  maxMerchantsPorPolling: 100,          // header x-polling-merchants: máximo 100 por requisição
  // Guia: "até 2000 IDs por requisição" (a referência diz 10000) — usamos o menor.
  maxIdsPorAck: 2000,
  leaseNome: "ifood-events-poller",
  leaseTtlS: 90,                        // 3 ciclos: se o worker cair, outro assume em <= 90 s
  // Fencing do ACK: cada lote de ACK só pode SAIR até (renovação do lease + TTL - esta margem). Um ACK com retries
  // (3 x 20 s + Retry-After de até 30 s) poderia passar do TTL; o prazo garante que esta instância nunca reconhece
  // depois que outra já pode ter assumido o lease.
  margemFencingAckMs: 15_000,
  maxTentativasProcessamento: 5,        // reprocessamento de eventos FALHOU (retry_count)
  backoffMaxMs: 5 * 60_000,             // erro repetido: espera crescente, teto de 5 min
  // Doc (throttling): 429 = polling bloqueado por 5 min quando há eventos sem ACK.
  espera429Ms: 60_000,
};

// Order (detalhes + confirm) — valores da documentação oficial.
export const IFOOD_ORDER = {
  slaConfirmacaoMs: 8 * 60_000,          // "Confirme o recebimento em 8 minutos"
  detalhesRetencaoDias: 7,               // a API mantém os detalhes por 7 dias — não consultar pedido mais antigo
  // O evento PLACED pode chegar ANTES dos detalhes (404): retry com backoff exponencial por até 10 min.
  detalhesJanelaRetentativasMs: 10 * 60_000,
  detalhesBackoffBaseMs: 2_000,
  detalhesBackoffMaxMs: 120_000,
  detalhesPorCiclo: 10,                  // no máximo N consultas de detalhes por ciclo de polling (rate limit)
  maxTentativasDetalhes: 12,
  // Checkpoint D
  reenvioIncertoAposMs: 3 * 60_000,      // ação com resultado INCERTO (timeout): só pode ser reenviada, explicitamente, depois disto
  sendingReassumivelMs: 30_000,          // <acao>_sending mais velho que isto = quem enviou provavelmente caiu
};
