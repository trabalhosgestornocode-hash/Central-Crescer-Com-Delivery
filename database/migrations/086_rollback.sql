-- =====================================================================
-- ROLLBACK — MIGRATION 086 (auth_session_id + auth_confirmado)
-- =====================================================================
-- Remove só o que a 086 cria: a constraint, as duas colunas novas, a RPC
-- nova, e reverte whatsapp_auth_state_fenced/whatsapp_heartbeat_fenced para
-- a forma da migration 084 (sem auth_session_id/auth_confirmado). NUNCA
-- toca lease_*/desired_connection_state/status/auth_state_encrypted em si
-- — nenhuma sessão WhatsApp real é afetada além de perder os dois campos
-- novos (o ciphertext e a versão do auth continuam intactos).
begin;

drop function if exists whatsapp_auth_confirmado_fenced(uuid, text, text, bigint, uuid);

-- whatsapp_heartbeat_fenced volta à forma da 084 (mesma assinatura, corpo
-- sem a coluna auth_confirmado).
create or replace function whatsapp_heartbeat_fenced(
  p_organizacao_id uuid,
  p_provider_instance_id text,
  p_process_id text,
  p_epoch bigint,
  p_status text,
  p_telefone text,
  p_gateway_version text,
  p_last_error_class text
) returns table(ok boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_now timestamptz := now();
begin
  update public.whatsapp_conexoes
  set last_seen_at = v_now,
      status = coalesce(p_status, status),
      telefone_e164 = coalesce(p_telefone, telefone_e164),
      gateway_version = coalesce(p_gateway_version, gateway_version),
      last_error_class = coalesce(p_last_error_class, last_error_class),
      connected_at = case when p_status = 'CONNECTED' then v_now else connected_at end,
      disconnected_at = case when p_status in ('DISCONNECTED', 'LOGGED_OUT') then v_now else disconnected_at end
  where organizacao_id = p_organizacao_id
    and provider_instance_id = p_provider_instance_id
    and lease_owner_id = p_process_id
    and lease_epoch = p_epoch
    and lease_expires_at > now();

  return query select found;
end;
$$;

-- whatsapp_auth_state_fenced volta a devolver só (ok) — DROP+CREATE de
-- novo, porque o RETURNS muda (perde auth_session_id).
drop function if exists whatsapp_auth_state_fenced(uuid, text, text, bigint, text, text);

create function whatsapp_auth_state_fenced(
  p_organizacao_id uuid,
  p_provider_instance_id text,
  p_process_id text,
  p_epoch bigint,
  p_auth_state_encrypted text,
  p_auth_state_version text
) returns table(ok boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  update public.whatsapp_conexoes
  set auth_state_encrypted = p_auth_state_encrypted,
      auth_state_version = p_auth_state_version
  where organizacao_id = p_organizacao_id
    and provider_instance_id = p_provider_instance_id
    and lease_owner_id = p_process_id
    and lease_epoch = p_epoch
    and lease_expires_at > now();

  return query select found;
end;
$$;

revoke all on function whatsapp_auth_state_fenced(uuid, text, text, bigint, text, text) from public, anon, authenticated;
revoke all on function whatsapp_heartbeat_fenced(uuid, text, text, bigint, text, text, text, text) from public, anon, authenticated;
grant execute on function whatsapp_auth_state_fenced(uuid, text, text, bigint, text, text) to service_role;
grant execute on function whatsapp_heartbeat_fenced(uuid, text, text, bigint, text, text, text, text) to service_role;

alter table whatsapp_conexoes
  drop constraint if exists whatsapp_conexoes_auth_confirmado_integridade;

alter table whatsapp_conexoes
  drop column if exists auth_session_id,
  drop column if exists auth_confirmado;

commit;
