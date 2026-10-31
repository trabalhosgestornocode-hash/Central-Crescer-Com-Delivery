-- 140 — D-1: uma mensagem FÍSICA consolidada consome UMA única cota do telefone (teto de 3/dia por telefone preservado).
--
-- Coluna `consolidacao_chave` em comunicacao_mensagens (null = mensagem individual, como hoje) e novo parâmetro opcional
-- `p_consolidacao_chave` em comunicacao_reservar_envio. Com o parâmetro NULO (envio de hoje) a função se comporta IDÊNTICA à da 104:
-- count(distinct coalesce(chave, id)) = count(*) quando nenhuma linha tem chave. Com a chave informada:
--   * as linhas da MESMA chave não contam contra o próprio grupo (são a mesma mensagem física);
--   * linhas com a mesma chave contam UMA vez no teto por telefone/dia e nas taxas por minuto (organização e global);
--   * o limite por ORGANIZAÇÃO/dia e o cooldown continuam por linha (cada relatório é um aviso da sua empresa), exceto que o cooldown
--     ignora irmãs do mesmo grupo.
-- A reserva grava a chave (ou limpa, se nula) na linha reservada: um componente que volta ao fluxo individual (retry) perde a chave.
-- Não altera limites, política, destinatários, consentimentos nem dados existentes (coluna nova nula). Rollback: 140_rollback.sql.
begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regclass('public.comunicacao_mensagens') is null then
    raise exception 'migration 140: comunicacao_mensagens ausente';
  end if;
end $$;

alter table comunicacao_mensagens add column if not exists consolidacao_chave text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'comunicacao_mensagens_consolidacao_chave_chk') then
    alter table comunicacao_mensagens add constraint comunicacao_mensagens_consolidacao_chave_chk
      check (consolidacao_chave is null or char_length(consolidacao_chave) between 1 and 80);
  end if;
end $$;
create index if not exists idx_comunicacao_mensagens_consolidacao_chave on comunicacao_mensagens (consolidacao_chave) where consolidacao_chave is not null;

drop function if exists comunicacao_reservar_envio(uuid, text, bigint, integer, numeric, integer, integer, integer, timestamptz, integer);
create or replace function comunicacao_reservar_envio(
  p_id uuid, p_worker text, p_claim_geracao bigint, p_lease_segundos integer,
  p_cooldown_horas numeric, p_max_por_contato_dia integer,
  p_max_por_minuto integer, p_max_por_minuto_org integer, p_inicio_dia timestamptz,
  p_max_por_org_dia integer default null,
  p_consolidacao_chave text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare m comunicacao_mensagens; r comunicacao_mensagens; n integer;
begin
  perform pg_advisory_xact_lock(hashtext('comunicacao_capacidade'));

  select * into m from comunicacao_mensagens where id = p_id;
  if not found or m.status <> 'PROCESSING' or m.claimed_by is distinct from p_worker
     or m.claim_geracao <> p_claim_geracao or m.claim_expira_em is null or m.claim_expira_em <= now()
     or m.tentativas >= m.max_tentativas then
    return jsonb_build_object('resultado', 'POSSE_PERDIDA');
  end if;
  if m.expira_em is not null and m.expira_em <= now() then
    update comunicacao_mensagens set status = 'CANCELLED', erro = 'EXPIRADA', updated_at = now() where id = m.id;
    return jsonb_build_object('resultado', 'EXPIRADA');
  end if;

  -- COOLDOWN POR DESTINATÁRIO (mesmo contato) na mesma organização/unidade/tipo; irmãs do mesmo grupo consolidado não contam
  if p_cooldown_horas is not null then
    select count(*) into n from comunicacao_mensagens x
     where x.id <> m.id and x.direcao = 'saida' and x.organizacao_id = m.organizacao_id
       and x.contato_id is not distinct from m.contato_id
       and x.unidade_id is not distinct from m.unidade_id and x.tipo = m.tipo
       and (p_consolidacao_chave is null or x.consolidacao_chave is distinct from p_consolidacao_chave)
       and ( x.status in ('SENDING', 'DELIVERY_UNKNOWN')
          or (x.status in ('SENT', 'DELIVERED', 'READ') and x.enviado_em >= now() - make_interval(secs => p_cooldown_horas * 3600)) );
    if n > 0 then return jsonb_build_object('resultado', 'COOLDOWN'); end if;
  end if;

  -- LIMITE POR TELEFONE / dia — conta MENSAGENS FÍSICAS: linhas da mesma chave valem uma só; as do próprio grupo não contam
  if p_max_por_contato_dia is not null and m.contato_id is not null then
    select count(distinct coalesce(x.consolidacao_chave, x.id::text)) into n from comunicacao_mensagens x
     where x.id <> m.id and x.direcao = 'saida' and x.contato_id = m.contato_id
       and (p_consolidacao_chave is null or x.consolidacao_chave is distinct from p_consolidacao_chave)
       and x.status in ('SENDING', 'SENT', 'DELIVERED', 'READ', 'DELIVERY_UNKNOWN')
       and (x.enviado_em >= p_inicio_dia or x.entrega_incerta_em >= p_inicio_dia or (x.status = 'SENDING' and x.claimed_at >= p_inicio_dia));
    if n >= p_max_por_contato_dia then return jsonb_build_object('resultado', 'RATE_LIMIT_DIA'); end if;
  end if;

  -- LIMITE POR ORGANIZAÇÃO / dia (cada relatório é um aviso da empresa: por linha, como na 104)
  if p_max_por_org_dia is not null and m.alerta_id is not null then
    select count(*) into n from comunicacao_mensagens x
     where x.id <> m.id and x.direcao = 'saida' and x.organizacao_id = m.organizacao_id and x.alerta_id is not null
       and x.status in ('SENDING', 'SENT', 'DELIVERED', 'READ', 'DELIVERY_UNKNOWN')
       and (x.enviado_em >= p_inicio_dia or x.entrega_incerta_em >= p_inicio_dia or (x.status = 'SENDING' and x.claimed_at >= p_inicio_dia));
    if n >= p_max_por_org_dia then return jsonb_build_object('resultado', 'RATE_LIMIT_DIA_ORGANIZACAO'); end if;
  end if;

  if p_max_por_minuto_org is not null then
    select count(distinct coalesce(x.consolidacao_chave, x.id::text)) into n from comunicacao_mensagens x
     where x.id <> m.id and x.direcao = 'saida' and x.organizacao_id = m.organizacao_id
       and (p_consolidacao_chave is null or x.consolidacao_chave is distinct from p_consolidacao_chave)
       and x.status in ('SENDING', 'SENT', 'DELIVERED', 'READ', 'DELIVERY_UNKNOWN')
       and (x.enviado_em >= now() - interval '1 minute' or x.entrega_incerta_em >= now() - interval '1 minute'
            or (x.status = 'SENDING' and x.claimed_at >= now() - interval '1 minute'));
    if n >= p_max_por_minuto_org then return jsonb_build_object('resultado', 'RATE_LIMIT_MINUTO_ORGANIZACAO'); end if;
  end if;

  if p_max_por_minuto is not null then
    select count(distinct coalesce(x.consolidacao_chave, x.id::text)) into n from comunicacao_mensagens x
     where x.id <> m.id and x.direcao = 'saida'
       and (p_consolidacao_chave is null or x.consolidacao_chave is distinct from p_consolidacao_chave)
       and x.status in ('SENDING', 'SENT', 'DELIVERED', 'READ', 'DELIVERY_UNKNOWN')
       and (x.enviado_em >= now() - interval '1 minute' or x.entrega_incerta_em >= now() - interval '1 minute'
            or (x.status = 'SENDING' and x.claimed_at >= now() - interval '1 minute'));
    if n >= p_max_por_minuto then return jsonb_build_object('resultado', 'RATE_LIMIT_MINUTO'); end if;
  end if;

  update comunicacao_mensagens
     set status = 'SENDING', tentativas = tentativas + 1, consolidacao_chave = p_consolidacao_chave,
         claim_expira_em = now() + make_interval(secs => greatest(p_lease_segundos, 1)), updated_at = now()
   where id = p_id and status = 'PROCESSING' and claimed_by = p_worker and claim_geracao = p_claim_geracao
     and claim_expira_em > now() and tentativas < max_tentativas
  returning * into r;
  if not found then return jsonb_build_object('resultado', 'POSSE_PERDIDA'); end if;
  return jsonb_build_object('resultado', 'INICIADO', 'mensagem', to_jsonb(r));
end;
$$;
comment on function comunicacao_reservar_envio(uuid, text, bigint, integer, numeric, integer, integer, integer, timestamptz, integer, text) is
  'Reserva ATÔMICA (advisory lock) + PROCESSING -> SENDING. Como a 104, mais p_consolidacao_chave: linhas da mesma chave são UMA mensagem física para o teto por telefone/dia e as taxas por minuto. Chave nula = comportamento idêntico ao anterior.';
revoke all on function comunicacao_reservar_envio(uuid, text, bigint, integer, numeric, integer, integer, integer, timestamptz, integer, text) from public, anon, authenticated;
grant execute on function comunicacao_reservar_envio(uuid, text, bigint, integer, numeric, integer, integer, integer, timestamptz, integer, text) to service_role;

notify pgrst, 'reload schema';
commit;
