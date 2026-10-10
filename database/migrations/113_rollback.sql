-- Rollback da 113: remove só a constraint e o índice (não mexe em dado algum).
begin;
set local lock_timeout = '5s';
alter table usuarios_organizacoes drop constraint if exists uo_sem_papel_exibicao;
drop index if exists uq_usuarios_unidades_exibicao_unica;
commit;
