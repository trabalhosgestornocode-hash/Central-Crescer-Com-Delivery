// Central de Notificações — testes NEGATIVOS no nível HTTP, com os routers REAIS (sem banco: tudo o que é recusado tem de ser
// recusado ANTES de qualquer acesso ao banco; o fetch global fica bloqueado e qualquer tentativa de rede falha o teste).
//   * público do titular: só POST, sem cache, sem referrer, token inválido = 404 genérico, limite por IP (429), código nunca na resposta;
//   * tenant (D-3): quem não tem permissão, financeiro tentando gerenciar, gerente sem unidade no contexto e gerente mirando
//     outra unidade são recusados com 403.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

process.env.NOTIFICACOES_SEGREDO_MESTRE = "segredo-de-teste-da-central-0123456789abcdef";
process.env.RATE_LIMIT_NOTIFICACOES_TITULAR_MAX = "5";
const { titularRouter, notificacoesRouter } = await import("../src/modules/notificacoes/notificacoes.routes.js");
const { errorHandler } = await import("../src/middlewares/errorHandler.js");
const { permissoesDoPapel } = await import("../src/shared/permissoes.js");

const ORG = "00000000-0000-4000-8000-00000000a001";
const UN_A = "00000000-0000-4000-8000-0000000000a1";
const UN_B = "00000000-0000-4000-8000-0000000000a2";

let chamadasDeRede = 0;
const fetchOriginal = globalThis.fetch;
let servidor; let base; let sessao = null;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/publico/notificacoes", titularRouter);
  app.use("/api/v1/notificacoes", (req, _res, next) => { if (sessao) Object.assign(req, sessao()); next(); }, notificacoesRouter);
  app.use(errorHandler);
  servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});
after(async () => { await new Promise((r) => servidor.close(r)); });

// fetch do TESTE (cliente) passa; o do SERVIDOR (Supabase) é contado como rede proibida.
async function chamar(metodo, caminho, corpo) {
  const r = await fetchOriginal(base + caminho, { method: metodo, headers: corpo ? { "Content-Type": "application/json" } : {}, body: corpo ? JSON.stringify(corpo) : undefined });
  const texto = await r.text();
  return { status: r.status, headers: r.headers, texto, json: (() => { try { return JSON.parse(texto); } catch { return null; } })() };
}
const redes = [];
before(() => { globalThis.fetch = async (u) => { chamadasDeRede++; redes.push(String(u).replace(/^https?:\/\/[^/]+/, "").slice(0, 80)); throw new Error("rede bloqueada no teste"); }; });
after(() => { globalThis.fetch = fetchOriginal;   // A única escrita permitida é a auditoria de SEGURANÇA da plataforma (403/429 viram evento — errorHandler.js). Dado nenhum.
  assert.deepEqual(redes.filter((u) => !u.startsWith("/rest/v1/plataforma_auditoria")), [], "nenhuma recusa pode tocar tabela de dados");
  assert.ok(redes.length > 0, "as recusas foram auditadas (evento de segurança)");
});

describe("rotas públicas do titular", () => {
  test("só POST: GET/PUT/DELETE não existem (404) — token e código nunca vão na URL", async () => {
    for (const m of ["GET", "PUT", "DELETE"]) assert.equal((await chamar(m, "/api/publico/notificacoes/convite/abrir")).status, 404, m);
  });
  test("token inválido: 404 genérico, sem cache e sem referrer", async () => {
    const r = await chamar("POST", "/api/publico/notificacoes/convite/abrir", { token: "curto" });
    assert.equal(r.status, 404);
    assert.match(r.json.error, /inválido ou expirado/);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  });
  test("transporte desligado (padrão): pedir código = 503, nenhum desafio criado", async () => {
    const r = await chamar("POST", "/api/publico/notificacoes/gestao/codigo", { telefone: "(11) 91234-5678" });
    assert.equal(r.status, 503);
    assert.doesNotMatch(r.texto, /\d{6}/, "nenhum código na resposta");
  });
  test("limite por IP: depois do teto, 429 em QUALQUER rota pública", async () => {
    let ultimo = null;
    for (let i = 0; i < 6; i++) ultimo = await chamar("POST", "/api/publico/notificacoes/convite/abrir", { token: "x" });
    assert.equal(ultimo.status, 429);
    assert.equal((await chamar("POST", "/api/publico/notificacoes/gestao/verificar", { desafio: "x", provisorio: "y", codigo: "123456" })).status, 429);
  });
});

describe("rotas do tenant (D-3)", () => {
  const como = (papel, unidadeId) => () => ({ tenant: { organizacaoId: ORG, unidadeId }, acesso: { papel, permissoes: permissoesDoPapel(papel) }, user: { id: "u" } });
  const CONVITE = { nome: "X", telefone: "(11) 91234-5678", unidades: [UN_B], categorias: ["pendencia_d1"] };

  test("sem contexto/permissão (operations, viewer): 403 em leitura e escrita", async () => {
    for (const papel of ["operations", "viewer"]) {
      sessao = como(papel, UN_A);
      assert.equal((await chamar("GET", "/api/v1/notificacoes/destinatarios")).status, 403, papel);
      assert.equal((await chamar("POST", "/api/v1/notificacoes/convites", CONVITE)).status, 403, papel);
    }
  });
  test("financeiro: pode ver, NÃO gerencia (convidar, suspender, revogar, auditoria = 403)", async () => {
    sessao = como("finance", UN_A);
    assert.equal((await chamar("POST", "/api/v1/notificacoes/convites", CONVITE)).status, 403);
    assert.equal((await chamar("POST", `/api/v1/notificacoes/destinatarios/${UN_A}/suspensao`, { unidadeId: UN_A })).status, 403);
    assert.equal((await chamar("POST", `/api/v1/notificacoes/destinatarios/${UN_A}/pedido-revogacao`, { motivo: "abc" })).status, 403);
    assert.equal((await chamar("GET", "/api/v1/notificacoes/auditoria")).status, 403);
  });
  test("gerente SEM unidade no contexto (visão da empresa): 403 — não vira gestor da empresa inteira", async () => {
    sessao = como("unit_manager", null);
    assert.equal((await chamar("GET", "/api/v1/notificacoes/destinatarios")).status, 403);
    assert.equal((await chamar("POST", "/api/v1/notificacoes/convites", CONVITE)).status, 403);
  });
  test("gerente da unidade A mirando a unidade B: 403 em convite, suspensão, preferências e vínculo", async () => {
    sessao = como("unit_manager", UN_A);
    assert.equal((await chamar("POST", "/api/v1/notificacoes/convites", CONVITE)).status, 403);
    assert.equal((await chamar("POST", `/api/v1/notificacoes/destinatarios/${UN_A}/suspensao`, { unidadeId: UN_B })).status, 403);
    assert.equal((await chamar("PUT", `/api/v1/notificacoes/destinatarios/${UN_A}/preferencias`, { unidadeId: UN_B })).status, 403);
    assert.equal((await chamar("POST", `/api/v1/notificacoes/destinatarios/${UN_A}/vincular-unidade`, { unidadeId: UN_B, motivo: "abc" })).status, 403);
    assert.equal((await chamar("GET", `/api/v1/notificacoes/historico?unidadeId=${UN_B}`)).status, 403);
  });
  test("produção sem APP_URL_PUBLICA: criar convite da Central = 503 ANTES de qualquer gravação; Host forjado não vira link", async () => {
    const antes = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      sessao = como("organization_admin", UN_A);
      const r = await fetchOriginal(base + "/api/v1/notificacoes/convites", { method: "POST", headers: { "Content-Type": "application/json", Host: "atacante.exemplo" }, body: JSON.stringify({ ...CONVITE, unidades: [UN_A] }) });
      const corpo = await r.json();
      assert.equal(r.status, 503);
      assert.equal(corpo.details?.codigo ?? corpo.codigo ?? "URL_PUBLICA_AUSENTE", "URL_PUBLICA_AUSENTE");
      assert.doesNotMatch(JSON.stringify(corpo), /atacante/);
    } finally { process.env.NODE_ENV = antes; }
  });
  test("preferências NUNCA reativam: habilitado:true não é aceito como ligar (só restringe)", async () => {
    const { definirPreferencias } = await import("../src/modules/notificacoes/notificacoes.service.js");
    let enviado = null;
    await definirPreferencias({ req: { user: { id: "u" } }, escopo: { organizacaoId: ORG, unidadePermitida: UN_A }, destinatarioId: UN_A,
      corpo: { unidadeId: UN_A, habilitado: true }, deps: { auditar: async () => {}, repo: { preferenciasEscopo: async (p) => { enviado = p; return { resultado: "ATUALIZADO" }; } } } });
    assert.equal(enviado.habilitado, null, "habilitado:true vira 'não mexer'");
  });
});
