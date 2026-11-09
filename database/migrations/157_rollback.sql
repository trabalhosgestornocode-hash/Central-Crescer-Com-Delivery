-- Rollback da 157. RECUSA se já existir dado de importação (perderia rastreabilidade
-- e fichas com rendimento). Para reverter COM dados, exporte antes e remova manualmente.
do $$ begin
  if exists (select 1 from catalogo_importacoes) or exists (select 1 from catalogo_origem)
     or exists (select 1 from ficha_mao_de_obra)
     or exists (select 1 from produtos where rendimento <> 1 or homologacao <> 'nao_aplicavel') then
    raise exception 'Rollback da 157 recusado: há dados de catálogo importado (rendimento/homologação/origem). Exporte e limpe antes.';
  end if;
end $$;

drop function if exists fn_catalogo_importar(uuid, text, jsonb, uuid, jsonb, boolean);
drop table if exists catalogo_origem;
drop table if exists catalogo_importacoes;
drop table if exists ficha_mao_de_obra;

-- Restaura a fn_custo_produto da migration 021 (sem rendimento).
create or replace function fn_custo_produto(p_produto_id uuid)
returns numeric language sql stable as $$
  select coalesce(
    (select custo_manual from produtos where id = p_produto_id),
    (
      with recursive expl as (
        select ft.insumo_id, ft.subproduto_id, ft.quantidade::numeric as qtd
        from ficha_tecnica ft
        where ft.produto_id = p_produto_id and coalesce(ft.ativo, true)
        union all
        select ft.insumo_id, ft.subproduto_id, e.qtd * ft.quantidade
        from expl e
        join ficha_tecnica ft on ft.produto_id = e.subproduto_id and coalesce(ft.ativo, true)
        where e.subproduto_id is not null
      )
      select coalesce(sum(e.qtd * i.preco_unitario), 0)
      from expl e
      join insumos i on i.id = e.insumo_id
      where e.insumo_id is not null
    )
  );
$$;

alter table produtos drop constraint if exists produtos_rendimento_positivo;
alter table produtos drop constraint if exists produtos_homologacao_valida;
alter table produtos drop column if exists homologado_por;
alter table produtos drop column if exists homologado_em;
alter table produtos drop column if exists homologacao;
alter table produtos drop column if exists unidade_rendimento;
alter table produtos drop column if exists rendimento;
