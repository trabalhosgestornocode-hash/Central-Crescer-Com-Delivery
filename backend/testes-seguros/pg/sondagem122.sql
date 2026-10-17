-- Sondagens da 122 sobre o banco "sim" (120+121+122 aplicadas COMO dono não-superusuário, default privileges do Supabase simulados).
-- Tudo roda como service_role (o único papel do backend). Dados sintéticos.
\set ON_ERROR_STOP off
\set O '00000000-0000-0000-0000-0000000000a1'
\set U '00000000-0000-0000-0000-0000000000a2'
\set USR '00000000-0000-0000-0000-000000000999'
\set OB '00000000-0000-0000-0000-0000000000b1'
\set UB '00000000-0000-0000-0000-0000000000b2'
insert into organizacoes(id,nome) values (:'OB','Org B') on conflict do nothing;
insert into unidades(id,organizacao_id,nome) values (:'UB',:'OB','UB') on conflict do nothing;
insert into fin_plano_contas(id,organizacao_id,tipo,natureza,nome,papel) values
 ('00000000-0000-0000-0000-0000000000f1',:'O','RECEITA','RECEBIMENTO','VENDAS','receita_operacional'),
 ('00000000-0000-0000-0000-0000000000f2',:'O','TRANSFERENCIA','ENTRE CONTAS','ENTRE CONTAS','transferencia'),
 ('00000000-0000-0000-0000-0000000000f3',:'OB','RECEITA','RECEBIMENTO','VENDAS','receita_operacional');
insert into fin_contas(id,organizacao_id,unidade_id,nome) values
 ('00000000-0000-0000-0000-0000000000e1',:'O',:'U','A'),('00000000-0000-0000-0000-0000000000e2',:'O',:'U','B'),('00000000-0000-0000-0000-0000000000e3',:'OB',:'UB','X');
insert into fin_lancamentos(id,organizacao_id,unidade_id,conta_id,categoria_id,descricao,sentido,valor_centavos,data_movimento) values
 ('00000000-0000-0000-0000-0000000000d1',:'O',:'U','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000f1','Venda out','entrada',10000,'2026-10-05'),
 ('00000000-0000-0000-0000-0000000000d2',:'O',:'U','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000f1','Venda set','entrada',20000,'2026-09-10');

\echo '== B. FECHAMENTO do mês 2026-09 (como service_role, pelas funções) =='
set role service_role;
select (fin_abrir_periodo(:'O',:'U',:'USR','2026-09-01')->>'versao') as versao \gset
select fin_fingerprint_periodo(:'O',:'U','2026-09-01') as fp \gset
select fin_fechar_periodo(:'O',:'U',:'USR','2026-09-01', :versao::int, :'fp', '{"teste":true}', 0, false)->>'status' as status_fechado;
reset role;

\echo '== C. BLOQUEIOS em mês FECHADO (todos esperados: ERRO fin_periodo_fechado) =='
set role service_role;
\echo 'C1 insert lançamento'
insert into fin_lancamentos(organizacao_id,unidade_id,conta_id,categoria_id,descricao,sentido,valor_centavos,data_movimento) values (:'O',:'U','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000f1','x','entrada',100,'2026-09-20');
\echo 'C2 update lançamento (descrição)'
update fin_lancamentos set descricao='alterada' where id='00000000-0000-0000-0000-0000000000d2';
\echo 'C3 mover lançamento de mês aberto para fechado'
update fin_lancamentos set data_movimento='2026-09-15' where id='00000000-0000-0000-0000-0000000000d1';
\echo 'C4 mover lançamento de mês fechado para aberto'
update fin_lancamentos set data_movimento='2026-10-15' where id='00000000-0000-0000-0000-0000000000d2';
\echo 'C5 insert referência'
insert into fin_referencias(organizacao_id,unidade_id,data,tipo,valor_centavos,fonte) values (:'O',:'U','2026-09-10','venda',100,'manual');
\echo 'C6 insert resolução de conciliação'
insert into fin_conciliacao_resolucoes(organizacao_id,unidade_id,escopo,chave,classificacao,valor_centavos,diferenca_no_momento_centavos,nota) values (:'O',:'U','caixa_dia','2026-09-10','ajuste',100,100,'nota valida');
\echo 'C7 insert saldo de abertura'
insert into fin_saldos_abertura(organizacao_id,unidade_id,conta_id,data_referencia,valor_centavos) values (:'O',:'U','00000000-0000-0000-0000-0000000000e1','2026-09-01',100);
\echo 'C8 alterar snapshot/fechado_em do período fechado'
update fin_periodos set snapshot='{"adulterado":true}' where mes='2026-09-01' and unidade_id=:'U';
\echo 'C9 fechar de novo'
select fin_fechar_periodo(:'O',:'U',:'USR','2026-09-01', 99, 'x', '{}', 0, false);
reset role;

\echo '== D. REABERTURA em nível de banco (decisão: reabrir deve permanecer DESABILITADA) =='
set role service_role;
\echo 'D1 UPDATE direto fechado -> reaberto como service_role (esperado: BLOQUEADO; se passar = brecha)'
update fin_periodos set status='reaberto', motivo_reabertura='reabertura direta de teste' where mes='2026-09-01' and unidade_id=:'U' returning status;
reset role;
select status as status_apos_tentativa_direta from fin_periodos where mes='2026-09-01' and unidade_id=:'U';
\echo 'D2 EXECUTE de fin_reabrir_periodo pelo service_role (esperado: sem EXECUTE; se executar = brecha)'
set role service_role;
select fin_reabrir_periodo(:'O',:'U',:'USR','2026-09-01', (select versao from fin_periodos where mes='2026-09-01' and unidade_id=:'U'), 'reabertura por funcao de teste') ->> 'status' as via_funcao;
reset role;

\echo '== E. importacao_id entre tenants =='
insert into fin_importacoes(id,organizacao_id,unidade_id,arquivo_hash,previa) values ('00000000-0000-0000-0000-0000000000c9',:'OB',:'UB','h','{}');
set role service_role;
\echo 'E1 lançamento da Org A apontando para a importação da Org B (esperado: ERRO; se passar = FK sem escopo de tenant)'
insert into fin_lancamentos(organizacao_id,unidade_id,conta_id,categoria_id,descricao,sentido,valor_centavos,data_movimento,importacao_id,origem,chave_origem) values (:'O',:'U','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000f1','x','entrada',100,'2026-10-07','00000000-0000-0000-0000-0000000000c9','importacao','k1');
reset role;

\echo '== G. INTEGRIDADE DE TRANSFERÊNCIA =='
set role service_role;
select fin_criar_transferencia(:'O',:'U',:'USR','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000e2',5000,'2026-10-06','Transf','00000000-0000-0000-0000-0000000000f2') as par \gset
select lancamento_saida_id as perna_s, lancamento_entrada_id as perna_e from fin_transferencias where id = :'par' \gset
\echo 'G1 trocar a CATEGORIA de uma perna vinculada (R5) (esperado ERRO)'
update fin_lancamentos set categoria_id='00000000-0000-0000-0000-0000000000f1' where id=:'perna_s';
\echo 'G2 mudar valor / conta / data / sentido de perna vinculada (esperado 4 ERROS)'
update fin_lancamentos set valor_centavos=1 where id=:'perna_s';
update fin_lancamentos set conta_id='00000000-0000-0000-0000-0000000000e2' where id=:'perna_s';
update fin_lancamentos set data_movimento='2026-10-07' where id=:'perna_s';
update fin_lancamentos set sentido='entrada' where id=:'perna_s';
\echo 'G3 cancelar UMA perna isolada (esperado ERRO)'
update fin_lancamentos set status='cancelado' where id=:'perna_s';
\echo 'G4 mexer no par: trocar pernas / cancelar o par sem a função (esperado 2 ERROS)'
update fin_transferencias set lancamento_saida_id=:'perna_e' where id=:'par';
update fin_transferencias set status='cancelada', cancelada_por=:'USR', cancelada_em=now(), motivo_cancelamento='motivo com mais de dez' where id=:'par';
\echo 'G5 DELETE do par pelo service_role (esperado permission denied)'
delete from fin_transferencias where id=:'par';
\echo 'G6 desvincular SEM motivo (121) (esperado permission denied) e COM motivo curto (esperado ERRO)'
select fin_desvincular_transferencia(:'O',:'U',:'USR',:'par');
select fin_desvincular_transferencia_motivada(:'O',:'U',:'USR',:'par','curto');
\echo 'G7 outra organização tenta cancelar o par (esperado: erro "nao encontrada")'
select fin_cancelar_transferencia(:'OB',:'UB',:'USR',:'par','motivo suficientemente longo');
reset role;
\echo 'G8 spoof da flag local + cancelar UMA perna: o gatilho de linha cede, a REDE NO COMMIT deve recusar (esperado ERRO fin_transferencia_parcial)'
set role service_role;
begin;
select set_config('fin.cancelando_par', :'par', true);
update fin_lancamentos set status='cancelado' where id=:'perna_s';
commit;
reset role;
select status as perna_s_status_apos_spoof from fin_lancamentos where id=:'perna_s';
\echo 'G9 cancelamento legítimo do par (esperado OK) e repetição idempotente (esperado jaCancelada=true)'
set role service_role;
select fin_cancelar_transferencia(:'O',:'U',:'USR',:'par','motivo suficientemente longo')->>'jaCancelada' as primeira;
select fin_cancelar_transferencia(:'O',:'U',:'USR',:'par','outro motivo bem longo')->>'jaCancelada' as repeticao;
reset role;
select count(*) filter (where status='cancelado') as pernas_canceladas, (select status from fin_transferencias where id=:'par') as par_status, (select count(*) from fin_auditoria where entidade_id in (:'perna_s'::text,:'perna_e'::text) and acao='fin_lancamentos.update') as linhas_auditoria_pernas from fin_lancamentos where id in (:'perna_s',:'perna_e');
\echo 'G10 par cancelado é imutável / não desvincula (esperado 2 ERROS)'
set role service_role;
update fin_transferencias set motivo_cancelamento='alterado depois' where id=:'par';
select fin_desvincular_transferencia_motivada(:'O',:'U',:'USR',:'par','motivo suficientemente longo');
reset role;
