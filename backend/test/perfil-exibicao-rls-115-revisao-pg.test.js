// Revisão profunda da migration 115 (Checkpoint 6B.5) sobre o schema REAL em Postgres LOCAL e DESCARTÁVEL:
// PUBLIC, donos, sobrecargas, concedentes diferentes, dependências, acesso do backend (service_role), varredura final e
// atomicidade sob falha intermediária (lock_timeout).
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55420/postgres node --test test/perfil-exibicao-rls-115-revisao-pg.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { motivoPular, criarBancoDescartavel, sql, psqlSync, psqlAsync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal, comoUsuario, MIGRATIONS_DIR } from "./helpers/schema-real-pg.js";
import { IDS, FIXTURES, SEM_CHECKS, SEMEADOR, MEDIDOR } from "./helpers/matriz-acesso-direto.sql.js";

const M114 = join(MIGRATIONS_DIR, "114_rls_exclui_papel_exibicao.sql");
const M115 = join(MIGRATIONS_DIR, "115_fecha_acesso_direto_residual.sql"); const R115 = join(MIGRATIONS_DIR, "115_rollback.sql");
const VIEWS = ["vw_estoque_critico", "vw_faturamento_diario", "vw_produto_margem", "vw_produtos_vendidos"];
const RPCS = ["bonificacao_congelar_competencia", "bonificacao_reabrir_competencia", "converter_empresa_para_unidade", "excluir_organizacao_definitivamente", "promover_unidade_para_empresa", "remapear_organizacao_em_tabelas_de_unidade", "transferir_unidade_organizacao"];
const lista = (a) => a.map((x) => `'${x}'`).join(",");
const PAPEIS = { tv: IDS.tv, viewerUni: IDS.viewerUni, herda: IDS.herda, gestorOrg: IDS.gestorOrg, financeOrg: IDS.financeOrg, outraEmpresa: IDS.outraEmpresa, estranho: IDS.estranho };

describe("115 — revisão profunda (schema real, Postgres descartável)", { skip: motivoPular, timeout: 600_000 }, () => {
  let b;
  const q = (t) => sql(b.url, t);
  const medir = (usuario, papel = "authenticated") => {
    const r = comoUsuario(b.url, usuario, "select tabela || '|' || a1 || '|' || b1 || '|' || alteraveis || '|' || insere from zz_medir() order by 1;", { papel });
    assert.ok(r.ok, r.err);
    return r.saida.split(/\r?\n/).filter((l) => l.includes("|"));
  };
  const medirTodos = () => { const o = {}; for (const [n, id] of Object.entries(PAPEIS)) o[n] = medir(id); o.anon = medir("", "anon"); o.service = medir("", "service_role"); return o; };
  const ehPermissao = (err) => /permission denied|permissão negada/i.test(err);
  const ARGS = {
    bonificacao_congelar_competencia: `'${IDS.orgA}', '${IDS.uniA1}', 2026, 9, 'manual', '{}'::jsonb, '{}'::jsonb, 'm', '${IDS.tv}', 't'`,
    bonificacao_reabrir_competencia: `'${IDS.uniA1}', 2026, 9, 'm', '${IDS.tv}', 't'`,
    converter_empresa_para_unidade: `'${IDS.orgB}', '${IDS.orgA}', '${IDS.tv}', 'e', null, null`,
    excluir_organizacao_definitivamente: `'${IDS.orgB}', 'Empresa B', '${IDS.tv}', 'e', null, null`,
    promover_unidade_para_empresa: `'${IDS.uniA2}', 'N', '${IDS.tv}', 'e', null, null`,
    remapear_organizacao_em_tabelas_de_unidade: `'${IDS.uniA2}', '${IDS.orgA}', '${IDS.orgB}'`,
    transferir_unidade_organizacao: `'${IDS.uniA2}', '${IDS.orgB}', '${IDS.tv}', 'e', null, null`,
  };
  const chamarRpcs = (papel, usuario) => RPCS.map((n) => ({ n, ...comoUsuario(b.url, usuario, `select ${n}(${ARGS[n]});`, { papel }) }));

  before(() => {
    b = criarBancoDescartavel("rls_115_rev");
    assert.deepEqual(construirSchemaReal(b.url, { ate: 113 }), []);
    q(FIXTURES); q(SEM_CHECKS); q(SEMEADOR); q(MEDIDOR);
    q("select zz_semear(); update vendas set status = 'concluida'");
    assert.equal(psqlSync(b.url, "", { arquivo: M114 }).ok, true);
  });
  after(() => b?.derrubar());

  test("TODOS os papéis: a 115 não muda uma linha da matriz das tabelas (TV, viewer, herda, gestor, financeiro, outra empresa, estranho, anon, service_role)", () => {
    const antes = medirTodos();
    assert.equal(psqlSync(b.url, "", { arquivo: M115 }).ok, true);
    assert.deepEqual(medirTodos(), antes);
  });

  test("PUBLIC e donos: nada concedido a PUBLIC (grantee 0), anon ou authenticated nas views/RPCs; donos = dono do schema, nunca uma role da API", () => {
    const views = q(`select count(*) from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where c.relnamespace = 'public'::regnamespace and c.relname in (${lista(VIEWS)}) and (a).grantee in (0, 'anon'::regrole, 'authenticated'::regrole)`);
    const rpcs = q(`select count(*) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.pronamespace = 'public'::regnamespace and p.proname in (${lista(RPCS)}) and (a).grantee in (0, 'anon'::regrole, 'authenticated'::regrole)`);
    assert.deepEqual([views, rpcs], ["0", "0"]);
    const donos = q(`select string_agg(distinct pg_get_userbyid(o), ',') from (select relowner o from pg_class where relnamespace = 'public'::regnamespace and (relname in (${lista(VIEWS)}) or relname = 'unidade_config') union all select proowner from pg_proc where pronamespace = 'public'::regnamespace and proname in (${lista(RPCS)})) t`);
    assert.equal(donos, "postgres");
    assert.equal(q("select has_table_privilege('public', 'public.unidade_config'::regclass, 'select')"), "f");
  });

  test("SOBRECARGAS: uma função nova com o mesmo nome (outra assinatura) nasce exposta pelos privilégios padrão; reaplicar a 115 a fecha (revogação por NOME)", () => {
    q("create function public.bonificacao_reabrir_competencia(p_x text) returns text language sql as $f$ select 'x' $f$");
    assert.equal(q("select has_function_privilege('anon', 'public.bonificacao_reabrir_competencia(text)'::regprocedure, 'execute')"), "t", "risco de uma sobrecarga futura: nasce exposta");
    assert.equal(psqlSync(b.url, "", { arquivo: M115 }).ok, true);
    assert.equal(q("select has_function_privilege('anon', 'public.bonificacao_reabrir_competencia(text)'::regprocedure, 'execute') or has_function_privilege('authenticated', 'public.bonificacao_reabrir_competencia(text)'::regprocedure, 'execute')"), "f");
    q("drop function public.bonificacao_reabrir_competencia(text)");
  });

  test("GRANT de OUTRO concedente: registra se a REVOKE do dono remove um privilégio dado por outra role com GRANT OPTION; a auditoria lista o concedente (quem_concedeu) para flagrar", () => {
    q("do $$ begin if not exists (select 1 from pg_roles where rolname = 'concedente_teste') then create role concedente_teste nologin; end if; end $$");
    q("grant select on vw_faturamento_diario to concedente_teste with grant option");
    q("set role concedente_teste; grant select on vw_faturamento_diario to anon; reset role");
    assert.equal(comoUsuario(b.url, "", "select count(*) from vw_faturamento_diario;", { papel: "anon" }).ok, true, "anon lê pelo grant do outro concedente");
    psqlSync(b.url, "", { arquivo: M115 });
    const sobrevive = comoUsuario(b.url, "", "select count(*) from vw_faturamento_diario;", { papel: "anon" }).ok;
    const concedentes = q("select coalesce(string_agg(pg_get_userbyid((a).grantor) || '>' || (a).grantee::regrole::text, ','), '') from pg_class c, aclexplode(c.relacl) a where c.oid = 'public.vw_faturamento_diario'::regclass and (a).grantee in (0, 'anon'::regrole, 'authenticated'::regrole)");
    console.log("# grant de outro concedente sobrevive à REVOKE do dono?", sobrevive, "| concedentes visíveis:", concedentes || "(nenhum)");
    if (sobrevive) assert.match(concedentes, /concedente_teste>anon/, "a auditoria enxerga quem concedeu");
    q("revoke all on vw_faturamento_diario from concedente_teste cascade");        // remediação: revogar do concedente em cascata
    assert.equal(comoUsuario(b.url, "", "select count(*) from vw_faturamento_diario;", { papel: "anon" }).ok, false, "após a remediação o anon não lê");
    q("drop owned by concedente_teste; drop role concedente_teste");
  });

  test("DEPENDÊNCIAS: nenhuma view/policy/trigger/função do banco depende das 4 views ou de unidade_config; as RPCs só são citadas por outras RPCs da mesma família", () => {
    assert.equal(q(`select count(*) from pg_depend d join pg_rewrite r on r.oid = d.objid join pg_class v on v.oid = d.refobjid where v.relname in (${lista(VIEWS)}) and r.ev_class <> v.oid`), "0");
    assert.equal(q("select count(*) from pg_policies where schemaname = 'public' and (coalesce(qual, '') || coalesce(with_check, '')) ~ 'vw_|(^|[^_a-z])unidade_config'"), "0");
    assert.equal(q("select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid where not t.tgisinternal and p.prosrc ~ 'vw_|(^|[^_a-z])unidade_config'"), "0");
    assert.equal(q("select coalesce(string_agg(p.proname, ','), '') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proname !~ '^zz_' and p.prosrc ~ 'vw_estoque_critico|vw_faturamento_diario|vw_produto_margem|vw_produtos_vendidos|(^|[^_a-z])unidade_config'"), "");
    const entre = q(`select coalesce(string_agg(distinct p.proname || '>' || m, ',' order by p.proname || '>' || m), '') from pg_proc p, unnest(array[${lista(RPCS)}]) m where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proname <> m and p.proname !~ '^zz_' and p.prosrc like '%' || m || '%'`);
    console.log("# funções do banco que citam as RPCs:", entre || "(nenhuma)");
    for (const par of entre.split(",").filter(Boolean)) assert.ok(RPCS.includes(par.split(">")[0]), `chamador inesperado: ${par}`);
  });

  test("BACKEND (service_role): as 7 RPCs não dão 'permission denied' (podem dar erro de negócio); anon, authenticated e a TV levam 'permission denied' em TODAS", () => {
    for (const r of chamarRpcs("service_role", "")) assert.equal(ehPermissao(r.err), false, `service_role / ${r.n}: ${r.err.slice(0, 140)}`);
    for (const [papel, usuario] of [["authenticated", IDS.tv], ["authenticated", IDS.gestorOrg], ["anon", ""]]) {
      for (const r of chamarRpcs(papel, usuario)) { assert.equal(r.ok, false, `${papel}/${r.n}`); assert.equal(ehPermissao(r.err), true, `${papel} / ${r.n}: ${r.err.slice(0, 140)}`); }
    }
    for (const v of VIEWS) assert.equal(comoUsuario(b.url, "", `select count(*) >= 0 from ${v};`, { papel: "service_role" }).ok, true, `service_role lê ${v}`);
    assert.equal(comoUsuario(b.url, "", "select count(*) from unidade_config;", { papel: "service_role" }).ok, true);
    assert.equal(comoUsuario(b.url, "", "insert into unidade_config (unidade_id) values ('" + IDS.uniA2 + "') on conflict do nothing;", { papel: "service_role" }).ok, true, "o backend continua gravando unidade_config");
  });

  test("VARREDURA FINAL (114 + 115): nenhuma view legível por anon/authenticated; nenhuma tabela sem RLS; funções expostas = auxiliares de RLS + fn_custo_* (+ pgcrypto); nenhuma policy aberta", () => {
    assert.equal(q("select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm') and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'))"), "0");
    assert.equal(q("select coalesce(string_agg(c.relname, ','), '') from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity and c.relname !~ '^zz_'"), "");
    const expostas = q(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and format_type(p.prorettype, null) <> 'trigger' and p.proname !~ '^(zz_.*|armor|crypt|dearmor|decrypt|decrypt_iv|digest|encrypt|encrypt_iv|gen_random_bytes|gen_random_uuid|gen_salt|hmac|pgp_.*)$' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`);
    assert.equal(expostas, "auth_organizacao_id,auth_organizacao_ids,auth_unidade_id,auth_unidade_ids,fn_custo_produto,fn_recalc_custo,is_platform_superadmin,tem_grant_realtime");
    assert.equal(q("select count(*) from pg_policies where schemaname = 'public' and (qual = 'true' or with_check = 'true')"), "0");
  });

  test("FALHA INTERMEDIÁRIA: com transação longa segurando unidade_config, a 115 falha em ~5 s e NÃO aplica NADA (nem o REVOKE das views que vem antes) — atômica; repetida depois, aplica", async () => {
    assert.equal(psqlSync(b.url, "", { arquivo: R115 }).ok, true);
    q("alter table unidade_config disable row level security");   // ambiente SEM RLS (banco montado só pelo repositório): é aí que a 115 precisa do lock forte
    const segurando = psqlAsync(b.url, "begin; select count(*) from unidade_config; select pg_sleep(14); commit;");
    await new Promise((r) => setTimeout(r, 1500));
    const t0 = Date.now(); const r = psqlSync(b.url, "", { arquivo: M115 }); const gasto = Date.now() - t0;
    assert.equal(r.ok, false); assert.match(r.err, /lock timeout|lock_timeout/i); assert.ok(gasto >= 4000 && gasto < 11_000, `falhou em ~5 s: ${gasto} ms`);
    assert.equal(comoUsuario(b.url, "", "select count(*) from vw_faturamento_diario;", { papel: "anon" }).ok, true, "views como estavam: o REVOKE foi desfeito junto");
    assert.equal(q("select relrowsecurity::text from pg_class where oid = 'public.unidade_config'::regclass"), "false");
    assert.equal(q("select has_function_privilege('anon', 'public.bonificacao_reabrir_competencia(uuid, integer, integer, text, uuid, text)'::regprocedure, 'execute')"), "t");
    await segurando;
    assert.equal(psqlSync(b.url, "", { arquivo: M115 }).ok, true, "repetida: aplica");
    assert.equal(comoUsuario(b.url, "", "select count(*) from vw_faturamento_diario;", { papel: "anon" }).ok, false);
  });

  test("INDEPENDÊNCIA: a 115 SOZINHA (sem 112/113/114, schema como a produção está hoje) aplica sem erro, fecha views/unidade_config/RPCs e não muda a matriz das tabelas; 112→113→114 aplicam depois sem conflito", () => {
    const b2 = criarBancoDescartavel("rls_115_sozinha");
    assert.deepEqual(construirSchemaReal(b2.url, { ate: 111 }), []);
    try {
      sql(b2.url, `insert into auth.users (id, email) values ('${IDS.viewerUni}', 'v@teste.invalid');
        insert into perfis (id, nome) values ('${IDS.viewerUni}', 'v'); insert into perfis_operacionais (id, conta_id, nome) values ('${IDS.viewerUni}', '${IDS.viewerUni}', 'v');
        insert into organizacoes (id, nome) values ('${IDS.orgA}', 'A'); insert into unidades (id, organizacao_id, nome) values ('${IDS.uniA1}', '${IDS.orgA}', 'A1');
        insert into usuarios_unidades (usuario_id, perfil_id, unidade_id, papel) values ('${IDS.viewerUni}', '${IDS.viewerUni}', '${IDS.uniA1}', 'viewer');
        insert into unidade_config (unidade_id) values ('${IDS.uniA1}');`);
      const vendasAntes = comoUsuario(b2.url, IDS.viewerUni, "select count(*) from unidade_config;").out;
      assert.equal(vendasAntes, "1", "antes da 115 o viewer lê unidade_config (sem RLS)");
      assert.equal(psqlSync(b2.url, "", { arquivo: M115 }).ok, true, "115 sozinha");
      assert.equal(comoUsuario(b2.url, IDS.viewerUni, "select count(*) from unidade_config;").out, "0");
      assert.equal(comoUsuario(b2.url, "", "select count(*) from vw_faturamento_diario;", { papel: "anon" }).ok, false);
      assert.equal(comoUsuario(b2.url, IDS.viewerUni, "select count(*) from vw_faturamento_diario;").ok, false);
      assert.equal(comoUsuario(b2.url, IDS.viewerUni, "select count(*) from unidades;").ok, true, "o RLS das demais tabelas segue como era");
      for (const f of ["112_papel_operador_exibicao.sql", "113_papel_exibicao_somente_unidade.sql", "114_rls_exclui_papel_exibicao.sql"]) assert.equal(psqlSync(b2.url, "", { arquivo: join(MIGRATIONS_DIR, f) }).ok, true, f);
      assert.equal(comoUsuario(b2.url, "", "select count(*) from vw_faturamento_diario;", { papel: "anon" }).ok, false, "continua fechado");
    } finally { b2.derrubar(); }
  });
});
