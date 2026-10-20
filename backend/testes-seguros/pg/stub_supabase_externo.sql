-- Stub MÍNIMO dos schemas que o Supabase fornece (auth, storage, realtime) para aplicar a cadeia de migrations da main num PostgreSQL
-- LOCAL DESCARTÁVEL. Rodar como superusuário local, antes das migrations. Não reproduz o comportamento do Supabase; só permite
-- que as referências (FKs para auth.users, auth.uid(), storage.buckets, policies em realtime.messages) existam.
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key, email text, phone text, raw_user_meta_data jsonb default '{}'::jsonb, raw_app_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now(), last_sign_in_at timestamptz, deleted_at timestamptz,
  banned_until timestamptz, email_confirmed_at timestamptz, is_sso_user boolean default false, is_anonymous boolean default false
);
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(auth.jwt() ->> 'role', current_user::text) $$;
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key, name text not null, owner uuid, public boolean default false, avif_autodetection boolean default false,
  file_size_limit bigint, allowed_mime_types text[], owner_id text, created_at timestamptz default now(), updated_at timestamptz default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid, owner_id text,
  metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now()
);
alter table storage.objects enable row level security;
create schema if not exists realtime;
create table if not exists realtime.messages (
  id bigint generated always as identity primary key, topic text not null, extension text not null, payload jsonb, event text,
  private boolean default false, inserted_at timestamptz default now(), updated_at timestamptz default now()
);
alter table realtime.messages enable row level security;
create or replace function realtime.topic() returns text language sql stable as $$ select nullif(current_setting('realtime.topic', true), '') $$;
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then create publication supabase_realtime; end if;
end $$;
grant usage on schema auth, storage, realtime to public;
grant select, references on auth.users to public;
grant all on storage.buckets, storage.objects, realtime.messages to public;
grant execute on all functions in schema auth, realtime to public;
-- No Supabase, quem roda as migrations (postgres) administra estes objetos; aqui esse papel é o dono_sim (não-superusuário).
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'dono_sim') then
    alter table realtime.messages owner to dono_sim; alter table storage.buckets owner to dono_sim; alter table storage.objects owner to dono_sim;
    alter publication supabase_realtime owner to dono_sim;
  end if;
end $$;
