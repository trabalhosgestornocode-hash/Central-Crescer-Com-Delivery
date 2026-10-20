-- Testes do SQL provisório em banco DESCARTÁVEL. Dados 100% sintéticos. Cada bloco levanta exceção se a expectativa falhar.
-- Rodar via run.sh (recusa host que não seja local/descartável).
\set ON_ERROR_STOP on
begin;

create temp table ctx as
select (select id from (select gen_random_uuid() id) a) org1, gen_random_uuid() org2, gen_random_uuid() u1, gen_random_uuid() u2, gen_random_uuid() u3, gen_random_uuid() usr;
insert into organizacoes (id, nome) select org1, 'Org 1' from ctx union all select org2, 'Org 2' from ctx;
insert into unidades (id, organizacao_id, nome) select u1, org1, 'U1' from ctx union all select u2, org1, 'U2' from ctx union all select u3, org2, 'U3' from ctx;

-- categorias (org1) e contas (u1)
create temp table ids as select 1 as k;
do $$
declare c ctx;
begin
  select * into c from ctx;
  insert into fin_plano_contas (organizacao_id, tipo, natureza, nome, papel) values
    (c.org1, 'RECEITA', 'RECEBIMENTO', 'VENDAS', 'receita_operacional'),
    (c.org1, 'TRANSFERENCIA', 'ENTRE CONTAS', 'ENTRE CONTAS', 'transferencia'),
    (c.org2, 'RECEITA', 'RECEBIMENTO', 'VENDAS', 'receita_operacional');
  insert into fin_contas (organizacao_id, unidade_id, nome) values (c.org1, c.u1, 'A'), (c.org1, c.u1, 'B'), (c.org1, c.u2, 'A'), (c.org2, c.u3, 'A');
end $$;

-- 1) unidade de outra organização é recusada
do $$
declare c ctx; ok boolean := false;
begin
  select * into c from ctx;
  begin insert into fin_contas (organizacao_id, unidade_id, nome) values (c.org1, c.u3, 'X'); exception when sqlstate '23514' then ok := true; end;
  if not ok then raise exception 'FALHA 1: aceitou unidade de outra organizacao'; end if;
end $$;

-- 2) lançamento com conta de outra unidade / categoria de outra organização é recusado
do $$
declare c ctx; conta_u2 uuid; cat_org2 uuid; ok1 boolean := false; ok2 boolean := false;
begin
  select * into c from ctx;
  select id into conta_u2 from fin_contas where unidade_id = c.u2;
  select id into cat_org2 from fin_plano_contas where organizacao_id = c.org2;
  begin insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, descricao, sentido, valor_centavos, data_movimento, classificacao_pendente)
        values (c.org1, c.u1, conta_u2, 'x', 'entrada', 100, '2026-09-01', true); exception when sqlstate '23514' then ok1 := true; end;
  begin insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, categoria_id, descricao, sentido, valor_centavos, data_movimento)
        values (c.org1, c.u1, (select id from fin_contas where unidade_id = c.u1 and nome = 'A'), cat_org2, 'x', 'entrada', 100, '2026-09-01'); exception when sqlstate '23514' then ok2 := true; end;
  if not (ok1 and ok2) then raise exception 'FALHA 2: vazamento entre tenants (% %)', ok1, ok2; end if;
end $$;

-- 3) sem categoria exige classificacao_pendente; valor <= 0 recusado
do $$
declare c ctx; a uuid; ok1 boolean := false; ok2 boolean := false;
begin
  select * into c from ctx; select id into a from fin_contas where unidade_id = c.u1 and nome = 'A';
  begin insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, descricao, sentido, valor_centavos, data_movimento) values (c.org1, c.u1, a, 'x', 'saida', 5, '2026-09-01'); exception when check_violation then ok1 := true; end;
  begin insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, descricao, sentido, valor_centavos, data_movimento, classificacao_pendente) values (c.org1, c.u1, a, 'x', 'saida', 0, '2026-09-01', true); exception when check_violation then ok2 := true; end;
  if not (ok1 and ok2) then raise exception 'FALHA 3'; end if;
end $$;

-- 4) transferência atômica: par com líquido zero; mesma conta recusada; edição de perna vinculada recusada
do $$
declare c ctx; a uuid; b uuid; cat uuid; par uuid; liquido bigint; ok1 boolean := false; ok2 boolean := false;
begin
  select * into c from ctx;
  select id into a from fin_contas where unidade_id = c.u1 and nome = 'A';
  select id into b from fin_contas where unidade_id = c.u1 and nome = 'B';
  select id into cat from fin_plano_contas where organizacao_id = c.org1 and papel = 'transferencia';
  par := fin_criar_transferencia(c.org1, c.u1, c.usr, a, b, 12345, '2026-09-02', 'T', cat);
  select sum(case sentido when 'entrada' then valor_centavos else -valor_centavos end) into liquido
    from fin_lancamentos l join fin_transferencias t on l.id in (t.lancamento_saida_id, t.lancamento_entrada_id) where t.id = par;
  if liquido <> 0 then raise exception 'FALHA 4a: par nao fecha em zero'; end if;
  begin perform fin_criar_transferencia(c.org1, c.u1, c.usr, a, a, 1, '2026-09-02', 'T', cat); exception when sqlstate '23514' then ok1 := true; end;
  if not ok1 then raise exception 'FALHA 4b: aceitou mesma conta'; end if;
  if (select count(*) from fin_lancamentos where valor_centavos = 1) <> 0 then raise exception 'FALHA 4c: transferencia nao foi atomica (perna orfa)'; end if;
  begin update fin_lancamentos set valor_centavos = 999 where id = (select lancamento_saida_id from fin_transferencias where id = par); exception when sqlstate '23514' then ok2 := true; end;
  if not ok2 then raise exception 'FALHA 4d: alterou perna vinculada'; end if;
end $$;

-- 5) período fechado bloqueia escrita; auditoria registra e é imutável
do $$
declare c ctx; a uuid; cat uuid; ok boolean := false; ok2 boolean := false; n int;
begin
  select * into c from ctx; select id into a from fin_contas where unidade_id = c.u1 and nome = 'A';
  select id into cat from fin_plano_contas where organizacao_id = c.org1 and papel = 'receita_operacional';
  perform set_config('fin.fechando_periodo', '00000000-0000-4000-8000-0000000000f1', true);   -- fixture: período já fechado (o gatilho F-D da 122 só admite via função ou flag)
  insert into fin_periodos (id, organizacao_id, unidade_id, mes, status) values ('00000000-0000-4000-8000-0000000000f1', c.org1, c.u1, '2026-08-01', 'fechado');
  perform set_config('fin.fechando_periodo', '', true);
  begin insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, categoria_id, descricao, sentido, valor_centavos, data_movimento)
        values (c.org1, c.u1, a, cat, 'x', 'entrada', 10, '2026-08-15'); exception when sqlstate '23514' then ok := true; end;
  if not ok then raise exception 'FALHA 5a: escreveu em mes fechado'; end if;
  select count(*) into n from fin_auditoria where entidade = 'fin_lancamentos' and acao = 'fin_lancamentos.insert';
  if n < 2 then raise exception 'FALHA 5b: auditoria nao registrou'; end if;
  begin update fin_auditoria set acao = 'x'; exception when sqlstate '23514' then ok2 := true; end;
  if not ok2 then raise exception 'FALHA 5c: auditoria mutavel'; end if;
end $$;

-- 6) categoria em uso não troca de papel
do $$
declare c ctx; a uuid; cat uuid; ok boolean := false;
begin
  select * into c from ctx; select id into a from fin_contas where unidade_id = c.u1 and nome = 'A';
  select id into cat from fin_plano_contas where organizacao_id = c.org1 and papel = 'receita_operacional';
  insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, categoria_id, descricao, sentido, valor_centavos, data_movimento) values (c.org1, c.u1, a, cat, 'v', 'entrada', 777, '2026-09-03');
  begin update fin_plano_contas set papel = 'custo_variavel' where id = cat; exception when sqlstate '23514' then ok := true; end;
  if not ok then raise exception 'FALHA 6: mudou papel de categoria em uso'; end if;
end $$;

-- 7) importação: atômica, idempotente, duplicata legítima preservada, par confirmado vinculado, par não confirmado não
do $$
declare c ctx; imp uuid; r jsonb; r2 jsonb; n int; previa jsonb;
begin
  select * into c from ctx;
  previa := jsonb_build_object(
    'contas', jsonb_build_array(jsonb_build_object('nome','A'), jsonb_build_object('nome','B'), jsonb_build_object('nome','Z')),
    'categorias', jsonb_build_array(jsonb_build_object('tipo','TRANSFERENCIA','natureza','ENTRE CONTAS','nome','ENTRE CONTAS','papel','transferencia')),
    'saldos', jsonb_build_array(jsonb_build_object('conta','Z','data','2026-09-01','valor_centavos',5000)),
    'lancamentos', jsonb_build_array(
      jsonb_build_object('chave','k1#1','data','2026-09-05','descricao','saida','sentido','saida','valor_centavos',900,'conta','A','categoria',jsonb_build_object('tipo','TRANSFERENCIA','natureza','ENTRE CONTAS','nome','ENTRE CONTAS'),'importar',true),
      jsonb_build_object('chave','k2#1','data','2026-09-05','descricao','entrada','sentido','entrada','valor_centavos',900,'conta','B','categoria',jsonb_build_object('tipo','TRANSFERENCIA','natureza','ENTRE CONTAS','nome','ENTRE CONTAS'),'importar',true),
      jsonb_build_object('chave','k3#1','data','2026-09-06','descricao','pix','sentido','saida','valor_centavos',163,'conta','Z','categoria',null,'pendente',true,'importar',true),
      jsonb_build_object('chave','k3#2','data','2026-09-06','descricao','pix','sentido','saida','valor_centavos',163,'conta','Z','categoria',null,'pendente',true,'importar',true),
      jsonb_build_object('chave','k4#1','data','2026-09-07','descricao','nao importar','sentido','saida','valor_centavos',1,'conta','Z','categoria',null,'pendente',true,'importar',false)),
    'pares', jsonb_build_array(jsonb_build_object('saida','k1#1','entrada','k2#1','confirmado',true), jsonb_build_object('saida','k3#1','entrada','k3#2','confirmado',false)));
  insert into fin_importacoes (organizacao_id, unidade_id, arquivo_hash, previa, criado_por) values (c.org1, c.u2, 'h', previa, c.usr) returning id into imp;
  r := fin_confirmar_importacao(c.org1, c.u2, c.usr, imp);
  if (r->>'lancamentosGravados')::int <> 4 or (r->>'paresVinculados')::int <> 1 or (r->>'saldosGravados')::int <> 1 then raise exception 'FALHA 7a: %', r; end if;
  if (select count(*) from fin_lancamentos where chave_origem like 'k3#%') <> 2 then raise exception 'FALHA 7b: duplicata legitima perdida'; end if;
  if (select count(*) from fin_lancamentos where chave_origem = 'k4#1') <> 0 then raise exception 'FALHA 7c: importou linha marcada importar=false'; end if;
  r2 := fin_confirmar_importacao(c.org1, c.u2, c.usr, imp);
  if (r2->>'jaConfirmada')::boolean is not true then raise exception 'FALHA 7d: reconfirmar nao foi idempotente'; end if;
  -- nova importação do mesmo conteúdo: nada duplica
  insert into fin_importacoes (organizacao_id, unidade_id, arquivo_hash, previa, criado_por) values (c.org1, c.u2, 'h', previa, c.usr) returning id into imp;
  r2 := fin_confirmar_importacao(c.org1, c.u2, c.usr, imp);
  if (r2->>'lancamentosGravados')::int <> 0 or (r2->>'jaExistentes')::int <> 4 then raise exception 'FALHA 7e: reimportacao duplicou %', r2; end if;
  select count(*) into n from fin_lancamentos where unidade_id = c.u2 and origem = 'importacao';
  if n <> 4 then raise exception 'FALHA 7f: total %', n; end if;
  -- outro tenant não confirma importação alheia
  begin perform fin_confirmar_importacao(c.org2, c.u3, c.usr, imp); raise exception 'FALHA 7g: confirmou importacao de outro tenant';
  exception when sqlstate 'P0002' then null; end;
end $$;

-- 8) importação com erro no meio não deixa resíduo (conta ausente do jsonb gera linha descartada; categoria inválida aborta tudo)
do $$
declare c ctx; imp uuid; antes int; ok boolean := false;
begin
  select * into c from ctx;
  select count(*) into antes from fin_lancamentos where unidade_id = c.u2;
  insert into fin_importacoes (organizacao_id, unidade_id, arquivo_hash, previa, criado_por) values (c.org1, c.u2, 'h2',
    jsonb_build_object('contas', jsonb_build_array(jsonb_build_object('nome','Q')), 'categorias', jsonb_build_array(jsonb_build_object('tipo','X','natureza','X','nome','X','papel','papel_inventado')),
                       'lancamentos', jsonb_build_array(jsonb_build_object('chave','z1','data','2026-09-09','descricao','d','sentido','saida','valor_centavos',1,'conta','Q','categoria',null,'pendente',true,'importar',true))), c.usr) returning id into imp;
  begin perform fin_confirmar_importacao(c.org1, c.u2, c.usr, imp); exception when check_violation then ok := true; end;
  if not ok then raise exception 'FALHA 8a: aceitou papel inventado'; end if;
end $$;

-- 9) vincular limpa a pendência das pernas; desvincular restaura e nada é excluído
do $$
declare c ctx; a uuid; b uuid; cat uuid; s uuid; e uuid; par uuid;
begin
  select * into c from ctx;
  select id into a from fin_contas where unidade_id = c.u1 and nome = 'A';
  select id into b from fin_contas where unidade_id = c.u1 and nome = 'B';
  select id into cat from fin_plano_contas where organizacao_id = c.org1 and papel = 'transferencia';
  insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, categoria_id, descricao, sentido, valor_centavos, data_movimento, classificacao_pendente) values (c.org1, c.u1, a, cat, 's', 'saida', 321, '2026-09-10', true) returning id into s;
  insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, categoria_id, descricao, sentido, valor_centavos, data_movimento, classificacao_pendente) values (c.org1, c.u1, b, cat, 'e', 'entrada', 321, '2026-09-10', true) returning id into e;
  par := fin_vincular_transferencia(c.org1, c.u1, c.usr, s, e);
  if (select count(*) from fin_lancamentos where id in (s, e) and classificacao_pendente) <> 0 then raise exception 'FALHA 9a: pendencia nao limpa'; end if;
  if not fin_desvincular_transferencia(c.org1, c.u1, c.usr, par) then raise exception 'FALHA 9b'; end if;
  if (select count(*) from fin_lancamentos where id in (s, e) and classificacao_pendente) <> 2 then raise exception 'FALHA 9c: pendencia nao restaurada'; end if;
  if fin_desvincular_transferencia(c.org2, c.u3, c.usr, par) then raise exception 'FALHA 9d'; end if;
end $$;

rollback;
\echo 'TODOS OS TESTES SQL PASSARAM'
