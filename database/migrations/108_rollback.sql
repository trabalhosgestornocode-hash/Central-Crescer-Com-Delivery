-- =====================================================================
-- ROLLBACK da migration 108 (Dashboard iFood — múltiplos canais).
-- NÃO executar automaticamente.
--
-- Remove SOMENTE o que a 108 criou. `lancamentos_financeiros_diarios`
-- perde só a coluna `estrutura_lancamento` e a unique (id, unidade_id) —
-- nenhum valor consolidado é tocado.
--
-- TRAVA: se já existir QUALQUER valor lançado por canal, o rollback ABORTA
-- sem mexer em nada — apagar a composição histórica por canal é perda de
-- dado, nunca efeito colateral de um rollback. Os dias multicanal já
-- lançados continuariam válidos como consolidado (são a linha da unidade),
-- mas o detalhe por canal seria perdido: decida isso conscientemente.
-- =====================================================================

do $$
begin
  if to_regclass('public.lancamentos_financeiros_canais') is not null
     and exists (select 1 from lancamentos_financeiros_canais) then
    raise exception 'rollback 108 abortado: existem valores lançados por canal em lancamentos_financeiros_canais. Exporte/decida antes de remover.';
  end if;
end $$;

drop function if exists dashboard_ifood_salvar_lancamento_multicanal(uuid, uuid, uuid, timestamptz, jsonb, jsonb);
drop function if exists dashboard_ifood_salvar_config_unidade(uuid, uuid, text, text, text, jsonb, uuid, text, text);
drop function if exists dashboard_ifood_config_versao(uuid);

drop trigger if exists trg_lfd_estrutura_imutavel on lancamentos_financeiros_diarios;
drop function if exists lfd_estrutura_imutavel();

drop table if exists lancamentos_financeiros_canais;
drop function if exists lfc_coerencia();

drop table if exists dashboard_ifood_canais;
drop function if exists difc_unidade_imutavel();

drop table if exists dashboard_ifood_unidade_config;

alter table lancamentos_financeiros_diarios drop constraint if exists lfd_id_unidade_key;
alter table lancamentos_financeiros_diarios drop constraint if exists lfd_escopo_entregadores_lancamento_check;
alter table lancamentos_financeiros_diarios drop column if exists escopo_entregadores_lancamento;
alter table lancamentos_financeiros_diarios drop constraint if exists lfd_estrutura_lancamento_check;
alter table lancamentos_financeiros_diarios drop column if exists estrutura_lancamento;

-- VERIFICAÇÃO (só leitura):
--   select to_regclass('public.dashboard_ifood_canais'), to_regclass('public.lancamentos_financeiros_canais'),
--          to_regclass('public.dashboard_ifood_unidade_config');            -- esperado: null, null, null
--   select count(*) from information_schema.columns
--   where table_name = 'lancamentos_financeiros_diarios' and column_name = 'estrutura_lancamento';  -- esperado: 0
