-- 132 — Configurações 2.0: fuso e horário de funcionamento por unidade (D-15) e convite de usuário por e-mail (D-14).
--
-- ADITIVA. Não altera dados existentes nem comportamento: `unidades.timezone` nasce NULO (a regra de fuso só usa o fuso da unidade
-- depois de uma DATA DE CORTE configurada fora do banco — desligada por padrão), e o convite de usuário é uma tabela nova.
--
-- D-11 (transferência de unidade): nenhuma tabela nova tem o par de colunas `organizacao_id` + `unidade_id` — `usuarios_convites`
-- usa `unidade_alvo_id` —, então `remapear_organizacao_em_tabelas_de_unidade` não a enxerga (critério da função: as duas colunas).
-- As colunas novas de `unidades` também não interferem: a função atualiza OUTRAS tabelas.
--
-- D-14: token de convite = 32 bytes aleatórios gerados no backend; aqui só o SHA-256 (hex). E-mail: HMAC (busca/dedupe) +
-- cifrado (AES-256-GCM, chave fora do banco). Uso único atômico por `usuarios_convite_consumir`. 72 h de validade.
-- Rollback: 132_rollback.sql.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Fuso IANA e horário de funcionamento da unidade (D-15)
-- ---------------------------------------------------------------------------------------------------------------------------
alter table unidades add column if not exists timezone text;
alter table unidades add column if not exists horario_funcionamento jsonb;

comment on column unidades.timezone is
  'Fuso IANA da unidade (ex.: America/Porto_Velho). NULO = fuso da plataforma. Só passa a valer para competências a partir da data de corte configurada (OPERACIONAL_FUSO_UNIDADE_CORTE); antes disso o comportamento é o anterior. Histórico nunca é reprocessado.';
comment on column unidades.horario_funcionamento is
  'Horário de funcionamento: {"seg":[{"inicio":"HH:MM","fim":"HH:MM"}], …, "dom":[]}. Informativo (nenhuma regra de envio o usa nesta versão).';

create or replace function unidades_validar_fuso_horario() returns trigger
language plpgsql set search_path = public as $$
declare
  dia text; faixa jsonb; dias constant text[] := array['seg','ter','qua','qui','sex','sab','dom'];
begin
  if new.timezone is not null and not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'unidades: fuso inválido (%)', new.timezone using errcode = '22023';
  end if;
  if new.horario_funcionamento is not null then
    if jsonb_typeof(new.horario_funcionamento) <> 'object' then
      raise exception 'unidades: horario_funcionamento deve ser um objeto' using errcode = '22023';
    end if;
    for dia in select jsonb_object_keys(new.horario_funcionamento) loop
      if not (dia = any (dias)) then raise exception 'unidades: dia inválido (%)', dia using errcode = '22023'; end if;
      if jsonb_typeof(new.horario_funcionamento -> dia) <> 'array' or jsonb_array_length(new.horario_funcionamento -> dia) > 3 then
        raise exception 'unidades: o dia % deve ter de 0 a 3 faixas', dia using errcode = '22023';
      end if;
      for faixa in select value from jsonb_array_elements(new.horario_funcionamento -> dia) loop
        if coalesce(faixa->>'inicio', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(faixa->>'fim', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
           or faixa->>'inicio' = faixa->>'fim' then
          raise exception 'unidades: faixa inválida em % (use HH:MM, início diferente do fim)', dia using errcode = '22023';
        end if;
      end loop;
    end loop;
  end if;
  return new;
end $$;

drop trigger if exists trg_unidades_validar_fuso_horario on unidades;
create trigger trg_unidades_validar_fuso_horario before insert or update of timezone, horario_funcionamento on unidades
  for each row execute function unidades_validar_fuso_horario();
revoke all on function unidades_validar_fuso_horario() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Convite de usuário por e-mail (D-14)
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists usuarios_convites (
  id               uuid primary key default gen_random_uuid(),
  token_hash       text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  organizacao_id   uuid not null references organizacoes(id) on delete cascade,
  unidade_alvo_id  uuid references unidades(id) on delete cascade,      -- NULO = acesso à empresa; nunca "unidade_id" (D-11)
  papel            text not null check (papel in ('organization_admin', 'unit_manager', 'finance', 'operations', 'viewer')),
  nome             text check (nome is null or length(nome) <= 160),
  email_hmac       text not null check (email_hmac ~ '^[0-9a-f]{64}$'),
  email_cifrado    text not null,
  email_mascarado  text check (email_mascarado is null or email_mascarado ~ '^[^@]{1,3}[*]+@'),   -- só exibição (ex.: an***@x.com)
  chave_versao     integer not null default 1,
  criado_por       uuid,                                                 -- auth.users.id de quem convidou (sem FK: sobrevive à exclusão)
  criado_perfil_id uuid,
  criado_em        timestamptz not null default now(),
  expira_em        timestamptz not null,
  envio_status     text not null default 'DESLIGADO' check (envio_status in ('DESLIGADO', 'ENVIADO', 'FALHOU')),
  envio_tentado_em timestamptz,
  usado_em         timestamptz,
  usado_por        uuid,
  revogado_em      timestamptz,
  revogado_por     uuid,
  constraint usuarios_convites_token_unico unique (token_hash),
  constraint usuarios_convites_validade check (expira_em > criado_em and expira_em <= criado_em + interval '72 hours'),
  constraint usuarios_convites_uso_ou_revogacao check (not (usado_em is not null and revogado_em is not null))
);
create unique index if not exists ux_usuarios_convites_pendente
  on usuarios_convites (organizacao_id, email_hmac) where usado_em is null and revogado_em is null;
create index if not exists ix_usuarios_convites_org on usuarios_convites (organizacao_id, criado_em desc);

comment on table usuarios_convites is
  'Convite de acesso por e-mail (D-14). Token: só o SHA-256. E-mail: HMAC + cifrado. Uso único (usuarios_convite_consumir). Nenhuma senha passa por aqui.';

create or replace function usuarios_convites_coerencia() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.unidade_alvo_id is not null
     and not exists (select 1 from unidades u where u.id = new.unidade_alvo_id and u.organizacao_id = new.organizacao_id) then
    raise exception 'usuarios_convites: a unidade não pertence à empresa' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and ((to_jsonb(new) - array['usado_em','usado_por','revogado_em','revogado_por','envio_status','envio_tentado_em'])
                           is distinct from (to_jsonb(old) - array['usado_em','usado_por','revogado_em','revogado_por','envio_status','envio_tentado_em'])) then
    raise exception 'usuarios_convites: só o estado (uso, revogação, envio) muda' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (old.usado_em is not null or old.revogado_em is not null)
     and (new.usado_em is distinct from old.usado_em or new.revogado_em is distinct from old.revogado_em) then
    raise exception 'usuarios_convites: convite já encerrado' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_usuarios_convites_coerencia on usuarios_convites;
create trigger trg_usuarios_convites_coerencia before insert or update on usuarios_convites
  for each row execute function usuarios_convites_coerencia();

/** Consome o convite de forma ATÔMICA (uso único): confere token, e-mail (HMAC), prazo e estado. */
create or replace function usuarios_convite_consumir(p_token_hash text, p_email_hmac text, p_usuario_id uuid)
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare c usuarios_convites;
begin
  if p_token_hash is null or p_email_hmac is null or p_usuario_id is null then return jsonb_build_object('resultado', 'INVALIDO'); end if;
  select * into c from usuarios_convites where token_hash = p_token_hash for update;
  if not found then return jsonb_build_object('resultado', 'INVALIDO'); end if;
  if c.revogado_em is not null then return jsonb_build_object('resultado', 'REVOGADO'); end if;
  if c.usado_em is not null then return jsonb_build_object('resultado', 'JA_USADO'); end if;
  if c.expira_em <= now() then return jsonb_build_object('resultado', 'EXPIRADO'); end if;
  if c.email_hmac <> p_email_hmac then return jsonb_build_object('resultado', 'EMAIL_DIVERGENTE'); end if;
  if c.unidade_alvo_id is not null
     and not exists (select 1 from unidades u where u.id = c.unidade_alvo_id and u.organizacao_id = c.organizacao_id) then
    return jsonb_build_object('resultado', 'UNIDADE_MUDOU_DE_EMPRESA');
  end if;
  update usuarios_convites set usado_em = now(), usado_por = p_usuario_id where id = c.id;
  return jsonb_build_object('resultado', 'CONSUMIDO', 'convite_id', c.id, 'organizacao_id', c.organizacao_id,
                            'unidade_alvo_id', c.unidade_alvo_id, 'papel', c.papel, 'nome', c.nome);
end $$;

alter table usuarios_convites enable row level security;
do $$ begin
  revoke all on table usuarios_convites from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table usuarios_convites from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table usuarios_convites from authenticated; end if;
  revoke all on function usuarios_convite_consumir(text, text, uuid) from public;
  revoke all on function usuarios_convites_coerencia() from public;
  -- funções de gatilho também: o Supabase concede EXECUTE em funções novas a anon/authenticated por default privileges
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function usuarios_convite_consumir(text, text, uuid) from anon;
    revoke all on function usuarios_convites_coerencia() from anon;
    revoke all on function unidades_validar_fuso_horario() from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function usuarios_convite_consumir(text, text, uuid) from authenticated;
    revoke all on function usuarios_convites_coerencia() from authenticated;
    revoke all on function unidades_validar_fuso_horario() from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function usuarios_convites_coerencia() from service_role;
    revoke all on function unidades_validar_fuso_horario() from service_role;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table usuarios_convites from service_role;
    grant select, insert on table usuarios_convites to service_role;
    grant update (usado_em, usado_por, revogado_em, revogado_por, envio_status, envio_tentado_em) on table usuarios_convites to service_role;
    grant execute on function usuarios_convite_consumir(text, text, uuid) to service_role;
  end if;
end $$;

commit;

-- VERIFICAÇÃO (só leitura):
-- select column_name from information_schema.columns where table_name='unidades' and column_name in ('timezone','horario_funcionamento');
-- select has_table_privilege('authenticated','usuarios_convites','SELECT'), has_table_privilege('service_role','usuarios_convites','DELETE'); -- f | f
