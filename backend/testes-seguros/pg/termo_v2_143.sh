#!/bin/bash
# Migration 143 (termo v2 RASCUNHO + categorias dos relatórios selecionáveis) — SOMENTE PostgreSQL LOCAL DESCARTÁVEL (cluster com MARCADOR_DESCARTAVEL, banco `nt_branch`).
# Uso: PG_CLUSTER_DIR=<cluster> bash termo_v2_143.sh
set -u
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR}"; H="-h 127.0.0.1 -p 54321"; DB=t143
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
N_OK=0; N_F=0; ok() { echo "OK    $1"; N_OK=$((N_OK+1)); }; bad() { echo "FALHA $1"; N_F=$((N_F+1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — esperado [$3], obtido [$2]"; fi; }
[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo "RECUSADO: sem MARCADOR_DESCARTAVEL"; exit 2; }
psql $H -U postgres -tAc "show data_directory" | grep -qF "$CLUSTER" || { echo "RECUSADO: servidor não é o cluster descartável"; exit 2; }
q() { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d $DB -c "$1" 2>&1; }
psql $H -U postgres -X -q -d postgres -c "drop database if exists $DB" -c "create database $DB owner dono_sim template nt_branch" >/dev/null 2>&1 || { echo "não consegui clonar nt_branch"; exit 2; }
APLICA() { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -q -v ON_ERROR_STOP=1 -d $DB -f "$RAIZ/database/migrations/$1" 2>&1 | grep -i "error\|erro" | head -3; }
D1="select md5(to_jsonb(c)::text) from comunicacao_categorias c where codigo='pendencia_d1'"
D1_ANTES="$(q "$D1")"; V1_ANTES="$(q "select md5(to_jsonb(t)::text) from comunicacao_termos t where versao=1")"
CONT_ANTES="$(q "select (select count(*) from comunicacao_consentimentos)||'/'||(select count(*) from comunicacao_destinatario_escopos)||'/'||(select count(*) from comunicacao_convites)")"
chk "antes: termo vigente é a v1 (rascunho) e os relatórios NÃO são selecionáveis" "$(q "select (select max(versao) from comunicacao_termos)||'/'||(select string_agg(codigo||':'||estado, ',' order by codigo) from comunicacao_categorias where codigo in ('fechamento_operacional_diario','resumo_semanal'))")" "1/fechamento_operacional_diario:SIMULACAO,resumo_semanal:EM_BREVE"
chk "143 aplica sem erro" "$(APLICA 143_termo_v2_rascunho_e_categorias_relatorios.sql)" ""
chk "143 idempotente" "$(APLICA 143_termo_v2_rascunho_e_categorias_relatorios.sql)" ""
chk "termo v2 inserido como RASCUNHO e vigente (maior versão); hash = sha256 do texto" "$(q "select versao||'/'||rascunho||'/'||(hash = encode(sha256(convert_to(texto,'UTF8')),'hex'))::text from comunicacao_termos where versao=2")" "2/true/true"
chk "a v1 permanece intacta no histórico" "$(q "select md5(to_jsonb(t)::text) from comunicacao_termos t where versao=1")" "$V1_ANTES"
chk "o texto da v2 é o escolhido: título, categorias, OTP, cancelamento e marcador jurídico pendente (sem CNPJ inventado)" "$(q "select (texto like 'Autoriza%Notifica%Crescer com Delivery%')::text||(texto like '%- Relat%rio Operacional Di%rio.%')::text||(texto like '%- Resumo Operacional Semanal.%')::text||(texto like '%c%digo de seguran%a%')::text||(texto like '%[PENDENTE DE VERIFICA%JUR%DICA: identifica%o da empresa respons%vel e contato de privacidade]%')::text||(texto !~ '[0-9]{2}[.][0-9]{3}[.][0-9]{3}/')::text from comunicacao_termos where versao=2")" "truetruetruetruetruetrue"
chk "categorias dos relatórios: rótulos novos, ATIVA/baileys e ativo=FALSE (invisíveis ao resolvedor do D-1)" "$(q "select string_agg(codigo||':'||rotulo||':'||estado||':'||transporte||':'||ativo::text, '|' order by codigo) from comunicacao_categorias where codigo in ('fechamento_operacional_diario','resumo_semanal')")" "fechamento_operacional_diario:Relatório Operacional Diário:ATIVA:baileys:false|resumo_semanal:Resumo Operacional Semanal:ATIVA:baileys:false"
chk "a categoria do D-1 (pendencia_d1) NÃO mudou" "$(q "$D1")" "$D1_ANTES"
chk "a 143 não cria consentimento, escopo nem convite (contagens iguais às de antes)" "$(q "select (select count(*) from comunicacao_consentimentos)||'/'||(select count(*) from comunicacao_destinatario_escopos)||'/'||(select count(*) from comunicacao_convites)")" "$CONT_ANTES"
chk "a v2 é imutável (update e delete recusados)" "$(q "update comunicacao_termos set rascunho=false where versao=2" | grep -c 'imutável')$(q "delete from comunicacao_termos where versao=2" | grep -c 'imutável')" "11"
chk "rollback restaura as categorias (a v2 permanece, rascunho)" "$(APLICA 143_rollback.sql)$(q "select (select string_agg(codigo||':'||estado||':'||transporte, ',' order by codigo) from comunicacao_categorias where codigo in ('fechamento_operacional_diario','resumo_semanal'))||'/'||(select rascunho::text from comunicacao_termos where versao=2)")" "fechamento_operacional_diario:SIMULACAO:noop,resumo_semanal:EM_BREVE:noop/true"
chk "D-1 intacto depois do rollback" "$(q "$D1")" "$D1_ANTES"
chk "reaplicar a 143 depois do rollback" "$(APLICA 143_termo_v2_rascunho_e_categorias_relatorios.sql)" ""
echo "RESULTADO: $N_OK ok, $N_F falhas"; [ "$N_F" = 0 ]
