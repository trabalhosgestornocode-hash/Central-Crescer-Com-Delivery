// Checkpoint FINANCIAL EVENTS REAL READ-ONLY — header condicional, merchant pelo
// `receiver`, PII fora da resposta, null != zero, erros HTTP reais, read-only.
// Zero rede real e zero banco: fetch falso + supabase.from falso (só na prova de rota).
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-client-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-client-secret";

const financial = await import("../src/modules/ifood/ifoodFinancial.service.js");
const httpClient = await import("../src/modules/ifood/ifoodHttp.client.js");
const { mapearEventoFinanceiro } = await import("../src/modules/ifood/ifoodFinancial.mapper.js");
const { IFOOD_ERROS } = await import("../src/modules/ifood/ifood.errors.js");
const { cifrar } = await import("../src/shared/cripto.js");
const { supabase } = await import("../src/config/supabase.js");
const { config } = await import("../src/config/env.js");
const { ifoodRouter } = await import("../src/modules/ifood/ifood.routes.js");
const { requireModulo } = await import("../src/middlewares/auth.js");
const { errorHandler } = await import("../src/middlewares/errorHandler.js");
const { MODULOS } = await import("../src/shared/modulos.js");
const { permissoesDoPapel } = await import("../src/shared/permissoes.js");

const MERCHANT_A = "55c8f464-e65f-4340-b2c7-62d143027040";
const MERCHANT_B = "11111111-2222-3333-4444-555555555555";
const MERCHANT_FIXTURE = "35e575d6-3070-4978-9f7c-968b1dd0647e";
const TENANT_A = { organizacaoId: "org-A", unidadeId: "uni-A" };
const TENANT_B = { organizacaoId: "org-B", unidadeId: "uni-B" };
const PERIODO = { inicio: "2026-09-26", fim: "2026-09-27" };
const CNPJ = "11222333000181";
const CPF = "12345678909";
const HEADER = "x-request-homologation";
const daquiA = (ms) => new Date(Date.now() + ms).toISOString();
const credValida = (at = "AT-atual") => ({ access_token_cifrado: cifrar(at), refresh_token_cifrado: cifrar("RT-atual"), expira_em: daquiA(3_600_000), status: "ativa" });

const CONEXOES = {
  "uni-A": { id: "conx-A", organizacao_id: "org-A", status: "ativa", merchant_id: MERCHANT_A },
  "uni-B": { id: "conx-B", organizacao_id: "org-B", status: "ativa", merchant_id: MERCHANT_B },
};

function repoFalso(creds = {}) {
  const chamadas = [];
  const alvo = {
    async obterConexaoViva({ organizacaoId, unidadeId }) { const c = CONEXOES[unidadeId]; return c && c.organizacao_id === organizacaoId ? c : null; },
    async obterCredencial({ conexaoId }) { return conexaoId in creds ? creds[conexaoId] : credValida(); },
    async salvarCredencial() { throw new Error("não deveria salvar"); },
    async atualizarCredencial() { throw new Error("não deveria atualizar"); },
  };
  const repo = new Proxy(alvo, { get: (t, n) => (typeof t[n] === "function" ? (...a) => { chamadas.push({ nome: n, args: a }); return t[n](...a); } : t[n]) });
  return { repo, chamadas };
}

function resposta(status, corpo, headers = {}) {
  const h = new Map(Object.entries({ "content-type": "application/json", ...headers }));
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, text: async () => (corpo === undefined ? "" : JSON.stringify(corpo)) };
}
function fetchFalso(fn) {
  const chamadas = [];
  const f = async (url, init) => { chamadas.push({ url, metodo: init.method, headers: init.headers }); return fn(url, init, chamadas.length); };
  f.chamadas = chamadas;
  return f;
}
const httpReal = (fetchImpl) => ({
  getJson: (c, o) => httpClient.getJson(c, { ...o, fetchImpl }),
  postForm: (c, campos, o) => httpClient.postForm(c, campos, { ...(o ?? {}), fetchImpl }),
});

function ev(name, value, over = {}) {
  return {
    name, description: name, product: "IFOOD", trigger: "SALE_CONCLUDED",
    dateTime: "2026-09-27T07:00:00Z", competence: "2026-09",
    period: { beginDate: "2026-09-21", endDate: "2026-09-27" },
    reference: { type: "ORDER", id: "4dcafcbc-0000-0000-0000-000000000000", date: "2026-09-27T04:15:22.173Z" },
    hasTransferImpact: true,
    ...(value === undefined ? {} : { amount: { value } }),
    settlement: { expectedDate: "2026-10-22" },
    receiver: { businessId: MERCHANT_A, businessType: "MERCHANT", businessDocument: CNPJ },
    payment: { method: "CREDIT", brand: "VISA", liability: "MERCHANT" },
    ...over,
  };
}
const envelope = (eventos, over = {}) => [{ page: 1, size: 100, hasNextPage: false, financialEvents: eventos, ...over }];

function silenciar() {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const linhas = [];
  for (const k of Object.keys(orig)) console[k] = (...a) => linhas.push(a.map(String).join(" "));
  return { linhas, restaurar: () => Object.assign(console, orig) };
}
async function comSilencio(fn) { const c = silenciar(); try { return { r: await fn(), log: c.linhas.join("\n") }; } finally { c.restaurar(); } }

const chamar = (extra, f, repo = repoFalso().repo, tenant = TENANT_A) =>
  financial.listarFinancialEvents({ ...tenant, ...PERIODO, ...extra, deps: { repo, http: httpReal(f) } });
const ok200 = (eventos, over) => fetchFalso(() => resposta(200, envelope(eventos, over)));

// ---------------------------------------------------------------------------
// 1-4 header
// ---------------------------------------------------------------------------
describe("header x-request-homologation (Financial Events)", () => {
  test("[1] homologacao:true envia o header", async () => {
    const f = ok200([]); await chamar({ homologacao: true }, f);
    assert.equal(f.chamadas[0].headers[HEADER], "true");
  });
  test("[2] homologacao:false NÃO envia o header", async () => {
    const f = ok200([]); await chamar({ homologacao: false }, f);
    assert.equal(HEADER in f.chamadas[0].headers, false);
    assert.equal(f.chamadas[0].url, `https://mock.ifood.test/financial/v3.0/merchants/${MERCHANT_A}/financial-events?beginDate=2026-09-26&endDate=2026-09-27&page=1&size=100`);
  });
  test("[3] homologacao omitido -> decide a UNIDADE: fora da allowlist = SEM header (dado real)", async () => {
    const f = ok200([]); await chamar({}, f);
    assert.equal(HEADER in f.chamadas[0].headers, false);
  });
  test("[4] valor não-boolean (ex.: 'true' vindo de query) NÃO liga a fixture — decide a unidade", async () => {
    for (const v of ["true", "false", 1, 0, null, "0"]) {
      const f = ok200([]); await chamar({ homologacao: v }, f);
      assert.equal(HEADER in f.chamadas[0].headers, false, `homologacao=${JSON.stringify(v)}`);
    }
  });
  test("[4b] Settlements segue a UNIDADE: fora da allowlist sem header; na allowlist com header", async () => {
    const f = fetchFalso(() => resposta(200, { settlements: [] }));
    await comSilencio(() => financial.listarSettlements({ ...TENANT_A, modo: "calculo", ...PERIODO, deps: { repo: repoFalso().repo, http: httpReal(f) } }).catch(() => {}));
    await comSilencio(() => financial.listarSettlements({ ...TENANT_A, modo: "calculo", ...PERIODO, deps: { homologacaoFinancial: (u) => u === TENANT_A.unidadeId, repo: repoFalso().repo, http: httpReal(f) } }).catch(() => {}));
    assert.equal(HEADER in f.chamadas[0].headers, false);
    assert.equal(f.chamadas[1].headers[HEADER], "true");
  });
});

// ---------------------------------------------------------------------------
// 5-7 merchant / vazio
// ---------------------------------------------------------------------------
describe("merchant pelo receiver", () => {
  test("[5] merchant correto -> eventos aceitos, resposta válida", async () => {
    const r = await chamar({ homologacao: false }, ok200([ev("ORDER_PAYMENT", "27"), ev("ORDER_COMMISSION", "-3.24")]));
    assert.equal(r.eventos.length, 2);
    assert.equal(r.validacao.valida, true);
  });
  test("[6] MODO REAL: receiver de outra loja -> evento descartado, resposta inválida, log 'rejeitada' sem documento", async () => {
    const alheio = ev("SERVICE_FEE", "-0.99", { receiver: { businessId: MERCHANT_FIXTURE, businessDocument: "72821234000100" } });
    const { r, log } = await comSilencio(() => chamar({ homologacao: false }, ok200([alheio, ev("ORDER_PAYMENT", "27")])));
    assert.deepEqual(r.eventos.map((e) => e.nome), ["ORDER_PAYMENT"]);
    assert.equal(r.validacao.valida, false);
    assert.deepEqual(r.validacao.motivos, ["MERCHANT_DIVERGENTE"]);
    assert.deepEqual(r.validacao.merchant.recebidosDivergentes, ["35e5****647e"]);
    assert.equal(r.validacao.merchant.eventosDescartados, 1);
    assert.equal(r.validacao.divergencia, "rejeitada");
    assert.equal(r.fonte, "real");
    assert.equal(r.amostraHomologacao, false);
    assert.match(log, /financial\.events\.resposta_invalida/);
    assert.match(log, /"divergencia":"rejeitada"/);
    assert.ok(!log.includes("72821234000100") && !log.includes(CNPJ));
  });
  test("[6c] HOMOLOGAÇÃO: receiver da fixture oficial -> evento MANTIDO como amostra, log 'fixture_oficial_aceita' sem documento", async () => {
    const alheio = ev("SERVICE_FEE", "-0.99", { receiver: { businessId: MERCHANT_FIXTURE, businessDocument: "72821234000100" } });
    const { r, log } = await comSilencio(() => chamar({ homologacao: true }, ok200([alheio, ev("ORDER_PAYMENT", "27")])));
    assert.deepEqual(r.eventos.map((e) => e.nome), ["SERVICE_FEE", "ORDER_PAYMENT"]);
    assert.equal(r.fonte, "fixture");
    assert.equal(r.amostraHomologacao, true);
    assert.deepEqual(r.amostra.merchants, ["35e5****647e"]);
    assert.equal(r.validacao.merchant.eventosDescartados, 0);
    assert.equal(r.validacao.merchant.fixtureAceitos, 1);
    assert.equal(r.validacao.divergencia, "fixture_oficial_aceita");
    assert.match(log, /financial\.events\.fixture_aceita/);
    assert.doesNotMatch(log, /financial\.events\.resposta_invalida/);
    assert.ok(!log.includes("72821234000100") && !log.includes(CNPJ) && !log.includes(MERCHANT_FIXTURE));
    assert.ok(!JSON.stringify(r.amostra).includes(MERCHANT_FIXTURE), "merchant da fixture só mascarado");
  });
  test("[6b] evento sem receiver: mantido (requisição já foi pelo merchant da conexão) e contado", async () => {
    const r = await chamar({ homologacao: false }, ok200([ev("ORDER_PAYMENT", "27", { receiver: undefined })]));
    assert.equal(r.eventos.length, 1);
    assert.equal(r.validacao.merchant.eventosSemMerchant, 1);
    assert.equal(r.validacao.valida, true);
  });
  test("[7] resposta vazia -> eventos:[] e válida (acesso ok + nenhum evento ≠ fixture ≠ sem permissão)", async () => {
    const r = await chamar({ homologacao: false }, ok200([]));
    assert.deepEqual(r.eventos, []);
    assert.equal(r.validacao.valida, true);
  });
  test("[7b] 200 sem corpo -> eventos:[] sem lançar", async () => {
    const r = await chamar({ homologacao: false }, fetchFalso(() => resposta(200, undefined)));
    assert.deepEqual(r.eventos, []);
  });
});

// ---------------------------------------------------------------------------
// 8-16 tipos de evento, sinal, ausência x zero (o mapper NÃO reclassifica)
// ---------------------------------------------------------------------------
describe("tipos de evento preservados sem reinterpretação", () => {
  const casos = [
    ["[8] pagamento", ev("ORDER_PAYMENT", "27", { description: "IN_APP_PAYMENT_CREDIT" }), 27, "credito"],
    ["[9] comissão", ev("ORDER_COMMISSION", "-3.24", { description: "MARKETPLACE_COMMISSION", billing: { baseValue: "27", feePercentage: "12" } }), -3.24, "debito"],
    ["[10] taxa de transação", ev("PAYMENT_TRANSACTION_FEE", "-0.86", { billing: { baseValue: "27", feePercentage: "3.2" } }), -0.86, "debito"],
    ["[10b] taxa de serviço", ev("SERVICE_FEE", "-0.99"), -0.99, "debito"],
    ["[11] subsídio iFood", ev("IFOOD_SUBSIDY", "5", { description: "BENEFIT_OWN" }), 5, "credito"],
    ["[11b] subsídio da loja (sem impacto)", ev("STORE_SUBSIDY", "-5", { hasTransferImpact: false }), -5, "debito"],
    ["[12] cancelamento/ressarcimento", ev("STORE_REFUND", "25.50", { description: "REFUND_PARTIAL_CANCELLATION", trigger: "SALE_CANCELLED" }), 25.5, "credito"],
    ["[13] ajuste positivo", ev("ORDER_COMMISSION", "3.09", { trigger: "PARTIAL_CANCELLATION_ORDER" }), 3.09, "credito"],
    ["[14] ajuste negativo (nome livre, sem dateTime)", ev("Retenção de pedido cancelado recebido pela loja", "-35.91", { trigger: "SALES_OCCURRENCE", dateTime: undefined }), -35.91, "debito"],
  ];
  for (const [nome, bruto, valor, tipoValor] of casos) {
    test(`${nome}: name/trigger/descrição intactos, valor numérico, sinal correto`, () => {
      const e = mapearEventoFinanceiro(bruto);
      assert.equal(e.nome, bruto.name);
      assert.equal(e.gatilho, bruto.trigger);
      assert.equal(e.descricao, bruto.description);
      assert.equal(e.valor, valor);
      assert.equal(e.tipoValor, tipoValor);
      assert.equal(e.referencia.id, bruto.reference.id);
      assert.equal(e.temImpactoRepasse, bruto.hasTransferImpact);
    });
  }
  test("[14b] sem dateTime -> dataHora null (não inventa data)", () => {
    assert.equal(mapearEventoFinanceiro(ev("X", "-1", { dateTime: undefined })).dataHora, null);
  });
  test("[15] ausência de valor -> valor null e tipoValor null (nunca R$ 0,00)", () => {
    const e = mapearEventoFinanceiro(ev("ORDER_COMMISSION", undefined, { billing: undefined, hasTransferImpact: undefined }));
    assert.equal(e.valor, null);
    assert.equal(e.tipoValor, null);
    assert.equal(e.faturamento, null);
    assert.equal(e.temImpactoRepasse, null);
  });
  test("[16] zero real ('0') continua 0, não null", () => {
    const e = mapearEventoFinanceiro(ev("DELIVERY_FEE_IFOOD", "0"));
    assert.equal(e.valor, 0);
  });
  test("[16b] parcela de ORDER_PAYMENT preservada (evita somar a mesma receita como se fossem vendas diferentes)", () => {
    const e = mapearEventoFinanceiro(ev("ORDER_PAYMENT", "69.32", { billing: { baseValue: "207.98", installments: { reference: "1/3", referenceDate: "2026-09-27" } } }));
    assert.deepEqual(e.faturamento.parcela, { referencia: "1/3", dataReferencia: "2026-09-27" });
    assert.equal(e.faturamento.valorBase, 207.98);
  });
});

// ---------------------------------------------------------------------------
// 17-18 paginação e datas
// ---------------------------------------------------------------------------
describe("paginação e datas", () => {
  test("[17] hasNextPage:true -> UMA chamada só; próxima página só sinalizada", async () => {
    const f = ok200([ev("ORDER_PAYMENT", "27")], { hasNextPage: true });
    const r = await chamar({ homologacao: false, page: 1, size: 50 }, f);
    assert.equal(f.chamadas.length, 1);
    assert.match(f.chamadas[0].url, /page=1&size=50$/);
    assert.equal(r.pagina.temProximaPagina, true);
  });
  test("[18] datas vão verbatim; dateTime do evento volta intacto", async () => {
    const f = ok200([ev("ORDER_PAYMENT", "27")]);
    const r = await chamar({ homologacao: false }, f);
    assert.match(f.chamadas[0].url, /beginDate=2026-09-26&endDate=2026-09-27/);
    assert.equal(r.eventos[0].dataHora, "2026-09-27T07:00:00Z");
    assert.deepEqual(r.periodo, PERIODO);
  });
  test("[18b] período > 33 dias ou só uma das datas -> erro ANTES de chamar o iFood", async () => {
    for (const p of [{ inicio: "2026-08-01", fim: "2026-09-27" }, { inicio: "2026-09-26", fim: undefined }]) {
      const f = ok200([]);
      await assert.rejects(() => financial.listarFinancialEvents({ ...TENANT_A, ...p, deps: { repo: repoFalso().repo, http: httpReal(f) } }),
        (e) => e.codigo === IFOOD_ERROS.IFOOD_FINANCIAL_PERIODO_INVALIDO);
      assert.equal(f.chamadas.length, 0);
    }
  });
});

// ---------------------------------------------------------------------------
// 19-24 erros HTTP reais (http client real sobre fetch falso)
// ---------------------------------------------------------------------------
describe("erros HTTP", () => {
  const erro = (status, h) => fetchFalso(() => resposta(status, { error: { code: "X", message: "m" } }, h));
  test("[19] 400 -> IFOOD_REQUISICAO_INVALIDA, sem retry", async () => {
    const f = erro(400);
    await assert.rejects(() => comSilencio(() => chamar({ homologacao: false }, f)), (e) => e.codigo === IFOOD_ERROS.IFOOD_REQUISICAO_INVALIDA);
    assert.equal(f.chamadas.length, 1);
  });
  test("[20] 401 -> NÃO renova neste teste de repo (salvar lança) e propaga erro; nunca loop", async () => {
    const f = fetchFalso((url) => (url.includes("/authentication/") ? resposta(200, { accessToken: "AT-novo", refreshToken: "RT-novo", expiresIn: 10800 }) : resposta(401, {})));
    await assert.rejects(() => comSilencio(() => chamar({ homologacao: false }, f)));
    assert.ok(f.chamadas.filter((c) => !c.url.includes("/authentication/")).length <= 2);
  });
  test("[21] 403 -> IFOOD_MERCHANT_SEM_PERMISSAO, sem retry", async () => {
    const f = erro(403);
    await assert.rejects(() => comSilencio(() => chamar({ homologacao: false }, f)), (e) => e.codigo === IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO);
    assert.equal(f.chamadas.length, 1);
  });
  test("[22] 429 -> retry limitado (3) e IFOOD_RATE_LIMITED", async () => {
    const f = erro(429, { "retry-after": "0" });
    await assert.rejects(() => comSilencio(() => chamar({ homologacao: false }, f)), (e) => e.codigo === IFOOD_ERROS.IFOOD_RATE_LIMITED);
    assert.equal(f.chamadas.length, 3);
  });
  test("[23] 500 -> retry limitado (3) e IFOOD_INDISPONIVEL", async () => {
    const f = erro(500);
    await assert.rejects(() => comSilencio(() => chamar({ homologacao: false }, f)), (e) => e.codigo === IFOOD_ERROS.IFOOD_INDISPONIVEL);
    assert.equal(f.chamadas.length, 3);
  });
  test("[24] timeout -> IFOOD_INDISPONIVEL motivo timeout", async () => {
    const f = fetchFalso(() => { const e = new Error("aborted"); e.name = "AbortError"; throw e; });
    await assert.rejects(() => comSilencio(() => chamar({ homologacao: false }, f)), (e) => e.codigo === IFOOD_ERROS.IFOOD_INDISPONIVEL && e.details?.motivo === "timeout");
  });
});

// ---------------------------------------------------------------------------
// 25-28 read-only, PII, isolamento
// ---------------------------------------------------------------------------
describe("read-only, PII, isolamento", () => {
  test("[25] nenhuma persistência: repo só é LIDO (mesmo com evento descartado)", async () => {
    const { repo, chamadas } = repoFalso();
    const alheio = ev("SERVICE_FEE", "-0.99", { receiver: { businessId: MERCHANT_FIXTURE } });
    await comSilencio(() => chamar({ homologacao: false }, ok200([alheio, ev("ORDER_PAYMENT", "27")]), repo));
    assert.deepEqual([...new Set(chamadas.map((c) => c.nome))].sort(), ["obterConexaoViva", "obterCredencial"]);
  });
  test("[26] nenhuma escrita no iFood: 1 GET no path de financial-events", async () => {
    const f = ok200([ev("ORDER_PAYMENT", "27")]);
    await chamar({ homologacao: false }, f);
    assert.equal(f.chamadas.length, 1);
    assert.equal(f.chamadas[0].metodo, "GET");
    assert.match(f.chamadas[0].url, /\/financial\/v3\.0\/merchants\/[^/]+\/financial-events\?/);
  });
  test("[27] nenhum PII no retorno do service (businessDocument/merchantDocument/CPF)", async () => {
    const r = await chamar({ homologacao: false }, ok200([
      ev("ORDER_PAYMENT", "27", { receiver: { businessId: MERCHANT_A, businessDocument: CNPJ } }),
      ev("ORDER_COMMISSION", "-3", { receiver: { merchantId: MERCHANT_A, merchantDocument: CPF } }),
    ]));
    const txt = JSON.stringify(r);
    assert.ok(!txt.includes(CNPJ) && !txt.includes(CPF));
    assert.doesNotMatch(txt, /document/i);
  });
  test("[28] isolamento: cada tenant consulta só o próprio merchant com o próprio token; tenant cruzado não chama", async () => {
    const { repo, chamadas } = repoFalso({ "conx-A": credValida("AT-A"), "conx-B": credValida("AT-B") });
    const f = ok200([]);
    await chamar({ homologacao: false }, f, repo, TENANT_A);
    await chamar({ homologacao: false }, f, repo, TENANT_B);
    assert.ok(f.chamadas[0].url.includes(MERCHANT_A) && f.chamadas[0].headers.Authorization === "Bearer AT-A");
    assert.ok(f.chamadas[1].url.includes(MERCHANT_B) && f.chamadas[1].headers.Authorization === "Bearer AT-B");
    assert.deepEqual(chamadas.filter((c) => c.nome === "obterConexaoViva").map((c) => c.args[0]), [TENANT_A, TENANT_B]);
    const f2 = ok200([]);
    await assert.rejects(() => chamar({ homologacao: false }, f2, repo, { organizacaoId: "org-A", unidadeId: "uni-B" }), (e) => e.codigo === IFOOD_ERROS.IFOOD_CONEXAO_NAO_ENCONTRADA);
    assert.equal(f2.chamadas.length, 0);
  });
});

// ---------------------------------------------------------------------------
// [27] + escolha fixture/real NUNCA pelo frontend — rota real, sem banco e sem rede
// ---------------------------------------------------------------------------
describe("rotas GET /financial/events e /financial/sales", async () => {
  const fromOriginal = supabase.from;
  const fetchOriginal = globalThis.fetch;
  const escritas = [];
  supabase.from = (tabela) => {
    const linha = tabela === "ifood_conexoes" ? { id: "conx-A", organizacao_id: "org-A", unidade_id: "uni-A", status: "ativa", merchant_id: MERCHANT_A }
      : tabela === "ifood_credenciais" ? credValida() : null;
    const q = {
      select: () => q, eq: () => q, neq: () => q,
      insert: () => { escritas.push(tabela); return q; }, update: () => { escritas.push(tabela); return q; },
      upsert: () => { escritas.push(tabela); return q; }, delete: () => { escritas.push(tabela); return q; },
      maybeSingle: async () => ({ data: linha, error: null }), single: async () => ({ data: linha, error: null }),
    };
    return q;
  };
  const chamadasIfood = [];
  globalThis.fetch = async (url, init) => {
    chamadasIfood.push({ url: String(url), headers: init.headers, metodo: init.method });
    if (String(url).includes("/sales")) return resposta(200, [{ page: 1, size: 0, total: 0, pageCount: 0, sales: [] }]);
    return resposta(200, envelope([ev("ORDER_PAYMENT", "27", { receiver: { businessId: MERCHANT_A, businessDocument: CPF } })]));
  };

  const app = express();
  app.use("/api/v1", (req, _res, next) => {
    req.user = { id: "u-events-rota" };
    req.acesso = { papel: "unit_manager", permissoes: permissoesDoPapel("unit_manager"), modulos: [MODULOS.IFOOD], impersonando: false };
    req.tenant = { organizacaoId: "org-A", unidadeId: "uni-A" };
    next();
  }, requireModulo(MODULOS.IFOOD), ifoodRouter);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  after(() => { server.close(); supabase.from = fromOriginal; globalThis.fetch = fetchOriginal; });

  const get = (url) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method: "GET", path: url }, (res) => {
      let corpo = ""; res.on("data", (c) => { corpo += c; }); res.on("end", () => resolve({ status: res.statusCode, corpo }));
    });
    req.on("error", reject); req.end();
  });

  test("events: 200 sem documento/CPF, sem `validacao`, merchant da conexão", async () => {
    const { r } = await comSilencio(() => get(`/api/v1/financial/events?inicio=${PERIODO.inicio}&fim=${PERIODO.fim}`));
    assert.equal(r.status, 200, r.corpo);
    assert.ok(!r.corpo.includes(CPF));
    assert.doesNotMatch(r.corpo, /document/i);
    const { data } = JSON.parse(r.corpo);
    assert.equal(data.eventos[0].nome, "ORDER_PAYMENT");
    assert.equal("validacao" in data, false);
  });

  test("?homologacao=... na query é ignorado (events e sales) — o header segue só a config do backend", async () => {
    const antes = chamadasIfood.length;
    const oposto = config.ifood.financialFixture === true ? "false" : "true";
    await comSilencio(() => get(`/api/v1/financial/events?inicio=${PERIODO.inicio}&fim=${PERIODO.fim}&homologacao=${oposto}`));
    await comSilencio(() => get(`/api/v1/financial/sales?inicio=${PERIODO.inicio}&fim=${PERIODO.fim}&homologacao=${oposto}`));
    const novas = chamadasIfood.slice(antes);
    assert.equal(novas.length, 2);
    for (const c of novas) {
      assert.equal(HEADER in c.headers, config.ifood.financialFixture === true, c.url);
      assert.doesNotMatch(c.url, /homologacao/);
    }
  });

  test("rotas não escreveram no banco e só fizeram GET", () => {
    assert.deepEqual(escritas, []);
    assert.ok(chamadasIfood.every((c) => c.metodo === "GET"));
  });
});
