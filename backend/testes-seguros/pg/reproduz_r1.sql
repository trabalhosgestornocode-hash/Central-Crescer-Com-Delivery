-- REPRODUÇÃO DO R-1 (como service_role): mês com venda R$ 1.000,00 + taxa R$ 100,00 e nenhum recebimento ⇒ o motor de conciliação aponta ponte_mensal ABERTA.
-- Antes da M1 (122 de cd35699) o fechamento com a lista de pendências OMITIDA fecha o mês sem exceção. Com a M1 (f2b1a40+) é recusado.
-- PRÉ-REQUISITO: banco 'sim' montado por sim_supabase.sh (org ...a1 e unidade ...a2 já existem). Para ver o ANTES, monte com a 122 anterior à M1:
--   P122=<caminho de uma cópia da 122 de cd35699> bash backend/testes-seguros/pg/sim_supabase.sh   (git show cd35699:docs/gestao-financeira/proposta-122/122_conciliacao_periodos.provisorio.sql > copia.sql)
insert into fin_referencias(organizacao_id,unidade_id,data,tipo,canal,valor_centavos,fonte) values
  ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','2036-05-10','venda',null,100000,'manual'),
  ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','2036-05-10','taxa','STONE',10000,'manual');
select (fin_abrir_periodo('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000999','2036-05-01')->>'versao')::int as v \gset
select fin_fingerprint_periodo('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','2036-05-01') as fp \gset
set role service_role;
select fin_fechar_periodo('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000999','2036-05-01', :v, :'fp', '{}', array[]::text[], false)->>'status' as resultado;
