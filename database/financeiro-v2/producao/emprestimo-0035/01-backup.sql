-- 01 — BACKUP antes da 0035 (só cópia; nada é alterado). Revisar antes de aplicar.
begin;
create schema if not exists backup_0035_20261127;
create table backup_0035_20261127.concessao_fv2 as select * from financeiro_v2.fv2_concessao;
create table backup_0035_20261127.migracao_fv2 as select * from financeiro_v2.fv2_migracao;
create table backup_0035_20261127.objetos as
  select 'funcao' tipo, p.proname nome, pg_get_functiondef(p.oid) definicao from pg_proc p where p.pronamespace = 'financeiro_v2'::regnamespace and p.proname in ('fv2_obrigacao_documental')
  union all select 'restricao', c.conname, pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'fv2_concessao_acoes_lista';
select (select count(*) from backup_0035_20261127.concessao_fv2) concessoes, (select count(*) from backup_0035_20261127.migracao_fv2) migracoes, (select count(*) from backup_0035_20261127.objetos) objetos;
commit;
