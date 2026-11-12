-- =====================================================================================================================
-- Financeiro v2 — migração 0003: liberações de acesso (concessões financeiro_v2.*) por organização + unidade (Execução 02B)
--
-- Só é aplicada no PostgreSQL local isolado (scripts/fv2-banco-teste.mjs). Não pertence a database/migrations/.
-- Regras protegidas no banco:
--   * uma linha por usuário por escopo; ações só do catálogo financeiro_v2.* (nada herdado do sistema antigo);
--   * ninguém concede a si mesmo (concedido_por ≠ usuario_id);
--   * concessão ativa tem ao menos uma ação; revogada não tem nenhuma;
--   * nada se apaga; toda versão tem histórico (quem concedeu/revogou, quando e por quê); RLS por escopo.
-- A PRIMEIRA concessão de cada escopo (administrador inicial) é provisionada fora da aplicação, como fv2_escopo.
-- =====================================================================================================================

create table fv2_concessao (
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
  usuario_id         uuid not null,
  acoes              jsonb not null check (jsonb_typeof(acoes) = 'array'),
  situacao           text not null check (situacao in ('ATIVA', 'REVOGADA')),
  concedido_por      uuid not null,
  justificativa      text not null check (length(btrim(justificativa)) between 1 and 500),
  unique (organizacao_id, unidade_id, id),
  unique (organizacao_id, unidade_id, usuario_id),
  check (atualizado_em >= criado_em),
  check (concedido_por <> usuario_id),
  check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar", "financeiro_v2.corrigir", "financeiro_v2.cancelar",
                    "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar", "financeiro_v2.revisar",
                    "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder"]'::jsonb),
  check ((situacao = 'ATIVA') = (jsonb_array_length(acoes) > 0))
);

alter table fv2_concessao add constraint fv2_concessao_escopo_fk foreign key (organizacao_id, unidade_id) references fv2_escopo;
create unique index fv2_concessao_chave_uq on fv2_concessao (organizacao_id, unidade_id, chave_idempotencia) where chave_idempotencia is not null;
create trigger fv2_concessao_sem_delete before delete on fv2_concessao for each row execute function fv2_proibir_exclusao();
create trigger fv2_concessao_sem_truncate before truncate on fv2_concessao for each statement execute function fv2_proibir_exclusao();
create trigger fv2_concessao_versao before update on fv2_concessao for each row execute function fv2_guardar_versao();
create constraint trigger fv2_concessao_historico after insert or update on fv2_concessao deferrable initially deferred
  for each row execute function fv2_exigir_historico('CONCESSAO');
alter table fv2_concessao enable row level security;
alter table fv2_concessao force row level security;
create policy fv2_concessao_escopo on fv2_concessao
  using (organizacao_id = fv2_org() and unidade_id = fv2_uni()) with check (organizacao_id = fv2_org() and unidade_id = fv2_uni());
grant select, insert, update on fv2_concessao to fv2_app;

create or replace function fv2_tabela_do_tipo(p_tipo text) returns regclass language sql immutable as $$
  select case p_tipo
    when 'CONTA' then 'fv2_conta' when 'CONTRAPARTE' then 'fv2_contraparte' when 'CATEGORIA' then 'fv2_categoria'
    when 'LANCAMENTO' then 'fv2_lancamento' when 'VENDA' then 'fv2_venda' when 'PAGAMENTO_VENDA' then 'fv2_pagamento_venda'
    when 'OBRIGACAO' then 'fv2_obrigacao' when 'RECEBIVEL' then 'fv2_recebivel' when 'MOVIMENTACAO' then 'fv2_movimentacao'
    when 'LIQUIDACAO' then 'fv2_liquidacao' when 'TRANSFERENCIA' then 'fv2_transferencia' when 'AJUSTE' then 'fv2_ajuste'
    when 'ESTORNO' then 'fv2_estorno' when 'DOCUMENTO' then 'fv2_documento' when 'VINCULO_DOCUMENTAL' then 'fv2_vinculo_documental'
    when 'CORRESPONDENCIA' then 'fv2_correspondencia' when 'COMPETENCIA' then 'fv2_competencia'
    when 'IMPORTACAO' then 'fv2_importacao' when 'REGISTRO_FONTE' then 'fv2_registro_fonte' when 'CONCESSAO' then 'fv2_concessao'
  end::regclass
$$;
