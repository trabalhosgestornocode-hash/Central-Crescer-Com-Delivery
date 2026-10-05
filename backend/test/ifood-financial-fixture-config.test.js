// IFOOD_FINANCIAL_FIXTURE (parse estrito + trava de produção), rotas decidindo
// fixture x real só pela config, marcação `fonte`, e temImpactoRepasse null na
// conciliação. Zero rede real, zero banco.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";

const { resolverFixtureFinanceira, PROJETO_TESTE_REF, PROJETO_PRODUCAO_REF } = await import("../src/modules/ifood/ifood.ambienteTeste.js");
const { config } = await import("../src/config/env.js");
const financial = await import("../src/modules/ifood/ifoodFinancial.service.js");
const { mapearEventoFinanceiro } = await import("../src/modules/ifood/ifoodFinancial.mapper.js");
const { conciliarFinancial, conciliarSalesComEvents, conciliarEventsComSettlements, STATUS_CONCILIACAO } = await import("../src/modules/ifood/ifoodFinancial.reconciliation.js");
const { cifrar } = await import("../src/shared/cripto.js");
const { supabase } = await import("../src/config/supabase.js");
const { ifoodRouter } = await import("../src/modules/ifood/ifood.routes.js");
const { requireModulo } = await import("../src/middlewares/auth.js");
const { errorHandler } = await import("../src/middlewares/errorHandler.js");
const { MODULOS } = await import("../src/shared/modulos.js");
const { permissoesDoPapel } = await import("../src/shared/permissoes.js");

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(AQUI, "..");
const MERCHANT = "55c8f464-e65f-4340-b2c7-62d143027040";
const HEADER = "x-request-homologation";
const TESTE = { SUPABASE_URL: `https://${PROJETO_TESTE_REF}.supabase.co` };
const PROD = { SUPABASE_URL: `https://${PROJETO_PRODUCAO_REF}.supabase.co` };
const credValida = () => ({ access_token_cifrado: cifrar("AT-atual"), refresh_token_cifrado: cifrar("RT-atual"), expira_em: new Date(Date.now() + 3_600_000).toISOString(), status: "ativa" });

function silenciar() {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = () => {};
  return () => Object.assign(console, orig);
}

// ---------------------------------------------------------------------------
// [1-4] parse estrito + trava de produção
// ---------------------------------------------------------------------------
describe("resolverFixtureFinanceira", () => {
  test("[1] ausente, vazio ou 'false' -> false (default seguro), em qualquer ambiente", () => {
    for (const v of [undefined, "", "false", "  false ", "FALSE"]) {
      assert.equal(resolverFixtureFinanceira({ ...PROD, IFOOD_FINANCIAL_FIXTURE: v }), false, JSON.stringify(v));
    }
  });
  test("[2] 'true' no ambiente de teste (Supabase de teste, fora do Render, não-production) -> true", () => {
    assert.equal(resolverFixtureFinanceira({ ...TESTE, IFOOD_FINANCIAL_FIXTURE: "true" }), true);
    assert.equal(resolverFixtureFinanceira({ ...TESTE, IFOOD_FINANCIAL_FIXTURE: " TRUE " }), true);
  });
  test("[3] valor ambíguo ('1', 'yes', 'sim', 'on') é REJEITADO — nunca vira truthy nem falsy em silêncio", () => {
    for (const v of ["1", "yes", "sim", "on", "0", "no"]) {
      assert.throws(() => resolverFixtureFinanceira({ ...TESTE, IFOOD_FINANCIAL_FIXTURE: v }), /IFOOD_FINANCIAL_FIXTURE inválida/, v);
    }
  });
  test("[4] 'true' em produção é recusado: Supabase de produção, Render ou NODE_ENV=production", () => {
    for (const env of [PROD, { ...TESTE, RENDER: "true" }, { ...TESTE, NODE_ENV: "production" }, { SUPABASE_URL: "https://outro.supabase.co" }]) {
      assert.throws(() => resolverFixtureFinanceira({ ...env, IFOOD_FINANCIAL_FIXTURE: "true" }), /recusada/, JSON.stringify(env));
    }
  });
  test("[1b] independente de IFOOD_HOMOLOGATION_MODE", () => {
    assert.equal(resolverFixtureFinanceira({ ...TESTE, IFOOD_HOMOLOGATION_MODE: "true" }), false);
  });

  const subir = (extra) => spawnSync(process.execPath, ["--input-type=module", "-e",
    "const { config } = await import('./src/config/env.js'); console.log('FIXTURE=' + JSON.stringify(config.ifood.financialFixture));"], {
    cwd: BACKEND, encoding: "utf8",
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40), SUPABASE_ANON_KEY: "y".repeat(40), ...extra },
  });

  test("[4b] env.js: fixture=true com Supabase de PRODUÇÃO -> o processo NÃO sobe (exit 1)", () => {
    const r = subir({ ...PROD, IFOOD_FINANCIAL_FIXTURE: "true" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /IFOOD_FINANCIAL_FIXTURE=true recusada/);
    assert.doesNotMatch(r.stdout, /FIXTURE=/);
  });
  test("[3b] env.js: 'false' literal -> config.ifood.financialFixture === false; ausente -> false; 'true' em teste -> true", () => {
    assert.match(subir({ ...PROD, IFOOD_FINANCIAL_FIXTURE: "false" }).stdout, /FIXTURE=false/);
    assert.match(subir({ ...PROD }).stdout, /FIXTURE=false/);
    assert.match(subir({ ...TESTE, IFOOD_FINANCIAL_FIXTURE: "true" }).stdout, /FIXTURE=true/);
  });
  test("[3c] env.js: valor inválido -> o processo NÃO sobe", () => {
    const r = subir({ ...TESTE, IFOOD_FINANCIAL_FIXTURE: "1" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /IFOOD_FINANCIAL_FIXTURE inválida/);
  });
});

// ---------------------------------------------------------------------------
// [6-8] mapper + [10] conciliação não trata null como false
// ---------------------------------------------------------------------------
describe("temImpactoRepasse", () => {
  const ev = (hasTransferImpact, value = "-1") => mapearEventoFinanceiro({ name: "X", amount: { value }, hasTransferImpact, reference: { type: "ORDER", id: "o1" } });
  test("[6] true -> true", () => assert.equal(ev(true).temImpactoRepasse, true));
  test("[7] false -> false", () => assert.equal(ev(false).temImpactoRepasse, false));
  test("[8] ausente / 'true' string / null -> null (não informado, nunca false)", () => {
    for (const v of [undefined, null, "true", 1]) assert.equal(ev(v).temImpactoRepasse, null, JSON.stringify(v));
  });

  test("[10] conciliarFinancial: null não entra em 'sem impacto'; saldoImpactante vira null (não um parcial)", () => {
    const r = conciliarFinancial({ periodo: {}, sales: null, events: { eventos: [ev(true, "10"), ev(false, "-2"), ev(undefined, "-3")] }, settlements: null, reconciliation: null, anticipations: null });
    assert.equal(r.eventos.comImpactoTransferencia, 1);
    assert.equal(r.eventos.semImpactoTransferencia, 1);
    assert.equal(r.eventos.impactoNaoInformado, 1);
    assert.equal(r.eventos.saldoImpactante, null);
  });
  test("[10b] conciliarFinancial sem nulls: saldoImpactante continua somando só os true", () => {
    const r = conciliarFinancial({ periodo: {}, sales: null, events: { eventos: [ev(true, "10"), ev(false, "-2")] }, settlements: null, reconciliation: null, anticipations: null });
    assert.equal(r.eventos.saldoImpactante, 10);
    assert.equal(r.eventos.impactoNaoInformado, 0);
  });
  test("[10c] Sales×Events: venda com evento de impacto desconhecido -> INCOMPLETO (não DIVERGENTE/CONCILIADO)", () => {
    const venda = { id: "o1", shortId: "1", resumoFinanceiro: { saldo: 10 } };
    const eventos = [{ ...ev(true, "10"), referencia: { tipo: "ORDER", id: "o1" } }, { ...ev(undefined, "0"), referencia: { tipo: "ORDER", id: "o1" } }];
    const r = conciliarSalesComEvents([venda], eventos);
    assert.equal(r.porVenda[0].status, STATUS_CONCILIACAO.INCOMPLETO);
    assert.equal(r.porVenda[0].eventosSemImpacto, 0);
    assert.equal(r.porVenda[0].eventosImpactoNaoInformado, 1);
  });
  test("[10d] Events×Settlements: impacto desconhecido -> INCOMPLETO; sem nulls continua comparando", () => {
    const comNull = conciliarEventsComSettlements([ev(true, "10"), ev(undefined, "5")], { saldo: 10, titulos: [] });
    assert.equal(comNull.status, STATUS_CONCILIACAO.INCOMPLETO);
    assert.equal(comNull.eventosImpactoNaoInformado, 1);
    const semNull = conciliarEventsComSettlements([ev(true, "10"), ev(false, "5")], { saldo: 10, titulos: [] });
    assert.equal(semNull.status, STATUS_CONCILIACAO.CONCILIADO);
  });
});

// ---------------------------------------------------------------------------
// Parte 2 — fixture marcada e isolada
// ---------------------------------------------------------------------------
describe("fixture nunca se passa por dado real", () => {
  const repo = {
    async obterConexaoViva() { return { id: "conx-1", status: "ativa", merchant_id: MERCHANT }; },
    async obterCredencial() { return credValida(); },
  };
  const httpGravador = () => {
    const chamadas = [];
    return {
      chamadas,
      async getJson(caminho, opts) { chamadas.push({ rotulo: opts.rotulo, homologacao: opts.homologacao }); return {}; },
      async postForm() { throw new Error("sem refresh"); },
      async postJson() { throw new Error("sem escrita"); },
    };
  };
  test("listarSales/listarFinancialEvents marcam fonte 'real' (false) x 'fixture' (true)", async () => {
    const restaurar = silenciar();
    try {
      const h = httpGravador();
      const base = { organizacaoId: "o", unidadeId: "u", inicio: "2026-09-21", fim: "2026-09-29", deps: { repo, http: h } };
      assert.equal((await financial.listarSales({ ...base, homologacao: false })).fonte, "real");
      assert.equal((await financial.listarSales({ ...base, homologacao: true })).fonte, "fixture");
      assert.equal((await financial.listarFinancialEvents({ ...base, homologacao: false })).fonte, "real");
      assert.equal((await financial.listarFinancialEvents({ ...base })).fonte, "real", "omitido: unidade fora da allowlist");
      assert.equal((await financial.listarFinancialEvents({ ...base, deps: { ...base.deps, homologacaoFinancial: () => true } })).fonte, "fixture");
    } finally { restaurar(); }
  });
  test("conciliação: UM modo para TODAS as fontes (nunca mistura real com fixture), decidido pela unidade", async () => {
    const restaurar = silenciar();
    try {
      for (const [emHomologacao, fonte] of [[false, "real"], [true, "fixture"]]) {
        const h = httpGravador();
        const r = await financial.obterConciliacaoFinanceira({ organizacaoId: "o", unidadeId: "u", inicio: "2026-09-21", fim: "2026-09-29", deps: { repo, http: h, homologacaoFinancial: () => emHomologacao } });
        assert.equal(r.fonte, fonte);
        const porRotulo = Object.fromEntries(h.chamadas.map((c) => [c.rotulo, c.homologacao]));
        for (const rot of ["financial.sales", "financial.events", "financial.settlements", "financial.anticipations"]) {
          assert.equal(porRotulo[rot], emHomologacao, `${rot} (homologação=${emHomologacao})`);
        }
      }
    } finally { restaurar(); }
  });
});

// ---------------------------------------------------------------------------
// [5][11][12] rotas: só a config decide; nada persiste; só GET
// ---------------------------------------------------------------------------
describe("rotas Sales/Events seguem IFOOD_FINANCIAL_FIXTURE, nunca a query", async () => {
  const fixtureOriginal = config.ifood.financialFixture;
  const fromOriginal = supabase.from;
  const fetchOriginal = globalThis.fetch;
  const escritas = [];
  supabase.from = (tabela) => {
    const linha = tabela === "ifood_conexoes" ? { id: "conx-1", organizacao_id: "org-1", unidade_id: "uni-1", status: "ativa", merchant_id: MERCHANT }
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
    const corpo = String(url).includes("/sales") ? [{ page: 1, sales: [] }] : [{ page: 1, financialEvents: [] }];
    return { ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) }, text: async () => JSON.stringify(corpo) };
  };
  const app = express();
  app.use("/api/v1", (req, _res, next) => {
    req.user = { id: "u-fixture-config" };
    req.acesso = { papel: "unit_manager", permissoes: permissoesDoPapel("unit_manager"), modulos: [MODULOS.IFOOD], impersonando: false };
    req.tenant = { organizacaoId: "org-1", unidadeId: "uni-1" };
    next();
  }, requireModulo(MODULOS.IFOOD), ifoodRouter);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  after(() => { server.close(); supabase.from = fromOriginal; globalThis.fetch = fetchOriginal; config.ifood.financialFixture = fixtureOriginal; });

  const get = (url) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method: "GET", path: url }, (res) => {
      let corpo = ""; res.on("data", (c) => { corpo += c; }); res.on("end", () => resolve({ status: res.statusCode, corpo }));
    });
    req.on("error", reject); req.end();
  });
  const Q = "inicio=2026-09-21&fim=2026-09-29";

  test("[5a] config=false (default): SEM header, mesmo com ?homologacao=true na query", async () => {
    config.ifood.financialFixture = false;
    const antes = chamadasIfood.length;
    const restaurar = silenciar();
    try {
      for (const rota of ["sales", "events"]) {
        const r = await get(`/api/v1/financial/${rota}?${Q}&homologacao=true&fixture=true`);
        assert.equal(r.status, 200, r.corpo);
        assert.equal(JSON.parse(r.corpo).data.fonte, "real");
      }
    } finally { restaurar(); }
    for (const c of chamadasIfood.slice(antes)) {
      assert.equal(HEADER in c.headers, false, c.url);
      assert.doesNotMatch(c.url, /homologacao|fixture/);
    }
  });

  test("[5b] config=true: header enviado, mesmo com ?homologacao=false na query", async () => {
    config.ifood.financialFixture = true;
    const antes = chamadasIfood.length;
    const restaurar = silenciar();
    try {
      for (const rota of ["sales", "events"]) {
        const r = await get(`/api/v1/financial/${rota}?${Q}&homologacao=false`);
        assert.equal(JSON.parse(r.corpo).data.fonte, "fixture");
      }
    } finally { restaurar(); }
    for (const c of chamadasIfood.slice(antes)) assert.equal(c.headers[HEADER], "true", c.url);
  });

  test("[11][12] nenhuma escrita no banco e só GET no iFood", () => {
    assert.deepEqual(escritas, []);
    assert.ok(chamadasIfood.length >= 4);
    assert.ok(chamadasIfood.every((c) => c.metodo === "GET"));
  });
});
