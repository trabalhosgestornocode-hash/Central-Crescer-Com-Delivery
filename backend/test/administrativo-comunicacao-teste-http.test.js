// H.4-B.5 — as rotas da Central de Comunicação e do TESTE CONTROLADO só existem atrás de `requirePainelAdministrativo` (nenhuma rota pública), e o envio de
// teste valida ator + confirmação ANTES de tocar em qualquer coisa. Sem banco, sem rede.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { administrativoRouter } from "../src/modules/administrativo/administrativo.routes.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const USUARIO_COMUM = { id: "11111111-1111-4111-8111-111111111111", email: "comum@teste.com", nome: "Comum", painelAdministrativo: false };
const USUARIO_PAINEL = { id: "22222222-2222-4222-8222-222222222222", email: "painel@teste.com", nome: "Painel", painelAdministrativo: true };

function chamar(user, metodo, path, corpo) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use("/administrativo", administrativoRouter);
  app.use(errorHandler);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => {
      const req = http.request({ host: "127.0.0.1", port: server.address().port, path, method: metodo, headers: corpo ? { "Content-Type": "application/json" } : {} }, (res) => {
        let body = ""; res.on("data", (c) => { body += c; });
        res.on("end", () => { server.close(); resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null }); });
      });
      req.on("error", (e) => { server.close(); reject(e); });
      if (corpo) req.write(JSON.stringify(corpo));
      req.end();
    });
  });
}
const ID = "33333333-3333-4333-8333-333333333333";
const ROTAS = [
  ["GET", "/administrativo/comunicacao/mensagens"], ["GET", `/administrativo/comunicacao/mensagens/${ID}`], ["GET", "/administrativo/comunicacao/configuracao-operacional"],
  ["GET", `/administrativo/comunicacao/teste/preparo?organizacaoId=${ID}`], ["POST", "/administrativo/comunicacao/teste", { organizacaoId: ID, unidadeId: ID, testeId: ID, confirmacaoExplicita: true }],
  ["GET", `/administrativo/comunicacao/teste/${ID}`],
];

describe("Central de Comunicação / Teste — autorização", () => {
  for (const [metodo, path, corpo] of ROTAS) {
    test(`${metodo} ${path.split("?")[0]}: usuário comum => 403; sem usuário => recusado`, async () => {
      assert.equal((await chamar(USUARIO_COMUM, metodo, path, corpo)).status, 403);
      assert.ok([401, 403].includes((await chamar(null, metodo, path, corpo)).status));
    });
  }
  test("POST /teste sem confirmação explícita => 400 ANTES de qualquer efeito (sem banco)", async () => {
    const r = await chamar(USUARIO_PAINEL, "POST", "/administrativo/comunicacao/teste", { organizacaoId: ID, unidadeId: ID, testeId: ID });
    assert.equal(r.status, 400);
  });
  test("o router não expõe nenhuma rota de envio de teste fora do prefixo administrativo e a rota nasce no mesmo router protegido", () => {
    const src = readFileSync(join(aqui, "..", "src", "modules", "administrativo", "administrativo.routes.js"), "utf8").replace(/\r\n/g, "\n");
    const teste = src.split("\n").filter((l) => /comunicacao\/teste/.test(l) && !l.trim().startsWith("//"));
    assert.equal(teste.length, 3);
    assert.ok(teste.every((l) => l.startsWith("administrativoRouter.")), "toda rota de teste é do administrativoRouter (requirePainelAdministrativo)");
  });
});
