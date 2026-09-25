\set ON_ERROR_STOP on
begin;
create temp table vistos098(direcao text,id uuid,primary key(direcao,id));
do $$
declare
 org uuid:='a0960000-0000-4000-8000-00000000000a'; contato uuid; instante timestamptz:=clock_timestamp();
 antes_em timestamptz; antes_direcao text; antes_id uuid; item record; n integer; paginas integer:=0;
begin
 select contato_id into contato from comunicacao_roster_autorizado where organizacao_id=org limit 1;
 if contato is null then raise exception 'Seed autorizado ausente'; end if;
 delete from comunicacao_inbox_mensagens where contato_id=contato;
 delete from comunicacao_mensagens where contato_id=contato;
 insert into comunicacao_inbox_mensagens(id,organizacao_id,contato_id,provider_message_id,origem_tipo,tipo_conteudo,texto,recebido_em)
 select ('00000000-0098-4000-8000-'||lpad(i::text,12,'0'))::uuid,org,contato,'qa098-'||i,'LIVE','texto','fixture',instante from generate_series(1,601) i;
 insert into comunicacao_mensagens(id,organizacao_id,contato_id,direcao,tipo,conteudo,status,idempotency_key,disponivel_em,enviado_em)
 select ('00000000-0098-4000-8000-'||lpad((i+1000)::text,12,'0'))::uuid,org,contato,'saida','manual','fixture','SENT','qa098-'||i,instante,instante from generate_series(1,601) i;
 loop
  n:=0;
  for item in select * from comunicacao_conversa_pagina(org,contato,instante-interval '1 day',antes_em,antes_direcao,antes_id,200) loop
   insert into vistos098 values(item.direcao,item.id);
   antes_em:=item.em; antes_direcao:=item.direcao; antes_id:=item.id; n:=n+1;
  end loop;
  paginas:=paginas+1;
  if n>200 or paginas>8 then raise exception 'Paginação sem limite/progresso'; end if;
  exit when n<200;
 end loop;
 if (select count(*) from vistos098)<>1202 then raise exception 'Perda na paginação'; end if;
 if exists(select 1 from comunicacao_conversa_pagina(org,gen_random_uuid(),instante-interval '1 day')) then raise exception 'Contato fora do roster'; end if;
 raise notice 'PASS: 1202 mensagens, 7 páginas, empate de timestamp, sem perda/duplicata; roster preservado';
end $$;
rollback;
