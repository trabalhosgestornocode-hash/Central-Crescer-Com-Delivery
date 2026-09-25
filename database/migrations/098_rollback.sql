-- Requer código anterior restaurado e nenhuma operação externa em andamento.
begin;
drop function if exists comunicacao_conversa_pagina(uuid,uuid,timestamptz,timestamptz,text,uuid,integer);
do $$ begin if exists(select 1 from information_schema.columns where table_name='whatsapp_identidade' and column_name='efeito_token') and
  (select count(*) from whatsapp_identidade where to_jsonb(whatsapp_identidade)->>'efeito_token' is not null)>0 then raise exception 'Reconcilie efeitos pendentes antes do rollback 098'; end if; end $$;
drop function if exists whatsapp_confirmar_identidade_operacao(uuid,text,uuid,text,uuid,text,text,uuid);
drop function if exists whatsapp_operacao_efeito(uuid,text,uuid,uuid,text,text);
alter table whatsapp_identidade drop constraint if exists whatsapp_identidade_efeito_valido;
alter table whatsapp_identidade drop column if exists efeito_token, drop column if exists efeito_acao, drop column if exists efeito_estado;
create or replace function whatsapp_operacao_iniciar(
  p_organizacao_id uuid, p_provider_instance_id text, p_tipo text, p_por uuid, p_ttl_segundos integer default 300
) returns table (iniciada boolean, operacao_id uuid, operacao_tipo text)
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into whatsapp_identidade (organizacao_id, provider_instance_id) values (p_organizacao_id, p_provider_instance_id)
  on conflict (organizacao_id, provider_instance_id) do nothing;

  update whatsapp_identidade i
     set operacao_id = gen_random_uuid(), operacao_tipo = p_tipo, operacao_por = p_por,
         operacao_expira_em = now() + make_interval(secs => greatest(coalesce(p_ttl_segundos, 300), 30))
   where i.organizacao_id = p_organizacao_id and i.provider_instance_id = p_provider_instance_id
     and (i.operacao_id is null or i.operacao_expira_em < now())
  returning i.operacao_id into v_id;

  if v_id is not null then
    return query select true, v_id, p_tipo;
  else
    return query select false, i.operacao_id, i.operacao_tipo from whatsapp_identidade i
     where i.organizacao_id = p_organizacao_id and i.provider_instance_id = p_provider_instance_id;
  end if;
end;
$$;

create or replace function whatsapp_operacao_encerrar(p_organizacao_id uuid, p_provider_instance_id text, p_operacao_id uuid)
returns boolean
language sql
set search_path = public
as $$
  with u as (
    update whatsapp_identidade
       set operacao_id = null, operacao_tipo = null, operacao_por = null, operacao_expira_em = null
     where organizacao_id = p_organizacao_id and provider_instance_id = p_provider_instance_id and operacao_id = p_operacao_id
    returning 1
  )
  select exists (select 1 from u);
$$;

revoke all on function whatsapp_operacao_iniciar(uuid, text, text, uuid, integer) from public, anon, authenticated;
revoke all on function whatsapp_operacao_encerrar(uuid, text, uuid) from public, anon, authenticated;
grant execute on function whatsapp_operacao_iniciar(uuid, text, text, uuid, integer) to service_role;
grant execute on function whatsapp_operacao_encerrar(uuid, text, uuid) to service_role;


commit;
