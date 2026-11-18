-- =====================================================================================================================
-- Financeiro v2 — migração 0026: ENTREGADORES PRÓPRIOS (fechamento semanal a partir do parser Foody Delivery)
--
-- Só é aplicada no PostgreSQL local isolado e, depois de autorizada, no schema dedicado. Não pertence a database/migrations/.
--
-- O que muda (e o que NÃO muda):
--   * fv2_semana_entregadores: o estado de cada semana da unidade (pendente ou consolidada) e suas divergências posteriores.
--   * fv2_fechamento_entregador: o retrato imutável do que foi apurado por entregador e semana + a conferência documental.
--   * A entrega em si continua SÓ no parser: aqui fica apenas o retrato da semana encerrada, que sustenta o demonstrativo.
--   * A conta a pagar continua em fv2_obrigacao: nenhuma tabela de pagamento nova, nenhum calendário paralelo.
--   * Mesmas proteções das demais tabelas: escopo por empresa/unidade (RLS), sem exclusão, versão e histórico obrigatórios.
--   * Nada existente é alterado (só a função fv2_tabela_do_tipo ganha os tipos novos).
-- =====================================================================================================================

create table fv2_semana_entregadores (
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
  semana_inicio      date not null check (extract(isodow from semana_inicio) = 1),
  semana_fim         date not null,
  situacao           text not null check (situacao in ('PENDENTE', 'CONSOLIDADA')),
  dados              jsonb not null check (jsonb_typeof(dados) = 'object'),
  unique (organizacao_id, unidade_id, id),
  unique (organizacao_id, unidade_id, semana_inicio),
  check (semana_fim = semana_inicio + 6),
  check (atualizado_em >= criado_em)
);

create table fv2_fechamento_entregador (
  seq                 bigint generated always as identity,
  id                  uuid not null primary key,
  organizacao_id      uuid not null,
  unidade_id          uuid not null,
  versao              integer not null check (versao >= 1),
  criado_em           timestamptz not null,
  criado_por          uuid not null,
  atualizado_em       timestamptz not null,
  atualizado_por      uuid not null,
  chave_idempotencia  text not null check (length(chave_idempotencia) between 1 and 400),
  impressao           text,
  extras              jsonb not null default '{}'::jsonb check (jsonb_typeof(extras) = 'object'),
  semana_inicio       date not null check (extract(isodow from semana_inicio) = 1),
  semana_fim          date not null,
  vencimento          date not null,
  entregador_chave    text not null check (length(btrim(entregador_chave)) between 1 and 200),
  entregador_nome     text not null check (length(btrim(entregador_nome)) between 1 and 200),
  obrigacao_id        uuid,
  valor_centavos      bigint not null check (valor_centavos > 0),
  entregas            integer not null check (entregas >= 0),
  situacao_documental text not null check (situacao_documental in ('AGUARDANDO_NF', 'NF_RECEBIDA', 'NF_EM_CONFERENCIA', 'NF_APROVADA', 'NF_REJEITADA', 'LIBERADO_PAGAMENTO')),
  dados               jsonb not null check (jsonb_typeof(dados) = 'object'),
  unique (organizacao_id, unidade_id, id),
  unique (organizacao_id, unidade_id, semana_inicio, entregador_chave),
  check (semana_fim = semana_inicio + 6),
  check (vencimento = semana_inicio + 9),
  check (atualizado_em >= criado_em)
);

alter table fv2_semana_entregadores add constraint fv2_semana_entregadores_escopo_fk foreign key (organizacao_id, unidade_id) references fv2_escopo;
alter table fv2_fechamento_entregador add constraint fv2_fechamento_entregador_escopo_fk foreign key (organizacao_id, unidade_id) references fv2_escopo;
create unique index fv2_semana_entregadores_chave_uq on fv2_semana_entregadores (organizacao_id, unidade_id, chave_idempotencia) where chave_idempotencia is not null;
create unique index fv2_fechamento_entregador_chave_uq on fv2_fechamento_entregador (organizacao_id, unidade_id, chave_idempotencia);
create unique index fv2_fechamento_entregador_obrigacao_uq on fv2_fechamento_entregador (organizacao_id, unidade_id, obrigacao_id) where obrigacao_id is not null;
create index fv2_fechamento_entregador_vencimento on fv2_fechamento_entregador (organizacao_id, unidade_id, vencimento);

create trigger fv2_semana_entregadores_sem_delete before delete on fv2_semana_entregadores for each row execute function fv2_proibir_exclusao();
create trigger fv2_semana_entregadores_sem_truncate before truncate on fv2_semana_entregadores for each statement execute function fv2_proibir_exclusao();
create trigger fv2_semana_entregadores_versao before update on fv2_semana_entregadores for each row execute function fv2_guardar_versao();
create constraint trigger fv2_semana_entregadores_historico after insert or update on fv2_semana_entregadores deferrable initially deferred
  for each row execute function fv2_exigir_historico('SEMANA_ENTREGADORES');
create trigger fv2_fechamento_entregador_sem_delete before delete on fv2_fechamento_entregador for each row execute function fv2_proibir_exclusao();
create trigger fv2_fechamento_entregador_sem_truncate before truncate on fv2_fechamento_entregador for each statement execute function fv2_proibir_exclusao();
create trigger fv2_fechamento_entregador_versao before update on fv2_fechamento_entregador for each row execute function fv2_guardar_versao();
create constraint trigger fv2_fechamento_entregador_historico after insert or update on fv2_fechamento_entregador deferrable initially deferred
  for each row execute function fv2_exigir_historico('FECHAMENTO_ENTREGADOR');

-- O valor apurado de um fechamento é imutável: diferença posterior vira divergência, ajuste ou conta complementar.
create function fv2_fechamento_entregador_imutavel() returns trigger language plpgsql as $$
begin
  if new.valor_centavos <> old.valor_centavos or new.entregas <> old.entregas or new.semana_inicio <> old.semana_inicio
     or new.entregador_chave <> old.entregador_chave or new.chave_idempotencia <> old.chave_idempotencia then
    raise exception 'FV2: o valor apurado do fechamento semanal não pode ser alterado' using errcode = 'FV010';
  end if;
  return new;
end $$;
create trigger fv2_fechamento_entregador_valor before update on fv2_fechamento_entregador for each row execute function fv2_fechamento_entregador_imutavel();

alter table fv2_semana_entregadores enable row level security;
alter table fv2_semana_entregadores force row level security;
create policy fv2_semana_entregadores_escopo on fv2_semana_entregadores
  using (organizacao_id = (select fv2_org()) and unidade_id = (select fv2_uni()))
  with check (organizacao_id = (select fv2_org()) and unidade_id = (select fv2_uni()));
create policy fv2_semana_entregadores_ler on fv2_semana_entregadores as restrictive for select using ((select fv2_sessao_operacional()));
create policy fv2_semana_entregadores_incluir on fv2_semana_entregadores as restrictive for insert with check ((select fv2_tem_acao(array['financeiro_v2.registrar'])));
create policy fv2_semana_entregadores_alterar on fv2_semana_entregadores as restrictive for update
  using ((select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir'])))
  with check ((select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir'])));
grant select, insert, update on fv2_semana_entregadores to fv2_app;

alter table fv2_fechamento_entregador enable row level security;
alter table fv2_fechamento_entregador force row level security;
create policy fv2_fechamento_entregador_escopo on fv2_fechamento_entregador
  using (organizacao_id = (select fv2_org()) and unidade_id = (select fv2_uni()))
  with check (organizacao_id = (select fv2_org()) and unidade_id = (select fv2_uni()));
create policy fv2_fechamento_entregador_ler on fv2_fechamento_entregador as restrictive for select using ((select fv2_sessao_operacional()));
create policy fv2_fechamento_entregador_incluir on fv2_fechamento_entregador as restrictive for insert with check ((select fv2_tem_acao(array['financeiro_v2.registrar'])));
create policy fv2_fechamento_entregador_alterar on fv2_fechamento_entregador as restrictive for update
  using ((select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir', 'financeiro_v2.conciliar', 'financeiro_v2.enviar_documento'])))
  with check ((select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir', 'financeiro_v2.conciliar', 'financeiro_v2.enviar_documento'])));
grant select, insert, update on fv2_fechamento_entregador to fv2_app;

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
    when 'SEMANA_ENTREGADORES' then 'fv2_semana_entregadores' when 'FECHAMENTO_ENTREGADOR' then 'fv2_fechamento_entregador'
  end::regclass
$$;

-- Identidade técnica do fechamento semanal: pode criar fechamento e conta a pagar, e NADA que mova dinheiro ou altere permissões.
create function fv2_bloquear_identidade_de_automacao() returns trigger language plpgsql as $$
begin
  if fv2_usuario() = '00000000-0000-4000-8000-00000000e7e9'::uuid then
    raise exception 'FV2: a identidade técnica de entregadores não pode alterar %', tg_table_name using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
do $$ declare t text; begin
  foreach t in array array['fv2_movimentacao', 'fv2_liquidacao', 'fv2_transferencia', 'fv2_ajuste', 'fv2_estorno', 'fv2_saldo_conta', 'fv2_sessao_caixa', 'fv2_concessao', 'fv2_conta', 'fv2_competencia'] loop
    execute format('create trigger %I before insert or update on %I for each row execute function fv2_bloquear_identidade_de_automacao()', t || '_sem_automacao', t);
  end loop;
end $$;
create trigger fv2_obrigacao_sem_automacao before update on fv2_obrigacao for each row execute function fv2_bloquear_identidade_de_automacao();
