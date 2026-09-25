\set ON_ERROR_STOP on
-- Usar somente banco de TESTE, depois do seed 096/097. Todas as mudanças abaixo são revertidas.
begin;
create temp table resultados098(nome text, ok boolean not null);
create function pg_temp.verificar(nome text, ok boolean) returns void language plpgsql as $$
begin
 insert into resultados098 values(nome,coalesce(ok,false));
 if ok is distinct from true then raise exception 'FAIL: %',nome; end if;
end $$;
do $$
declare
 org uuid := 'a0960000-0000-4000-8000-00000000000a'; outra uuid := 'b0960000-0000-4000-8000-00000000000b';
 a uuid; b uuid; geracao uuid := gen_random_uuid(); tok uuid := gen_random_uuid(); instante timestamptz := clock_timestamp();
 hash text := encode(sha256(convert_to('+12025550100','UTF8')),'hex');
begin
 delete from whatsapp_identidade where organizacao_id=org;
 insert into whatsapp_conexoes(organizacao_id,provider_instance_id,status,telefone_e164,connected_at,last_seen_at,auth_session_id,auth_state_encrypted,auth_confirmado)
 values(org,'default','CONNECTED','+12025550100',instante,instante,geracao,'fixture-teste-sem-credencial',true)
 on conflict(organizacao_id,provider_instance_id) do update set status='CONNECTED',telefone_e164=excluded.telefone_e164,connected_at=instante,last_seen_at=instante,auth_session_id=geracao,auth_state_encrypted=excluded.auth_state_encrypted,auth_confirmado=true;
 select operacao_id into a from whatsapp_operacao_iniciar(org,'default','CONECTAR',null,300);
 perform pg_temp.verificar('organização incorreta',not whatsapp_confirmar_identidade_operacao(outra,'default',a,hash,geracao,'TESTE',null,null));
 perform pg_temp.verificar('telefone vivo divergente',not whatsapp_confirmar_identidade_operacao(org,'default',a,repeat('0',64),geracao,'TESTE',null,null));
 perform pg_temp.verificar('geração divergente',not whatsapp_confirmar_identidade_operacao(org,'default',a,hash,gen_random_uuid(),'TESTE',null,null));
 perform pg_temp.verificar('confirmação normal',whatsapp_confirmar_identidade_operacao(org,'default',a,hash,geracao,'TESTE',null,null));
 perform pg_temp.verificar('confirmação repetida não decide novamente',not whatsapp_confirmar_identidade_operacao(org,'default',a,hash,geracao,'TESTE',null,null));
 perform pg_temp.verificar('encerramento antigo não muda conta confirmada',not whatsapp_operacao_encerrar(org,'default',a));
 select operacao_id into a from whatsapp_operacao_iniciar(org,'default','CONECTAR',null,300);
 update whatsapp_identidade set operacao_expira_em=clock_timestamp()-interval '1 second' where organizacao_id=org;
 perform pg_temp.verificar('expirada recusada',not whatsapp_confirmar_identidade_operacao(org,'default',a,hash,geracao,'TESTE',null,null));
 select operacao_id into b from whatsapp_operacao_iniciar(org,'default','TROCAR',null,300);
 perform pg_temp.verificar('B substituiu A',a<>b);
 perform pg_temp.verificar('A não confirma B',not whatsapp_confirmar_identidade_operacao(org,'default',a,repeat('1',64),geracao,'TESTE','Antiga',null));
 perform pg_temp.verificar('B e identidade anterior intactas',exists(select 1 from whatsapp_identidade where organizacao_id=org and operacao_id=b and telefone_hash=hash and nome_operacional is null));
 perform pg_temp.verificar('A não dispara efeito',not whatsapp_operacao_efeito(org,'default',a,tok,'DESCONECTAR','PREPARAR'));
 perform pg_temp.verificar('cancelar B',whatsapp_operacao_encerrar(org,'default',b));
 perform pg_temp.verificar('cancelada não confirma',not whatsapp_confirmar_identidade_operacao(org,'default',b,hash,geracao,'TESTE',null,null));
 select operacao_id into a from whatsapp_operacao_iniciar(org,'default','CONECTAR',null,300);
 perform pg_temp.verificar('preparar efeito',whatsapp_operacao_efeito(org,'default',a,tok,'CONECTAR','PREPARAR'));
 perform pg_temp.verificar('consumir efeito',whatsapp_operacao_efeito(org,'default',a,tok,'CONECTAR','CONSUMIR'));
 perform pg_temp.verificar('token não reutilizável',not whatsapp_operacao_efeito(org,'default',a,tok,'CONECTAR','CONSUMIR'));
 update whatsapp_identidade set operacao_expira_em=clock_timestamp()-interval '1 second' where organizacao_id=org;
 perform pg_temp.verificar('execução não expira liberando outra operação',not (select iniciada from whatsapp_operacao_iniciar(org,'default','TROCAR',null,300)));
 perform pg_temp.verificar('cancelamento não remove execução',not whatsapp_operacao_encerrar(org,'default',a));
 perform pg_temp.verificar('aborto não remove efeito consumido',not whatsapp_operacao_efeito(org,'default',a,tok,'CONECTAR','ABORTAR'));
 perform pg_temp.verificar('falha explícita reconciliável',whatsapp_operacao_efeito(org,'default',a,tok,'CONECTAR','INCERTO'));
 perform pg_temp.verificar('ACK tardio conclui a mesma execução',whatsapp_operacao_efeito(org,'default',a,tok,'CONECTAR','CONCLUIR'));
 select operacao_id into b from whatsapp_operacao_iniciar(org,'default','TROCAR',null,300);
 perform pg_temp.verificar('B só assume após ACK',a<>b);
 perform pg_temp.verificar('requisição atrasada A não consome',not whatsapp_operacao_efeito(org,'default',a,tok,'CONECTAR','CONSUMIR'));
 tok:=gen_random_uuid();
 perform pg_temp.verificar('prepara B',whatsapp_operacao_efeito(org,'default',b,tok,'DESCONECTAR','PREPARAR'));
 perform pg_temp.verificar('aborta antes do consumo',whatsapp_operacao_efeito(org,'default',b,tok,'DESCONECTAR','ABORTAR'));
 perform pg_temp.verificar('token revogado não chega ao efeito',not whatsapp_operacao_efeito(org,'default',b,tok,'DESCONECTAR','CONSUMIR'));
end $$;
select count(*) as pass from resultados098 where ok;
rollback;
