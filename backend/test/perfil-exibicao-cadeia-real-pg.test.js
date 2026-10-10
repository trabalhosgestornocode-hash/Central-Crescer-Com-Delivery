// Perfil de EXIBIÇÃO — CADEIA REAL: createApp + requireAuth + seleção de contexto + requireContexto + módulos do
// tenant, com o supabase-js de verdade apontado para um "Supabase" local (helpers/supabase-falso-pg.js) em cima de um
// Postgres REAL e DESCARTÁVEL. As migrations 112 e 113 aplicadas aqui são as REAIS (database/migrations).
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55410/postgres node --test test/perfil-exibicao-cadeia-real-pg.test.js
//
// PULA sem a variável e RECUSA qualquer host que não seja local. Dados fictícios; nunca toca o Supabase de verdade
// (a URL do projeto é a do servidor local do próprio teste).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { motivoPular, criarBancoDescartavel, sql } from "./helpers/pg-descartavel.js";
import { iniciarSupabaseFalso } from "./helpers/supabase-falso-pg.js";
import { SCHEMA_BASE } from "./helpers/schema-perfil-exibicao.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const MIG = join(aqui, "..", "..", "database", "migrations");

const ORG_A = "a0000000-0000-4000-8000-00000000000a";
const ORG_B = "b0000000-0000-4000-8000-00000000000b";
const UNI_A1 = "a1000000-0000-4000-8000-0000000000a1";
const UNI_A2 = "a2000000-0000-4000-8000-0000000000a2";
const UNI_B1 = "b1000000-0000-4000-8000-0000000000b1";
const MODULOS_TODOS = ["dashboard", "products_cmv", "ingredients", "sales", "ifood", "ifood_dashboard", "monthly_bonus", "parser_food_delivery", "martin_brower", "inteligencia", "agente_ia"];

const USUARIOS = new Map(); // jwt -> { id, email }
let banco; let falso; let servidor; let BASE;
let svc; // serviços carregados depois de apontar o ambiente para o servidor falso

// ---- helpers de dados -------------------------------------------------------------------------------------------
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
function conta(rotulo) {
  const id = randomUUID(); const jwt = `jwt.${Buffer.from(JSON.stringify({ sub: id })).toString("base64url")}.sig`;
  USUARIOS.set(jwt, { id, email: `${rotulo}-${id.slice(0, 6)}@exemplo.test` });
  sql(banco.url, `insert into perfis (id, nome, email) values ('${id}', ${lit(rotulo)}, ${lit(USUARIOS.get(jwt).email)});
    insert into perfis_operacionais (id, conta_id, nome) values ('${id}', '${id}', ${lit(rotulo)});`); // perfil inicial: id == conta
  return { id, jwt, rotulo };
}
const vincularEmpresa = (c, org, papel) => sql(banco.url, `insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values ('${c.id}', '${c.id}', '${org}', '${papel}')`);
const vincularUnidade = (c, uni, papel) => sql(banco.url, `insert into usuarios_unidades (usuario_id, perfil_id, unidade_id, papel) values ('${c.id}', '${c.id}', '${uni}', ${papel ? lit(papel) : "null"})`);
const contaExibicao = (rotulo, uni = UNI_A1) => { const c = conta(rotulo); vincularUnidade(c, uni, "display_operator"); return c; };

async function api(c, metodo, caminho, { ctx, corpo, headers = {} } = {}) {
  const r = await fetch(`${BASE}/api/v1${caminho}`, {
    method: metodo,
    headers: { authorization: `Bearer ${c.jwt}`, ...(ctx ? { "x-context-token": ctx } : {}), ...(corpo !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const texto = await r.text(); let json = null; try { json = JSON.parse(texto); } catch { /* vazio */ }
  return { status: r.status, json, texto };
}
async function entrar(c, org = ORG_A, uni = UNI_A1) {
  const r = await api(c, "POST", "/sessao/selecionar", { corpo: { organizacaoId: org, unidadeId: uni } });
  assert.equal(r.status, 201, r.texto);
  return { ctx: r.json.data.contextToken, sid: r.json.data.sessionId, dados: r.json.data };
}
const reqStub = { user: { id: randomUUID(), email: "super@exemplo.test" }, headers: {}, socket: {}, header: () => null };

describe("PERFIL DE EXIBIÇÃO — cadeia real (Postgres + migrations 112/113 reais)", { skip: motivoPular, timeout: 600_000 }, () => {
  before(async () => {
    banco = criarBancoDescartavel("perfil_exib_cadeia");
    sql(banco.url, SCHEMA_BASE);
    // As migrations REAIS, na ordem. A 112 não tem begin/commit (ALTER TYPE ... ADD VALUE); a 113 usa o valor depois.
    sql(banco.url, "", { arquivo: join(MIG, "112_papel_operador_exibicao.sql") });
    sql(banco.url, "", { arquivo: join(MIG, "113_papel_exibicao_somente_unidade.sql") });
    sql(banco.url, `
      insert into organizacoes (id, nome) values ('${ORG_A}', 'Empresa A'), ('${ORG_B}', 'Empresa B');
      insert into unidades (id, organizacao_id, nome) values ('${UNI_A1}', '${ORG_A}', 'Unidade A1'), ('${UNI_A2}', '${ORG_A}', 'Unidade A2'), ('${UNI_B1}', '${ORG_B}', 'Unidade B1');
      insert into organizacao_modulos select o, m from unnest(array['${ORG_A}'::uuid, '${ORG_B}'::uuid]) o, unnest(array[${MODULOS_TODOS.map(lit).join(",")}]) m;
      insert into unidade_modulos select u, m from unnest(array['${UNI_A1}'::uuid, '${UNI_A2}'::uuid, '${UNI_B1}'::uuid]) u, unnest(array[${MODULOS_TODOS.map(lit).join(",")}]) m;
      insert into ifood_pedidos (order_id, organizacao_id, unidade_id, display_id, status_oficial, status_oficial_em, order_type, delivery_by, order_created_at, placed_event_created_at, criado_em) values
        ('p-a1-1', '${ORG_A}', '${UNI_A1}', '1111', 'CONFIRMED', now(), 'DELIVERY', 'IFOOD', now(), now(), now()),
        ('p-a1-2', '${ORG_A}', '${UNI_A1}', '1112', 'CONFIRMED', now(), 'DELIVERY', 'IFOOD', now(), now(), now()),
        ('p-a2-1', '${ORG_A}', '${UNI_A2}', '2221', 'CONFIRMED', now(), 'DELIVERY', 'IFOOD', now(), now(), now()),
        ('p-b1-1', '${ORG_B}', '${UNI_B1}', '9991', 'CONFIRMED', now(), 'DELIVERY', 'IFOOD', now(), now(), now());`);

    falso = await iniciarSupabaseFalso({ pgUrl: banco.url, usuarios: USUARIOS });
    process.env.SUPABASE_URL = falso.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "chave-service-role-de-teste-".padEnd(48, "z");
    process.env.SUPABASE_ANON_KEY = "chave-anon-de-teste-".padEnd(48, "a");
    process.env.CONTEXT_TOKEN_SECRET = "segredo-do-token-de-contexto-de-teste-".padEnd(64, "k");
    process.env.RATE_LIMIT_API_MAX = "1000000"; process.env.RATE_LIMIT_CONTEXTO_MAX = "1000000";
    process.env.RATE_LIMIT_PLATAFORMA_MAX = "1000000"; process.env.RATE_LIMIT_ADMINISTRATIVO_MAX = "1000000";
    process.env.NODE_ENV = "test";
    const { createApp } = await import("../src/app.js");
    svc = {
      plataforma: await import("../src/modules/plataforma/plataforma.usuarios.service.js"),
      sessao: await import("../src/modules/sessao/sessao.service.js"),
      tenantUsuarios: await import("../src/modules/usuarios/usuarios.service.js"),
      rotas: await import("./helpers/rotas-tenant.js"),
    };
    const app = createApp();
    servidor = await new Promise((r) => { const s = http.createServer(app).listen(0, "127.0.0.1", () => r(s)); });
    servidor.unref();
    BASE = `http://127.0.0.1:${servidor.address().port}`;
  });
  after(async () => {
    if (servidor) await new Promise((r) => servidor.close(r));
    await falso?.parar();
    banco?.derrubar();
  });

  describe("migrations reais", () => {
    test("o valor existe no enum e o papel é gravável em unidade; em empresa a constraint 113 recusa", () => {
      assert.equal(sql(banco.url, "select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'papel_acesso' and e.enumlabel = 'display_operator'"), "1");
      const c = conta("mig-ok");
      assert.doesNotThrow(() => vincularUnidade(c, UNI_A1, "display_operator"));
      assert.throws(() => vincularEmpresa(c, ORG_A, "display_operator"), /uo_sem_papel_exibicao|violates check/);
    });
  });

  describe("seleção de contexto: só a unidade vinculada", () => {
    test("os acessos oferecidos são EXATAMENTE a unidade vinculada, sem consolidado e sem outras unidades", async () => {
      const c = contaExibicao("acessos");
      const r = await api(c, "GET", "/sessao/acessos");
      assert.equal(r.status, 200, r.texto);
      const opcoes = r.json.data.opcoes;
      assert.equal(opcoes.length, 1);
      assert.equal(opcoes[0].unidadeId, UNI_A1);
      assert.equal(opcoes[0].papel, "display_operator");
      assert.ok(!opcoes.some((o) => o.unidadeId == null), "sem opção consolidada");
      assert.equal(r.json.data.superadmin, false);
      assert.equal(r.json.data.painelAdministrativo, false);
    });

    test("contexto da unidade vinculada: permissões = só checklist.visualizar", async () => {
      const c = contaExibicao("ctx-ok");
      const { dados } = await entrar(c);
      assert.equal(dados.papel, "display_operator");
      assert.deepEqual(dados.permissoes, ["checklist.visualizar"]);
      assert.equal(dados.unidade.id, UNI_A1);
    });

    test("consolidado, outra unidade da MESMA empresa e outra empresa: 403, com a MESMA mensagem (não revela o que existe)", async () => {
      const c = contaExibicao("negados");
      const respostas = [];
      for (const corpo of [{ organizacaoId: ORG_A, unidadeId: null }, { organizacaoId: ORG_A, unidadeId: UNI_A2 }, { organizacaoId: ORG_B, unidadeId: UNI_B1 }, { organizacaoId: ORG_B, unidadeId: null }]) {
        const r = await api(c, "POST", "/sessao/selecionar", { corpo });
        assert.equal(r.status, 403, JSON.stringify(corpo));
        respostas.push(r.json.error ?? r.json.message ?? r.texto);
      }
      assert.equal(new Set(respostas).size, 1, `mensagens diferentes: ${JSON.stringify(respostas)}`);
    });

    test("papel de exibição gravado como vínculo de EMPRESA (dado fora do padrão, sem a constraint): recusado em qualquer contexto", async () => {
      sql(banco.url, "alter table usuarios_organizacoes drop constraint uo_sem_papel_exibicao");
      try {
        const c = conta("org-ruim");
        sql(banco.url, `insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values ('${c.id}', '${c.id}', '${ORG_A}', 'display_operator')`);
        for (const unidadeId of [null, UNI_A1, UNI_A2]) {
          const r = await api(c, "POST", "/sessao/selecionar", { corpo: { organizacaoId: ORG_A, unidadeId } });
          assert.equal(r.status, 403, `unidade ${unidadeId}: ${r.texto}`);
        }
      } finally {
        sql(banco.url, "delete from usuarios_organizacoes where papel::text = 'display_operator'");
        sql(banco.url, "alter table usuarios_organizacoes add constraint uo_sem_papel_exibicao check (papel <> 'display_operator'::papel_acesso)");
      }
    });

    test("trocar-unidade: só para a própria unidade; consolidado e outra unidade dão 403", async () => {
      const c = contaExibicao("troca");
      const { ctx } = await entrar(c);
      assert.equal((await api(c, "POST", "/sessao/trocar-unidade", { ctx, corpo: { unidadeId: UNI_A2 } })).status, 403);
      assert.equal((await api(c, "POST", "/sessao/trocar-unidade", { ctx, corpo: { unidadeId: null } })).status, 403);
      const certa = await api(c, "POST", "/sessao/trocar-unidade", { ctx, corpo: { unidadeId: UNI_A1 } });
      assert.equal(certa.status, 201, certa.texto);
    });
  });

  describe("o que o perfil CONSEGUE: o Checklist da própria unidade", () => {
    test("GET /checklist-operacional/resumo: 200, só pedidos da unidade do contexto", async () => {
      const c = contaExibicao("resumo");
      const { ctx } = await entrar(c);
      const r = await api(c, "GET", "/checklist-operacional/resumo", { ctx });
      assert.equal(r.status, 200, r.texto);
      assert.equal(r.json.data.contagemDia.recebidos, 2, "só os 2 pedidos de A1");
      assert.doesNotMatch(r.texto, /2221|9991/, "nada de A2 nem de B1");
    });

    test("adulterar empresa/unidade por query, cabeçalho ou corpo NÃO muda a unidade (vem do contexto assinado)", async () => {
      const c = contaExibicao("adultera");
      const { ctx } = await entrar(c);
      const r = await api(c, "GET", `/checklist-operacional/resumo?unidadeId=${UNI_A2}&organizacaoId=${ORG_B}&unidade_id=${UNI_B1}`, {
        ctx, headers: { "x-unidade-id": UNI_A2, "x-organizacao-id": ORG_B, "x-tenant": UNI_B1 } });
      assert.equal(r.status, 200, r.texto);
      assert.equal(r.json.data.contagemDia.recebidos, 2);
      assert.doesNotMatch(r.texto, /2221|9991/);
    });

    test("Context Token de OUTRA conta não vale (409), e um token adulterado também", async () => {
      const dona = contaExibicao("dona"); const outra = contaExibicao("outra", UNI_A2);
      const { ctx } = await entrar(dona);
      assert.equal((await api(outra, "GET", "/checklist-operacional/resumo", { ctx })).status, 409);
      assert.equal((await api(dona, "GET", "/checklist-operacional/resumo", { ctx: ctx.slice(0, -3) + "abc" })).status, 409);
      assert.equal((await api(dona, "GET", "/checklist-operacional/resumo")).status, 409, "sem token de contexto");
    });

    test("conta de exibição de OUTRA empresa só enxerga a dela", async () => {
      const c = contaExibicao("empresa-b", UNI_B1);
      const { ctx } = await entrar(c, ORG_B, UNI_B1);
      const r = await api(c, "GET", "/checklist-operacional/resumo", { ctx });
      assert.equal(r.status, 200);
      assert.equal(r.json.data.contagemDia.recebidos, 1);
      assert.doesNotMatch(r.texto, /1111|1112|2221/);
    });
  });

  describe("rotas de sessão (fora do bloqueio do tenant) não vazam outras unidades", () => {
    test("/sessao/unidades lista SÓ a unidade vinculada (mesmo existindo outras na mesma empresa) e /sessao/atual só mostra o próprio perfil", async () => {
      const c = contaExibicao("seletor");
      const { ctx } = await entrar(c);
      const u = await api(c, "GET", "/sessao/unidades", { ctx });
      assert.equal(u.status, 200, u.texto);
      assert.deepEqual(u.json.data.unidades.map((x) => x.id), [UNI_A1]);
      assert.doesNotMatch(u.texto, /Unidade A2|Unidade B1|Empresa B/);
      const a = await api(c, "GET", "/sessao/atual", { ctx });
      assert.equal(a.status, 200);
      assert.deepEqual([a.json.data.papel, a.json.data.permissoes, a.json.data.unidadeId], ["display_operator", ["checklist.visualizar"], UNI_A1]);
      // e os acessos oferecidos continuam sendo só o dela, também por perfilId na query
      const acessos = await api(c, "GET", `/sessao/acessos?perfilId=${c.id}`);
      assert.deepEqual(acessos.json.data.opcoes.map((o) => o.unidadeId), [UNI_A1]);
    });
  });

  describe("o que o perfil NÃO consegue", () => {
    test("TODAS as rotas do tenant (menos as 2 permitidas) dão 403 pela cadeia real", async () => {
      const c = contaExibicao("tudo-negado");
      const { ctx } = await entrar(c);
      const permitidas = new Set(["GET /checklist-operacional/resumo", "POST /realtime/credencial"]);
      const rotas = svc.rotas.todasAsRotasDoTenant().filter((r) => !permitidas.has(`${r.metodo} ${r.modelo}`));
      assert.ok(rotas.length >= 100);
      const falhas = [];
      for (let i = 0; i < rotas.length; i += 8) {
        await Promise.all(rotas.slice(i, i + 8).map(async (r) => {
          const res = await api(c, r.metodo, r.caminho, { ctx, corpo: ["POST", "PUT", "PATCH"].includes(r.metodo) ? {} : undefined });
          if (res.status !== 403) falhas.push(`${res.status} ${r.metodo} ${r.modelo}`);
        }));
      }
      assert.deepEqual(falhas, [], "rota alcançável pelo perfil de exibição");
    });

    test("Painel SuperAdmin, Painel Administrativo e o legado /contexto: 403", async () => {
      const c = contaExibicao("paineis");
      const { ctx } = await entrar(c);
      for (const [m, p, corpo] of [["GET", "/plataforma/usuarios"], ["GET", "/plataforma/empresas"], ["POST", "/plataforma/usuarios", {}],
        ["GET", "/administrativo/qualquer"], ["GET", "/administrativo/performance/x"],
        ["POST", "/contexto/acessar", { organizacaoId: ORG_B }], ["GET", "/contexto/acessos"]]) {
        const r = await api(c, m, p, { ctx, corpo });
        assert.equal(r.status, 403, `${m} ${p}: ${r.texto}`);
      }
    });

    test("não vira superadmin nem painel: /me reflete a identidade, sem privilégio", async () => {
      const c = contaExibicao("me");
      const r = await api(c, "GET", "/me");
      assert.equal(r.status, 200);
      assert.equal(r.json.data.superadmin, false);
      assert.equal(r.json.data.painelAdministrativo, false);
    });
  });

  describe("Realtime: só o canal da unidade", () => {
    test("exibição recebe SÓ unidade:<id>; gestor recebe empresa + unidade (outros papéis intactos)", async () => {
      const tv = contaExibicao("rt-tv"); const gestor = conta("rt-gestor"); vincularEmpresa(gestor, ORG_A, "unit_manager");
      const a = await entrar(tv); const b = await entrar(gestor, ORG_A, UNI_A1);
      const rTv = await api(tv, "POST", "/realtime/credencial", { ctx: a.ctx });
      assert.equal(rTv.status, 200, rTv.texto);
      assert.deepEqual(rTv.json.data.topicos, [`unidade:${UNI_A1}`]);
      assert.equal(sql(banco.url, `select string_agg(topico, ',' order by topico) from realtime_channel_grants where sessao_contexto_id = '${a.sid}'`), `unidade:${UNI_A1}`);
      const rG = await api(gestor, "POST", "/realtime/credencial", { ctx: b.ctx });
      assert.deepEqual([...rG.json.data.topicos].sort(), [`empresa:${ORG_A}`, `unidade:${UNI_A1}`].sort());
    });
  });

  describe("sessão: expiração, revogação, desativação, bloqueio e mudança de permissão", () => {
    test("sessão expirada: 409 (contexto inválido) e NENHUM dado; reautenticar (nova seleção) devolve o acesso", async () => {
      const c = contaExibicao("expira");
      const { ctx, sid } = await entrar(c);
      assert.equal((await api(c, "GET", "/checklist-operacional/resumo", { ctx })).status, 200);
      sql(banco.url, `update sessoes_contexto set expira_em = now() - interval '1 minute' where id = '${sid}'`);
      const r = await api(c, "GET", "/checklist-operacional/resumo", { ctx });
      assert.equal(r.status, 409);
      assert.equal(r.json.details?.contexto, "invalido");
      assert.doesNotMatch(r.texto, /1111|1112|recebidos/);
      const nova = await entrar(c);                                           // reautenticação válida
      assert.equal((await api(c, "GET", "/checklist-operacional/resumo", { ctx: nova.ctx })).status, 200);
      assert.equal((await api(c, "GET", "/checklist-operacional/resumo", { ctx })).status, 409, "o token velho continua inválido");
    });

    test("sair (encerrar) revoga a sessão: a chamada seguinte é 409", async () => {
      const c = contaExibicao("encerra");
      const { ctx } = await entrar(c);
      assert.equal((await api(c, "POST", "/sessao/encerrar", { ctx, corpo: {} })).status, 200);
      assert.equal((await api(c, "GET", "/checklist-operacional/resumo", { ctx })).status, 409);
    });

    test("revogação administrativa (revogarSessoes): corta a sessão aberta na hora, sem dado", async () => {
      const c = contaExibicao("revoga");
      const { ctx } = await entrar(c);
      assert.equal((await api(c, "GET", "/checklist-operacional/resumo", { ctx })).status, 200);
      const n = await svc.sessao.revogarSessoes({ perfilId: c.id, motivo: "teste_revogacao" });
      assert.ok(n >= 1);
      const r = await api(c, "GET", "/checklist-operacional/resumo", { ctx });
      assert.equal(r.status, 409);
      assert.doesNotMatch(r.texto, /recebidos|1111/);
    });

    test("usuário DESATIVADO: 403 em tudo, inclusive no Checklist e em nova seleção", async () => {
      const c = contaExibicao("inativo");
      const { ctx } = await entrar(c);
      sql(banco.url, `update perfis set ativo = false where id = '${c.id}'`);
      assert.equal((await api(c, "GET", "/checklist-operacional/resumo", { ctx })).status, 403);
      assert.equal((await api(c, "POST", "/sessao/selecionar", { corpo: { organizacaoId: ORG_A, unidadeId: UNI_A1 } })).status, 403);
    });

    test("empresa BLOQUEADA: 403 na sessão aberta e em nova seleção", async () => {
      const c = contaExibicao("bloqueada", UNI_B1);
      const { ctx } = await entrar(c, ORG_B, UNI_B1);
      assert.equal((await api(c, "GET", "/checklist-operacional/resumo", { ctx })).status, 200);
      sql(banco.url, `update organizacoes set status = 'bloqueada' where id = '${ORG_B}'`);
      try {
        const r = await api(c, "GET", "/checklist-operacional/resumo", { ctx });
        assert.equal(r.status, 403); assert.doesNotMatch(r.texto, /recebidos|9991/);
        assert.equal((await api(c, "POST", "/sessao/selecionar", { corpo: { organizacaoId: ORG_B, unidadeId: UNI_B1 } })).status, 403);
      } finally { sql(banco.url, `update organizacoes set status = 'ativa' where id = '${ORG_B}'`); }
    });

    test("unidade DESATIVADA: nova seleção é negada", async () => {
      const c = contaExibicao("uni-inativa", UNI_A2);
      assert.equal((await entrar(c, ORG_A, UNI_A2)).dados.unidade.id, UNI_A2);
      sql(banco.url, `update unidades set ativo = false where id = '${UNI_A2}'`);
      try {
        assert.equal((await api(c, "POST", "/sessao/selecionar", { corpo: { organizacaoId: ORG_A, unidadeId: UNI_A2 } })).status, 403);
      } finally { sql(banco.url, `update unidades set ativo = true where id = '${UNI_A2}'`); }
    });

    test("vínculo BLOQUEADO (ativo=false): nova seleção negada", async () => {
      const c = contaExibicao("vinculo-off");
      sql(banco.url, `update usuarios_unidades set ativo = false where usuario_id = '${c.id}'`);
      assert.equal((await api(c, "POST", "/sessao/selecionar", { corpo: { organizacaoId: ORG_A, unidadeId: UNI_A1 } })).status, 403);
    });

    test("MUDANÇA de permissões: trocar o papel do vínculo revoga a sessão antiga; a nova reflete o papel novo", async () => {
      const c = contaExibicao("muda-papel");
      const { ctx } = await entrar(c);
      const r = await svc.plataforma.atualizarVinculoUnidade(reqStub, c.id, UNI_A1, { papel: "viewer" });
      assert.ok(r.sessoesRevogadas >= 1, "a sessão do perfil naquela unidade foi revogada");
      assert.equal((await api(c, "GET", "/checklist-operacional/resumo", { ctx })).status, 409);
      const nova = await entrar(c);
      assert.equal(nova.dados.papel, "viewer");
      assert.ok(nova.dados.permissoes.includes("integracoes.ver"));
    });
  });

  describe("provisionamento pelo painel: conta de exibição é EXCLUSIVA", () => {
    const rejeita = async (fn, status = 409) => {
      await assert.rejects(fn, (e) => { assert.equal(e.statusCode, status, e.message); return true; });
    };

    test("criar o vínculo de exibição numa conta SEM vínculo de empresa funciona (único caso de unidade sem empresa)", async () => {
      const c = conta("prov-ok");
      const r = await svc.plataforma.associarUnidade(reqStub, c.id, { unidadeId: UNI_A1, papel: "display_operator" });
      assert.equal(r.papel, "display_operator");
      assert.equal(sql(banco.url, `select papel from usuarios_unidades where usuario_id = '${c.id}'`), "display_operator");
      assert.equal((await entrar(c)).dados.papel, "display_operator");
    });

    test("conta COM vínculo de empresa não pode receber o papel de exibição (nem por associarUnidade, nem por atualizarVinculoUnidade)", async () => {
      const gestor = conta("prov-gestor"); vincularEmpresa(gestor, ORG_A, "unit_manager");
      await rejeita(() => svc.plataforma.associarUnidade(reqStub, gestor.id, { unidadeId: UNI_A1, papel: "display_operator" }));
      vincularUnidade(gestor, UNI_A1, "viewer");
      await rejeita(() => svc.plataforma.atualizarVinculoUnidade(reqStub, gestor.id, UNI_A1, { papel: "display_operator" }));
      assert.equal(sql(banco.url, `select papel from usuarios_unidades where usuario_id = '${gestor.id}'`), "viewer", "nada mudou");
    });

    test("conta de exibição não ganha vínculo de empresa (associarEmpresa), e o papel não existe como cargo de empresa", async () => {
      const tv = contaExibicao("prov-tv");
      await rejeita(() => svc.plataforma.associarEmpresa(reqStub, tv.id, { organizacaoId: ORG_A, papel: "viewer" }));
      await rejeita(() => svc.plataforma.associarEmpresa(reqStub, conta("prov-x").id, { organizacaoId: ORG_A, papel: "display_operator" }), 400);
      await rejeita(() => svc.plataforma.associarEmpresasLote(reqStub, tv.id, { itens: [{ organizacaoId: ORG_A, papel: "viewer" }] }));
      assert.equal(sql(banco.url, `select count(*) from usuarios_organizacoes where usuario_id = '${tv.id}'`), "0");
    });

    test("conta de exibição não mistura com outro papel em outra unidade", async () => {
      const tv = contaExibicao("prov-mix");
      await rejeita(() => svc.plataforma.associarUnidade(reqStub, tv.id, { unidadeId: UNI_A2, papel: "viewer" }), 400); // sem empresa: exige empresa
      const solta = conta("prov-solta"); vincularUnidade(solta, UNI_A1, "viewer");               // unidade-só, outro papel
      await rejeita(() => svc.plataforma.associarUnidade(reqStub, solta.id, { unidadeId: UNI_A2, papel: "display_operator" }));
    });

    test("a lista de cargos de EMPRESA não oferece o de exibição; a de UNIDADE oferece, marcado como só-unidade", () => {
      assert.ok(!svc.plataforma.detalharPapeis().some((p) => p.valor === "display_operator"));
      const u = svc.plataforma.detalharPapeisUnidade().find((p) => p.valor === "display_operator");
      assert.ok(u && u.somenteUnidade === true);
      assert.deepEqual(u.permissoes, ["checklist.visualizar"]);
      assert.ok(!svc.tenantUsuarios.papeisDisponiveis().some((p) => p.valor === "display_operator"), "o admin da empresa também não oferece");
    });
  });

  describe("os demais papéis não regrediram", () => {
    test("gestor de empresa: seleciona consolidado e unidade, tem as permissões de antes e abre o Checklist", async () => {
      const g = conta("regride-gestor"); vincularEmpresa(g, ORG_A, "unit_manager");
      const consolidado = await api(g, "POST", "/sessao/selecionar", { corpo: { organizacaoId: ORG_A, unidadeId: null } });
      assert.equal(consolidado.status, 201, consolidado.texto);
      const { ctx, dados } = await entrar(g, ORG_A, UNI_A1);
      assert.equal(dados.papel, "unit_manager");
      assert.ok(dados.permissoes.includes("vendas.importar") && dados.permissoes.includes("checklist.visualizar") && dados.permissoes.includes("integracoes.ver"));
      assert.equal((await api(g, "GET", "/checklist-operacional/resumo", { ctx })).status, 200);
      // rota fora do Checklist NÃO é bloqueada pelo perfil de exibição (alcança o handler: nunca 403 do bloqueio)
      assert.notEqual((await api(g, "GET", "/usuarios/papeis", { ctx })).status, 403);
    });

    test("viewer e administrador: continuam entrando e abrindo o Checklist", async () => {
      for (const papel of ["viewer", "organization_admin", "finance", "operations"]) {
        const c = conta(`regride-${papel}`); vincularEmpresa(c, ORG_A, papel);
        const { ctx } = await entrar(c, ORG_A, UNI_A1);
        assert.equal((await api(c, "GET", "/checklist-operacional/resumo", { ctx })).status, 200, papel);
      }
    });

    test("sessão ANTIGA (permissões congeladas SEM checklist.visualizar) continua abrindo o Checklist pela integracoes.ver", async () => {
      const g = conta("regride-antiga"); vincularEmpresa(g, ORG_A, "viewer");
      const { ctx, sid } = await entrar(g, ORG_A, UNI_A1);
      sql(banco.url, `update sessoes_contexto set permissoes = permissoes - 'checklist.visualizar' where id = '${sid}'`);
      assert.equal((await api(g, "GET", "/checklist-operacional/resumo", { ctx })).status, 200);
      sql(banco.url, `update sessoes_contexto set permissoes = '[]'::jsonb where id = '${sid}'`);
      assert.equal((await api(g, "GET", "/checklist-operacional/resumo", { ctx })).status, 403, "sem nenhuma das duas permissões: 403");
    });
  });

  test("auditoria da seleção de contexto registra o papel de exibição", () => {
    const n = sql(banco.url, "select count(*) from plataforma_auditoria where detalhes->>'papel' = 'display_operator'");
    assert.ok(Number(n) >= 1);
  });
});
