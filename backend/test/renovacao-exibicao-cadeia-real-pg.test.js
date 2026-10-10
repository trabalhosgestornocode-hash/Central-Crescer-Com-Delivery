// RENOVAÇÃO AUTOMÁTICA do contexto do perfil de exibição — CADEIA REAL (createApp + requireAuth + seleção de contexto +
// requireContexto + renovação) contra um Postgres LOCAL descartável e um "Supabase" local que fala o protocolo.
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55420/postgres node --test test/renovacao-exibicao-cadeia-real-pg.test.js
//
// O tempo é SIMULADO sem esperar: cada "passo" recua no banco os prazos das sessões (expira_em/criada_em) e emite um JWT
// cujo carimbo de autenticação (amr[].timestamp) também recua. O servidor continua usando o relógio REAL: nada aqui
// confia em relógio do navegador. PULA sem a variável e RECUSA host que não seja local.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { motivoPular, criarBancoDescartavel, sql } from "./helpers/pg-descartavel.js";
import { iniciarSupabaseFalso } from "./helpers/supabase-falso-pg.js";
import { SCHEMA_BASE } from "./helpers/schema-perfil-exibicao.js";

const MIG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "database", "migrations");
const ORG_A = "a0000000-0000-4000-8000-00000000000a";
const ORG_B = "b0000000-0000-4000-8000-00000000000b";
const UNI_A1 = "a1000000-0000-4000-8000-0000000000a1";
const UNI_A2 = "a2000000-0000-4000-8000-0000000000a2";
const UNI_B1 = "b1000000-0000-4000-8000-0000000000b1";
const MODULOS = ["dashboard", "products_cmv", "ingredients", "sales", "ifood", "ifood_dashboard", "monthly_bonus", "parser_food_delivery", "inteligencia", "agente_ia"];
const H = 3_600_000; const MIN = 60_000;

const USUARIOS = new Map();
let banco; let falso; let servidor; let BASE; let svc;
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const iso = (ms) => new Date(ms).toISOString();

// ---- dados ------------------------------------------------------------------------------------------------------
function conta(rotulo) {
  const id = randomUUID();
  sql(banco.url, `insert into perfis (id, nome, email) values ('${id}', ${lit(rotulo)}, ${lit(`${rotulo}-${id.slice(0, 6)}@exemplo.test`)});
    insert into perfis_operacionais (id, conta_id, nome) values ('${id}', '${id}', ${lit(rotulo)});`);
  return { id, rotulo, email: `${rotulo}-${id.slice(0, 6)}@exemplo.test`, jwt: null };
}
const vincularUnidade = (c, uni, papel) => sql(banco.url, `insert into usuarios_unidades (usuario_id, perfil_id, unidade_id, papel) values ('${c.id}', '${c.id}', '${uni}', ${papel ? lit(papel) : "null"})`);
const vincularEmpresa = (c, org, papel) => sql(banco.url, `insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values ('${c.id}', '${c.id}', '${org}', '${papel}')`);
const contaTv = (rotulo, uni = UNI_A1) => { const c = conta(rotulo); vincularUnidade(c, uni, "display_operator"); return c; };

/** JWT de teste com as claims que o Supabase poria: `amr[].timestamp` (carimbo da autenticação) e `aal`. */
function emitirJwt(c, { autenticadoHa = 0, aal = "aal1", semAmr = false } = {}) {
  const agoraS = Math.floor(Date.now() / 1000);
  const payload = { sub: c.id, aal, ...(semAmr ? {} : { amr: [{ method: "password", timestamp: agoraS - Math.floor(autenticadoHa / 1000) }] }), jti: randomUUID() };
  const jwt = `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
  USUARIOS.set(jwt, { id: c.id, email: c.email });
  return jwt;
}

async function api(jwt, metodo, caminho, { ctx, corpo } = {}) {
  const r = await fetch(`${BASE}/api/v1${caminho}`, {
    method: metodo,
    headers: { authorization: `Bearer ${jwt}`, ...(ctx ? { "x-context-token": ctx } : {}), ...(corpo !== undefined ? { "content-type": "application/json" } : {}) },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const texto = await r.text(); let json = null; try { json = JSON.parse(texto); } catch { /* vazio */ }
  return { status: r.status, json, texto };
}
async function entrar(jwt, org = ORG_A, uni = UNI_A1) {
  const r = await api(jwt, "POST", "/sessao/selecionar", { corpo: { organizacaoId: org, unidadeId: uni } });
  assert.equal(r.status, 201, r.texto);
  return { ctx: r.json.data.contextToken, sid: r.json.data.sessionId, dados: r.json.data };
}
const linha = (sid) => JSON.parse(sql(banco.url, `select coalesce(row_to_json(t), '{}') from (select id, expira_em, revogada_em, motivo_revogacao, papel, perfil_id, unidade_id, organizacao_id, permissoes, modulos from sessoes_contexto where id = '${sid}') t`));
const vivas = (contaId) => Number(sql(banco.url, `select count(*) from sessoes_contexto where usuario_id = '${contaId}' and revogada_em is null and expira_em > now()`));
/** Recua `ms` no banco: todas as sessões da conta "envelhecem" ms (o servidor segue no relógio real). */
const envelhecer = (contaId, ms) => sql(banco.url, `update sessoes_contexto set expira_em = expira_em - interval '${Math.round(ms)} milliseconds', criada_em = criada_em - interval '${Math.round(ms)} milliseconds' where usuario_id = '${contaId}'`);
const auditoria = (acao, contaId) => JSON.parse(sql(banco.url, `select coalesce(json_agg(a order by created_at), '[]') from (select acao, detalhes, ator_id, created_at from plataforma_auditoria where acao = ${lit(acao)} and ator_id = '${contaId}') a`));

describe("RENOVAÇÃO AUTOMÁTICA do perfil de exibição — cadeia real", { skip: motivoPular, timeout: 900_000 }, () => {
  before(async () => {
    banco = criarBancoDescartavel("renov_exib");
    sql(banco.url, SCHEMA_BASE);
    sql(banco.url, "", { arquivo: join(MIG, "112_papel_operador_exibicao.sql") });
    sql(banco.url, "", { arquivo: join(MIG, "113_papel_exibicao_somente_unidade.sql") });
    sql(banco.url, `
      insert into organizacoes (id, nome) values ('${ORG_A}', 'Empresa A'), ('${ORG_B}', 'Empresa B');
      insert into unidades (id, organizacao_id, nome) values ('${UNI_A1}', '${ORG_A}', 'Unidade A1'), ('${UNI_A2}', '${ORG_A}', 'Unidade A2'), ('${UNI_B1}', '${ORG_B}', 'Unidade B1');
      insert into organizacao_modulos select o, m from unnest(array['${ORG_A}'::uuid, '${ORG_B}'::uuid]) o, unnest(array[${MODULOS.map(lit).join(",")}]) m;
      insert into unidade_modulos select u, m from unnest(array['${UNI_A1}'::uuid, '${UNI_A2}'::uuid, '${UNI_B1}'::uuid]) u, unnest(array[${MODULOS.map(lit).join(",")}]) m;
      insert into ifood_pedidos (order_id, organizacao_id, unidade_id, display_id, status_oficial, status_oficial_em, order_type, delivery_by, order_created_at, placed_event_created_at, criado_em)
        values ('p1', '${ORG_A}', '${UNI_A1}', '1111', 'CONFIRMED', now(), 'DELIVERY', 'IFOOD', now(), now(), now());`);
    falso = await iniciarSupabaseFalso({ pgUrl: banco.url, usuarios: USUARIOS });
    Object.assign(process.env, {
      SUPABASE_URL: falso.url, SUPABASE_SERVICE_ROLE_KEY: "chave-service-role-de-teste-".padEnd(48, "z"), SUPABASE_ANON_KEY: "chave-anon-de-teste-".padEnd(48, "a"),
      CONTEXT_TOKEN_SECRET: "segredo-do-token-de-contexto-de-teste-".padEnd(64, "k"), NODE_ENV: "test",
      RATE_LIMIT_API_MAX: "1000000", RATE_LIMIT_CONTEXTO_MAX: "1000000", RATE_LIMIT_RENOVAR_MAX: "1000000",
    });
    const { createApp } = await import("../src/app.js");
    svc = {
      renov: await import("../src/modules/sessao/sessao.renovacao.service.js"),
      sessao: await import("../src/modules/sessao/sessao.service.js"),
      plataforma: await import("../src/modules/plataforma/plataforma.usuarios.service.js"),
    };
    servidor = await new Promise((r) => { const s = http.createServer(createApp()).listen(0, "127.0.0.1", () => r(s)); });
    servidor.unref();
    BASE = `http://127.0.0.1:${servidor.address().port}`;
  });
  after(async () => { if (servidor) await new Promise((r) => servidor.close(r)); await falso?.parar(); banco?.derrubar(); });

  describe("renovação: feliz, cedo e idempotente", () => {
    test("CEDO (contexto recém-criado): 200 'renovado:false' e NADA muda no banco", async () => {
      const c = contaTv("cedo"); const jwt = emitirJwt(c);
      const { ctx, sid } = await entrar(jwt);
      const antes = linha(sid);
      const r = await api(jwt, "POST", "/sessao/renovar", { ctx });
      assert.equal(r.status, 200, r.texto);
      assert.equal(r.json.data.renovado, false);
      assert.deepEqual(linha(sid), antes, "o contexto não foi tocado");
      assert.equal(vivas(c.id), 1);
      assert.ok(r.json.data.servidorEm && r.json.data.limiteAbsolutoEm, "devolve o relógio do servidor e o limite");
    });

    test("RENOVA dentro da janela: contexto NOVO com a mesma identidade e as mesmas permissões; antigo vira 'renovada' e fica só 90 s", async () => {
      const c = contaTv("renova"); const jwt = emitirJwt(c, { autenticadoHa: 7 * H });
      const { ctx, sid, dados } = await entrar(jwt);
      envelhecer(c.id, 7 * H + 5 * MIN);                       // faltam ~55 min: dentro da janela de 2 h
      const r = await api(jwt, "POST", "/sessao/renovar", { ctx });
      assert.equal(r.status, 201, r.texto);
      const n = r.json.data;
      assert.equal(n.renovado, true);
      assert.notEqual(n.contextToken, ctx); assert.notEqual(n.sessionId, sid);
      assert.deepEqual([n.empresa.id, n.unidade.id, n.perfil.id, n.papel], [dados.empresa.id, dados.unidade.id, dados.perfil.id, "display_operator"]);
      assert.deepEqual(n.permissoes, ["checklist.visualizar"]);
      // o novo funciona; o antigo ainda responde durante a graça (polling em voo não leva 409) e tem prazo curto e marca
      assert.equal((await api(jwt, "GET", "/checklist-operacional/resumo", { ctx: n.contextToken })).status, 200);
      assert.equal((await api(jwt, "GET", "/checklist-operacional/resumo", { ctx })).status, 200, "graça: requisição em voo com o token antigo");
      const antiga = linha(sid);
      assert.equal(antiga.motivo_revogacao, "renovada");
      assert.ok(Date.parse(antiga.expira_em) - Date.now() <= 91_000, "graça de ~90 s");
      assert.equal(vivas(c.id), 2, "durante a graça há exatamente 2 (a antiga e a nova)");
      // depois da graça a antiga morre sozinha
      envelhecer(c.id, 2 * MIN);
      assert.equal((await api(jwt, "GET", "/checklist-operacional/resumo", { ctx })).status, 409);
      assert.equal((await api(jwt, "GET", "/checklist-operacional/resumo", { ctx: n.contextToken })).status, 200);
    });

    test("o contexto ANTIGO não pode ser renovado de novo (reutilização): 409 e nenhuma sessão extra", async () => {
      const c = contaTv("reuso"); const jwt = emitirJwt(c, { autenticadoHa: 7 * H });
      const { ctx } = await entrar(jwt);
      envelhecer(c.id, 7 * H + 10 * MIN);
      assert.equal((await api(jwt, "POST", "/sessao/renovar", { ctx })).status, 201);
      const vivasDepois = vivas(c.id);
      const de_novo = await api(jwt, "POST", "/sessao/renovar", { ctx });
      assert.equal(de_novo.status, 409, de_novo.texto);
      assert.equal(de_novo.json.details.codigo, "RENOVACAO_CONCORRENTE");
      assert.equal(vivas(c.id), vivasDepois, "a repetição não criou sessão");
    });

    test("o corpo é IGNORADO: empresa, unidade, papel e permissões enviados não mudam NADA (sem ampliação de permissões)", async () => {
      const c = contaTv("corpo"); const jwt = emitirJwt(c, { autenticadoHa: 7 * H });
      const { ctx } = await entrar(jwt);
      envelhecer(c.id, 7 * H + 10 * MIN);
      const r = await api(jwt, "POST", "/sessao/renovar", { ctx, corpo: { papel: "organization_admin", organizacaoId: ORG_B, unidadeId: UNI_B1, perfilId: randomUUID(), permissoes: ["vendas.ver", "financeiro.ver"], validadeS: 999999 } });
      assert.equal(r.status, 201, r.texto);
      assert.deepEqual([r.json.data.papel, r.json.data.unidade.id, r.json.data.empresa.id, r.json.data.permissoes], ["display_operator", UNI_A1, ORG_A, ["checklist.visualizar"]]);
      assert.ok(Date.parse(r.json.data.expiraEm) - Date.now() <= 8 * H + 5000, "validade não ampliada pelo cliente");
    });
  });

  describe("jornada de 17 h: o Checklist atravessa o expediente sem interação", () => {
    test("17 h simuladas, passo de 30 min, polling a cada passo: nenhum 409, exatamente 2 renovações, mesma identidade; depois do limite, reautenticação", async () => {
      const c = contaTv("jornada"); let e = 0;                   // `e` = tempo SIMULADO decorrido desde o login
      let jwt = emitirJwt(c);
      let { ctx, dados } = await entrar(jwt);
      const identidade = JSON.stringify([dados.empresa.id, dados.unidade.id, dados.perfil.id, dados.papel, dados.permissoes]);
      const renovacoes = []; const tokens = new Set([ctx]);
      const PASSO = 30 * MIN;
      for (; e <= 17 * H; ) {
        envelhecer(c.id, PASSO); e += PASSO;
        jwt = emitirJwt(c, { autenticadoHa: e });                // o login "continua" onde estava: carimbo recuado
        const poll = await api(jwt, "GET", "/checklist-operacional/resumo", { ctx });
        assert.equal(poll.status, 200, `polling a ${e / H} h: ${poll.texto}`);
        // O navegador pede a renovação quando falta ~1 h (relógio do SERVIDOR, lido de /sessao/atual).
        const atual = await api(jwt, "GET", "/sessao/atual", { ctx });
        const restante = Date.parse(atual.json.data.expiraEm) - Date.parse(atual.json.data.servidorEm);
        if (restante <= 60 * MIN) {
          const r = await api(jwt, "POST", "/sessao/renovar", { ctx });
          assert.equal(r.status, 201, `renovação a ${e / H} h: ${r.texto}`);
          assert.equal(JSON.stringify([r.json.data.empresa.id, r.json.data.unidade.id, r.json.data.perfil.id, r.json.data.papel, r.json.data.permissoes]), identidade);
          renovacoes.push(e / H); ctx = r.json.data.contextToken; tokens.add(ctx);
        }
      }
      assert.equal(renovacoes.length, 2, `renovações em ${renovacoes}`);
      assert.ok(renovacoes[0] < 8 && renovacoes[0] >= 6.5, `a primeira renovação veio ANTES de completar 8 h: ${renovacoes[0]} h`);
      assert.ok(renovacoes[1] < renovacoes[0] + 8, "a segunda também veio antes de a anterior vencer");
      assert.equal(tokens.size, 3, "3 contextos ao longo da jornada");
      // Passa do limite absoluto (20 h desde o login): o contexto vence e a renovação exige NOVA autenticação.
      while (e < 20 * H + 10 * MIN) { envelhecer(c.id, PASSO); e += PASSO; jwt = emitirJwt(c, { autenticadoHa: e }); }
      const depois = await api(jwt, "POST", "/sessao/renovar", { ctx });
      assert.ok([401, 409].includes(depois.status), `depois do limite: ${depois.status} ${depois.texto}`);
      const reentrar = await api(jwt, "POST", "/sessao/selecionar", { corpo: { organizacaoId: ORG_A, unidadeId: UNI_A1 } });
      assert.equal(reentrar.status, 401, "a reentrada automática TAMBÉM exige nova autenticação depois do limite");
      assert.equal(reentrar.json.details.codigo, "REAUTENTICACAO_NECESSARIA");
      // Autenticação nova (carimbo recente) -> volta a funcionar.
      const novoLogin = emitirJwt(c, { autenticadoHa: 0 });
      assert.equal((await api(novoLogin, "POST", "/sessao/selecionar", { corpo: { organizacaoId: ORG_A, unidadeId: UNI_A1 } })).status, 201);
    });
  });

  describe("limite absoluto desde a AUTENTICAÇÃO", () => {
    test("perto do limite a renovação sai CURTA (só até o limite); no limite, 401 REAUTENTICACAO_NECESSARIA e nada muda", async () => {
      const c = contaTv("limite"); const jwt = emitirJwt(c, { autenticadoHa: 19 * H + 50 * MIN });   // faltam 10 min para as 20 h
      const { ctx, dados } = await entrar(jwt);
      assert.ok(Date.parse(dados.expiraEm) - Date.now() <= 10 * MIN + 5000, "o PRÓPRIO contexto inicial já respeita o limite");
      assert.ok(dados.limiteAbsolutoEm);
      const r = await api(jwt, "POST", "/sessao/renovar", { ctx });
      assert.equal(r.status, 201, r.texto);
      assert.ok(Date.parse(r.json.data.expiraEm) - Date.now() <= 10 * MIN + 5000, "validade encurtada até o limite");
      // 1 min antes do limite ou depois: reautenticar
      const jwtVelho = emitirJwt(c, { autenticadoHa: 20 * H + MIN });
      const sidAntes = linha(r.json.data.sessionId);
      const r2 = await api(jwtVelho, "POST", "/sessao/renovar", { ctx: r.json.data.contextToken });
      assert.equal(r2.status, 401); assert.equal(r2.json.details.codigo, "REAUTENTICACAO_NECESSARIA");
      assert.deepEqual(linha(r.json.data.sessionId), sidAntes, "a recusa não alterou o contexto");
    });

    test("sem o carimbo de autenticação no JWT: NÃO renova (fail-closed, comportamento de 8 h) e nada muda", async () => {
      const c = contaTv("sem-amr"); const jwt = emitirJwt(c, { semAmr: true });
      const { ctx, sid } = await entrar(jwt);                    // entrar continua funcionando
      envelhecer(c.id, 7 * H + 10 * MIN);
      const antes = linha(sid);
      const r = await api(jwt, "POST", "/sessao/renovar", { ctx });
      assert.equal(r.status, 403, r.texto); assert.equal(r.json.details.codigo, "RENOVACAO_INDISPONIVEL");
      assert.deepEqual(linha(sid), antes);
      assert.equal(vivas(c.id), 1);
    });

    test("carimbo 'do futuro' (relógio do emissor adiantado) não vale: não renova", async () => {
      const c = contaTv("futuro"); const jwt = emitirJwt(c, { autenticadoHa: -2 * H });
      const { ctx } = await entrar(jwt);
      envelhecer(c.id, 7 * H + 10 * MIN);
      assert.equal((await api(jwt, "POST", "/sessao/renovar", { ctx })).status, 403);
    });
  });

  describe("quem NÃO pode renovar", () => {
    test("gestor, administrador, financeiro, operação e consulta: 403 e a sessão fica EXATAMENTE como estava", async () => {
      for (const papel of ["unit_manager", "organization_admin", "finance", "operations", "viewer"]) {
        const c = conta(`adm-${papel}`); vincularEmpresa(c, ORG_A, papel);
        const jwt = emitirJwt(c, { autenticadoHa: 7 * H });
        const { ctx, sid } = await entrar(jwt, ORG_A, UNI_A1);
        envelhecer(c.id, 7 * H + 10 * MIN);
        const antes = linha(sid);
        const r = await api(jwt, "POST", "/sessao/renovar", { ctx });
        assert.equal(r.status, 403, `${papel}: ${r.texto}`);
        assert.equal(r.json.details.codigo, "RENOVACAO_NAO_PERMITIDA");
        assert.deepEqual(linha(sid), antes, `${papel}: a sessão não foi alterada (nem encurtada)`);
        assert.equal(vivas(c.id), 1);
      }
    });

    test("impersonação (superadmin dentro de uma empresa) e papéis administrativos: o serviço recusa sem tocar em nada", async () => {
      const recusas = [];
      const { ApiError } = await import("../src/shared/ApiError.js");
      for (const acesso of [
        { sessionId: randomUUID(), expiraEm: iso(Date.now() + 30 * MIN), perfilId: null, papel: "organization_admin", impersonando: true },
        { sessionId: randomUUID(), expiraEm: iso(Date.now() + 30 * MIN), perfilId: randomUUID(), papel: "display_operator", impersonando: true },
        { sessionId: randomUUID(), expiraEm: iso(Date.now() + 30 * MIN), perfilId: randomUUID(), papel: "platform_superadmin", impersonando: false },
      ]) {
        const db = { from: () => { throw new Error("não deveria tocar no banco"); } };
        await assert.rejects(svc.renov.renovarContexto({ usuario: { id: randomUUID(), authEm: Date.now() - H }, acesso, tenant: { organizacaoId: ORG_A, unidadeId: UNI_A1 } },
          { supabase: db, auditar: async (a) => recusas.push(a.acao) }),
        (e) => { assert.ok(e instanceof ApiError); assert.equal(e.statusCode, 403); return true; });
      }
      assert.equal(recusas.length, 3); assert.ok(recusas.every((a) => a === "sessao.contexto_renovacao_negada"));
    });

    test("sem contexto, ou com Supabase expirado/inválido: 409/401 e nada é renovado", async () => {
      const c = contaTv("sem-ctx"); const jwt = emitirJwt(c, { autenticadoHa: 7 * H });
      assert.equal((await api(jwt, "POST", "/sessao/renovar")).status, 409, "sem Context Token");
      const { ctx } = await entrar(jwt);
      envelhecer(c.id, 7 * H + 10 * MIN);
      const invalido = await api("jwt-que-o-supabase-nao-conhece", "POST", "/sessao/renovar", { ctx });
      assert.equal(invalido.status, 401);
      assert.equal(vivas(c.id), 1);
    });
  });

  describe("autorização REVALIDADA a cada renovação", () => {
    test("REVOGAÇÃO administrativa durante o expediente: a renovação falha (409) e a reentrada só volta se o vínculo continuar", async () => {
      const c = contaTv("revoga"); const jwt = emitirJwt(c, { autenticadoHa: 7 * H });
      const { ctx } = await entrar(jwt);
      envelhecer(c.id, 7 * H + 10 * MIN);
      await svc.sessao.revogarSessoes({ perfilId: c.id, motivo: "teste_revogacao" });
      assert.equal((await api(jwt, "POST", "/sessao/renovar", { ctx })).status, 409);
      assert.equal((await api(jwt, "GET", "/checklist-operacional/resumo", { ctx })).status, 409);
      // vínculo ainda ativo: a reautenticação válida devolve o acesso...
      assert.equal((await api(jwt, "POST", "/sessao/selecionar", { corpo: { organizacaoId: ORG_A, unidadeId: UNI_A1 } })).status, 201);
      // ...e se o vínculo for REMOVIDO pelo painel, não volta.
      await svc.plataforma.removerVinculoUnidade({ user: { id: randomUUID(), email: "s@x.test" }, headers: {}, socket: {}, header: () => null }, c.id, UNI_A1);
      assert.equal((await api(jwt, "POST", "/sessao/selecionar", { corpo: { organizacaoId: ORG_A, unidadeId: UNI_A1 } })).status, 403);
    });

    test("UNIDADE desativada: a renovação é negada (403) e o contexto antigo é REVOGADO na hora", async () => {
      const c = contaTv("uni-off", UNI_A2); const jwt = emitirJwt(c, { autenticadoHa: 7 * H });
      const { ctx, sid } = await entrar(jwt, ORG_A, UNI_A2);
      envelhecer(c.id, 7 * H + 10 * MIN);
      sql(banco.url, `update unidades set ativo = false where id = '${UNI_A2}'`);
      try {
        const r = await api(jwt, "POST", "/sessao/renovar", { ctx });
        assert.equal(r.status, 403, r.texto);
        assert.ok(linha(sid).revogada_em, "contexto antigo revogado");
        assert.equal((await api(jwt, "GET", "/checklist-operacional/resumo", { ctx })).status, 409);
        assert.equal(vivas(c.id), 0);
      } finally { sql(banco.url, `update unidades set ativo = true where id = '${UNI_A2}'`); }
    });

    test("VÍNCULO bloqueado (ativo=false): 403 + revogação; EMPRESA bloqueada: 403; PERFIL/USUÁRIO desativado: 403, nada novo", async () => {
      const casos = [
        ["vinculo", (c) => sql(banco.url, `update usuarios_unidades set ativo = false where usuario_id = '${c.id}'`)],
        ["empresa", () => sql(banco.url, `update organizacoes set status = 'bloqueada' where id = '${ORG_B}'`)],
        ["perfil", (c) => sql(banco.url, `update perfis_operacionais set ativo = false where id = '${c.id}'`)],
        ["usuario", (c) => sql(banco.url, `update perfis set ativo = false where id = '${c.id}'`)],
      ];
      for (const [nome, quebrar] of casos) {
        const empresaB = nome === "empresa";
        const c = contaTv(`quebra-${nome}`, empresaB ? UNI_B1 : UNI_A1); const jwt = emitirJwt(c, { autenticadoHa: 7 * H });
        const { ctx } = await entrar(jwt, empresaB ? ORG_B : ORG_A, empresaB ? UNI_B1 : UNI_A1);
        envelhecer(c.id, 7 * H + 10 * MIN);
        quebrar(c);
        try {
          const r = await api(jwt, "POST", "/sessao/renovar", { ctx });
          assert.ok([403, 409].includes(r.status), `${nome}: ${r.status} ${r.texto}`);
          assert.ok(!r.json?.data?.contextToken, `${nome}: nenhum contexto novo foi emitido`);
          assert.equal(vivas(c.id), ["usuario", "empresa", "perfil"].includes(nome) ? vivas(c.id) : 0, `${nome}: sessões vivas (status ${r.status})`);
          const resumo = await api(jwt, "GET", "/checklist-operacional/resumo", { ctx });
          assert.ok([403, 409].includes(resumo.status), `${nome}: o Checklist também recusa (${resumo.status})`);
        } finally { sql(banco.url, `update organizacoes set status = 'ativa' where id = '${ORG_B}'`); }
      }
    });

    test("papel do vínculo ALTERADO no banco sem revogar a sessão: a renovação NÃO emite contexto com o papel novo (sem ampliar permissões)", async () => {
      const c = contaTv("papel-muda"); const jwt = emitirJwt(c, { autenticadoHa: 7 * H });
      const { ctx, sid } = await entrar(jwt);
      envelhecer(c.id, 7 * H + 10 * MIN);
      sql(banco.url, `update usuarios_unidades set papel = 'viewer' where usuario_id = '${c.id}'`);   // viraria "Consulta" (9 permissões)
      const r = await api(jwt, "POST", "/sessao/renovar", { ctx });
      assert.equal(r.status, 403, r.texto);
      assert.ok(!r.json?.data, "nenhum token com permissões ampliadas foi devolvido");
      assert.equal(sql(banco.url, `select count(*) from sessoes_contexto where usuario_id = '${c.id}' and revogada_em is null and papel = 'viewer'`), "0", "nenhuma sessão viva de 'viewer'");
      assert.ok(linha(sid).revogada_em, "e o contexto antigo foi revogado");
    });

    test("conta de exibição que ganhou VÍNCULO DE EMPRESA (dado fora do padrão): a renovação é negada", async () => {
      sql(banco.url, "alter table usuarios_organizacoes drop constraint uo_sem_papel_exibicao");
      try {
        const c = contaTv("ganha-empresa"); const jwt = emitirJwt(c, { autenticadoHa: 7 * H });
        const { ctx } = await entrar(jwt);
        envelhecer(c.id, 7 * H + 10 * MIN);
        vincularEmpresa(c, ORG_A, "viewer");     // agora o papel da unidade (direto) ainda é display, mas há herança possível
        sql(banco.url, `update usuarios_unidades set papel = null where usuario_id = '${c.id}'`); // herdaria 'viewer' da empresa
        const r = await api(jwt, "POST", "/sessao/renovar", { ctx });
        assert.equal(r.status, 403, r.texto);
        assert.equal(sql(banco.url, `select count(*) from sessoes_contexto where usuario_id = '${c.id}' and revogada_em is null and papel = 'viewer'`), "0");
      } finally { sql(banco.url, "alter table usuarios_organizacoes add constraint uo_sem_papel_exibicao check (papel <> 'display_operator'::papel_acesso)"); }
    });
  });

  describe("concorrência e falhas", () => {
    test("6 renovações SIMULTÂNEAS do mesmo contexto: exatamente UMA vence (201), as outras 409, e há UMA sessão nova", async () => {
      const c = contaTv("concorre"); const jwt = emitirJwt(c, { autenticadoHa: 7 * H });
      const { ctx, sid } = await entrar(jwt);
      envelhecer(c.id, 7 * H + 10 * MIN);
      const antes = vivas(c.id);
      const rs = await Promise.all(Array.from({ length: 6 }, () => api(jwt, "POST", "/sessao/renovar", { ctx })));
      const ok = rs.filter((r) => r.status === 201); const perdedoras = rs.filter((r) => r.status === 409);
      assert.equal(ok.length, 1, JSON.stringify(rs.map((r) => r.status)));
      assert.equal(perdedoras.length, 5);
      assert.ok(perdedoras.every((r) => r.json.details.codigo === "RENOVACAO_CONCORRENTE"));
      assert.equal(vivas(c.id), antes + 1, "uma sessão a mais (a nova), nunca duas");
      assert.equal(linha(sid).motivo_revogacao, "renovada");
      assert.equal((await api(jwt, "GET", "/checklist-operacional/resumo", { ctx: ok[0].json.data.contextToken })).status, 200);
    });

    test("FALHA TRANSITÓRIA do servidor na revalidação: o contexto antigo é RESTAURADO (prazo e marca de volta) e dá para tentar de novo", async () => {
      const c = contaTv("transit"); const jwt = emitirJwt(c, { autenticadoHa: 7 * H });
      const { ctx, sid } = await entrar(jwt);
      envelhecer(c.id, 7 * H + 10 * MIN);
      const antes = linha(sid);
      const usuario = { id: c.id, email: c.email, authEm: Date.now() - 7 * H };
      const acesso = { sessionId: sid, expiraEm: antes.expira_em, perfilId: c.id, papel: "display_operator", impersonando: false };
      await assert.rejects(svc.renov.renovarContexto({ usuario, acesso, tenant: { organizacaoId: ORG_A, unidadeId: UNI_A1 } },
        { selecionarContexto: async () => { throw new Error("banco caiu"); } }), /banco caiu/);
      assert.deepEqual(linha(sid), antes, "restaurado exatamente como estava");
      assert.equal((await api(jwt, "GET", "/checklist-operacional/resumo", { ctx })).status, 200);
      assert.equal((await api(jwt, "POST", "/sessao/renovar", { ctx })).status, 201, "e a próxima tentativa funciona");
    });

    test("FALHA de revalidação por acesso negado (403): contexto antigo REVOGADO; por outra recusa (4xx): só a graça de 90 s (não é restaurado)", async () => {
      const { ApiError } = await import("../src/shared/ApiError.js");
      for (const [status, esperaRevogada] of [[403, true], [400, false]]) {
        const c = contaTv(`rec-${status}`); const jwt = emitirJwt(c, { autenticadoHa: 7 * H });
        const { ctx, sid } = await entrar(jwt);
        envelhecer(c.id, 7 * H + 10 * MIN);
        const antes = linha(sid);
        const usuario = { id: c.id, email: c.email, authEm: Date.now() - 7 * H };
        const acesso = { sessionId: sid, expiraEm: antes.expira_em, perfilId: c.id, papel: "display_operator", impersonando: false };
        await assert.rejects(svc.renov.renovarContexto({ usuario, acesso, tenant: { organizacaoId: ORG_A, unidadeId: UNI_A1 } },
          { selecionarContexto: async () => { throw new ApiError(status, "negado"); } }));
        const depois = linha(sid);
        assert.equal(!!depois.revogada_em, esperaRevogada, `status ${status}`);
        assert.equal(depois.motivo_revogacao, esperaRevogada ? "renovacao_negada" : "renovada");
        if (!esperaRevogada) assert.ok(Date.parse(depois.expira_em) - Date.now() <= 91_000, "só a graça");
        void ctx;
      }
    });

    test("MFA exigido (MFA_ENFORCE_EXIBICAO=true): sem aal2 não entra nem renova; com aal2, sim", async () => {
      process.env.MFA_ENFORCE_EXIBICAO = "true";
      try {
        const c = contaTv("mfa");
        const semMfa = emitirJwt(c, { autenticadoHa: 7 * H, aal: "aal1" });
        const entrou = await api(semMfa, "POST", "/sessao/selecionar", { corpo: { organizacaoId: ORG_A, unidadeId: UNI_A1 } });
        assert.equal(entrou.status, 401); assert.equal(entrou.json.details.codigo, "MFA_REQUERIDA");
        const comMfa = emitirJwt(c, { autenticadoHa: 7 * H, aal: "aal2" });
        const { ctx } = await entrar(comMfa);
        envelhecer(c.id, 7 * H + 10 * MIN);
        const r1 = await api(semMfa, "POST", "/sessao/renovar", { ctx });
        assert.equal(r1.status, 401); assert.equal(r1.json.details.codigo, "MFA_REQUERIDA");
        assert.equal((await api(comMfa, "POST", "/sessao/renovar", { ctx })).status, 201);
      } finally { delete process.env.MFA_ENFORCE_EXIBICAO; }
    });
  });

  describe("auditoria", () => {
    test("renovação, negação e reautenticação ficam registradas SEM nenhum token e com os ids certos", async () => {
      const c = contaTv("audit"); const jwt = emitirJwt(c, { autenticadoHa: 7 * H });
      const a = await entrar(jwt);
      envelhecer(c.id, 7 * H + 10 * MIN);
      const r = await api(jwt, "POST", "/sessao/renovar", { ctx: a.ctx });
      assert.equal(r.status, 201);
      const ok = auditoria("sessao.contexto_renovado", c.id);
      assert.equal(ok.length, 1);
      assert.equal(ok[0].detalhes.sessaoAnteriorId, a.sid); assert.equal(ok[0].detalhes.sessaoNovaId, r.json.data.sessionId);
      assert.ok(ok[0].detalhes.validadeS > 0 && ok[0].detalhes.limiteAbsolutoEm);
      await api(jwt, "POST", "/sessao/renovar", { ctx: a.ctx });          // repetição: 409
      await api(emitirJwt(c, { autenticadoHa: 21 * H }), "POST", "/sessao/renovar", { ctx: r.json.data.contextToken }); // limite
      const negadas = auditoria("sessao.contexto_renovacao_negada", c.id).map((x) => x.detalhes.motivo);
      assert.deepEqual(negadas.sort(), ["concorrente", "limite_absoluto"]);
      const tudo = sql(banco.url, `select coalesce(string_agg(detalhes::text || coalesce(acao, ''), ' '), '') from plataforma_auditoria where ator_id = '${c.id}'`);
      for (const segredo of [a.ctx, r.json.data.contextToken, jwt]) assert.ok(!tudo.includes(segredo), "nenhum token na auditoria");
      assert.doesNotMatch(tudo, /eyJ|contextToken/);
    });
  });
});
