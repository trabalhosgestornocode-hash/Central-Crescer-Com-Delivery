-- Transferência/promoção de unidades × Financeiro (120 §5b) — PostgreSQL LOCAL DESCARTÁVEL, banco montado por transferencia_unidades.sh
-- (cadeia da origin/main + 120 → 121 → 122). Roda como superusuário local; as operações de negócio rodam como service_role (o papel do backend).
-- Cada cenário usa organizações/unidades próprias. Saída: uma linha OK/FALHA por verificação e o total no fim.
\set ON_ERROR_STOP 1
\pset tuples_only on
\pset format unaligned
-- TRAVA INLINE: só em banco local descartável criado pelo .sh (nome estrut_*) e sem nenhuma organização anterior aos testes.
do $$ begin
  if current_database() not like 'estrut\_%' or inet_server_addr() is distinct from '127.0.0.1'::inet then
    raise exception 'RECUSADO: este script só roda no banco local descartável estrut_* (127.0.0.1).';
  end if;
  if exists (select 1 from public.organizacoes where nome not like '[TU]%') then
    raise exception 'RECUSADO: o banco tem organizações que não são deste teste.';
  end if;
end $$;

drop schema if exists teste_tu cascade;
create schema teste_tu;
create table teste_tu.resultado (n serial, ok boolean, rotulo text, detalhe text);
grant usage on schema teste_tu to service_role, anon, authenticated, dono_sim;
grant insert, select on teste_tu.resultado to service_role, anon, authenticated, dono_sim;
grant usage on sequence teste_tu.resultado_n_seq to service_role, anon, authenticated, dono_sim;

create function teste_tu.ok(p_cond boolean, p_rotulo text, p_detalhe text default null) returns void language sql as $$
  insert into teste_tu.resultado (ok, rotulo, detalhe) values (coalesce(p_cond, false), p_rotulo, p_detalhe) $$;
-- Executa p_sql; espera erro com p_sqlstate (e, se dado, mensagem contendo p_trecho). Retorna a mensagem obtida.
create function teste_tu.espera_erro(p_sql text, p_sqlstate text, p_trecho text, p_rotulo text) returns text language plpgsql as $$
declare v_estado text; v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_estado = returned_sqlstate, v_msg = message_text;
    perform teste_tu.ok(v_estado = p_sqlstate and (p_trecho is null or v_msg ilike '%' || p_trecho || '%'), p_rotulo, v_estado || ': ' || v_msg);
    return v_msg;
  end;
  perform teste_tu.ok(false, p_rotulo, 'não falhou');
  return null;
end $$;
create function teste_tu.executa(p_sql text, p_rotulo text) returns jsonb language plpgsql as $$
declare v jsonb; v_estado text; v_msg text;
begin
  execute p_sql into v;
  perform teste_tu.ok(true, p_rotulo, left(v::text, 300));
  return v;
exception when others then
  get stacked diagnostics v_estado = returned_sqlstate, v_msg = message_text;
  perform teste_tu.ok(false, p_rotulo, v_estado || ': ' || v_msg);
  return null;
end $$;
grant execute on all functions in schema teste_tu to service_role, anon, authenticated, dono_sim;

-- Fixtures (como superusuário): ator da plataforma, organizações e unidades sintéticas.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000a70a', 'ator-tu@invalid.local') on conflict do nothing;
create function teste_tu.org(p_nome text) returns uuid language sql as $$
  insert into public.organizacoes (nome) values ('[TU] ' || p_nome) returning id $$;
create function teste_tu.unidade(p_org uuid, p_nome text) returns uuid language sql as $$
  insert into public.unidades (organizacao_id, nome) values (p_org, '[TU] ' || p_nome) returning id $$;
create function teste_tu.conta(p_org uuid, p_uni uuid, p_nome text) returns uuid language sql as $$
  insert into public.fin_contas (organizacao_id, unidade_id, nome) values (p_org, p_uni, p_nome) returning id $$;
create function teste_tu.lanc(p_org uuid, p_uni uuid, p_conta uuid, p_sentido text, p_valor bigint) returns uuid language sql as $$
  insert into public.fin_lancamentos (organizacao_id, unidade_id, conta_id, descricao, sentido, valor_centavos, data_movimento, classificacao_pendente)
  values (p_org, p_uni, p_conta, 'teste', p_sentido, p_valor, date '2026-09-10', true) returning id $$;
create function teste_tu.transferir(p_uni uuid, p_org uuid) returns text language sql as $$
  select format('select public.transferir_unidade_organizacao(%L::uuid, %L::uuid, %L::uuid)', p_uni, p_org, '00000000-0000-0000-0000-00000000a70a') $$;
create function teste_tu.promover(p_uni uuid) returns text language sql as $$
  select format('select public.promover_unidade_para_empresa(%L::uuid, %L, %L::uuid)', p_uni, '[TU] promovida', '00000000-0000-0000-0000-00000000a70a') $$;
-- Fotografia do que a unidade tem: organização da unidade + organização de TODA linha (de qualquer tabela) ligada a ela.
create function teste_tu.foto(p_uni uuid) returns jsonb language plpgsql as $$
declare t text; v jsonb := '{}'; x jsonb;
begin
  v := jsonb_build_object('unidades', (select organizacao_id from public.unidades where id = p_uni),
                          'organizacoes', (select count(*) from public.organizacoes),
                          'plataforma_auditoria', (select count(*) from public.plataforma_auditoria),
                          'sessoes_revogadas', (select count(*) from public.sessoes_contexto where unidade_id = p_uni and revogada_em is not null));
  for t in select c1.table_name from information_schema.columns c1
             join information_schema.columns c2 on c2.table_schema = c1.table_schema and c2.table_name = c1.table_name and c2.column_name = 'unidade_id'
             join information_schema.tables tt on tt.table_schema = c1.table_schema and tt.table_name = c1.table_name and tt.table_type = 'BASE TABLE'
            where c1.table_schema = 'public' and c1.column_name = 'organizacao_id' order by 1 loop
    execute format('select jsonb_agg(organizacao_id order by organizacao_id) from public.%I where unidade_id = $1', t) into x using p_uni;
    if x is not null then v := v || jsonb_build_object(t, x); end if;
  end loop;
  return v;
end $$;
grant execute on all functions in schema teste_tu to service_role;
-- Linhas "operacionais" de outros módulos ligadas à unidade (iFood, Checklist/HDMI, sessão): devem SEGUIR a unidade quando ela é transferida.
create function teste_tu.operacional(p_org uuid, p_uni uuid) returns void language plpgsql as $$
begin
  insert into public.dashboard_ifood_unidade_config (organizacao_id, unidade_id) values (p_org, p_uni);
  insert into public.ifood_conexoes (organizacao_id, unidade_id) values (p_org, p_uni);
  insert into public.dispositivos_exibicao (organizacao_id, unidade_id, nome, token_hash, autorizado_por_conta_id, expira_em)
    values (p_org, p_uni, 'TV teste', md5(random()::text) || md5(random()::text), gen_random_uuid(), now() + interval '1 day');
  insert into public.sessoes_contexto (usuario_id, organizacao_id, unidade_id, papel, expira_em, impersonado_por)
    values ('00000000-0000-0000-0000-00000000a70a', p_org, p_uni, 'organization_admin', now() + interval '1 day', '00000000-0000-0000-0000-00000000a70a');
  insert into public.unidade_modulos (unidade_id, modulo_id) values (p_uni, 'gestao_financeira'), (p_uni, 'checklist_operacional') on conflict do nothing;
  insert into public.organizacao_modulos (organizacao_id, modulo_id) values (p_org, 'gestao_financeira') on conflict do nothing;
end $$;

-- =========================================================================================================
-- 0) Estrutura: lista explícita = exatamente as tabelas financeiras com unidade_id; guarda fora do alcance de anon/authenticated
select teste_tu.ok(
  (select array_agg(x order by x) from unnest(public.gestao_financeira_tabelas_da_unidade()) x)
  = (select array_agg(c.relname::text order by c.relname) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
       and (c.relname like 'fin\_%' or c.relname like 'gestao\_financeira\_%')
       and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'unidade_id' and not a.attisdropped)),
  '0.1 lista explícita cobre exatamente as tabelas financeiras com unidade_id');
select teste_tu.ok(not has_function_privilege('anon', 'public.gestao_financeira_verificar_unidade_transferivel(uuid)', 'execute')
               and not has_function_privilege('authenticated', 'public.gestao_financeira_verificar_unidade_transferivel(uuid)', 'execute')
               and not has_function_privilege('anon', 'public.remapear_organizacao_em_tabelas_de_unidade(uuid,uuid,uuid)', 'execute')
               and not has_function_privilege('authenticated', 'public.transferir_unidade_organizacao(uuid,uuid,uuid,text,text,text)', 'execute'),
  '0.2 anon/authenticated não executam guarda, remapeamento nem transferência (fechamento da 115 preservado)');
select teste_tu.ok(has_function_privilege('service_role', 'public.gestao_financeira_verificar_unidade_transferivel(uuid)', 'execute')
               and not (select prosecdef from pg_proc where oid = 'public.remapear_organizacao_em_tabelas_de_unidade(uuid,uuid,uuid)'::regprocedure)
               and not (select prosecdef from pg_proc where oid = 'public.gestao_financeira_verificar_unidade_transferivel(uuid)'::regprocedure),
  '0.3 service_role executa a guarda; remapeamento e guarda continuam SECURITY INVOKER');

-- =========================================================================================================
-- 1) Transferência SEM dados financeiros (com dados operacionais de iFood/Checklist/sessão) — funciona e remapeia como antes
select set_config('tu.a1', teste_tu.org('1 origem')::text, false);
select set_config('tu.b1', teste_tu.org('1 destino')::text, false);
select set_config('tu.u1', teste_tu.unidade(current_setting('tu.a1')::uuid, '1')::text, false);
select teste_tu.operacional(current_setting('tu.a1')::uuid, current_setting('tu.u1')::uuid);
set role service_role;
select set_config('tu.r1', coalesce(teste_tu.executa(teste_tu.transferir(current_setting('tu.u1')::uuid, current_setting('tu.b1')::uuid),
  '1.1 transferência de unidade sem dados financeiros conclui (service_role)')::text, 'null'), false);
reset role;
select teste_tu.ok((select organizacao_id from public.unidades where id = current_setting('tu.u1')::uuid) = current_setting('tu.b1')::uuid, '1.2 unidade passou para a empresa de destino');
select teste_tu.ok(current_setting('tu.r1')::jsonb -> 'tabelasRemapeadas' ?& array['dashboard_ifood_unidade_config', 'ifood_conexoes']
                   and not (current_setting('tu.r1')::jsonb -> 'tabelasRemapeadas' ?| public.gestao_financeira_tabelas_da_unidade()),
  '1.3 iFood/Checklist remapeados; nenhuma tabela financeira na varredura', current_setting('tu.r1')::jsonb ->> 'tabelasRemapeadas');
select teste_tu.ok(not exists (select 1 from public.dashboard_ifood_unidade_config where unidade_id = current_setting('tu.u1')::uuid and organizacao_id <> current_setting('tu.b1')::uuid)
               and not exists (select 1 from public.ifood_conexoes where unidade_id = current_setting('tu.u1')::uuid and organizacao_id <> current_setting('tu.b1')::uuid)
               and not exists (select 1 from public.dispositivos_exibicao where unidade_id = current_setting('tu.u1')::uuid
                                 and (revogado_em is null or motivo_revogacao <> 'unidade_transferida')),
  '1.4 iFood segue a unidade; aparelhos do Checklist (HDMI) revogados com motivo unidade_transferida (gatilho da main, inalterado)');
select teste_tu.ok((select count(*) from public.sessoes_contexto where unidade_id = current_setting('tu.u1')::uuid and revogada_em is not null and motivo_revogacao = 'unidade_transferida') = 1
               and exists (select 1 from public.plataforma_auditoria where acao = 'unidade.transferida_entre_empresas' and entidade_id = current_setting('tu.u1')),
  '1.5 sessões revogadas e auditoria da plataforma gravada (comportamento da 053 mantido)');
select teste_tu.ok((select count(*) from public.unidade_modulos where unidade_id = current_setting('tu.u1')::uuid and modulo_id in ('gestao_financeira', 'checklist_operacional')) = 2,
  '1.6 "só configuração": módulos habilitados na unidade (Financeiro e Checklist) permanecem; não bloqueiam');
-- Depois da transferência, o Financeiro só aceita a empresa NOVA para a unidade
set role service_role;
select teste_tu.espera_erro(format('select teste_tu.conta(%L::uuid, %L::uuid, %L)', current_setting('tu.a1'), current_setting('tu.u1'), 'conta antiga'),
  '23514', 'unidade nao pertence', '1.7 conta financeira com a empresa ANTIGA é recusada depois da transferência');
select teste_tu.executa(format('select to_jsonb(teste_tu.conta(%L::uuid, %L::uuid, %L))', current_setting('tu.b1'), current_setting('tu.u1'), 'conta nova'),
  '1.8 conta financeira com a empresa NOVA é aceita');
reset role;

-- =========================================================================================================
-- 2) Promoção SEM dados financeiros — funciona; a unidade vira empresa própria com o catálogo clonado
select set_config('tu.a2', teste_tu.org('2 mae')::text, false);
select set_config('tu.u2', teste_tu.unidade(current_setting('tu.a2')::uuid, '2')::text, false);
select teste_tu.operacional(current_setting('tu.a2')::uuid, current_setting('tu.u2')::uuid);
-- DEFEITO PRÉ-EXISTENTE DA MAIN (independe do Financeiro): a 063 trocou unique (usuario_id, organizacao_id) por (perfil_id, organizacao_id), mas
-- promover_unidade_para_empresa ainda faz `on conflict (usuario_id, organizacao_id)` ⇒ 42P10 em TODA promoção. O .sh mostra o mesmo erro sem 120–122.
set role service_role;
select teste_tu.espera_erro(teste_tu.promover(current_setting('tu.u2')::uuid), '42P10', 'ON CONFLICT', '2.0 [pré-existente na main] promoção falha com 42P10 (ON CONFLICT sem constraint)');
reset role;
-- Só NESTE banco de teste: índice temporário que devolve a constraint que a 053 esperava, para exercitar o resto da promoção.
create unique index teste_tu_contorno_063 on public.usuarios_organizacoes (usuario_id, organizacao_id);
set role service_role;
select set_config('tu.r2', coalesce(teste_tu.executa(teste_tu.promover(current_setting('tu.u2')::uuid), '2.1 promoção de unidade sem dados financeiros conclui (com o contorno local da 063)')::text, 'null'), false);
reset role;
select teste_tu.ok((select organizacao_id from public.unidades where id = current_setting('tu.u2')::uuid) <> current_setting('tu.a2')::uuid
               and not exists (select 1 from public.ifood_conexoes where unidade_id = current_setting('tu.u2')::uuid and organizacao_id = current_setting('tu.a2')::uuid),
  '2.2 unidade e linhas operacionais foram para a empresa nova', current_setting('tu.r2'));
select teste_tu.ok(exists (select 1 from public.organizacao_modulos om join public.unidades u on u.organizacao_id = om.organizacao_id
                            where u.id = current_setting('tu.u2')::uuid and om.modulo_id = 'gestao_financeira'),
  '2.3 empresa nova herda os módulos da mãe (comportamento da 053), inclusive o Financeiro habilitado');

-- =========================================================================================================
-- 3–7) BLOQUEIOS: cada cenário tem só UM tipo de registro financeiro; a transferência e a promoção são recusadas e nada muda
create function teste_tu.cenario_bloqueado(p_rotulo text, p_tipo text, p_trecho text) returns void language plpgsql as $$
declare a uuid := teste_tu.org(p_rotulo || ' origem'); b uuid := teste_tu.org(p_rotulo || ' destino'); u uuid := teste_tu.unidade(a, p_rotulo);
        c1 uuid; c2 uuid; l1 uuid; l2 uuid; cat uuid; pf uuid; f0 jsonb; f1 jsonb;
begin
  perform teste_tu.operacional(a, u);
  if p_tipo = 'lancamentos' then
    c1 := teste_tu.conta(a, u, 'c'); perform teste_tu.lanc(a, u, c1, 'entrada', 100);
  elsif p_tipo = 'transferencias' then
    -- sem gatilhos: isola a tabela de transferências (sem lançamentos/contas/auditoria contando junto)
    set local session_replication_role = replica;
    c1 := gen_random_uuid(); c2 := gen_random_uuid(); l1 := gen_random_uuid(); l2 := gen_random_uuid();
    insert into public.fin_transferencias (organizacao_id, unidade_id, lancamento_saida_id, lancamento_entrada_id) values (a, u, l1, l2);
    set local session_replication_role = origin;
  elsif p_tipo = 'periodo_fechado' then
    set local session_replication_role = replica;
    insert into public.fin_periodos (organizacao_id, unidade_id, mes, status, fechado_em) values (a, u, date '2026-08-01', 'fechado', now());
    set local session_replication_role = origin;
  elsif p_tipo = 'auditoria' then
    insert into public.fin_auditoria (organizacao_id, unidade_id, acao, entidade) values (a, u, 'teste.historico', 'fin_lancamentos');
  elsif p_tipo = 'so_conta' then
    c1 := teste_tu.conta(a, u, 'só uma conta, nenhum lançamento');
  elsif p_tipo = 'so_sangria' then
    set local session_replication_role = replica;
    insert into public.fin_plano_contas (organizacao_id, tipo, natureza, nome, papel) values (a, 'despesa', 'saida', 'Sangria', 'despesa_variavel') returning id into cat;
    insert into public.fin_sangria_excecoes (organizacao_id, unidade_id, categoria_id, motivo, aprovada_por) values (a, u, cat, 'motivo de teste', gen_random_uuid());
    set local session_replication_role = origin;
  elsif p_tipo = 'so_concessao_revogada' then
    set local session_replication_role = replica;
    insert into public.gestao_financeira_concessoes (organizacao_id, unidade_id, perfil_id, nivel, concedida_por, motivo, revogada_em, revogada_por, motivo_revogacao)
      values (a, u, gen_random_uuid(), 'leitura', gen_random_uuid(), 'concessão de teste', now(), gen_random_uuid(), 'revogada no teste');
    set local session_replication_role = origin;
  end if;
  f0 := teste_tu.foto(u);
  execute 'set local role service_role';
  perform teste_tu.espera_erro(teste_tu.transferir(u, b), '22023', p_trecho, p_rotulo || '.a transferência recusada (22023, mensagem clara)');
  perform teste_tu.espera_erro(teste_tu.promover(u), '22023', p_trecho, p_rotulo || '.b promoção recusada (22023, mensagem clara)');
  execute 'reset role';
  f1 := teste_tu.foto(u);
  perform teste_tu.ok(f0 = f1, p_rotulo || '.c nada mudou: unidade, linhas financeiras e operacionais, sessões, auditoria e organizações',
                      case when f0 <> f1 then f0::text || ' ≠ ' || f1::text end);
end $$;
-- (o contorno da 063 continua ativo: as promoções abaixo chegam até a guarda, em vez de pararem no 42P10)
select teste_tu.cenario_bloqueado('3 lançamentos', 'lancamentos', 'lançamentos: 1');
select teste_tu.ok((select count(*) from public.fin_auditoria a join public.fin_lancamentos l on l.unidade_id = a.unidade_id
                     join public.unidades u on u.id = l.unidade_id where u.nome = '[TU] 3 lançamentos') > 0,
  '3.d a mensagem do cenário 3 também conta a auditoria gerada pelos gatilhos (conta + lançamento)');
select teste_tu.cenario_bloqueado('4 transferências', 'transferencias', 'transferências: 1');
select teste_tu.cenario_bloqueado('5 período fechado', 'periodo_fechado', 'períodos: 1');
select teste_tu.cenario_bloqueado('6 auditoria', 'auditoria', 'auditoria financeira: 1');
-- 7) "Apenas configuração": conta sem lançamento, exceção de sangria, concessão (mesmo revogada) — todas já são histórico/vínculo do tenant
select teste_tu.cenario_bloqueado('7a só conta', 'so_conta', 'contas: 1, auditoria financeira: 1');
select teste_tu.cenario_bloqueado('7b só exceção de sangria', 'so_sangria', 'exceções de sangria: 1');
select teste_tu.cenario_bloqueado('7c só concessão revogada', 'so_concessao_revogada', 'concessões de acesso: 1');

-- =========================================================================================================
-- 8) Tentativas entre organizações
select set_config('tu.a8', teste_tu.org('8 A')::text, false);
select set_config('tu.b8', teste_tu.org('8 B')::text, false);
select set_config('tu.ua8', teste_tu.unidade(current_setting('tu.a8')::uuid, '8 A')::text, false);
select set_config('tu.ub8', teste_tu.unidade(current_setting('tu.b8')::uuid, '8 B')::text, false);
select set_config('tu.ca8', teste_tu.conta(current_setting('tu.a8')::uuid, current_setting('tu.ua8')::uuid, 'conta A')::text, false);
set role service_role;
select teste_tu.espera_erro(format('select teste_tu.lanc(%L::uuid, %L::uuid, %L::uuid, %L, 1)', current_setting('tu.b8'), current_setting('tu.ub8'), current_setting('tu.ca8'), 'entrada'),
  '23514', 'conta de outro tenant', '8.1 lançamento da empresa B não usa conta da empresa A');
select teste_tu.espera_erro(format('select teste_tu.lanc(%L::uuid, %L::uuid, %L::uuid, %L, 1)', current_setting('tu.b8'), current_setting('tu.ua8'), current_setting('tu.ca8'), 'entrada'),
  '23514', 'unidade nao pertence', '8.2 empresa B não grava em unidade da empresa A');
select teste_tu.espera_erro(format('update public.fin_contas set organizacao_id = %L where id = %L', current_setting('tu.b8'), current_setting('tu.ca8')),
  '23514', null, '8.3 UPDATE direto da empresa de uma conta financeira é recusado');
select teste_tu.espera_erro(format('update public.fin_auditoria set organizacao_id = %L where unidade_id = %L', current_setting('tu.b8'), current_setting('tu.ua8')),
  '42501', null, '8.4 service_role não altera a auditoria financeira');
select teste_tu.espera_erro(format('select public.remapear_organizacao_em_tabelas_de_unidade(%L, %L, %L)', current_setting('tu.ua8'), current_setting('tu.a8'), current_setting('tu.b8')),
  '22023', 'contas: 1', '8.5 chamada DIRETA do remapeamento (sem passar pela transferência) também é recusada');
reset role;
set role anon;
select teste_tu.espera_erro(teste_tu.transferir(current_setting('tu.ua8')::uuid, current_setting('tu.b8')::uuid), '42501', null, '8.6 anon não executa a transferência');
select teste_tu.espera_erro(format('select public.gestao_financeira_verificar_unidade_transferivel(%L)', current_setting('tu.ua8')), '42501', null, '8.7 anon não executa a guarda');
reset role;
set role authenticated;
select teste_tu.espera_erro(format('select public.remapear_organizacao_em_tabelas_de_unidade(%L, %L, %L)', current_setting('tu.ub8'), current_setting('tu.b8'), current_setting('tu.a8')),
  '42501', null, '8.8 authenticated não executa o remapeamento');
reset role;
select teste_tu.ok(not exists (select 1 from public.fin_contas c join public.unidades u on u.id = c.unidade_id where c.organizacao_id <> u.organizacao_id)
               and not exists (select 1 from public.fin_lancamentos l join public.unidades u on u.id = l.unidade_id where l.organizacao_id <> u.organizacao_id),
  '8.9 nenhuma linha financeira (contas/lançamentos) com empresa diferente da empresa atual da unidade, em todo o banco');
-- 8.10–8.13 UPDATE GENÉRICO direto em unidades.organizacao_id (sem passar pelas RPCs): o histórico financeiro não pode ficar órfão na
-- empresa antiga. Antes do gatilho em unidades (A2, 2026-10-19) o UPDATE passava e a unidade ia para B com as linhas financeiras em A.
set role service_role;
select teste_tu.espera_erro(format('update public.unidades set organizacao_id = %L where id = %L', current_setting('tu.b8'), current_setting('tu.ua8')),
  '22023', 'contas: 1', '8.10 UPDATE direto da empresa de uma unidade COM histórico financeiro é recusado');
reset role;
select set_config('tu.ux8', teste_tu.unidade(current_setting('tu.a8')::uuid, '8 X sem financeiro')::text, false);
set role service_role;
select teste_tu.executa(format('update public.unidades set organizacao_id = %L where id = %L returning jsonb_build_object(''org'', organizacao_id)', current_setting('tu.b8'), current_setting('tu.ux8')),
  '8.11 UPDATE direto da empresa de unidade SEM histórico financeiro continua permitido');
select teste_tu.executa(format('update public.unidades set nome = nome where id = %L returning jsonb_build_object(''ok'', true)', current_setting('tu.ua8')),
  '8.12 UPDATE de outras colunas da unidade com histórico continua permitido');
reset role;
select teste_tu.ok((select organizacao_id from public.unidades where id = current_setting('tu.ua8')::uuid) = current_setting('tu.a8')::uuid
               and (select organizacao_id from public.unidades where id = current_setting('tu.ux8')::uuid) = current_setting('tu.b8')::uuid,
  '8.13 a unidade com histórico continua na empresa original; a sem histórico mudou');

-- =========================================================================================================
-- 10b) Falha segura da guarda
set role service_role;
begin isolation level repeatable read;
select teste_tu.espera_erro(teste_tu.transferir(current_setting('tu.ub8')::uuid, current_setting('tu.a8')::uuid), '25001', 'READ COMMITTED', '10b.1 REPEATABLE READ é recusado (a contagem exige snapshot novo)');
commit;
reset role;
set role dono_sim;
-- dono_sim: dono das tabelas, sem BYPASSRLS; gestao_financeira_concessoes tem FORCE RLS ⇒ não lê tudo ⇒ a guarda recusa em vez de concluir "vazio"
select teste_tu.espera_erro(format('select public.gestao_financeira_verificar_unidade_transferivel(%L)', current_setting('tu.ub8')), '42501', 'por inteiro',
  '10b.2 papel sujeito a RLS não conclui "sem histórico": falha fechado');
reset role;
select teste_tu.ok((select organizacao_id from public.unidades where id = current_setting('tu.ub8')::uuid) = current_setting('tu.b8')::uuid, '10b.3 unidade intacta após as recusas');

-- =========================================================================================================
drop index public.teste_tu_contorno_063;
\echo ====RESULTADO====
select format('%s %s%s', case when ok then 'OK   ' else 'FALHA' end, rotulo, case when not ok or detalhe is not null and rotulo like '1.3%' then '  [' || coalesce(detalhe, '') || ']' else '' end)
  from teste_tu.resultado order by n;
select format('TOTAL: %s verificações, %s falhas', count(*), count(*) filter (where not ok)) from teste_tu.resultado;
