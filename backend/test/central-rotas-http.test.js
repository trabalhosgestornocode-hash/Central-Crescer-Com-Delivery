// Central de Comunicação — as rotas de conversas/visão geral/histórico só existem atrás de `requirePainelAdministrativo` (nenhuma rota pública), o envio manual
// exige ator humano e valida ANTES de tocar em qualquer coisa. Sem banco, sem rede.
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
const ID = "33333333-3333-4333-8333-333333333333";

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

const ROTAS = [
  ["GET", "/administrativo/comunicacao/central/visao-geral"], ["GET", "/administrativo/comunicacao/central/automacoes"], ["GET", "/administrativo/comunicacao/central/destinatarios"],
  ["GET", "/administrativo/comunicacao/central/historico"], ["GET", "/administrativo/comunicacao/central/diagnostico"], ["GET", "/administrativo/comunicacao/central/atualizacoes"],
  ["GET", "/administrativo/comunicacao/conversas"], ["GET", `/administrativo/comunicacao/conversas/${ID}`],
  ["POST", `/administrativo/comunicacao/conversas/${ID}/lida`, {}], ["POST", `/administrativo/comunicacao/conversas/${ID}/mensagens`, { envioId: ID, texto: "oi" }],
];

describe("Central — autorização das rotas", () => {
  for (const [metodo, path, corpo] of ROTAS) {
    test(`${metodo} ${path.replace(ID, ":id")}: usuário comum ⇒ 403; sem usuário ⇒ recusado`, async () => {
      assert.equal((await chamar(USUARIO_COMUM, metodo, path, corpo)).status, 403);
      assert.ok([401, 403].includes((await chamar(null, metodo, path, corpo)).status));
    });
  }

  test("POST /mensagens: validação ANTES de qualquer efeito (sem banco) — texto vazio, envioId inválido, conversa inválida ⇒ 400", async () => {
    const base = `/administrativo/comunicacao/conversas/${ID}/mensagens`;
    for (const corpo of [{ envioId: ID, texto: "" }, { envioId: ID }, { envioId: "x", texto: "oi" }, { texto: "oi" }]) {
      assert.equal((await chamar(USUARIO_PAINEL, "POST", base, corpo)).status, 400, JSON.stringify(corpo));
    }
    assert.equal((await chamar(USUARIO_PAINEL, "POST", "/administrativo/comunicacao/conversas/nao-uuid/mensagens", { envioId: ID, texto: "oi" })).status, 400);
  });

  test("cursor malformado ⇒ 400 antes de tocar o banco; conversa com id inválido ⇒ 400", async () => {
    assert.equal((await chamar(USUARIO_PAINEL, "GET", "/administrativo/comunicacao/central/atualizacoes?cursor=lixo")).status, 400);
    assert.equal((await chamar(USUARIO_PAINEL, "GET", "/administrativo/comunicacao/conversas/nao-uuid")).status, 400);
    assert.equal((await chamar(USUARIO_PAINEL, "GET", "/administrativo/comunicacao/conversas?filtro=hack")).status, 400);
  });
});

describe("Central — guardas estáticos", () => {
  const src = (...p) => readFileSync(join(aqui, "..", "src", ...p), "utf8").replace(/\r\n/g, "\n");
  const semComentarios = (s) => s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  test("toda rota nova da Central nasce no administrativoRouter (protegido) e o envio manual tem limite de taxa próprio", () => {
    const rotas = src("modules", "administrativo", "administrativo.routes.js");
    const linhas = rotas.split("\n").filter((l) => /comunicacao\/(central|conversas)/.test(l) && !l.trim().startsWith("//"));
    assert.equal(linhas.length, 10);
    assert.ok(linhas.every((l) => l.startsWith("administrativoRouter.")));
    const envio = linhas.find((l) => l.includes("/mensagens"));
    assert.match(envio, /limiteDeTaxa\(\{ escopo: "comunicacao_manual", \.\.\.RATE_LIMIT\.comunicacaoManual \}\)/);
  });

  test("o serviço da Central nunca chama o provider direto: só WhatsAppService (via criarWhatsAppServiceDoAmbiente) e nunca o Baileys/Gateway na mão", () => {
    for (const f of [["modules", "administrativo", "administrativo.comunicacao.conversas.js"], ["modules", "comunicacao", "comunicacao.manual.js"], ["modules", "comunicacao", "comunicacao.inbox.service.js"]]) {
      const codigo = semComentarios(src(...f));
      assert.ok(!/\.sendText\(|\.sendImage\(|\.sendDocument\(|from "baileys"|fetch\(/.test(codigo), f.join("/"));
    }
  });

  test("o inbox/roster nunca tocam o outbox nem o claim (o inbound continua separado do envio)", () => {
    for (const f of ["comunicacao.inbox.service.js", "comunicacao.inbox.repo.js", "comunicacao.roster.js"]) {
      const codigo = semComentarios(src("modules", "comunicacao", f));
      assert.ok(!/comunicacao_mensagens|comunicacao_claim|SCHEDULED/.test(codigo), f);
    }
  });

  test("a migration 096 é aditiva: nenhum drop/alter/delete/truncate sobre objetos existentes e nada referencia o claim", () => {
    const sql = readFileSync(join(aqui, "..", "..", "database", "migrations", "096_comunicacao_central_conversas.sql"), "utf8").replace(/\r\n/g, "\n");
    const codigo = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    assert.ok(!/\bdrop\s+(table|view|function|column)\b/i.test(codigo), "sem DROP");
    assert.ok(!/\btruncate\b/i.test(codigo));
    // ALTER TABLE só em contatos_whatsapp (colunas de foto) e nas duas tabelas NOVAS (ligar RLS) — nunca em tabela existente do outbox/inbound.
    assert.ok(!/alter\s+table\s+(?!contatos_whatsapp\b|comunicacao_inbox_mensagens\b|comunicacao_inbox_leituras\b)\w+/i.test(codigo), "ALTER TABLE só onde a 096 é dona");
    assert.ok(!/alter\s+table\s+contatos_whatsapp\s+(drop|alter\s+column)/i.test(codigo));
    assert.ok(!/comunicacao_mensagens|comunicacao_claim/.test(codigo), "não referencia o outbox nem o claim");
    assert.match(codigo, /alter table comunicacao_inbox_mensagens enable row level security/);
    assert.match(codigo, /revoke all on comunicacao_inbox_mensagens from public, anon, authenticated/);
    assert.match(codigo, /revoke all on comunicacao_roster_autorizado from public, anon, authenticated/);
  });
});
