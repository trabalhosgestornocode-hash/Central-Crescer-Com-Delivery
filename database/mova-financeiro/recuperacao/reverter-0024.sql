-- MOVA — REVERSÃO da 0024 (grupo multiempresa). Só com autorização específica. Antes, desmarque todo grupo compartilhado (o MOVA
-- recusaria a montagem de um grupo com duas empresas sem a marca, e a coluna deixaria de existir).
begin;
do $$ begin
  if exists (select 1 from mova.grupo_autorizado where multiempresa) then raise exception 'MOVA 0024: há grupo marcado multiempresa — desmarque antes; nada foi feito'; end if;
end $$;
alter table mova.grupo_autorizado drop column if exists multiempresa;
delete from mova.mova_migracao where nome = '0024_mova_grupo_multiempresa.sql';
commit;
