#!/bin/bash
# F-1 — integridade do pré-fechamento com DUAS (ou mais) SESSÕES PostgreSQL REAIS, contra o banco "sim" (120+121+122 aplicadas por sim_supabase.sh).
# Prova: mudanças em tipo/canal de conta e em exceções de sangria entre a prévia e o fechamento geram 409 (fin_periodo_conflito_dados); alterações
# concorrentes ao fechamento esperam a trava; 409 não consome exceção; nova prévia destrava; operações legítimas não são bloqueadas; mês fechado é preservado.
# Uso:  PG_CLUSTER_DIR=C:/Users/ponte/pg-descartavel bash backend/testes-seguros/pg/sim_supabase.sh && bash backend/testes-seguros/pg/f1_concorrencia.sh
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH" PGCLIENTENCODING=UTF8
# local: banco "sim". T3 (Supabase DESCARTÁVEL): exporte T3_PSQL_CONN="postgresql://postgres:<senha-url-encoded>@<host>:5432/postgres" e T3_CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL
if [ -n "$T3_PSQL_CONN" ]; then [ "$T3_CONFIRMO" = "ESTE_PROJETO_E_DESCARTAVEL" ] || { echo "defina T3_CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL"; exit 2; }; H="$T3_PSQL_CONN"; else H="-h 127.0.0.1 -p 54321 -U postgres -d sim"; fi
O_PADRAO=00000000-0000-0000-0000-0000000000a1
P="psql $H -q -tA -v ON_ERROR_STOP=0"
T="${TMPDIR:-/tmp}/f1"; mkdir -p "$T"
O="${T3_ORG_ID:-$O_PADRAO}"; USR=00000000-0000-0000-0000-000000000999; SA=00000000-0000-0000-0000-000000000888
REC=00000000-0000-4000-f100-0000000000c1; DESP=00000000-0000-4000-f100-0000000000c2; OUTRA=00000000-0000-4000-f100-0000000000c3
FALHOU=""; ok() { echo "PASS  $1"; }; bad() { echo "FALHA $1"; FALHOU=1; }
now_ms() { echo $(( $(date +%s%N) / 1000000 )); }
NUM=0; NONCE=$(printf "%08x" $(( (RANDOM << 16) | RANDOM )))   # ids novos a cada execução: o script pode rodar várias vezes no mesmo banco

$P -c "insert into fin_plano_contas(id,organizacao_id,tipo,natureza,nome,papel) values ('$REC','$O','RECEITA','RECEBIMENTO','F1 REC','receita_operacional'),('$DESP','$O','DESPESA','FIXA','F1 DESP','despesa_fixa'),('$OUTRA','$O','DESPESA','FIXA','F1 OUTRA','despesa_fixa') on conflict (id) do nothing" >/dev/null

# cria uma unidade nova com 2 contas (banco + caixa_fisico), lançamentos no mês $1 (receita no banco; saída de DESP no caixa) e devolve o id da unidade
novo_cenario() { # $1 = mês (AAAA-MM-01)
  NUM=$((NUM+1)); U=$(printf "${NONCE}-0000-4000-f1%02d-000000000001" "$NUM"); CB=$(printf "${NONCE}-0000-4000-f1%02d-0000000000b1" "$NUM"); CC=$(printf "${NONCE}-0000-4000-f1%02d-0000000000b2" "$NUM"); CX=$(printf "${NONCE}-0000-4000-f1%02d-0000000000b3" "$NUM")
  $P >/dev/null <<SQL
insert into unidades(id,organizacao_id,nome) values ('$U','$O','F1 $NUM');
insert into fin_contas(id,organizacao_id,unidade_id,nome,tipo_conta) values ('$CB','$O','$U','BANCO','banco'),('$CC','$O','$U','CAIXA','caixa_fisico'),('$CX','$O','$U','OUTRA SEM MOVIMENTO','banco');
set role service_role;
insert into fin_lancamentos(organizacao_id,unidade_id,conta_id,categoria_id,descricao,sentido,valor_centavos,data_movimento) values
 ('$O','$U','$CB','$REC','venda','entrada',10000,'${1%-01}-03'),('$O','$U','$CC','$DESP','sangria','saida',2000,'${1%-01}-04');
SQL
}
previa() { # $1=unidade $2=mês -> "versao|fingerprint"
  $P -c "set role service_role; select (fin_abrir_periodo('$O','$1','$USR','$2')->>'versao') || '|' || fin_fingerprint_periodo('$O','$1','$2')" | tail -1
}
fechar_sql() { # $1=unidade $2=mês $3=previa(versao|fp)  -> comando SQL
  echo "select fin_fechar_periodo('$O','$1','$USR','$2',${3%%|*},'${3##*|}','{}',array[]::text[],false)->>'status'"
}
tenta_fechar() { $P -c "set role service_role; $(fechar_sql "$1" "$2" "$3")" 2>&1 | head -1; }
esperar() { # rótulo, saída obtida, trecho esperado
  case "$2" in *"$3"*) ok "$1 [$3]";; *) bad "$1 (esperado '$3', veio '$(echo "$2" | cut -c1-120)')";; esac
}
estado_periodo() { $P -c "select status from fin_periodos where unidade_id='$1' and mes='$2'"; }

echo "=== 1. tipo da conta muda DEPOIS da prévia ==="
M=2032-01-01; novo_cenario $M; PV=$(previa $U $M)
$P -c "set role service_role; update fin_contas set tipo_conta='caixa_fisico' where id='$CB'" >/dev/null
esperar "1a fechar com a prévia antiga" "$(tenta_fechar $U $M "$PV")" "fin_periodo_conflito_dados"
[ "$(estado_periodo $U $M)" = "aberto" ] && ok "1b mês continua aberto" || bad "1b mês mudou de estado"
PV2=$(previa $U $M); [ "$PV2" != "$PV" ] && ok "1c nova prévia tem impressão diferente" || bad "1c impressão não mudou"
esperar "1d fechar com a NOVA prévia" "$(tenta_fechar $U $M "$PV2")" "fechado"

echo "=== 2. canal da conta muda DEPOIS da prévia ==="
M=2032-02-01; novo_cenario $M; PV=$(previa $U $M)
$P -c "set role service_role; update fin_contas set canal_referencia='STONE' where id='$CB'" >/dev/null
esperar "2a fechar com a prévia antiga" "$(tenta_fechar $U $M "$PV")" "fin_periodo_conflito_dados"
PV2=$(previa $U $M); esperar "2b fechar com a NOVA prévia" "$(tenta_fechar $U $M "$PV2")" "fechado"

echo "=== 3. exceção de sangria ativada / desativada DEPOIS da prévia ==="
M=2032-03-01; novo_cenario $M; PV=$(previa $U $M)
EXC=$(printf "${NONCE}-0000-4000-f1%02d-0000000000e1" "$NUM")
$P -c "set role service_role; insert into fin_sangria_excecoes(id,organizacao_id,unidade_id,categoria_id,motivo,aprovada_por) values ('$EXC','$O','$U','$DESP','categoria paga em especie',gen_random_uuid())" >/dev/null
esperar "3a ativar exceção da categoria COM saída no mês" "$(tenta_fechar $U $M "$PV")" "fin_periodo_conflito_dados"
PV2=$(previa $U $M)
$P -c "set role service_role; update fin_sangria_excecoes set ativa=false, desativada_por=gen_random_uuid(), desativada_em=now(), motivo_desativacao='nao se aplica mais' where id='$EXC'" >/dev/null
esperar "3b desativar a exceção" "$(tenta_fechar $U $M "$PV2")" "fin_periodo_conflito_dados"
PV3=$(previa $U $M)
EXC2=$(printf "${NONCE}-0000-4000-f1%02d-0000000000e2" "$NUM")
$P -c "set role service_role; insert into fin_sangria_excecoes(id,organizacao_id,unidade_id,categoria_id,motivo,aprovada_por) values ('$EXC2','$O','$U','$OUTRA','categoria sem saida neste mes',gen_random_uuid())" >/dev/null
esperar "3c exceção de categoria SEM saída no mês NÃO gera 409 espúrio" "$(tenta_fechar $U $M "$PV3")" "fechado"

echo "=== 4. alteração CONCORRENTE ao fechamento (sessões reais) ==="
M=2032-04-01; novo_cenario $M; PV=$(previa $U $M); EXC=$(printf "${NONCE}-0000-4000-f1%02d-0000000000e1" "$NUM")
T0=$(now_ms)
( $P -c "set role service_role; begin; $(fechar_sql $U $M "$PV"); select pg_sleep(4); commit;" > "$T/a4.out" 2>&1 ) &
sleep 1
( S=$(now_ms); $P -c "set role service_role; update fin_contas set tipo_conta='caixa_fisico' where id='$CB'" > "$T/b4.out" 2>&1; echo "dur=$(( $(now_ms) - S ))" >> "$T/b4.out" ) &
( S=$(now_ms); $P -c "set role service_role; insert into fin_sangria_excecoes(id,organizacao_id,unidade_id,categoria_id,motivo,aprovada_por) values ('$EXC','$O','$U','$DESP','configuracao concorrente',gen_random_uuid())" > "$T/c4.out" 2>&1; echo "dur=$(( $(now_ms) - S ))" >> "$T/c4.out" ) &
wait
esperar "4a fechamento concluiu" "$(head -1 $T/a4.out)" "fechado"
DB=$(grep -o 'dur=[0-9]*' $T/b4.out | cut -d= -f2); DC=$(grep -o 'dur=[0-9]*' $T/c4.out | cut -d= -f2)
[ "$DB" -ge 2500 ] && ok "4b mudança de tipo de conta ESPEROU a trava (${DB} ms)" || bad "4b não esperou (${DB} ms)"
esperar "4c ...e foi RECUSADA após o fechamento (mês fechado é preservado)" "$(cat $T/b4.out)" "fin_periodo_fechado"
[ "$DC" -ge 2500 ] && ok "4d exceção de sangria ESPEROU a trava (${DC} ms)" || bad "4d não esperou (${DC} ms)"
[ -z "$(grep -i error $T/c4.out)" ] && ok "4e ...e foi aceita depois (configuração da unidade; snapshot do mês fechado intacto)" || bad "4e exceção recusada: $(head -1 $T/c4.out)"
[ "$(estado_periodo $U $M)" = "fechado" ] && ok "4f mês fechado" || bad "4f estado do mês"
[ "$($P -c "select tipo_conta from fin_contas where id='$CB'")" = "banco" ] && ok "4g tipo da conta NÃO mudou" || bad "4g tipo da conta mudou em mês fechado"

echo "=== 5. 409 não consome a exceção; repetição com nova prévia funciona ==="
M=2032-05-01; novo_cenario $M
$P -c "set role service_role; insert into fin_lancamentos(organizacao_id,unidade_id,conta_id,categoria_id,descricao,sentido,valor_centavos,data_movimento,classificacao_pendente) values ('$O','$U','$CB',null,'pendente','entrada',100,'${M%-01}-10',true)" >/dev/null
MFA="jsonb_build_object('aal','aal2','em', to_char(now() at time zone 'utc' - interval '30 seconds','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'))"
$P -c "set role ${T3_DONO_ROLE:-dono_sim}; select 1 from (select fin_conceder_excecao_fechamento('$O','$U','$SA','$M','Justificativa suficientemente longa para o teste',7,'{}',$MFA)) x" >/dev/null
PV=$(previa $U $M)
$P -c "set role service_role; update fin_contas set canal_referencia='IFOOD' where id='$CB'" >/dev/null
R5=$($P -c "set role service_role; select fin_fechar_periodo('$O','$U','$USR','$M',${PV%%|*},'${PV##*|}','{}',array[]::text[],true)->>'status'" 2>&1 | head -1)
esperar "5a fechar com exceção e prévia antiga => 409 de dados" "$R5" "fin_periodo_conflito_dados"
[ "$($P -c "select status from fin_excecoes_fechamento where unidade_id='$U' and mes='$M'")" = "ativa" ] && ok "5b exceção NÃO foi consumida" || bad "5b exceção consumida/alterada pelo 409"
PV2=$(previa $U $M)
R5b=$($P -c "set role service_role; select fin_fechar_periodo('$O','$U','$USR','$M',${PV2%%|*},'${PV2##*|}','{}',array[]::text[],true)->>'status'" 2>&1 | head -1)
esperar "5c nova prévia + reconhecimento => fecha" "$R5b" "fechado"
[ "$($P -c "select status from fin_excecoes_fechamento where unidade_id='$U' and mes='$M'")" = "consumida" ] && ok "5d exceção consumida UMA vez, só no fechamento válido" || bad "5d estado da exceção"

echo "=== 6. SEM bloqueios indevidos durante um fechamento em andamento ==="
M=2032-06-01; novo_cenario $M; PV=$(previa $U $M); U6=$U; CB6=$CB; CX6=$CX
# conta com movimento APENAS em outro mês aberto (2032-07) e unidade/conta alheias
$P -c "set role service_role; insert into fin_lancamentos(organizacao_id,unidade_id,conta_id,categoria_id,descricao,sentido,valor_centavos,data_movimento) values ('$O','$U6','$CX6','$REC','outro mes','entrada',500,'2032-07-05')" >/dev/null
novo_cenario 2032-06-01; UALHEIA=$U; CBALHEIA=$CB
( $P -c "set role service_role; begin; $(fechar_sql $U6 2032-06-01 "$PV"); select pg_sleep(4); commit;" > "$T/a6.out" 2>&1 ) &
sleep 1
cronometra() { local S; S=$(now_ms); $P -c "set role service_role; $1" >/dev/null 2>&1; echo $(( $(now_ms) - S )); }
D1=$(cronometra "update fin_contas set nome='BANCO RENOMEADO' where id='$CB6'")
D2=$(cronometra "update fin_contas set ativo=false where id='$CB6'")
D3=$(cronometra "update fin_contas set tipo_conta='adquirente' where id='$CX6'")
D4=$(cronometra "insert into fin_lancamentos(organizacao_id,unidade_id,conta_id,categoria_id,descricao,sentido,valor_centavos,data_movimento) values ('$O','$U6','$CX6','$REC','outro mes 2','entrada',1,'2032-07-06')")
D5=$(cronometra "update fin_contas set tipo_conta='caixa_fisico' where id='$CBALHEIA'")
D6=$(cronometra "insert into fin_sangria_excecoes(organizacao_id,unidade_id,categoria_id,motivo,aprovada_por) values ('$O','$U6','$OUTRA','sem saida em 2032-06',gen_random_uuid())")
wait
for par in "6a renomear conta:$D1" "6b inativar conta:$D2" "6c mudar tipo de conta com movimento só em OUTRO mês aberto:$D3" "6d lançamento em OUTRO mês:$D4" "6e mudar tipo de conta de OUTRA unidade:$D5" "6f exceção de categoria sem saída no mês fechando:$D6"; do
  nome="${par%%:*}"; ms="${par##*:}"; [ "$ms" -lt 1500 ] && ok "$nome não bloqueou (${ms} ms)" || bad "$nome ficou bloqueado (${ms} ms)"
done
esperar "6g fechamento concluiu normalmente" "$(head -1 $T/a6.out)" "fechado"

echo "=== 7. integridade do mês FECHADO ==="
R7=$($P -c "set role service_role; update fin_contas set tipo_conta='adquirente' where id='$CB6'" 2>&1 | head -1)
esperar "7a tipo de conta com movimento em mês fechado é recusado NO BANCO" "$R7" "fin_periodo_fechado"
R7b=$($P -c "set role service_role; update fin_contas set canal_referencia='X' where id='$CB6'" 2>&1 | head -1)
esperar "7b canal idem" "$R7b" "fin_periodo_fechado"
R7c=$($P -c "set role service_role; update fin_contas set tipo_conta='outra' where id='$CBALHEIA'" 2>&1 | head -1)
[ -z "$R7c" ] && ok "7c conta sem movimento em mês fechado continua editável" || bad "7c conta sem movimento recusada: $R7c"
[ "$($P -c "select (snapshot is not null)::text from fin_periodos where unidade_id='$U6' and mes='2032-06-01'")" = "true" ] && ok "7d snapshot do mês fechado intacto" || bad "7d snapshot"

echo; [ -z "$FALHOU" ] && echo "F-1 CONCORRÊNCIA: TODAS AS PROVAS OK" || { echo "F-1 CONCORRÊNCIA: HOUVE FALHAS"; exit 1; }
