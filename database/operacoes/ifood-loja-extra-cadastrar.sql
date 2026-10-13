-- =====================================================================
-- CADASTRAR uma loja iFood ADICIONAL numa unidade (ex.: Subway Saladas na Subway Saci — Matriz). NÃO consulta o iFood.
-- =====================================================================
-- ⚠️  Só com autorização expressa. Cria a loja no estado `pendente`: o poller NUNCA consulta uma loja `pendente`.
--     Depois do cadastro vem a LIBERAÇÃO supervisionada (ifood-loja-extra-liberar.sql), que é um passo separado e explícito.
--
-- Uso (psql com TLS):
--   psql "<conexão>" -v ON_ERROR_STOP=1 -v unidade=<UUID da unidade> -v merchant=<UUID do merchant iFood> -v rotulo=<nome curto> \
--        -f ifood-loja-extra-cadastrar.sql
-- Pré-condições (qualquer falha ABORTA e não grava nada): a unidade tem conexão viva `ativa` com merchant principal e credencial Order `ativa`;
-- o merchant tem formato de UUID, NÃO é a loja principal de nenhuma conexão e não está cadastrado em outra loja adicional viva.
-- A tabela é backend-only (RLS sem policy); o gatilho do banco confere que organização/unidade são as da conexão.
-- =====================================================================
\set ON_ERROR_STOP on
begin;

select count(*) = 1 as ok
  from ifood_conexoes c
 where c.unidade_id = :'unidade'::uuid and c.status = 'ativa' and c.merchant_id is not null
   and exists (select 1 from ifood_credenciais k where k.conexao_id = c.id and k.app_type = 'order' and k.status = 'ativa')
   and :'merchant' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   and not exists (select 1 from ifood_conexoes x where x.merchant_id = :'merchant' and x.status <> 'revogada')
   and not exists (select 1 from ifood_conexao_lojas l where l.merchant_id = :'merchant' and l.estado <> 'desativada') \gset
\if :ok
  insert into ifood_conexao_lojas (conexao_id, organizacao_id, unidade_id, merchant_id, rotulo)
  select c.id, c.organizacao_id, c.unidade_id, :'merchant', nullif(btrim(:'rotulo'), '')
    from ifood_conexoes c where c.unidade_id = :'unidade'::uuid and c.status = 'ativa';
  insert into plataforma_auditoria (ator_tipo, acao, entidade, entidade_id, organizacao_id, detalhes)
  select 'sistema', 'ifood.loja_extra_cadastrada', 'ifood_conexao_loja', l.id::text, l.organizacao_id,
         jsonb_build_object('estado', 'pendente', 'rotulo', l.rotulo, 'unidade_id', l.unidade_id, 'consulta_ao_ifood', false)
    from ifood_conexao_lojas l where l.merchant_id = :'merchant' and l.estado = 'pendente';
  select 'CADASTRADA (pendente): nenhuma consulta ao iFood foi feita.' as resultado;
  commit;
\else
  rollback;
  \echo 'ABORTADO: pré-condições não atendidas (unidade sem conexão ativa/credencial Order, merchant inválido, ou merchant já em uso). Nada foi gravado.'
  select 1 / 0;
\endif
