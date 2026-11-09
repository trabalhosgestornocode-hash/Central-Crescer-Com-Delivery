-- Testes da migration 158 (rodar DEPOIS de 157 + 158 e do 10_catalogo.test.sql).
\set ON_ERROR_STOP on
create or replace function t_assert2(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'FALHA: %', msg; end if; raise notice 'ok - %', msg; end $$;

-- 1. CONDIÇÕES: as comissões existentes das Subways permanecem EXATAMENTE como estavam
select t_assert2((select count(*) from canais_venda where organizacao_id='a0000000-0000-4000-8000-000000000001' and comissao_pct = 0.27 and canal='ifood') = 1, 'Subway X manteve comissão iFood 27% após a 158');
select t_assert2((select count(*) from canais_venda where organizacao_id='a0000000-0000-4000-8000-000000000001' and (taxas_pct is not null or promocao_pct is not null or entrega_custo is not null)) = 0, 'campos novos nascem NULL (não configurado), nunca zero');
select t_assert2((select count(*) from canais_venda where organizacao_id='c0000000-0000-4000-8000-000000000003') = 0, 'Caramelle continua sem linhas em canais_venda (nada semeado)');

-- 2. CONSTRAINTS das condições
do $$ begin
  begin insert into canais_venda (organizacao_id, canal, comissao_pct, taxas_pct) values ('c0000000-0000-4000-8000-000000000003','ifood',0.2,1.5); raise exception 'deveria recusar';
  exception when check_violation then raise notice 'ok - percentual >= 100%% recusado'; end;
  begin insert into canais_venda (organizacao_id, canal, comissao_pct, entrega_responsavel) values ('c0000000-0000-4000-8000-000000000003','uber',0.1,'ninguem'); raise exception 'deveria recusar';
  exception when check_violation then raise notice 'ok - responsável pela entrega inválido recusado'; end;
end $$;
insert into canais_venda (organizacao_id, canal, comissao_pct, taxas_pct, promocao_pct, tributos_pct, entrega_responsavel, entrega_custo, outras_deducoes)
values ('c0000000-0000-4000-8000-000000000003','ifood',0.23,0.015,0.05,0.04,'loja',6.5,'[{"nome":"Embalagem delivery","pct":0.01}]');
select t_assert2((select comissao_pct from canais_venda where organizacao_id='c0000000-0000-4000-8000-000000000003' and canal='ifood') = 0.23, 'Caramelle: condições próprias gravadas');
select t_assert2((select comissao_pct from canais_venda where organizacao_id='a0000000-0000-4000-8000-000000000001' and canal='ifood') = 0.27, 'Subway X inalterada pela configuração da Caramelle');

-- 3. HOMOLOGAÇÃO: invalidação por COMPOSIÇÃO (cadeia: Torta usa Bechamel, que usa Requeijão)
-- 44444444-...02 = Bechamel (preparação), ...03 = Torta (usa Bechamel), ...01 = Empadão (independente)
update produtos set homologacao='homologada', homologado_em=now(), homologado_custo=1.0, homologado_por_nome='Admin Teste' where id in
 ('44444444-0000-4000-8000-000000000001','44444444-0000-4000-8000-000000000002','44444444-0000-4000-8000-000000000003');
insert into insumos (id, organizacao_id, nome, unidade_medida, preco_unitario) values ('33333333-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000003','Sal','g',0.003);
insert into ficha_tecnica (produto_id, insumo_id, quantidade)
  values ('44444444-0000-4000-8000-000000000002','33333333-0000-4000-8000-000000000002',1); -- muda a composição do Bechamel
select t_assert2((select homologacao from produtos where id='44444444-0000-4000-8000-000000000002') = 'pendente', 'alterar a ficha da preparação invalida a homologação dela');
select t_assert2((select homologacao from produtos where id='44444444-0000-4000-8000-000000000003') = 'pendente', 'e de quem a usa como preparação (cascata)');
select t_assert2((select homologacao from produtos where id='44444444-0000-4000-8000-000000000001') = 'homologada', 'produto não relacionado permanece homologado');
select t_assert2((select homologacao_motivo from produtos where id='44444444-0000-4000-8000-000000000003') = 'composicao_alterada', 'motivo registrado');
select t_assert2((select homologado_em is null and homologado_custo is null and homologado_por_nome is null from produtos where id='44444444-0000-4000-8000-000000000003'), 'carimbo e custo homologado limpos');
select t_assert2((select count(*) from produto_historico where produto_id='44444444-0000-4000-8000-000000000003' and campo='homologacao') = 1, 'invalidação registrada no histórico');

-- RENDIMENTO invalida
update produtos set homologacao='homologada' where id='44444444-0000-4000-8000-000000000001';
update produtos set rendimento = 10 where id='44444444-0000-4000-8000-000000000001';
select t_assert2((select homologacao from produtos where id='44444444-0000-4000-8000-000000000001') = 'pendente' and (select homologacao_motivo from produtos where id='44444444-0000-4000-8000-000000000001') = 'rendimento_alterado', 'alterar rendimento invalida a homologação');
-- atualização que NÃO muda o rendimento não invalida
update produtos set homologacao='homologada' where id='44444444-0000-4000-8000-000000000001';
update produtos set rendimento = 10, nome = 'Empadão G' where id='44444444-0000-4000-8000-000000000001';
select t_assert2((select homologacao from produtos where id='44444444-0000-4000-8000-000000000001') = 'homologada', 'renomear (rendimento igual) não invalida');

-- 4. SUBWAYS (nao_aplicavel) nunca são tocadas pelos gatilhos
update ficha_tecnica set quantidade = quantidade where produto_id='22222222-0000-4000-8000-000000000002';
select t_assert2((select count(*) from produtos where id in (select id from snap_custo) and homologacao <> 'nao_aplicavel') = 0, 'Subways permanecem nao_aplicavel após mexer em fichas');
select t_assert2((select count(*) from snap_custo s where abs(fn_custo_produto(s.id) - s.custo) > 1e-12) = 0, 'custo das Subways idêntico após a 158');
select t_assert2((select bool_and(relrowsecurity) from pg_class where relname = 'canais_venda_historico'), 'RLS ligado no histórico das condições');

-- 5. INTEGRIDADE DA RECEITA: ciclo e vínculo entre organizações
-- 44..02 = Bechamel (preparação) ; 44..03 = Torta (usa Bechamel) ; 22..02 = sanduíche de OUTRA organização (Subway X)
do $$ begin
  begin insert into ficha_tecnica (produto_id, subproduto_id, quantidade) values ('44444444-0000-4000-8000-000000000002','44444444-0000-4000-8000-000000000003',1);
    raise exception 'ciclo indireto deveria ser recusado';
  exception when check_violation then raise notice 'ok - ciclo indireto (Bechamel usa Torta que usa Bechamel) recusado'; end;
  begin insert into ficha_tecnica (produto_id, subproduto_id, quantidade) values ('44444444-0000-4000-8000-000000000003','44444444-0000-4000-8000-000000000003',1);
    raise exception 'auto-referência deveria ser recusada';
  exception when check_violation or others then raise notice 'ok - auto-referência recusada'; end;
  begin insert into ficha_tecnica (produto_id, subproduto_id, quantidade) values ('44444444-0000-4000-8000-000000000003','22222222-0000-4000-8000-000000000002',1);
    raise exception 'vínculo entre organizações deveria ser recusado';
  exception when check_violation then raise notice 'ok - vínculo com preparação de OUTRA organização recusado'; end;
end $$;
-- caso válido continua funcionando (nova preparação da mesma empresa) e atualizar quantidade não dispara a validação
insert into produtos (id, organizacao_id, nome, rendimento, unidade_rendimento, vendavel, tipo) values
 ('44444444-0000-4000-8000-000000000004','c0000000-0000-4000-8000-000000000003','Cobertura',200,'g',false,'submontagem');
insert into ficha_tecnica (produto_id, subproduto_id, quantidade) values ('44444444-0000-4000-8000-000000000003','44444444-0000-4000-8000-000000000004',50);
select t_assert2((select count(*) from ficha_tecnica where produto_id='44444444-0000-4000-8000-000000000003' and subproduto_id='44444444-0000-4000-8000-000000000004') = 1, 'preparação válida da mesma empresa é aceita');
update ficha_tecnica set quantidade = 60 where produto_id='44444444-0000-4000-8000-000000000003' and subproduto_id='44444444-0000-4000-8000-000000000004';
select t_assert2((select quantidade from ficha_tecnica where produto_id='44444444-0000-4000-8000-000000000003' and subproduto_id='44444444-0000-4000-8000-000000000004') = 60, 'atualizar quantidade não é bloqueado');
-- adicionar a preparação invalida a homologação (gatilho de composição) e do pai
update produtos set homologacao='homologada' where id in ('44444444-0000-4000-8000-000000000003');
insert into produtos (id, organizacao_id, nome, rendimento, vendavel, tipo) values ('44444444-0000-4000-8000-000000000005','c0000000-0000-4000-8000-000000000003','Recheio',1,false,'submontagem');
insert into ficha_tecnica (produto_id, subproduto_id, quantidade) values ('44444444-0000-4000-8000-000000000003','44444444-0000-4000-8000-000000000005',1);
select t_assert2((select homologacao from produtos where id='44444444-0000-4000-8000-000000000003') = 'pendente', 'adicionar preparação à receita invalida a homologação');
