-- 136 · PRÉ-VOO SÓ LEITURA no Supabase de TESTE (wiqqsxnysbzhcrzrrean). Uma linha, um JSON.
with fn as (select p.oid, p.proname, md5(pg_get_functiondef(p.oid)) h, pg_get_functiondef(p.oid) d
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public')
select jsonb_build_object(
  'identidade', jsonb_build_object('db', current_database(), 'usuario', current_user, 'versao', split_part(version(), ' ', 2),
                                   'agora', now(), 'sistema_id', (select system_identifier from pg_control_system())),
  'f136_ja_aplicada', (select d like '%136: escrita direta%' from fn where proname = 'unidades_validar_fuso_horario'),
  'f132_md5', (select h from fn where proname = 'unidades_validar_fuso_horario'),
  'f132_tem_cr', (select position(chr(13) in d) > 0 from fn where proname = 'unidades_validar_fuso_horario'),
  'gatilhos_unidades', (select jsonb_agg(tgname || ':' || pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid = 'public.unidades'::regclass and not tgisinternal),
  'politicas_unidades', (select jsonb_agg(jsonb_build_object('nome', policyname, 'cmd', cmd, 'roles', roles, 'using', qual, 'check', with_check) order by policyname) from pg_policies where schemaname = 'public' and tablename = 'unidades'),
  'grants_unidades', (select jsonb_agg(grantee || ':' || privilege_type order by grantee, privilege_type) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'unidades' and grantee in ('anon','authenticated','service_role')),
  'transferir', (select jsonb_agg(jsonb_build_object('args', pg_get_function_identity_arguments(p.oid), 'secdef', p.prosecdef, 'dono', pg_get_userbyid(p.proowner), 'md5', md5(pg_get_functiondef(p.oid)),
                  'exec_service', has_function_privilege('service_role', p.oid, 'EXECUTE'), 'exec_auth', has_function_privilege('authenticated', p.oid, 'EXECUTE')))
                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'transferir_unidade_organizacao'),
  'impressao', jsonb_build_object(
     'colunas', (select md5(string_agg(table_name || '.' || column_name || ':' || data_type || ':' || coalesce(column_default, '') || ':' || is_nullable, ';' order by table_name, column_name)) from information_schema.columns where table_schema = 'public'),
     'funcoes_exceto_136', (select md5(string_agg(proname || ':' || h, ';' order by proname, h)) from fn where proname <> 'unidades_validar_fuso_horario'),
     'acl_funcoes', (select md5(string_agg(p.proname || ':' || coalesce(p.proacl::text, ''), ';' order by p.proname, p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
     'gatilhos', (select md5(string_agg(pg_get_triggerdef(t.oid), ';' order by pg_get_triggerdef(t.oid))) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal),
     'politicas', (select md5(string_agg(tablename || ':' || policyname || ':' || cmd || ':' || roles::text || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), ';' order by tablename, policyname)) from pg_policies where schemaname = 'public'),
     'acl_rls', (select md5(string_agg(c.relname || ':' || coalesce(c.relacl::text, '') || ':' || c.relrowsecurity, ';' order by c.relname)) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','v','m','p')),
     'n_tabelas', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p')),
     'n_funcoes', (select count(*) from fn)),
  'dados', jsonb_build_object(
     'unidades_completo', (select md5(coalesce(string_agg(to_jsonb(u)::text, ';' order by u.id), '')) || ':' || count(*) from unidades u),
     'unidades_com_fuso', (select count(*) from unidades where timezone is not null or horario_funcionamento is not null),
     'vinculos', (select md5(coalesce(string_agg(to_jsonb(x)::text, ';' order by to_jsonb(x)::text), '')) || ':' || count(*) from usuarios_organizacoes x),
     'mensagens', (select count(*) from comunicacao_mensagens),
     'mensagens_6h', (select count(*) from comunicacao_mensagens where created_at > now() - interval '6 hours'),
     'configuracoes', (select md5(coalesce(string_agg(chave || '=' || valor::text, ';' order by chave), '')) from comunicacao_configuracoes)),
  'massa_teste', (select jsonb_agg(jsonb_build_object('org', o, 'unidades_ativas', n, 'unidade', u1, 'membro', m)) from (
       select u.organizacao_id o, count(*) n, min(u.id::text) u1,
              (select min(x.usuario_id::text) from usuarios_organizacoes x where x.organizacao_id = u.organizacao_id and x.ativo) m
       from unidades u where u.ativo group by u.organizacao_id order by count(*) desc limit 3) s)
) as prevoo;
