-- ROLLBACK da migration 097 (WhatsApp: aba Conexão). Remove SOMENTE o que a 097 criou.
-- Não toca whatsapp_conexoes, o outbox, o inbox (096) nem os recibos (095). Apaga a identidade interna e as permissões específicas (sem outra cópia).
begin;

drop function if exists whatsapp_operacao_encerrar(uuid, text, uuid);
drop function if exists whatsapp_operacao_iniciar(uuid, text, text, uuid, integer);
drop table if exists whatsapp_identidade;
drop table if exists painel_adm_permissoes;

commit;
