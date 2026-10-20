#!/bin/bash
# Ensaio de prod-migrar.mjs — SOMENTE PostgreSQL LOCAL DESCARTÁVEL (127.0.0.1:54321 com MARCADOR_DESCARTAVEL).
# Precisa do banco e115_base criado por backend/testes-seguros/pg/ensaio_115_120.sh (cadeia da main, com a 115 e as 123–125).
# Prova as recusas (alvo, porta, autorização, backup, identidade) e a aplicação 120 → 121 → 122 com catálogo 23/23,
# só 'modulos' mudando e reaplicação sem mudança. Nenhuma conexão real é usada: as URLs de recusa são fictícias.
# Uso: PG_CLUSTER_DIR=C:/…/pgdata bash backend/testes-seguros/producao/ensaio_prod_migrar.sh
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR (cluster DESCARTÁVEL local, com o arquivo MARCADOR_DESCARTAVEL)}"
[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo "RECUSADO: $CLUSTER sem MARCADOR_DESCARTAVEL"; exit 2; }
AQUI="$(cd "$(dirname "$0")" && pwd)"; M="node $AQUI/prod-migrar.mjs"
H="-h 127.0.0.1 -p 54321"; L="postgresql://dono_sim@127.0.0.1:54321/prod_sim"
export PGCLIENTENCODING=UTF8 PROD_EVIDENCIAS="${TMPDIR:-/tmp}/evidencias-prod-ensaio"
P=0; F=0; ok() { echo "OK    $1"; P=$((P+1)); }; bad() { echo "FALHA $1"; F=$((F+1)); }
roda() { env -u DATABASE_URL -u SUPABASE_URL -u SUPABASE_SERVICE_ROLE_KEY -u PROD_CONN "$@" 2>&1; }
psql $H -U postgres -Xq -c "drop database if exists prod_sim" -c "create database prod_sim template e115_base owner dono_sim" >/dev/null 2>&1 \
  || { echo "RECUSADO: não foi possível criar prod_sim a partir de e115_base (rode ensaio_115_120.sh antes)"; exit 2; }

roda $M preflight | grep -q "RECUSADO: defina PROD_CONN" && ok "R1 sem PROD_CONN: recusa" || bad "R1"
roda PROD_CONN="postgresql://postgres:x@db.wiqqsxnysbzhcrzrrean.supabase.co:5432/postgres" $M preflight | grep -q "projeto de TESTES" && ok "R2 projeto de testes: recusa" || bad "R2"
roda PROD_CONN="postgresql://postgres:x@db.abcdefghijabcdefghij.supabase.co:5432/postgres" $M preflight | grep -q "não são do projeto de produção" && ok "R3 outro projeto: recusa" || bad "R3"
roda PROD_CONN="postgresql://postgres.uqybgauuxcrqzquultfu:x@aws-0-sa-east-1.pooler.supabase.com:6543/postgres" $M preflight | grep -q "porta 6543" && ok "R4 pooler em modo transação: recusa" || bad "R4"
roda PROD_ENSAIO_LOCAL=1 PROD_CONN="$L" PG_CLUSTER_DIR=/nao/existe $M preflight | grep -q "MARCADOR_DESCARTAVEL" && ok "R5 ensaio sem marcador: recusa" || bad "R5"

E=(PROD_ENSAIO_LOCAL=1 PROD_CONN="$L" PG_CLUSTER_DIR="$CLUSTER")
O=$(roda "${E[@]}" $M preflight); ID=$(echo "$O" | grep -o "PROD_IDENTIDADE=[0-9a-f]*" | cut -d= -f2)
[ -n "$ID" ] && echo "$O" | grep -q "somente_leitura" && echo "$O" | grep -qE "^ +on +$|\| on" && ok "P1 preflight somente leitura devolve a identidade" || bad "P1: $O"
roda "${E[@]}" PROD_IDENTIDADE="$ID" $M aplicar | grep -q "falta PROD_AUTORIZO" && ok "R6 aplicar sem PROD_AUTORIZO: recusa" || bad "R6"
roda "${E[@]}" PROD_IDENTIDADE="$ID" PROD_AUTORIZO=SIM $M aplicar | grep -q "falta PROD_BACKUP_CONFIRMADO" && ok "R7 aplicar sem PROD_BACKUP_CONFIRMADO: recusa" || bad "R7"
roda "${E[@]}" PROD_IDENTIDADE=000 PROD_AUTORIZO=SIM PROD_BACKUP_CONFIRMADO=SIM $M aplicar | grep -q "PROD_IDENTIDADE ausente ou diferente" && ok "R8 identidade diferente: recusa" || bad "R8"
[ "$(psql $H -U postgres -XtAc "select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname like 'fin\_%'" -d prod_sim)" = 0 ] && ok "R9 nenhuma recusa escreveu no banco" || bad "R9"
O=$(roda "${E[@]}" PROD_IDENTIDADE="$ID" PROD_AUTORIZO=SIM PROD_BACKUP_CONFIRMADO=SIM $M aplicar)
echo "$O" | grep -q "RESULTADO: OK" && echo "$O" | grep -q "catálogo: 23 t / 0 f" && ok "A1 aplica 120 → 121 → 122: catálogo 23/23, só 'modulos' +1" || bad "A1: $O"
roda "${E[@]}" PROD_IDENTIDADE="$ID" $M verificar | grep -q "catálogo: 23 t / 0 f" && ok "V1 verificar: 23/23" || bad "V1"
O=$(roda "${E[@]}" PROD_IDENTIDADE="$ID" PROD_AUTORIZO=SIM PROD_BACKUP_CONFIRMADO=SIM $M aplicar)
echo "$O" | grep -q "catálogo: 23 t / 0 f" && ! echo "$O" | grep -q "^MUDOU" && ok "A2 reaplicação idempotente: nenhuma tabela compartilhada muda" || bad "A2: $O"
grep -rlq "127.0.0.1:54321/prod_sim" "$PROD_EVIDENCIAS" 2>/dev/null && bad "E1 a conexão vazou para a evidência" || ok "E1 evidências sem a conexão"
psql $H -U postgres -Xq -c "drop database prod_sim" >/dev/null 2>&1; rm -rf "$PROD_EVIDENCIAS"
echo "== $P OK, $F FALHA"; [ "$F" = 0 ]
