-- Testes da migration 157 (rodar DEPOIS de 05_seed_subway.sql + 157 aplicada 2x).
\set ON_ERROR_STOP on
create or replace function t_assert(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'FALHA: %', msg; end if; raise notice 'ok - %', msg; end $$;

-- 1. REGRESSÃO SUBWAY: rendimento=1 => custo idêntico ao de antes da 157
select t_assert((select count(*) from snap_custo s join produtos p on p.id=s.id
                  where abs(fn_custo_produto(p.id) - s.custo) > 1e-12) = 0, 'Subways: custo idêntico antes/depois da 157');
select t_assert(abs(fn_custo_produto('22222222-0000-4000-8000-000000000002') - (2*0.076*30 + 1.25)) < 1e-9, 'Subway X: submontagem + insumo = 5.81');
select t_assert(abs(fn_custo_produto('22222222-0000-4000-8000-000000000003') - 1.40) < 1e-9, 'Subway Y: linha inativa ignorada');
select t_assert((select count(*) from produtos where rendimento <> 1 or homologacao <> 'nao_aplicavel') = 0, 'Subways: defaults neutros (rendimento 1, nao_aplicavel)');

-- 2. RENDIMENTO: receita de 8 unidades
insert into organizacoes (id, nome) values ('c0000000-0000-4000-8000-000000000003','Caramelle Teste');
insert into insumos (id, organizacao_id, nome, unidade_medida, preco_caixa, rendimento, preco_unitario) values
 ('33333333-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000003','Requeijão','g',69.9,1500,0.0466);
insert into produtos (id, organizacao_id, nome, rendimento, vendavel, tipo) values
 ('44444444-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000003','Empadão',8,true,'outro');
insert into ficha_tecnica (produto_id, insumo_id, quantidade) values ('44444444-0000-4000-8000-000000000001','33333333-0000-4000-8000-000000000001',200);
select t_assert(abs(fn_custo_produto('44444444-0000-4000-8000-000000000001') - (200*0.0466/8)) < 1e-9, 'rendimento 8 divide o custo do lote (1.165)');

-- 3. PREPARAÇÃO por peso (rendimento 1554 g) usada em 700 g
insert into produtos (id, organizacao_id, nome, rendimento, unidade_rendimento, vendavel, tipo) values
 ('44444444-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000003','Bechamel',1554,'g',false,'submontagem'),
 ('44444444-0000-4000-8000-000000000003','c0000000-0000-4000-8000-000000000003','Torta',4,'un',true,'outro');
insert into ficha_tecnica (produto_id, insumo_id, quantidade) values ('44444444-0000-4000-8000-000000000002','33333333-0000-4000-8000-000000000001',200);
insert into ficha_tecnica (produto_id, subproduto_id, quantidade) values ('44444444-0000-4000-8000-000000000003','44444444-0000-4000-8000-000000000002',700);
select t_assert(abs(fn_custo_produto('44444444-0000-4000-8000-000000000003') - (700 * (200*0.0466/1554) / 4)) < 1e-9, 'preparação aninhada: custo/g da base x qtd / rendimento da torta');

-- 4. IMPORTAÇÃO transacional + idempotente
create temp table payload as select jsonb_build_object(
 'insumos', jsonb_build_array(
   jsonb_build_object('chave','ing:cafe','nome','Café','tipo','outro','unidade_medida','g','preco_caixa',40,'rendimento',1000),
   jsonb_build_object('chave','ing:leite','nome','Leite','tipo','outro','unidade_medida','ml','preco_caixa',5.49,'rendimento',1000)),
 'produtos', jsonb_build_array(
   jsonb_build_object('chave','prep:calda','nome','Calda','tipo','submontagem','vendavel',false,'rendimento',500,'unidade_rendimento','g','homologacao','pendente',
     'linhas', jsonb_build_array(jsonb_build_object('ref','insumo','chave','ing:leite','quantidade',500,'ordem',1))),
   jsonb_build_object('chave','fin:cappuccino','nome','Cappuccino','tipo','bebida','vendavel',true,'rendimento',2,'homologacao','pendente',
     'linhas', jsonb_build_array(jsonb_build_object('ref','insumo','chave','ing:cafe','quantidade',20,'ordem',1),
                                 jsonb_build_object('ref','produto','chave','prep:calda','quantidade',100,'ordem',2)),
     'mao_de_obra', jsonb_build_array(jsonb_build_object('funcao','barista','minutos',4,'custo_minuto',0.28)))
 )) p;
select fn_catalogo_importar('c0000000-0000-4000-8000-000000000003','teste-v1',(select p from payload),null,'[]',false) as r1 \gset
select t_assert((:'r1'::jsonb->>'insumos_novos')::int = 2 and (:'r1'::jsonb->>'produtos_novos')::int = 2, '1a importação cria 2 insumos e 2 produtos');
select fn_catalogo_importar('c0000000-0000-4000-8000-000000000003','teste-v1',(select p from payload),null,'[]',false) as r2 \gset
select t_assert((:'r2'::jsonb->>'insumos_novos')::int = 0 and (:'r2'::jsonb->>'produtos_novos')::int = 0 and (:'r2'::jsonb->>'insumos_existentes')::int = 2, '2a importação NÃO duplica (idempotente)');
select t_assert((select count(*) from insumos where organizacao_id='c0000000-0000-4000-8000-000000000003' and nome in ('Café','Leite')) = 2, 'sem insumos duplicados');
select t_assert((select count(*) from produtos where organizacao_id='c0000000-0000-4000-8000-000000000003' and nome in ('Calda','Cappuccino')) = 2, 'sem produtos duplicados');
select t_assert((select count(*) from ficha_tecnica f join produtos p on p.id=f.produto_id where p.nome='Cappuccino') = 2, 'ficha do Cappuccino mantém 2 linhas após reimportar');
-- custo: (20 g x 0.04 + 100 g x (500 ml x 0.00549 / 500)) / 2 = (0.8 + 0.549)/2 = 0.6745
select t_assert(abs((select custo_cache from produtos where nome='Cappuccino') - 0.6745) < 1e-9, 'custo_cache do importado considera rendimento e preparação (0.6745)');
select t_assert((select homologacao from produtos where nome='Cappuccino') = 'pendente', 'importado entra como pendente de homologação');
select t_assert((select count(*) from ficha_mao_de_obra) = 1, 'mão de obra gravada à parte, fora do custo');
select t_assert((select count(*) from catalogo_importacoes) = 2, 'cada execução registra uma importação (rastreabilidade)');

-- reimport com preço divergente: NÃO sobrescreve o vigente, só reporta
update insumos set preco_caixa = 42, preco_unitario = 0.042 where nome='Café' and organizacao_id='c0000000-0000-4000-8000-000000000003';
select fn_catalogo_importar('c0000000-0000-4000-8000-000000000003','teste-v1',(select p from payload),null,'[]',false) as r3 \gset
select t_assert(jsonb_array_length(:'r3'::jsonb->'precos_divergentes') = 1 and (select preco_caixa from insumos where nome='Café' and organizacao_id='c0000000-0000-4000-8000-000000000003') = 42, 'reimport preserva preço vigente e reporta divergência');

-- 5. ISOLAMENTO: mesma chave/fonte em OUTRA organização cria registros próprios e não toca nos de Caramelle
select fn_catalogo_importar('b0000000-0000-4000-8000-000000000002','teste-v1',(select p from payload),null,'[]',false) as r4 \gset
select t_assert((:'r4'::jsonb->>'insumos_novos')::int = 2, 'outra organização recebe o seu próprio catálogo');
select t_assert((select count(distinct organizacao_id) from catalogo_origem where fonte='teste-v1') = 2, 'catalogo_origem separado por organização');
select t_assert((select count(*) from insumos where organizacao_id='c0000000-0000-4000-8000-000000000003' and nome='Café') = 1, 'Caramelle continua com 1 Café');
select t_assert((select preco_caixa from insumos where organizacao_id='c0000000-0000-4000-8000-000000000003' and nome='Café') = 42, 'importação em outra org não alterou preço da Caramelle');
select t_assert((select count(*) from snap_custo s where abs(fn_custo_produto(s.id) - s.custo) > 1e-12) = 0, 'Subways intactas após importações em outras orgs');
-- organização inexistente é recusada
do $$ begin
  begin perform fn_catalogo_importar('99999999-0000-4000-8000-000000000009','teste-v1','{}'::jsonb); raise exception 'deveria recusar';
  exception when sqlstate '22023' then raise notice 'ok - organização inexistente recusada'; end;
end $$;
-- ATOMICIDADE: payload com referência quebrada não deixa nada para trás
select count(*) as antes from insumos \gset
do $$ begin
  begin
    perform fn_catalogo_importar('c0000000-0000-4000-8000-000000000003','teste-atomico',
      '{"insumos":[{"chave":"ing:novo","nome":"Novo","tipo":"outro","unidade_medida":"g","preco_caixa":1,"rendimento":1}],
        "produtos":[{"chave":"p:x","nome":"X","tipo":"outro","linhas":[{"ref":"insumo","chave":"ing:inexistente","quantidade":1}]}]}'::jsonb);
    raise exception 'deveria falhar';
  exception when sqlstate '22023' then raise notice 'ok - payload inválido abortou'; end;
end $$;
select t_assert((select count(*) from insumos) = :antes, 'importação com erro não deixa insumo órfão (transação atômica)');

-- 6. PERMISSÕES: anon/authenticated não executam nem leem
select t_assert(not has_function_privilege('anon','fn_catalogo_importar(uuid,text,jsonb,uuid,jsonb,boolean)','execute'), 'anon não executa a importação');
select t_assert(not has_function_privilege('authenticated','fn_catalogo_importar(uuid,text,jsonb,uuid,jsonb,boolean)','execute'), 'authenticated não executa a importação');
select t_assert(has_function_privilege('service_role','fn_catalogo_importar(uuid,text,jsonb,uuid,jsonb,boolean)','execute'), 'service_role executa');
select t_assert((select bool_and(relrowsecurity) from pg_class where relname in ('catalogo_origem','catalogo_importacoes','ficha_mao_de_obra')), 'RLS ligado nas 3 tabelas novas');
