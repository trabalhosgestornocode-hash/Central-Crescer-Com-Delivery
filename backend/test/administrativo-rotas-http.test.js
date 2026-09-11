// PAINEL ADMINISTRATIVO — Fase F: AUTORIZAÇÃO das rotas via Express real.
//
// Sobe o `administrativoRouter` REAL num app mínimo, injeta `req.user` por
// middleware e um Supabase FAKE por `app.locals.adminDeps`. Prova, de ponta a
// ponta (item 14 do pedido):
//   * usuário comum -> 403 ;
//   * usuário com acesso ao Painel Administrativo -> 200 ;
//   * SuperAdmin (sem o flag) -> 200 por bypass ;
//   * ter acesso TENANT (vínculos de empresa) NÃO concede o Painel Administrativo ;
//   * `req.tenant` presente NÃO restringe a visão — continua cross-tenant ;
//   * rota inexistente sob /administrativo -> 404 JSON (nunca cai no app).
//
// NÃO usa banco, NÃO usa rede externa (loopback só). Sem TEST_SUPABASE_*.
//
// Rodar: node --test test/administrativo-rotas-http.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { administrativoRouter } from "../src/modules/administrativo/administrativo.routes.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";

const HOJE = "2026-09-15";
const D1 = "2026-09-14";
const MOD = "ifood_dashboard";
const uuid = (l) => { const h = Buffer.from(l).toString("hex").padEnd(32, "0").slice(0, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

// ---- Supabase fake (mesma forma do administrativo-frota.test.js) ----
function fakeDb(estado) {
  function from(tabela) {
    const ctx = { eq: [], inF: null, gte: null, lte: null };
    const casa = (r) =>
      ctx.eq.every(([c, v]) => r[c] === v) &&
      (!ctx.inF || ctx.inF.vals.includes(r[ctx.inF.col])) &&
      (ctx.gte == null || r[ctx.gte.col] >= ctx.gte.v) &&
      (ctx.lte == null || r[ctx.lte.col] <= ctx.lte.v);
    const run = (single) => Promise.resolve(single
      ? { data: (estado[tabela] ?? []).find(casa) ?? null, error: null }
      : { data: (estado[tabela] ?? []).filter(casa).map((r) => ({ ...r })), error: null });
    const b = {
      select: () => b, eq: (c, v) => (ctx.eq.push([c, v]), b), in: (c, vals) => (ctx.inF = { col: c, vals }, b),
      gte: (c, v) => (ctx.gte = { col: c, v }, b), lte: (c, v) => (ctx.lte = { col: c, v }, b),
      order: () => b, range: (de, ate) => run(false).then((r) => ({ ...r, data: (r.data ?? []).slice(de, ate + 1) })),
      maybeSingle: () => run(true), then: (res, rej) => run(false).then(res, rej),
    };
    return b;
  }
  return { from };
}

function estadoComFrota() {
  const dias = [];
  for (let d = 1; d <= 31; d++) dias.push(`2026-08-${String(d).padStart(2, "0")}`);
  for (let d = 1; d <= 14; d++) dias.push(`2026-09-${String(d).padStart(2, "0")}`);
  const lanc = [];
  for (const u of ["ua", "ub", "uc"]) for (const data of dias) {
    lanc.push({ unidade_id: uuid(u), data_lancamento: data, status: "finalizado", situacao: "normal", valor_vendas_ifood: 100 });
  }
  return {
    organizacoes: [uuid("o1"), uuid("o2"), uuid("o3")].map((id, i) => ({ id, nome: `Org ${i}`, status: "ativa", eh_modelo: false, created_at: "2025-01-01T00:00:00Z" })),
    unidades: [["ua", "o1"], ["ub", "o2"], ["uc", "o3"]].map(([u, o]) => ({ id: uuid(u), organizacao_id: uuid(o), nome: u, ativo: true, eh_teste: false, created_at: "2025-01-01T00:00:00Z" })),
    organizacao_modulos: [uuid("o1"), uuid("o2"), uuid("o3")].map((organizacao_id) => ({ organizacao_id, modulo_id: MOD })),
    unidade_modulos: [uuid("ua"), uuid("ub"), uuid("uc")].map((unidade_id) => ({ unidade_id, modulo_id: MOD })),
    lancamentos_financeiros_diarios: lanc,
  };
}

function makeApp({ user, tenant, deps, hoje = HOJE } = {}) {
  const app = express();
  app.use((req, _res, next) => { if (user !== undefined) req.user = user; if (tenant) req.tenant = tenant; next(); });
  app.use("/administrativo", administrativoRouter);
  app.use(errorHandler);
  app.locals.adminDeps = deps;
  app.locals.adminHoje = hoje;
  return app;
}

function GET(app, path) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      http.get({ host: "127.0.0.1", port, path }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => { server.close(); resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null }); });
      }).on("error", (e) => { server.close(); reject(e); });
    });
  });
}

const usuarioComum = { id: uuid("comum"), nome: "Comum", superadmin: false, painelAdministrativo: false };
const usuarioPainel = { id: uuid("painel"), nome: "Gestor", superadmin: false, painelAdministrativo: true };
const superadmin = { id: uuid("super"), nome: "Root", superadmin: true, painelAdministrativo: false };
// "usuário tenant": tem vínculos de empresa (papéis operacionais) mas NENHUM
// poder global. Ter acesso a uma empresa não é ter o Painel Administrativo.
const usuarioTenant = { id: uuid("tenant"), nome: "Gerente da Loja", superadmin: false, painelAdministrativo: false, papel: "organization_admin" };

describe("autorização das rotas /administrativo (Express real)", () => {
  test("usuário comum -> 403 em /ping e em /visao-geral", async () => {
    const app = makeApp({ user: usuarioComum, deps: { supabase: fakeDb(estadoComFrota()) } });
    assert.equal((await GET(app, "/administrativo/ping")).status, 403);
    assert.equal((await GET(app, "/administrativo/visao-geral")).status, 403);
  });

  test("usuário com acesso ao Painel Administrativo -> 200", async () => {
    const app = makeApp({ user: usuarioPainel, deps: { supabase: fakeDb(estadoComFrota()) } });
    const ping = await GET(app, "/administrativo/ping");
    assert.equal(ping.status, 200);
    assert.equal(ping.json.data.via, "painel_administrativo");
    assert.equal((await GET(app, "/administrativo/visao-geral")).status, 200);
  });

  test("SuperAdmin sem o flag -> 200 por bypass, `via: superadmin`", async () => {
    const app = makeApp({ user: superadmin, deps: { supabase: fakeDb(estadoComFrota()) } });
    const ping = await GET(app, "/administrativo/ping");
    assert.equal(ping.status, 200);
    assert.equal(ping.json.data.via, "superadmin");
  });

  test("acesso TENANT (vínculo de empresa, papel operacional) NÃO concede o Painel Administrativo -> 403", async () => {
    const app = makeApp({ user: usuarioTenant, deps: { supabase: fakeDb(estadoComFrota()) } });
    assert.equal((await GET(app, "/administrativo/visao-geral")).status, 403);
  });

  test("`req.tenant` presente NÃO restringe a visão — continua cross-tenant (3 empresas)", async () => {
    const app = makeApp({
      user: usuarioPainel,
      tenant: { organizacaoId: uuid("o1"), unidadeId: uuid("ua") }, // contexto de UMA empresa
      deps: { supabase: fakeDb(estadoComFrota()) },
    });
    const r = await GET(app, "/administrativo/visao-geral");
    assert.equal(r.status, 200);
    assert.equal(r.json.data.resumo.empresasMonitoradas, 3);
    assert.equal(r.json.data.resumo.unidadesMonitoradas, 3);
    assert.equal(r.json.data.d1, D1);
  });

  test("rota inexistente sob /administrativo -> 404 JSON (nunca a SPA)", async () => {
    const app = makeApp({ user: usuarioPainel, deps: { supabase: fakeDb(estadoComFrota()) } });
    const r = await GET(app, "/administrativo/nao-existe");
    assert.equal(r.status, 404);
    assert.ok(r.json.error);
  });

  test("todas as rotas Fase F respondem (200) para usuário autorizado", async () => {
    const app = makeApp({ user: usuarioPainel, deps: { supabase: fakeDb(estadoComFrota()) } });
    for (const p of ["/visao-geral", "/monitoramento-diario", "/pendencias", "/empresas"]) {
      assert.equal((await GET(app, `/administrativo${p}`)).status, 200, p);
    }
    assert.equal((await GET(app, `/administrativo/empresas/${uuid("o2")}`)).status, 200);
    assert.equal((await GET(app, `/administrativo/unidades/${uuid("ub")}/calendario?mes=2026-09`)).status, 200);
  });

  test("monitoramento-diario?data=<hoje> -> 400 (nunca cobra o dia de hoje)", async () => {
    const app = makeApp({ user: usuarioPainel, deps: { supabase: fakeDb(estadoComFrota()) } });
    const r = await GET(app, `/administrativo/monitoramento-diario?data=${HOJE}`);
    assert.equal(r.status, 400);
  });
});
