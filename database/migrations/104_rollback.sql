-- ROLLBACK da migration 104 — restaura os corpos EXATOS de 088 (reserva), 092 (sincroniza alerta + WHEN da 088) e 100 (valida habilitação, habilitar piloto).
-- ATENÇÃO (perda de dados, por desenho): apaga envio_automatico/limites por empresa, categorias por destinatário e o catálogo de categorias.
-- Mensagens já criadas por destinatário PERMANECEM (a tabela comunicacao_mensagens não é alterada, só perde o índice único parcial).
-- Antes de reverter em produção: desligar o modo global (DISABLED) — as RPCs antigas voltam a valer e ignoram envio_automatico.
begin;

-- 8. reserva (088)
drop function if exists comunicacao_reservar_envio(uuid, text, bigint, integer, numeric, integer, integer, integer, timestamptz, integer);
create or replace function comunicacao_reservar_envio(
  p_id uuid, p_worker text, p_claim_geracao bigint, p_lease_segundos integer,
  p_cooldown_horas numeric, p_max_por_contato_dia integer,
  p_max_por_minuto integer, p_max_por_minuto_org integer, p_inicio_dia timestamptz
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
  if p_cooldown_horas is not null then
    select count(*) into n from comunicacao_mensagens x
     where x.id <> m.id and x.direcao = 'saida' and x.organizacao_id = m.organizacao_id
       and x.unidade_id is not distinct from m.unidade_id and x.tipo = m.tipo
       and ( x.status in ('SENDING', 'DELIVERY_UNKNOWN')
          or (x.status in ('SENT', 'DELIVERED', 'READ') and x.enviado_em >= now() - make_interval(secs => p_cooldown_horas * 3600)) );
    if n > 0 then return jsonb_build_object('resultado', 'COOLDOWN'); end if;
  end if;
  if p_max_por_contato_dia is not null and m.contato_id is not null then
    select count(*) into n from comunicacao_mensagens x
     where x.id <> m.id and x.direcao = 'saida' and x.contato_id = m.contato_id
       and x.status in ('SENDING', 'SENT', 'DELIVERED', 'READ', 'DELIVERY_UNKNOWN')
       and (x.enviado_em >= p_inicio_dia or x.entrega_incerta_em >= p_inicio_dia or (x.status = 'SENDING' and x.claimed_at >= p_inicio_dia));
    if n >= p_max_por_contato_dia then return jsonb_build_object('resultado', 'RATE_LIMIT_DIA'); end if;
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
revoke all on function comunicacao_reservar_envio(uuid, text, bigint, integer, numeric, integer, integer, integer, timestamptz) from public, anon, authenticated;
grant execute on function comunicacao_reservar_envio(uuid, text, bigint, integer, numeric, integer, integer, integer, timestamptz) to service_role;

-- 6. sincroniza alerta (092) + trigger (WHEN da 088)
drop trigger if exists trg_comunicacao_mensagens_sincroniza_alerta on comunicacao_mensagens;
create or replace function comunicacao_mensagens_sincroniza_alerta()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.metadados->>'proposito' = 'reforco' then
    return null;
  end if;
  if new.status = 'CANCELLED' then
    update comunicacao_alertas set status = 'DETECTED', updated_at = now()
     where id = new.alerta_id and status in ('SCHEDULED', 'PROCESSING');
  else
    update comunicacao_alertas set status = new.status, updated_at = now()
     where id = new.alerta_id and status not in ('RESOLVED', 'CANCELLED') and status <> new.status;
  end if;
  return null;
end;
$$;
revoke all on function comunicacao_mensagens_sincroniza_alerta() from public, anon, authenticated;
create trigger trg_comunicacao_mensagens_sincroniza_alerta
  after update of status on comunicacao_mensagens
  for each row
  when (old.status is distinct from new.status and new.alerta_id is not null
        and (new.status in ('SENT', 'DELIVERED', 'READ', 'FAILED')
             or (new.status = 'CANCELLED' and new.erro = 'EXPIRADA')))
  execute function comunicacao_mensagens_sincroniza_alerta();
drop function if exists comunicacao_status_agregado_alerta(uuid);

-- 7/9. RPCs novas e re-grant das antigas
drop function if exists comunicacao_agendar_mensagens_alerta(uuid, text, text, jsonb, integer);
drop function if exists comunicacao_definir_envio_automatico(uuid, boolean, uuid);
drop function if exists comunicacao_habilitar_organizacao(uuid, uuid);
grant execute on function comunicacao_agendar_mensagem_alerta(uuid, text, text, text, timestamptz, timestamptz, integer) to service_role;
grant execute on function comunicacao_agendar_reforco_alerta(uuid, text, text, timestamptz, timestamptz, integer) to service_role;
grant execute on function comunicacao_agendar_aviso_tardio_d1(uuid, text, text, timestamptz, timestamptz, integer) to service_role;

-- habilitar piloto (100)
create or replace function comunicacao_habilitar_organizacao_piloto(
  p_organizacao_id uuid, p_ator_perfil_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  h comunicacao_habilitacoes; v_modo text; n integer; v_ator uuid; v_dest jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('comunicacao_habilitar_organizacao_piloto'));
  select trim(both '"' from (valor #>> '{}')) into v_modo from comunicacao_configuracoes where chave = 'modo';
  if coalesce(v_modo, 'DISABLED') <> 'DISABLED' then
    return jsonb_build_object('acao', 'MODO_NAO_DESABILITADO', 'modo', v_modo);
  end if;
  select * into h from comunicacao_habilitacoes where organizacao_id = p_organizacao_id for update;
  if not found then return jsonb_build_object('acao', 'SEM_CONFIGURACAO'); end if;
  if h.habilitado then return jsonb_build_object('acao', 'JA_HABILITADA'); end if;
  select count(*) into n from comunicacao_habilitacoes where habilitado and organizacao_id <> p_organizacao_id;
  if n > 0 then return jsonb_build_object('acao', 'OUTRA_ORGANIZACAO_HABILITADA'); end if;
  if h.timezone is null then return jsonb_build_object('acao', 'TIMEZONE_AUSENTE'); end if;
  if coalesce(array_length(h.tipos_permitidos, 1), 0) = 0 then return jsonb_build_object('acao', 'TIPO_AUSENTE'); end if;
  v_dest := comunicacao_resolver_destinatario(p_organizacao_id);
  if v_dest->>'acao' = 'SEM_DESTINATARIO' then return jsonb_build_object('acao', 'SEM_DESTINATARIO'); end if;
  if v_dest->>'acao' <> 'OK' then return jsonb_build_object('acao', 'DESTINATARIO_INELEGIVEL'); end if;
  select id into v_ator from perfis_operacionais where id = p_ator_perfil_id;
  update comunicacao_habilitacoes
     set habilitado = true, atualizado_por = v_ator, updated_at = now()
   where organizacao_id = p_organizacao_id;
  return jsonb_build_object('acao', 'HABILITADA');
end;
$$;
revoke all on function comunicacao_habilitar_organizacao_piloto(uuid, uuid) from public, anon, authenticated;
grant execute on function comunicacao_habilitar_organizacao_piloto(uuid, uuid) to service_role;

-- 5/4/3. resolvedor, índices, limite de destinatários
drop function if exists comunicacao_resolver_destinatarios(uuid, text);
drop index if exists ux_mensagens_alerta_destinatario_proposito;
drop index if exists ix_mensagens_org_enviado;
drop trigger if exists trg_comunicacao_contatos_empresa_limite on comunicacao_contatos_empresa;
drop function if exists comunicacao_contatos_empresa_limite();
drop function if exists comunicacao_max_destinatarios_ativos();
delete from comunicacao_configuracoes where chave = 'destinatarios';
alter table comunicacao_contatos_empresa drop column if exists ativado_em;
alter table comunicacao_contatos_empresa drop column if exists autorizacao_registrada_em;
alter table comunicacao_contatos_empresa drop column if exists autorizacao_registrada_por;

-- 2. categorias
drop table if exists comunicacao_destinatario_categorias;
drop table if exists comunicacao_categorias;

-- 1. habilitação: trigger de validação (100) e colunas
create or replace function comunicacao_habilitacoes_valida()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.timezone is not null and (
       not exists (select 1 from pg_timezone_names where name = new.timezone)
       or (new.timezone <> 'UTC' and (new.timezone not like '%/%' or new.timezone ilike 'etc/%'))) then
    raise exception 'timezone IANA invalido: %', new.timezone using errcode = '22023';
  end if;
  if new.janelas is not null and jsonb_typeof(new.janelas) <> 'object' then
    raise exception 'janelas deve ser um objeto jsonb' using errcode = '22023';
  end if;
  if new.destinatario_contato_empresa_id is not null then
    if not exists (select 1 from comunicacao_contatos_empresa ce
                    where ce.id = new.destinatario_contato_empresa_id and ce.organizacao_id = new.organizacao_id
                      and ce.ativo and ce.contato_whatsapp_id is not distinct from new.destinatario_contato_id) then
      raise exception 'responsavel de comunicacao inexistente, inativo ou de outra empresa' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function comunicacao_habilitacoes_valida() from public, anon, authenticated;

alter table comunicacao_habilitacoes drop constraint if exists comunicacao_habilitacoes_automatico_exige_habilitado;
alter table comunicacao_habilitacoes drop constraint if exists comunicacao_habilitacoes_limite_diario_org_positivo;
alter table comunicacao_habilitacoes drop constraint if exists comunicacao_habilitacoes_cooldown_positivo;
alter table comunicacao_habilitacoes drop column if exists envio_automatico;
alter table comunicacao_habilitacoes drop column if exists limite_diario_org;
alter table comunicacao_habilitacoes drop column if exists cooldown_minutos;
alter table comunicacao_habilitacoes drop column if exists envio_automatico_atualizado_em;
alter table comunicacao_habilitacoes drop column if exists envio_automatico_atualizado_por;
do $$ begin
  alter table comunicacao_habilitacoes add constraint comunicacao_habilitacoes_habilitado_exige_destinatario
    check (not habilitado or destinatario_contato_id is not null) not valid;
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
commit;
