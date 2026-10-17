#!/usr/bin/env bash
# Concorrência REAL com duas sessões: uma escrita em andamento (com a trava do período) x um fechamento com impressão antiga.
# Esperado: o fechamento ESPERA a escrita terminar e então é recusado por conflito de dados (nunca fecha ignorando a escrita).
# Chamado por run.sh (herda HOST, PORT, PSQL, DB). Dados sintéticos; usa o banco descartável recém-criado.
set -euo pipefail
q() { "$PSQL" -h "$HOST" -p "$PORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q -t -A "$@"; }

IDS=$(q -c "
with o as (insert into organizacoes (nome) values ('Org conc') returning id),
     u as (insert into unidades (organizacao_id, nome) select id, 'U conc' from o returning id, organizacao_id),
     p as (insert into fin_plano_contas (organizacao_id, tipo, natureza, nome, papel) select organizacao_id, 'R', 'R', 'VENDAS', 'receita_operacional' from u returning id),
     c as (insert into fin_contas (organizacao_id, unidade_id, nome) select organizacao_id, id, 'BANCO' from u returning id)
select (select id from o) || ',' || (select id from u) || ',' || (select id from p) || ',' || (select id from c);")
ORG=${IDS%%,*}; REST=${IDS#*,}; UNI=${REST%%,*}; REST=${REST#*,}; CAT=${REST%%,*}; CONTA=${REST#*,}
USR=00000000-0000-4000-8000-000000000003

q -c "insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, categoria_id, descricao, sentido, valor_centavos, data_movimento) values ('$ORG','$UNI','$CONTA','$CAT','base','entrada',1000,'2027-03-02');" >/dev/null
VERSAO=$(q -c "select (fin_abrir_periodo('$ORG','$UNI','$USR','2027-03-01')->>'versao');")
FP=$(q -c "select fin_fingerprint_periodo('$ORG','$UNI','2027-03-01');")

# Sessão A: grava um lançamento no mês e SEGURA a transação por 4 s
( q -c "begin; insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, categoria_id, descricao, sentido, valor_centavos, data_movimento) values ('$ORG','$UNI','$CONTA','$CAT','concorrente','entrada',500,'2027-03-03'); select pg_sleep(4); commit;" >/dev/null ) &
PID=$!
sleep 1

# Sessão B: tenta fechar com a impressão antiga. Deve BLOQUEAR até A terminar e então falhar por conflito de dados.
INI=$(date +%s)
set +e
SAIDA=$(q -c "select fin_fechar_periodo('$ORG','$UNI','$USR','2027-03-01',$VERSAO,'$FP','{}'::jsonb,0,false);" 2>&1)
COD=$?
set -e
FIM=$(date +%s)
wait $PID
[ $COD -ne 0 ] || { echo "FALHA: o fechamento concorrente teve sucesso: $SAIDA"; exit 1; }
echo "$SAIDA" | grep -q "fin_periodo_conflito_dados" || { echo "FALHA: erro inesperado: $SAIDA"; exit 1; }
[ $((FIM-INI)) -ge 2 ] || { echo "FALHA: o fechamento nao esperou a escrita em andamento ($((FIM-INI))s)"; exit 1; }
[ "$(q -c "select status from fin_periodos where unidade_id='$UNI' and mes='2027-03-01';")" = "aberto" ] || { echo "FALHA: periodo fechou apesar do conflito"; exit 1; }

# Retentativa com a impressão atual: fecha, e a escrita concorrente está incluída no mês
FP2=$(q -c "select fin_fingerprint_periodo('$ORG','$UNI','2027-03-01');")
V2=$(q -c "select versao from fin_periodos where unidade_id='$UNI' and mes='2027-03-01';")
q -c "select fin_fechar_periodo('$ORG','$UNI','$USR','2027-03-01',$V2,'$FP2','{}'::jsonb,0,false);" >/dev/null
[ "$(q -c "select count(*) from fin_lancamentos where unidade_id='$UNI' and data_movimento >= '2027-03-01' and data_movimento < '2027-04-01';")" = "2" ] || { echo "FALHA: contagem apos fechamento"; exit 1; }
echo "CONCORRENCIA OK (fechamento esperou ${INI}->${FIM}, conflito detectado, retentativa fechou)"

# ---------------------------------------------------------------------------------------------------------------------
# Concorrência do CANCELAMENTO DE TRANSFERÊNCIA (sessões reais). Cada cenário usa um par novo no mês aberto de 2027-05.
# ---------------------------------------------------------------------------------------------------------------------
CAT_T=$(q -c "insert into fin_plano_contas (organizacao_id, tipo, natureza, nome, papel) values ('$ORG','T','T','TRANSF','transferencia') returning id;")
CONTA_B=$(q -c "insert into fin_contas (organizacao_id, unidade_id, nome) values ('$ORG','$UNI','BANCO2') returning id;")
novo_par() { q -c "select fin_criar_transferencia('$ORG','$UNI','$USR','$CONTA','$CONTA_B',2500,'2027-${2:-05}-0$1','par conc $1','$CAT_T');"; }
estados() { q -c "select string_agg(l.status, ',' order by l.sentido) from fin_transferencias t join fin_lancamentos l on l.id in (t.lancamento_saida_id, t.lancamento_entrada_id) where t.id = '$1';"; }
espera_min() { [ $(( $2 - $1 )) -ge ${3:-2} ] || { echo "FALHA: a segunda sessao nao esperou a primeira ($(( $2 - $1 ))s)"; exit 1; }; }

# A) duas chamadas simultâneas de cancelamento: a segunda ESPERA, não erra e é idempotente; cada perna é auditada UMA vez
PAR=$(novo_par 1)
( q -c "begin; select fin_cancelar_transferencia('$ORG','$UNI','$USR','$PAR','primeira chamada simultanea'); select pg_sleep(3); commit;" >/dev/null ) &
P1=$!; sleep 1; INI=$(date +%s)
RES=$(q -c "select fin_cancelar_transferencia('$ORG','$UNI','$USR','$PAR','segunda chamada simultanea');" 2>&1); FIM=$(date +%s); wait $P1
echo "$RES" | grep -q '"jaCancelada": true' || { echo "FALHA A: segunda chamada nao foi idempotente: $RES"; exit 1; }
espera_min $INI $FIM
[ "$(estados "$PAR")" = "cancelado,cancelado" ] || { echo "FALHA A: estados $(estados "$PAR")"; exit 1; }
[ "$(q -c "select count(*) from fin_auditoria where entidade='fin_lancamentos' and acao='fin_lancamentos.update' and depois->>'status'='cancelado' and entidade_id in (select lancamento_saida_id::text from fin_transferencias where id='$PAR' union select lancamento_entrada_id::text from fin_transferencias where id='$PAR');")" = "2" ] || { echo "FALHA A: cada perna deve ser auditada uma unica vez"; exit 1; }

# B) cancelar x desvincular ao mesmo tempo: o desvínculo ESPERA e é recusado (par cancelado é imutável); resultado consistente
PAR=$(novo_par 2)
( q -c "begin; select fin_cancelar_transferencia('$ORG','$UNI','$USR','$PAR','cancelando enquanto outro desvincula'); select pg_sleep(3); commit;" >/dev/null ) &
P1=$!; sleep 1; INI=$(date +%s)
set +e; RES=$(q -c "select fin_desvincular_transferencia_motivada('$ORG','$UNI','$USR','$PAR','tentativa de desvincular durante o cancelamento');" 2>&1); COD=$?; set -e; FIM=$(date +%s); wait $P1
[ $COD -ne 0 ] && echo "$RES" | grep -q "fin_transferencia_cancelada_imutavel" || { echo "FALHA B: desvinculo concorrente deveria ser recusado: $RES"; exit 1; }
espera_min $INI $FIM
[ "$(estados "$PAR")" = "cancelado,cancelado" ] && [ "$(q -c "select status from fin_transferencias where id='$PAR';")" = "cancelada" ] || { echo "FALHA B: estado final inconsistente"; exit 1; }

# C) desvincular x cancelar: quem chega depois vê o resultado do primeiro (cancelar acha o par inexistente) — nunca cancela só uma perna
PAR=$(novo_par 3)
( q -c "begin; select fin_desvincular_transferencia_motivada('$ORG','$UNI','$USR','$PAR','pareamento incorreto detectado'); select pg_sleep(3); commit;" >/dev/null ) &
P1=$!; sleep 1; INI=$(date +%s)
set +e; RES=$(q -c "select fin_cancelar_transferencia('$ORG','$UNI','$USR','$PAR','tentativa de cancelar par ja desfeito');" 2>&1); COD=$?; set -e; FIM=$(date +%s); wait $P1
[ $COD -ne 0 ] && echo "$RES" | grep -q "fin_transferencia_nao_encontrada" || { echo "FALHA C: cancelar apos desvincular deveria dar nao encontrada: $RES"; exit 1; }
espera_min $INI $FIM
[ "$(q -c "select count(*) from fin_lancamentos where descricao like 'par conc 3' and status='realizado';")" = "2" ] || { echo "FALHA C: as duas pernas deveriam seguir ativas"; exit 1; }

# D) edição de uma perna (transação aberta) x cancelamento do par: o cancelamento espera a edição e cancela as DUAS; a edição não se perde
PAR=$(novo_par 4)
SID=$(q -c "select lancamento_saida_id from fin_transferencias where id='$PAR';")
( q -c "begin; update fin_lancamentos set descricao = 'perna editada em paralelo' where id = '$SID'; select pg_sleep(3); commit;" >/dev/null ) &
P1=$!; sleep 1; INI=$(date +%s)
q -c "select fin_cancelar_transferencia('$ORG','$UNI','$USR','$PAR','cancelando apos edicao concorrente');" >/dev/null; FIM=$(date +%s); wait $P1
espera_min $INI $FIM
[ "$(estados "$PAR")" = "cancelado,cancelado" ] || { echo "FALHA D: estados $(estados "$PAR")"; exit 1; }
[ "$(q -c "select descricao from fin_lancamentos where id='$SID';")" = "perna editada em paralelo" ] || { echo "FALHA D: edicao concorrente perdida"; exit 1; }

# E) rollback integral: fecha o mês DEPOIS de criar o par; o cancelamento falha e as duas pernas seguem ativas
PAR=$(novo_par 5 06)
FPE=$(q -c "select fin_fingerprint_periodo('$ORG','$UNI','2027-06-01');"); VE=$(q -c "select versao from fin_periodos where unidade_id='$UNI' and mes='2027-06-01';")
q -c "select fin_fechar_periodo('$ORG','$UNI','$USR','2027-06-01',$VE,'$FPE','{}'::jsonb,0,false);" >/dev/null
set +e; RES=$(q -c "select fin_cancelar_transferencia('$ORG','$UNI','$USR','$PAR','tentando cancelar em mes fechado');" 2>&1); COD=$?; set -e
[ $COD -ne 0 ] && echo "$RES" | grep -q "fin_periodo_fechado" || { echo "FALHA E: deveria recusar por periodo fechado: $RES"; exit 1; }
[ "$(estados "$PAR")" = "realizado,realizado" ] && [ "$(q -c "select status from fin_transferencias where id='$PAR';")" = "vinculada" ] || { echo "FALHA E: algo mudou apesar da recusa"; exit 1; }
echo "CONCORRENCIA DO CANCELAMENTO OK (A: idempotente, B: desvinculo recusado, C: cancelar apos desvinculo, D: edicao preservada, E: rollback integral)"
