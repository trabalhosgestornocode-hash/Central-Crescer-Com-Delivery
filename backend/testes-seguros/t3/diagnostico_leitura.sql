-- Diagnóstico SOMENTE LEITURA do banco de testes COMPARTILHADO (doc 19 §6, Grupo A). Rodar só por diagnostico_leitura.mjs, que:
-- recusa produção, exige o ref do projeto de testes e abre a sessão com default_transaction_read_only=on.
-- Aqui: transação READ ONLY + conferência explícita; só SELECT em catálogo/contagens. Nenhuma escrita, nenhuma função de negócio chamada.
\set ON_ERROR_STOP on
\pset footer off
begin transaction read only;
set local statement_timeout = '20s';
do $$ begin
  if current_setting('transaction_read_only') <> 'on' or current_setting('default_transaction_read_only') <> 'on' then
    raise exception 'RECUSADO: a sessão não está em modo somente leitura.';
  end if;
end $$;

\echo '== 1. servidor'
select version() as versao, current_user as usuario, current_database() as banco, current_setting('transaction_read_only') as somente_leitura;

\echo '== 2. migrations registradas (supabase_migrations)'
select to_regclass('supabase_migrations.schema_migrations') is not null as tem_mig \gset
\if :tem_mig
select count(*) as qtd, min(version) as primeira, max(version) as ultima from supabase_migrations.schema_migrations;
select string_agg(version || coalesce(':' || name, ''), ', ' order by version) as versoes from supabase_migrations.schema_migrations;
\else
\echo 'supabase_migrations.schema_migrations AUSENTE (migrations aplicadas manualmente pelo SQL Editor?)'
\endif

\echo '== 3. papéis'
select rolname, rolsuper, rolbypassrls, rolcanlogin, rolinherit from pg_roles
 where rolname in ('postgres','service_role','anon','authenticated','authenticator','supabase_admin','dashboard_user') order by rolname;
select r.rolname as papel, string_agg(m.rolname, ',' order by m.rolname) as membro_de from pg_roles r
  join pg_auth_members am on am.member = r.oid join pg_roles m on m.oid = am.roleid
 where r.rolname in ('postgres','service_role','authenticator') group by r.rolname order by 1;

\echo '== 4. donos das tabelas do public'
select pg_get_userbyid(c.relowner) as dono, count(*) as tabelas, count(*) filter (where c.relrowsecurity) as com_rls,
       count(*) filter (where c.relforcerowsecurity) as force_rls
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' group by 1 order by 2 desc;

\echo '== 5. objetos financeiros (devem estar AUSENTES)'
select count(*) filter (where relname like 'fin\_%') as tabelas_fin, count(*) filter (where relname like 'gestao\_financeira\_%') as tabelas_gf
  from pg_class where relnamespace = 'public'::regnamespace;
select count(*) as funcoes_fin_gfc from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'fin\_%' or proname like 'gfc\_%' or proname like 'gestao\_financeira\_%');
select id, nome, categoria, ordem from public.modulos order by ordem;
select pg_get_constraintdef(oid) as check_modulos_categoria from pg_constraint where conrelid = 'public.modulos'::regclass and contype = 'c';

\echo '== 6. funções compartilhadas tocadas pela 120/121 (dono, segurança, ACL, assinatura do corpo)'
select p.oid::regprocedure as funcao, pg_get_userbyid(p.proowner) as dono, p.prosecdef as definer, p.proconfig as config,
       p.proacl::text as acl, md5(p.prosrc) as md5_corpo, length(p.prosrc) as tam,
       md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) as md5_normalizado,   -- compara com a main sem depender de CRLF/espaços
       pg_has_role('postgres', p.proowner, 'USAGE') as postgres_administra
  from pg_proc p where p.pronamespace = 'public'::regnamespace
   and p.proname in ('remapear_organizacao_em_tabelas_de_unidade','transferir_unidade_organizacao','promover_unidade_para_empresa',
                     'converter_empresa_para_unidade','excluir_organizacao_definitivamente','set_updated_at','rls_auto_enable')
 order by 1::text;
select strpos(p.prosrc, 'on conflict (usuario_id, organizacao_id)') > 0 as promover_usa_conflito_antigo
  from pg_proc p where p.oid = to_regprocedure('public.promover_unidade_para_empresa(uuid,uuid,text,text,text,text,uuid)')
     or (p.pronamespace = 'public'::regnamespace and p.proname = 'promover_unidade_para_empresa') limit 1;
select indexrelid::regclass as indice, pg_get_indexdef(indexrelid) as def from pg_index
 where indrelid = 'public.usuarios_organizacoes'::regclass and indisunique;

\echo '== 7. gatilhos de evento (ex.: rls_auto_enable) e default privileges'
select evtname, evtevent, evtfoid::regproc as funcao, evtenabled, evttags from pg_event_trigger order by 1;
select pg_get_userbyid(d.defaclrole) as papel, d.defaclnamespace::regnamespace as schema, d.defaclobjtype as tipo, d.defaclacl::text as acl
  from pg_default_acl d order by 1, 3;

\echo '== 8. tabelas que remapear_* varreria hoje (org + unidade) e privilégio do service_role nelas'
select c1.table_name as tabela, has_table_privilege('service_role', format('public.%I', c1.table_name), 'update') as sr_update
  from information_schema.columns c1
  join information_schema.columns c2 on c2.table_schema = c1.table_schema and c2.table_name = c1.table_name and c2.column_name = 'unidade_id'
  join information_schema.tables t on t.table_schema = c1.table_schema and t.table_name = c1.table_name and t.table_type = 'BASE TABLE'
 where c1.table_schema = 'public' and c1.column_name = 'organizacao_id'
   and c1.table_name not in ('martin_brower_vinculos','sessoes_contexto','insumo_historico')
 order by 1;
select has_table_privilege('service_role', 'public.unidades', 'update') as service_role_update_unidades,
       has_table_privilege('service_role', 'public.unidades', 'select') as service_role_select_unidades;
select tgname, tgrelid::regclass as tabela, tgfoid::regproc as funcao from pg_trigger where tgrelid = 'public.unidades'::regclass and not tgisinternal order by 1;

\echo '== 9. extensões e dependências usadas pelas 120–122'
select extname, extversion, extnamespace::regnamespace as schema from pg_extension order by 1;
select to_regprocedure('public.gen_random_uuid()') is not null or to_regprocedure('pg_catalog.gen_random_uuid()') is not null as gen_random_uuid,
       to_regprocedure('pg_catalog.sha256(bytea)') is not null as sha256;

\echo '== 10. dados (só contagens) e organizações de teste'
select (select count(*) from public.organizacoes) as organizacoes, (select count(*) from public.unidades) as unidades,
       (select count(*) from public.organizacao_modulos) as org_modulos, (select count(*) from public.unidade_modulos) as unidade_modulos;
select count(*) filter (where id::text like '00000000-0000-0000-0000-0000000000%') as orgs_ids_sinteticos,
       count(*) filter (where nome like '[T3-FIN]%') as orgs_t3_fin from public.organizacoes;

\echo '== 11. atividade no momento (outras sessões; sem texto de consulta)'
select usename, application_name, state, count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()
 group by 1, 2, 3 order by 4 desc limit 15;
rollback;
