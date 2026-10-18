-- T3 — verificações de CATÁLOGO do Dashboard Financeiro (120 + 121 + 122). SOMENTE LEITURA (select). Rodar no projeto Supabase DESCARTÁVEL já com as 3 migrations
-- aplicadas (e também no PostgreSQL local descartável, onde serve de ensaio). Cada linha: verificação | esperado | obtido | ok. Qualquer ok = false reprova o T3.
--   psql "<conexão do projeto DESCARTÁVEL>" -v ON_ERROR_STOP=1 -f backend/testes-seguros/t3/verificacoes_catalogo.sql
-- Nunca rode contra produção. Este arquivo não altera nada.
with
fin_tabelas as (select c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) as dono
                  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and (c.relname like 'fin\_%' escape '\' or c.relname like 'gestao\_financeira\_%' escape '\')),
fin_funcoes as (select p.oid, p.proname, p.oid::regprocedure::text as assinatura, p.prosecdef, p.proconfig, p.prorettype, pg_get_userbyid(p.proowner) as dono,
                       (p.prorettype = 'trigger'::regtype) as eh_gatilho
                  from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'fin\_%' escape '\' or p.proname like 'gfc\_%' escape '\' or p.proname like 'gestao\_financeira\_%' escape '\')),
papeis as (select rolname, rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname in ('anon', 'authenticated', 'service_role', 'postgres')),
-- funções NÃO-gatilho que o backend (service_role) PRECISA poder executar
permitidas_service_role(nome) as (values ('fin_abrir_periodo'), ('fin_fechar_periodo'), ('fin_fingerprint_periodo'), ('fin_periodo_travar_e_checar'), ('fin_periodo_travar'),
  ('fin_conciliacao_pendencias_ids'), ('fin_consumir_excecao_fechamento'), ('fin_confirmar_importacao'), ('fin_criar_transferencia'), ('fin_vincular_transferencia'),
  ('fin_cancelar_transferencia'), ('fin_desvincular_transferencia_motivada')),
-- funções que NINGUÉM além do dono pode executar (reabertura desabilitada; concessão/revogação de exceção bloqueadas até o MFA; validadores puros; gatilhos)
proibidas_service_role(nome) as (values ('fin_reabrir_periodo'), ('fin_conceder_excecao_fechamento'), ('fin_revogar_excecao_fechamento'), ('fin_mfa_evidencia_valida'), ('fin_ids_conciliacao_validos'),
  ('fin_desvincular_transferencia')),
checks as (
  select 1 as n, 'service_role tem BYPASSRLS (as funções/gatilhos DEFINER e FORCE RLS da 120 dependem disso)' as verificacao, 'true' as esperado,
         coalesce((select rolbypassrls::text from papeis where rolname = 'service_role'), 'papel inexistente') as obtido
  union all select 2, 'anon e authenticated SEM BYPASSRLS', 'true',
         (select (count(*) = 2 and bool_and(not rolbypassrls))::text from papeis where rolname in ('anon', 'authenticated'))
  union all select 3, 'dono das tabelas fin_*/gestao_financeira_* não é superusuário nem BYPASSRLS (pior caso para DEFINER)', 'true',
         (select (count(*) > 0 and bool_and(not r.rolsuper or r.rolname = 'postgres'))::text from fin_tabelas t join pg_roles r on r.rolname = t.dono)
  union all select 4, 'RLS LIGADA em todas as tabelas financeiras', '0 sem RLS', (select count(*) filter (where not relrowsecurity) || ' sem RLS' from fin_tabelas)
  union all select 5, 'ZERO policies nas tabelas financeiras (acesso só pelo backend)', '0', (select count(*)::text from pg_policies where schemaname = 'public' and (tablename like 'fin\_%' escape '\' or tablename like 'gestao\_financeira\_%' escape '\'))
  union all select 6, 'FORCE RLS nas tabelas da 120 (concessões e auditoria)', '2', (select count(*)::text from fin_tabelas where relname like 'gestao\_financeira\_%' escape '\' and relforcerowsecurity)
  union all select 7, 'anon/authenticated SEM nenhum privilégio de tabela financeira', '0', (select count(*)::text from fin_tabelas t, papeis p, unnest(array['select','insert','update','delete','truncate','references','trigger']) pr
                                                                   where p.rolname in ('anon', 'authenticated') and has_table_privilege(p.rolname, t.oid, pr))
  union all select 8, 'service_role SEM delete/truncate/references/trigger em tabela financeira', '0', (select count(*)::text from fin_tabelas t, unnest(array['delete','truncate','references','trigger']) pr where has_table_privilege('service_role', t.oid, pr))
  union all select 9, 'service_role não escreve em fin_auditoria nem em fin_excecoes_fechamento (só gatilhos/funções)', '0',
         (select count(*)::text from unnest(array['fin_auditoria','fin_excecoes_fechamento']) t, unnest(array['insert','update']) pr where to_regclass('public.' || t) is not null and has_table_privilege('service_role', ('public.' || t)::regclass, pr))
  union all select 10, 'anon/authenticated SEM EXECUTE em NENHUMA função financeira (inclui gatilhos e validadores)', '0',
         (select count(*)::text from fin_funcoes f, papeis p where p.rolname in ('anon', 'authenticated') and has_function_privilege(p.rolname, f.oid, 'execute'))
  union all select 11, 'service_role executa TODAS as funções permitidas (lista fechada)', '0 ausentes',
         (select count(*) filter (where not coalesce(has_function_privilege('service_role', f.oid, 'execute'), false)) || ' ausentes' from permitidas_service_role a left join fin_funcoes f on f.proname = a.nome)
  union all select 12, 'service_role NÃO executa as funções proibidas (reabrir, conceder, revogar, validadores, desvínculo sem motivo)', '0',
         (select count(*)::text from proibidas_service_role a join fin_funcoes f on f.proname = a.nome where has_function_privilege('service_role', f.oid, 'execute'))
  union all select 13, 'service_role não executa função NÃO-gatilho fora da lista permitida', '0',
         (select count(*)::text from fin_funcoes f where not f.eh_gatilho and has_function_privilege('service_role', f.oid, 'execute') and f.proname not in (select nome from permitidas_service_role))
  union all select 14, 'toda função SECURITY DEFINER tem search_path fixo', '0 sem search_path',
         (select count(*) filter (where prosecdef and not coalesce(array_to_string(proconfig, ',') like '%search_path=%', false)) || ' sem search_path' from fin_funcoes)
  union all select 15, 'funções críticas com search_path fixo (fechar, conciliação autoritativa)', '2',
         (select count(*)::text from fin_funcoes where proname in ('fin_fechar_periodo', 'fin_conciliacao_pendencias_ids') and coalesce(array_to_string(proconfig, ',') like '%search_path=%', false))
  union all select 16, 'nenhuma SOBRECARGA de função financeira (O-1)', '0', (select count(*)::text from (select proname from fin_funcoes group by proname having count(*) > 1) x)
  union all select 17, 'fin_conciliacao_pendencias_ids é STABLE e invoker (não DEFINER)', 'true',
         (select (provolatile = 's' and not prosecdef)::text from pg_proc where oid = 'fin_conciliacao_pendencias_ids(uuid,uuid,date)'::regprocedure)
  union all select 18, 'funções DEFINER de exceção pertencem ao dono das tabelas', '0 divergentes',
         (select count(*) filter (where f.dono is distinct from (select dono from fin_tabelas where relname = 'fin_excecoes_fechamento')) || ' divergentes' from fin_funcoes f where f.proname in ('fin_conceder_excecao_fechamento', 'fin_revogar_excecao_fechamento', 'fin_consumir_excecao_fechamento'))
  union all select 19, 'gatilhos de integridade presentes e HABILITADOS (reabertura, fechamento direto, exceção, tipo/canal de conta, exceção de sangria)', '5',
         (select count(*)::text from pg_trigger where not tgisinternal and tgenabled = 'O' and tgname in ('trg_fin_periodos_bloqueia_reabertura', 'trg_fin_periodos_bloqueia_fechamento_direto', 'trg_fin_excecoes_fechamento_guarda', 'trg_fin_contas_regra_conciliacao', 'trg_fin_sangria_excecoes_regra'))
  union all select 20, 'sequências financeiras SEM USAGE para anon/authenticated', '0',
         (select count(*)::text from pg_class c, papeis p where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' and (c.relname like 'fin\_%' escape '\' or c.relname like 'gestao\_financeira\_%' escape '\') and p.rolname in ('anon', 'authenticated') and has_sequence_privilege(p.rolname, c.oid, 'usage'))
  union all select 21, 'modulos.categoria aceita financeiro e módulos coexistem (Financeiro 17, Checklist 18 se a 123 estiver aplicada)', 'true',
         (select (exists (select 1 from pg_constraint where conrelid = 'public.modulos'::regclass and pg_get_constraintdef(oid) ilike '%financeiro%')
                  and exists (select 1 from public.modulos where id = 'gestao_financeira' and ordem = 17)
                  and not exists (select 1 from public.modulos where ordem = 17 and id <> 'gestao_financeira'))::text)
  union all select 22, 'módulo gestao_financeira NÃO habilitado em nenhuma empresa/unidade (nasce desabilitado)', '0',
         (select ((select count(*) from public.organizacao_modulos where modulo_id = 'gestao_financeira') + (select count(*) from public.unidade_modulos where modulo_id = 'gestao_financeira'))::text)
  union all select 23, 'nenhuma concessão financeira ativa (flag desligada, nada habilitado)', '0',
         (select count(*)::text from public.gestao_financeira_concessoes where revogada_em is null)
)
select n, verificacao, esperado, obtido, (obtido = esperado) as ok from checks order by n;
