-- =====================================================================================================================
-- Financeiro v2 — migração 0004: formação de operações financeiras (Execução 03)
--
-- Só é aplicada no PostgreSQL local isolado (scripts/fv2-banco-teste.mjs). Não pertence a database/migrations/.
--   * fv2_proposta          — proposta de operação formada a partir de registros importados (nunca efeito automático);
--   * fv2_divergencia_fonte — diferença documentada entre fontes (ex.: faturamento × formas de pagamento), com explicações.
-- Regras protegidas no banco:
--   * a mesma origem gera no máximo UMA proposta por operação (chave única por escopo);
--   * proposta aplicada guarda os efeitos criados e não volta a "aprovada" nem é reaplicada;
--   * transições de estado válidas; nada se apaga; histórico obrigatório; RLS por escopo.
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

create table fv2_proposta (
  like fv2__molde including all,
  operacao           text not null check (operacao in ('VENDA', 'VENDA_AGREGADA', 'PAGAMENTO_STONE', 'OBRIGACAO_ENTREGADOR', 'MOVIMENTACAO_BANCARIA')),
  estado             text not null check (estado in ('PROPOSTA', 'AGUARDANDO_EVIDENCIA', 'AGUARDANDO_REVISAO', 'APROVADA', 'APLICADA', 'REJEITADA', 'SUBSTITUIDA')),
  fonte              text not null,
  tipo_relatorio     text not null,
  importacao_id      uuid not null,
  documento_ids      uuid[] not null check (cardinality(documento_ids) >= 1),
  registro_ids       uuid[] not null check (cardinality(registro_ids) >= 1),
  competencia        text not null check (competencia ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  data_operacao      date not null,
  natureza           text not null,
  valor_centavos     bigint not null,
  categoria_sugerida text,
  comando            jsonb not null check (jsonb_typeof(comando) = 'object'),
  duplicidades       jsonb not null check (jsonb_typeof(duplicidades) = 'array'),
  divergencias       jsonb not null check (jsonb_typeof(divergencias) = 'array'),
  confianca          text not null check (confianca in ('ALTA', 'MEDIA', 'BAIXA')),
  justificativa      text not null check (length(btrim(justificativa)) > 0),
  efeitos            jsonb not null check (jsonb_typeof(efeitos) = 'array'),
  decidido_por       uuid,
  decidido_em        timestamptz,
  substituida_por_id uuid,
  check (estado <> 'APLICADA' or jsonb_array_length(efeitos) >= 1),
  check (estado not in ('APROVADA', 'APLICADA', 'REJEITADA') or (decidido_por is not null and decidido_em is not null)),
  check (substituida_por_id is null or substituida_por_id <> id)
);
create index fv2_proposta_estado on fv2_proposta (organizacao_id, unidade_id, operacao, estado);

create table fv2_divergencia_fonte (
  like fv2__molde including all,
  tipo               text not null check (tipo ~ '^[A-Z][A-Z0-9_]{2,79}$'),
  periodo_inicio     date not null,
  periodo_fim        date not null,
  totais             jsonb not null check (jsonb_typeof(totais) = 'object'),
  diferenca_centavos bigint not null,
  por_dia            jsonb not null check (jsonb_typeof(por_dia) = 'object'),
  atipicos           jsonb not null check (jsonb_typeof(atipicos) = 'array'),
  explicacoes        jsonb not null check (jsonb_typeof(explicacoes) = 'array'),
  estado             text not null check (estado in ('ABERTA', 'EXPLICADA_PARCIALMENTE', 'RESOLVIDA')),
  registro_ids       uuid[] not null,
  check (periodo_fim >= periodo_inicio)
);

drop table fv2__molde;

-- Proposta: aplicada nunca volta nem troca os efeitos; rejeitada/substituída são finais.
create function fv2_tg_proposta_estado() returns trigger language plpgsql as $$
begin
  if old.estado = 'APLICADA' and (new.estado not in ('APLICADA', 'SUBSTITUIDA') or new.efeitos is distinct from old.efeitos) then
    raise exception 'Financeiro v2: proposta aplicada não volta atrás nem troca os efeitos.' using errcode = 'FV013';
  end if;
  if old.estado in ('REJEITADA', 'SUBSTITUIDA') and new.estado is distinct from old.estado then
    raise exception 'Financeiro v2: proposta % é final.', old.estado using errcode = 'FV013';
  end if;
  if new.estado = 'APLICADA' and old.estado not in ('APROVADA', 'APLICADA') then
    raise exception 'Financeiro v2: só proposta aprovada pode ser aplicada.' using errcode = 'FV013';
  end if;
  if (new.comando, new.registro_ids, new.valor_centavos) is distinct from (old.comando, old.registro_ids, old.valor_centavos)
     and old.estado in ('APROVADA', 'APLICADA') then
    raise exception 'Financeiro v2: proposta aprovada não muda de conteúdo.' using errcode = 'FV013';
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
      ('fv2_proposta', 'importacao_id', 'fv2_importacao'),
      ('fv2_proposta', 'substituida_por_id', 'fv2_proposta')
    ) as x(tabela, coluna, alvo)
  loop
    execute format(
      'alter table %I add constraint %I foreign key (organizacao_id, unidade_id, %I) references %I (organizacao_id, unidade_id, id) deferrable initially deferred',
      fk.tabela, fk.tabela || '_' || fk.coluna || '_fk', fk.coluna, fk.alvo);
  end loop;
  for t in select * from (values ('fv2_proposta', 'PROPOSTA'), ('fv2_divergencia_fonte', 'DIVERGENCIA_FONTE')) as x(tabela, tipo)
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

create trigger fv2_proposta_estado before update on fv2_proposta for each row execute function fv2_tg_proposta_estado();

-- Nova relação de conciliação: conta a pagar × saída bancária (sempre candidata FRACA).
alter table fv2_correspondencia drop constraint fv2_correspondencia_relacao_check;
alter table fv2_correspondencia add constraint fv2_correspondencia_relacao_check
  check (relacao in ('SAIPOS_X_STONE', 'STONE_X_RECEBIMENTO', 'RECEBIMENTO_STONE_X_UNICRED', 'IFOOD_X_UNICRED', 'FOODY_X_UNICRED', 'OBRIGACAO_X_MOVIMENTACAO', 'MANUAL'));

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
  end::regclass
$$;
