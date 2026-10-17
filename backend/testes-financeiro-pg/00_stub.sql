-- STUB para banco DESCARTÁVEL: só o mínimo que o domínio financeiro referencia. NUNCA rodar fora de um cluster temporário.
create extension if not exists pgcrypto;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
create table if not exists organizacoes (id uuid primary key default gen_random_uuid(), nome text not null);
create table if not exists unidades (id uuid primary key default gen_random_uuid(), organizacao_id uuid not null references organizacoes(id), nome text not null);
