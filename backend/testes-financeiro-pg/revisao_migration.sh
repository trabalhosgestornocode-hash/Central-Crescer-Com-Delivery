#!/usr/bin/env bash
# REVISÃO FORMAL das migrations promovidas pelo Agente 1 (120 + 121) em PostgreSQL DESCARTÁVEL e LOCAL.
# Uso: FIN_PG_DESCARTAVEL=1 PSQL=... MIG120=<arquivo> MIG121=<arquivo> [MIG121_ROLLBACK=<arquivo>] bash revisao_migration.sh
# Os arquivos vêm da branch de integração por LEITURA (git show), nunca aplicados em banco remoto.
set -euo pipefail
[ "${FIN_PG_DESCARTAVEL:-}" = "1" ] || { echo "defina FIN_PG_DESCARTAVEL=1"; exit 2; }
HOST="${FIN_PG_HOST:-127.0.0.1}"; case "$HOST" in 127.0.0.1|localhost|::1) ;; *) echo "so loopback"; exit 2;; esac
PORT="${FIN_PG_PORT:-54329}"; PSQL="${PSQL:-psql}"; DB="fin_revisao_$$"
AQUI="$(cd "$(dirname "$0")" && pwd)"
run() { "$PSQL" -h "$HOST" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
run -d postgres -c "create database $DB"; trap 'run -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
run -d "$DB" -f "$AQUI/00_stub.sql"; run -d "$DB" -f "$AQUI/01_stub_120.sql"
run -d "$DB" -f "$MIG120"; echo "120 aplicada"
run -d "$DB" -f "$MIG121"; echo "121 aplicada"
run -d "$DB" -f "$MIG121"; echo "121 reaplicada (idempotente)"
run -d "$DB" -f "$AQUI/10_dominio.test.sql"                      # a suíte do domínio passa sobre a 121 INTEGRADA
# sondagens sobre a 121 INTEGRADA: R1-R4 devem passar; R5 e o ACHADO documentado (perna vinculada trocando de categoria)
if SAIDA=$(run -d "$DB" -f "$AQUI/40_revisao_121.test.sql" 2>&1); then echo "AVISO: R5 nao falhou na 121 integrada"; else echo "$SAIDA" | grep -q "ACHADO R5" && echo "ACHADO R5 reproduzido na 121 integrada (esperado)" || { echo "$SAIDA"; exit 1; }; fi
# com o 122 por cima, o achado esta corrigido e as sondagens passam por inteiro
if [ -n "${MIG122:-}" ]; then run -d "$DB" -f "$MIG122"; run -d "$DB" -f "$AQUI/40_revisao_121.test.sql"; run -d "$DB" -f "$AQUI/25_cancelamento_par.test.sql"; fi
if [ -n "${MIG121_ROLLBACK:-}" ]; then run -d "$DB" -f "$MIG121_ROLLBACK"; echo "rollback 121 (banco sem dados) OK"; fi
