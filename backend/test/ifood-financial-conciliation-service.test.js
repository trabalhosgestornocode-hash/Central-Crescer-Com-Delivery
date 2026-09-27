// ifoodFinancial.service.js#obterConciliacaoFinanceira — orquestração real
// das 5 chamadas (Promise.allSettled) + resiliência (Bloco 12). Sem rede
// real, sem banco real.
import test from "node:test";
import assert from "node:assert/strict";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-client-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-client-secret";

const financial = await import("../src/modules/ifood/ifoodFinancial.service.js");
const { IFOOD_ERROS, ifoodErro } = await import("../src/modules/ifood/ifood.errors.js");
const { STATUS_CONCILIACAO } = await import("../src/modules/ifood/ifoodFinancial.reconciliation.js");
const { cifrar } = await import("../src/shared/cripto.js");

const TENANT = { organizacaoId: "org-1", unidadeId: "uni-1" };
const MERCHANT_ID = "550e8400-e29b-41d4-a716-446655440000";
const daquiA = (ms) => new Date(Date.now() + ms).toISOString();

function repoFalso(opts = {}) {
  const estado = {
    conexao: "conexao" in opts ? opts.conexao : { id: "conx-1", status: "ativa", merchant_id: MERCHANT_ID },
    cred: { access_token_cifrado: cifrar("AT-atual"), refresh_token_cifrado: cifrar("RT-atual"), expira_em: daquiA(60 * 60 * 1000), status: "ativa" },
  };
  return {
    estado,
    async obterConexaoViva() { return estado.conexao; },
    async obterCredencial() { return estado.cred ? { ...estado.cred } : null; },
    async salvarCredencial(a) { estado.cred = { ...estado.cred, access_token_cifrado: a.accessTokenCifrado, expira_em: a.expiraEm }; return estado.cred; },
    async atualizarCredencial({ campos }) { estado.cred = { ...estado.cred, ...campos }; return estado.cred; },
  };
}

const RESP_SALES = { page: 1, size: 1, beginSalesDate: "2025-01-01", endSalesDate: "2025-01-31", sales: [{ id: "s1", shortId: "1", currentStatus: "CONCLUDED", billingSummary: { saleBalance: 91, billingEntries: [] } }], total: 1, pageCount: 1 };
const RESP_EVENTS = { page: 1, size: 100, hasNextPage: false, financialEvents: [{ name: "ORDER_PAYMENT", hasTransferImpact: true, amount: { value: "91" }, reference: { type: "ORDER", id: "s1" } }] };
const RESP_SETTLEMENTS = { beginDate: "2025-01-01", endDate: "2025-01-31", balance: 91, merchantId: MERCHANT_ID, settlements: [{ id: "t1", type: "REPASSE", amount: 91, status: "SUCCEED", accountDetails: {}, paymentDate: "2025-01-31" }] };
const RESP_RECONCILIATION = [{ downloadPath: null, createdAt: "2025-02-01T00:00:00Z", metadata: null }];
const RESP_ANTICIPATIONS = { beginDate: "2025-01-01", endDate: "2025-01-31", balance: 0, settlements: [] };

// httpFalso roteia por rótulo (cada API chama com um `rotulo` diferente).
function httpFalso(respostasPorRotulo) {
  const chamadas = [];
  return {
    chamadas,
    async getJson(caminho, opts) {
      chamadas.push({ caminho, rotulo: opts?.rotulo });
      const entrada = respostasPorRotulo[opts?.rotulo];
      if (entrada === undefined) throw new Error(`sem stub pra rótulo ${opts?.rotulo}`);
      if (entrada instanceof Error) throw entrada;
      return entrada;
    },
    async postJson() { throw new Error("não deveria chamar postJson neste teste"); },
    async postForm() { return { accessToken: "AT-renovado", refreshToken: "RT-renovado", expiresIn: 21600 }; },
  };
}
function downloadFalso() { return { async baixarArquivoConciliacao() { return Buffer.from(""); } }; }

test("todas as 5 fontes OK (sem exceção): fontesComErro vazio, Sales×Events conciliado", async () => {
  const http = httpFalso({
    "financial.sales": RESP_SALES, "financial.events": RESP_EVENTS, "financial.settlements": RESP_SETTLEMENTS,
    "financial.reconciliation": RESP_RECONCILIATION, "financial.anticipations": RESP_ANTICIPATIONS,
  });
  const r = await financial.obterConciliacaoFinanceira({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-31", deps: { repo: repoFalso(), http, download: downloadFalso() } });
  assert.deepEqual(r.fontesComErro, []);
  // Reconciliation respondeu OK mas sem downloadPath pra essa competência
  // (dado realista) -> settlementsVsReconciliation fica INCOMPLETO, então o
  // statusGeral reflete isso; o que este teste garante é que as 5 chamadas
  // aconteceram e a conta de Sales x Events (que TEM dado dos dois lados)
  // saiu certa.
  assert.equal(r.conciliacao.salesVsEvents.status, STATUS_CONCILIACAO.CONCILIADO);
  assert.equal(r.conciliacao.eventsVsSettlements.status, STATUS_CONCILIACAO.CONCILIADO);
  assert.equal(r.reconciliation.disponivel, false);
});

test("RESILIÊNCIA: Reconciliation indisponível (erro) e Anticipation com erro -> as outras 3 ainda produzem análise válida", async () => {
  const http = httpFalso({
    "financial.sales": RESP_SALES, "financial.events": RESP_EVENTS, "financial.settlements": RESP_SETTLEMENTS,
    "financial.reconciliation": ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL),
    "financial.anticipations": ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL),
  });
  const r = await financial.obterConciliacaoFinanceira({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-31", deps: { repo: repoFalso(), http, download: downloadFalso() } });
  // Sales x Events e Events x Settlements continuam calculáveis normalmente.
  assert.equal(r.conciliacao.salesVsEvents.status, STATUS_CONCILIACAO.CONCILIADO);
  assert.equal(r.conciliacao.eventsVsSettlements.status, STATUS_CONCILIACAO.CONCILIADO);
  assert.equal(r.reconciliation.disponivel, false);
  assert.equal(r.anticipation.quantidade, 0);
  assert.equal(r.fontesComErro.length, 2);
  assert.deepEqual(r.fontesComErro.map((f) => f.fonte).sort(), ["anticipations", "reconciliation"]);
});

test("todas as 5 fontes falham -> não lança, devolve análise vazia com fontesComErro completo", async () => {
  const erro = ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL);
  const http = httpFalso({
    "financial.sales": erro, "financial.events": erro, "financial.settlements": erro,
    "financial.reconciliation": erro, "financial.anticipations": erro,
  });
  const r = await financial.obterConciliacaoFinanceira({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-31", deps: { repo: repoFalso(), http, download: downloadFalso() } });
  assert.equal(r.fontesComErro.length, 5);
  assert.equal(r.conciliacao.statusGeral, STATUS_CONCILIACAO.INCOMPLETO);
});

test("sem conexão viva -> lança IMEDIATAMENTE (não chama as 5 APIs)", async () => {
  const http = httpFalso({});
  await assert.rejects(
    () => financial.obterConciliacaoFinanceira({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-31", deps: { repo: repoFalso({ conexao: null }), http, download: downloadFalso() } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_CONEXAO_NAO_ENCONTRADA,
  );
  assert.equal(http.chamadas.length, 0);
});

test("sem merchant vinculado -> lança IFOOD_FINANCIAL_SEM_MERCHANT antes de chamar qualquer API", async () => {
  const http = httpFalso({});
  const repo = repoFalso({ conexao: { id: "conx-1", status: "ativa", merchant_id: null } });
  await assert.rejects(
    () => financial.obterConciliacaoFinanceira({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-31", deps: { repo, http, download: downloadFalso() } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_FINANCIAL_SEM_MERCHANT,
  );
  assert.equal(http.chamadas.length, 0);
});

test("competencia deriva de `inicio` quando não informada explicitamente", async () => {
  const http = httpFalso({
    "financial.sales": RESP_SALES, "financial.events": RESP_EVENTS, "financial.settlements": RESP_SETTLEMENTS,
    "financial.reconciliation": RESP_RECONCILIATION, "financial.anticipations": RESP_ANTICIPATIONS,
  });
  await financial.obterConciliacaoFinanceira({ ...TENANT, inicio: "2025-03-05", fim: "2025-03-10", deps: { repo: repoFalso(), http, download: downloadFalso() } });
  const chamadaReconciliation = http.chamadas.find((c) => c.rotulo === "financial.reconciliation");
  assert.match(chamadaReconciliation.caminho, /competence=2025-03/);
});

test("merchantId nunca aceito do chamador — usa sempre o da conexão em todas as 5 chamadas", async () => {
  const http = httpFalso({
    "financial.sales": RESP_SALES, "financial.events": RESP_EVENTS, "financial.settlements": RESP_SETTLEMENTS,
    "financial.reconciliation": RESP_RECONCILIATION, "financial.anticipations": RESP_ANTICIPATIONS,
  });
  await financial.obterConciliacaoFinanceira({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-31", merchantId: "outro-merchant-injetado", deps: { repo: repoFalso(), http, download: downloadFalso() } });
  for (const c of http.chamadas) assert.match(c.caminho, new RegExp(MERCHANT_ID));
});

test("resposta nunca contém token/secret/authorization", async () => {
  const http = httpFalso({
    "financial.sales": RESP_SALES, "financial.events": RESP_EVENTS, "financial.settlements": RESP_SETTLEMENTS,
    "financial.reconciliation": RESP_RECONCILIATION, "financial.anticipations": RESP_ANTICIPATIONS,
  });
  const r = await financial.obterConciliacaoFinanceira({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-31", deps: { repo: repoFalso(), http, download: downloadFalso() } });
  const txt = JSON.stringify(r).toLowerCase();
  for (const vazamento of ["accesstoken", "refreshtoken", "authorization", "clientsecret", "at-atual", "rt-atual"]) {
    assert.ok(!txt.includes(vazamento), `vazou: ${vazamento}`);
  }
});
