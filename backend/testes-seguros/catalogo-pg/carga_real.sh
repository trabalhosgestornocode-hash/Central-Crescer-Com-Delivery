#!/usr/bin/env bash
# Carga REAL simulada num Postgres DESCARTÁVEL local: aplica o payload do importador 2x numa empresa fictícia
# (com Subways semeadas, a migração 157/158 e um catálogo pré-existente) e confere custo, idempotência e isolamento.
# Os JSON (dados do cliente) ficam fora do repositório; o SQL gerado vai para um diretório temporário.
#
# Uso: CAT_PG_DESCARTAVEL=1 CAT_PG_PORT=55420 PSQL=".../psql" ./carga_real.sh <payload.json> <relatorio.json>
set -euo pipefail
[ "${CAT_PG_DESCARTAVEL:-}" = "1" ] || { echo "defina CAT_PG_DESCARTAVEL=1 (cluster temporário local)"; exit 2; }
HOST="${CAT_PG_HOST:-127.0.0.1}"; case "$HOST" in 127.0.0.1|localhost|::1) ;; *) echo "só loopback"; exit 2;; esac
PORT="${CAT_PG_PORT:-55420}"; PSQL="${PSQL:-psql}"; DB="cat_carga_$$"
[ $# -eq 2 ] || { echo "uso: $0 <payload.json> <relatorio.json>"; exit 2; }
AQUI="$(cd "$(dirname "$0")" && pwd)"; M="$AQUI/../../../database/migrations"
TMP="$(mktemp -d)"; SQL="$TMP/carga.sql"
run() { "$PSQL" -h "$HOST" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
run -d postgres -c "create database $DB"
trap 'run -d postgres -c "drop database if exists $DB" >/dev/null; rm -rf "$TMP"' EXIT
node "$AQUI/gerar-teste-carga.mjs" --payload "$1" --relatorio "$2" --saida "$SQL"
run -d "$DB" -f "$AQUI/00_stub.sql"
run -d "$DB" -f "$AQUI/../../../database/schema.sql" >/dev/null
for m in 002_produto_historico 004_custo_manual 021_insumos_ficha_cmv 022_origem_reconstrucao; do run -d "$DB" -f "$M/$m.sql" >/dev/null; done
run -d "$DB" -f "$AQUI/05_seed_subway.sql"
run -d "$DB" -f "$M/157_catalogo_empresa_rendimento_importacao.sql"
run -d "$DB" -f "$M/158_condicoes_comerciais_e_invalidacao_homologacao.sql"
out="$(run -d "$DB" -f "$SQL" 2>&1)" || { echo "$out" | grep -E "ok -|FALHA|ERRO|ERROR" | sed 's/^psql:[^ ]* //'; echo "FALHA"; exit 1; }
echo "$out" | grep -E "ok -|FALHA|ERRO|ERROR" | sed 's/^psql:[^ ]* //'
if echo "$out" | grep -qE "FALHA|ERRO|ERROR"; then echo "FALHA"; exit 1; fi
echo "CARGA REAL SIMULADA: TODOS OS TESTES PASSARAM"
