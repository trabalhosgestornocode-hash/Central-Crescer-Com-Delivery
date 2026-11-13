-- APLICAR (ESCRITA) — remove o catálogo-modelo copiado por engano para UMA empresa, com cópia de segurança.
-- Só executar com autorização explícita, depois de rodar o PREVIEW e conferir os números.
--
-- Uso: troque <ORG_ID> (id da empresa) e os 4 números <ESPERADO_*> pelos valores que o PREVIEW mostrou.
-- Tudo numa transação: se qualquer trava ou contagem não bater, nada é alterado.
-- Cópia de segurança: schema backup_ops (fora da API REST), tabelas modelo_indevido_* com a coluna lote = id desta execução.
begin;

create schema if not exists backup_ops;
revoke all on schema backup_ops from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on schema backup_ops from anon, authenticated'; end if;
end $$;

create temp table _alvo on commit drop as select '<ORG_ID>'::uuid org, gen_random_uuid() lote;
create temp table _prod on commit drop as
  select p.id from produtos p, _alvo a where p.organizacao_id = a.org and p.homologacao = 'nao_aplicavel'
     and p.created_at = (select min(created_at) from produtos where organizacao_id = a.org)
     and not exists (select 1 from catalogo_origem o where o.entidade = 'produto' and o.entidade_id = p.id);
create temp table _ins on commit drop as
  select i.id from insumos i, _alvo a where i.organizacao_id = a.org
     and i.created_at = (select min(created_at) from insumos where organizacao_id = a.org)
     and not exists (select 1 from catalogo_origem o where o.entidade = 'insumo' and o.entidade_id = i.id);

do $$
declare n_p int; n_i int; n_f int; n_pp int; trava int;
begin
  select count(*) into n_p from _prod; select count(*) into n_i from _ins;
  select count(*) into n_f from ficha_tecnica where produto_id in (select id from _prod);
  select count(*) into n_pp from produto_precos where produto_id in (select id from _prod);
  if n_p <> <ESPERADO_PRODUTOS> or n_i <> <ESPERADO_INSUMOS> or n_f <> <ESPERADO_FICHA> or n_pp <> <ESPERADO_PRECOS> then
    raise exception 'Contagem diferente do PREVIEW (produtos %, insumos %, ficha %, preços %): nada foi alterado.', n_p, n_i, n_f, n_pp;
  end if;
  select (select count(*) from vendas_itens where produto_id in (select id from _prod))
       + (select count(*) from sw_produtos_vendidos where produto_id in (select id from _prod))
       + (select count(*) from sw_mapeamento_produtos where produto_id in (select id from _prod))
       + (select count(*) from produto_historico where produto_id in (select id from _prod))
       + (select count(*) from ficha_tecnica f where (f.insumo_id in (select id from _ins) or f.subproduto_id in (select id from _prod)) and f.produto_id not in (select id from _prod))
       + (select count(*) from movimentacoes_estoque where insumo_id in (select id from _ins))
       + (select count(*) from pedidos_compra_itens where insumo_id in (select id from _ins))
       + (select count(*) from insumo_historico where insumo_id in (select id from _ins))
       + (select count(*) from sw_combo_componentes where produto_id in (select id from _prod))
       + (select count(*) from ficha_mao_de_obra where produto_id in (select id from _prod))
       + (select count(*) from estoque where insumo_id in (select id from _ins))
       + (select count(*) from lotes where insumo_id in (select id from _ins))
       + (select count(*) from divergencias_compra where insumo_id in (select id from _ins))
       + (select count(*) from martin_brower_vinculos where insumo_id in (select id from _ins))
       + (select count(*) from unidades u, _alvo a where u.organizacao_id = a.org and (u.tabela_balcao is not null or u.tabela_ifood is not null))
    into trava;
  if trava <> 0 then raise exception 'Há uso real dos itens-modelo (% referências): nada foi alterado. Rode o PREVIEW.', trava; end if;
end $$;

-- cópia de segurança integral (linhas inteiras), marcada com o lote desta execução
create table if not exists backup_ops.modelo_indevido_produtos (lote uuid, removido_em timestamptz, linha jsonb);
create table if not exists backup_ops.modelo_indevido_insumos  (lote uuid, removido_em timestamptz, linha jsonb);
create table if not exists backup_ops.modelo_indevido_ficha    (lote uuid, removido_em timestamptz, linha jsonb);
create table if not exists backup_ops.modelo_indevido_precos   (lote uuid, removido_em timestamptz, linha jsonb);
insert into backup_ops.modelo_indevido_produtos select a.lote, now(), to_jsonb(p) from produtos p, _alvo a where p.id in (select id from _prod);
insert into backup_ops.modelo_indevido_insumos  select a.lote, now(), to_jsonb(i) from insumos i, _alvo a where i.id in (select id from _ins);
insert into backup_ops.modelo_indevido_ficha    select a.lote, now(), to_jsonb(f) from ficha_tecnica f, _alvo a where f.produto_id in (select id from _prod);
insert into backup_ops.modelo_indevido_precos   select a.lote, now(), to_jsonb(x) from produto_precos x, _alvo a where x.produto_id in (select id from _prod);

delete from ficha_tecnica where produto_id in (select id from _prod);
delete from produto_precos where produto_id in (select id from _prod);
delete from produtos where id in (select id from _prod) and organizacao_id = (select org from _alvo);
delete from insumos  where id in (select id from _ins)  and organizacao_id = (select org from _alvo);

select 'lote de backup (guarde para reverter)' item, lote::text valor from _alvo
union all select 'produtos restantes na empresa', count(*)::text from produtos, _alvo a where organizacao_id = a.org
union all select 'insumos restantes na empresa', count(*)::text from insumos, _alvo a where organizacao_id = a.org;

commit;
