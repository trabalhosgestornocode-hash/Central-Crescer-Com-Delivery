-- 01 — BACKUP VERIFICADO antes da 0036 (só cópia; nada é alterado). Rodar como o dono do banco. Recusa se a cópia não bater.
begin;
create schema backup_0036_20261128;
create table backup_0036_20261128.concessao_fv2 as select * from financeiro_v2.fv2_concessao;
create table backup_0036_20261128.migracao_fv2 as select * from financeiro_v2.fv2_migracao;
create table backup_0036_20261128.objetos as
  select 'funcao' tipo, p.proname nome, pg_get_functiondef(p.oid) definicao from pg_proc p where p.pronamespace = 'financeiro_v2'::regnamespace and p.proname in ('fv2_vinculo_extrato_posicao', 'fv2_exigir_acao_do_lancamento')
  union all select 'restricao', c.conname, pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'fv2_concessao_acoes_lista'
  union all select 'politica', p.polname, jsonb_build_object('tabela', c.relname, 'using', pg_get_expr(p.polqual, p.polrelid), 'check', pg_get_expr(p.polwithcheck, p.polrelid))::text
    from pg_policy p join pg_class c on c.oid = p.polrelid where c.relnamespace = 'financeiro_v2'::regnamespace and (c.relname, p.polname) in (('fv2_obrigacao', 'fv2_obrigacao_alterar'), ('fv2_lancamento', 'fv2_lancamento_alterar'), ('fv2_contraparte', 'fv2_contraparte_incluir'), ('fv2_historico', 'fv2_historico_incluir'));
do $$ begin
  if (select md5(coalesce(string_agg(to_jsonb(c)::text, '|' order by c.id), '')) from financeiro_v2.fv2_concessao c)
     <> (select md5(coalesce(string_agg(to_jsonb(c)::text, '|' order by c.id), '')) from backup_0036_20261128.concessao_fv2 c) then raise exception '0036 backup: cópia das concessões não confere'; end if;
  if (select md5(coalesce(string_agg(nome || ':' || sha256, '|' order by nome), '')) from financeiro_v2.fv2_migracao)
     <> (select md5(coalesce(string_agg(nome || ':' || sha256, '|' order by nome), '')) from backup_0036_20261128.migracao_fv2) then raise exception '0036 backup: cópia das migrações não confere'; end if;
  if (select count(*) from backup_0036_20261128.objetos) <> 7 then raise exception '0036 backup: funções, restrição e políticas não copiadas'; end if;
end $$;
select (select count(*) from backup_0036_20261128.concessao_fv2) concessoes, (select count(*) from backup_0036_20261128.migracao_fv2) migracoes, (select count(*) from backup_0036_20261128.objetos) objetos,
       (select md5(coalesce(string_agg(to_jsonb(c)::text, '|' order by c.id), '')) from backup_0036_20261128.concessao_fv2 c) hash_concessoes;
commit;
