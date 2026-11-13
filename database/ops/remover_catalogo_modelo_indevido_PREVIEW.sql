-- PRÉ-VISUALIZAÇÃO (somente leitura) — catálogo-modelo copiado por engano para uma empresa.
--
-- Caso: ao criar a empresa, o catálogo-modelo das Subways (produtos, insumos, fichas e tabelas de preço) foi copiado
-- para uma empresa que NÃO é Subway. Esses itens aparecem em Produtos/Insumos e oferecem tabelas comerciais que não
-- existem na loja. Este script só LISTA o que seria removido e as travas; não altera nada.
--
-- Uso: troque <ORG_ID> pelo id da empresa (o cast falha se esquecer) e rode no SQL Editor.
-- Critério do "modelo": criado no MESMO instante da cópia (created_at da carga-modelo), sem origem de importação de
-- planilha (catalogo_origem) e sem homologação. Itens criados depois (pela loja ou por importação) NUNCA entram.
with alvo as (select '<ORG_ID>'::uuid org),
semente as (
  select (select min(created_at) from produtos, alvo where organizacao_id = alvo.org) p_ts,
         (select min(created_at) from insumos,  alvo where organizacao_id = alvo.org) i_ts),
prod as (
  select p.* from produtos p, alvo, semente where p.organizacao_id = alvo.org and p.created_at = semente.p_ts
     and p.homologacao = 'nao_aplicavel'
     and not exists (select 1 from catalogo_origem o where o.entidade = 'produto' and o.entidade_id = p.id)),
ins as (
  select i.* from insumos i, alvo, semente where i.organizacao_id = alvo.org and i.created_at = semente.i_ts
     and not exists (select 1 from catalogo_origem o where o.entidade = 'insumo' and o.entidade_id = i.id))
select 'semente_produtos_em' item, (select p_ts::text from semente) valor
union all select 'semente_insumos_em', (select i_ts::text from semente)
union all select 'produtos_a_remover', count(*)::text from prod
union all select 'insumos_a_remover', count(*)::text from ins
union all select 'linhas_ficha_a_remover', count(*)::text from ficha_tecnica f where f.produto_id in (select id from prod)
union all select 'precos_a_remover', count(*)::text from produto_precos pp where pp.produto_id in (select id from prod)
union all select 'tabelas_de_preco', coalesce(string_agg(distinct pp.canal::text || '/' || pp.tabela, ', '), '—') from produto_precos pp where pp.produto_id in (select id from prod)
-- TRAVAS: tudo abaixo precisa ser 0 para o APLICAR prosseguir
union all select 'TRAVA_vendas_itens', count(*)::text from vendas_itens where produto_id in (select id from prod)
union all select 'TRAVA_produtos_vendidos_pdv', count(*)::text from sw_produtos_vendidos where produto_id in (select id from prod)
union all select 'TRAVA_mapeamento_pdv', count(*)::text from sw_mapeamento_produtos where produto_id in (select id from prod)
union all select 'TRAVA_historico_produto', count(*)::text from produto_historico where produto_id in (select id from prod)
union all select 'TRAVA_usado_por_ficha_fora_do_modelo', count(*)::text from ficha_tecnica f
  where (f.insumo_id in (select id from ins) or f.subproduto_id in (select id from prod)) and f.produto_id not in (select id from prod)
union all select 'TRAVA_estoque_movimentos', count(*)::text from movimentacoes_estoque where insumo_id in (select id from ins)
union all select 'TRAVA_pedidos_compra', count(*)::text from pedidos_compra_itens where insumo_id in (select id from ins)
union all select 'TRAVA_historico_insumo', count(*)::text from insumo_historico where insumo_id in (select id from ins)
union all select 'TRAVA_unidade_com_tabela_oficial', count(*)::text from unidades u, alvo where u.organizacao_id = alvo.org and (u.tabela_balcao is not null or u.tabela_ifood is not null);
