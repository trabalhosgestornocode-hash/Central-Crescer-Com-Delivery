-- =====================================================================
-- MIGRATION 085 — desired_connection_state em whatsapp_conexoes (Checkpoint C3.5-B)
-- =====================================================================
-- ⚠️  NÃO APLICAR EM PRODUÇÃO NEM EM BANCO DE TESTE SEM APROVAÇÃO EXPLÍCITA.
--
-- OBJETIVO
--   Distinguir "intenção do operador" de "estado técnico observado". A
--   tabela já tinha `status` (083: o que o processo observou AGORA —
--   CONNECTING/CONNECTED/DISCONNECTED/LOGGED_OUT). Faltava o que o
--   operador pediu por último. Sem essa distinção, um shutdown técnico
--   (SIGTERM/deploy/restart) e um disconnect manual produziam o MESMO
--   `status=DISCONNECTED` — impossível para o próximo dono da lease saber
--   se deveria restaurar a sessão automaticamente ou respeitar um pedido
--   explícito de ficar offline (auditoria completa no Checkpoint C3.5-B,
--   pré-flight, itens A-D).
--
--   `desired_connection_state`:
--     CONNECTED    — o operador pediu para esta sessão ficar pareada
--                     (via /connect). Pré-condição necessária (não
--                     suficiente) para auto-restore.
--     DISCONNECTED — o operador pediu para ficar offline (via
--                     /disconnect), OU a sessão foi deslogada de verdade
--                     pelo WhatsApp (LOGGED_OUT). Nunca restaura sozinho.
--
--   DEFAULT = 'DISCONNECTED' (deliberadamente, NÃO 'CONNECTED') —
--   Checkpoint C3.5-B, decisão explícita: esta migration NUNCA pode,
--   sozinha, transformar uma sessão legada/já autenticada em candidata a
--   auto-restore. Toda linha existente (inclusive a sessão de teste já
--   pareada em produção) nasce com desired_connection_state=DISCONNECTED
--   e continua assim até alguém chamar /connect deliberadamente — que é
--   quem grava CONNECTED, e só ele.
--
-- POR QUE UMA RPC NOVA, NÃO UM PARÂMETRO NOVO EM whatsapp_heartbeat_fenced
-- (Checkpoint C3.5-B, item 2) — mudar a lista de parâmetros de uma função
-- existente via CREATE OR REPLACE FUNCTION exige a MESMA assinatura; uma
-- assinatura diferente cria um OVERLOAD novo, não substitui a antiga (o
-- oposto do que se quer). Uma RPC dedicada preserva heartbeat_fenced
-- byte-a-byte — uma instância do Gateway rodando código ANTERIOR a esta
-- migration continua chamando heartbeat_fenced exatamente como sempre;
-- só o código novo, e só depois de esta migration já existir, chama
-- whatsapp_desired_state_fenced. Nenhuma janela de incompatibilidade
-- durante rolling deploy.
--
-- SEGURANÇA: mesma postura das 5 funções da 084 — SECURITY INVOKER
-- (explícito), search_path fixo (public, pg_temp), toda referência à
-- tabela schema-qualificada, EXECUTE revogado de public/anon/authenticated
-- e concedido só a service_role. Mesmas três condições atomicamente no
-- WHERE do UPDATE: lease_owner_id=$processo AND lease_epoch=$epoch AND
-- lease_expires_at>now() (do banco, nunca do relógio do cliente).
--
-- PRÉ-REQUISITOS: migration 084 aplicada (whatsapp_conexoes tem lease_*).
-- TRANSACIONAL, IDEMPOTENTE (add column if not exists / create or replace).
-- ROLLBACK: database/migrations/085_rollback.sql.
-- =====================================================================

-- =====================================================================
-- PRÉ-CHECK OBRIGATÓRIO (execute isoladamente ANTES; nada aqui escreve)
-- =====================================================================
--   select to_regclass('public.whatsapp_conexoes');  -- precisa NÃO ser NULL
--   select column_name from information_schema.columns
--     where table_name = 'whatsapp_conexoes' and column_name = 'lease_owner_id'; -- precisa NÃO ser 0 linhas (084 aplicada)
--   select column_name from information_schema.columns
--     where table_name = 'whatsapp_conexoes' and column_name = 'desired_connection_state'; -- precisa ser 0 linhas
-- =====================================================================

begin;

alter table whatsapp_conexoes
  add column if not exists desired_connection_state text not null default 'DISCONNECTED'
  check (desired_connection_state in ('CONNECTED', 'DISCONNECTED'));

comment on column whatsapp_conexoes.desired_connection_state is
  'Intenção do OPERADOR (não estado técnico observado — isso é `status`). CONNECTED só é gravado por /connect, ANTES de qualquer socket. DISCONNECTED é o default de toda linha nova/legada, e é gravado por /disconnect e por LOGGED_OUT real. SIGTERM/deploy/restart NUNCA tocam este campo. Pré-condição necessária (não suficiente) para auto-restore — Checkpoint C3.5-B.';

-- =====================================================================
-- RPC dedicada — só altera desired_connection_state, fenced pelas mesmas
-- três condições (owner+epoch+validade, now() do banco). Nunca toca
-- status/auth_state/qualquer outra coluna.
-- =====================================================================
create or replace function whatsapp_desired_state_fenced(
  p_organizacao_id uuid,
  p_provider_instance_id text,
  p_process_id text,
  p_epoch bigint,
  p_desired_connection_state text
) returns table(ok boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if p_desired_connection_state not in ('CONNECTED', 'DISCONNECTED') then
    raise exception 'p_desired_connection_state invalido: %', p_desired_connection_state
      using errcode = 'invalid_parameter_value';
  end if;

  update public.whatsapp_conexoes
  set desired_connection_state = p_desired_connection_state
  where organizacao_id = p_organizacao_id
    and provider_instance_id = p_provider_instance_id
    and lease_owner_id = p_process_id
    and lease_epoch = p_epoch
    and lease_expires_at > now();

  return query select found;
end;
$$;

revoke all on function whatsapp_desired_state_fenced(uuid, text, text, bigint, text) from public, anon, authenticated;
grant execute on function whatsapp_desired_state_fenced(uuid, text, text, bigint, text) to service_role;

-- =====================================================================
-- PÓS-CHECK (execute isoladamente DEPOIS; nada aqui escreve)
-- =====================================================================
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--     where table_name = 'whatsapp_conexoes' and column_name = 'desired_connection_state';
--   -- esperado: text, not null, default 'DISCONNECTED'::text
--
--   select desired_connection_state, count(*) from whatsapp_conexoes group by 1;
--   -- esperado: TODA linha existente (inclusive a sessão real já pareada) com 'DISCONNECTED'
--
--   select p.oid::regprocedure as funcao, p.prosecdef as security_definer, p.proconfig
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and p.proname = 'whatsapp_desired_state_fenced';
--   -- esperado: 1 linha, security_definer=false, proconfig contém search_path=public, pg_temp
--
--   select
--     p.oid::regprocedure as funcao,
--     has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute,
--     has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
--     has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
--     exists (
--       select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
--       where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
--     ) as public_execute
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'whatsapp_desired_state_fenced';
--   -- esperado: service_role_execute=true; os outros 3 = false
-- =====================================================================

commit;
