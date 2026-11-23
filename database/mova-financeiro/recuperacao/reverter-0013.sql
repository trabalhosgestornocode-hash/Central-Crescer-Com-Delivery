-- MOVA — RECUPERAÇÃO da 0013_mova_entregadores_cadastro (volta ao estado anterior). Uma transação; só DEFINIÇÕES.
-- Aborta sem mudar nada se já houver dado que dependa da 0013 (observação, quem encerrou, motivo): decidir antes.
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0013_mova_entregadores_cadastro.sql') then raise exception 'MOVA recuperação: 0013 não está aplicada — nada a desfazer'; end if;
  if exists (select 1 from mova.mova_migracao where nome > '0013_mova_entregadores_cadastro.sql') then raise exception 'MOVA recuperação: há migrações depois da 0013'; end if;
  if exists (select 1 from mova.entregador_autorizado where observacoes is not null or revogado_por is not null or motivo_revogacao is not null) then raise exception 'MOVA recuperação: há cadastro que usa a 0013 — nada foi feito'; end if;
end $$;
revoke insert (observacoes) on mova.entregador_autorizado from mova_app;
revoke update (revogado_por, motivo_revogacao) on mova.entregador_autorizado from mova_app;
alter table mova.entregador_autorizado drop column motivo_revogacao, drop column revogado_por, drop column observacoes;
delete from mova.mova_migracao where nome = '0013_mova_entregadores_cadastro.sql';
