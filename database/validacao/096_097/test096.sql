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

-- ===== idempotência do registro =====
do $$ declare a record; b record; c record; begin
  select * into a from comunicacao_inbox_registrar('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1','WAID-1','LIVE','texto','olá',now());
  select * into b from comunicacao_inbox_registrar('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1','WAID-1','LIVE','texto','olá',now());
  perform pg_temp.t('registrar: 1ª chamada insere', a.inserido = true);
  perform pg_temp.t('registrar: 2ª chamada (mesmo id) NÃO duplica e devolve o mesmo id', b.inserido = false and b.id = a.id);
  perform pg_temp.t('registrar: exatamente 1 linha', (select count(*) from comunicacao_inbox_mensagens where provider_message_id='WAID-1') = 1);
  select * into c from comunicacao_inbox_registrar('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1','WAID-MIDIA','LIVE','midia',null,now());
  perform pg_temp.t('registrar: mídia sem texto entra', c.inserido);
end $$;

-- ===== constraints =====
select pg_temp.espera('CHECK: mídia COM texto é recusada', $q$insert into comunicacao_inbox_mensagens(organizacao_id,contato_id,provider_message_id,origem_tipo,tipo_conteudo,texto,recebido_em) values ('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1','X1','LIVE','midia','legenda',now())$q$, '23514');
select pg_temp.espera('CHECK: texto vazio é recusado', $q$insert into comunicacao_inbox_mensagens(organizacao_id,contato_id,provider_message_id,origem_tipo,tipo_conteudo,texto,recebido_em) values ('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1','X2','LIVE','texto','',now())$q$, '23514');
select pg_temp.espera('CHECK: texto > 4096 é recusado', $q$insert into comunicacao_inbox_mensagens(organizacao_id,contato_id,provider_message_id,origem_tipo,tipo_conteudo,texto,recebido_em) values ('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1','X3','LIVE','texto',repeat('a',4097),now())$q$, '23514');
select pg_temp.espera('CHECK: OFFLINE_RECOVERY nunca entra', $q$insert into comunicacao_inbox_mensagens(organizacao_id,contato_id,provider_message_id,origem_tipo,tipo_conteudo,texto,recebido_em) values ('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1','X4','OFFLINE_RECOVERY','texto','a',now())$q$, '23514');
select pg_temp.espera('CHECK: id do provedor com caracteres inválidos', $q$insert into comunicacao_inbox_mensagens(organizacao_id,contato_id,provider_message_id,origem_tipo,tipo_conteudo,texto,recebido_em) values ('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1','a b;c','LIVE','texto','a',now())$q$, '23514');
select pg_temp.espera('CHECK: tipo_conteudo inválido', $q$insert into comunicacao_inbox_mensagens(organizacao_id,contato_id,provider_message_id,origem_tipo,tipo_conteudo,texto,recebido_em) values ('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1','X5','LIVE','audio',null,now())$q$, '23514');
select pg_temp.espera('FK: contato inexistente', $q$insert into comunicacao_inbox_mensagens(organizacao_id,contato_id,provider_message_id,origem_tipo,tipo_conteudo,texto,recebido_em) values ('a0960000-0000-4000-8000-00000000000a',gen_random_uuid(),'X6','LIVE','texto','a',now())$q$, '23503');
select pg_temp.espera('FK: organização inexistente', $q$insert into comunicacao_inbox_mensagens(organizacao_id,contato_id,provider_message_id,origem_tipo,tipo_conteudo,texto,recebido_em) values (gen_random_uuid(),'e0000000-0096-4000-8000-0000000000a1','X7','LIVE','texto','a',now())$q$, '23503');
select pg_temp.espera('NOT NULL: recebido_em', $q$insert into comunicacao_inbox_mensagens(organizacao_id,contato_id,provider_message_id,origem_tipo,tipo_conteudo,texto,recebido_em) values ('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1','X8','LIVE','texto','a',null)$q$, '23502');
select pg_temp.espera('UNIQUE (org, id do provedor) direto', $q$insert into comunicacao_inbox_mensagens(organizacao_id,contato_id,provider_message_id,origem_tipo,tipo_conteudo,texto,recebido_em) values ('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1','WAID-1','LIVE','texto','a',now())$q$, '23505');

-- ===== multi-tenant =====
do $$ declare ra record; rb record; begin
  select * into ra from comunicacao_inbox_registrar('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a2','WAID-MT','LIVE','texto','msg da org A',now());
  select * into rb from comunicacao_inbox_registrar('b0960000-0000-4000-8000-00000000000b','e0000000-0096-4000-8000-0000000000b1','WAID-MT','LIVE','texto','msg da org B',now());
  perform pg_temp.t('MT: mesmo provider_message_id em orgs diferentes coexistem', ra.inserido and rb.inserido and ra.id <> rb.id);
  perform pg_temp.t('MT: resumo(A) só enxerga contatos da A', (select bool_and(contato_id in ('e0000000-0096-4000-8000-0000000000a1','e0000000-0096-4000-8000-0000000000a2')) from comunicacao_inbox_resumo('a0960000-0000-4000-8000-00000000000a')));
  perform pg_temp.t('MT: resumo(B) só enxerga a B', (select count(*) from comunicacao_inbox_resumo('b0960000-0000-4000-8000-00000000000b') where contato_id <> 'e0000000-0096-4000-8000-0000000000b1') = 0 and (select count(*) from comunicacao_inbox_resumo('b0960000-0000-4000-8000-00000000000b')) = 1);
  perform pg_temp.t('MT: resumo(B) não contém texto da A', (select coalesce(bool_and(ultima_texto not like '%org A%'),true) from comunicacao_inbox_resumo('b0960000-0000-4000-8000-00000000000b')));
end $$;
select pg_temp.t('MT/design: a org da tabela é a da CONEXÃO — responsável de outra org-cliente do roster É aceito', (select inserido from comunicacao_inbox_registrar('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000b1','WAID-CLIENTE','LIVE','texto','de cliente B via conexão A',now())));
select pg_temp.espera('MT: registrar contato DESCONHECIDO (sem perfil) é recusado', $q$select * from comunicacao_inbox_registrar('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000ee','WAID-UNK','LIVE','texto','x',now())$q$, 'P0001');
select pg_temp.espera('MT: registrar contato de perfil INATIVO é recusado', $q$select * from comunicacao_inbox_registrar('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000ff','WAID-OFF','LIVE','texto','x',now())$q$, 'P0001');

-- leitura por conversa: marcar lida na org A não pode afetar a org B quando o MESMO contato existe nas duas
insert into usuarios_organizacoes (usuario_id, organizacao_id, perfil_id, papel, ativo) values ('c0000000-0096-4000-8000-000000000001','b0960000-0000-4000-8000-00000000000b','d0000000-0096-4000-8000-0000000000a1','operations',true);
do $$ declare nl_b_antes int; nl_b_depois int; begin
  perform comunicacao_inbox_registrar('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1','WAID-SH-A','LIVE','texto','a→A',now() - interval '1 hour');
  perform comunicacao_inbox_registrar('b0960000-0000-4000-8000-00000000000b','e0000000-0096-4000-8000-0000000000a1','WAID-SH-B','LIVE','texto','a→B',now() - interval '1 hour');
  select nao_lidas into nl_b_antes from comunicacao_inbox_resumo('b0960000-0000-4000-8000-00000000000b') where contato_id='e0000000-0096-4000-8000-0000000000a1';
  perform comunicacao_inbox_marcar_lida('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1', now(), null);
  select nao_lidas into nl_b_depois from comunicacao_inbox_resumo('b0960000-0000-4000-8000-00000000000b') where contato_id='e0000000-0096-4000-8000-0000000000a1';
  perform pg_temp.t('MT: leitura marcada na org A NÃO altera não-lidas da org B (contato compartilhado)', nl_b_antes = nl_b_depois, format('B antes=%s depois=%s', nl_b_antes, nl_b_depois));
end $$;

-- ===== retenção (purga oportunista) =====
do $$ declare antes int; depois int; begin
  insert into comunicacao_inbox_mensagens(organizacao_id,contato_id,provider_message_id,origem_tipo,tipo_conteudo,texto,recebido_em) values ('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1','WAID-OLD','LIVE','texto','antiga',now() - interval '45 days');
  select count(*) into antes from comunicacao_inbox_mensagens where provider_message_id='WAID-OLD';
  perform comunicacao_inbox_registrar('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1','WAID-NEW','LIVE','texto','nova',now(),30);
  select count(*) into depois from comunicacao_inbox_mensagens where provider_message_id='WAID-OLD';
  perform pg_temp.t('retenção: >30 dias é purgada no registro seguinte', antes=1 and depois=0);
  insert into comunicacao_inbox_mensagens(organizacao_id,contato_id,provider_message_id,origem_tipo,tipo_conteudo,texto,recebido_em) values ('b0960000-0000-4000-8000-00000000000b','e0000000-0096-4000-8000-0000000000b1','WAID-OLD-B','LIVE','texto','antiga B',now() - interval '45 days');
  perform comunicacao_inbox_registrar('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1','WAID-NEW2','LIVE','texto','nova2',now(),30);
  perform pg_temp.t('retenção: a purga da org A não toca dados da org B', (select count(*) from comunicacao_inbox_mensagens where provider_message_id='WAID-OLD-B') = 1);
end $$;

-- ===== marcar_lida nunca retrocede =====
do $$ declare l timestamptz; begin
  perform comunicacao_inbox_marcar_lida('b0960000-0000-4000-8000-00000000000b','e0000000-0096-4000-8000-0000000000b1', now(), null);
  perform comunicacao_inbox_marcar_lida('b0960000-0000-4000-8000-00000000000b','e0000000-0096-4000-8000-0000000000b1', now() - interval '1 day', null);
  select lida_ate into l from comunicacao_inbox_leituras where organizacao_id='b0960000-0000-4000-8000-00000000000b' and contato_id='e0000000-0096-4000-8000-0000000000b1';
  perform pg_temp.t('marcar_lida: nunca retrocede', l > now() - interval '1 minute');
end $$;

-- ===== cascata =====
insert into contatos_whatsapp (id, telefone_e164) values ('e0000000-0096-4000-8000-0000000000c9','+5561990960099');
insert into comunicacao_inbox_mensagens(organizacao_id,contato_id,provider_message_id,origem_tipo,tipo_conteudo,texto,recebido_em) values ('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000c9','WAID-CASC2','LIVE','texto','x',now());
delete from contatos_whatsapp where id='e0000000-0096-4000-8000-0000000000c9';
select pg_temp.t('cascata: apagar o contato apaga suas mensagens', (select count(*) from comunicacao_inbox_mensagens where provider_message_id='WAID-CASC2') = 0);

-- ===== RLS / roles reais =====
set local role anon;
select pg_temp.espera('ROLE anon: SELECT na tabela negado (42501)', 'select count(*) from comunicacao_inbox_mensagens', '42501');
select pg_temp.espera('ROLE anon: INSERT negado', $q$insert into comunicacao_inbox_leituras(contato_id,lida_ate) values ('e0000000-0096-4000-8000-0000000000a1',now())$q$, '42501');
select pg_temp.espera('ROLE anon: view do roster negada', 'select count(*) from comunicacao_roster_autorizado', '42501');
select pg_temp.espera('ROLE anon: EXECUTE registrar negado', $q$select * from comunicacao_inbox_registrar('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1','ANON','LIVE','texto','x',now())$q$, '42501');
reset role;
set local role authenticated;
select pg_temp.espera('ROLE authenticated: SELECT negado', 'select count(*) from comunicacao_inbox_mensagens', '42501');
select pg_temp.espera('ROLE authenticated: view negada', 'select count(*) from comunicacao_roster_autorizado', '42501');
select pg_temp.espera('ROLE authenticated: EXECUTE resumo negado', $q$select * from comunicacao_inbox_resumo('a0960000-0000-4000-8000-00000000000a')$q$, '42501');
select pg_temp.espera('ROLE authenticated: EXECUTE marcar_lida negado', $q$select comunicacao_inbox_marcar_lida('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1',now(),null)$q$, '42501');
reset role;
-- RLS "de verdade": se alguém CONCEDER select por engano, RLS sem policy ainda bloqueia (0 linhas)
grant select on comunicacao_inbox_mensagens, comunicacao_inbox_leituras to authenticated, anon;
set local role authenticated;
select pg_temp.t('RLS (grant acidental): authenticated enxerga 0 linhas em mensagens', (select count(*) from comunicacao_inbox_mensagens) = 0);
select pg_temp.t('RLS (grant acidental): authenticated enxerga 0 linhas em leituras', (select count(*) from comunicacao_inbox_leituras) = 0);
reset role;
set local role anon;
select pg_temp.t('RLS (grant acidental): anon enxerga 0 linhas', (select count(*) from comunicacao_inbox_mensagens) = 0);
reset role;
select pg_temp.t('sanidade: as linhas existem (postgres/bypassrls as vê)', (select count(*) from comunicacao_inbox_mensagens) > 3);
set local role service_role;
select pg_temp.t('ROLE service_role (bypassrls) vê as linhas', (select count(*) from comunicacao_inbox_mensagens) > 3);
select pg_temp.t('ROLE service_role executa resumo', (select count(*) from comunicacao_inbox_resumo('a0960000-0000-4000-8000-00000000000a')) >= 1);
select pg_temp.t('ROLE service_role lê a view do roster', (select count(*) from comunicacao_roster_autorizado where organizacao_nome like 'ZZVAL%') >= 4);
reset role;

-- ===== purga periódica (retenção real) =====
do $$ declare n1 int; n2 int; begin
  insert into comunicacao_inbox_mensagens(organizacao_id,contato_id,provider_message_id,origem_tipo,tipo_conteudo,texto,recebido_em) values
    ('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1','PG-OLD-A','LIVE','texto','velha A',now() - interval '31 days'),
    ('b0960000-0000-4000-8000-00000000000b','e0000000-0096-4000-8000-0000000000b1','PG-OLD-B','LIVE','texto','velha B',now() - interval '40 days'),
    ('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1','PG-EDGE','LIVE','texto','29 dias',now() - interval '29 days'),
    ('a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1','PG-NEW','LIVE','texto','nova',now());
  perform pg_temp.t('purga: o resumo NÃO mostra texto vencido mesmo antes de purgar', (select count(*) from comunicacao_inbox_resumo('b0960000-0000-4000-8000-00000000000b') where ultima_texto = 'velha B') = 0);
  select comunicacao_inbox_purgar(30, 5000) into n1;
  perform pg_temp.t('purga: remove as vencidas de TODAS as orgs e devolve a contagem (sem conteúdo)', n1 >= 2 and (select count(*) from comunicacao_inbox_mensagens where provider_message_id in ('PG-OLD-A','PG-OLD-B')) = 0, 'removidas='||n1);
  perform pg_temp.t('purga: preserva 29 dias e a nova', (select count(*) from comunicacao_inbox_mensagens where provider_message_id in ('PG-EDGE','PG-NEW')) = 2);
  select comunicacao_inbox_purgar(30, 5000) into n2;
  perform pg_temp.t('purga: idempotente (2ª rodada remove 0)', n2 = 0);
  insert into comunicacao_inbox_mensagens(organizacao_id,contato_id,provider_message_id,origem_tipo,tipo_conteudo,texto,recebido_em) select 'a0960000-0000-4000-8000-00000000000a','e0000000-0096-4000-8000-0000000000a1','PG-LOTE-'||g,'LIVE','texto','x',now() - interval '50 days' from generate_series(1,7) g;
  select comunicacao_inbox_purgar(30, 3) into n1;
  perform pg_temp.t('purga: respeita o limite do lote', n1 = 3 and (select count(*) from comunicacao_inbox_mensagens where provider_message_id like 'PG-LOTE-%') = 4, 'n='||n1);
  select comunicacao_inbox_purgar(7, 5000) into n2;
  perform pg_temp.t('purga: retenção menor (7 dias) remove também os de 29 dias', n2 >= 5 and (select count(*) from comunicacao_inbox_mensagens where provider_message_id = 'PG-EDGE') = 0, 'n='||n2);
end $$;
set local role authenticated;
select pg_temp.espera('ROLE authenticated: EXECUTE purgar negado', 'select comunicacao_inbox_purgar(30, 10)', '42501');
reset role;
set local role anon;
select pg_temp.espera('ROLE anon: EXECUTE purgar negado', 'select comunicacao_inbox_purgar(30, 10)', '42501');
reset role;

-- ===== roster =====
select pg_temp.t('roster: vínculo DIRETO limita às unidades vinculadas (A1 só Loja1)', (select array_agg(unidade_nome order by unidade_nome) from comunicacao_roster_autorizado where contato_id='e0000000-0096-4000-8000-0000000000a1' and organizacao_id='a0960000-0000-4000-8000-00000000000a') = array['ZZVAL A-Loja1']);
select pg_temp.t('roster: sem vínculo direto HERDA todas as unidades ativas', (select count(*) from comunicacao_roster_autorizado where contato_id='e0000000-0096-4000-8000-0000000000a2') = 2);
select pg_temp.t('roster: perfil inativo/desconhecido/vínculo inativo NÃO aparecem', (select count(*) from comunicacao_roster_autorizado where contato_id in ('e0000000-0096-4000-8000-0000000000ff','e0000000-0096-4000-8000-0000000000ee','e0000000-0096-4000-8000-0000000000dd')) = 0);
select pg_temp.t('roster: contato NÃO aparece na org errada', (select count(*) from comunicacao_roster_autorizado where contato_id='e0000000-0096-4000-8000-0000000000b1' and organizacao_id='a0960000-0000-4000-8000-00000000000a') = 0);

select n, case when ok then 'PASS' else 'FAIL' end res, nome, case when ok then '' else detalhe end det from r order by n;
select count(*) filter (where ok) pass, count(*) filter (where not ok) fail from r;
rollback;
