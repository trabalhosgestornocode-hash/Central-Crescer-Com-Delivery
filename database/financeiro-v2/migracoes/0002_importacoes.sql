-- =====================================================================================================================
-- Financeiro v2 — migração 0002: importações financeiras e preparação da conciliação (Execução 02)
--
-- ATENÇÃO: como a 0001, este arquivo só é aplicado pelo script backend/scripts/fv2-banco-teste.mjs no PostgreSQL local
-- isolado do Financeiro v2. NÃO pertence a database/migrations/ e NÃO deve ser aplicado em produção nesta etapa.
--
-- O que muda:
--   * fv2_importacao       — cada arquivo recebido e seu processamento (estado da importação, prévia, relatório);
--   * fv2_registro_fonte   — cada linha lida de uma fonte, fiel ao original, SEM efeito financeiro (importar ≠ confirmar);
--   * fv2_correspondencia  — relação, regra e força da candidata; novo estado AGUARDANDO_DOCUMENTO.
-- Regras protegidas no banco:
--   * o conteúdo lido de um registro de fonte (valores, datas, identificador, linha original) é imutável;
--     só mudam a conferência e a situação (ATIVO → SUBSTITUIDO por versão corrigida);
--   * a mesma origem (fonte + tipo de registro + identificador) não entra duas vezes no mesmo escopo;
--   * importação concluída tem quem confirmou; substituída aponta para quem a substituiu;
--   * nada é apagado; toda versão tem histórico; RLS por organização + unidade.
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

create table fv2_importacao (
  like fv2__molde including all,
  fonte                   text not null check (fonte in ('SAIPOS', 'IFOOD', 'ANOTA_AI', 'STONE', 'UNICRED', 'FOODY', 'MANUAL', 'OUTRO')),
  tipo_relatorio          text not null check (tipo_relatorio ~ '^[A-Z][A-Z0-9_]{2,79}$'),
  formato                 text not null,
  documento_id            uuid not null,
  periodo_inicio          date not null,
  periodo_fim             date not null,
  estado                  text not null check (estado in ('RECEBIDO', 'EM_VALIDACAO', 'PRONTO_PARA_IMPORTAR', 'IMPORTADO',
                                                          'IMPORTADO_COM_PENDENCIAS', 'REJEITADO', 'SUBSTITUIDO')),
  compatibilidade         text not null check (compatibilidade in ('AMOSTRA_REAL', 'SINTETICA')),
  previa                  jsonb,
  impressao_previa        text,
  relatorio               jsonb,
  substitui_importacao_id uuid,
  substituida_por_id      uuid,
  confirmado_por          uuid,
  confirmado_em           timestamptz,
  justificativa           text,
  check (periodo_fim >= periodo_inicio),
  check (estado not in ('IMPORTADO', 'IMPORTADO_COM_PENDENCIAS') or (confirmado_por is not null and confirmado_em is not null and relatorio is not null)),
  check (estado <> 'IMPORTADO_COM_PENDENCIAS' or length(btrim(coalesce(justificativa, ''))) > 0),
  check (estado <> 'SUBSTITUIDO' or substituida_por_id is not null),
  check (substitui_importacao_id is null or substitui_importacao_id <> id)
);
create index fv2_importacao_fonte on fv2_importacao (organizacao_id, unidade_id, fonte, tipo_relatorio, estado);

create table fv2_registro_fonte (
  like fv2__molde including all,
  importacao_id          uuid not null,
  documento_id           uuid not null,
  fonte                  text not null,
  tipo_relatorio         text not null,
  tipo_registro          text not null check (tipo_registro ~ '^[A-Z][A-Z0-9_]{2,79}$'),
  id_externo             text,
  identificacao          text not null check (identificacao in ('ID_EXTERNO', 'IMPRESSAO_DIGITAL')),
  linha                  integer not null check (linha >= 1),
  data_referencia        date not null,
  competencia            text not null check (competencia ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  valor_centavos         bigint not null,
  dados                  jsonb not null check (jsonb_typeof(dados) = 'object'),
  original               jsonb not null check (jsonb_typeof(original) = 'object'),
  conferencia            text not null check (conferencia in ('NAO_CONFERIDO', 'CONFERIDO', 'DIVERGENTE')),
  situacao               text not null check (situacao in ('ATIVO', 'SUBSTITUIDO')),
  substituido_por_importacao_id uuid,
  check (identificacao <> 'ID_EXTERNO' or id_externo is not null),
  check (situacao <> 'SUBSTITUIDO' or substituido_por_importacao_id is not null),
  -- Registro ativo SEMPRE carrega a chave de origem (é ela que impede a dupla importação).
  check (situacao <> 'ATIVO' or chave_idempotencia is not null)
);
create index fv2_registro_fonte_importacao on fv2_registro_fonte (organizacao_id, unidade_id, importacao_id);
create index fv2_registro_fonte_tipo on fv2_registro_fonte (organizacao_id, unidade_id, fonte, tipo_registro, data_referencia);

drop table fv2__molde;

-- O conteúdo lido de uma fonte é fiel ao arquivo: não se reescreve depois de gravado.
create function fv2_tg_registro_fonte_imutavel() returns trigger language plpgsql as $$
begin
  if (new.importacao_id, new.documento_id, new.fonte, new.tipo_relatorio, new.tipo_registro, new.id_externo, new.identificacao,
      new.linha, new.data_referencia, new.competencia, new.valor_centavos, new.dados, new.original)
     is distinct from
     (old.importacao_id, old.documento_id, old.fonte, old.tipo_relatorio, old.tipo_registro, old.id_externo, old.identificacao,
      old.linha, old.data_referencia, old.competencia, old.valor_centavos, old.dados, old.original) then
    raise exception 'Financeiro v2: o conteúdo de um registro importado não pode ser reescrito.' using errcode = 'FV011';
  end if;
  if old.situacao = 'SUBSTITUIDO' and new.situacao <> 'SUBSTITUIDO' then
    raise exception 'Financeiro v2: registro substituído não volta a ficar ativo.' using errcode = 'FV011';
  end if;
  return new;
end $$;

-- Importação encerrada (importada, rejeitada ou substituída) não volta para trás.
create function fv2_tg_importacao_estado() returns trigger language plpgsql as $$
begin
  if old.estado = new.estado then
    if old.estado in ('IMPORTADO', 'IMPORTADO_COM_PENDENCIAS', 'REJEITADO', 'SUBSTITUIDO')
       and (new.previa, new.impressao_previa, new.relatorio, new.documento_id, new.periodo_inicio, new.periodo_fim)
           is distinct from (old.previa, old.impressao_previa, old.relatorio, old.documento_id, old.periodo_inicio, old.periodo_fim) then
      raise exception 'Financeiro v2: importação encerrada não pode ser reescrita.' using errcode = 'FV012';
    end if;
    return new;
  end if;
  if not (
       (old.estado = 'RECEBIDO' and new.estado = 'EM_VALIDACAO')
    or (old.estado = 'EM_VALIDACAO' and new.estado in ('PRONTO_PARA_IMPORTAR', 'REJEITADO'))
    or (old.estado = 'PRONTO_PARA_IMPORTAR' and new.estado in ('IMPORTADO', 'IMPORTADO_COM_PENDENCIAS', 'REJEITADO', 'SUBSTITUIDO'))
    or (old.estado in ('IMPORTADO', 'IMPORTADO_COM_PENDENCIAS') and new.estado = 'SUBSTITUIDO')
  ) then
    raise exception 'Financeiro v2: transição de importação % → % não permitida.', old.estado, new.estado using errcode = 'FV012';
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
      ('fv2_importacao',     'documento_id',                  'fv2_documento'),
      ('fv2_importacao',     'substitui_importacao_id',       'fv2_importacao'),
      ('fv2_importacao',     'substituida_por_id',            'fv2_importacao'),
      ('fv2_registro_fonte', 'importacao_id',                 'fv2_importacao'),
      ('fv2_registro_fonte', 'documento_id',                  'fv2_documento'),
      ('fv2_registro_fonte', 'substituido_por_importacao_id', 'fv2_importacao')
    ) as x(tabela, coluna, alvo)
  loop
    execute format(
      'alter table %I add constraint %I foreign key (organizacao_id, unidade_id, %I) references %I (organizacao_id, unidade_id, id) deferrable initially deferred',
      fk.tabela, fk.tabela || '_' || fk.coluna || '_fk', fk.coluna, fk.alvo);
  end loop;

  for t in select * from (values ('fv2_importacao', 'IMPORTACAO'), ('fv2_registro_fonte', 'REGISTRO_FONTE')) as x(tabela, tipo)
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

create trigger fv2_registro_fonte_imutavel before update on fv2_registro_fonte for each row execute function fv2_tg_registro_fonte_imutavel();
create trigger fv2_importacao_estado before update on fv2_importacao for each row execute function fv2_tg_importacao_estado();

-- Referência polimórfica passa a conhecer os novos tipos.
create or replace function fv2_tabela_do_tipo(p_tipo text) returns regclass language sql immutable as $$
  select case p_tipo
    when 'CONTA' then 'fv2_conta' when 'CONTRAPARTE' then 'fv2_contraparte' when 'CATEGORIA' then 'fv2_categoria'
    when 'LANCAMENTO' then 'fv2_lancamento' when 'VENDA' then 'fv2_venda' when 'PAGAMENTO_VENDA' then 'fv2_pagamento_venda'
    when 'OBRIGACAO' then 'fv2_obrigacao' when 'RECEBIVEL' then 'fv2_recebivel' when 'MOVIMENTACAO' then 'fv2_movimentacao'
    when 'LIQUIDACAO' then 'fv2_liquidacao' when 'TRANSFERENCIA' then 'fv2_transferencia' when 'AJUSTE' then 'fv2_ajuste'
    when 'ESTORNO' then 'fv2_estorno' when 'DOCUMENTO' then 'fv2_documento' when 'VINCULO_DOCUMENTAL' then 'fv2_vinculo_documental'
    when 'CORRESPONDENCIA' then 'fv2_correspondencia' when 'COMPETENCIA' then 'fv2_competencia'
    when 'IMPORTACAO' then 'fv2_importacao' when 'REGISTRO_FONTE' then 'fv2_registro_fonte'
  end::regclass
$$;

-- ------------------------------------------------------------------------------------------------- correspondência
alter table fv2_correspondencia drop constraint fv2_correspondencia_situacao_check;
alter table fv2_correspondencia add constraint fv2_correspondencia_situacao_check
  check (situacao in ('CANDIDATA', 'CONFIRMADA', 'DIVERGENTE', 'REJEITADA', 'AGUARDANDO_DOCUMENTO'));
alter table fv2_correspondencia add column relacao text not null default 'MANUAL'
  check (relacao in ('SAIPOS_X_STONE', 'STONE_X_RECEBIMENTO', 'RECEBIMENTO_STONE_X_UNICRED', 'IFOOD_X_UNICRED', 'FOODY_X_UNICRED', 'MANUAL'));
alter table fv2_correspondencia add column regra text;
alter table fv2_correspondencia add column forca text check (forca is null or forca in ('FORTE', 'FRACA'));
alter table fv2_correspondencia add constraint fv2_correspondencia_aguardando_check
  check (situacao <> 'AGUARDANDO_DOCUMENTO' or length(btrim(coalesce(justificativa_decisao, ''))) > 0);
-- Candidata proposta por regra automática sempre preserva a evidência (documentos de origem dos registros).
alter table fv2_correspondencia add constraint fv2_correspondencia_evidencia_check
  check (relacao = 'MANUAL' or cardinality(evidencia_documento_ids) >= 1);
