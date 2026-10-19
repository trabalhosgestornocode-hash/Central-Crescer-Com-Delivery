-- STUB para banco DESCARTÁVEL: só o mínimo que o domínio financeiro referencia. NUNCA rodar fora de um cluster temporário.
create extension if not exists pgcrypto;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
-- Como no Supabase: service_role ignora RLS (o backend depende disso; anon/authenticated NÃO ignoram).
alter role service_role bypassrls;
create table if not exists organizacoes (id uuid primary key default gen_random_uuid(), nome text not null);
create table if not exists unidades (id uuid primary key default gen_random_uuid(), organizacao_id uuid not null references organizacoes(id), nome text not null);
-- No Supabase o service_role já lê as tabelas de tenant (default privileges); o stub precisa refletir isso.
grant select on organizacoes to service_role;
-- UPDATE em unidades: o backend já altera unidades com o service_role; os gatilhos de escopo leem a unidade com FOR SHARE (120 §5b), que exige UPDATE.
grant select, update on unidades to service_role;
-- O mínimo que a 120 referencia (mesmo formato de backend/testes-seguros/pg/stub.sql).
create or replace function set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
create table if not exists perfis (id uuid primary key);
create table if not exists perfis_operacionais (id uuid primary key default gen_random_uuid(), conta_id uuid not null references perfis(id), nome text, ativo boolean not null default true);
create table if not exists usuarios_organizacoes (usuario_id uuid, organizacao_id uuid, ativo boolean default true);
create table if not exists usuarios_unidades (usuario_id uuid, unidade_id uuid, ativo boolean default true);
create table if not exists modulos (id text primary key, nome text not null, categoria text not null check (categoria in ('operacao','integracao')), ordem int not null default 0, ativo boolean not null default true);
create table if not exists organizacao_modulos (organizacao_id uuid, modulo_id text references modulos(id), primary key (organizacao_id, modulo_id));
create table if not exists unidade_modulos (unidade_id uuid, modulo_id text references modulos(id), primary key (unidade_id, modulo_id));
