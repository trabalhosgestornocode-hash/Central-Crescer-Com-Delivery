-- (REFERÊNCIA — NÃO use com \ir: um erro dentro de arquivo incluído não encerra o script que o incluiu; cada script traz esta trava INLINE)
-- TRAVA de ambiente DESCARTÁVEL para os scripts SQL que ESCREVEM (incluída com \ir no topo de cada um). Falha fechada:
--  1) exige `psql ... -v CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL`;
--  2) recusa se existir QUALQUER organização cujo id não seja de teste (00000000-0000-0000-0000-0000000000xx): um banco com dados reais nunca passa.
-- Importante: \quit dentro de um arquivo incluído só encerra o ARQUIVO incluído (o script que o incluiu continuaria). Por isso a recusa é um ERRO
-- com ON_ERROR_STOP ligado, que encerra o psql inteiro.
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
