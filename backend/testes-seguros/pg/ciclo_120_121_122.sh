#!/bin/bash
# Ciclo 120 -> 121 -> 122 e rollback 122 -> 121 -> 120 em PostgreSQL DESCARTÁVEL, com a janela do rollback da 122.
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
S="$(cd "$(dirname "$0")" && pwd)"
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR (diretório de dados do cluster DESCARTÁVEL local, com o arquivo MARCADOR_DESCARTAVEL)}"
R="${REPO:-$(cd "$S/../../.." && pwd)}"; M="$R/database/migrations"
P122="${P122:-$R/docs/gestao-financeira/proposta-122/122_conciliacao_periodos.provisorio.sql}"; RB122="${RB122:-$R/docs/gestao-financeira/proposta-122/122_rollback.provisorio.sql}"
H="-h 127.0.0.1 -p 54321 -U postgres"; P="psql $H -q -v ON_ERROR_STOP=1 -d ciclo3"
ok() { echo "OK    $1"; }; bad() { echo "FALHA $1"; FALHOU=1; }
[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo sem-marcador; exit 2; }
psql $H -tAc "show data_directory" | grep -qF "$CLUSTER" || { echo cluster-inesperado; exit 2; }
psql $H -q -c "drop database if exists ciclo3" -c "create database ciclo3" 2>&1 | grep -v NOTICE
$P -f "$S/stub.sql" >/dev/null 2>&1
ap() { $P -f "$1" >/dev/null 2>"${TMPDIR:-/tmp}/err3-pg.txt" && ok "$2" || { bad "$2"; head -2 "${TMPDIR:-/tmp}/err3-pg.txt"; }; }
ap "$M/120_gestao_financeira_fundacao.sql" "120"; ap "$M/121_gestao_financeira_dominio.sql" "121"; ap "$P122" "122"; ap "$P122" "122 (2ª vez, idempotente)"
$P -c "insert into organizacoes(id) values ('00000000-0000-0000-0000-0000000000a1'); insert into unidades(id,organizacao_id) values ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000a1'); insert into fin_contas(id,organizacao_id,unidade_id,nome) values ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','C')" >/dev/null 2>&1
LANC="insert into fin_lancamentos(organizacao_id,unidade_id,conta_id,categoria_id,descricao,sentido,valor_centavos,data_movimento,classificacao_pendente) values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000e1',null,'x','entrada',100,'2026-10-05',true)"
$P -c "$LANC" >/dev/null 2>&1 && ok "lançamento grava com 120+121+122" || bad "lançamento não grava com 122"
$P -c "delete from fin_lancamentos" >/dev/null 2>&1
# --- rollback da 122 (sem dados nas estruturas novas) ---
ap "$RB122" "rollback 122 (sem dados)"
ap "$RB122" "rollback 122 idempotente"
$P -c "$LANC" >/dev/null 2>"${TMPDIR:-/tmp}/janela-pg.txt" && echo "INFO  janela do rollback: lançamento GRAVA logo após o rollback da 122" || echo "ACHADO janela do rollback da 122: lançamento FALHA entre o rollback e a reaplicação da 121 ($(grep -m1 -oE 'function [a-z_]+\(.*\) does not exist|não existe' "${TMPDIR:-/tmp}/janela-pg.txt" | head -1))"
ap "$M/121_gestao_financeira_dominio.sql" "121 reaplicada (restaura guardas/funções)"
$P -c "$LANC" >/dev/null 2>&1 && ok "lançamento volta a gravar depois de reaplicar a 121" || bad "lançamento continua falhando"
$P -c "delete from fin_lancamentos" >/dev/null 2>&1
# --- rollback completo na ordem inversa ---
ap "$RB122" "rollback 122"; ap "$M/121_gestao_financeira_dominio.sql" "121 (restaura)"
# o rollback da 121 recusa se houver QUALQUER linha (inclusive as linhas 'aberto' de fin_periodos criadas automaticamente a cada escrita): limpeza supervisionada
$P -c "delete from fin_contas; delete from fin_periodos" >/dev/null 2>&1
$P -f "$M/121_rollback.sql" >/dev/null 2>&1 && ok "rollback 121 (após limpeza supervisionada dos dados de teste)" || bad "rollback 121"
T=$($P -t -A -c "select count(*) from pg_class where relnamespace='public'::regnamespace and relname like 'fin\\_%'" 2>/dev/null); [ "$T" = "0" ] && ok "nenhuma tabela/sequência fin_* restante" || bad "restaram $T objetos fin_*"
F=$($P -t -A -c "select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'fin\\_%'" 2>/dev/null); [ "$F" = "0" ] && ok "nenhuma função fin_* restante" || bad "restaram $F funções fin_*"
ap "$M/120_rollback.sql" "rollback 120"
ap "$M/120_gestao_financeira_fundacao.sql" "reaplica 120"; ap "$M/121_gestao_financeira_dominio.sql" "reaplica 121"; ap "$P122" "reaplica 122"
echo; [ -z "$FALHOU" ] && echo "CICLO 120/121/122 OK" || echo "CICLO COM FALHAS"
