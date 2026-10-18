#!/bin/bash
# Corrida real (3 sessões) no banco "sim": fechamento duplo com a mesma exceção + lançamento pendente novo DURANTE o fechamento.
# Pré-requisitos: sim_supabase.sh e adversarial122.sql já aplicados; PGCLIENTENCODING=UTF8. Resultado esperado: A fecha; B ja_fechado; C fin_periodo_fechado; exceção consumida 1x.
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH" PGCLIENTENCODING=UTF8
if [ -n "$T3_PSQL_CONN" ]; then [ "$T3_CONFIRMO" = "ESTE_PROJETO_E_DESCARTAVEL" ] || { echo "defina T3_CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL"; exit 2; }; CONN="$T3_PSQL_CONN"; else CONN="-h 127.0.0.1 -p 54321 -U postgres -d sim"; fi
P="psql $CONN -q -tA"; T="${TMPDIR:-/tmp}"
O=00000000-0000-0000-0000-0000000000a1; U=00000000-0000-0000-0000-0000000000a2; USR=00000000-0000-0000-0000-000000000999; SA=00000000-0000-0000-0000-000000000888
$P -c "set role service_role; insert into fin_lancamentos(organizacao_id,unidade_id,conta_id,categoria_id,descricao,sentido,valor_centavos,data_movimento,classificacao_pendente) values ('$O','$U','00000000-0000-0000-0000-0000000000e1',null,'pend','entrada',100,'2028-06-05',true)"
$P -c "set role ${T3_DONO_ROLE:-dono_sim}; select 1 from (select fin_conceder_excecao_fechamento('$O','$U','$SA','2028-06-01','Justificativa suficientemente longa para o teste',7,'{}', jsonb_build_object('aal','aal2','em', to_char(now() at time zone 'utc' - interval '20 seconds','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'))) ) x" >/dev/null
VER=$($P -c "set role service_role; select (fin_abrir_periodo('$O','$U','$USR','2028-06-01')->>'versao')" | tail -1)
FP=$($P -c "set role service_role; select fin_fingerprint_periodo('$O','$U','2028-06-01')" | tail -1)
CALL="select fin_fechar_periodo('$O','$U','$USR','2028-06-01',$VER,'$FP','{}',array[]::text[],true)->>'status'"
( $P -c "set role service_role; begin; $CALL; select pg_sleep(4); commit;" > $T/cA.out 2>&1 ) & sleep 1
( $P -c "set role service_role; $CALL" > $T/cB.out 2>&1 ) &
( $P -c "set role service_role; insert into fin_lancamentos(organizacao_id,unidade_id,conta_id,categoria_id,descricao,sentido,valor_centavos,data_movimento,classificacao_pendente) values ('$O','$U','00000000-0000-0000-0000-0000000000e1',null,'nova durante fechamento','entrada',100,'2028-06-20',true)" > $T/cC.out 2>&1 ) &
wait; echo "A:"; head -1 $T/cA.out; echo "B:"; head -1 $T/cB.out; echo "C:"; head -1 $T/cC.out
$P -c "select status from fin_excecoes_fechamento where unidade_id='$U' and mes='2028-06-01'; select status from fin_periodos where unidade_id='$U' and mes='2028-06-01'"
