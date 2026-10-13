-- =====================================================================
-- 117 — iFood: LOJAS ADICIONAIS por conexão (vários merchants na MESMA unidade e credencial Order)
-- =====================================================================
-- Hoje uma unidade tem UMA conexão viva com UM merchant (ifood_conexoes.merchant_id; índices únicos 056). Uma unidade com duas lojas no
-- iFood (ex.: Subway Sanduíches + Subway Saladas, mesma operação) não consegue receber os pedidos da segunda. Esta tabela guarda as lojas
-- ADICIONAIS da conexão. A loja principal continua EXATAMENTE onde está (ifood_conexoes.merchant_id): nenhuma coluna existente muda.
--
-- O poller só consulta a loja adicional quando ela está `ativa` ou `liberada` — e só a libera uma ação SUPERVISIONADA e explícita
-- (database/operacoes/ifood-loja-extra-liberar.sql). Consultar um merchant NÃO autorizado é infração no iFood; por isso a tabela guarda um
-- BLOQUEIO PERSISTENTE:
--
--   pendente   -> cadastrada; NUNCA consultada
--   liberada   -> supervisão autorizou a verificação: o poller inclui a loja no polling (no máximo `max` vezes) e, se o iFood não recusar,
--                 passa a `ativa`; se recusar (403 `unauthorizedMerchants`) ou esgotar as tentativas, vai a `bloqueada`
--   ativa      -> consultada a cada ciclo, junto com a loja principal (mesmo token, mesma credencial)
--   bloqueada  -> o iFood recusou (ou esgotou tentativas): NUNCA mais consultada, nem depois de reiniciar/deploy, até uma nova liberação
--                 supervisionada (única saída; exige `set local app.liberacao_supervisionada = 'on'` na mesma transação)
--   desativada -> removida pelo gestor; nunca consultada (cadastro encerrado, histórico preservado)
--
-- Isolamento: organização/unidade da linha DEVEM ser as da conexão (trigger), e o merchant não pode ser a loja principal de nenhuma conexão
-- viva nem repetir em outra loja adicional (índice único). Backend-only: RLS ligada, nenhuma policy; só o service_role acessa.
-- Sem token, sem segredo, sem payload do iFood. As linhas nunca são apagadas pelo backend.
--
-- 100% ADITIVA. Sem linhas cadastradas, o comportamento do poller e do Checklist é IDÊNTICO ao anterior. Idempotente.
-- Rollback: 117_rollback.sql.

begin;
set local lock_timeout = '5s';

create table if not exists ifood_conexao_lojas (
  id uuid primary key default gen_random_uuid(),
  conexao_id uuid not null references ifood_conexoes(id) on delete cascade,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,

  merchant_id text not null check (merchant_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  rotulo text check (rotulo is null or length(btrim(rotulo)) between 1 and 40),     -- nome curto exibido no Checklist (ex.: "Saladas")

  estado text not null default 'pendente'
    check (estado in ('pendente', 'liberada', 'ativa', 'bloqueada', 'desativada')),

  verificacoes integer not null default 0 check (verificacoes >= 0),             -- vezes que a loja entrou no polling estando `liberada`
  ultima_verificacao_em timestamptz,
  liberada_em timestamptz,
  liberada_por text check (liberada_por is null or length(liberada_por) <= 120),   -- quem autorizou (texto livre; sem dado sensível)
  ativada_em timestamptz,
  bloqueada_em timestamptz,
  bloqueio_motivo text check (bloqueio_motivo is null or length(bloqueio_motivo) <= 60),   -- código curto (SEM_AUTORIZACAO, TENTATIVAS_ESGOTADAS…)
  bloqueios integer not null default 0 check (bloqueios >= 0),
  desativada_em timestamptz,

  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),

  constraint ck_ifood_conexao_lojas_liberada check (estado <> 'liberada' or liberada_em is not null),
  constraint ck_ifood_conexao_lojas_ativa check (estado <> 'ativa' or ativada_em is not null),
  constraint ck_ifood_conexao_lojas_bloqueada check (estado <> 'bloqueada' or (bloqueada_em is not null and bloqueio_motivo is not null))
);

-- Um merchant adicional "vivo" em UMA conexão só (em todo o SaaS).
create unique index if not exists uq_ifood_conexao_lojas_merchant_vivo
  on ifood_conexao_lojas(merchant_id) where estado <> 'desativada';
create index if not exists idx_ifood_conexao_lojas_conexao on ifood_conexao_lojas(conexao_id, estado);
create index if not exists idx_ifood_conexao_lojas_tenant on ifood_conexao_lojas(organizacao_id, unidade_id);

-- Regras que o CHECK não alcança: tenant igual ao da conexão, merchant que não é a loja principal, campos imutáveis e a máquina de estados.
create or replace function ifood_conexao_lojas_validar() returns trigger
language plpgsql set search_path = public as $$
declare
  con record;
  permitido boolean;
begin
  select c.organizacao_id, c.unidade_id into con from ifood_conexoes c where c.id = new.conexao_id;
  if not found then raise exception 'ifood_conexao_lojas: conexão % não existe', new.conexao_id; end if;
  if new.organizacao_id is distinct from con.organizacao_id or new.unidade_id is distinct from con.unidade_id then
    raise exception 'ifood_conexao_lojas: organização/unidade da loja diferem as da conexão';
  end if;
  if new.estado <> 'desativada' and exists (
       select 1 from ifood_conexoes c where c.merchant_id = new.merchant_id and c.status <> 'revogada') then
    raise exception 'ifood_conexao_lojas: o merchant já é a loja principal de uma conexão';
  end if;

  if tg_op = 'INSERT' then
    if new.estado <> 'pendente' then raise exception 'ifood_conexao_lojas: toda loja nasce `pendente`'; end if;
    return new;
  end if;

  if new.conexao_id is distinct from old.conexao_id or new.merchant_id is distinct from old.merchant_id
     or new.organizacao_id is distinct from old.organizacao_id or new.unidade_id is distinct from old.unidade_id then
    raise exception 'ifood_conexao_lojas: conexão, merchant e tenant não mudam (cadastre outra loja)';
  end if;

  if new.estado is distinct from old.estado then
    permitido := (old.estado, new.estado) in (
      ('pendente', 'liberada'), ('pendente', 'desativada'),
      ('liberada', 'ativa'), ('liberada', 'bloqueada'), ('liberada', 'desativada'),
      ('ativa', 'bloqueada'), ('ativa', 'desativada'),
      ('bloqueada', 'liberada'), ('bloqueada', 'desativada'),
      ('desativada', 'pendente'));
    if not permitido then raise exception 'ifood_conexao_lojas: transição % -> % não permitida', old.estado, new.estado; end if;
    -- A única saída do bloqueio é uma nova verificação supervisionada e explícita (o script de operação liga esta chave na transação).
    if old.estado = 'bloqueada' and new.estado = 'liberada'
       and coalesce(current_setting('app.liberacao_supervisionada', true), '') <> 'on' then
      raise exception 'ifood_conexao_lojas: sair de `bloqueada` exige a liberação supervisionada (app.liberacao_supervisionada = on)';
    end if;
  end if;

  new.atualizado_em := now();
  return new;
end $$;

drop trigger if exists trg_ifood_conexao_lojas_validar on ifood_conexao_lojas;
create trigger trg_ifood_conexao_lojas_validar before insert or update on ifood_conexao_lojas
  for each row execute function ifood_conexao_lojas_validar();

-- Transições feitas pelo poller (atômicas, no relógio do banco). Só o service_role executa.
create or replace function ifood_loja_iniciar_verificacao(p_id uuid, p_max integer default 3) returns text
language plpgsql set search_path = public as $$
declare r ifood_conexao_lojas%rowtype;
begin
  select * into r from ifood_conexao_lojas where id = p_id for update;
  if not found then return 'nao_encontrada'; end if;
  if r.estado <> 'liberada' then return 'estado_invalido'; end if;
  if r.verificacoes >= greatest(p_max, 1) then
    update ifood_conexao_lojas set estado = 'bloqueada', bloqueada_em = now(), bloqueio_motivo = 'TENTATIVAS_ESGOTADAS', bloqueios = bloqueios + 1
     where id = p_id;
    return 'bloqueada';
  end if;
  update ifood_conexao_lojas set verificacoes = verificacoes + 1, ultima_verificacao_em = now() where id = p_id;
  return 'ok';
end $$;

create or replace function ifood_loja_marcar_ativa(p_id uuid) returns boolean
language plpgsql set search_path = public as $$
begin
  update ifood_conexao_lojas set estado = 'ativa', ativada_em = now() where id = p_id and estado = 'liberada';
  return found;
end $$;

create or replace function ifood_loja_bloquear(p_id uuid, p_motivo text) returns boolean
language plpgsql set search_path = public as $$
begin
  update ifood_conexao_lojas
     set estado = 'bloqueada', bloqueada_em = now(), bloqueio_motivo = left(coalesce(nullif(btrim(p_motivo), ''), 'BLOQUEADA'), 60), bloqueios = bloqueios + 1
   where id = p_id and estado in ('liberada', 'ativa');
  return found;
end $$;

-- Backend-only: RLS ligada, NENHUMA policy (deny-all para anon/authenticated). Só o service_role acessa.
alter table ifood_conexao_lojas enable row level security;

do $$
begin
  revoke all on table ifood_conexao_lojas from public;
  revoke all on function ifood_conexao_lojas_validar() from public;
  revoke all on function ifood_loja_iniciar_verificacao(uuid, integer) from public;
  revoke all on function ifood_loja_marcar_ativa(uuid) from public;
  revoke all on function ifood_loja_bloquear(uuid, text) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table ifood_conexao_lojas from anon;
    revoke all on function ifood_conexao_lojas_validar() from anon;
    revoke all on function ifood_loja_iniciar_verificacao(uuid, integer) from anon;
    revoke all on function ifood_loja_marcar_ativa(uuid) from anon;
    revoke all on function ifood_loja_bloquear(uuid, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table ifood_conexao_lojas from authenticated;
    revoke all on function ifood_conexao_lojas_validar() from authenticated;
    revoke all on function ifood_loja_iniciar_verificacao(uuid, integer) from authenticated;
    revoke all on function ifood_loja_marcar_ativa(uuid) from authenticated;
    revoke all on function ifood_loja_bloquear(uuid, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- Os privilégios padrão do Supabase dão ALL ao service_role: aqui o backend só lê, cadastra e atualiza (linhas nunca são apagadas por ele).
    revoke all on table ifood_conexao_lojas from service_role;
    grant select, insert, update on table ifood_conexao_lojas to service_role;
    grant execute on function ifood_loja_iniciar_verificacao(uuid, integer) to service_role;
    grant execute on function ifood_loja_marcar_ativa(uuid) to service_role;
    grant execute on function ifood_loja_bloquear(uuid, text) to service_role;
  end if;
end $$;

-- PÓS-CONDIÇÃO (falha segura, por privilégio EFETIVO): anon/authenticated/PUBLIC sem NENHUM acesso à tabela e às funções — inclusive por grant
-- de outra role ou herança. Se algo sobrar, ABORTA e DESFAZ a migration inteira (a transação é desta migration).
do $$
declare r text; f text; sobra text := '';
begin
  foreach r in array array['anon', 'authenticated'] loop
    if to_regrole(r) is null then continue; end if;
    if has_table_privilege(r, 'public.ifood_conexao_lojas', 'select,insert,update,delete,truncate,references,trigger') then sobra := sobra || chr(10) || '  - tabela ← ' || r; end if;
    foreach f in array array['public.ifood_loja_iniciar_verificacao(uuid, integer)', 'public.ifood_loja_marcar_ativa(uuid)', 'public.ifood_loja_bloquear(uuid, text)'] loop
      if has_function_privilege(r, f, 'execute') then sobra := sobra || chr(10) || '  - ' || f || ' ← ' || r; end if;
    end loop;
  end loop;
  if sobra <> '' then raise exception 'MIGRATION 117 abortada e DESFEITA: anon/authenticated ainda teriam acesso:%', sobra; end if;
end $$;

-- O PostgREST (API do Supabase) recarrega o schema para enxergar as novas funções.
notify pgrst, 'reload schema';

commit;
