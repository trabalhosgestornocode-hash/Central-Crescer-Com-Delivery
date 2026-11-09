#!/usr/bin/env bash
# Aplica a CADEIA COMPLETA de migrations do repositório (schema.sql + 000..158, em ordem numérica) num Postgres DESCARTÁVEL local
# e confere o que importa para o catálogo: erros de migration, RLS ligado, grants (anon/authenticated sem acesso às tabelas novas),
# funções (fn_custo_produto, fn_catalogo_importar) e gatilhos. Exige CAT_PG_DESCARTAVEL=1 e loopback. NÃO toca em Supabase algum.
# Uso: CAT_PG_DESCARTAVEL=1 CAT_PG_PORT=55420 PSQL="/c/Program Files/PostgreSQL/17/bin/psql" bash cadeia_completa.sh
set -uo pipefail
[ "${CAT_PG_DESCARTAVEL:-}" = "1" ] || { echo "defina CAT_PG_DESCARTAVEL=1"; exit 2; }
HOST="${CAT_PG_HOST:-127.0.0.1}"; case "$HOST" in 127.0.0.1|localhost|::1) ;; *) echo "só loopback"; exit 2;; esac
PORT="${CAT_PG_PORT:-55420}"; PSQL="${PSQL:-psql}"; DB="cadeia_$$"
AQUI="$(cd "$(dirname "$0")" && pwd)"; M="$AQUI/../../../database/migrations"
run() { "$PSQL" -h "$HOST" -p "$PORT" -U postgres -q "$@"; }
run -d postgres -c "create database $DB" >/dev/null; trap 'run -d postgres -c "drop database if exists $DB" >/dev/null 2>&1' EXIT
run -d "$DB" -f "$AQUI/00_stub.sql" >/dev/null 2>&1
# stubs extras do ambiente Supabase usados por migrations posteriores
run -d "$DB" >/dev/null 2>&1 <<'EOSQL'
create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
create or replace function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;
create schema if not exists realtime; create schema if not exists extensions; create schema if not exists storage;
do $$ begin if not exists (select 1 from pg_publication where pubname='supabase_realtime') then create publication supabase_realtime; end if; end $$;
EOSQL
ERROS=0; APLICADAS=0; : > /tmp/cadeia_erros.txt
aplica() { local f="$1"; local out; out="$(run -d "$DB" -v ON_ERROR_STOP=1 -f "$f" 2>&1 >/dev/null)"; if [ -n "$(echo "$out" | grep -i 'erro\|error')" ]; then ERROS=$((ERROS+1)); echo "== $(basename "$f")" >> /tmp/cadeia_erros.txt; echo "$out" | grep -i 'erro\|error' | head -2 >> /tmp/cadeia_erros.txt; else APLICADAS=$((APLICADAS+1)); fi; }
aplica "$AQUI/../../../database/schema.sql"
for f in $(ls "$M"/*.sql | grep -v "_rollback" | sort); do aplica "$f"; done
echo "migrations aplicadas sem erro: $APLICADAS ; com erro: $ERROS"
[ -s /tmp/cadeia_erros.txt ] && { echo "--- erros (primeiros):"; head -40 /tmp/cadeia_erros.txt; }
q() { run -d "$DB" -tA -c "$1"; }
echo "157/158 presentes: $(q "select to_regclass('catalogo_origem') is not null and to_regclass('canais_venda_historico') is not null")"
echo "RLS nas tabelas novas: $(q "select bool_and(relrowsecurity) from pg_class where relname in ('catalogo_origem','catalogo_importacoes','ficha_mao_de_obra','canais_venda_historico')")"
echo "anon/authenticated SEM acesso às tabelas novas: $(q "select bool_and(not has_table_privilege(r,t,'select')) from (values ('anon'),('authenticated')) a(r), (values ('catalogo_origem'),('catalogo_importacoes'),('ficha_mao_de_obra'),('canais_venda_historico')) b(t)")"
echo "anon/authenticated SEM execute em fn_catalogo_importar: $(q "select not has_function_privilege('anon','fn_catalogo_importar(uuid,text,jsonb,uuid,jsonb,boolean)','execute') and not has_function_privilege('authenticated','fn_catalogo_importar(uuid,text,jsonb,uuid,jsonb,boolean)','execute')")"
echo "gatilhos de ficha_tecnica: $(q "select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid='ficha_tecnica'::regclass and not tgisinternal")"
echo "políticas RLS em produtos/insumos/ficha_tecnica/canais_venda: $(q "select count(*) from pg_policies where tablename in ('produtos','insumos','ficha_tecnica','canais_venda')")"
echo "fn_custo_produto aceita rendimento: $(q "select pg_get_functiondef('fn_custo_produto(uuid)'::regprocedure) like '%rendimento%'")"
