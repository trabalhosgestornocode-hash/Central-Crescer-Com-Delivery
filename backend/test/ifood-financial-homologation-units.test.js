// Homologação Financial POR UNIDADE (IFOOD_FINANCIAL_HOMOLOGATION_UNITS).
//   * parser fail-closed (ausente, vazia, 1, vários, inválido, espaços, duplicados);
//   * decisão central (usarHomologacaoFinancial) a partir do tenant;
//   * rotas: query/body/header do navegador NÃO ligam a homologação;
//   * Merchant, Order e Events operacional não usam a allowlist;
//   * guard da flag global IFOOD_FINANCIAL_FIXTURE preservado em produção/Render;
//   * log de boot só com a quantidade; /status expõe só um booleano.
// Zero rede real e zero banco.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-client-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-client-secret";

const { usarHomologacaoFinancial, totalUnidadesHomologacaoFinancial } = await import("../src/modules/ifood/ifoodFinancialHomologacao.js");
const { PROJETO_TESTE_REF, PROJETO_PRODUCAO_REF } = await import("../src/modules/ifood/ifood.ambienteTeste.js");
const { config } = await import("../src/config/env.js");
const merchantService = await import("../src/modules/ifood/ifoodMerchant.service.js");
const conn = await import("../src/modules/ifood/ifoodConnection.service.js");
const { cifrar } = await import("../src/shared/cripto.js");
const { supabase } = await import("../src/config/supabase.js");
const { ifoodRouter } = await import("../src/modules/ifood/ifood.routes.js");
const { requireModulo } = await import("../src/middlewares/auth.js");
const { errorHandler } = await import("../src/middlewares/errorHandler.js");
const { MODULOS } = await import("../src/shared/modulos.js");
const { permissoesDoPapel } = await import("../src/shared/permissoes.js");

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(AQUI, "..");
const SRC = (f) => readFileSync(path.join(BACKEND, "src", f), "utf8");
const HEADER = "x-request-homologation";
const UNI_A = "aaaaaaaa-0000-4000-8000-00000000000a"; // autorizada (homologação)
const UNI_B = "bbbbbbbb-0000-4000-8000-00000000000b"; // não autorizada
const UNI_C = "cccccccc-0000-4000-8000-00000000000c";
const MERCHANT = "55c8f464-e65f-4340-b2c7-62d143027040";
const TESTE = { SUPABASE_URL: `https://${PROJETO_TESTE_REF}.supabase.co` };
const PROD = { SUPABASE_URL: `https://${PROJETO_PRODUCAO_REF}.supabase.co` };

function silenciar() {
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = () => {};
  return () => Object.assign(console, orig);
}

// Sobe env.js num processo isolado e devolve a config resultante.
function subirEnv(extra) {
  return spawnSync(process.execPath, ["--input-type=module", "-e",
    "const { config } = await import('./src/config/env.js'); console.log('LISTA=' + JSON.stringify(config.ifood.financialHomologacaoUnidades) + ' FIXTURE=' + config.ifood.financialFixture);"], {
    cwd: BACKEND, encoding: "utf8",
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40), SUPABASE_ANON_KEY: "y".repeat(40), ...PROD, ...extra },
  });
}
const lista = (r) => JSON.parse(/LISTA=(\[[^\]]*\])/.exec(r.stdout)?.[1] ?? "null");

// ===========================================================================
describe("config: IFOOD_FINANCIAL_HOMOLOGATION_UNITS (fail-closed)", () => {
  test("ausente -> lista vazia", () => assert.deepEqual(lista(subirEnv({})), []));
  test("vazia / só espaços -> lista vazia", () => {
    assert.deepEqual(lista(subirEnv({ IFOOD_FINANCIAL_HOMOLOGATION_UNITS: "" })), []);
    assert.deepEqual(lista(subirEnv({ IFOOD_FINANCIAL_HOMOLOGATION_UNITS: "   " })), []);
  });
  test("1 UUID -> 1 unidade (normalizada em minúsculas)", () => {
    assert.deepEqual(lista(subirEnv({ IFOOD_FINANCIAL_HOMOLOGATION_UNITS: UNI_A.toUpperCase() })), [UNI_A]);
  });
  test("vários UUIDs, com espaços e duplicados -> únicos, na ordem", () => {
    const r = subirEnv({ IFOOD_FINANCIAL_HOMOLOGATION_UNITS: ` ${UNI_A} ,${UNI_C},  ${UNI_A.toUpperCase()} ` });
    assert.deepEqual(lista(r), [UNI_A, UNI_C]);
  });
  test("inválidos são ignorados e só CONTADOS no log (o valor nunca é impresso)", () => {
    const r = subirEnv({ IFOOD_FINANCIAL_HOMOLOGATION_UNITS: `${UNI_A},todas,*,nao-e-uuid` });
    assert.deepEqual(lista(r), [UNI_A]);
    assert.match(r.stderr, /IFOOD_FINANCIAL_HOMOLOGATION_UNITS: 3 valor\(es\) ignorado\(s\)/);
    for (const vazado of ["todas", "nao-e-uuid", UNI_A]) assert.ok(!r.stderr.includes(vazado), `vazou ${vazado}`);
  });
  test("'*' / 'all' / 'true' NUNCA liberam todas as unidades", () => {
    for (const v of ["*", "all", "true", "todas"]) assert.deepEqual(lista(subirEnv({ IFOOD_FINANCIAL_HOMOLOGATION_UNITS: v })), [], v);
  });
  test("a allowlist é aceita em produção (Supabase de produção, Render, NODE_ENV=production) — o processo sobe", () => {
    const r = subirEnv({ RENDER: "true", NODE_ENV: "production", IFOOD_FINANCIAL_HOMOLOGATION_UNITS: UNI_A });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /FIXTURE=false/);
    assert.deepEqual(lista(r), [UNI_A]);
  });
});

// ===========================================================================
describe("guard da flag global IFOOD_FINANCIAL_FIXTURE preservado", () => {
  test("FIXTURE=true no Render/produção continua NÃO subindo (exit 1), mesmo com allowlist definida", () => {
    for (const extra of [{}, { RENDER: "true" }, { NODE_ENV: "production" }]) {
      const r = subirEnv({ ...extra, IFOOD_FINANCIAL_FIXTURE: "true", IFOOD_FINANCIAL_HOMOLOGATION_UNITS: UNI_A });
      assert.equal(r.status, 1, JSON.stringify(extra));
      assert.match(r.stderr, /IFOOD_FINANCIAL_FIXTURE=true recusada/);
    }
  });
  test("FIXTURE=true só no ambiente de teste local (Supabase de teste, fora do Render)", () => {
    const r = subirEnv({ ...TESTE, IFOOD_FINANCIAL_FIXTURE: "true" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /FIXTURE=true/);
  });
});

// ===========================================================================
describe("decisão central: usarHomologacaoFinancial(unidadeId)", () => {
  const cfg = (unidades, fixture = false) => ({ ifood: { financialHomologacaoUnidades: unidades, financialFixture: fixture } });
  test("unidade na allowlist -> true; fora -> false", () => {
    assert.equal(usarHomologacaoFinancial(UNI_A, cfg([UNI_A])), true);
    assert.equal(usarHomologacaoFinancial(UNI_B, cfg([UNI_A])), false);
  });
  test("comparação normalizada (caixa/espaços do id do tenant)", () => {
    assert.equal(usarHomologacaoFinancial(` ${UNI_A.toUpperCase()} `, cfg([UNI_A])), true);
  });
  test("lista vazia / ausente -> nenhuma unidade", () => {
    for (const c of [cfg([]), cfg(undefined), {}, undefined]) assert.equal(usarHomologacaoFinancial(UNI_A, c), false);
  });
  test("unidade ausente/inválida -> false", () => {
    for (const u of [null, undefined, "", 123, {}]) assert.equal(usarHomologacaoFinancial(u, cfg([UNI_A])), false);
  });
  test("flag global (só possível em teste local) vale para todas", () => {
    assert.equal(usarHomologacaoFinancial(UNI_B, cfg([], true)), true);
  });
  test("total para o log de boot", () => {
    assert.equal(totalUnidadesHomologacaoFinancial(cfg([UNI_A, UNI_C])), 2);
    assert.equal(totalUnidadesHomologacaoFinancial(cfg(undefined)), 0);
  });
  test("a config real do processo de teste começa vazia (fail-closed)", () => {
    assert.deepEqual(config.ifood.financialHomologacaoUnidades, []);
  });
});

// ===========================================================================
describe("rotas: só req.tenant decide — query, body e header do navegador NÃO ligam a homologação", async () => {
  const fromOriginal = supabase.from;
  const fetchOriginal = globalThis.fetch;
  const allowlistOriginal = config.ifood.financialHomologacaoUnidades;
  let tenantAtual = { organizacaoId: "org-1", unidadeId: UNI_B };
  const conexaoDe = (unidadeId) => ({ id: `conx-${unidadeId.slice(0, 4)}`, organizacao_id: "org-1", unidade_id: unidadeId, status: "ativa", merchant_id: MERCHANT });
  before(() => { config.ifood.financialHomologacaoUnidades = [UNI_A]; });
  supabase.from = (tabela) => {
    const filtros = {};
    const q = {
      select: () => q, eq: (c, v) => { filtros[c] = v; return q; }, neq: () => q, in: () => q, order: () => q, limit: () => q, gt: () => q, lt: () => q,
      insert: () => q, update: () => q, upsert: () => q, delete: () => q,
      maybeSingle: async () => ({ data: dado(), error: null }), single: async () => ({ data: dado(), error: null }),
    };
    const dado = () => {
      if (tabela === "ifood_conexoes") return conexaoDe(filtros.unidade_id ?? tenantAtual.unidadeId);
      if (tabela === "ifood_credenciais") return { access_token_cifrado: cifrar("AT"), refresh_token_cifrado: cifrar("RT"), expira_em: new Date(Date.now() + 3_600_000).toISOString(), status: "ativa" };
      return null;
    };
    return q;
  };
  const chamadas = [];
  globalThis.fetch = async (url, init) => {
    chamadas.push({ url: String(url), headers: init.headers ?? {} });
    const corpo = String(url).includes("/sales") ? [{ page: 1, size: 0, total: 0, pageCount: 0, sales: [] }]
      : String(url).includes("on-demand") ? { requestId: "123e4567-e89b-12d3-a456-426614174000", competence: "2026-08" } : {};
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

  const chamar = (metodo, url, { corpo, headers = {} } = {}) => new Promise((resolve, reject) => {
    const dados = corpo ? JSON.stringify(corpo) : null;
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method: metodo, path: url,
      headers: { ...headers, ...(dados ? { "content-type": "application/json", "content-length": Buffer.byteLength(dados) } : {}) } }, (res) => {
      let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, corpo: b }));
    });
    req.on("error", reject); if (dados) req.write(dados); req.end();
  });
  const ultimaIfood = () => chamadas.at(-1);
  const navegadorForcando = { [HEADER]: "true", "x-homologacao": "true" };

  test("unidade B (fora): Sales com ?homologacao=true e header do navegador -> iFood SEM o header", async () => {
    tenantAtual = { organizacaoId: "org-1", unidadeId: UNI_B };
    const restaurar = silenciar();
    try {
      const r = await chamar("GET", "/api/v1/financial/sales?inicio=2026-09-01&fim=2026-09-07&homologacao=true", { headers: navegadorForcando });
      assert.equal(r.status, 200, r.corpo);
    } finally { restaurar(); }
    assert.equal(HEADER in ultimaIfood().headers, false);
    assert.doesNotMatch(ultimaIfood().url, /homologacao/);
  });

  test("unidade B (fora): Settlements com query e header forçando -> SEM o header", async () => {
    tenantAtual = { organizacaoId: "org-1", unidadeId: UNI_B };
    const restaurar = silenciar();
    try { await chamar("GET", "/api/v1/financial/settlements?inicio=2026-09-01&fim=2026-09-07&homologacao=true", { headers: navegadorForcando }); } finally { restaurar(); }
    assert.equal(HEADER in ultimaIfood().headers, false);
  });

  test("unidade B (fora): POST On Demand com { homologacao: true } no body -> SEM o header", async () => {
    tenantAtual = { organizacaoId: "org-1", unidadeId: UNI_B };
    const restaurar = silenciar();
    try { await chamar("POST", "/api/v1/financial/reconciliation/on-demand", { corpo: { competencia: "2026-08", homologacao: true, unidadeId: UNI_A }, headers: navegadorForcando }); } finally { restaurar(); }
    assert.ok(ultimaIfood().url.includes("/reconciliation/on-demand"));
    assert.equal(HEADER in ultimaIfood().headers, false);
  });

  test("controle positivo: unidade A (na allowlist) -> o MESMO pedido vai COM o header", async () => {
    tenantAtual = { organizacaoId: "org-1", unidadeId: UNI_A };
    const restaurar = silenciar();
    try { await chamar("GET", "/api/v1/financial/sales?inicio=2026-09-01&fim=2026-09-07"); } finally { restaurar(); }
    assert.equal(ultimaIfood().headers[HEADER], "true");
    const restaurar2 = silenciar();
    try { await chamar("GET", "/api/v1/financial/settlements?inicio=2026-09-01&fim=2026-09-07"); } finally { restaurar2(); }
    assert.equal(ultimaIfood().headers[HEADER], "true");
  });

  test("controller não lê homologação de query/body (só tenant)", () => {
    const ctrl = SRC("modules/ifood/ifood.controller.js");
    assert.doesNotMatch(ctrl, /homologacao\s*:/, "o controller não repassa homologacao ao service");
    assert.doesNotMatch(ctrl, /req\.(query|body)\??\.homologacao|x-request-homologation/i);
  });
});

// ===========================================================================
describe("Merchant, Order e Events operacional NÃO usam a allowlist", () => {
  test("Merchant com a unidade na allowlist: nenhuma chamada leva o header", async () => {
    const chamadas = [];
    const httpFake = { async getJson(caminho, opts) { chamadas.push(opts); return caminho.includes("merchants?") ? [{ id: MERCHANT, name: "Loja" }] : { id: MERCHANT, name: "Loja" }; } };
    const token = { comAccessTokenValido: ({ fn }) => fn("AT"), escopoDoToken: () => "app" };
    const original = config.ifood.financialHomologacaoUnidades;
    config.ifood.financialHomologacaoUnidades = [UNI_A];
    const restaurar = silenciar();
    try {
      await merchantService.listarMerchantsAutorizados({ organizacaoId: "o", unidadeId: UNI_A, deps: { http: httpFake, token, repo: {} } });
      await merchantService.validarMerchant({ organizacaoId: "o", unidadeId: UNI_A, merchantId: MERCHANT, deps: { http: httpFake, token, repo: {} } });
    } finally { restaurar(); config.ifood.financialHomologacaoUnidades = original; }
    assert.equal(chamadas.length, 2);
    for (const o of chamadas) assert.notEqual(o.homologacao, true);
  });

  test("Order, Events, Handshake, OAuth e worker não importam a decisão nem a variável", () => {
    const arquivos = ["ifoodOrder.service.js", "ifoodOrder.client.js", "ifoodOrderActions.service.js", "ifoodHandshake.service.js", "ifoodHandshake.client.js",
      "ifoodEvents.client.js", "ifoodEvents.poller.js", "ifoodEvents.service.js", "ifoodAuth.service.js", "ifoodAuthProvider.js", "ifoodMerchant.service.js"];
    for (const f of arquivos) {
      const s = SRC(`modules/ifood/${f}`);
      assert.doesNotMatch(s, /ifoodFinancialHomologacao|financialHomologacaoUnidades|IFOOD_FINANCIAL_HOMOLOGATION_UNITS|usarHomologacaoFinancial/, f);
    }
  });

  test("token service: a allowlist só escolhe credencial para o appType financial", () => {
    const s = SRC("modules/ifood/ifoodToken.service.js");
    const usos = s.split(/\r?\n/).filter((l) => /unidadeEmHomologacaoFinancial\(|totalUnidadesHomologacaoFinancial\(/.test(l) && !/^\s*(\/\/|\*|import)/.test(l));
    assert.equal(usos.length, 2, usos.join("\n"));
    for (const l of usos) assert.match(l, /IFOOD_APPS\.FINANCIAL/, l);
    const codigo = s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""); // comentários podem citar a variável
    assert.doesNotMatch(codigo, /usarHomologacaoFinancial|financialHomologacaoUnidades|IFOOD_FINANCIAL_HOMOLOGATION_UNITS/);
  });

  test("só o service Financial, o token service (credencial Financial) e o status (selo) consultam a allowlist", () => {
    const usam = ["modules/ifood/ifoodFinancial.service.js", "modules/ifood/ifoodConnection.service.js", "modules/ifood/ifoodToken.service.js", "server.js"];
    for (const f of usam) assert.match(SRC(f), /ifoodFinancialHomologacao\.js/, f);
  });
});

// ===========================================================================
describe("log de boot e /status", () => {
  test("server.js loga só a QUANTIDADE de unidades", () => {
    const s = SRC("server.js");
    assert.match(s, /iFood Financial homologação: \$\{totalUnidadesHomologacaoFinancial\(\)\} unidade\(s\) habilitada\(s\)/);
    assert.doesNotMatch(s, /financialHomologacaoUnidades/, "server.js nunca lê/imprime a lista");
  });

  test("/status: financialHomologacao é só um booleano, true apenas para a unidade na allowlist", async () => {
    const original = config.ifood.financialHomologacaoUnidades;
    config.ifood.financialHomologacaoUnidades = [UNI_A];
    const repo = { async obterConexaoViva() { return null; } };
    try {
      const a = await conn.obterStatus({ organizacaoId: "o", unidadeId: UNI_A, deps: { repo } });
      const b = await conn.obterStatus({ organizacaoId: "o", unidadeId: UNI_B, deps: { repo } });
      assert.equal(a.financialHomologacao, true);
      assert.equal(b.financialHomologacao, false);
      assert.ok(!JSON.stringify(a).includes(UNI_A), "o status não ecoa a lista nem o id");
    } finally { config.ifood.financialHomologacaoUnidades = original; }
  });
});
