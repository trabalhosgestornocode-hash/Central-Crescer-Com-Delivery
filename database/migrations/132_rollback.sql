-- Rollback da 132 — remove o convite de usuário e as colunas de fuso/horário da unidade.
-- ATENÇÃO: apaga convites pendentes e o fuso/horário configurados nas unidades (exportar antes, se houver). Idempotente.
begin;
set local lock_timeout = '5s';
drop function if exists usuarios_convite_consumir(text, text, uuid);
drop table if exists usuarios_convites;
drop function if exists usuarios_convites_coerencia();
drop trigger if exists trg_unidades_validar_fuso_horario on unidades;
drop function if exists unidades_validar_fuso_horario();
alter table unidades drop column if exists horario_funcionamento;
alter table unidades drop column if exists timezone;
commit;
