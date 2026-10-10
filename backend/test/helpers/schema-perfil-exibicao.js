// Esquema MÍNIMO (só o que a cadeia de login/contexto/Checklist consulta) para os testes do perfil de exibição.
// Os tipos e as constraints relevantes são cópias fiéis da base real (000_base_migration / 015): o enum papel_acesso
// COMEÇA sem `display_operator` — o valor entra pela migration 112 REAL, aplicada pelo teste, assim como a 113.
export const SCHEMA_BASE = `
create type papel_acesso as enum ('platform_superadmin', 'organization_admin', 'unit_manager', 'finance', 'operations', 'viewer');
create type status_organizacao as enum ('ativa', 'teste', 'bloqueada', 'suspensa', 'cancelada');

create table organizacoes (id uuid primary key default gen_random_uuid(), nome text not null, logo_url text,
  status status_organizacao not null default 'ativa', ativo boolean not null default true,
  cnpj text, responsavel_nome text, responsavel_email text, telefone text, trial_expira_em timestamptz, observacoes text,
  created_at timestamptz not null default now(), eh_modelo boolean not null default false, modelo_origem_id uuid, plano_id uuid);
create table planos (id uuid primary key default gen_random_uuid(), nome text, codigo text);
create table unidades (id uuid primary key default gen_random_uuid(), organizacao_id uuid not null references organizacoes(id),
  nome text not null, cidade text, cnpj text, endereco text, telefone text, ativo boolean not null default true);

create table perfis (id uuid primary key, nome text, email text, ativo boolean not null default true,
  senha_provisoria boolean not null default false, papel text, organizacao_id uuid, created_at timestamptz not null default now());
create table perfis_operacionais (id uuid primary key default gen_random_uuid(), conta_id uuid not null, nome text not null,
  ativo boolean not null default true, pin_hash text, criado_em timestamptz not null default now());

create table usuarios_organizacoes (id uuid primary key default gen_random_uuid(), usuario_id uuid not null, perfil_id uuid,
  organizacao_id uuid not null references organizacoes(id), papel papel_acesso not null default 'viewer',
  ativo boolean not null default true, created_at timestamptz not null default now(),
  constraint uo_papel_valido check (papel <> 'platform_superadmin'), unique (perfil_id, organizacao_id), unique (usuario_id, organizacao_id));
create table usuarios_unidades (id uuid primary key default gen_random_uuid(), usuario_id uuid not null, perfil_id uuid,
  unidade_id uuid not null references unidades(id), papel papel_acesso, ativo boolean not null default true,
  created_at timestamptz not null default now(),
  constraint uu_papel_valido check (papel is null or papel <> 'platform_superadmin'), unique (perfil_id, unidade_id), unique (usuario_id, unidade_id));

create table sessoes_contexto (id uuid primary key default gen_random_uuid(), usuario_id uuid not null, organizacao_id uuid not null,
  unidade_id uuid, papel papel_acesso not null, permissoes jsonb not null default '[]', modulos jsonb not null default '[]',
  impersonado_por uuid, ip text, user_agent text, expira_em timestamptz not null, revogada_em timestamptz, motivo_revogacao text,
  perfil_id uuid, selecao_nonce text, criada_em timestamptz not null default now(), ultimo_uso_em timestamptz not null default now());

create table plataforma_admins (usuario_id uuid primary key, ativo boolean not null default true, observacao text);
create table painel_administrativo_usuarios (usuario_id uuid primary key, ativo boolean not null default true, observacao text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table organizacao_modulos (organizacao_id uuid not null references organizacoes(id), modulo_id text not null, primary key (organizacao_id, modulo_id));
create table unidade_modulos (unidade_id uuid not null references unidades(id), modulo_id text not null, primary key (unidade_id, modulo_id));

create table plataforma_auditoria (id uuid primary key default gen_random_uuid(), ator_id uuid, ator_email text, ator_tipo text not null default 'usuario',
  acao text not null, entidade text, entidade_id text, organizacao_id uuid, impersonado_por uuid, detalhes jsonb not null default '{}',
  ip text, user_agent text, created_at timestamptz not null default now(), perfil_id uuid);

create table realtime_channel_grants (sessao_contexto_id uuid not null, topico text not null, usuario_id uuid not null,
  expira_em timestamptz not null, primary key (sessao_contexto_id, topico));

-- Dados do Checklist (só leitura): sem conexão iFood a integração fica "não ativada"; os pedidos vêm de ifood_pedidos.
create table ifood_conexoes (id uuid primary key default gen_random_uuid(), organizacao_id uuid not null, unidade_id uuid not null,
  status text not null default 'pendente', merchant_id text, criado_por uuid);
create table ifood_pedidos (order_id text primary key, organizacao_id uuid not null, unidade_id uuid not null, display_id text,
  status_oficial text, status_oficial_em timestamptz, order_type text, delivery_by text, order_timing text, is_test boolean not null default false,
  order_created_at timestamptz, placed_event_created_at timestamptz, confirmed_event_at timestamptz, ready_event_at timestamptz,
  dispatch_event_at timestamptz, cancel_event_at timestamptz, primeiro_evento_em timestamptz, criado_em timestamptz not null default now());
`;
