do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create function set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;
create table organizacoes(id uuid primary key default gen_random_uuid(), nome text);
create table unidades(id uuid primary key default gen_random_uuid(), organizacao_id uuid not null references organizacoes(id), nome text);
create table perfis(id uuid primary key);
create table perfis_operacionais(id uuid primary key default gen_random_uuid(), conta_id uuid not null references perfis(id), nome text, ativo boolean not null default true);
create table usuarios_organizacoes(usuario_id uuid, organizacao_id uuid, ativo boolean default true);
create table usuarios_unidades(usuario_id uuid, unidade_id uuid, ativo boolean default true);
create table modulos(id text primary key, nome text not null, categoria text not null check (categoria in ('operacao','integracao')), ordem int not null default 0, ativo boolean not null default true);
create table organizacao_modulos(organizacao_id uuid, modulo_id text references modulos(id), primary key(organizacao_id,modulo_id));
create table unidade_modulos(unidade_id uuid, modulo_id text references modulos(id), primary key(unidade_id,modulo_id));
insert into modulos values ('dashboard','Dashboard','operacao',1);
