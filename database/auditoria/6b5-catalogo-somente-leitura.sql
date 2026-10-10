-- =====================================================================
-- AUDITORIA DE CATÁLOGO SOMENTE-LEITURA — Supabase / Postgres (Checkpoint 6B.5)
-- =====================================================================
-- COMO USAR: o RESPONSÁVEL cola e executa no SQL Editor do projeto (ou psql) com a role normal de administração. Nada é escrito:
--   * roda dentro de `BEGIN TRANSACTION READ ONLY` e termina em ROLLBACK (qualquer escrita falharia);
--   * consulta SÓ o catálogo do Postgres (nomes, privilégios, flags, definições de views/funções) — NENHUM dado de cliente,
--     nenhuma linha de tabela de negócio, nenhuma chave, token, connection string ou valor secreto;
--   * a única configuração lida são chaves `pgrst.*` PERMITIDAS (lista fixa: schemas expostos, limite de linhas, role anônima, pre-request) da role `authenticator`.
--   * ATENÇÃO: o SQL Editor do Supabase mostra só o resultado do ÚLTIMO comando. Para o SQL Editor use `6b6-catalogo-consulta-unica.sql` (um único SELECT). Este arquivo é para psql.
-- SAÍDA: cole o resultado de cada seção (texto) no relatório. NÃO cole nada além do que as consultas devolvem.
-- Foi testado em Postgres descartável (backend/test/auditoria-catalogo-sql.test.js) para garantir que roda sem erro e sem escrever.
-- =====================================================================
begin transaction read only;

-- 1) Versão real do PostgreSQL (o ALTER VIEW … security_invoker exige ≥ 15; a 115 NÃO depende disso — usa REVOKE)
select '1.versao' as secao, version() as valor, current_setting('server_version_num') as num;

-- 2) Migrations efetivamente aplicadas
--    2a) o projeto usa tabela de controle do Supabase CLI?  (se "sim", rode 2b)
select '2a.tabela_de_controle' as secao, coalesce(to_regclass('supabase_migrations.schema_migrations')::text, 'não existe') as valor;
--    2b) (só se 2a = existe)  select version, name from supabase_migrations.schema_migrations order by version;
--    2c) IMPRESSÃO DIGITAL por objeto (funciona sem tabela de controle): cada linha diz se o efeito da migration está presente
select '2c.impressao' as secao, x.migration, x.presente
from (values
  ('068+ dashboard_ifood_desbloqueios (tabela)',     (to_regclass('public.dashboard_ifood_desbloqueios') is not null)),
  ('080 realtime_channel_grants (tabela)',           (to_regclass('public.realtime_channel_grants') is not null)),
  ('108 dashboard_ifood_canais',                     (to_regclass('public.lancamentos_financeiros_canais') is not null)),
  ('110 exibicao_dispositivos (tabela)',             (to_regclass('public.dispositivos_exibicao') is not null)),
  ('112 valor display_operator no enum',             exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'papel_acesso' and e.enumlabel = 'display_operator')),
  ('113 constraint uo_sem_papel_exibicao',           exists (select 1 from pg_constraint where conname = 'uo_sem_papel_exibicao')),
  ('113 índice uq_usuarios_unidades_exibicao_unica', (to_regclass('public.uq_usuarios_unidades_exibicao_unica') is not null)),
  ('114 auth_unidade_ids ignora display_operator',   exists (select 1 from pg_proc where proname = 'auth_unidade_ids' and prosrc like '%display_operator%')),
  ('115 unidade_config com RLS ligado',              coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.unidade_config')), false)),
  ('115 views sem SELECT p/ anon/authenticated',     not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('vw_estoque_critico','vw_faturamento_diario','vw_produto_margem','vw_produtos_vendidos') and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'))))
) as x(migration, presente) order by 2;

-- 3) Roles do Supabase: atributos (sem senhas)
select '3.roles' as secao, rolname, rolsuper, rolbypassrls, rolinherit, rolcanlogin
from pg_roles where rolname in ('anon', 'authenticated', 'service_role', 'authenticator', 'postgres', 'supabase_admin') order by rolname;

-- 4) Privilégios PADRÃO concedidos a objetos novos em public (é o que torna uma tabela/função alcançável pela API)
select '4.default_acl' as secao, pg_get_userbyid(d.defaclrole) as dono, d.defaclobjtype as tipo, d.defaclacl::text as acl
from pg_default_acl d where d.defaclnamespace in (0, 'public'::regnamespace) order by 2, 3;

-- 5) Quem herda de quem entre as roles da API
select '5.membros' as secao, pg_get_userbyid(m.roleid) as grupo, pg_get_userbyid(m.member) as membro
from pg_auth_members m where pg_get_userbyid(m.roleid) in ('anon', 'authenticated', 'service_role', 'authenticator') or pg_get_userbyid(m.member) in ('anon', 'authenticated', 'service_role') order by 2, 3;

-- 6) Exposição pela API: schemas expostos pelo PostgREST (config da role authenticator; só chaves pgrst.*)
select '6.pgrst' as secao, split_part(c, '=', 1) as chave, split_part(c, '=', 2) as valor
from pg_roles r, unnest(coalesce(r.rolconfig, '{}')) c where r.rolname = 'authenticator' and c ~ '^pgrst\.(db_schemas|db_extra_search_path|db_max_rows|db_anon_role|db_pre_request|db_plan_enabled)=' order by 2;
select '6b.extensoes_de_api' as secao, extname, extversion from pg_extension where extname in ('pg_graphql', 'pg_net', 'pgcrypto', 'pgjwt', 'supabase_vault') order by 2;

-- 7) As QUATRO views: dono, opções (security_invoker/security_barrier), privilégios decodificados (com quem concedeu)
select '7.views' as secao, c.relname, pg_get_userbyid(c.relowner) as dono, coalesce(array_to_string(c.reloptions, ','), '(nenhuma: roda como o DONO)') as opcoes,
  has_table_privilege('anon', c.oid, 'select') as anon_select, has_table_privilege('authenticated', c.oid, 'select') as auth_select, has_table_privilege('service_role', c.oid, 'select') as service_select
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm') order by 2;
select '7b.views_acl' as secao, c.relname, (a).grantee::regrole::text as quem_recebe, pg_get_userbyid((a).grantor) as quem_concedeu, (a).privilege_type as privilegio
from pg_class c, lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm') and c.relname like 'vw\_%' and (a).grantee in (0, 'anon'::regrole, 'authenticated'::regrole) order by 2, 3, 5;
select '7c.views_definicao' as secao, c.relname, regexp_replace(pg_get_viewdef(c.oid), '\s+', ' ', 'g') as definicao
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'v' and c.relname like 'vw\_%' order by 2;

-- 8) unidade_config: RLS e privilégios
select '8.unidade_config' as secao, c.relname, c.relrowsecurity as rls_ligado, c.relforcerowsecurity as rls_forcado, pg_get_userbyid(c.relowner) as dono,
  (select count(*) from pg_policy p where p.polrelid = c.oid) as policies,
  has_table_privilege('anon', c.oid, 'select') as anon_select, has_table_privilege('anon', c.oid, 'update') as anon_update,
  has_table_privilege('authenticated', c.oid, 'select') as auth_select, has_table_privilege('authenticated', c.oid, 'update') as auth_update
from pg_class c where c.oid = to_regclass('public.unidade_config');

-- 9) TODAS as tabelas de public SEM RLS (esperado após a 115: nenhuma) e as com RLS mas sem policy (negam tudo à API)
select '9.sem_rls' as secao, c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity order by 2;
select '9b.rls_sem_policy' as secao, count(*) as qtde from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relrowsecurity and not exists (select 1 from pg_policy p where p.polrelid = c.oid);

-- 10) As SETE RPCs: TODAS as sobrecargas, SECURITY DEFINER?, search_path, dono, privilégio por role e dependências textuais
select '10.rpcs' as secao, p.oid::regprocedure::text as assinatura, p.prosecdef as security_definer, coalesce(array_to_string(p.proconfig, ','), '-') as config, pg_get_userbyid(p.proowner) as dono,
  has_function_privilege('anon', p.oid, 'execute') as anon_exec, has_function_privilege('authenticated', p.oid, 'execute') as auth_exec, has_function_privilege('service_role', p.oid, 'execute') as service_exec,
  exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where (a).grantee = 0) as public_exec
from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('bonificacao_congelar_competencia', 'bonificacao_reabrir_competencia', 'converter_empresa_para_unidade',
  'excluir_organizacao_definitivamente', 'promover_unidade_para_empresa', 'remapear_organizacao_em_tabelas_de_unidade', 'transferir_unidade_organizacao') order by 2;
select '10b.quem_chama_as_rpcs' as secao, p.proname as funcao_que_referencia, m as rpc_citada
from pg_proc p, unnest(array['bonificacao_congelar_competencia', 'bonificacao_reabrir_competencia', 'converter_empresa_para_unidade', 'excluir_organizacao_definitivamente',
  'promover_unidade_para_empresa', 'remapear_organizacao_em_tabelas_de_unidade', 'transferir_unidade_organizacao']) m
where p.pronamespace in ('public'::regnamespace) and p.prokind = 'f' and p.proname <> m and p.prosrc like '%' || m || '%' order by 2, 3;
select '10c.quem_usa_views_ou_config' as secao, p.proname, m as objeto_citado
from pg_proc p, unnest(array['vw_estoque_critico', 'vw_faturamento_diario', 'vw_produto_margem', 'vw_produtos_vendidos', 'unidade_config']) m
where p.pronamespace = 'public'::regnamespace and p.prosrc ~ ('(^|[^_a-z0-9])' || m || '([^a-z0-9_]|$)') order by 2, 3;

-- 11) TODAS as funções de public executáveis por anon ou authenticated (qualquer sobrecarga), com SECURITY DEFINER e search_path
select '11.funcoes_expostas' as secao, p.oid::regprocedure::text as assinatura, p.prosecdef as security_definer, coalesce(array_to_string(p.proconfig, ','), '-') as config, pg_get_userbyid(p.proowner) as dono,
  has_function_privilege('anon', p.oid, 'execute') as anon_exec, has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p') and format_type(p.prorettype, null) <> 'trigger'
  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
  and p.proname !~ '^(armor|crypt|dearmor|decrypt|decrypt_iv|digest|encrypt|encrypt_iv|gen_random_bytes|gen_random_uuid|gen_salt|hmac|pgp_.*)$' order by 3 desc, 2;

-- 12) Objetos equivalentes em OUTROS schemas: qualquer tabela/view fora de public (e fora dos internos) com SELECT para anon/authenticated
select '12.fora_de_public' as secao, n.nspname, c.relname, c.relkind, c.relrowsecurity as rls,
  has_table_privilege('anon', c.oid, 'select') as anon_select, has_table_privilege('authenticated', c.oid, 'select') as auth_select
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname not in ('pg_catalog', 'information_schema', 'public', 'pg_toast') and n.nspname not like 'pg\_%' and c.relkind in ('r', 'p', 'v', 'm', 'f')
  and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select')) order by 2, 3;

-- 13) Sequences em public com USAGE/UPDATE para anon/authenticated (apenas contagem)
select '13.sequences' as secao, count(*) as com_privilegio from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
  and (has_sequence_privilege('anon', c.oid, 'usage') or has_sequence_privilege('authenticated', c.oid, 'usage'));

-- 14) Realtime: tabelas publicadas para "postgres changes" (o RLS filtra o que cada assinante recebe)
select '14.publicacao_realtime' as secao, schemaname, tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 2, 3;

-- 15) Policies por dependência dos auxiliares de RLS (confirma que a 114 cobre o conjunto)
select '15.policies' as secao,
  case when coalesce(qual, '') || coalesce(with_check, '') ~ 'auth_unidade_ids' then 'auth_unidade_ids'
       when coalesce(qual, '') || coalesce(with_check, '') ~ 'auth_organizacao_ids' then 'auth_organizacao_ids' else 'outro' end as depende_de, count(*) as qtde
from pg_policies where schemaname = 'public' group by 2 order by 2;
select '15b.policies_outro' as secao, tablename, policyname, cmd, roles::text from pg_policies
where schemaname = 'public' and coalesce(qual, '') || coalesce(with_check, '') !~ 'auth_unidade_ids|auth_organizacao_ids' order by 2, 3;

-- 16) Corpo ATUAL de auth_unidade_ids (deve ser o original até a 114; depois, com display_operator) — é código de função, não dado
select '16.auth_unidade_ids' as secao, regexp_replace(prosrc, '\s+', ' ', 'g') as corpo, prosecdef as security_definer, coalesce(array_to_string(proconfig, ','), '-') as config, pg_get_userbyid(proowner) as dono
from pg_proc where pronamespace = 'public'::regnamespace and proname = 'auth_unidade_ids';

rollback;
