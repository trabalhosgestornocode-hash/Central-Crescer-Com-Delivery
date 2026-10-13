-- =====================================================================
-- DESATIVAR uma loja iFood adicional (parada imediata no próximo ciclo; sem deploy). Reversão do cadastro/liberação.
-- =====================================================================
-- O poller deixa de consultar a loja no próximo ciclo (lê a lista a cada ciclo). Os pedidos já gravados dela PERMANECEM. Se a loja ainda
-- estiver aberta no iFood e o Gestor fechado, ela sai do ar depois de alguns minutos SEM polling: coordene com o responsável antes.
--
-- Uso:  psql "<conexão>" -v ON_ERROR_STOP=1 -v merchant=<UUID do merchant adicional> -f ifood-loja-extra-desativar.sql
-- =====================================================================
\set ON_ERROR_STOP on
begin;
select count(*) = 1 as ok from ifood_conexao_lojas where merchant_id = :'merchant' and estado <> 'desativada' \gset
\if :ok
  update ifood_conexao_lojas set estado = 'desativada', desativada_em = now() where merchant_id = :'merchant' and estado <> 'desativada';
  insert into plataforma_auditoria (ator_tipo, acao, entidade, entidade_id, organizacao_id, detalhes)
  select 'sistema', 'ifood.loja_extra_desativada', 'ifood_conexao_loja', l.id::text, l.organizacao_id, jsonb_build_object('pedidos_preservados', true)
    from ifood_conexao_lojas l where l.merchant_id = :'merchant' and l.estado = 'desativada' order by l.desativada_em desc limit 1;
  select 'DESATIVADA: o poller para de consultar a loja no próximo ciclo.' as resultado;
  commit;
\else
  rollback;
  \echo 'ABORTADO: não há loja adicional viva com este merchant. Nada foi gravado.'
  select 1 / 0;
\endif
