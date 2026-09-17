-- =====================================================================
-- ROLLBACK — MIGRATION 084 (lease/fencing em whatsapp_conexoes)
-- =====================================================================
-- Remove com segurança só o que a 084 cria: as 5 funções e as 3 colunas de
-- lease. NUNCA toca auth_state_encrypted/auth_state_version nem qualquer
-- outro dado da tabela — nenhuma sessão WhatsApp real pareada é afetada.
begin;

drop function if exists whatsapp_lease_acquire(uuid, text, text, bigint);
drop function if exists whatsapp_lease_renew(uuid, text, text, bigint, bigint);
drop function if exists whatsapp_lease_release(uuid, text, text, bigint);
drop function if exists whatsapp_heartbeat_fenced(uuid, text, text, bigint, text, text, text, text);
drop function if exists whatsapp_auth_state_fenced(uuid, text, text, bigint, text, text);

-- Nenhum índice de lease foi criado por esta versão da migration (revisão
-- Checkpoint C3.5-A removeu o índice decorativo antes de aplicar em
-- qualquer banco) — nada a derrubar aqui além das colunas.

alter table whatsapp_conexoes
  drop column if exists lease_owner_id,
  drop column if exists lease_epoch,
  drop column if exists lease_expires_at;

commit;
