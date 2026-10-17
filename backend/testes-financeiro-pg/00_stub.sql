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
grant select on organizacoes, unidades to service_role;
