// Checkpoint SALES READ-ONLY — lacunas de cobertura de listarSales + parser.
// Complementa ifood-financial-service.test.js / ifood-financial-mapper.test.js.
// Zero rede real: o http client REAL roda sobre um fetch falso (erros HTTP,
// retry, timeout e logs exercitados de verdade); repo e credenciais em memória.
import test from "node:test";
import assert from "node:assert/strict";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-client-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-client-secret";

const financial = await import("../src/modules/ifood/ifoodFinancial.service.js");
const httpClient = await import("../src/modules/ifood/ifoodHttp.client.js");
const { mapearRespostaSales } = await import("../src/modules/ifood/ifoodFinancial.mapper.js");
const { IFOOD_ERROS } = await import("../src/modules/ifood/ifood.errors.js");
const { cifrar } = await import("../src/shared/cripto.js");

const MERCHANT_A = "55c8f464-e65f-4340-b2c7-62d143027040";
const MERCHANT_B = "11111111-2222-3333-4444-555555555555";
const TENANT_A = { organizacaoId: "org-A", unidadeId: "uni-A" };
const TENANT_B = { organizacaoId: "org-B", unidadeId: "uni-B" };
const PERIODO = { inicio: "2026-09-29", fim: "2026-09-29" };
const daquiA = (ms) => new Date(Date.now() + ms).toISOString();

function credValida() {
  return { access_token_cifrado: cifrar("AT-atual"), refresh_token_cifrado: cifrar("RT-atual"), expira_em: daquiA(60 * 60 * 1000), status: "ativa" };
}

/** Repo em memória, por unidade. Registra TODA chamada (nome do método + args). */
function repoPorUnidade(conexoes, credPorConexao = {}) {
  const chamadas = [];
  const creds = { ...credPorConexao };
  const alvo = {
    async obterConexaoViva({ organizacaoId, unidadeId }) {
      const c = conexoes[unidadeId];
      return c && c.organizacao_id === organizacaoId ? c : null;
    },
    async obterCredencial({ conexaoId }) { return conexaoId in creds ? (creds[conexaoId] ? { ...creds[conexaoId] } : null) : credValida(); },
    async salvarCredencial(a) {
      creds[a.conexaoId] = { access_token_cifrado: a.accessTokenCifrado, refresh_token_cifrado: a.refreshTokenCifrado, expira_em: a.expiraEm, status: "ativa" };
      return creds[a.conexaoId];
    },
    async atualizarCredencial({ conexaoId, campos }) { creds[conexaoId] = { ...creds[conexaoId], ...campos }; return creds[conexaoId]; },
  };
  const repo = new Proxy(alvo, {
    get(t, nome) {
      if (typeof t[nome] !== "function") return t[nome];
      return (...args) => { chamadas.push({ nome, args }); return t[nome](...args); };
    },
  });
  return { repo, chamadas };
}

const CONEXOES = {
  "uni-A": { id: "conx-A", organizacao_id: "org-A", unidade_id: "uni-A", status: "ativa", merchant_id: MERCHANT_A },
  "uni-B": { id: "conx-B", organizacao_id: "org-B", unidade_id: "uni-B", status: "ativa", merchant_id: MERCHANT_B },
};

function resposta(status, corpo, headers = {}) {
  const h = new Map(Object.entries({ "content-type": "application/json", ...headers }));
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, text: async () => (corpo === undefined ? "" : JSON.stringify(corpo)) };
}

/** fetch falso: `rotas(url, init, n)` devolve a resposta; registra método, url e headers. */
function fetchFalso(rotas) {
  const chamadas = [];
  const fn = async (url, init) => {
    chamadas.push({ url, metodo: init.method, headers: init.headers });
    return rotas(url, init, chamadas.length);
  };
  fn.chamadas = chamadas;
  return fn;
}

/** http REAL (ifoodHttp.client) com o fetch falso injetado. */
function httpReal(fetchImpl) {
  return {
    getJson: (c, o) => httpClient.getJson(c, { ...o, fetchImpl }),
    postForm: (c, campos, o) => httpClient.postForm(c, campos, { ...(o ?? {}), fetchImpl }),
  };
}

const ehToken = (url) => url.includes("/authentication/");
const TOKEN_OK = { accessToken: "AT-renovado", refreshToken: "RT-renovado", expiresIn: 10800 };

function venda(over = {}) {
  return {
    id: "a1b2c3d4-0000-0000-0000-000000000001", shortId: "1001", createdAt: "2026-09-29T15:00:00.000Z",
    type: "ORDER", category: "FOOD", salesChannel: "IFOOD", currentStatus: "CONCLUDED",
    merchant: { id: MERCHANT_A, shortId: 4078865, name: "Loja", type: "RESTAURANT", timezone: "Etc/GMT+3", documents: [] },
    saleGrossValue: { bag: 40, deliveryFee: 5, serviceFee: 0.99 },
    billingSummary: { saleBalance: 36.4, billingEntries: [{ name: "ORDER_PAYMENT", value: 45.99 }, { name: "ORDER_COMMISSION", value: -9.59 }] },
    ...over,
  };
}
const envelope = (sales, over = {}) => [{ page: 1, size: sales.length, beginSalesDate: "2026-09-29", endSalesDate: "2026-09-29", sales, total: sales.length, pageCount: sales.length ? 1 : 0, ...over }];

function capturarConsole() {
  const linhas = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => linhas.push(a.map(String).join(" "));
  return { linhas, restaurar: () => Object.assign(console, orig) };
}

const chamar = (tenant, deps, extra = {}) => financial.listarSales({ ...tenant, ...PERIODO, ...extra, deps });

// ---------------------------------------------------------------------------
// token
// ---------------------------------------------------------------------------
test("[2] token ausente (sem credencial financial) -> IFOOD_CREDENCIAL_NAO_ENCONTRADA, nenhuma chamada ao iFood", async () => {
  const f = fetchFalso(() => resposta(200, envelope([])));
  const { repo } = repoPorUnidade(CONEXOES, { "conx-A": null });
  await assert.rejects(() => chamar(TENANT_A, { repo, http: httpReal(f) }), (e) => e.codigo === IFOOD_ERROS.IFOOD_CREDENCIAL_NAO_ENCONTRADA);
  assert.equal(f.chamadas.length, 0);
});

test("[2b] credencial em reauth_required -> IFOOD_REFRESH_FALHOU, nenhuma chamada ao iFood", async () => {
  const f = fetchFalso(() => resposta(200, envelope([])));
  const { repo } = repoPorUnidade(CONEXOES, { "conx-A": { ...credValida(), status: "reauth_required" } });
  await assert.rejects(() => chamar(TENANT_A, { repo, http: httpReal(f) }), (e) => e.codigo === IFOOD_ERROS.IFOOD_REFRESH_FALHOU);
  assert.equal(f.chamadas.length, 0);
});

test("[3] token expirado pelo relógio -> refresh existente (1 POST de OAuth) e a leitura usa o token NOVO", async () => {
  const f = fetchFalso((url) => (ehToken(url) ? resposta(200, TOKEN_OK) : resposta(200, envelope([venda()]))));
  const { repo } = repoPorUnidade(CONEXOES, { "conx-A": { ...credValida(), expira_em: daquiA(-60_000) } });
  const r = await chamar(TENANT_A, { repo, http: httpReal(f) });
  assert.equal(r.vendas.length, 1);
  const [oauth, leitura] = f.chamadas;
  assert.ok(ehToken(oauth.url) && oauth.metodo === "POST");
  assert.equal(leitura.headers.Authorization, "Bearer AT-renovado");
});

test("[11] 401 real do iFood -> 1 refresh + 1 repetição; 401 de novo propaga IFOOD_TOKEN_EXPIRADO sem loop", async () => {
  const f = fetchFalso((url) => (ehToken(url) ? resposta(200, TOKEN_OK) : resposta(401, { message: "unauthorized" })));
  const { repo } = repoPorUnidade(CONEXOES);
  await assert.rejects(() => chamar(TENANT_A, { repo, http: httpReal(f) }), (e) => e.codigo === IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO);
  const leituras = f.chamadas.filter((c) => !ehToken(c.url));
  assert.equal(leituras.length, 2);
  assert.equal(f.chamadas.filter((c) => ehToken(c.url)).length, 1);
});

// ---------------------------------------------------------------------------
// merchant / tenant
// ---------------------------------------------------------------------------
test("[5] merchant de OUTRA unidade nunca é consultado: a unidade A só enxerga o merchant da própria conexão", async () => {
  const f = fetchFalso(() => resposta(200, envelope([])));
  const { repo } = repoPorUnidade(CONEXOES);
  await chamar(TENANT_A, { repo, http: httpReal(f) }, { merchantId: MERCHANT_B });
  assert.equal(f.chamadas.length, 1);
  assert.ok(f.chamadas[0].url.includes(`/merchants/${MERCHANT_A}/sales`));
  assert.ok(!f.chamadas[0].url.includes(MERCHANT_B));
});

test("[5b] unidade de outra organização (organizacaoId não bate) -> IFOOD_CONEXAO_NAO_ENCONTRADA, sem chamada", async () => {
  const f = fetchFalso(() => resposta(200, envelope([])));
  const { repo } = repoPorUnidade(CONEXOES);
  await assert.rejects(
    () => chamar({ organizacaoId: "org-A", unidadeId: "uni-B" }, { repo, http: httpReal(f) }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_CONEXAO_NAO_ENCONTRADA,
  );
  assert.equal(f.chamadas.length, 0);
});

test("[19] isolamento multi-tenant: cada tenant consulta só o próprio merchant, com o próprio token", async () => {
  const f = fetchFalso(() => resposta(200, envelope([])));
  const { repo, chamadas } = repoPorUnidade(CONEXOES, {
    "conx-A": { ...credValida(), access_token_cifrado: cifrar("AT-A") },
    "conx-B": { ...credValida(), access_token_cifrado: cifrar("AT-B") },
  });
  await chamar(TENANT_A, { repo, http: httpReal(f) });
  await chamar(TENANT_B, { repo, http: httpReal(f) });
  assert.ok(f.chamadas[0].url.includes(MERCHANT_A) && f.chamadas[0].headers.Authorization === "Bearer AT-A");
  assert.ok(f.chamadas[1].url.includes(MERCHANT_B) && f.chamadas[1].headers.Authorization === "Bearer AT-B");
  const conexoesPedidas = chamadas.filter((c) => c.nome === "obterConexaoViva").map((c) => c.args[0]);
  assert.deepEqual(conexoesPedidas, [TENANT_A, TENANT_B]);
});

// ---------------------------------------------------------------------------
// respostas
// ---------------------------------------------------------------------------
test("[8] múltiplas vendas: todas normalizadas, ordem preservada, total/pageCount repassados", async () => {
  const sales = [1, 2, 3].map((n) => venda({ id: `id-${n}`, shortId: String(n) }));
  const f = fetchFalso(() => resposta(200, envelope(sales, { total: 3, pageCount: 1 })));
  const { repo } = repoPorUnidade(CONEXOES);
  const r = await chamar(TENANT_A, { repo, http: httpReal(f) });
  assert.deepEqual(r.vendas.map((v) => v.id), ["id-1", "id-2", "id-3"]);
  assert.equal(r.pagina.total, 3);
  assert.equal(r.pagina.totalPaginas, 1);
});

test("[9] paginação: consulta UMA página só (sem percorrer as demais) e expõe totalPaginas para decisão manual", async () => {
  const f = fetchFalso(() => resposta(200, envelope([venda()], { size: 100, total: 250, pageCount: 3 })));
  const { repo } = repoPorUnidade(CONEXOES);
  const r = await chamar(TENANT_A, { repo, http: httpReal(f) });
  assert.equal(f.chamadas.length, 1);
  assert.match(f.chamadas[0].url, /page=1$/);
  assert.equal(r.pagina.totalPaginas, 3);
  assert.equal(r.pagina.total, 250);
});

test("[10] 400 real -> IFOOD_REQUISICAO_INVALIDA, sem retry", async () => {
  const f = fetchFalso(() => resposta(400, { message: "bad request" }));
  const { repo } = repoPorUnidade(CONEXOES);
  await assert.rejects(() => chamar(TENANT_A, { repo, http: httpReal(f) }), (e) => e.codigo === IFOOD_ERROS.IFOOD_REQUISICAO_INVALIDA);
  assert.equal(f.chamadas.length, 1);
});

test("[12] 403 real -> IFOOD_MERCHANT_SEM_PERMISSAO com mensagem de dados financeiros, sem retry", async () => {
  const f = fetchFalso(() => resposta(403, { message: "forbidden" }));
  const { repo } = repoPorUnidade(CONEXOES);
  await assert.rejects(
    () => chamar(TENANT_A, { repo, http: httpReal(f) }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO && /financeiros/.test(e.message),
  );
  assert.equal(f.chamadas.length, 1);
});

test("[13] 429 real -> retry limitado (3 tentativas) e depois IFOOD_RATE_LIMITED", async () => {
  const f = fetchFalso(() => resposta(429, {}, { "retry-after": "0" }));
  const { repo } = repoPorUnidade(CONEXOES);
  await assert.rejects(() => chamar(TENANT_A, { repo, http: httpReal(f) }), (e) => e.codigo === IFOOD_ERROS.IFOOD_RATE_LIMITED);
  assert.equal(f.chamadas.length, 3);
});

test("[14] 500 real -> retry limitado (3 tentativas) e depois IFOOD_INDISPONIVEL", async () => {
  const f = fetchFalso(() => resposta(500, {}));
  const { repo } = repoPorUnidade(CONEXOES);
  await assert.rejects(() => chamar(TENANT_A, { repo, http: httpReal(f) }), (e) => e.codigo === IFOOD_ERROS.IFOOD_INDISPONIVEL);
  assert.equal(f.chamadas.length, 3);
});

test("[15] timeout (AbortError) -> retry limitado e depois IFOOD_INDISPONIVEL com motivo timeout", async () => {
  const f = fetchFalso(() => { const e = new Error("aborted"); e.name = "AbortError"; throw e; });
  const { repo } = repoPorUnidade(CONEXOES);
  await assert.rejects(
    () => chamar(TENANT_A, { repo, http: httpReal(f) }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_INDISPONIVEL && e.details?.motivo === "timeout",
  );
  assert.equal(f.chamadas.length, 3);
});

test("[16] payload incompleto (venda sem valores/billing/pagamentos, item null) não lança e não inventa valor", async () => {
  const f = fetchFalso(() => resposta(200, envelope([{ id: "x", merchant: { id: MERCHANT_A } }, null])));
  const { repo } = repoPorUnidade(CONEXOES);
  const r = await chamar(TENANT_A, { repo, http: httpReal(f) });
  assert.equal(r.vendas.length, 1, "item null não tem merchant: é descartado, nunca vira venda da loja");
  const [v] = r.vendas;
  assert.equal(v.id, "x");
  assert.equal(v.status, null);
  assert.equal(v.resumoFinanceiro, null);
  assert.deepEqual(v.pagamentos, []);
  assert.deepEqual(v.valorBruto, { itens: null, entrega: null, taxaServico: null, total: null });
  assert.deepEqual(r.validacao.merchant.recebidosDivergentes, ["ausente"]);
});

test("[16b] corpo 200 vazio / sem `sales` -> vendas:[] sem lançar", async () => {
  const f = fetchFalso(() => resposta(200, undefined));
  const { repo } = repoPorUnidade(CONEXOES);
  const r = await chamar(TENANT_A, { repo, http: httpReal(f) });
  assert.deepEqual(r.vendas, []);
});

// ---------------------------------------------------------------------------
// valores e datas
// ---------------------------------------------------------------------------
test("[17] valor monetário: reais decimais preservados (não centavos) e soma sem ruído de ponto flutuante", () => {
  const r = mapearRespostaSales(envelope([venda({ saleGrossValue: { bag: 0.1, deliveryFee: 0.2, serviceFee: 0 } }), venda({ saleGrossValue: { bag: 207.86, deliveryFee: 8.99, serviceFee: -0.99 } })]));
  assert.equal(r.vendas[0].valorBruto.total, 0.3);
  assert.equal(r.vendas[1].valorBruto.itens, 207.86);
  assert.equal(r.vendas[1].valorBruto.taxaServico, -0.99);
  assert.equal(r.vendas[1].valorBruto.total, 215.86);
  assert.equal(r.vendas[1].resumoFinanceiro.saldo, 36.4);
});

test("[18] datas/timezone: período vai à API sem conversão; createdAt (UTC) e begin/endSalesDate (fuso da loja) voltam intactos", async () => {
  const f = fetchFalso(() => resposta(200, envelope([venda({ createdAt: "2026-09-29T02:30:00.000Z" })])));
  const { repo } = repoPorUnidade(CONEXOES);
  const r = await chamar(TENANT_A, { repo, http: httpReal(f) });
  assert.match(f.chamadas[0].url, /beginSalesDate=2026-09-29&endSalesDate=2026-09-29&page=1$/);
  assert.equal(r.vendas[0].criadoEm, "2026-09-29T02:30:00.000Z");
  assert.deepEqual(r.periodo, { inicio: "2026-09-29", fim: "2026-09-29" });
  assert.equal(r.vendas[0].merchant.timezone, "Etc/GMT+3");
  // 02:30Z do dia 29 = 23:30 do dia 28 no fuso da loja -> fora do período pedido (29/09).
  assert.deepEqual(r.validacao.motivos, ["VENDAS_FORA_DO_PERIODO"]);
});

test("exemplo OFICIAL da Referência de API (pedido CANCELLED): valorBruto continua preenchido, saldo 0 — bruto NÃO é receita", () => {
  const cancelado = venda({
    currentStatus: "CANCELLED", saleGrossValue: { bag: 21, deliveryFee: 5, serviceFee: 0 },
    billingSummary: { saleBalance: 0, billingEntries: [] },
    orderStatusHistory: [{ value: "CANCELLED", createdAt: "2025-03-06T20:36:46.299Z", metadata: { cancelCode: "902", cancelOrigin: "SCHEDULER" } }],
  });
  const [v] = mapearRespostaSales(envelope([cancelado])).vendas;
  assert.equal(v.status, "CANCELLED");
  assert.equal(v.valorBruto.total, 26);
  assert.equal(v.resumoFinanceiro.saldo, 0);
  assert.deepEqual(v.resumoFinanceiro.lancamentos, []);
  assert.equal(v.historicoStatus[0].detalhe.cancelCode, "902");
});

test("exemplo OFICIAL do guia (envelope objeto, page 0, parcelado, benefícios): parser lê todos os blocos", () => {
  const r = mapearRespostaSales({
    page: 0, size: 15, beginSalesDate: "2025-02-20", endSalesDate: "2025-02-21", total: 1, pageCount: 1,
    sales: [venda({
      benefits: { benefits: [{ target: "DELIVERY_FEE", value: 8.99, sponsorships: [{ name: "CHAIN", value: 5 }, { name: "IFOOD", value: 3.99 }] }], totalValue: 8.99 },
      delivery: { type: "DELIVERY", deliveryParameters: { logisticProvider: "IFOOD_LOGISTICS" }, prices: { grossValue: 8.99, discount: 8.99, netValue: 0 } },
      payments: { methods: [{ method: "CREDIT", currency: "BRL", type: "ONLINE", value: 205.85, card: { brand: "MASTERCARD" }, installment: { maxInstallments: 3, installmentDetail: [{ reference: "1", amount: 68.61 }] }, liability: "IFOOD" }] },
    })],
  });
  assert.equal(r.pagina.atual, 0);
  const [v] = r.vendas;
  assert.equal(v.beneficios.valorTotal, 8.99);
  assert.deepEqual(v.beneficios.itens[0].patrocinadores.map((p) => p.nome), ["CHAIN", "IFOOD"]);
  assert.equal(v.entrega.precos.liquido, 0);
  assert.equal(v.pagamentos[0].responsavel, "IFOOD");
  assert.equal(v.pagamentos[0].parcelamento.maxParcelas, 3);
});

// ---------------------------------------------------------------------------
// garantias read-only
// ---------------------------------------------------------------------------
test("[20] nenhuma escrita no iFood: toda requisição ao iFood (fora do OAuth) é GET no endpoint de sales", async () => {
  const f = fetchFalso((url) => (ehToken(url) ? resposta(200, TOKEN_OK) : resposta(200, envelope([venda()]))));
  const { repo } = repoPorUnidade(CONEXOES, { "conx-A": { ...credValida(), expira_em: daquiA(-1) } });
  await chamar(TENANT_A, { repo, http: httpReal(f) });
  const naoOauth = f.chamadas.filter((c) => !ehToken(c.url));
  assert.ok(naoOauth.length >= 1);
  for (const c of naoOauth) {
    assert.equal(c.metodo, "GET");
    assert.match(c.url, /^https:\/\/mock\.ifood\.test\/financial\/v3\.0\/merchants\/[^/]+\/sales\?/);
  }
});

test("[21] nenhuma persistência involuntária: com token válido o repo só é LIDO", async () => {
  const f = fetchFalso(() => resposta(200, envelope([venda(), venda({ id: "outra" })])));
  const { repo, chamadas } = repoPorUnidade(CONEXOES);
  await chamar(TENANT_A, { repo, http: httpReal(f) });
  assert.deepEqual([...new Set(chamadas.map((c) => c.nome))].sort(), ["obterConexaoViva", "obterCredencial"]);
});

test("[21b] mesmo com refresh, a única escrita é a do próprio token (credencial) — nenhum dado de venda chega ao repo", async () => {
  const f = fetchFalso((url) => (ehToken(url) ? resposta(200, TOKEN_OK) : resposta(200, envelope([venda()]))));
  const { repo, chamadas } = repoPorUnidade(CONEXOES, { "conx-A": { ...credValida(), expira_em: daquiA(-1) } });
  await chamar(TENANT_A, { repo, http: httpReal(f) });
  const escritas = chamadas.filter((c) => !c.nome.startsWith("obter"));
  assert.ok(escritas.every((c) => c.nome === "salvarCredencial" || c.nome === "atualizarCredencial"));
  assert.ok(!JSON.stringify(escritas.map((c) => c.args)).includes("ORDER_PAYMENT"));
});

test("[22] nenhum token em log: sucesso, refresh e erro não vazam access/refresh token nem client secret", async () => {
  const cap = capturarConsole();
  try {
    const f1 = fetchFalso((url) => (ehToken(url) ? resposta(200, TOKEN_OK) : resposta(200, envelope([venda()]))));
    const { repo: r1 } = repoPorUnidade(CONEXOES, { "conx-A": { ...credValida(), expira_em: daquiA(-1) } });
    await chamar(TENANT_A, { repo: r1, http: httpReal(f1) });

    const f2 = fetchFalso(() => resposta(403, { message: "forbidden" }));
    const { repo: r2 } = repoPorUnidade(CONEXOES);
    await chamar(TENANT_A, { repo: r2, http: httpReal(f2) }).catch(() => {});
  } finally {
    cap.restaurar();
  }
  const log = cap.linhas.join("\n");
  assert.ok(log.includes("financial.sales"), "esperava ao menos um log da consulta");
  for (const segredo of ["AT-atual", "RT-atual", "AT-renovado", "RT-renovado", "fin-client-secret", "Bearer "]) {
    assert.ok(!log.includes(segredo), `vazou no log: ${segredo}`);
  }
});
