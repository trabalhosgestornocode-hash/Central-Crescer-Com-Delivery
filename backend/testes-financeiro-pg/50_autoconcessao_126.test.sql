-- Migration 126: autoconcessão SÓ do SuperAdmin ATIVO da plataforma. Tudo dentro de uma transação desfeita no fim.
-- Rodar via run.sh (banco descartável). Cada caso levanta exceção com o nome do caso se o resultado for diferente do esperado.
\set ON_ERROR_STOP on
begin;
insert into organizacoes (id, nome) values ('00000000-0000-4000-8000-0000000a0001', 'Org 126'), ('00000000-0000-4000-8000-0000000a0002', 'Outra org');
insert into unidades (id, organizacao_id, nome) values
  ('00000000-0000-4000-8000-0000000b0001', '00000000-0000-4000-8000-0000000a0001', 'U1'),
  ('00000000-0000-4000-8000-0000000b0002', '00000000-0000-4000-8000-0000000a0002', 'U outra');
-- c1 = SuperAdmin ativo; c2 = conta comum; c3 = ex-SuperAdmin (inativo)
insert into perfis (id) values ('00000000-0000-4000-8000-0000000c0001'), ('00000000-0000-4000-8000-0000000c0002'), ('00000000-0000-4000-8000-0000000c0003');
insert into plataforma_admins (usuario_id, ativo) values ('00000000-0000-4000-8000-0000000c0001', true), ('00000000-0000-4000-8000-0000000c0003', false);
insert into perfis_operacionais (id, conta_id, nome) values
  ('00000000-0000-4000-8000-0000000d0001', '00000000-0000-4000-8000-0000000c0001', 'SuperAdmin'),
  ('00000000-0000-4000-8000-0000000d0002', '00000000-0000-4000-8000-0000000c0002', 'Comum'),
  ('00000000-0000-4000-8000-0000000d0003', '00000000-0000-4000-8000-0000000c0003', 'Ex-SuperAdmin');
insert into usuarios_organizacoes (usuario_id, organizacao_id, ativo) values
  ('00000000-0000-4000-8000-0000000c0001', '00000000-0000-4000-8000-0000000a0001', true),
  ('00000000-0000-4000-8000-0000000c0002', '00000000-0000-4000-8000-0000000a0001', true),
  ('00000000-0000-4000-8000-0000000c0003', '00000000-0000-4000-8000-0000000a0001', true);

create temp table _casos (nome text, esperado text, obtido text);
create or replace function pg_temp.tentar(p_nome text, p_esperado text, p_unidade uuid, p_org uuid, p_perfil uuid, p_por uuid) returns void
language plpgsql as $$
declare v text := 'ok';
begin
  begin
    insert into gestao_financeira_concessoes (organizacao_id, unidade_id, perfil_id, nivel, concedida_por, motivo)
    values (p_org, p_unidade, p_perfil, 'gestor', p_por, 'Teste da migration 126 (autoconcessão)');
  exception when others then v := sqlerrm;
  end;
  insert into _casos values (p_nome, p_esperado, v);
end $$;

-- 1. SuperAdmin ativo define o próprio acesso
select pg_temp.tentar('superadmin_se_concede', 'ok', '00000000-0000-4000-8000-0000000b0001', '00000000-0000-4000-8000-0000000a0001', '00000000-0000-4000-8000-0000000d0001', '00000000-0000-4000-8000-0000000c0001');
-- 2. Conta comum NÃO se autoconcede
select pg_temp.tentar('comum_se_concede', 'autoconcessão', '00000000-0000-4000-8000-0000000b0001', '00000000-0000-4000-8000-0000000a0001', '00000000-0000-4000-8000-0000000d0002', '00000000-0000-4000-8000-0000000c0002');
-- 3. SuperAdmin INATIVO não se autoconcede
select pg_temp.tentar('ex_superadmin_se_concede', 'autoconcessão', '00000000-0000-4000-8000-0000000b0001', '00000000-0000-4000-8000-0000000a0001', '00000000-0000-4000-8000-0000000d0003', '00000000-0000-4000-8000-0000000c0003');
-- 4. SuperAdmin concede a outra pessoa (sempre foi permitido)
select pg_temp.tentar('superadmin_concede_outro', 'ok', '00000000-0000-4000-8000-0000000b0001', '00000000-0000-4000-8000-0000000a0001', '00000000-0000-4000-8000-0000000d0002', '00000000-0000-4000-8000-0000000c0001');
-- 5. Mesmo o SuperAdmin precisa de vínculo com a empresa/unidade
select pg_temp.tentar('superadmin_sem_vinculo', 'vínculo', '00000000-0000-4000-8000-0000000b0002', '00000000-0000-4000-8000-0000000a0002', '00000000-0000-4000-8000-0000000d0001', '00000000-0000-4000-8000-0000000c0001');
-- 6. Segunda concessão ativa do mesmo perfil+unidade continua recusada
select pg_temp.tentar('superadmin_duplicada', 'uq_gfc_ativa', '00000000-0000-4000-8000-0000000b0001', '00000000-0000-4000-8000-0000000a0001', '00000000-0000-4000-8000-0000000d0001', '00000000-0000-4000-8000-0000000c0001');

do $$
declare r record; falhas int := 0;
begin
  for r in select * from _casos loop
    if (r.esperado = 'ok' and r.obtido <> 'ok') or (r.esperado <> 'ok' and position(r.esperado in r.obtido) = 0) then
      raise warning 'FALHA %: esperado %, obtido %', r.nome, r.esperado, r.obtido; falhas := falhas + 1;
    else raise notice 'OK    %', r.nome;
    end if;
  end loop;
  -- 7. A autoconcessão fica na trilha de auditoria como qualquer outra
  if not exists (select 1 from gestao_financeira_concessoes_auditoria a where a.perfil_id = '00000000-0000-4000-8000-0000000d0001' and a.evento = 'concedida' and a.ator_id = '00000000-0000-4000-8000-0000000c0001') then
    raise warning 'FALHA auditoria_da_autoconcessao'; falhas := falhas + 1;
  else raise notice 'OK    auditoria_da_autoconcessao';
  end if;
  if falhas > 0 then raise exception '126: % caso(s) falharam', falhas; end if;
  raise notice '126: 7/7 OK';
end $$;
rollback;
