-- =====================================================================
-- 157b — Pré-ativação: comissões por canal das Subways (OPCIONAL · NÃO EXECUTAR SEM APROVAÇÃO)
--
-- POR QUE EXISTE
--   O Simulador de Preço deixou de usar os percentuais fixos do front (iFood 27%, Uber 15%) e passou
--   a ler `canais_venda` DA EMPRESA. Empresas que nunca tiveram linhas ali (talvez as Subways mais antigas)
--   passariam a ver "comissão não configurada" (cálculo parcial) até alguém cadastrar.
--   Este arquivo existe para você ver QUEM está nessa situação e, só se decidir, semear os valores que
--   o front usava antes — de forma explícita e auditável, NUNCA para a Caramelle.
--
-- COMO USAR
--   1) Rode APENAS o bloco "PRÉ-VISUALIZAÇÃO" (SELECT, somente leitura). Ele lista organizações que:
--      - têm preço iFood cadastrado (produto_precos canal='ifood') e
--      - não têm nenhuma linha em canais_venda.
--      Confira a lista. A Caramelle NÃO deve aparecer (ela não tem tabela de preços iFood).
--   2) Se (e somente se) a lista estiver correta e houver autorização, descomente e rode o bloco "SEMEADURA"
--      informando os ids conferidos em `organizacoes_confirmadas`.
--   3) Reversão: o bloco "REVERSÃO" apaga só o que foi semeado (marcado em `origem` via comentário abaixo).
-- =====================================================================

-- ---------------- PRÉ-VISUALIZAÇÃO (somente leitura) ----------------
select o.id, o.nome,
       (select count(*) from produto_precos pp join produtos p on p.id = pp.produto_id
         where p.organizacao_id = o.id and pp.canal = 'ifood') as precos_ifood
  from organizacoes o
 where not exists (select 1 from canais_venda cv where cv.organizacao_id = o.id)
   and exists (select 1 from produto_precos pp join produtos p on p.id = pp.produto_id
                where p.organizacao_id = o.id and pp.canal = 'ifood')
 order by o.nome;

-- ---------------- SEMEADURA (COMENTADA — requer aprovação explícita) ----------------
-- begin;
-- with organizacoes_confirmadas(id) as (values
--   -- ('00000000-0000-0000-0000-000000000000'::uuid)   -- cole aqui SÓ os ids que você conferiu
--   ('00000000-0000-0000-0000-000000000000'::uuid)
-- )
-- insert into canais_venda (organizacao_id, canal, comissao_pct, ativo)
-- select c.id, v.canal::canal, v.pct, true
--   from organizacoes_confirmadas c
--  cross join (values ('balcao', 0.0000), ('ifood', 0.2700), ('uber', 0.1500)) as v(canal, pct)
--  where c.id <> '00000000-0000-0000-0000-000000000000'
-- on conflict (organizacao_id, canal) do nothing;
-- -- confira o resultado antes de confirmar:
-- -- select organizacao_id, canal, comissao_pct from canais_venda where organizacao_id in (select id from organizacoes_confirmadas);
-- commit;   -- troque por rollback; para desistir

-- ---------------- REVERSÃO (COMENTADA) ----------------
-- delete from canais_venda where organizacao_id in (/* os mesmos ids */ '00000000-0000-0000-0000-000000000000')
--   and ((canal='balcao' and comissao_pct=0) or (canal='ifood' and comissao_pct=0.27) or (canal='uber' and comissao_pct=0.15));
