-- =====================================================================
-- MIGRATION 095 — Comunicação WhatsApp: persistência de confirmações de entrega do provider (H.4-B.4)
-- =====================================================================
-- CONTEXTO. O 1º envio real gravou SENT (= `socket.sendMessage()` resolveu, o Baileys terminou de escrever
-- o stanza no socket) mas nada persistia DELIVERED/READ: `registrarStatusProvider` do backend era um stub.
--
-- O QUE FAZ (aditivo; sem coluna nova, sem mudança de enum/CHECK, sem tocar em trigger):
--   1. RPC comunicacao_registrar_status_provider — recebe uma confirmação do provider (SERVER_ACK,
--      DELIVERED, READ ou PROVIDER_ERROR) correlacionada por (organizacao_id, provider_message_id) e a
--      aplica de forma IDEMPOTENTE e MONOTÔNICA, numa única instrução atômica sob `for update`:
--        SENT -> DELIVERED -> READ          (SENT -> READ permitido: READ implica entrega)
--        nenhuma regressão (READ->DELIVERED, DELIVERED->SENT, READ->SENT) e evento repetido = no-op.
--      Só mexe em mensagens de saída em SENT/DELIVERED/READ. Qualquer outro estado (SENDING, SCHEDULED,
--      DELIVERY_UNKNOWN, FAILED, CANCELLED, BLOCKED…) NUNCA é alterado por um receipt: DELIVERY_UNKNOWN só
--      sai pela reconciliação humana (088) ou pela confirmação tardia do MESMO attempt (087).
--      SERVER_ACK e PROVIDER_ERROR NÃO mudam `status`: ficam em metadados.provider_ack / provider_erro
--      (evidência para reconstruir "servidor aceitou?" sem inventar valor de enum).
--   2. Índice parcial (organizacao_id, provider_message_id) — a correlação é o caminho quente de cada receipt.
--
-- SEMÂNTICA (o enum NÃO foi renomeado): SENT = enviado/aceito pelo provider LOCAL (sendMessage resolveu);
-- DELIVERED = confirmação de entrega do WhatsApp; READ = confirmação de leitura.
--
-- ALERTA. Esta função só faz UPDATE de `comunicacao_mensagens.status`; quem propaga ao alerta é o trigger
-- existente da 088/092 (após update of status): não sobrescreve RESOLVED/CANCELLED e NÃO propaga para
-- mensagem com metadados.proposito='reforco'. Um receipt tardio nunca reabre pendência de negócio.
--
-- PRÉ-REQUISITOS: 082, 087, 088, 092. TRANSACIONAL/IDEMPOTENTE. ROLLBACK: 095_rollback.sql.
-- SEGURANÇA: SECURITY INVOKER, search_path fixo, EXECUTE só para service_role. Nenhuma organização é habilitada.
-- =====================================================================
begin;

create index if not exists idx_comunicacao_mensagens_provider_msg
  on comunicacao_mensagens (organizacao_id, provider_message_id)
  where provider_message_id is not null;

create or replace function comunicacao_registrar_status_provider(
  p_organizacao_id uuid,
  p_provider_message_id text,
  p_status text,
  p_ocorrido_em timestamptz default null,
  p_erro_codigo text default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  m comunicacao_mensagens%rowtype;
  v_n integer;
  v_ts timestamptz;
  v_rank_atual integer;
  v_rank_novo integer;
  v_status_novo text;
begin
  if p_organizacao_id is null
     or p_provider_message_id is null or btrim(p_provider_message_id) = '' or length(p_provider_message_id) > 128
     or p_status is null or p_status not in ('SERVER_ACK', 'DELIVERED', 'READ', 'PROVIDER_ERROR') then
    raise exception 'STATUS_PROVIDER_INVALIDO' using errcode = '22023';
  end if;
  if p_status = 'PROVIDER_ERROR' and (p_erro_codigo is null or p_erro_codigo !~ '^[A-Za-z0-9_.:-]{1,40}$') then
    raise exception 'STATUS_PROVIDER_INVALIDO' using errcode = '22023';
  end if;

  select count(*) into v_n
    from comunicacao_mensagens x
   where x.organizacao_id = p_organizacao_id and x.provider_message_id = p_provider_message_id and x.direcao = 'saida';
  if v_n = 0 then
    return jsonb_build_object('resultado', 'NAO_ENCONTRADA');
  elsif v_n > 1 then
    return jsonb_build_object('resultado', 'AMBIGUA');
  end if;

  select * into m
    from comunicacao_mensagens x
   where x.organizacao_id = p_organizacao_id and x.provider_message_id = p_provider_message_id and x.direcao = 'saida'
   for update;
  if not found then
    return jsonb_build_object('resultado', 'NAO_ENCONTRADA');
  end if;

  if m.status not in ('SENT', 'DELIVERED', 'READ') then
    return jsonb_build_object('resultado', 'ESTADO_NAO_ELEGIVEL', 'status_atual', m.status);
  end if;

  -- relógio: nunca no futuro; nunca antes do próprio envio (o enviado_em é gravado pelo backend DEPOIS do sendMessage,
  -- então um receipt rápido pode chegar "antes" dele — a linha do tempo precisa continuar coerente).
  v_ts := least(coalesce(p_ocorrido_em, now()), now());
  if m.enviado_em is not null then v_ts := greatest(v_ts, m.enviado_em); end if;

  if p_status = 'SERVER_ACK' then
    if m.metadados #>> '{provider_ack,servidor_em}' is not null then
      return jsonb_build_object('resultado', 'DUPLICADO', 'status_atual', m.status);
    end if;
    update comunicacao_mensagens
       set metadados = jsonb_set(metadados, '{provider_ack}', coalesce(metadados->'provider_ack', '{}'::jsonb)
                                                              || jsonb_build_object('servidor_em', v_ts), true),
           updated_at = now()
     where id = m.id;
    return jsonb_build_object('resultado', 'ACK_REGISTRADO', 'status_atual', m.status);
  end if;

  if p_status = 'PROVIDER_ERROR' then
    -- rejeição do provider NÃO muda o status (decisão de produto pendente): fica só como evidência.
    if m.metadados #>> '{provider_erro,codigo}' is not null then
      return jsonb_build_object('resultado', 'DUPLICADO', 'status_atual', m.status);
    end if;
    update comunicacao_mensagens
       set metadados = jsonb_set(metadados, '{provider_erro}', jsonb_build_object('codigo', p_erro_codigo, 'em', v_ts), true),
           updated_at = now()
     where id = m.id;
    return jsonb_build_object('resultado', 'ERRO_REGISTRADO', 'status_atual', m.status);
  end if;

  -- DELIVERED / READ — máquina monotônica
  v_rank_atual := case m.status when 'SENT' then 1 when 'DELIVERED' then 2 else 3 end;
  v_rank_novo  := case p_status when 'DELIVERED' then 2 else 3 end;
  v_status_novo := case when v_rank_novo > v_rank_atual then p_status else m.status end;

  update comunicacao_mensagens
     set status = v_status_novo,
         -- READ implica que houve entrega: preenche entregue_em mesmo sem DELIVERED intermediário
         entregue_em = coalesce(entregue_em, v_ts),
         lido_em = case when p_status = 'READ' then coalesce(lido_em, v_ts) else lido_em end,
         updated_at = now()
   where id = m.id
     and (v_rank_novo > v_rank_atual
          or entregue_em is null
          or (p_status = 'READ' and lido_em is null));

  if v_rank_novo > v_rank_atual then
    return jsonb_build_object('resultado', 'APLICADO', 'status_anterior', m.status, 'status_atual', v_status_novo);
  end if;
  return jsonb_build_object('resultado', 'DUPLICADO', 'status_atual', m.status);
end;
$$;

comment on function comunicacao_registrar_status_provider(uuid, text, text, timestamptz, text) is
  'Confirmação do provider (SERVER_ACK|DELIVERED|READ|PROVIDER_ERROR) por (organizacao_id, provider_message_id). Idempotente e monotônica: SENT->DELIVERED->READ (SENT->READ permitido, READ preenche entregue_em), sem regressão. Só altera SENT/DELIVERED/READ de saída; SERVER_ACK e PROVIDER_ERROR ficam em metadados (não mudam status). Resultados: NAO_ENCONTRADA, AMBIGUA, ESTADO_NAO_ELEGIVEL, APLICADO, DUPLICADO, ACK_REGISTRADO, ERRO_REGISTRADO. A propagação ao alerta é do trigger (088/092): não reabre RESOLVED/CANCELLED e ignora reforço.';

revoke all on function comunicacao_registrar_status_provider(uuid, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function comunicacao_registrar_status_provider(uuid, text, text, timestamptz, text) to service_role;

notify pgrst, 'reload schema';
commit;
