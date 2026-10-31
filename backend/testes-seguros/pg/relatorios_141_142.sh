#!/bin/bash
# Migrations 141 (fila/auditoria dos relatórios operacionais + resumo semanal) e 142 (EXECUTE de comunicacao_cota_valida) — SOMENTE PostgreSQL LOCAL
# DESCARTÁVEL (cluster com MARCADOR_DESCARTAVEL, 127.0.0.1:54321), cadeia da main (banco `nt_branch`). Uso: PG_CLUSTER_DIR=<cluster> bash relatorios_141_142.sh
set -u
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR}"; H="-h 127.0.0.1 -p 54321"; DB=r141
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
N_OK=0; N_F=0; ok() { echo "OK    $1"; N_OK=$((N_OK+1)); }; bad() { echo "FALHA $1"; N_F=$((N_F+1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — esperado [$3], obtido [$2]"; fi; }
[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo "RECUSADO: sem MARCADOR_DESCARTAVEL"; exit 2; }
psql $H -U postgres -tAc "show data_directory" | grep -qF "$CLUSTER" || { echo "RECUSADO: servidor não é o cluster descartável"; exit 2; }
q() { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d $DB -c "$1" 2>&1; }
semear() { local r; r="$(q "$1")"; case "$r" in *ERROR*|*ERRO*) echo "SEED FALHOU: $r"; exit 2;; esac; }
psql $H -U postgres -X -q -d postgres -c "drop database if exists $DB" -c "create database $DB owner dono_sim template nt_branch" >/dev/null 2>&1 || { echo "não consegui clonar nt_branch"; exit 2; }
APLICA() { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -q -v ON_ERROR_STOP=1 -d $DB -f "$RAIZ/database/migrations/$1" 2>&1 | grep -i "error\|erro" | head -3; }
U() { printf '00000000-0000-4000-8000-%012d' "$1"; }

# ---------- 142 ----------
chk "antes da 142 o service_role NÃO executa comunicacao_cota_valida" "$(q "select has_function_privilege('service_role','comunicacao_cota_valida(jsonb)','execute')")" "f"
chk "antes da 142 o insert em comunicacao_categorias pelo service_role falha (o defeito)" "$(PGOPTIONS='-c lc_messages=C' psql $H -U postgres -X -tA -d $DB -c "set role service_role; insert into comunicacao_categorias (codigo, rotulo, tipo_alerta, ativo) values ('t_probe','probe','t_probe',false)" 2>&1 | grep -c 'permission denied for function')" "1"
chk "142 aplica sem erro" "$(APLICA 142_cota_valida_privilegio.sql)" ""
chk "142 idempotente" "$(APLICA 142_cota_valida_privilegio.sql)" ""
chk "depois: service_role executa; anon/authenticated/public NÃO" "$(q "select has_function_privilege('service_role',p.oid,'execute')::text||has_function_privilege('anon',p.oid,'execute')::text||has_function_privilege('authenticated',p.oid,'execute')::text from pg_proc p where proname='comunicacao_cota_valida'")" "truefalsefalse"
chk "depois da 142 o insert de categoria pelo service_role funciona" "$(PGOPTIONS='-c lc_messages=C' psql $H -U postgres -X -tA -d $DB -c "set role service_role; insert into comunicacao_categorias (codigo, rotulo, tipo_alerta, ativo) values ('t_probe','probe','t_probe',false) returning codigo" 2>&1 | grep -c t_probe)" "1"
q "delete from comunicacao_categorias where codigo='t_probe'" >/dev/null

# ---------- 141 ----------
chk "141 aplica sem erro" "$(APLICA 141_operacional_relatorios_envio.sql)" ""
chk "141 idempotente" "$(APLICA 141_operacional_relatorios_envio.sql)" ""
chk "RLS ligado nas duas tabelas e sem policy" "$(q "select count(*) filter (where relrowsecurity)||'/'||(select count(*) from pg_policies where tablename in ('operacional_resumos_semanais','operacional_relatorios_envios')) from pg_class where relname in ('operacional_resumos_semanais','operacional_relatorios_envios')")" "2/0"
chk "anon/authenticated sem NENHUM privilégio; service_role sem DELETE/UPDATE além de organizacao_id" "$(q "select (select count(*) from information_schema.role_table_grants where table_name in ('operacional_resumos_semanais','operacional_relatorios_envios') and grantee in ('anon','authenticated','PUBLIC'))||'/'||(select count(*) from information_schema.role_table_grants where table_name in ('operacional_resumos_semanais','operacional_relatorios_envios') and grantee='service_role' and privilege_type in ('DELETE','TRUNCATE'))")" "0/0"
chk "RPCs só para service_role" "$(q "select string_agg(proname||':'||has_function_privilege('anon',p.oid,'execute')::text||has_function_privilege('service_role',p.oid,'execute')::text, ',' order by proname) from pg_proc p where proname like 'operacional_relatorio_%'")" "operacional_relatorio_finalizar:falsetrue,operacional_relatorio_reservar:falsetrue"

O=$(U 9601); UN=$(U 9602); O2=$(U 9603); CE=$(U 9604); CE2=$(U 9605); FE=$(U 9606)
semear "insert into organizacoes (id, nome, status) values ('$O','[R141] O','ativa'),('$O2','[R141] O2','ativa')"
semear "insert into unidades (id, organizacao_id, nome) values ('$UN','$O','[R141] U')"
semear "insert into comunicacao_contatos_empresa (id, organizacao_id, nome, telefone_e164, tipo, whatsapp_status, whatsapp_validado_em, ativo) values ('$CE','$O','d1','+5511966660001','principal','VALIDADO',now(),true),('$CE2','$O','d2','+5511966660002','operacional','VALIDADO',now(),true)"
semear "insert into operacional_fechamentos (id, organizacao_id, unidade_id, competencia, versao, status, execucao_id, regra_versao, fuso, fuso_origem, origem, fonte, cobertura, indicadores, diagnostico, pendencias, hash_conteudo) values ('$FE','$O','$UN','2026-10-30',1,'CONSOLIDADO','$(U 1)',1,'America/Sao_Paulo','padrao_plataforma','manual','{}','{}','{}','{}','[]','h1')"
ENQ() { q "insert into operacional_relatorios_envios (id, organizacao_id, unidade_id, tipo, categoria, referencia, fechamento_id, contato_empresa_id, chave_idempotencia, mensagem, tamanho, expira_em, disponivel_em) values ('$(U $1)','$O','$UN','diario','fechamento_operacional_diario','2026-10-30','$FE','${2:-$CE}','chave-$1','msg',3, now() + interval '${3:-6 hours}', now() - interval '1 minute')"; }
chk "enfileirar 1 item" "$(ENQ 9701 | head -c 40)" "INSERT 0 1"
chk "chave de idempotência é ÚNICA (duplicado barrado)" "$(ENQ 9702 | grep -c 'duplicate key')" "0"
chk "mesma chave de novo = erro de unicidade" "$(q "insert into operacional_relatorios_envios (organizacao_id, unidade_id, tipo, categoria, referencia, fechamento_id, contato_empresa_id, chave_idempotencia, mensagem, tamanho, expira_em) values ('$O','$UN','diario','fechamento_operacional_diario','2026-10-30','$FE','$CE','chave-9701','m',1, now()+interval '1 hour')" | grep -c 'duplicate key')" "1"
chk "tenant: unidade de OUTRA empresa é barrada pelo trigger" "$(q "insert into operacional_relatorios_envios (organizacao_id, unidade_id, tipo, categoria, referencia, fechamento_id, contato_empresa_id, chave_idempotencia, mensagem, tamanho, expira_em) values ('$O2','$UN','diario','fechamento_operacional_diario','2026-10-30','$FE','$CE','chave-x','m',1, now()+interval '1 hour')" | grep -c 'não pertence')" "1"
chk "origem: diário sem fechamento e semanal com fechamento são barrados (CHECK)" "$(q "insert into operacional_relatorios_envios (organizacao_id, unidade_id, tipo, categoria, referencia, contato_empresa_id, chave_idempotencia, mensagem, tamanho, expira_em) values ('$O','$UN','diario','fechamento_operacional_diario','2026-10-30','$CE','chave-y','m',1, now()+interval '1 hour')" | grep -c 'ck_operacional_relatorio_origem')" "1"

RES() { q "select operacional_relatorio_reservar('$(U $1)', '${2:-w1}', 60, date_trunc('day', now()), ${3:-null})::jsonb->>'resultado'"; }
FIN() { q "select operacional_relatorio_finalizar('$(U $1)', '${2:-w1}', '$3', ${4:-null}, ${5:-null}, ${6:-null})::jsonb->>'resultado'"; }
chk "reservar: PENDENTE → INICIADO" "$(RES 9701)" "INICIADO"
chk "reservar de novo (outro worker): POSSE_PERDIDA — nunca envia duas vezes" "$(RES 9701 w2)" "POSSE_PERDIDA"
chk "finalizar com worker errado: POSSE_PERDIDA" "$(FIN 9701 w2 ENVIADO "'wamid.1'")" "POSSE_PERDIDA"
chk "finalizar ENVIADO pelo dono" "$(FIN 9701 w1 ENVIADO "'wamid.1'")" "GRAVADO"
chk "ENVIADO guarda provider id e horário; a posse é limpa" "$(q "select provider_message_id||'/'||(enviado_em is not null)||'/'||(claimed_by is null) from operacional_relatorios_envios where id='$(U 9701)'")" "wamid.1/true/true"
chk "item já ENVIADO não reserva de novo" "$(RES 9701)" "POSSE_PERDIDA"

ENQ 9710 $CE >/dev/null; ENQ 9711 $CE >/dev/null; ENQ 9712 $CE2 >/dev/null
chk "cota diária por destinatário/categoria (limite 1): o 2º do MESMO destinatário é COTA_DIA" "$(RES 9710 w1 1)" "COTA_DIA"
chk "o OUTRO destinatário não é afetado pela cota" "$(RES 9712 w1 1)" "INICIADO"
ENQ 9720 $CE "-1 minute" >/dev/null
chk "item vencido: EXPIRADO, nunca enviado" "$(RES 9720)" "EXPIRADO"
q "insert into operacional_relatorios_envios (id, organizacao_id, unidade_id, tipo, categoria, referencia, fechamento_id, contato_empresa_id, chave_idempotencia, mensagem, tamanho, expira_em, disponivel_em) values ('$(U 9730)','$O','$UN','diario','fechamento_operacional_diario','2026-10-30','$FE','$CE','chave-9730','m',1, now()+interval '1 hour', now()+interval '10 minutes')" >/dev/null
chk "item ainda não disponível: AINDA_NAO_DISPONIVEL" "$(RES 9730)" "AINDA_NAO_DISPONIVEL"
ENQ 9740 $CE2 >/dev/null; RES 9740 w1 >/dev/null
chk "RETRY (pré-envio provado) volta a PENDENTE com novo horário" "$(FIN 9740 w1 RETRY null "'pre-envio'" 120)" "GRAVADO"
chk "após RETRY: PENDENTE e indisponível por ~2 min" "$(q "select status||'/'||(disponivel_em > now())||'/'||tentativas from operacional_relatorios_envios where id='$(U 9740)'")" "PENDENTE/true/1"
ENQ 9750 $CE2 >/dev/null; RES 9750 w1 >/dev/null
q "update operacional_relatorios_envios set claim_expira_em = now() - interval '1 second' where id='$(U 9750)'" >/dev/null
chk "posse vencida em ENVIANDO: vira INCERTO (pode ter saído) e NUNCA é reenviada" "$(RES 9750 w2)/$(q "select status from operacional_relatorios_envios where id='$(U 9750)'")" "INCERTO/INCERTO"
ENQ 9760 $CE2 >/dev/null; for i in 1 2 3; do q "update operacional_relatorios_envios set status='PENDENTE', claimed_by=null, claim_expira_em=null, disponivel_em=now()-interval '1 minute' where id='$(U 9760)'" >/dev/null; RES 9760 w1 >/dev/null; FIN 9760 w1 RETRY null "'x'" 1 >/dev/null; done
q "update operacional_relatorios_envios set disponivel_em=now()-interval '1 minute' where id='$(U 9760)'" >/dev/null
chk "tentativas esgotadas (3): FALHOU, não reserva mais" "$(RES 9760)" "FALHOU"
CONC="$(mktemp -d)"; ENQ 9770 $CE2 >/dev/null
for i in 1 2 3 4 5; do ( RES 9770 w$i > "$CONC/$i" ) & done; wait
chk "CONCORRÊNCIA: 5 workers disputam o mesmo item: exatamente 1 INICIADO" "$(cat $CONC/* | grep -c INICIADO)/$(cat $CONC/* | grep -c POSSE_PERDIDA)" "1/4"
rm -rf "$CONC"

# resumo semanal
chk "resumo semanal: insert + mesmo (unidade, semana, hash) não duplica" "$(q "insert into operacional_resumos_semanais (organizacao_id, unidade_id, semana_inicio, status, dias_validos, hash_conteudo, indicadores, mensagem) values ('$O','$UN','2026-10-26','COMPLETA',7,'hash-teste-1','{}','m')" | head -c 10)/$(q "insert into operacional_resumos_semanais (organizacao_id, unidade_id, semana_inicio, status, dias_validos, hash_conteudo, indicadores, mensagem) values ('$O','$UN','2026-10-26','COMPLETA',7,'hash-teste-1','{}','m')" | grep -c 'uq_operacional_resumo_semanal')" "INSERT 0 1/1"
chk "resumo semanal com menos de 5 dias válidos é barrado (CHECK)" "$(q "insert into operacional_resumos_semanais (organizacao_id, unidade_id, semana_inicio, status, dias_validos, hash_conteudo, indicadores, mensagem) values ('$O','$UN','2026-10-19','PARCIAL',4,'hash-teste-2','{}','m')" | grep -c 'dias_validos')" "1"

# transferência de unidade: a função de remapeamento enxerga as tabelas novas e consegue atualizá-las
chk "service_role pode atualizar SÓ organizacao_id (transferência de unidade)" "$(PGOPTIONS='-c lc_messages=C' psql $H -U postgres -X -tA -d $DB -c "select grantee||':'||string_agg(column_name,',') from information_schema.column_privileges where table_name='operacional_relatorios_envios' and privilege_type='UPDATE' and grantee='service_role' group by grantee")" "service_role:organizacao_id"

# ---------- rollback ----------
chk "rollback da 141 sem erro" "$(APLICA 141_rollback.sql)" ""
chk "após o rollback: tabelas e RPCs removidas" "$(q "select (select count(*) from pg_class where relname in ('operacional_resumos_semanais','operacional_relatorios_envios'))||'/'||(select count(*) from pg_proc where proname like 'operacional_relatorio_%')")" "0/0"
chk "reaplicar a 141 depois do rollback funciona" "$(APLICA 141_operacional_relatorios_envio.sql)" ""
chk "rollback da 142 devolve o estado da 135 e a reaplicação restaura" "$(APLICA 142_rollback.sql)$(q "select has_function_privilege('service_role','comunicacao_cota_valida(jsonb)','execute')")$(APLICA 142_cota_valida_privilegio.sql)$(q "select has_function_privilege('service_role','comunicacao_cota_valida(jsonb)','execute')")" "ft"

echo "RESULTADO: $N_OK ok, $N_F falhas"; [ "$N_F" = 0 ]
