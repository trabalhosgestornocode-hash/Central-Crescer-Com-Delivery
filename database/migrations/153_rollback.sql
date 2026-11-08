-- Rollback da 153. RECUSA se houver qualquer dado nas tabelas novas (rollback de schema não recupera dados).
begin;
set local lock_timeout = '5s';
do $$
declare t text; n bigint;
begin
  foreach t in array array['fin_vendas_canal', 'fin_vendas_ajustes'] loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from %I', t) into n;
      if n > 0 then raise exception 'ROLLBACK 153 RECUSADO: % tem % linha(s)', t, n; end if;
    end if;
  end loop;
end $$;
drop table if exists fin_vendas_ajustes, fin_vendas_canal;
drop function if exists fin2_vendas_canal_guarda();
create or replace function public.gestao_financeira_tabelas_da_unidade() returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array[
    'gestao_financeira_concessoes', 'gestao_financeira_concessoes_auditoria',                                     -- 120
    'fin_contas', 'fin_saldos_abertura', 'fin_lancamentos', 'fin_transferencias', 'fin_periodos', 'fin_importacoes',
    'fin_auditoria',                                                                                              -- 121
    'fin_referencias', 'fin_conciliacao_resolucoes', 'fin_sangria_excecoes', 'fin_excecoes_fechamento',           -- 122
    'fin_obrigacoes', 'fin_pagamentos', 'fin_conciliacao_saidas',                                                 -- 151
    'fin_rateios', 'fin_rateio_parcelas', 'fin_recebiveis', 'fin_recebimentos', 'fin_dividas', 'fin_divida_eventos' -- 152
  ]::text[]
$$;
commit;
