#!/bin/bash
# D-1: teto diário por TELEFONE (RATE_LIMIT_DIA) — SOMENTE PostgreSQL LOCAL DESCARTÁVEL (cluster com MARCADOR_DESCARTAVEL, 127.0.0.1:54321).
# Usa a função REAL `comunicacao_reservar_envio` da cadeia da main (banco `nt_branch`, mantido por `MANTER_BANCOS=1 bash notificacoes_config2.sh`).
# Reproduz o caso de produção: 7 registros de empresa (em 3 empresas) compartilhando UM contato de WhatsApp e o teto configurado em 3.
# Não altera nenhuma cota: só mede o efeito de cada alternativa (teto atual × teto maior) e as proteções (outro telefone, vencimento, dia, minuto,
# idempotência). Uso: PG_CLUSTER_DIR=<cluster> bash backend/testes-seguros/pg/rate_limit_d1.sh
set -u
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR (cluster DESCARTÁVEL local)}"; H="-h 127.0.0.1 -p 54321"; DB=rl1
N_OK=0; N_F=0; ok() { echo "OK    $1"; N_OK=$((N_OK+1)); }; bad() { echo "FALHA $1"; N_F=$((N_F+1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — esperado [$3], obtido [$2]"; fi; }
[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo "RECUSADO: sem MARCADOR_DESCARTAVEL"; exit 2; }
psql $H -U postgres -tAc "show data_directory" | grep -qF "$CLUSTER" || { echo "RECUSADO: servidor não é o cluster descartável"; exit 2; }
psql $H -U postgres -tAc "select to_regclass('public.comunicacao_mensagens')" -d nt_branch 2>/dev/null | grep -q comunicacao_mensagens || { echo "falta nt_branch (rode notificacoes_config2.sh com MANTER_BANCOS=1)"; exit 2; }
q() { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d $DB -c "$1" 2>&1; }
semear() { local r; r="$(q "$1")"; case "$r" in *ERROR*|*ERRO*) echo "SEED FALHOU: $r"; exit 2;; esac; }
psql $H -U postgres -X -q -d postgres -c "drop database if exists $DB" -c "create database $DB owner dono_sim template nt_branch" >/dev/null 2>&1 || { echo "não consegui clonar nt_branch"; exit 2; }

U() { printf '00000000-0000-4000-8000-%012d' "$1"; }
CWX=$(U 9001); CWY=$(U 9002)
semear "insert into organizacoes (id, nome, status) values ('$(U 9101)','[RL] O1','ativa'),('$(U 9102)','[RL] O2','ativa'),('$(U 9103)','[RL] O3','ativa')"
semear "insert into contatos_whatsapp (id, telefone_e164, verificado, verificado_em, consentimento, consentimento_em, opt_out) values ('$CWX','+5511944440001',true,now(),true,now(),false),('$CWY','+5511944440002',true,now(),true,now(),false)"
# 7 mensagens do telefone X (empresas O1×3, O2×2, O3×2) e 1 do telefone Y — todas já "reivindicadas" pelo worker w1 (PROCESSING)
msg() { # id contato org
  semear "set session_replication_role = replica; insert into comunicacao_mensagens (id, organizacao_id, contato_id, tipo, conteudo, idempotency_key, disponivel_em, status, direcao, claimed_by, claimed_at, claim_geracao, claim_expira_em, tentativas, max_tentativas, expira_em) values ('$1','$3','$2','dashboard_ifood_d1','sintetico','rl-$1', now() - interval '1 minute','PROCESSING','saida','w1', now(), 1, now() + interval '10 minutes',0,3, now() + interval '24 hours')"; }
cria_tudo() {
  q "set session_replication_role = replica; delete from comunicacao_mensagens where idempotency_key like 'rl-%'" >/dev/null
  for i in 1 2 3; do msg "$(U $((9200+i)))" $CWX "$(U 9101)"; done
  for i in 4 5; do msg "$(U $((9200+i)))" $CWX "$(U 9102)"; done
  for i in 6 7; do msg "$(U $((9200+i)))" $CWX "$(U 9103)"; done
  msg "$(U 9208)" $CWY "$(U 9101)"
}
# reservar(id, teto_por_contato_dia, teto_por_minuto)
RES() { q "select comunicacao_reservar_envio('$(U "$1")', 'w1', 1, 60, null, ${2:-3}, ${3:-null}, null, date_trunc('day', now()), null)::jsonb->>'resultado'"; }
SEQ() { local t=$1 o=""; for i in 1 2 3 4 5 6 7; do o="$o$(RES $((9200+i)) $t) "; done; echo "${o% }"; }

cria_tudo
chk "teto ATUAL (3): 3 passam e 4 são barradas por RATE_LIMIT_DIA (o padrão de produção: 4/dia)" "$(SEQ 3)" "INICIADO INICIADO INICIADO RATE_LIMIT_DIA RATE_LIMIT_DIA RATE_LIMIT_DIA RATE_LIMIT_DIA"
chk "o OUTRO telefone não é afetado pelo teto do primeiro" "$(RES 9208 3)" "INICIADO"
chk "idempotência: reservar de novo uma mensagem já reservada não envia duas vezes (POSSE_PERDIDA)" "$(RES 9201 3)" "POSSE_PERDIDA"
chk "as barradas continuam PROCESSING (o adiamento é decidido pelo serviço, não pelo banco)" "$(q "select count(*) from comunicacao_mensagens where idempotency_key like 'rl-%' and status='PROCESSING'")" "4"

cria_tudo
chk "ALTERNATIVA teto 7: as 7 mensagens do mesmo telefone passam (7 avisos separados ao mesmo número no dia)" "$(SEQ 7)" "INICIADO INICIADO INICIADO INICIADO INICIADO INICIADO INICIADO"
cria_tudo
chk "ALTERNATIVA teto 4 (meio-termo): 4 passam, 3 barradas" "$(SEQ 4)" "INICIADO INICIADO INICIADO INICIADO RATE_LIMIT_DIA RATE_LIMIT_DIA RATE_LIMIT_DIA"

cria_tudo
q "update comunicacao_mensagens set status='SENT', enviado_em = now() - interval '1 day 1 hour' where idempotency_key in ('rl-$(U 9201)','rl-$(U 9202)','rl-$(U 9203)')" >/dev/null
chk "o teto é DIÁRIO: 3 envios de ONTEM não contam hoje (as 4 restantes passam)" "$(for i in 4 5 6 7; do printf '%s ' "$(RES $((9200+i)) 3)"; done | sed 's/ $//')" "INICIADO INICIADO INICIADO RATE_LIMIT_DIA"

cria_tudo
q "update comunicacao_mensagens set expira_em = now() - interval '1 minute' where id='$(U 9201)'" >/dev/null
chk "VENCIDA no banco: a reserva cancela como EXPIRADA (defesa que já existia) e não consome o teto" "$(RES 9201 3)/$(q "select status||':'||erro from comunicacao_mensagens where id='$(U 9201)'")" "EXPIRADA/CANCELLED:EXPIRADA"
chk "…o teto continua com folga para as demais (3 passam entre as 6 restantes)" "$(for i in 2 3 4 5 6 7; do printf '%s ' "$(RES $((9200+i)) 3)"; done | sed 's/ $//')" "INICIADO INICIADO INICIADO RATE_LIMIT_DIA RATE_LIMIT_DIA RATE_LIMIT_DIA"

cria_tudo
chk "teto por MINUTO (2): a 3ª mensagem do mesmo minuto é RATE_LIMIT_MINUTO (adia ~2 min, não vai para o dia seguinte)" "$(for i in 1 2 3; do printf '%s ' "$(RES $((9200+i)) 10 2)"; done | sed 's/ $//')" "INICIADO INICIADO RATE_LIMIT_MINUTO"
chk "nenhuma cota foi alterada por este teste (configuração global intacta)" "$(q "select valor->>'max_por_contato_por_dia' from comunicacao_configuracoes where chave='limites'")" "$(psql $H -U postgres -X -tA -d nt_branch -c "select valor->>'max_por_contato_por_dia' from comunicacao_configuracoes where chave='limites'")"
psql $H -U postgres -X -q -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
echo "== $N_OK ok, $N_F falhas =="; [ "$N_F" = 0 ]
