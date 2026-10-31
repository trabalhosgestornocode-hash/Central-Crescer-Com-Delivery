-- Rollback da 138 — remove só o livro de reservas do OTP (nada do D-1, dos desafios ou do consentimento depende dele). Idempotente.
begin;
set local lock_timeout = '5s';
drop function if exists comunicacao_otp_registrar_resultado(uuid, text, text);
drop function if exists comunicacao_otp_reservar(uuid, integer, integer, integer);
drop table if exists comunicacao_otp_envios;
commit;
