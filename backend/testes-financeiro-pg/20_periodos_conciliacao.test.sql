-- Testes (B7/B8) em banco DESCARTÁVEL. Dados 100% sintéticos. Cada bloco levanta exceção se a expectativa falhar.
\set ON_ERROR_STOP on
begin;

create temp table ctx as
select gen_random_uuid() org1, gen_random_uuid() org2, gen_random_uuid() u1, gen_random_uuid() u2, gen_random_uuid() u3, gen_random_uuid() usr;
insert into organizacoes (id, nome) select org1, 'Org 1' from ctx union all select org2, 'Org 2' from ctx;
insert into unidades (id, organizacao_id, nome) select u1, org1, 'U1' from ctx union all select u2, org1, 'U2' from ctx union all select u3, org2, 'U3' from ctx;
do $$
declare c ctx;
begin
  select * into c from ctx;
  insert into fin_plano_contas (organizacao_id, tipo, natureza, nome, papel) values
    (c.org1, 'RECEITA', 'R', 'VENDAS', 'receita_operacional'), (c.org1, 'DESPESA', 'FIXA', 'ALUGUEL', 'despesa_fixa');
  insert into fin_contas (organizacao_id, unidade_id, nome, tipo_conta, canal_referencia) values
    (c.org1, c.u1, 'BANCO', 'banco', null), (c.org1, c.u1, 'CAIXA', 'caixa_fisico', null), (c.org1, c.u1, 'STONE', 'adquirente', 'STONE');
end $$;

-- helpers
create function pg_temp.lanc(p_unidade uuid, p_conta text, p_cat text, p_sentido text, p_valor bigint, p_data date, p_pend boolean default false) returns uuid language plpgsql as $$
declare c ctx; v_id uuid;
begin
  select * into c from ctx;
  insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, categoria_id, descricao, sentido, valor_centavos, data_movimento, classificacao_pendente)
  values (c.org1, p_unidade, (select x.id from fin_contas x where x.unidade_id = p_unidade and x.nome = p_conta),
          (select p.id from fin_plano_contas p where p.organizacao_id = c.org1 and p.nome = p_cat), 'l', p_sentido, p_valor, p_data, p_pend) returning fin_lancamentos.id into v_id;
  return v_id;
end $$;

create function pg_temp.mfa(p_idade interval default interval '0') returns jsonb language sql as $$ select jsonb_build_object('aal', 'aal2', 'em', to_char((now() - p_idade) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) $$;

-- 1) abrir período é idempotente; mês inválido recusado; outro tenant não enxerga
do $$
declare c ctx; a jsonb; b jsonb; ok boolean := false;
begin
  select * into c from ctx;
  a := fin_abrir_periodo(c.org1, c.u1, c.usr, '2026-09-01');
  b := fin_abrir_periodo(c.org1, c.u1, c.usr, '2026-09-01');
  if a->>'id' <> b->>'id' or a->>'status' <> 'aberto' then raise exception 'FALHA 1a'; end if;
  begin perform fin_abrir_periodo(c.org1, c.u1, c.usr, '2026-09-15'); exception when sqlstate '23514' then ok := true; end;
  if not ok then raise exception 'FALHA 1b: aceitou mes que nao e o dia 1'; end if;
  ok := false;
  begin perform fin_abrir_periodo(c.org2, c.u1, c.usr, '2026-10-01'); exception when sqlstate '23514' then ok := true; end;   -- unidade da outra organização
  if not ok then raise exception 'FALHA 1c: abriu periodo com unidade de outra organizacao'; end if;
end $$;

-- 2) fechamento: snapshot, responsável e data; bloqueia escrita; reabertura exige motivo; snapshot imutável; auditoria
do $$
declare c ctx; fp text; per jsonb; ok1 boolean := false; ok2 boolean := false; ok3 boolean := false; ok4 boolean := false; n int;
begin
  select * into c from ctx;
  perform pg_temp.lanc(c.u1, 'BANCO', 'VENDAS', 'entrada', 100000, '2026-09-02');
  fp := fin_fingerprint_periodo(c.org1, c.u1, '2026-09-01');
  per := fin_fechar_periodo(c.org1, c.u1, c.usr, '2026-09-01', (fin_abrir_periodo(c.org1, c.u1, c.usr, '2026-09-01')->>'versao')::int, fp, '{"resultado": 100000}', '{}'::text[], false);
  if per->>'status' <> 'fechado' or per->>'fechado_por' is null or per->'snapshot'->>'resultado' <> '100000' then raise exception 'FALHA 2a: %', per; end if;
  if (per->'snapshot'->>'fingerprint') <> fp then raise exception 'FALHA 2a2: fingerprint nao gravado'; end if;
  begin perform pg_temp.lanc(c.u1, 'BANCO', 'VENDAS', 'entrada', 1, '2026-09-03'); exception when sqlstate '23514' then ok1 := true; end;
  begin update fin_lancamentos set descricao = 'x' where data_movimento = '2026-09-02' and unidade_id = c.u1; exception when sqlstate '23514' then ok2 := true; end;
  if not (ok1 and ok2) then raise exception 'FALHA 2b: escreveu em mes fechado (% %)', ok1, ok2; end if;
  begin update fin_periodos set snapshot = '{"resultado": 1}' where unidade_id = c.u1 and mes = '2026-09-01'; exception when sqlstate '23514' then ok3 := true; end;
  if not ok3 then raise exception 'FALHA 2c: snapshot mutavel'; end if;
  begin update fin_periodos set status = 'aberto' where unidade_id = c.u1 and mes = '2026-09-01'; exception when sqlstate '23514' then ok4 := true; end;
  if not ok4 then raise exception 'FALHA 2d: reabriu sem a funcao'; end if;
  -- outro mês da mesma unidade segue aberto
  perform pg_temp.lanc(c.u1, 'BANCO', 'VENDAS', 'entrada', 5, '2026-10-02');
  -- reabertura exige motivo, versão correta e período fechado
  ok1 := false; ok2 := false; ok3 := false;
  begin perform fin_reabrir_periodo(c.org1, c.u1, c.usr, '2026-09-01', (per->>'versao')::int, 'curto'); exception when sqlstate '23514' then ok1 := true; end;
  begin perform fin_reabrir_periodo(c.org1, c.u1, c.usr, '2026-09-01', 999, 'motivo suficientemente longo'); exception when sqlstate '23514' then ok2 := true; end;
  begin perform fin_reabrir_periodo(c.org1, c.u1, c.usr, '2026-10-01', 1, 'motivo suficientemente longo'); exception when sqlstate '23514' then ok3 := true; end;
  if not (ok1 and ok2 and ok3) then raise exception 'FALHA 2e: reabertura aceitou entrada invalida (% % %)', ok1, ok2, ok3; end if;
  -- REABERTURA DESABILITADA NO BANCO: mesmo a função (executada pelo dono) é barrada pelo gatilho enquanto a flag não for autorizada
  ok1 := false;
  begin perform fin_reabrir_periodo(c.org1, c.u1, c.usr, '2026-09-01', (per->>'versao')::int, 'correcao de classificacao aprovada'); exception when sqlstate '23514' then ok1 := (sqlerrm like 'fin_reabertura_desabilitada%'); end;
  if not ok1 then raise exception 'FALHA 2e2: reabertura funcionou sem a flag de autorizacao'; end if;
  ok1 := false;
  begin update fin_periodos set status = 'reaberto', reaberto_por = c.usr, reaberto_em = now(), motivo_reabertura = 'tentativa direta de reabertura' where unidade_id = c.u1 and mes = '2026-09-01'; exception when sqlstate '23514' then ok1 := (sqlerrm like 'fin_reabertura_desabilitada%'); end;
  if not ok1 then raise exception 'FALHA 2e3: UPDATE direto reabriu o mes'; end if;
  if has_function_privilege('service_role', 'fin_reabrir_periodo(uuid,uuid,uuid,date,int,text)', 'execute') then raise exception 'FALHA 2e4: service_role executa a reabertura'; end if;
  -- Comportamento FUTURO (só quando a política for aprovada e a função passar a setar a flag): aqui a flag é setada à mão para provar que o resto do fluxo funciona.
  perform set_config('fin.reabertura_autorizada', (select id::text from fin_periodos where unidade_id = c.u1 and mes = '2026-09-01'), true);
  per := fin_reabrir_periodo(c.org1, c.u1, c.usr, '2026-09-01', (per->>'versao')::int, 'correcao de classificacao aprovada');
  perform set_config('fin.reabertura_autorizada', '', true);
  if per->>'status' <> 'reaberto' or per->>'reaberto_por' is null or per->>'motivo_reabertura' is null then raise exception 'FALHA 2f: %', per; end if;
  perform pg_temp.lanc(c.u1, 'BANCO', 'VENDAS', 'entrada', 7, '2026-09-04');   -- reaberto aceita escrita
  select count(*) into n from fin_auditoria where entidade = 'fin_periodos' and acao = 'fin_periodos.update';
  if n < 2 then raise exception 'FALHA 2g: auditoria de fechamento/reabertura ausente (%)', n; end if;
  if not exists (select 1 from fin_auditoria where entidade = 'fin_periodos' and depois->>'status' = 'fechado' and antes->>'status' <> 'fechado') then raise exception 'FALHA 2h: auditoria sem antes/depois'; end if;
end $$;

-- 3) concorrência: versão desatualizada e conteúdo alterado desde a impressão são recusados
do $$
declare c ctx; fp text; v int; ok1 boolean := false; ok2 boolean := false; per jsonb;
begin
  select * into c from ctx;
  per := fin_abrir_periodo(c.org1, c.u1, c.usr, '2026-11-01');
  v := (per->>'versao')::int;
  perform pg_temp.lanc(c.u1, 'BANCO', 'VENDAS', 'entrada', 1000, '2026-11-02');
  fp := fin_fingerprint_periodo(c.org1, c.u1, '2026-11-01');
  perform pg_temp.lanc(c.u1, 'BANCO', 'VENDAS', 'entrada', 2000, '2026-11-03');   -- alteração depois da impressão
  begin perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2026-11-01', (select versao from fin_periodos where unidade_id = c.u1 and mes = '2026-11-01'), fp, '{}', '{}'::text[], false);
  exception when sqlstate '23514' then ok1 := (sqlerrm like 'fin_periodo_conflito_dados%'); end;
  begin perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2026-11-01', v + 50, fin_fingerprint_periodo(c.org1, c.u1, '2026-11-01'), '{}', '{}'::text[], false);
  exception when sqlstate '23514' then ok2 := (sqlerrm like 'fin_periodo_conflito_versao%'); end;
  if not (ok1 and ok2) then raise exception 'FALHA 3: conflitos nao detectados (% %)', ok1, ok2; end if;
  if (select status from fin_periodos where unidade_id = c.u1 and mes = '2026-11-01') <> 'aberto' then raise exception 'FALHA 3b: fechou apesar do conflito'; end if;
end $$;

-- 4) pendências impedem o fechamento; política só vale aprovada e com reconhecimento explícito
do $$
declare c ctx; v int; fp text; ok1 boolean := false; ok2 boolean := false; ok3 boolean := false; per jsonb;
begin
  select * into c from ctx;
  perform pg_temp.lanc(c.u1, 'BANCO', 'VENDAS', 'entrada', 1000, '2026-12-02', true);
  v := (fin_abrir_periodo(c.org1, c.u1, c.usr, '2026-12-01')->>'versao')::int;
  fp := fin_fingerprint_periodo(c.org1, c.u1, '2026-12-01');
  begin perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2026-12-01', v, fp, '{}', '{}'::text[], true); exception when sqlstate '23514' then ok1 := (sqlerrm like 'fin_periodo_pendencias:%'); end;
  -- pendência da conciliação (informada pelo backend) também impede
  perform pg_temp.lanc(c.u1, 'BANCO', 'VENDAS', 'entrada', 1, '2027-01-02');
  begin perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2027-01-01', (fin_abrir_periodo(c.org1, c.u1, c.usr, '2027-01-01')->>'versao')::int, fin_fingerprint_periodo(c.org1, c.u1, '2027-01-01'), '{}', array['caixa_dia:2030-01-01', 'caixa_dia:2030-01-02'], false);
  exception when sqlstate '23514' then ok2 := (sqlerrm like 'fin_periodo_pendencias:%'); end;
  if not (ok1 and ok2) then raise exception 'FALHA 4a: fechou com pendencias (% %)', ok1, ok2; end if;
  -- NÃO existe política geral: a tabela fin_config não existe mais
  if to_regclass('public.fin_config') is not null then raise exception 'FALHA 4b: fin_config nao deveria existir'; end if;
end $$;

-- 4') EXCEÇÃO por unidade + competência (LD-007): concedida só por função (SuperAdmin), uso único, cobre só o que foi identificado no ato
do $$
declare c ctx; v int; fp text; ok boolean; per jsonb; ex jsonb; novo uuid; ex2 jsonb; n int; msg text;
begin
  select * into c from ctx;
  -- 4b) validações da concessão
  ok := false; begin perform fin_conceder_excecao_fechamento(c.org1, c.u1, c.usr, '2026-12-01', 'curta', 7, '{}'::text[], pg_temp.mfa()); exception when sqlstate '23514' then ok := (sqlerrm like 'fin_excecao_justificativa_obrigatoria%'); end;
  if not ok then raise exception 'FALHA 4b1: aceitou justificativa curta'; end if;
  ok := false; begin perform fin_conceder_excecao_fechamento(c.org1, c.u1, c.usr, '2026-12-01', 'justificativa suficientemente longa', 31, '{}'::text[], pg_temp.mfa()); exception when sqlstate '23514' then ok := (sqlerrm like 'fin_excecao_validade_invalida%'); end;
  if not ok then raise exception 'FALHA 4b2: aceitou validade > 30 dias (excecao permanente)'; end if;
  ok := false; begin perform fin_conceder_excecao_fechamento(c.org1, c.u1, c.usr, '2026-12-01', 'justificativa suficientemente longa', 0, '{}'::text[], pg_temp.mfa()); exception when sqlstate '23514' then ok := true; end;
  if not ok then raise exception 'FALHA 4b3: aceitou validade 0'; end if;
  ok := false; begin perform fin_conceder_excecao_fechamento(c.org1, c.u1, null, '2026-12-01', 'justificativa suficientemente longa', 7, '{}'::text[], pg_temp.mfa()); exception when sqlstate '23514' then ok := true; end;
  if not ok then raise exception 'FALHA 4b4: aceitou sem responsavel'; end if;
  ok := false; begin perform fin_conceder_excecao_fechamento(c.org1, c.u1, c.usr, '2027-02-01', 'justificativa suficientemente longa', 7, '{}'::text[], pg_temp.mfa()); exception when sqlstate '23514' then ok := (sqlerrm like 'fin_excecao_sem_pendencias%'); end;
  if not ok then raise exception 'FALHA 4b5: concedeu excecao sem pendencia'; end if;
  ok := false; begin perform fin_conceder_excecao_fechamento(c.org1, c.u3, c.usr, '2026-12-01', 'justificativa suficientemente longa', 7, array['caixa_dia:2030-01-01'], pg_temp.mfa()); exception when sqlstate '23514' then ok := true; end;   -- unidade de outra organização
  if not ok then raise exception 'FALHA 4b6: concedeu excecao para unidade de outra organizacao'; end if;
  -- JANELA DE 10 MIN (decisão do usuário, LD-009): 9 min 59 s aceita; 10 min 1 s recusa; futuro além de 60 s recusa; sem MFA/AAL1/sem 'em' recusa
  ok := false; begin perform fin_conceder_excecao_fechamento(c.org1, c.u1, c.usr, '2026-12-01', 'justificativa suficientemente longa', 7, '{}'::text[], pg_temp.mfa(interval '10 minutes 1 second')); exception when sqlstate '23514' then ok := (sqlerrm like 'fin_excecao_mfa_invalida%'); end;
  if not ok then raise exception 'FALHA 4b7: aceitou MFA com mais de 10 min'; end if;
  ok := false; begin perform fin_conceder_excecao_fechamento(c.org1, c.u1, c.usr, '2026-12-01', 'justificativa suficientemente longa', 7, '{}'::text[], pg_temp.mfa(interval '-61 seconds')); exception when sqlstate '23514' then ok := (sqlerrm like 'fin_excecao_mfa_invalida%'); end;
  if not ok then raise exception 'FALHA 4b8: aceitou MFA do futuro'; end if;
  foreach msg in array array['null', '{"aal":"aal1","em":"2026-10-17T13:40:00Z"}', '{"aal":"aal2"}', '{"aal":"aal2","em":1760000000000}', '{"aal":"aal2","em":"hoje"}'] loop
    ok := false;
    begin perform fin_conceder_excecao_fechamento(c.org1, c.u1, c.usr, '2026-12-01', 'justificativa suficientemente longa', 7, '{}'::text[], case msg when 'null' then null else msg::jsonb end);
    exception when sqlstate '23514' then ok := (sqlerrm like 'fin_excecao_mfa_invalida%'); end;
    if not ok then raise exception 'FALHA 4b9: concedeu excecao sem MFA valido (%)', msg; end if;
  end loop;
  -- lista FECHADA de chaves e nada com cara de token: chave extra, jwt em qualquer lugar, sessao_ref cru, metodo desconhecido
  foreach msg in array array[
      'x1|"extra":"valor"',
      'x2|"metodo":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.assinaturaassinatura"',
      'x3|"sessao_ref":"0f3c2a77-aaaa-bbbb-cccc-1234567890ab"',
      'x4|"sessao_ref":"abc.def.ghi"',
      'x5|"metodo":"sms"',
      'x6|"jwt":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.assinaturaassinatura"'] loop
    ok := false;
    begin perform fin_conceder_excecao_fechamento(c.org1, c.u1, c.usr, '2026-12-01', 'justificativa suficientemente longa', 7, '{}'::text[],
            (replace(pg_temp.mfa()::text, '}', ',' || split_part(msg, '|', 2) || '}'))::jsonb);
    exception when sqlstate '23514' then ok := (sqlerrm like 'fin_excecao_mfa_invalida%'); end;
    if not ok then raise exception 'FALHA 4b10: evidencia fora da lista permitida aceita (%)', split_part(msg, '|', 1); end if;
  end loop;
  -- o CHECK da tabela recusa o mesmo, mesmo contornando a função (dono + flag)
  ok := false;
  begin
    perform set_config('fin.excecao_op', 'conceder', true);
    insert into fin_excecoes_fechamento (organizacao_id, unidade_id, mes, justificativa, pendencias, pendencias_hash, quantidade, aprovada_por, mfa_evidencia, expira_em)
    values (c.org1, c.u1, '2026-12-01', 'justificativa suficientemente longa', '[{"id":"x"}]', repeat('0', 64), 1, c.usr, '{"aal":"aal2","em":"2026-10-17T13:40:00Z","token":"abc"}', now() + interval '3 days');
  exception when check_violation then ok := true; end;
  perform set_config('fin.excecao_op', '', true);
  if not ok then raise exception 'FALHA 4b11: CHECK da evidencia nao barrou chave extra'; end if;
  -- 4c) ninguém escreve na tabela por fora das funções
  ok := false; begin insert into fin_excecoes_fechamento (organizacao_id, unidade_id, mes, justificativa, pendencias, pendencias_hash, quantidade, aprovada_por, expira_em)
    values (c.org1, c.u1, '2026-12-01', 'justificativa suficientemente longa', '[{"id":"x"}]', repeat('0', 64), 1, c.usr, now() + interval '3 days'); exception when sqlstate '23514' then ok := (sqlerrm like 'fin_excecao_via_funcao%'); end;
  if not ok then raise exception 'FALHA 4c1: INSERT direto aceito'; end if;
  -- 4d) concede (nada nas pendências muda) e prova que as pendências foram IDENTIFICADAS
  select count(*) into n from fin_lancamentos where unidade_id = c.u1 and data_movimento >= '2026-12-01' and data_movimento < '2027-01-01' and classificacao_pendente;
  ex := fin_conceder_excecao_fechamento(c.org1, c.u1, c.usr, '2026-12-01', 'justificativa: aguardando extrato do banco para classificar', 7, '{}'::text[], pg_temp.mfa(interval '9 minutes 59 seconds') || jsonb_build_object('metodo', 'totp', 'sessao_ref', encode(sha256(convert_to('sessao-sintetica', 'UTF8')), 'hex')));
  if ex->>'status' <> 'ativa' or (ex->>'quantidade')::int <> 1 or jsonb_array_length(ex->'pendencias') <> 1 or (ex->'pendencias'->0->>'id') is null then raise exception 'FALHA 4d1: %', ex; end if;
if ex->'mfa_evidencia'->>'aal' <> 'aal2' or ex->'mfa_evidencia'->>'metodo' <> 'totp' or length(ex->'mfa_evidencia'->>'sessao_ref') <> 64 or ex->>'aprovada_por' is null or (ex->>'expira_em')::timestamptz > now() + interval '7 days 1 minute' or (ex->>'expira_em')::timestamptz < now() + interval '6 days' then raise exception 'FALHA 4d1b: evidencia de MFA/aprovador/validade ausentes'; end if;  ok := false; begin update fin_excecoes_fechamento set mfa_evidencia = '{"aal":"aal2","em":"2020-01-01T00:00:00Z"}' where id = (ex->>'id')::uuid; exception when sqlstate '23514' then ok := true; end;  if not ok then raise exception 'FALHA 4d1c: evidencia de MFA mutavel'; end if;
  if (select count(*) from fin_lancamentos where unidade_id = c.u1 and data_movimento >= '2026-12-01' and data_movimento < '2027-01-01' and classificacao_pendente) <> n then raise exception 'FALHA 4d2: conceder alterou pendencias'; end if;
  ok := false; begin perform fin_conceder_excecao_fechamento(c.org1, c.u1, c.usr, '2026-12-01', 'segunda excecao para o mesmo mes e unidade', 7, '{}'::text[], pg_temp.mfa()); exception when unique_violation then ok := true; end;
  if not ok then raise exception 'FALHA 4d3: duas excecoes ativas para a mesma competencia'; end if;
  -- imutável: conteúdo, apagar, reclassificar
  ok := false; begin update fin_excecoes_fechamento set justificativa = 'justificativa alterada depois de concedida' where id = (ex->>'id')::uuid; exception when sqlstate '23514' then ok := true; end;
  if not ok then raise exception 'FALHA 4d4: justificativa mutavel'; end if;
  ok := false; begin update fin_excecoes_fechamento set expira_em = expira_em + interval '20 days' where id = (ex->>'id')::uuid; exception when sqlstate '23514' then ok := true; end;
  if not ok then raise exception 'FALHA 4d5: validade prorrogavel por UPDATE'; end if;
  ok := false; begin update fin_excecoes_fechamento set status = 'consumida', consumida_por = c.usr, consumida_em = now() where id = (ex->>'id')::uuid; exception when sqlstate '23514' then ok := true; end;
  if not ok then raise exception 'FALHA 4d6: consumo por UPDATE direto'; end if;
  ok := false; begin delete from fin_excecoes_fechamento where id = (ex->>'id')::uuid; exception when sqlstate '23514' then ok := true; end;
  if not ok then raise exception 'FALHA 4d7: excecao apagavel'; end if;
  -- consumir fora do fechamento é recusado
  ok := false; begin perform fin_consumir_excecao_fechamento((ex->>'id')::uuid, c.usr); exception when sqlstate '23514' then ok := (sqlerrm like 'fin_excecao_via_funcao%'); end;
  if not ok then raise exception 'FALHA 4d8: consumo fora do fechamento'; end if;
  -- 4e) fechar exige reconhecimento mesmo com exceção
  v := (select versao from fin_periodos where unidade_id = c.u1 and mes = '2026-12-01');
  fp := fin_fingerprint_periodo(c.org1, c.u1, '2026-12-01');
  ok := false; begin perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2026-12-01', v, fp, '{}', '{}'::text[], false); exception when sqlstate '23514' then ok := (sqlerrm like 'fin_periodo_pendencias_nao_reconhecidas%'); end;
  if not ok then raise exception 'FALHA 4e1: fechou com excecao sem reconhecimento'; end if;
  -- 4f) pendência NOVA depois da concessão invalida a cobertura
  novo := pg_temp.lanc(c.u1, 'BANCO', 'VENDAS', 'entrada', 3, '2026-12-05', true);
  fp := fin_fingerprint_periodo(c.org1, c.u1, '2026-12-01'); v := (select versao from fin_periodos where unidade_id = c.u1 and mes = '2026-12-01');
  ok := false; begin perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2026-12-01', v, fp, '{}', '{}'::text[], true); exception when sqlstate '23514' then ok := (sqlerrm like 'fin_periodo_excecao_insuficiente%'); end;
  if not ok then raise exception 'FALHA 4f1: pendencia nova coberta pela excecao antiga'; end if;
  ok := false; begin perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2026-12-01', v, fp, '{}', array['caixa_dia:2030-01-01', 'caixa_dia:2030-01-02', 'caixa_dia:2030-01-03', 'caixa_dia:2030-01-04', 'caixa_dia:2030-01-05'], true); exception when sqlstate '23514' then ok := true; end;   -- mais pendências de conciliação que as identificadas
  if not ok then raise exception 'FALHA 4f2: pendencia de conciliacao nova coberta'; end if;
  if (select status from fin_excecoes_fechamento where id = (ex->>'id')::uuid) <> 'ativa' then raise exception 'FALHA 4f3: excecao gasta em tentativa que falhou'; end if;
  update fin_lancamentos set status = 'cancelado' where id = novo;
  -- 4f') TROCA 1-por-1: a pendência coberta é RESOLVIDA e outra NOVA surge, com o MESMO total ⇒ recusa (conjunto de ids, não quantidade); a exceção segue ativa
  update fin_lancamentos set classificacao_pendente = false, categoria_id = (select id from fin_plano_contas where organizacao_id = c.org1 and nome = 'VENDAS')
   where unidade_id = c.u1 and data_movimento >= '2026-12-01' and data_movimento < '2027-01-01' and status <> 'cancelado' and id = ((ex->'pendencias'->0)->>'id')::uuid;
  novo := pg_temp.lanc(c.u1, 'BANCO', 'VENDAS', 'entrada', 4, '2026-12-06', true);
  fp := fin_fingerprint_periodo(c.org1, c.u1, '2026-12-01'); v := (select versao from fin_periodos where unidade_id = c.u1 and mes = '2026-12-01');
  ok := false; begin perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2026-12-01', v, fp, '{}', '{}'::text[], true); exception when sqlstate '23514' then ok := (sqlerrm like 'fin_periodo_excecao_insuficiente%'); end;
  if not ok then raise exception 'FALHA 4f4: troca 1-por-1 foi coberta por quantidade igual'; end if;
  if (select status from fin_excecoes_fechamento where id = (ex->>'id')::uuid) <> 'ativa' then raise exception 'FALHA 4f5: excecao gasta na tentativa recusada'; end if;
  -- restaura o cenário: a pendência original volta e a nova é cancelada
  update fin_lancamentos set classificacao_pendente = true where id = ((ex->'pendencias'->0)->>'id')::uuid;
  update fin_lancamentos set status = 'cancelado' where id = novo;
  -- motivo NOVO numa pendência coberta também invalida (ids iguais, motivos diferentes)
  update fin_lancamentos set revisao_motivos = array['motivo_novo_depois_da_excecao'] where id = ((ex->'pendencias'->0)->>'id')::uuid;
  fp := fin_fingerprint_periodo(c.org1, c.u1, '2026-12-01'); v := (select versao from fin_periodos where unidade_id = c.u1 and mes = '2026-12-01');
  ok := false; begin perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2026-12-01', v, fp, '{}', '{}'::text[], true); exception when sqlstate '23514' then ok := (sqlerrm like 'fin_periodo_excecao_insuficiente%'); end;
  if not ok then raise exception 'FALHA 4f6: motivo novo nao invalidou a cobertura'; end if;
  update fin_lancamentos set revisao_motivos = '{}' where id = ((ex->'pendencias'->0)->>'id')::uuid;
  -- revogável depois da pendência nova, e a nova exceção precisa recobrir tudo (ver 4i)
  
  -- 4g) outra unidade / outro mês não são cobertos pela exceção de u1/2026-12
  insert into fin_contas (organizacao_id, unidade_id, nome, tipo_conta) values (c.org1, c.u2, 'BANCO', 'banco') on conflict do nothing;
  perform pg_temp.lanc(c.u2, 'BANCO', 'VENDAS', 'entrada', 1, '2026-12-02', true);
  ok := false; begin perform fin_fechar_periodo(c.org1, c.u2, c.usr, '2026-12-01', (fin_abrir_periodo(c.org1, c.u2, c.usr, '2026-12-01')->>'versao')::int, fin_fingerprint_periodo(c.org1, c.u2, '2026-12-01'), '{}', '{}'::text[], true);
  exception when sqlstate '23514' then ok := (sqlerrm like 'fin_periodo_pendencias:%'); end;
  if not ok then raise exception 'FALHA 4g1: excecao de outra unidade valeu'; end if;
  -- 4h) fecha com a exceção: consumida, uso único, snapshot com o id e as pendências
  fp := fin_fingerprint_periodo(c.org1, c.u1, '2026-12-01'); v := (select versao from fin_periodos where unidade_id = c.u1 and mes = '2026-12-01');
  per := fin_fechar_periodo(c.org1, c.u1, c.usr, '2026-12-01', v, fp, '{}', '{}'::text[], true);
  if per->>'status' <> 'fechado' or (per->'snapshot'->>'pendenciasNoFechamento')::int <> 1 or per->'snapshot'->>'excecaoFechamentoId' <> ex->>'id' then raise exception 'FALHA 4h1: %', per; end if;
  if per->'snapshot' ? 'politicaPermitiaPendencias' then raise exception 'FALHA 4h2: snapshot ainda menciona politica'; end if;
  if (select status from fin_excecoes_fechamento where id = (ex->>'id')::uuid) <> 'consumida' then raise exception 'FALHA 4h3: excecao nao consumida'; end if;
  if not exists (select 1 from fin_auditoria where entidade = 'fin_excecoes_fechamento' and acao = 'fin_excecoes_fechamento.insert') or
     not exists (select 1 from fin_auditoria where entidade = 'fin_excecoes_fechamento' and acao = 'fin_excecoes_fechamento.update') then raise exception 'FALHA 4h4: concessao/consumo sem auditoria'; end if;
  ok := false; begin perform fin_revogar_excecao_fechamento(c.org1, c.u1, c.usr, (ex->>'id')::uuid, 'tentando revogar excecao ja consumida'); exception when sqlstate '23514' then ok := true; end;
  if not ok then raise exception 'FALHA 4h5: revogou excecao consumida'; end if;
  -- 4i) revogação: motivo obrigatório; depois o fechamento volta a ser impedido
  perform pg_temp.lanc(c.u1, 'BANCO', 'VENDAS', 'entrada', 1, '2027-03-02', true);
  ex2 := fin_conceder_excecao_fechamento(c.org1, c.u1, c.usr, '2027-03-01', 'justificativa: pendencia aguardando comprovante', 5, '{}'::text[], pg_temp.mfa());
  ok := false; begin perform fin_revogar_excecao_fechamento(c.org1, c.u1, c.usr, (ex2->>'id')::uuid, 'curto'); exception when sqlstate '23514' then ok := true; end;
  if not ok then raise exception 'FALHA 4i1: revogou sem motivo'; end if;
  if not fin_revogar_excecao_fechamento(c.org1, c.u1, c.usr, (ex2->>'id')::uuid, 'concedida por engano, revogada') then raise exception 'FALHA 4i2'; end if;
  ok := false; begin perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2027-03-01', (fin_abrir_periodo(c.org1, c.u1, c.usr, '2027-03-01')->>'versao')::int, fin_fingerprint_periodo(c.org1, c.u1, '2027-03-01'), '{}', '{}'::text[], true);
  exception when sqlstate '23514' then ok := (sqlerrm like 'fin_periodo_pendencias:%'); end;
  if not ok then raise exception 'FALHA 4i3: fechou com excecao revogada'; end if;
  if fin_revogar_excecao_fechamento(c.org2, c.u3, c.usr, (ex2->>'id')::uuid, 'tenant errado tentando revogar') then raise exception 'FALHA 4i4: revogou de outro tenant'; end if;
  -- 4i') exceção VENCIDA não vale no fechamento: ainda 'ativa' na tabela, mas expira_em no passado ⇒ comporta-se como sem exceção
  perform pg_temp.lanc(c.u1, 'BANCO', 'VENDAS', 'entrada', 1, '2027-06-02', true);
  perform set_config('fin.excecao_op', 'conceder', true);
  insert into fin_excecoes_fechamento (organizacao_id, unidade_id, mes, justificativa, pendencias, pendencias_hash, quantidade, aprovada_por, mfa_evidencia, aprovada_em, expira_em)
  select c.org1, c.u1, '2027-06-01', 'excecao sintetica ja vencida para teste', jsonb_build_array(jsonb_build_object('id', l.id, 'motivos', '[]'::jsonb)), repeat('0', 64), 1, c.usr,
         pg_temp.mfa(), now() - interval '5 days', now() - interval '1 day' from fin_lancamentos l where l.unidade_id = c.u1 and l.data_movimento = '2027-06-02' and l.classificacao_pendente;
  perform set_config('fin.excecao_op', '', true);
  ok := false; begin perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2027-06-01', (fin_abrir_periodo(c.org1, c.u1, c.usr, '2027-06-01')->>'versao')::int, fin_fingerprint_periodo(c.org1, c.u1, '2027-06-01'), '{}', '{}'::text[], true);
  exception when sqlstate '23514' then ok := (sqlerrm like 'fin_periodo_pendencias:%'); end;
  if not ok then raise exception 'FALHA 4i5: excecao vencida valeu no fechamento'; end if;
  if (select status from fin_excecoes_fechamento where mes = '2027-06-01' and unidade_id = c.u1) <> 'ativa' then raise exception 'FALHA 4i6: vencida foi consumida'; end if;
  -- uma nova concessão substitui a vencida (a vencida fica registrada como revogada)
  ex2 := fin_conceder_excecao_fechamento(c.org1, c.u1, c.usr, '2027-06-01', 'justificativa: nova excecao apos vencimento da anterior', 5, '{}'::text[], pg_temp.mfa());
  if (select count(*) from fin_excecoes_fechamento where mes = '2027-06-01' and unidade_id = c.u1 and status = 'revogada') <> 1 then raise exception 'FALHA 4i7: vencida nao foi encerrada'; end if;

  -- 4k) PENDÊNCIAS DE CONCILIAÇÃO com id estável ("escopo:chave"): conjunto, não contagem; resolver é permitido; trocar 1-por-1 ou criar nova é recusado
  perform pg_temp.lanc(c.u1, 'BANCO', 'VENDAS', 'entrada', 1, '2027-08-02', true);
  ok := false; begin perform fin_conceder_excecao_fechamento(c.org1, c.u1, c.usr, '2027-08-01', 'justificativa suficientemente longa', 7, array['ponte_mensal:agosto'], pg_temp.mfa()); exception when sqlstate '23514' then ok := (sqlerrm like 'fin_excecao_pendencias_invalidas%'); end;
  if not ok then raise exception 'FALHA 4k0: aceitou id de conciliacao em formato invalido'; end if;
  ok := false; begin perform fin_conceder_excecao_fechamento(c.org1, c.u1, c.usr, '2027-08-01', 'justificativa suficientemente longa', 7, array['caixa_dia:2027-08-03', 'caixa_dia:2027-08-03'], pg_temp.mfa()); exception when sqlstate '23514' then ok := (sqlerrm like 'fin_excecao_pendencias_invalidas%'); end;
  if not ok then raise exception 'FALHA 4k0b: aceitou ids repetidos'; end if;
  ex2 := fin_conceder_excecao_fechamento(c.org1, c.u1, c.usr, '2027-08-01', 'justificativa: pendencias de conciliacao conhecidas do mes', 7, array['ponte_mensal:2027-08-01', 'caixa_dia:2027-08-03'], pg_temp.mfa());
  if jsonb_array_length(ex2->'pendencias_conciliacao_ids') <> 2 or (ex2->>'pendencias_hash') !~ '^[0-9a-f]{64}$' then raise exception 'FALHA 4k1: %', ex2; end if;
  v := (select versao from fin_periodos where unidade_id = c.u1 and mes = '2027-08-01'); fp := fin_fingerprint_periodo(c.org1, c.u1, '2027-08-01');
  -- troca 1-por-1 na conciliação: mesmo total (2), um id diferente ⇒ recusa; a exceção segue ativa
  ok := false; begin perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2027-08-01', v, fp, '{}', array['ponte_mensal:2027-08-01', 'caixa_dia:2027-08-04'], true); exception when sqlstate '23514' then ok := (sqlerrm like 'fin_periodo_excecao_insuficiente%'); end;
  if not ok then raise exception 'FALHA 4k2: troca 1-por-1 de pendencia de conciliacao passou'; end if;
  -- uma pendência de conciliação NOVA além das cobertas ⇒ recusa
  ok := false; begin perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2027-08-01', v, fp, '{}', array['ponte_mensal:2027-08-01', 'caixa_dia:2027-08-03', 'sangria_dia:2027-08-03'], true); exception when sqlstate '23514' then ok := (sqlerrm like 'fin_periodo_excecao_insuficiente%'); end;
  if not ok then raise exception 'FALHA 4k3: pendencia de conciliacao nova coberta'; end if;
  -- ids inválidos no fechamento
  ok := false; begin perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2027-08-01', v, fp, '{}', array['qualquer coisa'], true); exception when sqlstate '23514' then ok := (sqlerrm like 'fin_pendencia_conciliacao_invalida%'); end;
  if not ok then raise exception 'FALHA 4k4: aceitou id invalido no fechamento'; end if;
  if (select status from fin_excecoes_fechamento where id = (ex2->>'id')::uuid) <> 'ativa' then raise exception 'FALHA 4k5: excecao gasta em tentativa recusada'; end if;
  -- resolver uma das pendências de conciliação (subconjunto) é permitido e consome a exceção
  per := fin_fechar_periodo(c.org1, c.u1, c.usr, '2027-08-01', v, fp, '{}', array['caixa_dia:2027-08-03'], true);
  if per->>'status' <> 'fechado' or (per->'snapshot'->>'pendenciasNoFechamento')::int <> 2 or per->'snapshot'->>'excecaoFechamentoId' <> ex2->>'id' then raise exception 'FALHA 4k6: %', per; end if;

  -- 4j) service_role (o backend) NÃO conceda, NÃO revoga, NÃO escreve na tabela — só lê
  set local role service_role;
  ok := false; begin perform fin_conceder_excecao_fechamento(c.org1, c.u1, c.usr, '2027-03-01', 'justificativa suficientemente longa', 7, '{}'::text[], pg_temp.mfa()); exception when insufficient_privilege then ok := true; end;
  if not ok then reset role; raise exception 'FALHA 4j1: service_role concede excecao'; end if;
  ok := false; begin perform fin_revogar_excecao_fechamento(c.org1, c.u1, c.usr, (ex2->>'id')::uuid, 'tentativa de revogar sem privilegio'); exception when insufficient_privilege then ok := true; end;
  if not ok then reset role; raise exception 'FALHA 4j2: service_role revoga excecao'; end if;
  ok := false; begin update fin_excecoes_fechamento set status = 'consumida'; exception when insufficient_privilege then ok := true; end;
  if not ok then reset role; raise exception 'FALHA 4j3: service_role escreve na tabela'; end if;
  perform 1 from fin_excecoes_fechamento limit 1;   -- leitura funciona
  reset role;
end $$;

-- 5) referências, resoluções e aberturas: isolamento, validações e mês fechado
do $$
declare c ctx; ok1 boolean := false; ok2 boolean := false; ok3 boolean := false; ok4 boolean := false; ok5 boolean := false; ok6 boolean := false; ref uuid;
begin
  select * into c from ctx;
  insert into fin_referencias (organizacao_id, unidade_id, data, tipo, canal, valor_centavos, fonte, chave_origem) values (c.org1, c.u1, '2026-10-05', 'venda', null, 8318338, 'manual', 'k1') returning id into ref;
  begin insert into fin_referencias (organizacao_id, unidade_id, data, tipo, valor_centavos, fonte, chave_origem) values (c.org1, c.u1, '2026-10-05', 'venda', 1, 'manual', 'k1'); exception when unique_violation then ok1 := true; end;
  begin insert into fin_referencias (organizacao_id, unidade_id, data, tipo, valor_centavos, fonte) values (c.org1, c.u1, '2026-10-05', 'inventado', 1, 'manual'); exception when check_violation then ok2 := true; end;
  begin insert into fin_referencias (organizacao_id, unidade_id, data, tipo, valor_centavos, fonte) values (c.org1, c.u3, '2026-10-05', 'venda', 1, 'manual'); exception when sqlstate '23514' then ok3 := true; end;   -- unidade de outra org
  begin update fin_referencias set status = 'cancelada' where id = ref; exception when check_violation then ok4 := true; end;   -- cancelar sem motivo
  if not (ok1 and ok2 and ok3 and ok4) then raise exception 'FALHA 5a: % % % %', ok1, ok2, ok3, ok4; end if;
  -- resolução exige nota e valor ≠ 0
  begin insert into fin_conciliacao_resolucoes (organizacao_id, unidade_id, escopo, chave, classificacao, valor_centavos, diferenca_no_momento_centavos, nota) values (c.org1, c.u1, 'ponte_mensal', '2026-10-01', 'prazo', -13101, -13101, 'x'); exception when check_violation then ok5 := true; end;
  begin insert into fin_conciliacao_resolucoes (organizacao_id, unidade_id, escopo, chave, classificacao, valor_centavos, diferenca_no_momento_centavos, nota) values (c.org1, c.u1, 'ponte_mensal', '2026-10-15', 'prazo', -13101, -13101, 'nota valida'); exception when check_violation then ok6 := true; end;   -- ponte_mensal exige dia 1
  if not (ok5 and ok6) then raise exception 'FALHA 5b: % %', ok5, ok6; end if;
  insert into fin_conciliacao_resolucoes (organizacao_id, unidade_id, escopo, chave, classificacao, valor_centavos, diferenca_no_momento_centavos, nota, criado_por) values (c.org1, c.u1, 'ponte_mensal', '2026-10-01', 'prazo', -13101, -13101, 'vendas de fim de mes recebidas depois', c.usr);
  -- mês fechado bloqueia referência, resolução e abertura
  perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2026-10-01', (fin_abrir_periodo(c.org1, c.u1, c.usr, '2026-10-01')->>'versao')::int, fin_fingerprint_periodo(c.org1, c.u1, '2026-10-01'), '{}', '{}'::text[], false);
  ok1 := false; ok2 := false; ok3 := false;
  begin insert into fin_referencias (organizacao_id, unidade_id, data, tipo, valor_centavos, fonte) values (c.org1, c.u1, '2026-10-06', 'venda', 1, 'manual'); exception when sqlstate '23514' then ok1 := true; end;
  begin insert into fin_conciliacao_resolucoes (organizacao_id, unidade_id, escopo, chave, classificacao, valor_centavos, diferenca_no_momento_centavos, nota) values (c.org1, c.u1, 'caixa_dia', '2026-10-06', 'ajuste', 5, 5, 'nota valida'); exception when sqlstate '23514' then ok2 := true; end;
  begin insert into fin_saldos_abertura (organizacao_id, unidade_id, conta_id, data_referencia, valor_centavos) values (c.org1, c.u1, (select id from fin_contas where unidade_id = c.u1 and nome = 'BANCO'), '2026-10-01', 5); exception when sqlstate '23514' then ok3 := true; end;
  if not (ok1 and ok2 and ok3) then raise exception 'FALHA 5c: mes fechado nao protegeu referencias/resolucoes/aberturas (% % %)', ok1, ok2, ok3; end if;
end $$;

-- 6) exceção de sangria: motivo obrigatório, única ativa por categoria, desativar exige motivo; categoria de outra org recusada
do $$
declare c ctx; cat uuid; ok1 boolean := false; ok2 boolean := false; ok3 boolean := false; ok4 boolean := false; ex uuid; outra uuid;
begin
  select * into c from ctx;
  select id into cat from fin_plano_contas where organizacao_id = c.org1 and nome = 'ALUGUEL';
  begin insert into fin_sangria_excecoes (organizacao_id, unidade_id, categoria_id, motivo, aprovada_por) values (c.org1, c.u1, cat, 'x', c.usr); exception when check_violation then ok1 := true; end;
  insert into fin_sangria_excecoes (organizacao_id, unidade_id, categoria_id, motivo, aprovada_por) values (c.org1, c.u1, cat, 'aluguel pago em especie fora da sangria', c.usr) returning id into ex;
  begin insert into fin_sangria_excecoes (organizacao_id, unidade_id, categoria_id, motivo, aprovada_por) values (c.org1, c.u1, cat, 'outra aprovacao duplicada', c.usr); exception when unique_violation then ok2 := true; end;
  begin update fin_sangria_excecoes set ativa = false where id = ex; exception when check_violation then ok3 := true; end;
  insert into fin_plano_contas (organizacao_id, tipo, natureza, nome, papel) values (c.org2, 'D', 'F', 'ALUGUEL', 'despesa_fixa') returning id into outra;
  begin insert into fin_sangria_excecoes (organizacao_id, unidade_id, categoria_id, motivo, aprovada_por) values (c.org1, c.u2, outra, 'categoria de outra organizacao', c.usr); exception when sqlstate '23514' then ok4 := true; end;
  if not (ok1 and ok2 and ok3 and ok4) then raise exception 'FALHA 6: % % % %', ok1, ok2, ok3, ok4; end if;
end $$;

-- 7) importação grava os códigos de revisão
do $$
declare c ctx; imp uuid; m text[];
begin
  select * into c from ctx;
  insert into fin_importacoes (organizacao_id, unidade_id, arquivo_hash, criado_por, previa) values (c.org1, c.u2, 'h', c.usr, jsonb_build_object(
    'contas', jsonb_build_array(jsonb_build_object('nome','Z')), 'categorias', '[]'::jsonb, 'saldos', '[]'::jsonb, 'pares', '[]'::jsonb,
    'lancamentos', jsonb_build_array(jsonb_build_object('chave','m1#1','data','2026-09-09','descricao','pix','sentido','saida','valor_centavos',50,'conta','Z','categoria',null,'pendente',true,'importar',true,'motivos', jsonb_build_array('a_identificar','sem_papel'))))) returning id into imp;
  perform fin_confirmar_importacao(c.org1, c.u2, c.usr, imp);
  select revisao_motivos into m from fin_lancamentos where chave_origem = 'm1#1' and unidade_id = c.u2;
  if m is distinct from array['a_identificar','sem_papel'] then raise exception 'FALHA 7: motivos %', m; end if;
end $$;

-- 8) F-B: lançamento só aceita importação do MESMO tenant (organização + unidade); manual (importacao_id nulo) segue livre
do $$
declare c ctx; imp_ok uuid; imp_outra_unidade uuid; imp_outra_org uuid; ok1 boolean := false; ok2 boolean := false; conta uuid;
begin
  select * into c from ctx;
  insert into fin_importacoes (organizacao_id, unidade_id, arquivo_hash, criado_por, previa) values (c.org1, c.u1, 'h-ok', c.usr, '{}') returning id into imp_ok;
  insert into fin_importacoes (organizacao_id, unidade_id, arquivo_hash, criado_por, previa) values (c.org1, c.u2, 'h-u2', c.usr, '{}') returning id into imp_outra_unidade;
  insert into fin_importacoes (organizacao_id, unidade_id, arquivo_hash, criado_por, previa) values (c.org2, c.u3, 'h-o2', c.usr, '{}') returning id into imp_outra_org;
  select id into conta from fin_contas where unidade_id = c.u1 and nome = 'BANCO';
  insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, descricao, sentido, valor_centavos, data_movimento, classificacao_pendente, importacao_id) values (c.org1, c.u1, conta, 'ok', 'entrada', 1, '2027-04-02', true, imp_ok);
  begin insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, descricao, sentido, valor_centavos, data_movimento, classificacao_pendente, importacao_id) values (c.org1, c.u1, conta, 'x', 'entrada', 1, '2027-04-03', true, imp_outra_unidade);
  exception when foreign_key_violation then ok1 := true; end;
  begin insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, descricao, sentido, valor_centavos, data_movimento, classificacao_pendente, importacao_id) values (c.org1, c.u1, conta, 'x', 'entrada', 1, '2027-04-03', true, imp_outra_org);
  exception when foreign_key_violation then ok2 := true; end;
  if not (ok1 and ok2) then raise exception 'FALHA 8: importacao de outro tenant aceita (% %)', ok1, ok2; end if;
  insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, descricao, sentido, valor_centavos, data_movimento, classificacao_pendente) values (c.org1, c.u1, conta, 'manual', 'entrada', 1, '2027-04-04', true);
end $$;

rollback;
\echo 'TESTES B7/B8 PASSARAM'
