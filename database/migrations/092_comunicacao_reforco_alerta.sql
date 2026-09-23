-- =====================================================================
-- MIGRATION 092 — Comunicação WhatsApp: reforço de prazo final D-1 (2ª mensagem de um alerta)
-- =====================================================================
-- Requisito (H.4-A.8): 1 aviso normal (wa:alerta:{id}:v1) + NO MÁXIMO UM reforço de prazo final
-- (wa:alerta:{id}:reforco:v1). Horário (20:00–22:00 local), cutoff (22:30), D-1 de hoje, espaçamento
-- e texto são responsabilidade do backend (mesmo padrão da 088).
--
-- O QUE FAZ (aditivo; sem tabela/coluna nova; sem estágios/prioridades):
--   1. RPC comunicacao_agendar_reforco_alerta — a 088 (comunicacao_agendar_mensagem_alerta) só aceita
--      alerta DETECTED e fica 100% INTACTA; esta função, específica, só cria o reforço de um alerta
--      cujo 1º envio comprovadamente saiu (SENT/DELIVERED/READ). Chave determinística validada aqui
--      (impossível um 2º reforço), idempotente, mesmas checagens de habilitação/destinatário da 088.
--      O reforço é identificado por comunicacao_mensagens.metadados->>'proposito' = 'reforco'
--      (ausente = inicial).
--   2. comunicacao_mensagens_sincroniza_alerta() (trigger da 088) — MESMA assinatura, MESMO trigger,
--      corpo com UMA guarda: mensagem com proposito='reforco' NÃO propaga status ao alerta. A mensagem
--      INICIAL continua sendo a única dona de comunicacao_alertas.status (semântica da 088 preservada
--      100% para mensagens sem propósito). O reforço tem fonte de verdade própria: a linha em
--      comunicacao_mensagens. RESOLVED continua sendo gravado pelo JS (resolverAlerta), fora do trigger.
--
-- PRÉ-REQUISITOS: 082, 087, 088. TRANSACIONAL/IDEMPOTENTE. ROLLBACK: 092_rollback.sql (restaura o
-- corpo EXATO do trigger da 088). Independente da 091 (não aplicada, preservada em lab/multi-estagio).
-- SEGURANÇA: SECURITY INVOKER, search_path fixo, EXECUTE só para service_role.
-- Nenhuma organização é habilitada por esta migration.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. RPC do reforço
-- ---------------------------------------------------------------------
create or replace function comunicacao_agendar_reforco_alerta(
  p_alerta_id uuid, p_conteudo text, p_idempotency_key text,
  p_disponivel_em timestamptz, p_expira_em timestamptz,
  p_max_tentativas integer default 5
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  a comunicacao_alertas; m comunicacao_mensagens; ini comunicacao_mensagens;
  h comunicacao_habilitacoes; c contatos_whatsapp; n integer;
begin
  select * into a from comunicacao_alertas where id = p_alerta_id for update;  -- serializa por alerta
  if not found then return jsonb_build_object('acao', 'ALERTA_INEXISTENTE'); end if;

  -- A chave do reforço é DETERMINÍSTICA e validada aqui: impossível criar um 2º reforço com outra chave.
  if p_idempotency_key is distinct from ('wa:alerta:' || a.id::text || ':reforco:v1') then
    return jsonb_build_object('acao', 'CHAVE_INVALIDA');
  end if;

  select * into m from comunicacao_mensagens where idempotency_key = p_idempotency_key;
  if found then
    if m.alerta_id is distinct from a.id then return jsonb_build_object('acao', 'CHAVE_EM_USO'); end if;
    return jsonb_build_object('acao', 'JA_EXISTIA', 'mensagem_id', m.id, 'status', m.status);
  end if;

  -- Estado coerente com "o 1º aviso já saiu". DETECTED/SCHEDULED/PROCESSING/BLOCKED/FAILED/
  -- RESPONDED/RESOLVED/CANCELLED nunca recebem reforço.
  if a.status not in ('SENT', 'DELIVERED', 'READ') then
    return jsonb_build_object('acao', 'ALERTA_SEM_PRIMEIRO_ENVIO', 'status_alerta', a.status);
  end if;

  -- A 1ª mensagem precisa existir E ter saído de fato (DELIVERY_UNKNOWN = incerto -> fail-closed).
  select * into ini from comunicacao_mensagens where idempotency_key = ('wa:alerta:' || a.id::text || ':v1');
  if not found or ini.alerta_id is distinct from a.id or ini.status not in ('SENT', 'DELIVERED', 'READ') then
    return jsonb_build_object('acao', 'PRIMEIRA_MENSAGEM_NAO_ENVIADA');
  end if;

  select count(*) into n from comunicacao_mensagens
   where alerta_id = a.id and status in ('PROCESSING', 'SENDING', 'DELIVERY_UNKNOWN');
  if n > 0 then return jsonb_build_object('acao', 'ENTREGA_EM_CURSO'); end if;

  -- HABILITAÇÃO + DESTINATÁRIO (fail-closed) — MESMAS checagens da RPC NORMAL (088).
  select * into h from comunicacao_habilitacoes where organizacao_id = a.organizacao_id;
  if not found or h.habilitado is not true or h.timezone is null then
    return jsonb_build_object('acao', 'NAO_HABILITADA');
  end if;
  if not (a.tipo_alerta = any (h.tipos_permitidos)) then
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
                                     tipo, conteudo, idempotency_key, status, disponivel_em, expira_em, max_tentativas, metadados)
  values (a.id, a.organizacao_id, a.unidade_id, h.destinatario_contato_id, h.destinatario_perfil_id,
          a.tipo_alerta, p_conteudo, p_idempotency_key, 'SCHEDULED', p_disponivel_em, p_expira_em, p_max_tentativas,
          jsonb_build_object('proposito', 'reforco'))
  returning * into m;
  -- O status do ALERTA não muda aqui nem depois (ver o trigger, item 2): o reforço tem fonte de verdade própria.
  return jsonb_build_object('acao', 'CRIADA', 'mensagem_id', m.id);
end;
$$;
comment on function comunicacao_agendar_reforco_alerta(uuid, text, text, timestamptz, timestamptz, integer) is
  'Cria o ÚNICO reforço (wa:alerta:{id}:reforco:v1) de um alerta cujo 1º aviso (…:v1) já saiu (SENT/DELIVERED/READ). Idempotente pela chave. Recusa: ALERTA_INEXISTENTE, CHAVE_INVALIDA, ALERTA_SEM_PRIMEIRO_ENVIO, PRIMEIRA_MENSAGEM_NAO_ENVIADA, ENTREGA_EM_CURSO, NAO_HABILITADA, TIPO_NAO_PERMITIDO, SEM_DESTINATARIO, DESTINATARIO_INELEGIVEL. Não altera o status do alerta. Horário/cutoff/espaçamento/texto são do backend.';
revoke all on function comunicacao_agendar_reforco_alerta(uuid, text, text, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function comunicacao_agendar_reforco_alerta(uuid, text, text, timestamptz, timestamptz, integer) to service_role;

-- ---------------------------------------------------------------------
-- 2. TRIGGER da 088 — o REFORÇO não propaga status ao alerta
-- ---------------------------------------------------------------------
-- CREATE OR REPLACE do corpo; o trigger (trg_comunicacao_mensagens_sincroniza_alerta, WHEN da 088) NÃO é
-- recriado. Fora a guarda inicial, o corpo é IDÊNTICO ao da 088: mensagens sem propósito (inicial) mantêm
-- exatamente a semântica legada. Consequências para uma mensagem de reforço (SENT/DELIVERED/READ/FAILED/
-- CANCELLED-EXPIRADA): o alerta NÃO muda (não regride READ->SENT, não vira FAILED, não volta a DETECTED).
create or replace function comunicacao_mensagens_sincroniza_alerta()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.metadados->>'proposito' = 'reforco' then
    return null; -- fonte de verdade do reforço = a própria mensagem; a INICIAL é a dona de comunicacao_alertas.status
  end if;
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

notify pgrst, 'reload schema';
commit;
