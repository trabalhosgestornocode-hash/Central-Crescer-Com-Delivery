-- =====================================================================
-- AUDITORIA COMPLEMENTAR SOMENTE-LEITURA — por que `unidade_config` já tem RLS ligado? (Checkpoint 6B.7)
-- =====================================================================
-- UM ÚNICO `SELECT` (o SQL Editor mostra só o último resultado). Mesmas garantias da consulta única 6b6: só catálogo (pg_*), sem escrita,
-- sem configuração, sem dado de cliente, sem segredo. Devolve (secao, a, b, c, d, e):
--   * 1.gatilhos_de_evento — gatilhos de evento do banco (um deles, do próprio Supabase, pode ligar o RLS automaticamente em tabelas novas);
--   * 2.rls_sem_policy — NOMES das tabelas de public com RLS ligado e nenhuma policy (mostra se "RLS ligado e sem policy" é um padrão do projeto);
--   * 3.unidade_config — dono, RLS, RLS forçado, policies, comentário e quando o objeto foi criado (se a extensão de auditoria permitir: não consultamos);
--   * 4.tabelas_sem_migration_conhecida — tabelas de public que NÃO aparecem em nenhuma migration do repositório não podem ser listadas aqui
--     (o banco não sabe); por isso a comparação é feita fora, com `2c` da consulta 6b6.
-- Como rodar: igual à 6b6 (SQL Editor → colar → Run → copiar o resultado). NÃO use a service_role key.
-- =====================================================================
select * from (

  select '1.gatilhos_de_evento' as secao, ev.evtname::text as a, ev.evtevent::text as b, 'habilitado=' || ev.evtenabled::text as c, 'funcao=' || ev.evtfoid::regproc::text as d, 'dono=' || pg_get_userbyid(ev.evtowner) as e
  from pg_event_trigger ev

  union all select '2.rls_sem_policy', c.relname::text, 'dono=' || pg_get_userbyid(c.relowner), null, null, null
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relrowsecurity and not exists (select 1 from pg_policy p where p.polrelid = c.oid)

  union all select '3.unidade_config', c.relname::text, 'dono=' || pg_get_userbyid(c.relowner), 'rls_ligado=' || c.relrowsecurity::text || ' rls_forcado=' || c.relforcerowsecurity::text,
    'policies=' || (select count(*) from pg_policy p where p.polrelid = c.oid)::text, 'comentario=' || coalesce(obj_description(c.oid, 'pg_class'), '(nenhum)')
  from pg_class c where c.oid = to_regclass('public.unidade_config')

) t
order by secao, a, b, c, d, e;
