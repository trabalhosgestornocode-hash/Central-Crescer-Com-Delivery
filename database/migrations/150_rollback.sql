-- Rollback da 150 — remove a trava de concorrência no banco (volta a valer só a trava da aplicação). Idempotente; não toca dados.
begin;
set local lock_timeout = '5s';
drop index if exists public.foody_sync_execucoes_uma_em_andamento;
commit;
