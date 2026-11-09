#!/usr/bin/env bash
# Testa a migration 157 num Postgres DESCARTÁVEL local (loopback). Exige CAT_PG_DESCARTAVEL=1.
# Uso: CAT_PG_DESCARTAVEL=1 CAT_PG_PORT=55420 PSQL="/c/Program Files/PostgreSQL/17/bin/psql" ./run.sh
set -euo pipefail
[ "${CAT_PG_DESCARTAVEL:-}" = "1" ] || { echo "defina CAT_PG_DESCARTAVEL=1 (cluster temporário local)"; exit 2; }
HOST="${CAT_PG_HOST:-127.0.0.1}"; case "$HOST" in 127.0.0.1|localhost|::1) ;; *) echo "só loopback"; exit 2;; esac
PORT="${CAT_PG_PORT:-55420}"; PSQL="${PSQL:-psql}"; DB="cat_descartavel_$$"
AQUI="$(cd "$(dirname "$0")" && pwd)"; M="$AQUI/../../../database/migrations"
run() { "$PSQL" -h "$HOST" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
run -d postgres -c "create database $DB"; trap 'run -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
run -d "$DB" -f "$AQUI/00_stub.sql"
run -d "$DB" -f "$AQUI/../../../database/schema.sql" >/dev/null
for m in 002_produto_historico 004_custo_manual 021_insumos_ficha_cmv 022_origem_reconstrucao; do run -d "$DB" -f "$M/$m.sql" >/dev/null; done
run -d "$DB" -f "$AQUI/05_seed_subway.sql"
M158="$M/158_condicoes_comerciais_e_invalidacao_homologacao.sql"
run -d "$DB" -f "$M/157_catalogo_empresa_rendimento_importacao.sql"
run -d "$DB" -f "$M/157_catalogo_empresa_rendimento_importacao.sql"   # idempotência da migration
saida_teste() { local out; out="$(run -d "$DB" -f "$1" 2>&1)" || { echo "$out" | grep -E "ok -|FALHA|ERRO|ERROR"; echo "FALHA: $1"; exit 1; }; echo "$out" | grep -E "ok -|FALHA|ERRO|ERROR" || true; if echo "$out" | grep -qE "FALHA|ERRO|ERROR"; then echo "FALHA em $1"; exit 1; fi; }
saida_teste "$AQUI/10_catalogo.test.sql"
run -d "$DB" -f "$M158"
run -d "$DB" -f "$M158"   # idempotência da 158
saida_teste "$AQUI/20_condicoes_homologacao.test.sql"
# rollback da 158: recusa com condições gravadas; limpa e reverte
if run -d "$DB" -f "$M/158_rollback.sql" >/dev/null 2>&1; then echo "FALHA: rollback 158 não recusou"; exit 1; fi; echo "ok - rollback da 158 recusado com condições gravadas"
run -d "$DB" -c "delete from canais_venda where organizacao_id='c0000000-0000-4000-8000-000000000003'; truncate canais_venda_historico;"
run -d "$DB" -f "$M/158_rollback.sql"; echo "ok - rollback da 158 aplicado"
# rollback: recusa com dados; aceita em banco sem dados de importação
if run -d "$DB" -f "$M/157_rollback.sql" >/dev/null 2>&1; then echo "FALHA: rollback não recusou com dados"; exit 1; fi; echo "ok - rollback recusado com dados importados"
run -d "$DB" -c "delete from ficha_tecnica where produto_id in (select id from produtos where homologacao<>'nao_aplicavel' or rendimento<>1); delete from produtos where homologacao<>'nao_aplicavel' or rendimento<>1; truncate catalogo_origem, catalogo_importacoes, ficha_mao_de_obra;"
run -d "$DB" -f "$M/157_rollback.sql"
SNAP=$(run -d "$DB" -tA -c "select count(*) from snap_custo s where abs(fn_custo_produto(s.id)-s.custo)>1e-12")
if [ "$SNAP" = "0" ]; then echo "ok - após rollback a fn_custo_produto volta a bater com o snapshot das Subways"; else echo "FALHA: custo diverge após rollback"; exit 1; fi
echo "TODOS OS TESTES PG PASSARAM"
