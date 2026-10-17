-- =====================================================================
-- MIGRATION 120 — Fundação de acesso do Dashboard Financeiro (gestao_financeira) — PROPOSTA
-- =====================================================================
-- ⚠️  NÃO APLICAR EM PRODUÇÃO NEM EM BANCO REMOTO SEM APROVAÇÃO EXPLÍCITA E IDENTIDADE DESCARTÁVEL COMPROVADA.
-- Escrita para ser exercitada só em Postgres local descartável / projeto Supabase novo.
--
-- O QUE FAZ
--   1. Libera a categoria 'financeiro' em modulos.categoria (a constraint da 030 só aceita 'operacao'/'integracao').
--   2. Registra o módulo 'gestao_financeira' NO CATÁLOGO (tabela modulos). NÃO escreve em organizacao_modulos nem em
--      unidade_modulos: o módulo nasce DESABILITADO para toda empresa e unidade existentes (diferente do backfill da 030).
--   3. Cria gestao_financeira_concessoes: concessão explícita por (organização, unidade, PERFIL), com nível, responsável,
--      motivo, expiração opcional e revogação. No máximo UMA concessão ativa por perfil+unidade.
--   4. Cria gestao_financeira_concessoes_auditoria: trilha append-only (UPDATE/DELETE/TRUNCATE recusados por trigger),
--      alimentada por trigger — registra inclusive escrita direta por SQL.
--   5. Triggers de integridade: unidade pertence à organização; perfil ativo e com vínculo com a empresa/unidade;
--      PROIBIDA a autoconcessão (quem concede não pode ser a conta dona do perfil); revogação exige motivo.
--   6. RLS LIGADO e FORÇADO, SEM nenhuma policy; REVOKE ALL de PUBLIC/anon/authenticated. Só o backend (service_role)
--      acessa — e ele filtra organização+unidade explicitamente.
--
-- NÃO FAZ: não concede acesso a ninguém; não habilita o módulo em empresa/unidade; não altera dados existentes.
-- PRÉ-REQUISITOS: 030, 034, 053 (usuarios_organizacoes/usuarios_unidades), 060 (perfis_operacionais), set_updated_at().
-- IDEMPOTENTE. ROLLBACK: 120_rollback.sql.
-- =====================================================================
begin;
set local lock_timeout = '5s';

-- 1) Categoria 'financeiro' ------------------------------------------------
do $$
declare c record;
begin
  for c in
    select con.conname from pg_constraint con
     where con.conrelid = 'public.modulos'::regclass and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%categoria%'
  loop
    execute format('alter table public.modulos drop constraint %I', c.conname);
  end loop;
  alter table public.modulos
    add constraint modulos_categoria_check check (categoria in ('operacao', 'integracao', 'financeiro'));
end $$;

-- 2) Módulo no catálogo (somente catálogo; sem vínculo com nenhuma empresa/unidade) ----
insert into public.modulos (id, nome, categoria, ordem) values
  ('gestao_financeira', 'Gestão Financeira', 'financeiro', 17)
on conflict (id) do update set nome = excluded.nome, categoria = excluded.categoria, ordem = excluded.ordem;

-- 3) Concessões -------------------------------------------------------------
create table if not exists public.gestao_financeira_concessoes (
  id               uuid primary key default gen_random_uuid(),
  organizacao_id   uuid not null references public.organizacoes(id) on delete cascade,
  unidade_id       uuid not null references public.unidades(id) on delete cascade,
  perfil_id        uuid not null references public.perfis_operacionais(id) on delete cascade,
  nivel            text not null check (nivel in ('leitura', 'operador', 'gestor')),
  concedida_por    uuid not null,                       -- auth.users.id do SuperAdmin; sem FK (sobrevive à exclusão da conta)
  motivo           text not null check (length(btrim(motivo)) >= 10),
  concedida_em     timestamptz not null default now(),
  expira_em        timestamptz,
  revogada_em      timestamptz,
  revogada_por     uuid,
  motivo_revogacao text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint gfc_expira_apos_concessao check (expira_em is null or expira_em > concedida_em),
  constraint gfc_revogacao_completa check (
    (revogada_em is null and revogada_por is null and motivo_revogacao is null)
    or (revogada_em is not null and revogada_por is not null and length(btrim(coalesce(motivo_revogacao, ''))) >= 10)
  )
);

-- No máximo uma concessão ATIVA por perfil+unidade (o backend lê com .is('revogada_em', null).maybeSingle()).
create unique index if not exists uq_gfc_ativa_perfil_unidade
  on public.gestao_financeira_concessoes (perfil_id, unidade_id) where revogada_em is null;
create index if not exists idx_gfc_org_unidade on public.gestao_financeira_concessoes (organizacao_id, unidade_id);
create index if not exists idx_gfc_perfil on public.gestao_financeira_concessoes (perfil_id);

comment on table public.gestao_financeira_concessoes is
  'Concessão EXPLÍCITA de acesso ao Dashboard Financeiro, por perfil+unidade. Sem policies: só o backend (service_role). Papel administrativo NÃO substitui esta linha.';

-- 3b) Auditoria append-only ----------------------------------------------------
create table if not exists public.gestao_financeira_concessoes_auditoria (
  id            bigint generated always as identity primary key,
  concessao_id  uuid not null,                 -- sem FK: a trilha sobrevive a exclusões em cascata
  organizacao_id uuid not null,
  unidade_id    uuid not null,
  perfil_id     uuid not null,
  evento        text not null check (evento in ('concedida', 'alterada', 'revogada')),
  nivel         text,
  ator_id       uuid,
  motivo        text,
  ocorreu_em    timestamptz not null default now()
);
create index if not exists idx_gfca_concessao on public.gestao_financeira_concessoes_auditoria (concessao_id);
create index if not exists idx_gfca_org on public.gestao_financeira_concessoes_auditoria (organizacao_id, ocorreu_em desc);

create or replace function public.gfc_auditoria_imutavel() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'gestao_financeira_concessoes_auditoria é append-only (% recusado).', tg_op;
end $$;

drop trigger if exists trg_gfca_imutavel on public.gestao_financeira_concessoes_auditoria;
create trigger trg_gfca_imutavel before update or delete on public.gestao_financeira_concessoes_auditoria
  for each row execute function public.gfc_auditoria_imutavel();
drop trigger if exists trg_gfca_sem_truncate on public.gestao_financeira_concessoes_auditoria;
create trigger trg_gfca_sem_truncate before truncate on public.gestao_financeira_concessoes_auditoria
  for each statement execute function public.gfc_auditoria_imutavel();

-- 4) Integridade -------------------------------------------------------------
create or replace function public.gfc_validar() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_org_unidade uuid;
  v_conta uuid;
  v_perfil_ativo boolean;
begin
  if tg_op = 'UPDATE' then
    -- Identidade da concessão é imutável: para mudar perfil/unidade/org, revogue e conceda de novo.
    if new.organizacao_id is distinct from old.organizacao_id or new.unidade_id is distinct from old.unidade_id
       or new.perfil_id is distinct from old.perfil_id or new.concedida_por is distinct from old.concedida_por
       or new.concedida_em is distinct from old.concedida_em then
      raise exception 'Concessão financeira: organização, unidade, perfil e concedente são imutáveis.';
    end if;
    if old.revogada_em is not null then
      raise exception 'Concessão financeira já revogada não pode ser alterada.';
    end if;
    -- Revogação não precisa revalidar vínculos (o vínculo pode ter sido removido — é justamente o caso de revogar).
    if new.revogada_em is not null then return new; end if;
  end if;

  select u.organizacao_id into v_org_unidade from public.unidades u where u.id = new.unidade_id;
  if v_org_unidade is null or v_org_unidade <> new.organizacao_id then
    raise exception 'Concessão financeira: a unidade não pertence à organização informada.';
  end if;

  select po.conta_id, po.ativo into v_conta, v_perfil_ativo from public.perfis_operacionais po where po.id = new.perfil_id;
  if v_conta is null or v_perfil_ativo is not true then
    raise exception 'Concessão financeira: perfil inexistente ou inativo.';
  end if;

  -- PROIBIDO autoconceder: o concedente não pode ser a conta dona do perfil beneficiado.
  if new.concedida_por = v_conta then
    raise exception 'Concessão financeira: autoconcessão é proibida.';
  end if;

  -- O perfil precisa ter vínculo ativo com a unidade OU com a empresa.
  if tg_op = 'INSERT' and not (
       exists (select 1 from public.usuarios_unidades uu where uu.usuario_id = v_conta and uu.unidade_id = new.unidade_id and uu.ativo)
    or exists (select 1 from public.usuarios_organizacoes uo where uo.usuario_id = v_conta and uo.organizacao_id = new.organizacao_id and uo.ativo)
  ) then
    raise exception 'Concessão financeira: o perfil não tem vínculo ativo com a unidade/empresa.';
  end if;
  return new;
end $$;

drop trigger if exists trg_gfc_validar on public.gestao_financeira_concessoes;
create trigger trg_gfc_validar before insert or update on public.gestao_financeira_concessoes
  for each row execute function public.gfc_validar();

drop trigger if exists trg_gfc_upd on public.gestao_financeira_concessoes;
create trigger trg_gfc_upd before update on public.gestao_financeira_concessoes
  for each row execute function public.set_updated_at();

create or replace function public.gfc_auditar() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    insert into public.gestao_financeira_concessoes_auditoria (concessao_id, organizacao_id, unidade_id, perfil_id, evento, nivel, ator_id, motivo)
    values (new.id, new.organizacao_id, new.unidade_id, new.perfil_id, 'concedida', new.nivel, new.concedida_por, new.motivo);
  elsif new.revogada_em is not null and old.revogada_em is null then
    insert into public.gestao_financeira_concessoes_auditoria (concessao_id, organizacao_id, unidade_id, perfil_id, evento, nivel, ator_id, motivo)
    values (new.id, new.organizacao_id, new.unidade_id, new.perfil_id, 'revogada', new.nivel, new.revogada_por, new.motivo_revogacao);
  elsif new.nivel is distinct from old.nivel or new.expira_em is distinct from old.expira_em then
    insert into public.gestao_financeira_concessoes_auditoria (concessao_id, organizacao_id, unidade_id, perfil_id, evento, nivel, ator_id, motivo)
    values (new.id, new.organizacao_id, new.unidade_id, new.perfil_id, 'alterada', new.nivel, null, null);
  end if;
  return new;
end $$;

drop trigger if exists trg_gfc_auditar on public.gestao_financeira_concessoes;
create trigger trg_gfc_auditar after insert or update on public.gestao_financeira_concessoes
  for each row execute function public.gfc_auditar();

-- 5) RLS sem policies + revogações ----------------------------------------------
alter table public.gestao_financeira_concessoes enable row level security;
alter table public.gestao_financeira_concessoes force row level security;
alter table public.gestao_financeira_concessoes_auditoria enable row level security;
alter table public.gestao_financeira_concessoes_auditoria force row level security;

-- Nenhuma policy é criada aqui (e nenhuma deve ser): anon/authenticated não têm caminho direto.
revoke all on table public.gestao_financeira_concessoes from public, anon, authenticated;
revoke all on table public.gestao_financeira_concessoes_auditoria from public, anon, authenticated;
revoke all on function public.gfc_validar(), public.gfc_auditar(), public.gfc_auditoria_imutavel() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update on public.gestao_financeira_concessoes to service_role;      -- sem DELETE: revoga-se, não se apaga
    grant select, insert on public.gestao_financeira_concessoes_auditoria to service_role;
    grant usage, select on all sequences in schema public to service_role;
  end if;
end $$;

-- 6) PÓS-CONDIÇÃO (falha segura): nada de acesso direto, nada de policy, módulo desabilitado em todo lugar.
do $$
declare t text; r text; n int;
begin
  foreach t in array array['gestao_financeira_concessoes', 'gestao_financeira_concessoes_auditoria'] loop
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) and has_any_column_privilege(r, ('public.' || t)::regclass, 'select,insert,update,references') then
        raise exception 'MIGRATION 120 abortada: % ainda tem acesso a % (grant herdado/default privileges). Nada foi aplicado.', r, t;
      end if;
    end loop;
    select count(*) into n from pg_policies where schemaname = 'public' and tablename = t;
    if n > 0 then raise exception 'MIGRATION 120 abortada: % possui % policy(ies); o desenho exige zero.', t, n; end if;
  end loop;
  if exists (select 1 from public.organizacao_modulos where modulo_id = 'gestao_financeira')
     or exists (select 1 from public.unidade_modulos where modulo_id = 'gestao_financeira') then
    raise exception 'MIGRATION 120 abortada: gestao_financeira deveria nascer desabilitado.';
  end if;
end $$;

commit;
