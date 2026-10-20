-- D-1 (Agente 2, 2026-10-19): histórico de mês FECHADO não pode sair dele por UPDATE de data/chave, de escopo (organização/unidade) nem por DELETE.
-- Antes da correção, fin_guarda_periodo_data só conferia o mês NOVO: mover uma referência/resolução/abertura de um mês fechado para um aberto
-- passava e mudava a impressão digital do mês fechado. Rode no banco "sim" (sim_supabase.sh), DEPOIS dos demais adversariais ou sozinho.
-- Prova antes/depois: P122=<122 sem a correção> bash sim_supabase.sh && psql ... -f este arquivo  => FALHAs;  com a 122 corrigida => só PASS.
-- TRAVA DE AMBIENTE DESCARTÁVEL (cópia INLINE de t3/guarda_descartavel.sql: erro dentro de \ir NÃO encerra o script que incluiu)
\set ON_ERROR_STOP on
\if :{?CONFIRMO}
\else
  \set CONFIRMO 'ausente'
\endif
select (:'CONFIRMO' = 'ESTE_PROJETO_E_DESCARTAVEL') as guarda_confirmado \gset
\if :guarda_confirmado
\else
  do $guarda$ begin raise exception 'RECUSADO: rode com -v CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL (somente banco/projeto DESCARTAVEL).'; end $guarda$;
\endif
do $guarda$
begin
  if to_regclass('public.organizacoes') is not null
     and exists (select 1 from public.organizacoes where id::text not like '00000000-0000-0000-0000-0000000000__') then
    raise exception 'RECUSADO: ha organizacoes que nao sao de teste neste banco; isto nao parece um ambiente descartavel.';
  end if;
end $guarda$;
-- fim da trava
\set ON_ERROR_STOP off
\set O '00000000-0000-0000-0000-0000000000a1'
\set U '00000000-0000-0000-0000-0000000000a2'
\set U3 '00000000-0000-0000-0000-0000000000a4'
\set OB '00000000-0000-0000-0000-0000000000b1'
\set UB '00000000-0000-0000-0000-0000000000b2'
\set USR '00000000-0000-0000-0000-000000000999'
\set CAT '00000000-0000-0000-0000-0000000000f1'
\set K3 '00000000-0000-0000-0000-0000000000e5'
\set K3B '00000000-0000-0000-0000-0000000000e6'

-- ---- dados sintéticos (unidade própria U3 para não interferir nos outros adversariais) ----
insert into organizacoes(id,nome) values (:'OB','Org B') on conflict do nothing;
insert into unidades(id,organizacao_id,nome) values (:'UB',:'OB','UB') on conflict do nothing;
insert into unidades(id,organizacao_id,nome) values (:'U3',:'O','U3') on conflict do nothing;
insert into fin_plano_contas(id,organizacao_id,tipo,natureza,nome,papel) values (:'CAT',:'O','RECEITA','RECEBIMENTO','VENDAS','receita_operacional') on conflict do nothing;
insert into fin_contas(id,organizacao_id,unidade_id,nome) values (:'K3',:'O',:'U3','D1-A') on conflict do nothing;
insert into fin_contas(id,organizacao_id,unidade_id,nome) values (:'K3B',:'O',:'U3','D1-B') on conflict do nothing;

create or replace function pg_temp.exp(label text, stmt text, esperado text) returns void language plpgsql as $$
declare estado text := 'ok'; msg text := '';
begin
  begin execute stmt; exception when others then estado := sqlstate; msg := sqlerrm; end;
  if (esperado = 'ok' and estado = 'ok') or (esperado = 'erro' and estado <> 'ok') or (esperado not in ('ok','erro') and msg like '%' || esperado || '%') then
    raise notice 'PASS  % [%]', label, case when estado = 'ok' then 'ok' else left(msg, 90) end;
  else raise notice 'FALHA % (esperado %, veio % %)', label, esperado, estado, left(msg, 140); end if;
end $$;
create or replace function pg_temp.verdade(label text, ok boolean, detalhe text default '') returns void language plpgsql as $$
begin
  if coalesce(ok, false) then raise notice 'PASS  %', label; else raise notice 'FALHA % (%)', label, detalhe; end if;
end $$;

set role service_role;
-- MARÇO/2038 (será FECHADO): ponte conciliada (venda 100 − recebido 100 − taxa 0 = 0), dinheiro 0 sem caixa físico (= 0), resolução e abertura.
insert into fin_referencias(id,organizacao_id,unidade_id,data,tipo,canal,valor_centavos,fonte) values
  ('00000000-0000-0000-0000-0000000d1001',:'O',:'U3','2038-03-10','venda',null,100,'manual'),
  ('00000000-0000-0000-0000-0000000d1002',:'O',:'U3','2038-03-10','taxa','X',0,'manual'),
  ('00000000-0000-0000-0000-0000000d1003',:'O',:'U3','2038-03-11','dinheiro',null,0,'manual');
insert into fin_lancamentos(id,organizacao_id,unidade_id,conta_id,categoria_id,descricao,sentido,valor_centavos,data_movimento) values
  ('00000000-0000-0000-0000-0000000d1101',:'O',:'U3',:'K3',:'CAT','recebimento','entrada',100,'2038-03-10');
insert into fin_conciliacao_resolucoes(id,organizacao_id,unidade_id,escopo,chave,classificacao,valor_centavos,diferenca_no_momento_centavos,nota) values
  ('00000000-0000-0000-0000-0000000d1201',:'O',:'U3','caixa_dia','2038-03-12','ajuste',7,7,'resolucao sintetica marco');
insert into fin_saldos_abertura(id,organizacao_id,unidade_id,conta_id,data_referencia,valor_centavos) values
  ('00000000-0000-0000-0000-0000000d1301',:'O',:'U3',:'K3','2038-03-01',1000);
-- ABRIL/2038 (aberto): uma linha de cada para as operações legítimas e para o lote misto.
insert into fin_referencias(id,organizacao_id,unidade_id,data,tipo,canal,valor_centavos,fonte) values
  ('00000000-0000-0000-0000-0000000d1004',:'O',:'U3','2038-04-05','dinheiro',null,0,'manual'),
  ('00000000-0000-0000-0000-0000000d1005',:'O',:'U3','2038-04-06','dinheiro',null,0,'manual');
insert into fin_conciliacao_resolucoes(id,organizacao_id,unidade_id,escopo,chave,classificacao,valor_centavos,diferenca_no_momento_centavos,nota) values
  ('00000000-0000-0000-0000-0000000d1202',:'O',:'U3','caixa_dia','2038-04-07','ajuste',5,5,'resolucao sintetica abril');
insert into fin_saldos_abertura(id,organizacao_id,unidade_id,conta_id,data_referencia,valor_centavos) values
  ('00000000-0000-0000-0000-0000000d1302',:'O',:'U3',:'K3B','2038-04-01',500);
reset role;

select pg_temp.verdade('D1-pre março sem pendências de conciliação (fechamento legítimo possível)', cardinality(fin_conciliacao_pendencias_ids(:'O',:'U3','2038-03-01')) = 0,
  array_to_string(fin_conciliacao_pendencias_ids(:'O',:'U3','2038-03-01'), ','));
set role service_role;
select (fin_abrir_periodo(:'O',:'U3',:'USR','2038-03-01')->>'versao')::int as v \gset
select fin_fingerprint_periodo(:'O',:'U3','2038-03-01') as fp \gset
select fin_fechar_periodo(:'O',:'U3',:'USR','2038-03-01', :v, :'fp', '{"t":1}', array[]::text[], false)->>'status' as status_marco \gset
reset role;
select pg_temp.verdade('D1-pre março FECHADO pelo caminho legítimo', :'status_marco' = 'fechado', :'status_marco');
select fin_fingerprint_periodo(:'O',:'U3','2038-03-01') as fp_fechado \gset
select count(*) as aud_antes from fin_auditoria \gset

-- ================= ATAQUES (service_role = o backend; privilégios homologados: SELECT/INSERT/UPDATE, sem DELETE) =================
set role service_role;
-- referências
select pg_temp.exp('D1-01 referência: data de mês FECHADO -> mês aberto', $q$ update fin_referencias set data = '2038-04-11' where id = '00000000-0000-0000-0000-0000000d1003' $q$, 'fin_periodo_fechado');
select pg_temp.exp('D1-02 referência: data de mês aberto -> mês FECHADO', $q$ update fin_referencias set data = '2038-03-20' where id = '00000000-0000-0000-0000-0000000d1004' $q$, 'fin_periodo_fechado');
select pg_temp.exp('D1-03 referência: cancelar no mês FECHADO', $q$ update fin_referencias set status = 'cancelada', motivo_cancelamento = 'teste d1' where id = '00000000-0000-0000-0000-0000000d1001' $q$, 'fin_periodo_fechado');
select pg_temp.exp('D1-04 referência: trocar a unidade (mesma organização) no mês FECHADO', $q$ update fin_referencias set unidade_id = '00000000-0000-0000-0000-0000000000a2' where id = '00000000-0000-0000-0000-0000000d1002' $q$, 'fin_campo_imutavel');
select pg_temp.exp('D1-05 referência: trocar organização e unidade (outra empresa) no mês FECHADO', $q$ update fin_referencias set organizacao_id = '00000000-0000-0000-0000-0000000000b1', unidade_id = '00000000-0000-0000-0000-0000000000b2' where id = '00000000-0000-0000-0000-0000000d1002' $q$, 'fin_campo_imutavel');
select pg_temp.exp('D1-06 referência: trocar a unidade de linha de mês ABERTO (escopo é imutável)', $q$ update fin_referencias set unidade_id = '00000000-0000-0000-0000-0000000000a2' where id = '00000000-0000-0000-0000-0000000d1005' $q$, 'fin_campo_imutavel');
-- resoluções (chave = dia ou 1º do mês; escopo da conciliação)
select pg_temp.exp('D1-07 resolução: chave de mês FECHADO -> mês aberto', $q$ update fin_conciliacao_resolucoes set chave = '2038-04-12' where id = '00000000-0000-0000-0000-0000000d1201' $q$, 'fin_periodo_fechado');
select pg_temp.exp('D1-08 resolução: escopo+chave (vira ponte do mês aberto)', $q$ update fin_conciliacao_resolucoes set escopo = 'ponte_mensal', chave = '2038-04-01' where id = '00000000-0000-0000-0000-0000000d1201' $q$, 'fin_periodo_fechado');
select pg_temp.exp('D1-09 resolução: revogar no mês FECHADO', $q$ update fin_conciliacao_resolucoes set status = 'revogada', motivo_revogacao = 'teste d1 revogacao' where id = '00000000-0000-0000-0000-0000000d1201' $q$, 'fin_periodo_fechado');
select pg_temp.exp('D1-10 resolução: trocar organização e unidade no mês FECHADO', $q$ update fin_conciliacao_resolucoes set organizacao_id = '00000000-0000-0000-0000-0000000000b1', unidade_id = '00000000-0000-0000-0000-0000000000b2' where id = '00000000-0000-0000-0000-0000000d1201' $q$, 'fin_campo_imutavel');
-- saldos de abertura
select pg_temp.exp('D1-11 abertura: data de mês FECHADO -> mês aberto', $q$ update fin_saldos_abertura set data_referencia = '2038-04-02' where id = '00000000-0000-0000-0000-0000000d1301' $q$, 'fin_periodo_fechado');
select pg_temp.exp('D1-12 abertura: valor no mês FECHADO', $q$ update fin_saldos_abertura set valor_centavos = 1 where id = '00000000-0000-0000-0000-0000000d1301' $q$, 'fin_periodo_fechado');
select pg_temp.exp('D1-13 abertura: trocar a unidade no mês FECHADO', $q$ update fin_saldos_abertura set unidade_id = '00000000-0000-0000-0000-0000000000a2' where id = '00000000-0000-0000-0000-0000000d1301' $q$, 'erro');
-- lote: uma única instrução que pega linhas de mês aberto E de mês fechado -> tudo recusado (nenhuma linha muda)
select pg_temp.exp('D1-14 lote misto em referências (aberto + fechado) numa instrução', $q$ update fin_referencias set data = data + 40 where unidade_id = '00000000-0000-0000-0000-0000000000a4' $q$, 'fin_periodo_fechado');
select pg_temp.verdade('D1-14b lote recusado não alterou nem a linha de mês ABERTO', (select data from fin_referencias where id = '00000000-0000-0000-0000-0000000d1004') = '2038-04-05');
select pg_temp.exp('D1-15 lote via UPDATE ... FROM em resoluções', $q$ update fin_conciliacao_resolucoes x set chave = v.nova from (values ('00000000-0000-0000-0000-0000000d1202'::uuid, '2038-05-07'::date), ('00000000-0000-0000-0000-0000000d1201'::uuid, '2038-05-12'::date)) v(id, nova) where x.id = v.id $q$, 'fin_periodo_fechado');
select pg_temp.verdade('D1-15b lote recusado não alterou a resolução de mês ABERTO', (select chave from fin_conciliacao_resolucoes where id = '00000000-0000-0000-0000-0000000d1202') = '2038-04-07');
select pg_temp.exp('D1-16 lote em aberturas (aberto + fechado)', $q$ update fin_saldos_abertura set data_referencia = data_referencia + 1 where unidade_id = '00000000-0000-0000-0000-0000000000a4' $q$, 'fin_periodo_fechado');
-- atomicidade dentro de uma transação explícita: primeiro muda uma linha aberta, depois tenta a fechada -> nada persiste
select pg_temp.exp('D1-17 transação: altera linha aberta e depois a fechada (tudo desfeito)', $q$ do $d$ begin update fin_referencias set data = '2038-04-20' where id = '00000000-0000-0000-0000-0000000d1005'; update fin_referencias set data = '2038-04-21' where id = '00000000-0000-0000-0000-0000000d1003'; end $d$ $q$, 'fin_periodo_fechado');
select pg_temp.verdade('D1-17b a linha aberta da transação desfeita ficou como estava', (select data from fin_referencias where id = '00000000-0000-0000-0000-0000000d1005') = '2038-04-06');
-- DELETE: o modelo homologado não dá DELETE ao backend
select pg_temp.exp('D1-18 DELETE de referência pelo service_role', $q$ delete from fin_referencias where id = '00000000-0000-0000-0000-0000000d1003' $q$, 'permission denied');
select pg_temp.exp('D1-19 DELETE de abertura pelo service_role', $q$ delete from fin_saldos_abertura where id = '00000000-0000-0000-0000-0000000d1301' $q$, 'permission denied');
-- lançamento (regressão: a guarda dele já conferia o mês antigo)
select pg_temp.exp('D1-20 lançamento: data de mês FECHADO -> mês aberto (regressão)', $q$ update fin_lancamentos set data_movimento = '2038-04-10' where id = '00000000-0000-0000-0000-0000000d1101' $q$, 'fin_periodo_fechado');
-- inserir no mês fechado continua recusado
select pg_temp.exp('D1-21 inserir referência no mês FECHADO', $q$ insert into fin_referencias(organizacao_id,unidade_id,data,tipo,valor_centavos,fonte) values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a4','2038-03-15','dinheiro',0,'manual') $q$, 'fin_periodo_fechado');

-- ================= OPERAÇÕES LEGÍTIMAS entre meses ABERTOS (não podem quebrar) =================
select pg_temp.exp('D1-L1 referência: abril -> maio (ambos abertos)', $q$ update fin_referencias set data = '2038-05-05' where id = '00000000-0000-0000-0000-0000000d1004' $q$, 'ok');
select pg_temp.exp('D1-L2 referência: cancelar em mês aberto', $q$ update fin_referencias set status = 'cancelada', motivo_cancelamento = 'teste legitimo' where id = '00000000-0000-0000-0000-0000000d1005' $q$, 'ok');
select pg_temp.exp('D1-L3 resolução: abril -> maio (ambos abertos)', $q$ update fin_conciliacao_resolucoes set chave = '2038-05-07' where id = '00000000-0000-0000-0000-0000000d1202' $q$, 'ok');
select pg_temp.exp('D1-L4 resolução: revogar em mês aberto', $q$ update fin_conciliacao_resolucoes set status = 'revogada', motivo_revogacao = 'teste legitimo revogacao' where id = '00000000-0000-0000-0000-0000000d1202' $q$, 'ok');
select pg_temp.exp('D1-L5 abertura: abril -> maio (ambos abertos)', $q$ update fin_saldos_abertura set data_referencia = '2038-05-01' where id = '00000000-0000-0000-0000-0000000d1302' $q$, 'ok');
select pg_temp.exp('D1-L6 abertura: regravar (upsert) no mês aberto, como a aplicação faz', $q$ insert into fin_saldos_abertura(organizacao_id,unidade_id,conta_id,data_referencia,valor_centavos) values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-0000000000e6','2038-05-01',600) on conflict (conta_id, data_referencia) do update set valor_centavos = excluded.valor_centavos $q$, 'ok');
select pg_temp.exp('D1-L7 lote só com linhas abertas (maio -> junho)', $q$ update fin_referencias set data = data + 31 where unidade_id = '00000000-0000-0000-0000-0000000000a4' and data >= '2038-05-01' $q$, 'ok');
reset role;

-- ================= DONO/superusuário: o gatilho também vale fora do backend =================
select pg_temp.exp('D1-22 DELETE de referência do mês FECHADO pelo dono', $q$ delete from fin_referencias where id = '00000000-0000-0000-0000-0000000d1003' $q$, 'fin_periodo_fechado');
select pg_temp.exp('D1-23 DELETE de resolução do mês FECHADO pelo dono', $q$ delete from fin_conciliacao_resolucoes where id = '00000000-0000-0000-0000-0000000d1201' $q$, 'fin_periodo_fechado');
select pg_temp.exp('D1-24 DELETE de abertura do mês FECHADO pelo dono', $q$ delete from fin_saldos_abertura where id = '00000000-0000-0000-0000-0000000d1301' $q$, 'fin_periodo_fechado');
select pg_temp.exp('D1-25 UPDATE de data do mês FECHADO pelo dono', $q$ update fin_referencias set data = '2038-04-30' where id = '00000000-0000-0000-0000-0000000d1001' $q$, 'fin_periodo_fechado');

-- ================= O HISTÓRICO FECHADO FICOU INTACTO =================
select pg_temp.verdade('D1-H1 impressão digital do mês fechado inalterada', fin_fingerprint_periodo(:'O',:'U3','2038-03-01') = :'fp_fechado');
select pg_temp.verdade('D1-H2 as 3 referências de março continuam em março, ativas e na unidade U3',
  (select count(*) from fin_referencias where unidade_id = :'U3' and organizacao_id = :'O' and data between '2038-03-01' and '2038-03-31' and status = 'ativa') = 3);
select pg_temp.verdade('D1-H3 a resolução de março continua vigente em março',
  (select count(*) from fin_conciliacao_resolucoes where id = '00000000-0000-0000-0000-0000000d1201' and chave = '2038-03-12' and status = 'vigente' and unidade_id = :'U3') = 1);
select pg_temp.verdade('D1-H4 a abertura de março continua igual',
  (select count(*) from fin_saldos_abertura where id = '00000000-0000-0000-0000-0000000d1301' and data_referencia = '2038-03-01' and valor_centavos = 1000 and unidade_id = :'U3') = 1);
select pg_temp.verdade('D1-H5 nenhuma linha de auditoria sobre registros de março depois do fechamento',
  not exists (select 1 from fin_auditoria where id > :aud_antes and entidade_id in ('00000000-0000-0000-0000-0000000d1001','00000000-0000-0000-0000-0000000d1002','00000000-0000-0000-0000-0000000d1003','00000000-0000-0000-0000-0000000d1101','00000000-0000-0000-0000-0000000d1201','00000000-0000-0000-0000-0000000d1301')));
select pg_temp.verdade('D1-H6 as operações legítimas ficaram auditadas (antes/depois)',
  (select count(*) from fin_auditoria where id > :aud_antes and entidade_id in ('00000000-0000-0000-0000-0000000d1004','00000000-0000-0000-0000-0000000d1005','00000000-0000-0000-0000-0000000d1202','00000000-0000-0000-0000-0000000d1302') and antes is not null and depois is not null) >= 6);
select pg_temp.verdade('D1-H7 status do período de março continua fechado', (select status from fin_periodos where unidade_id = :'U3' and mes = '2038-03-01') = 'fechado');
