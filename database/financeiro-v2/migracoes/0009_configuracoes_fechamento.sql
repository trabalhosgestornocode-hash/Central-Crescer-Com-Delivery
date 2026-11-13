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
