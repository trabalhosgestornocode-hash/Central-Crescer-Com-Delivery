-- =====================================================================
-- MIGRATION 109 — Comunicação: envios ao GRUPO INTERNO da operação
-- =====================================================================
-- OBJETIVO
--   Registrar, com idempotência garantida pelo banco, cada mensagem enviada
--   ao grupo interno do WhatsApp ("Crescer Com Delivery - Central"):
--     * TESTE_GRUPO               — teste controlado pelo Painel Administrativo;
--     * RELATORIO_DASHBOARD_IFOOD — relatório diário de pendências (D-1).
--
-- POR QUE UMA TABELA PRÓPRIA (e não comunicacao_mensagens)
--   comunicacao_mensagens é por organização/contato/telefone (alerta a um
--   destinatário de UMA empresa). O grupo interno não pertence a nenhuma
--   organização e não é um contato — misturar os dois quebraria os limites,
--   a política e a Central de Comunicação, que contam/filtram por empresa.
--
-- IDEMPOTÊNCIA
--   UNIQUE(chave_idempotencia). Quem consegue o INSERT é o ÚNICO que chama o
--   Gateway; qualquer outro chamador (duplo clique, retry, outra instância,
--   restart) encontra a linha e NÃO envia. Chaves:
--     teste:      grupo_teste:<testeId>
--     relatório:  ifood_dashboard_alert:<AAAA-MM-DD>:<grupo_jid>
--
-- STATUS
--   PROCESSING       reservado, Gateway ainda não chamado (nada saiu);
--   SENDING          chamada ao Gateway em andamento;
--   SENT             o Gateway devolveu providerMessageId;
--   FAILED           falha COMPROVADAMENTE antes do envio (motivo);
--   DELIVERY_UNKNOWN não é possível provar que nada saiu — NUNCA reenviar
--                    automaticamente.
--
-- Aditiva e idempotente. NÃO ALTERA tabelas existentes.
-- ROLLBACK: database/migrations/109_rollback.sql
-- PRÉ-REQUISITO: perfis (base).
-- =====================================================================

create table if not exists comunicacao_envios_grupo (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('TESTE_GRUPO', 'RELATORIO_DASHBOARD_IFOOD')),
  chave_idempotencia text not null check (length(chave_idempotencia) between 1 and 200),
  grupo_jid text not null check (grupo_jid ~ '^[0-9]{5,40}(-[0-9]{5,20})?@g\.us$'),
  data_referencia date,
  status text not null default 'PROCESSING'
    check (status in ('PROCESSING', 'SENDING', 'SENT', 'FAILED', 'DELIVERY_UNKNOWN')),
  motivo text check (motivo is null or length(motivo) <= 300),
  conteudo text not null check (length(conteudo) between 1 and 4096),
  provider_message_id text,
  -- Números do relatório (verificadas, críticas, atenção...) e o nome do grupo confirmado — nunca telefone ou credencial.
  resumo jsonb not null default '{}'::jsonb,
  tentativas integer not null default 0 check (tentativas >= 0),
  criado_por uuid references perfis(id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  enviado_em timestamptz,
  falhou_em timestamptz,
  constraint uq_comunicacao_envios_grupo_chave unique (chave_idempotencia)
);

create index if not exists idx_comunicacao_envios_grupo_tipo_data
  on comunicacao_envios_grupo(tipo, data_referencia desc, criado_em desc);

create or replace function comunicacao_envios_grupo_touch()
returns trigger language plpgsql as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;

drop trigger if exists trg_comunicacao_envios_grupo_upd on comunicacao_envios_grupo;
create trigger trg_comunicacao_envios_grupo_upd before update on comunicacao_envios_grupo
  for each row execute function comunicacao_envios_grupo_touch();

alter table comunicacao_envios_grupo enable row level security;
-- Sem policy: deny-all para anon/authenticated. Só o backend (service_role).

revoke all on comunicacao_envios_grupo from anon, authenticated;
revoke all on function comunicacao_envios_grupo_touch() from public, anon, authenticated;
