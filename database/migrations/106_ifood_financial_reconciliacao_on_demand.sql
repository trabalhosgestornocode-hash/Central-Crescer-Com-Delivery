-- =====================================================================
-- MIGRATION 106 — iFood Financial: registro das solicitações de
-- Reconciliation On Demand (requestId)
-- =====================================================================
-- STATUS: ARQUIVO LOCAL PARA REVISÃO. NÃO APLICADA em nenhum banco.
--         Só aplicar com autorização explícita (primeiro no projeto de TESTE).
--
-- OBJETIVO
--   Guardar o requestId devolvido pelo POST .../reconciliation/on-demand por
--   organização + unidade + conexão + competência. A doc oficial manda, no
--   409 ("solicitação recente já em progresso"), REUTILIZAR o requestId
--   anterior — e o 409 não devolve esse id. Também permite retomar o
--   acompanhamento depois de recarregar a página.
--
--   Uma linha por conexão + competência (a solicitação mais recente
--   substitui a anterior). `expira_em` = solicitado_em + 24h (TTL do
--   requestId documentado pelo iFood).
--
-- SEGURANÇA
--   Backend-only (RLS habilitado SEM policy => deny-all para authenticated;
--   o backend usa service_role). Não guarda token, URL de download (assinada)
--   nem conteúdo do arquivo — só identificadores e status.
--   Os default privileges do Supabase dão GRANT ALL (inclusive TRUNCATE, que
--   NÃO passa por RLS) a anon/authenticated em toda tabela nova de `public`:
--   por isso o REVOKE explícito no fim (mesma convenção das migrations 104/105).
--
-- SEM A MIGRATION: o backend cai num registro em memória (mesmo isolamento)
-- e registra aviso — ver backend/src/modules/ifood/ifoodFinancial.solicitacoes.js.
--
-- Aditiva e idempotente. NÃO ALTERA tabelas existentes.
-- ROLLBACK: database/migrations/106_rollback.sql
-- PRÉ-REQUISITO: migration 056 (ifood_conexoes, ifood_touch_atualizado_em).
-- =====================================================================

create table if not exists ifood_financial_reconciliacoes_on_demand (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  conexao_id uuid not null references ifood_conexoes(id) on delete cascade,
  merchant_id text not null,
  competencia text not null check (competencia ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  request_id uuid not null,
  -- 'solicitado' (POST aceito) + os 4 status do GET oficial.
  status text not null default 'solicitado'
    check (status in ('solicitado', 'created', 'enqueue', 'processed', 'error')),
  mensagem_erro text,
  solicitado_por uuid references perfis(id) on delete set null,
  solicitado_em timestamptz not null default now(),
  expira_em timestamptz not null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint uq_ifood_fin_recon_od_conexao_competencia unique (conexao_id, competencia)
);

create index if not exists idx_ifood_fin_recon_od_request
  on ifood_financial_reconciliacoes_on_demand(conexao_id, request_id);
create index if not exists idx_ifood_fin_recon_od_tenant
  on ifood_financial_reconciliacoes_on_demand(organizacao_id, unidade_id);

drop trigger if exists trg_ifood_fin_recon_od_upd on ifood_financial_reconciliacoes_on_demand;
create trigger trg_ifood_fin_recon_od_upd before update on ifood_financial_reconciliacoes_on_demand
  for each row execute function ifood_touch_atualizado_em();

alter table ifood_financial_reconciliacoes_on_demand enable row level security;
-- Sem policy para `authenticated`: deny-all é o comportamento desejado.

-- Nenhum privilégio para os papéis do frontend (anon/authenticated); só o
-- backend (service_role) acessa. Idempotente.
revoke all on ifood_financial_reconciliacoes_on_demand from anon, authenticated;
