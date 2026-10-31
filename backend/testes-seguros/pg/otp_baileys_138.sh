#!/bin/bash
# Migration 138 (reservas do OTP pelo Baileys) — SOMENTE PostgreSQL LOCAL DESCARTÁVEL (cluster com MARCADOR_DESCARTAVEL, 127.0.0.1:54321).
# Parte da CADEIA REAL: exige o banco `nt_branch` (132–136 sobre a main) mantido por `MANTER_BANCOS=1 bash notificacoes_config2.sh`.
# Prova: aplica/reaplica; dedupe por desafio sob concorrência (8 sessões = 1 linha); cota por hora/dia; saturação sob concorrência
# (exatamente N reservas); PRIORIDADE do D-1 (envio em curso/recém-vencido adia; backlog antigo e agendamento futuro NÃO bloqueiam);
# a fila do D-1 não é alterada; estado final imutável; limites inválidos; privilégios; sem número/código/texto; cascata; rollback.
# Uso: PG_CLUSTER_DIR=<cluster> bash backend/testes-seguros/pg/otp_baileys_138.sh
set -u
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
AQUI="$(cd "$(dirname "$0")" && pwd)"; M="$(cd "$AQUI/../../.." && pwd)/database/migrations"
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR (cluster DESCARTÁVEL local)}"; H="-h 127.0.0.1 -p 54321"; DB=otp138
N_OK=0; N_F=0; ok() { echo "OK    $1"; N_OK=$((N_OK+1)); }; bad() { echo "FALHA $1"; N_F=$((N_F+1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — esperado [$3], obtido [$2]"; fi; }
[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo "RECUSADO: sem MARCADOR_DESCARTAVEL"; exit 2; }
psql $H -U postgres -tAc "show data_directory" | grep -qF "$CLUSTER" || { echo "RECUSADO: servidor não é o cluster descartável"; exit 2; }
psql $H -U postgres -tAc "select to_regclass('public.comunicacao_desafios_titular')" -d nt_branch 2>/dev/null | grep -q comunicacao_desafios_titular || { echo "falta nt_branch (rode notificacoes_config2.sh com MANTER_BANCOS=1)"; exit 2; }
q()  { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d $DB -c "$1" 2>&1; }
sr() { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d $DB -c "set role service_role; $1" 2>&1 | grep -v '^SET$'; }
como() { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d $DB -c "set role $1; $2" 2>&1 | grep -v '^SET$'; }
aplicar() { psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d $DB -f "$1" >/dev/null 2>&1; }
psql $H -U postgres -X -q -d postgres -c "drop database if exists $DB" -c "create database $DB owner dono_sim template nt_branch" >/dev/null 2>&1 || { echo "não consegui clonar nt_branch (conexões abertas?)"; exit 2; }
aplicar "$M/137_notificacoes_webhook_eventos.sql"; chk "137 aplicada sobre a cadeia real" "$?" "0"
aplicar "$M/138_notificacoes_otp_envios.sql"; chk "138 aplicada" "$?" "0"
aplicar "$M/138_notificacoes_otp_envios.sql"; chk "reaplicar a 138 é inofensivo" "$?" "0"
chk "RLS ligada e sem política" "$(q "select relrowsecurity::text||'/'||(select count(*) from pg_policies where tablename='comunicacao_otp_envios') from pg_class where relname='comunicacao_otp_envios'")" "true/0"
chk "sem coluna de número, código ou texto" "$(q "select count(*) from information_schema.columns where table_name='comunicacao_otp_envios' and column_name ~ '(telefone|codigo|texto|conteudo|numero)'")" "0"

# ---------- massa sintética: desafios e fila do D-1 ----------
D() { printf '00000000-0000-4000-8000-%012d' "$1"; }
for i in $(seq 1 12); do
  q "insert into comunicacao_desafios_titular (id, tipo, telefone_cifrado, telefone_hmac, codigo_hmac, expira_em) values ('$(D $i)','gestao','x', repeat('a',64), repeat('b',64), now() + interval '4 minutes')" >/dev/null
done
RES() { sr "select comunicacao_otp_reservar('$(D "$1")', ${2:-30}, ${3:-150}, ${4:-3})::jsonb->>'resultado'"; }
limpar() { q "truncate comunicacao_otp_envios" >/dev/null; q "set session_replication_role = replica; delete from comunicacao_mensagens where idempotency_key like 'sint138-%'" >/dev/null; }
FILA_HASH="select coalesce(md5(string_agg(id::text||status||coalesce(updated_at::text,''), ',' order by id)),'vazia') from comunicacao_mensagens"

chk "1ª reserva → RESERVADO" "$(RES 1)" "RESERVADO"
chk "mesma reserva de novo → JA_RESERVADO" "$(RES 1)" "JA_RESERVADO"
limpar
for s in 1 2 3 4 5 6 7 8; do ( RES 2 >/dev/null ) & done; wait
chk "8 sessões simultâneas no MESMO desafio = 1 linha" "$(q "select count(*) from comunicacao_otp_envios where desafio_id='$(D 2)'")" "1"
limpar
for s in 1 2 3 4 5 6 7 8; do ( RES "$s" 100 1000 3 >/dev/null ) & done; wait
chk "8 desafios simultâneos com limite de 3 simultâneos → exatamente 3 ENVIANDO (serialização entre instâncias)" "$(q "select count(*) from comunicacao_otp_envios where status='ENVIANDO'")" "3"
chk "os demais ficaram ADIADO/SATURADO (fora da cota)" "$(q "select count(*) from comunicacao_otp_envios where status='ADIADO' and motivo='SATURADO'")" "5"
limpar
chk "cota por hora: 2 reservas, a 3ª → LIMITE_ATINGIDO (limite 2/h)" "$(RES 1 2 100 20)/$(RES 2 2 100 20)/$(RES 3 2 100 20)" "RESERVADO/RESERVADO/LIMITE_ATINGIDO"
chk "LIMITE não consome cota (estado LIMITE não conta)" "$(q "select count(*) from comunicacao_otp_envios where status in ('ENVIANDO','ENVIADO','INCERTO')")" "2"
limpar
chk "cota por dia: limite 1/dia → 2ª recusada" "$(RES 1 100 1 20)/$(RES 2 100 1 20)" "RESERVADO/LIMITE_ATINGIDO"
limpar; q "insert into comunicacao_otp_envios (desafio_id,status,criado_em) values ('$(D 5)','ENVIADO', now() - interval '2 hours')" >/dev/null
chk "reserva antiga (>1h) não conta na cota horária" "$(RES 1 1 100 20)" "RESERVADO"

# ---------- prioridade do D-1 ----------
msg() { q "set session_replication_role = replica; insert into comunicacao_mensagens (id, organizacao_id, tipo, conteudo, idempotency_key, disponivel_em, status, updated_at) values (gen_random_uuid(), gen_random_uuid(), 'dashboard_ifood_d1', 'sintetico', 'sint138-$1', $2, '$3', $4)" >/dev/null; }
limpar; FH0="$(q "$FILA_HASH")"
msg a "now() + interval '10 minutes'" SCHEDULED "now()"
chk "D-1 agendado para o FUTURO não bloqueia o OTP" "$(RES 1)" "RESERVADO"
limpar; msg b "now() - interval '10 minutes'" SCHEDULED "now() - interval '10 minutes'"
chk "backlog ANTIGO/parado do D-1 não bloqueia (sem inanição)" "$(RES 1)" "RESERVADO"
limpar; msg c "now() - interval '1 hour'" SENDING "now() - interval '5 minutes'"
chk "SENDING antigo (lease vencido) não bloqueia" "$(RES 1)" "RESERVADO"
limpar; msg d "now() - interval '30 seconds'" SCHEDULED "now()"
chk "D-1 recém-VENCIDO (worker prestes a pegar) → ADIADO_PRIORIDADE_D1" "$(RES 1)" "ADIADO_PRIORIDADE_D1"
chk "adiado fica registrado como ADIADO/PRIORIDADE_D1 e não consome cota" "$(q "select status||'/'||motivo from comunicacao_otp_envios where desafio_id='$(D 1)'")" "ADIADO/PRIORIDADE_D1"
limpar; msg e "now() - interval '1 hour'" SENDING "now()"
chk "D-1 em SENDING agora → ADIADO_PRIORIDADE_D1" "$(RES 1)" "ADIADO_PRIORIDADE_D1"
limpar; msg f "now() - interval '30 seconds'" PROCESSING "now()"
chk "D-1 em PROCESSING agora → ADIADO_PRIORIDADE_D1" "$(RES 1)" "ADIADO_PRIORIDADE_D1"
limpar; msg g "now() - interval '30 seconds'" SENT "now()"
chk "D-1 já ENVIADO (SENT) não bloqueia" "$(RES 1)" "RESERVADO"
limpar
chk "a fila do D-1 não foi alterada pelo OTP (hash antes = depois, sem as linhas sintéticas)" "$(q "$FILA_HASH")" "$FH0"

# ---------- resultado, limites, privilégios ----------
limpar; RES 1 >/dev/null
chk "ENVIANDO → ENVIADO" "$(sr "select comunicacao_otp_registrar_resultado('$(D 1)','ENVIADO',null)")" "t"
chk "estado final NÃO é sobrescrito (idempotente)" "$(sr "select comunicacao_otp_registrar_resultado('$(D 1)','FALHOU','X')")" "f"
chk "estado inválido é recusado" "$(sr "select comunicacao_otp_registrar_resultado('$(D 1)','QUALQUER',null)" | grep -c 'estado inválido')" "1"
chk "motivo fora do vocabulário é recusado pelo CHECK" "$(q "update comunicacao_otp_envios set motivo='com espaco' where desafio_id='$(D 1)'" | grep -c 'violates check')" "1"
chk "limites inválidos recusados" "$(sr "select comunicacao_otp_reservar('$(D 3)', 0, 100, 3)" | grep -c 'limites inválidos')" "1"
chk "desafio inexistente recusado" "$(sr "select comunicacao_otp_reservar(gen_random_uuid(), 10, 100, 3)" | grep -c 'desafio inexistente')" "1"
for r in anon authenticated; do
  chk "$r sem acesso à tabela" "$(como $r "select count(*) from comunicacao_otp_envios" | grep -c 'permission denied')" "1"
  chk "$r sem EXECUTE nas funções" "$(como $r "select comunicacao_otp_reservar('$(D 4)',10,100,3)" | grep -c 'permission denied')" "1"
done
chk "service_role não apaga nem altera colunas fora de status/motivo" "$(sr "delete from comunicacao_otp_envios" | grep -c 'permission denied')/$(sr "update comunicacao_otp_envios set criado_em = now()" | grep -c 'permission denied')" "1/1"
q "delete from comunicacao_desafios_titular where id='$(D 1)'" >/dev/null
chk "apagar o desafio apaga a reserva (cascata, sem resíduo)" "$(q "select count(*) from comunicacao_otp_envios where desafio_id='$(D 1)'")" "0"

# ---------- rollback ----------
limpar
psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d $DB -f "$M/138_rollback.sql" >/dev/null 2>&1; chk "rollback da 138" "$?" "0"
chk "rollback removeu tabela e funções e deixou 134/137 intactas" "$(q "select (to_regclass('public.comunicacao_otp_envios') is null)::text||'/'||(to_regclass('public.comunicacao_desafios_titular') is not null)::text||'/'||(to_regclass('public.comunicacao_provedor_eventos') is not null)::text||'/'||(select count(*) from pg_proc where proname like 'comunicacao_otp_%')")" "true/true/true/0"
psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d $DB -f "$M/138_rollback.sql" >/dev/null 2>&1; chk "rollback idempotente" "$?" "0"
psql $H -U postgres -X -q -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
echo "== $N_OK ok, $N_F falhas =="; [ "$N_F" = 0 ]
