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
  per := fin_fechar_periodo(c.org1, c.u1, c.usr, '2026-09-01', (fin_abrir_periodo(c.org1, c.u1, c.usr, '2026-09-01')->>'versao')::int, fp, '{"resultado": 100000}', 0, false);
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
  per := fin_reabrir_periodo(c.org1, c.u1, c.usr, '2026-09-01', (per->>'versao')::int, 'correcao de classificacao aprovada');
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
  begin perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2026-11-01', (select versao from fin_periodos where unidade_id = c.u1 and mes = '2026-11-01'), fp, '{}', 0, false);
  exception when sqlstate '23514' then ok1 := (sqlerrm like 'fin_periodo_conflito_dados%'); end;
  begin perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2026-11-01', v + 50, fin_fingerprint_periodo(c.org1, c.u1, '2026-11-01'), '{}', 0, false);
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
  begin perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2026-12-01', v, fp, '{}', 0, true); exception when sqlstate '23514' then ok1 := (sqlerrm like 'fin_periodo_pendencias:%'); end;
  -- pendência da conciliação (informada pelo backend) também impede
  perform pg_temp.lanc(c.u1, 'BANCO', 'VENDAS', 'entrada', 1, '2027-01-02');
  begin perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2027-01-01', (fin_abrir_periodo(c.org1, c.u1, c.usr, '2027-01-01')->>'versao')::int, fin_fingerprint_periodo(c.org1, c.u1, '2027-01-01'), '{}', 2, false);
  exception when sqlstate '23514' then ok2 := (sqlerrm like 'fin_periodo_pendencias:%'); end;
  if not (ok1 and ok2) then raise exception 'FALHA 4a: fechou com pendencias (% %)', ok1, ok2; end if;
  -- política não pode ser ligada sem aprovação registrada
  begin insert into fin_config (organizacao_id, unidade_id, permite_fechar_com_pendencias) values (c.org1, c.u1, true); exception when check_violation then ok3 := true; end;
  if not ok3 then raise exception 'FALHA 4b: politica ligada sem aprovacao'; end if;
  insert into fin_config (organizacao_id, unidade_id, permite_fechar_com_pendencias, aprovado_por, aprovado_em, nota_aprovacao) values (c.org1, c.u1, true, c.usr, now(), 'aprovado pela diretoria em ata 123');
  ok1 := false;
  begin perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2026-12-01', v, fp, '{}', 0, false); exception when sqlstate '23514' then ok1 := (sqlerrm like 'fin_periodo_pendencias_nao_reconhecidas%'); end;
  if not ok1 then raise exception 'FALHA 4c: fechou com pendencias sem reconhecimento'; end if;
  per := fin_fechar_periodo(c.org1, c.u1, c.usr, '2026-12-01', v, fp, '{}', 0, true);
  if (per->'snapshot'->>'pendenciasNoFechamento')::int <> 1 or (per->'snapshot'->>'politicaPermitiaPendencias')::boolean is not true then raise exception 'FALHA 4d: %', per; end if;
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
  perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2026-10-01', (fin_abrir_periodo(c.org1, c.u1, c.usr, '2026-10-01')->>'versao')::int, fin_fingerprint_periodo(c.org1, c.u1, '2026-10-01'), '{}', 0, false);
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

rollback;
\echo 'TESTES B7/B8 PASSARAM'
