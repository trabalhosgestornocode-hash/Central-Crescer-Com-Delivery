-- =====================================================================
-- MIGRATION 091 — Comunicação WhatsApp: fundação multi-estágio D-1 crítico
-- (Checkpoint H.4-A.6 — auditoria completa em H.4-A.4/H.4-A.5)
-- =====================================================================
-- ⚠️  NÃO APLICAR EM PRODUÇÃO SEM APROVAÇÃO EXPLÍCITA. Este arquivo é
--     entregue como IMPLEMENTAÇÃO LOCAL, ainda não aplicada em nenhum
--     ambiente (nem teste, nem produção) neste checkpoint.
--
-- PRINCÍPIO: 1 alerta lógico pode ter até 3 mensagens ao longo do dia —
-- NORMAL, CRITICO_1, CRITICO_FINAL — mas continua sendo A MESMA pendência
-- de negócio. `comunicacao_alertas.status` passa a refletir o ESTÁGIO DE
-- MAIOR PRIORIDADE já criado para aquele alerta, nunca o último evento
-- cronológico (um receipt tardio de um estágio antigo nunca pode regredir
-- ou sobrescrever o que um estágio mais novo já determinou).
--
-- O QUE FAZ (aditivo; a ÚNICA função existente alterada é
-- comunicacao_mensagens_sincroniza_alerta — só o CORPO, mesma assinatura,
-- MESMO TRIGGER que já a chama; comunicacao_agendar_mensagem_alerta,
-- usada pelo fluxo NORMAL, fica 100% intacta — ver item 3 do checkpoint):
--   1. comunicacao_estagio_prioridade(text) — fonte ÚNICA de prioridade de
--      estágio (NORMAL=0 < critico_1=1 < critico_final=2), reaproveitada
--      pelo trigger E pela nova função de status-por-mensagem — evita ter
--      a mesma regra duplicada/divergente em dois lugares.
--   2. comunicacao_mensagens_sincroniza_alerta() — mesmo trigger de 088,
--      corpo agora com o gate de prioridade acima. NÃO muda o WHEN do
--      trigger (continua só SENT/DELIVERED/READ/FAILED ou
--      CANCELLED+EXPIRADA) — CANCELLED por SUPERSEDED_BY_* nunca dispara
--      esta função, de propósito: quem supersede já assume o controle do
--      alerta na própria transação de criação (ver função 4).
--   3. comunicacao_atualizar_status_alerta_por_mensagem(uuid, text) — nova
--      função que centraliza no banco a MESMA regra de prioridade para o
--      caminho de escrita usado pelo JS (hoje: BLOCKED por veto de
--      política). Substitui, só nesse call-site, o UPDATE direto que
--      existia antes (ver alertasRepo.atualizarStatusAlerta, que
--      permanece intacta para os demais usos/testes).
--   4. comunicacao_agendar_mensagem_critica(...) — nova RPC, só para
--      critico_1/critico_final, só para tipo_alerta=dashboard_ifood_d1.
--      Reaproveita as MESMAS checagens de habilitação/destinatário da
--      função normal (nada de novo ali), acrescenta: validação de
--      estágio, verificação de que nenhum estágio de prioridade IGUAL OU
--      MAIOR já existe, bloqueio fail-closed se existir mensagem do
--      alerta em PROCESSING/SENDING/DELIVERY_UNKNOWN, e supersede
--      atômico (CANCELLED, nunca DELETE) de uma mensagem SCHEDULED de
--      estágio inferior antes de inserir a nova.
--
-- O QUE ESTA MIGRATION NÃO FAZ (de propósito — ver H.4-A.5/H.4-A.6):
--   * NÃO calcula prazoFinalHoje, timezone, janela 19:30-20:00/22:15-22:45
--     nem o texto da mensagem — tudo isso é responsabilidade do backend
--     (administrativo.status.js / comunicacao.horarioCritico.js /
--     comunicacao.template.js), que passa o resultado já pronto (mesmo
--     padrão que a função NORMAL já usa hoje).
--   * NÃO cria coluna nova, NÃO cria tabela nova, NÃO faz backfill —
--     `metadados` (jsonb) já existente carrega `estagio`.
--   * NÃO toca comunicacao_reservar_envio, comunicacao_claim_mensagens,
--     comunicacao_cancelar_expiradas, comunicacao_reconciliar_entrega —
--     mensagens críticas passam pelo MESMO fluxo claim -> policy ->
--     reservar -> JIT -> provider que a mensagem normal já usa hoje.
--   * NÃO expõe UI, preview crítico nem "próximo alerta" — H.4-A.6 é
--     só a fundação SQL.
--
-- VALORES CANÔNICOS de comunicacao_mensagens.metadados->>'estagio':
--   ausente/null -> NORMAL (compatibilidade histórica automática, sem
--   backfill: nenhuma mensagem existente precisa ser tocada);
--   'critico_1'; 'critico_final'. Nenhum outro valor é aceito pela nova RPC.
--
-- PRÉ-REQUISITOS: 082, 087, 088 aplicadas. TRANSACIONAL/IDEMPOTENTE.
-- ROLLBACK: 091_rollback.sql (restaura o corpo EXATO do trigger da 088,
-- remove só o que esta migration acrescenta).
-- SEGURANÇA: SECURITY INVOKER, search_path fixo, EXECUTE só para service_role.
-- Nenhuma organização é habilitada por esta migration.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. PRIORIDADE DE ESTÁGIO — fonte única (trigger e função de status usam)
-- ---------------------------------------------------------------------
create or replace function comunicacao_estagio_prioridade(p_estagio text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case coalesce(p_estagio, 'normal')
    when 'normal' then 0
    when 'critico_1' then 1
    when 'critico_final' then 2
    -- estágio desconhecido nunca "vence" nada — nunca controla o agregado.
    else -1
  end;
$$;
comment on function comunicacao_estagio_prioridade(text) is
  'Fonte ÚNICA da prioridade de estágio de comunicacao_mensagens.metadados->>''estagio'' (NORMAL=0 < critico_1=1 < critico_final=2; ausente=NORMAL). Reutilizada pelo trigger de sincronização e por comunicacao_atualizar_status_alerta_por_mensagem — nunca duplicar este CASE em outro lugar.';
revoke all on function comunicacao_estagio_prioridade(text) from public, anon, authenticated;
grant execute on function comunicacao_estagio_prioridade(text) to service_role;

-- ---------------------------------------------------------------------
-- 2. TRIGGER STAGE-AWARE — mesma assinatura, mesmo trigger, corpo novo
-- ---------------------------------------------------------------------
-- O WHEN do trigger (definido em 088, NÃO recriado aqui) continua:
--   old.status IS DISTINCT FROM new.status AND new.alerta_id IS NOT NULL
--   AND (new.status IN ('SENT','DELIVERED','READ','FAILED')
--        OR (new.status = 'CANCELLED' AND new.erro = 'EXPIRADA'))
-- CREATE OR REPLACE de uma função apontada por um trigger existente não
-- exige recriar o trigger (mesmo nome, mesma assinatura, mesmo retorno).
create or replace function comunicacao_mensagens_sincroniza_alerta()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_prioridade_nova integer; v_prioridade_max integer;
begin
  v_prioridade_nova := comunicacao_estagio_prioridade(new.metadados->>'estagio');
  select max(comunicacao_estagio_prioridade(metadados->>'estagio'))
    into v_prioridade_max
    from comunicacao_mensagens
   where alerta_id = new.alerta_id;

  -- Só o estágio de MAIOR prioridade já existente para este alerta pode
  -- controlar o agregado (H.4-A.5, itens 3-4-5-6): um evento tardio
  -- (out-of-order) de um estágio mais antigo nunca sobrescreve nem regride
  -- o que um estágio mais novo já determinou. `new` já está incluído na
  -- MAX acima (UPDATE já aplicado na mesma transação) — se `new` não é o
  -- próprio máximo, ele perdeu a corrida e este UPDATE é ignorado.
  if v_prioridade_nova < v_prioridade_max then
    return null;
  end if;

  if new.status = 'CANCELLED' then
    -- Só chega aqui com erro = 'EXPIRADA' (o WHEN do trigger já filtra
    -- isso) — CANCELLED por SUPERSEDED_BY_* nunca dispara esta função, de
    -- propósito (H.4-A.5, item 17): quem supersede (comunicacao_agendar_
    -- mensagem_critica) já assume o controle do alerta na própria
    -- transação de criação, sem passar por aqui.
    update comunicacao_alertas set status = 'DETECTED', updated_at = now()
     where id = new.alerta_id and status in ('SCHEDULED', 'PROCESSING');
  else
    update comunicacao_alertas set status = new.status, updated_at = now()
     where id = new.alerta_id and status not in ('RESOLVED', 'CANCELLED') and status <> new.status;
  end if;
  return null;
end;
$$;
comment on function comunicacao_mensagens_sincroniza_alerta() is
  'Trigger AFTER UPDATE OF status em comunicacao_mensagens (091: stage-aware). Só o estágio de MAIOR prioridade já existente para o alerta pode escrever comunicacao_alertas.status — eventos fora de ordem de um estágio mais antigo são ignorados. CANCELLED só reabre o alerta para DETECTED quando erro=EXPIRADA E nenhum estágio mais novo existe; SUPERSEDED_BY_* nunca reabre (nunca dispara esta função). Nunca sobrescreve RESOLVED/CANCELLED.';

-- ---------------------------------------------------------------------
-- 3. STATUS DO ALERTA A PARTIR DE UMA MENSAGEM (caminho usado pelo JS)
-- ---------------------------------------------------------------------
-- Centraliza no banco a MESMA regra de prioridade do trigger, para o
-- único call-site de aplicação que hoje escreve comunicacao_alertas.status
-- fora do trigger sem saber de estágio (H.4-A.5, itens 23-24): o veto de
-- política (BLOCKED) de uma mensagem específica. Substitui, só ali, o
-- UPDATE direto — alertasRepo.atualizarStatusAlerta(alertaId, status)
-- continua existindo, intacta, para os demais usos (inclusive os testes
-- que semeiam status de alerta diretamente, sem mensagem nenhuma).
create or replace function comunicacao_atualizar_status_alerta_por_mensagem(p_mensagem_id uuid, p_status text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare m comunicacao_mensagens; v_prioridade_msg integer; v_prioridade_max integer; n integer;
begin
  select * into m from comunicacao_mensagens where id = p_mensagem_id;
  if not found then return jsonb_build_object('acao', 'MENSAGEM_INEXISTENTE'); end if;
  if m.alerta_id is null then return jsonb_build_object('acao', 'SEM_ALERTA'); end if;

  v_prioridade_msg := comunicacao_estagio_prioridade(m.metadados->>'estagio');
  select max(comunicacao_estagio_prioridade(metadados->>'estagio'))
    into v_prioridade_max
    from comunicacao_mensagens
   where alerta_id = m.alerta_id;

  if v_prioridade_msg < v_prioridade_max then
    return jsonb_build_object('acao', 'IGNORADO_ESTAGIO_SUPERADO');
  end if;

  update comunicacao_alertas set status = p_status, updated_at = now()
   where id = m.alerta_id and status not in ('RESOLVED', 'CANCELLED') and status <> p_status;
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('acao', 'NAO_ATUALIZADO', 'alerta_id', m.alerta_id); end if;
  return jsonb_build_object('acao', 'ATUALIZADO', 'alerta_id', m.alerta_id);
end;
$$;
comment on function comunicacao_atualizar_status_alerta_por_mensagem(uuid, text) is
  'Grava comunicacao_alertas.status a partir de UMA mensagem específica, só se o estágio dela ainda for o de maior prioridade para o alerta (mesma regra de comunicacao_mensagens_sincroniza_alerta, sem duplicar o CASE — reaproveita comunicacao_estagio_prioridade). Nunca sobrescreve RESOLVED/CANCELLED.';
revoke all on function comunicacao_atualizar_status_alerta_por_mensagem(uuid, text) from public, anon, authenticated;
grant execute on function comunicacao_atualizar_status_alerta_por_mensagem(uuid, text) to service_role;

-- ---------------------------------------------------------------------
-- 4. NOVA RPC — agendamento de estágio crítico (critico_1 / critico_final)
-- ---------------------------------------------------------------------
create or replace function comunicacao_agendar_mensagem_critica(
  p_alerta_id uuid, p_estagio text, p_conteudo text,
  p_idempotency_key text, p_disponivel_em timestamptz, p_expira_em timestamptz,
  p_max_tentativas integer default 5
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  a comunicacao_alertas; m comunicacao_mensagens; h comunicacao_habilitacoes; c contatos_whatsapp;
  v_prioridade_nova integer; v_prioridade_max integer; v_superado comunicacao_mensagens; n integer;
begin
  -- Item 10: só os dois estágios críticos conhecidos — qualquer outro valor é recusado.
  if p_estagio not in ('critico_1', 'critico_final') then
    return jsonb_build_object('acao', 'ESTAGIO_INVALIDO');
  end if;
  v_prioridade_nova := comunicacao_estagio_prioridade(p_estagio);

  select * into a from comunicacao_alertas where id = p_alerta_id for update;  -- serializa por alerta
  if not found then return jsonb_build_object('acao', 'ALERTA_INEXISTENTE'); end if;

  -- Item 11: mecanismo NÃO genérico — só dashboard_ifood_d1 nesta fase.
  if a.tipo_alerta <> 'dashboard_ifood_d1' then
    return jsonb_build_object('acao', 'TIPO_NAO_SUPORTADO');
  end if;

  -- Idempotência (item 12-13): mesma chave -> mesma mensagem, nunca duplica.
  select * into m from comunicacao_mensagens where idempotency_key = p_idempotency_key;
  if found then
    if m.alerta_id is distinct from a.id then return jsonb_build_object('acao', 'CHAVE_EM_USO'); end if;
    return jsonb_build_object('acao', 'JA_EXISTIA', 'mensagem_id', m.id, 'status', m.status);
  end if;

  -- Item 19-20: entrega em curso ou incerta para ESTE alerta (qualquer estágio) -> nada novo
  -- até reconciliar. PROCESSING entra aqui de propósito (H.4-A.5/A.6, item 14/19): um worker
  -- pode já ter reivindicado a mensagem e estar prestes a chamar o provider — cancelar por
  -- baixo dele seria uma corrida real, não uma simples troca de linha SCHEDULED.
  select count(*) into n from comunicacao_mensagens
   where alerta_id = a.id and status in ('PROCESSING', 'SENDING', 'DELIVERY_UNKNOWN');
  if n > 0 then return jsonb_build_object('acao', 'ENTREGA_EM_CURSO'); end if;

  -- Fail-closed contra chamada fora de ordem: se já existe mensagem de estágio IGUAL OU MAIOR
  -- para este alerta, este pedido está atrasado/duplicado — nunca cria um estágio "para trás".
  select max(comunicacao_estagio_prioridade(metadados->>'estagio'))
    into v_prioridade_max
    from comunicacao_mensagens
   where alerta_id = a.id;
  if v_prioridade_max is not null and v_prioridade_nova <= v_prioridade_max then
    return jsonb_build_object('acao', 'ESTAGIO_JA_SUPERADO');
  end if;

  -- HABILITAÇÃO + DESTINATÁRIO (fail-closed) — MESMAS checagens da função NORMAL,
  -- nada reimplementado com regra diferente.
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

  -- SUPERSEDE (itens 15-16-17): a mensagem SCHEDULED de estágio inferior (se existir) é
  -- cancelada NA MESMA transação — nunca DELETE, nunca SENDING/SENT/DELIVERED/READ/
  -- DELIVERY_UNKNOWN (a checagem ENTREGA_EM_CURSO acima já teria barrado antes de chegar
  -- aqui se algo estivesse em voo; só sobra SCHEDULED/estados terminais para superar).
  update comunicacao_mensagens
     set status = 'CANCELLED', erro = 'SUPERSEDED_BY_' || upper(p_estagio), updated_at = now()
   where alerta_id = a.id and status = 'SCHEDULED'
     and comunicacao_estagio_prioridade(metadados->>'estagio') < v_prioridade_nova
  returning * into v_superado;

  insert into comunicacao_mensagens (alerta_id, organizacao_id, unidade_id, contato_id, destinatario_perfil_id,
                                     tipo, conteudo, idempotency_key, status, disponivel_em, expira_em, max_tentativas, metadados)
  values (a.id, a.organizacao_id, a.unidade_id, h.destinatario_contato_id, h.destinatario_perfil_id,
          a.tipo_alerta, p_conteudo, p_idempotency_key, 'SCHEDULED', p_disponivel_em, p_expira_em, p_max_tentativas,
          jsonb_build_object('estagio', p_estagio))
  returning * into m;

  -- O novo estágio assume o controle do alerta diretamente (mesmo padrão da função NORMAL) —
  -- não depende do trigger, que nunca dispara para SUPERSEDED (item 17).
  update comunicacao_alertas set status = 'SCHEDULED', updated_at = now() where id = a.id;

  return jsonb_build_object('acao', 'CRIADA', 'mensagem_id', m.id, 'supersedeu', (v_superado.id is not null));
end;
$$;
comment on function comunicacao_agendar_mensagem_critica(uuid, text, text, text, timestamptz, timestamptz, integer) is
  'Agenda um estágio CRÍTICO (critico_1|critico_final) para um alerta dashboard_ifood_d1 já DETECTED ou com estágio inferior ativo. Reaproveita as checagens de habilitação/destinatário da função normal. Recusa (fail-closed): ESTAGIO_INVALIDO, TIPO_NAO_SUPORTADO, ENTREGA_EM_CURSO (PROCESSING/SENDING/DELIVERY_UNKNOWN de qualquer estágio), ESTAGIO_JA_SUPERADO (chamada fora de ordem), NAO_HABILITADA, TIPO_NAO_PERMITIDO, SEM_DESTINATARIO, DESTINATARIO_INELEGIVEL. Supersede (CANCELLED, nunca DELETE) a mensagem SCHEDULED de estágio inferior na MESMA transação. timezone/janela/prazoFinalHoje/texto são responsabilidade do backend (não recalculados aqui).';
revoke all on function comunicacao_agendar_mensagem_critica(uuid, text, text, text, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function comunicacao_agendar_mensagem_critica(uuid, text, text, text, timestamptz, timestamptz, integer) to service_role;

notify pgrst, 'reload schema';
commit;
