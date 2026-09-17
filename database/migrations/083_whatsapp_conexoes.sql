-- =====================================================================
-- MIGRATION 083 — whatsapp_conexoes (Checkpoint C1)
-- =====================================================================
-- ⚠️  NÃO APLICAR EM PRODUÇÃO NEM EM BANCO DE TESTE SEM APROVAÇÃO EXPLÍCITA.
-- ⚠️  ESTE ARQUIVO FOI CRIADO LOCALMENTE NO CHECKPOINT C1 E NÃO FOI
--     APLICADO EM NENHUM BANCO (nem produção, nem teste) ATÉ AGORA.
--
-- OBJETIVO
--   Persistir o estado de UMA conexão do Gateway WhatsApp (Baileys) por
--   organização: status do lifecycle, telefone conectado, heartbeat
--   (last_seen_at) e o auth state CIFRADO (nunca em claro — a chave de
--   decifra mora só no processo gateway-whatsapp, nunca aqui).
--
--   Esta migration é SÓ SCHEMA ADITIVO. Nenhuma tabela existente é alterada.
--   Mesmo padrão de segurança da 082: RLS habilitado, zero policies (deny-
--   by-default), revoke explícito de anon/authenticated, service_role único
--   consumidor.
--
-- POR QUE BLOB MONOLÍTICO, NÃO TABELA POR CHAVE (decisão do Checkpoint C1)
--   `auth_state_encrypted` guarda creds + TODAS as chaves do Signal
--   Protocol cifradas juntas num blob único (AES-256-GCM, formato
--   versionado — ver gateway-whatsapp/src/crypto.js), não uma tabela
--   `whatsapp_auth_keys` com uma linha por chave.
--
--   Evidência (instrumentação real, sem rede, rodando `initAuthCreds()` do
--   pacote `baileys@6.7.24` já instalado — ver
--   docs/gateway-whatsapp-auth-state-instrumentacao.md no repo):
--     - `creds` sozinho serializa em ~1,8 KB.
--     - As categorias de `keys` são um conjunto FECHADO de 6 valores
--       (`pre-key`, `session`, `sender-key`, `sender-key-memory`,
--       `app-state-sync-key`, `app-state-sync-version`), e o escopo já
--       fechado do C0/C1 (um único número, sem grupos, sem sincronizar
--       histórico, poucos contatos administrativos) limita estruturalmente
--       esse volume a dezenas de entradas, não milhares.
--     - Uma tabela por chave obrigaria o backend a conhecer nomes/ids de
--       chave do Signal Protocol em claro (para ter uma PK), mesmo com o
--       VALOR cifrado — pior superfície do que um blob opaco único.
--     - O Gateway já resolve get/set em memória durante a sessão ativa; só
--       persiste no backend em `creds.update` — não há padrão de escrita
--       "quente" por chave individual que justifique uma linha por chave.
--   Não é irrevogável — se o uso crescer para múltiplos números/grupos,
--   revisitar (o próprio relatório do Checkpoint C0 já previa isso).
--
-- POR QUE O BACKEND NUNCA DECIFRA (ajuste do Checkpoint C0, item 8/11)
--   `auth_state_encrypted` e `auth_state_version` são os ÚNICOS campos que
--   carregam a sessão — ambos ciphertext opaco do ponto de vista do
--   backend. A chave AES-256-GCM (`WHATSAPP_AUTH_ENCRYPTION_KEY`) só existe
--   no processo gateway-whatsapp. Um comprometimento isolado do backend
--   (ou deste banco) não basta para sequestrar a sessão WhatsApp.
--
-- POR QUE `provider_instance_id` DESDE JÁ (Checkpoint C0, item 20)
--   Mesmo com um único número hoje, o campo evita reescrever o contrato
--   quando um segundo número/gateway aparecer. Não superdimensionado: não
--   há roteamento multi-instância nenhum construído agora, só o campo.
--
-- PRÉ-REQUISITOS: migration 000 (organizacoes) aplicada.
-- TRANSACIONAL: todo o arquivo roda em uma transação.
-- IDEMPOTENTE: reexecutável com segurança (if not exists / on conflict).
-- ROLLBACK: database/migrations/083_rollback.sql.
-- =====================================================================

-- =====================================================================
-- PRÉ-CHECK OBRIGATÓRIO (execute isoladamente ANTES; nada aqui escreve)
-- =====================================================================
--   select to_regclass('public.whatsapp_conexoes');       -- precisa ser NULL (ainda não existe)
--   select to_regprocedure('public.set_updated_at()');    -- precisa existir (migration 000)
-- =====================================================================

begin;

create table if not exists whatsapp_conexoes (
  id                     uuid primary key default gen_random_uuid(),
  organizacao_id         uuid not null references organizacoes(id) on delete cascade,
  provider               text not null default 'baileys',
  provider_instance_id   text not null default 'default',
  status                 text not null default 'DISCONNECTED' check (status in (
    'CONNECTING', 'CONNECTED', 'DISCONNECTED', 'LOGGED_OUT'
  )),
  telefone_e164          text,
  -- Ciphertext opaco (AES-256-GCM, formato versionado) — ver justificativa
  -- no topo do arquivo. O backend NUNCA decifra isto.
  auth_state_encrypted   text,
  auth_state_version     text,
  connected_at           timestamptz,
  disconnected_at        timestamptz,
  -- Atualizado pelo heartbeat do Gateway (Checkpoint C0, item 16/17) — a
  -- indisponibilidade é inferível por ausência prolongada, nunca só por
  -- estado em memória do backend.
  last_seen_at           timestamptz,
  -- Mesmo vocabulário de comunicacao_tentativas.erro_classificacao (082) —
  -- nunca uma string livre.
  last_error_class       text check (last_error_class in ('RETRYAVEL', 'PERMANENTE', 'INCERTO')),
  gateway_version        text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint whatsapp_conexoes_instancia_unica unique (organizacao_id, provider_instance_id)
);

comment on table whatsapp_conexoes is
  'Estado de UMA conexão do Gateway WhatsApp (Baileys) por organização/instância. auth_state_encrypted é ciphertext opaco (AES-256-GCM) — o backend armazena, nunca decifra; a chave só existe no processo gateway-whatsapp.';
comment on column whatsapp_conexoes.auth_state_encrypted is
  'Blob monolítico cifrado (creds + todas as chaves do Signal Protocol) — formato versionado v1:<iv>:<authTag>:<ciphertext>. Ver gateway-whatsapp/src/crypto.js e docs/gateway-whatsapp-auth-state-instrumentacao.md.';
comment on column whatsapp_conexoes.provider_instance_id is
  'Preparação para múltiplos números/gateways (Checkpoint C0, item 20) — hoje sempre "default", sem roteamento multi-instância construído.';
comment on column whatsapp_conexoes.last_seen_at is
  'Atualizado a cada heartbeat do Gateway. Ausência prolongada = gateway morto, sem depender de estado em memória do backend.';

create index if not exists idx_whatsapp_conexoes_organizacao on whatsapp_conexoes (organizacao_id);

drop trigger if exists trg_whatsapp_conexoes_upd on whatsapp_conexoes;
create trigger trg_whatsapp_conexoes_upd before update on whatsapp_conexoes
  for each row execute function set_updated_at();

alter table whatsapp_conexoes enable row level security;
revoke all on whatsapp_conexoes from authenticated, anon;

-- =====================================================================
-- PÓS-CHECK (execute isoladamente DEPOIS; nada aqui escreve)
-- =====================================================================
--   select to_regclass('public.whatsapp_conexoes');                          -- não NULL
--   select conname from pg_constraint where conname = 'whatsapp_conexoes_instancia_unica'; -- 1 linha
--   select relrowsecurity from pg_class where relname = 'whatsapp_conexoes'; -- true
--   select grantee, privilege_type from information_schema.role_table_grants
--     where table_name = 'whatsapp_conexoes' and grantee in ('anon', 'authenticated'); -- 0 linhas
-- =====================================================================

commit;
