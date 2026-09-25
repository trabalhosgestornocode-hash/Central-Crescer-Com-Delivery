-- Evolução da 098 (conceito separado: reconciliação de efeitos externos incertos). Não altera modo, habilitações nem outbox.
-- A decisão CONCLUIDO/ABORTADO/AINDA_INCERTO é tomada AQUI, sob FOR UPDATE, a partir de evidência (snapshot da sessão gravado no PREPARAR +
-- estado vivo do Gateway informado pelo backend). Nenhum parâmetro permite "forçar sucesso".
begin;
alter table whatsapp_identidade
  add column if not exists efeito_auth_session_id uuid,
  add column if not exists efeito_atualizado_em timestamptz,
  add column if not exists efeito_incerto_desde timestamptz,
  add column if not exists efeito_verificado_em timestamptz,
  add column if not exists efeito_verificacoes integer not null default 0,
  add column if not exists efeito_ultimo_resultado text;
alter table whatsapp_identidade drop constraint if exists whatsapp_identidade_efeito_meta_valida;
alter table whatsapp_identidade add constraint whatsapp_identidade_efeito_meta_valida check (
  efeito_token is not null or (efeito_auth_session_id is null and efeito_atualizado_em is null and efeito_incerto_desde is null));

-- Mesma assinatura da 098. Novidades: snapshot da sessão no PREPARAR, carimbo de tempo por transição e a fase FALHA_DETERMINISTICA
-- (o Gateway prova que falhou ANTES de qualquer efeito: EXECUTANDO -> livre, sem reconciliação).
create or replace function whatsapp_operacao_efeito(
 p_organizacao_id uuid,p_provider_instance_id text,p_operacao_id uuid,p_token uuid,p_acao text,p_fase text
) returns boolean language plpgsql set search_path=public as $$
declare i whatsapp_identidade%rowtype; v_sessao uuid;
begin
 select * into i from whatsapp_identidade where organizacao_id=p_organizacao_id
 and provider_instance_id=p_provider_instance_id for update;
 if not found or i.operacao_id is distinct from p_operacao_id or p_operacao_id is null or p_token is null then return false; end if;
 if p_fase='PREPARAR' then
  if i.efeito_token is not null or i.operacao_expira_em<=clock_timestamp() or
     p_acao is null or p_acao not in ('CONECTAR','ENCERRAR','DESCONECTAR','RESET') then return false; end if;
  select auth_session_id into v_sessao from whatsapp_conexoes
   where organizacao_id=p_organizacao_id and provider_instance_id=p_provider_instance_id;
  update whatsapp_identidade set efeito_token=p_token,efeito_acao=p_acao,efeito_estado='PENDENTE',
   efeito_auth_session_id=v_sessao,efeito_atualizado_em=clock_timestamp(),efeito_incerto_desde=null,
   efeito_verificado_em=null,efeito_verificacoes=0,efeito_ultimo_resultado=null
  where organizacao_id=p_organizacao_id and provider_instance_id=p_provider_instance_id;
 elsif i.efeito_token is distinct from p_token or i.efeito_acao is distinct from p_acao then return false;
 elsif p_fase='CONSUMIR' then
  if i.efeito_estado<>'PENDENTE' or i.operacao_expira_em<=clock_timestamp() then return false; end if;
  update whatsapp_identidade set efeito_estado='EXECUTANDO',efeito_atualizado_em=clock_timestamp()
  where organizacao_id=p_organizacao_id and provider_instance_id=p_provider_instance_id;
 elsif (p_fase='CONCLUIR' and i.efeito_estado in ('EXECUTANDO','INCERTO'))
    or (p_fase='ABORTAR' and i.efeito_estado='PENDENTE')
    or (p_fase='FALHA_DETERMINISTICA' and i.efeito_estado='EXECUTANDO') then
  -- ABORTAR revoga antes do consumo; FALHA_DETERMINISTICA: o Gateway declarou falha anterior ao efeito externo.
  update whatsapp_identidade set efeito_token=null,efeito_acao=null,efeito_estado=null,
   efeito_auth_session_id=null,efeito_atualizado_em=null,efeito_incerto_desde=null
  where organizacao_id=p_organizacao_id and provider_instance_id=p_provider_instance_id;
 elsif p_fase='INCERTO' and i.efeito_estado='EXECUTANDO' then
  update whatsapp_identidade set efeito_estado='INCERTO',efeito_atualizado_em=clock_timestamp(),efeito_incerto_desde=clock_timestamp()
  where organizacao_id=p_organizacao_id and provider_instance_id=p_provider_instance_id;
 else return false;
 end if;
 return true;
end $$;

-- Reconciliação oficial. p_gateway_* vêm do backend (estado vivo consultado agora). Retorna a decisão e o motivo.
create or replace function whatsapp_operacao_reconciliar(
 p_organizacao_id uuid,p_provider_instance_id text,p_operacao_id uuid,
 p_gateway_ok boolean,p_gateway_estado text,p_gateway_auth_session_id uuid,p_por uuid,p_janela_segundos integer default 30
) returns table(decisao text,motivo text,acao text)
language plpgsql set search_path=public as $$
declare i whatsapp_identidade%rowtype; c whatsapp_conexoes%rowtype; v_dec text; v_mot text; v_acao text;
 v_idade double precision; v_fresco boolean; v_janela integer:=greatest(coalesce(p_janela_segundos,30),0);
begin
 select * into i from whatsapp_identidade where organizacao_id=p_organizacao_id
 and provider_instance_id=p_provider_instance_id for update;
 if not found or i.efeito_token is null then return query select 'JA_RESOLVIDO','sem_efeito_pendente',null::text; return; end if;
 if p_operacao_id is null or i.operacao_id is distinct from p_operacao_id then
  return query select 'RECUSADO','operacao_diferente',null::text; return; end if;
 v_acao:=i.efeito_acao;
 v_idade:=extract(epoch from clock_timestamp()-coalesce(i.efeito_atualizado_em,i.operacao_expira_em));
 select * into c from whatsapp_conexoes where organizacao_id=p_organizacao_id and provider_instance_id=p_provider_instance_id;
 v_fresco:=found and c.status='CONNECTED' and c.last_seen_at is not null and c.last_seen_at>clock_timestamp()-interval '2 minutes'
  and i.efeito_auth_session_id is not null and c.auth_session_id is not distinct from i.efeito_auth_session_id;

 if i.efeito_estado='PENDENTE' then
  -- Token nunca consumido: revogá-lo prova que não houve efeito (um CONSUMIR tardio será recusado).
  if v_idade>=v_janela then v_dec:='ABORTADO'; v_mot:='token_nunca_consumido'; else v_dec:='AINDA_INCERTO'; v_mot:='aguardando_consumo'; end if;
 elsif v_idade<v_janela then v_dec:='AINDA_INCERTO'; v_mot:='janela_de_estabilizacao';
 elsif p_gateway_ok is not true or p_gateway_estado is null then v_dec:='AINDA_INCERTO'; v_mot:='gateway_indisponivel';
 elsif v_acao='DESCONECTAR' then
  if p_gateway_estado<>'CONNECTED' then v_dec:='CONCLUIDO'; v_mot:='sessao_encerrada';
  elsif i.efeito_auth_session_id is not null and p_gateway_auth_session_id is not null and p_gateway_auth_session_id<>i.efeito_auth_session_id then v_dec:='CONCLUIDO'; v_mot:='sessao_substituida';
  elsif v_fresco and p_gateway_auth_session_id=i.efeito_auth_session_id then v_dec:='ABORTADO'; v_mot:='sessao_original_ativa';
  else v_dec:='AINDA_INCERTO'; v_mot:='evidencia_contraditoria'; end if;
 elsif v_acao='RESET' then
  if i.efeito_auth_session_id is not null and p_gateway_auth_session_id is distinct from i.efeito_auth_session_id then v_dec:='CONCLUIDO'; v_mot:='sessao_diferente';
  elsif v_fresco and p_gateway_estado='CONNECTED' and p_gateway_auth_session_id=i.efeito_auth_session_id then v_dec:='ABORTADO'; v_mot:='sessao_original_ativa';
  else v_dec:='AINDA_INCERTO'; v_mot:='evidencia_contraditoria'; end if;
 elsif v_acao='CONECTAR' then
  if p_gateway_estado in ('CONNECTED','CONNECTING','WAITING_QR','RECONNECTING') then v_dec:='CONCLUIDO'; v_mot:='pareamento_ativo';
  elsif p_gateway_estado='DISCONNECTED' then v_dec:='ABORTADO'; v_mot:='gateway_desconectado';
  else v_dec:='AINDA_INCERTO'; v_mot:='estado_gateway_indeterminado'; end if;
 elsif v_acao='ENCERRAR' then
  if p_gateway_estado='DISCONNECTED' then v_dec:='CONCLUIDO'; v_mot:='gateway_desconectado';
  elsif p_gateway_estado in ('CONNECTED','CONNECTING','WAITING_QR','RECONNECTING') then v_dec:='ABORTADO'; v_mot:='gateway_ainda_ativo';
  else v_dec:='AINDA_INCERTO'; v_mot:='estado_gateway_indeterminado'; end if;
 else v_dec:='AINDA_INCERTO'; v_mot:='acao_desconhecida'; end if;

 if v_dec in ('CONCLUIDO','ABORTADO') then
  update whatsapp_identidade set efeito_token=null,efeito_acao=null,efeito_estado=null,
   efeito_auth_session_id=null,efeito_atualizado_em=null,efeito_incerto_desde=null,
   efeito_verificado_em=clock_timestamp(),efeito_verificacoes=efeito_verificacoes+1,efeito_ultimo_resultado=v_dec||':'||v_mot
  where organizacao_id=p_organizacao_id and provider_instance_id=p_provider_instance_id;
  -- Fluxo interrompido de desconexão/reset não continua: fecha a operação. Desconexão concluída também limpa a identidade confirmada.
  if v_acao in ('DESCONECTAR','RESET') then
   update whatsapp_identidade set operacao_id=null,operacao_tipo=null,operacao_por=null,operacao_expira_em=null
   where organizacao_id=p_organizacao_id and provider_instance_id=p_provider_instance_id;
  end if;
  if v_acao='DESCONECTAR' and v_dec='CONCLUIDO' then
   update whatsapp_identidade set status='SEM_CONTA',telefone_hash=null,nome_operacional=null,confirmado_em=null,confirmado_por=null,identificado_em=null
   where organizacao_id=p_organizacao_id and provider_instance_id=p_provider_instance_id;
  end if;
 else
  update whatsapp_identidade set efeito_verificado_em=clock_timestamp(),efeito_verificacoes=efeito_verificacoes+1,
   efeito_ultimo_resultado=v_dec||':'||v_mot,
   efeito_estado=case when efeito_estado='EXECUTANDO' and v_idade>=v_janela then 'INCERTO' else efeito_estado end,
   efeito_incerto_desde=case when efeito_estado='EXECUTANDO' and v_idade>=v_janela then clock_timestamp() else efeito_incerto_desde end
  where organizacao_id=p_organizacao_id and provider_instance_id=p_provider_instance_id;
 end if;
 return query select v_dec,v_mot,v_acao;
end $$;

revoke all on function whatsapp_operacao_efeito(uuid,text,uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function whatsapp_operacao_reconciliar(uuid,text,uuid,boolean,text,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function whatsapp_operacao_efeito(uuid,text,uuid,uuid,text,text) to service_role;
grant execute on function whatsapp_operacao_reconciliar(uuid,text,uuid,boolean,text,uuid,uuid,integer) to service_role;
commit;
