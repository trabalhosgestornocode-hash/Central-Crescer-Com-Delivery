-- =====================================================================
-- Checklist Operacional 2.0 — VERIFICAÇÃO das migrations 127/128 em produção (SOMENTE LEITURA)
-- =====================================================================
-- Nenhuma instrução aqui escreve: só SELECT/EXPLAIN em catálogo e tabelas. Rodar cada bloco no SQL Editor (ou psql) e
-- ARQUIVAR o resultado com o horário. Runbook: docs/runbook-migrations-127-128-producao.md.
--
--   V0  ANTES  — linha de base + impressões digitais (rodar imediatamente antes da 127; anotar t0 = coluna `agora`)
--   V1  DEPOIS da 127 — estrutura, constraints, gatilhos, RLS e privilégios dos objetos novos
--   V2  DEPOIS da 128 — índice válido e usado
--   V3  DEPOIS de tudo — a MESMA consulta do V0 (com o t0 anotado) + crescimento normal de pedidos/eventos
--
-- Por que impressões digitais e não só contagens: pedidos e eventos CONTINUAM chegando e mudando de estado durante a
-- janela. O que precisa ser idêntico antes/depois é (a) o CONJUNTO de pedidos/eventos que já existia em t0 (só os
-- identificadores — estado pode mudar legitimamente pelo worker) e (b) a ESTRUTURA de tudo que não é do Checklist.

-- ---------------------------------------------------------------------
-- V0 / V3 — linha de base. No V3, substituir o t0 abaixo pelo `agora` anotado no V0.
-- ---------------------------------------------------------------------
with p as (select now() as t0)   -- V3: troque por  select timestamptz '2026-10-24 16:26:39+00' as t0
select
  (select t0 from p)                                                                                     as t0,
  now()                                                                                                  as agora,
  -- (a) dados existentes em t0: conjunto idêntico antes/depois
  (select count(*) from ifood_pedidos, p where criado_em <= p.t0)                                        as pedidos_ate_t0,
  (select md5(string_agg(order_id, ',' order by order_id)) from ifood_pedidos, p where criado_em <= p.t0) as pedidos_ate_t0_md5,
  (select count(*) from ifood_eventos, p where received_at <= p.t0)                                     as eventos_ate_t0,
  (select md5(string_agg(event_id, ',' order by event_id)) from ifood_eventos, p where received_at <= p.t0) as eventos_ate_t0_md5,
  -- (b) totais e vida do processamento (no V3 devem ser >= V0 e o lease recente)
  (select count(*) from ifood_pedidos)                                                                   as pedidos_total,
  (select count(*) from ifood_eventos)                                                                   as eventos_total,
  (select max(received_at) from ifood_eventos)                                                           as ultimo_evento,
  (select count(*) from ifood_eventos where processing_status = 'FALHOU')                                as eventos_falhou,
  (select string_agg(nome || ' renovado ' || to_char(atualizado_em, 'HH24:MI:SS') || ' até ' || to_char(lease_ate, 'HH24:MI:SS'), '; ')
     from ifood_poller_lease)                                                                            as lease_poller,
  -- (c) Financeiro: totais por tabela (só mudam por uso normal, nunca pela migration)
  (select string_agg(t || '=' || n, ' ' order by t) from (
     select 'fin_plano_contas' t, count(*) n from fin_plano_contas union all
     select 'fin_contas', count(*) from fin_contas union all
     select 'fin_lancamentos', count(*) from fin_lancamentos union all
     select 'fin_auditoria', count(*) from fin_auditoria union all
     select 'gestao_financeira_concessoes', count(*) from gestao_financeira_concessoes) x)               as financeiro_totais,
  -- (d) ESTRUTURA de tudo fora do escopo do PR: tem de ser IDÊNTICA antes/depois
  (select md5(string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable, ',' order by table_name, ordinal_position))
     from information_schema.columns where table_schema = 'public' and table_name not like 'checklist_metas%') as estrutura_colunas_md5,
  (select md5(string_agg(tablename || ':' || indexname || ':' || indexdef, ',' order by tablename, indexname))
     from pg_indexes where schemaname = 'public' and tablename not like 'checklist_metas%'
       and indexname <> 'idx_ifood_pedidos_tenant_criado')                                               as estrutura_indices_md5,
  (select md5(coalesce(string_agg(schemaname || '.' || tablename || ':' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), ',' order by schemaname, tablename, policyname), ''))
     from pg_policies where tablename not like 'checklist_metas%')                                      as politicas_rls_md5,
  (select md5(string_agg(c.relname || ':' || c.relrowsecurity::text || ':' || coalesce(array_to_string(c.relacl, '|'), ''), ',' order by c.relname))
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'v', 'm') and c.relname not like 'checklist_metas%') as rls_e_privilegios_md5,
  (select md5(string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || coalesce(array_to_string(p.proacl, '|'), ''), ',' order by p.proname, pg_get_function_identity_arguments(p.oid)))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname not like 'checklist_metas%')                              as funcoes_md5,
  -- (e) objetos do PR (V0: tudo ausente; V3: presente)
  to_regclass('public.checklist_metas') is not null                                                      as tem_checklist_metas,
  to_regclass('public.checklist_metas_historico') is not null                                            as tem_checklist_metas_historico,
  to_regclass('public.idx_ifood_pedidos_tenant_criado') is not null                                      as tem_indice_128,
  (select count(*) from pg_stat_activity where datname = current_database() and state <> 'idle' and pid <> pg_backend_pid()) as sessoes_ativas,
  (select coalesce(max(extract(epoch from now() - xact_start))::int, 0) from pg_stat_activity
     where datname = current_database() and xact_start is not null and pid <> pg_backend_pid())        as transacao_mais_antiga_s;

-- ---------------------------------------------------------------------
-- V1 — depois da 127 (esperado entre parênteses)
-- ---------------------------------------------------------------------
select item, valor from (
  select 1 o, 'tabelas criadas (2)' item, count(*)::text valor from pg_class where relname in ('checklist_metas', 'checklist_metas_historico') and relkind = 'r'
  union all select 2, 'RLS ligada nas duas (true,true)', string_agg(relrowsecurity::text, ',' order by relname) from pg_class where relname in ('checklist_metas', 'checklist_metas_historico') and relkind = 'r'
  union all select 3, 'policies (0)', count(*)::text from pg_policies where tablename like 'checklist_metas%'
  union all select 4, 'CHECKs em checklist_metas (8)', count(*)::text from pg_constraint where conrelid = 'public.checklist_metas'::regclass and contype = 'c'
  union all select 5, 'FKs com on delete cascade (cc)', string_agg(confdeltype::text, '' order by conname) from pg_constraint where conrelid = 'public.checklist_metas'::regclass and contype = 'f'
  union all select 6, 'unicidade (unidade, versão) do histórico (1)', count(*)::text from pg_constraint where conrelid = 'public.checklist_metas_historico'::regclass and contype = 'u'
  union all select 7, 'gatilhos (3)', count(*)::text from pg_trigger where tgrelid in ('public.checklist_metas'::regclass, 'public.checklist_metas_historico'::regclass) and not tgisinternal
  union all select 8, 'funções (4)', count(*)::text from pg_proc where proname like 'checklist_metas%'
  union all select 9, 'anon pode ler/escrever (false)', has_table_privilege('anon', 'public.checklist_metas', 'select,insert,update,delete')::text
  union all select 10, 'authenticated pode ler/escrever (false)', has_table_privilege('authenticated', 'public.checklist_metas', 'select,insert,update,delete')::text
  union all select 11, 'authenticated lê histórico (false)', has_table_privilege('authenticated', 'public.checklist_metas_historico', 'select')::text
  union all select 12, 'service_role só lê (true,false)', has_table_privilege('service_role', 'public.checklist_metas', 'select')::text || ',' || has_table_privilege('service_role', 'public.checklist_metas', 'insert,update,delete')::text
  union all select 13, 'função de escrita: service_role sim, authenticated não (true,false)',
    has_function_privilege('service_role', 'public.checklist_metas_salvar(uuid, uuid, bigint, numeric, numeric, numeric, numeric, numeric, numeric, text, uuid, uuid, text, uuid)', 'execute')::text || ',' ||
    has_function_privilege('authenticated', 'public.checklist_metas_salvar(uuid, uuid, bigint, numeric, numeric, numeric, numeric, numeric, numeric, text, uuid, uuid, text, uuid)', 'execute')::text
  union all select 14, 'linhas (0 até o deploy)', (select count(*) from checklist_metas)::text || ',' || (select count(*) from checklist_metas_historico)::text
) x order by o;

-- ---------------------------------------------------------------------
-- V2 — depois da 128 (esperado: t | t | definição exata | plano usa o índice)
-- ---------------------------------------------------------------------
select i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) as definicao, pg_size_pretty(pg_relation_size(i.indexrelid)) as tamanho
from pg_index i where i.indexrelid = 'public.idx_ifood_pedidos_tenant_criado'::regclass;

-- Plano da consulta do Dashboard, com o tenant LITERAL (como o backend envia). Troque os dois valores por uma unidade
-- real com pedidos (ex.: `select organizacao_id, unidade_id, count(*) from ifood_pedidos group by 1, 2 order by 3 desc
-- limit 1;`). Com poucas linhas o planejador pode preferir varrer a tabela; para confirmar que o índice é ELEGÍVEL,
-- rodar na MESMA sessão `set enable_seqscan = off;` antes (vale só para a sessão; nada é gravado).
explain select order_id from ifood_pedidos
where organizacao_id = '00000000-0000-0000-0000-000000000000'::uuid   -- <organizacao_id>
  and unidade_id = '00000000-0000-0000-0000-000000000000'::uuid       -- <unidade_id>
  and criado_em >= date_trunc('day', now()) and criado_em < now()   -- período padrão do Dashboard: hoje
order by criado_em, order_id;
