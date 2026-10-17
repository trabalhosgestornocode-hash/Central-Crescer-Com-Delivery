#!/usr/bin/env bash
# Roda o SQL provisório + testes em um PostgreSQL DESCARTÁVEL e LOCAL.
# Recusa qualquer host que não seja loopback e exige FIN_PG_DESCARTAVEL=1. Cria/derruba um banco temporário próprio.
# Uso: FIN_PG_DESCARTAVEL=1 FIN_PG_PORT=54329 PSQL="/c/Program Files/PostgreSQL/17/bin/psql" ./run.sh
set -euo pipefail
[ "${FIN_PG_DESCARTAVEL:-}" = "1" ] || { echo "defina FIN_PG_DESCARTAVEL=1 (cluster temporário local)"; exit 2; }
HOST="${FIN_PG_HOST:-127.0.0.1}"
case "$HOST" in 127.0.0.1|localhost|::1) ;; *) echo "host recusado: só loopback"; exit 2;; esac
PORT="${FIN_PG_PORT:-54329}"
PSQL="${PSQL:-psql}"
DB="fin_descartavel_$$"
AQUI="$(cd "$(dirname "$0")" && pwd)"
SQL="$AQUI/../../docs/gestao-financeira/sql-provisorio/121_gestao_financeira_dominio.provisorio.sql"
run() { "$PSQL" -h "$HOST" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
run -d postgres -c "create database $DB"
trap 'run -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
run -d "$DB" -f "$AQUI/00_stub.sql"
run -d "$DB" -f "$SQL"
run -d "$DB" -f "$SQL"   # idempotência: segunda aplicação não pode falhar
run -d "$DB" -f "$AQUI/10_dominio.test.sql"
# rollback seguro: aplica após os testes (banco vazio, pois os testes fazem rollback) e reaplica
run -d "$DB" -f "$AQUI/../../docs/gestao-financeira/sql-provisorio/121_rollback.provisorio.sql"
run -d "$DB" -f "$SQL"
echo "rollback + reaplicacao OK"
