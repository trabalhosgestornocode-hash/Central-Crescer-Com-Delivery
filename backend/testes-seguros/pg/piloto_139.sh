#!/bin/bash
# Migration 139 (trava de convites por UNIDADE do piloto) + isolamento da REVOGAÇÃO do SAIR — SOMENTE PostgreSQL LOCAL DESCARTÁVEL
# (cluster com MARCADOR_DESCARTAVEL, 127.0.0.1:54321). Parte da CADEIA REAL: exige o banco `nt_branch` (132–136 sobre a main), mantido por
# `MANTER_BANCOS=1 bash notificacoes_config2.sh`.
# Prova: gatilho fail-closed (chave ausente/array/vazio/objeto/elemento inválido), unidade fora do piloto recusada, UPDATE não é barrado,
# privilégios; revogação do SAIR isolada por número (2 empresas compartilhando o MESMO contato de WhatsApp; outro número intacto),
# ledger só das empresas do número, fila só dos registros do número, e rollback.
# Uso: PG_CLUSTER_DIR=<cluster> bash backend/testes-seguros/pg/piloto_139.sh
set -u
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
AQUI="$(cd "$(dirname "$0")" && pwd)"; M="$(cd "$AQUI/../../.." && pwd)/database/migrations"
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR (cluster DESCARTÁVEL local)}"; H="-h 127.0.0.1 -p 54321"; DB=pil139
N_OK=0; N_F=0; ok() { echo "OK    $1"; N_OK=$((N_OK+1)); }; bad() { echo "FALHA $1"; N_F=$((N_F+1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — esperado [$3], obtido [$2]"; fi; }
[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo "RECUSADO: sem MARCADOR_DESCARTAVEL"; exit 2; }
psql $H -U postgres -tAc "show data_directory" | grep -qF "$CLUSTER" || { echo "RECUSADO: servidor não é o cluster descartável"; exit 2; }
psql $H -U postgres -tAc "select to_regclass('public.comunicacao_convites')" -d nt_branch 2>/dev/null | grep -q comunicacao_convites || { echo "falta nt_branch (rode notificacoes_config2.sh com MANTER_BANCOS=1)"; exit 2; }
q()  { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d $DB -c "$1" 2>&1; }
sr() { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d $DB -c "set role service_role; $1" 2>&1 | grep -v '^SET$'; }
como() { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d $DB -c "set role $1; $2" 2>&1 | grep -v '^SET$'; }
aplicar() { psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d $DB -f "$1" >/dev/null 2>&1; }
psql $H -U postgres -X -q -d postgres -c "drop database if exists $DB" -c "create database $DB owner dono_sim template nt_branch" >/dev/null 2>&1 || { echo "não consegui clonar nt_branch (conexões abertas?)"; exit 2; }

P1=00000000-0000-4000-8000-0000000d0101; P2=00000000-0000-4000-8000-0000000d0102
U1=00000000-0000-4000-8000-0000000d0201; U2=00000000-0000-4000-8000-0000000d0202; U3=00000000-0000-4000-8000-0000000d0203
CWX=00000000-0000-4000-8000-0000000d0301; CWY=00000000-0000-4000-8000-0000000d0302
CE1X=00000000-0000-4000-8000-0000000d0401; CE2X=00000000-0000-4000-8000-0000000d0402; CE1Y=00000000-0000-4000-8000-0000000d0403
HX=$(printf 'a%.0s' {1..64}); HY=$(printf 'b%.0s' {1..64})
semear() { local r; r="$(q "$1")"; case "$r" in *ERROR*|*ERRO*) echo "SEED FALHOU: $r"; exit 2;; esac; }
semear "insert into organizacoes (id, nome, status) values ('$P1','[139] P1','ativa'),('$P2','[139] P2','ativa')"
semear "insert into unidades (id, organizacao_id, nome, ativo, eh_teste) values ('$U1','$P1','U1',true,false),('$U2','$P1','U2',true,false),('$U3','$P2','U3',true,false)"
semear "insert into contatos_whatsapp (id, telefone_e164, verificado, verificado_em, consentimento, consentimento_em, opt_out) values ('$CWX','+5511955550001',true,now(),true,now(),false),('$CWY','+5511955550002',true,now(),true,now(),false)"
semear "insert into comunicacao_contatos_empresa (id, organizacao_id, nome, telefone_e164, tipo, contato_whatsapp_id, whatsapp_status, whatsapp_validado_em, ativo) values ('$CE1X','$P1','X em P1','+5511955550001','principal','$CWX','VALIDADO',now(),true),('$CE2X','$P2','X em P2','+5511955550001','principal','$CWX','VALIDADO',now(),true),('$CE1Y','$P1','Y em P1','+5511955550002','secundario','$CWY','VALIDADO',now(),true)"
semear "insert into comunicacao_destinatario_categorias (contato_empresa_id, organizacao_id, categoria, habilitado) select id, organizacao_id, 'pendencia_d1', true from comunicacao_contatos_empresa where id in ('$CE1X','$CE2X','$CE1Y')"
semear "set session_replication_role = replica; insert into comunicacao_mensagens (id, organizacao_id, contato_empresa_id, tipo, conteudo, idempotency_key, disponivel_em, status, direcao) select gen_random_uuid(), organizacao_id, id, 'dashboard_ifood_d1', 'sintetico', 'sint139-'||id, now() + interval '1 hour', 'SCHEDULED', 'saida' from comunicacao_contatos_empresa where id in ('$CE1X','$CE2X','$CE1Y')"
FILA0="$(q "select md5(string_agg(id::text||status, ',' order by id)) from comunicacao_mensagens where idempotency_key not like 'sint139-%'")"

# ---------------- 139: gatilho ----------------
aplicar "$M/139_notificacoes_convites_piloto.sql"; chk "139 aplicada sobre a cadeia real" "$?" "0"
aplicar "$M/139_notificacoes_convites_piloto.sql"; chk "reaplicar a 139 é inofensivo" "$?" "0"
chk "gatilho BEFORE INSERT presente, função sem acesso a anon/authenticated" "$(q "select (select count(*) from pg_trigger where tgname='trg_comunicacao_convites_piloto' and not tgisinternal) || '/' || has_function_privilege('anon','comunicacao_convites_piloto_guard()','execute') || '/' || has_function_privilege('authenticated','comunicacao_convites_piloto_guard()','execute')")" "1/false/false"
conv() { local T; T=$(printf '%s' "$RANDOM$RANDOM$(date +%s%N)" | sha256sum | cut -c1-64); sr "insert into comunicacao_convites (token_hash, organizacao_id, unidades_pretendidas, categorias_pretendidas, nome, telefone_cifrado, telefone_hmac, telefone_mascarado, expira_em, simulado) values ('$T', '$1', $2, array['pendencia_d1'], 'T', 'cifrado', '$HX', '+551********01', now() + interval '48 hours', true) returning id" | head -1; }
cfg() { q "delete from comunicacao_configuracoes where chave='convites_unidades_piloto'; $1" >/dev/null; }
ARR() { echo "array['$1']::uuid[]"; }

cfg ""; chk "chave AUSENTE: sem restrição (o backend decide)" "$(conv $P1 "$(ARR $U2)" | grep -c -E '^[0-9a-f-]{36}$')" "1"
cfg "insert into comunicacao_configuracoes (chave, valor) values ('convites_unidades_piloto', '[\"$U1\"]')"
chk "piloto [U1]: convite para U1 passa" "$(conv $P1 "$(ARR $U1)" | grep -c -E '^[0-9a-f-]{36}$')" "1"
chk "piloto [U1]: convite para U2 (outra unidade) recusado" "$(conv $P1 "$(ARR $U2)" | grep -c 'CONVITE_UNIDADE_FORA_DO_PILOTO')" "1"
chk "piloto [U1]: convite misto U1+U2 recusado" "$(conv $P1 "array['$U1','$U2']::uuid[]" | grep -c 'CONVITE_UNIDADE_FORA_DO_PILOTO')" "1"
cfg "insert into comunicacao_configuracoes (chave, valor) values ('convites_unidades_piloto', '[]')"
chk "piloto vazio: NINGUÉM (fail-closed)" "$(conv $P1 "$(ARR $U1)" | grep -c 'CONVITE_UNIDADE_FORA_DO_PILOTO')" "1"
cfg "insert into comunicacao_configuracoes (chave, valor) values ('convites_unidades_piloto', '{\"a\":1}')"
chk "valor que não é array: NINGUÉM" "$(conv $P1 "$(ARR $U1)" | grep -c 'CONVITE_UNIDADE_FORA_DO_PILOTO')" "1"
cfg "insert into comunicacao_configuracoes (chave, valor) values ('convites_unidades_piloto', '[\"$U1\",\"nao-e-uuid\"]')"
chk "elemento que não é uuid: NINGUÉM (nem U1)" "$(conv $P1 "$(ARR $U1)" | grep -c 'CONVITE_UNIDADE_FORA_DO_PILOTO')" "1"
cfg "insert into comunicacao_configuracoes (chave, valor) values ('convites_unidades_piloto', '[\"$U1\", null]')"
chk "elemento null no array: NINGUÉM (antes: <> ALL com NULL deixava passar)" "$(conv $P1 "$(ARR $U2)" | grep -c 'CONVITE_UNIDADE_FORA_DO_PILOTO')" "1"
cfg "insert into comunicacao_configuracoes (chave, valor) values ('convites_unidades_piloto', '[\"$U1\", 7]')"
chk "elemento numérico no array: NINGUÉM" "$(conv $P1 "$(ARR $U1)" | grep -c 'CONVITE_UNIDADE_FORA_DO_PILOTO')" "1"
cfg "insert into comunicacao_configuracoes (chave, valor) values ('convites_unidades_piloto', '[\"$U1\"]')"
ID1="$(conv $P1 "$(ARR $U1)" | head -1)"
chk "UPDATE de convite existente NÃO é barrado (só INSERT)" "$(sr "update comunicacao_convites set status='CANCELADO', cancelado_em=now() where id='$ID1' returning status")" "CANCELADO
UPDATE 1"
chk "anon/authenticated sem acesso à configuração do piloto" "$(como anon "select count(*) from comunicacao_configuracoes" | grep -c 'permission denied')/$(como authenticated "select count(*) from comunicacao_configuracoes" | grep -c 'permission denied')" "1/1"
cfg ""

# ---------------- SAIR: isolamento da revogação ----------------
REV() { sr "select comunicacao_revogar('$HX', array['$CE1X','$CE2X']::uuid[], null, null, '$1', null, null, true, null)::jsonb->>'resultado'"; }
chk "origem inválida é recusada e nada muda" "$(REV 'qualquer')/$(q "select count(*) from comunicacao_consentimentos where contato_empresa_id in ('$CE1X','$CE2X','$CE1Y')")" "ORIGEM_INVALIDA/0"
chk "SAIR do número X revoga nas DUAS empresas que o cadastraram" "$(REV 'palavra_chave_inbound')" "REVOGADO"
chk "categorias do número X desligadas (P1 e P2); a do outro número (Y) intacta" "$(q "select string_agg(habilitado::text, ',' order by contato_empresa_id) from comunicacao_destinatario_categorias where contato_empresa_id in ('$CE1X','$CE2X','$CE1Y')")" "false,false,true"
chk "opt-out só no contato de WhatsApp do número X" "$(q "select string_agg(opt_out::text, ',' order by id) from contatos_whatsapp where id in ('$CWX','$CWY')")" "true,false"
chk "livro-razão: REVOGADO só para os registros do número X, cada um na SUA empresa (sem cruzar empresas)" "$(q "select count(*) filter (where contato_empresa_id='$CE1X' and organizacao_id='$P1') || '/' || count(*) filter (where contato_empresa_id='$CE2X' and organizacao_id='$P2') || '/' || count(*) filter (where contato_empresa_id='$CE1Y') || '/' || count(*) filter (where acao <> 'REVOGADO') from comunicacao_consentimentos where contato_empresa_id in ('$CE1X','$CE2X','$CE1Y')" | awk -F/ '{print ($1>0 && $2>0 ? "ok" : "falta") "/" $3 "/" $4}')" "ok/0/0"
chk "fila: só as mensagens do número X canceladas por REVOGADO_PELO_TITULAR; a do Y segue agendada" "$(q "select string_agg(status||':'||coalesce(erro,''), ',' order by contato_empresa_id) from comunicacao_mensagens where idempotency_key like 'sint139-%'")" "CANCELLED:REVOGADO_PELO_TITULAR,CANCELLED:REVOGADO_PELO_TITULAR,SCHEDULED:"
N1="$(q "select count(*) from comunicacao_consentimentos where contato_empresa_id='$CE1X'")"; REV 'palavra_chave_inbound' >/dev/null
chk "SEM dedupe no banco, repetir o SAIR acrescenta linhas ao livro-razão (por isso o backend confere 'já saiu de tudo' antes)" "$([ "$(q "select count(*) from comunicacao_consentimentos where contato_empresa_id='$CE1X'")" -gt "$N1" ] && echo cresce)" "cresce"
chk "a fila do D-1 que não é sintética ficou idêntica" "$(q "select md5(string_agg(id::text||status, ',' order by id)) from comunicacao_mensagens where idempotency_key not like 'sint139-%'")" "$FILA0"

# ---------------- rollback ----------------
psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d $DB -f "$M/139_rollback.sql" >/dev/null 2>&1; chk "rollback da 139" "$?" "0"
cfg "insert into comunicacao_configuracoes (chave, valor) values ('convites_unidades_piloto', '[]')"
chk "após o rollback o gatilho não existe (convite passa mesmo com piloto vazio)" "$(q "select count(*) from pg_trigger where tgname='trg_comunicacao_convites_piloto'")/$(conv $P1 "$(ARR $U2)" | grep -c -E '^[0-9a-f-]{36}$')" "0/1"
psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d $DB -f "$M/139_rollback.sql" >/dev/null 2>&1; chk "rollback idempotente" "$?" "0"
psql $H -U postgres -X -q -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
echo "== $N_OK ok, $N_F falhas =="; [ "$N_F" = 0 ]
