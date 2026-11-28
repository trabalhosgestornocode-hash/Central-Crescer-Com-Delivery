-- Rollback da 163. Recusa se já houver custo zero declarado, pesos na ficha, rascunhos ou correções gravadas
-- (apagar isso perderia informação do cliente). Não toca em fn_custo_produto nem em dados anteriores à 163.
begin;
do $$ begin
  if exists (select 1 from insumos where custo_zero_declarado)
     or exists (select 1 from ficha_tecnica where peso_bruto is not null or peso_liquido is not null)
     or exists (select 1 from produto_rascunhos) or exists (select 1 from catalogo_correcoes)
     or exists (select 1 from produto_precos_historico) then
    raise exception 'ROLLBACK_163_RECUSADO: existem dados gravados pelas funcionalidades da 163';
  end if;
end $$;
do $$ begin
  if to_regclass('public.unidade_modulos') is not null then delete from unidade_modulos where modulo_id = 'products_cmv_v2'; end if;
  if to_regclass('public.organizacao_modulos') is not null then delete from organizacao_modulos where modulo_id = 'products_cmv_v2'; end if;
  if to_regclass('public.modulos') is not null then delete from modulos where id = 'products_cmv_v2'; end if;
end $$;
drop trigger if exists trg_insumo_custo_zero_preco on insumos;
drop function if exists trg_insumo_custo_zero_preco();
drop function if exists fn_corrigir_rendimentos(uuid, jsonb, text, text);
drop function if exists fn_custo_zero(uuid, uuid, boolean, text, text, text);
drop table if exists catalogo_correcoes, produto_rascunhos, produto_precos_historico;
alter table produto_precos drop column if exists origem, drop column if exists vigente_desde, drop column if exists informado_por;
alter table ficha_tecnica drop constraint if exists ficha_pesos_coerentes;
alter table ficha_tecnica drop column if exists peso_bruto, drop column if exists peso_liquido, drop column if exists indice_coccao, drop column if exists aproveitamento_justificativa;
alter table insumos drop constraint if exists insumos_custo_zero_coerente, drop constraint if exists insumos_aproveitamento_valido;
alter table insumos drop column if exists custo_zero_declarado, drop column if exists custo_zero_motivo, drop column if exists custo_zero_por,
  drop column if exists custo_zero_em, drop column if exists custo_zero_preco_anterior, drop column if exists aproveitamento_pct;
commit;
