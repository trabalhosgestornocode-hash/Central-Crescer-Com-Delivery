// A migration 115 (v2) sobre um schema que REPRODUZ o estado encontrado na auditoria de PRODUÇÃO (6B.6/6B.7):
//   Postgres 17.x · 4 views vw_* com SELECT p/ anon e authenticated, rodando como o dono · 7 RPCs executáveis por anon/authenticated/PUBLIC ·
//   `unidade_config` com RLS LIGADO e SEM policies · o valor display_operator NÃO existe · a 114 NÃO está aplicada.
// Só dados sintéticos (nenhum dado real). Prova: fecha o que deve, NÃO amplia nenhum privilégio, preserva o RLS existente, não toma lock desnecessário,
// preserva o backend (service_role) e os usuários existentes, e falha de forma segura (atômica) quando a premissa não vale.
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55420/postgres node --test test/perfil-exibicao-115-producao-real-pg.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { motivoPular, criarBancoDescartavel, sql, psqlSync, psqlAsync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal, comoUsuario, MIGRATIONS_DIR } from "./helpers/schema-real-pg.js";
import { IDS, fixturesSql, SEM_CHECKS, SEMEADOR, MEDIDOR } from "./helpers/matriz-acesso-direto.sql.js";

const M115 = join(MIGRATIONS_DIR, "115_fecha_acesso_direto_residual.sql"); const R115 = join(MIGRATIONS_DIR, "115_rollback.sql");
const VIEWS = ["vw_estoque_critico", "vw_faturamento_diario", "vw_produto_margem", "vw_produtos_vendidos"];
const RPCS = ["bonificacao_congelar_competencia", "bonificacao_reabrir_competencia", "converter_empresa_para_unidade", "excluir_organizacao_definitivamente", "promover_unidade_para_empresa", "remapear_organizacao_em_tabelas_de_unidade", "transferir_unidade_organizacao"];
const lista = (a) => a.map((x) => `'${x}'`).join(",");
const PAPEIS = { viewerUni: IDS.viewerUni, herda: IDS.herda, gestorOrg: IDS.gestorOrg, financeOrg: IDS.financeOrg, outraEmpresa: IDS.outraEmpresa, estranho: IDS.estranho };
const ARGS = {
  bonificacao_congelar_competencia: `'${IDS.orgA}', '${IDS.uniA1}', 2026, 9, 'manual', '{}'::jsonb, '{}'::jsonb, 'm', '${IDS.viewerUni}', 't'`,
  bonificacao_reabrir_competencia: `'${IDS.uniA1}', 2026, 9, 'm', '${IDS.viewerUni}', 't'`,
  converter_empresa_para_unidade: `'${IDS.orgB}', '${IDS.orgA}', '${IDS.viewerUni}', 'e', null, null`,
  excluir_organizacao_definitivamente: `'${IDS.orgB}', 'Empresa B', '${IDS.viewerUni}', 'e', null, null`,
  promover_unidade_para_empresa: `'${IDS.uniA2}', 'N', '${IDS.viewerUni}', 'e', null, null`,
  remapear_organizacao_em_tabelas_de_unidade: `'${IDS.uniA2}', '${IDS.orgA}', '${IDS.orgB}'`,
  transferir_unidade_organizacao: `'${IDS.uniA2}', '${IDS.orgB}', '${IDS.viewerUni}', 'e', null, null`,
};

describe("115 v2 — schema que reproduz a PRODUÇÃO (Postgres descartável, dados sintéticos)", { skip: motivoPular, timeout: 600_000 }, () => {
  let b; let aclAntes;
  const q = (t) => sql(b.url, t);
  const ehPermissao = (err) => /permission denied|permissão negada/i.test(err);
  const leView = (v, usuario, papel = "authenticated") => comoUsuario(b.url, usuario, `select count(*) from ${v};`, { papel });
  const chamar = (n, usuario, papel = "authenticated") => comoUsuario(b.url, usuario, `select ${n}(${ARGS[n]});`, { papel });
  const medir = (usuario, papel = "authenticated") => {
    const r = comoUsuario(b.url, usuario, "select tabela || '|' || a1 || '|' || b1 || '|' || alteraveis || '|' || insere from zz_medir() order by 1;", { papel });
    assert.ok(r.ok, r.err); return r.saida.split(/\r?\n/).filter((l) => l.includes("|"));
  };
  const medirTodos = () => { const o = {}; for (const [n, id] of Object.entries(PAPEIS)) o[n] = medir(id); o.anon = medir("", "anon"); o.service = medir("", "service_role"); return o; };
  /** Foto de TODOS os privilégios de objetos de public: tabela/view/sequência/função, grantee, privilégio, quem concedeu. */
  const fotoAcl = () => q(`select coalesce(string_agg(x, E'\n' order by x), '') from (
      select 'rel|' || c.relkind::text || '|' || c.relname || '|' || (a).grantee::regrole::text || '|' || (a).privilege_type || '|' || pg_get_userbyid((a).grantor) as x
        from pg_class c, lateral aclexplode(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) a where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S') and c.relname !~ '^zz_'
      union all select 'fn|' || p.oid::regprocedure::text || '|' || (a).grantee::regrole::text || '|' || (a).privilege_type || '|' || pg_get_userbyid((a).grantor)
        from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a where p.pronamespace = 'public'::regnamespace and p.proname !~ '^zz_') t`).split(/\r?\n/).filter(Boolean);

  before(() => {
    b = criarBancoDescartavel("rls_115_prod");
    assert.deepEqual(construirSchemaReal(b.url, { ate: 111 }), []);                      // o que o repositório tinha ANTES do pacote 112+
    q("alter table unidade_config enable row level security");                          // ACHADO DE PRODUÇÃO: RLS já ligado, sem policies
    q(fixturesSql({ comTv: false })); q(SEM_CHECKS); q(SEMEADOR); q(MEDIDOR);
    q(`select zz_semear(); update vendas set status = 'concluida'; set session_replication_role = replica; insert into unidade_config (unidade_id) values ('${IDS.uniA1}'), ('${IDS.uniB1}');`);
    aclAntes = fotoAcl();
  });
  after(() => b?.derrubar());

  test("o schema reproduz a produção: PG 17, views do dono com SELECT p/ anon e authenticated, 7 RPCs executáveis por PUBLIC, unidade_config com RLS e zero policies, sem display_operator e sem a 114", () => {
    assert.ok(Number(q("show server_version_num")) >= 170000, "Postgres 17");
    assert.equal(q("select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'papel_acesso' and e.enumlabel = 'display_operator'"), "0");
    assert.doesNotMatch(q("select prosrc from pg_proc where proname = 'auth_unidade_ids'"), /display_operator/);
    for (const v of VIEWS) {
      assert.equal(q(`select coalesce(reloptions::text, 'nenhuma') || '|' || pg_get_userbyid(relowner) || '|' || has_table_privilege('anon', oid, 'select')::text || '|' || has_table_privilege('authenticated', oid, 'select')::text from pg_class where oid = 'public.${v}'::regclass`), "nenhuma|postgres|true|true", v);
    }
    for (const n of RPCS) assert.equal(q(`select string_agg(has_function_privilege(r, p.oid, 'execute')::text, ',' order by r) from pg_proc p, unnest(array['anon', 'authenticated', 'service_role']) r where p.proname = '${n}'`), "true,true,true", n);
    assert.equal(q("select relrowsecurity::text || '|' || relforcerowsecurity::text || '|' || (select count(*) from pg_policy where polrelid = c.oid) from pg_class c where oid = 'public.unidade_config'::regclass"), "true|false|0");
  });

  test("EXPOSIÇÃO ANTES (privilégio SQL comprovado, dados sintéticos): anon e authenticated leem as views com as DUAS unidades e executam as RPCs; unidade_config já nega", () => {
    assert.ok(Number(leView("vw_faturamento_diario", "", "anon").out) >= 2, "anon lê as duas unidades pela view");
    assert.ok(Number(leView("vw_faturamento_diario", IDS.estranho).out) >= 2, "authenticated sem vínculo também");
    for (const n of RPCS) { const r = chamar(n, "", "anon"); assert.equal(ehPermissao(r.err), false, `anon executa ${n}`); }
    for (const [u, papel] of [[IDS.estranho, "authenticated"], ["", "anon"]]) assert.equal(comoUsuario(b.url, u, "select count(*) from unidade_config;", { papel }).out, "0", "RLS sem policy: nega");
  });

  test("APLICA a 115: sem erro, atômica; fecha as 4 views e as 7 RPCs; NÃO toca em unidade_config (RLS ligado e zero policies preservados)", () => {
    const matrizAntes = medirTodos();
    const r = psqlSync(b.url, "", { arquivo: M115 }); assert.equal(r.ok, true, r.err);
    assert.match(r.err, /MIGRATION 115: 4 views e 7 funções/);
    for (const v of VIEWS) for (const [u, papel] of [["", "anon"], [IDS.estranho, "authenticated"], [IDS.gestorOrg, "authenticated"], [IDS.viewerUni, "authenticated"]]) {
      const x = leView(v, u, papel); assert.equal(x.ok, false, `${papel} ainda lê ${v}`); assert.equal(ehPermissao(x.err), true);
    }
    for (const n of RPCS) for (const [u, papel] of [["", "anon"], [IDS.estranho, "authenticated"], [IDS.gestorOrg, "authenticated"]]) {
      const x = chamar(n, u, papel); assert.equal(x.ok, false); assert.equal(ehPermissao(x.err), true, `${papel} executa ${n}: ${x.err.slice(0, 100)}`);
    }
    assert.equal(q("select relrowsecurity::text || '|' || relforcerowsecurity::text || '|' || (select count(*) from pg_policy where polrelid = c.oid) from pg_class c where oid = 'public.unidade_config'::regclass"), "true|false|0", "RLS e policies exatamente como estavam");
    assert.deepEqual(medirTodos(), matrizAntes, "usuários existentes: nenhuma linha da matriz de tabelas mudou (inclui anon e service_role)");
  });

  test("NENHUMA AMPLIAÇÃO: todo privilégio depois da 115 já existia antes; só SAÍRAM entradas de PUBLIC/anon/authenticated das 4 views e das 7 funções (nenhum outro objeto mudou)", () => {
    const depois = fotoAcl(); const antes = new Set(aclAntes); const dep = new Set(depois);
    assert.deepEqual(depois.filter((x) => !antes.has(x)), [], "nenhum privilégio novo");
    const removidos = aclAntes.filter((x) => !dep.has(x));
    assert.ok(removidos.length >= VIEWS.length + RPCS.length, `removidos: ${removidos.length}`);
    const alvoView = { test: (x) => x.startsWith("rel|") && ["v", "m"].includes(x.split("|")[1]) && VIEWS.includes(x.split("|")[2]) };
    const alvoFn = { test: (x) => x.startsWith("fn|") && RPCS.includes(x.split("|")[1].replace(/^public./, "").split("(")[0]) };
    for (const x of removidos) {
      assert.ok(alvoView.test(x) || alvoFn.test(x), `removido fora dos alvos: ${x}`);
      const grantee = x.startsWith("rel|") ? x.split("|")[3] : x.split("|")[2];
      assert.ok(["-", "anon", "authenticated"].includes(grantee), `grantee removido inesperado: ${x}`);   // "-" = PUBLIC
    }
    for (const x of aclAntes.filter((y) => alvoView.test(y) || alvoFn.test(y))) {
      const grantee = x.startsWith("rel|") ? x.split("|")[3] : x.split("|")[2];
      if (!["-", "anon", "authenticated"].includes(grantee)) assert.ok(dep.has(x), `service_role/dono perdeu: ${x}`);
    }
  });

  test("BACKEND (service_role): Dashboard/CMV (views), unidade_config (leitura e gravação), bonificação e funções administrativas executam sem 'permission denied'", () => {
    assert.ok(Number(leView("vw_faturamento_diario", "", "service_role").out) >= 2, "Dashboard: faturamento das duas unidades");
    for (const v of ["vw_produto_margem", "vw_produtos_vendidos", "vw_estoque_critico"]) assert.equal(leView(v, "", "service_role").ok, true, `${v} (CMV/Dashboard)`);
    assert.equal(comoUsuario(b.url, "", "select count(*) from unidade_config;", { papel: "service_role" }).out, "2", "backend lê unidade_config (RLS não o afeta)");
    assert.equal(comoUsuario(b.url, "", `update unidade_config set cmv_saudavel = 31 where unidade_id = '${IDS.uniA1}';`, { papel: "service_role" }).ok, true);
    assert.equal(q(`select cmv_saudavel from unidade_config where unidade_id = '${IDS.uniA1}'`), "31.00", "e grava");
    for (const n of RPCS) { const x = chamar(n, "", "service_role"); assert.equal(ehPermissao(x.err), false, `service_role / ${n}: ${x.err.slice(0, 120)}`); }
  });

  test("ACESSO DIRETO por anon e authenticated depois da 115: views, RPCs e unidade_config negados; demais tabelas seguem sob RLS (anon: 0 tabelas visíveis)", () => {
    const anon = medir("", "anon"); assert.ok(anon.every((l) => l.split("|")[1] <= 0 && l.split("|")[2] <= 0), "anon nada vê");
    assert.equal(comoUsuario(b.url, IDS.estranho, "select count(*) from unidade_config;").out, "0");
    assert.equal(comoUsuario(b.url, "", "update unidade_config set cmv_saudavel = 99;", { papel: "anon" }).ok, true);   // 0 linhas (RLS)
    assert.equal(q("select count(*) from unidade_config where cmv_saudavel = 99"), "0");
  });

  test("EXPOSIÇÃO DA API — metadados: o que a API enxergaria em schemas expostos (public) para anon antes × depois; exploração efetiva NÃO realizada", () => {
    q("do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if; end $$; alter role authenticator set pgrst.db_schemas = 'public,graphql_public'");
    const expostoSql = q("select (select split_part(c, '=', 2) from pg_roles r, unnest(r.rolconfig) c where r.rolname = 'authenticator' and c like 'pgrst.db_schemas=%') like '%public%'");
    assert.equal(expostoSql, "t", "o schema public está na lista exposta (premissa da produção)");
    const legiveisPorAnon = () => q("select coalesce(string_agg(c.relname, ',' order by c.relname), '') from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm') and has_table_privilege('anon', c.oid, 'select')");
    assert.equal(legiveisPorAnon(), "", "depois da 115: nenhuma view legível por anon (nada a expor em /rest/v1/vw_*)");
    assert.equal(q("select count(*) from pg_policies where schemaname = 'public' and ('anon' = any(roles) or 'public' = any(roles))"), "1", "única policy que alcança anon: rls_padmadm_self (usa auth.uid() ⇒ 0 linhas para anon)");
    assert.equal(psqlSync(b.url, "", { arquivo: R115 }).ok, true);
    assert.equal(legiveisPorAnon(), VIEWS.slice().sort().join(","), "ANTES (privilégio SQL comprovado): as 4 views legíveis por anon");
    assert.equal(psqlSync(b.url, "", { arquivo: M115 }).ok, true);
    assert.equal(legiveisPorAnon(), "");
  });

  test("RLS PRÉ-EXISTENTE com policies: se unidade_config tiver policies, a 115 NÃO as remove nem altera o RLS (e não toma o lock forte): rodando enquanto OUTRA transação segura a tabela, aplica em segundos", async () => {
    q("create policy zz_politica_existente on unidade_config for select to authenticated using (unidade_id in (select auth_unidade_ids()))");
    assert.equal(psqlSync(b.url, "", { arquivo: R115 }).ok, true);
    const segurando = psqlAsync(b.url, "begin; select count(*) from unidade_config; select pg_sleep(12); commit;");
    await new Promise((r) => setTimeout(r, 1500));
    const t0 = Date.now(); const r = psqlSync(b.url, "", { arquivo: M115 }); const gasto = Date.now() - t0;
    assert.equal(r.ok, true, r.err); assert.ok(gasto < 4000, `não esperou lock: ${gasto} ms`);
    assert.equal(q("select (select count(*) from pg_policy where polrelid = c.oid)::text || '|' || relrowsecurity::text from pg_class c where oid = 'public.unidade_config'::regclass"), "1|true");
    await segurando; q("drop policy zz_politica_existente on unidade_config");
  });

  test("PRÉ-CONDIÇÃO: executada por uma role que NÃO administra os objetos, a 115 ABORTA listando-os e NÃO altera nada", () => {
    q("do $$ begin if not exists (select 1 from pg_roles where rolname = 'operador_sem_dono') then create role operador_sem_dono nologin; end if; end $$");
    assert.equal(psqlSync(b.url, "", { arquivo: R115 }).ok, true);
    const conteudo = (psqlSync(b.url, "select 1").ok, `set role operador_sem_dono;\n` + require_fs(M115));
    const r = psqlSync(b.url, conteudo);
    assert.equal(r.ok, false); assert.match(r.err, /MIGRATION 115 abortada: a role operador_sem_dono não administra/); assert.match(r.err, /vw_faturamento_diario/);
    assert.equal(leView("vw_faturamento_diario", "", "anon").ok, true, "nada foi alterado: anon ainda lê (estado anterior intacto)");
  });

  test("PÓS-CONDIÇÃO: privilégio concedido por OUTRA role sobreviveria à REVOKE do dono ⇒ a 115 ABORTA e DESFAZ TUDO (nenhuma exposição parcial); depois da remediação, aplica", () => {
    q("do $$ begin if not exists (select 1 from pg_roles where rolname = 'concedente_externo') then create role concedente_externo nologin; end if; end $$");
    q("grant select on vw_estoque_critico to concedente_externo with grant option; set role concedente_externo; grant select on vw_estoque_critico to anon; reset role");
    const r = psqlSync(b.url, "", { arquivo: M115 });
    assert.equal(r.ok, false); assert.match(r.err, /abortada e DESFEITA/); assert.match(r.err, /vw_estoque_critico/); assert.match(r.err, /concedido por concedente_externo/);
    assert.equal(leView("vw_faturamento_diario", "", "anon").ok, true, "TUDO desfeito (a revogação das outras views também): estado anterior");
    q("revoke all on vw_estoque_critico from concedente_externo cascade");
    assert.equal(psqlSync(b.url, "", { arquivo: M115 }).ok, true, "após remediar o concedente, aplica");
    assert.equal(leView("vw_estoque_critico", "", "anon").ok, false);
    q("drop owned by concedente_externo; drop role concedente_externo");
  });

  test("HERANÇA: se anon (ou authenticated) herda de uma role que tem acesso a um alvo, a pós-condição EFETIVA aborta e desfaz tudo; sem a associação, aplica", () => {
    assert.equal(psqlSync(b.url, "", { arquivo: R115 }).ok, true);          // volta ao estado ABERTO (o teste anterior terminou com a 115 aplicada)
    q("do $$ begin if not exists (select 1 from pg_roles where rolname = 'grupo_herdado') then create role grupo_herdado nologin; end if; end $$");
    q("grant execute on function bonificacao_reabrir_competencia(uuid, integer, integer, text, uuid, text) to grupo_herdado; grant grupo_herdado to authenticated");
    const r = psqlSync(b.url, "", { arquivo: M115 });
    assert.equal(r.ok, false); assert.match(r.err, /abortada e DESFEITA/); assert.match(r.err, /authenticated ainda teria acesso/); assert.match(r.err, /bonificacao_reabrir_competencia/);
    assert.equal(leView("vw_faturamento_diario", "", "anon").ok, true, "tudo desfeito: nenhuma exposição parcial");
    q("revoke grupo_herdado from authenticated");
    assert.equal(psqlSync(b.url, "", { arquivo: M115 }).ok, true, "sem a herança, aplica");
    assert.equal(ehPermissao(chamar("bonificacao_reabrir_competencia", IDS.estranho).err), true);
    q("drop owned by grupo_herdado; drop role grupo_herdado");
  });

  test("service_role que dependia só de PUBLIC: a 115 devolve a ELA o acesso que já tinha (e a mais ninguém); idempotente na segunda execução", () => {
    q("revoke all on vw_produto_margem from service_role; revoke all on function bonificacao_reabrir_competencia(uuid, integer, integer, text, uuid, text) from service_role");
    q("grant select on vw_produto_margem to public; grant execute on function bonificacao_reabrir_competencia(uuid, integer, integer, text, uuid, text) to public");
    assert.equal(psqlSync(b.url, "", { arquivo: R115 }).ok, true);
    assert.equal(psqlSync(b.url, "", { arquivo: M115 }).ok, true);
    assert.equal(leView("vw_produto_margem", "", "service_role").ok, true, "service_role mantém o acesso efetivo");
    assert.equal(chamar("bonificacao_reabrir_competencia", "", "service_role").err.includes("permission denied"), false);
    assert.equal(leView("vw_produto_margem", "", "anon").ok, false);
    const a1 = fotoAcl(); assert.equal(psqlSync(b.url, "", { arquivo: M115 }).ok, true); assert.deepEqual(fotoAcl(), a1, "segunda execução não muda nada");
  });

  test("ROLLBACK: devolve exatamente o estado encontrado (views: SELECT; RPCs: EXECUTE p/ PUBLIC) e NÃO desliga o RLS de unidade_config; reaplicar fecha de novo", () => {
    assert.equal(psqlSync(b.url, "", { arquivo: R115 }).ok, true);
    assert.equal(q("select relrowsecurity::text from pg_class where oid = 'public.unidade_config'::regclass"), "true", "RLS preservado");
    for (const v of VIEWS) assert.equal(leView(v, "", "anon").ok, true, v);
    assert.equal(comoUsuario(b.url, "", "insert into vw_faturamento_diario default values;", { papel: "anon" }).ok, false, "não devolve INSERT/UPDATE nas views");
    for (const n of RPCS) assert.equal(ehPermissao(chamar(n, "", "anon").err), false, `${n} voltou a ser executável (estado encontrado)`);
    assert.equal(psqlSync(b.url, "", { arquivo: M115 }).ok, true);
    assert.equal(leView("vw_faturamento_diario", "", "anon").ok, false);
  });
});

import { readFileSync } from "node:fs";
function require_fs(f) { return readFileSync(f, "utf8"); }
