-- ROLLBACK da migration 096 (Central de Comunicação: conversas).
-- Remove SOMENTE o que a 096 criou. Não toca em comunicacao_mensagens, na 090 nem nos recibos (095).
-- ATENÇÃO: apaga o texto das mensagens recebidas guardado em comunicacao_inbox_mensagens (não há outra cópia).
begin;

drop function if exists comunicacao_inbox_purgar(integer, integer);
drop function if exists comunicacao_inbox_resumo(uuid, integer);
drop function if exists comunicacao_inbox_marcar_lida(uuid, uuid, timestamptz, uuid);
drop function if exists comunicacao_inbox_registrar(uuid, uuid, text, text, text, text, timestamptz, integer);
drop table if exists comunicacao_inbox_leituras;
drop table if exists comunicacao_inbox_mensagens;
drop view if exists comunicacao_roster_autorizado;
alter table contatos_whatsapp drop column if exists foto_indisponivel_ate;
alter table contatos_whatsapp drop column if exists foto_atualizada_em;
alter table contatos_whatsapp drop column if exists foto_url;

commit;
