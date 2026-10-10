// RLS × Operador de Exibição (achado do 6B.3), contra um Postgres LOCAL e DESCARTÁVEL.
//
// Reproduz o desenho real das migrations 015/016: `auth_unidade_ids()` + policy `for all to authenticated` numa tabela de
// unidade. Mostra que, SEM a 114, a conta da TV (papel de exibição, só vínculo de unidade) lê E ESCREVE direto pela API
// REST (papel `authenticated` + JWT próprio) — e que COM a 114 ela não enxerga nada, enquanto os demais papéis ficam iguais.
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55420/postgres node --test test/perfil-exibicao-rls-pg.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { motivoPular, criarBancoDescartavel, sql, psqlSync } from "./helpers/pg-descartavel.js";

const MIG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "database", "migrations");
const M112 = join(MIG, "112_papel_operador_exibicao.sql"); const M114 = join(MIG, "114_rls_exclui_papel_exibicao.sql"); const R114 = join(MIG, "114_rollback.sql");
const UNI_A = "a1000000-0000-4000-8000-0000000000a1"; const UNI_B = "b1000000-0000-4000-8000-0000000000b1";
const U = { tv: "11111111-1111-4111-8111-111111111111", gestor: "22222222-2222-4222-8222-222222222222", herda: "33333333-3333-4333-8333-333333333333", outro: "44444444-4444-4444-8444-444444444444" };

describe("RLS × papel de exibição (Postgres descartável)", { skip: motivoPular, timeout: 120_000 }, () => {
  let b;
  const q = (t) => sql(b.url, t);
  /** Executa como o PostgREST: papel `authenticated` + claim sub; devolve a última linha de saída. */
  const como = (usuario, comando) => {
    const r = psqlSync(b.url, `set role authenticated; select set_config('request.jwt.claim.sub', '${usuario}', false); ${comando}`);
    return { ok: r.ok, out: r.out.split(/\r?\n/).filter(Boolean).pop() ?? "", err: r.err };
  };
  const linhasVisiveis = (usuario) => como(usuario, "select count(*) from vendas;").out;

  before(() => {
    b = criarBancoDescartavel("perfil_exib_rls");
    q(`
      do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if; end $$;
      create schema if not exists auth;
      create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
      create type papel_acesso as enum ('platform_superadmin', 'organization_admin', 'unit_manager', 'finance', 'operations', 'viewer');
      create table usuarios_unidades (id uuid primary key default gen_random_uuid(), usuario_id uuid not null, unidade_id uuid not null, papel papel_acesso, ativo boolean not null default true);
      create function public.auth_unidade_ids() returns setof uuid language sql stable security definer set search_path to 'public' as $f$
        select unidade_id from usuarios_unidades where usuario_id = auth.uid() and ativo; $f$;
      create table vendas (id serial primary key, unidade_id uuid not null, total numeric);
      alter table vendas enable row level security;
      create policy rls_vendas_tenant on vendas for all to authenticated using (unidade_id in (select auth_unidade_ids())) with check (unidade_id in (select auth_unidade_ids()));
      grant usage on schema public to authenticated; grant usage on schema auth to authenticated;
      grant select, insert, update, delete on vendas to authenticated; grant usage on all sequences in schema public to authenticated;
      grant select on usuarios_unidades to authenticated; grant execute on function auth.uid() to authenticated;
      insert into vendas (unidade_id, total) values ('${UNI_A}', 100), ('${UNI_A}', 250), ('${UNI_B}', 999);`);
    psqlSync(b.url, "", { arquivo: M112 });
    q(`insert into usuarios_unidades (usuario_id, unidade_id, papel) values ('${U.tv}', '${UNI_A}', 'display_operator'), ('${U.gestor}', '${UNI_A}', 'unit_manager'), ('${U.herda}', '${UNI_A}', null);`);
  });
  after(() => b?.derrubar());

  test("ANTES da 114 (estado atual de produção): a conta da TV lê e ESCREVE direto pela API — o achado", () => {
    assert.equal(linhasVisiveis(U.tv), "2", "enxerga as vendas da unidade (sem passar pelo backend)");
    assert.equal(como(U.tv, "insert into vendas (unidade_id, total) values ('" + UNI_A + "', 1);").ok, true, "e consegue gravar");
    assert.equal(como(U.tv, "delete from vendas where total = 1;").ok, true);
    assert.equal(linhasVisiveis(U.outro), "0", "quem não tem vínculo não vê nada (o RLS funciona para os de fora)");
  });

  test("DEPOIS da 114: a conta da TV não enxerga nem escreve nada; os outros papéis (inclusive 'herda da empresa') ficam EXATAMENTE como antes", () => {
    assert.equal(psqlSync(b.url, "", { arquivo: M114 }).ok, true);
    assert.equal(linhasVisiveis(U.tv), "0");
    const ins = como(U.tv, "insert into vendas (unidade_id, total) values ('" + UNI_A + "', 1);");
    assert.equal(ins.ok, false); assert.match(ins.err, /row-level security|política|policy/i);
    assert.equal(linhasVisiveis(U.gestor), "2"); assert.equal(linhasVisiveis(U.herda), "2");
    assert.equal(como(U.gestor, "insert into vendas (unidade_id, total) values ('" + UNI_A + "', 5);").ok, true, "gestor continua escrevendo na própria unidade");
    assert.equal(linhasVisiveis(U.outro), "0");
    q("delete from vendas where total = 5");
  });

  test("114 é idempotente e só substitui o corpo da função (grants e dono preservados); o rollback restaura o original", () => {
    assert.equal(psqlSync(b.url, "", { arquivo: M114 }).ok, true);
    const antes = q("select pg_get_userbyid(proowner) || '|' || prosecdef::text || '|' || provolatile::text from pg_proc where proname = 'auth_unidade_ids'");
    assert.match(antes, /\|true\|s$/);
    assert.equal(psqlSync(b.url, "", { arquivo: R114 }).ok, true);
    assert.equal(linhasVisiveis(U.tv), "2", "rollback devolve o comportamento anterior (a conta de exibição volta a ser vista pelas policies)");
    assert.equal(q("select pg_get_userbyid(proowner) || '|' || prosecdef::text || '|' || provolatile::text from pg_proc where proname = 'auth_unidade_ids'"), antes);
    assert.equal(psqlSync(b.url, "", { arquivo: M114 }).ok, true);
    assert.equal(linhasVisiveis(U.tv), "0");
  });

  test("114 exige a 112 aplicada (sem o valor do enum a função não é criada) e é transacional: nada fica pela metade", () => {
    const b2 = criarBancoDescartavel("perfil_exib_rls2");
    try {
      sql(b2.url, `create schema if not exists auth; create function auth.uid() returns uuid language sql stable as $f$ select null::uuid $f$;
        create type papel_acesso as enum ('platform_superadmin', 'organization_admin', 'unit_manager', 'finance', 'operations', 'viewer');
        create table usuarios_unidades (id uuid primary key, usuario_id uuid, unidade_id uuid, papel papel_acesso, ativo boolean);
        create function public.auth_unidade_ids() returns setof uuid language sql stable as $f$ select unidade_id from usuarios_unidades where usuario_id = auth.uid() and ativo $f$;`);
      const antes = sql(b2.url, "select prosrc from pg_proc where proname = 'auth_unidade_ids'");
      const r = psqlSync(b2.url, "", { arquivo: M114 });
      assert.equal(r.ok, false); assert.match(r.err, /display_operator|enum/i);
      assert.equal(sql(b2.url, "select prosrc from pg_proc where proname = 'auth_unidade_ids'"), antes, "função original intacta");
    } finally { b2.derrubar(); }
  });

  test("estático: 114 é transacional com lock_timeout, só altera auth_unidade_ids, nada destrutivo, e avisa que não deve ser aplicada sem aprovação", () => {
    const f = readFileSync(M114, "utf8"); const s = f.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join("\n");
    assert.match(s, /^begin;$/m); assert.match(s, /^commit;$/m); assert.match(s, /set local lock_timeout = '5s'/);
    assert.equal((s.match(/create or replace function/gi) ?? []).length, 1); assert.match(s, /public\.auth_unidade_ids\(\)/);
    assert.doesNotMatch(s, /\b(drop|delete|truncate|update|insert|alter)\b/i);
    assert.match(f, /NÃO APLICAR EM PRODUÇÃO SEM APROVAÇÃO EXPLÍCITA/);
  });
});
