-- Rollback da 137 — remove só o registro de eventos do webhook (nada do D-1/consentimento depende dele). Idempotente.
begin;
set local lock_timeout = '5s';
drop function if exists comunicacao_provedor_registrar_eventos(jsonb);
drop table if exists comunicacao_provedor_eventos;
commit;
