-- Reversão da migração 0029 (identidade fiscal). Só rodar com o MOVA de entregadores DESLIGADO.
-- As tabelas guardam o conhecimento fiscal aprendido e a trilha das evidências: são renomeadas (preservadas), nunca apagadas.
begin;
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0029_mova_identidade_fiscal.sql') then raise exception 'MOVA recuperação: 0029 não está aplicada — nada a desfazer'; end if;
  if exists (select 1 from mova.mova_migracao where nome > '0029_mova_identidade_fiscal.sql') then raise exception 'MOVA recuperação: há migrações depois da 0029 — desfazer essas primeiro'; end if;
end $$;
alter table mova.identidade_fiscal rename to identidade_fiscal_revertida_0029;
alter table mova.identidade_fiscal_vinculo rename to identidade_fiscal_vinculo_revertida_0029;
alter table mova.identidade_fiscal_evidencia rename to identidade_fiscal_evidencia_revertida_0029;
alter table mova.identidade_fiscal_tomador rename to identidade_fiscal_tomador_revertida_0029;
alter table mova.nota_leitura_fiscal rename to nota_leitura_fiscal_revertida_0029;
delete from mova.mova_migracao where nome = '0029_mova_identidade_fiscal.sql';
commit;
