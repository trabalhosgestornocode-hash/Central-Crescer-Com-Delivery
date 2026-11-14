-- Financeiro v2 — FOTO do sistema atual (SÓ LEITURA). Rodar antes e depois da instalação: o hash deve ser IGUAL.
-- Exclui só o que é do Financeiro v2 (schema financeiro_v2, papéis fv2_*) e esquemas temporários.
with foto as (
  select 'schema' k, nspname || '|' || nspowner::regrole::text || '|' || coalesce(nspacl::text, '') v from pg_namespace where nspname <> 'financeiro_v2' and nspname !~ '^pg_(toast_)?temp_'
  union all select 'rel', n.nspname || '.' || c.relname || '|' || c.relkind::text || '|' || c.relowner::regrole::text || '|' || coalesce(c.relacl::text, '') || '|' || c.relrowsecurity::text || c.relforcerowsecurity::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('financeiro_v2', 'pg_toast', 'pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast_)?temp_'
  union all select 'func', p.oid::regprocedure::text || '|' || p.proowner::regrole::text || '|' || coalesce(p.proacl::text, '') || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('financeiro_v2', 'pg_catalog', 'information_schema')
  union all select 'pol', schemaname || '.' || tablename || '.' || policyname || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '') from pg_policies where schemaname <> 'financeiro_v2'
  union all select 'dacl', defaclrole::regrole::text || '|' || defaclnamespace::text || '|' || defaclobjtype::text || '|' || coalesce(defaclacl::text, '') from pg_default_acl
  union all select 'role', rolname || '|' || rolsuper::text || rolcreaterole::text || rolbypassrls::text || rolcanlogin::text || rolinherit::text from pg_roles where rolname !~ '^(fv2_|pg_)'
  union all select 'memb', r.rolname || '>' || m.rolname || '|' || x.admin_option::text || x.inherit_option::text || x.set_option::text
    from pg_auth_members x join pg_roles r on r.oid = x.roleid join pg_roles m on m.oid = x.member where r.rolname !~ '^fv2_' and m.rolname !~ '^fv2_'
  union all select 'trg', tgrelid::regclass::text || '.' || tgname || '|' || tgenabled::text from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname <> 'financeiro_v2'
)
select count(*) as itens, encode(sha256(convert_to(string_agg(k || ':' || v, E'\n' order by k, v), 'UTF8')), 'hex') as sha256 from foto;
