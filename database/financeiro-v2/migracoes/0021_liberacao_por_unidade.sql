-- =====================================================================================================================
-- Financeiro v2 — migração 0021: LIBERAÇÃO DO FINANCEIRO V2 POR EMPRESA E UNIDADE — Execução 09B
--
-- Só é aplicada no PostgreSQL local isolado. Não pertence a database/migrations/.
--
-- A liberação decide se a INTERFACE do v2 substitui o financeiro atual numa unidade. Ela NÃO concede nada: as ações
-- continuam exigindo concessão `financeiro_v2.*`, sessão de banco e RLS.
--   * desligado por padrão: sem linha = desligado; unidade só vale com a empresa ligada;
--   * leitura por função (fv2_app, sem sessão de banco: é um booleano de disponibilidade, sem dado financeiro);
--   * escrita SOMENTE pela autoridade (gateway), por função do guardião, com ator, justificativa (≥ 20), prova de
--     segundo fator declarada pelo gateway (aal2 com carimbo) e histórico imutável; nenhum papel tem DML direto;
--   * desligar não apaga nada do v2 (dados e auditoria ficam); religar não "ressuscita" sessões antigas.
-- =====================================================================================================================

create table fv2_liberacao (
  organizacao_id uuid not null,
  unidade_id     uuid,                 -- null = a própria empresa
  ativa          boolean not null,
  versao         integer not null default 1,
  alterada_em    timestamptz not null default clock_timestamp(),
  alterada_por   uuid not null,
  justificativa  text not null check (length(btrim(justificativa)) >= 20)
);
create unique index fv2_liberacao_chave on fv2_liberacao (organizacao_id, coalesce(unidade_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table fv2_liberacao_historico (
  seq            bigint generated always as identity primary key,
  organizacao_id uuid not null,
  unidade_id     uuid,
  ativa_antes    boolean,
  ativa_depois   boolean not null,
  ator           uuid not null,
  justificativa  text not null,
  segundo_fator_em timestamptz not null,
  papel_de_banco text not null default session_user,
  em             timestamptz not null default clock_timestamp()
);

-- Histórico imutável (nem o guardião altera ou apaga).
create or replace function fv2_liberacao_historico_imutavel() returns trigger language plpgsql as $$
begin
  raise exception 'Financeiro v2: o histórico de liberações é imutável.' using errcode = 'FV042';
end $$;
create trigger fv2_liberacao_historico_imutavel before update or delete on fv2_liberacao_historico for each row execute function fv2_liberacao_historico_imutavel();

revoke all on fv2_liberacao, fv2_liberacao_historico from public;
grant select, insert, update on fv2_liberacao to fv2_guardiao;
grant select, insert on fv2_liberacao_historico to fv2_guardiao;
alter table fv2_liberacao enable row level security;
alter table fv2_liberacao_historico enable row level security;
create policy fv2_liberacao_guardiao on fv2_liberacao to fv2_guardiao using (true) with check (true);
create policy fv2_liberacao_historico_guardiao on fv2_liberacao_historico to fv2_guardiao using (true) with check (true);

-- Leitura: estado da empresa e da unidade (desligado por padrão).
create or replace function fv2_liberacao_estado(p_organizacao uuid, p_unidade uuid)
returns table (empresa boolean, unidade boolean) language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce((select l.ativa from fv2_liberacao l where l.organizacao_id = p_organizacao and l.unidade_id is null), false),
         coalesce((select l.ativa from fv2_liberacao l where l.organizacao_id = p_organizacao and l.unidade_id is null), false)
           and coalesce((select l.ativa from fv2_liberacao l where l.organizacao_id = p_organizacao and l.unidade_id = p_unidade), false)
$$;

-- Escrita: só a autoridade (gateway), que já verificou identidade e segundo fator do ator.
create or replace function fv2_liberacao_alterar(p_organizacao uuid, p_unidade uuid, p_ativa boolean, p_ator uuid, p_justificativa text, p_segundo_fator_em timestamptz)
returns integer language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  antes boolean;
  v integer;
begin
  if p_organizacao is null or p_ator is null or p_ativa is null then
    raise exception 'Financeiro v2: liberação exige empresa, ator e estado.' using errcode = 'FV042';
  end if;
  if length(btrim(coalesce(p_justificativa, ''))) < 20 then
    raise exception 'Financeiro v2: liberação exige justificativa (mínimo 20 caracteres).' using errcode = 'FV042';
  end if;
  if p_segundo_fator_em is null or p_segundo_fator_em < clock_timestamp() - interval '10 minutes' or p_segundo_fator_em > clock_timestamp() + interval '1 minute' then
    raise exception 'Financeiro v2: liberação exige segundo fator recente (10 minutos).' using errcode = 'FV042';
  end if;
  if p_unidade is not null and not exists (select 1 from fv2_escopo e where e.organizacao_id = p_organizacao and e.unidade_id = p_unidade) then
    raise exception 'Financeiro v2: unidade fora dos escopos do banco financeiro.' using errcode = 'FV042';
  end if;
  select l.ativa into antes from fv2_liberacao l where l.organizacao_id = p_organizacao and l.unidade_id is not distinct from p_unidade for update;
  if found then
    update fv2_liberacao set ativa = p_ativa, versao = versao + 1, alterada_em = clock_timestamp(), alterada_por = p_ator, justificativa = p_justificativa
     where organizacao_id = p_organizacao and unidade_id is not distinct from p_unidade returning versao into v;
  else
    insert into fv2_liberacao (organizacao_id, unidade_id, ativa, alterada_por, justificativa) values (p_organizacao, p_unidade, p_ativa, p_ator, p_justificativa) returning versao into v;
  end if;
  insert into fv2_liberacao_historico (organizacao_id, unidade_id, ativa_antes, ativa_depois, ator, justificativa, segundo_fator_em)
  values (p_organizacao, p_unidade, antes, p_ativa, p_ator, p_justificativa, p_segundo_fator_em);
  return v;
end $$;

alter function fv2_liberacao_estado(uuid, uuid) owner to fv2_guardiao;
alter function fv2_liberacao_alterar(uuid, uuid, boolean, uuid, text, timestamptz) owner to fv2_guardiao;
revoke all on function fv2_liberacao_estado(uuid, uuid) from public;
revoke all on function fv2_liberacao_alterar(uuid, uuid, boolean, uuid, text, timestamptz) from public;
grant execute on function fv2_liberacao_estado(uuid, uuid) to fv2_app, fv2_autoridade;
grant execute on function fv2_liberacao_alterar(uuid, uuid, boolean, uuid, text, timestamptz) to fv2_autoridade;
