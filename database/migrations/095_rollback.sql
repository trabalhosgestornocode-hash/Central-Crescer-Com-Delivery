-- Rollback da MIGRATION 095 (persistência de confirmações de entrega do provider).
-- Remove a RPC e o índice. Status DELIVERED/READ já gravados permanecem (são linhas normais).
begin;

drop function if exists comunicacao_registrar_status_provider(uuid, text, text, timestamptz, text);
drop index if exists idx_comunicacao_mensagens_provider_msg;

notify pgrst, 'reload schema';
commit;
