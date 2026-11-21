-- =====================================================================================================================
-- MOVA — RELÉ de homologação (Execução 11). Aplicar SOMENTE no banco de HOMOLOGAÇÃO (marca MOVA_HOMOLOGACAO:<marca>),
-- como o papel dono dos schemas do MOVA (não superusuário). Nunca no banco de produção.
--
-- Gateway Baileys ──HTTPS──► Edge Function `mova-rele` ──► mova_rele.receber() ──► mova_rele.evento (fila durável)
--                                                                      ▲
--                         consumidor local (papel mova_rele_consumidor) ┘ reservar → receptor MOVA → confirmar
--
-- * A assinatura HMAC do Gateway (timestamp \n nonce \n MÉTODO \n caminho \n sha256(corpo)), a janela de ±60 s, o nonce de uso
--   único e o limite de taxa são conferidos AQUI, antes de gravar qualquer coisa. O segredo fica em mova_rele.segredo (só o
--   dono lê; as funções SECURITY DEFINER usam). A Edge Function não conhece o segredo.
-- * Tabelas com RLS ligada e SEM políticas; nenhum privilégio de tabela para anon/authenticated/service_role/public.
--   O schema não está exposto na Data API. Os papéis do relé só executam as funções do relé.
-- * A entrega no relé NÃO é processamento financeiro: o consumidor entrega ao receptor MOVA, que deduplica por evento.
-- PRÉ-REQUISITO no Supabase: o papel dono precisa de USAGE no schema `extensions` (pgcrypto), concedido pelo postgres:
--   grant usage on schema extensions to <papel dono>;   (sem isso, digest/hmac "não existem" para as funções)
-- =====================================================================================================================
do $$ begin
  if coalesce(shobj_description((select oid from pg_database where datname = current_database()), 'pg_database'), '') not like 'MOVA_HOMOLOGACAO:%'
     and current_database() not like 'fv2_teste_%' then
    raise exception 'MOVA relé: só no banco de homologação (marca MOVA_HOMOLOGACAO) ou no banco local de teste — nada foi feito';
  end if;
  if exists (select 1 from pg_namespace where nspname = 'mova_rele') then raise exception 'MOVA relé: schema mova_rele já existe — nada foi feito'; end if;
end $$;

-- pgcrypto: no Supabase já existe (schema extensions); num PostgreSQL sem ele (banco local de teste), vai para um schema próprio.
do $$ begin
  if not exists (select 1 from pg_extension where extname = 'pgcrypto') then
    create schema mova_rele_cripto; create extension pgcrypto with schema mova_rele_cripto;
  end if;
end $$;

create schema mova_rele;
revoke all on schema mova_rele from public;

-- Segredo do canal (uma linha). Gravado por script local; nunca versionado.
create table mova_rele.segredo (
  id        boolean primary key default true check (id),
  valor     text not null check (length(valor) >= 32),
  gravado_em timestamptz not null default now()
);

create table mova_rele.evento (
  evento_id         text primary key check (evento_id ~ '^[A-Za-z0-9_.:@-]{1,160}$'),
  origem            text not null check (origem ~ '^[a-z0-9-]{1,40}$'),
  corpo             text not null,                         -- bytes EXATOS assinados pelo Gateway (o consumidor confere de novo)
  sha256            text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  tamanho           integer not null check (tamanho > 0),
  assinatura_ts     text not null,
  assinatura_nonce  text not null,
  assinatura        text not null check (assinatura ~ '^[0-9a-f]{64}$'),
  caminho           text not null,
  recebido_em       timestamptz not null default now(),
  estado            text not null default 'RECEBIDO' check (estado in ('RECEBIDO','RESERVADO','PROCESSADO','NOVA_TENTATIVA','FALHA_DEFINITIVA')),
  tentativas        integer not null default 0,
  consumidor        text,
  lease_ate         timestamptz,
  proxima_em        timestamptz not null default now(),
  concluido_em      timestamptz,
  falha_codigo      text check (falha_codigo ~ '^[A-Z0-9_:]{1,80}$'),
  entregas          integer not null default 1             -- quantas vezes o Gateway entregou o MESMO evento (dedupe)
);
create index evento_disponivel on mova_rele.evento (proxima_em, recebido_em) where estado in ('RECEBIDO','NOVA_TENTATIVA');
create index evento_reservado on mova_rele.evento (lease_ate) where estado = 'RESERVADO';
create index evento_recebido_em on mova_rele.evento (recebido_em);

create table mova_rele.nonce (nonce text primary key, expira_em timestamptz not null);
create index nonce_expira on mova_rele.nonce (expira_em);

-- Auditoria técnica SEM conteúdo: só ação, evento, código.
create table mova_rele.auditoria (
  seq       bigint generated always as identity primary key,
  em        timestamptz not null default now(),
  acao      text not null,
  evento_id text,
  ator      text,
  codigo    text
);

alter table mova_rele.segredo enable row level security;
alter table mova_rele.evento enable row level security;
alter table mova_rele.nonce enable row level security;
alter table mova_rele.auditoria enable row level security;
revoke all on all tables in schema mova_rele from public;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on all tables in schema mova_rele from %I', r); end if;
  end loop;
end $$;

-- ------------------------------------------------------------------------------------------------- receber (Edge Function)
-- Resultado: GRAVADO | DUPLICADO | NAO_AUTORIZADO | REPLAY | LIMITE | INVALIDO
create function mova_rele.receber(p_corpo text, p_ts text, p_nonce text, p_assinatura text, p_caminho text, p_origem text, p_limite_por_minuto integer default 60)
returns text language plpgsql security definer set search_path = pg_catalog, extensions, mova_rele_cripto, pg_temp as $$
declare
  v_segredo text; v_sha text; v_esperada text; v_evento text; v_agora timestamptz := clock_timestamp(); v_ins boolean;
begin
  if p_corpo is null or p_ts !~ '^\d{10,13}$' or p_nonce !~ '^[A-Za-z0-9_-]{16,64}$' or p_assinatura !~ '^[0-9a-f]{64}$'
     or p_caminho <> '/internal/mova/eventos/mova-grupo' or p_origem !~ '^[a-z0-9-]{1,40}$' then
    insert into mova_rele.auditoria (acao, ator, codigo) values ('RECUSADO', p_origem, 'FORMATO'); return 'NAO_AUTORIZADO';
  end if;
  select valor into v_segredo from mova_rele.segredo;
  if v_segredo is null then raise exception 'MOVA relé: segredo não configurado'; end if;
  if abs(extract(epoch from v_agora) * 1000 - p_ts::numeric) > 60000 then
    insert into mova_rele.auditoria (acao, ator, codigo) values ('RECUSADO', p_origem, 'JANELA'); return 'NAO_AUTORIZADO';
  end if;
  v_sha := encode(digest(convert_to(p_corpo, 'UTF8'), 'sha256'), 'hex');
  v_esperada := encode(hmac(convert_to(p_ts || E'\n' || p_nonce || E'\nPOST\n' || p_caminho || E'\n' || v_sha, 'UTF8'), convert_to(v_segredo, 'UTF8'), 'sha256'), 'hex');
  -- comparação dos HASHES das assinaturas: o tempo não revela prefixos da assinatura esperada
  if digest(v_esperada, 'sha256') <> digest(p_assinatura, 'sha256') then
    insert into mova_rele.auditoria (acao, ator, codigo) values ('RECUSADO', p_origem, 'ASSINATURA'); return 'NAO_AUTORIZADO';
  end if;
  delete from mova_rele.nonce where expira_em < v_agora;
  insert into mova_rele.nonce (nonce, expira_em) values (p_nonce, v_agora + interval '2 minutes') on conflict do nothing;
  if not found then insert into mova_rele.auditoria (acao, ator, codigo) values ('RECUSADO', p_origem, 'REPLAY'); return 'REPLAY'; end if;
  if (select count(*) from mova_rele.evento where recebido_em > v_agora - interval '1 minute') >= p_limite_por_minuto then
    insert into mova_rele.auditoria (acao, ator, codigo) values ('RECUSADO', p_origem, 'LIMITE'); return 'LIMITE';
  end if;
  begin
    v_evento := (p_corpo::jsonb) ->> 'eventoId';
  exception when others then v_evento := null;
  end;
  if v_evento is null or v_evento !~ '^[A-Za-z0-9_.:@-]{1,160}$' then
    insert into mova_rele.auditoria (acao, ator, codigo) values ('RECUSADO', p_origem, 'EVENTO_INVALIDO'); return 'INVALIDO';
  end if;
  insert into mova_rele.evento (evento_id, origem, corpo, sha256, tamanho, assinatura_ts, assinatura_nonce, assinatura, caminho)
  values (v_evento, p_origem, p_corpo, v_sha, octet_length(p_corpo), p_ts, p_nonce, p_assinatura, p_caminho)
  on conflict (evento_id) do update set entregas = mova_rele.evento.entregas + 1
  returning (xmax = 0) into v_ins;
  insert into mova_rele.auditoria (acao, evento_id, ator) values (case when v_ins then 'GRAVADO' else 'DUPLICADO' end, v_evento, p_origem);
  return case when v_ins then 'GRAVADO' else 'DUPLICADO' end;
end $$;

-- ------------------------------------------------------------------------------------------------- consumidor
create function mova_rele.reservar(p_consumidor text, p_lote integer default 5, p_lease_segundos integer default 60)
returns table (evento_id text, corpo text, sha256 text, assinatura_ts text, assinatura_nonce text, assinatura text, caminho text, tentativas integer)
language plpgsql security definer set search_path = pg_catalog, extensions, mova_rele_cripto, pg_temp as $$
begin
  if p_consumidor !~ '^[A-Za-z0-9_.:-]{1,80}$' or p_lote not between 1 and 50 or p_lease_segundos not between 5 and 600 then
    raise exception 'MOVA relé: parâmetros de reserva inválidos';
  end if;
  return query
  with alvo as (
    select e.evento_id from mova_rele.evento e
     where (e.estado in ('RECEBIDO','NOVA_TENTATIVA') and e.proxima_em <= clock_timestamp())
        or (e.estado = 'RESERVADO' and e.lease_ate < clock_timestamp())
     order by e.recebido_em, e.evento_id
     limit p_lote
     for update skip locked)
  update mova_rele.evento e set estado = 'RESERVADO', consumidor = p_consumidor, lease_ate = clock_timestamp() + make_interval(secs => p_lease_segundos),
         tentativas = e.tentativas + 1
    from alvo where e.evento_id = alvo.evento_id
  returning e.evento_id, e.corpo, e.sha256, e.assinatura_ts, e.assinatura_nonce, e.assinatura, e.caminho, e.tentativas;
end $$;

-- Confirma SÓ se o lease ainda é deste consumidor (lease vencido e retomado por outro ⇒ false, sem efeito).
create function mova_rele.confirmar(p_evento_id text, p_consumidor text)
returns boolean language plpgsql security definer set search_path = pg_catalog, extensions, mova_rele_cripto, pg_temp as $$
begin
  update mova_rele.evento set estado = 'PROCESSADO', concluido_em = clock_timestamp(), lease_ate = null, falha_codigo = null
   where evento_id = p_evento_id and estado = 'RESERVADO' and consumidor = p_consumidor;
  if not found then return false; end if;
  insert into mova_rele.auditoria (acao, evento_id, ator) values ('PROCESSADO', p_evento_id, p_consumidor);
  return true;
end $$;

-- Devolve para nova tentativa (espera exponencial limitada) ou marca falha definitiva (8 tentativas ou definitiva=true).
create function mova_rele.devolver(p_evento_id text, p_consumidor text, p_codigo text, p_definitiva boolean default false)
returns text language plpgsql security definer set search_path = pg_catalog, extensions, mova_rele_cripto, pg_temp as $$
declare v_t integer; v_estado text;
begin
  if p_codigo !~ '^[A-Z0-9_:]{1,80}$' then raise exception 'MOVA relé: código inválido'; end if;
  select tentativas into v_t from mova_rele.evento where evento_id = p_evento_id and estado = 'RESERVADO' and consumidor = p_consumidor for update;
  if not found then return 'SEM_LEASE'; end if;
  v_estado := case when p_definitiva or v_t >= 8 then 'FALHA_DEFINITIVA' else 'NOVA_TENTATIVA' end;
  update mova_rele.evento set estado = v_estado, lease_ate = null, falha_codigo = p_codigo,
         proxima_em = clock_timestamp() + make_interval(secs => least(300, 5 * power(2, greatest(v_t - 1, 0))::integer))
   where evento_id = p_evento_id;
  insert into mova_rele.auditoria (acao, evento_id, ator, codigo) values (v_estado, p_evento_id, p_consumidor, p_codigo);
  return v_estado;
end $$;

create function mova_rele.resumo()
returns table (estado text, quantidade bigint, mais_antigo timestamptz)
language sql security definer set search_path = pg_catalog, extensions, mova_rele_cripto, pg_temp as $$
  select e.estado, count(*), min(e.recebido_em) from mova_rele.evento e group by e.estado
$$;

-- Retenção: apaga só PROCESSADO com mais de p_dias (o conteúdo autenticado já está no MOVA). Uso administrativo (dono).
create function mova_rele.expurgar(p_dias integer default 7)
returns integer language plpgsql security definer set search_path = pg_catalog, extensions, mova_rele_cripto, pg_temp as $$
declare n integer;
begin
  if p_dias < 1 then raise exception 'MOVA relé: retenção mínima de 1 dia'; end if;
  delete from mova_rele.evento where estado = 'PROCESSADO' and concluido_em < clock_timestamp() - make_interval(days => p_dias);
  get diagnostics n = row_count;
  delete from mova_rele.nonce where expira_em < clock_timestamp();
  insert into mova_rele.auditoria (acao, codigo) values ('EXPURGO', n::text);
  return n;
end $$;

-- ------------------------------------------------------------------------------------------------- papéis
revoke all on all functions in schema mova_rele from public;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on all functions in schema mova_rele from %I', r); end if;
  end loop;
end $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'mova_rele_gravador') then create role mova_rele_gravador nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'mova_rele_consumidor') then create role mova_rele_consumidor nologin noinherit; end if;
end $$;
grant usage on schema mova_rele to mova_rele_gravador, mova_rele_consumidor;
grant execute on function mova_rele.receber(text, text, text, text, text, text, integer) to mova_rele_gravador;
grant execute on function mova_rele.reservar(text, integer, integer), mova_rele.confirmar(text, text), mova_rele.devolver(text, text, text, boolean), mova_rele.resumo() to mova_rele_consumidor;
-- A Edge Function conecta como `postgres` (SUPABASE_DB_URL) e faz SET LOCAL ROLE mova_rele_gravador: precisa ser membro.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'postgres') and current_user <> 'postgres' then execute 'grant mova_rele_gravador to postgres'; end if;
end $$;
