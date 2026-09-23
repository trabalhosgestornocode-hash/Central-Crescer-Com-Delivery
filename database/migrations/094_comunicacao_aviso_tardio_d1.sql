-- =====================================================================
-- MIGRATION 094 — Comunicação WhatsApp: PRIMEIRO AVISO TARDIO D-1 (prazo final)
-- =====================================================================
-- Checkpoint H.4-B.2. Quando um D-1 que vence HOJE ainda está pendente depois da janela comercial e nenhum aviso
-- inicial saiu, o backend cria a PRIMEIRA mensagem na janela tardia (20:00–22:00). Não é reforço, não é retry:
--   * MESMA identidade lógica da 1ª mensagem: idempotency_key = wa:alerta:{id}:v1 (exatamente UMA inicial por alerta);
--   * metadados = {"proposito":"inicial","origem":"prazo_final_d1"} — a mensagem INICIAL continua dona de
--     comunicacao_alertas.status (a guarda do trigger da 092 só ignora proposito='reforco').
-- POR QUE RPC NOVA: comunicacao_agendar_mensagem_alerta (088) não recebe metadados, então não consegue gravar a origem
-- atomicamente sem alterar seu contrato. A 088 fica 100% INTACTA.
-- O QUE FAZ: serializa por alerta (FOR UPDATE) e aplica atomicamente: alerta existe, tipo dashboard_ifood_d1, chave
-- exata, nenhuma inicial existente, nenhuma entrega em curso, alerta DETECTED, habilitação e destinatário elegíveis
-- (mesmas checagens da 088). Cria a mensagem SCHEDULED e move o alerta a SCHEDULED na mesma transação.
-- NÃO FAZ: D-1/timezone/janela 20:00–22:00/cutoff/jitter/texto — responsabilidade do backend (mesmo padrão da 088/092).
-- Aditiva (sem tabela/coluna nova). PRÉ-REQUISITOS: 082, 088 (092 recomendada). TRANSACIONAL/IDEMPOTENTE.
-- ROLLBACK: 094_rollback.sql. SEGURANÇA: SECURITY INVOKER, search_path fixo, EXECUTE só para service_role.
-- =====================================================================
begin;

create or replace function comunicacao_agendar_aviso_tardio_d1(
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
  a comunicacao_alertas; m comunicacao_mensagens; h comunicacao_habilitacoes; c contatos_whatsapp; n integer;
begin
  select * into a from comunicacao_alertas where id = p_alerta_id for update;  -- serializa por alerta
  if not found then return jsonb_build_object('acao', 'ALERTA_INEXISTENTE'); end if;

  if a.tipo_alerta <> 'dashboard_ifood_d1' then return jsonb_build_object('acao', 'TIPO_NAO_SUPORTADO'); end if;

  -- MESMA identidade da 1ª mensagem: impossível uma 2ª identidade "tardia".
  if p_idempotency_key is distinct from ('wa:alerta:' || a.id::text || ':v1') then
    return jsonb_build_object('acao', 'CHAVE_INVALIDA');
  end if;

  select * into m from comunicacao_mensagens where idempotency_key = p_idempotency_key;
  if found then
    if m.alerta_id is distinct from a.id then return jsonb_build_object('acao', 'CHAVE_EM_USO'); end if;
    if m.status = 'CANCELLED' and m.erro = 'EXPIRADA' then
      return jsonb_build_object('acao', 'MENSAGEM_EXPIRADA', 'mensagem_id', m.id); -- expirou: NUNCA recria (nem amanhã)
    end if;
    return jsonb_build_object('acao', 'JA_EXISTIA', 'mensagem_id', m.id, 'status', m.status);
  end if;

  -- Nenhuma OUTRA mensagem inicial (de qualquer chave) e nenhuma entrega em curso/incerta para este alerta.
  select count(*) into n from comunicacao_mensagens
   where alerta_id = a.id and coalesce(metadados->>'proposito', 'inicial') = 'inicial';
  if n > 0 then return jsonb_build_object('acao', 'INICIAL_JA_EXISTE'); end if;
  select count(*) into n from comunicacao_mensagens
   where alerta_id = a.id and status in ('PROCESSING', 'SENDING', 'DELIVERY_UNKNOWN');
  if n > 0 then return jsonb_build_object('acao', 'ENTREGA_EM_CURSO'); end if;

  if a.status <> 'DETECTED' then
    return jsonb_build_object('acao', 'ALERTA_NAO_DETECTED', 'status_alerta', a.status);
  end if;

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
          jsonb_build_object('proposito', 'inicial', 'origem', 'prazo_final_d1'))
  returning * into m;
  update comunicacao_alertas set status = 'SCHEDULED' where id = a.id;
  return jsonb_build_object('acao', 'CRIADA', 'mensagem_id', m.id);
end;
$$;
comment on function comunicacao_agendar_aviso_tardio_d1(uuid, text, text, timestamptz, timestamptz, integer) is
  'Cria a PRIMEIRA mensagem (wa:alerta:{id}:v1, proposito=inicial, origem=prazo_final_d1) de um alerta dashboard_ifood_d1 DETECTED sem nenhuma inicial. Atômica e idempotente pela chave; exatamente uma inicial por alerta (normal OU tardia). Recusa: ALERTA_INEXISTENTE, TIPO_NAO_SUPORTADO, CHAVE_INVALIDA, CHAVE_EM_USO, MENSAGEM_EXPIRADA, INICIAL_JA_EXISTE, ENTREGA_EM_CURSO, ALERTA_NAO_DETECTED, NAO_HABILITADA, TIPO_NAO_PERMITIDO, SEM_DESTINATARIO, DESTINATARIO_INELEGIVEL. D-1/horário/texto são do backend.';
revoke all on function comunicacao_agendar_aviso_tardio_d1(uuid, text, text, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function comunicacao_agendar_aviso_tardio_d1(uuid, text, text, timestamptz, timestamptz, integer) to service_role;

notify pgrst, 'reload schema';
commit;
