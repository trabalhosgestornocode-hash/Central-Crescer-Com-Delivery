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
SQL2="$AQUI/../../docs/gestao-financeira/sql-provisorio/122_conciliacao_periodos.provisorio.sql"
run -d "$DB" -f "$SQL2"
run -d "$DB" -f "$SQL2"  # idempotência do 122
run -d "$DB" -f "$AQUI/10_dominio.test.sql"
run -d "$DB" -f "$AQUI/20_periodos_conciliacao.test.sql"
export HOST PORT PSQL DB
bash "$AQUI/30_concorrencia.sh"
# rollback seguro: o teste de concorrência deixou dados COMMITADOS => o rollback deve RECUSAR (e nada ser removido)
if run -d "$DB" -f "$AQUI/../../docs/gestao-financeira/sql-provisorio/122_rollback.provisorio.sql" 2>/dev/null; then echo "FALHA: rollback do 122 nao recusou com dados"; exit 1; fi
echo "rollback com dados recusado (ok)"
# banco novo e vazio: aplica 121+122, faz rollback 122, reaplica 121 (restaura funcoes) e 122; depois rollback 122+121
VAZIO="${DB}_v"
run -d postgres -c "create database $VAZIO"
trap 'run -d postgres -c "drop database if exists $DB" >/dev/null; run -d postgres -c "drop database if exists ${DB}_v" >/dev/null' EXIT
run -d "$VAZIO" -f "$AQUI/00_stub.sql"; run -d "$VAZIO" -f "$SQL"; run -d "$VAZIO" -f "$SQL2"
run -d "$VAZIO" -f "$AQUI/../../docs/gestao-financeira/sql-provisorio/122_rollback.provisorio.sql"
run -d "$VAZIO" -f "$SQL"; run -d "$VAZIO" -f "$SQL2"
run -d "$VAZIO" -f "$AQUI/../../docs/gestao-financeira/sql-provisorio/122_rollback.provisorio.sql"
run -d "$VAZIO" -f "$AQUI/../../docs/gestao-financeira/sql-provisorio/121_rollback.provisorio.sql"
echo "rollback 122/121 em banco vazio OK"
