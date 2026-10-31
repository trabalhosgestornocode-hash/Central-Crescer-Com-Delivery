-- 141 — Relatórios operacionais (diário e semanal) pela Central: persistência do RESUMO SEMANAL + FILA/AUDITORIA própria dos envios.
--
-- NÃO usa a fila do D-1 (`comunicacao_mensagens`) nem as cotas dela: o D-1 de pendências do Dashboard iFood fica intacto.
--   1. operacional_resumos_semanais — resumo da semana (segunda–domingo) calculado SÓ de fechamentos diários válidos; uma linha por
--      (unidade, semana, hash do conteúdo): correção de um diário gera outro hash = nova versão; reprocessar o mesmo não duplica.
--   2. operacional_relatorios_envios — um item por destinatário e relatório (diário/semanal): chave de idempotência ÚNICA, estados
--      PENDENTE → ENVIANDO → ENVIADO | FALHOU | INCERTO | BLOQUEADO | EXPIRADO, posse por claim (CAS) e histórico de tentativas.
--      Guarda a mensagem, o motivo e o id do provider. NUNCA guarda telefone (resolvido no envio, a partir do cadastro autorizado).
--   3. operacional_relatorio_reservar / _finalizar — transições atômicas (advisory lock por destinatário; cota diária própria por
--      destinatário e categoria; só reserva dentro de [disponivel_em, expira_em)).
-- As RPCs são SECURITY DEFINER (as mudanças de estado só passam por elas; o service_role não tem UPDATE direto nas tabelas), executáveis só por service_role.
-- Segurança: RLS ligado sem policy; nenhum grant a anon/authenticated; service_role com o mínimo (+ UPDATE só em organizacao_id,
-- exigido por remapear_organizacao_em_tabelas_de_unidade na transferência de unidade, como na 130). Aditiva; não altera dados.
-- Rollback: 141_rollback.sql (apaga resumos e itens da fila: exportar antes).
begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regclass('public.operacional_fechamentos') is null or to_regprocedure('public.operacional_validar_tenant()') is null then
    raise exception '141: exige a migration 130 (camada de fechamento operacional)';
  end if;
end $$;

create table if not exists operacional_resumos_semanais (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  semana_inicio date not null,
  status text not null check (status in ('COMPLETA', 'PARCIAL')),
  dias_validos integer not null check (dias_validos between 5 and 7),
  dias_ausentes jsonb not null default '[]'::jsonb,
  hash_conteudo text not null check (char_length(hash_conteudo) between 8 and 128),
  indicadores jsonb not null,
  mensagem text not null,
  criado_em timestamptz not null default now(),
  constraint uq_operacional_resumo_semanal unique (unidade_id, semana_inicio, hash_conteudo)
);
create index if not exists idx_operacional_resumos_tenant on operacional_resumos_semanais (organizacao_id, unidade_id, semana_inicio desc);
drop trigger if exists trg_operacional_resumos_tenant on operacional_resumos_semanais;
create trigger trg_operacional_resumos_tenant before insert or update on operacional_resumos_semanais
  for each row execute function operacional_validar_tenant();

create table if not exists operacional_relatorios_envios (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  tipo text not null check (tipo in ('diario', 'semanal')),
  categoria text not null check (categoria in ('fechamento_operacional_diario', 'resumo_semanal')),
  referencia date not null,                                   -- competência (diário) ou segunda-feira da semana (semanal)
  fechamento_id uuid references operacional_fechamentos(id),
  resumo_semanal_id uuid references operacional_resumos_semanais(id),
  proposito text not null default 'inicial' check (proposito in ('inicial', 'correcao')),
  contato_empresa_id uuid not null references comunicacao_contatos_empresa(id),
  chave_idempotencia text not null,
  mensagem text not null,
  tamanho integer not null,
  status text not null default 'PENDENTE' check (status in ('PENDENTE', 'ENVIANDO', 'ENVIADO', 'FALHOU', 'INCERTO', 'BLOQUEADO', 'EXPIRADO')),
  motivo text check (motivo is null or char_length(motivo) <= 200),
  tentativas integer not null default 0,
  max_tentativas integer not null default 3,
  disponivel_em timestamptz not null default now(),
  expira_em timestamptz not null,
  claimed_by text, claim_expira_em timestamptz,
  provider_message_id text,
  enviado_em timestamptz,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint uq_operacional_relatorio_envio_chave unique (chave_idempotencia),
  constraint ck_operacional_relatorio_origem check (
    (tipo = 'diario' and fechamento_id is not null and resumo_semanal_id is null and categoria = 'fechamento_operacional_diario')
    or (tipo = 'semanal' and resumo_semanal_id is not null and fechamento_id is null and categoria = 'resumo_semanal')),
  constraint ck_operacional_relatorio_posse check (status <> 'ENVIANDO' or (claimed_by is not null and claim_expira_em is not null))
);
create index if not exists idx_operacional_relatorios_fila on operacional_relatorios_envios (status, disponivel_em) where status in ('PENDENTE', 'ENVIANDO');
create index if not exists idx_operacional_relatorios_dest_dia on operacional_relatorios_envios (contato_empresa_id, categoria, enviado_em);
create index if not exists idx_operacional_relatorios_tenant on operacional_relatorios_envios (organizacao_id, unidade_id, criado_em desc);
drop trigger if exists trg_operacional_relatorios_tenant on operacional_relatorios_envios;
create trigger trg_operacional_relatorios_tenant before insert or update on operacional_relatorios_envios
  for each row execute function operacional_validar_tenant();

-- Reserva ATÔMICA: PENDENTE (ou ENVIANDO com posse vencida e tentativas sobrando) → ENVIANDO, com cota diária por destinatário/categoria.
create or replace function operacional_relatorio_reservar(
  p_id uuid, p_worker text, p_lease_segundos integer, p_inicio_dia timestamptz, p_max_por_destinatario_dia integer default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m operacional_relatorios_envios; n integer; r operacional_relatorios_envios;
begin
  select * into m from operacional_relatorios_envios where id = p_id;
  if not found then return jsonb_build_object('resultado', 'INEXISTENTE'); end if;
  perform pg_advisory_xact_lock(hashtext('relatorio_dest:' || m.contato_empresa_id::text || ':' || m.categoria));
  select * into m from operacional_relatorios_envios where id = p_id for update;
  if m.status = 'ENVIANDO' and m.claim_expira_em is not null and m.claim_expira_em <= now() then
    -- posse vencida: pode ter saído ou não — NUNCA reenvia (na dúvida, INCERTO)
    update operacional_relatorios_envios set status = 'INCERTO', motivo = 'POSSE_VENCIDA_NA_DUVIDA', claimed_by = null, claim_expira_em = null, atualizado_em = now() where id = m.id;
    return jsonb_build_object('resultado', 'INCERTO');
  end if;
  if m.status <> 'PENDENTE' then return jsonb_build_object('resultado', 'POSSE_PERDIDA', 'status', m.status); end if;
  if m.expira_em <= now() then
    update operacional_relatorios_envios set status = 'EXPIRADO', motivo = 'EXPIRADO', atualizado_em = now() where id = m.id;
    return jsonb_build_object('resultado', 'EXPIRADO');
  end if;
  if m.disponivel_em > now() then return jsonb_build_object('resultado', 'AINDA_NAO_DISPONIVEL'); end if;
  if m.tentativas >= m.max_tentativas then
    update operacional_relatorios_envios set status = 'FALHOU', motivo = 'TENTATIVAS_ESGOTADAS', atualizado_em = now() where id = m.id;
    return jsonb_build_object('resultado', 'FALHOU');
  end if;
  if p_max_por_destinatario_dia is not null then
    select count(*) into n from operacional_relatorios_envios x
     where x.id <> m.id and x.contato_empresa_id = m.contato_empresa_id and x.categoria = m.categoria
       and (x.status = 'ENVIANDO' or (x.status in ('ENVIADO', 'INCERTO') and coalesce(x.enviado_em, x.atualizado_em) >= p_inicio_dia));
    if n >= p_max_por_destinatario_dia then return jsonb_build_object('resultado', 'COTA_DIA'); end if;
  end if;
  update operacional_relatorios_envios set status = 'ENVIANDO', tentativas = tentativas + 1, claimed_by = p_worker,
         claim_expira_em = now() + make_interval(secs => greatest(p_lease_segundos, 1)), atualizado_em = now()
   where id = m.id and status = 'PENDENTE' returning * into r;
  if not found then return jsonb_build_object('resultado', 'POSSE_PERDIDA'); end if;
  return jsonb_build_object('resultado', 'INICIADO', 'tentativa', r.tentativas);
end $$;

-- Finalização com CAS da posse. RETRY volta a PENDENTE (só falha PROVADA pré-envio); dúvida = INCERTO e nunca volta.
create or replace function operacional_relatorio_finalizar(
  p_id uuid, p_worker text, p_resultado text, p_provider_message_id text default null, p_motivo text default null, p_retry_apos_segundos integer default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r operacional_relatorios_envios;
begin
  if p_resultado not in ('ENVIADO', 'FALHOU', 'INCERTO', 'BLOQUEADO', 'RETRY') then return jsonb_build_object('resultado', 'RESULTADO_INVALIDO'); end if;
  update operacional_relatorios_envios set
      status = case p_resultado when 'RETRY' then 'PENDENTE' else p_resultado end,
      motivo = left(p_motivo, 200),
      provider_message_id = case when p_resultado = 'ENVIADO' then p_provider_message_id else provider_message_id end,
      enviado_em = case when p_resultado = 'ENVIADO' then now() else enviado_em end,
      disponivel_em = case when p_resultado = 'RETRY' then now() + make_interval(secs => greatest(coalesce(p_retry_apos_segundos, 60), 1)) else disponivel_em end,
      claimed_by = null, claim_expira_em = null, atualizado_em = now()
   where id = p_id and status = 'ENVIANDO' and claimed_by = p_worker returning * into r;
  if not found then return jsonb_build_object('resultado', 'POSSE_PERDIDA'); end if;
  return jsonb_build_object('resultado', 'GRAVADO', 'status', r.status);
end $$;

alter table operacional_resumos_semanais enable row level security;
alter table operacional_relatorios_envios enable row level security;

do $$
declare papel text; t text;
begin
  foreach papel in array array['anon', 'authenticated', 'public'] loop
    if papel = 'public' or exists (select 1 from pg_roles where rolname = papel) then
      foreach t in array array['operacional_resumos_semanais', 'operacional_relatorios_envios'] loop
        execute format('revoke all on table %I from %s', t, papel);
      end loop;
      execute format('revoke all on function operacional_relatorio_reservar(uuid, text, integer, timestamptz, integer) from %s', papel);
      execute format('revoke all on function operacional_relatorio_finalizar(uuid, text, text, text, text, integer) from %s', papel);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- o Supabase concede ALL ao service_role por padrão em tabelas novas: tira tudo e devolve só o necessário (fila somente-inclusão; mudanças só pelas RPCs)
    revoke all on table operacional_resumos_semanais from service_role;
    revoke all on table operacional_relatorios_envios from service_role;
    grant select, insert on table operacional_resumos_semanais to service_role;
    grant update (organizacao_id) on table operacional_resumos_semanais to service_role;
    grant select, insert on table operacional_relatorios_envios to service_role;
    grant update (organizacao_id) on table operacional_relatorios_envios to service_role;
    grant execute on function operacional_relatorio_reservar(uuid, text, integer, timestamptz, integer) to service_role;
    grant execute on function operacional_relatorio_finalizar(uuid, text, text, text, text, integer) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
