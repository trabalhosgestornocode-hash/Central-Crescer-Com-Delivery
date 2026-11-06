#!/bin/bash
# Cria um banco LOCAL DESCARTÁVEL para o Financeiro 2.0 (privilégios do Supabase simulados) e aplica 120 → 121 → 122 → 151.
# Só os registros de plataforma (empresas/unidades sintéticas) são inseridos aqui; o resto é criado pelos SERVIÇOS reais.
#   PG_CLUSTER_DIR=~/pg-descartavel bash backend/testes-seguros/financeiro-2-0/preparar_banco.sh [nome_do_banco]
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
S="$(cd "$(dirname "$0")" && pwd)"; R="$(cd "$S/../../.." && pwd)"; M="$R/database/migrations"; STUB="$S/../pg/stub.sql"
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR (cluster DESCARTÁVEL local com MARCADOR_DESCARTAVEL)}"
DB="${1:-fin20app}"; H="-h 127.0.0.1 -p 54321"
case "$DB" in fin20*) ;; *) echo "nome de banco recusado (use fin20*)"; exit 2;; esac
[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo "sem marcador: recusado"; exit 2; }
psql $H -U postgres -tAc "show data_directory" | grep -qF "$CLUSTER" || { echo "cluster inesperado: recusado"; exit 2; }
psql $H -U postgres -q -d postgres -c "do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='dono_sim') then create role dono_sim login nosuperuser nobypassrls createrole; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end \$\$" >/dev/null 2>&1
psql $H -U postgres -q -d postgres -c "drop database if exists $DB with (force)" -c "create database $DB owner dono_sim" 2>&1 | grep -v NOTICE
psql $H -U postgres -q -d $DB -c "grant all on schema public to dono_sim; grant usage on schema public to anon, authenticated, service_role" >/dev/null
D="psql $H -U dono_sim -d $DB -q -v ON_ERROR_STOP=1"
$D -c "alter default privileges in schema public grant all on tables to anon, authenticated, service_role; alter default privileges in schema public grant all on sequences to anon, authenticated, service_role; alter default privileges in schema public grant all on functions to anon, authenticated, service_role" >/dev/null 2>&1
$D -f "$STUB" >/dev/null 2>&1 || { echo "stub falhou"; exit 1; }
for f in 120_gestao_financeira_fundacao.sql 121_gestao_financeira_dominio.sql 122_conciliacao_periodos.sql 151_financeiro_2_contas_pagar.sql; do
  $D -f "$M/$f" >/dev/null 2>"${TMPDIR:-/tmp}/fin20prep.txt" || { echo "falhou $f: $(grep -m2 -E 'ERRO|ERROR' "${TMPDIR:-/tmp}/fin20prep.txt")"; exit 1; }
done
u() { printf '00000000-0000-4000-8000-%012d' "$1"; }
printf '%s\n' "insert into organizacoes(id,nome) values ('$(u 1)','Açaí no Grau (dados SINTÉTICOS)'),('$(u 4)','Outra Empresa (SINTÉTICA)');
insert into unidades(id,organizacao_id,nome) values ('$(u 2)','$(u 1)','Loja Centro (sintética)'),('$(u 3)','$(u 1)','Loja Norte (sintética)'),('$(u 5)','$(u 4)','Unidade X (sintética)');" \
  | psql $H -U postgres -d $DB -q -v ON_ERROR_STOP=1 -f - >/dev/null || { echo "seed de plataforma falhou"; exit 1; }
echo "banco $DB pronto (120, 121, 122, 151) — dados de plataforma sintéticos"
