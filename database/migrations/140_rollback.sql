-- Rollback da 140: restaura a funcao da 104 e remove a coluna da consolidacao. Seguro com a flag desligada (nenhuma linha usa a chave).
-- Mensagens que tenham chave passam a contar individualmente no teto (comportamento anterior).
begin;
set local lock_timeout = '5s';
drop function if exists comunicacao_reservar_envio(uuid, text, bigint, integer, numeric, integer, integer, integer, timestamptz, integer, text);
create or replace function comunicacao_reservar_envio(
  p_id uuid, p_worker text, p_claim_geracao bigint, p_lease_segundos integer,
  p_cooldown_horas numeric, p_max_por_contato_dia integer,
  p_max_por_minuto integer, p_max_por_minuto_org integer, p_inicio_dia timestamptz,
  p_max_por_org_dia integer default null
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

  -- COOLDOWN POR DESTINATÁRIO (mesmo contato) na mesma organização/unidade/tipo: o envio ao João nunca adia a Maria
  if p_cooldown_horas is not null then
    select count(*) into n from comunicacao_mensagens x
     where x.id <> m.id and x.direcao = 'saida' and x.organizacao_id = m.organizacao_id
       and x.contato_id is not distinct from m.contato_id
       and x.unidade_id is not distinct from m.unidade_id and x.tipo = m.tipo
       and ( x.status in ('SENDING', 'DELIVERY_UNKNOWN')
          or (x.status in ('SENT', 'DELIVERED', 'READ') and x.enviado_em >= now() - make_interval(secs => p_cooldown_horas * 3600)) );
    if n > 0 then return jsonb_build_object('resultado', 'COOLDOWN'); end if;
  end if;

  -- LIMITE POR DESTINATÁRIO / dia
  if p_max_por_contato_dia is not null and m.contato_id is not null then
    select count(*) into n from comunicacao_mensagens x
     where x.id <> m.id and x.direcao = 'saida' and x.contato_id = m.contato_id
       and x.status in ('SENDING', 'SENT', 'DELIVERED', 'READ', 'DELIVERY_UNKNOWN')
       and (x.enviado_em >= p_inicio_dia or x.entrega_incerta_em >= p_inicio_dia or (x.status = 'SENDING' and x.claimed_at >= p_inicio_dia));
    if n >= p_max_por_contato_dia then return jsonb_build_object('resultado', 'RATE_LIMIT_DIA'); end if;
  end if;

  -- LIMITE POR ORGANIZAÇÃO / dia (todos os destinatários somados; só mensagens de ALERTA — resposta humana não consome)
  if p_max_por_org_dia is not null and m.alerta_id is not null then
    select count(*) into n from comunicacao_mensagens x
     where x.id <> m.id and x.direcao = 'saida' and x.organizacao_id = m.organizacao_id and x.alerta_id is not null
       and x.status in ('SENDING', 'SENT', 'DELIVERED', 'READ', 'DELIVERY_UNKNOWN')
       and (x.enviado_em >= p_inicio_dia or x.entrega_incerta_em >= p_inicio_dia or (x.status = 'SENDING' and x.claimed_at >= p_inicio_dia));
    if n >= p_max_por_org_dia then return jsonb_build_object('resultado', 'RATE_LIMIT_DIA_ORGANIZACAO'); end if;
  end if;

  if p_max_por_minuto_org is not null then
    select count(*) into n from comunicacao_mensagens x
     where x.id <> m.id and x.direcao = 'saida' and x.organizacao_id = m.organizacao_id
       and x.status in ('SENDING', 'SENT', 'DELIVERED', 'READ', 'DELIVERY_UNKNOWN')
       and (x.enviado_em >= now() - interval '1 minute' or x.entrega_incerta_em >= now() - interval '1 minute'
            or (x.status = 'SENDING' and x.claimed_at >= now() - interval '1 minute'));
    if n >= p_max_por_minuto_org then return jsonb_build_object('resultado', 'RATE_LIMIT_MINUTO_ORGANIZACAO'); end if;
  end if;

  if p_max_por_minuto is not null then
    select count(*) into n from comunicacao_mensagens x
     where x.id <> m.id and x.direcao = 'saida'
       and x.status in ('SENDING', 'SENT', 'DELIVERED', 'READ', 'DELIVERY_UNKNOWN')
       and (x.enviado_em >= now() - interval '1 minute' or x.entrega_incerta_em >= now() - interval '1 minute'
            or (x.status = 'SENDING' and x.claimed_at >= now() - interval '1 minute'));
    if n >= p_max_por_minuto then return jsonb_build_object('resultado', 'RATE_LIMIT_MINUTO'); end if;
  end if;

  update comunicacao_mensagens
     set status = 'SENDING', tentativas = tentativas + 1,
         claim_expira_em = now() + make_interval(secs => greatest(p_lease_segundos, 1)), updated_at = now()
   where id = p_id and status = 'PROCESSING' and claimed_by = p_worker and claim_geracao = p_claim_geracao
     and claim_expira_em > now() and tentativas < max_tentativas
  returning * into r;
  if not found then return jsonb_build_object('resultado', 'POSSE_PERDIDA'); end if;
  return jsonb_build_object('resultado', 'INICIADO', 'mensagem', to_jsonb(r));
end;
$$;
comment on function comunicacao_reservar_envio(uuid, text, bigint, integer, numeric, integer, integer, integer, timestamptz, integer) is
  'Reserva ATÔMICA (advisory lock) + PROCESSING -> SENDING. Limites separados: cooldown e cota diária POR DESTINATÁRIO; cota diária POR ORGANIZAÇÃO (alertas); taxa por minuto por ORGANIZAÇÃO e GLOBAL. Resultados: INICIADO | POSSE_PERDIDA | EXPIRADA | COOLDOWN | RATE_LIMIT_DIA | RATE_LIMIT_DIA_ORGANIZACAO | RATE_LIMIT_MINUTO_ORGANIZACAO | RATE_LIMIT_MINUTO.';
revoke all on function comunicacao_reservar_envio(uuid, text, bigint, integer, numeric, integer, integer, integer, timestamptz, integer) from public, anon, authenticated;
grant execute on function comunicacao_reservar_envio(uuid, text, bigint, integer, numeric, integer, integer, integer, timestamptz, integer) to service_role;
drop index if exists idx_comunicacao_mensagens_consolidacao_chave;
alter table comunicacao_mensagens drop constraint if exists comunicacao_mensagens_consolidacao_chave_chk;
alter table comunicacao_mensagens drop column if exists consolidacao_chave;
notify pgrst, 'reload schema';
commit;
