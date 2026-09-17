-- =====================================================================
-- ROLLBACK — MIGRATION 085 (desired_connection_state + whatsapp_desired_state_fenced)
-- =====================================================================
-- Remove com segurança só o que a 085 cria: a função nova e a coluna nova.
-- NUNCA toca lease_*/auth_state_*/status nem qualquer outro dado da
-- tabela — nenhuma sessão WhatsApp real é afetada.
begin;

drop function if exists whatsapp_desired_state_fenced(uuid, text, text, bigint, text);

alter table whatsapp_conexoes
  drop column if exists desired_connection_state;

commit;
