-- Testes da migration 163 (rodar DEPOIS de 157 + 158 + 163 e dos testes 10/20).
\set ON_ERROR_STOP on
create or replace function t_assert3(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'FALHA: %', msg; end if; raise notice 'ok - %', msg; end $$;

-- 0. Retrocompatibilidade: Subways idênticas e colunas novas nulas/false
select t_assert3((select count(*) from snap_custo s where abs(fn_custo_produto(s.id) - s.custo) > 1e-12 and s.id::text like '22222222%') = 0, '163: custo das Subways idêntico ao snapshot');
select t_assert3((select count(*) from insumos where custo_zero_declarado) = 0, 'nenhum insumo nasce com custo zero declarado');
select t_assert3((select count(*) from ficha_tecnica where peso_bruto is not null or peso_liquido is not null) = 0, 'nenhuma linha antiga reinterpretada (pesos nulos)');

-- Cenário "Loja Doces" isolado: org C. Água sem custo usada por duas fichas; preparação CREME BASE com rendimento 2,6 g.
insert into insumos (id, organizacao_id, nome, unidade_medida, preco_unitario) values
 ('33333333-0000-4000-8000-0000000000a1','c0000000-0000-4000-8000-000000000003','AGUA','ml',0),
 ('33333333-0000-4000-8000-0000000000a2','c0000000-0000-4000-8000-000000000003','INSUMO A','g',0.015);
insert into produtos (id, organizacao_id, nome, vendavel, tipo, rendimento, unidade_rendimento, homologacao) values
 ('44444444-0000-4000-8000-0000000000b1','c0000000-0000-4000-8000-000000000003','CREME BASE','f','submontagem',2.6,'g','pendente'),
 ('44444444-0000-4000-8000-0000000000b2','c0000000-0000-4000-8000-000000000003','BOLO BASE','t','sobremesa',1,null,'homologada');
insert into ficha_tecnica (produto_id, insumo_id, quantidade) values ('44444444-0000-4000-8000-0000000000b1','33333333-0000-4000-8000-0000000000a2',2700);
insert into ficha_tecnica (produto_id, subproduto_id, quantidade) values ('44444444-0000-4000-8000-0000000000b2','44444444-0000-4000-8000-0000000000b1',400);
update produtos set homologacao='homologada', homologado_custo=1 where id='44444444-0000-4000-8000-0000000000b2';

-- 1. CUSTO ZERO DECLARADO
do $$ begin
  begin perform fn_custo_zero('c0000000-0000-4000-8000-000000000003','33333333-0000-4000-8000-0000000000a1', true, '  ', 'Ana', null); raise exception 'deveria recusar';
  exception when sqlstate '22023' then raise notice 'ok - custo zero sem motivo recusado'; end;
  begin perform fn_custo_zero('a0000000-0000-4000-8000-000000000001','33333333-0000-4000-8000-0000000000a1', true, 'x', 'Ana', null); raise exception 'deveria recusar';
  exception when sqlstate '42501' then raise notice 'ok - outra organização não declara custo zero de insumo alheio'; end;
  begin update insumos set custo_zero_declarado = true where id='33333333-0000-4000-8000-0000000000a1'; raise exception 'deveria recusar';
  exception when check_violation then raise notice 'ok - constraint: declaração exige motivo (nem por SQL direto)'; end;
end $$;
select fn_custo_zero('c0000000-0000-4000-8000-000000000003','33333333-0000-4000-8000-0000000000a1', true, 'Água da rede absorvida nas despesas operacionais', 'Ana', 'ana@x');
select t_assert3((select custo_zero_declarado and preco_unitario = 0 and custo_zero_por = 'Ana' and custo_zero_em is not null from insumos where id='33333333-0000-4000-8000-0000000000a1'), 'declarado: preço 0, responsável e data');
select t_assert3((select (fn_custo_zero('c0000000-0000-4000-8000-000000000003','33333333-0000-4000-8000-0000000000a1', true, 'de novo', 'Ana', null))->>'alterado') = 'false', 'declarar de novo é idempotente');
select fn_custo_zero('c0000000-0000-4000-8000-000000000003','33333333-0000-4000-8000-0000000000a1', false, 'revisão: passou a ser água mineral comprada', 'Bia', null);
select t_assert3((select not custo_zero_declarado and preco_unitario = 0 from insumos where id='33333333-0000-4000-8000-0000000000a1'), 'revogar volta a DESCONHECIDO (0 sem declaração), nunca a zero declarado');
select t_assert3((select count(*) from catalogo_correcoes where entidade_id='33333333-0000-4000-8000-0000000000a1') = 2, 'histórico: declaração + revogação');

-- 1b. Tela ANTIGA de insumos informa preço num insumo com custo zero declarado: grava o preço e encerra a declaração
select fn_custo_zero('c0000000-0000-4000-8000-000000000003','33333333-0000-4000-8000-0000000000a1', true, 'água da rede', 'Ana', null);
update insumos set preco_unitario = 0.0003 where id='33333333-0000-4000-8000-0000000000a1'; -- caminho legado (sem fn_custo_zero)
select t_assert3((select not custo_zero_declarado and preco_unitario = 0.0003 and custo_zero_motivo is null from insumos where id='33333333-0000-4000-8000-0000000000a1'), 'preço informado pela tela antiga encerra a declaração (sem erro de constraint)');
select t_assert3((select count(*) from catalogo_correcoes where entidade_id='33333333-0000-4000-8000-0000000000a1' and justificativa like 'preço de compra%') = 1, 'encerramento automático auditado');
update insumos set preco_unitario = 0 where id='33333333-0000-4000-8000-0000000000a1'; -- volta ao estado do cenário (desconhecido)

-- 2. CORREÇÃO DE RENDIMENTO (transacional)
do $$ begin
  begin perform fn_corrigir_rendimentos('c0000000-0000-4000-8000-000000000003', '[{"produto_id":"44444444-0000-4000-8000-0000000000b1","rendimento_atual":2.6,"rendimento_novo":2600,"justificativa":"ok"},{"produto_id":"44444444-0000-4000-8000-0000000000b2","rendimento_atual":1,"rendimento_novo":2,"justificativa":"x"}]', 'Ana', null);
    raise exception 'deveria recusar';
  exception when sqlstate '22023' then raise notice 'ok - lote com produto que não é preparação é recusado INTEIRO'; end;
  begin perform fn_corrigir_rendimentos('c0000000-0000-4000-8000-000000000003', '[{"produto_id":"44444444-0000-4000-8000-0000000000b1","rendimento_atual":2.5,"rendimento_novo":2600,"justificativa":"x"}]', 'Ana', null); raise exception 'deveria recusar';
  exception when sqlstate '40001' then raise notice 'ok - valor atual divergente (concorrência) recusado'; end;
  begin perform fn_corrigir_rendimentos('a0000000-0000-4000-8000-000000000001', '[{"produto_id":"44444444-0000-4000-8000-0000000000b1","rendimento_atual":2.6,"rendimento_novo":2600,"justificativa":"x"}]', 'Ana', null); raise exception 'deveria recusar';
  exception when sqlstate '42501' then raise notice 'ok - outra organização não corrige preparação alheia'; end;
  begin perform fn_corrigir_rendimentos('a0000000-0000-4000-8000-000000000001', '[{"produto_id":"22222222-0000-4000-8000-000000000001","rendimento_atual":1,"rendimento_novo":5,"justificativa":"x"}]', 'Ana', null); raise exception 'deveria recusar';
  exception when sqlstate '22023' then raise notice 'ok - ficha padronizada (Subway) não entra na correção'; end;
end $$;
select t_assert3((select rendimento from produtos where id='44444444-0000-4000-8000-0000000000b1') = 2.6, 'lote recusado não alterou nada (atomicidade)');
select fn_corrigir_rendimentos('c0000000-0000-4000-8000-000000000003', '[{"produto_id":"44444444-0000-4000-8000-0000000000b1","rendimento_atual":2.6,"rendimento_novo":2600,"justificativa":"lote pesado: 2.6 g"}]', 'Ana', 'ana@x');
select t_assert3((select rendimento from produtos where id='44444444-0000-4000-8000-0000000000b1') = 2600, 'rendimento corrigido');
select t_assert3(abs(fn_custo_produto('44444444-0000-4000-8000-0000000000b1') - 2700*0.015/2600) < 1e-9, 'custo por grama recalculado (R$ ~0,0154/g, não R$ 15/g)');
select t_assert3((select homologacao from produtos where id='44444444-0000-4000-8000-0000000000b2') = 'pendente', 'dependente homologado foi invalidado (gatilho da 158)');
select t_assert3((select count(*) from catalogo_correcoes where tipo='rendimento' and entidade_id='44444444-0000-4000-8000-0000000000b1') = 1
  and (select count(*) from produto_historico where produto_id='44444444-0000-4000-8000-0000000000b1' and campo='rendimento') = 1, 'correção auditada (correções + histórico do produto)');

-- 3. PESOS da ficha
do $$ begin
  begin insert into ficha_tecnica (produto_id, insumo_id, quantidade, peso_bruto, peso_liquido) values ('44444444-0000-4000-8000-0000000000b2','33333333-0000-4000-8000-0000000000a2',100,100,120); raise exception 'deveria recusar';
  exception when check_violation then raise notice 'ok - peso líquido maior que bruto recusado'; end;
  begin update insumos set aproveitamento_pct = 0 where id='33333333-0000-4000-8000-0000000000a2'; raise exception 'deveria recusar';
  exception when check_violation then raise notice 'ok - aproveitamento 0%% recusado'; end;
end $$;

-- 4. Tabelas novas fechadas para anon/authenticated (se os papéis existirem no stub)
select t_assert3(not exists (select 1 from information_schema.role_table_grants where table_name in ('produto_rascunhos','catalogo_correcoes','produto_precos_historico') and grantee in ('anon','authenticated')), 'tabelas novas sem grant para anon/authenticated');
select t_assert3(not has_function_privilege('public', 'fn_corrigir_rendimentos(uuid, jsonb, text, text)', 'execute'), 'fn_corrigir_rendimentos não executável por public');
