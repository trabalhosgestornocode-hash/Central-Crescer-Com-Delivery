-- =====================================================================================================================
-- Financeiro v2 — migração 0006: tesouraria (Execução 06A)
--
-- Só é aplicada no PostgreSQL local isolado (scripts/fv2-banco-teste.mjs). Não pertence a database/migrations/.
--   * fv2_saldo_conta   — saldo INFORMADO de uma conta no início de um dia (extrato/contagem): ponto de partida do saldo
--                         calculado. Um saldo por conta e dia; nunca é sobrescrito.
--   * fv2_sessao_caixa  — sessão do caixa físico: abertura contada, operações, fechamento com teórico × contado.
-- Regras protegidas no banco:
--   * no máximo UMA sessão aberta por caixa; sessão fechada não reabre nem muda os números do fechamento;
--   * diferença = contado − teórico (conferida); diferença diferente de zero exige justificativa;
--   * nada se apaga; histórico obrigatório; RLS por escopo.
-- =====================================================================================================================

create table fv2__molde (
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
  unique (organizacao_id, unidade_id, id),
  check (atualizado_em >= criado_em)
);

create table fv2_saldo_conta (
  like fv2__molde including all,
  conta_id        uuid not null,
  data            date not null,
  valor_centavos  bigint not null,
  documento_id    uuid,
  observacao      text,
  unique (organizacao_id, unidade_id, conta_id, data)
);

create table fv2_sessao_caixa (
  like fv2__molde including all,
  conta_id                 uuid not null,
  situacao                 text not null check (situacao in ('ABERTA', 'FECHADA')),
  data_abertura            date not null,
  saldo_abertura_centavos  bigint not null check (saldo_abertura_centavos >= 0),
  observacao               text,
  operacoes                jsonb not null check (jsonb_typeof(operacoes) = 'array'),
  data_fechamento          date,
  entradas_centavos        bigint check (entradas_centavos is null or entradas_centavos >= 0),
  saidas_centavos          bigint check (saidas_centavos is null or saidas_centavos >= 0),
  teorico_centavos         bigint,
  contado_centavos         bigint check (contado_centavos is null or contado_centavos >= 0),
  diferenca_centavos       bigint,
  justificativa            text,
  fechado_por              uuid,
  fechado_em               timestamptz,
  check (situacao <> 'ABERTA' or (data_fechamento is null and contado_centavos is null and teorico_centavos is null and diferenca_centavos is null)),
  check (situacao <> 'FECHADA' or (data_fechamento is not null and data_fechamento >= data_abertura and contado_centavos is not null
    and teorico_centavos is not null and entradas_centavos is not null and saidas_centavos is not null and fechado_por is not null and fechado_em is not null
    and teorico_centavos = saldo_abertura_centavos + entradas_centavos - saidas_centavos
    and diferenca_centavos = contado_centavos - teorico_centavos
    and (diferenca_centavos = 0 or length(btrim(coalesce(justificativa, ''))) > 0)))
);
create unique index fv2_sessao_caixa_uma_aberta on fv2_sessao_caixa (organizacao_id, unidade_id, conta_id) where situacao = 'ABERTA';
create index fv2_sessao_caixa_conta on fv2_sessao_caixa (organizacao_id, unidade_id, conta_id, data_abertura);

drop table fv2__molde;

-- Sessão fechada é definitiva: não reabre e não troca os números do fechamento. Abertura não muda depois de criada.
create function fv2_tg_sessao_caixa() returns trigger language plpgsql as $$
begin
  if old.situacao = 'FECHADA' then
    raise exception 'Financeiro v2: sessão de caixa fechada não é alterada.' using errcode = 'FV014';
  end if;
  if (new.conta_id, new.data_abertura, new.saldo_abertura_centavos) is distinct from (old.conta_id, old.data_abertura, old.saldo_abertura_centavos) then
    raise exception 'Financeiro v2: a abertura do caixa não muda depois de registrada.' using errcode = 'FV014';
  end if;
  if jsonb_array_length(new.operacoes) < jsonb_array_length(old.operacoes) then
    raise exception 'Financeiro v2: operações de caixa não são removidas.' using errcode = 'FV014';
  end if;
  return new;
end $$;

-- Saldo informado não é reescrito: um novo saldo é OUTRO registro, em outra data.
create function fv2_tg_saldo_conta() returns trigger language plpgsql as $$
begin
  if (new.conta_id, new.data, new.valor_centavos) is distinct from (old.conta_id, old.data, old.valor_centavos) then
    raise exception 'Financeiro v2: saldo informado não é reescrito.' using errcode = 'FV014';
  end if;
  return new;
end $$;

do $$
declare
  fk record;
  t  record;
begin
  for fk in
    select * from (values
      ('fv2_saldo_conta', 'conta_id', 'fv2_conta'),
      ('fv2_saldo_conta', 'documento_id', 'fv2_documento'),
      ('fv2_sessao_caixa', 'conta_id', 'fv2_conta')
    ) as x(tabela, coluna, alvo)
  loop
    execute format(
      'alter table %I add constraint %I foreign key (organizacao_id, unidade_id, %I) references %I (organizacao_id, unidade_id, id) deferrable initially deferred',
      fk.tabela, fk.tabela || '_' || fk.coluna || '_fk', fk.coluna, fk.alvo);
  end loop;
  for t in select * from (values ('fv2_saldo_conta', 'SALDO_CONTA'), ('fv2_sessao_caixa', 'SESSAO_CAIXA')) as x(tabela, tipo)
  loop
    execute format('alter table %I add constraint %I foreign key (organizacao_id, unidade_id) references fv2_escopo', t.tabela, t.tabela || '_escopo_fk');
    execute format('create unique index %I on %I (organizacao_id, unidade_id, chave_idempotencia) where chave_idempotencia is not null', t.tabela || '_chave_uq', t.tabela);
    execute format('create trigger %I before delete on %I for each row execute function fv2_proibir_exclusao()', t.tabela || '_sem_delete', t.tabela);
    execute format('create trigger %I before truncate on %I for each statement execute function fv2_proibir_exclusao()', t.tabela || '_sem_truncate', t.tabela);
    execute format('create trigger %I before update on %I for each row execute function fv2_guardar_versao()', t.tabela || '_versao', t.tabela);
    execute format('create constraint trigger %I after insert or update on %I deferrable initially deferred for each row execute function fv2_exigir_historico(%L)', t.tabela || '_historico', t.tabela, t.tipo);
    execute format('alter table %I enable row level security', t.tabela);
    execute format('alter table %I force row level security', t.tabela);
    execute format('create policy %I on %I using (organizacao_id = fv2_org() and unidade_id = fv2_uni()) with check (organizacao_id = fv2_org() and unidade_id = fv2_uni())', t.tabela || '_escopo', t.tabela);
    execute format('grant select, insert, update on %I to fv2_app', t.tabela);
  end loop;
end $$;

create trigger fv2_sessao_caixa_regras before update on fv2_sessao_caixa for each row execute function fv2_tg_sessao_caixa();
create trigger fv2_saldo_conta_regras before update on fv2_saldo_conta for each row execute function fv2_tg_saldo_conta();

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
  end::regclass
$$;
