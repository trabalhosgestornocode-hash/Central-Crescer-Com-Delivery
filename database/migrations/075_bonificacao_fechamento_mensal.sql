-- =====================================================================
-- MIGRATION 075 — Fechamento Mensal Visio (2 relatórios oficiais)
-- =====================================================================
-- OBJETIVO
--   Evoluir a 074 (bonificacao_mix_mensal — só o Relatório de Produtos)
--   para o "Fechamento Mensal Visio": um registro por (unidade, ano, mês)
--   com DUAS metades independentes — Relatório de Vendas (Geral:
--   faturamento/ticket/cupons/métodos de pagamento) e Relatório de Produtos
--   (Loja/Balcão: mix, PPD, torque, perdas). Cria também o modelo de
--   ESTADO da competência (bonificacao_competencia) e o SNAPSHOT imutável
--   versionado (bonificacao_competencia_snapshot).
--
--   Arquitetura aprovada: docs/… "Fechamento Mensal Visio v3.1".
--   Regra-mãe: obterMes() NUNCA lê bonificacao_fechamento_mensal para
--   decidir o resultado de uma competência — o que vale é
--   bonificacao_competencia.status + o snapshot da versao_atual.
--
-- PRÉ-REQUISITOS
--   * Migration 074 aplicada (tabela bonificacao_mix_mensal existe).
--   * bonificacao_mix_mensal VAZIA (0 linhas). A 074 nunca foi usada em
--     produção — confirmado 0 linhas em 2026-09-05. O PREFLIGHT abaixo
--     ABORTA a migration inteira se houver qualquer linha.
--   * Funções auth_unidade_ids() / is_platform_superadmin() /
--     bonificacao_set_atualizado_em() já existem (migrations 028/053).
--
-- SEGURANÇA (checklist aprovado)
--   * PREFLIGHT: count(*) > 0 em bonificacao_mix_mensal  -> RAISE (aborta).
--   * NÃO-DESTRUTIVA: só RENAME + ADD COLUMN + CREATE. Nenhum DROP COLUMN,
--     DROP TABLE, TRUNCATE, DELETE, UPDATE de dado. (o único DROP é de
--     constraint/policy/trigger, para RECRIAR equivalente com nome novo.)
--   * TRANSACIONAL: o arquivo inteiro roda em begin/commit — o RAISE do
--     preflight reverte tudo. Cole o arquivo INTEIRO no SQL Editor.
--   * IDEMPOTENTE: reexecução é segura (renames guardados, ADD IF NOT
--     EXISTS, DROP ... IF EXISTS antes de CREATE).
--   * FKs de bonificacao_competencia e _snapshot = ON DELETE RESTRICT
--     (snapshot financeiro nunca some por exclusão de competência/unidade).
--   * bonificacao_competencia_snapshot é APPEND-ONLY: trigger BEFORE
--     UPDATE/DELETE -> RAISE. Nada de substituido_em; a versão vigente é
--     bonificacao_competencia.versao_atual.
--
-- ROLLBACK: database/migrations/075_rollback.sql (reversão completa, IF EXISTS).
-- TESTE:   backend/test/migration-075.test.js (estático + cenários A/B/C).
-- COMO USAR: Supabase -> SQL Editor -> cole ESTE ARQUIVO INTEIRO e execute.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. PREFLIGHT + RENAME (tabela + colunas + constraints/índices/trigger).
--    Tudo num bloco só: se a tabela ainda é `bonificacao_mix_mensal`,
--    checa que está vazia e renomeia; se já é `bonificacao_fechamento_mensal`,
--    não faz nada (idempotente); se nenhuma das duas existe, aborta.
-- ---------------------------------------------------------------------
do $$
declare
  n bigint;
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'bonificacao_mix_mensal') then

    select count(*) into n from bonificacao_mix_mensal;
    if n > 0 then
      raise exception
        'ABORTADO (migration 075): bonificacao_mix_mensal tem % linha(s). '
        'Esta migration só roda com a tabela VAZIA (a 074 nunca foi usada em '
        'produção). Migre/preserve os dados manualmente antes de aplicar a 075.', n
        using errcode = 'restrict_violation';
    end if;

    -- tabela
    alter table bonificacao_mix_mensal rename to bonificacao_fechamento_mensal;

    -- colunas -> prefixo produtos_ (metade "Relatório de Produtos")
    alter table bonificacao_fechamento_mensal rename column qtd_sanduiches            to produtos_qtd_sanduiches;
    alter table bonificacao_fechamento_mensal rename column qtd_bebidas               to produtos_qtd_bebidas;
    alter table bonificacao_fechamento_mensal rename column qtd_adicionais            to produtos_qtd_adicionais;
    alter table bonificacao_fechamento_mensal rename column qtd_diversos              to produtos_qtd_diversos;
    alter table bonificacao_fechamento_mensal rename column percentual_bebidas_pdf    to produtos_pct_bebidas_pdf;
    alter table bonificacao_fechamento_mensal rename column percentual_adicionais_pdf to produtos_pct_adicionais_pdf;
    alter table bonificacao_fechamento_mensal rename column percentual_diversos_pdf   to produtos_pct_diversos_pdf;
    alter table bonificacao_fechamento_mensal rename column faturamento_loja          to produtos_faturamento_loja;
    alter table bonificacao_fechamento_mensal rename column ppd_loja                  to produtos_ppd;
    alter table bonificacao_fechamento_mensal rename column estabelecimento           to produtos_estabelecimento;
    alter table bonificacao_fechamento_mensal rename column hash_arquivo              to produtos_hash_arquivo;
    alter table bonificacao_fechamento_mensal rename column arquivo_storage           to produtos_arquivo_storage;
    alter table bonificacao_fechamento_mensal rename column origem                    to produtos_origem;
    alter table bonificacao_fechamento_mensal rename column usuario_id                to produtos_usuario_id;
    alter table bonificacao_fechamento_mensal rename column usuario_nome              to produtos_usuario_nome;

    -- constraints/índices/trigger -> nomes coerentes com o novo nome da tabela
    alter table bonificacao_fechamento_mensal rename constraint bonificacao_mix_mensal_pkey                   to bonificacao_fechamento_mensal_pkey;
    alter table bonificacao_fechamento_mensal rename constraint bonificacao_mix_mensal_unidade_id_ano_mes_key to bonificacao_fechamento_mensal_unidade_ano_mes_key;
    alter table bonificacao_fechamento_mensal rename constraint bonificacao_mix_mensal_ano_check              to bonificacao_fechamento_mensal_ano_check;
    alter table bonificacao_fechamento_mensal rename constraint bonificacao_mix_mensal_mes_check              to bonificacao_fechamento_mensal_mes_check;
    alter table bonificacao_fechamento_mensal rename constraint bonificacao_mix_mensal_origem_check           to bonificacao_fechamento_mensal_produtos_origem_check;
    alter table bonificacao_fechamento_mensal rename constraint bonificacao_mix_mensal_qtd_sanduiches_check   to bonificacao_fechamento_mensal_produtos_qtd_sanduiches_check;
    alter table bonificacao_fechamento_mensal rename constraint bonificacao_mix_mensal_qtd_bebidas_check      to bonificacao_fechamento_mensal_produtos_qtd_bebidas_check;
    alter table bonificacao_fechamento_mensal rename constraint bonificacao_mix_mensal_qtd_adicionais_check   to bonificacao_fechamento_mensal_produtos_qtd_adicionais_check;
    alter table bonificacao_fechamento_mensal rename constraint bonificacao_mix_mensal_qtd_diversos_check     to bonificacao_fechamento_mensal_produtos_qtd_diversos_check;

    alter index idx_bmm_unidade rename to idx_bfm_unidade;
    alter index idx_bmm_org     rename to idx_bfm_org;
    alter trigger trg_bmm_upd on bonificacao_fechamento_mensal rename to trg_bfm_upd;

  elsif not exists (select 1 from information_schema.tables
                    where table_schema = 'public' and table_name = 'bonificacao_fechamento_mensal') then
    raise exception
      'ABORTADO (migration 075): nem bonificacao_mix_mensal nem '
      'bonificacao_fechamento_mensal existem. Aplique a migration 074 primeiro.';
  end if;
  -- se já é bonificacao_fechamento_mensal: nada a renomear (idempotente).
end $$;

-- ---------------------------------------------------------------------
-- 1. COLUNAS NOVAS — metade PRODUTOS + metade VENDAS + flags da prévia.
--    Todas nullable ou com default -> ADD é não-destrutivo.
-- ---------------------------------------------------------------------
alter table bonificacao_fechamento_mensal
  add column if not exists produtos_torque             numeric(10,2),
  add column if not exists produtos_perdas             numeric(14,2),
  add column if not exists produtos_fat_sanduiches     numeric(14,2),
  add column if not exists produtos_pct_fat_sanduiches numeric(6,3),
  add column if not exists produtos_total_itens        int,
  add column if not exists produtos_canal_confirmado   boolean not null default false,
  add column if not exists produtos_atualizado_em      timestamptz,

  add column if not exists vendas_faturamento          numeric(14,2),
  add column if not exists vendas_ticket_medio         numeric(10,2),
  add column if not exists vendas_cupons_validos       int,
  add column if not exists vendas_cupons_vendas        int,
  add column if not exists vendas_metodos_pagamento    jsonb not null default '[]'::jsonb,
  add column if not exists vendas_estabelecimento      text,
  add column if not exists vendas_origem               text,
  add column if not exists vendas_hash_arquivo         text,
  add column if not exists vendas_arquivo_storage      text,
  add column if not exists vendas_usuario_id           uuid,
  add column if not exists vendas_usuario_nome         text,
  add column if not exists vendas_atualizado_em        timestamptz,

  add column if not exists periodo_confirmado_usuario  boolean not null default false;

-- CHECK de domínio das colunas novas (drop+add = idempotente).
alter table bonificacao_fechamento_mensal drop constraint if exists bfm_produtos_total_itens_check;
alter table bonificacao_fechamento_mensal add  constraint bfm_produtos_total_itens_check check (produtos_total_itens is null or produtos_total_itens >= 0);
alter table bonificacao_fechamento_mensal drop constraint if exists bfm_vendas_faturamento_check;
alter table bonificacao_fechamento_mensal add  constraint bfm_vendas_faturamento_check check (vendas_faturamento is null or vendas_faturamento >= 0);
alter table bonificacao_fechamento_mensal drop constraint if exists bfm_vendas_ticket_medio_check;
alter table bonificacao_fechamento_mensal add  constraint bfm_vendas_ticket_medio_check check (vendas_ticket_medio is null or vendas_ticket_medio >= 0);
alter table bonificacao_fechamento_mensal drop constraint if exists bfm_vendas_cupons_validos_check;
alter table bonificacao_fechamento_mensal add  constraint bfm_vendas_cupons_validos_check check (vendas_cupons_validos is null or vendas_cupons_validos >= 0);
alter table bonificacao_fechamento_mensal drop constraint if exists bfm_vendas_cupons_vendas_check;
alter table bonificacao_fechamento_mensal add  constraint bfm_vendas_cupons_vendas_check check (vendas_cupons_vendas is null or vendas_cupons_vendas >= 0);
alter table bonificacao_fechamento_mensal drop constraint if exists bfm_vendas_origem_check;
alter table bonificacao_fechamento_mensal add  constraint bfm_vendas_origem_check check (vendas_origem is null or vendas_origem in ('visio','manual','misto'));

-- Uma linha em bonificacao_fechamento_mensal só existe DEPOIS de um
-- fechamento confirmado -> as 2 metades + os 2 checkboxes são obrigatórios.
alter table bonificacao_fechamento_mensal drop constraint if exists bfm_completo;
alter table bonificacao_fechamento_mensal add  constraint bfm_completo check (
  produtos_qtd_sanduiches   is not null
  and vendas_faturamento    is not null
  and produtos_canal_confirmado = true
  and periodo_confirmado_usuario = true
);

-- ---------------------------------------------------------------------
-- 2. FKs -> ON DELETE RESTRICT (era CASCADE). Evidência financeira não
--    some por exclusão de empresa/unidade. (guardado + renomeado)
-- ---------------------------------------------------------------------
alter table bonificacao_fechamento_mensal drop constraint if exists bonificacao_mix_mensal_organizacao_id_fkey;
alter table bonificacao_fechamento_mensal drop constraint if exists bonificacao_fechamento_mensal_organizacao_id_fkey;
alter table bonificacao_fechamento_mensal add  constraint bonificacao_fechamento_mensal_organizacao_id_fkey
  foreign key (organizacao_id) references organizacoes(id) on delete restrict;

alter table bonificacao_fechamento_mensal drop constraint if exists bonificacao_mix_mensal_unidade_id_fkey;
alter table bonificacao_fechamento_mensal drop constraint if exists bonificacao_fechamento_mensal_unidade_id_fkey;
alter table bonificacao_fechamento_mensal add  constraint bonificacao_fechamento_mensal_unidade_id_fkey
  foreign key (unidade_id) references unidades(id) on delete restrict;

-- usuário: mantém ON DELETE SET NULL (pessoa pode sair; guardamos o nome). Só renomeia.
alter table bonificacao_fechamento_mensal drop constraint if exists bonificacao_mix_mensal_usuario_id_fkey;
alter table bonificacao_fechamento_mensal drop constraint if exists bonificacao_fechamento_mensal_produtos_usuario_id_fkey;
alter table bonificacao_fechamento_mensal add  constraint bonificacao_fechamento_mensal_produtos_usuario_id_fkey
  foreign key (produtos_usuario_id) references perfis(id) on delete set null;
alter table bonificacao_fechamento_mensal drop constraint if exists bonificacao_fechamento_mensal_vendas_usuario_id_fkey;
alter table bonificacao_fechamento_mensal add  constraint bonificacao_fechamento_mensal_vendas_usuario_id_fkey
  foreign key (vendas_usuario_id) references perfis(id) on delete set null;

-- ---------------------------------------------------------------------
-- 3. RLS da tabela renomeada — mesma expressão, nome novo.
-- ---------------------------------------------------------------------
alter table bonificacao_fechamento_mensal enable row level security;
drop policy if exists rls_bonificacao_mix_mensal_tenant        on bonificacao_fechamento_mensal;
drop policy if exists rls_bonificacao_fechamento_mensal_tenant on bonificacao_fechamento_mensal;
create policy rls_bonificacao_fechamento_mensal_tenant on bonificacao_fechamento_mensal
  for all to authenticated
  using      (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin())
  with check (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin());

-- ---------------------------------------------------------------------
-- 4. bonificacao_competencia — ESTADO da competência (fonte da verdade
--    de QUAL resultado vale). FKs RESTRICT.
-- ---------------------------------------------------------------------
create table if not exists bonificacao_competencia (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id     uuid not null references unidades(id)     on delete restrict,
  ano int not null check (ano between 2000 and 2100),
  mes int not null check (mes between 1 and 12),

  status text not null default 'aberta'
    check (status in ('aberta','fechada','reaberta','legado_sem_fechamento')),
  versao_atual int not null default 0 check (versao_atual >= 0),
  fechamento_id uuid references bonificacao_fechamento_mensal(id) on delete restrict,

  fechada_em      timestamptz,
  fechada_por_id  uuid references perfis(id) on delete set null,
  fechada_por_nome text,
  reaberta_em     timestamptz,
  reaberta_por_id uuid references perfis(id) on delete set null,
  reaberta_por_nome text,
  reabertura_motivo text,
  legado_capturado_em timestamptz,

  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),

  unique (unidade_id, ano, mes)
);
create index if not exists idx_bcomp_unidade on bonificacao_competencia(unidade_id, ano desc, mes desc);
create index if not exists idx_bcomp_org     on bonificacao_competencia(organizacao_id);
create index if not exists idx_bcomp_status  on bonificacao_competencia(status);

drop trigger if exists trg_bcomp_upd on bonificacao_competencia;
create trigger trg_bcomp_upd before update on bonificacao_competencia
  for each row execute function bonificacao_set_atualizado_em();

alter table bonificacao_competencia enable row level security;
drop policy if exists rls_bonificacao_competencia_tenant on bonificacao_competencia;
create policy rls_bonificacao_competencia_tenant on bonificacao_competencia
  for all to authenticated
  using      (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin())
  with check (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin());

-- ---------------------------------------------------------------------
-- 5. bonificacao_competencia_snapshot — APPEND-ONLY IMUTÁVEL, versionado.
--    Sem substituido_em. Versão vigente = bonificacao_competencia.versao_atual.
--    FKs RESTRICT (nada apaga snapshot financeiro).
-- ---------------------------------------------------------------------
create table if not exists bonificacao_competencia_snapshot (
  id uuid primary key default gen_random_uuid(),
  competencia_id uuid not null references bonificacao_competencia(id) on delete restrict,
  organizacao_id uuid not null references organizacoes(id)            on delete restrict,
  unidade_id     uuid not null references unidades(id)                on delete restrict,
  ano int not null,
  mes int not null,
  versao int not null check (versao >= 1),
  -- Origem ÚNICA e obrigatória do snapshot (correção conceitual F4):
  --   fechamento_mensal_direto → mês SEM acompanhamento diário, fechado pelos 2
  --                              relatórios mensais (Vendas + Produtos).
  --   acompanhamento_diario    → mês acompanhado dia a dia, consolidado do
  --                              cálculo ao vivo (obterMes).
  --   legado_pre_refatoracao   → captura do resultado anterior à refatoração.
  -- Nunca há duas origens no mesmo snapshot.
  origem text not null check (origem in ('fechamento_mensal_direto','acompanhamento_diario','legado_pre_refatoracao')),
  snapshot jsonb not null,
  criado_em     timestamptz not null default now(),
  criado_por_id uuid references perfis(id) on delete set null,
  criado_por_nome text,
  motivo text,
  unique (competencia_id, versao)
);
create index if not exists idx_bcsnap_competencia on bonificacao_competencia_snapshot(competencia_id, versao desc);
create index if not exists idx_bcsnap_unidade     on bonificacao_competencia_snapshot(unidade_id, ano, mes);

-- Imutabilidade NO BANCO — INSERT livre (append-only); UPDATE/DELETE proibidos.
create or replace function bonificacao_snapshot_imutavel() returns trigger as $imut$
begin
  raise exception
    'bonificacao_competencia_snapshot é append-only: % proibido (id=%). '
    'Reabertura/refechamento gera SNAPSHOT NOVO, nunca altera o anterior.',
    tg_op, coalesce(old.id, new.id)
    using errcode = 'restrict_violation';
end;
$imut$ language plpgsql;

drop trigger if exists trg_bcsnap_no_update on bonificacao_competencia_snapshot;
create trigger trg_bcsnap_no_update before update on bonificacao_competencia_snapshot
  for each row execute function bonificacao_snapshot_imutavel();
drop trigger if exists trg_bcsnap_no_delete on bonificacao_competencia_snapshot;
create trigger trg_bcsnap_no_delete before delete on bonificacao_competencia_snapshot
  for each row execute function bonificacao_snapshot_imutavel();

alter table bonificacao_competencia_snapshot enable row level security;
drop policy if exists rls_bonificacao_competencia_snapshot_tenant on bonificacao_competencia_snapshot;
create policy rls_bonificacao_competencia_snapshot_tenant on bonificacao_competencia_snapshot
  for all to authenticated
  using      (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin())
  with check (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin());

-- ---------------------------------------------------------------------
-- 6. FLUXO TRANSACIONAL DA F4 — funções que congelam / reabrem a
--    competência ATOMICAMENTE (o cliente Supabase-JS não tem transação
--    multi-statement; o codebase usa RPC para isso, ver .rpc() em
--    plataforma.*.service.js). SECURITY INVOKER (o backend chama com a
--    service-role, que ignora RLS; org/unidade/usuário vêm explícitos).
--
--    REGRA-MÃE: a autoridade do resultado é bonificacao_competencia.status
--    + o snapshot da versao_atual. Nunca `fechamento.status`.
--    IMUTABILIDADE: refechar/reabrir cria SEMPRE snapshot versão N+1.
--    A versão anterior nunca é tocada (trigger BEFORE UPDATE/DELETE).
-- ---------------------------------------------------------------------

-- 6.1 Congela a competência numa nova versão de snapshot.
--   p_origem = 'fechamento_mensal_direto' -> status 'fechada' (mês SEM acompanhamento, 2 relatórios mensais)
--            = 'acompanhamento_diario'    -> status 'fechada' (mês acompanhado dia a dia, consolidado do cálculo ao vivo)
--            = 'legado_pre_refatoracao'   -> status 'legado_sem_fechamento' (captura do resultado pré-refatoração)
--   p_fechamento (jsonb|null): quando presente (fechamento_mensal_direto), faz
--     UPSERT de bonificacao_fechamento_mensal e liga competencia.fechamento_id.
--     Nos outros casos (acompanhamento_diario / legado) é null.
--   Retorna { competencia_id, versao, status, snapshot_id }.
create or replace function bonificacao_congelar_competencia(
  p_organizacao_id uuid,
  p_unidade_id     uuid,
  p_ano            int,
  p_mes            int,
  p_origem         text,
  p_snapshot       jsonb,
  p_fechamento     jsonb   default null,
  p_motivo         text    default null,
  p_por_id         uuid    default null,
  p_por_nome       text    default null
) returns jsonb
language plpgsql
as $congelar$
declare
  v_comp     bonificacao_competencia%rowtype;
  v_status   text;
  v_versao   int;
  v_fech_id  uuid;
  v_snap_id  uuid;
  v_now      timestamptz := now();
begin
  if p_origem not in ('fechamento_mensal_direto','acompanhamento_diario','legado_pre_refatoracao') then
    raise exception 'origem inválida: % (esperado fechamento_mensal_direto | acompanhamento_diario | legado_pre_refatoracao)', p_origem
      using errcode = 'check_violation';
  end if;
  v_status := case p_origem when 'legado_pre_refatoracao' then 'legado_sem_fechamento' else 'fechada' end;

  -- competência: cria se não existe, trava a linha
  select * into v_comp from bonificacao_competencia
    where unidade_id = p_unidade_id and ano = p_ano and mes = p_mes
    for update;
  if not found then
    insert into bonificacao_competencia (organizacao_id, unidade_id, ano, mes, status, versao_atual)
      values (p_organizacao_id, p_unidade_id, p_ano, p_mes, 'aberta', 0)
      returning * into v_comp;
  end if;

  if v_comp.status = 'fechada' then
    raise exception
      'ABORTADO: competência %/% já está FECHADA (versão %). Reabra (bonificacao_reabrir_competencia) antes de refechar.',
      p_mes, p_ano, v_comp.versao_atual using errcode = 'restrict_violation';
  end if;
  if v_comp.status = 'legado_sem_fechamento' then
    raise exception
      'ABORTADO: competência %/% é LEGADO congelado (versão %). Não recongele o legado.',
      p_mes, p_ano, v_comp.versao_atual using errcode = 'restrict_violation';
  end if;

  v_versao := v_comp.versao_atual + 1;

  -- fechamento_mensal_direto: UPSERT da linha bonificacao_fechamento_mensal
  if p_fechamento is not null then
    insert into bonificacao_fechamento_mensal as bfm (
      organizacao_id, unidade_id, ano, mes,
      produtos_qtd_sanduiches, produtos_qtd_bebidas, produtos_qtd_adicionais, produtos_qtd_diversos,
      produtos_pct_bebidas_pdf, produtos_pct_adicionais_pdf, produtos_pct_diversos_pdf,
      produtos_faturamento_loja, produtos_ppd, produtos_torque, produtos_perdas,
      produtos_fat_sanduiches, produtos_pct_fat_sanduiches, produtos_total_itens,
      produtos_estabelecimento, produtos_hash_arquivo, produtos_arquivo_storage,
      produtos_origem, produtos_usuario_id, produtos_usuario_nome,
      produtos_canal_confirmado, produtos_atualizado_em,
      vendas_faturamento, vendas_ticket_medio, vendas_cupons_validos, vendas_cupons_vendas,
      vendas_metodos_pagamento, vendas_estabelecimento, vendas_origem,
      vendas_hash_arquivo, vendas_arquivo_storage, vendas_usuario_id, vendas_usuario_nome, vendas_atualizado_em,
      periodo_confirmado_usuario
    )
    select
      p_organizacao_id, p_unidade_id, p_ano, p_mes,
      (p_fechamento->>'produtos_qtd_sanduiches')::int, (p_fechamento->>'produtos_qtd_bebidas')::int,
      (p_fechamento->>'produtos_qtd_adicionais')::int, (p_fechamento->>'produtos_qtd_diversos')::int,
      (p_fechamento->>'produtos_pct_bebidas_pdf')::numeric, (p_fechamento->>'produtos_pct_adicionais_pdf')::numeric,
      (p_fechamento->>'produtos_pct_diversos_pdf')::numeric,
      (p_fechamento->>'produtos_faturamento_loja')::numeric, (p_fechamento->>'produtos_ppd')::numeric,
      (p_fechamento->>'produtos_torque')::numeric, (p_fechamento->>'produtos_perdas')::numeric,
      (p_fechamento->>'produtos_fat_sanduiches')::numeric, (p_fechamento->>'produtos_pct_fat_sanduiches')::numeric,
      (p_fechamento->>'produtos_total_itens')::int,
      p_fechamento->>'produtos_estabelecimento', p_fechamento->>'produtos_hash_arquivo', p_fechamento->>'produtos_arquivo_storage',
      coalesce(p_fechamento->>'produtos_origem','visio'), p_por_id, p_por_nome,
      true, v_now,
      (p_fechamento->>'vendas_faturamento')::numeric, (p_fechamento->>'vendas_ticket_medio')::numeric,
      (p_fechamento->>'vendas_cupons_validos')::int, (p_fechamento->>'vendas_cupons_vendas')::int,
      coalesce(p_fechamento->'vendas_metodos_pagamento','[]'::jsonb),
      p_fechamento->>'vendas_estabelecimento', coalesce(p_fechamento->>'vendas_origem','visio'),
      p_fechamento->>'vendas_hash_arquivo', p_fechamento->>'vendas_arquivo_storage', p_por_id, p_por_nome, v_now,
      true
    on conflict (unidade_id, ano, mes) do update set
      produtos_qtd_sanduiches     = excluded.produtos_qtd_sanduiches,
      produtos_qtd_bebidas        = excluded.produtos_qtd_bebidas,
      produtos_qtd_adicionais     = excluded.produtos_qtd_adicionais,
      produtos_qtd_diversos       = excluded.produtos_qtd_diversos,
      produtos_pct_bebidas_pdf    = excluded.produtos_pct_bebidas_pdf,
      produtos_pct_adicionais_pdf = excluded.produtos_pct_adicionais_pdf,
      produtos_pct_diversos_pdf   = excluded.produtos_pct_diversos_pdf,
      produtos_faturamento_loja   = excluded.produtos_faturamento_loja,
      produtos_ppd                = excluded.produtos_ppd,
      produtos_torque             = excluded.produtos_torque,
      produtos_perdas             = excluded.produtos_perdas,
      produtos_fat_sanduiches     = excluded.produtos_fat_sanduiches,
      produtos_pct_fat_sanduiches = excluded.produtos_pct_fat_sanduiches,
      produtos_total_itens        = excluded.produtos_total_itens,
      produtos_estabelecimento    = excluded.produtos_estabelecimento,
      produtos_hash_arquivo       = excluded.produtos_hash_arquivo,
      produtos_arquivo_storage    = excluded.produtos_arquivo_storage,
      produtos_origem             = excluded.produtos_origem,
      produtos_usuario_id         = excluded.produtos_usuario_id,
      produtos_usuario_nome       = excluded.produtos_usuario_nome,
      produtos_canal_confirmado   = true,
      produtos_atualizado_em      = v_now,
      vendas_faturamento          = excluded.vendas_faturamento,
      vendas_ticket_medio         = excluded.vendas_ticket_medio,
      vendas_cupons_validos       = excluded.vendas_cupons_validos,
      vendas_cupons_vendas        = excluded.vendas_cupons_vendas,
      vendas_metodos_pagamento    = excluded.vendas_metodos_pagamento,
      vendas_estabelecimento      = excluded.vendas_estabelecimento,
      vendas_origem               = excluded.vendas_origem,
      vendas_hash_arquivo         = excluded.vendas_hash_arquivo,
      vendas_arquivo_storage      = excluded.vendas_arquivo_storage,
      vendas_usuario_id           = excluded.vendas_usuario_id,
      vendas_usuario_nome         = excluded.vendas_usuario_nome,
      vendas_atualizado_em        = v_now,
      periodo_confirmado_usuario  = true
    returning bfm.id into v_fech_id;
  end if;

  -- snapshot APPEND-ONLY: sempre uma linha nova, versão N+1
  insert into bonificacao_competencia_snapshot (
    competencia_id, organizacao_id, unidade_id, ano, mes, versao, origem, snapshot,
    criado_por_id, criado_por_nome, motivo
  ) values (
    v_comp.id, p_organizacao_id, p_unidade_id, p_ano, p_mes, v_versao, p_origem, p_snapshot,
    p_por_id, p_por_nome, p_motivo
  )
  returning id into v_snap_id;

  -- competência: aponta para a nova versão vigente
  update bonificacao_competencia set
    status              = v_status,
    versao_atual        = v_versao,
    fechamento_id       = coalesce(v_fech_id, fechamento_id),
    fechada_em          = case when v_status = 'fechada' then v_now else fechada_em end,
    fechada_por_id      = case when v_status = 'fechada' then p_por_id else fechada_por_id end,
    fechada_por_nome    = case when v_status = 'fechada' then p_por_nome else fechada_por_nome end,
    legado_capturado_em = case when p_origem = 'legado_pre_refatoracao' then v_now else legado_capturado_em end,
    reaberta_em         = null, reaberta_por_id = null, reaberta_por_nome = null, reabertura_motivo = null
  where id = v_comp.id;

  return jsonb_build_object(
    'competencia_id', v_comp.id, 'versao', v_versao, 'status', v_status,
    'snapshot_id', v_snap_id, 'fechamento_id', v_fech_id
  );
end;
$congelar$;

-- 6.2 Reabre uma competência FECHADA. Nada é apagado — só muda o status.
--   O snapshot da versão vigente continua existindo (histórico); obterMes()
--   passa a calcular ao vivo até o próximo congelamento (versão N+1).
create or replace function bonificacao_reabrir_competencia(
  p_unidade_id uuid, p_ano int, p_mes int,
  p_motivo text, p_por_id uuid default null, p_por_nome text default null
) returns jsonb
language plpgsql
as $reabrir$
declare
  v_comp bonificacao_competencia%rowtype;
begin
  select * into v_comp from bonificacao_competencia
    where unidade_id = p_unidade_id and ano = p_ano and mes = p_mes for update;
  if not found then
    raise exception 'competência %/% não existe', p_mes, p_ano using errcode = 'no_data_found';
  end if;
  if v_comp.status <> 'fechada' then
    raise exception 'competência %/% não está fechada (status=%). Só dá para reabrir o que está fechado.',
      p_mes, p_ano, v_comp.status using errcode = 'restrict_violation';
  end if;
  if coalesce(length(trim(p_motivo)), 0) < 3 then
    raise exception 'informe o motivo da reabertura (mínimo 3 caracteres)' using errcode = 'check_violation';
  end if;

  update bonificacao_competencia set
    status = 'reaberta',
    reaberta_em = now(), reaberta_por_id = p_por_id, reaberta_por_nome = p_por_nome,
    reabertura_motivo = p_motivo
  where id = v_comp.id;

  return jsonb_build_object('competencia_id', v_comp.id, 'status', 'reaberta',
    'versao_atual', v_comp.versao_atual, 'reabertura_motivo', p_motivo);
end;
$reabrir$;

commit;

-- =====================================================================
-- VERIFICAÇÃO (rode SEPARADAMENTE, fora da transação acima):
--
--   \d+ bonificacao_fechamento_mensal
--     -> colunas produtos_* e vendas_*; FKs org/unidade ON DELETE RESTRICT;
--        CHECK bfm_completo; trigger trg_bfm_upd; policy rls_bonificacao_fechamento_mensal_tenant
--   select count(*) from bonificacao_fechamento_mensal;      -- inalterado (0)
--   \d+ bonificacao_competencia
--     -> status CHECK (4 valores); versao_atual default 0; FKs RESTRICT
--   \d+ bonificacao_competencia_snapshot
--     -> UNIQUE(competencia_id,versao); FKs RESTRICT; 2 triggers de imutabilidade
--
--   -- imutabilidade (devem FALHAR):
--   -- UPDATE bonificacao_competencia_snapshot SET versao = versao;
--   -- DELETE FROM bonificacao_competencia_snapshot;
--   -- DELETE FROM bonificacao_competencia WHERE id IN (SELECT competencia_id FROM bonificacao_competencia_snapshot);
-- =====================================================================
