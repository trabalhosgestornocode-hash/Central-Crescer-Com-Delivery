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
# 121: na branch de integracao ela vive em database/migrations; na branch do Agente 2 ainda esta em sql-provisorio
SQL="$AQUI/../../database/migrations/121_gestao_financeira_dominio.sql"; [ -f "$SQL" ] || SQL="$AQUI/../../docs/gestao-financeira/sql-provisorio/121_gestao_financeira_dominio.provisorio.sql"
# 120 antes da 121: a 121 exige a guarda de transferência de unidades da 120 (§5b)
F120="$AQUI/../../database/migrations/120_gestao_financeira_fundacao.sql"
R121="$AQUI/../../database/migrations/121_rollback.sql"; [ -f "$R121" ] || R121="$AQUI/../../docs/gestao-financeira/sql-provisorio/121_rollback.provisorio.sql"
run() { "$PSQL" -h "$HOST" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
run -d postgres -c "create database $DB"
trap 'run -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
run -d "$DB" -f "$AQUI/00_stub.sql"
run -d "$DB" -f "$F120"
run -d "$DB" -f "$SQL"
run -d "$DB" -f "$SQL"   # idempotência: segunda aplicação não pode falhar
SQL2="$AQUI/../../database/migrations/122_conciliacao_periodos.sql"
run -d "$DB" -f "$SQL2"
run -d "$DB" -f "$SQL2"  # idempotência do 122
run -d "$DB" -f "$AQUI/10_dominio.test.sql"
run -d "$DB" -f "$AQUI/20_periodos_conciliacao.test.sql"
run -d "$DB" -f "$AQUI/25_cancelamento_par.test.sql"
# 126: autoconcessão só do SuperAdmin ativo. Idempotente; o rollback volta à regra da 120 (nem o SuperAdmin se concede).
M126="$AQUI/../../database/migrations/126_financeiro_autoconcessao_superadmin.sql"
run -d "$DB" -f "$M126"; run -d "$DB" -f "$M126"
run -d "$DB" -f "$AQUI/50_autoconcessao_126.test.sql"
run -d "$DB" -f "$AQUI/../../database/migrations/126_rollback.sql"
if run -d "$DB" -f "$AQUI/50_autoconcessao_126.test.sql" >/dev/null 2>&1; then echo "FALHA: depois do rollback da 126 o SuperAdmin ainda se autoconcede"; exit 1; fi
echo "rollback da 126 restaura a proibição da 120 (ok)"
run -d "$DB" -f "$M126"
export HOST PORT PSQL DB
bash "$AQUI/30_concorrencia.sh"
# idempotência COM DADOS: o teste de concorrência deixou dados committados; reaplicar 121 e 122 não pode alterar nem perder nada
CONTA_ANTES=$(run -d "$DB" -t -A -c "select (select count(*) from fin_lancamentos)||'/'||(select count(*) from fin_transferencias)||'/'||(select count(*) from fin_periodos)||'/'||(select count(*) from fin_auditoria)")
run -d "$DB" -f "$SQL"; run -d "$DB" -f "$SQL2"
CONTA_DEPOIS=$(run -d "$DB" -t -A -c "select (select count(*) from fin_lancamentos)||'/'||(select count(*) from fin_transferencias)||'/'||(select count(*) from fin_periodos)||'/'||(select count(*) from fin_auditoria)")
[ "$CONTA_ANTES" = "$CONTA_DEPOIS" ] || { echo "FALHA: reaplicar com dados mudou contagens ($CONTA_ANTES -> $CONTA_DEPOIS)"; exit 1; }
echo "reaplicacao com dados existentes OK ($CONTA_DEPOIS)"
# rollback seguro: o teste de concorrência deixou dados COMMITADOS => o rollback deve RECUSAR (e nada ser removido)
if run -d "$DB" -f "$AQUI/../../database/migrations/122_rollback.sql" 2>/dev/null; then echo "FALHA: rollback do 122 nao recusou com dados"; exit 1; fi
echo "rollback com dados recusado (ok)"
# banco novo e vazio: aplica 121+122, faz rollback 122 SEM reaplicar a 121 (F-C: o rollback se auto-restaura), reaplica 122; depois rollback 122+121
VAZIO="${DB}_v"; REF="${DB}_r"
run -d postgres -c "create database $VAZIO"; run -d postgres -c "create database $REF"
trap 'run -d postgres -c "drop database if exists $DB" >/dev/null; run -d postgres -c "drop database if exists ${DB}_v" >/dev/null; run -d postgres -c "drop database if exists ${DB}_r" >/dev/null' EXIT
RB="$AQUI/../../database/migrations/122_rollback.sql"
run -d "$REF" -f "$AQUI/00_stub.sql"; run -d "$REF" -f "$F120"; run -d "$REF" -f "$SQL"            # referência: SÓ a 121
run -d "$VAZIO" -f "$AQUI/00_stub.sql"; run -d "$VAZIO" -f "$F120"; run -d "$VAZIO" -f "$SQL"; run -d "$VAZIO" -f "$SQL2"
# âncora de trava vazia ('aberto', sem dados): não pode impedir o rollback nem o da 121 (LD-006 item 3)
run -d "$VAZIO" -c "insert into organizacoes (id, nome) values ('00000000-0000-4000-8000-000000000001','O')" -c "insert into unidades (id, organizacao_id, nome) values ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','U')" -c "select fin_abrir_periodo('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','2026-09-01') is not null" >/dev/null
run -d "$VAZIO" -f "$RB"
DEF="select md5(pg_get_functiondef('fin_lancamentos_guarda()'::regprocedure)) || md5(pg_get_functiondef('fin_confirmar_importacao(uuid,uuid,uuid,uuid)'::regprocedure)) || has_function_privilege('service_role','fin_desvincular_transferencia(uuid,uuid,uuid,uuid)','execute')::text || (select count(*) from pg_proc where proname like 'fin\_%' and proname in ('fin_fechar_periodo','fin_abrir_periodo','fin_cancelar_transferencia','fin_conceder_excecao_fechamento','fin_periodo_travar_e_checar'))::text"
A=$(run -d "$REF" -t -A -c "$DEF"); B=$(run -d "$VAZIO" -t -A -c "$DEF")
[ "$A" = "$B" ] || { echo "FALHA: rollback da 122 nao restaurou o estado da 121 ($A != $B)"; exit 1; }
echo "rollback da 122 restaura exatamente as funcoes/privilegios da 121 (sem reaplicar a 121)"
run -d "$VAZIO" -c "begin; insert into fin_contas (organizacao_id, unidade_id, nome) values ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','C'); insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, descricao, sentido, valor_centavos, data_movimento, classificacao_pendente) select organizacao_id, unidade_id, id, 'x', 'entrada', 1, '2026-10-02', true from fin_contas; rollback;"   # escrita logo após o rollback funciona
run -d "$VAZIO" -f "$SQL2"
run -d "$VAZIO" -f "$RB"
run -d "$VAZIO" -f "$R121"
echo "rollback 122/121 em banco vazio OK"
