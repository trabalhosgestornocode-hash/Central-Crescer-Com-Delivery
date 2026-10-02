-- =====================================================================
-- MIGRATION 105 — WhatsApp: cache de RETRY (reenvio de mensagens que o destinatário não conseguiu decifrar)
-- =====================================================================
-- ⚠️  NÃO APLICAR EM PRODUÇÃO SEM APROVAÇÃO EXPLÍCITA. Escrita e testada SÓ contra um Postgres local descartável
--     (backend/test/whatsapp-retry-cache-migration-pg.test.js). A aplicação é um passo separado.
-- ✅  Puramente ADITIVA: uma tabela nova e três funções novas. NÃO altera whatsapp_conexoes (nem auth_state_encrypted,
--     nem o formato das credenciais) — só LÊ as colunas de lease para o fencing. Rollback: 105_rollback.sql (drop do
--     que esta migration criou; a sessão WhatsApp não é tocada).
--
-- POR QUÊ (auditoria de 2026-10-02): quando um aparelho destinatário não decifra uma mensagem nossa, ele mostra
-- "Aguardando mensagem" e manda um retry receipt; o Baileys só reenvia se o Gateway devolver o CONTEÚDO original em
-- `getMessage`. Retries chegam de 0,5 s a dezenas de horas depois do envio (aparelho offline) — memória do processo não
-- basta (restart/deploy/reconnect a apagam). Este cache é a fonte da verdade desse conteúdo.
--
-- O QUE É GUARDADO (mínimo necessário — ver gateway-whatsapp/src/retryCache.js)
--   provider_message_id  id da mensagem no protocolo (chave de busca do getMessage). UNIQUE por organização+instância.
--   payload_cifrado      `r1:iv:tag:ct` — proto.Message cifrado NO GATEWAY (AES-256-GCM, subchave HKDF própria, AAD =
--                        instância+id). O backend/banco NUNCA tem a chave: não há texto em claro aqui.
--   destino_hash         HMAC (subchave própria do Gateway) do usuário PN destinatário — o Gateway confere antes de
--   destino_lid_hash     reenviar, para nunca entregar o conteúdo a outro usuário. HMAC (não hash puro): telefone tem
--                        pouca entropia e um hash simples seria revertido por força bruta.
--   reenvios/max_reenvios  teto ATÔMICO de reenvios por mensagem (além do contador do próprio Baileys).
--   expires_at           TTL decidido pelo Gateway (faixa 1 h–30 dias imposta aqui). Expirado nunca é devolvido.
--
-- ESCOPO/TENANT: organizacao_id + provider_instance_id = a CONEXÃO (a mesma chave de whatsapp_conexoes), fornecidos pelo
-- backend (config), nunca pelo payload. Toda leitura/escrita é FENCED pela lease da conexão (owner+epoch+validade, tudo
-- com o now() do banco) — o mesmo critério de whatsapp_auth_state_fenced (084): só o dono atual do socket lê conteúdo.
-- RLS ligado e privilégios de anon/authenticated/PUBLIC revogados; só o service_role (backend) executa as funções.
--
-- LIMPEZA: cada gravação apaga até 200 linhas expiradas (oportunista, limitada) e whatsapp_retry_cache_limpar() pode ser
-- chamada por um job. Uma linha expirada nunca é devolvida mesmo antes de ser apagada.
-- =====================================================================

begin;

create table if not exists whatsapp_retry_cache (
  id                    uuid primary key default gen_random_uuid(),
  organizacao_id        uuid not null references organizacoes(id) on delete cascade,
  provider_instance_id  text not null default 'default',
  provider_message_id   text not null,
  payload_cifrado       text not null,
  payload_versao        text not null default 'r1',
  destino_hash          text not null,
  destino_lid_hash      text,
  reenvios              integer not null default 0,
  max_reenvios          integer not null,
  expires_at            timestamptz not null,
  ultimo_reenvio_em     timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint whatsapp_retry_cache_msg_unica unique (organizacao_id, provider_instance_id, provider_message_id),
  constraint whatsapp_retry_cache_id_formato check (provider_message_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  constraint whatsapp_retry_cache_payload_formato check (payload_cifrado ~ '^r1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$' and length(payload_cifrado) <= 131072),
  constraint whatsapp_retry_cache_versao check (payload_versao = 'r1'),
  constraint whatsapp_retry_cache_destino_formato check (destino_hash ~ '^[0-9a-f]{64}$' and (destino_lid_hash is null or destino_lid_hash ~ '^[0-9a-f]{64}$')),
  constraint whatsapp_retry_cache_reenvios check (reenvios >= 0 and max_reenvios between 1 and 50),
  constraint whatsapp_retry_cache_expira check (expires_at > created_at)
);

comment on table whatsapp_retry_cache is
  'Conteúdo CIFRADO (no Gateway) de mensagens WhatsApp enviadas, para reenvio quando o destinatário pede retry (Baileys getMessage). Fonte da verdade do cache de retry; TTL curto; acesso só por funções fenced pela lease da conexão.';
comment on column whatsapp_retry_cache.payload_cifrado is
  'proto.Message cifrado no Gateway (formato r1:iv:tag:ct, AES-256-GCM, AAD instância+id). O backend nunca tem a chave.';
comment on column whatsapp_retry_cache.destino_hash is
  'HMAC-SHA256 (subchave do Gateway) do usuário PN destinatário — nunca o telefone.';

create index if not exists idx_whatsapp_retry_cache_expira on whatsapp_retry_cache (expires_at);

alter table whatsapp_retry_cache enable row level security;
revoke all on whatsapp_retry_cache from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Fencing: o processo informado é o dono ATUAL e VÁLIDO da lease da conexão (now() do banco).
-- ---------------------------------------------------------------------
create or replace function whatsapp_retry_cache_lease_valida(
  p_organizacao_id uuid, p_provider_instance_id text, p_process_id text, p_epoch bigint
) returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.whatsapp_conexoes wc
    where wc.organizacao_id = p_organizacao_id
      and wc.provider_instance_id = p_provider_instance_id
      and wc.lease_owner_id = p_process_id
      and wc.lease_epoch = p_epoch
      and wc.lease_expires_at > now()
  );
$$;

-- ---------------------------------------------------------------------
-- Gravar (idempotente: um id já gravado NUNCA é sobrescrito — impede trocar o conteúdo de uma mensagem já enviada).
-- resultado: GRAVADO | JA_EXISTIA | LEASE_STALE
-- ---------------------------------------------------------------------
create or replace function whatsapp_retry_cache_gravar(
  p_organizacao_id uuid,
  p_provider_instance_id text,
  p_process_id text,
  p_epoch bigint,
  p_provider_message_id text,
  p_payload_cifrado text,
  p_payload_versao text,
  p_destino_hash text,
  p_destino_lid_hash text,
  p_ttl_segundos integer,
  p_max_reenvios integer
) returns table(resultado text, expira_em timestamptz)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_expira timestamptz;
begin
  if p_ttl_segundos is null or p_ttl_segundos < 3600 or p_ttl_segundos > 2592000 then
    raise exception 'p_ttl_segundos fora da faixa permitida (3600..2592000): %', p_ttl_segundos
      using errcode = 'invalid_parameter_value';
  end if;

  if not public.whatsapp_retry_cache_lease_valida(p_organizacao_id, p_provider_instance_id, p_process_id, p_epoch) then
    return query select 'LEASE_STALE'::text, null::timestamptz;
    return;
  end if;

  -- limpeza oportunista e LIMITADA (nunca uma varredura sem teto dentro de um envio)
  delete from public.whatsapp_retry_cache
  where id in (select id from public.whatsapp_retry_cache where expires_at <= now() order by expires_at limit 200);

  v_expira := now() + make_interval(secs => p_ttl_segundos);
  insert into public.whatsapp_retry_cache (
    organizacao_id, provider_instance_id, provider_message_id, payload_cifrado, payload_versao,
    destino_hash, destino_lid_hash, max_reenvios, expires_at
  ) values (
    p_organizacao_id, p_provider_instance_id, p_provider_message_id, p_payload_cifrado, p_payload_versao,
    p_destino_hash, p_destino_lid_hash, p_max_reenvios, v_expira
  )
  on conflict (organizacao_id, provider_instance_id, provider_message_id) do nothing;

  if found then
    return query select 'GRAVADO'::text, v_expira;
  else
    return query select 'JA_EXISTIA'::text, (select wrc.expires_at from public.whatsapp_retry_cache wrc
      where wrc.organizacao_id = p_organizacao_id and wrc.provider_instance_id = p_provider_instance_id
        and wrc.provider_message_id = p_provider_message_id);
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Consumir UM reenvio (atômico: SELECT ... FOR UPDATE + incremento). Só devolve o payload com resultado OK.
-- resultado: OK | NAO_ENCONTRADA | EXPIRADA | ESGOTADA | LEASE_STALE
-- ---------------------------------------------------------------------
create or replace function whatsapp_retry_cache_consumir(
  p_organizacao_id uuid,
  p_provider_instance_id text,
  p_process_id text,
  p_epoch bigint,
  p_provider_message_id text
) returns table(resultado text, payload_cifrado text, payload_versao text, destino_hash text, destino_lid_hash text, reenvios integer, max_reenvios integer)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v public.whatsapp_retry_cache%rowtype;
begin
  if not public.whatsapp_retry_cache_lease_valida(p_organizacao_id, p_provider_instance_id, p_process_id, p_epoch) then
    return query select 'LEASE_STALE'::text, null::text, null::text, null::text, null::text, null::integer, null::integer;
    return;
  end if;

  select * into v from public.whatsapp_retry_cache wrc
  where wrc.organizacao_id = p_organizacao_id and wrc.provider_instance_id = p_provider_instance_id
    and wrc.provider_message_id = p_provider_message_id
  for update;

  if not found then
    return query select 'NAO_ENCONTRADA'::text, null::text, null::text, null::text, null::text, null::integer, null::integer;
    return;
  end if;
  if v.expires_at <= now() then
    delete from public.whatsapp_retry_cache where id = v.id;
    return query select 'EXPIRADA'::text, null::text, null::text, null::text, null::text, null::integer, null::integer;
    return;
  end if;
  if v.reenvios >= v.max_reenvios then
    return query select 'ESGOTADA'::text, null::text, null::text, null::text, null::text, v.reenvios, v.max_reenvios;
    return;
  end if;

  update public.whatsapp_retry_cache
  set reenvios = whatsapp_retry_cache.reenvios + 1, ultimo_reenvio_em = now(), updated_at = now()
  where id = v.id;

  return query select 'OK'::text, v.payload_cifrado, v.payload_versao, v.destino_hash, v.destino_lid_hash, v.reenvios + 1, v.max_reenvios;
end;
$$;

-- ---------------------------------------------------------------------
-- Limpeza explícita (job/manual): apaga até p_limite linhas expiradas; devolve quantas apagou.
-- ---------------------------------------------------------------------
create or replace function whatsapp_retry_cache_limpar(p_limite integer default 1000)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  if p_limite is null or p_limite < 1 or p_limite > 100000 then
    raise exception 'p_limite fora da faixa permitida (1..100000): %', p_limite using errcode = 'invalid_parameter_value';
  end if;
  delete from public.whatsapp_retry_cache
  where id in (select id from public.whatsapp_retry_cache where expires_at <= now() order by expires_at limit p_limite);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function whatsapp_retry_cache_lease_valida(uuid, text, text, bigint) from public, anon, authenticated;
revoke all on function whatsapp_retry_cache_gravar(uuid, text, text, bigint, text, text, text, text, text, integer, integer) from public, anon, authenticated;
revoke all on function whatsapp_retry_cache_consumir(uuid, text, text, bigint, text) from public, anon, authenticated;
revoke all on function whatsapp_retry_cache_limpar(integer) from public, anon, authenticated;

grant execute on function whatsapp_retry_cache_lease_valida(uuid, text, text, bigint) to service_role;
grant execute on function whatsapp_retry_cache_gravar(uuid, text, text, bigint, text, text, text, text, text, integer, integer) to service_role;
grant execute on function whatsapp_retry_cache_consumir(uuid, text, text, bigint, text) to service_role;
grant execute on function whatsapp_retry_cache_limpar(integer) to service_role;

commit;
