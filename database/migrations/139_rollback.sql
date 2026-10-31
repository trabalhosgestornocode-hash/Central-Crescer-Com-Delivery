-- Rollback da 139 — remove só a trava de convites por unidade (nenhum dado depende dela). Idempotente.
begin;
set local lock_timeout = '5s';
drop trigger if exists trg_comunicacao_convites_piloto on comunicacao_convites;
drop function if exists comunicacao_convites_piloto_guard();
commit;
