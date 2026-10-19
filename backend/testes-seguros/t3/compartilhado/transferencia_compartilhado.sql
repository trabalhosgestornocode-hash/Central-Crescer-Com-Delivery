-- T3 COMPARTILHADO — transferência de unidades × Financeiro (120 §5b) SÓ entre as organizações sintéticas [T3-FIN]. Rodar pelo t3c.mjs
-- (passo "provas transferencia"), DEPOIS da semente: embrulho em READ COMMITTED (a guarda exige), conferência da allowlist antes do COMMIT.
-- Ator sintético (sem linha em auth.users: plataforma_auditoria.ator_id não tem FK).
\set ON_ERROR_STOP off
\set OA '00000000-0000-0000-0000-0000000f1a01'
\set OB '00000000-0000-0000-0000-0000000f1a02'
\set LIVRE '00000000-0000-0000-0000-0000000f1a15'
\set COM_FIN '00000000-0000-0000-0000-0000000f1a11'
\set ATOR '00000000-0000-0000-0000-0000000f1a21'
create or replace function pg_temp.t3c_exp(label text, sql text, esperado text) returns void language plpgsql as $$
declare estado text := 'ok'; msg text := '';
begin
  begin execute sql; exception when others then estado := sqlstate; msg := sqlerrm; end;
  if (esperado = 'ok' and estado = 'ok') or (esperado <> 'ok' and (estado = esperado or msg like '%' || esperado || '%')) then
    raise notice 'PASS  % [%]', label, case when estado = 'ok' then 'ok' else left(msg, 90) end;
  else raise notice 'FALHA % (esperado %, veio % %)', label, esperado, estado, left(msg, 140); end if;
end $$;
set role service_role;
select pg_temp.t3c_exp('TC1 unidade SEM Financeiro transfere A -> B',
  format('select transferir_unidade_organizacao(%L, %L, %L)', :'LIVRE', :'OB', :'ATOR'), 'ok');
select pg_temp.t3c_exp('TC2 e volta B -> A',
  format('select transferir_unidade_organizacao(%L, %L, %L)', :'LIVRE', :'OA', :'ATOR'), 'ok');
select pg_temp.t3c_exp('TC3 unidade COM Financeiro: transferência recusada (22023)',
  format('select transferir_unidade_organizacao(%L, %L, %L)', :'COM_FIN', :'OB', :'ATOR'), '22023');
select pg_temp.t3c_exp('TC4 unidade COM Financeiro: UPDATE direto de organizacao_id recusado (gatilho)',
  format('update public.unidades set organizacao_id = %L where id = %L', :'OB', :'COM_FIN'), '22023');
select pg_temp.t3c_exp('TC5 outras colunas da unidade com Financeiro continuam editáveis',
  format('update public.unidades set nome = nome where id = %L', :'COM_FIN'), 'ok');
reset role;
set role anon;
select pg_temp.t3c_exp('TC6 anon não executa a guarda financeira',
  format('select gestao_financeira_verificar_unidade_transferivel(%L)', :'COM_FIN'), '42501');
reset role;
do $tc$
begin
  if (select organizacao_id from public.unidades where id = '00000000-0000-0000-0000-0000000f1a15') = '00000000-0000-0000-0000-0000000f1a01'
     and (select organizacao_id from public.unidades where id = '00000000-0000-0000-0000-0000000f1a11') = '00000000-0000-0000-0000-0000000f1a01'
     and not exists (select 1 from public.fin_contas c join public.unidades u on u.id = c.unidade_id where c.organizacao_id <> u.organizacao_id) then
    raise notice 'PASS  TC7 estado final: as duas unidades na Org A; nenhum registro financeiro com empresa diferente da unidade';
  else raise notice 'FALHA TC7 estado final inesperado'; end if;
end $tc$;
