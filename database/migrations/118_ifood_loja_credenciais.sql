-- =====================================================================
-- 118 — iFood: CREDENCIAL OAUTH PRÓPRIA por loja adicional (credenciais independentes por merchant na MESMA unidade)
-- =====================================================================
-- A 117 deu à unidade lojas adicionais que compartilham a credencial Order da conexão. O suporte do iFood recomenda uma autorização OAuth
-- INDEPENDENTE por merchant. Esta migration guarda, para uma loja adicional (ifood_conexao_lojas), tokens PRÓPRIOS — e associa uma sessão
-- OAuth a uma loja-alvo. Nada existente muda: ifood_conexoes, ifood_credenciais e a 117 ficam como estão (só ganham uma tabela e uma coluna
-- NOVAS ao lado). A unidade continua tendo UMA conexão; os pedidos e eventos continuam na unidade, com a origem em `merchant_id`.
--
-- TITULAR ÚNICO DA CREDENCIAL de cada merchant (regra, não convenção):
--   * loja SEM linha em ifood_loja_credenciais  -> usa a credencial Order da conexão (modo compartilhado, como na 117);
--   * loja COM linha em ifood_loja_credenciais  -> usa SÓ a própria. Se ela estiver em `reauth_required`, a loja fica parada: o poller NUNCA
--     cai de volta para o token da conexão (que não a cobre e geraria 403 = infração).
--   `unique (loja_id, app_type)` garante no máximo uma credencial própria por loja; o índice único de merchant vivo da 117 garante que o merchant
--   está em uma só loja; e a 117 já impede que seja a loja principal de outra conexão. Logo, cada merchant tem exatamente um titular efetivo.
--
-- Isolamento: organização/unidade da credencial e da sessão são DERIVADAS da loja (trigger) e conferidas — nunca vêm de quem grava.
-- Backend-only: RLS ligada, nenhuma policy; só o service_role acessa; tokens SEMPRE cifrados pelo backend (AES-256-GCM, shared/cripto.js).
-- Apenas o app `order` (Events/Order) tem credencial por loja; Financial/Analytics seguem só por conexão.
--
-- 100% ADITIVA e idempotente. Sem linhas na tabela nova, o comportamento é IDÊNTICO ao da 117. Rollback: 118_rollback.sql.

begin;
set local lock_timeout = '5s';

create table if not exists ifood_loja_credenciais (
  id uuid primary key default gen_random_uuid(),
  loja_id uuid not null references ifood_conexao_lojas(id) on delete cascade,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,   -- preenchida pelo gatilho (a da loja)
  unidade_id uuid not null references unidades(id) on delete cascade,           -- idem
  app_type text not null check (app_type = 'order'),

  access_token_cifrado text not null,
  refresh_token_cifrado text,
  expira_em timestamptz not null,
  token_type text,
  status text not null default 'ativa' check (status in ('ativa', 'reauth_required')),

  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),

  constraint uq_ifood_loja_cred_loja_app unique (loja_id, app_type)
);
create index if not exists idx_ifood_loja_cred_tenant on ifood_loja_credenciais(organizacao_id, unidade_id);

-- Tenant derivado da loja; a loja e o tenant não mudam depois de criados; atualizado_em.
create or replace function ifood_loja_credenciais_validar() returns trigger
language plpgsql set search_path = public as $$
declare loja record;
begin
  select l.organizacao_id, l.unidade_id, l.estado into loja from ifood_conexao_lojas l where l.id = new.loja_id;
  if not found then raise exception 'ifood_loja_credenciais: loja % não existe', new.loja_id; end if;
  if tg_op = 'INSERT' then
    if loja.estado = 'desativada' then raise exception 'ifood_loja_credenciais: loja desativada não recebe credencial'; end if;
    new.organizacao_id := loja.organizacao_id;
    new.unidade_id := loja.unidade_id;
    return new;
  end if;
  if new.loja_id is distinct from old.loja_id or new.app_type is distinct from old.app_type
     or new.organizacao_id is distinct from old.organizacao_id or new.unidade_id is distinct from old.unidade_id then
    raise exception 'ifood_loja_credenciais: loja, app e tenant não mudam';
  end if;
  new.atualizado_em := now();
  return new;
end $$;

drop trigger if exists trg_ifood_loja_credenciais_validar on ifood_loja_credenciais;
create trigger trg_ifood_loja_credenciais_validar before insert or update on ifood_loja_credenciais
  for each row execute function ifood_loja_credenciais_validar();

-- Sessão OAuth direcionada a UMA loja adicional (nula = fluxo da conexão, como sempre).
alter table ifood_oauth_sessoes add column if not exists loja_id uuid references ifood_conexao_lojas(id) on delete cascade;
create index if not exists idx_ifood_oauth_sessoes_loja on ifood_oauth_sessoes(loja_id) where loja_id is not null;

create or replace function ifood_oauth_sessoes_loja_validar() returns trigger
language plpgsql set search_path = public as $$
declare loja record;
begin
  if new.loja_id is null then return new; end if;
  if new.app_type <> 'order' then raise exception 'ifood_oauth_sessoes: sessão de loja só para o app order'; end if;
  select l.organizacao_id, l.unidade_id into loja from ifood_conexao_lojas l where l.id = new.loja_id;
  if not found or new.organizacao_id is distinct from loja.organizacao_id or new.unidade_id is distinct from loja.unidade_id then
    raise exception 'ifood_oauth_sessoes: a loja-alvo não pertence a esta organização/unidade';
  end if;
  if tg_op = 'UPDATE' and new.loja_id is distinct from old.loja_id then
    raise exception 'ifood_oauth_sessoes: a loja-alvo não muda';
  end if;
  return new;
end $$;

drop trigger if exists trg_ifood_oauth_sessoes_loja on ifood_oauth_sessoes;
create trigger trg_ifood_oauth_sessoes_loja before insert or update on ifood_oauth_sessoes
  for each row execute function ifood_oauth_sessoes_loja_validar();

-- Backend-only: RLS ligada, NENHUMA policy.
alter table ifood_loja_credenciais enable row level security;

do $$
begin
  revoke all on table ifood_loja_credenciais from public;
  revoke all on function ifood_loja_credenciais_validar() from public;
  revoke all on function ifood_oauth_sessoes_loja_validar() from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table ifood_loja_credenciais from anon;
    revoke all on function ifood_loja_credenciais_validar() from anon;
    revoke all on function ifood_oauth_sessoes_loja_validar() from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table ifood_loja_credenciais from authenticated;
    revoke all on function ifood_loja_credenciais_validar() from authenticated;
    revoke all on function ifood_oauth_sessoes_loja_validar() from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- O backend lê, cria e atualiza a credencial da loja; nunca apaga (a remoção é operação supervisionada).
    revoke all on table ifood_loja_credenciais from service_role;
    grant select, insert, update on table ifood_loja_credenciais to service_role;
  end if;
end $$;

-- PÓS-CONDIÇÃO (falha segura, por privilégio EFETIVO): anon/authenticated/PUBLIC sem NENHUM acesso; service_role sem delete.
do $$
declare r text; sobra text := '';
begin
  foreach r in array array['anon', 'authenticated'] loop
    if to_regrole(r) is null then continue; end if;
    if has_table_privilege(r, 'public.ifood_loja_credenciais', 'select,insert,update,delete,truncate,references,trigger') then sobra := sobra || chr(10) || '  - tabela ← ' || r; end if;
  end loop;
  if to_regrole('service_role') is not null and has_table_privilege('service_role', 'public.ifood_loja_credenciais', 'delete,truncate') then
    sobra := sobra || chr(10) || '  - service_role ainda apaga';
  end if;
  if sobra <> '' then raise exception 'MIGRATION 118 abortada e DESFEITA: privilégios indevidos:%', sobra; end if;
end $$;

notify pgrst, 'reload schema';

commit;
