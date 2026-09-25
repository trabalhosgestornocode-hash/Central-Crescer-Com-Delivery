-- Requer nenhum efeito externo pendente (a 098 não conhece FALHA_DETERMINISTICA nem a reconciliação). Restaura a whatsapp_operacao_efeito da 098.
begin;
do $$ begin if exists(select 1 from information_schema.columns where table_name='whatsapp_identidade' and column_name='efeito_token') and
  (select count(*) from whatsapp_identidade where to_jsonb(whatsapp_identidade)->>'efeito_token' is not null)>0
  then raise exception 'Reconcilie efeitos pendentes antes do rollback 099'; end if; end $$;
drop function if exists whatsapp_operacao_reconciliar(uuid,text,uuid,boolean,text,uuid,uuid,integer);
alter table whatsapp_identidade drop constraint if exists whatsapp_identidade_efeito_meta_valida;
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
revoke all on function whatsapp_operacao_efeito(uuid,text,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function whatsapp_operacao_efeito(uuid,text,uuid,uuid,text,text) to service_role;
alter table whatsapp_identidade drop column if exists efeito_auth_session_id, drop column if exists efeito_atualizado_em,
  drop column if exists efeito_incerto_desde, drop column if exists efeito_verificado_em,
  drop column if exists efeito_verificacoes, drop column if exists efeito_ultimo_resultado;
commit;
