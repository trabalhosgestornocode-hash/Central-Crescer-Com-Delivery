-- =====================================================================
-- MIGRATION 088 — Comunicação WhatsApp: agendamento seguro (C3.5-D.3-D)
-- =====================================================================
-- ⚠️  NÃO APLICAR EM PRODUÇÃO SEM APROVAÇÃO EXPLÍCITA.
--
-- PRINCÍPIO: a MENSAGEM representa TRANSPORTE; o ALERTA representa a CONDIÇÃO DE
-- NEGÓCIO (a pendência). Uma incerteza de transporte (DELIVERY_UNKNOWN) NUNCA vira
-- status do alerta — o alerta continua podendo ser RESOLVED quando a pendência some.
--
-- O QUE FAZ (aditivo; ÚNICA função existente alterada: comunicacao_claim_mensagens,
-- que só ganha o filtro `expira_em` — ver 5. O rollback restaura o corpo exato da 087)
--   1. comunicacao_habilitacoes — habilitação POR ORGANIZAÇÃO (fail-closed): habilitado
--      default false, tipos permitidos, timezone IANA (validado por trigger), janelas
--      opcionais, pausa e DESTINATÁRIO EXPLÍCITO (contato + perfil). Ausência de linha,
--      habilitado=false ou habilitado sem destinatário = NÃO envia. Contato cadastrado
--      NÃO é destinatário operacional: só o que foi explicitamente configurado.
--   2. comunicacao_mensagens.expira_em — TTL: mensagem velha nunca é enviada.
--   3. comunicacao_agendar_mensagem_alerta — ATOMICIDADE alerta -> mensagem: cria a
--      mensagem (idempotente) e move o alerta para SCHEDULED na MESMA transação; ou
--      nada. O DESTINATÁRIO NÃO É ESCOLHA DO CHAMADOR: a função o lê da habilitação
--      da organização do alerta e recusa se estiver ausente/inelegível.
--   4. TRIGGER trg_comunicacao_mensagens_sincroniza_alerta: a mensagem SENT/DELIVERED/
--      READ/FAILED move o alerta na MESMA instrução; a mensagem que EXPIRA (CANCELLED +
--      erro 'EXPIRADA') devolve o alerta a DETECTED ("pendência ativa, sem mensagem
--      viva" — NÃO cancela nem resolve a pendência). Nunca sobrescreve RESOLVED/CANCELLED.
--      DELIVERY_UNKNOWN da mensagem NÃO altera o alerta.
--   5. comunicacao_cancelar_expiradas (TTL) + claim que ignora expiradas.
--   6. comunicacao_reservar_envio — RESERVA ATÔMICA DE CAPACIDADE + início do envio
--      (PROCESSING -> SENDING). Sob advisory lock verifica, na MESMA transação: posse
--      (token do CAS de 087), TTL, cooldown (organização+unidade+tipo), cota diária por
--      contato e DUAS camadas de taxa por minuto — GLOBAL (o único número/sessão) e por
--      ORGANIZAÇÃO (fairness multi-tenant). Só com as duas vagas libera o SENDING.
--   7. comunicacao_reconciliar_entrega — contrato para a futura ação HUMANA sobre
--      DELIVERY_UNKNOWN (ENVIADA -> SENT | NAO_ENVIADA -> FAILED, com operador ativo e
--      motivo). NUNCA reenvia: outra mensagem é um NOVO evento/versão explícito.
--
-- CAPACIDADE (o que consome os limites): SENDING | SENT | DELIVERED | READ |
-- DELIVERY_UNKNOWN (a mensagem chegou, ou PODE ter chegado, ao provider). NÃO consomem:
-- SCHEDULED, PROCESSING, CANCELLED, BLOCKED e FAILED — FAILED é rejeição definitiva /
-- comprovadamente não enviada (inclui a reconciliação NAO_ENVIADA): nenhuma mensagem
-- saiu do número. O DELIVERY_UNKNOWN conta no cooldown SEM limite de tempo enquanto
-- não for reconciliado; nos limites por minuto conta na janela deslizante de 60 s.
--
-- DEFAULTS E DECISÕES DE PRODUTO (V1) — nenhum default ativa comunicação sozinho:
--   * Organização SEM linha de habilitação, com habilitado=false, ou habilitado SEM destinatário
--     explícito: FAIL-CLOSED (nada é agendado nem enviado).
--   * Timezone ausente/inválido: FAIL-CLOSED (deferido; NUNCA UTC implícito).
--   * Limite por organização: 3/min (default do código; a linha de configuração não é tocada
--     por esta migration). Limite global: `limites.max_proativas_por_minuto` (default 5).
--   * DESTINATÁRIO PERTENCE À ORGANIZAÇÃO (V1): uma organização multiunidade usa o MESMO
--     destinatário para os alertas de todas as suas unidades. Nada seleciona contato por
--     unidade. "Override por unidade" seria uma feature explícita futura.
--   * A FK do destinatário NÃO tem CASCADE (de propósito): um contato configurado não pode ser
--     apagado por acidente — desconfigure a habilitação antes.
--   * Expirar a MENSAGEM não cancela nem resolve a PENDÊNCIA; nenhum :v2/lembrete automático.
--
-- ORDEM DE ROLLOUT/ROLLBACK: a 088 é aplicada ANTES do backend que a usa. No rollback, o backend
-- novo é revertido PRIMEIRO e só depois roda 088_rollback.sql. Nunca remover a 088 com o backend
-- dependente dela live.
--
-- PRÉ-REQUISITOS: 082 e 087 aplicadas. TRANSACIONAL/IDEMPOTENTE. ROLLBACK: 088_rollback.sql.
-- SEGURANÇA: SECURITY INVOKER, search_path fixo, EXECUTE só para service_role.
-- Nenhuma organização é habilitada por esta migration (default fechado).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. HABILITAÇÃO + DESTINATÁRIO por organização (fail-closed)
-- ---------------------------------------------------------------------
create table if not exists comunicacao_habilitacoes (
  organizacao_id   uuid primary key references organizacoes(id) on delete cascade,
  habilitado       boolean not null default false,
  tipos_permitidos text[]  not null default '{}',
  -- IANA "Região/Cidade" (ex.: America/Fortaleza) ou UTC. Nunca um offset.
  timezone         text,
  -- opcional; mesmo formato de comunicacao_configuracoes.janelas
  -- ({"seg_sex":{"inicio":"08:00","fim":"18:00"},"sab":null,"dom":null}); null = usa o padrão global.
  janelas          jsonb,
  pausado_ate      timestamptz,
  pausado_motivo   text,
  -- DESTINATÁRIO EXPLÍCITO: o par (contato, perfil) tem de existir em contatos_whatsapp_perfis.
  destinatario_contato_id uuid,
  destinatario_perfil_id  uuid,
  atualizado_por   uuid references perfis_operacionais(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- registro incompleto NÃO pode estar habilitado
  constraint comunicacao_habilitacoes_habilitado_exige_timezone check (not habilitado or timezone is not null),
  constraint comunicacao_habilitacoes_habilitado_exige_destinatario check (not habilitado or destinatario_contato_id is not null),
  constraint comunicacao_habilitacoes_destinatario_par check ((destinatario_contato_id is null) = (destinatario_perfil_id is null)),
  constraint comunicacao_habilitacoes_destinatario_fk foreign key (destinatario_contato_id, destinatario_perfil_id)
    references contatos_whatsapp_perfis (contato_id, perfil_operacional_id)
);

comment on table comunicacao_habilitacoes is
  'Habilitação de WhatsApp PROATIVO por ORGANIZAÇÃO. Ausência de linha = não habilitada (fail-closed). habilitado=true exige timezone E destinatário explícito. habilitado=true sozinho não basta: modo, consentimento, tipo, janela, cooldown e cota continuam valendo.';
comment on column comunicacao_habilitacoes.destinatario_contato_id is
  'Destinatário operacional EXPLÍCITO (com destinatario_perfil_id). Nunca inferido da ordem/existência de contatos.';

create or replace function comunicacao_habilitacoes_valida()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- IANA "Regiao/Cidade" (ou UTC): recusa offsets e aliases de offset fixo (EST, GMT, Etc/GMT+3)
  if new.timezone is not null and (
       not exists (select 1 from pg_timezone_names where name = new.timezone)
       or (new.timezone <> 'UTC' and (new.timezone not like '%/%' or new.timezone ilike 'etc/%'))) then
    raise exception 'timezone IANA invalido: %', new.timezone using errcode = '22023';
  end if;
  if new.janelas is not null and jsonb_typeof(new.janelas) <> 'object' then
    raise exception 'janelas deve ser um objeto jsonb' using errcode = '22023';
  end if;
  -- destinatário: o perfil TEM de ter vínculo ativo com ESTA organização (cross-org é impossível)
  -- e o par contato<->perfil tem de estar ativo.
  if new.destinatario_perfil_id is not null then
    if not exists (select 1 from usuarios_organizacoes uo
                    where uo.perfil_id = new.destinatario_perfil_id and uo.organizacao_id = new.organizacao_id and uo.ativo) then
      raise exception 'destinatario sem vinculo ativo com a organizacao' using errcode = '22023';
    end if;
    if not exists (select 1 from contatos_whatsapp_perfis cp
                    where cp.contato_id = new.destinatario_contato_id and cp.perfil_operacional_id = new.destinatario_perfil_id and cp.ativo) then
      raise exception 'par contato<->perfil inexistente ou inativo' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function comunicacao_habilitacoes_valida() from public, anon, authenticated;

drop trigger if exists trg_comunicacao_habilitacoes_valida on comunicacao_habilitacoes;
create trigger trg_comunicacao_habilitacoes_valida before insert or update on comunicacao_habilitacoes
  for each row execute function comunicacao_habilitacoes_valida();
drop trigger if exists trg_comunicacao_habilitacoes_upd on comunicacao_habilitacoes;
create trigger trg_comunicacao_habilitacoes_upd before update on comunicacao_habilitacoes
  for each row execute function set_updated_at();

alter table comunicacao_habilitacoes enable row level security;
revoke all on comunicacao_habilitacoes from authenticated, anon;

-- ---------------------------------------------------------------------
-- 2. TTL da mensagem
-- ---------------------------------------------------------------------
alter table comunicacao_mensagens add column if not exists expira_em timestamptz;
comment on column comunicacao_mensagens.expira_em is
  'Depois deste instante a MENSAGEM NUNCA é enviada (vira CANCELLED/EXPIRADA). NULL = não expira. Avaliado no relógio do BANCO. Expirar a mensagem NÃO resolve nem cancela a pendência (o alerta volta a DETECTED).';

-- ---------------------------------------------------------------------
-- 3. ATOMICIDADE alerta -> mensagem, com DESTINATÁRIO lido da habilitação
-- ---------------------------------------------------------------------
create or replace function comunicacao_agendar_mensagem_alerta(
  p_alerta_id uuid, p_tipo text, p_conteudo text,
  p_idempotency_key text, p_disponivel_em timestamptz, p_expira_em timestamptz,
  p_max_tentativas integer default 5
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare a comunicacao_alertas; m comunicacao_mensagens; h comunicacao_habilitacoes; c contatos_whatsapp; n integer;
begin
  select * into a from comunicacao_alertas where id = p_alerta_id for update;  -- serializa por alerta
  if not found then return jsonb_build_object('acao', 'ALERTA_INEXISTENTE'); end if;

  select * into m from comunicacao_mensagens where idempotency_key = p_idempotency_key;
  if found then
    if m.alerta_id is distinct from a.id then return jsonb_build_object('acao', 'CHAVE_EM_USO'); end if;
    -- a mensagem deste evento lógico já EXPIROU: NÃO cria outra (lembrete/nova versão = regra explícita futura)
    if m.status = 'CANCELLED' and m.erro = 'EXPIRADA' then
      return jsonb_build_object('acao', 'MENSAGEM_EXPIRADA', 'mensagem_id', m.id);
    end if;
    if a.status = 'DETECTED' and m.status in ('SCHEDULED', 'PROCESSING', 'SENDING') then
      update comunicacao_alertas set status = 'SCHEDULED' where id = a.id; -- repara alerta preso
    end if;
    return jsonb_build_object('acao', 'JA_EXISTIA', 'mensagem_id', m.id, 'status', m.status);
  end if;

  -- entrega desconhecida/em curso para este evento lógico: nada novo até reconciliar
  select count(*) into n from comunicacao_mensagens where alerta_id = a.id and status in ('SENDING', 'DELIVERY_UNKNOWN');
  if n > 0 then return jsonb_build_object('acao', 'ENTREGA_DESCONHECIDA'); end if;

  if a.status <> 'DETECTED' then
    return jsonb_build_object('acao', 'ALERTA_NAO_DETECTED', 'status_alerta', a.status);
  end if;

  -- HABILITAÇÃO + DESTINATÁRIO (fail-closed): nenhuma escolha do chamador
  select * into h from comunicacao_habilitacoes where organizacao_id = a.organizacao_id;
  if not found or h.habilitado is not true or h.timezone is null then
    return jsonb_build_object('acao', 'NAO_HABILITADA');
  end if;
  if p_tipo is null or not (p_tipo = any (h.tipos_permitidos)) then
    return jsonb_build_object('acao', 'TIPO_NAO_PERMITIDO');
  end if;
  if h.destinatario_contato_id is null or h.destinatario_perfil_id is null then
    return jsonb_build_object('acao', 'SEM_DESTINATARIO');
  end if;
  select * into c from contatos_whatsapp where id = h.destinatario_contato_id;
  if not found or c.opt_out is not false or c.consentimento is not true or c.verificado is not true
     or not exists (select 1 from perfis_operacionais where id = h.destinatario_perfil_id and ativo)
     or not exists (select 1 from usuarios_organizacoes uo where uo.perfil_id = h.destinatario_perfil_id and uo.organizacao_id = a.organizacao_id and uo.ativo)
     or not exists (select 1 from contatos_whatsapp_perfis cp where cp.contato_id = h.destinatario_contato_id and cp.perfil_operacional_id = h.destinatario_perfil_id and cp.ativo) then
    return jsonb_build_object('acao', 'DESTINATARIO_INELEGIVEL');
  end if;

  insert into comunicacao_mensagens (alerta_id, organizacao_id, unidade_id, contato_id, destinatario_perfil_id,
                                     tipo, conteudo, idempotency_key, status, disponivel_em, expira_em, max_tentativas)
  values (a.id, a.organizacao_id, a.unidade_id, h.destinatario_contato_id, h.destinatario_perfil_id,
          p_tipo, p_conteudo, p_idempotency_key, 'SCHEDULED', p_disponivel_em, p_expira_em, p_max_tentativas)
  returning * into m;
  update comunicacao_alertas set status = 'SCHEDULED' where id = a.id;
  return jsonb_build_object('acao', 'CRIADA', 'mensagem_id', m.id);
end;
$$;
comment on function comunicacao_agendar_mensagem_alerta(uuid, text, text, text, timestamptz, timestamptz, integer) is
  'Cria a mensagem (idempotente pela chave) e move o alerta DETECTED -> SCHEDULED na MESMA transação: ou os dois, ou nada. O destinatário vem da habilitação da organização do alerta (nunca do chamador). Recusa: ENTREGA_DESCONHECIDA, NAO_HABILITADA, TIPO_NAO_PERMITIDO, SEM_DESTINATARIO, DESTINATARIO_INELEGIVEL, MENSAGEM_EXPIRADA (não recria).';

-- ---------------------------------------------------------------------
-- 4. O ALERTA acompanha a mensagem (TRIGGER) — sem incerteza de transporte no alerta
-- ---------------------------------------------------------------------
create or replace function comunicacao_mensagens_sincroniza_alerta()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'CANCELLED' then
    -- a mensagem EXPIROU: a pendência de negócio continua; o alerta fica "ativo, sem mensagem viva"
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

drop trigger if exists trg_comunicacao_mensagens_sincroniza_alerta on comunicacao_mensagens;
create trigger trg_comunicacao_mensagens_sincroniza_alerta
  after update of status on comunicacao_mensagens
  for each row
  when (old.status is distinct from new.status and new.alerta_id is not null
        and (new.status in ('SENT', 'DELIVERED', 'READ', 'FAILED')
             or (new.status = 'CANCELLED' and new.erro = 'EXPIRADA')))
  execute function comunicacao_mensagens_sincroniza_alerta();

-- ---------------------------------------------------------------------
-- 5. TTL: cancelar expiradas + claim que ignora expiradas
-- ---------------------------------------------------------------------
-- SENDING/DELIVERY_UNKNOWN NUNCA são tocados.
create or replace function comunicacao_cancelar_expiradas(p_worker text)
returns setof comunicacao_mensagens
language sql
security invoker
set search_path = public
as $$
  update comunicacao_mensagens
     set status = 'CANCELLED', erro = 'EXPIRADA', updated_at = now()
   where expira_em is not null and expira_em <= now()
     and (status = 'SCHEDULED' or (status = 'PROCESSING' and claim_expira_em < now()))
  returning *;
$$;
comment on function comunicacao_cancelar_expiradas(text) is
  'TTL: SCHEDULED (ou PROCESSING com lease vencido) com expira_em no passado -> CANCELLED/EXPIRADA (o alerta volta a DETECTED pelo trigger; a pendência NÃO é cancelada). Nunca toca SENDING nem DELIVERY_UNKNOWN. p_worker é só rótulo de auditoria.';

-- CLAIM: mensagem expirada nunca é reivindicada (nunca chega a PROCESSING).
-- Único ajuste sobre o claim da 087: o filtro `expira_em`. Corpo, assinatura e token
-- (claim_geracao) IDÊNTICOS aos da 087. O rollback restaura o texto exato da 087.
create or replace function comunicacao_claim_mensagens(p_limite integer, p_worker text, p_lease_segundos integer default 120)
returns setof comunicacao_mensagens
language sql
security invoker
set search_path = public
as $$
  with candidatos as (
    select id
    from comunicacao_mensagens
    where ((status = 'SCHEDULED' and disponivel_em <= now())
       or (status = 'PROCESSING' and claim_expira_em < now()))
      and (expira_em is null or expira_em > now())
    order by disponivel_em asc
    limit greatest(p_limite, 0)
    for update skip locked
  )
  update comunicacao_mensagens m
  set status = 'PROCESSING',
      claimed_by = p_worker,
      claimed_at = now(),
      claim_expira_em = now() + make_interval(secs => greatest(p_lease_segundos, 1)),
      claim_geracao = m.claim_geracao + 1,
      updated_at = now()
  from candidatos c
  where m.id = c.id
  returning m.*;
$$;

comment on function comunicacao_claim_mensagens(integer, text, integer) is
  'Claim ATÔMICO de até p_limite mensagens elegíveis (SCHEDULED disponíveis, ou PROCESSING com lease expirado), via FOR UPDATE SKIP LOCKED. Incrementa claim_geracao (token do CLAIM); NÃO incrementa tentativas (attempt só nasce em comunicacao_iniciar_envio). NUNCA reivindica SENDING nem DELIVERY_UNKNOWN, nem mensagem com expira_em vencido (088: essas vão para CANCELLED/EXPIRADA via comunicacao_cancelar_expiradas).';

-- ---------------------------------------------------------------------
-- 6. RESERVA ATÔMICA de capacidade (global + por organização) + início do envio
-- ---------------------------------------------------------------------
-- Consumo = SENDING | SENT | DELIVERED | READ | DELIVERY_UNKNOWN (ver o cabeçalho).
-- PROCESSING/SCHEDULED/CANCELLED/BLOCKED/FAILED não consomem. A própria mensagem nunca conta.
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
  -- serializa TODAS as reservas: dois workers nunca avaliam a capacidade sobre o mesmo estado
  perform pg_advisory_xact_lock(hashtext('comunicacao_capacidade'));

  select * into m from comunicacao_mensagens where id = p_id;
  if not found or m.status <> 'PROCESSING' or m.claimed_by is distinct from p_worker
     or m.claim_geracao <> p_claim_geracao or m.claim_expira_em is null or m.claim_expira_em <= now()
     or m.tentativas >= m.max_tentativas then
    return jsonb_build_object('resultado', 'POSSE_PERDIDA');
  end if;
  if m.expira_em is not null and m.expira_em <= now() then
    -- expirou: cancela AQUI (mesma transação) — nunca fica PROCESSING esperando o chamador
    update comunicacao_mensagens set status = 'CANCELLED', erro = 'EXPIRADA', updated_at = now() where id = m.id;
    return jsonb_build_object('resultado', 'EXPIRADA');
  end if;

  if p_cooldown_horas is not null then
    select count(*) into n from comunicacao_mensagens x
     where x.id <> m.id and x.direcao = 'saida' and x.organizacao_id = m.organizacao_id
       and x.unidade_id is not distinct from m.unidade_id and x.tipo = m.tipo
       and ( x.status in ('SENDING', 'DELIVERY_UNKNOWN')        -- não reconciliadas: SEM limite de tempo
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

  -- CAMADA 2 — por ORGANIZAÇÃO (fairness: uma empresa não consome a capacidade das outras)
  if p_max_por_minuto_org is not null then
    select count(*) into n from comunicacao_mensagens x
     where x.id <> m.id and x.direcao = 'saida' and x.organizacao_id = m.organizacao_id
       and x.status in ('SENDING', 'SENT', 'DELIVERED', 'READ', 'DELIVERY_UNKNOWN')
       and (x.enviado_em >= now() - interval '1 minute' or x.entrega_incerta_em >= now() - interval '1 minute'
            or (x.status = 'SENDING' and x.claimed_at >= now() - interval '1 minute'));
    if n >= p_max_por_minuto_org then return jsonb_build_object('resultado', 'RATE_LIMIT_MINUTO_ORGANIZACAO'); end if;
  end if;

  -- CAMADA 1 — GLOBAL (o único número remetente / a sessão Baileys)
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
comment on function comunicacao_reservar_envio(uuid, text, bigint, integer, numeric, integer, integer, integer, timestamptz) is
  'Reserva ATÔMICA de capacidade (advisory lock) + PROCESSING -> SENDING. Resultados: INICIADO | POSSE_PERDIDA | EXPIRADA (a mensagem já foi CANCELLED/EXPIRADA aqui) | COOLDOWN | RATE_LIMIT_DIA | RATE_LIMIT_MINUTO_ORGANIZACAO | RATE_LIMIT_MINUTO (global). Só libera com vaga GLOBAL E da ORGANIZAÇÃO. O provider só pode ser chamado após INICIADO.';

-- ---------------------------------------------------------------------
-- 7. RECONCILIAÇÃO HUMANA de DELIVERY_UNKNOWN (contrato; sem UI, sem retry)
-- ---------------------------------------------------------------------
create or replace function comunicacao_reconciliar_entrega(p_id uuid, p_operador uuid, p_resultado text, p_motivo text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare r comunicacao_mensagens;
begin
  if p_operador is null then raise exception 'operador obrigatorio' using errcode = '22023'; end if;
  if not exists (select 1 from perfis_operacionais where id = p_operador and ativo) then
    raise exception 'operador inexistente ou inativo' using errcode = '22023';
  end if;
  if p_motivo is null or length(trim(p_motivo)) < 5 then raise exception 'motivo obrigatorio (>= 5 caracteres)' using errcode = '22023'; end if;
  if p_resultado is null or p_resultado not in ('ENVIADA', 'NAO_ENVIADA') then raise exception 'resultado invalido' using errcode = '22023'; end if;

  update comunicacao_mensagens m
     set status = case when p_resultado = 'ENVIADA' then 'SENT' else 'FAILED' end,
         enviado_em = case when p_resultado = 'ENVIADA' then coalesce(m.enviado_em, now()) else m.enviado_em end,
         falhou_em = case when p_resultado = 'NAO_ENVIADA' then now() else m.falhou_em end,
         erro_permanente = case when p_resultado = 'NAO_ENVIADA' then true else m.erro_permanente end,
         erro = case when p_resultado = 'NAO_ENVIADA' then 'RECONCILIADA_NAO_ENVIADA' else null end,
         metadados = m.metadados || jsonb_build_object('reconciliacao',
           jsonb_build_object('operador', p_operador, 'resultado', p_resultado, 'motivo', p_motivo, 'em', now())),
         updated_at = now()
   where m.id = p_id and m.status = 'DELIVERY_UNKNOWN'
  returning * into r;
  if not found then return jsonb_build_object('acao', 'NAO_ENCONTRADA_OU_NAO_UNKNOWN'); end if;

  -- O alerta acompanha via trigger (SENT/FAILED), sem sobrescrever RESOLVED/CANCELLED.
  -- "Não enviada" NÃO reabre nada: outra mensagem exige um NOVO evento/versão explícito.
  return jsonb_build_object('acao', 'RECONCILIADA', 'status', r.status);
end;
$$;
comment on function comunicacao_reconciliar_entrega(uuid, uuid, text, text) is
  'Único caminho (humano, auditado no metadados) para tirar uma mensagem de DELIVERY_UNKNOWN: ENVIADA -> SENT | NAO_ENVIADA -> FAILED. Nunca retry.';

-- ---------------------------------------------------------------------
-- Grants (só service_role)
-- ---------------------------------------------------------------------
revoke all on function comunicacao_agendar_mensagem_alerta(uuid, text, text, text, timestamptz, timestamptz, integer) from public, anon, authenticated;
revoke all on function comunicacao_reservar_envio(uuid, text, bigint, integer, numeric, integer, integer, integer, timestamptz) from public, anon, authenticated;
revoke all on function comunicacao_reconciliar_entrega(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function comunicacao_cancelar_expiradas(text) from public, anon, authenticated;
grant execute on function comunicacao_cancelar_expiradas(text) to service_role;
grant execute on function comunicacao_agendar_mensagem_alerta(uuid, text, text, text, timestamptz, timestamptz, integer) to service_role;
grant execute on function comunicacao_reservar_envio(uuid, text, bigint, integer, numeric, integer, integer, integer, timestamptz) to service_role;
grant execute on function comunicacao_reconciliar_entrega(uuid, uuid, text, text) to service_role;

notify pgrst, 'reload schema';
commit;
