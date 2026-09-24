\set ON_ERROR_STOP off
begin;
create temp table r (n serial, nome text, ok boolean, detalhe text);
grant all on r to public;
grant usage on sequence r_n_seq to public;
create or replace function pg_temp.t(p_nome text, p_ok boolean, p_det text default '') returns void language sql as $$ insert into r(nome, ok, detalhe) values (p_nome, coalesce(p_ok,false), p_det) $$;
create or replace function pg_temp.espera(p_nome text, p_sql text, p_estado text) returns void language plpgsql as $$
declare e text;
begin
  begin execute p_sql; perform pg_temp.t(p_nome, false, 'NÃO falhou (esperado '||p_estado||')');
  exception when others then e := sqlstate; perform pg_temp.t(p_nome, e = p_estado, 'sqlstate='||e||' esperado='||p_estado||' | '||left(sqlerrm,90)); end;
end $$;

-- ===== permissão específica =====
insert into painel_adm_permissoes (usuario_id, permissao) values ('c0000000-0096-4000-8000-000000000005','comunicacao:gerenciar_conexao');
select pg_temp.t('permissão: concedida a um usuário', (select count(*) from painel_adm_permissoes where usuario_id='c0000000-0096-4000-8000-000000000005') = 1);
select pg_temp.espera('permissão: duplicada é recusada (PK)', $q$insert into painel_adm_permissoes (usuario_id, permissao) values ('c0000000-0096-4000-8000-000000000005','comunicacao:gerenciar_conexao')$q$, '23505');
select pg_temp.espera('permissão: valor desconhecido é recusado (CHECK)', $q$insert into painel_adm_permissoes (usuario_id, permissao) values ('c0000000-0096-4000-8000-000000000001','superpoder')$q$, '23514');
select pg_temp.espera('permissão: usuário inexistente (FK)', $q$insert into painel_adm_permissoes (usuario_id, permissao) values (gen_random_uuid(),'comunicacao:gerenciar_conexao')$q$, '23503');
select pg_temp.t('permissão: quem só atende conversas NÃO tem a permissão', (select count(*) from painel_adm_permissoes where usuario_id='c0000000-0096-4000-8000-000000000001') = 0);

-- ===== identidade: constraints =====
select pg_temp.espera('identidade: CONFIRMADA sem hash é recusada', $q$insert into whatsapp_identidade (organizacao_id, status, confirmado_em) values ('a0960000-0000-4000-8000-00000000000a','CONFIRMADA', now())$q$, '23514');
select pg_temp.espera('identidade: CONFIRMADA sem confirmado_em é recusada', $q$insert into whatsapp_identidade (organizacao_id, status, telefone_hash) values ('a0960000-0000-4000-8000-00000000000a','CONFIRMADA', repeat('a',64))$q$, '23514');
select pg_temp.espera('identidade: hash que não é sha256 hex é recusado (nada de telefone em claro)', $q$insert into whatsapp_identidade (organizacao_id, telefone_hash) values ('a0960000-0000-4000-8000-00000000000a','+5511999990001')$q$, '23514');
select pg_temp.espera('identidade: status inválido', $q$insert into whatsapp_identidade (organizacao_id, status) values ('a0960000-0000-4000-8000-00000000000a','OK')$q$, '23514');
select pg_temp.espera('identidade: ambiente inválido', $q$insert into whatsapp_identidade (organizacao_id, ambiente) values ('a0960000-0000-4000-8000-00000000000a','HOMOLOG')$q$, '23514');
select pg_temp.espera('identidade: nome operacional vazio', $q$insert into whatsapp_identidade (organizacao_id, nome_operacional) values ('a0960000-0000-4000-8000-00000000000a','')$q$, '23514');
select pg_temp.espera('identidade: nome operacional > 60', $q$insert into whatsapp_identidade (organizacao_id, nome_operacional) values ('a0960000-0000-4000-8000-00000000000a',repeat('n',61))$q$, '23514');
select pg_temp.espera('identidade: operação sem tipo (par)', $q$insert into whatsapp_identidade (organizacao_id, operacao_id) values ('a0960000-0000-4000-8000-00000000000a', gen_random_uuid())$q$, '23514');
select pg_temp.espera('identidade: operacao_tipo inválido', $q$insert into whatsapp_identidade (organizacao_id, operacao_id, operacao_tipo, operacao_expira_em) values ('a0960000-0000-4000-8000-00000000000a', gen_random_uuid(),'FORMATAR', now())$q$, '23514');
select pg_temp.espera('identidade: organização inexistente (FK)', $q$insert into whatsapp_identidade (organizacao_id) values (gen_random_uuid())$q$, '23503');

-- ===== trava de operação =====
do $$ declare a record; b record; c record; e boolean; begin
  select * into a from whatsapp_operacao_iniciar('a0960000-0000-4000-8000-00000000000a','default','CONECTAR','d0000000-0096-4000-8000-0000000000ad',300);
  select * into b from whatsapp_operacao_iniciar('a0960000-0000-4000-8000-00000000000a','default','DESCONECTAR','d0000000-0096-4000-8000-0000000000ad',300);
  perform pg_temp.t('trava: 1ª operação inicia', a.iniciada and a.operacao_tipo='CONECTAR');
  perform pg_temp.t('trava: 2ª operação (outra aba/operador) é recusada e devolve a operação em curso', not b.iniciada and b.operacao_id = a.operacao_id and b.operacao_tipo='CONECTAR');
  perform pg_temp.t('trava: encerrar com id ERRADO não libera', whatsapp_operacao_encerrar('a0960000-0000-4000-8000-00000000000a','default', gen_random_uuid()) = false);
  select * into c from whatsapp_operacao_iniciar('a0960000-0000-4000-8000-00000000000a','default','TROCAR',null,300);
  perform pg_temp.t('trava: continua presa após encerrar-errado', not c.iniciada);
  perform pg_temp.t('trava: encerrar com o id certo libera', whatsapp_operacao_encerrar('a0960000-0000-4000-8000-00000000000a','default', a.operacao_id) = true);
  perform pg_temp.t('trava: encerrar de novo é no-op (false)', whatsapp_operacao_encerrar('a0960000-0000-4000-8000-00000000000a','default', a.operacao_id) = false);
  select * into c from whatsapp_operacao_iniciar('a0960000-0000-4000-8000-00000000000a','default','TROCAR',null,300);
  perform pg_temp.t('trava: depois de liberar, nova operação inicia', c.iniciada and c.operacao_tipo='TROCAR');
  -- expiração: a trava velha não prende para sempre
  update whatsapp_identidade set operacao_expira_em = now() - interval '1 second' where organizacao_id='a0960000-0000-4000-8000-00000000000a';
  select * into c from whatsapp_operacao_iniciar('a0960000-0000-4000-8000-00000000000a','default','CONECTAR',null,300);
  perform pg_temp.t('trava: expirada é retomável', c.iniciada);
  perform pg_temp.t('trava: TTL mínimo de 30 s (ttl=1 vira 30)', (select operacao_expira_em > now() + interval '25 seconds' from whatsapp_identidade where organizacao_id='a0960000-0000-4000-8000-00000000000a'));
end $$;

-- ===== multi-tenant: A e B independentes =====
do $$ declare ra record; rb record; begin
  select * into rb from whatsapp_operacao_iniciar('b0960000-0000-4000-8000-00000000000b','default','CONECTAR','d0000000-0096-4000-8000-0000000000b1',300);
  perform pg_temp.t('MT: a trava da org A NÃO bloqueia a org B', rb.iniciada);
  update whatsapp_identidade set status='CONFIRMADA', telefone_hash=repeat('b',64), confirmado_em=now(), nome_operacional='Agente B' where organizacao_id='b0960000-0000-4000-8000-00000000000b';
  perform pg_temp.t('MT: confirmar a identidade da B não muda a da A', (select status='SEM_CONTA' and telefone_hash is null and nome_operacional is null from whatsapp_identidade where organizacao_id='a0960000-0000-4000-8000-00000000000a'));
  perform pg_temp.t('MT: encerrar a operação da B com o id da A não libera a B', whatsapp_operacao_encerrar('b0960000-0000-4000-8000-00000000000b','default',(select operacao_id from whatsapp_identidade where organizacao_id='a0960000-0000-4000-8000-00000000000a')) = false);
  perform pg_temp.t('MT: encerrar a operação da A com o id da B não libera a A', whatsapp_operacao_encerrar('a0960000-0000-4000-8000-00000000000a','default',(select operacao_id from whatsapp_identidade where organizacao_id='b0960000-0000-4000-8000-00000000000b')) = false);
  perform pg_temp.t('MT: instâncias diferentes da MESMA org têm travas independentes', (select iniciada from whatsapp_operacao_iniciar('a0960000-0000-4000-8000-00000000000a','instancia-2','CONECTAR',null,300)));
end $$;

-- ===== identidade: ciclo pendente → confirmada → outra conta → desconexão (histórico preservado) =====
do $$ declare h1 text := repeat('1',64); h2 text := repeat('2',64); begin
  perform comunicacao_inbox_registrar('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1','WAID-HIST','LIVE','texto','histórico',now());
  update whatsapp_identidade set status='PENDENTE_CONFIRMACAO', telefone_hash=h1, identificado_em=now() where organizacao_id='a0960000-0000-4000-8000-00000000000a' and provider_instance_id='default';
  perform pg_temp.t('ciclo: PENDENTE_CONFIRMACAO aceita hash sem confirmado_em', (select status from whatsapp_identidade where organizacao_id='a0960000-0000-4000-8000-00000000000a' and provider_instance_id='default') = 'PENDENTE_CONFIRMACAO');
  update whatsapp_identidade set status='CONFIRMADA', confirmado_em=now(), confirmado_por='d0000000-0096-4000-8000-0000000000ad', nome_operacional='Agente Crescer' where organizacao_id='a0960000-0000-4000-8000-00000000000a' and provider_instance_id='default';
  perform pg_temp.t('ciclo: CONFIRMADA guarda hash + quem confirmou', (select telefone_hash=h1 and confirmado_por is not null from whatsapp_identidade where organizacao_id='a0960000-0000-4000-8000-00000000000a' and provider_instance_id='default'));
  -- "outra conta": a aplicação compara hashes; o banco garante que a confirmação nunca existe sem hash
  perform pg_temp.t('ciclo: hash da conta atual (h2) ≠ confirmado (h1) ⇒ aplicação invalida', (select telefone_hash <> h2 from whatsapp_identidade where organizacao_id='a0960000-0000-4000-8000-00000000000a' and provider_instance_id='default'));
  -- desconexão (o que a aplicação grava): volta a SEM_CONTA, sem tocar em nada da comunicação
  update whatsapp_identidade set status='SEM_CONTA', telefone_hash=null, identificado_em=null, confirmado_em=null, confirmado_por=null where organizacao_id='a0960000-0000-4000-8000-00000000000a' and provider_instance_id='default';
  perform pg_temp.t('desconexão: identidade zerada', (select status='SEM_CONTA' and telefone_hash is null from whatsapp_identidade where organizacao_id='a0960000-0000-4000-8000-00000000000a' and provider_instance_id='default'));
  perform pg_temp.t('desconexão: nome operacional preservado (é da operação, não do número)', (select nome_operacional='Agente Crescer' from whatsapp_identidade where organizacao_id='a0960000-0000-4000-8000-00000000000a' and provider_instance_id='default'));
  perform pg_temp.t('desconexão: histórico de mensagens PRESERVADO', (select count(*) from comunicacao_inbox_mensagens where provider_message_id='WAID-HIST') = 1);
  perform pg_temp.t('desconexão: contatos/destinatários preservados', (select count(*) from contatos_whatsapp where id::text like 'e0000000-0096-%') >= 6);
end $$;
do $$ begin
  update whatsapp_identidade set updated_at = '2000-01-01' where organizacao_id='b0960000-0000-4000-8000-00000000000b';
  perform pg_temp.t('trigger updated_at renova a cada UPDATE', (select updated_at > now() - interval '1 minute' from whatsapp_identidade where organizacao_id='b0960000-0000-4000-8000-00000000000b'));
end $$;

-- ===== cascata (apagar organização apaga a identidade dela, só dela) =====
do $$ begin
  insert into organizacoes (id, nome) values ('a0960000-0000-4000-8000-0000000000c1','ZZVAL Org C');
  perform whatsapp_operacao_iniciar('a0960000-0000-4000-8000-0000000000c1','default','CONECTAR',null,300);
  delete from organizacoes where id='a0960000-0000-4000-8000-0000000000c1';
  perform pg_temp.t('cascata: apagar a organização apaga a identidade dela', (select count(*) from whatsapp_identidade where organizacao_id='a0960000-0000-4000-8000-0000000000c1') = 0);
  perform pg_temp.t('cascata: identidades de A e B permanecem', (select count(*) from whatsapp_identidade where organizacao_id in ('a0960000-0000-4000-8000-00000000000a','b0960000-0000-4000-8000-00000000000b')) >= 2);
end $$;

-- ===== roles reais =====
set local role anon;
select pg_temp.espera('ROLE anon: SELECT whatsapp_identidade negado', 'select count(*) from whatsapp_identidade', '42501');
select pg_temp.espera('ROLE anon: SELECT painel_adm_permissoes negado', 'select count(*) from painel_adm_permissoes', '42501');
select pg_temp.espera('ROLE anon: conceder permissão a si mesmo negado', $q$insert into painel_adm_permissoes (usuario_id, permissao) values ('c0000000-0096-4000-8000-000000000001','comunicacao:gerenciar_conexao')$q$, '42501');
select pg_temp.espera('ROLE anon: EXECUTE whatsapp_operacao_iniciar negado', $q$select * from whatsapp_operacao_iniciar('a0960000-0000-4000-8000-00000000000a','default','CONECTAR',null,300)$q$, '42501');
reset role;
set local role authenticated;
select pg_temp.espera('ROLE authenticated: SELECT whatsapp_identidade negado', 'select count(*) from whatsapp_identidade', '42501');
select pg_temp.espera('ROLE authenticated: auto-concessão de permissão negada', $q$insert into painel_adm_permissoes (usuario_id, permissao) values ('c0000000-0096-4000-8000-000000000001','comunicacao:gerenciar_conexao')$q$, '42501');
select pg_temp.espera('ROLE authenticated: UPDATE de identidade negado (não se confirma conta pelo cliente)', $q$update whatsapp_identidade set status='CONFIRMADA'$q$, '42501');
select pg_temp.espera('ROLE authenticated: EXECUTE encerrar negado', $q$select whatsapp_operacao_encerrar('a0960000-0000-4000-8000-00000000000a','default',gen_random_uuid())$q$, '42501');
reset role;
grant select, insert, update, delete on whatsapp_identidade, painel_adm_permissoes to authenticated, anon;
set local role authenticated;
select pg_temp.t('RLS (grant acidental): authenticated enxerga 0 linhas de identidade', (select count(*) from whatsapp_identidade) = 0);
select pg_temp.t('RLS (grant acidental): authenticated enxerga 0 linhas de permissões', (select count(*) from painel_adm_permissoes) = 0);
select pg_temp.espera('RLS (grant acidental): authenticated NÃO consegue inserir permissão (with check)', $q$insert into painel_adm_permissoes (usuario_id, permissao) values ('c0000000-0096-4000-8000-000000000001','comunicacao:gerenciar_conexao')$q$, '42501');
do $$ declare n int; begin update whatsapp_identidade set status='SEM_CONTA'; get diagnostics n = row_count; perform pg_temp.t('RLS (grant acidental): UPDATE authenticated afeta 0 linhas', n = 0, 'linhas='||n); end $$;
reset role;
set local role anon;
select pg_temp.t('RLS (grant acidental): anon enxerga 0 linhas', (select count(*) from whatsapp_identidade) = 0 and (select count(*) from painel_adm_permissoes) = 0);
reset role;
set local role service_role;
select pg_temp.t('ROLE service_role lê identidade e permissões', (select count(*) from whatsapp_identidade) >= 2 and (select count(*) from painel_adm_permissoes) >= 1);
select pg_temp.t('ROLE service_role executa a trava', (select iniciada from whatsapp_operacao_iniciar('a0960000-0000-4000-8000-00000000000a','svc-role','CONECTAR',null,300)) = true);
reset role;

select n, case when ok then 'PASS' else 'FAIL' end res, nome, case when ok then '' else detalhe end det from r order by n;
select count(*) filter (where ok) pass, count(*) filter (where not ok) fail from r;
rollback;
