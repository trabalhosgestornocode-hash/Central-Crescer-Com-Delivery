-- =====================================================================
-- MIGRATION 103 — iFood Order (Checkpoint D): ready, dispatch, cancelamento e Handshake
-- =====================================================================
-- STATUS: ARQUIVO LOCAL PARA REVISÃO. NÃO APLICADA em nenhum banco.
--         Só aplicar com autorização explícita (primeiro no projeto de TESTE).
--
-- OBJETIVO
--   1. `action_state` (ifood_pedidos) passa de 4 para 13 valores: none + {confirm|ready|dispatch|cancel}_{sending|requested|failed}.
--      MODELAGEM: uma ação em andamento por pedido (a última). O HISTÓRICO completo de cada tentativa vive em
--      `ifood_pedido_acoes` (auditoria), então não é preciso um estado por ação simultânea. `action_uncertain`
--      marca "timeout/5xx: o iFood pode ter processado" — nesse caso o estado fica `<acao>_requested` e a
--      prioridade é AGUARDAR O EVENTO OFICIAL, nunca reenviar às cegas.
--   2. Carimbos por ação em `ifood_pedidos` (ready/dispatch/cancel: solicitado x evento oficial) e o motivo de cancelamento
--      (código + descrição oficiais, vindos de GET /cancellationReasons).
--   3. `ifood_pedido_acoes` (auditoria, criada na 102) ganha: conexao_id, tentativa, requested_at, responded_at,
--      error_message, request_payload, response_payload (SANITIZADOS — nunca token/segredo), dispute_id; e os CHECKs de
--      `acao`/`resultado` são ampliados.
--   4. `ifood_disputas` — negociações do Handshake (HANDSHAKE_DISPUTE/SETTLEMENT): identidade, prazo, ação de timeout,
--      alternativas, decisão enviada, resposta do iFood e settlement(s) recebidos.
--
-- REGRA DE OURO (inalterada desde o Checkpoint C)
--   Ação HTTP aceita NÃO muda `status_oficial`. Só o EVENTO oficial muda. Aqui: ready 202 => ready_requested;
--   dispatch 202 => dispatch_requested; requestCancellation 202 => cancel_requested; o estado só muda com RTP/DSP/CAN.
--
-- NÃO ALTERA: 056, 101, 102 (os arquivos). Só amplia o CHECK de action_state e os de acao/resultado, em DDL nova.
-- Aditiva e idempotente. Nenhuma linha existente muda de valor.
-- ROLLBACK: database/migrations/103_rollback.sql (aborta se houver dados dependentes da 103).
-- PRÉ-REQUISITO: migration 102.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ifood_pedidos: estado da ação + carimbos
-- ---------------------------------------------------------------------
alter table ifood_pedidos drop constraint if exists ck_ifood_pedidos_action_state;
alter table ifood_pedidos add constraint ck_ifood_pedidos_action_state
  check (action_state ~ '^(none|(confirm|ready|dispatch|cancel)_(sending|requested|failed))$');

alter table ifood_pedidos
  add column if not exists action_uncertain boolean not null default false,
  add column if not exists action_attempts integer not null default 0,        -- tentativas da ação ATUAL (ready/dispatch/cancel)
  add column if not exists action_last_error text,
  add column if not exists action_http_status integer,
  add column if not exists action_requested_at timestamptz,                    -- início da tentativa atual
  add column if not exists ready_requested_at timestamptz,
  add column if not exists ready_event_at timestamptz,                         -- evento oficial (RTP)
  add column if not exists dispatch_requested_at timestamptz,
  add column if not exists dispatch_event_at timestamptz,                      -- evento oficial (DSP)
  add column if not exists cancel_requested_at timestamptz,
  add column if not exists cancel_event_at timestamptz,                        -- evento oficial (CAN)
  add column if not exists cancel_reason_code text,                            -- código OFICIAL (GET cancellationReasons)
  add column if not exists cancel_reason_description text,
  add column if not exists cancel_failed_event_at timestamptz;                 -- CANCELLATION_REQUEST_FAILED

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ck_ifood_pedidos_action_uncertain') then
    alter table ifood_pedidos add constraint ck_ifood_pedidos_action_uncertain
      check (action_uncertain = false or action_state ~ '_requested$');       -- incerto só existe com ação "solicitada"
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. ifood_pedido_acoes: auditoria completa
-- ---------------------------------------------------------------------
alter table ifood_pedido_acoes
  add column if not exists conexao_id uuid references ifood_conexoes(id) on delete set null,
  add column if not exists tentativa integer,
  add column if not exists requested_at timestamptz,
  add column if not exists responded_at timestamptz,
  add column if not exists error_message text,                 -- sanitizada (sem token/segredo)
  add column if not exists request_payload jsonb,              -- o que enviamos (SEM Authorization/token)
  add column if not exists response_payload jsonb,             -- resposta sanitizada
  add column if not exists dispute_id text;

alter table ifood_pedido_acoes drop constraint if exists ifood_pedido_acoes_acao_check;
alter table ifood_pedido_acoes drop constraint if exists ck_ifood_pedido_acoes_acao;
alter table ifood_pedido_acoes add constraint ck_ifood_pedido_acoes_acao
  check (acao in ('confirm','ready','dispatch','cancel','dispute_accept','dispute_reject','dispute_alternative'));

alter table ifood_pedido_acoes drop constraint if exists ifood_pedido_acoes_resultado_check;
alter table ifood_pedido_acoes drop constraint if exists ck_ifood_pedido_acoes_resultado;
alter table ifood_pedido_acoes add constraint ck_ifood_pedido_acoes_resultado
  check (resultado in ('ENVIADA','ACEITA_202','ACEITA','RECUSADA','FALHOU','JA_SOLICITADA','INCERTO'));

create index if not exists idx_ifood_pedido_acoes_acao on ifood_pedido_acoes(pedido_id, acao, criado_em);

-- ---------------------------------------------------------------------
-- 3. ifood_disputas (Handshake / Plataforma de negociação)
-- ---------------------------------------------------------------------
create table if not exists ifood_disputas (
  id uuid primary key default gen_random_uuid(),

  dispute_id text not null,                          -- `id` da negociação no iFood (metadata.id do HANDSHAKE_DISPUTE)
  order_id text not null,
  pedido_id uuid not null references ifood_pedidos(id) on delete cascade,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  merchant_id text,

  -- HandshakeDispute (campos oficiais)
  action text,                                       -- CANCELLATION | PARTIAL_CANCELLATION | PROPOSED_AMOUNT_REFUND | PROPOSED_ADDITIONAL_TIME | VOID
  handshake_type text,                               -- AFTER_DELIVERY | DELAY | PREPARATION_TIME | AFTER_DELIVERY_PARTIALLY
  handshake_group text,
  message text,
  parent_dispute_id text,
  expires_at timestamptz,
  timeout_action text,                               -- ACCEPT_CANCELLATION | REJECT_CANCELLATION | VOID
  alternatives jsonb,
  accept_cancellation_reasons jsonb,
  evidences jsonb,
  dispute_payload jsonb,                             -- metadata bruta do evento
  dispute_event_id text,
  dispute_created_at timestamptz,
  dispute_event_received_at timestamptz,

  -- Ciclo local
  status text not null default 'ABERTA'
    check (status in ('ABERTA','RESPONDENDO','RESPONDIDA','RESPOSTA_INCERTA','RESPOSTA_FALHOU','ENCERRADA')),
  decision text check (decision in ('ACCEPT','REJECT','ALTERNATIVE')),
  decision_reason text,
  decision_request jsonb,                            -- corpo enviado (sanitizado)
  decision_requested_at timestamptz,
  decision_responded_at timestamptz,
  decision_http_status integer,
  decision_response jsonb,
  decision_error text,
  decision_attempts integer not null default 0,

  -- Settlement(s) recebido(s): ALTERNATIVE_REPLIED pode ser seguido de um final (ACCEPTED/REJECTED/EXPIRED)
  settlement_status text,                            -- o mais recente
  settlement_reason text,
  settlement_at timestamptz,
  settlements jsonb not null default '[]'::jsonb,    -- [{event_id,status,reason,at}]

  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),

  -- Uma negociação, um tenant, uma linha.
  constraint uq_ifood_disputas_dispute_id unique (dispute_id)
);

create index if not exists idx_ifood_disputas_tenant on ifood_disputas(organizacao_id, unidade_id, status);
create index if not exists idx_ifood_disputas_pedido on ifood_disputas(pedido_id);
create index if not exists idx_ifood_disputas_abertas on ifood_disputas(expires_at) where status in ('ABERTA','RESPONDENDO','RESPOSTA_INCERTA','RESPOSTA_FALHOU');

drop trigger if exists trg_ifood_disputas_upd on ifood_disputas;
create trigger trg_ifood_disputas_upd before update on ifood_disputas
  for each row execute function ifood_touch_atualizado_em();

alter table ifood_disputas enable row level security;   -- sem policy: backend-only (service_role)
