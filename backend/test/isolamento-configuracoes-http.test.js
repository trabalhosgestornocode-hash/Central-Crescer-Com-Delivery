// =====================================================================
// TESTE DE INTEGRAÇÃO — Isolamento das rotas de Configurações via HTTP
// =====================================================================
// Prova, contra o Express REAL + Supabase REAL, que os endpoints tenant de
// Configurações (Fase C / C.1) só respondem pela unidade do Context Token:
//
//   GET/PATCH /api/v1/unidade/dados
//   GET/PATCH /api/v1/unidade/metas-cmv
//   GET       /api/v1/unidade/tabelas-comerciais   (com catálogo por empresa)
//
// Afirmações verificadas (pedido da Fase G, item 4):
//   * token A nunca LÊ dado de B;
//   * token A nunca ESCREVE em B;
//   * trocar de unidade dentro da MESMA empresa respeita a unidade nova;
//   * `unidadeId` no corpo NÃO altera o alvo — é sempre o do Context Token;
//   * sem Context Token → 409; Context Token de outra sessão → recusado.
//
// SEGURANÇA — mesmas guardas do isolamento-tenant.test.js:
//   Só roda com TEST_SUPABASE_* + ISOLATION_TEST_DISPOSABLE=1. Sem isso é
//   PULADO (npm test fica verde). Recusa se a URL de teste == produção.
//
// PRÉ-REQUISITO: o Supabase de teste precisa do schema + migrations, INCLUINDO
//   057 (unidades.responsavel/email) e 058 (unidade_config). Se não estiverem
//   aplicadas, o teste PULA com a mensagem dizendo qual migration falta.
//
// COMO RODAR
//   node --env-file=.env.test --test test/isolamento-configuracoes-http.test.js
// =====================================================================
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { motivoParaPular, verificarCredencial, verificarTabelas } from "./helpers/preflight-supabase.js";

// IMPORTANTE: nada de `../src/**` é importado no topo. `config/env.js` roda
// no import e faz process.exit(1) se as vars do backend não estiverem no
// ambiente. Como este teste só roda com um SUPABASE de teste apontado por
// SUPABASE_URL/SERVICE/ANON (ver "COMO RODAR"), os imports do app ficam
// DENTRO do before() — quando o teste está PULADO, nada do app é carregado.
let createApp, criarSessao, permissoesDoPapel;

if (!globalThis.WebSocket) globalThis.WebSocket = ws;

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const CONFIRMA_DESCARTAVEL = process.env.ISOLATION_TEST_DISPOSABLE === "1";

// Este teste sobe o Express REAL. Para isso o processo precisa estar
// configurado para o projeto de TESTE (SUPABASE_URL == TEST_SUPABASE_URL).
// Nesse caso a guarda padrão "urlProducao" não se aplica — passamos null.
const APP_APONTA_TESTE = Boolean(process.env.SUPABASE_URL) && process.env.SUPABASE_URL === URL;

const motivoSkip = motivoParaPular({
  url: URL, service: SERVICE, anon: ANON,
  urlProducao: APP_APONTA_TESTE ? null : process.env.SUPABASE_URL,
  confirmaDescartavel: CONFIRMA_DESCARTAVEL,
}) || (!APP_APONTA_TESTE
  ? "[APP NAO CONFIGURADO PARA TESTE] rode com SUPABASE_URL/SERVICE/ANON == as do projeto de TESTE "
    + "(ex.: node --env-file=.env.test.http --test test/isolamento-configuracoes-http.test.js, onde .env.test.http "
    + "define SUPABASE_URL=<url de teste>, SUPABASE_SERVICE_ROLE_KEY=<...>, SUPABASE_ANON_KEY=<...>, "
    + "IFOOD_TOKEN_SECRET=<qualquer>, TEST_SUPABASE_URL=<mesma url>, TEST_SUPABASE_SERVICE_ROLE_KEY=<...>, "
    + "TEST_SUPABASE_ANON_KEY=<...>, ISOLATION_TEST_DISPOSABLE=1). O app usa um cliente supabase singleton; "
    + "sem isso o Express fala com um projeto e o JWT vem de outro."
  : "");

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
let PERMS_ADMIN;

describe("Isolamento HTTP — rotas de Configurações", { skip: motivoSkip }, () => {
  const admin = createClient(URL, SERVICE, opts);
  const tag = `cfgiso_${Date.now()}`;
  const SENHA = `Cfg-${tag}-Xx1!`;
  /** @type {import('node:http').Server} */
  let server;
  let base; // http://127.0.0.1:PORT
  const ctx = { A: null, B: null };

  async function criarAuthUser(sufixo) {
    const email = `${tag}_${sufixo}@example.com`.toLowerCase();
    const { data, error } = await admin.auth.admin.createUser({ email, password: SENHA, email_confirm: true });
    assert.ifError(error);
    const cli = createClient(URL, ANON, opts);
    const { data: sess, error: e2 } = await cli.auth.signInWithPassword({ email, password: SENHA });
    assert.ifError(e2);
    return { uid: data.user.id, email, jwt: sess.session.access_token };
  }

  // Empresa com 2 unidades + usuário organization_admin vinculado + preços +
  // unidade_config na 1ª unidade. Devolve tokens de contexto p/ cada unidade.
  async function criarEmpresa(rotulo, { cmvSaudavel, cmvAtencao, tabela }) {
    const { data: org } = await admin.from("organizacoes").insert({ nome: `CFG ${rotulo} ${tag}` }).select("id").single();
    const { data: u1 } = await admin.from("unidades")
      .insert({ organizacao_id: org.id, nome: `${rotulo}1 ${tag}`, responsavel: `Resp ${rotulo}1`, email: `${rotulo}1@loja.test`.toLowerCase(), tabela_balcao: tabela })
      .select("id").single();
    const { data: u2 } = await admin.from("unidades")
      .insert({ organizacao_id: org.id, nome: `${rotulo}2 ${tag}`, responsavel: `Resp ${rotulo}2` })
      .select("id").single();

    const user = await criarAuthUser(rotulo);
    await admin.from("perfis").insert({ id: user.uid, organizacao_id: org.id, nome: `User ${rotulo}`, email: user.email, papel: "admin", ativo: true });
    await admin.from("usuarios_organizacoes").insert({ usuario_id: user.uid, organizacao_id: org.id, papel: "organization_admin" });
    await admin.from("usuarios_unidades").insert([
      { usuario_id: user.uid, unidade_id: u1.id }, { usuario_id: user.uid, unidade_id: u2.id },
    ]);

    // metas de CMV só na 1ª unidade
    await admin.from("unidade_config").insert({ unidade_id: u1.id, cmv_saudavel: cmvSaudavel, cmv_atencao: cmvAtencao });

    // 1 produto com preço na tabela informada → catálogo da empresa
    const { data: prod } = await admin.from("produtos").insert({ organizacao_id: org.id, nome: `Prod ${rotulo} ${tag}` }).select("id").single();
    await admin.from("produto_precos").insert({ produto_id: prod.id, canal: "balcao", tabela, preco: 20 });

    const mk = (unidadeId) => criarSessao({
      usuarioId: user.uid, organizacaoId: org.id, unidadeId,
      papel: "organization_admin", permissoes: PERMS_ADMIN, modulos: [],
    });
    const [s1, s2] = await Promise.all([mk(u1.id), mk(u2.id)]);
    return { orgId: org.id, u1: u1.id, u2: u2.id, user, ctxU1: s1.token, ctxU2: s2.token };
  }

  const req = (metodo, rota, { jwt, ctxToken, body } = {}) =>
    fetch(base + rota, {
      method: metodo,
      headers: {
        ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
        ...(ctxToken ? { "x-context-token": ctxToken } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  before(async () => {
    ({ createApp } = await import("../src/app.js"));
    ({ criarSessao } = await import("../src/modules/sessao/sessao.service.js"));
    ({ permissoesDoPapel } = await import("../src/shared/permissoes.js"));
    PERMS_ADMIN = permissoesDoPapel("organization_admin");

    await verificarCredencial(admin, SERVICE);
    await verificarTabelas(admin, [
      "organizacoes", "unidades", "perfis", "produtos", "produto_precos",
      "usuarios_organizacoes", "usuarios_unidades", "sessoes_contexto",
      "unidade_config",           // migration 058
    ]);
    // migration 057 — coluna responsavel/email em unidades
    const { error: e057 } = await admin.from("unidades").select("responsavel, email").limit(1);
    if (e057) throw new Error("[MIGRATION 057 AUSENTE] unidades.responsavel/email nao existem no projeto de teste. Aplique 057_unidade_dados_contato.sql.");

    server = http.createServer(createApp());
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;

    ctx.A = await criarEmpresa("A", { cmvSaudavel: 25, cmvAtencao: 30, tabela: "E" });
    ctx.B = await criarEmpresa("B", { cmvSaudavel: 40, cmvAtencao: 45, tabela: "AERO A" });
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    for (const t of [ctx.A, ctx.B]) {
      if (!t) continue;
      try { await admin.auth.admin.deleteUser(t.user.uid); } catch { /* ignora */ }
      try { await admin.from("organizacoes").delete().eq("id", t.orgId); } catch { /* ignora */ }
    }
  });

  // ---- Dados da Unidade ----
  it("GET /unidade/dados: token A devolve A1, token B devolve B1 — nunca cruzam", async () => {
    const rA = await (await req("GET", "/api/v1/unidade/dados", { jwt: ctx.A.user.jwt, ctxToken: ctx.A.ctxU1 })).json();
    const rB = await (await req("GET", "/api/v1/unidade/dados", { jwt: ctx.B.user.jwt, ctxToken: ctx.B.ctxU1 })).json();
    assert.match(rA.data.nome, /^A1 /);
    assert.equal(rA.data.responsavel, "Resp A1");
    assert.match(rB.data.nome, /^B1 /);
    assert.notEqual(rA.data.id, rB.data.id);
  });

  it("PATCH /unidade/dados como A com unidadeId de B no corpo → edita A1, B1 intacta", async () => {
    const r = await req("PATCH", "/api/v1/unidade/dados", {
      jwt: ctx.A.user.jwt, ctxToken: ctx.A.ctxU1,
      body: { nome: `A1-EDIT ${tag}`, responsavel: "Novo A1", unidadeId: ctx.B.u1, organizacaoId: ctx.B.orgId },
    });
    assert.equal(r.status, 200);
    const { data: a1 } = await admin.from("unidades").select("nome, responsavel").eq("id", ctx.A.u1).single();
    const { data: b1 } = await admin.from("unidades").select("nome, responsavel").eq("id", ctx.B.u1).single();
    assert.equal(a1.nome, `A1-EDIT ${tag}`, "editou A1 (Context Token)");
    assert.match(b1.nome, /^B1 /);
    assert.equal(b1.responsavel, "Resp B1", "B1 intacta apesar do unidadeId no corpo");
  });

  it("PATCH /unidade/dados como A (unidade A1) não toca A2", async () => {
    const { data: antes } = await admin.from("unidades").select("nome, responsavel").eq("id", ctx.A.u2).single();
    await req("PATCH", "/api/v1/unidade/dados", { jwt: ctx.A.user.jwt, ctxToken: ctx.A.ctxU1, body: { telefone: "1199990000" } });
    const { data: depois } = await admin.from("unidades").select("nome, responsavel").eq("id", ctx.A.u2).single();
    assert.deepEqual(antes, depois, "A2 intacta");
  });

  it("trocar de unidade na mesma empresa (token A→A2) devolve A2, não A1", async () => {
    const r = await (await req("GET", "/api/v1/unidade/dados", { jwt: ctx.A.user.jwt, ctxToken: ctx.A.ctxU2 })).json();
    assert.match(r.data.nome, /^A2 /);
    assert.equal(r.data.responsavel, "Resp A2");
  });

  // ---- Metas de CMV ----
  it("GET /unidade/metas-cmv: A1=25/30, B1=40/45, A2=default 32/40", async () => {
    const a1 = await (await req("GET", "/api/v1/unidade/metas-cmv", { jwt: ctx.A.user.jwt, ctxToken: ctx.A.ctxU1 })).json();
    const b1 = await (await req("GET", "/api/v1/unidade/metas-cmv", { jwt: ctx.B.user.jwt, ctxToken: ctx.B.ctxU1 })).json();
    const a2 = await (await req("GET", "/api/v1/unidade/metas-cmv", { jwt: ctx.A.user.jwt, ctxToken: ctx.A.ctxU2 })).json();
    assert.deepEqual([a1.data.cmvSaudavel, a1.data.cmvAtencao, a1.data.persistido], [25, 30, true]);
    assert.deepEqual([b1.data.cmvSaudavel, b1.data.cmvAtencao, b1.data.persistido], [40, 45, true]);
    assert.deepEqual([a2.data.cmvSaudavel, a2.data.cmvAtencao, a2.data.persistido], [32, 40, false]);
  });

  it("PATCH /unidade/metas-cmv como A não altera a config de B", async () => {
    await req("PATCH", "/api/v1/unidade/metas-cmv", { jwt: ctx.A.user.jwt, ctxToken: ctx.A.ctxU1, body: { cmvSaudavel: 18, cmvAtencao: 22 } });
    const { data: b } = await admin.from("unidade_config").select("cmv_saudavel, cmv_atencao").eq("unidade_id", ctx.B.u1).single();
    assert.deepEqual([Number(b.cmv_saudavel), Number(b.cmv_atencao)], [40, 45], "config de B1 intacta");
  });

  // ---- Tabelas comerciais + catálogo por empresa ----
  it("GET /unidade/tabelas-comerciais: catálogo é da empresa — A não vê 'AERO A' de B", async () => {
    const a = await (await req("GET", "/api/v1/unidade/tabelas-comerciais", { jwt: ctx.A.user.jwt, ctxToken: ctx.A.ctxU1 })).json();
    const b = await (await req("GET", "/api/v1/unidade/tabelas-comerciais", { jwt: ctx.B.user.jwt, ctxToken: ctx.B.ctxU1 })).json();
    assert.deepEqual(a.data.catalogo.balcao, ["E"]);
    assert.deepEqual(b.data.catalogo.balcao, ["AERO A"]);
    assert.ok(!a.data.catalogo.balcao.includes("AERO A"), "A nunca vê a taxonomia de B");
  });

  // ---- Context Token é a única fonte de autorização ----
  it("sem Context Token → 409", async () => {
    const r = await req("GET", "/api/v1/unidade/dados", { jwt: ctx.A.user.jwt });
    assert.equal(r.status, 409);
  });

  it("Context Token de B com JWT de A → recusado (409)", async () => {
    const r = await req("GET", "/api/v1/unidade/dados", { jwt: ctx.A.user.jwt, ctxToken: ctx.B.ctxU1 });
    assert.equal(r.status, 409, "token de contexto não pertence à sessão do usuário A");
  });
});
