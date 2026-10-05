// Checkpoint SALES REAL SEM FIXTURE — header de homologação condicional, merchant
// obrigatório, período conferido, documentos/CPF fora da resposta, null != zero.
// Zero rede real e zero banco: fetch falso + supabase.from falso (só na prova de rota).
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-client-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-client-secret";

const financial = await import("../src/modules/ifood/ifoodFinancial.service.js");
const httpClient = await import("../src/modules/ifood/ifoodHttp.client.js");
const { mapearVenda } = await import("../src/modules/ifood/ifoodFinancial.mapper.js");
const { cifrar } = await import("../src/shared/cripto.js");
const { supabase } = await import("../src/config/supabase.js");
const { config } = await import("../src/config/env.js");
const { ifoodRouter } = await import("../src/modules/ifood/ifood.routes.js");
const { requireModulo } = await import("../src/middlewares/auth.js");
const { errorHandler } = await import("../src/middlewares/errorHandler.js");
const { MODULOS } = await import("../src/shared/modulos.js");
const { permissoesDoPapel } = await import("../src/shared/permissoes.js");

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const MERCHANT = "55c8f464-e65f-4340-b2c7-62d143027040";
const MERCHANT_FIXTURE = "f07d23bd-74fc-47fa-9abf-2889e8127c00";
const TENANT = { organizacaoId: "org-1", unidadeId: "uni-1" };
const PERIODO = { inicio: "2026-09-26", fim: "2026-09-27" };
const CPF = "12345678909";
const CNPJ = "11222333000181";
const HEADER = "x-request-homologation";
const daquiA = (ms) => new Date(Date.now() + ms).toISOString();

const credValida = () => ({ access_token_cifrado: cifrar("AT-atual"), refresh_token_cifrado: cifrar("RT-atual"), expira_em: daquiA(3_600_000), status: "ativa" });

function repoFalso() {
  const chamadas = [];
  const alvo = {
    async obterConexaoViva() { return { id: "conx-1", organizacao_id: "org-1", unidade_id: "uni-1", status: "ativa", merchant_id: MERCHANT }; },
    async obterCredencial() { return credValida(); },
    async salvarCredencial() { throw new Error("não deveria salvar"); },
    async atualizarCredencial() { throw new Error("não deveria atualizar"); },
  };
  const repo = new Proxy(alvo, { get: (t, n) => (typeof t[n] === "function" ? (...a) => { chamadas.push(n); return t[n](...a); } : t[n]) });
  return { repo, chamadas };
}

function resposta(status, corpo) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) }, text: async () => JSON.stringify(corpo) };
}

function fetchFalso(corpo) {
  const chamadas = [];
  const fn = async (url, init) => { chamadas.push({ url, metodo: init.method, headers: init.headers }); return resposta(200, corpo); };
  fn.chamadas = chamadas;
  return fn;
}

const httpReal = (fetchImpl) => ({
  getJson: (c, o) => httpClient.getJson(c, { ...o, fetchImpl }),
  postForm: (c, campos, o) => httpClient.postForm(c, campos, { ...(o ?? {}), fetchImpl }),
});

function venda(over = {}) {
  return {
    id: "a1b2c3d4-0000-0000-0000-000000000001", shortId: "1001", createdAt: "2026-09-27T15:00:00.000Z",
    type: "ORDER", category: "FOOD", salesChannel: "IFOOD", currentStatus: "CONCLUDED",
    merchant: { id: MERCHANT, shortId: 4078865, name: "Teste - Loja", type: "RESTAURANT", timezone: "Etc/GMT+3",
      documents: [{ type: "CNPJ", value: CNPJ }, { type: "CPF", value: CPF }, { type: "MCC", value: "5812" }] },
    saleGrossValue: { bag: 40, deliveryFee: 5, serviceFee: 0.99 },
    billingSummary: { saleBalance: 36.4, billingEntries: [{ name: "ORDER_PAYMENT", value: 45.99 }] },
    ...over,
  };
}
const envelope = (sales, over = {}) => ({ page: 1, size: sales.length, beginSalesDate: PERIODO.inicio, endSalesDate: PERIODO.fim, sales, total: sales.length, pageCount: 1, ...over });

// Reproduz a fixture observada no checkpoint anterior: outro merchant, período 2025-08-01.
const FIXTURE = envelope([venda({ id: "f892eb0b-0000-0000-0000-000000000000", createdAt: "2025-08-01T15:23:33.832Z",
  merchant: { id: MERCHANT_FIXTURE, shortId: 0, name: "Fixture", timezone: "Etc/GMT+3", documents: [{ type: "CPF", value: "99999999999" }] } })],
{ beginSalesDate: "2025-08-01", endSalesDate: "2025-08-01", size: 2, total: 2 });

const chamar = (extra, f, repo = repoFalso().repo) => financial.listarSales({ ...TENANT, ...PERIODO, ...extra, deps: { repo, http: httpReal(f) } });

function silenciar() {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const linhas = [];
  for (const k of Object.keys(orig)) console[k] = (...a) => linhas.push(a.map(String).join(" "));
  return { linhas, restaurar: () => Object.assign(console, orig) };
}

// ---------------------------------------------------------------------------
// 1-3. header de homologação
// ---------------------------------------------------------------------------
describe("header x-request-homologation (Sales)", () => {
  test("[1] homologacao:true -> envia o header", async () => {
    const f = fetchFalso(envelope([venda()]));
    await chamar({ homologacao: true }, f);
    assert.equal(f.chamadas[0].headers[HEADER], "true");
  });

  test("[1b] homologacao omitido -> decide a UNIDADE: fora da allowlist = SEM header", async () => {
    const f = fetchFalso(envelope([venda()]));
    await chamar({}, f);
    assert.equal(HEADER in f.chamadas[0].headers, false);
  });

  test("[2] homologacao:false -> NÃO envia o header (e o resto da requisição é idêntico)", async () => {
    const f = fetchFalso(envelope([venda()]));
    await chamar({ homologacao: false }, f);
    const h = f.chamadas[0].headers;
    assert.equal(HEADER in h, false);
    assert.equal(h.Authorization, "Bearer AT-atual");
    assert.equal(f.chamadas[0].url, `https://mock.ifood.test/financial/v3.0/merchants/${MERCHANT}/sales?beginSalesDate=2026-09-26&endSalesDate=2026-09-27&page=1`);
  });

  test("[2c] valor não-boolean (ex.: 'true' vindo de query) NÃO liga o header — decide a unidade", async () => {
    for (const v of ["true", "false", 1, 0, null, "nao"]) {
      const f = fetchFalso(envelope([venda()]));
      await chamar({ homologacao: v }, f);
      assert.equal(HEADER in f.chamadas[0].headers, false, `homologacao=${JSON.stringify(v)}`);
    }
  });

  test("[3] demais APIs Financial seguem a UNIDADE: fora da allowlist, sem header", async () => {
    const casos = [
      ["events", () => financial.listarFinancialEvents({ ...TENANT, ...PERIODO, deps: { repo: repoFalso().repo, http: httpReal(fev) } })],
      ["settlements", () => financial.listarSettlements({ ...TENANT, modo: "calculo", ...PERIODO, deps: { repo: repoFalso().repo, http: httpReal(fset) } })],
      ["anticipations", () => financial.listarAnticipations({ ...TENANT, modo: "calculo", ...PERIODO, deps: { repo: repoFalso().repo, http: httpReal(fant) } })],
    ];
    const fev = fetchFalso({ financialEvents: [] });
    const fset = fetchFalso({ settlements: [] });
    const fant = fetchFalso({ anticipations: [] });
    const cap = silenciar();
    try { for (const [, fn] of casos) await fn().catch(() => {}); } finally { cap.restaurar(); }
    for (const [nome, f] of [["events", fev], ["settlements", fset], ["anticipations", fant]]) {
      assert.ok(f.chamadas.length >= 1, `${nome}: esperava 1 chamada`);
      assert.equal(HEADER in f.chamadas[0].headers, false, `${nome}: unidade fora da allowlist não envia o header`);
    }
  });

  test("[3b] Merchant/Order/Events/OAuth nunca passam `homologacao` (o header não é global)", () => {
    const dir = path.join(AQUI, "../src/modules/ifood");
    for (const arq of ["ifoodMerchant.service.js", "ifoodOrder.client.js", "ifoodEvents.client.js", "ifoodHandshake.client.js", "ifoodAuth.service.js", "ifoodToken.service.js", "ifoodAuthProvider.js"]) {
      const src = readFileSync(path.join(dir, arq), "utf8");
      assert.doesNotMatch(src, /homologacao\s*:/, `${arq} não deveria passar homologacao ao http client`);
    }
    const cliente = readFileSync(path.join(dir, "ifoodHttp.client.js"), "utf8");
    assert.equal((cliente.match(/if \(homologacao === true\) headers\[HEADER_HOMOLOGACAO\]/g) ?? []).length, 3, "header só por opt-in explícito");
  });
});

// ---------------------------------------------------------------------------
// 4-5. merchant obrigatório
// ---------------------------------------------------------------------------
describe("merchant obrigatoriamente correto", () => {
  test("[4] merchant correto -> venda aceita, resposta válida", async () => {
    const r = await chamar({ homologacao: false }, fetchFalso(envelope([venda()])));
    assert.equal(r.vendas.length, 1);
    assert.equal(r.validacao.valida, true);
    assert.deepEqual(r.validacao.motivos, []);
  });

  test("[5] MODO REAL: merchant diferente -> venda descartada, resposta inválida, log sanitizado com esperado x recebido", async () => {
    const cap = silenciar();
    let r;
    try { r = await chamar({ homologacao: false }, fetchFalso(FIXTURE)); } finally { cap.restaurar(); }
    assert.deepEqual(r.vendas, []);
    assert.equal(r.fonte, "real");
    assert.equal(r.amostraHomologacao, false);
    assert.equal(r.validacao.divergencia, "rejeitada");
    assert.equal(r.validacao.valida, false);
    assert.ok(r.validacao.motivos.includes("MERCHANT_DIVERGENTE"));
    assert.equal(r.validacao.merchant.esperado, "55c8****7040");
    assert.deepEqual(r.validacao.merchant.recebidosDivergentes, ["f07d****7c00"]);
    assert.equal(r.validacao.merchant.vendasDescartadas, 1);
    const log = cap.linhas.join("\n");
    assert.match(log, /financial\.sales\.resposta_invalida/);
    assert.ok(!log.includes("99999999999") && !/documents|documentos/i.test(log), "log não pode ter documentos");
  });

  test("[5c] HOMOLOGAÇÃO: venda da fixture oficial (outra loja/período) -> MANTIDA como amostra, log 'fixture_oficial_aceita'", async () => {
    const cap = silenciar();
    let r;
    try { r = await chamar({ homologacao: true }, fetchFalso(FIXTURE)); } finally { cap.restaurar(); }
    assert.equal(r.vendas.length, 1);
    assert.equal(r.vendas[0].merchant.id, MERCHANT_FIXTURE, "dado da fixture preservado como veio");
    assert.equal(r.fonte, "fixture");
    assert.equal(r.amostraHomologacao, true);
    assert.deepEqual(r.amostra.merchants, ["f07d****7c00"]);
    assert.equal(r.validacao.merchant.vendasDescartadas, 0);
    assert.equal(r.validacao.merchant.fixtureAceitas, 1);
    assert.equal(r.validacao.divergencia, "fixture_oficial_aceita");
    const log = cap.linhas.join("\n");
    assert.match(log, /financial\.sales\.fixture_aceita/);
    assert.doesNotMatch(log, /financial\.sales\.resposta_invalida/);
    assert.ok(!log.includes("99999999999") && !/documents|documentos/i.test(log) && !log.includes(MERCHANT_FIXTURE));
  });

  test("[5b] resposta mista: só a venda do merchant consultado segue; a outra é descartada", async () => {
    const cap = silenciar();
    let r;
    try {
      r = await chamar({ homologacao: false }, fetchFalso(envelope([venda({ id: "nossa" }), venda({ id: "alheia", merchant: { id: MERCHANT_FIXTURE } })])));
    } finally { cap.restaurar(); }
    assert.deepEqual(r.vendas.map((v) => v.id), ["nossa"]);
    assert.equal(r.validacao.valida, false);
  });
});

// ---------------------------------------------------------------------------
// 8. período
// ---------------------------------------------------------------------------
describe("período", () => {
  test("[8] período ecoado divergente é detectado e NÃO vira o período exposto", async () => {
    const cap = silenciar();
    let r;
    try { r = await chamar({ homologacao: true }, fetchFalso(FIXTURE)); } finally { cap.restaurar(); }
    assert.ok(r.validacao.motivos.includes("PERIODO_RETORNADO_DIVERGENTE"));
    assert.deepEqual(r.periodo, PERIODO);
    assert.deepEqual(r.validacao.periodo.retornado, { inicio: "2025-08-01", fim: "2025-08-01" });
    assert.equal(r.validacao.periodo.confere, false);
  });

  test("[8b] venda da loja com data (no fuso da loja) fora do período -> VENDAS_FORA_DO_PERIODO", async () => {
    const cap = silenciar();
    let r;
    try { r = await chamar({ homologacao: false }, fetchFalso(envelope([venda({ createdAt: "2026-09-25T12:00:00.000Z" })]))); } finally { cap.restaurar(); }
    assert.deepEqual(r.validacao.motivos, ["VENDAS_FORA_DO_PERIODO"]);
    assert.equal(r.validacao.periodo.vendasForaDoPeriodo, 1);
  });

  test("[8c] fronteira de fuso: 2026-09-27T02:37Z é 26/09 23:37 na loja -> dentro de 26..27", async () => {
    const r = await chamar({ homologacao: false }, fetchFalso(envelope([venda({ createdAt: "2026-09-27T02:37:45.539Z" })])));
    assert.equal(r.validacao.valida, true);
  });

  test("[8d] resposta sem metadados de período -> confere:null (não inventa divergência nem conformidade)", async () => {
    const r = await chamar({ homologacao: false }, fetchFalso(envelope([venda()], { beginSalesDate: undefined, endSalesDate: undefined })));
    assert.equal(r.validacao.periodo.confere, null);
    assert.equal(r.validacao.valida, true);
  });

  test("[4b] acesso válido + nenhuma venda: resposta VÁLIDA e vazia (≠ fixture ≠ sem permissão)", async () => {
    const r = await chamar({ homologacao: false }, fetchFalso(envelope([], { total: 0, pageCount: 0 })));
    assert.deepEqual(r.vendas, []);
    assert.equal(r.validacao.valida, true);
    assert.equal(r.validacao.merchant.vendasDescartadas, 0);
  });
});

// ---------------------------------------------------------------------------
// 9. null != zero
// ---------------------------------------------------------------------------
describe("ausência de valor não vira zero", () => {
  test("[9] bag ausente -> valor bruto desconhecido (null), nunca 'venda de R$ 0'", () => {
    const v = mapearVenda(venda({ saleGrossValue: { deliveryFee: 5 } }));
    assert.deepEqual(v.valorBruto, { itens: null, entrega: null, taxaServico: null, total: null });
    assert.deepEqual(mapearVenda(venda({ saleGrossValue: undefined })).valorBruto, { itens: null, entrega: null, taxaServico: null, total: null });
  });

  test("[9b] deliveryFee/serviceFee ausentes com bag presente -> 0 (doc: ausente = não cobrado)", () => {
    const v = mapearVenda(venda({ saleGrossValue: { bag: 30 } }));
    assert.deepEqual(v.valorBruto, { itens: 30, entrega: 0, taxaServico: 0, total: 30 });
  });

  test("[9c] saleBalance ausente -> saldo null; billingEntry sem valor -> valor null e tipo null", () => {
    const v = mapearVenda(venda({ billingSummary: { billingEntries: [{ name: "ORDER_PAYMENT" }, { name: "ORDER_COMMISSION", value: -3 }] } }));
    assert.equal(v.resumoFinanceiro.saldo, null);
    assert.deepEqual(v.resumoFinanceiro.lancamentos, [{ nome: "ORDER_PAYMENT", valor: null, tipo: null }, { nome: "ORDER_COMMISSION", valor: -3, tipo: "debito" }]);
  });

  test("[9d] zero REAL continua zero (saldo 0 de pedido cancelado)", () => {
    const v = mapearVenda(venda({ currentStatus: "CANCELLED", billingSummary: { saleBalance: 0, billingEntries: [] } }));
    assert.equal(v.resumoFinanceiro.saldo, 0);
  });
});

// ---------------------------------------------------------------------------
// 10-11. read-only
// ---------------------------------------------------------------------------
describe("read-only", () => {
  test("[10] homologacao:false não persiste nada: repo só é LIDO, mesmo com fixture descartada", async () => {
    const { repo, chamadas } = repoFalso();
    const cap = silenciar();
    try { await chamar({ homologacao: false }, fetchFalso(FIXTURE), repo); } finally { cap.restaurar(); }
    assert.deepEqual([...new Set(chamadas)].sort(), ["obterConexaoViva", "obterCredencial"]);
  });

  test("[11] nenhum endpoint de escrita: 1 única requisição, GET, no path de sales", async () => {
    const f = fetchFalso(envelope([venda()]));
    await chamar({ homologacao: false }, f);
    assert.equal(f.chamadas.length, 1);
    assert.equal(f.chamadas[0].metodo, "GET");
    assert.match(f.chamadas[0].url, /\/financial\/v3\.0\/merchants\/[^/]+\/sales\?/);
  });
});

// ---------------------------------------------------------------------------
// 6-7. rota interna: documents/CPF não chegam ao frontend
// ---------------------------------------------------------------------------
describe("[6][7] GET /financial/sales (rota real) não expõe documents/CPF/CNPJ", async () => {
  const fromOriginal = supabase.from;
  const fetchOriginal = globalThis.fetch;
  const tabelasTocadas = [];
  const escritas = [];

  // Banco falso: só as duas leituras que a rota faz (conexão viva + credencial).
  supabase.from = (tabela) => {
    tabelasTocadas.push(tabela);
    const linha = tabela === "ifood_conexoes"
      ? { id: "conx-1", organizacao_id: "org-1", unidade_id: "uni-1", status: "ativa", merchant_id: MERCHANT }
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
    chamadasIfood.push({ url: String(url), metodo: init.method, headers: init.headers });
    return resposta(200, [envelope([venda()])]);
  };

  const app = express();
  app.use("/api/v1", (req, _res, next) => {
    req.user = { id: "u-sales-docs" };
    req.acesso = { papel: "unit_manager", permissoes: permissoesDoPapel("unit_manager"), modulos: [MODULOS.IFOOD], impersonando: false };
    req.tenant = { organizacaoId: "org-1", unidadeId: "uni-1" };
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

  test("resposta 200 sem documents/documentos, sem CPF e sem CNPJ — só id/nome do merchant, status, datas, valores, paginação", async () => {
    const cap = silenciar();
    let r;
    try { r = await get(`/api/v1/financial/sales?inicio=${PERIODO.inicio}&fim=${PERIODO.fim}&merchantId=${MERCHANT_FIXTURE}`); } finally { cap.restaurar(); }
    assert.equal(r.status, 200, r.corpo);
    assert.doesNotMatch(r.corpo, /documents?|documentos/i);
    assert.ok(!r.corpo.includes(CPF), "CPF vazou");
    assert.ok(!r.corpo.includes(CNPJ), "CNPJ vazou");
    assert.ok(!r.corpo.includes("5812"), "MCC vazou");
    const { data } = JSON.parse(r.corpo);
    assert.equal(data.vendas[0].merchant.id, MERCHANT);
    assert.equal(data.vendas[0].merchant.nome, "Teste - Loja");
    assert.equal(data.vendas[0].status, "CONCLUDED");
    assert.equal(data.vendas[0].criadoEm, "2026-09-27T15:00:00.000Z");
    assert.equal(data.vendas[0].valorBruto.total, 45.99);
    assert.equal("validacao" in data, false, "validacao é diagnóstico backend-only");
  });

  test("a rota usou o merchant da conexão (ignorou ?merchantId=), fez 1 GET e não escreveu no banco", () => {
    assert.equal(chamadasIfood.length, 1);
    assert.equal(chamadasIfood[0].metodo, "GET");
    assert.ok(chamadasIfood[0].url.includes(`/merchants/${MERCHANT}/sales`));
    assert.ok(!chamadasIfood[0].url.includes(MERCHANT_FIXTURE));
    assert.deepEqual(escritas, []);
    assert.deepEqual([...new Set(tabelasTocadas)].sort(), ["ifood_conexoes", "ifood_credenciais"]);
  });

  test("a rota segue IFOOD_FINANCIAL_FIXTURE (config do backend) para o header", () => {
    assert.equal(HEADER in chamadasIfood[0].headers, config.ifood.financialFixture === true);
  });
});
