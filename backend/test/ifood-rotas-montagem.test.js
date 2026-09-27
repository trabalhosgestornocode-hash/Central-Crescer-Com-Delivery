// iFood — o módulo está REALMENTE montado e protegido?
//
// Existe para não repetirmos o problema da Fase 1: código e testes de service
// passavam, mas `routes.js` nunca montou o `ifoodRouter` e o produto não
// alcançava nada. Aqui a prova é em três camadas:
//   1. estrutural — routes.js monta /integracoes/ifood atrás de
//      requireContexto + requireModulo(IFOOD), e app.js protege /api/v1 com
//      requireAuth;
//   2. o ifoodRouter REAL expõe todas as rotas esperadas (Fase 1 + Financial);
//   3. HTTP — requireAuth real, requireModulo/requirePermissao reais com
//      papéis reais (permissoesDoPapel), tenant obrigatório e rate limit.
//
// Sem banco e sem rede: todo caso que PASSA pela autorização é interrompido
// pelo controller com 400 "selecione a loja" (unidade ausente) ANTES de
// qualquer service — determinístico. Nenhuma chamada ao iFood é feita.
//
// Rodar: node --experimental-vm-modules --test test/ifood-rotas-montagem.test.js

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { ifoodRouter } from "../src/modules/ifood/ifood.routes.js";
import { requireAuth, requireModulo } from "../src/middlewares/auth.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";
import { MODULOS } from "../src/shared/modulos.js";
import { permissoesDoPapel } from "../src/shared/permissoes.js";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = readFileSync(path.join(AQUI, "../src/routes.js"), "utf8");
const APP = readFileSync(path.join(AQUI, "../src/app.js"), "utf8");

// ---------------------------------------------------------------------------
// 1. Estrutural
// ---------------------------------------------------------------------------
describe("routes.js / app.js — montagem do iFood", () => {
  test("ifoodRouter é importado e montado em /integracoes/ifood com requireModulo(IFOOD)", () => {
    assert.match(ROUTES, /import\s*\{\s*ifoodRouter\s*\}\s*from\s*["']\.\/modules\/ifood\/ifood\.routes\.js["']/);
    assert.match(ROUTES, /tenant\.use\(\s*["']\/integracoes\/ifood["']\s*,\s*requireModulo\(MODULOS\.IFOOD\)\s*,\s*ifoodRouter\s*\)/);
  });

  test("a montagem vem DEPOIS de tenant.use(requireContexto) — nunca sem Context Token", () => {
    const iGate = ROUTES.indexOf("tenant.use(requireContexto)");
    const iIfood = ROUTES.indexOf('tenant.use("/integracoes/ifood"');
    assert.ok(iGate > -1 && iIfood > -1);
    assert.ok(iGate < iIfood, "/integracoes/ifood tem que vir depois do gate de contexto");
  });

  test("/api/v1 inteiro passa por requireAuth antes do router", () => {
    const iAuth = APP.indexOf('app.use("/api/v1", requireAuth)');
    const iRouter = APP.indexOf('app.use("/api/v1", router)');
    assert.ok(iAuth > -1, "requireAuth precisa proteger /api/v1");
    assert.ok(iRouter > -1, "o router principal precisa estar montado");
    assert.ok(iAuth < iRouter, "requireAuth vem antes do router");
  });

  test("o módulo iFood existe no catálogo de módulos", () => {
    assert.equal(MODULOS.IFOOD, "ifood");
  });
});

// ---------------------------------------------------------------------------
// 2. O router real expõe as rotas esperadas
// ---------------------------------------------------------------------------
function rotasDoRouter(router) {
  return router.stack
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route.path}`))
    .sort();
}

describe("ifoodRouter — rotas expostas", () => {
  const rotas = rotasDoRouter(ifoodRouter);

  test("Fase 1: OAuth, merchants, vínculo, status e desconexão", () => {
    for (const r of [
      "POST /oauth/start", "POST /oauth/complete",
      "GET /merchants", "POST /merchants/link", "GET /merchants/:merchantId",
      "GET /status", "DELETE /",
    ]) assert.ok(rotas.includes(r), `falta a rota ${r}`);
  });

  test("Fase 2: Financial (somente leitura + reconciliation on-demand)", () => {
    for (const r of [
      "GET /financial/sales", "GET /financial/events", "GET /financial/settlements",
      "GET /financial/reconciliation", "POST /financial/reconciliation/on-demand",
      "GET /financial/reconciliation/on-demand/:requestId",
      "GET /financial/anticipations", "GET /financial/conciliation",
    ]) assert.ok(rotas.includes(r), `falta a rota ${r}`);
  });

  test("não existe nenhuma rota de Order/Events/operação de pedido nesta fase", () => {
    const proibidas = /order|events?\b(?!$)|ack|confirm|dispatch|ready|cancel|handshake|polling/i;
    const suspeitas = rotas.filter((r) => !r.includes("/financial/") && proibidas.test(r));
    assert.deepEqual(suspeitas, []);
  });
});

// ---------------------------------------------------------------------------
// 3. HTTP — auth real, módulo/permissão reais, tenant, rate limit
// ---------------------------------------------------------------------------
/**
 * App mínimo espelhando a cadeia de produção:
 *   /api/v1 -> requireAuth (REAL) -> [gate de contexto fake] -> requireModulo(IFOOD) (REAL) -> ifoodRouter (REAL)
 * O gate de contexto fake só faz o que requireContexto faz: preencher
 * req.acesso (papel, permissões REAIS do papel, módulos) e req.tenant.
 */
function montarApp() {
  const app = express();
  app.use(express.json());
  // requireAuth real exige JWT do Supabase; nos casos autenticados um header
  // de teste injeta req.user no lugar dele. Sem o header, requireAuth REAL decide.
  app.use("/api/v1", (req, res, next) => {
    if (req.headers["x-teste-user"]) {
      req.user = { id: String(req.headers["x-teste-user"]) };
      return next();
    }
    return requireAuth(req, res, next); // sem stub -> requireAuth REAL decide (401)
  }, (req, _res, next) => {
    const papel = req.headers["x-teste-papel"];
    if (papel) {
      const modulos = String(req.headers["x-teste-modulos"] ?? MODULOS.IFOOD).split(",").filter(Boolean);
      req.acesso = { papel, permissoes: permissoesDoPapel(papel), modulos, impersonando: false };
      if (req.headers["x-teste-org"]) {
        req.tenant = {
          organizacaoId: String(req.headers["x-teste-org"]),
          unidadeId: req.headers["x-teste-unidade"] ? String(req.headers["x-teste-unidade"]) : null,
        };
      }
    }
    next();
  }, requireModulo(MODULOS.IFOOD), ifoodRouter);
  app.use(errorHandler);
  return app;
}

function chamar(server, { method, url, headers = {} }) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers: { "content-type": "application/json", ...headers } }, (res) => {
      let corpo = "";
      res.on("data", (c) => { corpo += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(corpo); } catch { /* corpo vazio */ } resolve({ status: res.statusCode, json }); });
    });
    req.on("error", reject);
    req.end(method === "GET" || method === "DELETE" ? undefined : "{}");
  });
}

const ORG = "11111111-1111-4111-8111-111111111111";
const semUnidade = (papel, extra = {}) => ({ "x-teste-user": `u-${papel}-${Math.random()}`, "x-teste-papel": papel, "x-teste-org": ORG, ...extra });

// Rotas que exigem GERENCIAR (todas menos GET /status).
const ROTAS_GERENCIAR = [
  ["POST", "/api/v1/oauth/start"], ["POST", "/api/v1/oauth/complete"],
  ["GET", "/api/v1/merchants"], ["POST", "/api/v1/merchants/link"], ["GET", "/api/v1/merchants/abc"],
  ["DELETE", "/api/v1/"],
  ["GET", "/api/v1/financial/sales"], ["GET", "/api/v1/financial/events"],
  ["GET", "/api/v1/financial/settlements"], ["GET", "/api/v1/financial/reconciliation"],
  ["POST", "/api/v1/financial/reconciliation/on-demand"],
  ["GET", "/api/v1/financial/reconciliation/on-demand/req-1"],
  ["GET", "/api/v1/financial/anticipations"], ["GET", "/api/v1/financial/conciliation"],
];

describe("HTTP — autenticação, módulo, permissão e tenant", async () => {
  const app = montarApp();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());

  test("sem token: requireAuth REAL responde 401 (nenhuma rota iFood é pública)", async () => {
    for (const [method, url] of [["GET", "/api/v1/status"], ["POST", "/api/v1/oauth/start"], ["DELETE", "/api/v1/"]]) {
      const r = await chamar(server, { method, url });
      assert.equal(r.status, 401, `${method} ${url}`);
    }
  });

  test("autenticado mas SEM contexto de empresa: 403", async () => {
    const r = await chamar(server, { method: "GET", url: "/api/v1/status", headers: { "x-teste-user": "u1" } });
    assert.equal(r.status, 403);
  });

  test("empresa SEM o módulo iFood contratado: 403 em qualquer rota, até para admin", async () => {
    for (const [method, url] of [["GET", "/api/v1/status"], ["POST", "/api/v1/oauth/start"]]) {
      const r = await chamar(server, { method, url, headers: semUnidade("organization_admin", { "x-teste-modulos": "sales,parser_food_delivery" }) });
      assert.equal(r.status, 403, `${method} ${url}`);
      assert.match(JSON.stringify(r.json), /não contratado/i);
    }
  });

  for (const papel of ["viewer", "finance", "operations"]) {
    test(`${papel}: NÃO tem integracoes.gerenciar — 403 em todas as rotas de ação`, async () => {
      for (const [method, url] of ROTAS_GERENCIAR) {
        const r = await chamar(server, { method, url, headers: semUnidade(papel) });
        assert.equal(r.status, 403, `${papel} ${method} ${url}`);
      }
    });

    test(`${papel}: tem integracoes.ver — GET /status passa da autorização (tenant sem unidade -> 400, não 403)`, async () => {
      const r = await chamar(server, { method: "GET", url: "/api/v1/status", headers: semUnidade(papel) });
      assert.equal(r.status, 400);
      assert.match(JSON.stringify(r.json), /loja/i);
    });
  }

  for (const papel of ["organization_admin", "unit_manager"]) {
    test(`${papel}: tem integracoes.gerenciar — passa da autorização e cai no tenant obrigatório (400)`, async () => {
      for (const [method, url] of ROTAS_GERENCIAR) {
        const r = await chamar(server, { method, url, headers: semUnidade(papel, { "x-teste-user": `u-${papel}-${method}-${url}` }) });
        assert.equal(r.status, 400, `${papel} ${method} ${url} deveria exigir a unidade (400), veio ${r.status}`);
      }
    });
  }

  test("tenant obrigatório: sem unidade selecionada nenhum controller executa (400 'Selecione a loja')", async () => {
    const r = await chamar(server, { method: "POST", url: "/api/v1/merchants/link", headers: semUnidade("unit_manager") });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.json), /Selecione a loja/);
  });

  test("rate limit por usuário em /oauth/start: 6ª chamada na janela -> 429 (e é por usuário, outro usuário não é afetado)", async () => {
    const h = semUnidade("unit_manager", { "x-teste-user": "u-ratelimit-start" });
    const codigos = [];
    for (let i = 0; i < 6; i += 1) codigos.push((await chamar(server, { method: "POST", url: "/api/v1/oauth/start", headers: h })).status);
    assert.deepEqual(codigos, [400, 400, 400, 400, 400, 429]);
    const outro = await chamar(server, { method: "POST", url: "/api/v1/oauth/start", headers: semUnidade("unit_manager", { "x-teste-user": "u-ratelimit-outro" }) });
    assert.equal(outro.status, 400);
  });
});
