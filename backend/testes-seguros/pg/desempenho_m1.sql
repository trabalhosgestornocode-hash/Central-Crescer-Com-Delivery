-- Desempenho da M1 e do fechamento com volume (local descartável OU Supabase DESCARTÁVEL). Cria a própria unidade/contas/categorias (ids aleatórios) e N lançamentos em UM mês.
--   psql <conexão DESCARTÁVEL> -v N=60000 -v ORG=<uuid de uma organização de teste> -f backend/testes-seguros/pg/desempenho_m1.sql
--   (padrão N=60000; ORG padrão = 00000000-0000-0000-0000-0000000000a1, a mesma do ambiente local)
-- Mede: função autoritativa de conciliação, impressão digital e fechamento completo (mês limpo). Critério de aceite sugerido: fechamento < 2 s com 300 mil.
-- Observação T3: o insert em massa usa session_replication_role = replica (pula gatilhos); se o papel do projeto não puder, rode sem essa linha (mais lento, mesmo resultado).
\set ON_ERROR_STOP on
\if :{?N} \else \set N 60000 \endif
\if :{?ORG} \else \set ORG '00000000-0000-0000-0000-0000000000a1' \endif
select gen_random_uuid() as u, gen_random_uuid() as c1, gen_random_uuid() as c2, gen_random_uuid() as cr, gen_random_uuid() as cd, substr(md5(random()::text), 1, 8) as sfx \gset
\set USR '00000000-0000-0000-0000-000000000999'
insert into unidades(id, organizacao_id, nome) values (:'u', :'ORG', 'DESEMPENHO ' || :'sfx');
insert into fin_plano_contas(id, organizacao_id, tipo, natureza, nome, papel) values (:'cr', :'ORG', 'RECEITA', 'R', 'PERF REC ' || :'sfx', 'receita_operacional'), (:'cd', :'ORG', 'DESPESA', 'F', 'PERF DESP ' || :'sfx', 'despesa_fixa');
insert into fin_contas(id, organizacao_id, unidade_id, nome, tipo_conta) values (:'c1', :'ORG', :'u', 'PCAIXA', 'caixa_fisico'), (:'c2', :'ORG', :'u', 'PBANCO', 'banco');
set session_replication_role = replica;
insert into fin_lancamentos(organizacao_id, unidade_id, conta_id, categoria_id, descricao, sentido, valor_centavos, data_movimento, status, classificacao_pendente)
select :'ORG', :'u', case when g % 3 = 0 then :'c1'::uuid else :'c2'::uuid end, case when g % 2 = 0 then :'cr'::uuid else :'cd'::uuid end,
       'perf ' || g, case when g % 2 = 0 then 'entrada' else 'saida' end, 100 + (g % 5000), date '2035-03-01' + (g % 31), 'realizado', false
  from generate_series(1, :N) g;
set session_replication_role = origin;
analyze fin_lancamentos;
select count(*) as lancamentos_no_mes from fin_lancamentos where unidade_id = :'u' and data_movimento >= '2035-03-01' and data_movimento < '2035-04-01';
select (fin_abrir_periodo(:'ORG', :'u', :'USR', '2035-03-01')->>'versao')::int as v \gset
\timing on
select cardinality(fin_conciliacao_pendencias_ids(:'ORG', :'u', '2035-03-01')) as pendencias_de_conciliacao;
select fin_fingerprint_periodo(:'ORG', :'u', '2035-03-01') as fp \gset
select fin_fechar_periodo(:'ORG', :'u', :'USR', '2035-03-01', :v, :'fp', '{}', array[]::text[], false)->>'status' as status_fechamento;
\timing off
