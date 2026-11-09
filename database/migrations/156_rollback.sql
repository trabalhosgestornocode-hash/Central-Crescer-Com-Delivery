-- Rollback da 156. RECUSA se houver qualquer dado na tabela (rollback de schema não recupera dados).
begin;
set local lock_timeout = '5s';
do $$
declare n bigint;
begin
  if to_regclass('public.fin_pendencias_documentais') is not null then
    select count(*) into n from fin_pendencias_documentais;
    if n > 0 then raise exception 'ROLLBACK 156 RECUSADO: fin_pendencias_documentais tem % linha(s)', n; end if;
  end if;
end $$;
drop table if exists fin_pendencias_documentais;
drop function if exists fin2_pendencia_documental_guarda();
create or replace function public.gestao_financeira_tabelas_da_unidade() returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array[
    'gestao_financeira_concessoes', 'gestao_financeira_concessoes_auditoria',                                     -- 120
    'fin_contas', 'fin_saldos_abertura', 'fin_lancamentos', 'fin_transferencias', 'fin_periodos', 'fin_importacoes',
    'fin_auditoria',                                                                                              -- 121
    'fin_referencias', 'fin_conciliacao_resolucoes', 'fin_sangria_excecoes', 'fin_excecoes_fechamento',           -- 122
    'fin_obrigacoes', 'fin_pagamentos', 'fin_conciliacao_saidas',                                                 -- 151
    'fin_rateios', 'fin_rateio_parcelas', 'fin_recebiveis', 'fin_recebimentos', 'fin_dividas', 'fin_divida_eventos', -- 152
    'fin_vendas_canal', 'fin_vendas_ajustes',                                                                     -- 153
    'fin_transferencias_multiplas', 'fin_transferencias_multiplas_entradas'                                       -- 155
  ]::text[]
$$;
commit;
