-- =====================================================================
-- MIGRATION 097 — WhatsApp: aba CONEXÃO (identidade, confirmação de conta, permissão e trava de operação)
-- =====================================================================
-- ⚠️  NÃO APLICAR EM PRODUÇÃO SEM APROVAÇÃO EXPLÍCITA. Nunca aplicada em banco algum por quem a escreveu.
-- ✅  Puramente ADITIVA: 2 tabelas e 2 funções novas. NÃO altera whatsapp_conexoes (estado/auth/lease), o outbox, o inbox (096) nem os recibos (095).
--     Não guarda QR, auth state, chaves Signal, tokens nem telefone completo.
--
-- O QUE ISTO RESOLVE
--   1. PERMISSÃO ESPECÍFICA para gerenciar a conexão (`comunicacao:gerenciar_conexao`): quem só atende conversas NÃO ganha o poder de conectar/desconectar
--      o WhatsApp. O SuperAdmin passa por bypass (aplicação); nenhum outro perfil tem isso por padrão.
--   2. IDENTIDADE INTERNA separada da identidade do WhatsApp: `ambiente` (TESTE | PRODUCAO) e `nome_operacional` ("Agente Crescer"), que NÃO ficam presos ao número:
--      guardamos só o HASH do número que o operador CONFIRMOU; se outro número aparecer, a confirmação e o nome operacional deixam de valer.
--   3. CONFIRMAÇÃO explícita da conta depois de escanear o QR (a sessão conecta, mas fica PENDENTE_CONFIRMACAO até o operador confirmar).
--   4. TRAVA de operação concorrente (conectar / trocar / desconectar): uma por vez, com expiração — duas abas ou dois operadores nunca abrem duas sessões.
--
-- SEGURANÇA: RLS ligado e privilégios de anon/authenticated revogados (padrão 082/090/096): só o service_role do backend acessa.
-- ROLLBACK: 097_rollback.sql.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. PERMISSÕES ESPECÍFICAS DO PAINEL ADMINISTRATIVO
-- ---------------------------------------------------------------------
create table if not exists painel_adm_permissoes (
  usuario_id    uuid not null references auth.users(id) on delete cascade,
  permissao     text not null,
  concedida_por uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  primary key (usuario_id, permissao),
  constraint painel_adm_permissoes_valida check (permissao in ('comunicacao:gerenciar_conexao'))
);

comment on table painel_adm_permissoes is
  'Permissões ESPECÍFICAS além do flag geral do Painel Administrativo. Ter acesso às Conversas não concede gerenciar a conexão do WhatsApp.';

alter table painel_adm_permissoes enable row level security;
revoke all on painel_adm_permissoes from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. IDENTIDADE DO WHATSAPP + CONFIRMAÇÃO + TRAVA DE OPERAÇÃO
-- ---------------------------------------------------------------------
create table if not exists whatsapp_identidade (
  organizacao_id        uuid not null references organizacoes(id) on delete cascade,
  provider_instance_id  text not null default 'default',
  ambiente              text not null default 'TESTE' check (ambiente in ('TESTE', 'PRODUCAO')),
  -- Nome operacional ("Agente Crescer"): NUNCA atrelado a um número para sempre. Só vale enquanto o número confirmado for o mesmo (telefone_hash).
  nome_operacional      text check (nome_operacional is null or char_length(nome_operacional) between 1 and 60),
  status                text not null default 'SEM_CONTA' check (status in ('SEM_CONTA', 'PENDENTE_CONFIRMACAO', 'CONFIRMADA')),
  -- sha256 (hex) do E.164 da conta identificada — serve só para detectar "outro número". O número em si já vive em whatsapp_conexoes; aqui não há cópia.
  telefone_hash         text check (telefone_hash is null or telefone_hash ~ '^[0-9a-f]{64}$'),
  identificado_em       timestamptz,
  confirmado_em         timestamptz,
  confirmado_por        uuid references perfis_operacionais(id) on delete set null,
  -- Trava de operação concorrente (conectar | trocar | desconectar), com expiração.
  operacao_id           uuid,
  operacao_tipo         text check (operacao_tipo is null or operacao_tipo in ('CONECTAR', 'TROCAR', 'DESCONECTAR')),
  operacao_por          uuid references perfis_operacionais(id) on delete set null,
  operacao_expira_em    timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (organizacao_id, provider_instance_id),
  constraint whatsapp_identidade_confirmada_exige_hash check (status <> 'CONFIRMADA' or (telefone_hash is not null and confirmado_em is not null)),
  constraint whatsapp_identidade_operacao_par check ((operacao_id is null) = (operacao_tipo is null) and (operacao_id is null) = (operacao_expira_em is null))
);

comment on table whatsapp_identidade is
  'Identidade INTERNA da conexão do WhatsApp (ambiente, nome operacional, confirmação da conta). Separada da identidade do WhatsApp. Sem QR, auth state, chaves ou telefone completo.';

drop trigger if exists trg_whatsapp_identidade_upd on whatsapp_identidade;
create trigger trg_whatsapp_identidade_upd before update on whatsapp_identidade
  for each row execute function set_updated_at();

alter table whatsapp_identidade enable row level security;
revoke all on whatsapp_identidade from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. TRAVA ATÔMICA DE OPERAÇÃO (uma por vez; expira sozinha)
-- ---------------------------------------------------------------------
create or replace function whatsapp_operacao_iniciar(
  p_organizacao_id uuid, p_provider_instance_id text, p_tipo text, p_por uuid, p_ttl_segundos integer default 300
) returns table (iniciada boolean, operacao_id uuid, operacao_tipo text)
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into whatsapp_identidade (organizacao_id, provider_instance_id) values (p_organizacao_id, p_provider_instance_id)
  on conflict (organizacao_id, provider_instance_id) do nothing;

  update whatsapp_identidade i
     set operacao_id = gen_random_uuid(), operacao_tipo = p_tipo, operacao_por = p_por,
         operacao_expira_em = now() + make_interval(secs => greatest(coalesce(p_ttl_segundos, 300), 30))
   where i.organizacao_id = p_organizacao_id and i.provider_instance_id = p_provider_instance_id
     and (i.operacao_id is null or i.operacao_expira_em < now())
  returning i.operacao_id into v_id;

  if v_id is not null then
    return query select true, v_id, p_tipo;
  else
    return query select false, i.operacao_id, i.operacao_tipo from whatsapp_identidade i
     where i.organizacao_id = p_organizacao_id and i.provider_instance_id = p_provider_instance_id;
  end if;
end;
$$;

create or replace function whatsapp_operacao_encerrar(p_organizacao_id uuid, p_provider_instance_id text, p_operacao_id uuid)
returns boolean
language sql
set search_path = public
as $$
  with u as (
    update whatsapp_identidade
       set operacao_id = null, operacao_tipo = null, operacao_por = null, operacao_expira_em = null
     where organizacao_id = p_organizacao_id and provider_instance_id = p_provider_instance_id and operacao_id = p_operacao_id
    returning 1
  )
  select exists (select 1 from u);
$$;

revoke all on function whatsapp_operacao_iniciar(uuid, text, text, uuid, integer) from public, anon, authenticated;
revoke all on function whatsapp_operacao_encerrar(uuid, text, uuid) from public, anon, authenticated;
grant execute on function whatsapp_operacao_iniciar(uuid, text, text, uuid, integer) to service_role;
grant execute on function whatsapp_operacao_encerrar(uuid, text, uuid) to service_role;

commit;

-- ---------------------------------------------------------------------
-- VERIFICAÇÃO pós-aplicação (TESTE primeiro):
--   select relrowsecurity from pg_class where relname in ('painel_adm_permissoes', 'whatsapp_identidade');           -- true, true
--   select grantee from information_schema.role_table_grants where table_name in ('painel_adm_permissoes', 'whatsapp_identidade')
--     and grantee in ('anon', 'authenticated', 'PUBLIC');                                                            -- 0 linhas
--   -- Conceder a permissão a um operador (SQL, por quem administra):
--   --   insert into painel_adm_permissoes (usuario_id, permissao) values ('<auth.users.id>', 'comunicacao:gerenciar_conexao');
-- ---------------------------------------------------------------------
