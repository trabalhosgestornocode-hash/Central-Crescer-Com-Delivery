// PAINEL ADMINISTRATIVO — Comunicação: matriz de autorização de TODAS as rotas.
//
// Regra: Comunicação = superadmin OU acesso ao Painel Administrativo — `requirePainelAdministrativo`
// no router inteiro, e a mesma regra reforçada no service da Conexão (`temPermissaoConexao`).
//
// As rotas NÃO são listadas à mão: saem do próprio `administrativoRouter` (todo path que começa com
// /comunicacao). Uma rota nova de Comunicação nasce coberta por esta matriz automaticamente.
//   1. SuperAdmin                          -> nunca 401/403
//   2. Painel Administrativo (não-SA)      -> nunca 401/403, e o MESMO status que o SuperAdmin
//   3. usuário comum                       -> 403, sem tocar no banco, no Gateway nem na rede
//   4. chamada direta sem usuário          -> 403 em TODAS as rotas/métodos
//   5. regressão: o acesso à Comunicação NÃO abre o Painel SuperAdmin (/plataforma)
//
// Sobe os routers REAIS num app mínimo. NÃO usa banco real, NÃO usa rede (fetch global bloqueado).
//
// Rodar: node --test test/administrativo-comunicacao-autorizacao-matriz.test.js

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { administrativoRouter } from "../src/modules/administrativo/administrativo.routes.js";
import { plataformaRouter } from "../src/modules/plataforma/plataforma.routes.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";

const ID = "11111111-1111-4111-8111-111111111111";

/** Todas as rotas /comunicacao do router real: [[METODO, "/administrativo/comunicacao/..."]] com params preenchidos. */
function rotasDeComunicacao() {
  const rotas = [];
  for (const layer of administrativoRouter.stack) {
    const r = layer.route;
    if (!r || typeof r.path !== "string" || !r.path.startsWith("/comunicacao")) continue;
    for (const metodo of Object.keys(r.methods).filter((m) => r.methods[m] && m !== "_all")) {
      rotas.push([metodo.toUpperCase(), "/administrativo" + r.path.replace(/:[A-Za-z]+/g, ID)]);
    }
  }
  return rotas;
}
const ROTAS_COMUNICACAO = rotasDeComunicacao();
// Corpo genérico: confirmações explícitas e flags seguras — o que importa aqui é a AUTORIZAÇÃO.
const CORPO = { confirmacaoExplicita: true, habilitado: false, ativo: true, operacaoId: ID, ambiente: "TESTE", modo: "DISABLED", texto: "teste" };

const SUPERADMIN = { id: "u-sa", email: "root@teste.com", nome: "Root", superadmin: true, painelAdministrativo: false };
const PAINEL = { id: "u-padm", email: "padm@teste.com", nome: "Painel", superadmin: false, painelAdministrativo: true };
const COMUM = { id: "u-comum", email: "comum@teste.com", nome: "Comum", superadmin: false, painelAdministrativo: false };

/**
 * Dependências sentinela: banco e Gateway registram acesso e falham. Para quem NÃO é autorizado, prova que
 * o 403 acontece antes de qualquer I/O. Para quem é autorizado, o erro resultante (4xx/5xx de negócio) só
 * confirma que a autorização deixou a requisição chegar ao handler.
 */
function depsSentinela() {
  const toques = { db: 0, gateway: 0 };
  const falha = (tipo) => () => { toques[tipo]++; throw new Error(`${tipo}-sentinela`); };
  const supabase = { from: falha("db"), rpc: falha("db") };
  const whatsAppService = new Proxy({}, { get: (_t, prop) => (prop === "then" ? undefined : falha("gateway")) });
  return { deps: { supabase, whatsAppService, env: {}, auditar: falha("db") }, toques };
}

function makeApp(user, deps) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use("/administrativo", administrativoRouter);
  app.use("/plataforma", plataformaRouter);
  app.use(errorHandler);
  app.locals.adminDeps = deps;
  return app;
}

function chamar(app, metodo, path, corpo) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const headers = corpo ? { "Content-Type": "application/json" } : {};
      const req = http.request({ host: "127.0.0.1", port, path, method: metodo, headers }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => { server.close(); resolve({ status: res.statusCode, body }); });
      });
      req.on("error", (e) => { server.close(); reject(e); });
      if (corpo) req.write(JSON.stringify(corpo));
      req.end();
    });
  });
}
const corpoDe = (metodo) => (metodo === "GET" || metodo === "DELETE" ? undefined : CORPO);

// Rede bloqueada durante toda a suíte: nenhum handler pode falar com o Gateway real configurado no .env.
const fetchOriginal = globalThis.fetch;
let chamadasDeRede = 0;
before(() => { globalThis.fetch = async () => { chamadasDeRede++; throw new Error("rede bloqueada no teste"); }; });
after(() => { globalThis.fetch = fetchOriginal; assert.equal(chamadasDeRede, 0, "nenhuma rota pode tentar sair para a rede"); });

describe("Comunicação — inventário", () => {
  test("o router expõe as rotas de Comunicação (sanidade da derivação automática)", () => {
    assert.ok(ROTAS_COMUNICACAO.length >= 40, `só ${ROTAS_COMUNICACAO.length} rotas encontradas`);
    for (const essencial of ["GET /administrativo/comunicacao/resumo", `POST /administrativo/comunicacao/conexao/iniciar`, `PUT /administrativo/comunicacao/modo`, `POST /administrativo/comunicacao/teste`]) {
      assert.ok(ROTAS_COMUNICACAO.some(([m, p]) => `${m} ${p}` === essencial), `faltou ${essencial}`);
    }
  });
});

describe("Comunicação — superadmin OU Painel Administrativo têm o MESMO acesso em todas as rotas", () => {
  for (const [metodo, path] of ROTAS_COMUNICACAO) {
    test(`${metodo} ${path}: SuperAdmin e Painel passam, com o mesmo status`, async () => {
      const status = [];
      for (const user of [SUPERADMIN, PAINEL]) {
        const r = await chamar(makeApp(user, depsSentinela().deps), metodo, path, corpoDe(metodo));
        assert.ok(![401, 403].includes(r.status), `${user.nome} recebeu ${r.status}: ${r.body.slice(0, 200)}`);
        status.push(r.status);
      }
      assert.equal(status[1], status[0], `SuperAdmin=${status[0]} Painel=${status[1]}`);
    });
  }
});

describe("Comunicação — usuário sem Painel Administrativo é negado no servidor (chamada direta)", () => {
  for (const [rotulo, user] of [["usuário comum", COMUM], ["sem req.user", null]]) {
    for (const [metodo, path] of ROTAS_COMUNICACAO) {
      test(`${rotulo}: ${metodo} ${path} -> 403 sem tocar em banco/Gateway`, async () => {
        const { deps, toques } = depsSentinela();
        const r = await chamar(makeApp(user, deps), metodo, path, corpoDe(metodo));
        assert.equal(r.status, 403);
        assert.deepEqual(toques, { db: 0, gateway: 0 }, "nenhum I/O antes da autorização");
      });
    }
  }
});

describe("Regressão — acesso à Comunicação NÃO concede poderes de SuperAdmin", () => {
  const ROTAS_SUPERADMIN = [
    ["GET", "/plataforma/empresas"],
    ["GET", "/plataforma/usuarios"],
    ["POST", "/plataforma/usuarios", { email: "x@teste.com" }],
    ["POST", "/plataforma/usuarios/u-comum/superadmin", { superadmin: true }],
    ["POST", "/plataforma/usuarios/u-comum/painel-administrativo", { painelAdministrativo: true }],
    ["GET", "/plataforma/painel-administrativo/usuarios"],
  ];
  for (const [metodo, path, corpo] of ROTAS_SUPERADMIN) {
    test(`Painel Administrativo (não-SA): ${metodo} ${path} -> 403`, async () => {
      const { deps, toques } = depsSentinela();
      const r = await chamar(makeApp(PAINEL, deps), metodo, path, corpo);
      assert.equal(r.status, 403);
      assert.deepEqual(toques, { db: 0, gateway: 0 });
    });
  }
});
