-- =====================================================================
-- 127 — Checklist Operacional: METAS da unidade (persistidas, versionadas, auditadas)
-- =====================================================================
-- Até aqui as metas do Checklist viviam só na memória da aba (nunca salvas): cada TV/tablet tinha as suas, e um
-- recarregar voltava ao exemplo. Esta migration cria a ÚNICA fonte de verdade:
--
--   checklist_metas            uma linha por unidade; `versao` sobe a cada alteração (controle de concorrência)
--   checklist_metas_historico  append-only: quem, quando, valor anterior e novo valor de CADA versão
--   checklist_metas_salvar()   a única escrita: compara a versão esperada, grava a nova versão e o histórico na
--                              MESMA transação. Versão diferente da esperada = 'conflito' (nada é gravado) e a
--                              resposta traz o valor atual para a tela reconciliar.
--
-- Isolamento: a unidade TEM de pertencer à organização (checado na função e no trigger). Backend-only, como as tabelas
-- do iFood: RLS ligada, nenhuma policy; o service_role só LÊ as tabelas e escreve pela função.
--
-- O histórico também serve à avaliação HISTÓRICA: o Dashboard Operacional avalia cada pedido pela meta vigente no
-- recebimento (a versão cujo `alterado_em` é o último ≤ recebimento), então mudar a meta nunca reescreve o passado.
--
-- 100% ADITIVA: nenhuma tabela existente muda. Idempotente. Rollback: 127_rollback.sql.

begin;
set local lock_timeout = '5s';

create table if not exists checklist_metas (
  unidade_id uuid primary key references unidades(id) on delete cascade,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  versao bigint not null check (versao >= 1),

  preparo_meta_min numeric(5,1) not null check (preparo_meta_min > 0 and preparo_meta_min <= 240),
  preparo_aviso_pct numeric(4,1) not null check (preparo_aviso_pct between 50 and 99),
  entrega_meta_min numeric(5,1) not null check (entrega_meta_min > 0 and entrega_meta_min <= 240),
  entrega_aviso_pct numeric(4,1) not null check (entrega_aviso_pct between 50 and 99),
  vida_meta_min numeric(5,1) not null check (vida_meta_min > 0 and vida_meta_min <= 240),
  vida_aviso_pct numeric(4,1) not null check (vida_aviso_pct between 50 and 99),

  atualizado_em timestamptz not null default now(),
  atualizado_por_perfil_id uuid,                                                       -- perfis_operacionais.id (null em impersonação)
  atualizado_por_nome text check (atualizado_por_nome is null or length(atualizado_por_nome) <= 120),
  criado_em timestamptz not null default now()
);
create index if not exists idx_checklist_metas_org on checklist_metas(organizacao_id);

create table if not exists checklist_metas_historico (
  id bigint generated always as identity primary key,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  versao bigint not null check (versao >= 1),
  anterior jsonb,                                                                      -- null na primeira versão
  novo jsonb not null,
  origem text not null check (origem in ('interface', 'migracao_local')),
  alterado_em timestamptz not null default now(),
  alterado_por_perfil_id uuid,
  alterado_por_usuario_id uuid,                                                        -- auth.users.id de quem salvou
  alterado_por_nome text check (alterado_por_nome is null or length(alterado_por_nome) <= 120),
  impersonado_por uuid,                                                                -- superadmin em suporte, quando houver
  constraint uq_checklist_metas_historico_versao unique (unidade_id, versao)
);
create index if not exists idx_checklist_metas_historico_tenant
  on checklist_metas_historico(organizacao_id, unidade_id, alterado_em desc);

-- Organização da linha = organização da unidade (nunca uma meta "de outra empresa" para a unidade).
create or replace function checklist_metas_validar_tenant() returns trigger
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from unidades u where u.id = new.unidade_id and u.organizacao_id = new.organizacao_id) then
    raise exception 'checklist_metas: a unidade % não pertence à organização %', new.unidade_id, new.organizacao_id
      using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.organizacao_id is distinct from old.organizacao_id or new.unidade_id is distinct from old.unidade_id) then
    raise exception 'checklist_metas: organização e unidade não mudam' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_checklist_metas_tenant on checklist_metas;
create trigger trg_checklist_metas_tenant before insert or update on checklist_metas
  for each row execute function checklist_metas_validar_tenant();
drop trigger if exists trg_checklist_metas_historico_tenant on checklist_metas_historico;
create trigger trg_checklist_metas_historico_tenant before insert on checklist_metas_historico
  for each row execute function checklist_metas_validar_tenant();

-- Histórico é append-only: nada o altera nem apaga (só a exclusão da unidade/empresa, em cascata).
create or replace function checklist_metas_historico_imutavel() returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception 'checklist_metas_historico é somente inclusão (%).', tg_op using errcode = '42501';
end $$;

drop trigger if exists trg_checklist_metas_historico_imutavel on checklist_metas_historico;
create trigger trg_checklist_metas_historico_imutavel before update or delete on checklist_metas_historico
  for each row execute function checklist_metas_historico_imutavel();

create or replace function checklist_metas_json(m checklist_metas) returns jsonb
language sql immutable set search_path = public as $$
  select jsonb_build_object(
    'preparo', jsonb_build_object('meta', m.preparo_meta_min, 'avisoPct', m.preparo_aviso_pct),
    'entrega', jsonb_build_object('meta', m.entrega_meta_min, 'avisoPct', m.entrega_aviso_pct),
    'vida',    jsonb_build_object('meta', m.vida_meta_min,    'avisoPct', m.vida_aviso_pct));
$$;

-- A ÚNICA escrita. Resultados: 'salvo' | 'sem_alteracao' (valores iguais: nenhuma versão nova) | 'conflito'
-- (versão esperada ≠ atual — nada gravado). `p_versao_esperada = 0` = "a unidade ainda não tem metas": é assim que a
-- migração de uma configuração local nunca sobrescreve um valor já persistido por outro aparelho.
create or replace function checklist_metas_salvar(
  p_organizacao_id uuid, p_unidade_id uuid, p_versao_esperada bigint,
  p_preparo_meta numeric, p_preparo_aviso numeric,
  p_entrega_meta numeric, p_entrega_aviso numeric,
  p_vida_meta numeric, p_vida_aviso numeric,
  p_origem text, p_perfil_id uuid, p_usuario_id uuid, p_nome text, p_impersonado_por uuid
) returns table (resultado text, versao_atual bigint, metas_atual jsonb, atualizado_em_atual timestamptz, atualizado_por_atual text)
language plpgsql security definer set search_path = public as $$
declare
  atual checklist_metas%rowtype;
  gravado checklist_metas%rowtype;
begin
  if p_organizacao_id is null or p_unidade_id is null then
    raise exception 'checklist_metas_salvar: tenant ausente' using errcode = '22023';
  end if;
  if not exists (select 1 from unidades u where u.id = p_unidade_id and u.organizacao_id = p_organizacao_id) then
    raise exception 'checklist_metas_salvar: a unidade não pertence à organização' using errcode = '42501';
  end if;

  select * into atual from checklist_metas m where m.unidade_id = p_unidade_id for update;

  if not found then
    if coalesce(p_versao_esperada, 0) <> 0 then
      return query select 'conflito'::text, 0::bigint, null::jsonb, null::timestamptz, null::text;
      return;
    end if;
    insert into checklist_metas as m (unidade_id, organizacao_id, versao,
      preparo_meta_min, preparo_aviso_pct, entrega_meta_min, entrega_aviso_pct, vida_meta_min, vida_aviso_pct,
      atualizado_por_perfil_id, atualizado_por_nome)
    values (p_unidade_id, p_organizacao_id, 1,
      round(p_preparo_meta, 1), round(p_preparo_aviso, 1), round(p_entrega_meta, 1), round(p_entrega_aviso, 1),
      round(p_vida_meta, 1), round(p_vida_aviso, 1), p_perfil_id, left(p_nome, 120))
    on conflict (unidade_id) do nothing
    returning m.* into gravado;
    if gravado.unidade_id is null then
      -- Outro aparelho gravou a primeira versão no mesmo instante: conflito, com o valor dele.
      select * into atual from checklist_metas m where m.unidade_id = p_unidade_id;
      return query select 'conflito'::text, atual.versao, checklist_metas_json(atual), atual.atualizado_em, atual.atualizado_por_nome;
      return;
    end if;
    insert into checklist_metas_historico (organizacao_id, unidade_id, versao, anterior, novo, origem,
      alterado_em, alterado_por_perfil_id, alterado_por_usuario_id, alterado_por_nome, impersonado_por)
    values (p_organizacao_id, p_unidade_id, 1, null, checklist_metas_json(gravado), p_origem,
      gravado.atualizado_em, p_perfil_id, p_usuario_id, left(p_nome, 120), p_impersonado_por);
    return query select 'salvo'::text, gravado.versao, checklist_metas_json(gravado), gravado.atualizado_em, gravado.atualizado_por_nome;
    return;
  end if;

  if atual.versao <> coalesce(p_versao_esperada, -1) then
    return query select 'conflito'::text, atual.versao, checklist_metas_json(atual), atual.atualizado_em, atual.atualizado_por_nome;
    return;
  end if;

  if (atual.preparo_meta_min, atual.preparo_aviso_pct, atual.entrega_meta_min, atual.entrega_aviso_pct, atual.vida_meta_min, atual.vida_aviso_pct)
     = (round(p_preparo_meta, 1), round(p_preparo_aviso, 1), round(p_entrega_meta, 1), round(p_entrega_aviso, 1), round(p_vida_meta, 1), round(p_vida_aviso, 1)) then
    return query select 'sem_alteracao'::text, atual.versao, checklist_metas_json(atual), atual.atualizado_em, atual.atualizado_por_nome;
    return;
  end if;

  update checklist_metas m set
    versao = m.versao + 1,
    preparo_meta_min = round(p_preparo_meta, 1), preparo_aviso_pct = round(p_preparo_aviso, 1),
    entrega_meta_min = round(p_entrega_meta, 1), entrega_aviso_pct = round(p_entrega_aviso, 1),
    vida_meta_min = round(p_vida_meta, 1), vida_aviso_pct = round(p_vida_aviso, 1),
    atualizado_em = now(), atualizado_por_perfil_id = p_perfil_id, atualizado_por_nome = left(p_nome, 120)
  where m.unidade_id = p_unidade_id
  returning m.* into gravado;

  insert into checklist_metas_historico (organizacao_id, unidade_id, versao, anterior, novo, origem,
    alterado_em, alterado_por_perfil_id, alterado_por_usuario_id, alterado_por_nome, impersonado_por)
  values (p_organizacao_id, p_unidade_id, gravado.versao, checklist_metas_json(atual), checklist_metas_json(gravado), p_origem,
    gravado.atualizado_em, p_perfil_id, p_usuario_id, left(p_nome, 120), p_impersonado_por);

  return query select 'salvo'::text, gravado.versao, checklist_metas_json(gravado), gravado.atualizado_em, gravado.atualizado_por_nome;
end $$;

alter table checklist_metas enable row level security;
alter table checklist_metas_historico enable row level security;
-- NENHUMA policy: deny-all para anon/authenticated. Acesso só pelo backend.

do $$
declare
  fn_salvar constant text := 'checklist_metas_salvar(uuid, uuid, bigint, numeric, numeric, numeric, numeric, numeric, numeric, text, uuid, uuid, text, uuid)';
  papel text;
begin
  foreach papel in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if papel = 'public' or exists (select 1 from pg_roles where rolname = papel) then
      execute format('revoke all on table checklist_metas from %s', papel);
      execute format('revoke all on table checklist_metas_historico from %s', papel);
      execute format('revoke all on function %s from %s', fn_salvar, papel);
      execute format('revoke all on function checklist_metas_json(checklist_metas) from %s', papel);
      execute format('revoke all on function checklist_metas_validar_tenant() from %s', papel);
      execute format('revoke all on function checklist_metas_historico_imutavel() from %s', papel);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- O backend só LÊ as tabelas; toda escrita passa pela função (versão + histórico na mesma transação).
    grant select on table checklist_metas to service_role;
    grant select on table checklist_metas_historico to service_role;
    execute format('grant execute on function %s to service_role', fn_salvar);
  end if;
end $$;

commit;
