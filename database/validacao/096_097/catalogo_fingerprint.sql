\pset format unaligned
\pset tuples_only on
\pset fieldsep '|'
select 'COL|'||c.table_name||'|'||c.column_name||'|'||c.data_type||'|'||c.is_nullable||'|'||coalesce(c.column_default,'') from information_schema.columns c where c.table_schema='public' order by 1;
select 'CON|'||cl.relname||'|'||co.conname||'|'||regexp_replace(pg_get_constraintdef(co.oid),'s+',' ','g') from pg_constraint co join pg_class cl on cl.oid=co.conrelid join pg_namespace n on n.oid=cl.relnamespace where n.nspname='public' order by 1;
select 'IDX|'||tablename||'|'||indexname||'|'||indexdef from pg_indexes where schemaname='public' order by 1;
select 'FN|'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')|'||md5(pg_get_functiondef(p.oid))||'|'||coalesce(p.proacl::text,'') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by 1;
select 'TRG|'||c.relname||'|'||t.tgname||'|'||md5(pg_get_triggerdef(t.oid)) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal order by 1;
select 'POL|'||tablename||'|'||policyname||'|'||coalesce(cmd,'')||'|'||regexp_replace(coalesce(qual,''),'s+',' ','g')||'|'||regexp_replace(coalesce(with_check,''),'s+',' ','g') from pg_policies where schemaname='public' order by 1;
select 'REL|'||c.relname||'|'||c.relkind::text||'|rls='||c.relrowsecurity||'|force='||c.relforcerowsecurity||'|'||coalesce(c.relacl::text,'')||'|'||coalesce(array_to_string(c.reloptions,','),'') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','v','m','p') order by 1;
select 'VIEW|'||viewname||'|'||md5(definition) from pg_views where schemaname='public' order by 1;
