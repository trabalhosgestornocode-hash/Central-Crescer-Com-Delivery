-- =====================================================================
-- MIGRATION 086 — auth_session_id + auth_confirmado em whatsapp_conexoes
-- (Checkpoint C3.5-C.2/C.3)
-- =====================================================================
-- ⚠️  NÃO APLICAR EM PRODUÇÃO NEM EM BANCO DE TESTE SEM APROVAÇÃO EXPLÍCITA.
--
-- CAUSA RAIZ QUE ESTA MIGRATION CORRIGE (Checkpoint C3.5-C.1, investigação
-- read-only contra o Baileys 6.7.24 REALMENTE instalado em produção):
--   No fluxo de pareamento por QR, `creds.registered` NUNCA é escrito como
--   true em lugar nenhum do pacote instalado — a única escrita existe em
--   node_modules/baileys/lib/Socket/messages-recv.js, dentro do handler de
--   notificação 'link_code_companion_reg', que só é alcançado no fluxo de
--   PAIRING CODE NUMÉRICO (nunca no QR). O sinal real e único de login
--   concluído, para QR, é `connection.update({connection:"open"})`, emitido
--   por CB:success (Socket/socket.js) depois de uploadPreKeysToServerIfRequired()
--   + sendPassiveIq('active'). A máquina de estados do Gateway (baileysSession.js)
--   exigia `registered===true` para promover a sessão a CONNECTED — uma
--   premissa nunca verificada contra o código-fonte real da biblioteca, que
--   nunca se confirma no fluxo de QR. Resultado ao vivo: uma sessão real,
--   autenticada e funcional (mensagens de terceiros chegando, telefone
--   identificado, connection=open já observado), ficou permanentemente presa
--   em CONNECTING no Crescer.
--
-- OBJETIVO DESTA MIGRATION
--   Substituir `registered` por um marcador durável PRÓPRIO do Crescer,
--   vinculado à GERAÇÃO exata do auth state (não só a presença de um
--   ciphertext qualquer), que só pode ser gravado depois que, NESTA conexão:
--     1. connection:"open" foi observado;
--     2. toda persistência de creds/Signal keys pendente/concorrente ao open
--        foi concluída com sucesso (authAdapter.aguardarPersistenciasPendentes());
--     3. o auth state persistido existe;
--     4. a escrita do marcador foi confirmada pelo backend com fencing
--        owner+epoch válido E a geração (auth_session_id) bate exatamente.
--
-- AUTH_SESSION_ID — POR QUE NÃO BASTA `auth_confirmado boolean` SOZINHO
--   Um `confirmarAuthState` tardio (callback assíncrono de um socket que já
--   foi superado por um reset+novo pareamento DENTRO DO MESMO epoch de
--   lease — nenhuma troca de dono, fencing de lease sozinho não pega isso)
--   poderia confirmar a geração ERRADA. `auth_session_id` é um UUID que:
--     - nasce dentro da própria whatsapp_auth_state_fenced, exatamente na
--       transição NULL -> presente de auth_state_encrypted (nunca gerado no
--       Gateway/Node — o backend, dono da linha, decide atomicamente se é
--       continuação ou início de geração);
--     - permanece idêntico em toda persistência subsequente da MESMA
--       geração (creds.update, keys.set);
--     - é removido (NULL) exatamente quando o reset zera auth_state_encrypted;
--     - é exigido, por igualdade EXATA, dentro de whatsapp_auth_confirmado_fenced
--       — mesmo com owner+epoch corretos, um auth_session_id que não bate
--       recusa a confirmação.
--
-- BACKFILL (item crítico) — a sessão REAL de produção já tem
-- auth_state_encrypted PRESENTE quando esta migration roda. Sem backfill,
-- ela nasceria com auth_session_id NULL, criando uma corrida: a recuperação
-- legado (Checkpoint C3.5-C.2, item 6) não poderia confirmar nada até uma
-- futura creds.update/keys.set gerar o UUID por acaso, ANTES ou DEPOIS de
-- connection:"open" — ordem não garantida. O backfill abaixo atribui
-- identidade estável a TODA geração de auth já persistida, ANTES da
-- constraint de integridade, na MESMA transação. Ele NUNCA confirma nada —
-- `auth_confirmado` permanece false (já é o default) para toda linha
-- backfilled; só marca "esta é uma geração", não "esta geração é válida".
--
-- CONSTRAINT DE INTEGRIDADE — fecha exatamente a combinação inválida
-- (auth_confirmado=true sem auth/session id), permitindo os 4 estados
-- legítimos: ABSENT (auth null, session_id null, confirmado false); auth
-- legado/parcial (auth presente, session_id presente, confirmado false);
-- auth confirmado (auth presente, session_id presente, confirmado true);
-- LOGGED_OUT com auth ainda armazenado (mesma forma do legado — a
-- constraint não olha `status`, é ortogonal a ele).
--
-- whatsapp_auth_state_fenced — MUDA DE FORMA DE RETORNO (ok) -> (ok,
-- auth_session_id). Postgres recusa CREATE OR REPLACE quando o RETURNS
-- TABLE muda de forma — por isso DROP FUNCTION + CREATE FUNCTION, dentro da
-- mesma transação (atômico), com GRANT/REVOKE reaplicados explicitamente
-- depois (o DROP apaga os grants anteriores).
--
-- COMPATIBILIDADE COM BACKEND ANTIGO (Checkpoint C3.5-C.3, item 2) —
-- verificado no código de whatsappGateway.repo.js ANTES desta migration:
-- `chamarRpc()` faz `data?.[0] ?? null` e `atualizarComFencing()` só lê
-- `r?.ok`; nenhum caminho existente lê/exige uma forma exata da linha
-- retornada. Um backend rodando o código ANTERIOR a este checkpoint
-- continua funcionando sem nenhuma mudança — só ignora a coluna nova
-- `auth_session_id` no resultado. BACKEND ANTIGO COMPATÍVEL: SIM.
--
-- whatsapp_heartbeat_fenced — só corpo (mesma assinatura, CREATE OR
-- REPLACE normal): quando p_status='LOGGED_OUT', também zera
-- auth_confirmado=false. auth_session_id NUNCA é tocado aqui — o blob de
-- auth em si só é limpo por reset explícito, como já era antes.
--
-- whatsapp_auth_confirmado_fenced — NOVA. Classificação atômica do motivo
-- de rejeição via SELECT ... FOR UPDATE (trava a linha, decide, escreve —
-- tudo na MESMA invocação/transação, sem segunda consulta depois do UPDATE,
-- sem janela TOCTOU): 'OK' | 'LEASE_STALE' | 'AUTH_SESSION_STALE' |
-- 'AUTH_ABSENT' | 'NOT_FOUND'.
--
-- PRÉ-REQUISITOS: migration 085 aplicada (desired_connection_state existe).
-- TRANSACIONAL. NÃO totalmente idempotente por causa do DROP+CREATE de
-- whatsapp_auth_state_fenced (re-executar é seguro — DROP FUNCTION sem
-- IF EXISTS falharia numa 2ª execução; ver nota no bloco correspondente).
-- ROLLBACK: database/migrations/086_rollback.sql.
-- =====================================================================

-- =====================================================================
-- PRÉ-CHECK OBRIGATÓRIO (execute isoladamente ANTES; nada aqui escreve)
-- =====================================================================
--   select to_regclass('public.whatsapp_conexoes');  -- precisa NÃO ser NULL
--   select column_name from information_schema.columns
--     where table_name = 'whatsapp_conexoes' and column_name = 'desired_connection_state'; -- precisa NÃO ser 0 linhas (085 aplicada)
--   select column_name from information_schema.columns
--     where table_name = 'whatsapp_conexoes' and column_name in ('auth_session_id','auth_confirmado'); -- precisa ser 0 linhas
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- COLUNAS NOVAS
-- ---------------------------------------------------------------------
alter table whatsapp_conexoes
  add column if not exists auth_session_id uuid,
  add column if not exists auth_confirmado boolean not null default false;

comment on column whatsapp_conexoes.auth_session_id is
  'Identidade estável da GERAÇÃO de auth_state_encrypted — gerada só dentro de whatsapp_auth_state_fenced, na transição NULL->presente; preservada em toda persistência subsequente da mesma geração; removida (NULL) só pelo reset explícito. Nunca gerado no Gateway/Node.';
comment on column whatsapp_conexoes.auth_confirmado is
  'Marcador durável do Crescer (NUNCA equivalente a creds.registered do Baileys — ver Checkpoint C3.5-C.1): true só depois que, NESTA geração de auth, connection:"open" foi observado, toda persistência pendente concluiu, e whatsapp_auth_confirmado_fenced confirmou owner+epoch+geração exatos. Zerado por reset e por LOGGED_OUT.';

-- ---------------------------------------------------------------------
-- BACKFILL — identidade para geração já persistida, SEM confirmar nada.
-- Roda ANTES da constraint, na mesma transação: a sessão real de produção
-- (auth_state_encrypted já presente hoje) sai desta migration já em estado
-- "legado/parcial" válido (auth presente + session_id presente + confirmado
-- false), nunca em um estado que a constraint abaixo recusaria.
-- ---------------------------------------------------------------------
update public.whatsapp_conexoes
set auth_session_id = gen_random_uuid()
where auth_state_encrypted is not null
  and auth_session_id is null;

-- ---------------------------------------------------------------------
-- CONSTRAINT DE INTEGRIDADE
-- ---------------------------------------------------------------------
alter table whatsapp_conexoes
  add constraint whatsapp_conexoes_auth_confirmado_integridade
  check (
    (auth_state_encrypted is null and auth_session_id is null and auth_confirmado = false)
    or
    (auth_state_encrypted is not null and auth_session_id is not null)
  );

-- ---------------------------------------------------------------------
-- whatsapp_auth_state_fenced — DROP + CREATE (mudança de forma de retorno).
-- NOTA DE RE-EXECUÇÃO: se esta migration for aplicada 2x sem rollback entre
-- as duas, o DROP FUNCTION abaixo falha (a função já não existe na
-- assinatura antiga na 2ª vez — na verdade já existe na assinatura NOVA, e
-- "drop function ... (uuid, text, text, bigint, text, text)" continua
-- batendo pelos PARÂMETROS, que não mudaram — a lista de parâmetros é a
-- mesma, só o RETURNS mudou; portanto o DROP por assinatura de parâmetros
-- funciona igual nas duas execuções, tornando este bloco idempotente na
-- prática apesar de não usar IF EXISTS).
-- ---------------------------------------------------------------------
drop function if exists whatsapp_auth_state_fenced(uuid, text, text, bigint, text, text);

create function whatsapp_auth_state_fenced(
  p_organizacao_id uuid,
  p_provider_instance_id text,
  p_process_id text,
  p_epoch bigint,
  p_auth_state_encrypted text,
  p_auth_state_version text
) returns table(ok boolean, auth_session_id uuid)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
begin
  if p_auth_state_encrypted is null then
    -- Reset explícito (Checkpoint C3.5-B.2): limpa auth, versão, geração e
    -- confirmação juntos, na mesma UPDATE fenced de sempre.
    update public.whatsapp_conexoes
    set auth_state_encrypted = null,
        auth_state_version = null,
        auth_session_id = null,
        auth_confirmado = false
    where organizacao_id = p_organizacao_id
      and provider_instance_id = p_provider_instance_id
      and lease_owner_id = p_process_id
      and lease_epoch = p_epoch
      and lease_expires_at > now()
    returning whatsapp_conexoes.auth_session_id into v_session_id;
  else
    -- Persistência normal (creds.update/keys.set): preserva auth_session_id
    -- já existente; só minta um novo na transição NULL->presente. NUNCA
    -- toca auth_confirmado aqui — sync normal não confirma nem desconfirma.
    update public.whatsapp_conexoes
    set auth_state_encrypted = p_auth_state_encrypted,
        auth_state_version = p_auth_state_version,
        auth_session_id = coalesce(whatsapp_conexoes.auth_session_id, gen_random_uuid())
    where organizacao_id = p_organizacao_id
      and provider_instance_id = p_provider_instance_id
      and lease_owner_id = p_process_id
      and lease_epoch = p_epoch
      and lease_expires_at > now()
    returning whatsapp_conexoes.auth_session_id into v_session_id;
  end if;

  if found then
    return query select true, v_session_id;
  else
    return query select false, null::uuid;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- whatsapp_heartbeat_fenced — só corpo (mesma assinatura). LOGGED_OUT
-- também zera auth_confirmado; auth_session_id nunca é tocado aqui.
-- ---------------------------------------------------------------------
create or replace function whatsapp_heartbeat_fenced(
  p_organizacao_id uuid,
  p_provider_instance_id text,
  p_process_id text,
  p_epoch bigint,
  p_status text,
  p_telefone text,
  p_gateway_version text,
  p_last_error_class text
) returns table(ok boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_now timestamptz := now();
begin
  update public.whatsapp_conexoes
  set last_seen_at = v_now,
      status = coalesce(p_status, status),
      telefone_e164 = coalesce(p_telefone, telefone_e164),
      gateway_version = coalesce(p_gateway_version, gateway_version),
      last_error_class = coalesce(p_last_error_class, last_error_class),
      connected_at = case when p_status = 'CONNECTED' then v_now else connected_at end,
      disconnected_at = case when p_status in ('DISCONNECTED', 'LOGGED_OUT') then v_now else disconnected_at end,
      auth_confirmado = case when p_status = 'LOGGED_OUT' then false else auth_confirmado end
  where organizacao_id = p_organizacao_id
    and provider_instance_id = p_provider_instance_id
    and lease_owner_id = p_process_id
    and lease_epoch = p_epoch
    and lease_expires_at > now();

  return query select found;
end;
$$;

-- ---------------------------------------------------------------------
-- whatsapp_auth_confirmado_fenced — NOVA. Classificação atômica do motivo
-- via SELECT ... FOR UPDATE: a linha é travada, o motivo é decidido contra
-- essa leitura travada, e a escrita (se aplicável) acontece na MESMA
-- invocação — nenhuma segunda consulta depois do UPDATE, nenhuma janela
-- TOCTOU. Só confirma quando linha existe + owner correto + epoch correto
-- + lease válida (now() do banco) + auth presente + auth_session_id
-- armazenado bate EXATAMENTE com o esperado.
-- ---------------------------------------------------------------------
create function whatsapp_auth_confirmado_fenced(
  p_organizacao_id uuid,
  p_provider_instance_id text,
  p_process_id text,
  p_epoch bigint,
  p_auth_session_id_esperado uuid
) returns table(ok boolean, motivo text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v record;
begin
  select lease_owner_id, lease_epoch, lease_expires_at, auth_state_encrypted, auth_session_id
    into v
    from public.whatsapp_conexoes
    where organizacao_id = p_organizacao_id
      and provider_instance_id = p_provider_instance_id
    for update;

  if not found then
    return query select false, 'NOT_FOUND'; return;
  end if;

  if v.lease_owner_id is distinct from p_process_id
     or v.lease_epoch is distinct from p_epoch
     or v.lease_expires_at is null
     or v.lease_expires_at <= now() then
    return query select false, 'LEASE_STALE'; return;
  end if;

  if v.auth_state_encrypted is null then
    return query select false, 'AUTH_ABSENT'; return;
  end if;

  if v.auth_session_id is distinct from p_auth_session_id_esperado then
    return query select false, 'AUTH_SESSION_STALE'; return;
  end if;

  update public.whatsapp_conexoes
  set auth_confirmado = true
  where organizacao_id = p_organizacao_id
    and provider_instance_id = p_provider_instance_id;

  return query select true, 'OK';
end;
$$;

-- EXECUTE: revogado explicitamente de public, anon E authenticated (não só
-- de public — redundante de propósito) e concedido só a service_role, mesma
-- postura de 083/084/085.
revoke all on function whatsapp_auth_state_fenced(uuid, text, text, bigint, text, text) from public, anon, authenticated;
revoke all on function whatsapp_heartbeat_fenced(uuid, text, text, bigint, text, text, text, text) from public, anon, authenticated;
revoke all on function whatsapp_auth_confirmado_fenced(uuid, text, text, bigint, uuid) from public, anon, authenticated;

grant execute on function whatsapp_auth_state_fenced(uuid, text, text, bigint, text, text) to service_role;
grant execute on function whatsapp_heartbeat_fenced(uuid, text, text, bigint, text, text, text, text) to service_role;
grant execute on function whatsapp_auth_confirmado_fenced(uuid, text, text, bigint, uuid) to service_role;

-- =====================================================================
-- PÓS-CHECK (execute isoladamente DEPOIS; nada aqui escreve)
-- =====================================================================
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--     where table_name = 'whatsapp_conexoes' and column_name in ('auth_session_id','auth_confirmado')
--     order by column_name;
--   -- esperado: auth_confirmado boolean not null default false; auth_session_id uuid nullable
--
--   select auth_state_encrypted is not null as tem_auth, auth_session_id, auth_confirmado
--     from whatsapp_conexoes;
--   -- esperado: TODA linha com auth presente tem auth_session_id NÃO NULO e auth_confirmado=false;
--   --           TODA linha sem auth tem auth_session_id NULO
--
--   select conname from pg_constraint where conname = 'whatsapp_conexoes_auth_confirmado_integridade'; -- 1 linha
--
--   select p.proname, p.prosecdef, p.proconfig
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and p.proname in
--       ('whatsapp_auth_state_fenced','whatsapp_heartbeat_fenced','whatsapp_auth_confirmado_fenced')
--     order by p.proname;
--   -- esperado: prosecdef=false em todas; proconfig contém search_path=public, pg_temp
--
--   select p.proname, count(*) as qtd_overloads
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and p.proname in
--       ('whatsapp_auth_state_fenced','whatsapp_heartbeat_fenced','whatsapp_auth_confirmado_fenced')
--     group by p.proname order by p.proname;
--   -- esperado: 3 linhas, qtd_overloads=1 em todas (nenhum overload fantasma deixado pelo DROP+CREATE)
--
--   select
--     p.oid::regprocedure as funcao,
--     has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute,
--     has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
--     has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname in
--     ('whatsapp_auth_state_fenced','whatsapp_heartbeat_fenced','whatsapp_auth_confirmado_fenced')
--   order by p.proname;
--   -- esperado: service_role_execute=true; os outros 2 = false, nas 3 linhas
-- =====================================================================

commit;
