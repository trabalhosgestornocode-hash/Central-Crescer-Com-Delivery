-- Evolução da 097 já versionada/aplicada em teste. Não altera modo, habilitações ou outbox.
-- Um efeito externo consumido não expira automaticamente: resultado incerto requer reconciliação.
begin;
-- Remove a assinatura preliminar somente se uma versão de desenvolvimento da 098 foi ensaiada.
drop function if exists whatsapp_confirmar_identidade_operacao(uuid,text,uuid,text,timestamptz,text,text,uuid);
alter table whatsapp_identidade add column if not exists efeito_token uuid;
alter table whatsapp_identidade add column if not exists efeito_acao text;
alter table whatsapp_identidade add column if not exists efeito_estado text;
alter table whatsapp_identidade drop constraint if exists whatsapp_identidade_efeito_valido;
alter table whatsapp_identidade add constraint whatsapp_identidade_efeito_valido check (
  (efeito_token is null and efeito_acao is null and efeito_estado is null) or
  (efeito_token is not null and operacao_id is not null and efeito_acao is not null and efeito_estado is not null and
   efeito_acao in ('CONECTAR','ENCERRAR','DESCONECTAR','RESET') and
   efeito_estado in ('PENDENTE','EXECUTANDO','INCERTO')));

create or replace function whatsapp_operacao_iniciar(
 p_organizacao_id uuid,p_provider_instance_id text,p_tipo text,p_por uuid,p_ttl_segundos integer default 300
) returns table(iniciada boolean,operacao_id uuid,operacao_tipo text)
language plpgsql set search_path=public as $$
declare v_id uuid;
begin
 insert into whatsapp_identidade(organizacao_id,provider_instance_id)
 values(p_organizacao_id,p_provider_instance_id) on conflict do nothing;
 update whatsapp_identidade i set operacao_id=gen_random_uuid(),operacao_tipo=p_tipo,operacao_por=p_por,
 operacao_expira_em=clock_timestamp()+make_interval(secs=>greatest(coalesce(p_ttl_segundos,300),30))
 where i.organizacao_id=p_organizacao_id and i.provider_instance_id=p_provider_instance_id
 and i.efeito_token is null and (i.operacao_id is null or i.operacao_expira_em<clock_timestamp())
 returning i.operacao_id into v_id;
 if v_id is not null then return query select true,v_id,p_tipo;
 else return query select false,i.operacao_id,i.operacao_tipo from whatsapp_identidade i
 where i.organizacao_id=p_organizacao_id and i.provider_instance_id=p_provider_instance_id; end if;
end $$;

create or replace function whatsapp_operacao_encerrar(p_organizacao_id uuid,p_provider_instance_id text,p_operacao_id uuid)
returns boolean language sql set search_path=public as $$
 with u as (update whatsapp_identidade set operacao_id=null,operacao_tipo=null,operacao_por=null,operacao_expira_em=null
 where organizacao_id=p_organizacao_id and provider_instance_id=p_provider_instance_id
 and operacao_id=p_operacao_id and efeito_token is null returning 1) select exists(select 1 from u);
$$;

create or replace function whatsapp_operacao_efeito(
 p_organizacao_id uuid,p_provider_instance_id text,p_operacao_id uuid,p_token uuid,p_acao text,p_fase text
) returns boolean language plpgsql set search_path=public as $$
declare i whatsapp_identidade%rowtype;
begin
 select * into i from whatsapp_identidade where organizacao_id=p_organizacao_id
 and provider_instance_id=p_provider_instance_id for update;
 if not found or i.operacao_id is distinct from p_operacao_id or p_operacao_id is null or p_token is null then return false; end if;
 if p_fase='PREPARAR' then
  if i.efeito_token is not null or i.operacao_expira_em<=clock_timestamp() or
     p_acao is null or p_acao not in ('CONECTAR','ENCERRAR','DESCONECTAR','RESET') then return false; end if;
  update whatsapp_identidade set efeito_token=p_token,efeito_acao=p_acao,efeito_estado='PENDENTE'
  where organizacao_id=p_organizacao_id and provider_instance_id=p_provider_instance_id;
 elsif i.efeito_token is distinct from p_token or i.efeito_acao is distinct from p_acao then return false;
 elsif p_fase='CONSUMIR' then
  if i.efeito_estado<>'PENDENTE' or i.operacao_expira_em<=clock_timestamp() then return false; end if;
  update whatsapp_identidade set efeito_estado='EXECUTANDO'
  where organizacao_id=p_organizacao_id and provider_instance_id=p_provider_instance_id;
 elsif p_fase='CONCLUIR' and i.efeito_estado in ('EXECUTANDO','INCERTO') then
  update whatsapp_identidade set efeito_token=null,efeito_acao=null,efeito_estado=null
  where organizacao_id=p_organizacao_id and provider_instance_id=p_provider_instance_id;
 elsif p_fase='ABORTAR' and i.efeito_estado='PENDENTE' then
  -- Revoga antes do consumo: uma requisição atrasada não poderá executar.
  update whatsapp_identidade set efeito_token=null,efeito_acao=null,efeito_estado=null
  where organizacao_id=p_organizacao_id and provider_instance_id=p_provider_instance_id;
 elsif p_fase='INCERTO' and i.efeito_estado='EXECUTANDO' then
  update whatsapp_identidade set efeito_estado='INCERTO'
  where organizacao_id=p_organizacao_id and provider_instance_id=p_provider_instance_id;
 else return false;
 end if;
 return true;
end $$;

create or replace function whatsapp_confirmar_identidade_operacao(
 p_organizacao_id uuid,p_provider_instance_id text,p_operacao_id uuid,p_telefone_hash text,
 p_auth_session_id uuid,p_ambiente text,p_nome_operacional text,p_por uuid
) returns boolean language plpgsql set search_path=public as $$
declare i whatsapp_identidade%rowtype; c whatsapp_conexoes%rowtype;
begin
 select * into i from whatsapp_identidade where organizacao_id=p_organizacao_id
 and provider_instance_id=p_provider_instance_id for update;
 if not found or p_operacao_id is null or i.operacao_id is distinct from p_operacao_id or
 i.operacao_tipo not in ('CONECTAR','TROCAR') or i.operacao_expira_em<=clock_timestamp() or i.efeito_token is not null then return false; end if;
 select * into c from whatsapp_conexoes where organizacao_id=p_organizacao_id
 and provider_instance_id=p_provider_instance_id for update;
 if not found or c.status<>'CONNECTED' or c.telefone_e164 is null or
 p_auth_session_id is null or c.auth_session_id is distinct from p_auth_session_id or not c.auth_confirmado or c.last_seen_at is null or
 c.last_seen_at<clock_timestamp()-interval '2 minutes' or
 encode(sha256(convert_to(c.telefone_e164,'UTF8')),'hex') is distinct from p_telefone_hash then return false; end if;
 update whatsapp_identidade set status='CONFIRMADA',telefone_hash=p_telefone_hash,
 identificado_em=clock_timestamp(),confirmado_em=clock_timestamp(),confirmado_por=p_por,
 ambiente=p_ambiente,nome_operacional=p_nome_operacional,
 operacao_id=null,operacao_tipo=null,operacao_por=null,operacao_expira_em=null
 where organizacao_id=p_organizacao_id and provider_instance_id=p_provider_instance_id;
 return true;
end $$;

revoke all on function whatsapp_operacao_efeito(uuid,text,uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function whatsapp_confirmar_identidade_operacao(uuid,text,uuid,text,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function whatsapp_operacao_efeito(uuid,text,uuid,uuid,text,text) to service_role;
grant execute on function whatsapp_confirmar_identidade_operacao(uuid,text,uuid,text,uuid,text,text,uuid) to service_role;
-- Paginação por evento, direção e UUID: a primeira página contém as mensagens mais recentes.
create or replace function comunicacao_conversa_pagina(
 p_organizacao_id uuid,p_contato_id uuid,p_desde timestamptz,
 p_antes_em timestamptz default null,p_antes_direcao text default null,p_antes_id uuid default null,p_limite integer default 201
) returns table(direcao text,em timestamptz,id uuid,registro jsonb)
language sql stable set search_path=public as $$
 with mensagens as (
  select 'entrada'::text as direcao,m.recebido_em as em,m.id,to_jsonb(m) as registro
  from comunicacao_inbox_mensagens m where m.organizacao_id=p_organizacao_id and m.contato_id=p_contato_id
  and m.recebido_em>=greatest(p_desde,now()-interval '30 days')
  union all
  select 'saida'::text,
   case when m.status='SCHEDULED' then m.disponivel_em else coalesce(m.enviado_em,m.created_at) end,m.id,to_jsonb(m)
  from comunicacao_mensagens m where m.contato_id=p_contato_id and m.direcao='saida'
  and (case when m.status='SCHEDULED' then m.disponivel_em else coalesce(m.enviado_em,m.created_at) end)>=greatest(p_desde,now()-interval '30 days')
 )
 select m.* from mensagens m
 where exists(select 1 from comunicacao_roster_autorizado r where r.contato_id=p_contato_id)
 and (p_antes_em is null or (m.em,m.direcao,m.id)<(p_antes_em,p_antes_direcao,p_antes_id))
 order by m.em desc,m.direcao desc,m.id desc limit least(greatest(p_limite,1),201);
$$;
revoke all on function comunicacao_conversa_pagina(uuid,uuid,timestamptz,timestamptz,text,uuid,integer) from public,anon,authenticated;
grant execute on function comunicacao_conversa_pagina(uuid,uuid,timestamptz,timestamptz,text,uuid,integer) to service_role;
commit;
