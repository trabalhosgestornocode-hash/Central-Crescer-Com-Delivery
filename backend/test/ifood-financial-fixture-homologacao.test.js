// Fixture oficial do iFood no modo HOMOLOGAÇÃO Financial (Sales e Financial Events).
// Reproduz o que produção mostrou em 2026-10-05 (North Shopping, app TEST, header ligado):
//   * Sales: total 2, 1 por página, loja f07d****7c00, período 2025-08-01 -> 1 venda descartada;
//   * Financial Events: 28 eventos de receiver f07d****7c00 -> 28 descartados.
// Regra nova: em HOMOLOGAÇÃO (decidida pelo backend) a fixture é MANTIDA como amostra
// (fonte "fixture", amostraHomologacao); no modo REAL o descarte por merchant segue igual.
// Zero rede real e zero banco.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-client-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-client-secret";

const financial = await import("../src/modules/ifood/ifoodFinancial.service.js");
const { config } = await import("../src/config/env.js");
const { cifrar } = await import("../src/shared/cripto.js");
const { supabase } = await import("../src/config/supabase.js");
const { ifoodRouter } = await import("../src/modules/ifood/ifood.routes.js");
const { requireModulo } = await import("../src/middlewares/auth.js");
const { errorHandler } = await import("../src/middlewares/errorHandler.js");
const { MODULOS } = await import("../src/shared/modulos.js");
const { permissoesDoPapel } = await import("../src/shared/permissoes.js");

const MERCHANT_CONEXAO = "55c8f464-e65f-4340-b2c7-62d143027040";
const MERCHANT_FIXTURE = "f07d23bd-74fc-47fa-9abf-2889e8127c00";
const UNI_A = "aaaaaaaa-0000-4000-8000-00000000000a"; // homologação
const UNI_B = "bbbbbbbb-0000-4000-8000-00000000000b"; // real
const HEADER = "x-request-homologation";

const venda = (over = {}) => ({
  id: "venda-1", shortId: "1234", createdAt: "2025-08-01T15:00:00Z", currentStatus: "CONCLUDED", salesChannel: "IFOOD",
  merchant: { id: MERCHANT_FIXTURE, timezone: "America/Sao_Paulo", documents: [{ type: "CNPJ", value: "11222333000181" }] },
  saleGrossValue: { bag: 50, deliveryFee: 0, serviceFee: 0.99 },
  payments: { methods: [{ method: "CREDIT", type: "ONLINE", liability: "IFOOD", value: 50.99 }] },
  billingSummary: { saleBalance: 43.9, billingEntries: [{ name: "ORDER_PAYMENT", value: 50.99 }, { name: "ORDER_COMMISSION", value: -6.1 }, { name: "SERVICE_FEE", value: -0.99 }] },
  ...over,
});
// Forma da resposta de produção: total 2, 1 por página, período da fixture 2025-08-01.
const SALES_FIXTURE = [{ page: 1, size: 1, total: 2, pageCount: 2, beginSalesDate: "2025-08-01", endSalesDate: "2025-08-01", sales: [venda()] }];
const evento = (i, receiver = MERCHANT_FIXTURE) => ({
  name: i % 2 ? "ORDER_COMMISSION" : "ORDER_PAYMENT", description: "x", trigger: "SALE_CONCLUDED",
  dateTime: "2025-08-01T07:00:00Z", amount: { value: i % 2 ? "-6.10" : "50.99" }, hasTransferImpact: true,
  settlement: { expectedDate: "2025-08-28" },
  receiver: { businessId: receiver, businessType: "MERCHANT", businessDocument: "11222333000181" },
});
const EVENTS_FIXTURE = (n = 28) => [{ page: 1, size: 100, hasNextPage: false, financialEvents: Array.from({ length: n }, (_, i) => evento(i)) }];

const repoFalso = () => ({
  async obterConexaoViva({ unidadeId }) { return { id: `conx-${unidadeId.slice(0, 4)}`, status: "ativa", merchant_id: MERCHANT_CONEXAO }; },
  async obterCredencial() { return { access_token_cifrado: cifrar("AT"), refresh_token_cifrado: cifrar("RT"), expira_em: new Date(Date.now() + 3_600_000).toISOString(), status: "ativa" }; },
});
function httpFalso(map) {
  const chamadas = [];
  return { chamadas, async getJson(caminho, opts) { chamadas.push({ caminho, homologacao: opts?.homologacao }); return map(caminho); } };
}
function silenciar() {
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const linhas = [];
  for (const k of Object.keys(orig)) console[k] = (...a) => linhas.push(a.map(String).join(" "));
  return { linhas, restaurar: () => Object.assign(console, orig) };
}
async function quieto(fn) { const s = silenciar(); try { return { r: await fn(), log: s.linhas.join("\n") }; } finally { s.restaurar(); } }
const PERIODO = { inicio: "2026-09-29", fim: "2026-10-05" };
const emHomologacao = (u) => u === UNI_A;

// ===========================================================================
describe("Sales", () => {
  test("REAL: venda do merchant da conexão é aceita", async () => {
    const http_ = httpFalso(() => [{ ...SALES_FIXTURE[0], beginSalesDate: PERIODO.inicio, endSalesDate: PERIODO.fim, sales: [venda({ merchant: { id: MERCHANT_CONEXAO, timezone: "America/Sao_Paulo" }, createdAt: "2026-10-01T15:00:00Z" })] }]);
    const { r } = await quieto(() => financial.listarSales({ organizacaoId: "o", unidadeId: UNI_B, ...PERIODO, deps: { repo: repoFalso(), http: http_, homologacaoFinancial: emHomologacao } }));
    assert.equal(r.vendas.length, 1);
    assert.equal(r.fonte, "real");
    assert.equal(r.amostraHomologacao, false);
    assert.equal(http_.chamadas[0].homologacao, false);
  });

  test("REAL: venda de outro merchant é DESCARTADA (sem mudança) e logada como 'rejeitada'", async () => {
    const http_ = httpFalso(() => SALES_FIXTURE);
    const { r, log } = await quieto(() => financial.listarSales({ organizacaoId: "o", unidadeId: UNI_B, ...PERIODO, deps: { repo: repoFalso(), http: http_, homologacaoFinancial: emHomologacao } }));
    assert.deepEqual(r.vendas, []);
    assert.equal(r.validacao.merchant.vendasDescartadas, 1);
    assert.equal(r.validacao.divergencia, "rejeitada");
    assert.match(log, /financial\.sales\.resposta_invalida/);
    assert.ok(!log.includes(MERCHANT_FIXTURE) && !log.includes("11222333000181"));
  });

  test("HOMOLOGAÇÃO: fixture oficial (outra loja/período) é MANTIDA como amostra, com paginação e campos exigidos", async () => {
    const http_ = httpFalso(() => SALES_FIXTURE);
    const { r, log } = await quieto(() => financial.listarSales({ organizacaoId: "o", unidadeId: UNI_A, ...PERIODO, deps: { repo: repoFalso(), http: http_, homologacaoFinancial: emHomologacao } }));
    assert.equal(http_.chamadas[0].homologacao, true);
    assert.equal(r.vendas.length, 1);
    assert.equal(r.fonte, "fixture");
    assert.equal(r.amostraHomologacao, true);
    assert.deepEqual(r.amostra, { merchants: ["f07d****7c00"], periodo: { inicio: "2025-08-01", fim: "2025-08-01" } });
    assert.deepEqual(r.periodo, PERIODO, "o período exposto continua sendo o SOLICITADO");
    assert.equal(r.pagina.total, 2);
    assert.equal(r.pagina.totalPaginas, 2);
    const v = r.vendas[0];
    assert.equal(v.status, "CONCLUDED");
    assert.equal(v.valorBruto.total, 50.99);
    assert.equal(v.resumoFinanceiro.saldo, 43.9);
    assert.equal(v.pagamentos[0].metodo, "CREDIT");
    assert.equal(v.pagamentos[0].responsavel, "IFOOD");
    assert.deepEqual(v.resumoFinanceiro.lancamentos.map((l) => l.nome), ["ORDER_PAYMENT", "ORDER_COMMISSION", "SERVICE_FEE"]);
    assert.ok(!JSON.stringify(r).includes("11222333000181"), "documentos da loja nunca saem do mapper");
    assert.match(log, /financial\.sales\.fixture_aceita/);
    assert.match(log, /"divergencia":"fixture_oficial_aceita"/);
    assert.ok(!log.includes(MERCHANT_FIXTURE));
  });

  test("HOMOLOGAÇÃO não altera o merchant da conexão (a resposta não traz merchant da conexão trocado)", async () => {
    const http_ = httpFalso(() => SALES_FIXTURE);
    const { r } = await quieto(() => financial.listarSales({ organizacaoId: "o", unidadeId: UNI_A, ...PERIODO, deps: { repo: repoFalso(), http: http_, homologacaoFinancial: emHomologacao } }));
    assert.equal(r.validacao.merchant.esperado, "55c8****7040");
    assert.ok(http_.chamadas[0].caminho.includes(MERCHANT_CONEXAO), "a consulta continua no merchant da conexão");
  });
});

// ===========================================================================
describe("Financial Events", () => {
  test("REAL: receiver correto aceito; divergente DESCARTADO", async () => {
    const lista = [...EVENTS_FIXTURE(2)[0].financialEvents, evento(9, MERCHANT_CONEXAO)];
    const http_ = httpFalso(() => [{ page: 1, size: 100, hasNextPage: false, financialEvents: lista }]);
    const { r, log } = await quieto(() => financial.listarFinancialEvents({ organizacaoId: "o", unidadeId: UNI_B, ...PERIODO, deps: { repo: repoFalso(), http: http_, homologacaoFinancial: emHomologacao } }));
    assert.equal(r.eventos.length, 1);
    assert.equal(r.validacao.merchant.eventosDescartados, 2);
    assert.equal(r.fonte, "real");
    assert.equal(r.amostraHomologacao, false);
    assert.match(log, /financial\.events\.resposta_invalida/);
  });

  test("HOMOLOGAÇÃO: os 28 eventos da fixture (caso de produção) são MANTIDOS como amostra", async () => {
    const http_ = httpFalso(() => EVENTS_FIXTURE(28));
    const { r, log } = await quieto(() => financial.listarFinancialEvents({ organizacaoId: "o", unidadeId: UNI_A, ...PERIODO, deps: { repo: repoFalso(), http: http_, homologacaoFinancial: emHomologacao } }));
    assert.equal(http_.chamadas[0].homologacao, true);
    assert.equal(r.eventos.length, 28);
    assert.equal(r.fonte, "fixture");
    assert.equal(r.amostraHomologacao, true);
    assert.deepEqual(r.amostra.merchants, ["f07d****7c00"]);
    assert.equal(r.validacao.merchant.fixtureAceitos, 28);
    assert.equal(r.validacao.merchant.eventosDescartados, 0);
    assert.match(log, /financial\.events\.fixture_aceita/);
    assert.ok(!log.includes(MERCHANT_FIXTURE) && !log.includes("11222333000181"));
  });
});

// ===========================================================================
describe("Conciliação consolidada: um único modo, sem mistura real + fixture", () => {
  const mapa = (c) => (c.includes("/sales") ? SALES_FIXTURE : c.includes("financial-events") ? EVENTS_FIXTURE(2) : c.includes("/reconciliation") ? [{ downloadPath: null }] : {});
  test("HOMOLOGAÇÃO: Sales e Events entram como amostra; tudo marcado fixture", async () => {
    const http_ = httpFalso(mapa);
    const { r } = await quieto(() => financial.obterConciliacaoFinanceira({ organizacaoId: "o", unidadeId: UNI_A, ...PERIODO, competencia: "2026-09", deps: { repo: repoFalso(), http: http_, homologacaoFinancial: emHomologacao } }));
    assert.equal(r.fonte, "fixture");
    assert.equal(r.vendas.quantidade, 1);
    assert.equal(r.eventos.quantidade, 2);
    assert.ok(http_.chamadas.every((c) => c.homologacao === true));
  });
  test("REAL: mesma resposta de outra loja não entra (0 vendas, 0 eventos); tudo marcado real", async () => {
    const http_ = httpFalso(mapa);
    const { r } = await quieto(() => financial.obterConciliacaoFinanceira({ organizacaoId: "o", unidadeId: UNI_B, ...PERIODO, competencia: "2026-09", deps: { repo: repoFalso(), http: http_, homologacaoFinancial: emHomologacao } }));
    assert.equal(r.fonte, "real");
    assert.equal(r.vendas.quantidade, 0);
    assert.equal(r.eventos.quantidade, 0);
    assert.ok(http_.chamadas.every((c) => c.homologacao === false));
  });
});

// ===========================================================================
describe("rotas: query/body/header do navegador NÃO ativam a aceitação da fixture", async () => {
  const fromOriginal = supabase.from;
  const fetchOriginal = globalThis.fetch;
  const allowlistOriginal = config.ifood.financialHomologacaoUnidades;
  let tenantAtual = { organizacaoId: "org-1", unidadeId: UNI_B };
  before(() => { config.ifood.financialHomologacaoUnidades = [UNI_A]; });
  supabase.from = (tabela) => {
    const q = {
      select: () => q, eq: () => q, neq: () => q, in: () => q, order: () => q, limit: () => q,
      maybeSingle: async () => ({ data: dado(), error: null }), single: async () => ({ data: dado(), error: null }),
    };
    const dado = () => (tabela === "ifood_conexoes"
      ? { id: "conx-1", organizacao_id: "org-1", unidade_id: tenantAtual.unidadeId, status: "ativa", merchant_id: MERCHANT_CONEXAO }
      : tabela === "ifood_credenciais" ? { access_token_cifrado: cifrar("AT"), refresh_token_cifrado: cifrar("RT"), expira_em: new Date(Date.now() + 3_600_000).toISOString(), status: "ativa" } : null);
    return q;
  };
  const chamadas = [];
  globalThis.fetch = async (url, init) => {
    chamadas.push({ url: String(url), headers: init.headers ?? {} });
    const corpo = String(url).includes("/sales") ? SALES_FIXTURE : EVENTS_FIXTURE(3);
    return { ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) }, text: async () => JSON.stringify(corpo) };
  };
  const app = express();
  app.use(express.json());
  app.use("/api/v1", (req, _res, next) => {
    req.user = { id: "u-1" };
    req.acesso = { papel: "unit_manager", permissoes: permissoesDoPapel("unit_manager"), modulos: [MODULOS.IFOOD], impersonando: false };
    req.tenant = { ...tenantAtual };
    next();
  }, requireModulo(MODULOS.IFOOD), ifoodRouter);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  after(() => { server.close(); supabase.from = fromOriginal; globalThis.fetch = fetchOriginal; config.ifood.financialHomologacaoUnidades = allowlistOriginal; });
  const get = (url) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method: "GET", path: url, headers: { [HEADER]: "true", "x-amostra-homologacao": "true" } }, (res) => {
      let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, corpo: b }));
    });
    req.on("error", reject); req.end();
  });

  test("unidade B (real) forçando por query e header: fixture DESCARTADA, fonte real, sem header ao iFood", async () => {
    tenantAtual = { organizacaoId: "org-1", unidadeId: UNI_B };
    const { r } = await quieto(() => get(`/api/v1/financial/sales?inicio=${PERIODO.inicio}&fim=${PERIODO.fim}&homologacao=true&amostraHomologacao=true`));
    assert.equal(r.status, 200, r.corpo);
    const { data } = JSON.parse(r.corpo);
    assert.deepEqual(data.vendas, []);
    assert.equal(data.fonte, "real");
    assert.equal(data.amostraHomologacao, false);
    assert.equal(HEADER in chamadas.at(-1).headers, false);
    const ev = await quieto(() => get(`/api/v1/financial/events?inicio=${PERIODO.inicio}&fim=${PERIODO.fim}&homologacao=true`));
    assert.deepEqual(JSON.parse(ev.r.corpo).data.eventos, []);
  });

  test("unidade A (allowlist): mesma resposta vira amostra marcada, sem `validacao` nem documentos", async () => {
    tenantAtual = { organizacaoId: "org-1", unidadeId: UNI_A };
    const { r } = await quieto(() => get(`/api/v1/financial/sales?inicio=${PERIODO.inicio}&fim=${PERIODO.fim}`));
    const { data } = JSON.parse(r.corpo);
    assert.equal(data.vendas.length, 1);
    assert.equal(data.fonte, "fixture");
    assert.equal(data.amostraHomologacao, true);
    assert.deepEqual(data.amostra.merchants, ["f07d****7c00"]);
    assert.equal("validacao" in data, false);
    assert.ok(!r.corpo.includes("11222333000181"));
    assert.equal(chamadas.at(-1).headers[HEADER], "true");
  });
});
