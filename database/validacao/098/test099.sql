\set ON_ERROR_STOP on
-- Reconciliação (099). Somente banco de TESTE, depois do seed 096/097 e das migrations 098+099. Tudo é revertido.
begin;
create temp table resultados099(nome text, ok boolean not null);
create function pg_temp.verificar(nome text, ok boolean) returns void language plpgsql as $$
begin
 insert into resultados099 values(nome,coalesce(ok,false));
 if ok is distinct from true then raise exception 'FAIL: %',nome; end if;
end $$;
-- Cenário: conexão CONNECTED (geração g), operação do tipo t, efeito a no estado e, com idade envelhecida (fora da janela de estabilização).
create function pg_temp.cenario(org uuid,g uuid,t text,a text,e text) returns uuid language plpgsql as $$
declare op uuid; tok uuid:=gen_random_uuid();
begin
 delete from whatsapp_identidade where organizacao_id=org;
 delete from whatsapp_conexoes where organizacao_id=org;
 insert into whatsapp_conexoes(organizacao_id,provider_instance_id,status,telefone_e164,connected_at,last_seen_at,auth_session_id,auth_state_encrypted,auth_confirmado)
 values(org,'default','CONNECTED','+12025550100',now(),now(),g,'fixture-teste-sem-credencial',true);
 insert into whatsapp_identidade(organizacao_id,provider_instance_id,status,telefone_hash,confirmado_em,ambiente)
 values(org,'default','CONFIRMADA',repeat('a',64),now(),'TESTE');
 select operacao_id into op from whatsapp_operacao_iniciar(org,'default',t,null,300);
 perform whatsapp_operacao_efeito(org,'default',op,tok,a,'PREPARAR');
 if e in ('EXECUTANDO','INCERTO') then perform whatsapp_operacao_efeito(org,'default',op,tok,a,'CONSUMIR'); end if;
 if e='INCERTO' then perform whatsapp_operacao_efeito(org,'default',op,tok,a,'INCERTO'); end if;
 update whatsapp_identidade set efeito_atualizado_em=clock_timestamp()-interval '10 minutes' where organizacao_id=org;
 return op;
end $$;
create function pg_temp.rec(org uuid,op uuid,ok boolean,est text,aut uuid) returns text language sql as $$
 select decisao||':'||motivo from whatsapp_operacao_reconciliar(org,'default',op,ok,est,aut,null,30) $$;
do $$
declare org uuid := 'a0960000-0000-4000-8000-00000000000a'; outra uuid := 'b0960000-0000-4000-8000-00000000000b';
 g uuid:=gen_random_uuid(); g2 uuid:=gen_random_uuid(); op uuid; f whatsapp_identidade%rowtype; tok uuid;
begin
 -- DESCONECTAR
 op:=pg_temp.cenario(org,g,'DESCONECTAR','DESCONECTAR','INCERTO');
 perform pg_temp.verificar('gateway indisponível continua INCERTO',pg_temp.rec(org,op,false,null,null)='AINDA_INCERTO:gateway_indisponivel');
 perform pg_temp.verificar('INCERTO preservado e verificação contada',(select efeito_estado='INCERTO' and efeito_verificacoes=1 and efeito_ultimo_resultado='AINDA_INCERTO:gateway_indisponivel' from whatsapp_identidade where organizacao_id=org));
 perform pg_temp.verificar('operação nova não assume enquanto INCERTO',not (select iniciada from whatsapp_operacao_iniciar(org,'default','TROCAR',null,300)));
 perform pg_temp.verificar('operação errada recusada',pg_temp.rec(org,gen_random_uuid(),true,'DISCONNECTED',null)='RECUSADO:operacao_diferente');
 perform pg_temp.verificar('outra organização sem efeito: JA_RESOLVIDO (nunca decide)',pg_temp.rec(outra,op,true,'DISCONNECTED',null)='JA_RESOLVIDO:sem_efeito_pendente');
 perform pg_temp.verificar('contraditório (conectado, sessão desconhecida) continua INCERTO',pg_temp.rec(org,op,true,'CONNECTED',null)='AINDA_INCERTO:evidencia_contraditoria');
 perform pg_temp.verificar('sessão original ainda ativa => ABORTADO',pg_temp.rec(org,op,true,'CONNECTED',g)='ABORTADO:sessao_original_ativa');
 select * into f from whatsapp_identidade where organizacao_id=org;
 perform pg_temp.verificar('aborto: efeito limpo, operação fechada, identidade preservada',f.efeito_token is null and f.operacao_id is null and f.status='CONFIRMADA' and f.efeito_ultimo_resultado='ABORTADO:sessao_original_ativa');
 perform pg_temp.verificar('repetida é idempotente',pg_temp.rec(org,op,true,'CONNECTED',g)='JA_RESOLVIDO:sem_efeito_pendente');
 perform pg_temp.verificar('operação nova assume após reconciliação',(select iniciada from whatsapp_operacao_iniciar(org,'default','TROCAR',null,300)));

 op:=pg_temp.cenario(org,g,'DESCONECTAR','DESCONECTAR','INCERTO');
 perform pg_temp.verificar('gateway desconectado => CONCLUIDO',pg_temp.rec(org,op,true,'DISCONNECTED',null)='CONCLUIDO:sessao_encerrada');
 select * into f from whatsapp_identidade where organizacao_id=org;
 perform pg_temp.verificar('concluído: identidade limpa, efeito livre, operação fechada',f.status='SEM_CONTA' and f.telefone_hash is null and f.efeito_token is null and f.operacao_id is null);

 op:=pg_temp.cenario(org,g,'DESCONECTAR','DESCONECTAR','INCERTO');
 perform pg_temp.verificar('sessão substituída => CONCLUIDO',pg_temp.rec(org,op,true,'CONNECTED',g2)='CONCLUIDO:sessao_substituida');

 -- janela de estabilização (logout em voo)
 op:=pg_temp.cenario(org,g,'DESCONECTAR','DESCONECTAR','INCERTO');
 update whatsapp_identidade set efeito_atualizado_em=clock_timestamp() where organizacao_id=org;
 perform pg_temp.verificar('efeito recente: aguarda estabilização, mesmo com evidência',pg_temp.rec(org,op,true,'DISCONNECTED',null)='AINDA_INCERTO:janela_de_estabilizacao');

 -- heartbeat velho não sustenta ABORTADO
 op:=pg_temp.cenario(org,g,'DESCONECTAR','DESCONECTAR','INCERTO');
 update whatsapp_conexoes set last_seen_at=now()-interval '10 minutes' where organizacao_id=org;
 perform pg_temp.verificar('sessão igual mas heartbeat velho => INCERTO',pg_temp.rec(org,op,true,'CONNECTED',g)='AINDA_INCERTO:evidencia_contraditoria');

 -- EXECUTANDO parado (gateway caiu no meio / timeout do backend)
 op:=pg_temp.cenario(org,g,'DESCONECTAR','DESCONECTAR','EXECUTANDO');
 perform pg_temp.verificar('EXECUTANDO com gateway fora => AINDA_INCERTO',pg_temp.rec(org,op,false,null,null)='AINDA_INCERTO:gateway_indisponivel');
 perform pg_temp.verificar('EXECUTANDO parado é promovido a INCERTO (observável)',(select efeito_estado='INCERTO' and efeito_incerto_desde is not null from whatsapp_identidade where organizacao_id=org));

 -- RESET
 op:=pg_temp.cenario(org,g,'TROCAR','RESET','INCERTO');
 perform pg_temp.verificar('RESET: geração diferente => CONCLUIDO',pg_temp.rec(org,op,true,'WAITING_QR',null)='CONCLUIDO:sessao_diferente');
 perform pg_temp.verificar('RESET concluído não apaga identidade por inferência',(select status='CONFIRMADA' from whatsapp_identidade where organizacao_id=org));
 op:=pg_temp.cenario(org,g,'TROCAR','RESET','INCERTO');
 perform pg_temp.verificar('RESET: mesma sessão ativa => ABORTADO',pg_temp.rec(org,op,true,'CONNECTED',g)='ABORTADO:sessao_original_ativa');
 op:=pg_temp.cenario(org,g,'TROCAR','RESET','INCERTO');
 update whatsapp_identidade set efeito_auth_session_id=null where organizacao_id=org;
 perform pg_temp.verificar('RESET sem snapshot de sessão não conclui por inferência fraca',pg_temp.rec(org,op,true,'CONNECTED',g)='AINDA_INCERTO:evidencia_contraditoria');

 -- CONECTAR / ENCERRAR
 op:=pg_temp.cenario(org,g,'CONECTAR','CONECTAR','INCERTO');
 perform pg_temp.verificar('CONECTAR com QR ativo => CONCLUIDO',pg_temp.rec(org,op,true,'WAITING_QR',null)='CONCLUIDO:pareamento_ativo');
 perform pg_temp.verificar('operação do assistente é mantida',(select operacao_id=op from whatsapp_identidade where organizacao_id=org));
 op:=pg_temp.cenario(org,g,'CONECTAR','CONECTAR','INCERTO');
 perform pg_temp.verificar('CONECTAR com gateway desconectado => ABORTADO',pg_temp.rec(org,op,true,'DISCONNECTED',null)='ABORTADO:gateway_desconectado');
 op:=pg_temp.cenario(org,g,'CONECTAR','CONECTAR','INCERTO');
 perform pg_temp.verificar('estado do gateway indeterminado continua INCERTO',pg_temp.rec(org,op,true,'AUTH_ERROR',null)='AINDA_INCERTO:estado_gateway_indeterminado');
 op:=pg_temp.cenario(org,g,'CONECTAR','ENCERRAR','INCERTO');
 perform pg_temp.verificar('ENCERRAR com gateway desconectado => CONCLUIDO',pg_temp.rec(org,op,true,'DISCONNECTED',null)='CONCLUIDO:gateway_desconectado');
 op:=pg_temp.cenario(org,g,'CONECTAR','ENCERRAR','INCERTO');
 perform pg_temp.verificar('ENCERRAR com socket ainda ativo => ABORTADO',pg_temp.rec(org,op,true,'CONNECTING',null)='ABORTADO:gateway_ainda_ativo');

 -- PENDENTE (token nunca consumido)
 op:=pg_temp.cenario(org,g,'CONECTAR','CONECTAR','PENDENTE');
 update whatsapp_identidade set efeito_atualizado_em=clock_timestamp() where organizacao_id=org;
 perform pg_temp.verificar('PENDENTE recente aguarda',pg_temp.rec(org,op,false,null,null)='AINDA_INCERTO:aguardando_consumo');
 update whatsapp_identidade set efeito_atualizado_em=clock_timestamp()-interval '10 minutes' where organizacao_id=org;
 perform pg_temp.verificar('PENDENTE antigo => ABORTADO (token revogado, sem efeito)',pg_temp.rec(org,op,false,null,null)='ABORTADO:token_nunca_consumido');
 perform pg_temp.verificar('CONSUMIR tardio do token revogado é recusado',not whatsapp_operacao_efeito(org,'default',op,gen_random_uuid(),'CONECTAR','CONSUMIR'));

 -- FALHA_DETERMINISTICA
 op:=pg_temp.cenario(org,g,'CONECTAR','CONECTAR','PENDENTE');
 select efeito_token into tok from whatsapp_identidade where organizacao_id=org;
 perform pg_temp.verificar('FALHA_DETERMINISTICA exige EXECUTANDO',not whatsapp_operacao_efeito(org,'default',op,tok,'CONECTAR','FALHA_DETERMINISTICA'));
 perform whatsapp_operacao_efeito(org,'default',op,tok,'CONECTAR','CONSUMIR');
 perform pg_temp.verificar('FALHA_DETERMINISTICA com token errado recusada',not whatsapp_operacao_efeito(org,'default',op,gen_random_uuid(),'CONECTAR','FALHA_DETERMINISTICA'));
 perform pg_temp.verificar('FALHA_DETERMINISTICA aceita com token e ação corretos',whatsapp_operacao_efeito(org,'default',op,tok,'CONECTAR','FALHA_DETERMINISTICA'));
 perform pg_temp.verificar('efeito liberado sem reconciliação',(select efeito_token is null and efeito_auth_session_id is null and efeito_atualizado_em is null from whatsapp_identidade where organizacao_id=org));
 perform pg_temp.verificar('após falha determinística a operação pode preparar de novo',whatsapp_operacao_efeito(org,'default',op,gen_random_uuid(),'CONECTAR','PREPARAR'));
end $$;
do $$ begin
 begin
  update whatsapp_identidade set efeito_token=null,efeito_atualizado_em=now() where organizacao_id='a0960000-0000-4000-8000-00000000000a';
  raise exception 'FAIL: constraint efeito_meta_valida não recusou';
 exception when check_violation then
  insert into resultados099 values('constraint efeito_meta_valida recusa metadados órfãos',true);
 end;
end $$;
do $$ begin
 perform pg_temp.verificar('anon/authenticated sem EXECUTE na reconciliação; service_role com',
  not has_function_privilege('anon','whatsapp_operacao_reconciliar(uuid,text,uuid,boolean,text,uuid,uuid,integer)','execute')
  and not has_function_privilege('authenticated','whatsapp_operacao_reconciliar(uuid,text,uuid,boolean,text,uuid,uuid,integer)','execute')
  and has_function_privilege('service_role','whatsapp_operacao_reconciliar(uuid,text,uuid,boolean,text,uuid,uuid,integer)','execute'));
end $$;
select count(*) as pass, count(*) filter (where not ok) as fail from resultados099;
rollback;
