-- 137 — Webhook de status de entrega do provedor oficial (Meta WhatsApp Cloud API). SÓ registra eventos de status.
--
-- Idempotente por construção: a chave primária é `provedorId:status` (a Meta reentrega o mesmo evento); o RPC usa
-- `on conflict do nothing`, então duas entregas simultâneas do mesmo payload gravam UMA linha. Sem telefone, sem texto de mensagem,
-- sem corpo bruto: só id do provedor, status e código de erro. Não toca no D-1, em cotas, destinatários ou consentimentos.
-- Escrita só pelo RPC (service_role); RLS ligada e sem política. Rollback: 137_rollback.sql.
begin;
set local lock_timeout = '5s';

create table if not exists comunicacao_provedor_eventos (
  chave           text primary key check (chave ~ '^[A-Za-z0-9._=:-]{3,255}$'),
  provedor        text not null default 'meta_whatsapp' check (provedor in ('meta_whatsapp')),
  provedor_msg_id text not null check (length(provedor_msg_id) between 1 and 200),
  status          text not null check (status ~ '^[a-z_]{1,30}$'),
  codigo_erro     integer check (codigo_erro is null or codigo_erro between 0 and 999999),
  recebido_em     timestamptz not null default now(),
  constraint comunicacao_provedor_eventos_chave_coerente check (chave = provedor_msg_id || ':' || status)
);
create index if not exists comunicacao_provedor_eventos_msg_idx on comunicacao_provedor_eventos (provedor_msg_id, recebido_em);
alter table comunicacao_provedor_eventos enable row level security;

create or replace function comunicacao_provedor_registrar_eventos(p jsonb) returns integer
language plpgsql security invoker set search_path = public as $$
declare n integer;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 200 then
    raise exception 'eventos inválidos' using errcode = '22023';
  end if;
  insert into comunicacao_provedor_eventos (chave, provedor_msg_id, status, codigo_erro)
  select e.chave, e.provedor_msg_id, e.status, e.codigo_erro
    from jsonb_to_recordset(p) as e(chave text, provedor_msg_id text, status text, codigo_erro integer)
  on conflict (chave) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

do $$
declare papel text;
begin
  foreach papel in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if papel = 'public' or exists (select 1 from pg_roles where rolname = papel) then
      execute format('revoke all on table comunicacao_provedor_eventos from %s', papel);
      execute format('revoke all on function comunicacao_provedor_registrar_eventos(jsonb) from %s', papel);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert on table comunicacao_provedor_eventos to service_role;
    grant execute on function comunicacao_provedor_registrar_eventos(jsonb) to service_role;
  end if;
end $$;
commit;
