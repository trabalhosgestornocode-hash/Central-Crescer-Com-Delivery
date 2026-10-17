-- STUB das dependências da Migration 120 (Agente 1), SÓ para banco descartável: o mínimo para a 120 aplicar e ser sondada.
create or replace function set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
create table if not exists modulos (id text primary key, nome text not null, categoria text not null check (categoria in ('operacao','integracao')), ordem int not null default 0);
create table if not exists organizacao_modulos (organizacao_id uuid not null, modulo_id text not null);
create table if not exists unidade_modulos (unidade_id uuid not null, modulo_id text not null);
create table if not exists perfis_operacionais (id uuid primary key default gen_random_uuid(), conta_id uuid, ativo boolean not null default true);
create table if not exists usuarios_organizacoes (usuario_id uuid, organizacao_id uuid, ativo boolean default true);
create table if not exists usuarios_unidades (usuario_id uuid, unidade_id uuid, ativo boolean default true);
