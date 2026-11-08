-- =====================================================================
-- 153 — Financeiro 2.0: FATURAMENTO POR CANAL e AJUSTES até a base gerencial.
-- NÃO APLICADA EM PRODUÇÃO (preparada e testada só em banco local descartável). Aplicar em produção é decisão do responsável.
-- Mesmo modelo de privilégios da 151/152: backend-only, RLS sem policy, sem DELETE, escopo de tenant e trilha imutável.
--
--   • fin_vendas_canal: total por CANAL e competência, com a granularidade DECLARADA ('mensal' ou 'diaria'). Dado mensal fica identificado
--     como consolidação mensal: o sistema nunca fabrica vendas diárias a partir de total mensal.
--     valor_painel = total do relatório/painel de origem (ex.: SAIPOS); valor_gerencial = base usada na DRE gerencial.
--   • fin_vendas_ajustes: cada ajuste que leva o painel à base gerencial (taxa de entrega, desconto, estimativa...), com estado
--     'confirmado' ou 'estimado' (estimado = pendente de confirmação por responsável). NÃO é taxa financeira nem dedução da DRE: é a
--     reconciliação entre dois totais de vendas. Σ(painel) + Σ(ajustes) = Σ(gerencial) é conferido pela aplicação e exposto, não imposto aqui.
-- Não altera fin_referencias (faturamento oficial diário) nem cria recebimento bancário.
-- Idempotente. Rollback: 153_rollback.sql (recusa se houver dados).
-- =====================================================================
begin;
set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.fin_obrigacoes') is null or to_regprocedure('public.fin_auditar()') is null or to_regprocedure('public.fin_validar_escopo()') is null then
    raise exception 'MIGRATION 153 abortada: requer as migrations 120, 121, 122, 151 e 152 aplicadas.';
  end if;
end $$;

create table if not exists fin_vendas_canal (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  competencia date not null check (competencia = date_trunc('month', competencia)::date),
  granularidade text not null default 'mensal' check (granularidade in ('mensal', 'diaria')),
  canal text not null check (length(btrim(canal)) between 1 and 60),
  origem_tecnica text check (origem_tecnica is null or length(origem_tecnica) <= 120),
  vendas_qtd integer check (vendas_qtd is null or vendas_qtd >= 0),
  valor_painel_centavos bigint not null check (valor_painel_centavos >= 0),
  valor_gerencial_centavos bigint not null check (valor_gerencial_centavos >= 0),
  fonte text not null check (length(btrim(fonte)) between 1 and 120),
  observacao text check (observacao is null or length(observacao) <= 500),
  status text not null default 'ativa' check (status in ('ativa', 'cancelada')),
  motivo_cancelamento text, cancelado_por uuid, cancelado_em timestamptz,
  chave_origem text,
  criado_por uuid, atualizado_por uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint fin_vcanal_cancelamento check (status <> 'cancelada' or (cancelado_por is not null and cancelado_em is not null and length(btrim(coalesce(motivo_cancelamento, ''))) >= 5))
);
create unique index if not exists ux_fin_vendas_canal_ativo on fin_vendas_canal (organizacao_id, unidade_id, competencia, canal) where status = 'ativa';
create unique index if not exists ux_fin_vendas_canal_chave on fin_vendas_canal (organizacao_id, unidade_id, chave_origem) where chave_origem is not null and status = 'ativa';
create index if not exists ix_fin_vendas_canal_comp on fin_vendas_canal (organizacao_id, unidade_id, competencia);

create table if not exists fin_vendas_ajustes (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  competencia date not null check (competencia = date_trunc('month', competencia)::date),
  canal text not null check (length(btrim(canal)) between 1 and 60),
  tipo text not null check (tipo in ('estimativa', 'taxa_entrega', 'desconto', 'outro')),
  valor_centavos bigint not null check (valor_centavos <> 0),            -- com sinal: negativo reduz o painel até a base gerencial
  descricao text not null check (length(btrim(descricao)) between 3 and 300),
  estado text not null default 'estimado' check (estado in ('confirmado', 'estimado')),
  evidencia text check (evidencia is null or length(evidencia) <= 500),
  confirmado_por uuid, confirmado_em timestamptz,
  status text not null default 'ativa' check (status in ('ativa', 'cancelada')),
  motivo_cancelamento text, cancelado_por uuid, cancelado_em timestamptz,
  chave_origem text,
  criado_por uuid, atualizado_por uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint fin_vajuste_confirmacao check ((estado = 'confirmado') = (confirmado_por is not null and confirmado_em is not null)),
  constraint fin_vajuste_cancelamento check (status <> 'cancelada' or (cancelado_por is not null and cancelado_em is not null and length(btrim(coalesce(motivo_cancelamento, ''))) >= 5))
);
create unique index if not exists ux_fin_vendas_ajustes_chave on fin_vendas_ajustes (organizacao_id, unidade_id, chave_origem) where chave_origem is not null and status = 'ativa';
create index if not exists ix_fin_vendas_ajustes_comp on fin_vendas_ajustes (organizacao_id, unidade_id, competencia);

-- organização/unidade nunca mudam; confirmação não é desfeita
create or replace function fin2_vendas_canal_guarda() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (new.organizacao_id is distinct from old.organizacao_id or new.unidade_id is distinct from old.unidade_id or new.competencia is distinct from old.competencia) then
    raise exception 'fin_campo_imutavel: organizacao, unidade e competencia nao mudam (cancele e registre outro)' using errcode = '23514';
  end if;
  if tg_table_name = 'fin_vendas_ajustes' and tg_op = 'UPDATE' then
    -- (IF aninhado: o PL/pgSQL resolveria old.estado mesmo no gatilho da tabela de canais, que não tem essa coluna)
    if to_jsonb(old)->>'estado' = 'confirmado' and to_jsonb(new)->>'estado' is distinct from 'confirmado' then
      raise exception 'fin_campo_imutavel: ajuste confirmado nao volta a estimado (cancele e registre outro)' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['fin_vendas_canal', 'fin_vendas_ajustes'] loop
    execute format('drop trigger if exists trg_%1$s_guarda on %1$s', t);
    execute format('create trigger trg_%1$s_guarda before update on %1$s for each row execute function fin2_vendas_canal_guarda()', t);
    execute format('drop trigger if exists trg_%1$s_auditar on %1$s', t);
    execute format('create trigger trg_%1$s_auditar after insert or update or delete on %1$s for each row execute function fin_auditar()', t);
    execute format('drop trigger if exists trg_%1$s_escopo on %1$s', t);
    execute format('create trigger trg_%1$s_escopo before insert or update on %1$s for each row execute function fin_validar_escopo()', t);
  end loop;
end $$;

-- Transferência de unidades: tabelas novas com unidade_id entram na lista
create or replace function public.gestao_financeira_tabelas_da_unidade() returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array[
    'gestao_financeira_concessoes', 'gestao_financeira_concessoes_auditoria',                                     -- 120
    'fin_contas', 'fin_saldos_abertura', 'fin_lancamentos', 'fin_transferencias', 'fin_periodos', 'fin_importacoes',
    'fin_auditoria',                                                                                              -- 121
    'fin_referencias', 'fin_conciliacao_resolucoes', 'fin_sangria_excecoes', 'fin_excecoes_fechamento',           -- 122
    'fin_obrigacoes', 'fin_pagamentos', 'fin_conciliacao_saidas',                                                 -- 151
    'fin_rateios', 'fin_rateio_parcelas', 'fin_recebiveis', 'fin_recebimentos', 'fin_dividas', 'fin_divida_eventos', -- 152
    'fin_vendas_canal', 'fin_vendas_ajustes'                                                                      -- 153
  ]::text[]
$$;

-- Privilégios: backend-only. RLS ligada, NENHUMA policy, sem DELETE.
do $$
declare t text; r text;
begin
  foreach t in array array['fin_vendas_canal', 'fin_vendas_ajustes'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from public', t);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table %I from %I', t, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on table %I from service_role', t);
      execute format('grant select, insert, update on table %I to service_role', t);
    end if;
  end loop;
  execute 'revoke all on function fin2_vendas_canal_guarda() from public';
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function fin2_vendas_canal_guarda() from %I', r); end if;
  end loop;
end $$;

-- Pós-condições
do $$
declare t text;
begin
  foreach t in array array['fin_vendas_canal', 'fin_vendas_ajustes'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception '153 pós-condição: RLS desligada em %', t; end if;
    if exists (select 1 from pg_policies where tablename = t) then raise exception '153 pós-condição: % tem policy', t; end if;
    if t <> all (public.gestao_financeira_tabelas_da_unidade()) then raise exception '153 pós-condição: % fora da guarda de transferência', t; end if;
    if exists (select 1 from pg_roles where rolname = 'anon') and has_table_privilege('anon', 'public.' || t, 'select') then raise exception '153 pós-condição: anon lê %', t; end if;
  end loop;
end $$;
commit;
