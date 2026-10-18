-- =====================================================================
-- ROTULAR a conexão iFood existente de uma unidade (legado -> financeiro_homologacao | pedidos_producao). SUPERVISIONADO.
-- =====================================================================
-- Pré-requisito para a unidade ganhar a 2ª conexão (ex.: Subway North Shopping: a conexão de teste vira `financeiro_homologacao`, e a de
-- pedidos reais nasce como `pedidos_producao`). SÓ muda finalidade e ambiente: merchant, status, credenciais e tokens NÃO são tocados.
-- Reversível: ifood-conexao-rotular-rollback.sql. NÃO use na Subway Saci (conexão `legado` com pedidos): ela permanece como está.
--
-- Recusa (aborta sem gravar) se: a conexão não existe/não é `legado`/não está viva; a finalidade é inválida; a conexão tem credencial
-- incompatível com a finalidade (financeiro_homologacao com credencial `order`; pedidos_producao com financial/analytics).
-- Para `financeiro_homologacao` exige ainda a confirmação -v confirmo_homologacao=sim (o merchant é de TESTE do iFood).
--
-- Uso:  psql "<conexão>" -v ON_ERROR_STOP=1 -v conexao=<UUID da conexão> -v finalidade=financeiro_homologacao \
--            -v confirmo_homologacao=sim -f ifood-conexao-rotular.sql
-- Antes e depois: select id, unidade_id, status, merchant_id is not null as tem_merchant, finalidade, ambiente from ifood_conexoes where id = '<UUID>';
-- =====================================================================
\set ON_ERROR_STOP on
begin;
select count(*) = 1 as ok from ifood_conexoes
 where id = :'conexao' and finalidade = 'legado' and status <> 'revogada'
   and :'finalidade' in ('financeiro_homologacao', 'pedidos_producao')
   and (:'finalidade' <> 'financeiro_homologacao' or :'confirmo_homologacao' = 'sim') \gset
\if :ok
  update ifood_conexoes
     set finalidade = :'finalidade',
         ambiente = case :'finalidade' when 'financeiro_homologacao' then 'homologacao' else 'producao' end
   where id = :'conexao';
  insert into plataforma_auditoria (ator_tipo, acao, entidade, entidade_id, organizacao_id, detalhes)
  select 'sistema', 'ifood.conexao_rotulada', 'ifood_conexao', c.id::text, c.organizacao_id,
         jsonb_build_object('finalidade', c.finalidade, 'ambiente', c.ambiente, 'credenciais_e_merchant_preservados', true)
    from ifood_conexoes c where c.id = :'conexao';
  select id, unidade_id, status, merchant_id is not null as tem_merchant, finalidade, ambiente from ifood_conexoes where id = :'conexao';
  commit;
\else
  rollback;
  \echo 'ABORTADO: conexao inexistente, nao legada, revogada, finalidade invalida ou falta -v confirmo_homologacao=sim. Nada foi gravado.'
  select 1 / 0;
\endif
