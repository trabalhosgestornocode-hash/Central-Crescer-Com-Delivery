-- Rollback da MIGRATION 090 (whatsapp_inbound_mensagens). Remove a função e a tabela (e os eventos inbound persistidos nela).
drop function if exists whatsapp_inbound_registrar(uuid, text, text, text, text, text, boolean, boolean, text, boolean, text, timestamptz);
drop table if exists whatsapp_inbound_mensagens;
