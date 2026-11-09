-- Duas organizações "Subway-like" com BOM aninhado (submontagem) e linhas inativas, ANTES da 157.
insert into organizacoes (id, nome) values ('a0000000-0000-4000-8000-000000000001','Subway X'),('b0000000-0000-4000-8000-000000000002','Subway Y');
insert into insumos (id, organizacao_id, nome, unidade_medida, preco_unitario) values
 ('11111111-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','Pão','un',1.25),
 ('11111111-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','Frango','kg',30),
 ('11111111-0000-4000-8000-000000000003','b0000000-0000-4000-8000-000000000002','Pão','un',1.40);
insert into produtos (id, organizacao_id, nome, vendavel, tipo) values
 ('22222222-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','Recheio','f','submontagem'),
 ('22222222-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','Sanduíche','t','sanduiche'),
 ('22222222-0000-4000-8000-000000000003','b0000000-0000-4000-8000-000000000002','Sanduíche Y','t','sanduiche');
insert into ficha_tecnica (produto_id, insumo_id, quantidade) values
 ('22222222-0000-4000-8000-000000000001','11111111-0000-4000-8000-000000000002',0.076);
insert into ficha_tecnica (produto_id, subproduto_id, quantidade) values
 ('22222222-0000-4000-8000-000000000002','22222222-0000-4000-8000-000000000001',2);
insert into ficha_tecnica (produto_id, insumo_id, quantidade) values
 ('22222222-0000-4000-8000-000000000002','11111111-0000-4000-8000-000000000001',1),
 ('22222222-0000-4000-8000-000000000003','11111111-0000-4000-8000-000000000003',1);
insert into ficha_tecnica (produto_id, insumo_id, quantidade, ativo) values   -- linha INATIVA: não pode contar
 ('22222222-0000-4000-8000-000000000003','11111111-0000-4000-8000-000000000001',99,false);
create table snap_custo as select id, fn_custo_produto(id) as custo from produtos;
insert into canais_venda (organizacao_id, canal, comissao_pct) values ('a0000000-0000-4000-8000-000000000001','ifood',0.27),('a0000000-0000-4000-8000-000000000001','balcao',0);
