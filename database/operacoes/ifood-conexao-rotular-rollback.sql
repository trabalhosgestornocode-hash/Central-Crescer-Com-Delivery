-- =====================================================================
-- Reverter a rotulagem de uma conexão iFood (financeiro_homologacao | pedidos_producao -> legado). SUPERVISIONADO.
-- =====================================================================
-- Só volta finalidade='legado' e ambiente='nao_informado'. Recusa (aborta) se a unidade tiver outra conexão viva (a volta a `legado` faria
-- a seleção por finalidade perder a distinção entre as duas): revogue/ajuste a outra ANTES, por decisão explícita.
--
-- Uso:  psql "<conexão>" -v ON_ERROR_STOP=1 -v conexao=<UUID da conexão> -f ifood-conexao-rotular-rollback.sql
-- =====================================================================
\set ON_ERROR_STOP on
begin;
select count(*) = 1 as ok from ifood_conexoes c
 where c.id = :'conexao' and c.finalidade <> 'legado'
   and not exists (select 1 from ifood_conexoes o where o.unidade_id = c.unidade_id and o.id <> c.id and o.status <> 'revogada') \gset
\if :ok
  update ifood_conexoes set finalidade = 'legado', ambiente = 'nao_informado' where id = :'conexao';
  insert into plataforma_auditoria (ator_tipo, acao, entidade, entidade_id, organizacao_id, detalhes)
  select 'sistema', 'ifood.conexao_rotulo_revertido', 'ifood_conexao', c.id::text, c.organizacao_id, jsonb_build_object('finalidade', 'legado')
    from ifood_conexoes c where c.id = :'conexao';
  select id, unidade_id, status, finalidade, ambiente from ifood_conexoes where id = :'conexao';
  commit;
\else
  rollback;
  \echo 'ABORTADO: conexao ja e legado, inexistente, ou a unidade tem OUTRA conexao viva. Nada foi gravado.'
  select 1 / 0;
\endif
