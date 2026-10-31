// =====================================================================
// TESTE DE INTEGRAÇÃO — 136: fuso e horário da unidade só pelo backend (PostgREST REAL)
// =====================================================================
// Prova pelo HTTP do PostgREST de um Supabase REAL (o de TESTE) o que a 136 garante no banco:
//   * anon e authenticated NÃO gravam `timezone` / `horario_funcionamento` (UPDATE, INSERT, nem junto com outra coluna);
//   * as DEMAIS colunas seguem a permissão que já existia (rls_unidades_tenant: membro grava a própria unidade);
//   * isolamento: o membro não lê nem grava unidade de outra empresa;
//   * as tabelas e RPCs novas de 132–135 seguem fechadas para authenticated;
//   * o backend (service_role) grava o fuso e a transferência de unidade segue funcionando e preserva o fuso.
//
// COMO FUNCIONA (mesmo padrão de isolamento-tenant.test.js)
//   * Setup usa a service_role SÓ para criar a massa descartável (2 empresas, 2 unidades, 1 usuário vinculado à empresa A).
//   * As ASSERÇÕES de anon/authenticated usam a chave PUBLICÁVEL e o JWT real do usuário (login por senha) — nunca a service_role.
//   * Teardown apaga usuário e empresas (cascade).
//
// SEGURANÇA — NUNCA use produção: mesmas guardas de test/helpers/preflight-supabase.js (TEST_* definidas, URL ≠ SUPABASE_URL,
// ISOLATION_TEST_DISPOSABLE=1). Sem elas, é PULADO (npm test fica verde).
//
// COMO RODAR
//   node --env-file=.env.test --test test/isolamento-unidades-fuso-136-http.test.js
// =====================================================================
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { motivoParaPular, verificarCredencial } from "./helpers/preflight-supabase.js";

if (!globalThis.WebSocket) globalThis.WebSocket = ws;

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;

const motivoSkip = motivoParaPular({
  url: URL, service: SERVICE, anon: ANON,
  urlProducao: process.env.SUPABASE_URL,
  confirmaDescartavel: process.env.ISOLATION_TEST_DISPOSABLE === "1",
});

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const FUSO_RECUSADO = /só mudam pelo backend/;
const TABELAS_NOVAS = ["usuarios_convites", "comunicacao_legado_snapshot", "comunicacao_destinatario_escopos", "comunicacao_termos",
  "comunicacao_convites", "comunicacao_desafios_titular", "comunicacao_consentimentos"];

/** Chamada HTTP crua ao PostgREST: devolve status, corpo e o `code` do erro (se houver). */
async function rest(caminho, { metodo = "GET", chave, jwt = null, corpo } = {}) {
  const r = await fetch(`${URL}/rest/v1/${caminho}`, {
    method: metodo,
    headers: { apikey: chave, Authorization: `Bearer ${jwt ?? chave}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const texto = await r.text();
  let json = null;
  try { json = texto ? JSON.parse(texto) : null; } catch { json = texto; }
  return { status: r.status, json, code: json?.code ?? null, msg: json?.message ?? "" };
}

describe("136 — fuso e horário da unidade só pelo backend (PostgREST real)", { skip: motivoSkip }, () => {
  const admin = createClient(URL, SERVICE, opts);
  const tag = `fuso136_${Date.now()}`;
  const SENHA = `F136-${tag}-Xx1!`;
  const ctx = {};

  const lerUnidade = async (id) => {
    const { data, error } = await admin.from("unidades").select("id, nome, organizacao_id, timezone, horario_funcionamento").eq("id", id).single();
    assert.ifError(error);
    return data;
  };
  const comoAnon = (caminho, o = {}) => rest(caminho, { ...o, chave: ANON });
  const comoA = (caminho, o = {}) => rest(caminho, { ...o, chave: ANON, jwt: ctx.jwtA });

  before(async () => {
    await verificarCredencial(admin, SERVICE);
    for (const r of ["A", "B"]) {
      const { data: org, error: eOrg } = await admin.from("organizacoes").insert({ nome: `F136 ${r} ${tag}` }).select("id").single();
      assert.ifError(eOrg);
      const { data: uni, error: eUni } = await admin.from("unidades").insert({ organizacao_id: org.id, nome: `Unidade ${r} ${tag}` }).select("id").single();
      assert.ifError(eUni);
      ctx[`org${r}`] = org.id;
      ctx[`uni${r}`] = uni.id;
    }
    const email = `${tag}_a@example.com`;
    const { data: criado, error: eUser } = await admin.auth.admin.createUser({ email, password: SENHA, email_confirm: true });
    assert.ifError(eUser);
    ctx.uidA = criado.user.id;
    const { error: ePerf } = await admin.from("perfis").insert({
      id: ctx.uidA, organizacao_id: ctx.orgA, unidade_id: ctx.uniA, nome: "User A", email, papel: "admin", ativo: true,
    });
    assert.ifError(ePerf);
    const { data: po, error: ePo } = await admin.from("perfis_operacionais").insert({ conta_id: ctx.uidA, nome: "Perfil A" }).select("id").single();
    assert.ifError(ePo);
    const { error: eVo } = await admin.from("usuarios_organizacoes")
      .insert({ usuario_id: ctx.uidA, organizacao_id: ctx.orgA, papel: "organization_admin", perfil_id: po.id });
    assert.ifError(eVo);
    const { error: eVu } = await admin.from("usuarios_unidades").insert({ usuario_id: ctx.uidA, unidade_id: ctx.uniA, perfil_id: po.id });
    assert.ifError(eVu);
    const cli = createClient(URL, ANON, opts);
    const { data: sessao, error: eLogin } = await cli.auth.signInWithPassword({ email, password: SENHA });
    assert.ifError(eLogin);
    ctx.jwtA = sessao.session.access_token;
  });

  after(async () => {
    if (ctx.uidA) { try { await admin.auth.admin.deleteUser(ctx.uidA); } catch { /* ignora */ } }
    for (const org of [ctx.orgA, ctx.orgB]) {
      if (org) { try { await admin.from("organizacoes").delete().eq("id", org); } catch { /* ignora */ } }
    }
  });

  // ------- anon -------
  it("anon não lê unidades", async () => {
    const r = await comoAnon(`unidades?select=id&id=eq.${ctx.uniA}`);
    assert.ok(r.status >= 400 || (Array.isArray(r.json) && r.json.length === 0), `anon leu unidade: ${r.status}`);
  });

  it("anon não grava fuso nem horário", async () => {
    const r1 = await comoAnon(`unidades?id=eq.${ctx.uniA}`, { metodo: "PATCH", corpo: { timezone: "America/Manaus" } });
    const r2 = await comoAnon(`unidades?id=eq.${ctx.uniA}`, { metodo: "PATCH", corpo: { horario_funcionamento: {} } });
    for (const r of [r1, r2]) assert.ok(r.status >= 400 || (Array.isArray(r.json) && r.json.length === 0), `anon gravou: ${r.status}`);
    const u = await lerUnidade(ctx.uniA);
    assert.equal(u.timezone, null);
    assert.equal(u.horario_funcionamento, null);
  });

  it("anon não insere unidade com fuso", async () => {
    const r = await comoAnon("unidades", { metodo: "POST", corpo: { organizacao_id: ctx.orgA, nome: `anon ${tag}`, timezone: "America/Sao_Paulo" } });
    assert.ok(r.status >= 400, `anon inseriu: ${r.status}`);
  });

  // ------- authenticated (membro da empresa A) -------
  it("membro enxerga só as unidades da própria empresa", async () => {
    const r = await comoA("unidades?select=id,organizacao_id");
    assert.equal(r.status, 200);
    assert.ok(r.json.some((x) => x.id === ctx.uniA), "não viu a própria unidade");
    assert.ok(r.json.every((x) => x.organizacao_id === ctx.orgA), "viu unidade de outra empresa");
  });

  it("membro NÃO grava o fuso da própria unidade (42501)", async () => {
    const r = await comoA(`unidades?id=eq.${ctx.uniA}`, { metodo: "PATCH", corpo: { timezone: "America/Manaus" } });
    assert.equal(r.status, 403);
    assert.equal(r.code, "42501");
    assert.match(r.msg, FUSO_RECUSADO);
    assert.equal((await lerUnidade(ctx.uniA)).timezone, null);
  });

  it("membro NÃO grava o horário da própria unidade (42501)", async () => {
    const r = await comoA(`unidades?id=eq.${ctx.uniA}`, { metodo: "PATCH", corpo: { horario_funcionamento: { seg: [{ inicio: "10:00", fim: "22:00" }] } } });
    assert.equal(r.status, 403);
    assert.equal(r.code, "42501");
    assert.match(r.msg, FUSO_RECUSADO);
    assert.equal((await lerUnidade(ctx.uniA)).horario_funcionamento, null);
  });

  it("membro NÃO grava o fuso escondido junto com outra coluna", async () => {
    const antes = await lerUnidade(ctx.uniA);
    const r = await comoA(`unidades?id=eq.${ctx.uniA}`, { metodo: "PATCH", corpo: { nome: `${antes.nome} x`, timezone: "America/Manaus" } });
    assert.equal(r.code, "42501");
    const depois = await lerUnidade(ctx.uniA);
    assert.equal(depois.nome, antes.nome, "a transação deveria ter sido recusada inteira");
    assert.equal(depois.timezone, null);
  });

  it("membro NÃO insere unidade com fuso", async () => {
    const r = await comoA("unidades", { metodo: "POST", corpo: { organizacao_id: ctx.orgA, nome: `ins ${tag}`, timezone: "America/Sao_Paulo" } });
    assert.equal(r.status, 403);
    assert.equal(r.code, "42501");
    assert.match(r.msg, FUSO_RECUSADO);
  });

  it("DEMAIS colunas: membro segue gravando a própria unidade (permissão anterior, inalterada)", async () => {
    const r = await comoA(`unidades?id=eq.${ctx.uniA}`, { metodo: "PATCH", corpo: { nome: `Unidade A2 ${tag}` } });
    assert.equal(r.status, 200);
    assert.equal(r.json.length, 1);
    assert.equal((await lerUnidade(ctx.uniA)).nome, `Unidade A2 ${tag}`);
  });

  it("enviar o fuso SEM mudança não é bloqueado", async () => {
    const r = await comoA(`unidades?id=eq.${ctx.uniA}`, { metodo: "PATCH", corpo: { timezone: null } });
    assert.equal(r.status, 200);
    assert.equal(r.json.length, 1);
  });

  it("isolamento: membro não lê nem grava unidade de outra empresa", async () => {
    const antes = await lerUnidade(ctx.uniB);
    const lida = await comoA(`unidades?select=id&id=eq.${ctx.uniB}`);
    assert.deepEqual(lida.json, []);
    const r1 = await comoA(`unidades?id=eq.${ctx.uniB}`, { metodo: "PATCH", corpo: { nome: "invasão" } });
    const r2 = await comoA(`unidades?id=eq.${ctx.uniB}`, { metodo: "PATCH", corpo: { timezone: "America/Manaus" } });
    for (const r of [r1, r2]) assert.ok(r.status >= 400 || (Array.isArray(r.json) && r.json.length === 0), `gravou em outra empresa: ${r.status}`);
    assert.deepEqual(await lerUnidade(ctx.uniB), antes);
  });

  it("tabelas novas de 132–135 seguem fechadas para o membro", async () => {
    for (const t of TABELAS_NOVAS) {
      const r = await comoA(`${t}?select=*&limit=1`);
      assert.ok(r.status >= 400, `${t} exposta para authenticated: ${r.status}`);
    }
  });

  it("RPCs novas e a transferência não são executáveis pelo membro", async () => {
    const chamadas = {
      comunicacao_resolver_destinatarios_unidade: { p_organizacao_id: ctx.orgA, p_unidade_id: ctx.uniA, p_tipo_alerta: "dashboard_ifood_d1" },
      comunicacao_revogar: {},
      transferir_unidade_organizacao: { p_unidade_id: ctx.uniA, p_nova_organizacao_id: ctx.orgB, p_ator_id: ctx.uidA },
    };
    for (const [fn, corpo] of Object.entries(chamadas)) {
      const r = await comoA(`rpc/${fn}`, { metodo: "POST", corpo });
      assert.ok(r.status >= 400, `${fn} executou para authenticated: ${r.status}`);
    }
    assert.equal((await lerUnidade(ctx.uniA)).organizacao_id, ctx.orgA);
  });

  // ------- backend (service_role) — o caminho autorizado -------
  it("backend grava fuso e horário; validação da 132 segue valendo", async () => {
    const ok = await rest(`unidades?id=eq.${ctx.uniA}`, { metodo: "PATCH", chave: SERVICE,
      corpo: { timezone: "America/Manaus", horario_funcionamento: { seg: [{ inicio: "10:00", fim: "22:00" }] } } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json[0].timezone, "America/Manaus");
    const ruim = await rest(`unidades?id=eq.${ctx.uniA}`, { metodo: "PATCH", chave: SERVICE, corpo: { timezone: "Marte/Base" } });
    assert.equal(ruim.code, "22023");
  });

  it("transferência pelo backend funciona e preserva fuso e horário", async () => {
    const r = await rest("rpc/transferir_unidade_organizacao", { metodo: "POST", chave: SERVICE,
      corpo: { p_unidade_id: ctx.uniA, p_nova_organizacao_id: ctx.orgB, p_ator_id: ctx.uidA, p_ator_email: null, p_ip: null, p_user_agent: "teste-136" } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const u = await lerUnidade(ctx.uniA);
    assert.equal(u.organizacao_id, ctx.orgB);
    assert.equal(u.timezone, "America/Manaus");
    assert.ok(u.horario_funcionamento);
  });
});
