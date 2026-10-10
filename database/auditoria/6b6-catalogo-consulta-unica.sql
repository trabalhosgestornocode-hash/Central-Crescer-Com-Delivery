-- =====================================================================
-- AUDITORIA DE CATÁLOGO SOMENTE-LEITURA — CONSULTA ÚNICA (Checkpoint 6B.6)
-- =====================================================================
-- POR QUE UMA CONSULTA SÓ: o SQL Editor do Supabase mostra apenas o resultado do ÚLTIMO comando de um script. Este arquivo é UM ÚNICO
-- `SELECT` que devolve todas as seções numa tabela só (colunas: secao, a, b, c, d, e, f) — basta colar, executar e exportar/copiar o resultado.
--
-- GARANTIAS (conferidas por teste: backend/test/auditoria-catalogo-sql.test.js):
--   * é UM comando `SELECT` (sem BEGIN/COMMIT, sem SET, sem DO, sem DDL/DML, sem GRANT/REVOKE): não escreve nada, não muda configuração;
--   * consulta SÓ o catálogo do Postgres (pg_*) — nomes, flags, privilégios, definição de views e corpo de funções. NENHUMA linha de
--     tabela de negócio, nenhum `auth.users`, nenhum `storage.objects`, nenhuma chave/token/senha/connection string;
--   * a única leitura de configuração é a de chaves `pgrst.*` PERMITIDAS (lista fixa: schemas expostos, limite de linhas, role anônima,
--     pre-request) da role `authenticator`; qualquer outra chave (inclusive segredos) é ignorada;
--   * a única tabela fora do catálogo é `supabase_migrations.schema_migrations` (versão e nome das migrations), lida SOMENTE se existir.
--
-- COMO RODAR (supervisionado): Supabase → SQL Editor → New query → colar este arquivo → Run → copiar/exportar o resultado inteiro
-- (CSV ou texto). Role: a normal de administração do SQL Editor (postgres). NÃO use a service_role key, NÃO use conexão externa.
-- =====================================================================
select * from (

  select '1.versao' as secao, version() as a, current_setting('server_version_num') as b, null::text as c, null::text as d, null::text as e, null::text as f

  union all select '2a.tabela_de_controle', coalesce(to_regclass('supabase_migrations.schema_migrations')::text, 'não existe'), null, null, null, null, null
  union all select '2b.migrations_registradas',
    case when to_regclass('supabase_migrations.schema_migrations') is not null
         then (select string_agg(x::text, ',' order by x::text) from unnest(xpath('//version/text()', query_to_xml('select version::text as version from supabase_migrations.schema_migrations', true, false, ''))) x)
         else '(sem tabela de controle: use 2c)' end, null, null, null, null, null
  union all select '2c.impressao', m.migration, m.presente::text, null, null, null, null
  from (values
    ('068+ dashboard_ifood_desbloqueios (tabela)',     (to_regclass('public.dashboard_ifood_desbloqueios') is not null)),
    ('080 realtime_channel_grants (tabela)',           (to_regclass('public.realtime_channel_grants') is not null)),
    ('108 lancamentos_financeiros_canais (tabela)',    (to_regclass('public.lancamentos_financeiros_canais') is not null)),
    ('110 dispositivos_exibicao (tabela)',             (to_regclass('public.dispositivos_exibicao') is not null)),
    ('112 valor display_operator no enum',             exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'papel_acesso' and e.enumlabel = 'display_operator')),
    ('113 constraint uo_sem_papel_exibicao',           exists (select 1 from pg_constraint where conname = 'uo_sem_papel_exibicao')),
    ('113 índice uq_usuarios_unidades_exibicao_unica', (to_regclass('public.uq_usuarios_unidades_exibicao_unica') is not null)),
    ('114 auth_unidade_ids ignora display_operator',   exists (select 1 from pg_proc where proname = 'auth_unidade_ids' and prosrc like '%display_operator%')),
    ('115 unidade_config com RLS ligado',              coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.unidade_config')), false)),
    ('115 views sem SELECT p/ anon/authenticated',     not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('vw_estoque_critico','vw_faturamento_diario','vw_produto_margem','vw_produtos_vendidos') and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'))))
  ) as m(migration, presente)

  union all select '3.roles', rolname, rolsuper::text, rolbypassrls::text, rolinherit::text, rolcanlogin::text, null
  from pg_roles where rolname in ('anon', 'authenticated', 'service_role', 'authenticator', 'postgres', 'supabase_admin')

  union all select '4.default_acl', pg_get_userbyid(d.defaclrole), d.defaclobjtype::text, d.defaclacl::text, null, null, null
  from pg_default_acl d where d.defaclnamespace in (0, 'public'::regnamespace)

  union all select '5.membros', pg_get_userbyid(m.roleid), pg_get_userbyid(m.member), null, null, null, null
  from pg_auth_members m where pg_get_userbyid(m.roleid) in ('anon', 'authenticated', 'service_role', 'authenticator') or pg_get_userbyid(m.member) in ('anon', 'authenticated', 'service_role')

  union all select '6.pgrst', split_part(c, '=', 1), substr(c, strpos(c, '=') + 1), null, null, null, null
  from pg_roles r, unnest(coalesce(r.rolconfig, '{}')) c
  where r.rolname = 'authenticator' and c ~ '^pgrst\.(db_schemas|db_extra_search_path|db_max_rows|db_anon_role|db_pre_request|db_plan_enabled)='
  union all select '6b.extensoes_de_api', extname, extversion, null, null, null, null from pg_extension where extname in ('pg_graphql', 'pg_net', 'pgcrypto', 'pgjwt', 'supabase_vault')

  union all select '7.views', c.relname, pg_get_userbyid(c.relowner), coalesce(array_to_string(c.reloptions, ','), '(nenhuma: roda como o DONO)'),
    'anon_select=' || has_table_privilege('anon', c.oid, 'select')::text, 'auth_select=' || has_table_privilege('authenticated', c.oid, 'select')::text, 'service_select=' || has_table_privilege('service_role', c.oid, 'select')::text
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm')
  union all select '7b.views_acl', c.relname, (a).grantee::regrole::text, pg_get_userbyid((a).grantor), (a).privilege_type, null, null
  from pg_class c, lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm') and c.relname like 'vw\_%' and (a).grantee in (0, 'anon'::regrole, 'authenticated'::regrole)
  union all select '7c.views_definicao', c.relname, regexp_replace(pg_get_viewdef(c.oid), '\s+', ' ', 'g'), null, null, null, null
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'v' and c.relname like 'vw\_%'

  union all select '8.unidade_config', c.relname, 'rls_ligado=' || c.relrowsecurity::text, 'rls_forcado=' || c.relforcerowsecurity::text, 'dono=' || pg_get_userbyid(c.relowner),
    'policies=' || (select count(*) from pg_policy p where p.polrelid = c.oid)::text,
    'anon_sel=' || has_table_privilege('anon', c.oid, 'select')::text || ' anon_upd=' || has_table_privilege('anon', c.oid, 'update')::text || ' auth_sel=' || has_table_privilege('authenticated', c.oid, 'select')::text || ' auth_upd=' || has_table_privilege('authenticated', c.oid, 'update')::text
  from pg_class c where c.oid = to_regclass('public.unidade_config')

  union all select '9.sem_rls', c.relname, null, null, null, null, null
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity
  union all select '9b.rls_sem_policy', count(*)::text, null, null, null, null, null
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relrowsecurity and not exists (select 1 from pg_policy p where p.polrelid = c.oid)

  union all select '10.rpcs', p.oid::regprocedure::text, 'security_definer=' || p.prosecdef::text, coalesce(array_to_string(p.proconfig, ','), '-'), 'dono=' || pg_get_userbyid(p.proowner),
    'anon=' || has_function_privilege('anon', p.oid, 'execute')::text || ' authenticated=' || has_function_privilege('authenticated', p.oid, 'execute')::text || ' service_role=' || has_function_privilege('service_role', p.oid, 'execute')::text,
    'public=' || exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where (a).grantee = 0)::text
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('bonificacao_congelar_competencia', 'bonificacao_reabrir_competencia', 'converter_empresa_para_unidade',
    'excluir_organizacao_definitivamente', 'promover_unidade_para_empresa', 'remapear_organizacao_em_tabelas_de_unidade', 'transferir_unidade_organizacao')
  union all select '10b.quem_chama_as_rpcs', p.proname, m, null, null, null, null
  from pg_proc p, unnest(array['bonificacao_congelar_competencia', 'bonificacao_reabrir_competencia', 'converter_empresa_para_unidade', 'excluir_organizacao_definitivamente',
    'promover_unidade_para_empresa', 'remapear_organizacao_em_tabelas_de_unidade', 'transferir_unidade_organizacao']) m
  where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proname <> m and p.prosrc like '%' || m || '%'
  union all select '10c.quem_usa_views_ou_config', p.proname, m, null, null, null, null
  from pg_proc p, unnest(array['vw_estoque_critico', 'vw_faturamento_diario', 'vw_produto_margem', 'vw_produtos_vendidos', 'unidade_config']) m
  where p.pronamespace = 'public'::regnamespace and p.prosrc ~ ('(^|[^_a-z0-9])' || m || '([^a-z0-9_]|$)')

  union all select '11.funcoes_expostas', p.oid::regprocedure::text, 'security_definer=' || p.prosecdef::text, coalesce(array_to_string(p.proconfig, ','), '-'), 'dono=' || pg_get_userbyid(p.proowner),
    'anon=' || has_function_privilege('anon', p.oid, 'execute')::text || ' authenticated=' || has_function_privilege('authenticated', p.oid, 'execute')::text, null
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p') and format_type(p.prorettype, null) <> 'trigger'
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
    and p.proname !~ '^(armor|crypt|dearmor|decrypt|decrypt_iv|digest|encrypt|encrypt_iv|gen_random_bytes|gen_random_uuid|gen_salt|hmac|pgp_.*)$'

  union all select '12.fora_de_public', n.nspname, c.relname, c.relkind::text, 'rls=' || c.relrowsecurity::text,
    'anon_select=' || has_table_privilege('anon', c.oid, 'select')::text, 'auth_select=' || has_table_privilege('authenticated', c.oid, 'select')::text
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname not in ('pg_catalog', 'information_schema', 'public', 'pg_toast') and n.nspname not like 'pg\_%' and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'))

  union all select '13.sequences', count(*)::text, null, null, null, null, null
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' and (has_sequence_privilege('anon', c.oid, 'usage') or has_sequence_privilege('authenticated', c.oid, 'usage'))

  union all select '14.publicacao_realtime', schemaname::text, tablename::text, null, null, null, null from pg_publication_tables where pubname = 'supabase_realtime'

  union all select '15.policies', case when coalesce(qual, '') || coalesce(with_check, '') ~ 'auth_unidade_ids' then 'auth_unidade_ids'
       when coalesce(qual, '') || coalesce(with_check, '') ~ 'auth_organizacao_ids' then 'auth_organizacao_ids' else 'outro' end, count(*)::text, null, null, null, null
  from pg_policies where schemaname = 'public' group by 2
  union all select '15b.policies_outro', tablename::text, policyname::text, cmd::text, roles::text, null, null from pg_policies
  where schemaname = 'public' and coalesce(qual, '') || coalesce(with_check, '') !~ 'auth_unidade_ids|auth_organizacao_ids'

  union all select '16.auth_unidade_ids', regexp_replace(prosrc, '\s+', ' ', 'g'), 'security_definer=' || prosecdef::text, coalesce(array_to_string(proconfig, ','), '-'), 'dono=' || pg_get_userbyid(proowner), null, null
  from pg_proc where pronamespace = 'public'::regnamespace and proname = 'auth_unidade_ids'

) t
order by secao, a, b, c, d, e, f;
