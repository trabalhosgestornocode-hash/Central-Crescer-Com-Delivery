-- =====================================================================
-- LIBERAR (verificação SUPERVISIONADA) de uma loja iFood adicional. É o ÚNICO jeito de uma loja `pendente` ou `bloqueada` voltar ao polling.
-- =====================================================================
-- ⚠️  SÓ com autorização expressa e com o acompanhamento humano da loja confirmado. Este script NÃO consulta o iFood: ele apenas marca a loja
--     como `liberada`. Quem consulta é o próprio poller em produção (o único que faz polling, detentor do lease), no próximo ciclo, UMA vez
--     por tentativa e no máximo 3 tentativas. Resultado:
--       * o iFood aceita              -> a loja vira `ativa` e seus eventos são processados normalmente (nada é descartado);
--       * o iFood recusa (403)        -> a loja vira `bloqueada` (persistente) e NUNCA mais é consultada até uma nova liberação como esta;
--       * 3 tentativas sem resposta   -> `bloqueada` (TENTATIVAS_ESGOTADAS).
-- Consultar um merchant NÃO autorizado é infração no iFood: libere SÓ depois de conferir no Portal do Parceiro que o aplicativo da Central
-- foi autorizado para ESTA loja. A consulta mantém a loja ABERTA no iFood enquanto durar o polling: o Gestor de Pedidos dela precisa estar
-- aberto e acompanhado.
--
-- Uso (psql com TLS):
--   psql "<conexão>" -v ON_ERROR_STOP=1 -v merchant=<UUID do merchant adicional> -v por="<quem autorizou>" -f ifood-loja-extra-liberar.sql
-- (use só caracteres ASCII em -v por: o psql no Windows recusa acentos em variáveis passadas pela linha de comando)
-- =====================================================================
\set ON_ERROR_STOP on
begin;
-- Chave que o gatilho exige para sair de `bloqueada` (vale só nesta transação).
set local app.liberacao_supervisionada = 'on';

select count(*) = 1 as ok from ifood_conexao_lojas where merchant_id = :'merchant' and estado in ('pendente', 'bloqueada')
   and exists (select 1 from ifood_conexoes c where c.id = conexao_id and c.status = 'ativa' and c.merchant_id is not null) \gset
\if :ok
  update ifood_conexao_lojas
     set estado = 'liberada', liberada_em = now(), liberada_por = left(nullif(btrim(:'por'), ''), 120), verificacoes = 0,
         bloqueada_em = null, bloqueio_motivo = null
   where merchant_id = :'merchant' and estado in ('pendente', 'bloqueada');
  insert into plataforma_auditoria (ator_tipo, acao, entidade, entidade_id, organizacao_id, detalhes)
  select 'sistema', 'ifood.loja_extra_liberada', 'ifood_conexao_loja', l.id::text, l.organizacao_id,
         jsonb_build_object('autorizado_por', l.liberada_por, 'max_tentativas', 3, 'consulta_feita_por', 'poller em producao (unico), no proximo ciclo')
    from ifood_conexao_lojas l where l.merchant_id = :'merchant' and l.estado = 'liberada';
  select 'LIBERADA: o poller fará UMA consulta por ciclo (máx. 3). Acompanhe os logs events.loja_extra_*' as resultado;
  commit;
\else
  rollback;
  \echo 'ABORTADO: não há exatamente uma loja `pendente`/`bloqueada` com este merchant numa conexão ativa. Nada foi gravado.'
  select 1 / 0;
\endif
