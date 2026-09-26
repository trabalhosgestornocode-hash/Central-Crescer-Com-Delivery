// PAINEL ADMINISTRATIVO — Comunicação: matriz de autorização de TODAS as rotas.
//
// Regra (já em vigor via `requirePainelAdministrativo` no router inteiro):
//   Comunicação = superadmin OU acesso ao Painel Administrativo.
//
// Este arquivo trava a regra rota a rota, para que uma rota nova de Comunicação
// não nasça com uma checagem exclusiva de SuperAdmin nem sem proteção:
//   1. SuperAdmin                          -> passa (nunca 403)
//   2. Painel Administrativo (não-SA)      -> passa (nunca 403) — mesma visão do SA
//   3. usuário comum                       -> 403, sem tocar no banco
//   4. chamada direta sem autorização      -> 403 em TODAS as rotas/métodos
//   5. regressão: o acesso à Comunicação NÃO abre o Painel SuperAdmin (/plataforma)
//
// Sobe os routers REAIS num app mínimo. NÃO usa banco real, NÃO usa rede.
//
// Rodar: node --test test/administrativo-comunicacao-autorizacao-matriz.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { administrativoRouter } from "../src/modules/administrativo/administrativo.routes.js";
import { plataformaRouter } from "../src/modules/plataforma/plataforma.routes.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";

// Todas as rotas de Comunicação expostas por administrativo.routes.js.
const ROTAS_COMUNICACAO = [
  ["GET", "/administrativo/comunicacao/resumo"],
  ["GET", "/administrativo/comunicacao/organizacoes"],
  ["GET", `/administrativo/comunicacao/organizacoes/${ORG}`],
  ["PUT", `/administrativo/comunicacao/organizacoes/${ORG}/responsavel`, { nome: "X", telefoneE164: "+5586999990000" }],
  ["PUT", `/administrativo/comunicacao/organizacoes/${ORG}/responsaveis/${CONTATO}/ativo`, { ativo: true }],
  ["POST", `/administrativo/comunicacao/organizacoes/${ORG}/responsaveis/${CONTATO}/validar`, { confirmacaoExplicita: true }],
  ["POST", `/administrativo/comunicacao/organizacoes/${ORG}/habilitacao`, { habilitado: false, confirmacaoExplicita: true }],
  ["GET", "/administrativo/comunicacao/configuracoes"],
  ["PUT", "/administrativo/comunicacao/configuracoes", {}],
  ["GET", `/administrativo/comunicacao/organizacoes/${ORG}/preview-mensagem`],
  ["PUT", `/administrativo/comunicacao/organizacoes/${ORG}/configuracao`, { habilitado: false }],
  ["POST", `/administrativo/comunicacao/organizacoes/${ORG}/consentimento`, { confirmacaoExplicita: true }],
  ["GET", "/administrativo/comunicacao/fila"],
  ["GET", "/administrativo/comunicacao/historico"],
];

const SUPERADMIN = { id: "u-sa", email: "root@teste.com", nome: "Root", superadmin: true, painelAdministrativo: false };
const PAINEL = { id: "u-padm", email: "padm@teste.com", nome: "Painel", superadmin: false, painelAdministrativo: true };
const COMUM = { id: "u-comum", email: "comum@teste.com", nome: "Comum", superadmin: false, painelAdministrativo: false };

// Supabase que registra acesso e falha — prova que o 403 acontece ANTES de
// qualquer leitura/escrita. Para usuários autorizados o erro resultante (5xx)
// só confirma que a autorização deixou a requisição chegar ao handler.
function dbSentinela() {
  const s = { tocado: 0 };
  s.from = () => { s.tocado++; throw new Error("db-sentinela"); };
  s.rpc = () => { s.tocado++; throw new Error("db-sentinela"); };
  return s;
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

describe("Comunicação — superadmin OU Painel Administrativo têm o MESMO acesso em todas as rotas", () => {
  for (const [nome, user] of [["SuperAdmin", SUPERADMIN], ["Painel Administrativo (não-SA)", PAINEL]]) {
    for (const [metodo, path, corpo] of ROTAS_COMUNICACAO) {
      test(`${nome}: ${metodo} ${path} -> não é 403`, async () => {
        const r = await chamar(makeApp(user, { supabase: dbSentinela() }), metodo, path, corpo);
        assert.notEqual(r.status, 403, `autorizado recebeu 403: ${r.body}`);
        assert.notEqual(r.status, 401);
      });
    }
  }
});

describe("Comunicação — usuário sem Painel Administrativo é negado no servidor (chamada direta)", () => {
  for (const [rotulo, user] of [["usuário comum", COMUM], ["sem req.user", null]]) {
    for (const [metodo, path, corpo] of ROTAS_COMUNICACAO) {
      test(`${rotulo}: ${metodo} ${path} -> 403 sem tocar no banco`, async () => {
        const db = dbSentinela();
        const r = await chamar(makeApp(user, { supabase: db }), metodo, path, corpo);
        assert.equal(r.status, 403);
        assert.equal(db.tocado, 0, "o banco não pode ser tocado antes da autorização");
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
      const r = await chamar(makeApp(PAINEL, { supabase: dbSentinela() }), metodo, path, corpo);
      assert.equal(r.status, 403);
    });
  }
});
