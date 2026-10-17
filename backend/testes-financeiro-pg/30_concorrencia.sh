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
