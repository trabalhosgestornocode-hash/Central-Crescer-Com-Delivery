// Auxiliar de testes — monta, num Postgres LOCAL e DESCARTÁVEL, o schema REAL do projeto (migration base + as incrementais
// 068..114 do repositório) com STUBS do que o Supabase fornece (roles anon/authenticated/service_role, schemas auth, storage
// e realtime) e os PRIVILÉGIOS PADRÃO que o Supabase concede em `public` (alter default privileges … to anon, authenticated,
// service_role) — é isso que torna uma tabela/função alcançável pela API REST (PostgREST) e por /rpc.
//
// LIMITES (declarados): reflete o que está nas migrations do repositório, não o estado ao vivo do projeto de produção
// (alterações feitas à mão no painel não aparecem aqui). Os privilégios padrão são os documentados do Supabase.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql, psqlSync } from "./pg-descartavel.js";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "database", "migrations");

const STUBS = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  end $$;
  create extension if not exists pgcrypto;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
  create function auth.role() returns text language sql stable as $f$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $f$;
  create function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  create schema realtime;
  create table realtime.messages (id uuid primary key default gen_random_uuid(), topic text, extension text, payload jsonb);
  alter table realtime.messages enable row level security;
  create function realtime.topic() returns text language sql stable as $f$ select current_setting('realtime.topic', true) $f$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`;

/** Arquivos aplicados, em ordem: base (equivale a 001..067) + 068 em diante, sem rollbacks nem o arquivo de verificação. */
export function migrationsParaAplicar({ ate = 999 } = {}) {
  const todas = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && !/rollback|VERIFICACAO/i.test(f)).sort();
  const incrementais = todas.filter((f) => { const n = Number(f.slice(0, 3)); return n >= 68 && n <= ate; });
  return ["000_base_migration.sql", ...incrementais];
}

/** Aplica stubs + migrations no banco `url`. Devolve a lista de falhas (vazia = tudo aplicou). */
export function construirSchemaReal(url, opcoes = {}) {
  sql(url, STUBS);
  const falhas = [];
  for (const f of migrationsParaAplicar(opcoes)) {
    const r = psqlSync(url, "", { arquivo: join(MIGRATIONS_DIR, f) });
    if (!r.ok) falhas.push({ arquivo: f, erro: r.err.split(/\r?\n/).filter((l) => /ERROR|ERRO/.test(l)).slice(0, 2).join(" | ").slice(0, 300) });
  }
  return falhas;
}

/** Executa `comando` COMO o PostgREST faria: papel `authenticated` + claim sub; devolve { ok, out, err } (out = última linha). */
export function comoUsuario(url, usuarioId, comando, { papel = "authenticated" } = {}) {
  const r = psqlSync(url, `set role ${papel}; select set_config('request.jwt.claim.sub', '${usuarioId ?? ""}', false); select set_config('request.jwt.claim.role', '${papel}', false); ${comando}`);
  return { ok: r.ok, out: r.out.split(/\r?\n/).filter(Boolean).pop() ?? "", saida: r.out, err: r.err };
}
