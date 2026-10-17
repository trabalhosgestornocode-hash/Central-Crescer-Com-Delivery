-- Sondagens da REVISÃO FORMAL da Migration 121 (privilégios, RLS, escalonamento por RPC, integridade). Banco DESCARTÁVEL, dados sintéticos.
-- Executa como superusuário e alterna para `service_role` (papel do backend) / `anon` / `authenticated` com SET ROLE.
\set ON_ERROR_STOP on
begin;

create temp table ctx as
select gen_random_uuid() org1, gen_random_uuid() org2, gen_random_uuid() u1, gen_random_uuid() u3, gen_random_uuid() usr;
grant select on ctx to public;
insert into organizacoes (id, nome) select org1, 'O1' from ctx union all select org2, 'O2' from ctx;
insert into unidades (id, organizacao_id, nome) select u1, org1, 'U1' from ctx union all select u3, org2, 'U3' from ctx;
do $$
declare c ctx;
begin
  select * into c from ctx;
  insert into fin_plano_contas (organizacao_id, tipo, natureza, nome, papel) values (c.org1, 'T', 'N', 'TRANSF', 'transferencia'), (c.org1, 'D', 'F', 'DESP', 'despesa_fixa');
  insert into fin_contas (organizacao_id, unidade_id, nome) values (c.org1, c.u1, 'A'), (c.org1, c.u1, 'B');
end $$;

-- R1: anon e authenticated não têm NENHUM acesso (tabelas, funções)
do $$
declare t text; r text; f text;
begin
  foreach t in array array['fin_plano_contas','fin_contas','fin_saldos_abertura','fin_lancamentos','fin_transferencias','fin_periodos','fin_importacoes','fin_auditoria'] loop
    foreach r in array array['anon','authenticated'] loop
      if has_any_column_privilege(r, ('public.' || t)::regclass, 'select,insert,update,references') or has_table_privilege(r, ('public.' || t)::regclass, 'delete,truncate,trigger') then
        raise exception 'FALHA R1: % tem privilegio em %', r, t;
      end if;
    end loop;
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception 'FALHA R1: RLS desligado em %', t; end if;
    if (select count(*) from pg_policies where schemaname = 'public' and tablename = t) <> 0 then raise exception 'FALHA R1: policy em %', t; end if;
  end loop;
  foreach f in array array['fin_confirmar_importacao(uuid,uuid,uuid,uuid)','fin_criar_transferencia(uuid,uuid,uuid,uuid,uuid,bigint,date,text,uuid)','fin_vincular_transferencia(uuid,uuid,uuid,uuid,uuid)','fin_desvincular_transferencia(uuid,uuid,uuid,uuid)'] loop
    foreach r in array array['anon','authenticated'] loop
      if has_function_privilege(r, ('public.' || f)::regprocedure, 'execute') then raise exception 'FALHA R1: % executa %', r, f; end if;
    end loop;
    -- com o 122 aplicado o desvinculo SEM motivo sai do service_role de proposito (existe a versao motivada)
    if not has_function_privilege('service_role', ('public.' || f)::regprocedure, 'execute')
       and not (f like 'fin_desvincular_transferencia(%' and to_regprocedure('fin_desvincular_transferencia_motivada(uuid,uuid,uuid,uuid,text)') is not null) then
      raise exception 'FALHA R1: service_role sem execute em %', f;
    end if;
  end loop;
end $$;

-- R2: service_role: sem DELETE/TRUNCATE em nenhuma tabela; auditoria só leitura
do $$
declare t text;
begin
  foreach t in array array['fin_plano_contas','fin_contas','fin_saldos_abertura','fin_lancamentos','fin_transferencias','fin_periodos','fin_importacoes','fin_auditoria'] loop
    if has_table_privilege('service_role', ('public.' || t)::regclass, 'delete,truncate') then raise exception 'FALHA R2: service_role com delete/truncate em %', t; end if;
  end loop;
  if has_table_privilege('service_role', 'public.fin_auditoria'::regclass, 'insert,update') then raise exception 'FALHA R2: service_role escreve na auditoria'; end if;
end $$;

-- R3: como service_role de verdade: delete direto negado; auditoria imutável; funções DEFINER não são escalonáveis
set role service_role;
do $$
declare c ctx; ok boolean := false;
begin
  select * into c from ctx;
  begin delete from fin_lancamentos; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FALHA R3a: service_role apagou lancamentos'; end if;
  ok := false;
  begin delete from fin_auditoria; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FALHA R3b'; end if;
  ok := false;
  begin insert into fin_auditoria (acao, entidade) values ('x', 'y'); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FALHA R3c: service_role escreveu auditoria diretamente'; end if;
  -- trigger function DEFINER não pode ser chamada diretamente (sem escalonamento)
  ok := false;
  begin perform fin_auditar(); exception when others then ok := true; end;
  if not ok then raise exception 'FALHA R3d: fin_auditar chamavel diretamente'; end if;
end $$;
reset role;

-- R4: desvincular (SECURITY DEFINER) é escopado: outra organização/unidade não consegue desfazer par alheio; funções checam tenant
do $$
declare c ctx; a uuid; b uuid; cat uuid; par uuid; ok boolean;
begin
  select * into c from ctx;
  select id into a from fin_contas where nome = 'A' and unidade_id = c.u1; select id into b from fin_contas where nome = 'B' and unidade_id = c.u1;
  select id into cat from fin_plano_contas where organizacao_id = c.org1 and papel = 'transferencia';
  par := fin_criar_transferencia(c.org1, c.u1, c.usr, a, b, 500, '2026-09-01', 't', cat);
  set local role service_role;
  if to_regprocedure('fin_desvincular_transferencia_motivada(uuid,uuid,uuid,uuid,text)') is not null then
    ok := fin_desvincular_transferencia_motivada(c.org2, c.u3, c.usr, par, 'motivo suficientemente longo');        -- tenant errado
  else ok := fin_desvincular_transferencia(c.org2, c.u3, c.usr, par); end if;
  if ok then raise exception 'FALHA R4a: desvinculou par de outro tenant'; end if;
  if to_regprocedure('fin_desvincular_transferencia_motivada(uuid,uuid,uuid,uuid,text)') is not null then
    ok := fin_desvincular_transferencia_motivada(c.org1, c.u3, c.usr, par, 'motivo suficientemente longo');        -- unidade errada
  else ok := fin_desvincular_transferencia(c.org1, c.u3, c.usr, par); end if;
  if ok then raise exception 'FALHA R4b: desvinculou com unidade errada'; end if;
  if not exists (select 1 from fin_transferencias where id = par) then raise exception 'FALHA R4c: par sumiu'; end if;
  reset role;
end $$;

-- R5: integridade do par — alterar a CATEGORIA de uma perna vinculada para fora de "transferência" (achado da revisão)
do $$
declare c ctx; a uuid; b uuid; cat uuid; outra uuid; par uuid; sid uuid; ok boolean := false;
begin
  select * into c from ctx;
  select id into a from fin_contas where nome = 'A' and unidade_id = c.u1; select id into b from fin_contas where nome = 'B' and unidade_id = c.u1;
  select id into cat from fin_plano_contas where organizacao_id = c.org1 and papel = 'transferencia';
  select id into outra from fin_plano_contas where organizacao_id = c.org1 and papel = 'despesa_fixa';
  par := fin_criar_transferencia(c.org1, c.u1, c.usr, a, b, 777, '2026-09-02', 't2', cat);
  select lancamento_saida_id into sid from fin_transferencias where id = par;
  begin update fin_lancamentos set categoria_id = outra where id = sid; exception when sqlstate '23514' then ok := true; end;
  if not ok then raise exception 'ACHADO R5: perna de transferencia vinculada aceitou trocar de categoria (par fica inconsistente) — corrigido no 122'; end if;
end $$;

rollback;
\echo 'SONDAGENS 121 PASSARAM'
