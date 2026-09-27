-- =====================================================================
-- MIGRATION 102 — iFood Order (Checkpoint C): detalhes do pedido + ação de confirmação
-- =====================================================================
-- STATUS: ARQUIVO LOCAL PARA REVISÃO. NÃO APLICADA em nenhum banco.
--         Só aplicar com autorização explícita (primeiro no projeto de TESTE).
--
-- OBJETIVO
--   Estender `ifood_pedidos` (criada na 101, mínima) com:
--     1. DETALHES do pedido (GET /order/v1.0/orders/{id}): índice operacional + payload BRUTO
--        inteiro (`details_payload`) + hash. Itens/complementos/observações ficam em jsonb como
--        o iFood enviou (nada é achatado).
--     2. CONTROLE de busca dos detalhes (retentativas com backoff: o PLACED pode chegar antes
--        dos detalhes ficarem disponíveis).
--     3. AÇÃO `confirm` com estado INTERMEDIÁRIO local (`action_state`), separado do estado
--        OFICIAL (`status_oficial`, só muda por evento).
--     4. TIMESTAMPS de SLA (confirmação obrigatória em 8 min).
--     5. `ifood_pedido_acoes` — auditoria de cada tentativa de ação (backend-only).
--
-- REGRA DE OURO DO ESTADO
--   POST /confirm com 202 => `action_state = 'confirm_requested'`. `status_oficial` continua
--   PLACED até chegar o evento CONFIRMED (CFM). O 202 NUNCA marca CONFIRMED.
--
-- Aditiva e idempotente: só ADD COLUMN IF NOT EXISTS / CREATE ... IF NOT EXISTS. Nenhuma coluna
-- da 101 (ou da 056) é alterada; nenhuma linha existente muda de valor.
-- ROLLBACK: database/migrations/102_rollback.sql
-- PRÉ-REQUISITO: migration 101.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. DETALHES DO PEDIDO
-- ---------------------------------------------------------------------
alter table ifood_pedidos
  add column if not exists display_id text,
  add column if not exists order_type text,                 -- DELIVERY | TAKEOUT | DINE_IN | INDOOR
  add column if not exists order_timing text,               -- IMMEDIATE | SCHEDULED
  add column if not exists category text,
  add column if not exists sales_channel text,
  add column if not exists is_test boolean,
  add column if not exists delivery_by text,                -- IFOOD | MERCHANT
  add column if not exists order_created_at timestamptz,    -- `createdAt` do pedido (SLA parte daqui)
  add column if not exists preparation_start_at timestamptz,
  add column if not exists scheduled_start_at timestamptz,
  add column if not exists scheduled_end_at timestamptz,
  add column if not exists pickup_code text,
  add column if not exists delivery_observations text,
  add column if not exists takeout_observations text,
  add column if not exists extra_info text,
  -- Totais
  add column if not exists total_sub_total numeric(12,2),
  add column if not exists total_delivery_fee numeric(12,2),
  add column if not exists total_additional_fees numeric(12,2),
  add column if not exists total_benefits numeric(12,2),
  add column if not exists total_order_amount numeric(12,2),
  -- Pagamento (resumo consultável; o detalhe completo está em `payments`)
  add column if not exists payment_methods text[] not null default '{}',
  add column if not exists card_brands text[] not null default '{}',
  add column if not exists cash_change_for numeric(12,2),
  add column if not exists payment_prepaid numeric(12,2),
  add column if not exists payment_pending numeric(12,2),
  add column if not exists has_offline_payment boolean,
  -- Descontos: quem financia (IFOOD/MERCHANT/EXTERNAL/CHAIN -> valor)
  add column if not exists discount_sponsors jsonb not null default '{}'::jsonb,
  -- CPF/CNPJ fiscal quando presente
  add column if not exists customer_document_number text,
  add column if not exists customer_document_type text,
  -- Estruturas preservadas como o iFood enviou (sem achatar)
  add column if not exists items_count integer,
  add column if not exists items jsonb,
  add column if not exists benefits jsonb,
  add column if not exists payments jsonb,
  add column if not exists customer jsonb,                  -- dado pessoal: backend-only (RLS deny-all)
  add column if not exists delivery jsonb,
  add column if not exists takeout jsonb,
  add column if not exists dine_in jsonb,
  add column if not exists indoor jsonb,
  add column if not exists schedule jsonb,
  add column if not exists additional_fees jsonb,
  add column if not exists additional_info jsonb,
  -- Payload bruto inteiro + hash (idempotência: mesmo hash = nada a regravar)
  add column if not exists details_payload jsonb,
  add column if not exists details_payload_hash text,
  add column if not exists details_avisos text[] not null default '{}';

-- ---------------------------------------------------------------------
-- 2. CONTROLE DA BUSCA DE DETALHES
-- ---------------------------------------------------------------------
alter table ifood_pedidos
  add column if not exists details_status text not null default 'PENDENTE',
  add column if not exists details_tentativas integer not null default 0,
  add column if not exists details_ultima_tentativa_em timestamptz,
  add column if not exists details_ultimo_erro text,
  add column if not exists details_fetched_at timestamptz,        -- 1ª vez que buscamos com sucesso (SLA)
  add column if not exists details_atualizado_em timestamptz;     -- última gravação do payload

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ck_ifood_pedidos_details_status') then
    alter table ifood_pedidos add constraint ck_ifood_pedidos_details_status
      check (details_status in ('PENDENTE','OK','NAO_ENCONTRADO','ERRO'));
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. AÇÃO CONFIRM + SLA
-- ---------------------------------------------------------------------
alter table ifood_pedidos
  add column if not exists action_state text not null default 'none',
  add column if not exists confirm_attempts integer not null default 0,
  add column if not exists confirm_last_error text,
  add column if not exists confirm_http_status integer,
  -- SLA: PLACED (evento) -> detalhes -> confirm enviado -> CONFIRMED (evento)
  add column if not exists placed_event_created_at timestamptz,
  add column if not exists placed_event_received_at timestamptz,
  add column if not exists confirm_requested_at timestamptz,
  add column if not exists confirmed_event_at timestamptz,
  add column if not exists confirmed_event_received_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ck_ifood_pedidos_action_state') then
    alter table ifood_pedidos add constraint ck_ifood_pedidos_action_state
      check (action_state in ('none','confirm_sending','confirm_requested','confirm_failed'));
  end if;
end $$;

-- Fila de detalhes pendentes (pequena, parcial).
create index if not exists idx_ifood_pedidos_details_pendentes
  on ifood_pedidos(details_ultima_tentativa_em)
  where details_status in ('PENDENTE','NAO_ENCONTRADO','ERRO');
create index if not exists idx_ifood_pedidos_action
  on ifood_pedidos(organizacao_id, unidade_id, action_state)
  where action_state <> 'none';

-- ---------------------------------------------------------------------
-- 4. AUDITORIA DE AÇÕES
-- ---------------------------------------------------------------------
create table if not exists ifood_pedido_acoes (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references ifood_pedidos(id) on delete cascade,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  order_id text not null,
  acao text not null check (acao in ('confirm')),
  resultado text not null check (resultado in ('ENVIADA','ACEITA_202','RECUSADA','FALHOU','JA_SOLICITADA')),
  http_status integer,
  erro_codigo text,
  criado_em timestamptz not null default now()
);
create index if not exists idx_ifood_pedido_acoes_pedido on ifood_pedido_acoes(pedido_id, criado_em);

alter table ifood_pedido_acoes enable row level security;   -- sem policy: backend-only (service_role)
