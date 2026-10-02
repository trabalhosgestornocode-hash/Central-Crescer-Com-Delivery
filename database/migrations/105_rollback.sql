-- ROLLBACK da MIGRATION 105 — remove SÓ o cache de retry. Não toca em whatsapp_conexoes (auth state, lease, credenciais):
-- a sessão WhatsApp conectada continua intacta. Antes de aplicar, desligue WHATSAPP_RETRY_RESEND_ENABLED no Gateway (com a
-- flag desligada nada chama estas funções; com ela ligada e a tabela ausente, o Gateway cai para a memória e loga a falha).
begin;
drop function if exists whatsapp_retry_cache_limpar(integer);
drop function if exists whatsapp_retry_cache_consumir(uuid, text, text, bigint, text);
drop function if exists whatsapp_retry_cache_gravar(uuid, text, text, bigint, text, text, text, text, text, integer, integer);
drop function if exists whatsapp_retry_cache_lease_valida(uuid, text, text, bigint);
drop table if exists whatsapp_retry_cache;
commit;
