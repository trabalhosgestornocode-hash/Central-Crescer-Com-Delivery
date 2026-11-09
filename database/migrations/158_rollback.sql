-- Rollback da 158. Recusa se já houver condições comerciais além da comissão ou histórico gravado.
do $$ begin
  if exists (select 1 from canais_venda_historico)
     or exists (select 1 from canais_venda where taxas_pct is not null or promocao_pct is not null or tributos_pct is not null
                  or entrega_responsavel is not null or entrega_custo is not null or outras_deducoes <> '[]'::jsonb or observacao is not null) then
    raise exception 'Rollback da 158 recusado: há condições comerciais/histórico gravados. Exporte antes.';
  end if;
end $$;

drop trigger if exists trg_ficha_integridade on ficha_tecnica;
drop function if exists trg_ficha_integridade();
drop trigger if exists trg_produto_homologacao on produtos;
drop trigger if exists trg_ficha_homologacao on ficha_tecnica;
drop function if exists trg_produto_invalida_homologacao();
drop function if exists trg_ficha_invalida_homologacao();
drop function if exists fn_invalida_homologacao(uuid, text);
drop table if exists canais_venda_historico;
alter table canais_venda drop constraint if exists canais_venda_pcts_validos;
alter table canais_venda drop constraint if exists canais_venda_entrega_resp_valida;
alter table canais_venda drop column if exists updated_at, drop column if exists updated_by, drop column if exists observacao,
  drop column if exists outras_deducoes, drop column if exists entrega_custo, drop column if exists entrega_responsavel,
  drop column if exists tributos_pct, drop column if exists promocao_pct, drop column if exists taxas_pct;
alter table produtos drop column if exists homologado_por_nome, drop column if exists homologacao_motivo, drop column if exists homologado_custo;
