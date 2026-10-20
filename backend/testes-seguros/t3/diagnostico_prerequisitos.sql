-- Diagnóstico SOMENTE LEITURA: pré-requisitos das 120–122 e do t3c (semente/encerramento) no banco de testes COMPARTILHADO (doc 23 §3).
-- Rodar só por: node diagnostico_leitura.mjs diagnostico_prerequisitos.sql. Só catálogo; nenhuma linha de negócio é lida.
\set ON_ERROR_STOP on
\pset footer off
begin transaction read only;
set local statement_timeout = '20s';
do $$ begin
  if current_setting('transaction_read_only') <> 'on' then raise exception 'RECUSADO: a sessão não está em modo somente leitura.'; end if;
end $$;

\echo '== 1. colunas que as 120–122 e o t3c usam (falta = linha com existe=f)'
select x.tabela, x.coluna, exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = x.tabela and c.column_name = x.coluna) as existe
  from (values ('organizacoes','id'), ('organizacoes','nome'), ('organizacoes','ativo'), ('unidades','id'), ('unidades','organizacao_id'), ('unidades','nome'), ('unidades','ativo'),
               ('modulos','id'), ('modulos','nome'), ('modulos','categoria'), ('modulos','ordem'), ('organizacao_modulos','organizacao_id'), ('organizacao_modulos','modulo_id'),
               ('unidade_modulos','unidade_id'), ('unidade_modulos','modulo_id'), ('perfis_operacionais','id'), ('perfis_operacionais','conta_id'), ('perfis_operacionais','ativo'),
               ('usuarios_organizacoes','usuario_id'), ('usuarios_organizacoes','organizacao_id'), ('usuarios_organizacoes','ativo'),
               ('usuarios_unidades','usuario_id'), ('usuarios_unidades','unidade_id'), ('usuarios_unidades','ativo'),
               ('plataforma_auditoria','organizacao_id')) x(tabela, coluna)
 order by existe, 1, 2;

\echo '== 2. colunas NOT NULL sem default em organizacoes/unidades/organizacao_modulos/unidade_modulos (a semente só preenche id, nome, organizacao_id, modulo_id)'
select table_name, column_name, data_type from information_schema.columns
 where table_schema = 'public' and table_name in ('organizacoes','unidades','organizacao_modulos','unidade_modulos') and is_nullable = 'NO' and column_default is null
 order by 1, 2;

\echo '== 3. gatilhos em organizacoes/unidades/módulos (efeitos colaterais da semente/encerramento)'
select tgrelid::regclass as tabela, tgname, tgfoid::regproc as funcao, tgenabled,
       case when tgtype & 4 = 4 then 'INSERT ' else '' end || case when tgtype & 16 = 16 then 'UPDATE ' else '' end || case when tgtype & 8 = 8 then 'DELETE' else '' end as eventos
  from pg_trigger where not tgisinternal and tgrelid in ('public.organizacoes'::regclass, 'public.unidades'::regclass, 'public.organizacao_modulos'::regclass, 'public.unidade_modulos'::regclass)
 order by 1, 2;

\echo '== 4. funções e catálogo que a 120 pressupõe'
select to_regprocedure('public.set_updated_at()') is not null as set_updated_at,
       to_regprocedure('public.remapear_organizacao_em_tabelas_de_unidade(uuid,uuid,uuid)') is not null as remapear_054,
       to_regprocedure('public.transferir_unidade_organizacao(uuid,uuid,uuid,text,text,text)') is not null as transferir,
       (select count(*) from public.modulos where id = 'gestao_financeira') as ja_tem_gestao_financeira,
       (select count(*) from public.modulos where ordem = 17) as ordem_17_ocupada,
       (select string_agg(pg_get_constraintdef(oid), ' | ') from pg_constraint where conrelid = 'public.modulos'::regclass and contype = 'c') as checks_modulos,
       (select count(*) from pg_class where relnamespace = 'public'::regnamespace and (relname like 'fin\_%' or relname like 'gestao\_financeira\_%' or relname like 'gfc\_%')) as nomes_financeiros_em_uso,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'fin\_%' or proname like 'gfc\_%' or proname like 'gestao\_financeira\_%')) as funcoes_financeiras_em_uso;

\echo '== 5. ids e nomes da allowlist do t3c (devem estar LIVRES)'
select (select count(*) from public.organizacoes where id::text like '00000000-0000-0000-0000-0000000f1a%') as orgs_allowlist,
       (select count(*) from public.unidades where id::text like '00000000-0000-0000-0000-0000000f1a%') as unidades_allowlist,
       (select count(*) from public.organizacoes where nome like '[T3-FIN]%') as nomes_t3_fin,
       (select count(*) from public.organizacao_modulos where modulo_id = 'gestao_financeira') + (select count(*) from public.unidade_modulos where modulo_id = 'gestao_financeira') as habilitacoes_financeiro;

\echo '== 6. gatilho de evento que liga RLS em tabela nova (afeta o CREATE TABLE das 120–122)'
select e.evtname, e.evtevent, e.evtenabled, e.evttags, p.proname, pg_get_userbyid(p.proowner) as dono, p.prosecdef as definer,
       md5(p.prosrc) as md5_corpo, left(regexp_replace(p.prosrc, '\s+', ' ', 'g'), 400) as inicio_do_corpo
  from pg_event_trigger e join pg_proc p on p.oid = e.evtfoid order by 1;

\echo '== 7. papel postgres: pode SET ROLE para service_role/anon/authenticated (as provas usam)?'
select r as papel, pg_has_role('postgres', r, 'MEMBER') as membro, pg_has_role('postgres', r, 'SET') as pode_set_role
  from unnest(array['service_role','anon','authenticated']) r;
rollback;
