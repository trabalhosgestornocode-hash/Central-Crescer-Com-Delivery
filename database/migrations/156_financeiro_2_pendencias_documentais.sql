-- =====================================================================
-- 156 — Financeiro 2.0: PENDÊNCIAS DOCUMENTAIS (cadastro manual na Central de Conferências).
-- NÃO APLICADA EM PRODUÇÃO (preparada e testada só em banco local descartável). Aplicar em produção é decisão do responsável.
-- Registra o que depende de comprovação, classificação ou aprovação (ex.: diferença de caixa sem destino) SEM criar movimentação financeira:
-- não toca em lançamentos, pagamentos, recebimentos nem conciliações. Mesmo modelo de privilégios da 151–155: backend-only, RLS sem policy,
-- sem DELETE (cancela-se com motivo), escopo de tenant e trilha imutável (fin_auditar).
--   • estado: 'pendente' | 'estimado' | 'aguardando_comprovacao' | 'confirmado'. 'confirmado' só com evidência + quem + quando (constraint).
--   • confirmado não volta atrás nem muda valor/descrição (gatilho); organização e unidade nunca mudam.
--   • chave_origem: idempotência do cadastro (único entre as ativas) para não duplicar.
-- Idempotente. Rollback: 156_rollback.sql (recusa se houver dados).
-- =====================================================================
begin;
set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.fin_vendas_ajustes') is null or to_regprocedure('public.fin_auditar()') is null or to_regprocedure('public.fin_validar_escopo()') is null
     or to_regclass('public.fin_transferencias_multiplas') is null then
    raise exception 'MIGRATION 156 abortada: requer as migrations 120, 121, 122, 151, 152, 153 e 155 aplicadas.';
  end if;
end $$;

create table if not exists fin_pendencias_documentais (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  competencia date not null check (competencia = date_trunc('month', competencia)::date),
  data_referencia date,
  descricao text not null check (length(btrim(descricao)) between 3 and 300),
  valor_centavos bigint check (valor_centavos is null or valor_centavos >= 0),
  motivo text not null check (length(btrim(motivo)) between 5 and 500),
  evidencia_necessaria text not null check (length(btrim(evidencia_necessaria)) between 5 and 500),
  responsavel text not null check (length(btrim(responsavel)) between 2 and 120),
  estado text not null default 'pendente' check (estado in ('pendente', 'estimado', 'aguardando_comprovacao', 'confirmado')),
  observacoes text check (observacoes is null or length(observacoes) <= 1000),
  documento_referencia text check (documento_referencia is null or length(documento_referencia) <= 300),   -- nome/local do documento (a infraestrutura de anexos não é usada aqui)
  relacionada_chave text check (relacionada_chave is null or length(relacionada_chave) <= 160),           -- pendência possivelmente relacionada (não presume que sejam perdas independentes)
  confirmacao_evidencia text check (confirmacao_evidencia is null or length(confirmacao_evidencia) <= 500),
  confirmado_por uuid, confirmado_em timestamptz,
  status text not null default 'ativa' check (status in ('ativa', 'cancelada')),
  motivo_cancelamento text, cancelado_por uuid, cancelado_em timestamptz,
  chave_origem text check (chave_origem is null or length(chave_origem) <= 160),
  criado_por uuid, atualizado_por uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint fin_pdoc_confirmacao check ((estado = 'confirmado') = (confirmado_por is not null and confirmado_em is not null and length(btrim(coalesce(confirmacao_evidencia, ''))) >= 5)),
  constraint fin_pdoc_cancelamento check (status <> 'cancelada' or (cancelado_por is not null and cancelado_em is not null and length(btrim(coalesce(motivo_cancelamento, ''))) >= 5))
);
create unique index if not exists ux_fin_pdoc_chave on fin_pendencias_documentais (organizacao_id, unidade_id, chave_origem) where chave_origem is not null and status = 'ativa';
create index if not exists ix_fin_pdoc_comp on fin_pendencias_documentais (organizacao_id, unidade_id, competencia);

create or replace function fin2_pendencia_documental_guarda() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.organizacao_id is distinct from old.organizacao_id or new.unidade_id is distinct from old.unidade_id then
      raise exception 'fin_campo_imutavel: organizacao e unidade nao mudam' using errcode = '23514';
    end if;
    if old.estado = 'confirmado' and (new.estado is distinct from 'confirmado' or new.valor_centavos is distinct from old.valor_centavos or new.descricao is distinct from old.descricao
       or new.confirmado_por is distinct from old.confirmado_por or new.confirmado_em is distinct from old.confirmado_em or new.confirmacao_evidencia is distinct from old.confirmacao_evidencia) then
      raise exception 'fin_campo_imutavel: pendencia confirmada nao muda valor, descricao nem confirmacao (cancele e registre outra)' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_fin_pendencias_documentais_guarda on fin_pendencias_documentais;
create trigger trg_fin_pendencias_documentais_guarda before update on fin_pendencias_documentais for each row execute function fin2_pendencia_documental_guarda();
drop trigger if exists trg_fin_pendencias_documentais_auditar on fin_pendencias_documentais;
create trigger trg_fin_pendencias_documentais_auditar after insert or update or delete on fin_pendencias_documentais for each row execute function fin_auditar();
drop trigger if exists trg_fin_pendencias_documentais_escopo on fin_pendencias_documentais;
create trigger trg_fin_pendencias_documentais_escopo before insert or update on fin_pendencias_documentais for each row execute function fin_validar_escopo();

-- Transferência de unidades: tabela nova com unidade_id entra na lista
create or replace function public.gestao_financeira_tabelas_da_unidade() returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array[
    'gestao_financeira_concessoes', 'gestao_financeira_concessoes_auditoria',                                     -- 120
    'fin_contas', 'fin_saldos_abertura', 'fin_lancamentos', 'fin_transferencias', 'fin_periodos', 'fin_importacoes',
    'fin_auditoria',                                                                                              -- 121
    'fin_referencias', 'fin_conciliacao_resolucoes', 'fin_sangria_excecoes', 'fin_excecoes_fechamento',           -- 122
    'fin_obrigacoes', 'fin_pagamentos', 'fin_conciliacao_saidas',                                                 -- 151
    'fin_rateios', 'fin_rateio_parcelas', 'fin_recebiveis', 'fin_recebimentos', 'fin_dividas', 'fin_divida_eventos', -- 152
    'fin_vendas_canal', 'fin_vendas_ajustes',                                                                     -- 153
    'fin_transferencias_multiplas', 'fin_transferencias_multiplas_entradas',                                      -- 155
    'fin_pendencias_documentais'                                                                                  -- 156
  ]::text[]
$$;

-- Privilégios: backend-only. RLS ligada, NENHUMA policy, sem DELETE.
do $$
declare r text;
begin
  alter table fin_pendencias_documentais enable row level security;
  revoke all on table fin_pendencias_documentais from public;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table fin_pendencias_documentais from %I', r); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table fin_pendencias_documentais from service_role;
    grant select, insert, update on table fin_pendencias_documentais to service_role;
  end if;
  revoke all on function fin2_pendencia_documental_guarda() from public;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function fin2_pendencia_documental_guarda() from %I', r); end if;
  end loop;
end $$;

-- Pós-condições
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.fin_pendencias_documentais'::regclass) then raise exception '156 pós-condição: RLS desligada'; end if;
  if exists (select 1 from pg_policies where tablename = 'fin_pendencias_documentais') then raise exception '156 pós-condição: não deve haver policy'; end if;
  if 'fin_pendencias_documentais' <> all (public.gestao_financeira_tabelas_da_unidade()) then raise exception '156 pós-condição: fora da guarda de transferência'; end if;
  if exists (select 1 from pg_roles where rolname = 'anon') and has_table_privilege('anon', 'public.fin_pendencias_documentais', 'select') then raise exception '156 pós-condição: anon lê a tabela'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') and has_table_privilege('service_role', 'public.fin_pendencias_documentais', 'delete') then raise exception '156 pós-condição: service_role pode apagar'; end if;
end $$;
commit;
