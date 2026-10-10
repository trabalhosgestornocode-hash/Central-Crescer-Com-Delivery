-- =====================================================================
-- CONSULTA MÍNIMA PARA FECHAR A MIGRATION 115 — SOMENTE-LEITURA (Checkpoint 6B.8)
-- =====================================================================
-- UM ÚNICO `SELECT` (o SQL Editor mostra só o último resultado). Só catálogo (pg_*): nomes, privilégios e flags. Sem escrita, sem configuração, sem dado de
-- cliente, sem segredo. Devolve SÓ o que ainda falta saber (colunas: secao, a, b, c, d, e, f):
--   1.sessao        — quem está executando (a 115 exige dono ou membro do dono; esperado: postgres).
--   2.acl_completo  — TODOS os grantees das 4 views e das 7 RPCs (inclusive PUBLIC e roles extras), com quem concedeu: mostra grants de outras roles.
--   3.assinaturas   — TODAS as sobrecargas das 7 RPCs (uma linha por assinatura).
--   4.dependencias  — o que, dentro do banco, referencia as views/RPCs (funções, views dependentes, policies): quebraria se anon/authenticated perdessem acesso?
--   5.membros       — associações de roles (herança) envolvendo anon/authenticated: um grant a uma role que elas herdam também vale para elas.
--   6.pgrst_schemas — schemas expostos pela API (só a chave pgrst.db_schemas).
-- COMO RODAR: SQL Editor → New query → colar → Run → copiar o resultado inteiro. NÃO use a service_role key. Role normal do SQL Editor (postgres).
-- =====================================================================
select * from (

  select '1.sessao' as secao, current_user::text as a, session_user::text as b, 'superuser=' || (select rolsuper::text from pg_roles where rolname = current_user) as c,
    'membro_de_postgres=' || pg_has_role(current_user, 'postgres', 'USAGE')::text as d, null::text as e, null::text as f

  union all select '2.acl_completo', c.oid::regclass::text, 'view', 'dono=' || pg_get_userbyid(c.relowner),
    'grantee=' || (a).grantee::regrole::text, 'concedido_por=' || pg_get_userbyid((a).grantor), string_agg((a).privilege_type, ',' order by (a).privilege_type)
  from pg_class c, lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm') and c.relname in ('vw_estoque_critico', 'vw_faturamento_diario', 'vw_produto_margem', 'vw_produtos_vendidos')
  group by c.oid, c.relowner, (a).grantee, (a).grantor
  union all select '2.acl_completo', p.oid::regprocedure::text, 'rpc', 'dono=' || pg_get_userbyid(p.proowner),
    'grantee=' || (a).grantee::regrole::text, 'concedido_por=' || pg_get_userbyid((a).grantor), string_agg((a).privilege_type, ',' order by (a).privilege_type)
  from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  where p.pronamespace = 'public'::regnamespace and p.proname in ('bonificacao_congelar_competencia', 'bonificacao_reabrir_competencia', 'converter_empresa_para_unidade',
    'excluir_organizacao_definitivamente', 'promover_unidade_para_empresa', 'remapear_organizacao_em_tabelas_de_unidade', 'transferir_unidade_organizacao')
  group by p.oid, p.proowner, (a).grantee, (a).grantor

  union all select '3.assinaturas', p.proname::text, p.oid::regprocedure::text, 'security_definer=' || p.prosecdef::text, 'kind=' || p.prokind::text,
    'pronargs=' || p.pronargs::text, 'dono=' || pg_get_userbyid(p.proowner)
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('bonificacao_congelar_competencia', 'bonificacao_reabrir_competencia', 'converter_empresa_para_unidade',
    'excluir_organizacao_definitivamente', 'promover_unidade_para_empresa', 'remapear_organizacao_em_tabelas_de_unidade', 'transferir_unidade_organizacao')

  union all select '4.dependencias', 'funcao', p.oid::regprocedure::text, 'cita=' || m, null, null, null
  from pg_proc p, unnest(array['vw_estoque_critico', 'vw_faturamento_diario', 'vw_produto_margem', 'vw_produtos_vendidos', 'bonificacao_congelar_competencia', 'bonificacao_reabrir_competencia',
    'converter_empresa_para_unidade', 'excluir_organizacao_definitivamente', 'promover_unidade_para_empresa', 'remapear_organizacao_em_tabelas_de_unidade', 'transferir_unidade_organizacao']) m
  where p.pronamespace in ('public'::regnamespace) and p.prokind in ('f', 'p') and p.proname <> m and p.prosrc ~ ('(^|[^a-z0-9_])' || m || '([^a-z0-9_]|$)')
  union all select '4.dependencias', 'view_dependente', r.ev_class::regclass::text, 'depende_de=' || v.relname, null, null, null
  from pg_depend d join pg_rewrite r on r.oid = d.objid join pg_class v on v.oid = d.refobjid
  where v.relnamespace = 'public'::regnamespace and v.relname in ('vw_estoque_critico', 'vw_faturamento_diario', 'vw_produto_margem', 'vw_produtos_vendidos') and r.ev_class <> v.oid
  union all select '4.dependencias', 'policy', pl.tablename::text || '.' || pl.policyname::text, 'cita=' || m, null, null, null
  from pg_policies pl, unnest(array['vw_estoque_critico', 'vw_faturamento_diario', 'vw_produto_margem', 'vw_produtos_vendidos']) m
  where pl.schemaname = 'public' and coalesce(pl.qual, '') || coalesce(pl.with_check, '') ~ ('(^|[^a-z0-9_])' || m || '([^a-z0-9_]|$)')

  union all select '5.membros', pg_get_userbyid(m.roleid), pg_get_userbyid(m.member), 'inherit_option=' || m.inherit_option::text, 'admin_option=' || m.admin_option::text, null, null
  from pg_auth_members m where pg_get_userbyid(m.member) in ('anon', 'authenticated') or pg_get_userbyid(m.roleid) in ('anon', 'authenticated')

  union all select '6.pgrst_schemas', 'pgrst.db_schemas', substr(c, strpos(c, '=') + 1), null, null, null, null
  from pg_roles r, unnest(coalesce(r.rolconfig, '{}')) c where r.rolname = 'authenticator' and c ~ '^pgrst\.db_schemas='

) t
order by secao, a, b, c, d, e, f;
