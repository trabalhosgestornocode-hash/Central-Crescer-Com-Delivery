-- =====================================================================
-- MIGRATION 084 — lease/fencing em whatsapp_conexoes (Checkpoint C3.5)
-- =====================================================================
-- ⚠️  NÃO APLICAR EM PRODUÇÃO NEM EM BANCO DE TESTE SEM APROVAÇÃO EXPLÍCITA.
--
-- OBJETIVO
--   Rolling deploy no Render pode manter mais de um processo do Gateway
--   vivo ao mesmo tempo (confirmado ao vivo no Checkpoint C3: instâncias
--   `j4jv6`/`8s9n5` coexistiram com `492hh`, e uma instância ociosa
--   sobrescreveu `disconnected_at` no shutdown, mesmo nunca tendo aberto
--   socket nenhum). Esta migration adiciona os três campos que sustentam
--   posse exclusiva da sessão por LEASE + FENCING TOKEN:
--     lease_owner_id   — gateway_process_id (UUID efêmero, gerado no boot
--                         de cada processo) do dono atual da lease.
--     lease_epoch      — token de cerca (fencing token) monotônico:
--                         incrementado só numa transição REAL de dono
--                         (owner NULL, expirado, ou outro processo cuja
--                         lease já venceu) — nunca em renew, nem num
--                         re-acquire do MESMO dono ainda dentro do TTL
--                         (ver função whatsapp_lease_acquire abaixo).
--     lease_expires_at — TTL da lease; vencido, outro processo pode
--                         adquirir mesmo sem release explícito (processo
--                         morto sem shutdown gracioso — item 11).
--
--   Nenhuma tabela nova: a lease é sobre o MESMO recurso que
--   `whatsapp_conexoes` já representa (uma sessão lógica por
--   organizacao_id + provider_instance_id) — a UNIQUE já existente
--   (whatsapp_conexoes_instancia_unica) é exatamente o escopo certo para
--   "no máximo um dono por vez", e é o índice que toda operação de lease
--   realmente usa (ver seção ÍNDICE abaixo — não criamos nenhum novo).
--
-- POR QUE FUNÇÕES SQL (RPC), NÃO UPDATE...WHERE via supabase-js direto —
-- PostgREST não permite expressar `now()` nem `now() + interval` dentro de
-- um filtro (`.gt()`) ou de um corpo de `.update()` comum: os dois são
-- apenas comparação/atribuição de VALORES literais, nunca expressões
-- avaliadas no banco. Toda operação que decide validade de lease ou
-- escreve um novo prazo vive em função PL/pgSQL, chamada via `.rpc()` do
-- supabase-js, e usa `now()` do PRÓPRIO POSTGRES do início ao fim — a única
-- autoridade final é o banco. O cliente (Gateway ou backend) NUNCA envia um
-- instante absoluto — só `p_ttl_ms`, uma DURAÇÃO relativa (validada, ver
-- seção TTL abaixo). O relógio do Gateway (`leaseManager.js`) continua
-- existindo, mas só para self-fencing PREVENTIVO (fechar o socket
-- proativamente perto do prazo) — nunca para autorizar uma escrita.
--
-- SEMÂNTICA DE ACQUIRE PELO MESMO DONO
--   Se lease_owner_id = p_process_id E a lease ainda está válida
--   (lease_expires_at > now()), um novo `acquire` se comporta EXATAMENTE
--   como um `renew`: só estende lease_expires_at, `lease_epoch` NUNCA muda.
--   Só uma transição REAL de dono incrementa o epoch.
--
-- SEGURANÇA DAS FUNÇÕES (auditoria, Checkpoint C3.5-A)
--   Todas as 5 funções são SECURITY INVOKER (explícito, não o default
--   implícito) — rodam com o privilégio de quem CHAMA, nunca elevado.
--   Suficiente aqui: o único chamador legítimo é `service_role` (via
--   supabase-js do backend), que já tem acesso direto de leitura/escrita à
--   tabela mesmo sem a função (bypassa RLS por convenção do Supabase) — não
--   há elevação de privilégio nenhuma para ganhar com SECURITY DEFINER, e
--   evitá-lo elimina de vez a classe de risco de search_path hijacking que
--   SECURITY DEFINER introduziria. Mesmo assim, `search_path` é fixado
--   explicitamente (`public, pg_temp`) em toda função — não é opcional só
--   para DEFINER: é o que o linter de segurança do Supabase cobra para
--   QUALQUER função, e evita que a resolução de `whatsapp_conexoes` (dentro
--   da função) dependa do search_path de sessão do caller. Toda referência
--   à tabela dentro das funções também é schema-qualificada
--   (`public.whatsapp_conexoes`) — cinto e suspensório.
--   EXECUTE é revogado explicitamente de public, anon E authenticated (não
--   só de public — redundante de propósito, nunca dependendo só de RLS
--   nem só da cadeia de herança de PUBLIC) e concedido só a service_role.
--
-- TTL — VALIDAÇÃO DE ENTRADA (Checkpoint C3.5-A, auditoria)
--   `p_ttl_ms` é validado DENTRO das funções que o recebem (acquire, renew)
--   — nunca confiamos só na validação do lado do backend (defesa em
--   profundidade: a rota HTTP também valida, mas a autoridade final é o
--   banco). Faixa permitida: 1..300000 ms (1ms a 5 minutos). Justificativa:
--   o valor configurado hoje é WHATSAPP_LEASE_TTL_MS=45000 (45s); o teto de
--   300000ms (5min) é >6x folga sobre isso — generoso o bastante para
--   qualquer ajuste operacional razoável, mas ainda limita o pior caso de
--   "apagão" de failover (tempo que uma lease morta, sem release explícito,
--   fica bloqueando um novo dono) a no máximo 5 minutos. Um TTL <= 0 (ou
--   NULL) nunca produziria uma lease coerente; um TTL absurdamente grande
--   (dias, anos) criaria, na prática, uma lease "eterna" que um processo
--   morto sem shutdown gracioso deixaria travada por tempo inaceitável —
--   exatamente o que este checkpoint existe para evitar.
--
-- FUNÇÕES CRIADAS:
--   whatsapp_lease_acquire(org, instancia, process_id, ttl_ms)
--     -> (acquired bool, lease_epoch bigint, lease_expires_at timestamptz)
--   whatsapp_lease_renew(org, instancia, process_id, epoch, ttl_ms)
--     -> (renewed bool, lease_epoch bigint, lease_expires_at timestamptz)
--   whatsapp_lease_release(org, instancia, process_id, epoch)
--     -> (released bool)
--   whatsapp_heartbeat_fenced(org, instancia, process_id, epoch, status,
--                              telefone, gateway_version, last_error_class)
--     -> (ok bool)
--   whatsapp_auth_state_fenced(org, instancia, process_id, epoch,
--                               auth_state_encrypted, auth_state_version)
--     -> (ok bool)
--
-- INVARIANTES (respondidas por construção nas funções abaixo):
--   ACQUIRE:  expiração checada com now() do banco; incremento de epoch +
--             atribuição de owner na MESMA instrução UPDATE (atômico); dois
--             contenders simultâneos -> exatamente um ganha (o segundo
--             UPDATE, ao ser liberado do lock de linha, reavalia o WHERE
--             contra a linha já modificada pelo primeiro e afeta 0 linhas).
--   RENEW:    owner igual E epoch igual E lease_expires_at > now() (do
--             banco) -> novo lease_expires_at = now()+ttl (do banco); nunca
--             incrementa epoch.
--   RELEASE:  owner igual E epoch igual E lease_expires_at > now() -> limpa
--             owner/expires_at; nunca reseta/decrementa epoch.
--   GRAVAÇÃO FENCED (heartbeat/auth-state): owner igual E epoch igual E
--             lease_expires_at > now() (as três, atomicamente, no WHERE do
--             UPDATE dentro da função) -> senão, zero linhas afetadas,
--             `ok=false`.
--
-- ÍNDICE: NENHUM novo criado nesta migration (revisão Checkpoint C3.5-A —
-- ver justificativa detalhada logo antes das funções, abaixo).
--
-- PRÉ-REQUISITOS: migration 083 aplicada (whatsapp_conexoes existe).
-- TRANSACIONAL, IDEMPOTENTE (add column if not exists / create or replace).
-- ROLLBACK: database/migrations/084_rollback.sql.
-- =====================================================================

-- =====================================================================
-- PRÉ-CHECK OBRIGATÓRIO (execute isoladamente ANTES; nada aqui escreve)
-- =====================================================================
--   select to_regclass('public.whatsapp_conexoes');  -- precisa NÃO ser NULL
--   select column_name from information_schema.columns
--     where table_name = 'whatsapp_conexoes' and column_name = 'lease_owner_id'; -- precisa ser 0 linhas
-- =====================================================================

begin;

alter table whatsapp_conexoes
  add column if not exists lease_owner_id   text,
  add column if not exists lease_epoch      bigint not null default 0,
  add column if not exists lease_expires_at timestamptz;

comment on column whatsapp_conexoes.lease_owner_id is
  'gateway_process_id (UUID efêmero, gerado no boot) do processo dono atual da sessão. NULL = sem dono (lease livre).';
comment on column whatsapp_conexoes.lease_epoch is
  'Fencing token monotônico — incrementado só numa transição REAL de dono (ver whatsapp_lease_acquire). Toda gravação sensível precisa apresentar o epoch atual; um epoch velho é rejeitado mesmo que owner_id ainda bata.';
comment on column whatsapp_conexoes.lease_expires_at is
  'TTL da lease (autoridade: now() do Postgres, nunca relógio de cliente). Vencida, outro processo pode adquirir mesmo sem release explícito do dono anterior.';

-- SEM ÍNDICE NOVO (revisão Checkpoint C3.5-A): a tabela já tem a UNIQUE
-- `whatsapp_conexoes_instancia_unica (organizacao_id, provider_instance_id)`
-- desde a 083, e é ELA que toda operação de lease/fencing efetivamente usa
-- — todas filtram por (organizacao_id, provider_instance_id), nunca por
-- lease_owner_id isoladamente. Um índice parcial em lease_owner_id (versão
-- anterior desta migration) não acelera nenhuma consulta que o sistema
-- realmente faz hoje — não existe nenhum "listar quem detém lease agora"
-- em produção — e, com o volume desta tabela (um número por organização,
-- Checkpoint C0 item 20: dezenas de linhas no máximo, não milhares), até
-- essa consulta hipotética seria instantânea com scan sequencial. Índice
-- decorativo removido de propósito; revisitar SE e quando existir uma
-- consulta real por lease_owner_id (ex.: um job de observabilidade futuro).

-- =====================================================================
-- ACQUIRE — atômico, now() do banco do início ao fim. Re-acquire pelo
-- MESMO dono ainda válido = tratado como renew (não incrementa epoch).
-- Qualquer outra transição de dono incrementa. p_ttl_ms validado.
-- =====================================================================
create or replace function whatsapp_lease_acquire(
  p_organizacao_id uuid,
  p_provider_instance_id text,
  p_process_id text,
  p_ttl_ms bigint
) returns table(acquired boolean, lease_epoch bigint, lease_expires_at timestamptz)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_epoch bigint;
  v_expires timestamptz;
begin
  if p_ttl_ms is null or p_ttl_ms <= 0 or p_ttl_ms > 300000 then
    raise exception 'p_ttl_ms fora da faixa permitida (1..300000 ms): %', p_ttl_ms
      using errcode = 'invalid_parameter_value';
  end if;

  insert into public.whatsapp_conexoes (organizacao_id, provider_instance_id)
  values (p_organizacao_id, p_provider_instance_id)
  on conflict (organizacao_id, provider_instance_id) do nothing;

  -- Ramo 1: re-acquire IDEMPOTENTE pelo mesmo dono, ainda dentro do TTL —
  -- comporta-se como renew, epoch preservado.
  update public.whatsapp_conexoes
  set lease_expires_at = now() + make_interval(secs => p_ttl_ms / 1000.0)
  where organizacao_id = p_organizacao_id
    and provider_instance_id = p_provider_instance_id
    and lease_owner_id = p_process_id
    and lease_expires_at > now()
  returning whatsapp_conexoes.lease_epoch, whatsapp_conexoes.lease_expires_at
    into v_epoch, v_expires;

  if found then
    return query select true, v_epoch, v_expires;
    return;
  end if;

  -- Ramo 2: transição REAL de dono — owner livre, OU lease (de quem for,
  -- inclusive do próprio p_process_id) já vencida. Epoch incrementa.
  update public.whatsapp_conexoes
  set lease_owner_id = p_process_id,
      lease_epoch = whatsapp_conexoes.lease_epoch + 1,
      lease_expires_at = now() + make_interval(secs => p_ttl_ms / 1000.0)
  where organizacao_id = p_organizacao_id
    and provider_instance_id = p_provider_instance_id
    and (lease_owner_id is null or lease_expires_at <= now())
  returning whatsapp_conexoes.lease_epoch, whatsapp_conexoes.lease_expires_at
    into v_epoch, v_expires;

  if found then
    return query select true, v_epoch, v_expires;
    return;
  end if;

  -- Ramo 3: outro processo detém uma lease válida agora — não adquiriu.
  -- Devolve o estado atual (diagnóstico), acquired=false.
  select wc.lease_epoch, wc.lease_expires_at into v_epoch, v_expires
  from public.whatsapp_conexoes wc
  where wc.organizacao_id = p_organizacao_id and wc.provider_instance_id = p_provider_instance_id;

  return query select false, v_epoch, v_expires;
end;
$$;

-- =====================================================================
-- RENEW — owner+epoch+validade checados com now() do banco; nunca muda
-- epoch. p_ttl_ms validado, mesma faixa do acquire.
-- =====================================================================
create or replace function whatsapp_lease_renew(
  p_organizacao_id uuid,
  p_provider_instance_id text,
  p_process_id text,
  p_epoch bigint,
  p_ttl_ms bigint
) returns table(renewed boolean, lease_epoch bigint, lease_expires_at timestamptz)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_epoch bigint;
  v_expires timestamptz;
begin
  if p_ttl_ms is null or p_ttl_ms <= 0 or p_ttl_ms > 300000 then
    raise exception 'p_ttl_ms fora da faixa permitida (1..300000 ms): %', p_ttl_ms
      using errcode = 'invalid_parameter_value';
  end if;

  update public.whatsapp_conexoes
  set lease_expires_at = now() + make_interval(secs => p_ttl_ms / 1000.0)
  where organizacao_id = p_organizacao_id
    and provider_instance_id = p_provider_instance_id
    and lease_owner_id = p_process_id
    and lease_epoch = p_epoch
    and lease_expires_at > now()
  returning whatsapp_conexoes.lease_epoch, whatsapp_conexoes.lease_expires_at
    into v_epoch, v_expires;

  if found then
    return query select true, v_epoch, v_expires;
  else
    return query select false, null::bigint, null::timestamptz;
  end if;
end;
$$;

-- =====================================================================
-- RELEASE — owner+epoch+validade checados com now() do banco; lease_epoch
-- NUNCA é resetado (o próximo acquire continua a partir dele).
-- =====================================================================
create or replace function whatsapp_lease_release(
  p_organizacao_id uuid,
  p_provider_instance_id text,
  p_process_id text,
  p_epoch bigint
) returns table(released boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  update public.whatsapp_conexoes
  set lease_owner_id = null, lease_expires_at = null
  where organizacao_id = p_organizacao_id
    and provider_instance_id = p_provider_instance_id
    and lease_owner_id = p_process_id
    and lease_epoch = p_epoch
    and lease_expires_at > now();

  return query select found;
end;
$$;

-- =====================================================================
-- GRAVAÇÕES FENCED — heartbeat e auth-state. Mesmas três condições no
-- WHERE (owner+epoch+lease_expires_at > now(), do banco), dentro da MESMA
-- instrução UPDATE que grava os campos — nunca um check separado da escrita.
-- =====================================================================
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
      disconnected_at = case when p_status in ('DISCONNECTED', 'LOGGED_OUT') then v_now else disconnected_at end
  where organizacao_id = p_organizacao_id
    and provider_instance_id = p_provider_instance_id
    and lease_owner_id = p_process_id
    and lease_epoch = p_epoch
    and lease_expires_at > now();

  return query select found;
end;
$$;

create or replace function whatsapp_auth_state_fenced(
  p_organizacao_id uuid,
  p_provider_instance_id text,
  p_process_id text,
  p_epoch bigint,
  p_auth_state_encrypted text,
  p_auth_state_version text
) returns table(ok boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  update public.whatsapp_conexoes
  set auth_state_encrypted = p_auth_state_encrypted,
      auth_state_version = p_auth_state_version
  where organizacao_id = p_organizacao_id
    and provider_instance_id = p_provider_instance_id
    and lease_owner_id = p_process_id
    and lease_epoch = p_epoch
    and lease_expires_at > now();

  return query select found;
end;
$$;

-- EXECUTE: revogado explicitamente de public, anon E authenticated (não só
-- de public — redundante de propósito) e concedido só a service_role.
-- Nunca dependemos só de RLS para proteger estas funções: RLS protege a
-- TABELA por trás; isto protege quem pode nem sequer CHAMAR a função.
revoke all on function whatsapp_lease_acquire(uuid, text, text, bigint) from public, anon, authenticated;
revoke all on function whatsapp_lease_renew(uuid, text, text, bigint, bigint) from public, anon, authenticated;
revoke all on function whatsapp_lease_release(uuid, text, text, bigint) from public, anon, authenticated;
revoke all on function whatsapp_heartbeat_fenced(uuid, text, text, bigint, text, text, text, text) from public, anon, authenticated;
revoke all on function whatsapp_auth_state_fenced(uuid, text, text, bigint, text, text) from public, anon, authenticated;

grant execute on function whatsapp_lease_acquire(uuid, text, text, bigint) to service_role;
grant execute on function whatsapp_lease_renew(uuid, text, text, bigint, bigint) to service_role;
grant execute on function whatsapp_lease_release(uuid, text, text, bigint) to service_role;
grant execute on function whatsapp_heartbeat_fenced(uuid, text, text, bigint, text, text, text, text) to service_role;
grant execute on function whatsapp_auth_state_fenced(uuid, text, text, bigint, text, text) to service_role;

-- =====================================================================
-- PÓS-CHECK (execute isoladamente DEPOIS; nada aqui escreve)
-- =====================================================================
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--     where table_name = 'whatsapp_conexoes'
--       and column_name in ('lease_owner_id','lease_epoch','lease_expires_at')
--     order by column_name;
--   -- esperado: lease_epoch bigint not null default 0; os outros dois nullable
--
--   select proname, prosecdef, proconfig
--     from pg_proc where proname like 'whatsapp_%';
--   -- esperado: prosecdef=false (SECURITY INVOKER) em todas; proconfig
--   -- contém 'search_path=public, pg_temp' em todas.
--
--   -- Nenhum overload inesperado (cada função só pode ter 1 versão):
--   select p.proname, count(*) as qtd_overloads
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and p.proname in
--       ('whatsapp_lease_acquire','whatsapp_lease_renew','whatsapp_lease_release',
--        'whatsapp_heartbeat_fenced','whatsapp_auth_state_fenced')
--     group by p.proname order by p.proname;
--   -- esperado: 5 linhas, qtd_overloads=1 em todas.
--
--   -- Privilégios reais por ACL — nunca "consegui rodar no SQL Editor" (ele
--   -- roda em contexto administrativo, que bypassa tudo). has_function_privilege
--   -- cobre service_role/anon/authenticated; PUBLIC não é um papel
--   -- consultável por has_function_privilege('public', ...) — é representado
--   -- por grantee=0 dentro do próprio ACL da função, lido via aclexplode().
--   select
--     p.oid::regprocedure as funcao,
--     has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute,
--     has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
--     has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
--     exists (
--       select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
--       where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
--     ) as public_execute
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname in
--     ('whatsapp_lease_acquire','whatsapp_lease_renew','whatsapp_lease_release',
--      'whatsapp_heartbeat_fenced','whatsapp_auth_state_fenced')
--   order by p.proname;
--   -- esperado, nas 5 linhas: service_role_execute=true; anon_execute=false;
--   -- authenticated_execute=false; public_execute=false.
-- =====================================================================

commit;
