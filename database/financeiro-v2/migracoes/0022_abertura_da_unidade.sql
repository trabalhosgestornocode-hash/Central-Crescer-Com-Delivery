-- =====================================================================================================================
-- Financeiro v2 — migração 0022: ABERTURA FINANCEIRA DA UNIDADE (doc 32)
--
-- ADITIVA: só cria uma tabela e atualiza o mapa de tipos. Não altera dado nem regra existente.
--
-- A abertura fixa, por unidade, a COMPETÊNCIA DE INÍCIO e a DATA DE CORTE (véspera do 1º dia): os saldos de abertura e
-- os títulos anteriores são posições nessa data, e nenhuma importação aplica efeito econômico anterior a ela.
--   * uma linha por unidade (única); nunca excluída; cada mudança é nova versão com histórico (mesmo gatilho das demais);
--   * gravada só por quem tem `configurar` (RLS), na sessão de banco da pessoa (identidade individual);
--   * a coerência (início = dia seguinte ao corte; competência = mês do início) é conferida também aqui.
-- =====================================================================================================================

create table fv2_abertura (
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
  competencia_inicio text not null check (competencia_inicio ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  data_de_corte      date not null,
  situacao           text not null check (situacao in ('CONFIGURADA', 'CONCLUIDA')),
  observacao         text,
  unique (organizacao_id, unidade_id, id),
  unique (organizacao_id, unidade_id),
  check (atualizado_em >= criado_em),
  check (to_char(data_de_corte + 1, 'YYYY-MM-DD') = competencia_inicio || '-01')
);

alter table fv2_abertura add constraint fv2_abertura_escopo_fk foreign key (organizacao_id, unidade_id) references fv2_escopo;
create unique index fv2_abertura_chave_uq on fv2_abertura (organizacao_id, unidade_id, chave_idempotencia) where chave_idempotencia is not null;
create trigger fv2_abertura_sem_delete before delete on fv2_abertura for each row execute function fv2_proibir_exclusao();
create trigger fv2_abertura_sem_truncate before truncate on fv2_abertura for each statement execute function fv2_proibir_exclusao();
create trigger fv2_abertura_versao before update on fv2_abertura for each row execute function fv2_guardar_versao();
create constraint trigger fv2_abertura_historico after insert or update on fv2_abertura deferrable initially deferred
  for each row execute function fv2_exigir_historico('ABERTURA');

alter table fv2_abertura enable row level security;
alter table fv2_abertura force row level security;
-- Mesmas quatro políticas das demais tabelas de cadastro (conferidas contra fv2_configuracao_unidade):
create policy fv2_abertura_escopo on fv2_abertura
  using (organizacao_id = (select fv2_org()) and unidade_id = (select fv2_uni()))
  with check (organizacao_id = (select fv2_org()) and unidade_id = (select fv2_uni()));
create policy fv2_abertura_ler on fv2_abertura as restrictive for select using ((select fv2_sessao_operacional()));
create policy fv2_abertura_incluir on fv2_abertura as restrictive for insert with check ((select fv2_tem_acao(array['financeiro_v2.configurar'])));
create policy fv2_abertura_alterar on fv2_abertura as restrictive for update
  using ((select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar',
    'financeiro_v2.fechar', 'financeiro_v2.homologar', 'financeiro_v2.revisar', 'financeiro_v2.configurar', 'financeiro_v2.importar',
    'financeiro_v2.conceder', 'financeiro_v2.documentos', 'financeiro_v2.aprovar', 'financeiro_v2.aplicar', 'financeiro_v2.revogar',
    'financeiro_v2.confirmar_importacao', 'financeiro_v2.reabrir', 'financeiro_v2.reclassificar', 'financeiro_v2.enviar_documento',
    'financeiro_v2.vincular_pagamento'])))
  with check ((select fv2_tem_acao(array['financeiro_v2.configurar'])));
grant select, insert, update on fv2_abertura to fv2_app;

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
    when 'ABERTURA' then 'fv2_abertura'
  end::regclass
$$;
