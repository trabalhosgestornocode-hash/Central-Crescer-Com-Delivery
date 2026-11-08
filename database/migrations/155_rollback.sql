-- Rollback da 155. RECUSA se houver qualquer vínculo 1:N (rollback de schema não recupera dados).
begin;
set local lock_timeout = '5s';
do $$
declare t text; n bigint;
begin
  foreach t in array array['fin_transferencias_multiplas_entradas', 'fin_transferencias_multiplas'] loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from %I', t) into n;
      if n > 0 then raise exception 'ROLLBACK 155 RECUSADO: % tem % linha(s)', t, n; end if;
    end if;
  end loop;
end $$;
drop trigger if exists trg_fin_transferencias_multipla_excl on fin_transferencias;
drop trigger if exists trg_fin_lancamentos_multipla_guarda on fin_lancamentos;
drop table if exists fin_transferencias_multiplas_entradas, fin_transferencias_multiplas;
drop function if exists fin_vincular_transferencia_multipla(uuid,uuid,uuid,uuid,uuid[],text);
drop function if exists fin_desvincular_transferencia_multipla(uuid,uuid,uuid,uuid,text);
drop function if exists fin2_multipla_exclusiva();
drop function if exists fin2_multipla_imutavel();
drop function if exists fin2_lancamento_multipla_guarda();
create or replace function public.gestao_financeira_tabelas_da_unidade() returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array[
    'gestao_financeira_concessoes', 'gestao_financeira_concessoes_auditoria',                                     -- 120
    'fin_contas', 'fin_saldos_abertura', 'fin_lancamentos', 'fin_transferencias', 'fin_periodos', 'fin_importacoes',
    'fin_auditoria',                                                                                              -- 121
    'fin_referencias', 'fin_conciliacao_resolucoes', 'fin_sangria_excecoes', 'fin_excecoes_fechamento',           -- 122
    'fin_obrigacoes', 'fin_pagamentos', 'fin_conciliacao_saidas',                                                 -- 151
    'fin_rateios', 'fin_rateio_parcelas', 'fin_recebiveis', 'fin_recebimentos', 'fin_dividas', 'fin_divida_eventos', -- 152
    'fin_vendas_canal', 'fin_vendas_ajustes'                                                                      -- 153
  ]::text[]
$$;
commit;
