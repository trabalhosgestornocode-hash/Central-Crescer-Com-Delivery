-- =====================================================================
-- MIGRATION 101 — iFood Events (Checkpoint B): eventos, pedidos (mínimo) e lease do poller
-- =====================================================================
-- STATUS: ARQUIVO LOCAL PARA REVISÃO. NÃO APLICADA em nenhum banco.
--         Só aplicar com autorização explícita (primeiro no projeto de TESTE).
--
-- OBJETIVO
--   Fundação do recebimento de eventos do iFood por polling:
--     1. `ifood_eventos`       — TODO evento recebido, persistido ANTES do ACK.
--                                 UNIQUE(event_id) é a deduplicação (a API repete eventos).
--     2. `ifood_pedidos`       — estrutura MÍNIMA: um "esqueleto" do pedido + o estado
--                                 OFICIAL derivado dos eventos. Detalhes do pedido (itens,
--                                 pagamento etc.) entram no Checkpoint C — NÃO aqui.
--     3. `ifood_poller_lease`  — lease (lock com prazo) para haver UM poller por vez,
--                                 usando o relógio do BANCO (não o das instâncias).
--
-- REGRA DE OURO DO ESTADO
--   O estado do pedido só muda por EVENTO OFICIAL do iFood. Enviar /confirm e receber 202
--   NÃO muda `status_oficial`. (As ações entram no Checkpoint C.)
--
-- MULTI-TENANT (organização -> unidade -> merchantId)
--   * O tenant de um evento é resolvido no backend a partir do `merchant_id` via
--     `ifood_conexoes` (056: merchant_id único entre conexões vivas). Nunca do payload.
--   * Evento de merchant DESCONHECIDO fica em QUARENTENA: organizacao_id/unidade_id NULL
--     e processing_status = 'MERCHANT_DESCONHECIDO' (guardado para auditoria, sem tocar em
--     nenhum tenant). CHECK impede meio-tenant (org sem unidade ou vice-versa).
--   * `ifood_pedidos.order_id` é UNIQUE: um pedido nunca pertence a dois tenants.
--
-- ACK
--   `acknowledged_at` só é preenchido depois que o iFood respondeu 202 ao ACK. Evento
--   persistido e ainda sem ACK volta no polling e é re-enviado no ACK (idempotente).
--
-- SEGURANÇA
--   RLS habilitado nas três, SEM policy para `authenticated` (deny-all): backend-only
--   (service_role), como `ifood_credenciais`. Os eventos guardam o payload bruto.
--   As funções são SECURITY DEFINER e só o service_role pode executá-las.
--
-- APP_TYPE `order` (Events/Order)
--   Events e Order trabalham conceitualmente com appType = 'order' — nunca com o token do `financial`.
--   A única mudança em objetos da 056 é AMPLIAR os dois CHECKs de app_type (ifood_credenciais e
--   ifood_oauth_sessoes) de (analytics, financial) para (analytics, financial, order). O ARQUIVO da
--   056 não é editado. Nenhuma linha existente muda. `order` ainda não é oferecido ao OAuth/UI:
--   no modo distribuído só terá credencial quando o app real existir; no centralized_test usa o
--   token do app centralizado (Teste (C)) e NÃO grava credencial por unidade.
--
-- Fora isso, aditiva e idempotente (tabelas, colunas e dados da 056 não são tocados).
--
-- ROLLBACK: database/migrations/101_rollback.sql
-- COMO USAR: Supabase -> SQL Editor -> (projeto de TESTE primeiro) -> cole e execute.
-- PRÉ-REQUISITOS: migration 056 (ifood_conexoes, ifood_touch_atualizado_em) e as tabelas
--   organizacoes / unidades.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. EVENTOS
-- ---------------------------------------------------------------------
create table if not exists ifood_eventos (
  id uuid primary key default gen_random_uuid(),

  -- Identidade do evento (campos oficiais da API de Events).
  event_id text not null,                 -- `id` do evento no iFood (UUID) — chave de deduplicação
  merchant_id text not null,
  order_id text,                          -- `orderId` (pode faltar em evento anômalo)
  event_code text not null,               -- `code`     (ex.: PLC, CFM, CAN)
  event_full_code text not null,          -- `fullCode` (ex.: PLACED, CONFIRMED)
  sales_channel text,
  event_created_at timestamptz,           -- `createdAt` do iFood (a API pode entregar fora de ordem)

  -- Tenant (resolvido pelo backend via merchant_id -> ifood_conexoes). NULL = quarentena.
  organizacao_id uuid references organizacoes(id) on delete cascade,
  unidade_id uuid references unidades(id) on delete cascade,
  conexao_id uuid references ifood_conexoes(id) on delete set null,

  -- Ciclo de vida local.
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  acknowledged_at timestamptz,            -- só após HTTP 202 do ACK
  processing_status text not null default 'RECEBIDO'
    check (processing_status in (
      'RECEBIDO',              -- persistido, ainda não processado
      'PROCESSADO',            -- efeito local aplicado (ex.: estado do pedido)
      'IGNORADO',              -- código conhecido, sem efeito local neste checkpoint / superado por outro evento
      'DESCONHECIDO',          -- código fora do catálogo: guardado e reconhecido, sem efeito
      'MERCHANT_DESCONHECIDO', -- merchant sem conexão viva: quarentena, sem tenant
      'FALHOU'                 -- erro ao processar; reprocessável (retry_count)
    )),
  retry_count integer not null default 0,     -- tentativas de PROCESSAMENTO que falharam
  reentregas integer not null default 0,      -- vezes que o iFood entregou o evento de novo (observabilidade do throttling)
  ultima_entrega_em timestamptz not null default now(),
  last_error text,                            -- mensagem sanitizada

  -- Payload bruto (auditoria) + hash estável do conteúdo.
  payload jsonb not null,
  payload_hash text not null,

  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),

  -- DEDUPLICAÇÃO: o mesmo evento nunca vira duas linhas.
  constraint uq_ifood_eventos_event_id unique (event_id),

  -- Tenant completo ou nenhum (nunca só a organização, nunca só a unidade).
  constraint ck_ifood_eventos_tenant check (
    (organizacao_id is null and unidade_id is null)
    or (organizacao_id is not null and unidade_id is not null)
  ),
  -- Quarentena <=> sem tenant.
  constraint ck_ifood_eventos_quarentena check (
    (processing_status = 'MERCHANT_DESCONHECIDO') = (organizacao_id is null)
  )
);

create index if not exists idx_ifood_eventos_merchant_criado
  on ifood_eventos(merchant_id, event_created_at);
create index if not exists idx_ifood_eventos_order
  on ifood_eventos(order_id) where order_id is not null;
create index if not exists idx_ifood_eventos_tenant_order
  on ifood_eventos(organizacao_id, unidade_id, order_id) where organizacao_id is not null;
-- Fila de reprocessamento (RECEBIDO/FALHOU) — pequena, parcial.
create index if not exists idx_ifood_eventos_pendentes
  on ifood_eventos(received_at) where processing_status in ('RECEBIDO', 'FALHOU');
-- Persistido mas ainda sem ACK confirmado — observabilidade/diagnóstico.
create index if not exists idx_ifood_eventos_sem_ack
  on ifood_eventos(received_at) where acknowledged_at is null;

drop trigger if exists trg_ifood_eventos_upd on ifood_eventos;
create trigger trg_ifood_eventos_upd before update on ifood_eventos
  for each row execute function ifood_touch_atualizado_em();

-- ---------------------------------------------------------------------
-- 2. PEDIDOS (estrutura MÍNIMA — detalhes do pedido: Checkpoint C)
-- ---------------------------------------------------------------------
create table if not exists ifood_pedidos (
  id uuid primary key default gen_random_uuid(),

  order_id text not null,                  -- `orderId` do iFood
  merchant_id text not null,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,

  -- Estado OFICIAL: só muda por evento do grupo ORDER_STATUS.
  status_oficial text,                     -- PLACED | CONFIRMED | SEPARATION_STARTED | SEPARATION_ENDED |
                                           -- READY_TO_PICKUP | DISPATCHED | CONCLUDED | CANCELLED
  status_oficial_evento_id text,           -- event_id que definiu o estado atual
  status_oficial_em timestamptz,           -- createdAt desse evento (guarda contra eventos fora de ordem)

  primeiro_evento_em timestamptz,
  ultimo_evento_em timestamptz,

  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),

  -- Um pedido pertence a UM tenant, sempre.
  constraint uq_ifood_pedidos_order_id unique (order_id)
);

create index if not exists idx_ifood_pedidos_tenant
  on ifood_pedidos(organizacao_id, unidade_id, status_oficial);
create index if not exists idx_ifood_pedidos_merchant
  on ifood_pedidos(merchant_id);

drop trigger if exists trg_ifood_pedidos_upd on ifood_pedidos;
create trigger trg_ifood_pedidos_upd before update on ifood_pedidos
  for each row execute function ifood_touch_atualizado_em();

-- ---------------------------------------------------------------------
-- 3. LEASE DO POLLER (um poller por vez, com o relógio do BANCO)
-- ---------------------------------------------------------------------
create table if not exists ifood_poller_lease (
  nome text primary key,                   -- ex.: 'ifood-events-poller'
  holder text not null,                    -- identificação da instância que detém o lease
  lease_ate timestamptz not null,          -- vence sozinho (worker que caiu não trava ninguém)
  geracao bigint not null default 1,       -- +1 a cada troca de titular (fencing/observabilidade)
  atualizado_em timestamptz not null default now()
);

-- Adquire OU renova o lease. Atômico (INSERT ... ON CONFLICT DO UPDATE ... WHERE).
--   * sem linha            -> cria (adquirido);
--   * lease vencido        -> toma (geracao + 1);
--   * mesmo holder         -> renova (geracao igual);
--   * lease vivo de outro  -> NÃO altera; devolve adquirido = false + o titular atual.
create or replace function ifood_lease_adquirir(p_nome text, p_holder text, p_ttl_s integer)
returns table (adquirido boolean, lease_holder text, lease_ate timestamptz, geracao bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row ifood_poller_lease%rowtype;
begin
  if p_ttl_s is null or p_ttl_s < 5 then
    raise exception 'ttl invalido (minimo 5s)';
  end if;

  insert into ifood_poller_lease as l (nome, holder, lease_ate, geracao)
  values (p_nome, p_holder, now() + make_interval(secs => p_ttl_s), 1)
  on conflict (nome) do update
    set holder = excluded.holder,
        lease_ate = excluded.lease_ate,
        geracao = case when l.holder = excluded.holder then l.geracao else l.geracao + 1 end,
        atualizado_em = now()
    where l.lease_ate < now() or l.holder = excluded.holder
  returning l.* into v_row;

  if found then
    return query select true, v_row.holder, v_row.lease_ate, v_row.geracao;
    return;
  end if;

  select * into v_row from ifood_poller_lease where nome = p_nome;
  return query select false, v_row.holder, v_row.lease_ate, v_row.geracao;
end $$;

-- Libera o lease (shutdown gracioso). Só quem é o titular consegue.
create or replace function ifood_lease_liberar(p_nome text, p_holder text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  update ifood_poller_lease
     set lease_ate = now() - interval '1 second', atualizado_em = now()
   where nome = p_nome and holder = p_holder;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

-- Marca re-entregas (o iFood mandou de novo um evento já guardado). Observabilidade do
-- throttling: 50 entregas sem ACK geram 1 strike no iFood.
create or replace function ifood_eventos_marcar_reentrega(p_event_ids text[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  update ifood_eventos
     set reentregas = reentregas + 1, ultima_entrega_em = now()
   where event_id = any(p_event_ids);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- 4. app_type: aceitar 'order' (Events/Order) — SÓ amplia os CHECKs da 056
-- ---------------------------------------------------------------------
alter table ifood_credenciais drop constraint if exists ifood_credenciais_app_type_check;
alter table ifood_credenciais add constraint ifood_credenciais_app_type_check
  check (app_type in ('analytics', 'financial', 'order'));

alter table ifood_oauth_sessoes drop constraint if exists ifood_oauth_sessoes_app_type_check;
alter table ifood_oauth_sessoes add constraint ifood_oauth_sessoes_app_type_check
  check (app_type in ('analytics', 'financial', 'order'));

-- ---------------------------------------------------------------------
-- 5. RLS + permissões
-- ---------------------------------------------------------------------
alter table ifood_eventos       enable row level security;
alter table ifood_pedidos       enable row level security;
alter table ifood_poller_lease  enable row level security;
-- NENHUMA policy para `authenticated`: deny-all. Acesso só pelo backend (service_role).

do $$
begin
  revoke all on function ifood_lease_adquirir(text, text, integer) from public;
  revoke all on function ifood_lease_liberar(text, text) from public;
  revoke all on function ifood_eventos_marcar_reentrega(text[]) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function ifood_lease_adquirir(text, text, integer) from anon;
    revoke all on function ifood_lease_liberar(text, text) from anon;
    revoke all on function ifood_eventos_marcar_reentrega(text[]) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function ifood_lease_adquirir(text, text, integer) from authenticated;
    revoke all on function ifood_lease_liberar(text, text) from authenticated;
    revoke all on function ifood_eventos_marcar_reentrega(text[]) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function ifood_lease_adquirir(text, text, integer) to service_role;
    grant execute on function ifood_lease_liberar(text, text) to service_role;
    grant execute on function ifood_eventos_marcar_reentrega(text[]) to service_role;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 6. VERIFICAÇÃO (rode separadamente, depois de aplicar)
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname in ('ifood_credenciais_app_type_check', 'ifood_oauth_sessoes_app_type_check');
--   -- Esperado: CHECK (app_type = ANY (ARRAY['analytics', 'financial', 'order'])) nas duas.
--   select tablename, rowsecurity from pg_tables
--    where schemaname='public' and tablename in ('ifood_eventos','ifood_pedidos','ifood_poller_lease');
--   -- Esperado: 3 linhas, rowsecurity = true.
--   select conname from pg_constraint where conrelid = 'ifood_eventos'::regclass and contype in ('u','c');
--   -- Esperado: uq_ifood_eventos_event_id, ck_ifood_eventos_tenant, ck_ifood_eventos_quarentena, status_check.
--   select * from ifood_lease_adquirir('teste-verificacao', 'holder-a', 30);   -- adquirido = true
--   select * from ifood_lease_adquirir('teste-verificacao', 'holder-b', 30);   -- adquirido = false
--   select ifood_lease_liberar('teste-verificacao', 'holder-a');               -- true
--   delete from ifood_poller_lease where nome = 'teste-verificacao';
-- =====================================================================
-- FIM
-- =====================================================================
