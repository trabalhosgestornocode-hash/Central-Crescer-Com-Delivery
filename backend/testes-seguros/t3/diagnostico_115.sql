-- Diagnóstico SOMENTE LEITURA: alvos da migration 115 no banco de testes COMPARTILHADO (pré-voo do T3, doc 23).
-- Rodar só por: node diagnostico_leitura.mjs diagnostico_115.sql (recusa produção, sessão default_transaction_read_only=on).
-- Só SELECT em catálogo + contagens nas 4 views. NÃO chama nenhuma das 7 funções (nem para provar exploração).
\set ON_ERROR_STOP on
\pset footer off
begin transaction read only;
set local statement_timeout = '20s';
do $$ begin
  if current_setting('transaction_read_only') <> 'on' or current_setting('default_transaction_read_only') <> 'on' then
    raise exception 'RECUSADO: a sessão não está em modo somente leitura.';
  end if;
end $$;

\set alvos_v '(select unnest(array[''vw_estoque_critico'',''vw_faturamento_diario'',''vw_produto_margem'',''vw_produtos_vendidos'']) as nome)'
\set alvos_f '(select unnest(array[''bonificacao_congelar_competencia'',''bonificacao_reabrir_competencia'',''converter_empresa_para_unidade'',''excluir_organizacao_definitivamente'',''promover_unidade_para_empresa'',''remapear_organizacao_em_tabelas_de_unidade'',''transferir_unidade_organizacao'']) as nome)'
-- (variáveis do psql: nenhum objeto é criado; transação READ ONLY não aceita CREATE)

\echo '== 1. sessão'
select current_user as usuario, current_setting('transaction_read_only') as somente_leitura,
       pg_has_role(current_user, 'postgres', 'USAGE') as administra_postgres;

\echo '== 2. views-alvo: existência, dono, security_invoker, ACL e privilégio EFETIVO'
select a.nome, c.oid is not null as existe, pg_get_userbyid(c.relowner) as dono,
       coalesce(array_to_string(c.reloptions, ','), '') as opcoes,
       c.relacl::text as acl,
       has_table_privilege('anon', c.oid, 'select') as anon_select,
       has_table_privilege('authenticated', c.oid, 'select') as auth_select,
       has_table_privilege('service_role', c.oid, 'select') as sr_select
  from :alvos_v a left join pg_class c on c.relname = a.nome and c.relnamespace = 'public'::regnamespace and c.relkind in ('v','m')
 order by 1;

\echo '== 3. funções-alvo: sobrecargas, dono, definer, ACL e EXECUTE efetivo'
select a.nome, p.oid::regprocedure as assinatura, pg_get_userbyid(p.proowner) as dono, p.prosecdef as definer, p.proconfig as config,
       p.proacl::text as acl,
       exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0 and x.privilege_type = 'EXECUTE') as public_execute,
       has_function_privilege('anon', p.oid, 'execute') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
       has_function_privilege('service_role', p.oid, 'execute') as sr_exec
  from :alvos_f a left join pg_proc p on p.proname = a.nome and p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
 order by 1, 2::text;

\echo '== 4. verificações internas de autorização no CORPO (texto, sem executar)'
select p.proname,
       p.prosrc ~* 'auth\.uid\(\)'            as usa_auth_uid,
       p.prosrc ~* 'auth\.(role|jwt)\(\)'     as usa_auth_role_jwt,
       p.prosrc ~* 'is_platform_superadmin|auth_is_|superadmin' as usa_helper_superadmin,
       p.prosrc ~* 'current_user|session_user' as usa_current_user,
       p.prosrc ~* 'has_(table|function)_privilege' as checa_privilegio,
       (select count(*) from regexp_matches(p.prosrc, 'raise\s+exception', 'gi')) as qtd_raise,
       p.prosrc ~* 'execute\s+format' as sql_dinamico
  from pg_proc p join :alvos_f a on a.nome = p.proname where p.pronamespace = 'public'::regnamespace order by 1;

\echo '== 5. tabelas citadas no corpo das funções-alvo × RLS × policies de escrita para anon/authenticated/public'
with tab as (
  select distinct p.proname as funcao, c.relname as tabela, c.relrowsecurity as rls, c.relforcerowsecurity as force_rls
    from pg_proc p join :alvos_f a on a.nome = p.proname
    join pg_class c on c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and p.prosrc ~* ('(update|insert\s+into|delete\s+from)\s+(public\.)?' || c.relname || '\M')
   where p.pronamespace = 'public'::regnamespace)
select t.funcao, t.tabela, t.rls, t.force_rls,
       has_table_privilege('anon', ('public.' || t.tabela)::regclass, 'update') as anon_grant_update,
       has_table_privilege('authenticated', ('public.' || t.tabela)::regclass, 'update') as auth_grant_update,
       coalesce((select string_agg(pp.policyname || '[' || pp.cmd || ':' || array_to_string(pp.roles, '/') || ']', '; ' order by pp.policyname)
                   from pg_policies pp where pp.schemaname = 'public' and pp.tablename = t.tabela
                    and pp.cmd in ('ALL','INSERT','UPDATE','DELETE')
                    and pp.roles && array['anon','authenticated','public']::name[]), '(nenhuma)') as policies_escrita_anon_auth
  from tab t order by 1, 2;

select pp.tablename, pp.policyname, pp.cmd, array_to_string(pp.roles, '/') as roles, pp.qual, pp.with_check
  from pg_policies pp where pp.schemaname = 'public'
   and pp.tablename in ('unidades','organizacoes','plataforma_auditoria','bonificacao_competencia','bonificacao_competencia_snapshot','bonificacao_fechamento_mensal','usuarios_organizacoes','sessoes_contexto')
 order by 1, 2;
select p.proname, p.prosrc ~* 'insert\s+into\s+(public\.)?plataforma_auditoria' as grava_plataforma_auditoria
  from pg_proc p join :alvos_f a on a.nome = p.proname where p.pronamespace = 'public'::regnamespace order by 1;

\echo '== 6. views-alvo: dono ignora RLS? tabelas-base e volume exposto (contagem, sem ler linhas)'
select r.rolname as dono_views, r.rolbypassrls as dono_bypassrls, r.rolsuper as dono_super
  from pg_roles r where r.oid = (select relowner from pg_class where relname = 'vw_faturamento_diario' and relnamespace = 'public'::regnamespace);
select v.relname as view, string_agg(distinct b.relname || '(rls=' || b.relrowsecurity || ',force=' || b.relforcerowsecurity || ',dono=' || pg_get_userbyid(b.relowner) || ')', ', ') as tabelas_base
  from pg_class v join :alvos_v a on a.nome = v.relname
  join pg_rewrite rw on rw.ev_class = v.oid join pg_depend d on d.objid = rw.oid and d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_class'::regclass
  join pg_class b on b.oid = d.refobjid and b.oid <> v.oid and b.relkind = 'r'
 where v.relnamespace = 'public'::regnamespace group by 1 order by 1;
select (select count(*) from public.vw_faturamento_diario) as linhas_vw_faturamento_diario,
       (select count(*) from public.vw_estoque_critico)    as linhas_vw_estoque_critico,
       (select count(*) from public.vw_produto_margem)     as linhas_vw_produto_margem,
       (select count(*) from public.vw_produtos_vendidos)  as linhas_vw_produtos_vendidos;

\echo '== 7. unidade_config'
select relrowsecurity as rls, relforcerowsecurity as force_rls,
       (select count(*) from pg_policies where schemaname = 'public' and tablename = 'unidade_config') as policies
  from pg_class where oid = to_regclass('public.unidade_config');

\echo '== 8. exposição pelo PostgREST: schema public e configuração das roles'
select has_schema_privilege('anon', 'public', 'usage') as anon_usage_public, has_schema_privilege('authenticated', 'public', 'usage') as auth_usage_public;
select r.rolname, s.setdatabase, s.setconfig from pg_db_role_setting s left join pg_roles r on r.oid = s.setrole
 where r.rolname in ('authenticator','anon','authenticated','service_role') or s.setrole = 0 order by 1;
select n.nspname as schema_extra, has_schema_privilege('anon', n.oid, 'usage') as anon_usage
  from pg_namespace n where n.nspname in ('graphql_public','api','storage','extensions') order by 1;

\echo '== 9. pré/pós-condições da 115 neste banco (sem aplicar)'
select count(*) filter (where not pg_has_role(current_user, x.dono, 'USAGE')) as alvos_nao_administrados,
       count(*) as alvos_total
  from (select relowner as dono from pg_class c join :alvos_v a on a.nome = c.relname where c.relnamespace = 'public'::regnamespace and c.relkind in ('v','m')
        union all select proowner from pg_proc p join :alvos_f a on a.nome = p.proname where p.pronamespace = 'public'::regnamespace and p.prokind = 'f') x;
select r.rolname as papel, coalesce(string_agg(m.rolname, ',' order by m.rolname), '(nenhuma)') as herda_de
  from pg_roles r left join pg_auth_members am on am.member = r.oid left join pg_roles m on m.oid = am.roleid
 where r.rolname in ('anon','authenticated') group by 1 order by 1;
select coalesce(string_agg(distinct g.obj || ' ← ' || g.grantee || ' por ' || g.grantor, '; '), '(nenhum)') as grants_de_outro_concedente
  from (select c.relname as obj, (x).grantee::regrole::text as grantee, pg_get_userbyid((x).grantor) as grantor, (x).grantor <> c.relowner as outro
          from pg_class c join :alvos_v a on a.nome = c.relname, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x where c.relnamespace = 'public'::regnamespace and (x).grantee <> 0
        union all
        select p.proname, case when (x).grantee = 0 then 'PUBLIC' else (x).grantee::regrole::text end, pg_get_userbyid((x).grantor), (x).grantor <> p.proowner
          from pg_proc p join :alvos_f a on a.nome = p.proname, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where p.pronamespace = 'public'::regnamespace) g
 where g.outro;
select string_agg(dv.relname, ', ') as views_que_dependem_dos_alvos
  from pg_class v join :alvos_v a on a.nome = v.relname
  join pg_depend d on d.refobjid = v.oid and d.classid = 'pg_rewrite'::regclass
  join pg_rewrite rw on rw.oid = d.objid join pg_class dv on dv.oid = rw.ev_class and dv.oid <> v.oid;
select count(*) as policies_que_citam_funcoes_alvo from pg_policies pp
 where exists (select 1 from :alvos_f a where coalesce(pp.qual, '') || coalesce(pp.with_check, '') ilike '%' || a.nome || '%');

\echo '== 10. migrations vizinhas da 115 neste banco (sinais por objeto)'
select to_regclass('public.dispositivos_exibicao') is not null as m110_exibicao,
       exists (select 1 from pg_proc where proname = 'auth_is_display_operator' and pronamespace = 'public'::regnamespace) as m112_114_exibicao,
       to_regclass('public.ifood_conexao_lojas') is not null as m117,
       exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ifood_conexoes' and column_name = 'finalidade') as m124,
       exists (select 1 from public.modulos where id = 'checklist_operacional') as m123;

\echo '== 11. remapear (SQL dinâmico): tabelas org+unidade e policies de UPDATE que anon/authenticated/public teriam'
select coalesce(pp.roles_txt, '(sem policy de UPDATE)') as quem_pode_update, count(*) as tabelas, string_agg(t.table_name, ', ' order by t.table_name) as lista
  from (select c1.table_name from information_schema.columns c1
          join information_schema.columns c2 on c2.table_schema = c1.table_schema and c2.table_name = c1.table_name and c2.column_name = 'unidade_id'
          join information_schema.tables tt on tt.table_schema = c1.table_schema and tt.table_name = c1.table_name and tt.table_type = 'BASE TABLE'
         where c1.table_schema = 'public' and c1.column_name = 'organizacao_id'
           and c1.table_name not in ('martin_brower_vinculos','sessoes_contexto','insumo_historico')) t
  left join lateral (select string_agg(distinct r, '/' order by r) as roles_txt from pg_policies p, unnest(p.roles) r
                      where p.schemaname = 'public' and p.tablename = t.table_name and p.cmd in ('ALL','UPDATE')
                        and r in ('anon','authenticated','public')) pp on true
 group by 1 order by 1;
-- remapear chamada por anon/authenticated aborta inteira se faltar UPDATE em QUALQUER tabela da varredura (o privilégio é checado mesmo com 0 linhas)
select r.papel, count(*) as tabelas_varridas, count(*) filter (where not has_table_privilege(r.papel, format('public.%I', t.table_name), 'update')) as sem_update,
       coalesce(string_agg(t.table_name, ', ' order by t.table_name) filter (where not has_table_privilege(r.papel, format('public.%I', t.table_name), 'update')), '') as quais
  from (select c1.table_name from information_schema.columns c1
          join information_schema.columns c2 on c2.table_schema = c1.table_schema and c2.table_name = c1.table_name and c2.column_name = 'unidade_id'
          join information_schema.tables tt on tt.table_schema = c1.table_schema and tt.table_name = c1.table_name and tt.table_type = 'BASE TABLE'
         where c1.table_schema = 'public' and c1.column_name = 'organizacao_id'
           and c1.table_name not in ('martin_brower_vinculos','sessoes_contexto','insumo_historico')) t,
       (values ('anon'::name), ('authenticated'::name)) r(papel)
 group by 1 order by 1;
select count(*) as tabelas_publicas_sem_rls from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity;
rollback;
