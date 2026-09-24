// ABA CONEXÃO — rotas HTTP: só existem atrás de `requirePainelAdministrativo`; ler o estado é permitido a quem vê a Central, mas o QR e toda ação exigem a permissão
// ESPECÍFICA (comunicacao:gerenciar_conexao). O QR sai com `Cache-Control: no-store` e nunca aparece em erro. Sem banco real, sem rede.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { administrativoRouter } from "../src/modules/administrativo/administrativo.routes.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";
import { criarFakeDb } from "./helpers/central-fake-db.js";
import { _zerarCachePerfil } from "../src/modules/administrativo/administrativo.comunicacao.conexao.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const ORG = "00000000-0000-4000-8000-0000000000a1";
const COMUM = { id: "11111111-1111-4111-8111-111111111111", email: "comum@t.com", nome: "Comum", painelAdministrativo: false };
const PAINEL = { id: "22222222-2222-4222-8222-222222222222", email: "painel@t.com", nome: "Painel", painelAdministrativo: true, superadmin: false };
const SUPER = { ...PAINEL, id: "33333333-3333-4333-8333-333333333333", superadmin: true };
const OPERACAO = "44444444-4444-4444-8444-444444444444";
const QR = "2@SEGREDO-HTTP-QR,aaa";

function chamar({ user, metodo = "GET", path, corpo, adminDeps }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  if (adminDeps) app.locals.adminDeps = adminDeps;
  app.use("/administrativo", administrativoRouter);
  app.use(errorHandler);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => {
      const req = http.request({ host: "127.0.0.1", port: server.address().port, path, method: metodo, headers: corpo ? { "Content-Type": "application/json" } : {} }, (res) => {
        let body = ""; res.on("data", (c) => { body += c; });
        res.on("end", () => { server.close(); resolve({ status: res.statusCode, headers: res.headers, texto: body, json: body ? JSON.parse(body) : null }); });
      });
      req.on("error", (e) => { server.close(); reject(e); });
      if (corpo) req.write(JSON.stringify(corpo));
      req.end();
    });
  });
}

const B = "/administrativo/comunicacao/conexao";
const ROTAS = [
  ["GET", B], ["GET", `${B}/qr?operacaoId=${OPERACAO}`], ["POST", `${B}/iniciar`, {}], ["POST", `${B}/novo-qr`, { operacaoId: OPERACAO }], ["POST", `${B}/confirmar`, { operacaoId: OPERACAO }], ["POST", `${B}/cancelar`, { operacaoId: OPERACAO }],
  ["POST", `${B}/desconectar`, { confirmacaoExplicita: true }], ["POST", `${B}/trocar`, { confirmacaoExplicita: true }], ["PUT", `${B}/identidade`, { ambiente: "TESTE" }],
];

function depsFalsas({ permitidos = [], qr = QR } = {}) {
  const db = criarFakeDb({
    whatsapp_conexoes: [{ organizacao_id: ORG, provider_instance_id: "default", status: "CONNECTING", telefone_e164: null, last_seen_at: new Date().toISOString() }],
    whatsapp_identidade: [{ organizacao_id: ORG, provider_instance_id: "default", ambiente: "TESTE", status: "SEM_CONTA", operacao_id: OPERACAO, operacao_tipo: "CONECTAR", operacao_expira_em: new Date(Date.now() + 200_000).toISOString() }],
    painel_adm_permissoes: permitidos.map((u) => ({ usuario_id: u, permissao: "comunicacao:gerenciar_conexao" })),
  });
  const chamadas = [];
  const svc = {
    conexaoStatus: async () => ({ status: "CONNECTING", qrDisponivel: !!qr, reconectando: false }),
    conexaoQr: async () => ({ qr, svg: qr ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"></svg>' : null, geradoEm: new Date().toISOString(), expiraEm: new Date(Date.now() + 50_000).toISOString(), ordem: 1 }),
    conexaoPerfil: async () => ({ disponivel: false }), conexaoConectar: async () => { chamadas.push("conectar"); }, conexaoDesconectarConta: async () => { chamadas.push("desconectar"); }, conexaoEncerrar: async () => {},
  };
  return { deps: { supabase: db, env: {}, organizacaoConexaoId: ORG, whatsAppService: svc, auditar: async () => {}, agora: () => new Date() }, chamadas };
}

describe("Conexão — autorização das rotas", () => {
  for (const [metodo, path, corpo] of ROTAS) {
    test(`${metodo} ${path.split("?")[0].replace(B, "…/conexao")}: usuário comum ⇒ 403; sem usuário ⇒ recusado`, async () => {
      assert.equal((await chamar({ user: COMUM, metodo, path, corpo })).status, 403);
      assert.ok([401, 403].includes((await chamar({ user: null, metodo, path, corpo })).status));
    });
  }

  test("GET /conexao: quem está no painel MAS não tem a permissão lê o estado — sem operação e com permissoes.gerenciar=false", async () => {
    const { deps } = depsFalsas();
    const r = await chamar({ user: PAINEL, path: B, adminDeps: deps });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.data.permissoes.gerenciar, r.json.data.operacao, r.json.data.estado], [false, null, "WAITING_QR"]);
    assert.ok(!r.texto.includes("SEGREDO"), "o estado nunca traz o QR");
  });

  test("o QR é recusado (403) a quem só vê o painel: o valor NUNCA chega", async () => {
    const { deps } = depsFalsas();
    const r = await chamar({ user: PAINEL, path: `${B}/qr?operacaoId=${OPERACAO}`, adminDeps: deps });
    assert.equal(r.status, 403);
    assert.ok(!r.texto.includes("SEGREDO"));
  });

  test("com a permissão (tabela) ou SuperAdmin o QR sai com Cache-Control: no-store", async () => {
    for (const [user, permitidos] of [[PAINEL, [PAINEL.id]], [SUPER, []]]) {
      const { deps } = depsFalsas({ permitidos });
      const r = await chamar({ user, path: `${B}/qr?operacaoId=${OPERACAO}`, adminDeps: deps });
      assert.equal(r.status, 200);
      assert.equal(r.headers["cache-control"], "no-store");
      assert.match(r.json.data.svg, /^<svg /);
      assert.ok(!r.texto.includes("SEGREDO"), "nem a string crua do QR vai ao navegador");
    }
  });

  test("um erro nunca carrega o QR: operação inválida ⇒ 409 sem o valor", async () => {
    const { deps } = depsFalsas({ permitidos: [PAINEL.id] });
    const r = await chamar({ user: PAINEL, path: `${B}/qr?operacaoId=55555555-5555-4555-8555-555555555555`, adminDeps: deps });
    assert.equal(r.status, 409);
    assert.ok(!r.texto.includes("SEGREDO"));
  });

  test("desconectar sem confirmação explícita ⇒ 400 ANTES de tocar o Gateway", async () => {
    const { deps, chamadas } = depsFalsas({ permitidos: [PAINEL.id] });
    const r = await chamar({ user: PAINEL, metodo: "POST", path: `${B}/desconectar`, corpo: {}, adminDeps: deps });
    assert.equal(r.status, 400);
    assert.deepEqual(chamadas, []);
  });

  test("sem permissão nenhuma ação chega ao Gateway (POST iniciar/trocar/desconectar ⇒ 403)", async () => {
    const { deps, chamadas } = depsFalsas();
    _zerarCachePerfil();
    for (const [path, corpo] of [[`${B}/iniciar`, {}], [`${B}/trocar`, { confirmacaoExplicita: true }], [`${B}/desconectar`, { confirmacaoExplicita: true }]]) {
      assert.equal((await chamar({ user: PAINEL, metodo: "POST", path, corpo, adminDeps: deps })).status, 403, path);
    }
    assert.deepEqual(chamadas, []);
  });
});

describe("Conexão — guardas estáticos", () => {
  const src = (...p) => readFileSync(join(aqui, "..", "src", ...p), "utf8").replace(/\r\n/g, "\n");
  const semComentarios = (s) => s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  test("toda rota da Conexão nasce no administrativoRouter e toda escrita passa pelo limite de taxa próprio", () => {
    const linhas = src("modules", "administrativo", "administrativo.routes.js").split("\n").filter((l) => /comunicacao\/conexao/.test(l) && !l.trim().startsWith("//"));
    assert.equal(linhas.length, 9);
    assert.ok(linhas.every((l) => l.startsWith("administrativoRouter.")));
    for (const l of linhas.filter((x) => /\.(post|put)\(/.test(x))) assert.match(l, /limiteConexao/, l);
  });

  test("o serviço da Conexão só fala com o Gateway pelo WhatsAppService e nunca importa Baileys/HTTP na mão nem grava credencial", () => {
    const codigo = semComentarios(src("modules", "administrativo", "administrativo.comunicacao.conexao.js"));
    assert.ok(!/from "baileys"|fetch\(|auth_state|authState|creds|signal/i.test(codigo));
    assert.ok(!/console\.(log|error|warn)/.test(codigo), "o serviço nunca loga (QR/segredo)");
  });

  test("o QR nunca é escrito em tabela: nenhum insert/upsert/update do serviço recebe o valor do QR", () => {
    const codigo = semComentarios(src("modules", "administrativo", "administrativo.comunicacao.conexao.js"));
    // gravações e auditoria: nenhuma chamada recebe o valor do QR (a RESPOSTA ao operador é o único lugar onde ele passa, e só em memória)
    const chamadas = [...codigo.matchAll(/(salvarIdentidade|auditarConexao)\([^;]*;/g)].map((m) => m[0].replace(/ACOES\.WHATSAPP_QR_GERADO/g, ""));
    assert.ok(chamadas.length >= 10, "achou as chamadas de gravação/auditoria");
    for (const c of chamadas) assert.ok(!/\bqr\b|\bvalor\b/.test(c), c.slice(0, 140));
  });

  test("a migration 097 é aditiva, sem QR/auth/telefone e com RLS + revoke nas duas tabelas novas", () => {
    const sql = readFileSync(join(aqui, "..", "..", "database", "migrations", "097_whatsapp_conexao_identidade.sql"), "utf8").replace(/\r\n/g, "\n");
    const codigo = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    assert.ok(!/\bdrop\s+(table|view|function|column)\b/i.test(codigo) && !/\btruncate\b/i.test(codigo));
    assert.ok(!/alter\s+table\s+(?!painel_adm_permissoes\b|whatsapp_identidade\b)\w+/i.test(codigo), "ALTER TABLE só nas tabelas novas");
    assert.ok(!/\b(qr|auth_state\w*|telefone_e164|signal\w*)\s+(text|jsonb|bytea)/i.test(codigo), "nenhuma coluna para QR, auth state, telefone completo ou chaves");
    for (const t of ["painel_adm_permissoes", "whatsapp_identidade"]) {
      assert.match(codigo, new RegExp(`alter table ${t} enable row level security`));
      assert.match(codigo, new RegExp(`revoke all on ${t} from public, anon, authenticated`));
    }
    assert.ok(!/whatsapp_conexoes|comunicacao_mensagens|comunicacao_claim/.test(codigo), "não toca o estado da sessão nem o outbox");
  });
});
