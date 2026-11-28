#!/usr/bin/env bash
# 157 + 158 + 163 num Postgres DESCARTÁVEL local (loopback). Exige CAT_PG_DESCARTAVEL=1.
# Uso: CAT_PG_DESCARTAVEL=1 CAT_PG_PORT=55463 PSQL="/c/Program Files/PostgreSQL/17/bin/psql" ./run163.sh
set -euo pipefail
[ "${CAT_PG_DESCARTAVEL:-}" = "1" ] || { echo "defina CAT_PG_DESCARTAVEL=1 (cluster temporário local)"; exit 2; }
HOST="${CAT_PG_HOST:-127.0.0.1}"; case "$HOST" in 127.0.0.1|localhost|::1) ;; *) echo "só loopback"; exit 2;; esac
PORT="${CAT_PG_PORT:-55420}"; PSQL="${PSQL:-psql}"; DB="cat163_descartavel_$$"
AQUI="$(cd "$(dirname "$0")" && pwd)"; M="$AQUI/../../../database/migrations"
run() { "$PSQL" -h "$HOST" -p "$PORT" -U postgres -w -v ON_ERROR_STOP=1 -q "$@"; }
run -d postgres -c "create database $DB"; trap 'run -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
run -d "$DB" -f "$AQUI/00_stub.sql"
run -d "$DB" -f "$AQUI/../../../database/schema.sql" >/dev/null
for m in 002_produto_historico 004_custo_manual 021_insumos_ficha_cmv 022_origem_reconstrucao; do run -d "$DB" -f "$M/$m.sql" >/dev/null; done
run -d "$DB" -f "$AQUI/05_seed_subway.sql"
run -d "$DB" -f "$M/157_catalogo_empresa_rendimento_importacao.sql"
saida() { local out; out="$(run -d "$DB" -f "$1" 2>&1)" || { echo "$out" | grep -E "ok -|FALHA|ERRO|ERROR"; echo "FALHA: $1"; exit 1; }; echo "$out" | grep -E "ok -|FALHA|ERRO|ERROR" || true; if echo "$out" | grep -qE "FALHA|ERRO|ERROR"; then exit 1; fi; }
saida "$AQUI/10_catalogo.test.sql"
run -d "$DB" -f "$M/158_condicoes_comerciais_e_invalidacao_homologacao.sql"
saida "$AQUI/20_condicoes_homologacao.test.sql"
run -d "$DB" -f "$M/163_produtos_cmv_governanca.sql"
run -d "$DB" -f "$M/163_produtos_cmv_governanca.sql"; echo "ok - 163 idempotente (aplicada duas vezes)"
saida "$AQUI/30_produtos_cmv_163.test.sql"
if run -d "$DB" -f "$M/163_rollback.sql" >/dev/null 2>&1; then echo "FALHA: rollback 163 não recusou com dados"; exit 1; fi; echo "ok - rollback da 163 recusado com dados gravados"
run -d "$DB" -c "truncate catalogo_correcoes, produto_rascunhos, produto_precos_historico; update insumos set custo_zero_declarado=false, custo_zero_motivo=null; update ficha_tecnica set peso_bruto=null, peso_liquido=null;"
run -d "$DB" -f "$M/163_rollback.sql"; echo "ok - rollback da 163 aplicado"
SNAP=$(run -d "$DB" -tA -c "select count(*) from snap_custo s where s.id::text like '22222222%' and abs(fn_custo_produto(s.id)-s.custo)>1e-12")
[ "$SNAP" = "0" ] && echo "ok - após rollback da 163 as Subways seguem idênticas" || { echo "FALHA: Subway divergiu"; exit 1; }
echo "TODOS OS TESTES PG DA 163 PASSARAM"
