-- Financeiro v2 — INSTALAÇÃO no schema dedicado financeiro_v2 (gerado por backend/scripts/fv2/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como `postgres` (não superusuário, com CREATEROLE), numa ÚNICA transação. Qualquer falha desfaz tudo.
-- Migrações: 0001_fundacao.sql, 0002_importacoes.sql, 0003_concessoes.sql, 0004_formacao.sql, 0005_composicao_venda.sql, 0006_tesouraria.sql, 0007_saldo_referencia.sql, 0008_conferencias_indices.sql, 0009_configuracoes_fechamento.sql, 0010_auditoria_posicao_posterior.sql, 0011_sessao_banco_e_concessoes.sql, 0012_permissao_por_acao.sql, 0013_acoes_granulares.sql, 0014_reclassificacao.sql, 0015_indices_carga_por_competencia.sql, 0016_envio_de_evidencias.sql, 0017_indices_seletivos.sql, 0018_fechamento_ressalvas_baixa_extrato.sql, 0019_com_pendencias_sem_contorno.sql, 0020_baixa_antecipada.sql, 0021_liberacao_por_unidade.sql, 0022_abertura_da_unidade.sql, 0023_administracao_corporativa.sql, 0024_canais_e_operadoras.sql, 0025_fechamento_manual_caixa.sql, 0026_entregadores_proprios.sql, 0027_bloqueio_automacao_definer.sql, 0028_leitor_mova.sql, 0029_pagamento_por_comprovante.sql, 0030_registrar_obrigacao_documental.sql, 0031_registrar_juros_no_pagamento.sql

-- ===================================================================================== pré-condições (abortam)
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'financeiro_v2') then raise exception 'FV2 instalação: schema financeiro_v2 já existe — nada foi feito'; end if;
  if exists (select 1 from pg_roles where rolname like 'fv2\_%') then raise exception 'FV2 instalação: já existem papéis fv2_* — nada foi feito'; end if;
  if (select rolsuper from pg_roles where rolname = current_user) then raise exception 'FV2 instalação: não aplicar como superusuário'; end if;
  if not (select rolcreaterole from pg_roles where rolname = current_user) then raise exception 'FV2 instalação: o executor precisa de CREATEROLE'; end if;
  if current_setting('server_version_num')::int < 130000 then raise exception 'FV2 instalação: PostgreSQL 13+ exigido'; end if;
  -- A-2 (auditoria do Agente 2): publicação FOR ALL TABLES incluiria AUTOMATICAMENTE as tabelas do v2 na replicação lógica
  -- (Realtime). A publicação é da plataforma: a instalação PARA antes de qualquer alteração e a decisão é humana.
  if exists (select 1 from pg_publication where puballtables) then
    raise exception 'FV2 instalação: existe publicação FOR ALL TABLES (%) — as tabelas do v2 entrariam na replicação; nada foi feito',
      (select string_agg(pubname, ', ') from pg_publication where puballtables);
  end if;
end $$;

-- ================================================================================ A1/A4: schema, papéis, uso
create schema financeiro_v2;
revoke all on schema financeiro_v2 from public;
create role fv2_app nologin;
create role fv2_autoridade nologin;
create role fv2_guardiao nologin;
grant usage on schema financeiro_v2 to fv2_app, fv2_autoridade, fv2_guardiao;
create table financeiro_v2.fv2_migracao (nome text primary key, sha256 text not null, sha256_aplicado text, aplicada_em timestamptz not null default now());
set local search_path = financeiro_v2, pg_catalog;

-- ------------------------------------------------------------------------- 0001_fundacao.sql (arquivo ef5d9f835541d6fce2807109be1a5737813084bd94130f9714e5105b0e361427)
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
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0001_fundacao.sql', 'ef5d9f835541d6fce2807109be1a5737813084bd94130f9714e5105b0e361427', 'ef5d9f835541d6fce2807109be1a5737813084bd94130f9714e5105b0e361427');

-- ------------------------------------------------------------------------- 0002_importacoes.sql (arquivo d49d3b6bd531bf2d031e86a0ca0245a28632a6fa177017bcd4ff9433807c088a)
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
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0002_importacoes.sql', 'd49d3b6bd531bf2d031e86a0ca0245a28632a6fa177017bcd4ff9433807c088a', 'd49d3b6bd531bf2d031e86a0ca0245a28632a6fa177017bcd4ff9433807c088a');

-- ------------------------------------------------------------------------- 0003_concessoes.sql (arquivo a6e58f09056935eb2414f5d2119433e92e9919930eb88eb0e16acbd4bd076ec9)
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
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0003_concessoes.sql', 'a6e58f09056935eb2414f5d2119433e92e9919930eb88eb0e16acbd4bd076ec9', 'a6e58f09056935eb2414f5d2119433e92e9919930eb88eb0e16acbd4bd076ec9');

-- ------------------------------------------------------------------------- 0004_formacao.sql (arquivo ce5b6ecf822b69f86a4a6cd190d6dcad52c59ad33a0df0f07b398e9dd3d5b9bf)
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
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0004_formacao.sql', 'ce5b6ecf822b69f86a4a6cd190d6dcad52c59ad33a0df0f07b398e9dd3d5b9bf', 'ce5b6ecf822b69f86a4a6cd190d6dcad52c59ad33a0df0f07b398e9dd3d5b9bf');

-- ------------------------------------------------------------------------- 0005_composicao_venda.sql (arquivo 8dbbc4296a95cc46648a38fb69ae407d5a41efdf5d1ced2c96c7f5bd408472d8)
-- =====================================================================================================================
-- Financeiro v2 — migração 0005: composição econômica da venda (Execução 03B)
--
-- Só é aplicada no PostgreSQL local isolado (scripts/fv2-banco-teste.mjs). Não pertence a database/migrations/.
-- Compatível com as vendas existentes: descontos_centavos nasce 0 e composicao nasce nula (venda sem composição).
--   * descontos_centavos — descontos com efeito PRÓPRIO (da loja ou com financiador não comprovado), lançados como dedução;
--     subsídio de terceiro NÃO entra aqui: é pagamento do terceiro (recebível dele);
--   * composicao        — itens, acréscimos, serviços e descontos com financiador, como vieram da fonte.
-- Regras no banco: descontos não negativos; pago + devolvido + descontos próprios nunca superam a receita; a receita da
-- venda continua ÚNICA e do valor bruto próprio (fv2_conferir_venda inalterada: só conta lançamentos de RECEITA).
-- =====================================================================================================================

alter table fv2_venda add column descontos_centavos bigint not null default 0 check (descontos_centavos >= 0);
alter table fv2_venda add column composicao jsonb check (composicao is null or jsonb_typeof(composicao) = 'object');
alter table fv2_venda add constraint fv2_venda_composicao_fecha check (pago_centavos + devolvido_centavos + descontos_centavos <= bruto_centavos);
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0005_composicao_venda.sql', '8dbbc4296a95cc46648a38fb69ae407d5a41efdf5d1ced2c96c7f5bd408472d8', '8dbbc4296a95cc46648a38fb69ae407d5a41efdf5d1ced2c96c7f5bd408472d8');

-- ------------------------------------------------------------------------- 0006_tesouraria.sql (arquivo f4170c545e077e9d44fcd03bb21aa0c3712ec0c154e5e54ef6bcc53d5a0232a8)
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
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0006_tesouraria.sql', 'f4170c545e077e9d44fcd03bb21aa0c3712ec0c154e5e54ef6bcc53d5a0232a8', 'f4170c545e077e9d44fcd03bb21aa0c3712ec0c154e5e54ef6bcc53d5a0232a8');

-- ------------------------------------------------------------------------- 0007_saldo_referencia.sql (arquivo e27550c85b6b1d5195e1986e750aa944b64372e1690c8ab9481a634b48e6e21a)
-- =====================================================================================================================
-- Financeiro v2 — migração 0007: referência do saldo informado (Execução 06B, auditoria A.1)
--
-- Só é aplicada no PostgreSQL local isolado (scripts/fv2-banco-teste.mjs). Não pertence a database/migrations/.
--   * fv2_saldo_conta.referencia — INICIO_DO_DIA ("saldo anterior": antes dos movimentos do dia) ou FIM_DO_DIA
--     ("saldo final": já inclui os movimentos do dia). Registros anteriores eram todos de início do dia.
--   * A unicidade passa a ser por conta + data + referência: um extrato pode informar o saldo final de um dia e outro o
--     saldo anterior do dia seguinte; os dois são conferidos entre si (nunca sobrescritos).
--   * A referência faz parte do saldo informado: também não é reescrita.
-- =====================================================================================================================

alter table fv2_saldo_conta add column referencia text not null default 'INICIO_DO_DIA'
  check (referencia in ('INICIO_DO_DIA', 'FIM_DO_DIA'));

do $$
declare
  nome text;
begin
  select con.conname into nome
    from pg_constraint con
   where con.conrelid = 'fv2_saldo_conta'::regclass and con.contype = 'u'
     and (select array_agg(att.attname::text order by att.attname) from pg_attribute att
           where att.attrelid = con.conrelid and att.attnum = any (con.conkey)) = array['conta_id', 'data', 'organizacao_id', 'unidade_id'];
  if nome is null then
    raise exception 'Financeiro v2: unicidade (conta, data) de fv2_saldo_conta não encontrada.';
  end if;
  execute format('alter table fv2_saldo_conta drop constraint %I', nome);
end $$;

alter table fv2_saldo_conta add constraint fv2_saldo_conta_conta_data_referencia_uq unique (organizacao_id, unidade_id, conta_id, data, referencia);

create or replace function fv2_tg_saldo_conta() returns trigger language plpgsql as $$
begin
  if (new.conta_id, new.data, new.referencia, new.valor_centavos) is distinct from (old.conta_id, old.data, old.referencia, old.valor_centavos) then
    raise exception 'Financeiro v2: saldo informado não é reescrito.' using errcode = 'FV014';
  end if;
  return new;
end $$;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0007_saldo_referencia.sql', 'e27550c85b6b1d5195e1986e750aa944b64372e1690c8ab9481a634b48e6e21a', 'e27550c85b6b1d5195e1986e750aa944b64372e1690c8ab9481a634b48e6e21a');

-- ------------------------------------------------------------------------- 0008_conferencias_indices.sql (arquivo 25042551aa6730531d8ce9a460ab64660ef95e8f71da4fb2228a53e8279c22e9)
-- =====================================================================================================================
-- Financeiro v2 — migração 0008: índices da Central de Conferências (Execução 06C)
--
-- Só é aplicada no PostgreSQL local isolado (scripts/fv2-banco-teste.mjs). Não pertence a database/migrations/.
-- As listas da Central são paginadas NO BANCO (LIMIT/OFFSET + COUNT separado); estes índices atendem os filtros usados:
--   * propostas por competência e estado, ordenadas pela data da operação;
--   * importações por sobreposição de período (início ≤ fim do mês e fim ≥ início do mês);
--   * correspondências por competência (gravada em `extras` desde a 06C) e situação;
--   * registros de fonte ativos por importação (contagem do documento).
-- Nenhuma tabela, coluna, regra ou permissão nova.
-- =====================================================================================================================

create index fv2_proposta_competencia on fv2_proposta (organizacao_id, unidade_id, competencia, estado, data_operacao);
create index fv2_importacao_periodo on fv2_importacao (organizacao_id, unidade_id, periodo_inicio, periodo_fim);
create index fv2_correspondencia_competencia on fv2_correspondencia (organizacao_id, unidade_id, (extras->>'competencia'), situacao);
create index fv2_registro_fonte_importacao_situacao on fv2_registro_fonte (organizacao_id, unidade_id, importacao_id, situacao);
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0008_conferencias_indices.sql', '25042551aa6730531d8ce9a460ab64660ef95e8f71da4fb2228a53e8279c22e9', '25042551aa6730531d8ce9a460ab64660ef95e8f71da4fb2228a53e8279c22e9');

-- ------------------------------------------------------------------------- 0009_configuracoes_fechamento.sql (arquivo 7d986399161f897288d31772d6774f586c86ab29366e4dd4a330990fcc5e7e05)
-- =====================================================================================================================
-- Financeiro v2 — migração 0009: configurações, permissões, cofre documental e fechamento mensal (Execução 06D)
--
-- Só é aplicada no PostgreSQL local isolado (scripts/fv2-banco-teste.mjs). Não pertence a database/migrations/.
--
-- 1. Competência homologada protegida também NA PERSISTÊNCIA, para todos os registros que mudam o resultado ou o vínculo:
--      lançamento e movimentação (já desde a 0001), e agora ajuste, liquidação, correspondência (pela competência DA
--      CONCILIAÇÃO), títulos (obrigação/recebível) e venda. Títulos e vendas de competência homologada aceitam SÓ a mudança
--      da posição financeira (pago/saldo/devolvido; situação do título entre aberta-parcial-quitada) — recebimento,
--      pagamento ou devolução posteriores, que não mudam o resultado homologado; qualquer outra coluna, ajuste ou
--      cancelamento é recusado.
--      Cada gatilho toma a trava COMPARTILHADA da competência (a mesma chave do núcleo): uma escrita escrita "à mão"
--      também espera uma homologação em andamento — que toma a trava EXCLUSIVA aqui também.
-- 2. fv2_versao_fechamento   — retrato IMUTÁVEL de cada passagem por estado de fechamento (somente inserção).
-- 3. fv2_atribuicao_pendencia — responsável por pendência da Central de Conferências (com histórico).
-- 4. fv2_canal_processador   — canais e processadores cadastrados na unidade (sem taxa contratual presumida).
-- 5. fv2_configuracao_unidade — identificação e situação da unidade no Financeiro v2 (uma linha por escopo).
-- 6. Nova ação financeiro_v2.documentos na lista fechada de concessões.
-- =====================================================================================================================

-- ------------------------------------------------------------------------------------------------ trava + homologada
create or replace function fv2_trava_da_competencia(p_org uuid, p_uni uuid, p_mes text, p_exclusiva boolean) returns void language plpgsql as $$
begin
  if p_exclusiva then
    perform pg_advisory_xact_lock(hashtextextended('fv2|' || p_org::text || '|' || p_uni::text || '|competencia:' || p_mes, 0));
  else
    perform pg_advisory_xact_lock_shared(hashtextextended('fv2|' || p_org::text || '|' || p_uni::text || '|competencia:' || p_mes, 0));
  end if;
end $$;

create or replace function fv2_homologada(p_org uuid, p_uni uuid, p_mes text) returns boolean language sql stable as $$
  select exists (select 1 from fv2_competencia c where c.organizacao_id = p_org and c.unidade_id = p_uni and c.competencia = p_mes and c.estado = 'FECHAMENTO_HOMOLOGADO')
$$;

-- Mês da linha conforme a origem informada no gatilho.
create or replace function fv2_mes_da_linha(linha jsonb, origem text) returns text language sql immutable as $$
  select case origem
    when 'competencia' then linha->>'competencia'
    when 'data_efetiva' then left(linha->>'data_efetiva', 7)
    when 'conciliacao' then coalesce(linha->'extras'->>'competenciaDaConciliacao', linha->'extras'->>'competencia')
  end
$$;

-- Substitui a função da 0001: agora também toma a trava compartilhada (mesma chave do núcleo).
create or replace function fv2_bloquear_homologada() returns trigger language plpgsql as $$
declare
  mes text := fv2_mes_da_linha(to_jsonb(new), tg_argv[0]);
begin
  if mes is null then return new; end if;
  perform fv2_trava_da_competencia(new.organizacao_id, new.unidade_id, mes, false);
  if fv2_homologada(new.organizacao_id, new.unidade_id, mes) then
    raise exception 'Financeiro v2: a competência % está homologada.', mes using errcode = 'FV001';
  end if;
  return new;
end $$;

create trigger fv2_ajuste_homologada before insert or update on fv2_ajuste for each row execute function fv2_bloquear_homologada('competencia');
create trigger fv2_liquidacao_homologada before insert or update on fv2_liquidacao for each row execute function fv2_bloquear_homologada('data_efetiva');
create trigger fv2_correspondencia_homologada before insert or update on fv2_correspondencia for each row execute function fv2_bloquear_homologada('conciliacao');

-- Títulos e vendas de competência homologada: criação e mudanças ECONÔMICAS bloqueadas; só a POSIÇÃO FINANCEIRA pode mudar
-- depois do fechamento (recebimento, pagamento ou devolução posteriores — cujo efeito econômico, se houver, nasce em outra
-- competência). Os argumentos do gatilho listam as colunas livres; 'situacao_financeira' libera a situação do título entre
-- aberta, parcial e quitada (nunca cancelamento).
create or replace function fv2_posicao_em_homologada() returns trigger language plpgsql as $$
declare
  livres text[] := array['versao', 'atualizado_em', 'atualizado_por'];
  situacao_livre boolean := false;
  i int;
begin
  perform fv2_trava_da_competencia(new.organizacao_id, new.unidade_id, new.competencia, false);
  if not fv2_homologada(new.organizacao_id, new.unidade_id, new.competencia) then return new; end if;
  if tg_op = 'INSERT' then
    raise exception 'Financeiro v2: a competência % está homologada.', new.competencia using errcode = 'FV001';
  end if;
  for i in 0 .. tg_nargs - 1 loop
    if tg_argv[i] = 'situacao_financeira' then situacao_livre := true; else livres := livres || tg_argv[i]; end if;
  end loop;
  if situacao_livre then livres := livres || 'situacao'::text; end if;
  if (to_jsonb(old) - livres) is distinct from (to_jsonb(new) - livres)
     or (situacao_livre and (new.situacao = 'CANCELADA' or old.situacao = 'CANCELADA') and new.situacao is distinct from old.situacao) then
    raise exception 'Financeiro v2: registro de competência homologada só muda a posição financeira (pagamento, recebimento ou devolução posteriores).' using errcode = 'FV001';
  end if;
  return new;
end $$;
create trigger fv2_obrigacao_homologada before insert or update on fv2_obrigacao for each row execute function fv2_posicao_em_homologada('liquidado_centavos', 'saldo_centavos', 'situacao_financeira');
create trigger fv2_recebivel_homologada before insert or update on fv2_recebivel for each row execute function fv2_posicao_em_homologada('liquidado_centavos', 'saldo_centavos', 'situacao_financeira');
create trigger fv2_venda_homologada before insert or update on fv2_venda for each row execute function fv2_posicao_em_homologada('pago_centavos', 'devolvido_centavos', 'pagamento_ids');

-- Homologar toma a trava EXCLUSIVA também no banco (espera escritas "à mão" em andamento).
create or replace function fv2_trava_ao_homologar() returns trigger language plpgsql as $$
begin
  if new.estado = 'FECHAMENTO_HOMOLOGADO' and (tg_op = 'INSERT' or old.estado is distinct from new.estado) then
    perform fv2_trava_da_competencia(new.organizacao_id, new.unidade_id, new.competencia, true);
  end if;
  return new;
end $$;
create trigger fv2_competencia_trava_homologacao before insert or update on fv2_competencia for each row execute function fv2_trava_ao_homologar();

-- ------------------------------------------------------------------------------------------------ tabelas novas
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

create table fv2_versao_fechamento (
  like fv2__molde including all,
  competencia        text not null check (competencia ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  tipo               text not null check (tipo in ('PRELIMINAR', 'COM_PENDENCIAS', 'HOMOLOGADA')),
  numero             integer not null check (numero >= 1),
  revisao            integer not null check (revisao >= 0),
  metodologia        text,
  metodologia_versao text not null check (length(metodologia_versao) between 3 and 120),
  apuracao           jsonb not null check (jsonb_typeof(apuracao) = 'object'),
  pendencias         jsonb not null check (jsonb_typeof(pendencias) = 'array'),
  verificacoes       jsonb not null check (jsonb_typeof(verificacoes) = 'object'),
  decidido_por       uuid not null,
  decidido_em        timestamptz not null,
  justificativa      text,
  check (impressao ~ '^[0-9a-f]{64}$'),
  check (tipo <> 'HOMOLOGADA' or length(btrim(coalesce(metodologia, ''))) > 0),
  unique (organizacao_id, unidade_id, competencia, numero)
);

create table fv2_atribuicao_pendencia (
  like fv2__molde including all,
  competencia    text not null check (competencia ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  chave          text not null check (length(chave) between 3 and 300),
  responsavel_id uuid not null,
  situacao       text not null check (situacao in ('ATRIBUIDA', 'EM_ANALISE', 'AGUARDANDO_TERCEIRO', 'CONCLUIDA')),
  data_revisao   date,
  comentarios    jsonb not null check (jsonb_typeof(comentarios) = 'array'),
  atribuido_por  uuid not null,
  unique (organizacao_id, unidade_id, competencia, chave)
);

create table fv2_canal_processador (
  like fv2__molde including all,
  papel       text not null check (papel in ('CANAL', 'PROCESSADOR')),
  codigo      text not null check (codigo ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  codigo_base text not null,
  nome        text not null check (length(btrim(nome)) between 1 and 80),
  situacao    text not null check (situacao in ('ATIVO', 'INATIVO')),
  observacao  text,
  check ((papel = 'CANAL' and codigo_base in ('BALCAO', 'IFOOD', 'ANOTA_AI', 'OUTRO'))
      or (papel = 'PROCESSADOR' and codigo_base in ('STONE', 'IFOOD', 'ANOTA_AI', 'OPERADORA_BENEFICIOS', 'MAQUINA_TERCEIROS', 'OUTRO'))),
  unique (organizacao_id, unidade_id, papel, codigo)
);

create table fv2_configuracao_unidade (
  like fv2__molde including all,
  nome_exibicao         text not null check (length(btrim(nome_exibicao)) between 1 and 120),
  identificacao_empresa text,
  situacao              text not null check (situacao in ('ATIVA', 'INATIVA')),
  observacao            text,
  unique (organizacao_id, unidade_id)
);

drop table fv2__molde;

-- Versão de fechamento é somente inserção: nenhum UPDATE (o retrato homologado nunca é reescrito).
create or replace function fv2_versao_imutavel() returns trigger language plpgsql as $$
begin
  raise exception 'Financeiro v2: versão de fechamento é imutável.' using errcode = 'FV015';
end $$;

do $$
declare
  t record;
begin
  for t in select * from (values
    ('fv2_versao_fechamento', 'VERSAO_FECHAMENTO'), ('fv2_atribuicao_pendencia', 'ATRIBUICAO_PENDENCIA'),
    ('fv2_canal_processador', 'CANAL_PROCESSADOR'), ('fv2_configuracao_unidade', 'CONFIGURACAO_UNIDADE')
  ) as x(tabela, tipo)
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

create trigger fv2_versao_fechamento_imutavel before update on fv2_versao_fechamento for each row execute function fv2_versao_imutavel();
-- Uma versão HOMOLOGADA só nasce com a competência homologada na mesma transação (conferido no commit).
create or replace function fv2_versao_homologada_coerente() returns trigger language plpgsql as $$
begin
  if new.tipo = 'HOMOLOGADA' and not fv2_homologada(new.organizacao_id, new.unidade_id, new.competencia) then
    raise exception 'Financeiro v2: versão homologada sem competência homologada.' using errcode = 'FV015';
  end if;
  return null;
end $$;
create constraint trigger fv2_versao_fechamento_coerente after insert on fv2_versao_fechamento deferrable initially deferred
  for each row execute function fv2_versao_homologada_coerente();

-- ------------------------------------------------------------------------------------------------ concessões
do $$
declare
  r record;
begin
  for r in select conname from pg_constraint where conrelid = 'fv2_concessao'::regclass and pg_get_constraintdef(oid) like '%<@%' loop
    execute format('alter table fv2_concessao drop constraint %I', r.conname);
  end loop;
end $$;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar", "financeiro_v2.corrigir", "financeiro_v2.cancelar",
  "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar", "financeiro_v2.revisar",
  "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos"]'::jsonb);

-- ------------------------------------------------------------------------------------------------ registro de tipos
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
  end::regclass
$$;

create index fv2_versao_fechamento_competencia on fv2_versao_fechamento (organizacao_id, unidade_id, competencia, tipo, numero);
create index fv2_correspondencia_conciliacao on fv2_correspondencia (organizacao_id, unidade_id, (extras->>'competenciaDaConciliacao'), situacao);
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0009_configuracoes_fechamento.sql', '7d986399161f897288d31772d6774f586c86ab29366e4dd4a330990fcc5e7e05', '7d986399161f897288d31772d6774f586c86ab29366e4dd4a330990fcc5e7e05');

-- ------------------------------------------------------------------------- 0010_auditoria_posicao_posterior.sql (arquivo 45714c799f03d562136b1038b6a91809bd0414adc71a5fd2541784f2af4cf7f6)
-- =====================================================================================================================
-- Financeiro v2 — migração 0010: auditoria integrada (Execução 07)
--
-- Só é aplicada no PostgreSQL local isolado (scripts/fv2-banco-teste.mjs). Não pertence a database/migrations/.
--
-- Achado da auditoria: um título (recebível/obrigação) de competência homologada pode ter o VALOR DEVIDO reduzido por um
-- fato POSTERIOR legítimo (estorno de pagamento de venda, taxa descoberta depois e reconhecida no mês em que foi
-- descoberta). Esses fatos gravam um registro em fv2_ajuste NA COMPETÊNCIA ABERTA do fato (o gatilho da 0009 recusa
-- ajuste em competência homologada) e mudam `ajustes_centavos` do título. Na 0009 essa coluna não era livre: o núcleo
-- permitia e o banco recusava — comportamento diferente entre memória e PostgreSQL.
--
-- Regra nova: em competência homologada, `ajustes_centavos` só muda se ficar IGUAL à soma dos registros de ajuste do
-- título (todos auditados, com histórico, e os novos necessariamente em competência aberta). Mudança "solta", sem o
-- registro correspondente, continua recusada (FV001). Nada mais foi liberado.
-- =====================================================================================================================

create or replace function fv2_posicao_em_homologada() returns trigger language plpgsql as $$
declare
  livres text[] := array['versao', 'atualizado_em', 'atualizado_por'];
  situacao_livre boolean := false;
  ajustes_livres boolean := false;
  soma bigint;
  i int;
begin
  perform fv2_trava_da_competencia(new.organizacao_id, new.unidade_id, new.competencia, false);
  if not fv2_homologada(new.organizacao_id, new.unidade_id, new.competencia) then return new; end if;
  if tg_op = 'INSERT' then
    raise exception 'Financeiro v2: a competência % está homologada.', new.competencia using errcode = 'FV001';
  end if;
  for i in 0 .. tg_nargs - 1 loop
    if tg_argv[i] = 'situacao_financeira' then situacao_livre := true;
    elsif tg_argv[i] = 'ajustes_registrados' then ajustes_livres := true;
    else livres := livres || tg_argv[i]; end if;
  end loop;
  if situacao_livre then livres := livres || 'situacao'::text; end if;
  if ajustes_livres and (to_jsonb(new)->>'ajustes_centavos') is distinct from (to_jsonb(old)->>'ajustes_centavos') then
    select coalesce(sum(a.valor_centavos), 0) into soma from fv2_ajuste a
     where a.organizacao_id = new.organizacao_id and a.unidade_id = new.unidade_id and a.alvo_id = new.id;
    if soma <> (to_jsonb(new)->>'ajustes_centavos')::bigint then
      raise exception 'Financeiro v2: ajuste de título de competência homologada sem o registro de ajuste correspondente.' using errcode = 'FV001';
    end if;
    livres := livres || 'ajustes_centavos'::text;
  end if;
  if (to_jsonb(old) - livres) is distinct from (to_jsonb(new) - livres)
     or (situacao_livre and (new.situacao = 'CANCELADA' or old.situacao = 'CANCELADA') and new.situacao is distinct from old.situacao) then
    raise exception 'Financeiro v2: registro de competência homologada só muda a posição financeira (pagamento, recebimento ou devolução posteriores).' using errcode = 'FV001';
  end if;
  return new;
end $$;

drop trigger fv2_obrigacao_homologada on fv2_obrigacao;
drop trigger fv2_recebivel_homologada on fv2_recebivel;
create trigger fv2_obrigacao_homologada before insert or update on fv2_obrigacao for each row execute function fv2_posicao_em_homologada('liquidado_centavos', 'saldo_centavos', 'situacao_financeira', 'ajustes_registrados');
create trigger fv2_recebivel_homologada before insert or update on fv2_recebivel for each row execute function fv2_posicao_em_homologada('liquidado_centavos', 'saldo_centavos', 'situacao_financeira', 'ajustes_registrados');
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0010_auditoria_posicao_posterior.sql', '45714c799f03d562136b1038b6a91809bd0414adc71a5fd2541784f2af4cf7f6', '45714c799f03d562136b1038b6a91809bd0414adc71a5fd2541784f2af4cf7f6');

-- ------------------------------------------------------------------------- 0011_sessao_banco_e_concessoes.sql (arquivo f89aba0ad79f4bef458751ed0468d85f7bc9d850872a905e3ffb1a2cb2610c5d)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0011: identidade de sessão no banco e concessões protegidas (Execução 07B)
--
-- Só é aplicada no PostgreSQL local isolado (scripts/fv2-banco-teste.mjs). Não pertence a database/migrations/.
--
-- PROBLEMA (auditoria 07, riscos P7 e P8):
--   * o escopo do RLS vinha de duas variáveis de sessão (fv2.organizacao_id/fv2.unidade_id) que o próprio papel da
--     aplicação define: quem tivesse a credencial da aplicação escolhia qualquer unidade;
--   * a aplicação gravava fv2_concessao por SQL livre: as regras de escalada só existiam no núcleo.
--
-- CORREÇÃO:
--   * SESSÃO DE BANCO: só a AUTORIDADE (papel fv2_autoridade — o gateway de autenticação, credencial separada) emite
--     sessões. A emissão exige concessão ATIVA do usuário no escopo. A aplicação recebe um token aleatório (o banco
--     guarda só o hash) e o declara por transação (fv2.sessao). Organização, unidade e usuário vêm do REGISTRO da sessão,
--     nunca de variável escolhida pela aplicação. Sem sessão válida = nenhuma linha (falha fechada).
--   * CONCESSÕES: a aplicação perde INSERT/UPDATE em fv2_concessao. A única escrita é fv2_gravar_concessao, que confere
--     NO BANCO: ator = usuário da sessão; ninguém concede a si mesmo; o ator tem `conceder` e todas as ações novas;
--     escopo = o da sessão; trava por escopo (concorrência sem escalada); auditoria própria, só de inserção; e revoga as
--     sessões de banco do alvo (a mudança vale na próxima transação).
--   * PROVISIONAMENTO INICIAL: sessão especial emitida só pela autoridade, com atestante ≠ alvo, nível aal2 declarado,
--     justificativa e evidência, apenas quando a unidade não tem quem conceda. Não dá acesso financeiro ao atestante.
--   * As funções privilegiadas pertencem a fv2_guardiao (sem login, sem membros), com search_path fixo e EXECUTE
--     revogado de PUBLIC. As políticas dele são explícitas e restritas às tabelas de concessão e escopo.
--   * Políticas de todas as tabelas: escopo da sessão avaliado uma vez por consulta; leitura exige sessão OPERACIONAL;
--     escrita exige sessão com ação além de `ver`.
--
-- LIMITE HONESTO: o banco não autentica pessoas. Ele confia em quem detém a credencial de fv2_autoridade. A garantia é
-- que a credencial da APLICAÇÃO, sozinha, não escolhe escopo, não cria sessão e não altera concessão.
-- =====================================================================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'fv2_autoridade') then
    create role fv2_autoridade nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'fv2_guardiao') then
    create role fv2_guardiao nologin;
  end if;
end $$;

-- ------------------------------------------------------------------------------------------------ tabelas protegidas
create table fv2_sessao_banco (
  id                uuid primary key default gen_random_uuid(),
  token_hash        bytea not null unique check (length(token_hash) = 32),
  usuario_id        uuid not null,
  organizacao_id    uuid not null,
  unidade_id        uuid not null,
  finalidade        text not null check (finalidade in ('OPERACAO', 'PROVISIONAMENTO')),
  pode_escrever     boolean not null,
  alvo              uuid,
  acoes_autorizadas jsonb,
  referencia        text check (referencia is null or length(referencia) <= 200),
  emitida_por       text not null default session_user,
  emitida_em        timestamptz not null default clock_timestamp(),
  expira_em         timestamptz not null,
  revogada_em       timestamptz,
  motivo_revogacao  text,
  foreign key (organizacao_id, unidade_id) references fv2_escopo,
  check ((finalidade = 'PROVISIONAMENTO') = (alvo is not null)),
  check (expira_em > emitida_em)
);
create index fv2_sessao_banco_usuario on fv2_sessao_banco (organizacao_id, unidade_id, usuario_id) where revogada_em is null;

create table fv2_auditoria_concessao (
  seq             bigint generated always as identity primary key,
  organizacao_id  uuid not null,
  unidade_id      uuid not null,
  concessao_id    uuid not null,
  usuario_alvo    uuid not null,
  ator            uuid not null,
  sessao_id       uuid not null,
  finalidade      text not null,
  operacao        text not null,
  acoes_antes     jsonb not null,
  acoes_depois    jsonb not null,
  situacao_depois text not null,
  justificativa   text not null,
  papel_de_banco  text not null default session_user,
  em              timestamptz not null default clock_timestamp()
);

create table fv2_provisionamento_inicial (
  id                 uuid primary key default gen_random_uuid(),
  organizacao_id     uuid not null,
  unidade_id         uuid not null,
  usuario_id         uuid not null,
  atestante_id       uuid not null check (atestante_id <> usuario_id),
  nivel_autenticacao text not null check (nivel_autenticacao = 'aal2'),
  acoes              jsonb not null,
  justificativa      text not null,
  evidencia          text not null,
  sessao_id          uuid not null references fv2_sessao_banco,
  emitido_em         timestamptz not null default clock_timestamp(),
  concluido_em       timestamptz,
  foreign key (organizacao_id, unidade_id) references fv2_escopo
);

create function fv2_somente_insercao() returns trigger language plpgsql as $$
begin
  raise exception 'Financeiro v2: % só aceita inclusão.', tg_table_name using errcode = 'FV040';
end $$;
create trigger fv2_auditoria_concessao_imutavel before update or delete on fv2_auditoria_concessao for each row execute function fv2_somente_insercao();
create trigger fv2_auditoria_concessao_sem_truncate before truncate on fv2_auditoria_concessao for each statement execute function fv2_somente_insercao();
create trigger fv2_sessao_banco_sem_delete before delete on fv2_sessao_banco for each row execute function fv2_somente_insercao();
create trigger fv2_provisionamento_sem_delete before delete on fv2_provisionamento_inicial for each row execute function fv2_somente_insercao();

revoke all on fv2_sessao_banco, fv2_auditoria_concessao, fv2_provisionamento_inicial from public;
grant select, insert, update on fv2_sessao_banco, fv2_provisionamento_inicial to fv2_guardiao;
grant select, insert on fv2_auditoria_concessao to fv2_guardiao;
grant select on fv2_escopo to fv2_guardiao;
grant select, insert, update on fv2_concessao to fv2_guardiao;

-- Exceção EXPLÍCITA e restrita: o guardião (sem login, sem membros) só é alcançado pelas funções abaixo, que filtram o
-- escopo pela própria sessão. Nenhum outro papel ganha política nova.
create policy fv2_concessao_guardiao on fv2_concessao to fv2_guardiao using (true) with check (true);
create policy fv2_escopo_guardiao on fv2_escopo for select to fv2_guardiao using (true);

-- A aplicação não escreve mais concessões por SQL.
revoke insert, update, delete, truncate on fv2_concessao from fv2_app;

-- ------------------------------------------------------------------------------------------------ sessão vigente
create type fv2_sessao_vigente as (
  sessao_id uuid, usuario_id uuid, organizacao_id uuid, unidade_id uuid,
  finalidade text, pode_escrever boolean, alvo uuid, acoes_autorizadas jsonb
);

create function fv2__sessao_vigente() returns setof fv2_sessao_vigente
language sql stable security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
  select s.id, s.usuario_id, s.organizacao_id, s.unidade_id, s.finalidade, s.pode_escrever, s.alvo, s.acoes_autorizadas
    from fv2_sessao_banco s
   where s.token_hash = sha256(convert_to(nullif(current_setting('fv2.sessao', true), ''), 'UTF8'))
     and s.revogada_em is null
     and s.expira_em > now()
$$;

create or replace function fv2_org() returns uuid language sql stable as $$ select organizacao_id from fv2__sessao_vigente() $$;
create or replace function fv2_uni() returns uuid language sql stable as $$ select unidade_id from fv2__sessao_vigente() $$;
create function fv2_usuario() returns uuid language sql stable as $$ select usuario_id from fv2__sessao_vigente() $$;
create function fv2_sessao_operacional() returns boolean language sql stable as
  $$ select coalesce((select finalidade = 'OPERACAO' from fv2__sessao_vigente()), false) $$;
create function fv2_pode_escrever() returns boolean language sql stable as
  $$ select coalesce((select finalidade = 'OPERACAO' and pode_escrever from fv2__sessao_vigente()), false) $$;
create function fv2_em_provisionamento() returns boolean language sql stable as
  $$ select coalesce((select finalidade = 'PROVISIONAMENTO' from fv2__sessao_vigente()), false) $$;

/** A aplicação declara o token da transação. Limpa qualquer valor de sessão deixado na conexão (pool). */
create function fv2_assumir_sessao(p_token text) returns fv2_sessao_vigente language plpgsql as $$
declare
  v fv2_sessao_vigente;
begin
  perform set_config('fv2.sessao', '', false);
  perform set_config('fv2.sessao', coalesce(p_token, ''), true);
  select * into v from fv2__sessao_vigente();
  return v;
end $$;

-- ------------------------------------------------------------------------------------------------ emissão (autoridade)
create function fv2__acoes_ordenadas(p jsonb) returns jsonb language sql immutable as
  $$ select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from (select distinct x from jsonb_array_elements_text(p) x) d $$;

create function fv2__trava_concessoes(p_organizacao uuid, p_unidade uuid, p_exclusiva boolean) returns void language plpgsql as $$
begin
  if p_exclusiva then
    perform pg_advisory_xact_lock(hashtextextended('fv2|' || p_organizacao || '|' || p_unidade || '|concessoes', 0));
  else
    perform pg_advisory_xact_lock_shared(hashtextextended('fv2|' || p_organizacao || '|' || p_unidade || '|concessoes', 0));
  end if;
end $$;

create function fv2__novo_token() returns text language sql volatile as
  $$ select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') $$;

create function fv2_abrir_sessao(p_usuario uuid, p_organizacao uuid, p_unidade uuid, p_validade_segundos integer, p_referencia text)
returns text language plpgsql volatile security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
declare
  acoes jsonb;
  token text := fv2__novo_token();
begin
  if p_usuario is null or p_organizacao is null or p_unidade is null then
    raise exception 'Financeiro v2: sessão sem usuário, organização ou unidade.' using errcode = '22023';
  end if;
  if p_validade_segundos is null or p_validade_segundos < 1 or p_validade_segundos > 43200 then
    raise exception 'Financeiro v2: validade da sessão fora do limite (1 s a 12 h).' using errcode = '22023';
  end if;
  if not exists (select 1 from fv2_escopo e where e.organizacao_id = p_organizacao and e.unidade_id = p_unidade) then
    raise exception 'Financeiro v2: escopo não configurado.' using errcode = 'FV020';
  end if;
  -- Compartilhada: espera concessões em alteração no escopo terminarem (uma revogação em andamento nunca é "furada").
  perform fv2__trava_concessoes(p_organizacao, p_unidade, false);
  select c.acoes into acoes from fv2_concessao c
   where c.organizacao_id = p_organizacao and c.unidade_id = p_unidade and c.usuario_id = p_usuario and c.situacao = 'ATIVA';
  if acoes is null or jsonb_array_length(acoes) = 0 then
    raise exception 'Financeiro v2: usuário sem concessão ativa nesta unidade.' using errcode = 'FV020';
  end if;
  insert into fv2_sessao_banco (token_hash, usuario_id, organizacao_id, unidade_id, finalidade, pode_escrever, referencia, expira_em)
  values (sha256(convert_to(token, 'UTF8')), p_usuario, p_organizacao, p_unidade, 'OPERACAO',
          exists (select 1 from jsonb_array_elements_text(acoes) a where a <> 'financeiro_v2.ver'),
          left(p_referencia, 200), clock_timestamp() + make_interval(secs => p_validade_segundos));
  return token;
end $$;

create function fv2_abrir_sessao_de_provisionamento(p_atestante uuid, p_usuario uuid, p_organizacao uuid, p_unidade uuid,
  p_acoes jsonb, p_nivel_autenticacao text, p_justificativa text, p_evidencia text)
returns text language plpgsql volatile security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
declare
  token text := fv2__novo_token();
  sessao uuid;
  acoes jsonb;
begin
  if p_atestante is null or p_usuario is null or p_organizacao is null or p_unidade is null then
    raise exception 'Financeiro v2: provisionamento incompleto.' using errcode = 'FV021';
  end if;
  if p_nivel_autenticacao is distinct from 'aal2' then
    raise exception 'Financeiro v2: o atestante precisa de autenticação multifator (aal2).' using errcode = 'FV021';
  end if;
  if p_atestante = p_usuario then
    raise exception 'Financeiro v2: o atestante não provisiona a si mesmo.' using errcode = 'FV021';
  end if;
  if coalesce(length(btrim(p_justificativa)), 0) not between 1 and 500 or coalesce(length(btrim(p_evidencia)), 0) not between 1 and 300 then
    raise exception 'Financeiro v2: provisionamento exige justificativa e evidência.' using errcode = 'FV021';
  end if;
  if jsonb_typeof(p_acoes) is distinct from 'array' or jsonb_array_length(p_acoes) = 0 then
    raise exception 'Financeiro v2: provisionamento exige ações explícitas.' using errcode = 'FV021';
  end if;
  acoes := fv2__acoes_ordenadas(p_acoes);
  if not exists (select 1 from fv2_escopo e where e.organizacao_id = p_organizacao and e.unidade_id = p_unidade) then
    raise exception 'Financeiro v2: escopo não configurado.' using errcode = 'FV021';
  end if;
  perform fv2__trava_concessoes(p_organizacao, p_unidade, true);
  if exists (select 1 from fv2_concessao c where c.organizacao_id = p_organizacao and c.unidade_id = p_unidade
              and c.situacao = 'ATIVA' and c.acoes ? 'financeiro_v2.conceder') then
    raise exception 'Financeiro v2: a unidade já tem administrador; provisionamento inicial recusado.' using errcode = 'FV021';
  end if;
  insert into fv2_sessao_banco (token_hash, usuario_id, organizacao_id, unidade_id, finalidade, pode_escrever, alvo, acoes_autorizadas, referencia, expira_em)
  values (sha256(convert_to(token, 'UTF8')), p_atestante, p_organizacao, p_unidade, 'PROVISIONAMENTO', false, p_usuario, acoes,
          'provisionamento inicial', clock_timestamp() + interval '2 minutes')
  returning id into sessao;
  insert into fv2_provisionamento_inicial (organizacao_id, unidade_id, usuario_id, atestante_id, nivel_autenticacao, acoes, justificativa, evidencia, sessao_id)
  values (p_organizacao, p_unidade, p_usuario, p_atestante, p_nivel_autenticacao, acoes, btrim(p_justificativa), btrim(p_evidencia), sessao);
  return token;
end $$;

/** Logout, troca de contexto ou revogação da sessão da plataforma: encerra as sessões de banco do usuário no escopo. */
create function fv2_encerrar_sessoes(p_usuario uuid, p_organizacao uuid, p_unidade uuid, p_motivo text)
returns integer language plpgsql volatile security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
declare
  n integer;
begin
  update fv2_sessao_banco set revogada_em = clock_timestamp(), motivo_revogacao = left(coalesce(p_motivo, 'encerrada pela autoridade'), 200)
   where usuario_id = p_usuario and organizacao_id = p_organizacao and unidade_id = p_unidade and revogada_em is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- ------------------------------------------------------------------------------------------------ escrita de concessão
create function fv2_gravar_concessao(p jsonb, p_versao_esperada integer)
returns integer language plpgsql volatile security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
declare
  s fv2_sessao_vigente;
  r fv2_concessao;
  atual fv2_concessao;
  ator jsonb;
  antes jsonb;
  novas jsonb;
  operacao text;
  n integer;
begin
  select * into s from fv2__sessao_vigente();
  if s.sessao_id is null then
    raise exception 'Financeiro v2: sessão de banco ausente, expirada ou revogada.' using errcode = '42501';
  end if;
  r := jsonb_populate_record(null::fv2_concessao, p);
  if r.organizacao_id is distinct from s.organizacao_id or r.unidade_id is distinct from s.unidade_id then
    raise exception 'Financeiro v2: concessão fora do escopo da sessão.' using errcode = '42501';
  end if;
  perform fv2__trava_concessoes(s.organizacao_id, s.unidade_id, true);
  -- Revalida DEPOIS da trava: a sessão do ator pode ter sido revogada enquanto esperava.
  select * into s from fv2__sessao_vigente();
  if s.sessao_id is null then
    raise exception 'Financeiro v2: sessão de banco revogada durante a operação.' using errcode = '42501';
  end if;
  if r.usuario_id = s.usuario_id then
    raise exception 'Financeiro v2: ninguém concede nem revoga o próprio acesso.' using errcode = 'FV030';
  end if;
  if r.atualizado_por is distinct from s.usuario_id or r.concedido_por is distinct from s.usuario_id then
    raise exception 'Financeiro v2: a autoria da concessão é a do usuário da sessão.' using errcode = 'FV031';
  end if;
  select * into atual from fv2_concessao c where c.organizacao_id = s.organizacao_id and c.unidade_id = s.unidade_id and c.id = r.id;
  if atual.id is not null and atual.usuario_id <> r.usuario_id then
    raise exception 'Financeiro v2: uma concessão não muda de usuário.' using errcode = 'FV033';
  end if;
  antes := case when atual.id is not null and atual.situacao = 'ATIVA' then atual.acoes else '[]'::jsonb end;
  select coalesce(jsonb_agg(a), '[]'::jsonb) into novas from jsonb_array_elements_text(r.acoes) a where not (antes ? a);

  if s.finalidade = 'PROVISIONAMENTO' then
    if r.usuario_id is distinct from s.alvo or r.situacao <> 'ATIVA' or fv2__acoes_ordenadas(r.acoes) is distinct from s.acoes_autorizadas then
      raise exception 'Financeiro v2: o provisionamento grava exatamente o que foi atestado.' using errcode = 'FV035';
    end if;
    if exists (select 1 from fv2_concessao c where c.organizacao_id = s.organizacao_id and c.unidade_id = s.unidade_id
                and c.situacao = 'ATIVA' and c.acoes ? 'financeiro_v2.conceder') then
      raise exception 'Financeiro v2: a unidade já tem administrador.' using errcode = 'FV035';
    end if;
    operacao := 'PROVISIONAMENTO';
  else
    select c.acoes into ator from fv2_concessao c
     where c.organizacao_id = s.organizacao_id and c.unidade_id = s.unidade_id and c.usuario_id = s.usuario_id and c.situacao = 'ATIVA';
    if ator is null or not (ator ? 'financeiro_v2.conceder') then
      raise exception 'Financeiro v2: o usuário da sessão não tem concessão para conceder.' using errcode = 'FV032';
    end if;
    if exists (select 1 from jsonb_array_elements_text(novas) a where not (ator ? a)) then
      raise exception 'Financeiro v2: não é possível conceder uma ação que você não possui.' using errcode = 'FV034';
    end if;
    operacao := case when jsonb_array_length(novas) > 0 then 'CONCESSAO' else 'REVOGACAO' end;
  end if;

  if p_versao_esperada is null then
    insert into fv2_concessao (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por,
                               chave_idempotencia, impressao, extras, usuario_id, acoes, situacao, concedido_por, justificativa)
    values (r.id, r.organizacao_id, r.unidade_id, r.versao, r.criado_em, r.criado_por, r.atualizado_em, r.atualizado_por,
            r.chave_idempotencia, r.impressao, coalesce(r.extras, '{}'::jsonb), r.usuario_id, r.acoes, r.situacao, r.concedido_por, r.justificativa);
    n := 1;
  else
    update fv2_concessao c
       set versao = r.versao, atualizado_em = r.atualizado_em, atualizado_por = r.atualizado_por, impressao = r.impressao,
           extras = coalesce(r.extras, '{}'::jsonb), acoes = r.acoes, situacao = r.situacao, concedido_por = r.concedido_por,
           justificativa = r.justificativa
     where c.organizacao_id = s.organizacao_id and c.unidade_id = s.unidade_id and c.id = r.id and c.versao = p_versao_esperada;
    get diagnostics n = row_count;
    if n = 0 then
      return 0;
    end if;
  end if;

  insert into fv2_auditoria_concessao (organizacao_id, unidade_id, concessao_id, usuario_alvo, ator, sessao_id, finalidade, operacao,
                                       acoes_antes, acoes_depois, situacao_depois, justificativa)
  values (s.organizacao_id, s.unidade_id, r.id, r.usuario_id, s.usuario_id, s.sessao_id, s.finalidade, operacao,
          coalesce(atual.acoes, '[]'::jsonb), r.acoes, r.situacao, r.justificativa);
  -- Qualquer mudança nos direitos do alvo derruba as sessões de banco dele: a próxima transação recalcula (ou é recusada).
  update fv2_sessao_banco b set revogada_em = clock_timestamp(), motivo_revogacao = 'concessão alterada'
   where b.usuario_id = r.usuario_id and b.organizacao_id = s.organizacao_id and b.unidade_id = s.unidade_id and b.revogada_em is null;
  if s.finalidade = 'PROVISIONAMENTO' then
    update fv2_provisionamento_inicial p set concluido_em = clock_timestamp() where p.sessao_id = s.sessao_id and p.concluido_em is null;
  end if;
  return n;
end $$;

-- ------------------------------------------------------------------------------------------------ propriedade e execução
do $$
declare
  f text;
begin
  foreach f in array array[
    'fv2__sessao_vigente()', 'fv2_abrir_sessao(uuid, uuid, uuid, integer, text)',
    'fv2_abrir_sessao_de_provisionamento(uuid, uuid, uuid, uuid, jsonb, text, text, text)',
    'fv2_encerrar_sessoes(uuid, uuid, uuid, text)', 'fv2_gravar_concessao(jsonb, integer)'
  ] loop
    execute format('alter function %s owner to fv2_guardiao', f);
    execute format('revoke all on function %s from public', f);
  end loop;
end $$;
grant execute on function fv2__sessao_vigente() to fv2_app;
grant execute on function fv2_gravar_concessao(jsonb, integer) to fv2_app;
grant execute on function fv2_abrir_sessao(uuid, uuid, uuid, integer, text) to fv2_autoridade;
grant execute on function fv2_abrir_sessao_de_provisionamento(uuid, uuid, uuid, uuid, jsonb, text, text, text) to fv2_autoridade;
grant execute on function fv2_encerrar_sessoes(uuid, uuid, uuid, text) to fv2_autoridade;
revoke all on function fv2__trava_concessoes(uuid, uuid, boolean) from public;
grant execute on function fv2__trava_concessoes(uuid, uuid, boolean) to fv2_guardiao;

-- ------------------------------------------------------------------------------------------------ políticas
-- 1) escopo da sessão avaliado UMA vez por consulta (subconsulta), não por linha;
-- 2) leitura só com sessão operacional (a de provisionamento enxerga apenas concessões e o histórico delas);
-- 3) escrita só com sessão operacional que tenha alguma ação além de `ver`.
do $$
declare
  p record;
  t record;
  usando text;
  conferindo text;
begin
  for p in select tablename, policyname, qual, with_check from pg_policies
            where schemaname = current_schema() and tablename like 'fv2\_%' and (qual like '%fv2_org()%' or with_check like '%fv2_org()%') loop
    usando := replace(replace(p.qual, 'fv2_org()', '(select fv2_org())'), 'fv2_uni()', '(select fv2_uni())');
    conferindo := replace(replace(p.with_check, 'fv2_org()', '(select fv2_org())'), 'fv2_uni()', '(select fv2_uni())');
    if conferindo is null then
      execute format('alter policy %I on %I using (%s)', p.policyname, p.tablename, usando);
    else
      execute format('alter policy %I on %I using (%s) with check (%s)', p.policyname, p.tablename, usando, conferindo);
    end if;
  end loop;
  for t in select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
            where ns.nspname = current_schema() and c.relkind = 'r' and c.relrowsecurity and c.relname like 'fv2\_%'
              and c.relname not in ('fv2_concessao', 'fv2_escopo', 'fv2_historico') loop
    execute format('create policy %I on %I as restrictive for select using ((select fv2_sessao_operacional()))', t.relname || '_ler', t.relname);
    execute format('create policy %I on %I as restrictive for insert with check ((select fv2_pode_escrever()))', t.relname || '_incluir', t.relname);
    execute format('create policy %I on %I as restrictive for update using ((select fv2_pode_escrever()))', t.relname || '_alterar', t.relname);
  end loop;
end $$;

create policy fv2_historico_ler on fv2_historico as restrictive for select
  using ((select fv2_sessao_operacional()) or registro_tipo = 'CONCESSAO');
create policy fv2_historico_incluir on fv2_historico as restrictive for insert
  with check ((select fv2_pode_escrever()) or ((select fv2_em_provisionamento()) and registro_tipo = 'CONCESSAO'));
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0011_sessao_banco_e_concessoes.sql', 'f89aba0ad79f4bef458751ed0468d85f7bc9d850872a905e3ffb1a2cb2610c5d', '11076638e13b9d499a409d30ffbb692846a2e0a71fa7652a473b5b157f0b2642');

-- ------------------------------------------------------------------------- 0012_permissao_por_acao.sql (arquivo cd0f8f8e3e2d05beaef02a7832ffd32765f5aa9ed1067208239c8f3b430f6fa2)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0012: autorização POR AÇÃO no caminho de persistência (Execução 08)
--
-- Só é aplicada no PostgreSQL local isolado. Não pertence a database/migrations/.
--
-- PROBLEMA (07B, risco R4): o banco exigia sessão válida, mas qualquer sessão com uma ação além de `ver` gravava em
-- qualquer tabela da unidade (ex.: quem só concilia podia gravar vendas; quem só importa podia mudar a competência).
--
-- CORREÇÃO:
--   * fv2_tem_acao(ações[]): a sessão de banco é operacional E o usuário DELA tem, AGORA (concessão gravada e ativa,
--     lida no comando — revogação concorrente vale no comando seguinte), alguma das ações pedidas na mesma unidade;
--   * cada tabela × operação exige o conjunto de ações que o núcleo realmente usa para gravá-la (mapa medido pela
--     suíte inteira instrumentada — docs/financeiro-v2/17, seção 4). Operação sem uso legítimo = recusada sempre;
--   * competência: gatilho espelha a matriz de transições do núcleo (dominio/fechamento.js): homologar exige
--     `homologar`; reabrir uma homologada exige `revisar`; as demais mudanças de estado exigem `fechar`;
--   * histórico: só quem tem alguma ação de escrita (ou a sessão de provisionamento, para a concessão atestada).
-- Leitura continua exigindo sessão operacional (07B). Superusuário/dono não passam pela regra (como no RLS).
-- =====================================================================================================================

create function fv2_tem_acao(p_acoes text[]) returns boolean
language sql stable security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
  select exists (
    select 1
      from fv2__sessao_vigente() s
      join fv2_concessao c on c.organizacao_id = s.organizacao_id and c.unidade_id = s.unidade_id and c.usuario_id = s.usuario_id
     where s.finalidade = 'OPERACAO' and c.situacao = 'ATIVA' and c.acoes ?| p_acoes
  )
$$;
alter function fv2_tem_acao(text[]) owner to fv2_guardiao;
revoke all on function fv2_tem_acao(text[]) from public;
grant execute on function fv2_tem_acao(text[]) to fv2_app;

-- Mapa tabela × operação → ações (prefixo financeiro_v2. omitido aqui e acrescentado abaixo).
create temporary table fv2__mapa (tabela text, operacao text, acoes text[]) on commit drop;
insert into fv2__mapa values
  ('fv2_ajuste', 'I', '{cancelar,corrigir,revisar,registrar}'),
  ('fv2_atribuicao_pendencia', 'I', '{revisar}'), ('fv2_atribuicao_pendencia', 'U', '{revisar}'),
  ('fv2_canal_processador', 'I', '{configurar}'), ('fv2_canal_processador', 'U', '{configurar}'),
  ('fv2_categoria', 'I', '{configurar,registrar}'), ('fv2_categoria', 'U', '{configurar}'),
  ('fv2_competencia', 'I', '{fechar}'), ('fv2_competencia', 'U', '{fechar,homologar,revisar}'),
  ('fv2_configuracao_unidade', 'I', '{configurar}'), ('fv2_configuracao_unidade', 'U', '{configurar}'),
  ('fv2_conta', 'I', '{configurar}'), ('fv2_conta', 'U', '{configurar}'),
  ('fv2_contraparte', 'I', '{registrar,revisar}'), ('fv2_contraparte', 'U', '{registrar,configurar}'),
  ('fv2_correspondencia', 'I', '{conciliar}'), ('fv2_correspondencia', 'U', '{conciliar}'),
  ('fv2_divergencia_fonte', 'I', '{registrar,importar}'), ('fv2_divergencia_fonte', 'U', '{revisar}'),
  ('fv2_documento', 'I', '{importar,registrar}'), ('fv2_documento', 'U', '{importar,registrar}'),
  ('fv2_estorno', 'I', '{cancelar}'),
  ('fv2_importacao', 'I', '{importar}'), ('fv2_importacao', 'U', '{importar}'),
  ('fv2_lancamento', 'I', '{cancelar,corrigir,registrar,revisar}'), ('fv2_lancamento', 'U', '{cancelar,corrigir,revisar}'),
  ('fv2_liquidacao', 'I', '{registrar,revisar}'), ('fv2_liquidacao', 'U', '{cancelar}'),
  ('fv2_movimentacao', 'I', '{cancelar,registrar,revisar}'), ('fv2_movimentacao', 'U', '{cancelar,conciliar,registrar}'),
  ('fv2_obrigacao', 'I', '{registrar,revisar}'), ('fv2_obrigacao', 'U', '{cancelar,corrigir,registrar,revisar}'),
  ('fv2_pagamento_venda', 'I', '{registrar,revisar}'), ('fv2_pagamento_venda', 'U', '{cancelar}'),
  ('fv2_proposta', 'I', '{registrar,importar}'), ('fv2_proposta', 'U', '{cancelar,registrar,revisar}'),
  ('fv2_recebivel', 'I', '{registrar,revisar}'), ('fv2_recebivel', 'U', '{cancelar,corrigir,registrar,revisar}'),
  ('fv2_registro_fonte', 'I', '{importar}'), ('fv2_registro_fonte', 'U', '{importar}'),
  ('fv2_saldo_conta', 'I', '{registrar}'),
  ('fv2_sessao_caixa', 'I', '{registrar}'), ('fv2_sessao_caixa', 'U', '{registrar}'),
  ('fv2_transferencia', 'I', '{registrar}'), ('fv2_transferencia', 'U', '{cancelar}'),
  ('fv2_venda', 'I', '{registrar,revisar}'), ('fv2_venda', 'U', '{cancelar,registrar,revisar}'),
  ('fv2_versao_fechamento', 'I', '{fechar,homologar}'),
  ('fv2_vinculo_documental', 'I', '{registrar,importar}');

do $$
declare
  t record;
  acoes text;
  inc text;
  alt text;
begin
  for t in select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
            where ns.nspname = current_schema() and c.relkind = 'r' and c.relrowsecurity and c.relname like 'fv2\_%'
              and c.relname not in ('fv2_concessao', 'fv2_escopo', 'fv2_historico') loop
    select string_agg(format('%L', 'financeiro_v2.' || a), ', ') into acoes from fv2__mapa m, unnest(m.acoes) a where m.tabela = t.relname and m.operacao = 'I';
    inc := case when acoes is null then 'false' else format('(select fv2_tem_acao(array[%s]))', acoes) end;
    select string_agg(format('%L', 'financeiro_v2.' || a), ', ') into acoes from fv2__mapa m, unnest(m.acoes) a where m.tabela = t.relname and m.operacao = 'U';
    alt := case when acoes is null then 'false' else format('(select fv2_tem_acao(array[%s]))', acoes) end;
    -- USING de UPDATE também governa SELECT ... FOR UPDATE (reserva da linha numa operação que GRAVA a tabela ou a
    -- referencia): vale para quem pode incluir OU alterar. A ALTERAÇÃO em si é decidida no WITH CHECK (só as ações
    -- de alteração; sem uso legítimo = recusada com erro, nunca "sumida").
    select string_agg(distinct format('%L', 'financeiro_v2.' || a), ', ') into acoes from fv2__mapa m, unnest(m.acoes) a where m.tabela = t.relname;
    execute format('alter policy %I on %I with check (%s)', t.relname || '_incluir', t.relname, inc);
    execute format('alter policy %I on %I using (%s) with check (%s)', t.relname || '_alterar', t.relname,
      case when acoes is null then 'false' else format('(select fv2_tem_acao(array[%s]))', acoes) end, alt);
  end loop;
end $$;

alter policy fv2_historico_incluir on fv2_historico with check (
  (select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar',
    'financeiro_v2.fechar', 'financeiro_v2.homologar', 'financeiro_v2.revisar', 'financeiro_v2.configurar', 'financeiro_v2.importar',
    'financeiro_v2.conceder', 'financeiro_v2.documentos']))
  or ((select fv2_em_provisionamento()) and registro_tipo = 'CONCESSAO'));

-- Competência: a ação exigida depende da TRANSIÇÃO (espelho de dominio/fechamento.js).
create function fv2_exigir_acao_da_transicao() returns trigger language plpgsql as $$
declare
  exigida text;
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.estado = old.estado then
    return new;
  end if;
  exigida := case
    when new.estado = 'FECHAMENTO_HOMOLOGADO' then 'financeiro_v2.homologar'
    when tg_op = 'UPDATE' and old.estado = 'FECHAMENTO_HOMOLOGADO' then 'financeiro_v2.revisar'
    else 'financeiro_v2.fechar' end;
  if not fv2_tem_acao(array[exigida]) then
    raise exception 'Financeiro v2: a mudança de estado da competência exige %.', exigida using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_competencia_acao before insert or update on fv2_competencia for each row execute function fv2_exigir_acao_da_transicao();
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
drop table if exists pg_temp.fv2__mapa;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0012_permissao_por_acao.sql', 'cd0f8f8e3e2d05beaef02a7832ffd32765f5aa9ed1067208239c8f3b430f6fa2', 'b932783e71b91683154346505caf2d5ddcc930a7c848e2232a5a3c172c3531a9');

-- ------------------------------------------------------------------------- 0013_acoes_granulares.sql (arquivo 23482b0a571c0f212470443dc1eae001c67dd70b3e4bb4aed96d5b2b489b22cc)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0013: AÇÕES GRANULARES (Execução 08B)
--
-- Só é aplicada no PostgreSQL local isolado. Não pertence a database/migrations/.
--
-- Separa decisões sensíveis que antes dividiam a mesma ação:
--   aprovar (aprovar/rejeitar proposta) ≠ aplicar (aplicar proposta aprovada) ≠ revisar;
--   conceder ≠ revogar; importar ≠ confirmar_importacao; homologar ≠ reabrir (antes: revisar).
--
-- MIGRAÇÃO RESTRITIVA: nenhuma concessão existente recebe as ações novas. Quem tinha `revisar`, `importar` ou
-- `conceder` continua com elas e PERDE, na prática, aprovar/aplicar/confirmar/revogar/reabrir até receber concessão
-- explícita (registrada, justificada e auditada pelo fluxo normal).
--
-- O mapa tabela × operação foi MEDIDO de novo com a suíte instrumentada (docs/financeiro-v2/18, seção 4).
-- =====================================================================================================================

-- 1) Catálogo do banco.
do $$
declare
  r record;
begin
  for r in select conname from pg_constraint where conrelid = 'fv2_concessao'::regclass and pg_get_constraintdef(oid) like '%<@%' loop
    execute format('alter table fv2_concessao drop constraint %I', r.conname);
  end loop;
end $$;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir"]'::jsonb);

-- 2) Conceder ≠ revogar na função guardada (mesma assinatura, dono e privilégios mantidos).
create or replace function fv2_gravar_concessao(p jsonb, p_versao_esperada integer)
returns integer language plpgsql volatile security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
declare
  s fv2_sessao_vigente;
  r fv2_concessao;
  atual fv2_concessao;
  ator jsonb;
  antes jsonb;
  novas jsonb;
  removidas jsonb;
  operacao text;
  n integer;
begin
  select * into s from fv2__sessao_vigente();
  if s.sessao_id is null then
    raise exception 'Financeiro v2: sessão de banco ausente, expirada ou revogada.' using errcode = '42501';
  end if;
  r := jsonb_populate_record(null::fv2_concessao, p);
  if r.organizacao_id is distinct from s.organizacao_id or r.unidade_id is distinct from s.unidade_id then
    raise exception 'Financeiro v2: concessão fora do escopo da sessão.' using errcode = '42501';
  end if;
  perform fv2__trava_concessoes(s.organizacao_id, s.unidade_id, true);
  select * into s from fv2__sessao_vigente();
  if s.sessao_id is null then
    raise exception 'Financeiro v2: sessão de banco revogada durante a operação.' using errcode = '42501';
  end if;
  if r.usuario_id = s.usuario_id then
    raise exception 'Financeiro v2: ninguém concede nem revoga o próprio acesso.' using errcode = 'FV030';
  end if;
  if r.atualizado_por is distinct from s.usuario_id or r.concedido_por is distinct from s.usuario_id then
    raise exception 'Financeiro v2: a autoria da concessão é a do usuário da sessão.' using errcode = 'FV031';
  end if;
  select * into atual from fv2_concessao c where c.organizacao_id = s.organizacao_id and c.unidade_id = s.unidade_id and c.id = r.id;
  if atual.id is not null and atual.usuario_id <> r.usuario_id then
    raise exception 'Financeiro v2: uma concessão não muda de usuário.' using errcode = 'FV033';
  end if;
  antes := case when atual.id is not null and atual.situacao = 'ATIVA' then atual.acoes else '[]'::jsonb end;
  select coalesce(jsonb_agg(a), '[]'::jsonb) into novas from jsonb_array_elements_text(r.acoes) a where not (antes ? a);
  select coalesce(jsonb_agg(a), '[]'::jsonb) into removidas from jsonb_array_elements_text(antes) a
   where r.situacao <> 'ATIVA' or not (r.acoes ? a);

  if s.finalidade = 'PROVISIONAMENTO' then
    if r.usuario_id is distinct from s.alvo or r.situacao <> 'ATIVA' or fv2__acoes_ordenadas(r.acoes) is distinct from s.acoes_autorizadas then
      raise exception 'Financeiro v2: o provisionamento grava exatamente o que foi atestado.' using errcode = 'FV035';
    end if;
    if exists (select 1 from fv2_concessao c where c.organizacao_id = s.organizacao_id and c.unidade_id = s.unidade_id
                and c.situacao = 'ATIVA' and c.acoes ? 'financeiro_v2.conceder') then
      raise exception 'Financeiro v2: a unidade já tem administrador.' using errcode = 'FV035';
    end if;
    operacao := 'PROVISIONAMENTO';
  else
    select c.acoes into ator from fv2_concessao c
     where c.organizacao_id = s.organizacao_id and c.unidade_id = s.unidade_id and c.usuario_id = s.usuario_id and c.situacao = 'ATIVA';
    -- Acrescentar exige `conceder` (e só repassa o que o ator tem); retirar exige `revogar`.
    if jsonb_array_length(novas) > 0 and (ator is null or not (ator ? 'financeiro_v2.conceder')) then
      raise exception 'Financeiro v2: o usuário da sessão não tem concessão para conceder.' using errcode = 'FV032';
    end if;
    if jsonb_array_length(removidas) > 0 and (ator is null or not (ator ? 'financeiro_v2.revogar')) then
      raise exception 'Financeiro v2: o usuário da sessão não tem concessão para revogar.' using errcode = 'FV036';
    end if;
    if jsonb_array_length(novas) = 0 and jsonb_array_length(removidas) = 0 and (ator is null or not (ator ?| array['financeiro_v2.conceder', 'financeiro_v2.revogar'])) then
      raise exception 'Financeiro v2: o usuário da sessão não administra concessões.' using errcode = 'FV032';
    end if;
    if exists (select 1 from jsonb_array_elements_text(novas) a where not (ator ? a)) then
      raise exception 'Financeiro v2: não é possível conceder uma ação que você não possui.' using errcode = 'FV034';
    end if;
    operacao := case when jsonb_array_length(novas) > 0 and jsonb_array_length(removidas) > 0 then 'CONCESSAO_E_REVOGACAO'
                     when jsonb_array_length(novas) > 0 then 'CONCESSAO' else 'REVOGACAO' end;
  end if;

  if p_versao_esperada is null then
    insert into fv2_concessao (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por,
                               chave_idempotencia, impressao, extras, usuario_id, acoes, situacao, concedido_por, justificativa)
    values (r.id, r.organizacao_id, r.unidade_id, r.versao, r.criado_em, r.criado_por, r.atualizado_em, r.atualizado_por,
            r.chave_idempotencia, r.impressao, coalesce(r.extras, '{}'::jsonb), r.usuario_id, r.acoes, r.situacao, r.concedido_por, r.justificativa);
    n := 1;
  else
    update fv2_concessao c
       set versao = r.versao, atualizado_em = r.atualizado_em, atualizado_por = r.atualizado_por, impressao = r.impressao,
           extras = coalesce(r.extras, '{}'::jsonb), acoes = r.acoes, situacao = r.situacao, concedido_por = r.concedido_por,
           justificativa = r.justificativa
     where c.organizacao_id = s.organizacao_id and c.unidade_id = s.unidade_id and c.id = r.id and c.versao = p_versao_esperada;
    get diagnostics n = row_count;
    if n = 0 then
      return 0;
    end if;
  end if;

  insert into fv2_auditoria_concessao (organizacao_id, unidade_id, concessao_id, usuario_alvo, ator, sessao_id, finalidade, operacao,
                                       acoes_antes, acoes_depois, situacao_depois, justificativa)
  values (s.organizacao_id, s.unidade_id, r.id, r.usuario_id, s.usuario_id, s.sessao_id, s.finalidade, operacao,
          coalesce(atual.acoes, '[]'::jsonb), r.acoes, r.situacao, r.justificativa);
  update fv2_sessao_banco b set revogada_em = clock_timestamp(), motivo_revogacao = 'concessão alterada'
   where b.usuario_id = r.usuario_id and b.organizacao_id = s.organizacao_id and b.unidade_id = s.unidade_id and b.revogada_em is null;
  if s.finalidade = 'PROVISIONAMENTO' then
    update fv2_provisionamento_inicial pi set concluido_em = clock_timestamp() where pi.sessao_id = s.sessao_id and pi.concluido_em is null;
  end if;
  return n;
end $$;

-- 3) Políticas por ação com o mapa novo (medido).
create temporary table fv2__mapa (tabela text, operacao text, acoes text[]) on commit drop;
insert into fv2__mapa values
  ('fv2_ajuste', 'I', '{aplicar,cancelar,corrigir,registrar}'),
  ('fv2_atribuicao_pendencia', 'I', '{revisar}'), ('fv2_atribuicao_pendencia', 'U', '{revisar}'),
  ('fv2_canal_processador', 'I', '{configurar}'), ('fv2_canal_processador', 'U', '{configurar}'),
  ('fv2_categoria', 'I', '{configurar,registrar}'), ('fv2_categoria', 'U', '{configurar}'),
  ('fv2_competencia', 'I', '{fechar}'), ('fv2_competencia', 'U', '{fechar,homologar,reabrir}'),
  ('fv2_configuracao_unidade', 'I', '{configurar}'), ('fv2_configuracao_unidade', 'U', '{configurar}'),
  ('fv2_conta', 'I', '{configurar}'), ('fv2_conta', 'U', '{configurar}'),
  ('fv2_contraparte', 'I', '{aplicar,registrar}'), ('fv2_contraparte', 'U', '{registrar,configurar}'),
  ('fv2_correspondencia', 'I', '{conciliar}'), ('fv2_correspondencia', 'U', '{conciliar}'),
  ('fv2_divergencia_fonte', 'I', '{registrar,importar}'), ('fv2_divergencia_fonte', 'U', '{revisar}'),
  ('fv2_documento', 'I', '{importar,registrar}'), ('fv2_documento', 'U', '{confirmar_importacao,registrar}'),
  ('fv2_estorno', 'I', '{cancelar}'),
  ('fv2_importacao', 'I', '{importar}'), ('fv2_importacao', 'U', '{confirmar_importacao,importar}'),
  ('fv2_lancamento', 'I', '{aplicar,cancelar,corrigir,registrar,revisar}'), ('fv2_lancamento', 'U', '{cancelar,corrigir,revisar}'),
  ('fv2_liquidacao', 'I', '{registrar,aplicar}'), ('fv2_liquidacao', 'U', '{cancelar}'),
  ('fv2_movimentacao', 'I', '{aplicar,cancelar,registrar,revisar}'), ('fv2_movimentacao', 'U', '{cancelar,conciliar,registrar}'),
  ('fv2_obrigacao', 'I', '{aplicar,registrar}'), ('fv2_obrigacao', 'U', '{cancelar,corrigir,registrar}'),
  ('fv2_pagamento_venda', 'I', '{aplicar,registrar,revisar}'), ('fv2_pagamento_venda', 'U', '{cancelar}'),
  ('fv2_proposta', 'I', '{registrar,importar}'), ('fv2_proposta', 'U', '{aplicar,aprovar,cancelar,registrar,revisar}'),
  ('fv2_recebivel', 'I', '{aplicar,registrar}'), ('fv2_recebivel', 'U', '{aplicar,cancelar,corrigir,registrar}'),
  ('fv2_registro_fonte', 'I', '{confirmar_importacao}'), ('fv2_registro_fonte', 'U', '{confirmar_importacao}'),
  ('fv2_saldo_conta', 'I', '{registrar}'),
  ('fv2_sessao_caixa', 'I', '{registrar}'), ('fv2_sessao_caixa', 'U', '{registrar}'),
  ('fv2_transferencia', 'I', '{registrar}'), ('fv2_transferencia', 'U', '{cancelar}'),
  ('fv2_venda', 'I', '{aplicar,registrar,revisar}'), ('fv2_venda', 'U', '{aplicar,cancelar,registrar}'),
  ('fv2_versao_fechamento', 'I', '{fechar,homologar,reabrir}'),
  ('fv2_vinculo_documental', 'I', '{registrar,importar}');

do $$
declare
  t record;
  acoes text;
  inc text;
  alt text;
  escritas text := (select string_agg(format('%L', 'financeiro_v2.' || a), ', ') from unnest(array['registrar', 'corrigir', 'cancelar', 'conciliar',
    'fechar', 'homologar', 'revisar', 'configurar', 'importar', 'conceder', 'documentos', 'aprovar', 'aplicar', 'revogar', 'confirmar_importacao', 'reabrir']) a);
begin
  for t in select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
            where ns.nspname = current_schema() and c.relkind = 'r' and c.relrowsecurity and c.relname like 'fv2\_%'
              and c.relname not in ('fv2_concessao', 'fv2_escopo', 'fv2_historico') loop
    select string_agg(format('%L', 'financeiro_v2.' || a), ', ') into acoes from fv2__mapa m, unnest(m.acoes) a where m.tabela = t.relname and m.operacao = 'I';
    inc := case when acoes is null then 'false' else format('(select fv2_tem_acao(array[%s]))', acoes) end;
    select string_agg(format('%L', 'financeiro_v2.' || a), ', ') into acoes from fv2__mapa m, unnest(m.acoes) a where m.tabela = t.relname and m.operacao = 'U';
    alt := case when acoes is null then 'false' else format('(select fv2_tem_acao(array[%s]))', acoes) end;
    execute format('alter policy %I on %I with check (%s)', t.relname || '_incluir', t.relname, inc);
    -- USING (alcançar/reservar a linha, inclusive SELECT ... FOR UPDATE de registros REFERENCIADOS pela operação, como a
    -- conta do caixa ao aplicar uma venda): qualquer ação de escrita. A ALTERAÇÃO em si é decidida no WITH CHECK, só
    -- com as ações da tabela — e quem não as tem recebe ERRO explícito, nunca um UPDATE "que não achou nada".
    execute format('alter policy %I on %I using ((select fv2_tem_acao(array[%s]))) with check (%s)', t.relname || '_alterar', t.relname, escritas, alt);
  end loop;
end $$;

alter policy fv2_historico_incluir on fv2_historico with check (
  (select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar',
    'financeiro_v2.fechar', 'financeiro_v2.homologar', 'financeiro_v2.revisar', 'financeiro_v2.configurar', 'financeiro_v2.importar',
    'financeiro_v2.conceder', 'financeiro_v2.documentos', 'financeiro_v2.aprovar', 'financeiro_v2.aplicar', 'financeiro_v2.revogar',
    'financeiro_v2.confirmar_importacao', 'financeiro_v2.reabrir']))
  or ((select fv2_em_provisionamento()) and registro_tipo = 'CONCESSAO'));

-- 4) Reabrir competência homologada exige `reabrir` (espelho de dominio/fechamento.js).
create or replace function fv2_exigir_acao_da_transicao() returns trigger language plpgsql as $$
declare
  exigida text;
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.estado = old.estado then
    return new;
  end if;
  exigida := case
    when new.estado = 'FECHAMENTO_HOMOLOGADO' then 'financeiro_v2.homologar'
    when tg_op = 'UPDATE' and old.estado = 'FECHAMENTO_HOMOLOGADO' then 'financeiro_v2.reabrir'
    else 'financeiro_v2.fechar' end;
  if not fv2_tem_acao(array[exigida]) then
    raise exception 'Financeiro v2: a mudança de estado da competência exige %.', exigida using errcode = '42501';
  end if;
  return new;
end $$;

-- 5) Proposta: a decisão depende da TRANSIÇÃO de estado (a tabela também é alterada por outras ações legítimas,
--    então o mapa por tabela não basta): aprovar/rejeitar exige `aprovar`; aplicar exige `aplicar`.
create function fv2_exigir_acao_da_proposta() returns trigger language plpgsql as $$
declare
  exigida text;
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.estado = old.estado then
    return new;
  end if;
  exigida := case new.estado
    when 'APROVADA' then 'financeiro_v2.aprovar'
    when 'REJEITADA' then 'financeiro_v2.aprovar'
    when 'APLICADA' then 'financeiro_v2.aplicar'
    else null end;
  if exigida is not null and not fv2_tem_acao(array[exigida]) then
    raise exception 'Financeiro v2: esta decisão sobre a proposta exige %.', exigida using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_proposta_acao before insert or update on fv2_proposta for each row execute function fv2_exigir_acao_da_proposta();
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
drop table if exists pg_temp.fv2__mapa;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0013_acoes_granulares.sql', '23482b0a571c0f212470443dc1eae001c67dd70b3e4bb4aed96d5b2b489b22cc', '5a9ade7290a208b383059e7c77c3fbaeafdd20984a50162755027e4c36b3cbe6');

-- ------------------------------------------------------------------------- 0014_reclassificacao.sql (arquivo 598cd8c434a5987747a58f64010a84642747b22a42ff54453f666924f5323e68)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0014: RECLASSIFICAÇÃO COM PERMISSÃO PRÓPRIA (Execução 08C)
--
-- Só é aplicada no PostgreSQL local isolado. Não pertence a database/migrations/.
--
-- Mudar a categoria de um lançamento passa a exigir `financeiro_v2.reclassificar` — também NO BANCO, linha a linha:
--   * a ação nova entra no catálogo; NENHUMA concessão existente a recebe (migração restritiva);
--   * gatilho em fv2_lancamento: mudança de categoria/classificação/natureza exige `reclassificar` e não pode mudar, na
--     MESMA gravação, valor, competência, situação, origem, canal, data, descrição ou fonte (a identidade do fato econômico
--     é preservada); receita nunca vira não-receita (nem o contrário); a natureza só muda despesa ⇄ patrimonial em conta a
--     pagar; a categoria de destino precisa existir no escopo, aceitar lançamento, estar ativa e não ser provisória;
--   * mudanças que NÃO tocam a categoria continuam exigindo cancelar/corrigir/revisar — `reclassificar` sozinho não
--     altera valor nem cancela nada;
--   * a evidência vinculada na reclassificação (vínculo documental) e o histórico aceitam a ação nova;
--   * para ALCANÇAR linhas referenciadas (SELECT ... FOR UPDATE da competência, do documento), o USING de alteração de
--     todas as tabelas passa a incluir a ação nova — a ALTERAÇÃO em si continua decidida pelo WITH CHECK de cada tabela.
-- =====================================================================================================================

-- 1) Catálogo do banco.
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir",
  "financeiro_v2.reclassificar"]'::jsonb);

-- 2) USING de alteração (alcançar a linha) com a ação nova, em todas as tabelas com política por ação.
do $$
declare
  t record;
  escritas text := (select string_agg(format('%L', 'financeiro_v2.' || a), ', ') from unnest(array['registrar', 'corrigir', 'cancelar', 'conciliar',
    'fechar', 'homologar', 'revisar', 'configurar', 'importar', 'conceder', 'documentos', 'aprovar', 'aplicar', 'revogar', 'confirmar_importacao', 'reabrir',
    'reclassificar']) a);
begin
  for t in select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
            where ns.nspname = current_schema() and c.relkind = 'r' and c.relrowsecurity and c.relname like 'fv2\_%'
              and c.relname not in ('fv2_concessao', 'fv2_escopo', 'fv2_historico') loop
    execute format('alter policy %I on %I using ((select fv2_tem_acao(array[%s])))', t.relname || '_alterar', t.relname, escritas);
  end loop;
end $$;

-- 3) Lançamento: a ação nova pode ALTERAR a linha (o gatilho decide O QUE pode mudar).
alter policy fv2_lancamento_alterar on fv2_lancamento with check (
  (select fv2_tem_acao(array['financeiro_v2.cancelar', 'financeiro_v2.corrigir', 'financeiro_v2.revisar', 'financeiro_v2.reclassificar'])));

-- 4) Evidência da reclassificação (vínculo documento → lançamento) e histórico.
alter policy fv2_vinculo_documental_incluir on fv2_vinculo_documental with check (
  (select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.importar', 'financeiro_v2.reclassificar'])));
alter policy fv2_historico_incluir on fv2_historico with check (
  (select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar',
    'financeiro_v2.fechar', 'financeiro_v2.homologar', 'financeiro_v2.revisar', 'financeiro_v2.configurar', 'financeiro_v2.importar',
    'financeiro_v2.conceder', 'financeiro_v2.documentos', 'financeiro_v2.aprovar', 'financeiro_v2.aplicar', 'financeiro_v2.revogar',
    'financeiro_v2.confirmar_importacao', 'financeiro_v2.reabrir', 'financeiro_v2.reclassificar']))
  or ((select fv2_em_provisionamento()) and registro_tipo = 'CONCESSAO'));

-- 5) Gatilho: o que a reclassificação pode (e não pode) mudar, conferido no banco.
create function fv2_exigir_acao_do_lancamento() returns trigger language plpgsql as $$
declare
  cat record;
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    return new;
  end if;
  if (new.categoria_id, new.categoria_codigo, new.classificacao, new.natureza)
       is not distinct from (old.categoria_id, old.categoria_codigo, old.classificacao, old.natureza) then
    -- Sem mudança de categoria: as ações de sempre. `reclassificar` sozinho não muda valor nem cancela.
    if not fv2_tem_acao(array['financeiro_v2.cancelar', 'financeiro_v2.corrigir', 'financeiro_v2.revisar']) then
      raise exception 'Financeiro v2: alterar o lançamento exige cancelar, corrigir ou revisar.' using errcode = '42501';
    end if;
    return new;
  end if;
  if not fv2_tem_acao(array['financeiro_v2.reclassificar']) then
    raise exception 'Financeiro v2: mudar a categoria de um lançamento exige reclassificar.' using errcode = '42501';
  end if;
  if old.situacao <> 'ATIVO' then
    raise exception 'Financeiro v2: lançamento cancelado não é reclassificado.' using errcode = 'FV037';
  end if;
  if (new.valor_centavos, new.moeda, new.competencia, new.situacao, new.data_operacao, new.descricao, new.origem, new.canal,
      new.retido_no_repasse, new.fonte_sistema, new.fonte_id_externo)
       is distinct from (old.valor_centavos, old.moeda, old.competencia, old.situacao, old.data_operacao, old.descricao, old.origem, old.canal,
      old.retido_no_repasse, old.fonte_sistema, old.fonte_id_externo) then
    raise exception 'Financeiro v2: a reclassificação muda só a categoria — a identidade do fato econômico é preservada.' using errcode = 'FV037';
  end if;
  if not (new.natureza = old.natureza
          or (old.origem->>'tipo' = 'OBRIGACAO' and old.natureza in ('DESPESA', 'PATRIMONIAL') and new.natureza in ('DESPESA', 'PATRIMONIAL'))) then
    raise exception 'Financeiro v2: natureza econômica incompatível na reclassificação.' using errcode = 'FV038';
  end if;
  if new.categoria_codigo in ('DESCONTOS_A_CLASSIFICAR', 'DESPESAS_A_CLASSIFICAR') then
    raise exception 'Financeiro v2: categoria provisória não é destino de reclassificação.' using errcode = 'FV038';
  end if;
  select c.codigo, c.natureza, c.classificacao, c.aceita_lancamento, c.ativa into cat
    from fv2_categoria c where c.id = new.categoria_id and c.organizacao_id = new.organizacao_id and c.unidade_id = new.unidade_id;
  if cat.codigo is null or cat.codigo <> new.categoria_codigo or cat.natureza <> new.natureza or cat.classificacao <> new.classificacao
     or not cat.aceita_lancamento or not cat.ativa then
    raise exception 'Financeiro v2: a categoria de destino não confere com o plano de contas da unidade.' using errcode = 'FV038';
  end if;
  return new;
end $$;
create trigger fv2_lancamento_acao before update on fv2_lancamento for each row execute function fv2_exigir_acao_do_lancamento();
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0014_reclassificacao.sql', '598cd8c434a5987747a58f64010a84642747b22a42ff54453f666924f5323e68', '598cd8c434a5987747a58f64010a84642747b22a42ff54453f666924f5323e68');

-- ------------------------------------------------------------------------- 0015_indices_carga_por_competencia.sql (arquivo 314227f5309c2bf0917d27d39b4dac8b31a1aa249220fdfee041f0721db1976a)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0015: ÍNDICES DA CARGA DIRIGIDA POR COMPETÊNCIA (Execução 08C)
--
-- Só é aplicada no PostgreSQL local isolado. Não pertence a database/migrations/.
--
-- Cada índice corresponde a uma consulta de aplicacao/cargaDaCompetencia.js (Vendas, Recebimentos, Central, Pendências,
-- Fechamento): sementes por competência/período e o fecho dos vínculos por chave estrangeira. Sem mudança de dados,
-- regras ou permissões. Todos começam por organização + unidade (o escopo de toda consulta).
-- =====================================================================================================================

-- Sementes por competência / período.
create index if not exists fv2_venda_competencia on fv2_venda (organizacao_id, unidade_id, competencia);
create index if not exists fv2_recebivel_competencia on fv2_recebivel (organizacao_id, unidade_id, competencia);
create index if not exists fv2_obrigacao_competencia on fv2_obrigacao (organizacao_id, unidade_id, competencia);
create index if not exists fv2_ajuste_competencia on fv2_ajuste (organizacao_id, unidade_id, competencia);
create index if not exists fv2_liquidacao_data on fv2_liquidacao (organizacao_id, unidade_id, data_efetiva);
create index if not exists fv2_estorno_data on fv2_estorno (organizacao_id, unidade_id, data_efetiva);
create index if not exists fv2_registro_fonte_competencia on fv2_registro_fonte (organizacao_id, unidade_id, competencia, tipo_registro);

-- Fecho dos vínculos (ida e volta).
create index if not exists fv2_pagamento_venda_venda on fv2_pagamento_venda (organizacao_id, unidade_id, venda_id);
create index if not exists fv2_recebivel_venda on fv2_recebivel (organizacao_id, unidade_id, venda_id);
create index if not exists fv2_obrigacao_grupo on fv2_obrigacao (organizacao_id, unidade_id, grupo_id);
create index if not exists fv2_movimentacao_pagamento on fv2_movimentacao (organizacao_id, unidade_id, pagamento_id);
create index if not exists fv2_estorno_alvo on fv2_estorno (organizacao_id, unidade_id, alvo_id);
create index if not exists fv2_vinculo_documental_registro on fv2_vinculo_documental (organizacao_id, unidade_id, registro_id);
-- Lançamento → origem (venda, recebível, ajuste, obrigação, proposta, estorno): subcampos do JSON `origem`.
create index if not exists fv2_lancamento_origem_id on fv2_lancamento (organizacao_id, unidade_id, (origem->>'id'));
create index if not exists fv2_lancamento_origem_venda on fv2_lancamento (organizacao_id, unidade_id, (origem->>'vendaId'));
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0015_indices_carga_por_competencia.sql', '314227f5309c2bf0917d27d39b4dac8b31a1aa249220fdfee041f0721db1976a', '314227f5309c2bf0917d27d39b4dac8b31a1aa249220fdfee041f0721db1976a');

-- ------------------------------------------------------------------------- 0016_envio_de_evidencias.sql (arquivo 161206c52160277c846fe32a8de0908bf177357561945df19ff73b3ae766a918)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0016: ENVIO DE EVIDÊNCIAS PELA INTERFACE (Execução 08D)
--
-- Só é aplicada no PostgreSQL local isolado. Não pertence a database/migrations/.
--
-- Ação nova `financeiro_v2.enviar_documento`: grava a FICHA do documento enviado e o VÍNCULO com o registro da
-- pendência. Não abre arquivo (`documentos`) e não decide nada financeiro (reclassificar, conciliar, homologar).
-- MIGRAÇÃO RESTRITIVA: nenhuma concessão existente a recebe.
-- =====================================================================================================================

-- 1) Catálogo do banco.
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir",
  "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento"]'::jsonb);

-- 2) USING de alteração (alcançar linhas referenciadas, ex.: SELECT ... FOR UPDATE do registro da pendência).
do $$
declare
  t record;
  escritas text := (select string_agg(format('%L', 'financeiro_v2.' || a), ', ') from unnest(array['registrar', 'corrigir', 'cancelar', 'conciliar',
    'fechar', 'homologar', 'revisar', 'configurar', 'importar', 'conceder', 'documentos', 'aprovar', 'aplicar', 'revogar', 'confirmar_importacao', 'reabrir',
    'reclassificar', 'enviar_documento']) a);
begin
  for t in select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
            where ns.nspname = current_schema() and c.relkind = 'r' and c.relrowsecurity and c.relname like 'fv2\_%'
              and c.relname not in ('fv2_concessao', 'fv2_escopo', 'fv2_historico') loop
    execute format('alter policy %I on %I using ((select fv2_tem_acao(array[%s])))', t.relname || '_alterar', t.relname, escritas);
  end loop;
end $$;

-- 3) Ficha do documento e vínculo: a ação nova só INCLUI (não altera documento existente nem vínculo).
alter policy fv2_documento_incluir on fv2_documento with check (
  (select fv2_tem_acao(array['financeiro_v2.importar', 'financeiro_v2.registrar', 'financeiro_v2.enviar_documento'])));
alter policy fv2_vinculo_documental_incluir on fv2_vinculo_documental with check (
  (select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.importar', 'financeiro_v2.reclassificar', 'financeiro_v2.enviar_documento'])));
alter policy fv2_historico_incluir on fv2_historico with check (
  (select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar',
    'financeiro_v2.fechar', 'financeiro_v2.homologar', 'financeiro_v2.revisar', 'financeiro_v2.configurar', 'financeiro_v2.importar',
    'financeiro_v2.conceder', 'financeiro_v2.documentos', 'financeiro_v2.aprovar', 'financeiro_v2.aplicar', 'financeiro_v2.revogar',
    'financeiro_v2.confirmar_importacao', 'financeiro_v2.reabrir', 'financeiro_v2.reclassificar', 'financeiro_v2.enviar_documento']))
  or ((select fv2_em_provisionamento()) and registro_tipo = 'CONCESSAO'));
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0016_envio_de_evidencias.sql', '161206c52160277c846fe32a8de0908bf177357561945df19ff73b3ae766a918', '161206c52160277c846fe32a8de0908bf177357561945df19ff73b3ae766a918');

-- ------------------------------------------------------------------------- 0017_indices_seletivos.sql (arquivo 01666ecf61be707c262bde5867dce5380595d9a81a4226f5778e862d4ecf1926)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0017: ÍNDICES COM A COLUNA SELETIVA PRIMEIRO (Execução 08D)
--
-- Só é aplicada no PostgreSQL local isolado. Não pertence a database/migrations/.
--
-- Achado da 08C: sem estatísticas (banco recém-carregado, antes do autovacuum/ANALYZE), o planejador usava só o prefixo
-- organização+unidade dos índices da 0015 e filtrava a unidade inteira ("Rows Removed by Filter"). Organização e unidade
-- quase não distinguem linhas (uma empresa tem poucas unidades); a competência, a data e as chaves do fecho distinguem.
-- Com a coluna seletiva na FRENTE, a condição `= any(...)`/faixa vira condição do índice com ou sem estatísticas.
-- Organização e unidade continuam no índice (e no RLS); nenhuma regra de segurança muda. ANALYZE continua recomendado.
-- =====================================================================================================================

drop index if exists fv2_venda_competencia;
drop index if exists fv2_recebivel_competencia;
drop index if exists fv2_obrigacao_competencia;
drop index if exists fv2_ajuste_competencia;
drop index if exists fv2_liquidacao_data;
drop index if exists fv2_estorno_data;
drop index if exists fv2_registro_fonte_competencia;
drop index if exists fv2_pagamento_venda_venda;
drop index if exists fv2_recebivel_venda;
drop index if exists fv2_obrigacao_grupo;
drop index if exists fv2_movimentacao_pagamento;
drop index if exists fv2_estorno_alvo;
drop index if exists fv2_vinculo_documental_registro;
drop index if exists fv2_lancamento_origem_id;
drop index if exists fv2_lancamento_origem_venda;

-- Sementes por competência / período.
create index fv2_venda_competencia_sel on fv2_venda (competencia, organizacao_id, unidade_id);
create index fv2_lancamento_competencia_sel on fv2_lancamento (competencia, organizacao_id, unidade_id);
create index fv2_recebivel_competencia_sel on fv2_recebivel (competencia, organizacao_id, unidade_id);
create index fv2_obrigacao_competencia_sel on fv2_obrigacao (competencia, organizacao_id, unidade_id);
create index fv2_ajuste_competencia_sel on fv2_ajuste (competencia, organizacao_id, unidade_id);
create index fv2_proposta_competencia_sel on fv2_proposta (competencia, organizacao_id, unidade_id);
create index fv2_movimentacao_data_sel on fv2_movimentacao (data_efetiva, organizacao_id, unidade_id);
create index fv2_liquidacao_data_sel on fv2_liquidacao (data_efetiva, organizacao_id, unidade_id);
create index fv2_estorno_data_sel on fv2_estorno (data_efetiva, organizacao_id, unidade_id);
create index fv2_registro_fonte_competencia_sel on fv2_registro_fonte (competencia, tipo_registro, organizacao_id, unidade_id);
create index fv2_correspondencia_competencia_sel on fv2_correspondencia ((extras->>'competencia'), organizacao_id, unidade_id);
create index fv2_correspondencia_conciliacao_sel on fv2_correspondencia ((extras->>'competenciaDaConciliacao'), organizacao_id, unidade_id);

-- Fecho dos vínculos.
create index fv2_pagamento_venda_venda_sel on fv2_pagamento_venda (venda_id, organizacao_id, unidade_id);
create index fv2_recebivel_venda_sel on fv2_recebivel (venda_id, organizacao_id, unidade_id);
create index fv2_obrigacao_grupo_sel on fv2_obrigacao (grupo_id, organizacao_id, unidade_id);
create index fv2_movimentacao_pagamento_sel on fv2_movimentacao (pagamento_id, organizacao_id, unidade_id);
create index fv2_liquidacao_alvo_sel on fv2_liquidacao (alvo_id, organizacao_id, unidade_id);
create index fv2_liquidacao_movimentacao_sel on fv2_liquidacao (movimentacao_id, organizacao_id, unidade_id);
create index fv2_ajuste_alvo_sel on fv2_ajuste (alvo_id, organizacao_id, unidade_id);
create index fv2_estorno_alvo_sel on fv2_estorno (alvo_id, organizacao_id, unidade_id);
create index fv2_vinculo_documental_registro_sel on fv2_vinculo_documental (registro_id, organizacao_id, unidade_id);
create index fv2_lancamento_origem_id_sel on fv2_lancamento ((origem->>'id'), organizacao_id, unidade_id);
create index fv2_lancamento_origem_venda_sel on fv2_lancamento ((origem->>'vendaId'), organizacao_id, unidade_id);
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0017_indices_seletivos.sql', '01666ecf61be707c262bde5867dce5380595d9a81a4226f5778e862d4ecf1926', '01666ecf61be707c262bde5867dce5380595d9a81a4226f5778e862d4ecf1926');

-- ------------------------------------------------------------------------- 0018_fechamento_ressalvas_baixa_extrato.sql (arquivo 7a312af6949f039bb6ec7a21e8488f06eaf7dad7756a618e995334448daeaeec)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0018: HOMOLOGAÇÃO COM RESSALVAS (F-1) e BAIXA POR SAÍDA DO EXTRATO (F-2) — Execução 08E
--
-- Só é aplicada no PostgreSQL local isolado. Não pertence a database/migrations/.
--
-- F-1 (espelho de dominio/ressalvas.js + aplicacao/competencias.js), linha a linha em fv2_competencia:
--   * não se cria competência já homologada;
--   * homologar não reescreve as pendências documentadas;
--   * do PRELIMINAR só se homologa sem ressalvas; do COM_PENDENCIAS, cada ressalva precisa estar documentada (com
--     decisão e "o que falta"/evidência) e ter natureza admissível (efeito no resultado SEM_EFEITO ou CONHECIDO com valor);
--   * verificações OBJETIVAS que o banco faz sozinho, sem confiar na aplicação: nenhum lançamento ativo da competência
--     em categoria provisória ("a classificar") e nenhuma saída do período sem vínculo — esses distorcem o resultado de
--     modo ainda não esclarecido e nunca viram ressalva.
--
-- F-2: ação nova `financeiro_v2.vincular_pagamento` (MIGRAÇÃO RESTRITIVA: nenhuma concessão existente a recebe).
--   * quem só vincula NÃO insere movimentação (a política de inclusão de fv2_movimentacao não a lista): vincular nunca
--     cria saída nova; também não insere lançamento (nunca cria despesa);
--   * a liquidação gravada só por `vincular_pagamento` precisa apontar para uma SAÍDA válida, que já existia ANTES desta
--     transação, e para uma conta a pagar; e precisa carregar a evidência (documento) ou uma conciliação confirmada;
--   * na saída, só pode AUMENTAR o valor alocado; na conta, só mudar a posição (liquidado, saldo e situação, que só pode
--     ficar parcial ou quitada).
-- =====================================================================================================================

-- 1) Catálogo do banco.
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir",
  "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento"]'::jsonb);

-- 2) USING de alteração (alcançar linhas referenciadas, ex.: SELECT ... FOR UPDATE da saída e das contas).
do $$
declare
  t record;
  escritas text := (select string_agg(format('%L', 'financeiro_v2.' || a), ', ') from unnest(array['registrar', 'corrigir', 'cancelar', 'conciliar',
    'fechar', 'homologar', 'revisar', 'configurar', 'importar', 'conceder', 'documentos', 'aprovar', 'aplicar', 'revogar', 'confirmar_importacao', 'reabrir',
    'reclassificar', 'enviar_documento', 'vincular_pagamento']) a);
begin
  for t in select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
            where ns.nspname = current_schema() and c.relkind = 'r' and c.relrowsecurity and c.relname like 'fv2\_%'
              and c.relname not in ('fv2_concessao', 'fv2_escopo', 'fv2_historico') loop
    execute format('alter policy %I on %I using ((select fv2_tem_acao(array[%s])))', t.relname || '_alterar', t.relname, escritas);
  end loop;
end $$;

-- 3) O que `vincular_pagamento` pode gravar: liquidação (inclusão), posição da conta e alocado da saída (alteração),
--    vínculo documental da evidência e histórico. NUNCA movimentação nova, lançamento ou obrigação nova.
alter policy fv2_liquidacao_incluir on fv2_liquidacao with check (
  (select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.aplicar', 'financeiro_v2.vincular_pagamento'])));
alter policy fv2_movimentacao_alterar on fv2_movimentacao with check (
  (select fv2_tem_acao(array['financeiro_v2.cancelar', 'financeiro_v2.conciliar', 'financeiro_v2.registrar', 'financeiro_v2.vincular_pagamento'])));
alter policy fv2_obrigacao_alterar on fv2_obrigacao with check (
  (select fv2_tem_acao(array['financeiro_v2.cancelar', 'financeiro_v2.corrigir', 'financeiro_v2.registrar', 'financeiro_v2.vincular_pagamento'])));
alter policy fv2_vinculo_documental_incluir on fv2_vinculo_documental with check (
  (select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.importar', 'financeiro_v2.reclassificar', 'financeiro_v2.enviar_documento', 'financeiro_v2.vincular_pagamento'])));
alter policy fv2_historico_incluir on fv2_historico with check (
  (select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar',
    'financeiro_v2.fechar', 'financeiro_v2.homologar', 'financeiro_v2.revisar', 'financeiro_v2.configurar', 'financeiro_v2.importar',
    'financeiro_v2.conceder', 'financeiro_v2.documentos', 'financeiro_v2.aprovar', 'financeiro_v2.aplicar', 'financeiro_v2.revogar',
    'financeiro_v2.confirmar_importacao', 'financeiro_v2.reabrir', 'financeiro_v2.reclassificar', 'financeiro_v2.enviar_documento',
    'financeiro_v2.vincular_pagamento']))
  or ((select fv2_em_provisionamento()) and registro_tipo = 'CONCESSAO'));

-- 4) Barreiras linha a linha para quem grava SÓ com `vincular_pagamento`.
create or replace function fv2_so_vincula() returns boolean language sql stable as $$
  select not (select rolsuper from pg_roles where rolname = current_user)
     and not fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.aplicar', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar', 'financeiro_v2.corrigir'])
$$;

create or replace function fv2_vinculo_extrato_liquidacao() returns trigger language plpgsql as $$
declare
  m record;
  xid_atual text := (pg_current_xact_id()::text::bigint % 4294967296)::text;
begin
  if not fv2_so_vincula() then
    return new;
  end if;
  if new.alvo_tipo <> 'OBRIGACAO' then
    raise exception 'Financeiro v2: vincular pagamento do extrato só baixa conta a pagar.' using errcode = '42501';
  end if;
  select x.*, x.xmin::text as criada_em_xid into m from fv2_movimentacao x
   where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.movimentacao_id;
  if not found or m.sentido <> 'SAIDA' or m.situacao <> 'VALIDA' or m.transferencia_id is not null or m.pagamento_id is not null
     or m.estorno_id is not null or m.natureza in ('DEVOLUCAO', 'TRANSFERENCIA_INTERNA') then
    raise exception 'Financeiro v2: a baixa por extrato exige uma saída válida, que não seja transferência nem devolução.' using errcode = '42501';
  end if;
  if m.criada_em_xid = xid_atual then
    raise exception 'Financeiro v2: vincular pagamento do extrato usa saída JÁ registrada — não cria saída nova.' using errcode = '42501';
  end if;
  if coalesce(new.extras->>'origemDoVinculo', '') <> 'EXTRATO' then
    raise exception 'Financeiro v2: liquidação gravada por vincular_pagamento precisa ser marcada como vínculo de extrato.' using errcode = '42501';
  end if;
  if new.extras->>'documentoId' is null and not exists (
    select 1 from fv2_correspondencia c
     where c.organizacao_id = new.organizacao_id and c.unidade_id = new.unidade_id and c.situacao = 'CONFIRMADA'
       and cardinality(c.evidencia_documento_ids) > 0
       and (c.lado_a || c.lado_b) @> jsonb_build_array(jsonb_build_object('tipo', 'MOVIMENTACAO', 'id', new.movimentacao_id::text))
       and (c.lado_a || c.lado_b) @> jsonb_build_array(jsonb_build_object('tipo', 'OBRIGACAO', 'id', new.alvo_id::text))) then
    raise exception 'Financeiro v2: a baixa por extrato exige documento que comprove o pagamento ou conciliação confirmada com evidência.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_liquidacao_vinculo_extrato before insert on fv2_liquidacao for each row execute function fv2_vinculo_extrato_liquidacao();

create or replace function fv2_vinculo_extrato_posicao() returns trigger language plpgsql as $$
declare
  livres text[] := array['versao', 'atualizado_em', 'atualizado_por', 'extras'] || tg_argv[0]::text[];
begin
  if not fv2_so_vincula() then
    return new;
  end if;
  if (to_jsonb(old) - livres) is distinct from (to_jsonb(new) - livres) then
    raise exception 'Financeiro v2: vincular pagamento do extrato só muda a posição (alocado/pago/saldo), nada mais.' using errcode = '42501';
  end if;
  if (to_jsonb(new)->>tg_argv[1])::bigint < (to_jsonb(old)->>tg_argv[1])::bigint then
    raise exception 'Financeiro v2: vincular pagamento do extrato não desfaz baixas (use o estorno, com a permissão própria).' using errcode = '42501';
  end if;
  -- Na conta, a situação resultante de uma baixa só pode ser parcial ou quitada (nunca cancelar ou reabrir).
  if tg_table_name = 'fv2_obrigacao' and (to_jsonb(new)->>'situacao') not in ('PARCIAL', 'QUITADA') then
    raise exception 'Financeiro v2: vincular pagamento do extrato só deixa a conta parcial ou quitada.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_movimentacao_vinculo_extrato before update on fv2_movimentacao for each row
  execute function fv2_vinculo_extrato_posicao('{alocado_centavos}', 'alocado_centavos');
create trigger fv2_obrigacao_vinculo_extrato before update on fv2_obrigacao for each row
  execute function fv2_vinculo_extrato_posicao('{liquidado_centavos,saldo_centavos,situacao}', 'liquidado_centavos');

-- 5) F-1 no banco: homologação só com pendências tratadas.
create or replace function fv2_homologacao_com_ressalvas() returns trigger language plpgsql as $$
declare
  h jsonb;
  r jsonb;
  doc jsonb;
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    return new;
  end if;
  if new.estado <> 'FECHAMENTO_HOMOLOGADO' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    raise exception 'Financeiro v2: competência não nasce homologada — passe pelo fechamento preliminar.' using errcode = 'FV040';
  end if;
  if old.estado = 'FECHAMENTO_HOMOLOGADO' then
    return new;
  end if;
  h := new.extras->'homologacao';
  if h is null or jsonb_typeof(h) <> 'object' or jsonb_typeof(h->'ressalvas') <> 'array' or (h->>'de') is distinct from old.estado
     or coalesce((h->>'pendenciasNaoTratadas')::int, -1) <> 0 then
    raise exception 'Financeiro v2: homologação sem a avaliação das pendências (nenhuma pendência pode estar sem tratamento).' using errcode = 'FV040';
  end if;
  if new.pendencias is distinct from old.pendencias then
    raise exception 'Financeiro v2: homologar não reescreve as pendências documentadas.' using errcode = 'FV040';
  end if;
  if old.estado = 'FECHAMENTO_PRELIMINAR' and jsonb_array_length(h->'ressalvas') > 0 then
    raise exception 'Financeiro v2: ressalvas exigem o fechamento com pendências documentadas antes da homologação.' using errcode = 'FV040';
  end if;
  for r in select * from jsonb_array_elements(h->'ressalvas') loop
    if coalesce(r->>'efeitoNoResultado', '') not in ('SEM_EFEITO', 'CONHECIDO')
       or (r->>'efeitoNoResultado' = 'CONHECIDO' and (r->'valorCentavos' is null or jsonb_typeof(r->'valorCentavos') <> 'number')) then
      raise exception 'Financeiro v2: ressalva inadmissível (efeito no resultado indeterminado): %', r->>'chave' using errcode = 'FV040';
    end if;
    select d into doc from jsonb_array_elements(old.pendencias) d where d->>'chave' = r->>'chave' limit 1;
    if doc is null or length(btrim(coalesce(doc->>'decisao', ''))) = 0
       or (length(btrim(coalesce(doc->>'documentacaoFaltante', ''))) = 0 and jsonb_array_length(coalesce(doc->'evidenciaDocumentoIds', '[]'::jsonb)) = 0) then
      raise exception 'Financeiro v2: ressalva sem documentação suficiente no fechamento: %', r->>'chave' using errcode = 'FV040';
    end if;
  end loop;
  -- Verificações objetivas, independentes do que a aplicação informa.
  if exists (select 1 from fv2_lancamento l where l.organizacao_id = new.organizacao_id and l.unidade_id = new.unidade_id
              and l.competencia = new.competencia and l.situacao = 'ATIVO' and l.categoria_codigo in ('DESPESAS_A_CLASSIFICAR', 'DESCONTOS_A_CLASSIFICAR')) then
    raise exception 'Financeiro v2: há lançamento da competência em categoria provisória ("a classificar"): não homologa.' using errcode = 'FV040';
  end if;
  if exists (select 1 from fv2_movimentacao m where m.organizacao_id = new.organizacao_id and m.unidade_id = new.unidade_id
              and to_char(m.data_efetiva, 'YYYY-MM') = new.competencia and m.sentido = 'SAIDA' and m.situacao = 'VALIDA'
              and m.alocado_centavos < m.valor_centavos and m.transferencia_id is null and m.pagamento_id is null and m.estorno_id is null) then
    raise exception 'Financeiro v2: há saída bancária do período sem vínculo (pode ser despesa não reconhecida): não homologa.' using errcode = 'FV040';
  end if;
  return new;
end $$;
create trigger fv2_competencia_ressalvas before insert or update on fv2_competencia for each row execute function fv2_homologacao_com_ressalvas();
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0018_fechamento_ressalvas_baixa_extrato.sql', '7a312af6949f039bb6ec7a21e8488f06eaf7dad7756a618e995334448daeaeec', '7a312af6949f039bb6ec7a21e8488f06eaf7dad7756a618e995334448daeaeec');

-- ------------------------------------------------------------------------- 0019_com_pendencias_sem_contorno.sql (arquivo ca7d6fd943a640ce83afa8d96f79b70e6662e62d86fc5cb8bfaca05f49a629e1)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0019: "FECHAMENTO COM PENDÊNCIAS DOCUMENTADAS" SEM CONTORNO — Execução 08E (achado da jornada)
--
-- Só é aplicada no PostgreSQL local isolado. Não pertence a database/migrations/.
--
-- A jornada no navegador mostrou que a passagem PRELIMINAR → COM_PENDENCIAS aceitava pendências não documentadas e
-- bloqueantes (a homologação continuava barrada, mas o estado afirmava algo falso). Regra (espelho do núcleo,
-- dominio/ressalvas.js → podeRegistrarComPendencias): o estado só vale quando o que resta são ressalvas admissíveis.
-- O banco confere o que consegue conferir sozinho:
--   * a competência não nasce nesse estado;
--   * ao ENTRAR nele, há ao menos uma pendência documentada e cada uma tem decisão e "o que falta" ou evidência;
--   * as mesmas verificações OBJETIVAS da homologação (0018): nenhum lançamento ativo em categoria provisória e nenhuma
--     saída do período sem vínculo — essas nunca viram ressalva.
-- A classificação de admissibilidade de cada pendência (natureza × impacto) continua no núcleo; o banco barra a
-- homologação com ressalva inadmissível (0018).
-- =====================================================================================================================

create or replace function fv2_com_pendencias_documentadas() returns trigger language plpgsql as $$
declare
  doc jsonb;
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    return new;
  end if;
  if new.estado <> 'FECHAMENTO_COM_PENDENCIAS' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    raise exception 'Financeiro v2: competência não nasce com pendências documentadas — passe pelo fechamento preliminar.' using errcode = 'FV040';
  end if;
  if old.estado = 'FECHAMENTO_COM_PENDENCIAS' then
    return new; -- documentar/atualizar pendências dentro do estado continua permitido
  end if;
  if jsonb_typeof(new.pendencias) <> 'array' or jsonb_array_length(new.pendencias) = 0 then
    raise exception 'Financeiro v2: fechamento com pendências exige ao menos uma pendência documentada.' using errcode = 'FV040';
  end if;
  for doc in select * from jsonb_array_elements(new.pendencias) loop
    if length(btrim(coalesce(doc->>'decisao', ''))) = 0
       or (length(btrim(coalesce(doc->>'documentacaoFaltante', ''))) = 0 and jsonb_array_length(coalesce(doc->'evidenciaDocumentoIds', '[]'::jsonb)) = 0) then
      raise exception 'Financeiro v2: pendência sem documentação suficiente (decisão e o que falta ou evidência): %', coalesce(doc->>'chave', doc->>'descricao') using errcode = 'FV040';
    end if;
  end loop;
  if exists (select 1 from fv2_lancamento l where l.organizacao_id = new.organizacao_id and l.unidade_id = new.unidade_id
              and l.competencia = new.competencia and l.situacao = 'ATIVO' and l.categoria_codigo in ('DESPESAS_A_CLASSIFICAR', 'DESCONTOS_A_CLASSIFICAR')) then
    raise exception 'Financeiro v2: há lançamento da competência em categoria provisória ("a classificar"): resolva antes do fechamento com pendências.' using errcode = 'FV040';
  end if;
  if exists (select 1 from fv2_movimentacao m where m.organizacao_id = new.organizacao_id and m.unidade_id = new.unidade_id
              and to_char(m.data_efetiva, 'YYYY-MM') = new.competencia and m.sentido = 'SAIDA' and m.situacao = 'VALIDA'
              and m.alocado_centavos < m.valor_centavos and m.transferencia_id is null and m.pagamento_id is null and m.estorno_id is null) then
    raise exception 'Financeiro v2: há saída bancária do período sem vínculo: resolva antes do fechamento com pendências.' using errcode = 'FV040';
  end if;
  return new;
end $$;
create trigger fv2_competencia_com_pendencias before insert or update on fv2_competencia for each row execute function fv2_com_pendencias_documentadas();
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0019_com_pendencias_sem_contorno.sql', 'ca7d6fd943a640ce83afa8d96f79b70e6662e62d86fc5cb8bfaca05f49a629e1', 'ca7d6fd943a640ce83afa8d96f79b70e6662e62d86fc5cb8bfaca05f49a629e1');

-- ------------------------------------------------------------------------- 0020_baixa_antecipada.sql (arquivo 719f956225b03eb1a40b4a97c53a1803517bf5bd8e927ab3ffda10c4b54d3254)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0020: BAIXA POR EXTRATO COM SAÍDA ANTERIOR À EMISSÃO (pagamento antecipado) — Execução 09
--
-- Só é aplicada no PostgreSQL local isolado. Não pertence a database/migrations/.
--
-- Espelho de aplicacao/baixaPorExtrato.js: sem bloqueio absoluto por data, mas a liquidação de VÍNCULO DE EXTRATO cuja
-- saída é anterior à emissão da conta só é gravada se vier marcada como pagamento antecipado (extras.antecipacao, com
-- os dias de antecedência coerentes com as datas reais) e com DOCUMENTO de tipo compatível (comprovante, contrato, nota
-- fiscal ou boleto). Conciliação confirmada sozinha não basta aqui. Vale para qualquer gravador (não só "só vincula").
-- =====================================================================================================================

create or replace function fv2_baixa_antecipada() returns trigger language plpgsql as $$
declare
  data_saida date;
  emissao date;
  ant jsonb;
  tipo_doc text;
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    return new;
  end if;
  if new.alvo_tipo <> 'OBRIGACAO' or coalesce(new.extras->>'origemDoVinculo', '') <> 'EXTRATO' then
    return new;
  end if;
  select m.data_efetiva into data_saida from fv2_movimentacao m
   where m.organizacao_id = new.organizacao_id and m.unidade_id = new.unidade_id and m.id = new.movimentacao_id;
  select o.data_emissao into emissao from fv2_obrigacao o
   where o.organizacao_id = new.organizacao_id and o.unidade_id = new.unidade_id and o.id = new.alvo_id;
  ant := new.extras->'antecipacao';
  if data_saida is null or emissao is null or data_saida >= emissao then
    if ant is not null and jsonb_typeof(ant) <> 'null' then
      raise exception 'Financeiro v2: a saída não é anterior à emissão — não pode ser marcada como pagamento antecipado.' using errcode = 'FV041';
    end if;
    return new;
  end if;
  if ant is null or jsonb_typeof(ant) <> 'object' or (ant->>'dias')::int is distinct from (emissao - data_saida)
     or ant->>'dataSaida' is distinct from data_saida::text or ant->>'dataEmissao' is distinct from emissao::text then
    raise exception 'Financeiro v2: saída anterior à emissão da conta exige identificação explícita de pagamento antecipado.' using errcode = 'FV041';
  end if;
  select d.tipo into tipo_doc from fv2_documento d
   where d.organizacao_id = new.organizacao_id and d.unidade_id = new.unidade_id and d.id = (new.extras->>'documentoId')::uuid;
  if tipo_doc is null or tipo_doc not in ('COMPROVANTE', 'CONTRATO', 'NOTA_FISCAL', 'BOLETO') then
    raise exception 'Financeiro v2: pagamento antecipado exige documento compatível (comprovante, contrato, nota fiscal ou boleto).' using errcode = 'FV041';
  end if;
  return new;
end $$;
create trigger fv2_liquidacao_baixa_antecipada before insert on fv2_liquidacao for each row execute function fv2_baixa_antecipada();
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0020_baixa_antecipada.sql', '719f956225b03eb1a40b4a97c53a1803517bf5bd8e927ab3ffda10c4b54d3254', '719f956225b03eb1a40b4a97c53a1803517bf5bd8e927ab3ffda10c4b54d3254');

-- ------------------------------------------------------------------------- 0021_liberacao_por_unidade.sql (arquivo b24ed9c2e8f18e4f881f76d3e7e7f3d2bb3eec24637c1a40189e75073c1a4b64)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0021: LIBERAÇÃO DO FINANCEIRO V2 POR EMPRESA E UNIDADE — Execução 09B
--
-- Só é aplicada no PostgreSQL local isolado. Não pertence a database/migrations/.
--
-- A liberação decide se a INTERFACE do v2 substitui o financeiro atual numa unidade. Ela NÃO concede nada: as ações
-- continuam exigindo concessão `financeiro_v2.*`, sessão de banco e RLS.
--   * desligado por padrão: sem linha = desligado; unidade só vale com a empresa ligada;
--   * leitura por função (fv2_app, sem sessão de banco: é um booleano de disponibilidade, sem dado financeiro);
--   * escrita SOMENTE pela autoridade (gateway), por função do guardião, com ator, justificativa (≥ 20), prova de
--     segundo fator declarada pelo gateway (aal2 com carimbo) e histórico imutável; nenhum papel tem DML direto;
--   * desligar não apaga nada do v2 (dados e auditoria ficam); religar não "ressuscita" sessões antigas.
-- =====================================================================================================================

create table fv2_liberacao (
  organizacao_id uuid not null,
  unidade_id     uuid,                 -- null = a própria empresa
  ativa          boolean not null,
  versao         integer not null default 1,
  alterada_em    timestamptz not null default clock_timestamp(),
  alterada_por   uuid not null,
  justificativa  text not null check (length(btrim(justificativa)) >= 20)
);
create unique index fv2_liberacao_chave on fv2_liberacao (organizacao_id, coalesce(unidade_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table fv2_liberacao_historico (
  seq            bigint generated always as identity primary key,
  organizacao_id uuid not null,
  unidade_id     uuid,
  ativa_antes    boolean,
  ativa_depois   boolean not null,
  ator           uuid not null,
  justificativa  text not null,
  segundo_fator_em timestamptz not null,
  papel_de_banco text not null default session_user,
  em             timestamptz not null default clock_timestamp()
);

-- Histórico imutável (nem o guardião altera ou apaga).
create or replace function fv2_liberacao_historico_imutavel() returns trigger language plpgsql as $$
begin
  raise exception 'Financeiro v2: o histórico de liberações é imutável.' using errcode = 'FV042';
end $$;
create trigger fv2_liberacao_historico_imutavel before update or delete on fv2_liberacao_historico for each row execute function fv2_liberacao_historico_imutavel();

revoke all on fv2_liberacao, fv2_liberacao_historico from public;
grant select, insert, update on fv2_liberacao to fv2_guardiao;
grant select, insert on fv2_liberacao_historico to fv2_guardiao;
alter table fv2_liberacao enable row level security;
alter table fv2_liberacao_historico enable row level security;
create policy fv2_liberacao_guardiao on fv2_liberacao to fv2_guardiao using (true) with check (true);
create policy fv2_liberacao_historico_guardiao on fv2_liberacao_historico to fv2_guardiao using (true) with check (true);

-- Leitura: estado da empresa e da unidade (desligado por padrão).
create or replace function fv2_liberacao_estado(p_organizacao uuid, p_unidade uuid)
returns table (empresa boolean, unidade boolean) language sql stable security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
  select coalesce((select l.ativa from fv2_liberacao l where l.organizacao_id = p_organizacao and l.unidade_id is null), false),
         coalesce((select l.ativa from fv2_liberacao l where l.organizacao_id = p_organizacao and l.unidade_id is null), false)
           and coalesce((select l.ativa from fv2_liberacao l where l.organizacao_id = p_organizacao and l.unidade_id = p_unidade), false)
$$;

-- Escrita: só a autoridade (gateway), que já verificou identidade e segundo fator do ator.
create or replace function fv2_liberacao_alterar(p_organizacao uuid, p_unidade uuid, p_ativa boolean, p_ator uuid, p_justificativa text, p_segundo_fator_em timestamptz)
returns integer language plpgsql security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
declare
  antes boolean;
  v integer;
begin
  if p_organizacao is null or p_ator is null or p_ativa is null then
    raise exception 'Financeiro v2: liberação exige empresa, ator e estado.' using errcode = 'FV042';
  end if;
  if length(btrim(coalesce(p_justificativa, ''))) < 20 then
    raise exception 'Financeiro v2: liberação exige justificativa (mínimo 20 caracteres).' using errcode = 'FV042';
  end if;
  if p_segundo_fator_em is null or p_segundo_fator_em < clock_timestamp() - interval '10 minutes' or p_segundo_fator_em > clock_timestamp() + interval '1 minute' then
    raise exception 'Financeiro v2: liberação exige segundo fator recente (10 minutos).' using errcode = 'FV042';
  end if;
  if p_unidade is not null and not exists (select 1 from fv2_escopo e where e.organizacao_id = p_organizacao and e.unidade_id = p_unidade) then
    raise exception 'Financeiro v2: unidade fora dos escopos do banco financeiro.' using errcode = 'FV042';
  end if;
  select l.ativa into antes from fv2_liberacao l where l.organizacao_id = p_organizacao and l.unidade_id is not distinct from p_unidade for update;
  if found then
    update fv2_liberacao set ativa = p_ativa, versao = versao + 1, alterada_em = clock_timestamp(), alterada_por = p_ator, justificativa = p_justificativa
     where organizacao_id = p_organizacao and unidade_id is not distinct from p_unidade returning versao into v;
  else
    insert into fv2_liberacao (organizacao_id, unidade_id, ativa, alterada_por, justificativa) values (p_organizacao, p_unidade, p_ativa, p_ator, p_justificativa) returning versao into v;
  end if;
  insert into fv2_liberacao_historico (organizacao_id, unidade_id, ativa_antes, ativa_depois, ator, justificativa, segundo_fator_em)
  values (p_organizacao, p_unidade, antes, p_ativa, p_ator, p_justificativa, p_segundo_fator_em);
  return v;
end $$;

alter function fv2_liberacao_estado(uuid, uuid) owner to fv2_guardiao;
alter function fv2_liberacao_alterar(uuid, uuid, boolean, uuid, text, timestamptz) owner to fv2_guardiao;
revoke all on function fv2_liberacao_estado(uuid, uuid) from public;
revoke all on function fv2_liberacao_alterar(uuid, uuid, boolean, uuid, text, timestamptz) from public;
grant execute on function fv2_liberacao_estado(uuid, uuid) to fv2_app, fv2_autoridade;
grant execute on function fv2_liberacao_alterar(uuid, uuid, boolean, uuid, text, timestamptz) to fv2_autoridade;
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0021_liberacao_por_unidade.sql', 'b24ed9c2e8f18e4f881f76d3e7e7f3d2bb3eec24637c1a40189e75073c1a4b64', 'fd829c5c35ba04744989f410a5a2bf341e87d58d8b7e03f44ca2ec0324366248');

-- ------------------------------------------------------------------------- 0022_abertura_da_unidade.sql (arquivo 43de10df4e73e9d53ecd01cc2607dd2629f8ec665a4fd2ca865ffcd819394a21)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
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
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0022_abertura_da_unidade.sql', '43de10df4e73e9d53ecd01cc2607dd2629f8ec665a4fd2ca865ffcd819394a21', '43de10df4e73e9d53ecd01cc2607dd2629f8ec665a4fd2ca865ffcd819394a21');

-- ------------------------------------------------------------------------- 0023_administracao_corporativa.sql (arquivo ddc2d8b28694ea3b982114e879474e16d5041277d1f2b6f5653f48768e47ca23)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0023: ADMINISTRAÇÃO CORPORATIVA (ativação simples por unidade, sem atestante em cada uma)
--
-- Só é aplicada no PostgreSQL local isolado e, depois de autorizada, no schema dedicado. Não pertence a database/migrations/.
--
-- O que muda (e o que NÃO muda):
--   * NOVO papel de autoridade: ADMINISTRADOR FINANCEIRO CORPORATIVO (por empresa). Quem é administrador é decidido por
--     outro administrador corporativo; a PRIMEIRA pessoa de uma empresa só entra pelo procedimento de infraestrutura
--     (autoridade + segundo fator recente, uma única vez por empresa). Ser administrador da plataforma NÃO basta.
--   * Liberar/desligar unidades e conceder/revogar acessos financeiros passam a ser feitos pelo administrador
--     corporativo SEM segundo atestante e SEM segundo fator a cada ato (a autenticação da sessão e a verificação no
--     backend continuam). Tudo grava ator, justificativa e histórico imutáveis.
--   * Separa DISPONIBILIDADE (fv2_liberacao.ativa: a interface do v2 aparece) de ESCRITA (escrita_ativa: a unidade aceita
--     lançamentos). Padrão: escrita DESLIGADA; as linhas existentes (Açaí) ficam como estão.
--   * Ninguém concede a si mesmo (a regra de tabela concedido_por <> usuario_id continua valendo).
--   * Nada é apagado: só colunas novas, tabelas novas e funções novas. O histórico anterior permanece.
-- =====================================================================================================================

-- 1) Administradores corporativos ----------------------------------------------------------------------------------
create table fv2_administrador_corporativo (
  organizacao_id uuid not null,
  conta_id       uuid not null,               -- a conta pessoal (a mesma que liberação e MFA usam como ator)
  ativo          boolean not null,
  versao         integer not null default 1,
  alterado_em    timestamptz not null default clock_timestamp(),
  alterado_por   uuid not null,
  justificativa  text not null check (length(btrim(justificativa)) >= 20),
  primary key (organizacao_id, conta_id)
);
create table fv2_administrador_corporativo_historico (
  seq            bigint generated always as identity primary key,
  organizacao_id uuid not null,
  conta_id       uuid not null,
  ativo_antes    boolean,
  ativo_depois   boolean not null,
  ator           uuid not null,
  origem         text not null check (origem in ('INFRAESTRUTURA', 'ADMINISTRADOR_CORPORATIVO')),
  justificativa  text not null,
  segundo_fator_em timestamptz,
  papel_de_banco text not null default session_user,
  em             timestamptz not null default clock_timestamp()
);
create trigger fv2_administrador_historico_imutavel before update or delete on fv2_administrador_corporativo_historico for each row execute function fv2_liberacao_historico_imutavel();
revoke all on fv2_administrador_corporativo, fv2_administrador_corporativo_historico from public;
grant select, insert, update on fv2_administrador_corporativo to fv2_guardiao;
grant select, insert on fv2_administrador_corporativo_historico to fv2_guardiao;
alter table fv2_administrador_corporativo enable row level security;
alter table fv2_administrador_corporativo_historico enable row level security;
create policy fv2_administrador_guardiao on fv2_administrador_corporativo to fv2_guardiao using (true) with check (true);
create policy fv2_administrador_historico_guardiao on fv2_administrador_corporativo_historico to fv2_guardiao using (true) with check (true);

-- 2) Liberação: escrita por unidade ----------------------------------------------------------------------------------
alter table fv2_liberacao add column escrita_ativa boolean not null default false;
alter table fv2_liberacao_historico add column escrita_antes boolean;
alter table fv2_liberacao_historico add column escrita_depois boolean;
alter table fv2_liberacao_historico add column origem text not null default 'SEGUNDO_FATOR';
alter table fv2_liberacao_historico alter column segundo_fator_em drop not null;

-- 2b) O guardião (dono das funções acima) grava SÓ o histórico de CONCESSÃO — o mesmo que a aplicação grava no provisionamento.
grant select, insert on fv2_historico to fv2_guardiao;
create policy fv2_historico_guardiao on fv2_historico to fv2_guardiao using (registro_tipo = 'CONCESSAO') with check (registro_tipo = 'CONCESSAO');
alter policy fv2_historico_incluir on fv2_historico with check (
  (select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar',
    'financeiro_v2.fechar', 'financeiro_v2.homologar', 'financeiro_v2.revisar', 'financeiro_v2.configurar', 'financeiro_v2.importar',
    'financeiro_v2.conceder', 'financeiro_v2.documentos', 'financeiro_v2.aprovar', 'financeiro_v2.aplicar', 'financeiro_v2.revogar',
    'financeiro_v2.confirmar_importacao', 'financeiro_v2.reabrir', 'financeiro_v2.reclassificar', 'financeiro_v2.enviar_documento',
    'financeiro_v2.vincular_pagamento']))
  or ((select fv2_em_provisionamento()) and registro_tipo = 'CONCESSAO')
  or (current_user = 'fv2_guardiao' and registro_tipo = 'CONCESSAO'));

-- 3) Auditoria de concessão sem sessão de banco (o ato do administrador corporativo não abre sessão) ---------------------
alter table fv2_auditoria_concessao alter column sessao_id drop not null;

-- 4) Funções ---------------------------------------------------------------------------------------------------------
create or replace function fv2_administrador_corporativo_ativo(p_organizacao uuid, p_conta uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
  select coalesce((select a.ativo from fv2_administrador_corporativo a where a.organizacao_id = p_organizacao and a.conta_id = p_conta), false)
$$;

-- Define (liga/desliga) um administrador corporativo.
--   * se a empresa JÁ tem administrador ativo: só outro administrador ativo faz (origem ADMINISTRADOR_CORPORATIVO), sem
--     segundo fator a cada ato; ninguém altera a si mesmo;
--   * se NÃO tem nenhum: só pelo procedimento de infraestrutura, com segundo fator recente do ator (uma vez por empresa).
create or replace function fv2_administrador_corporativo_definir(p_organizacao uuid, p_conta uuid, p_ativo boolean, p_ator uuid, p_justificativa text, p_segundo_fator_em timestamptz)
returns integer language plpgsql security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
declare
  antes boolean;
  v integer;
  origem text;
  tem_ativo boolean;
begin
  if p_organizacao is null or p_conta is null or p_ator is null or p_ativo is null then
    raise exception 'Financeiro v2: administrador corporativo exige empresa, conta, ator e estado.' using errcode = 'FV042';
  end if;
  if length(btrim(coalesce(p_justificativa, ''))) < 20 then
    raise exception 'Financeiro v2: administrador corporativo exige justificativa (mínimo 20 caracteres).' using errcode = 'FV042';
  end if;
  if not exists (select 1 from fv2_escopo e where e.organizacao_id = p_organizacao) then
    raise exception 'Financeiro v2: empresa fora dos escopos do banco financeiro.' using errcode = 'FV042';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('fv2_administrador_corporativo:' || p_organizacao::text, 0));
  select exists (select 1 from fv2_administrador_corporativo a where a.organizacao_id = p_organizacao and a.ativo) into tem_ativo;
  if tem_ativo then
    if p_ator = p_conta then
      raise exception 'Financeiro v2: ninguém altera a própria condição de administrador corporativo.' using errcode = 'FV043';
    end if;
    if not coalesce((select a.ativo from fv2_administrador_corporativo a where a.organizacao_id = p_organizacao and a.conta_id = p_ator), false) then
      raise exception 'Financeiro v2: só um administrador corporativo ativo altera administradores.' using errcode = 'FV043';
    end if;
    if not p_ativo and (select count(*) from fv2_administrador_corporativo a where a.organizacao_id = p_organizacao and a.ativo and a.conta_id <> p_conta) = 0 then
      raise exception 'Financeiro v2: a empresa não pode ficar sem administrador corporativo.' using errcode = 'FV043';
    end if;
    origem := 'ADMINISTRADOR_CORPORATIVO';
  else
    if not p_ativo then
      raise exception 'Financeiro v2: não há administrador corporativo ativo para desligar.' using errcode = 'FV043';
    end if;
    if p_segundo_fator_em is null or p_segundo_fator_em < clock_timestamp() - interval '10 minutes' or p_segundo_fator_em > clock_timestamp() + interval '1 minute' then
      raise exception 'Financeiro v2: o primeiro administrador corporativo exige segundo fator recente (10 minutos).' using errcode = 'FV043';
    end if;
    origem := 'INFRAESTRUTURA';
  end if;
  select a.ativo into antes from fv2_administrador_corporativo a where a.organizacao_id = p_organizacao and a.conta_id = p_conta for update;
  if found then
    update fv2_administrador_corporativo set ativo = p_ativo, versao = versao + 1, alterado_em = clock_timestamp(), alterado_por = p_ator, justificativa = p_justificativa
     where organizacao_id = p_organizacao and conta_id = p_conta returning versao into v;
  else
    insert into fv2_administrador_corporativo (organizacao_id, conta_id, ativo, alterado_por, justificativa) values (p_organizacao, p_conta, p_ativo, p_ator, p_justificativa) returning versao into v;
  end if;
  insert into fv2_administrador_corporativo_historico (organizacao_id, conta_id, ativo_antes, ativo_depois, ator, origem, justificativa, segundo_fator_em)
  values (p_organizacao, p_conta, antes, p_ativo, p_ator, origem, p_justificativa, case when origem = 'INFRAESTRUTURA' then p_segundo_fator_em end);
  return v;
end $$;

-- Estado de liberação passa a informar também a ESCRITA (mudou o tipo de retorno: recria).
drop function if exists fv2_liberacao_estado(uuid, uuid);
create function fv2_liberacao_estado(p_organizacao uuid, p_unidade uuid)
returns table (empresa boolean, unidade boolean, escrita boolean) language sql stable security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
  with e as (select coalesce((select l.ativa from fv2_liberacao l where l.organizacao_id = p_organizacao and l.unidade_id is null), false) as ativa),
       u as (select l.ativa, l.escrita_ativa from fv2_liberacao l where l.organizacao_id = p_organizacao and l.unidade_id = p_unidade)
  select e.ativa,
         e.ativa and coalesce((select u.ativa from u), false),
         e.ativa and coalesce((select u.ativa and u.escrita_ativa from u), false)
    from e
$$;
alter function fv2_liberacao_estado(uuid, uuid) owner to fv2_guardiao;
revoke all on function fv2_liberacao_estado(uuid, uuid) from public;
grant execute on function fv2_liberacao_estado(uuid, uuid) to fv2_app, fv2_autoridade;

-- Liberação EM LOTE pelo administrador corporativo (uma chamada, várias unidades, uma transação).
--   p_escrita null = não mexe na escrita; true/false = define. Ligar a escrita exige a unidade ligada.
create or replace function fv2_liberacao_alterar_lote(p_organizacao uuid, p_unidades uuid[], p_ativa boolean, p_escrita boolean, p_ator uuid, p_justificativa text)
returns integer language plpgsql security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
declare
  u uuid;
  antes boolean;
  esc_antes boolean;
  esc_depois boolean;
  n integer := 0;
begin
  if p_organizacao is null or p_ator is null or p_ativa is null or p_unidades is null or coalesce(array_length(p_unidades, 1), 0) = 0 then
    raise exception 'Financeiro v2: liberação em lote exige empresa, ator, estado e unidades.' using errcode = 'FV042';
  end if;
  if array_length(p_unidades, 1) > 50 then
    raise exception 'Financeiro v2: lote de liberação limitado a 50 unidades.' using errcode = 'FV042';
  end if;
  if length(btrim(coalesce(p_justificativa, ''))) < 20 then
    raise exception 'Financeiro v2: liberação exige justificativa (mínimo 20 caracteres).' using errcode = 'FV042';
  end if;
  if not fv2_administrador_corporativo_ativo(p_organizacao, p_ator) then
    raise exception 'Financeiro v2: só o administrador financeiro corporativo libera unidades.' using errcode = 'FV043';
  end if;
  if (not p_ativa) and coalesce(p_escrita, false) then
    raise exception 'Financeiro v2: unidade desligada não pode ficar com escrita ligada.' using errcode = 'FV042';
  end if;
  -- a empresa precisa estar ligada (a linha da empresa é criada junto, na primeira vez)
  if p_ativa then
    select l.ativa into antes from fv2_liberacao l where l.organizacao_id = p_organizacao and l.unidade_id is null for update;
    if not found then
      insert into fv2_liberacao (organizacao_id, unidade_id, ativa, alterada_por, justificativa) values (p_organizacao, null, true, p_ator, p_justificativa);
      insert into fv2_liberacao_historico (organizacao_id, unidade_id, ativa_antes, ativa_depois, ator, justificativa, segundo_fator_em, origem, escrita_depois)
      values (p_organizacao, null, null, true, p_ator, p_justificativa, null, 'ADMINISTRADOR_CORPORATIVO', false);
    elsif not antes then
      update fv2_liberacao set ativa = true, versao = versao + 1, alterada_em = clock_timestamp(), alterada_por = p_ator, justificativa = p_justificativa
       where organizacao_id = p_organizacao and unidade_id is null;
      insert into fv2_liberacao_historico (organizacao_id, unidade_id, ativa_antes, ativa_depois, ator, justificativa, segundo_fator_em, origem)
      values (p_organizacao, null, false, true, p_ator, p_justificativa, null, 'ADMINISTRADOR_CORPORATIVO');
    end if;
  end if;
  foreach u in array p_unidades loop
    if u is null or not exists (select 1 from fv2_escopo e where e.organizacao_id = p_organizacao and e.unidade_id = u) then
      raise exception 'Financeiro v2: unidade fora dos escopos do banco financeiro.' using errcode = 'FV042';
    end if;
    select l.ativa, l.escrita_ativa into antes, esc_antes from fv2_liberacao l where l.organizacao_id = p_organizacao and l.unidade_id = u for update;
    esc_depois := case when not p_ativa then false when p_escrita is null then coalesce(esc_antes, false) else p_escrita end;
    if found then
      update fv2_liberacao set ativa = p_ativa, escrita_ativa = esc_depois, versao = versao + 1, alterada_em = clock_timestamp(), alterada_por = p_ator, justificativa = p_justificativa
       where organizacao_id = p_organizacao and unidade_id = u;
    else
      insert into fv2_liberacao (organizacao_id, unidade_id, ativa, escrita_ativa, alterada_por, justificativa) values (p_organizacao, u, p_ativa, esc_depois, p_ator, p_justificativa);
    end if;
    insert into fv2_liberacao_historico (organizacao_id, unidade_id, ativa_antes, ativa_depois, ator, justificativa, segundo_fator_em, origem, escrita_antes, escrita_depois)
    values (p_organizacao, u, antes, p_ativa, p_ator, p_justificativa, null, 'ADMINISTRADOR_CORPORATIVO', esc_antes, esc_depois);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Concessão pelo administrador corporativo: acrescenta/retira ações de UMA pessoa em UMA unidade da empresa.
--   * ator = conta do administrador corporativo ativo; beneficiário = pessoa operacional (perfil) ≠ ator (sem autoconcessão);
--   * p_acoes vazio = revoga (situação REVOGADA); ações só do catálogo financeiro_v2.*;
--   * grava a auditoria de concessão (finalidade ADMINISTRACAO_CORPORATIVA) e encerra as sessões de banco do beneficiário.
create or replace function fv2_conceder_por_administrador(p_organizacao uuid, p_unidade uuid, p_usuario uuid, p_acoes jsonb, p_ator_conta uuid, p_ator_perfil uuid, p_justificativa text)
returns integer language plpgsql security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
declare
  atual fv2_concessao;
  v_acoes jsonb;
  v_situacao text;
  v integer;
  novo_id uuid;
begin
  if p_organizacao is null or p_unidade is null or p_usuario is null or p_ator_conta is null or p_ator_perfil is null then
    raise exception 'Financeiro v2: concessão exige empresa, unidade, beneficiário e ator.' using errcode = 'FV030';
  end if;
  if p_usuario = p_ator_perfil or p_usuario = p_ator_conta then
    raise exception 'Financeiro v2: ninguém concede nem revoga o próprio acesso.' using errcode = 'FV030';
  end if;
  if length(btrim(coalesce(p_justificativa, ''))) < 20 then
    raise exception 'Financeiro v2: concessão exige justificativa (mínimo 20 caracteres).' using errcode = 'FV030';
  end if;
  if jsonb_typeof(p_acoes) is distinct from 'array' then
    raise exception 'Financeiro v2: ações inválidas.' using errcode = 'FV030';
  end if;
  if not fv2_administrador_corporativo_ativo(p_organizacao, p_ator_conta) then
    raise exception 'Financeiro v2: só o administrador financeiro corporativo concede acessos por esta via.' using errcode = 'FV043';
  end if;
  if not exists (select 1 from fv2_escopo e where e.organizacao_id = p_organizacao and e.unidade_id = p_unidade) then
    raise exception 'Financeiro v2: unidade fora dos escopos do banco financeiro.' using errcode = 'FV030';
  end if;
  v_acoes := fv2__acoes_ordenadas(p_acoes);
  v_situacao := case when jsonb_array_length(v_acoes) > 0 then 'ATIVA' else 'REVOGADA' end;
  perform fv2__trava_concessoes(p_organizacao, p_unidade, true);
  select * into atual from fv2_concessao c where c.organizacao_id = p_organizacao and c.unidade_id = p_unidade and c.usuario_id = p_usuario;
  if atual.id is null then
    if v_situacao = 'REVOGADA' then
      return 0; -- nada a revogar
    end if;
    novo_id := gen_random_uuid();
    insert into fv2_concessao (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, chave_idempotencia, usuario_id, acoes, situacao, concedido_por, justificativa)
    values (novo_id, p_organizacao, p_unidade, 1, clock_timestamp(), p_ator_perfil, clock_timestamp(), p_ator_perfil, 'concessao:' || p_usuario::text, p_usuario, v_acoes, v_situacao, p_ator_perfil, btrim(p_justificativa));
    v := 1;
  else
    if atual.situacao = v_situacao and atual.acoes = v_acoes then
      return 0; -- sem mudança
    end if;
    update fv2_concessao c set versao = c.versao + 1, atualizado_em = clock_timestamp(), atualizado_por = p_ator_perfil, acoes = v_acoes, situacao = v_situacao,
           concedido_por = p_ator_perfil, justificativa = btrim(p_justificativa)
     where c.id = atual.id returning c.versao into v;
    novo_id := atual.id;
  end if;
  insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em)
  values (gen_random_uuid(), p_organizacao, p_unidade, 'CONCESSAO', novo_id, case when atual.id is null then 'CRIACAO' else 'CORRECAO' end,
          case when atual.id is null then null else jsonb_build_object('versao', atual.versao, 'acoes', atual.acoes, 'situacao', atual.situacao) end,
          jsonb_build_object('versao', v, 'acoes', v_acoes, 'situacao', v_situacao), btrim(p_justificativa), p_ator_perfil, clock_timestamp());
  set constraints fv2_concessao_historico immediate;
  insert into fv2_auditoria_concessao (organizacao_id, unidade_id, concessao_id, usuario_alvo, ator, sessao_id, finalidade, operacao,
                                       acoes_antes, acoes_depois, situacao_depois, justificativa)
  values (p_organizacao, p_unidade, novo_id, p_usuario, p_ator_perfil, null, 'ADMINISTRACAO_CORPORATIVA',
          case when v_situacao = 'REVOGADA' then 'REVOGACAO' when atual.id is null then 'CONCESSAO' else 'CONCESSAO_E_REVOGACAO' end,
          case when atual.id is not null and atual.situacao = 'ATIVA' then atual.acoes else '[]'::jsonb end, v_acoes, v_situacao, btrim(p_justificativa));
  update fv2_sessao_banco b set revogada_em = clock_timestamp(), motivo_revogacao = 'concessão alterada pelo administrador corporativo'
   where b.usuario_id = p_usuario and b.organizacao_id = p_organizacao and b.unidade_id = p_unidade and b.revogada_em is null;
  return v;
end $$;

alter function fv2_administrador_corporativo_ativo(uuid, uuid) owner to fv2_guardiao;
alter function fv2_administrador_corporativo_definir(uuid, uuid, boolean, uuid, text, timestamptz) owner to fv2_guardiao;
alter function fv2_liberacao_alterar_lote(uuid, uuid[], boolean, boolean, uuid, text) owner to fv2_guardiao;
alter function fv2_conceder_por_administrador(uuid, uuid, uuid, jsonb, uuid, uuid, text) owner to fv2_guardiao;
revoke all on function fv2_administrador_corporativo_ativo(uuid, uuid) from public;
revoke all on function fv2_administrador_corporativo_definir(uuid, uuid, boolean, uuid, text, timestamptz) from public;
revoke all on function fv2_liberacao_alterar_lote(uuid, uuid[], boolean, boolean, uuid, text) from public;
revoke all on function fv2_conceder_por_administrador(uuid, uuid, uuid, jsonb, uuid, uuid, text) from public;
grant execute on function fv2_administrador_corporativo_ativo(uuid, uuid) to fv2_autoridade;
grant execute on function fv2_administrador_corporativo_definir(uuid, uuid, boolean, uuid, text, timestamptz) to fv2_autoridade;
grant execute on function fv2_liberacao_alterar_lote(uuid, uuid[], boolean, boolean, uuid, text) to fv2_autoridade;
grant execute on function fv2_conceder_por_administrador(uuid, uuid, uuid, jsonb, uuid, uuid, text) to fv2_autoridade;

-- Leituras para o painel do administrador corporativo (só ele lê; nenhum dado financeiro, só liberação e acessos).
create or replace function fv2_painel_liberacoes(p_organizacao uuid, p_ator uuid)
returns table (unidade_id uuid, rotulo text, ativa boolean, escrita_ativa boolean, empresa_ativa boolean) language plpgsql stable security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
begin
  if not fv2_administrador_corporativo_ativo(p_organizacao, p_ator) then
    raise exception 'Financeiro v2: só o administrador financeiro corporativo vê o painel de ativação.' using errcode = 'FV043';
  end if;
  return query
    select e.unidade_id, e.rotulo, coalesce(l.ativa, false), coalesce(l.ativa, false) and coalesce(l.escrita_ativa, false),
           coalesce((select x.ativa from fv2_liberacao x where x.organizacao_id = p_organizacao and x.unidade_id is null), false)
      from fv2_escopo e left join fv2_liberacao l on l.organizacao_id = e.organizacao_id and l.unidade_id = e.unidade_id
     where e.organizacao_id = p_organizacao order by e.rotulo;
end $$;

create or replace function fv2_painel_acessos(p_organizacao uuid, p_unidade uuid, p_ator uuid)
returns table (usuario_id uuid, acoes jsonb, situacao text, atualizado_em timestamptz) language plpgsql stable security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
begin
  if not fv2_administrador_corporativo_ativo(p_organizacao, p_ator) then
    raise exception 'Financeiro v2: só o administrador financeiro corporativo vê os acessos.' using errcode = 'FV043';
  end if;
  return query select c.usuario_id, c.acoes, c.situacao, c.atualizado_em from fv2_concessao c where c.organizacao_id = p_organizacao and c.unidade_id = p_unidade order by c.atualizado_em;
end $$;

alter function fv2_painel_liberacoes(uuid, uuid) owner to fv2_guardiao;
alter function fv2_painel_acessos(uuid, uuid, uuid) owner to fv2_guardiao;
revoke all on function fv2_painel_liberacoes(uuid, uuid) from public;
revoke all on function fv2_painel_acessos(uuid, uuid, uuid) from public;
grant execute on function fv2_painel_liberacoes(uuid, uuid) to fv2_autoridade;
grant execute on function fv2_painel_acessos(uuid, uuid, uuid) to fv2_autoridade;

create or replace function fv2_painel_administradores(p_organizacao uuid, p_ator uuid)
returns table (conta_id uuid, ativo boolean, alterado_em timestamptz) language plpgsql stable security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
begin
  if not fv2_administrador_corporativo_ativo(p_organizacao, p_ator) then
    raise exception 'Financeiro v2: só o administrador financeiro corporativo vê os administradores.' using errcode = 'FV043';
  end if;
  return query select a.conta_id, a.ativo, a.alterado_em from fv2_administrador_corporativo a where a.organizacao_id = p_organizacao order by a.alterado_em;
end $$;
alter function fv2_painel_administradores(uuid, uuid) owner to fv2_guardiao;
revoke all on function fv2_painel_administradores(uuid, uuid) from public;
grant execute on function fv2_painel_administradores(uuid, uuid) to fv2_autoridade;
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0023_administracao_corporativa.sql', 'ddc2d8b28694ea3b982114e879474e16d5041277d1f2b6f5653f48768e47ca23', '7cf93b58ab340e8da8b4414205cac63155129e20bbf5525d8338fcdaa3514687');

-- ------------------------------------------------------------------------- 0024_canais_e_operadoras.sql (arquivo 06d24fc401594af33601efceee76a0945059eb10bb8c729ef0b5c5ba185a7a59)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0024: CANAL 99FOOD e OPERADORAS de pagamento (Fase 02, doc 40)
--
-- Só é aplicada no PostgreSQL local isolado e, depois de autorizada, no schema dedicado. Não pertence a database/migrations/.
--
-- O que muda (e o que NÃO muda):
--   * canal NOVENTA_E_NOVE_FOOD passa a ser aceito (lançamento, venda, recebível, cadastro de canais). Os canais existentes
--     continuam iguais e nenhum registro é alterado.
--   * processadores PAGBANK, MAQUININHA_IFOOD (maquininha do iFood usada no balcão: operadora, não canal) e
--     NOVENTA_E_NOVE_FOOD (repasse do marketplace 99Food) passam a ser aceitos (pagamento, recebível, cadastro).
--   * Operadoras, tabelas de taxas e taxa estimada vivem nas extensões (`extras`) já existentes: nenhuma coluna nova.
--   * Só troca restrições CHECK por versões mais amplas: nenhuma linha atual deixa de valer.
-- =====================================================================================================================

do $$
declare
  r record;
begin
  -- Remove as CHECK antigas de canal/processador (nomes gerados pelo PostgreSQL) — identificadas pela definição.
  for r in
    select c.conname, t.relname
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where c.contype = 'c'
       and n.nspname = current_schema()
       and t.relname in ('fv2_lancamento', 'fv2_venda', 'fv2_pagamento_venda', 'fv2_recebivel', 'fv2_canal_processador')
       and pg_get_constraintdef(c.oid) like '%ANOTA_AI%'
  loop
    execute format('alter table %I drop constraint %I', r.relname, r.conname);
  end loop;
end $$;

-- A varredura acima apaga TODA CHECK que cita 'ANOTA_AI' nessas tabelas, e isso inclui a da origem da venda (SAIPOS, IFOOD,
-- ANOTA_AI, MANUAL), que não deve mudar. Ela volta aqui, idêntica à da fundação (0001): nenhuma linha atual a viola.
alter table fv2_venda add constraint fv2_venda_fonte_sistema_check
  check (fonte_sistema in ('SAIPOS', 'IFOOD', 'ANOTA_AI', 'MANUAL'));

alter table fv2_lancamento add constraint fv2_lancamento_canal_valido
  check (canal is null or canal in ('BALCAO', 'IFOOD', 'ANOTA_AI', 'NOVENTA_E_NOVE_FOOD', 'OUTRO'));
alter table fv2_venda add constraint fv2_venda_canal_valido
  check (canal in ('BALCAO', 'IFOOD', 'ANOTA_AI', 'NOVENTA_E_NOVE_FOOD', 'OUTRO'));
alter table fv2_pagamento_venda add constraint fv2_pagamento_venda_processador_valido
  check (processador is null or processador in ('STONE', 'PAGBANK', 'MAQUININHA_IFOOD', 'IFOOD', 'ANOTA_AI', 'NOVENTA_E_NOVE_FOOD', 'OPERADORA_BENEFICIOS', 'MAQUINA_TERCEIROS', 'OUTRO'));
alter table fv2_recebivel add constraint fv2_recebivel_processador_valido
  check (processador is null or processador in ('STONE', 'PAGBANK', 'MAQUININHA_IFOOD', 'IFOOD', 'ANOTA_AI', 'NOVENTA_E_NOVE_FOOD', 'OPERADORA_BENEFICIOS', 'MAQUINA_TERCEIROS', 'OUTRO'));
alter table fv2_recebivel add constraint fv2_recebivel_canal_valido
  check (canal is null or canal in ('BALCAO', 'IFOOD', 'ANOTA_AI', 'NOVENTA_E_NOVE_FOOD', 'OUTRO'));
alter table fv2_canal_processador add constraint fv2_canal_processador_codigo_base_valido
  check ((papel = 'CANAL' and codigo_base in ('BALCAO', 'IFOOD', 'ANOTA_AI', 'NOVENTA_E_NOVE_FOOD', 'OUTRO'))
      or (papel = 'PROCESSADOR' and codigo_base in ('STONE', 'PAGBANK', 'MAQUININHA_IFOOD', 'IFOOD', 'ANOTA_AI', 'NOVENTA_E_NOVE_FOOD', 'OPERADORA_BENEFICIOS', 'MAQUINA_TERCEIROS', 'OUTRO')));
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0024_canais_e_operadoras.sql', '06d24fc401594af33601efceee76a0945059eb10bb8c729ef0b5c5ba185a7a59', '06d24fc401594af33601efceee76a0945059eb10bb8c729ef0b5c5ba185a7a59');

-- ------------------------------------------------------------------------- 0025_fechamento_manual_caixa.sql (arquivo ffb42c1db5a02ba97eaeaf8c0047d4efbcc4568476f7907eda633b2d261135a2)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
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
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0025_fechamento_manual_caixa.sql', 'ffb42c1db5a02ba97eaeaf8c0047d4efbcc4568476f7907eda633b2d261135a2', 'ffb42c1db5a02ba97eaeaf8c0047d4efbcc4568476f7907eda633b2d261135a2');

-- ------------------------------------------------------------------------- 0026_entregadores_proprios.sql (arquivo 787d09876c61debe4c1d600862b80b482d7034a37c845596862383ee5d796312)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
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
    when 'EXTRA_ENTREGADOR' then 'fv2_extra_entregador'
  end::regclass
$$;

-- Serviços extras: valores fora das taxas do parser. A conta e a saída continuam nas tabelas próprias; aqui fica só o vínculo.
create table fv2_extra_entregador (
  seq                bigint generated always as identity,
  id                 uuid not null primary key,
  organizacao_id     uuid not null,
  unidade_id         uuid not null,
  versao             integer not null check (versao >= 1),
  criado_em          timestamptz not null,
  criado_por         uuid not null,
  atualizado_em      timestamptz not null,
  atualizado_por     uuid not null,
  chave_idempotencia text not null check (length(chave_idempotencia) between 1 and 400),
  impressao          text,
  extras             jsonb not null default '{}'::jsonb check (jsonb_typeof(extras) = 'object'),
  entregador_chave   text not null check (length(btrim(entregador_chave)) between 1 and 200),
  entregador_nome    text not null check (length(btrim(entregador_nome)) between 1 and 200),
  data_servico       date not null,
  semana_inicio      date not null check (extract(isodow from semana_inicio) = 1),
  descricao          text not null check (length(btrim(descricao)) between 1 and 300),
  valor_centavos     bigint not null check (valor_centavos > 0),
  situacao           text not null check (situacao in ('PENDENTE', 'PAGO', 'PAGO_AGUARDANDO_VINCULO', 'CANCELADO')),
  obrigacao_id       uuid,
  movimentacao_id    uuid,
  dados              jsonb not null check (jsonb_typeof(dados) = 'object'),
  unique (organizacao_id, unidade_id, id),
  check (data_servico between semana_inicio and semana_inicio + 6),
  check (atualizado_em >= criado_em)
);
alter table fv2_extra_entregador add constraint fv2_extra_entregador_escopo_fk foreign key (organizacao_id, unidade_id) references fv2_escopo;
create unique index fv2_extra_entregador_chave_uq on fv2_extra_entregador (organizacao_id, unidade_id, chave_idempotencia);
create unique index fv2_extra_entregador_obrigacao_uq on fv2_extra_entregador (organizacao_id, unidade_id, obrigacao_id) where obrigacao_id is not null and situacao <> 'CANCELADO';
create index fv2_extra_entregador_semana on fv2_extra_entregador (organizacao_id, unidade_id, semana_inicio);
create trigger fv2_extra_entregador_sem_delete before delete on fv2_extra_entregador for each row execute function fv2_proibir_exclusao();
create trigger fv2_extra_entregador_sem_truncate before truncate on fv2_extra_entregador for each statement execute function fv2_proibir_exclusao();
create trigger fv2_extra_entregador_versao before update on fv2_extra_entregador for each row execute function fv2_guardar_versao();
create constraint trigger fv2_extra_entregador_historico after insert or update on fv2_extra_entregador deferrable initially deferred
  for each row execute function fv2_exigir_historico('EXTRA_ENTREGADOR');
alter table fv2_extra_entregador enable row level security;
alter table fv2_extra_entregador force row level security;
create policy fv2_extra_entregador_escopo on fv2_extra_entregador
  using (organizacao_id = (select fv2_org()) and unidade_id = (select fv2_uni()))
  with check (organizacao_id = (select fv2_org()) and unidade_id = (select fv2_uni()));
create policy fv2_extra_entregador_ler on fv2_extra_entregador as restrictive for select using ((select fv2_sessao_operacional()));
create policy fv2_extra_entregador_incluir on fv2_extra_entregador as restrictive for insert with check ((select fv2_tem_acao(array['financeiro_v2.registrar'])));
create policy fv2_extra_entregador_alterar on fv2_extra_entregador as restrictive for update
  using ((select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir'])))
  with check ((select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir'])));
grant select, insert, update on fv2_extra_entregador to fv2_app;

-- Identidade técnica do fechamento semanal: pode criar fechamento e conta a pagar, e NADA que mova dinheiro ou altere permissões.
create function fv2_bloquear_identidade_de_automacao() returns trigger language plpgsql as $$
begin
  if fv2_usuario() = '00000000-0000-4000-8000-00000000e7e9'::uuid then
    raise exception 'FV2: a identidade técnica de entregadores não pode alterar %', tg_table_name using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
do $$ declare t text; begin
  foreach t in array array['fv2_extra_entregador', 'fv2_movimentacao', 'fv2_liquidacao', 'fv2_transferencia', 'fv2_ajuste', 'fv2_estorno', 'fv2_saldo_conta', 'fv2_sessao_caixa', 'fv2_concessao', 'fv2_conta', 'fv2_competencia'] loop
    execute format('create trigger %I before insert or update on %I for each row execute function fv2_bloquear_identidade_de_automacao()', t || '_sem_automacao', t);
  end loop;
end $$;
create trigger fv2_obrigacao_sem_automacao before update on fv2_obrigacao for each row execute function fv2_bloquear_identidade_de_automacao();
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0026_entregadores_proprios.sql', '787d09876c61debe4c1d600862b80b482d7034a37c845596862383ee5d796312', '787d09876c61debe4c1d600862b80b482d7034a37c845596862383ee5d796312');

-- ------------------------------------------------------------------------- 0027_bloqueio_automacao_definer.sql (arquivo 957abaa956fbb97a0b39f4549e43647e798ba8badc268955713f40b97332f25e)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0027: BLOQUEIO DA IDENTIDADE TÉCNICA independente de quem grava
--
-- Problema: o gatilho da 0026 consultava a sessão com os privilégios de quem gravava. Papéis sem acesso às sessões
-- (como o instalador) recebiam "permission denied" e não conseguiam criar a concessão técnica.
--
-- O que muda (e o que NÃO muda):
--   * A função do gatilho passa a rodar como fv2_guardiao, que já lê as sessões.
--   * Nenhum papel ganha acesso a fv2__sessao_vigente.
--   * A regra é a mesma: sessão da identidade técnica não altera as tabelas protegidas.
--   * Nenhum dado é alterado.
-- =====================================================================================================================

create or replace function fv2_bloquear_identidade_de_automacao() returns trigger
language plpgsql security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
begin
  if (select usuario_id from fv2__sessao_vigente()) = '00000000-0000-4000-8000-00000000e7e9'::uuid then
    raise exception 'FV2: a identidade técnica de entregadores não pode alterar %', tg_table_name using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
alter function fv2_bloquear_identidade_de_automacao() owner to fv2_guardiao;
revoke all on function fv2_bloquear_identidade_de_automacao() from public, fv2_app, fv2_autoridade;
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0027_bloqueio_automacao_definer.sql', '957abaa956fbb97a0b39f4549e43647e798ba8badc268955713f40b97332f25e', '957abaa956fbb97a0b39f4549e43647e798ba8badc268955713f40b97332f25e');

-- ------------------------------------------------------------------------- 0028_leitor_mova.sql (arquivo 760ac6416ee6b357c2a55edf92a894e89aa0da151435bf06450ccc2813b40b6b)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0028: LEITOR DO MOVA (piloto de consultas pelo WhatsApp, Execução 16A)
--
-- O MOVA (assistente financeiro no WhatsApp) passa a LER o Financeiro v2 com uma credencial PRÓPRIA, que não escreve
-- nada. Três barreiras independentes:
--   1. Papel fv2_leitor_mova: só SELECT nas tabelas que a aplicação lê, e EXECUTE só nas funções de leitura.
--      Nenhum INSERT, UPDATE, DELETE ou TRUNCATE. Não emite sessão de outra pessoa (sem fv2_abrir_sessao).
--   2. fv2_abrir_sessao_mova: emite sessão SÓ para a identidade técnica do MOVA, SÓ na unidade onde ela tem concessão
--      ATIVA exatamente igual a ["financeiro_v2.ver"]. A sessão nasce com pode_escrever = false e vale 5 minutos.
--      RLS da sessão: só a organização e a unidade da sessão aparecem.
--   3. Gatilho em fv2_concessao: a identidade do MOVA nunca fica ATIVA com outra ação além de financeiro_v2.ver, mesmo
--      por engano de um administrador. Revogar continua sempre possível.
--
-- O que NÃO muda: nenhuma tabela, nenhum dado, nenhuma concessão existente e nenhum outro papel.
-- A credencial de LOGIN (papel com senha, membro de fv2_leitor_mova) é criada na implantação, fora desta migração.
-- =====================================================================================================================

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'fv2_leitor_mova') then
    create role fv2_leitor_mova nologin;
  end if;
end $$;
grant usage on schema financeiro_v2 to fv2_leitor_mova;

-- 1. SELECT só onde a aplicação já lê (RLS e a sessão decidem as linhas).
do $$ declare t record; begin
  for t in select c.oid::regclass as tab from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'financeiro_v2' and c.relkind in ('r', 'p', 'v') and has_table_privilege('fv2_app', c.oid, 'SELECT') loop
    execute format('grant select on %s to fv2_leitor_mova', t.tab);
  end loop;
end $$;

-- EXECUTE: funções comuns (SECURITY INVOKER: rodam com os privilégios do leitor, que não escreve) e só três funções
-- SECURITY DEFINER de leitura, usadas pelas políticas. Nenhuma função que grava (concessão, liberação, sessão alheia).
do $$ declare f record; begin
  for f in select p.oid::regprocedure as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'financeiro_v2' and has_function_privilege('fv2_app', p.oid, 'EXECUTE')
              and (not p.prosecdef or p.oid in ('financeiro_v2.fv2__sessao_vigente()'::regprocedure,
                                                'financeiro_v2.fv2_tem_acao(text[])'::regprocedure,
                                                'financeiro_v2.fv2_liberacao_estado(uuid, uuid)'::regprocedure)) loop
    execute format('grant execute on function %s to fv2_leitor_mova', f.fn);
  end loop;
end $$;

-- 2. Sessão do MOVA: identidade fixa, concessão somente-leitura, sem escrita, 5 minutos.
create function fv2_abrir_sessao_mova(p_organizacao uuid, p_unidade uuid) returns text
language plpgsql volatile security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
declare
  identidade constant uuid := '00000000-0000-4000-8000-00000000a0a0';
  acoes jsonb;
  token text := fv2__novo_token();
begin
  if p_organizacao is null or p_unidade is null then
    raise exception 'MOVA: sessão sem organização ou unidade.' using errcode = '22023';
  end if;
  if not exists (select 1 from fv2_escopo e where e.organizacao_id = p_organizacao and e.unidade_id = p_unidade) then
    raise exception 'Financeiro v2: escopo não configurado.' using errcode = 'FV020';
  end if;
  perform fv2__trava_concessoes(p_organizacao, p_unidade, false);
  select c.acoes into acoes from fv2_concessao c
   where c.organizacao_id = p_organizacao and c.unidade_id = p_unidade and c.usuario_id = identidade and c.situacao = 'ATIVA';
  if acoes is distinct from '["financeiro_v2.ver"]'::jsonb then
    raise exception 'MOVA: sem concessão somente-leitura ativa nesta unidade.' using errcode = 'FV020';
  end if;
  insert into fv2_sessao_banco (token_hash, usuario_id, organizacao_id, unidade_id, finalidade, pode_escrever, referencia, expira_em)
  values (sha256(convert_to(token, 'UTF8')), identidade, p_organizacao, p_unidade, 'OPERACAO', false, 'automacao:mova',
          clock_timestamp() + interval '300 seconds');
  return token;
end $$;
alter function fv2_abrir_sessao_mova(uuid, uuid) owner to fv2_guardiao;
revoke all on function fv2_abrir_sessao_mova(uuid, uuid) from public;
grant execute on function fv2_abrir_sessao_mova(uuid, uuid) to fv2_leitor_mova;

-- 3. A identidade do MOVA só pode ter financeiro_v2.ver (inclusive em concessões futuras).
create function fv2_mova_somente_leitura() returns trigger language plpgsql as $$
begin
  -- Só concessão ATIVA: revogar (ações vazias, situação diferente de ATIVA) continua sempre possível.
  if new.usuario_id = '00000000-0000-4000-8000-00000000a0a0'::uuid and new.situacao = 'ATIVA'
     and new.acoes is distinct from '["financeiro_v2.ver"]'::jsonb then
    raise exception 'FV2: a identidade do MOVA só pode ter financeiro_v2.ver.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_concessao_mova_somente_leitura before insert or update on fv2_concessao
  for each row execute function fv2_mova_somente_leitura();
revoke all on function fv2_mova_somente_leitura() from public;
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0028_leitor_mova.sql', '760ac6416ee6b357c2a55edf92a894e89aa0da151435bf06450ccc2813b40b6b', '760ac6416ee6b357c2a55edf92a894e89aa0da151435bf06450ccc2813b40b6b');

-- ------------------------------------------------------------------------- 0029_pagamento_por_comprovante.sql (arquivo 9d071a32523aaa71ab1f9792cb4d002ba34222bafcb4814c8108a621113ab679)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0029: PAGAMENTO POR COMPROVANTE × CONCILIAÇÃO COM O EXTRATO — Execução 17
--
-- Espelho de aplicacao/baixaPorComprovante.js. Duas dimensões independentes:
--   * PAGAMENTO registrado por COMPROVANTE: liquidação de conta a pagar SEM movimentação bancária (movimentacao_id nulo),
--     marcada `extras.origemDoVinculo = 'COMPROVANTE'` e com `extras.documentoId` de um documento COMPROVANTE da unidade.
--     Nenhuma saída é inventada: saldo de banco e fluxo realizado só mudam quando o extrato chega.
--   * CONCILIAÇÃO: a saída do extrato é LIGADA à mesma liquidação (movimentacao_id passa de nulo para a saída, uma única
--     vez, sem mudar valor, conta ou data). Nunca segunda liquidação, segunda saída ou despesa.
-- Ação nova `financeiro_v2.baixar_por_comprovante` (MIGRAÇÃO RESTRITIVA: nenhuma concessão existente a recebe). Conciliar
-- usa `financeiro_v2.vincular_pagamento` (0018). Quem só baixa por comprovante NÃO grava liquidação com saída, nem
-- movimentação, lançamento ou conta nova.
-- Políticas são AMPLIADAS a partir da expressão atual (pg_policy), sem reescrever as regras das migrações anteriores.
-- =====================================================================================================================

-- 1) Liquidação sem movimentação: só pagamento por comprovante de conta a pagar, com documento.
alter table fv2_liquidacao alter column movimentacao_id drop not null;
alter table fv2_liquidacao add constraint fv2_liquidacao_sem_movimentacao check (
  movimentacao_id is not null
  or (alvo_tipo = 'OBRIGACAO' and extras->>'origemDoVinculo' = 'COMPROVANTE' and (extras->>'documentoId') is not null));

-- 2) Catálogo do banco.
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir",
  "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento",
  "financeiro_v2.baixar_por_comprovante"]'::jsonb);

-- 3) Políticas: acrescenta a ação às expressões ATUAIS (USING de alteração para alcançar as linhas; WITH CHECK do que grava).
do $$
declare
  r record;
  expr text;
begin
  for r in select * from (values
      ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'using', 'baixar_por_comprovante'),
      ('fv2_liquidacao', 'fv2_liquidacao_alterar', 'using', 'baixar_por_comprovante'),
      ('fv2_movimentacao', 'fv2_movimentacao_alterar', 'using', 'baixar_por_comprovante'),
      ('fv2_documento', 'fv2_documento_alterar', 'using', 'baixar_por_comprovante'),
      ('fv2_liquidacao', 'fv2_liquidacao_incluir', 'check', 'baixar_por_comprovante'),
      ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'check', 'baixar_por_comprovante'),
      ('fv2_vinculo_documental', 'fv2_vinculo_documental_incluir', 'check', 'baixar_por_comprovante'),
      ('fv2_historico', 'fv2_historico_incluir', 'check', 'baixar_por_comprovante'),
      -- conciliar o pagamento por comprovante = ligar a saída à liquidação existente (alteração da liquidação)
      ('fv2_liquidacao', 'fv2_liquidacao_alterar', 'check', 'vincular_pagamento')
    ) as v(tabela, politica, parte, acao) loop
    select case r.parte when 'using' then pg_get_expr(p.polqual, p.polrelid) else pg_get_expr(p.polwithcheck, p.polrelid) end into expr
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = current_schema() and c.relname = r.tabela and p.polname = r.politica;
    if expr is null then
      raise exception 'Financeiro v2 0029: política %.% (%) não encontrada.', r.tabela, r.politica, r.parte;
    end if;
    execute format('alter policy %I on %I %s ((%s) or (select fv2_tem_acao(array[%L])))', r.politica, r.tabela,
      case r.parte when 'using' then 'using' else 'with check' end, expr, 'financeiro_v2.' || r.acao);
  end loop;
end $$;

-- 4) A barreira da 0018 (quem só vincula) não se aplica à liquidação SEM movimentação: essa é tratada abaixo.
create or replace function fv2_vinculo_extrato_liquidacao() returns trigger language plpgsql as $$
declare
  m record;
  xid_atual text := (pg_current_xact_id()::text::bigint % 4294967296)::text;
begin
  if not fv2_so_vincula() then
    return new;
  end if;
  if new.movimentacao_id is null then
    return new; -- pagamento por comprovante (0029)
  end if;
  if new.alvo_tipo <> 'OBRIGACAO' then
    raise exception 'Financeiro v2: vincular pagamento do extrato só baixa conta a pagar.' using errcode = '42501';
  end if;
  select x.*, x.xmin::text as criada_em_xid into m from fv2_movimentacao x
   where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.movimentacao_id;
  if not found or m.sentido <> 'SAIDA' or m.situacao <> 'VALIDA' or m.transferencia_id is not null or m.pagamento_id is not null
     or m.estorno_id is not null or m.natureza in ('DEVOLUCAO', 'TRANSFERENCIA_INTERNA') then
    raise exception 'Financeiro v2: a baixa por extrato exige uma saída válida, que não seja transferência nem devolução.' using errcode = '42501';
  end if;
  if m.criada_em_xid = xid_atual then
    raise exception 'Financeiro v2: vincular pagamento do extrato usa saída JÁ registrada — não cria saída nova.' using errcode = '42501';
  end if;
  if coalesce(new.extras->>'origemDoVinculo', '') <> 'EXTRATO' then
    raise exception 'Financeiro v2: liquidação gravada por vincular_pagamento precisa ser marcada como vínculo de extrato.' using errcode = '42501';
  end if;
  if new.extras->>'documentoId' is null and not exists (
    select 1 from fv2_correspondencia c
     where c.organizacao_id = new.organizacao_id and c.unidade_id = new.unidade_id and c.situacao = 'CONFIRMADA'
       and cardinality(c.evidencia_documento_ids) > 0
       and (c.lado_a || c.lado_b) @> jsonb_build_array(jsonb_build_object('tipo', 'MOVIMENTACAO', 'id', new.movimentacao_id::text))
       and (c.lado_a || c.lado_b) @> jsonb_build_array(jsonb_build_object('tipo', 'OBRIGACAO', 'id', new.alvo_id::text))) then
    raise exception 'Financeiro v2: a baixa por extrato exige documento que comprove o pagamento ou conciliação confirmada com evidência.' using errcode = '42501';
  end if;
  return new;
end $$;

-- 5) Pagamento por comprovante e sua conciliação, para QUALQUER gravador (exceto o superusuário de manutenção).
create or replace function fv2_pagamento_por_comprovante() returns trigger language plpgsql as $$
declare
  tipo_doc text;
  m record;
  livres text[] := array['versao', 'atualizado_em', 'atualizado_por', 'extras', 'movimentacao_id'];
  so_documental boolean;
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    return new;
  end if;
  so_documental := not fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.aplicar', 'financeiro_v2.vincular_pagamento', 'financeiro_v2.cancelar']);
  if tg_op = 'INSERT' then
    if new.movimentacao_id is not null then
      if so_documental then
        raise exception 'Financeiro v2: quem só baixa por comprovante não grava liquidação com saída bancária.' using errcode = '42501';
      end if;
      return new;
    end if;
    if new.alvo_tipo <> 'OBRIGACAO' or coalesce(new.extras->>'origemDoVinculo', '') <> 'COMPROVANTE' then
      raise exception 'Financeiro v2: liquidação sem saída bancária só para pagamento de conta por comprovante.' using errcode = '42501';
    end if;
    select d.tipo into tipo_doc from fv2_documento d
     where d.organizacao_id = new.organizacao_id and d.unidade_id = new.unidade_id and d.id = (new.extras->>'documentoId')::uuid;
    if tipo_doc is distinct from 'COMPROVANTE' then
      raise exception 'Financeiro v2: pagamento sem extrato exige um documento COMPROVANTE desta unidade.' using errcode = '42501';
    end if;
    if new.data_efetiva > current_date + 1 then
      raise exception 'Financeiro v2: pagamento por comprovante não pode ter data futura (agendamento não é pagamento).' using errcode = '42501';
    end if;
    return new;
  end if;
  -- UPDATE
  if old.movimentacao_id is not null and new.movimentacao_id is distinct from old.movimentacao_id then
    raise exception 'Financeiro v2: a saída de uma liquidação não se troca.' using errcode = '42501';
  end if;
  if old.movimentacao_id is null and new.movimentacao_id is not null then
    if (to_jsonb(old) - livres) is distinct from (to_jsonb(new) - livres)
       or coalesce(new.extras->>'origemDoVinculo', '') <> 'COMPROVANTE'
       or (old.extras->'documentoId') is distinct from (new.extras->'documentoId') then
      raise exception 'Financeiro v2: conciliar o pagamento por comprovante só liga a saída do extrato (nada mais muda).' using errcode = '42501';
    end if;
    select x.* into m from fv2_movimentacao x
     where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.movimentacao_id;
    if not found or m.sentido <> 'SAIDA' or m.situacao <> 'VALIDA' or m.transferencia_id is not null or m.pagamento_id is not null
       or m.estorno_id is not null or m.natureza in ('DEVOLUCAO', 'TRANSFERENCIA_INTERNA')
       or m.valor_centavos <> new.valor_centavos - new.estornado_centavos then
      raise exception 'Financeiro v2: a conciliação exige saída válida do extrato com o valor do pagamento.' using errcode = '42501';
    end if;
    return new;
  end if;
  -- Quem só vincula (ou só baixa por comprovante) não altera liquidação por outro motivo.
  if fv2_so_vincula() and (to_jsonb(old) - array['versao', 'atualizado_em', 'atualizado_por']) is distinct from (to_jsonb(new) - array['versao', 'atualizado_em', 'atualizado_por']) then
    raise exception 'Financeiro v2: sem permissão para alterar esta liquidação além da conciliação.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_liquidacao_por_comprovante before insert or update on fv2_liquidacao for each row execute function fv2_pagamento_por_comprovante();

-- 6) Conservação (0001): a liquidação SEM movimentação só confere o título; com movimentação, também o alocado da saída.
create or replace function fv2_tg_liquidacao() returns trigger language plpgsql as $$
begin
  perform fv2_conferir_titulo(new.organizacao_id, new.unidade_id, new.alvo_tipo, new.alvo_id);
  if new.movimentacao_id is not null then
    perform fv2_conferir_movimentacao(new.organizacao_id, new.unidade_id, new.movimentacao_id);
  end if;
  return null;
end $$;
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0029_pagamento_por_comprovante.sql', '9d071a32523aaa71ab1f9792cb4d002ba34222bafcb4814c8108a621113ab679', '9d071a32523aaa71ab1f9792cb4d002ba34222bafcb4814c8108a621113ab679');

-- ------------------------------------------------------------------------- 0030_registrar_obrigacao_documental.sql (arquivo 2d39204d2d2de6f3806266e1ab2c1c45129ce62d61b3b8ec91a0f54574a83e09)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0030: CONTA A PAGAR A PARTIR DE DOCUMENTO com ação ESTREITA — Agente 2 (23/11/2026)
--
-- Espelho de economico.registrarObrigacaoDocumental. Ação nova `financeiro_v2.registrar_obrigacao` (MIGRAÇÃO RESTRITIVA:
-- nenhuma concessão existente a recebe). Quem SÓ tem esta ação (sem registrar/aplicar/corrigir/cancelar/conciliar) grava:
--   * UM lançamento de DESPESA, ativo, com origem OBRIGACAO, criado na MESMA transação da obrigação;
--   * a obrigação de UMA parcela, sem recorrência, em aberto, apontando para esse lançamento (o documento entra pelo vínculo
--     documental logo depois; o pagamento por comprovante exige o COMPROVANTE — 0029);
--   * a contraparte nova do formulário, o histórico e o vínculo documental dessa operação.
-- Nada de movimentação, liquidação, receita, dedução, patrimonial, conta, categoria ou alteração de registro existente: as
-- políticas de ALTERAÇÃO não são ampliadas. Políticas ampliadas a partir da expressão ATUAL (pg_policy).
-- =====================================================================================================================

-- 1) Catálogo do banco.
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir",
  "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento",
  "financeiro_v2.baixar_por_comprovante", "financeiro_v2.registrar_obrigacao"]'::jsonb);

-- 2) Políticas de INCLUSÃO: acrescenta a ação às expressões ATUAIS.
do $$
declare
  r record;
  expr text;
begin
  for r in select * from (values
      ('fv2_lancamento', 'fv2_lancamento_incluir'),
      ('fv2_obrigacao', 'fv2_obrigacao_incluir'),
      ('fv2_contraparte', 'fv2_contraparte_incluir'),
      ('fv2_vinculo_documental', 'fv2_vinculo_documental_incluir'),
      ('fv2_historico', 'fv2_historico_incluir')
    ) as v(tabela, politica) loop
    select pg_get_expr(p.polwithcheck, p.polrelid) into expr
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = current_schema() and c.relname = r.tabela and p.polname = r.politica;
    if expr is null then
      raise exception 'Financeiro v2 0030: política %.% não encontrada.', r.tabela, r.politica;
    end if;
    execute format('alter policy %I on %I with check ((%s) or (select fv2_tem_acao(array[%L])))', r.politica, r.tabela, expr, 'financeiro_v2.registrar_obrigacao');
  end loop;
end $$;

-- 3) Quem SÓ registra obrigação por documento: o banco confere a forma do que é gravado (qualquer gravador não superusuário).
create or replace function fv2_so_registra_obrigacao() returns boolean language sql stable as $$
  select not (select rolsuper from pg_roles where rolname = current_user)
     and fv2_tem_acao(array['financeiro_v2.registrar_obrigacao'])
     and not fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.aplicar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar'])
$$;

create or replace function fv2_obrigacao_documental() returns trigger language plpgsql as $$
declare
  l record;
  xid_atual text := (pg_current_xact_id()::text::bigint % 4294967296)::text;
begin
  if not fv2_so_registra_obrigacao() then
    return new;
  end if;
  if tg_table_name = 'fv2_lancamento' then
    if new.natureza <> 'DESPESA' or new.situacao <> 'ATIVO' or new.valor_centavos <= 0 or new.origem->>'tipo' <> 'OBRIGACAO' or new.retido_no_repasse then
      raise exception 'Financeiro v2: por documento só se registra lançamento de DESPESA nascido de conta a pagar.' using errcode = '42501';
    end if;
    return new;
  end if;
  -- fv2_obrigacao
  if (new.parcela->>'total')::int <> 1 or new.recorrencia is not null or new.situacao <> 'ABERTA' or new.liquidado_centavos <> 0 or new.ajustes_centavos <> 0 then
    raise exception 'Financeiro v2: conta a pagar por documento tem uma parcela, sem repetição e em aberto.' using errcode = '42501';
  end if;
  select x.*, x.xmin::text as criado_em_xid into l from fv2_lancamento x
   where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.lancamento_id;
  if not found or l.criado_em_xid <> xid_atual or l.origem->>'id' <> new.grupo_id::text or l.valor_centavos <> new.valor_base_centavos then
    raise exception 'Financeiro v2: a conta a pagar por documento aponta para o lançamento criado com ela (mesma transação e valor).' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_lancamento_documental before insert on fv2_lancamento for each row execute function fv2_obrigacao_documental();
create trigger fv2_obrigacao_documental before insert on fv2_obrigacao for each row execute function fv2_obrigacao_documental();
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0030_registrar_obrigacao_documental.sql', '2d39204d2d2de6f3806266e1ab2c1c45129ce62d61b3b8ec91a0f54574a83e09', '2d39204d2d2de6f3806266e1ab2c1c45129ce62d61b3b8ec91a0f54574a83e09');

-- ------------------------------------------------------------------------- 0031_registrar_juros_no_pagamento.sql (arquivo 7deef8e2183cb59df0bce45fa8a30d0d7edc5bb7f135ce3ecd9388de22e93e1b)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0031: ENCARGO (JUROS/MULTA) NO PAGAMENTO POR COMPROVANTE com ação ESTREITA — 23/11/2026
--
-- Espelho de baixaPorComprovante.registrarPagamentoComEncargo. Ação nova `financeiro_v2.registrar_juros` (MIGRAÇÃO
-- RESTRITIVA: nenhuma concessão existente a recebe). Ela NÃO é `corrigir`: só vale JUNTO com `baixar_por_comprovante` e, para
-- quem não tem as ações amplas (registrar, aplicar, corrigir, cancelar, conciliar), o banco confere a forma do que é gravado:
--   * UM lançamento de DESPESA, ativo, origem AJUSTE, na categoria oficial JUROS_E_MULTAS_DE_FORNECEDORES;
--   * UM ajuste de conta a pagar (OBRIGACAO), positivo, de no máximo 10% do valor base da conta, apontando para esse lançamento.
-- Nada de movimentação, receita, conta, categoria nova ou alteração de outro registro. Políticas ampliadas a partir da
-- expressão ATUAL (pg_policy), sem reescrever as regras das migrações anteriores.
-- =====================================================================================================================

-- 1) Catálogo do banco.
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir",
  "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento",
  "financeiro_v2.baixar_por_comprovante", "financeiro_v2.registrar_obrigacao", "financeiro_v2.registrar_juros"]'::jsonb);

-- 2) Políticas de INCLUSÃO: acrescenta a ação às expressões ATUAIS.
do $$
declare
  r record;
  expr text;
begin
  for r in select * from (values
      ('fv2_lancamento', 'fv2_lancamento_incluir'),
      ('fv2_ajuste', 'fv2_ajuste_incluir'),
      ('fv2_historico', 'fv2_historico_incluir')
    ) as v(tabela, politica) loop
    select pg_get_expr(p.polwithcheck, p.polrelid) into expr
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = current_schema() and c.relname = r.tabela and p.polname = r.politica;
    if expr is null then
      raise exception 'Financeiro v2 0031: política %.% não encontrada.', r.tabela, r.politica;
    end if;
    execute format('alter policy %I on %I with check ((%s) or (select fv2_tem_acao(array[%L])))', r.politica, r.tabela, expr, 'financeiro_v2.registrar_juros');
  end loop;
end $$;

-- 3) Quem tem `registrar_juros` e NENHUMA ação ampla: o banco confere a forma do encargo gravado.
create or replace function fv2_so_registra_juros() returns boolean language sql stable as $$
  select not (select rolsuper from pg_roles where rolname = current_user)
     and fv2_tem_acao(array['financeiro_v2.registrar_juros'])
     and not fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.aplicar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar'])
$$;

create or replace function fv2_juros_documental() returns trigger language plpgsql as $$
declare
  o record;
  l record;
begin
  if not fv2_so_registra_juros() then
    return new;
  end if;
  if tg_table_name = 'fv2_lancamento' then
    if new.origem->>'tipo' is distinct from 'AJUSTE' then
      return new; -- outros lançamentos são decididos pelas políticas/gatilhos das demais ações
    end if;
    if new.natureza <> 'DESPESA' or new.situacao <> 'ATIVO' or new.valor_centavos <= 0 or new.categoria_codigo <> 'JUROS_E_MULTAS_DE_FORNECEDORES' or new.retido_no_repasse then
      raise exception 'Financeiro v2: o encargo do pagamento é uma despesa ativa na categoria oficial de juros e multas.' using errcode = '42501';
    end if;
    return new;
  end if;
  -- fv2_ajuste
  if new.alvo_tipo <> 'OBRIGACAO' or new.valor_centavos <= 0 or new.lancamento_id is null then
    raise exception 'Financeiro v2: o encargo é um ajuste positivo de conta a pagar, com seu lançamento.' using errcode = '42501';
  end if;
  select x.* into o from fv2_obrigacao x where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.alvo_id;
  select x.* into l from fv2_lancamento x where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.lancamento_id;
  if o.id is null or l.id is null or l.categoria_codigo <> 'JUROS_E_MULTAS_DE_FORNECEDORES' or l.valor_centavos <> new.valor_centavos then
    raise exception 'Financeiro v2: o encargo aponta para a conta e para o lançamento de juros e multas com o mesmo valor.' using errcode = '42501';
  end if;
  if new.valor_centavos * 10 > o.valor_base_centavos then
    raise exception 'Financeiro v2: encargo acima de 10%% do valor da conta exige uma pessoa autorizada.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_lancamento_juros before insert on fv2_lancamento for each row execute function fv2_juros_documental();
create trigger fv2_ajuste_juros before insert on fv2_ajuste for each row execute function fv2_juros_documental();

-- 4) O gatilho da 0030 (quem só registra obrigação) não pode barrar o lançamento do ENCARGO de quem também tem `registrar_juros`:
--    esse caso é conferido pelo gatilho acima.
create or replace function fv2_obrigacao_documental() returns trigger language plpgsql as $$
declare
  l record;
  xid_atual text := (pg_current_xact_id()::text::bigint % 4294967296)::text;
begin
  if not fv2_so_registra_obrigacao() then
    return new;
  end if;
  if tg_table_name = 'fv2_lancamento' then
    if new.origem->>'tipo' = 'AJUSTE' and fv2_tem_acao(array['financeiro_v2.registrar_juros']) then
      return new; -- encargo do pagamento (0031): forma conferida por fv2_juros_documental
    end if;
    if new.natureza <> 'DESPESA' or new.situacao <> 'ATIVO' or new.valor_centavos <= 0 or new.origem->>'tipo' <> 'OBRIGACAO' or new.retido_no_repasse then
      raise exception 'Financeiro v2: por documento só se registra lançamento de DESPESA nascido de conta a pagar.' using errcode = '42501';
    end if;
    return new;
  end if;
  -- fv2_obrigacao
  if (new.parcela->>'total')::int <> 1 or new.recorrencia is not null or new.situacao <> 'ABERTA' or new.liquidado_centavos <> 0 or new.ajustes_centavos <> 0 then
    raise exception 'Financeiro v2: conta a pagar por documento tem uma parcela, sem repetição e em aberto.' using errcode = '42501';
  end if;
  select x.*, x.xmin::text as criado_em_xid into l from fv2_lancamento x
   where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.lancamento_id;
  if not found or l.criado_em_xid <> xid_atual or l.origem->>'id' <> new.grupo_id::text or l.valor_centavos <> new.valor_base_centavos then
    raise exception 'Financeiro v2: a conta a pagar por documento aponta para o lançamento criado com ela (mesma transação e valor).' using errcode = '42501';
  end if;
  return new;
end $$;

-- 5) A barreira da 0018 (quem não tem ações amplas só muda a POSIÇÃO da conta) ganha UMA exceção estreita: com `registrar_juros`, a
--    conta pode receber o ajuste do encargo — `ajustes_centavos` e `saldo_centavos` sobem, na MESMA transação do registro de ajuste
--    (a soma dos ajustes da conta precisa bater, como na 0010), sem reduzir, sem trocar a situação e sem mudar mais nada.
create or replace function fv2_vinculo_extrato_posicao() returns trigger language plpgsql as $$
declare
  livres text[] := array['versao', 'atualizado_em', 'atualizado_por', 'extras'] || tg_argv[0]::text[];
  soma bigint;
  so_encargo boolean := false;
begin
  if not fv2_so_vincula() then
    return new;
  end if;
  if tg_table_name = 'fv2_obrigacao' and fv2_tem_acao(array['financeiro_v2.registrar_juros'])
     and (to_jsonb(new)->>'ajustes_centavos') is distinct from (to_jsonb(old)->>'ajustes_centavos') then
    select coalesce(sum(a.valor_centavos), 0) into soma from fv2_ajuste a
     where a.organizacao_id = new.organizacao_id and a.unidade_id = new.unidade_id and a.alvo_id = new.id;
    if soma <> (to_jsonb(new)->>'ajustes_centavos')::bigint
       or (to_jsonb(new)->>'ajustes_centavos')::bigint < (to_jsonb(old)->>'ajustes_centavos')::bigint
       or new.situacao is distinct from old.situacao then
      raise exception 'Financeiro v2: o encargo só soma à conta o ajuste registrado com ele, sem reduzir nem mudar a situação.' using errcode = '42501';
    end if;
    livres := livres || array['ajustes_centavos', 'saldo_centavos'];
    so_encargo := true;
  end if;
  if (to_jsonb(old) - livres) is distinct from (to_jsonb(new) - livres) then
    raise exception 'Financeiro v2: vincular pagamento do extrato só muda a posição (alocado/pago/saldo), nada mais.' using errcode = '42501';
  end if;
  if (to_jsonb(new)->>tg_argv[1])::bigint < (to_jsonb(old)->>tg_argv[1])::bigint then
    raise exception 'Financeiro v2: vincular pagamento do extrato não desfaz baixas (use o estorno, com a permissão própria).' using errcode = '42501';
  end if;
  -- Na conta, a situação resultante de uma baixa só pode ser parcial ou quitada (nunca cancelar ou reabrir); o encargo não muda a situação.
  if tg_table_name = 'fv2_obrigacao' and not so_encargo and (to_jsonb(new)->>'situacao') not in ('PARCIAL', 'QUITADA') then
    raise exception 'Financeiro v2: vincular pagamento do extrato só deixa a conta parcial ou quitada.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0031_registrar_juros_no_pagamento.sql', '7deef8e2183cb59df0bce45fa8a30d0d7edc5bb7f135ce3ecd9388de22e93e1b', '7deef8e2183cb59df0bce45fa8a30d0d7edc5bb7f135ce3ecd9388de22e93e1b');

-- ======================================================== A5: nenhuma função do módulo executável por PUBLIC
do $$ declare f record; begin
  -- A5 (auditoria A-1): nenhuma função do módulo fica executável por PUBLIC (o padrão do PostgreSQL). Quem tinha o
  -- EXECUTE de PUBLIC passa a ter EXECUTE só para os três papéis do módulo; as funções protegidas já sem PUBLIC ficam
  -- exatamente como as migrações deixaram.
  for f in select p.oid::regprocedure as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'financeiro_v2' and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0 and x.privilege_type = 'EXECUTE') loop
    execute format('grant execute on function %s to fv2_app, fv2_autoridade, fv2_guardiao', f.fn);
    execute format('revoke execute on function %s from public', f.fn);
  end loop;
end $$;

-- ======================================================================= A5: revogação explícita (Agente 2, A-1)
-- Privilégio padrão GLOBAL do executor (sem IN SCHEMA) não se revoga por schema e daria às credenciais comuns acesso
-- aos objetos criados acima. Não se confia só na falta de USAGE: retira-se tudo explicitamente. As funções protegidas
-- são do guardião: a revogação usa a MESMA participação temporária da A3, desfeita na sequência.
grant fv2_guardiao to current_user;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated','service_role','authenticator'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema financeiro_v2 from %I', r);
      execute format('revoke all on all sequences in schema financeiro_v2 from %I', r);
      execute format('revoke all on all functions in schema financeiro_v2 from %I', r);
    end if;
  end loop;
end $$;
revoke fv2_guardiao from current_user;

-- ===================================================================================== pós-condições (abortam)
do $$
declare n int; txt text;
begin
  select count(*) into n from financeiro_v2.fv2_migracao;
  if n <> 31 then raise exception 'FV2 pós: % migrações registradas (esperado 31)', n; end if;
  -- nada do módulo fora do schema dedicado
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace where c.relname like 'fv2\_%' and s.nspname <> 'financeiro_v2' and s.nspname not like 'pg\_%';
  if n > 0 then raise exception 'FV2 pós: % relações fv2_* fora do schema', n; end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where p.proname like 'fv2\_%' and s.nspname <> 'financeiro_v2';
  if n > 0 then raise exception 'FV2 pós: % funções fv2_* fora do schema', n; end if;
  -- RLS forçada em todas as tabelas de dados (as 5 GUARDADAS não têm RLS por desenho e nenhum papel além do guardião as acessa)
  select string_agg(c.relname, ', ') into txt from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'financeiro_v2' and c.relkind = 'r' and c.relname <> 'fv2_migracao'
      and c.relname not in ('fv2_auditoria_concessao','fv2_liberacao','fv2_liberacao_historico','fv2_administrador_corporativo','fv2_administrador_corporativo_historico','fv2_provisionamento_inicial','fv2_sessao_banco')
      and not (c.relrowsecurity and c.relforcerowsecurity);
  if txt is not null then raise exception 'FV2 pós: tabelas sem RLS forçada: %', txt; end if;
  -- credenciais comuns sem nenhum caminho
  select string_agg(r, ', ') into txt from unnest(array['anon','authenticated','service_role','authenticator']) r
    where exists (select 1 from pg_roles where rolname = r) and has_schema_privilege(r, 'financeiro_v2', 'usage');
  if txt is not null then raise exception 'FV2 pós: USAGE no schema para %', txt; end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace,
    unnest(array['anon','authenticated','service_role','authenticator','fv2_app','fv2_autoridade']) g(r)
    where s.nspname = 'financeiro_v2' and exists (select 1 from pg_roles where rolname = g.r)
      and c.relname in ('fv2_auditoria_concessao','fv2_liberacao','fv2_liberacao_historico','fv2_administrador_corporativo','fv2_administrador_corporativo_historico','fv2_provisionamento_inicial','fv2_sessao_banco')
      and (has_table_privilege(g.r, c.oid, 'select') or has_table_privilege(g.r, c.oid, 'insert') or has_table_privilege(g.r, c.oid, 'update') or has_table_privilege(g.r, c.oid, 'delete'));
  if n > 0 then raise exception 'FV2 pós: tabela guardada acessível por papel não autorizado (% casos)', n; end if;
  -- A5: NENHUM privilégio de credencial comum em tabela, sequência ou função do schema (não só falta de USAGE).
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace,
    lateral aclexplode(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) x
    where s.nspname = 'financeiro_v2' and c.relkind in ('r','p','v','m','S')
      and (x.grantee = 0 or pg_get_userbyid(x.grantee) in ('anon','authenticated','service_role','authenticator'));
  if n > 0 then raise exception 'FV2 pós: % privilégio(s) de PUBLIC ou credencial comum em tabela/sequência do schema', n; end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace,
    lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
    where s.nspname = 'financeiro_v2' and pg_get_userbyid(x.grantee) in ('anon','authenticated','service_role','authenticator');
  if n > 0 then raise exception 'FV2 pós: % EXECUTE concedido a credencial comum em função do schema', n; end if;
  -- A-2: nenhuma tabela do v2 em publicação de replicação.
  select count(*) into n from pg_publication_tables where schemaname = 'financeiro_v2';
  if n > 0 then raise exception 'FV2 pós: % tabela(s) do v2 em publicação de replicação', n; end if;
  -- funções protegidas: dono guardião, search_path no schema, sem EXECUTE para PUBLIC nem credenciais comuns
  select string_agg(p.oid::regprocedure::text, ', ') into txt from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'financeiro_v2' and p.prosecdef and (
      pg_get_userbyid(p.proowner) <> 'fv2_guardiao'
      or not (p.proconfig::text like '%search_path=pg_catalog, financeiro_v2, pg_temp%')
      or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0 and x.privilege_type = 'EXECUTE')
      or exists (select 1 from unnest(array['anon','authenticated','service_role']) g(r) where exists (select 1 from pg_roles where rolname = g.r) and has_function_privilege(g.r, p.oid, 'execute')));
  if txt is not null then raise exception 'FV2 pós: função protegida fora da regra: %', txt; end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'financeiro_v2' and p.prosecdef;
  if n < 8 then raise exception 'FV2 pós: só % funções protegidas (esperado ≥ 8)', n; end if;
  -- A-1: NENHUMA função do schema (protegida ou não) executável pelas credenciais comuns
  select string_agg(p.oid::regprocedure::text || ':' || g.r, ', ') into txt from pg_proc p join pg_namespace s on s.oid = p.pronamespace,
    unnest(array['anon','authenticated','service_role','authenticator']) g(r)
    where s.nspname = 'financeiro_v2' and exists (select 1 from pg_roles where rolname = g.r) and has_function_privilege(g.r, p.oid, 'execute');
  if txt is not null then raise exception 'FV2 pós: função executável por credencial comum: %', txt; end if;
  -- A-2: nenhuma tabela do módulo em publicação de replicação/tempo real
  select count(*) into n from pg_publication_tables where schemaname = 'financeiro_v2';
  if n > 0 then raise exception 'FV2 pós: % tabelas do módulo em publicação de replicação', n; end if;
  -- guardião: nenhum membro com SET ou INHERIT; sem CREATE no schema
  select count(*) into n from pg_auth_members m join pg_roles r on r.oid = m.roleid where r.rolname = 'fv2_guardiao' and (m.set_option or m.inherit_option);
  if n > 0 then raise exception 'FV2 pós: guardião com participação utilizável'; end if;
  if has_schema_privilege('fv2_guardiao', 'financeiro_v2', 'create') then raise exception 'FV2 pós: guardião com CREATE no schema'; end if;
  -- nenhum papel de LOGIN criado aqui (os de conexão são criados depois, por decisão própria, com senha fora do Git)
  select count(*) into n from pg_roles where rolname like 'fv2\_%' and rolcanlogin;
  if n > 0 then raise exception 'FV2 pós: papel fv2_* com login'; end if;
end $$;
