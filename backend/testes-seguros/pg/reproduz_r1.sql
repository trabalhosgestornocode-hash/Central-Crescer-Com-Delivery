-- REPRODUÇÃO DO R-1 (como service_role): mês com venda R$ 1.000,00 + taxa R$ 100,00 e nenhum recebimento ⇒ o motor de conciliação aponta ponte_mensal ABERTA.
-- Antes da M1 (122 de cd35699) o fechamento com a lista de pendências OMITIDA fecha o mês sem exceção. Com a M1 (f2b1a40+) é recusado.
-- PRÉ-REQUISITO: banco 'sim' montado por sim_supabase.sh (org ...a1 e unidade ...a2 já existem). Para ver o ANTES, monte com a 122 anterior à M1:
--   P122=<caminho de uma cópia da 122 de cd35699> bash backend/testes-seguros/pg/sim_supabase.sh   (git show cd35699:docs/gestao-financeira/proposta-122/122_conciliacao_periodos.provisorio.sql > copia.sql)
-- TRAVA DE AMBIENTE DESCARTÁVEL (cópia INLINE de t3/guarda_descartavel.sql: erro dentro de \ir NÃO encerra o script que incluiu)
\set ON_ERROR_STOP on
\if :{?CONFIRMO}
\else
  \set CONFIRMO 'ausente'
\endif
select (:'CONFIRMO' = 'ESTE_PROJETO_E_DESCARTAVEL') as guarda_confirmado \gset
\if :guarda_confirmado
\else
  do $guarda$ begin raise exception 'RECUSADO: rode com -v CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL (somente banco/projeto DESCARTAVEL).'; end $guarda$;
\endif
do $guarda$
begin
  if to_regclass('public.organizacoes') is not null
     and exists (select 1 from public.organizacoes where id::text not like '00000000-0000-0000-0000-0000000000__') then
    raise exception 'RECUSADO: ha organizacoes que nao sao de teste neste banco; isto nao parece um ambiente descartavel.';
  end if;
end $guarda$;
-- fim da trava
insert into fin_referencias(organizacao_id,unidade_id,data,tipo,canal,valor_centavos,fonte) values
  ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','2036-05-10','venda',null,100000,'manual'),
  ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','2036-05-10','taxa','STONE',10000,'manual');
select (fin_abrir_periodo('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000999','2036-05-01')->>'versao')::int as v \gset
select fin_fingerprint_periodo('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','2036-05-01') as fp \gset
set role service_role;
select fin_fechar_periodo('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000999','2036-05-01', :v, :'fp', '{}', array[]::text[], false)->>'status' as resultado;
