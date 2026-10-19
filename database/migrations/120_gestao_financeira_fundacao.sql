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
--   7. Torna a transferência/promoção de unidades compatível com o Financeiro (seção 5b): guarda explícita que RECUSA mover unidade com
--      qualquer registro financeiro e substitui remapear_organizacao_em_tabelas_de_unidade (054) para deixar as tabelas financeiras fora da
--      varredura genérica; um gatilho em unidades aplica a mesma guarda a UPDATE direto de organizacao_id. Únicas alterações em objeto
--      compartilhado além do catálogo de módulos; desfeitas pelo 120_rollback.sql.
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
  -- true: a pessoa entra DIRETO no setor financeiro (sem escolha de setor). Afeta só a navegação — não remove papéis operacionais.
  somente_financeiro boolean not null default false,
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

-- (idempotência em bancos que já receberam uma versão anterior da tabela)
alter table public.gestao_financeira_concessoes add column if not exists somente_financeiro boolean not null default false;

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

  -- FOR SHARE: serializa com transferir/promover (que travam a unidade) — ver 5b.
  select u.organizacao_id into v_org_unidade from public.unidades u where u.id = new.unidade_id for share;
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
-- ATENÇÃO (achado da simulação de privilégios do Supabase, A8): o Supabase concede ALL a anon/authenticated/service_role em TODO objeto
-- novo de `public` por default privileges. Revogar só de public/anon/authenticated deixava service_role com DELETE/TRUNCATE nas concessões e
-- as sequências utilizáveis por anon/authenticated. Por isso revogamos TUDO primeiro e só então concedemos o mínimo.
revoke all on table public.gestao_financeira_concessoes from public, anon, authenticated;
revoke all on table public.gestao_financeira_concessoes_auditoria from public, anon, authenticated;
revoke all on sequence public.gestao_financeira_concessoes_auditoria_id_seq from public, anon, authenticated;
revoke all on function public.gfc_validar(), public.gfc_auditar(), public.gfc_auditoria_imutavel() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table public.gestao_financeira_concessoes from service_role;
    revoke all on table public.gestao_financeira_concessoes_auditoria from service_role;
    revoke all on sequence public.gestao_financeira_concessoes_auditoria_id_seq from service_role;
    revoke all on function public.gfc_validar(), public.gfc_auditar(), public.gfc_auditoria_imutavel() from service_role;   -- gatilhos: ninguém os chama
    grant select, insert, update on public.gestao_financeira_concessoes to service_role;      -- sem DELETE: revoga-se, não se apaga
    grant select, insert on public.gestao_financeira_concessoes_auditoria to service_role;
    grant usage on sequence public.gestao_financeira_concessoes_auditoria_id_seq to service_role;   -- só a sequência da trilha (o INSERT de auditoria roda como o invocador)
  end if;
end $$;

-- 5b) Transferência/promoção de unidades × Financeiro (correção de compatibilidade organizacional) -------------------------
-- PROBLEMA: `remapear_organizacao_em_tabelas_de_unidade` (054, chamada por transferir_unidade_organizacao e promover_unidade_para_empresa)
-- faz UPDATE em TODA tabela do public com organizacao_id + unidade_id. Com as tabelas financeiras no banco, ela tentaria UPDATE em
-- fin_auditoria (o service_role só tem SELECT nela, por desenho) e o PostgreSQL recusa pelo privilégio MESMO sem linha afetada:
-- `permission denied for table fin_auditoria` em QUALQUER transferência/promoção. Com dados, ainda trocaria a empresa de lançamentos e
-- da trilha de auditoria (que é imutável).
-- REGRA: o histórico financeiro pertence à empresa em que foi registrado e NUNCA muda de empresa por um UPDATE genérico.
--   * unidade SEM nenhuma linha financeira  → transferência/promoção seguem exatamente como antes (as tabelas financeiras ficam fora da varredura);
--   * unidade COM qualquer linha financeira → recusa com errcode 22023 (o backend devolve 400 com a mensagem), nada é alterado.
--   "Só configuração" também recusa: criar conta, exceção de sangria, período ou concessão grava auditoria imutável (fin_auditoria /
--   gestao_financeira_concessoes_auditoria) com a empresa atual — já é histórico. Habilitar o módulo (unidade_modulos) NÃO é tabela financeira:
--   continua sendo remapeado como sempre (e, na empresa nova, o Financeiro só abre se ela também tiver o módulo e houver concessão).
-- LISTA EXPLÍCITA (não depende de prefixo): toda tabela financeira com unidade_id. 121/122 conferem, na pós-condição, que nenhuma tabela
-- financeira nova ficou fora dela. Tabelas ainda não criadas são ignoradas (to_regclass).
create or replace function public.gestao_financeira_tabelas_da_unidade() returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array[
    'gestao_financeira_concessoes', 'gestao_financeira_concessoes_auditoria',                                     -- 120
    'fin_contas', 'fin_saldos_abertura', 'fin_lancamentos', 'fin_transferencias', 'fin_periodos', 'fin_importacoes',
    'fin_auditoria',                                                                                              -- 121
    'fin_referencias', 'fin_conciliacao_resolucoes', 'fin_sangria_excecoes', 'fin_excecoes_fechamento'            -- 122
  ]::text[]
$$;

-- Guarda: recusa se a unidade tiver QUALQUER linha financeira. SECURITY INVOKER de propósito: roda com o papel de quem transfere
-- (service_role/postgres, que contornam RLS); se esse papel não puder ler alguma tabela por inteiro (sem SELECT ou sujeito a RLS),
-- FALHA FECHADO em vez de concluir "não há dados".
-- Concorrência: trava a linha da unidade (FOR UPDATE — a mesma trava que transferir/promover já tomam). Os gatilhos de escopo do
-- Financeiro leem a unidade com FOR SHARE: um lançamento concorrente ou espera a transferência terminar (e então é recusado, porque a
-- unidade já é de outra empresa) ou termina antes (e então esta contagem, que usa um snapshot novo, o enxerga e recusa a transferência).
create or replace function public.gestao_financeira_verificar_unidade_transferivel(p_unidade_id uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_tabela text; v_oid regclass; v_qtd bigint; v_achados text := ''; v_ignora_rls boolean;
  v_rotulo constant jsonb := jsonb_build_object(
    'gestao_financeira_concessoes', 'concessões de acesso', 'gestao_financeira_concessoes_auditoria', 'auditoria de concessões',
    'fin_contas', 'contas', 'fin_saldos_abertura', 'saldos de abertura', 'fin_lancamentos', 'lançamentos',
    'fin_transferencias', 'transferências', 'fin_periodos', 'períodos', 'fin_importacoes', 'importações',
    'fin_auditoria', 'auditoria financeira', 'fin_referencias', 'referências de conciliação',
    'fin_conciliacao_resolucoes', 'resoluções de conciliação', 'fin_sangria_excecoes', 'exceções de sangria',
    'fin_excecoes_fechamento', 'exceções de fechamento');
begin
  if p_unidade_id is null then
    raise exception 'Unidade não informada.' using errcode = '22023';
  end if;
  -- A contagem abaixo precisa de um snapshot NOVO (tirado depois da trava): só READ COMMITTED garante isso dentro da transação.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Transferência/promoção de unidade exige isolamento READ COMMITTED (atual: %). Nada foi alterado.',
      current_setting('transaction_isolation') using errcode = '25001';
  end if;
  perform 1 from public.unidades where id = p_unidade_id for update;
  select r.rolsuper or r.rolbypassrls into v_ignora_rls from pg_roles r where r.rolname = current_user;
  foreach v_tabela in array public.gestao_financeira_tabelas_da_unidade() loop
    v_oid := to_regclass('public.' || v_tabela);
    continue when v_oid is null;
    if not has_table_privilege(current_user, v_oid, 'select')
       or exists (select 1 from pg_class c where c.oid = v_oid and c.relrowsecurity and not coalesce(v_ignora_rls, false)
                    and (c.relforcerowsecurity or not pg_has_role(current_user, c.relowner, 'USAGE'))) then
      raise exception 'Não foi possível verificar o histórico financeiro da unidade (o papel % não lê % por inteiro). Nada foi alterado.',
        current_user, v_tabela using errcode = '42501';
    end if;
    execute format('select count(*) from public.%I where unidade_id = $1', v_tabela) into v_qtd using p_unidade_id;
    if v_qtd > 0 then
      v_achados := v_achados || case when v_achados = '' then '' else ', ' end || (v_rotulo ->> v_tabela) || ': ' || v_qtd;
    end if;
  end loop;
  if v_achados <> '' then
    raise exception 'Esta unidade possui registros no Financeiro (%) e não pode ser transferida nem promovida: o histórico financeiro pertence à empresa atual e não muda de empresa. Nada foi alterado.', v_achados
      using errcode = '22023';
  end if;
end $$;

-- Pré-condição: só substitui a função compartilhada quem a administra (dono ou membro do papel dono); senão aborta sem alterar nada.
do $$
declare v_dono oid;
begin
  select p.proowner into v_dono from pg_proc p
   where p.oid = to_regprocedure('public.remapear_organizacao_em_tabelas_de_unidade(uuid,uuid,uuid)');
  if v_dono is not null and not pg_has_role(current_user, v_dono, 'USAGE') then
    raise exception 'MIGRATION 120 abortada: a role % não administra remapear_organizacao_em_tabelas_de_unidade (dono: %). Nada foi aplicado.',
      current_user, pg_get_userbyid(v_dono);
  end if;
end $$;

-- Mesma assinatura, mesmo retorno, mesmo SECURITY INVOKER e mesmas exclusões da 054; CREATE OR REPLACE preserva dono e privilégios
-- (inclusive o fechamento da 115). Diferenças: (1) chama a guarda antes de qualquer UPDATE; (2) as tabelas financeiras ficam FORA da varredura.
create or replace function public.remapear_organizacao_em_tabelas_de_unidade(
  p_unidade_id uuid, p_org_antiga_id uuid, p_org_nova_id uuid
) returns jsonb
language plpgsql
as $$
declare
  v_tabela text;
  v_qtd int;
  v_resultado jsonb := '{}'::jsonb;
begin
  perform public.gestao_financeira_verificar_unidade_transferivel(p_unidade_id);
  for v_tabela in
    select c1.table_name
    from information_schema.columns c1
    join information_schema.columns c2
      on c2.table_schema = c1.table_schema and c2.table_name = c1.table_name and c2.column_name = 'unidade_id'
    join information_schema.tables t
      on t.table_schema = c1.table_schema and t.table_name = c1.table_name and t.table_type = 'BASE TABLE'
    where c1.table_schema = 'public' and c1.column_name = 'organizacao_id'
      and c1.table_name not in ('martin_brower_vinculos', 'sessoes_contexto', 'insumo_historico')
      and c1.table_name::text <> all (public.gestao_financeira_tabelas_da_unidade())
    order by c1.table_name
  loop
    execute format(
      'update public.%I set organizacao_id = $1 where unidade_id = $2 and organizacao_id = $3',
      v_tabela
    ) using p_org_nova_id, p_unidade_id, p_org_antiga_id;
    get diagnostics v_qtd = row_count;
    if v_qtd > 0 then
      v_resultado := v_resultado || jsonb_build_object(v_tabela, v_qtd);
    end if;
  end loop;
  return v_resultado;
end;
$$;

revoke all on function public.gestao_financeira_tabelas_da_unidade(), public.gestao_financeira_verificar_unidade_transferivel(uuid)
  from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- o service_role chama transferir/promover (invoker) → remapear → guarda: precisa executar as duas.
    grant execute on function public.gestao_financeira_tabelas_da_unidade(), public.gestao_financeira_verificar_unidade_transferivel(uuid) to service_role;
  end if;
end $$;

-- Gatilho em unidades: um UPDATE GENÉRICO de organizacao_id (fora de transferir/promover, ex.: PostgREST com service_role ou SQL avulso)
-- também passa pela guarda. Sem ele a unidade mudava de empresa e o histórico financeiro ficava órfão na empresa antiga (A2, 2026-10-19;
-- transferencia_unidades.sql 8.10–8.13). Só age quando organizacao_id MUDA; transferir/promover chamam a guarda de novo pelo remapear
-- (idempotente). INVOKER pelo mesmo motivo da guarda: quem não lê as tabelas financeiras por inteiro falha FECHADO.
create or replace function public.gestao_financeira_unidades_guarda_org() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.organizacao_id is distinct from old.organizacao_id then
    perform public.gestao_financeira_verificar_unidade_transferivel(new.id);
  end if;
  return new;
end $$;
revoke all on function public.gestao_financeira_unidades_guarda_org() from public, anon, authenticated;
drop trigger if exists trg_unidades_guarda_financeiro on public.unidades;
create trigger trg_unidades_guarda_financeiro before update of organizacao_id on public.unidades
  for each row execute function public.gestao_financeira_unidades_guarda_org();

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
    if exists (select 1 from pg_roles where rolname = 'service_role')
       and (has_table_privilege('service_role', ('public.' || t)::regclass, 'delete') or has_table_privilege('service_role', ('public.' || t)::regclass, 'truncate')
            or has_table_privilege('service_role', ('public.' || t)::regclass, 'references') or has_table_privilege('service_role', ('public.' || t)::regclass, 'trigger')) then
      raise exception 'MIGRATION 120 abortada: service_role tem DELETE/TRUNCATE/REFERENCES/TRIGGER em % (default privileges). Nada foi aplicado.', t;
    end if;
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r)
       and has_sequence_privilege(r, 'public.gestao_financeira_concessoes_auditoria_id_seq', 'usage,select,update') then
      raise exception 'MIGRATION 120 abortada: % alcança a sequência da auditoria de concessões. Nada foi aplicado.', r;
    end if;
  end loop;
  if exists (select 1 from public.organizacao_modulos where modulo_id = 'gestao_financeira')
     or exists (select 1 from public.unidade_modulos where modulo_id = 'gestao_financeira') then
    raise exception 'MIGRATION 120 abortada: gestao_financeira deveria nascer desabilitado.';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r)
       and (has_function_privilege(r, 'public.gestao_financeira_verificar_unidade_transferivel(uuid)', 'execute')
            or has_function_privilege(r, 'public.gestao_financeira_tabelas_da_unidade()', 'execute')) then
      raise exception 'MIGRATION 120 abortada: % executa a guarda de transferência financeira.', r;
    end if;
  end loop;
  if pg_get_functiondef('public.remapear_organizacao_em_tabelas_de_unidade(uuid,uuid,uuid)'::regprocedure)
       not like '%gestao_financeira_verificar_unidade_transferivel%' then
    raise exception 'MIGRATION 120 abortada: remapear_organizacao_em_tabelas_de_unidade não chama a guarda financeira.';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.unidades'::regclass and tgname = 'trg_unidades_guarda_financeiro' and tgenabled <> 'D') then
    raise exception 'MIGRATION 120 abortada: gatilho trg_unidades_guarda_financeiro ausente ou desabilitado em unidades.';
  end if;
end $$;

commit;
