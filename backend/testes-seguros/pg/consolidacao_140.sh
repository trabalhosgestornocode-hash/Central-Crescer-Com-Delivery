#!/bin/bash
# D-1: migration 140 (cota ÚNICA por mensagem física consolidada) — SOMENTE PostgreSQL LOCAL DESCARTÁVEL (cluster com MARCADOR_DESCARTAVEL, 127.0.0.1:54321).
# Usa a cadeia da main (banco `nt_branch`, mantido por `MANTER_BANCOS=1 bash notificacoes_config2.sh`), aplica a 140 numa CÓPIA e prova:
# (a) chave nula = comportamento idêntico ao da 104 (flag desligada); (b) 7 componentes de uma chave consomem UMA vaga do teto do telefone;
# (c) o teto de 3 mensagens FÍSICAS por telefone/dia continua valendo; (d) concorrência (sessões paralelas) sem estourar o teto; (e) rollback e reaplicação.
# Uso: PG_CLUSTER_DIR=<cluster> bash backend/testes-seguros/pg/consolidacao_140.sh
set -u
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR (cluster DESCARTÁVEL local)}"; H="-h 127.0.0.1 -p 54321"; DB=c140
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
N_OK=0; N_F=0; ok() { echo "OK    $1"; N_OK=$((N_OK+1)); }; bad() { echo "FALHA $1"; N_F=$((N_F+1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — esperado [$3], obtido [$2]"; fi; }
[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo "RECUSADO: sem MARCADOR_DESCARTAVEL"; exit 2; }
psql $H -U postgres -tAc "show data_directory" | grep -qF "$CLUSTER" || { echo "RECUSADO: servidor não é o cluster descartável"; exit 2; }
psql $H -U postgres -tAc "select to_regclass('public.comunicacao_mensagens')" -d nt_branch 2>/dev/null | grep -q comunicacao_mensagens || { echo "falta nt_branch (rode notificacoes_config2.sh com MANTER_BANCOS=1)"; exit 2; }
q() { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d $DB -c "$1" 2>&1; }
semear() { local r; r="$(q "$1")"; case "$r" in *ERROR*|*ERRO*) echo "SEED FALHOU: $r"; exit 2;; esac; }
psql $H -U postgres -X -q -d postgres -c "drop database if exists $DB" -c "create database $DB owner dono_sim template nt_branch" >/dev/null 2>&1 || { echo "não consegui clonar nt_branch"; exit 2; }

U() { printf '00000000-0000-4000-8000-%012d' "$1"; }
CWX=$(U 9301); CWY=$(U 9302)
semear "insert into organizacoes (id, nome, status) values ('$(U 9401)','[C140] O1','ativa'),('$(U 9402)','[C140] O2','ativa'),('$(U 9403)','[C140] O3','ativa'),('$(U 9404)','[C140] O4','ativa'),('$(U 9405)','[C140] O5','ativa'),('$(U 9406)','[C140] O6','ativa'),('$(U 9407)','[C140] O7','ativa')"
semear "insert into contatos_whatsapp (id, telefone_e164, verificado, verificado_em, consentimento, consentimento_em, opt_out) values ('$CWX','+5511955550001',true,now(),true,now(),false),('$CWY','+5511955550002',true,now(),true,now(),false)"
# mensagem PROCESSING reivindicada pelo worker w1: msg <idN> <contato> <orgN>
msg() { semear "set session_replication_role = replica; insert into comunicacao_mensagens (id, organizacao_id, contato_id, tipo, conteudo, idempotency_key, disponivel_em, status, direcao, claimed_by, claimed_at, claim_geracao, claim_expira_em, tentativas, max_tentativas, expira_em) values ('$(U $1)','$(U $3)','$2','dashboard_ifood_d1','sintetico','c140-$1', now() - interval '1 minute','PROCESSING','saida','w1', now(), 1, now() + interval '10 minutes',0,3, now() + interval '24 hours')"; }
limpa() { q "set session_replication_role = replica; delete from comunicacao_mensagens where idempotency_key like 'c140-%'" >/dev/null; }
sete() { limpa; for i in 1 2 3 4 5 6 7; do msg $((9500+i)) $CWX $((9400+i)); done; }
# reservar(idN, teto, chave|null, teto_minuto|null)
RES() { local k="${3:-null}"; [ "$k" != "null" ] && k="'$k'"; q "select comunicacao_reservar_envio('$(U "$1")', 'w1', 1, 60, null, ${2:-3}, ${4:-null}, null, date_trunc('day', now()), null, $k)::jsonb->>'resultado'"; }
enviou() { q "update comunicacao_mensagens set status='SENT', enviado_em = now() where idempotency_key like 'c140-%' and status='SENDING'" >/dev/null; }

# ---------- aplicação da 140 (e idempotência) ----------
APLICA() { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -q -v ON_ERROR_STOP=1 -d $DB -f "$RAIZ/database/migrations/140_comunicacao_consolidacao_cota_unica.sql" 2>&1 | grep -i "error\|erro" | head -3; }
chk "a 140 aplica sem erro na cadeia da main" "$(APLICA)" ""
chk "a 140 é idempotente (segunda aplicação sem erro)" "$(APLICA)" ""
chk "assinatura nova com 11 parâmetros e UMA função só" "$(q "select count(*)||'/'||max(pronargs) from pg_proc where proname='comunicacao_reservar_envio'")" "1/11"
chk "execução só para service_role (anon/authenticated/public sem acesso)" "$(q "select has_function_privilege('anon', p.oid, 'execute')::text||has_function_privilege('authenticated', p.oid, 'execute')::text||has_function_privilege('service_role', p.oid, 'execute')::text from pg_proc p where proname='comunicacao_reservar_envio'")" "falsefalsetrue"

# ---------- (a) chave NULA = comportamento idêntico (flag desligada) ----------
sete
chk "chave nula, teto 3: 3 passam e 4 são barradas (idêntico ao rate_limit_d1)" "$(o=""; for i in 1 2 3 4 5 6 7; do o="$o$(RES $((9500+i)) 3) "; done; echo "${o% }")" "INICIADO INICIADO INICIADO RATE_LIMIT_DIA RATE_LIMIT_DIA RATE_LIMIT_DIA RATE_LIMIT_DIA"
chk "chave nula: a reserva grava chave nula" "$(q "select count(*) from comunicacao_mensagens where idempotency_key like 'c140-%' and consolidacao_chave is not null")" "0"

# ---------- (b) os 7 componentes de UMA chave consomem UMA vaga ----------
sete
chk "7 componentes da mesma chave: os 7 reservam (INICIADO) com teto 3" "$(o=""; for i in 1 2 3 4 5 6 7; do o="$o$(RES $((9500+i)) 3 chaveK1) "; done; echo "${o% }")" "INICIADO INICIADO INICIADO INICIADO INICIADO INICIADO INICIADO"
chk "a reserva grava a chave nos 7" "$(q "select count(*) from comunicacao_mensagens where idempotency_key like 'c140-%' and consolidacao_chave='chaveK1'")" "7"
enviou
chk "depois de SENT: o telefone consumiu UMA mensagem física no dia (7 linhas, 1 chave)" "$(q "select count(distinct coalesce(consolidacao_chave, id::text)) from comunicacao_mensagens where contato_id='$CWX' and idempotency_key like 'c140-%' and status='SENT'")" "1"

# ---------- (c) o teto de 3 mensagens FÍSICAS por telefone/dia continua valendo ----------
for i in 8 9 10 11; do msg $((9500+i)) $CWX $((9400+i-7)); done
chk "mais 2 mensagens individuais do mesmo telefone passam (1 consolidada + 2 = 3 físicas)" "$(RES 9508 3) $(RES 9509 3)" "INICIADO INICIADO"
chk "a 4ª mensagem física do telefone é barrada (RATE_LIMIT_DIA): teto global 3 preservado" "$(RES 9510 3)" "RATE_LIMIT_DIA"
chk "uma 2ª consolidação também é barrada quando o teto já está cheio" "$(RES 9511 3 chaveK2)" "RATE_LIMIT_DIA"
msg 9520 $CWY 9401
chk "o OUTRO telefone não é afetado" "$(RES 9520 3)" "INICIADO"

# dois grupos + um individual = 3 físicas; o quarto grupo é barrado
sete; limpa; for i in 1 2 3 4 5 6 7 8; do msg $((9500+i)) $CWX $((9400+i-(i>7?7:0))); done
chk "grupo A (3) + grupo B (2) + individual: 3 físicas; o grupo C é barrado" "$(for i in 1 2 3; do printf '%s ' "$(RES $((9500+i)) 3 gA)"; done; for i in 4 5; do printf '%s ' "$(RES $((9500+i)) 3 gB)"; done; printf '%s ' "$(RES 9506 3)"; printf '%s' "$(RES 9507 3 gC)")" "INICIADO INICIADO INICIADO INICIADO INICIADO INICIADO RATE_LIMIT_DIA"

# ---------- retry: o componente que volta ao fluxo individual perde a chave ----------
limpa; msg 9530 $CWX 9401; RES 9530 3 gR >/dev/null
q "update comunicacao_mensagens set status='PROCESSING', claim_expira_em=now()+interval '10 minutes' where id='$(U 9530)'" >/dev/null
chk "reserva individual posterior (chave nula) limpa a chave" "$(RES 9530 3) $(q "select coalesce(consolidacao_chave,'nula') from comunicacao_mensagens where id='$(U 9530)'")" "INICIADO nula"

# ---------- cooldown: irmãs do mesmo grupo não se bloqueiam ----------
limpa; msg 9540 $CWX 9401; msg 9541 $CWX 9401
R1="$(q "select comunicacao_reservar_envio('$(U 9540)','w1',1,60,8,3,null,null,date_trunc('day',now()),null,'gCool')::jsonb->>'resultado'")"
R2="$(q "select comunicacao_reservar_envio('$(U 9541)','w1',1,60,8,3,null,null,date_trunc('day',now()),null,'gCool')::jsonb->>'resultado'")"
chk "cooldown: irmã do MESMO grupo na mesma empresa/unidade/tipo não conta como cooldown" "$R1 $R2" "INICIADO INICIADO"
limpa; msg 9542 $CWX 9401; msg 9543 $CWX 9401
R1="$(q "select comunicacao_reservar_envio('$(U 9542)','w1',1,60,8,3,null,null,date_trunc('day',now()),null,null)::jsonb->>'resultado'")"
R2="$(q "select comunicacao_reservar_envio('$(U 9543)','w1',1,60,8,3,null,null,date_trunc('day',now()),null,null)::jsonb->>'resultado'")"
chk "cooldown sem chave: continua barrando (comportamento de hoje)" "$R1 $R2" "INICIADO COOLDOWN"

# ---------- taxa por minuto: mensagem física, não linha ----------
sete
chk "taxa global 2/min com chave: os 7 componentes (1 física) passam" "$(o=""; for i in 1 2 3 4 5 6 7; do o="$o$(RES $((9500+i)) 99 gM 2) "; done; echo "${o% }")" "INICIADO INICIADO INICIADO INICIADO INICIADO INICIADO INICIADO"
sete
chk "taxa global 2/min SEM chave: só 2 passam (como hoje)" "$(o=""; for i in 1 2 3 4 5; do o="$o$(RES $((9500+i)) 99 null 2) "; done; echo "${o% }")" "INICIADO INICIADO RATE_LIMIT_MINUTO RATE_LIMIT_MINUTO RATE_LIMIT_MINUTO"

# ---------- (d) concorrência: sessões paralelas ----------
TMP="$(mktemp -d)"
sete
for i in 1 2 3 4 5 6 7; do ( RES $((9500+i)) 3 gP > "$TMP/g$i" ) & done; wait
chk "CONCORRÊNCIA: 7 reservas paralelas da mesma chave: todas INICIADO" "$(cat $TMP/g* | sort | uniq -c | sed 's/^ *//' | tr '\n' ';')" "7 INICIADO;"
limpa; for i in 1 2 3 4 5 6 7 8; do msg $((9500+i)) $CWX $((9400+(i>7?1:i))); done
for i in 1 2 3 4 5 6 7 8; do ( RES $((9500+i)) 3 > "$TMP/i$i" ) & done; wait
chk "CONCORRÊNCIA: 8 individuais paralelas com teto 3: exatamente 3 passam (sem estouro)" "$(cat $TMP/i* | grep -c INICIADO)/$(cat $TMP/i* | grep -c RATE_LIMIT_DIA)" "3/5"
limpa; for i in 1 2 3 4 5 6 7 8 9 10 11 12; do msg $((9500+i)) $CWX $((9400+(i>7?i-7:i))); done
for i in 1 2 3 4; do ( RES $((9500+i)) 3 gQ1 > "$TMP/m$i" ) & done
for i in 5 6 7 8; do ( RES $((9500+i)) 3 gQ2 > "$TMP/m$i" ) & done
for i in 9 10 11 12; do ( RES $((9500+i)) 3 > "$TMP/m$i" ) & done; wait
chk "CONCORRÊNCIA mista (2 grupos + 4 individuais, teto 3): nunca mais de 3 mensagens físicas no telefone" "$(q "select count(distinct coalesce(consolidacao_chave, id::text)) from comunicacao_mensagens where idempotency_key like 'c140-%' and status='SENDING'")" "3"
chk "CONCORRÊNCIA mista: grupos nunca ficam pela metade (cada chave presente tem os 4 componentes reservados)" "$(q "select coalesce(bool_and(n=4),true) from (select consolidacao_chave k, count(*) n from comunicacao_mensagens where idempotency_key like 'c140-%' and status='SENDING' and consolidacao_chave is not null group by 1) x")" "t"
rm -rf "$TMP"

# ---------- (e) rollback e reaplicação ----------
chk "rollback da 140 sem erro" "$(PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -q -v ON_ERROR_STOP=1 -d $DB -f "$RAIZ/database/migrations/140_rollback.sql" 2>&1 | grep -i "error\|erro" | head -3)" ""
chk "após o rollback: função de 10 parâmetros (a da 104) e coluna removida" "$(q "select (select count(*)||'/'||max(pronargs) from pg_proc where proname='comunicacao_reservar_envio')||' '||(select count(*) from information_schema.columns where table_name='comunicacao_mensagens' and column_name='consolidacao_chave')")" "1/10 0"
chk "o corpo restaurado é o da 104 (md5 igual ao do banco de origem nt_branch)" "$(q "select md5(pg_get_functiondef(oid)) from pg_proc where proname='comunicacao_reservar_envio'")" "$(psql $H -U postgres -X -tA -d nt_branch -c "select md5(pg_get_functiondef(oid)) from pg_proc where proname='comunicacao_reservar_envio'")"
chk "reaplicar a 140 depois do rollback funciona" "$(APLICA)" ""

echo "RESULTADO: $N_OK ok, $N_F falhas"; [ "$N_F" = 0 ]
