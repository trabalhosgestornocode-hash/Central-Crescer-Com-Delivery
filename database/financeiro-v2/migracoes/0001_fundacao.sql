-- =====================================================================================================================
-- Financeiro v2 — migração 0001: fundação da persistência (Execução 01B)
--
-- ATENÇÃO: este arquivo NÃO pertence à sequência database/migrations/ do sistema atual e NÃO deve ser aplicado em
-- produção nesta etapa. Ele só é aplicado pelo script backend/scripts/fv2-banco-teste.mjs, que recusa qualquer destino
-- que não seja o PostgreSQL local isolado do Financeiro v2.
--
-- Princípios protegidos NO BANCO (além da validação do núcleo em JavaScript):
--   * dinheiro em BIGINT de centavos — nunca numeric/float; nenhuma fórmula financeira é reimplementada em SQL,
--     o banco só CONFERE somas e igualdades que o núcleo já calculou;
--   * toda linha pertence a um escopo (organização + unidade) cadastrado, e toda referência fica dentro do mesmo escopo;
--   * isolamento por RLS: a sessão só enxerga/grava o escopo declarado na transação (sem escopo = nada);
--   * nada é apagado (DELETE e TRUNCATE recusados); histórico é só acréscimo;
--   * toda criação/alteração exige o evento de histórico correspondente na MESMA transação;
--   * versão cresce de 1 em 1 (concorrência otimista); identidade e autoria de criação são imutáveis;
--   * saldo do título = base − liquidado + ajustes, nunca negativo, e bate com as liquidações e ajustes gravados;
--   * alocado da movimentação bate com as liquidações; transferência tem as duas pernas coerentes;
--   * venda ativa tem exatamente uma receita ativa do seu valor bruto; pagamentos nunca superam o bruto;
--   * competência homologada não aceita lançamento nem movimentação; só sai de homologada por reabertura justificada.
-- =====================================================================================================================

-- Papel de aplicação (sem login, sem privilégios de dono). O usuário de conexão é criado fora da migração e herda dele.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'fv2_app') then
    create role fv2_app nologin;
  end if;
end $$;

-- ------------------------------------------------------------------------------------------------- escopo e sessão

create table fv2_escopo (
  organizacao_id uuid not null,
  unidade_id     uuid not null,
  rotulo         text not null check (length(btrim(rotulo)) between 1 and 120),
  criado_em      timestamptz not null default now(),
  primary key (organizacao_id, unidade_id)
);
comment on table fv2_escopo is 'Pares organização+unidade em que o Financeiro v2 pode gravar. Provisionado fora da aplicação.';

create function fv2_org() returns uuid language sql stable as
  $$ select nullif(current_setting('fv2.organizacao_id', true), '')::uuid $$;
create function fv2_uni() returns uuid language sql stable as
  $$ select nullif(current_setting('fv2.unidade_id', true), '')::uuid $$;

-- ------------------------------------------------------------------------------------------------- molde comum

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

-- ------------------------------------------------------------------------------------------------- cadastros

create table fv2_conta (
  like fv2__molde including all,
  tipo        text not null check (tipo in ('BANCARIA', 'CAIXA_FISICO')),
  nome        text not null check (length(btrim(nome)) between 1 and 80),
  instituicao text,
  ativa       boolean not null
);

create table fv2_contraparte (
  like fv2__molde including all,
  tipo text not null check (tipo in ('FORNECEDOR', 'OPERADORA', 'CLIENTE', 'PRESTADOR', 'OUTRO')),
  nome text not null check (length(btrim(nome)) between 1 and 120)
);

create table fv2_categoria (
  like fv2__molde including all,
  codigo            text not null check (codigo ~ '^[A-Z][A-Z0-9_]{0,79}$'),
  nome              text not null check (length(btrim(nome)) between 1 and 120),
  classificacao     text not null check (classificacao in (
                      'RECEITA_OPERACIONAL', 'DEDUCOES_COMERCIAIS', 'CUSTOS_OPERACIONAIS', 'DESPESAS_COMERCIAIS',
                      'DESPESAS_RECEBIMENTO_PROCESSAMENTO', 'DESPESAS_ADMINISTRATIVAS', 'PESSOAL', 'MARKETING',
                      'DESPESAS_PLATAFORMAS', 'DESPESAS_FINANCEIRAS', 'TRIBUTOS', 'OUTROS_EFEITOS_GERENCIAIS',
                      'MOVIMENTACOES_PATRIMONIAIS')),
  natureza          text not null check (natureza in ('RECEITA', 'DEDUCAO', 'DESPESA', 'PATRIMONIAL')),
  pai_id            uuid,
  aceita_lancamento boolean not null,
  exige_documento   boolean not null,
  ativa             boolean not null,
  do_sistema        boolean not null,
  check (pai_id is null or pai_id <> id),
  -- A natureza precisa ser uma das permitidas pela classificação (mesma tabela de dominio/catalogos.js).
  check (
    (classificacao = 'RECEITA_OPERACIONAL' and natureza = 'RECEITA')
    or (classificacao = 'DEDUCOES_COMERCIAIS' and natureza = 'DEDUCAO')
    or (classificacao = 'MOVIMENTACOES_PATRIMONIAIS' and natureza = 'PATRIMONIAL')
    or (classificacao = 'TRIBUTOS' and natureza in ('DESPESA', 'DEDUCAO'))
    or (classificacao = 'OUTROS_EFEITOS_GERENCIAIS' and natureza in ('DESPESA', 'RECEITA'))
    or (classificacao in ('CUSTOS_OPERACIONAIS', 'DESPESAS_COMERCIAIS', 'DESPESAS_RECEBIMENTO_PROCESSAMENTO',
                          'DESPESAS_ADMINISTRATIVAS', 'PESSOAL', 'MARKETING', 'DESPESAS_PLATAFORMAS', 'DESPESAS_FINANCEIRAS')
        and natureza = 'DESPESA')
  ),
  unique (organizacao_id, unidade_id, codigo)
);

create table fv2_documento (
  like fv2__molde including all,
  origem              text not null check (origem in ('SAIPOS', 'IFOOD', 'ANOTA_AI', 'STONE', 'UNICRED', 'FOODY', 'MANUAL', 'OUTRO')),
  arquivo_id          text not null check (length(arquivo_id) between 1 and 200),
  hash_sha256         text not null check (hash_sha256 ~ '^[0-9a-f]{64}$'),
  tipo                text not null,
  competencia         text check (competencia is null or competencia ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  recebido_em         date not null,
  substitui_id        uuid,
  descricao           text,
  versao_documento    integer not null check (versao_documento >= 1),
  substituido_por_id  uuid,
  responsavel_id      uuid not null,
  unique (organizacao_id, unidade_id, hash_sha256)
);

-- ------------------------------------------------------------------------------------------------- econômico

create table fv2_lancamento (
  like fv2__molde including all,
  situacao           text not null check (situacao in ('ATIVO', 'CANCELADO')),
  natureza           text not null check (natureza in ('RECEITA', 'DEDUCAO', 'DESPESA', 'PATRIMONIAL')),
  valor_centavos     bigint not null check (valor_centavos <> 0),
  moeda              text not null check (moeda = 'BRL'),
  categoria_id       uuid not null,
  categoria_codigo   text not null,
  classificacao      text not null,
  descricao          text,
  data_operacao      date,
  competencia        text not null check (competencia ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  fonte_sistema      text,
  fonte_id_externo   text,
  canal              text check (canal is null or canal in ('BALCAO', 'IFOOD', 'ANOTA_AI', 'OUTRO')),
  retido_no_repasse  boolean not null,
  origem             jsonb not null check (jsonb_typeof(origem) = 'object' and origem ? 'tipo' and origem ? 'id'),
  -- Lançamento econômico nunca nasce de dinheiro andando: é isso que impede receita/despesa em dobro.
  check (origem->>'tipo' not in ('MOVIMENTACAO', 'LIQUIDACAO', 'TRANSFERENCIA')),
  check (fonte_id_externo is null or fonte_sistema is not null)
);
-- Uma venda tem no máximo UMA receita ativa.
create unique index fv2_lancamento_receita_unica_por_venda on fv2_lancamento (organizacao_id, unidade_id, (origem->>'id'))
  where natureza = 'RECEITA' and situacao = 'ATIVO' and origem->>'tipo' = 'VENDA';
create index fv2_lancamento_competencia on fv2_lancamento (organizacao_id, unidade_id, competencia);

create table fv2_venda (
  like fv2__molde including all,
  canal              text not null check (canal in ('BALCAO', 'IFOOD', 'ANOTA_AI', 'OUTRO')),
  data_venda         date not null,
  competencia        text not null check (competencia ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  bruto_centavos     bigint not null check (bruto_centavos > 0),
  pago_centavos      bigint not null check (pago_centavos >= 0),
  devolvido_centavos bigint not null check (devolvido_centavos >= 0),
  moeda              text not null check (moeda = 'BRL'),
  fonte_sistema      text not null check (fonte_sistema in ('SAIPOS', 'IFOOD', 'ANOTA_AI', 'MANUAL')),
  fonte_id_externo   text,
  descricao          text,
  lancamento_id      uuid not null,
  situacao           text not null check (situacao in ('ATIVA', 'CANCELADA')),
  pagamento_parcial  boolean not null,
  pagamentos         jsonb not null check (jsonb_typeof(pagamentos) = 'array'),
  pagamento_ids      uuid[] not null,
  -- O que foi pago mais o que foi devolvido nunca passa do valor da venda.
  check (pago_centavos + devolvido_centavos <= bruto_centavos)
);

create table fv2_pagamento_venda (
  like fv2__molde including all,
  venda_id            uuid not null,
  indice              integer not null check (indice >= 0),
  forma               text not null check (forma in ('DINHEIRO', 'PIX', 'DEBITO', 'CREDITO', 'VALE', 'OUTRA')),
  processador         text check (processador is null or processador in ('STONE', 'IFOOD', 'ANOTA_AI', 'OPERADORA_BENEFICIOS', 'MAQUINA_TERCEIROS', 'OUTRO')),
  valor_centavos      bigint not null check (valor_centavos > 0),
  estornado_centavos  bigint not null check (estornado_centavos >= 0),
  moeda               text not null check (moeda = 'BRL'),
  data_pagamento      date not null,
  conta_id            uuid,
  recebivel_id        uuid,
  movimentacao_id     uuid,
  situacao            text not null check (situacao in ('VALIDO', 'ESTORNADO_PARCIAL', 'ESTORNADO', 'CANCELADO')),
  check (estornado_centavos <= valor_centavos),
  -- Forma, processador e conta são dimensões distintas — e coerentes entre si:
  check (not (forma = 'DINHEIRO' and processador is not null)),          -- dinheiro não passa por processador
  check ((processador is not null) = (recebivel_id is not null)),        -- só pagamento processado gera recebível
  check (not (processador is not null and (conta_id is not null or movimentacao_id is not null))),
  check (movimentacao_id is null or conta_id is not null),
  unique (organizacao_id, unidade_id, venda_id, indice)
);

create table fv2_obrigacao (
  like fv2__molde including all,
  grupo_id             uuid not null,
  lancamento_id        uuid not null,
  contraparte_id       uuid not null,
  descricao            text not null,
  moeda                text not null check (moeda = 'BRL'),
  competencia          text not null check (competencia ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  data_emissao         date not null,
  vencimento           date not null,
  parcela              jsonb not null check ((parcela->>'numero')::int between 1 and (parcela->>'total')::int),
  recorrencia          jsonb,
  documento_ids        uuid[] not null,
  fonte_sistema        text,
  fonte_id_externo     text,
  valor_base_centavos  bigint not null check (valor_base_centavos > 0),
  liquidado_centavos   bigint not null check (liquidado_centavos >= 0),
  ajustes_centavos     bigint not null,
  saldo_centavos       bigint not null check (saldo_centavos >= 0),
  situacao             text not null check (situacao in ('ABERTA', 'PARCIAL', 'QUITADA', 'CANCELADA')),
  check (vencimento >= data_emissao),
  check (saldo_centavos = valor_base_centavos - liquidado_centavos + ajustes_centavos),
  check (situacao <> 'QUITADA' or saldo_centavos = 0),
  check (situacao <> 'CANCELADA' or liquidado_centavos = 0),
  unique (organizacao_id, unidade_id, grupo_id, parcela)
);

create table fv2_recebivel (
  like fv2__molde including all,
  processador          text check (processador is null or processador in ('STONE', 'IFOOD', 'ANOTA_AI', 'OPERADORA_BENEFICIOS', 'MAQUINA_TERCEIROS', 'OUTRO')),
  contraparte_id       uuid,
  canal                text check (canal is null or canal in ('BALCAO', 'IFOOD', 'ANOTA_AI', 'OUTRO')),
  venda_id             uuid,
  pagamento_id         uuid,
  pagamento_indice     integer,
  forma                text,
  bruto_centavos       bigint not null check (bruto_centavos > 0),
  moeda                text not null check (moeda = 'BRL'),
  retencoes            jsonb not null check (jsonb_typeof(retencoes) = 'array'),
  data_prevista        date,
  competencia          text not null check (competencia ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  descricao            text,
  documento_ids        uuid[] not null,
  fonte_sistema        text,
  fonte_id_externo     text,
  valor_base_centavos  bigint not null check (valor_base_centavos >= 0 and valor_base_centavos <= bruto_centavos),
  liquidado_centavos   bigint not null check (liquidado_centavos >= 0),
  ajustes_centavos     bigint not null,
  saldo_centavos       bigint not null check (saldo_centavos >= 0),
  situacao             text not null check (situacao in ('ABERTA', 'PARCIAL', 'QUITADA', 'CANCELADA')),
  check ((processador is null) <> (contraparte_id is null)),             -- devedor: processador OU contraparte
  check (saldo_centavos = valor_base_centavos - liquidado_centavos + ajustes_centavos),
  check (situacao <> 'QUITADA' or saldo_centavos = 0),
  check (situacao <> 'CANCELADA' or liquidado_centavos = 0)
);

-- ------------------------------------------------------------------------------------------------- caixa

create table fv2_movimentacao (
  like fv2__molde including all,
  conta_id             uuid not null,
  data_efetiva         date not null,
  sentido              text not null check (sentido in ('ENTRADA', 'SAIDA')),
  valor_centavos       bigint not null check (valor_centavos > 0),
  moeda                text not null check (moeda = 'BRL'),
  natureza             text not null check (natureza in ('PAGAMENTO', 'RECEBIMENTO', 'TRANSFERENCIA_INTERNA', 'DEVOLUCAO', 'OUTRA')),
  descricao            text,
  documento_id         uuid,
  fonte_sistema        text,
  fonte_id_externo     text,
  transferencia_id     uuid,
  pagamento_id         uuid,
  estorno_id           uuid,
  alocado_centavos     bigint not null check (alocado_centavos >= 0),
  situacao             text not null check (situacao in ('VALIDA', 'ESTORNADA')),
  situacao_conciliacao text not null check (situacao_conciliacao in ('NAO_CONCILIADA', 'PARCIAL', 'CONCILIADA')),
  check (alocado_centavos <= valor_centavos),
  check ((natureza = 'TRANSFERENCIA_INTERNA') = (transferencia_id is not null)),
  -- Transferência interna, pagamento direto de venda e movimentação estornada nunca liquidam título.
  check (alocado_centavos = 0 or (transferencia_id is null and pagamento_id is null and situacao = 'VALIDA')),
  check (not (natureza = 'PAGAMENTO' and sentido <> 'SAIDA')),
  check (not (natureza = 'RECEBIMENTO' and sentido <> 'ENTRADA')),
  check (not (natureza = 'DEVOLUCAO' and (sentido <> 'SAIDA' or estorno_id is null)))
);
create index fv2_movimentacao_data on fv2_movimentacao (organizacao_id, unidade_id, data_efetiva);

create table fv2_liquidacao (
  like fv2__molde including all,
  movimentacao_id     uuid not null,
  alvo_tipo           text not null check (alvo_tipo in ('OBRIGACAO', 'RECEBIVEL')),
  alvo_id             uuid not null,
  valor_centavos      bigint not null check (valor_centavos > 0),
  estornado_centavos  bigint not null check (estornado_centavos >= 0),
  data_efetiva        date not null,
  situacao            text not null check (situacao in ('VALIDA', 'ESTORNADA_PARCIAL', 'ESTORNADA')),
  check (estornado_centavos <= valor_centavos),
  check ((situacao = 'VALIDA') = (estornado_centavos = 0)),
  check ((situacao = 'ESTORNADA') = (estornado_centavos = valor_centavos))
);
create index fv2_liquidacao_alvo on fv2_liquidacao (organizacao_id, unidade_id, alvo_tipo, alvo_id);
create index fv2_liquidacao_movimentacao on fv2_liquidacao (organizacao_id, unidade_id, movimentacao_id);

create table fv2_transferencia (
  like fv2__molde including all,
  conta_origem_id   uuid not null,
  conta_destino_id  uuid not null,
  valor_centavos    bigint not null check (valor_centavos > 0),
  moeda             text not null check (moeda = 'BRL'),
  data_efetiva      date not null,
  descricao         text,
  saida_id          uuid not null,
  entrada_id        uuid not null,
  fonte_sistema     text,
  fonte_id_externo  text,
  situacao          text not null check (situacao in ('VALIDA', 'ESTORNADA')),
  check (conta_origem_id <> conta_destino_id),
  check (saida_id <> entrada_id)
);

create table fv2_ajuste (
  like fv2__molde including all,
  alvo_tipo       text not null check (alvo_tipo in ('OBRIGACAO', 'RECEBIVEL')),
  alvo_id         uuid not null,
  valor_centavos  bigint not null check (valor_centavos <> 0),
  motivo          text not null check (length(btrim(motivo)) > 0),
  competencia     text not null check (competencia ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  documento_id    uuid,
  lancamento_id   uuid,
  estorno_id      uuid,
  -- Ajuste sempre tem causa registrada: um lançamento classificado ou o estorno que o originou.
  check (lancamento_id is not null or estorno_id is not null)
);
create index fv2_ajuste_alvo on fv2_ajuste (organizacao_id, unidade_id, alvo_tipo, alvo_id);

create table fv2_estorno (
  like fv2__molde including all,
  alvo_tipo        text not null check (alvo_tipo in ('LIQUIDACAO', 'PAGAMENTO_VENDA', 'MOVIMENTACAO', 'TRANSFERENCIA')),
  alvo_id          uuid not null,
  valor_centavos   bigint not null check (valor_centavos > 0),
  motivo           text check (motivo is null or motivo in ('DEVOLUCAO_AO_CLIENTE', 'CORRECAO_DE_PAGAMENTO')),
  justificativa    text not null check (length(btrim(justificativa)) > 0),
  data_efetiva     date not null,
  documento_id     uuid,
  lancamento_id    uuid,
  movimentacao_id  uuid,
  check ((alvo_tipo = 'PAGAMENTO_VENDA') = (motivo is not null))
);

-- ------------------------------------------------------------------------------------------------- evidência e fechamento

create table fv2_vinculo_documental (
  like fv2__molde including all,
  documento_id   uuid not null,
  registro_tipo  text not null,
  registro_id    uuid not null,
  unique (organizacao_id, unidade_id, documento_id, registro_tipo, registro_id)
);

create table fv2_correspondencia (
  like fv2__molde including all,
  lado_a                  jsonb not null check (jsonb_typeof(lado_a) = 'array' and jsonb_array_length(lado_a) >= 1),
  lado_b                  jsonb not null check (jsonb_typeof(lado_b) = 'array' and jsonb_array_length(lado_b) >= 1),
  evidencia_documento_ids uuid[] not null,
  justificativa           text,
  diferenca_centavos      bigint not null,
  situacao                text not null check (situacao in ('CANDIDATA', 'CONFIRMADA', 'DIVERGENTE', 'REJEITADA')),
  responsavel_id          uuid,
  decidido_em             timestamptz,
  justificativa_decisao   text,
  check (situacao <> 'CONFIRMADA' or diferenca_centavos = 0),              -- só confirma o que fecha
  check (situacao = 'CANDIDATA' or (responsavel_id is not null and decidido_em is not null)),
  check (situacao not in ('DIVERGENTE', 'REJEITADA') or length(btrim(coalesce(justificativa_decisao, ''))) > 0)
);

create table fv2_competencia (
  like fv2__molde including all,
  competencia   text not null check (competencia ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  estado        text not null check (estado in ('ABERTA', 'FECHAMENTO_PRELIMINAR', 'FECHAMENTO_COM_PENDENCIAS', 'FECHAMENTO_HOMOLOGADO')),
  metodologia   text,
  pendencias    jsonb not null check (jsonb_typeof(pendencias) = 'array'),
  revisoes      integer not null check (revisoes >= 0),
  decidido_por  uuid not null,
  decidido_em   timestamptz not null,
  check (estado <> 'FECHAMENTO_COM_PENDENCIAS' or jsonb_array_length(pendencias) >= 1),
  check (estado <> 'FECHAMENTO_HOMOLOGADO' or length(btrim(coalesce(metodologia, ''))) > 0),
  unique (organizacao_id, unidade_id, competencia)
);

create table fv2_historico (
  seq             bigint generated always as identity,
  id              uuid not null primary key,
  organizacao_id  uuid not null,
  unidade_id      uuid not null,
  registro_tipo   text not null,
  registro_id     uuid not null,
  evento          text not null,
  antes           jsonb,
  depois          jsonb,
  justificativa   text,
  usuario_id      uuid not null,
  em              timestamptz not null,
  foreign key (organizacao_id, unidade_id) references fv2_escopo
);
create index fv2_historico_registro on fv2_historico (organizacao_id, unidade_id, registro_id, seq);

-- ------------------------------------------------------------------------------------------------- integridade referencial
-- Todas as chaves estrangeiras levam o escopo junto: é impossível apontar para registro de outra organização/unidade.
-- São conferidas no COMMIT (deferrable), porque operações compostas gravam registros que se referenciam mutuamente.

do $$
declare
  fk record;
begin
  for fk in
    select * from (values
      ('fv2_categoria',          'pai_id',             'fv2_categoria'),
      ('fv2_documento',          'substitui_id',       'fv2_documento'),
      ('fv2_documento',          'substituido_por_id', 'fv2_documento'),
      ('fv2_lancamento',         'categoria_id',       'fv2_categoria'),
      ('fv2_venda',              'lancamento_id',      'fv2_lancamento'),
      ('fv2_pagamento_venda',    'venda_id',           'fv2_venda'),
      ('fv2_pagamento_venda',    'conta_id',           'fv2_conta'),
      ('fv2_pagamento_venda',    'recebivel_id',       'fv2_recebivel'),
      ('fv2_pagamento_venda',    'movimentacao_id',    'fv2_movimentacao'),
      ('fv2_obrigacao',          'lancamento_id',      'fv2_lancamento'),
      ('fv2_obrigacao',          'contraparte_id',     'fv2_contraparte'),
      ('fv2_recebivel',          'contraparte_id',     'fv2_contraparte'),
      ('fv2_recebivel',          'venda_id',           'fv2_venda'),
      ('fv2_recebivel',          'pagamento_id',       'fv2_pagamento_venda'),
      ('fv2_movimentacao',       'conta_id',           'fv2_conta'),
      ('fv2_movimentacao',       'documento_id',       'fv2_documento'),
      ('fv2_movimentacao',       'transferencia_id',   'fv2_transferencia'),
      ('fv2_movimentacao',       'pagamento_id',       'fv2_pagamento_venda'),
      ('fv2_movimentacao',       'estorno_id',         'fv2_estorno'),
      ('fv2_liquidacao',         'movimentacao_id',    'fv2_movimentacao'),
      ('fv2_transferencia',      'conta_origem_id',    'fv2_conta'),
      ('fv2_transferencia',      'conta_destino_id',   'fv2_conta'),
      ('fv2_transferencia',      'saida_id',           'fv2_movimentacao'),
      ('fv2_transferencia',      'entrada_id',         'fv2_movimentacao'),
      ('fv2_ajuste',             'documento_id',       'fv2_documento'),
      ('fv2_ajuste',             'lancamento_id',      'fv2_lancamento'),
      ('fv2_ajuste',             'estorno_id',         'fv2_estorno'),
      ('fv2_estorno',            'documento_id',       'fv2_documento'),
      ('fv2_estorno',            'lancamento_id',      'fv2_lancamento'),
      ('fv2_estorno',            'movimentacao_id',    'fv2_movimentacao'),
      ('fv2_vinculo_documental', 'documento_id',       'fv2_documento')
    ) as t(tabela, coluna, alvo)
  loop
    execute format(
      'alter table %I add constraint %I foreign key (organizacao_id, unidade_id, %I) references %I (organizacao_id, unidade_id, id) deferrable initially deferred',
      fk.tabela, fk.tabela || '_' || fk.coluna || '_fk', fk.coluna, fk.alvo);
  end loop;
end $$;

-- ------------------------------------------------------------------------------------------------- funções de proteção

create function fv2_proibir_exclusao() returns trigger language plpgsql as $$
begin
  raise exception 'Financeiro v2: registros de % não são apagados.', tg_table_name using errcode = 'FV002';
end $$;

create function fv2_proibir_alteracao() returns trigger language plpgsql as $$
begin
  raise exception 'Financeiro v2: % é somente acréscimo.', tg_table_name using errcode = 'FV002';
end $$;

create function fv2_guardar_versao() returns trigger language plpgsql as $$
begin
  if new.id <> old.id or new.organizacao_id <> old.organizacao_id or new.unidade_id <> old.unidade_id
     or new.criado_em <> old.criado_em or new.criado_por <> old.criado_por then
    raise exception 'Financeiro v2: identidade, escopo e autoria de criação são imutáveis (%).', tg_table_name using errcode = 'FV003';
  end if;
  if new.versao <> old.versao + 1 then
    raise exception 'Financeiro v2: a versão deve crescer de 1 em 1 (%).', tg_table_name using errcode = 'FV004';
  end if;
  return new;
end $$;

-- Toda linha criada/alterada precisa do evento de histórico da MESMA versão. Conferido no commit.
create function fv2_exigir_historico() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from fv2_historico h
     where h.organizacao_id = new.organizacao_id and h.unidade_id = new.unidade_id
       and h.registro_id = new.id and h.registro_tipo = tg_argv[0] and (h.depois->>'versao')::int = new.versao
  ) then
    raise exception 'Financeiro v2: alteração sem histórico em % (versão %).', tg_table_name, new.versao using errcode = 'FV005';
  end if;
  return null;
end $$;

-- Competência homologada não recebe lançamento nem movimentação. O argumento diz de onde sai o mês da linha.
create function fv2_bloquear_homologada() returns trigger language plpgsql as $$
declare
  linha jsonb := to_jsonb(new);
  mes   text;
begin
  if tg_argv[0] = 'competencia' then mes := linha->>'competencia'; else mes := left(linha->>'data_efetiva', 7); end if;
  if exists (
    select 1 from fv2_competencia c
     where c.organizacao_id = new.organizacao_id and c.unidade_id = new.unidade_id
       and c.competencia = mes and c.estado = 'FECHAMENTO_HOMOLOGADO'
  ) then
    raise exception 'Financeiro v2: a competência % está homologada.', mes using errcode = 'FV001';
  end if;
  return new;
end $$;

create function fv2_guardar_fechamento() returns trigger language plpgsql as $$
begin
  if new.competencia <> old.competencia then
    raise exception 'Financeiro v2: a competência de um fechamento é imutável.' using errcode = 'FV003';
  end if;
  if old.estado = 'FECHAMENTO_HOMOLOGADO' and (new.estado <> 'ABERTA' or new.revisoes <> old.revisoes + 1) then
    raise exception 'Financeiro v2: competência homologada só muda por reabertura formal.' using errcode = 'FV008';
  end if;
  return new;
end $$;

-- Reabrir exige justificativa gravada no histórico da mesma versão. Conferido no commit.
create function fv2_exigir_justificativa_de_reabertura() returns trigger language plpgsql as $$
begin
  if old.estado <> 'ABERTA' and new.estado = 'ABERTA' and not exists (
    select 1 from fv2_historico h
     where h.organizacao_id = new.organizacao_id and h.unidade_id = new.unidade_id and h.registro_id = new.id
       and (h.depois->>'versao')::int = new.versao and length(btrim(coalesce(h.justificativa, ''))) > 0
  ) then
    raise exception 'Financeiro v2: reabertura de competência sem justificativa.' using errcode = 'FV008';
  end if;
  return null;
end $$;

-- Conservação do título: o que a linha diz que foi liquidado/ajustado tem de bater com as liquidações e ajustes gravados.
create function fv2_conferir_titulo(p_org uuid, p_uni uuid, p_tipo text, p_id uuid) returns void language plpgsql as $$
declare
  v_liquidado bigint;
  v_ajustes   bigint;
  v_soma_liq  bigint;
  v_soma_aj   bigint;
begin
  if p_tipo = 'OBRIGACAO' then
    select liquidado_centavos, ajustes_centavos into v_liquidado, v_ajustes from fv2_obrigacao
     where organizacao_id = p_org and unidade_id = p_uni and id = p_id;
  else
    select liquidado_centavos, ajustes_centavos into v_liquidado, v_ajustes from fv2_recebivel
     where organizacao_id = p_org and unidade_id = p_uni and id = p_id;
  end if;
  if not found then
    raise exception 'Financeiro v2: título % inexistente neste escopo.', p_tipo using errcode = 'FV006';
  end if;
  select coalesce(sum(valor_centavos - estornado_centavos), 0) into v_soma_liq from fv2_liquidacao
   where organizacao_id = p_org and unidade_id = p_uni and alvo_tipo = p_tipo and alvo_id = p_id;
  select coalesce(sum(valor_centavos), 0) into v_soma_aj from fv2_ajuste
   where organizacao_id = p_org and unidade_id = p_uni and alvo_tipo = p_tipo and alvo_id = p_id;
  if v_liquidado <> v_soma_liq or v_ajustes <> v_soma_aj then
    raise exception 'Financeiro v2: o saldo do título % não fecha com suas liquidações e ajustes.', p_tipo using errcode = 'FV007';
  end if;
end $$;

create function fv2_conferir_movimentacao(p_org uuid, p_uni uuid, p_id uuid) returns void language plpgsql as $$
declare
  v_alocado bigint;
  v_soma    bigint;
begin
  select alocado_centavos into v_alocado from fv2_movimentacao where organizacao_id = p_org and unidade_id = p_uni and id = p_id;
  if not found then
    raise exception 'Financeiro v2: movimentação inexistente neste escopo.' using errcode = 'FV006';
  end if;
  select coalesce(sum(valor_centavos - estornado_centavos), 0) into v_soma from fv2_liquidacao
   where organizacao_id = p_org and unidade_id = p_uni and movimentacao_id = p_id;
  if v_alocado <> v_soma then
    raise exception 'Financeiro v2: o valor alocado da movimentação não fecha com suas liquidações.' using errcode = 'FV007';
  end if;
end $$;

create function fv2_tg_titulo() returns trigger language plpgsql as $$
begin
  perform fv2_conferir_titulo(new.organizacao_id, new.unidade_id, tg_argv[0], new.id);
  return null;
end $$;

create function fv2_tg_alvo_de_titulo() returns trigger language plpgsql as $$
begin
  perform fv2_conferir_titulo(new.organizacao_id, new.unidade_id, new.alvo_tipo, new.alvo_id);
  return null;
end $$;

create function fv2_tg_liquidacao() returns trigger language plpgsql as $$
begin
  perform fv2_conferir_titulo(new.organizacao_id, new.unidade_id, new.alvo_tipo, new.alvo_id);
  perform fv2_conferir_movimentacao(new.organizacao_id, new.unidade_id, new.movimentacao_id);
  return null;
end $$;

create function fv2_tg_movimentacao() returns trigger language plpgsql as $$
begin
  perform fv2_conferir_movimentacao(new.organizacao_id, new.unidade_id, new.id);
  return null;
end $$;

-- Transferência: saída na conta de origem e entrada na conta de destino, mesmo valor, ambas vinculadas a ela e na mesma situação.
create function fv2_tg_transferencia() returns trigger language plpgsql as $$
declare
  v_ok boolean;
begin
  select count(*) = 2 into v_ok from fv2_movimentacao m
   where m.organizacao_id = new.organizacao_id and m.unidade_id = new.unidade_id and m.transferencia_id = new.id
     and m.natureza = 'TRANSFERENCIA_INTERNA' and m.valor_centavos = new.valor_centavos and m.situacao = new.situacao
     and ((m.id = new.saida_id and m.sentido = 'SAIDA' and m.conta_id = new.conta_origem_id)
       or (m.id = new.entrada_id and m.sentido = 'ENTRADA' and m.conta_id = new.conta_destino_id));
  if not v_ok or (select count(*) from fv2_movimentacao m where m.organizacao_id = new.organizacao_id
                    and m.unidade_id = new.unidade_id and m.transferencia_id = new.id) <> 2 then
    raise exception 'Financeiro v2: transferência sem o par saída+entrada coerente.' using errcode = 'FV009';
  end if;
  return null;
end $$;

create function fv2_tg_perna_de_transferencia() returns trigger language plpgsql as $$
declare
  t fv2_transferencia;
begin
  if new.transferencia_id is null then return null; end if;
  select * into t from fv2_transferencia where organizacao_id = new.organizacao_id and unidade_id = new.unidade_id and id = new.transferencia_id;
  if not found or t.situacao <> new.situacao or new.id not in (t.saida_id, t.entrada_id) then
    raise exception 'Financeiro v2: perna de transferência fora do par.' using errcode = 'FV009';
  end if;
  return null;
end $$;

-- Venda: ativa tem exatamente UMA receita ativa do valor bruto; cancelada não tem receita ativa.
-- O valor pago registrado bate com os pagamentos válidos.
create function fv2_conferir_venda(p_org uuid, p_uni uuid, p_id uuid) returns void language plpgsql as $$
declare
  v        fv2_venda;
  v_qtd    integer;
  v_valor  bigint;
  v_pago   bigint;
begin
  select * into v from fv2_venda where organizacao_id = p_org and unidade_id = p_uni and id = p_id;
  if not found then
    raise exception 'Financeiro v2: venda inexistente neste escopo.' using errcode = 'FV006';
  end if;
  select count(*), coalesce(sum(valor_centavos), 0) into v_qtd, v_valor from fv2_lancamento
   where organizacao_id = p_org and unidade_id = p_uni and natureza = 'RECEITA' and situacao = 'ATIVO'
     and origem->>'tipo' = 'VENDA' and origem->>'id' = p_id::text;
  if v.situacao = 'CANCELADA' then
    if v_qtd <> 0 then raise exception 'Financeiro v2: venda cancelada com receita ativa.' using errcode = 'FV010'; end if;
    return;
  end if;
  if v_qtd <> 1 or v_valor <> v.bruto_centavos then
    raise exception 'Financeiro v2: venda ativa deve ter exatamente uma receita do seu valor bruto.' using errcode = 'FV010';
  end if;
  select coalesce(sum(valor_centavos - estornado_centavos), 0) into v_pago from fv2_pagamento_venda
   where organizacao_id = p_org and unidade_id = p_uni and venda_id = p_id and situacao <> 'CANCELADO';
  if v_pago <> v.pago_centavos then
    raise exception 'Financeiro v2: o valor pago da venda não fecha com os pagamentos.' using errcode = 'FV010';
  end if;
end $$;

create function fv2_tg_venda() returns trigger language plpgsql as $$
begin
  perform fv2_conferir_venda(new.organizacao_id, new.unidade_id, case tg_argv[0] when 'venda' then new.id else (to_jsonb(new)->>'venda_id')::uuid end);
  return null;
end $$;

-- Referência polimórfica (tipo + id) precisa existir no mesmo escopo.
create function fv2_tabela_do_tipo(p_tipo text) returns regclass language sql immutable as $$
  select case p_tipo
    when 'CONTA' then 'fv2_conta' when 'CONTRAPARTE' then 'fv2_contraparte' when 'CATEGORIA' then 'fv2_categoria'
    when 'LANCAMENTO' then 'fv2_lancamento' when 'VENDA' then 'fv2_venda' when 'PAGAMENTO_VENDA' then 'fv2_pagamento_venda'
    when 'OBRIGACAO' then 'fv2_obrigacao' when 'RECEBIVEL' then 'fv2_recebivel' when 'MOVIMENTACAO' then 'fv2_movimentacao'
    when 'LIQUIDACAO' then 'fv2_liquidacao' when 'TRANSFERENCIA' then 'fv2_transferencia' when 'AJUSTE' then 'fv2_ajuste'
    when 'ESTORNO' then 'fv2_estorno' when 'DOCUMENTO' then 'fv2_documento' when 'VINCULO_DOCUMENTAL' then 'fv2_vinculo_documental'
    when 'CORRESPONDENCIA' then 'fv2_correspondencia' when 'COMPETENCIA' then 'fv2_competencia'
  end::regclass
$$;

create function fv2_tg_referencia_polimorfica() returns trigger language plpgsql as $$
declare
  linha    jsonb := to_jsonb(new);
  v_tabela regclass := fv2_tabela_do_tipo(linha->>tg_argv[0]);
  v_existe boolean;
begin
  if v_tabela is null then
    raise exception 'Financeiro v2: tipo de registro desconhecido em %.', tg_table_name using errcode = 'FV006';
  end if;
  execute format('select exists (select 1 from %s where organizacao_id = $1 and unidade_id = $2 and id = $3)', v_tabela)
    into v_existe using new.organizacao_id, new.unidade_id, (linha->>tg_argv[1])::uuid;
  if not v_existe then
    raise exception 'Financeiro v2: % aponta para registro inexistente neste escopo.', tg_table_name using errcode = 'FV006';
  end if;
  return null;
end $$;

-- ------------------------------------------------------------------------------------------------- gatilhos, RLS e privilégios

do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('fv2_conta', 'CONTA'), ('fv2_contraparte', 'CONTRAPARTE'), ('fv2_categoria', 'CATEGORIA'), ('fv2_documento', 'DOCUMENTO'),
      ('fv2_lancamento', 'LANCAMENTO'), ('fv2_venda', 'VENDA'), ('fv2_pagamento_venda', 'PAGAMENTO_VENDA'),
      ('fv2_obrigacao', 'OBRIGACAO'), ('fv2_recebivel', 'RECEBIVEL'), ('fv2_movimentacao', 'MOVIMENTACAO'),
      ('fv2_liquidacao', 'LIQUIDACAO'), ('fv2_transferencia', 'TRANSFERENCIA'), ('fv2_ajuste', 'AJUSTE'), ('fv2_estorno', 'ESTORNO'),
      ('fv2_vinculo_documental', 'VINCULO_DOCUMENTAL'), ('fv2_correspondencia', 'CORRESPONDENCIA'), ('fv2_competencia', 'COMPETENCIA')
    ) as x(tabela, tipo)
  loop
    execute format('alter table %I add constraint %I foreign key (organizacao_id, unidade_id) references fv2_escopo', t.tabela, t.tabela || '_escopo_fk');
    -- Idempotência: a mesma origem externa não entra duas vezes NO MESMO ESCOPO (outra unidade pode ter o mesmo identificador).
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

create trigger fv2_lancamento_homologada before insert or update on fv2_lancamento for each row execute function fv2_bloquear_homologada('competencia');
create trigger fv2_movimentacao_homologada before insert or update on fv2_movimentacao for each row execute function fv2_bloquear_homologada('data_efetiva');
create trigger fv2_competencia_fechamento before update on fv2_competencia for each row execute function fv2_guardar_fechamento();
create constraint trigger fv2_competencia_reabertura after update on fv2_competencia deferrable initially deferred for each row execute function fv2_exigir_justificativa_de_reabertura();

create constraint trigger fv2_obrigacao_conservacao after insert or update on fv2_obrigacao deferrable initially deferred for each row execute function fv2_tg_titulo('OBRIGACAO');
create constraint trigger fv2_recebivel_conservacao after insert or update on fv2_recebivel deferrable initially deferred for each row execute function fv2_tg_titulo('RECEBIVEL');
create constraint trigger fv2_liquidacao_conservacao after insert or update on fv2_liquidacao deferrable initially deferred for each row execute function fv2_tg_liquidacao();
create constraint trigger fv2_ajuste_conservacao after insert or update on fv2_ajuste deferrable initially deferred for each row execute function fv2_tg_alvo_de_titulo();
create constraint trigger fv2_movimentacao_conservacao after insert or update on fv2_movimentacao deferrable initially deferred for each row execute function fv2_tg_movimentacao();
create constraint trigger fv2_movimentacao_perna after insert or update on fv2_movimentacao deferrable initially deferred for each row execute function fv2_tg_perna_de_transferencia();
create constraint trigger fv2_transferencia_par after insert or update on fv2_transferencia deferrable initially deferred for each row execute function fv2_tg_transferencia();
create constraint trigger fv2_venda_conservacao after insert or update on fv2_venda deferrable initially deferred for each row execute function fv2_tg_venda('venda');
create constraint trigger fv2_pagamento_conservacao after insert or update on fv2_pagamento_venda deferrable initially deferred for each row execute function fv2_tg_venda('pagamento');
create constraint trigger fv2_vinculo_referencia after insert or update on fv2_vinculo_documental deferrable initially deferred for each row execute function fv2_tg_referencia_polimorfica('registro_tipo', 'registro_id');
create constraint trigger fv2_estorno_referencia after insert or update on fv2_estorno deferrable initially deferred for each row execute function fv2_tg_referencia_polimorfica('alvo_tipo', 'alvo_id');

-- Histórico: só acréscimo, isolado por escopo.
create trigger fv2_historico_sem_update before update on fv2_historico for each row execute function fv2_proibir_alteracao();
create trigger fv2_historico_sem_delete before delete on fv2_historico for each row execute function fv2_proibir_exclusao();
create trigger fv2_historico_sem_truncate before truncate on fv2_historico for each statement execute function fv2_proibir_exclusao();
alter table fv2_historico enable row level security;
alter table fv2_historico force row level security;
create policy fv2_historico_escopo on fv2_historico using (organizacao_id = fv2_org() and unidade_id = fv2_uni()) with check (organizacao_id = fv2_org() and unidade_id = fv2_uni());
grant select, insert on fv2_historico to fv2_app;

-- Escopo: a aplicação só enxerga o próprio; não cadastra nem altera escopos.
alter table fv2_escopo enable row level security;
alter table fv2_escopo force row level security;
create policy fv2_escopo_proprio on fv2_escopo for select using (organizacao_id = fv2_org() and unidade_id = fv2_uni());
create trigger fv2_escopo_sem_delete before delete on fv2_escopo for each row execute function fv2_proibir_exclusao();
grant select on fv2_escopo to fv2_app;

drop table fv2__molde;
