-- MOVA — RECUPERAÇÃO da 0021_mova_core_conhecimento (remove a base de conhecimento do MOVA CORE e a sua trilha). Uma transação.
-- Com conhecimento APROVADO, aborta: exporte antes (as aprovações são decisões de pessoas e precisam ser preservadas).
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0021_mova_core_conhecimento.sql') then raise exception 'MOVA recuperação: 0021 não está aplicada — nada a desfazer'; end if;
  if exists (select 1 from mova.mova_migracao where nome > '0021_mova_core_conhecimento.sql') then raise exception 'MOVA recuperação: há migrações depois da 0021'; end if;
  if exists (select 1 from mova.core_conhecimento where estado = 'APROVADO') then raise exception 'MOVA recuperação: há conhecimento APROVADO — exporte antes'; end if;
end $$;
drop table mova.core_conhecimento_evento;
drop table mova.core_conhecimento;
delete from mova.mova_migracao where nome = '0021_mova_core_conhecimento.sql';
