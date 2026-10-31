#!/bin/bash
# Migration 137 (eventos do webhook da Meta) — SOMENTE PostgreSQL LOCAL DESCARTÁVEL (cluster com MARCADOR_DESCARTAVEL, 127.0.0.1:54321).
# Prova: aplica; reaplica sem efeito; idempotência/concorrência (N sessões gravando os mesmos eventos = 1 linha cada); negativos
# (status/chave/ids inválidos, array enorme, não-array); privilégios (anon/authenticated sem acesso; service_role só pelo RPC/insert);
# RLS ligada; rollback remove tudo e é idempotente. Uso: PG_CLUSTER_DIR=<cluster> bash backend/testes-seguros/pg/webhook_137.sh
set -u
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
AQUI="$(cd "$(dirname "$0")" && pwd)"; M="$(cd "$AQUI/../../.." && pwd)/database/migrations"
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR (cluster DESCARTÁVEL local)}"; H="-h 127.0.0.1 -p 54321"; DB=wh137
N_OK=0; N_F=0; ok() { echo "OK    $1"; N_OK=$((N_OK+1)); }; bad() { echo "FALHA $1"; N_F=$((N_F+1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — esperado [$3], obtido [$2]"; fi; }
[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo "RECUSADO: sem MARCADOR_DESCARTAVEL"; exit 2; }
psql $H -U postgres -tAc "show data_directory" | grep -qF "$CLUSTER" || { echo "RECUSADO: servidor não é o cluster descartável"; exit 2; }
q()  { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d $DB -c "$1" 2>&1; }
sr() { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d $DB -c "set role service_role; $1" 2>&1 | grep -v '^SET$'; }
como() { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d $DB -c "set role $1; $2" 2>&1 | grep -v '^SET$'; }
psql $H -U postgres -X -q -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null 2>&1
psql $H -U postgres -X -q -v ON_ERROR_STOP=1 -d $DB -f "$M/137_notificacoes_webhook_eventos.sql" >/dev/null 2>&1; chk "aplica a 137" "$?" "0"
psql $H -U postgres -X -q -v ON_ERROR_STOP=1 -d $DB -f "$M/137_notificacoes_webhook_eventos.sql" >/dev/null 2>&1; chk "reaplicar é inofensivo" "$?" "0"
chk "RLS ligada" "$(q "select relrowsecurity from pg_class where relname='comunicacao_provedor_eventos'")" "t"
chk "sem nenhuma política" "$(q "select count(*) from pg_policies where tablename='comunicacao_provedor_eventos'")" "0"
EV='[{"chave":"wamid.A:delivered","provedor_msg_id":"wamid.A","status":"delivered","codigo_erro":null},{"chave":"wamid.B:failed","provedor_msg_id":"wamid.B","status":"failed","codigo_erro":131026}]'
chk "grava 2 eventos" "$(sr "select comunicacao_provedor_registrar_eventos('$EV'::jsonb)")" "2"
chk "reentrega grava 0" "$(sr "select comunicacao_provedor_registrar_eventos('$EV'::jsonb)")" "0"
for i in 1 2 3 4 5 6 7 8; do ( sr "select comunicacao_provedor_registrar_eventos('[{\"chave\":\"wamid.C:read\",\"provedor_msg_id\":\"wamid.C\",\"status\":\"read\",\"codigo_erro\":null}]'::jsonb)" >/dev/null ) & done; wait
chk "8 sessões simultâneas = 1 linha" "$(q "select count(*) from comunicacao_provedor_eventos where chave='wamid.C:read'")" "1"
chk "total 3 linhas" "$(q "select count(*) from comunicacao_provedor_eventos")" "3"
neg() { r="$(sr "select comunicacao_provedor_registrar_eventos('$2'::jsonb)")"; if echo "$r" | grep -qiE "violates check|eventos inválidos" && ! echo "$r" | grep -qi "regular expression"; then ok "recusa: $1"; else bad "$1 não foi recusado ($r)"; fi; }
neg "status com maiúscula/símbolo" '[{"chave":"w.1:DELIVERED;x","provedor_msg_id":"w.1","status":"DELIVERED;x"}]'
neg "chave incoerente com id:status" '[{"chave":"w.2:read","provedor_msg_id":"w.9","status":"read"}]'
neg "id vazio" '[{"chave":":read","provedor_msg_id":"","status":"read"}]'
neg "objeto em vez de array" '{"a":1}'
neg "null" 'null'
neg "código de erro fora da faixa" '[{"chave":"w.3:failed","provedor_msg_id":"w.3","status":"failed","codigo_erro":99999999}]'
neg "mais de 200 itens" "$(node -e 'console.log(JSON.stringify(Array.from({length:201},(_,i)=>({chave:`w.${i}:read`,provedor_msg_id:`w.${i}`,status:"read"}))))')"
chk "negativos não gravaram nada (atômico)" "$(q "select count(*) from comunicacao_provedor_eventos")" "3"
for r in anon authenticated; do
  chk "$r não lê a tabela" "$(como $r "select count(*) from comunicacao_provedor_eventos" | grep -c 'permission denied')" "1"
  chk "$r não executa o RPC" "$(como $r "select comunicacao_provedor_registrar_eventos('[]'::jsonb)" | grep -c 'permission denied')" "1"
done
chk "service_role não apaga nem altera linhas" "$(sr "delete from comunicacao_provedor_eventos" | grep -c 'permission denied')" "1"
chk "service_role não altera linhas" "$(sr "update comunicacao_provedor_eventos set status='read'" | grep -c 'permission denied')" "1"
psql $H -U postgres -X -q -v ON_ERROR_STOP=1 -d $DB -f "$M/137_rollback.sql" >/dev/null 2>&1; chk "rollback" "$?" "0"
chk "rollback removeu tabela e função" "$(q "select (to_regclass('public.comunicacao_provedor_eventos') is null) and not exists(select 1 from pg_proc where proname='comunicacao_provedor_registrar_eventos')")" "t"
psql $H -U postgres -X -q -v ON_ERROR_STOP=1 -d $DB -f "$M/137_rollback.sql" >/dev/null 2>&1; chk "rollback idempotente" "$?" "0"
psql $H -U postgres -X -q -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
echo "== $N_OK ok, $N_F falhas =="; [ "$N_F" = 0 ]
