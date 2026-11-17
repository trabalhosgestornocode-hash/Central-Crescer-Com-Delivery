-- =====================================================================================================================
-- Financeiro v2 — migração 0025: FECHAMENTO MANUAL DE CAIXA (Fase 04, doc 42)
--
-- Só é aplicada no PostgreSQL local isolado e, depois de autorizada, no schema dedicado. Não pertence a database/migrations/.
--
-- O que muda (e o que NÃO muda):
--   * Nova tabela fv2_fechamento_caixa: o fechamento que a equipe envia (um por dia × caixa), com as formas de pagamento,
--     esperado × informado × diferença e o dinheiro (abertura, vendas, retiradas, reforços, transferências).
--   * O fechamento é CONFERÊNCIA: não gera receita, lançamento nem movimentação (as vendas vêm das importações).
--   * Mesmas proteções das demais tabelas: escopo por empresa/unidade (RLS), sem exclusão, versão e histórico obrigatórios.
--   * Nada existente é alterado (só a função fv2_tabela_do_tipo ganha o tipo novo).
-- =====================================================================================================================

create table fv2_fechamento_caixa (
  seq                bigint generated always as identity,
  id                 uuid not null primary key,
  organizacao_id     uuid not null,
  unidade_id         uuid not null,
  versao             integer not null check (versao >= 1),
  criado_em          timestamptz not null,
  criado_por         uuid not null,
  atualizado_em      timestamptz not null,
  atualizado_por     uuid not null,
  chave_idempotencia text check (chave_idempotencia is null or length(chave_idempotencia) between 1 and 400),
  impressao          text,
  extras             jsonb not null default '{}'::jsonb check (jsonb_typeof(extras) = 'object'),
  data               date not null,
  caixa              text not null check (length(btrim(caixa)) between 1 and 40),
  situacao           text not null check (situacao in ('REGISTRADO', 'CONFERIDO')),
  dados              jsonb not null check (jsonb_typeof(dados) = 'object'),
  observacao         text,
  unique (organizacao_id, unidade_id, id),
  unique (organizacao_id, unidade_id, data, caixa),
  check (atualizado_em >= criado_em)
);

alter table fv2_fechamento_caixa add constraint fv2_fechamento_caixa_escopo_fk foreign key (organizacao_id, unidade_id) references fv2_escopo;
create unique index fv2_fechamento_caixa_chave_uq on fv2_fechamento_caixa (organizacao_id, unidade_id, chave_idempotencia) where chave_idempotencia is not null;
create index fv2_fechamento_caixa_data on fv2_fechamento_caixa (organizacao_id, unidade_id, data);
create trigger fv2_fechamento_caixa_sem_delete before delete on fv2_fechamento_caixa for each row execute function fv2_proibir_exclusao();
create trigger fv2_fechamento_caixa_sem_truncate before truncate on fv2_fechamento_caixa for each statement execute function fv2_proibir_exclusao();
create trigger fv2_fechamento_caixa_versao before update on fv2_fechamento_caixa for each row execute function fv2_guardar_versao();
create constraint trigger fv2_fechamento_caixa_historico after insert or update on fv2_fechamento_caixa deferrable initially deferred
  for each row execute function fv2_exigir_historico('FECHAMENTO_CAIXA');

alter table fv2_fechamento_caixa enable row level security;
alter table fv2_fechamento_caixa force row level security;
create policy fv2_fechamento_caixa_escopo on fv2_fechamento_caixa
  using (organizacao_id = (select fv2_org()) and unidade_id = (select fv2_uni()))
  with check (organizacao_id = (select fv2_org()) and unidade_id = (select fv2_uni()));
create policy fv2_fechamento_caixa_ler on fv2_fechamento_caixa as restrictive for select using ((select fv2_sessao_operacional()));
create policy fv2_fechamento_caixa_incluir on fv2_fechamento_caixa as restrictive for insert with check ((select fv2_tem_acao(array['financeiro_v2.registrar'])));
create policy fv2_fechamento_caixa_alterar on fv2_fechamento_caixa as restrictive for update
  using ((select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir', 'financeiro_v2.conciliar'])))
  with check ((select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir', 'financeiro_v2.conciliar'])));
grant select, insert, update on fv2_fechamento_caixa to fv2_app;

create or replace function fv2_tabela_do_tipo(p_tipo text) returns regclass language sql immutable as $$
  select case p_tipo
    when 'CONTA' then 'fv2_conta' when 'CONTRAPARTE' then 'fv2_contraparte' when 'CATEGORIA' then 'fv2_categoria'
    when 'LANCAMENTO' then 'fv2_lancamento' when 'VENDA' then 'fv2_venda' when 'PAGAMENTO_VENDA' then 'fv2_pagamento_venda'
    when 'OBRIGACAO' then 'fv2_obrigacao' when 'RECEBIVEL' then 'fv2_recebivel' when 'MOVIMENTACAO' then 'fv2_movimentacao'
    when 'LIQUIDACAO' then 'fv2_liquidacao' when 'TRANSFERENCIA' then 'fv2_transferencia' when 'AJUSTE' then 'fv2_ajuste'
    when 'ESTORNO' then 'fv2_estorno' when 'DOCUMENTO' then 'fv2_documento' when 'VINCULO_DOCUMENTAL' then 'fv2_vinculo_documental'
    when 'CORRESPONDENCIA' then 'fv2_correspondencia' when 'COMPETENCIA' then 'fv2_competencia'
    when 'IMPORTACAO' then 'fv2_importacao' when 'REGISTRO_FONTE' then 'fv2_registro_fonte' when 'CONCESSAO' then 'fv2_concessao'
    when 'PROPOSTA' then 'fv2_proposta' when 'DIVERGENCIA_FONTE' then 'fv2_divergencia_fonte'
    when 'SALDO_CONTA' then 'fv2_saldo_conta' when 'SESSAO_CAIXA' then 'fv2_sessao_caixa'
    when 'VERSAO_FECHAMENTO' then 'fv2_versao_fechamento' when 'ATRIBUICAO_PENDENCIA' then 'fv2_atribuicao_pendencia'
    when 'CANAL_PROCESSADOR' then 'fv2_canal_processador' when 'CONFIGURACAO_UNIDADE' then 'fv2_configuracao_unidade'
    when 'ABERTURA' then 'fv2_abertura' when 'FECHAMENTO_CAIXA' then 'fv2_fechamento_caixa'
  end::regclass
$$;
