-- Rollback da 152. RECUSA se houver qualquer dado nas tabelas novas (rollback de schema não recupera dados).
begin;
set local lock_timeout = '5s';
do $$
declare t text; n bigint;
begin
  foreach t in array array['fin_rateios', 'fin_rateio_parcelas', 'fin_recebiveis', 'fin_recebimentos', 'fin_dividas', 'fin_divida_eventos'] loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from %I', t) into n;
      if n > 0 then raise exception 'ROLLBACK 152 RECUSADO: % tem % linha(s)', t, n; end if;
    end if;
  end loop;
end $$;
drop function if exists fin_rateio_definir(uuid,uuid,uuid,uuid,bigint,text,text,text,jsonb,text,text);
drop function if exists fin_rateio_aprovar(uuid,uuid,uuid,uuid);
drop function if exists fin_rateio_cancelar(uuid,uuid,uuid,uuid,text);
drop table if exists fin_divida_eventos, fin_dividas, fin_recebimentos, fin_recebiveis, fin_rateio_parcelas, fin_rateios;
drop function if exists fin2_rateio_guarda(), fin2_recebimentos_guarda(), fin2_divida_eventos_guarda();
create or replace function public.gestao_financeira_tabelas_da_unidade() returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array[
    'gestao_financeira_concessoes', 'gestao_financeira_concessoes_auditoria',                                     -- 120
    'fin_contas', 'fin_saldos_abertura', 'fin_lancamentos', 'fin_transferencias', 'fin_periodos', 'fin_importacoes',
    'fin_auditoria',                                                                                              -- 121
    'fin_referencias', 'fin_conciliacao_resolucoes', 'fin_sangria_excecoes', 'fin_excecoes_fechamento',           -- 122
    'fin_obrigacoes', 'fin_pagamentos', 'fin_conciliacao_saidas'                                                  -- 151
  ]::text[]
$$;
commit;
