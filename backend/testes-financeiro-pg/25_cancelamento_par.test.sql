-- Cancelamento atômico de transferência, desvínculo motivado e proteção de perna vinculada. Banco DESCARTÁVEL, dados sintéticos.
\set ON_ERROR_STOP on
begin;

create temp table ctx as
select gen_random_uuid() org1, gen_random_uuid() org2, gen_random_uuid() u1, gen_random_uuid() u2, gen_random_uuid() u3, gen_random_uuid() usr;
insert into organizacoes (id, nome) select org1, 'O1' from ctx union all select org2, 'O2' from ctx;
insert into unidades (id, organizacao_id, nome) select u1, org1, 'U1' from ctx union all select u2, org1, 'U2' from ctx union all select u3, org2, 'U3' from ctx;
do $$
declare c ctx;
begin
  select * into c from ctx;
  insert into fin_plano_contas (organizacao_id, tipo, natureza, nome, papel) values (c.org1, 'T', 'N', 'TRANSF', 'transferencia'), (c.org1, 'D', 'F', 'DESP', 'despesa_fixa');
  insert into fin_contas (organizacao_id, unidade_id, nome) values (c.org1, c.u1, 'A'), (c.org1, c.u1, 'B'), (c.org1, c.u2, 'A'), (c.org1, c.u2, 'B');
end $$;
create function pg_temp.novo_par(p_unidade uuid, p_data date, p_valor bigint default 1000) returns uuid language plpgsql as $$
declare c ctx;
begin
  select * into c from ctx;
  return fin_criar_transferencia(c.org1, p_unidade, c.usr,
    (select id from fin_contas where unidade_id = p_unidade and nome = 'A'), (select id from fin_contas where unidade_id = p_unidade and nome = 'B'),
    p_valor, p_data, 'par sintetico', (select id from fin_plano_contas where organizacao_id = c.org1 and papel = 'transferencia'));
end $$;
create function pg_temp.pernas(p_par uuid) returns text[] language sql as $$
  select array_agg(l.status order by l.sentido) from fin_transferencias t join fin_lancamentos l on l.id in (t.lancamento_saida_id, t.lancamento_entrada_id) where t.id = p_par
$$;

-- 1) cancelar o PAR: as duas pernas e o par mudam juntos; motivo na nota; auditoria antes/depois; idempotente
do $$
declare c ctx; par uuid; r jsonb; r2 jsonb; n_antes int; n_depois int;
begin
  select * into c from ctx;
  par := pg_temp.novo_par(c.u1, '2026-09-10');
  select count(*) into n_antes from fin_auditoria where entidade = 'fin_lancamentos' and acao = 'fin_lancamentos.update';
  r := fin_cancelar_transferencia(c.org1, c.u1, c.usr, par, 'lancada em duplicidade pelo operador');
  if r->>'status' <> 'cancelada' or (r->>'jaCancelada')::boolean then raise exception 'FALHA 1a: %', r; end if;
  if pg_temp.pernas(par) is distinct from array['cancelado','cancelado'] then raise exception 'FALHA 1b: pernas %', pg_temp.pernas(par); end if;
  if (select status from fin_transferencias where id = par) <> 'cancelada' then raise exception 'FALHA 1c'; end if;
  if (select count(*) from fin_lancamentos l join fin_transferencias t on l.id in (t.lancamento_saida_id, t.lancamento_entrada_id) where t.id = par and l.nota_revisao like '%duplicidade%') <> 2 then raise exception 'FALHA 1d: motivo nao esta nas duas pernas'; end if;
  select count(*) into n_depois from fin_auditoria where entidade = 'fin_lancamentos' and acao = 'fin_lancamentos.update';
  if n_depois - n_antes <> 2 then raise exception 'FALHA 1e: auditoria das pernas (%)', n_depois - n_antes; end if;
  if not exists (select 1 from fin_auditoria where entidade = 'fin_transferencias' and antes->>'status' = 'vinculada' and depois->>'status' = 'cancelada' and depois->>'motivo_cancelamento' like '%duplicidade%') then raise exception 'FALHA 1f: auditoria do par sem antes/depois'; end if;
  -- idempotência: repetir não muda nada nem audita de novo
  r2 := fin_cancelar_transferencia(c.org1, c.u1, c.usr, par, 'outra tentativa qualquer repetida');
  if not (r2->>'jaCancelada')::boolean then raise exception 'FALHA 1g: nao idempotente'; end if;
  if (select count(*) from fin_auditoria where entidade = 'fin_lancamentos' and acao = 'fin_lancamentos.update') <> n_depois then raise exception 'FALHA 1h: repetir gerou auditoria'; end if;
end $$;

-- 2) validações: motivo obrigatório, tenant/unidade errados, período fechado (rollback integral das duas pernas)
do $$
declare c ctx; par uuid; ok1 boolean := false; ok2 boolean := false; ok3 boolean := false; ok4 boolean := false; ok5 boolean := false;
begin
  select * into c from ctx;
  par := pg_temp.novo_par(c.u1, '2026-09-11');
  begin perform fin_cancelar_transferencia(c.org1, c.u1, c.usr, par, 'curto'); exception when sqlstate '23514' then ok1 := (sqlerrm like 'fin_transferencia_motivo_obrigatorio%'); end;
  begin perform fin_cancelar_transferencia(c.org2, c.u3, c.usr, par, 'motivo suficientemente longo'); exception when sqlstate 'P0002' then ok2 := true; end;    -- outra organização
  begin perform fin_cancelar_transferencia(c.org1, c.u2, c.usr, par, 'motivo suficientemente longo'); exception when sqlstate 'P0002' then ok3 := true; end;    -- outra unidade
  if not (ok1 and ok2 and ok3) then raise exception 'FALHA 2a: % % %', ok1, ok2, ok3; end if;
  if pg_temp.pernas(par) is distinct from array['realizado','realizado'] then raise exception 'FALHA 2b: algo mudou apesar das recusas'; end if;
  -- mês fechado: nada muda (as DUAS pernas continuam ativas)
  perform fin_fechar_periodo(c.org1, c.u1, c.usr, '2026-08-01', (fin_abrir_periodo(c.org1, c.u1, c.usr, '2026-08-01')->>'versao')::int, fin_fingerprint_periodo(c.org1, c.u1, '2026-08-01'), '{}', '{}'::text[], false);
  -- cria a segunda perna no mês seguinte via inserção direta para simular par entre meses, depois fecha um dos meses
  par := pg_temp.novo_par(c.u2, '2026-10-05');
  perform fin_fechar_periodo(c.org1, c.u2, c.usr, '2026-10-01', (fin_abrir_periodo(c.org1, c.u2, c.usr, '2026-10-01')->>'versao')::int, fin_fingerprint_periodo(c.org1, c.u2, '2026-10-01'), '{}', '{}'::text[], false);
  begin perform fin_cancelar_transferencia(c.org1, c.u2, c.usr, par, 'motivo suficientemente longo'); exception when sqlstate '23514' then ok4 := (sqlerrm like 'fin_periodo_fechado%'); end;
  if not ok4 then raise exception 'FALHA 2c: cancelou par em mes fechado'; end if;
  if pg_temp.pernas(par) is distinct from array['realizado','realizado'] then raise exception 'FALHA 2d: perna alterada em mes fechado'; end if;
  if (select status from fin_transferencias where id = par) <> 'vinculada' then raise exception 'FALHA 2e: par mudou de estado'; end if;
end $$;

-- 3) cancelamento parcial é impossível: perna vinculada isolada recusada; contorno via flag cai na rede de segurança do commit
do $$
declare c ctx; par uuid; sid uuid; eid uuid; ok1 boolean := false; ok2 boolean := false; ok3 boolean := false; ok4 boolean := false;
begin
  select * into c from ctx;
  par := pg_temp.novo_par(c.u1, '2026-09-12');
  select lancamento_saida_id, lancamento_entrada_id into sid, eid from fin_transferencias where id = par;
  begin update fin_lancamentos set status = 'cancelado' where id = sid; exception when sqlstate '23514' then ok1 := (sqlerrm like 'fin_transferencia_vinculada%'); end;
  begin update fin_transferencias set status = 'cancelada', cancelada_por = c.usr, cancelada_em = now(), motivo_cancelamento = 'tentativa direta sem a funcao' where id = par; exception when sqlstate '23514' then ok2 := true; end;
  if not (ok1 and ok2) then raise exception 'FALHA 3a: % %', ok1, ok2; end if;
  -- mesmo com a flag (contorno), cancelar SÓ uma perna é barrado no commit
  perform set_config('fin.cancelando_par', par::text, true);
  update fin_lancamentos set status = 'cancelado' where id = sid;
  begin set constraints trg_fin_par_status_consistente immediate; exception when sqlstate '23514' then ok3 := (sqlerrm like 'fin_transferencia_parcial%'); end;
  if not ok3 then raise exception 'FALHA 3b: cancelamento parcial passou'; end if;
  perform set_config('fin.cancelando_par', '', true);
  -- trocar a categoria de uma perna vinculada (achado da revisão da 121) é recusado
  par := pg_temp.novo_par(c.u1, '2026-09-13');
  select lancamento_saida_id into sid from fin_transferencias where id = par;
  begin update fin_lancamentos set categoria_id = (select id from fin_plano_contas where organizacao_id = c.org1 and papel = 'despesa_fixa') where id = sid; exception when sqlstate '23514' then ok4 := true; end;
  if not ok4 then raise exception 'FALHA 3c: perna vinculada trocou de categoria'; end if;
end $$;

-- 4) desvincular com motivo: pernas continuam ATIVAS e pendentes, motivo nas notas; par cancelado não desvincula; sem motivo recusa
do $$
declare c ctx; par uuid; par2 uuid; ok1 boolean := false; ok2 boolean := false; ok3 boolean := false;
begin
  select * into c from ctx;
  par := pg_temp.novo_par(c.u1, '2026-09-14');
  begin perform fin_desvincular_transferencia_motivada(c.org1, c.u1, c.usr, par, 'curto'); exception when sqlstate '23514' then ok1 := true; end;
  if fin_desvincular_transferencia_motivada(c.org2, c.u3, c.usr, par, 'motivo suficientemente longo') then raise exception 'FALHA 4a: desvinculou de outro tenant'; end if;
  if not fin_desvincular_transferencia_motivada(c.org1, c.u1, c.usr, par, 'pareamento incorreto confirmado pelo gestor') then raise exception 'FALHA 4b'; end if;
  if exists (select 1 from fin_transferencias where id = par) then raise exception 'FALHA 4c: par ainda existe'; end if;
  if (select count(*) from fin_lancamentos where nota_revisao like '%pareamento incorreto%' and classificacao_pendente and status = 'realizado' and 'transferencia_sem_contraparte' = any(revisao_motivos)) <> 2 then raise exception 'FALHA 4d: pernas deveriam estar ativas, pendentes e com o motivo'; end if;
  par2 := pg_temp.novo_par(c.u1, '2026-09-15');
  perform fin_cancelar_transferencia(c.org1, c.u1, c.usr, par2, 'cancelamento de teste do par inteiro');
  begin perform fin_desvincular_transferencia_motivada(c.org1, c.u1, c.usr, par2, 'motivo suficientemente longo'); exception when sqlstate '23514' then ok2 := true; end;
  if not ok2 then raise exception 'FALHA 4e: desvinculou par cancelado'; end if;
  -- o desvínculo antigo (sem motivo) não é mais executável pelo backend
  if has_function_privilege('service_role', 'fin_desvincular_transferencia(uuid,uuid,uuid,uuid)', 'execute') then raise exception 'FALHA 4f: service_role ainda executa o desvinculo sem motivo'; end if;
  if not has_function_privilege('service_role', 'fin_cancelar_transferencia(uuid,uuid,uuid,uuid,text)', 'execute') then raise exception 'FALHA 4g'; end if;
  if has_function_privilege('anon', 'fin_cancelar_transferencia(uuid,uuid,uuid,uuid,text)', 'execute') or has_function_privilege('authenticated', 'fin_cancelar_transferencia(uuid,uuid,uuid,uuid,text)', 'execute') then raise exception 'FALHA 4h'; end if;
  ok3 := true;
end $$;

-- 5) isolado: lançamento comum cancela normalmente; trigger functions e sequência sem acesso para papéis públicos
do $$
declare c ctx; id1 uuid;
begin
  select * into c from ctx;
  insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, categoria_id, descricao, sentido, valor_centavos, data_movimento)
    values (c.org1, c.u1, (select id from fin_contas where unidade_id = c.u1 and nome = 'A'), (select id from fin_plano_contas where organizacao_id = c.org1 and papel = 'despesa_fixa'), 'isolado', 'saida', 100, '2026-09-20') returning id into id1;
  update fin_lancamentos set status = 'cancelado' where id = id1;
  if has_function_privilege('anon', 'fin_auditar()', 'execute') or has_function_privilege('authenticated', 'fin_validar_escopo()', 'execute') or has_function_privilege('public', 'fin_lancamentos_guarda()', 'execute') then raise exception 'FALHA 5a: funcao de gatilho executavel por papel publico'; end if;
  if has_sequence_privilege('anon', 'fin_auditoria_id_seq', 'usage') or has_sequence_privilege('authenticated', 'fin_auditoria_id_seq', 'usage') then raise exception 'FALHA 5b: sequencia da auditoria acessivel'; end if;
end $$;

rollback;
\echo 'TESTES CANCELAMENTO DO PAR PASSARAM'
