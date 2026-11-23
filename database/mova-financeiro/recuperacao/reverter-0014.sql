-- MOVA — RECUPERAÇÃO da 0014_mova_unidade_sem_grupo (volta ao estado da 0013). Uma transação; só DEFINIÇÕES.
-- Aborta se houver unidade sem grupo ATIVA (desative antes, conscientemente) ou migração posterior.
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0014_mova_unidade_sem_grupo.sql') then raise exception 'MOVA recuperação: 0014 não está aplicada — nada a desfazer'; end if;
  if exists (select 1 from mova.mova_migracao where nome > '0014_mova_unidade_sem_grupo.sql') then raise exception 'MOVA recuperação: há migrações depois da 0014'; end if;
  if exists (select 1 from mova.unidade_sem_grupo where ativo) then raise exception 'MOVA recuperação: há unidade sem grupo ativa — nada foi feito'; end if;
end $$;
drop table mova.unidade_sem_grupo;
delete from mova.mova_migracao where nome = '0014_mova_unidade_sem_grupo.sql';
