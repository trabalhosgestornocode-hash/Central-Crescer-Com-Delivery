#!/bin/bash
# Ensaio da migration 153 (faturamento por canal e ajustes) em banco LOCAL DESCARTÁVEL recém-criado: aplica 120→153, confere privilégios,
# constraints, travas e o rollback. NUNCA toca produção (recusa banco fora de fin20*; exige o marcador do cluster descartável).
#   PG_CLUSTER_DIR=~/pg-descartavel bash backend/testes-seguros/financeiro-2-0/ensaio-153.sh
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
S="$(cd "$(dirname "$0")" && pwd)"; R="$(cd "$S/../../.." && pwd)"; M="$R/database/migrations"
DB=fin20t153; H="-h 127.0.0.1 -p 54321"; FALHAS=0
bash "$S/preparar_banco.sh" "$DB" || { echo "preparar_banco falhou"; exit 1; }
q() { psql $H -U dono_sim -d "$DB" -tA -v ON_ERROR_STOP=1 -c "$1" 2>&1; }
p() { psql $H -U postgres -d "$DB" -tA -c "$1" 2>&1; }
chk() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (esperado '$3', obtido '$2')"; FALHAS=$((FALHAS+1)); fi; }
u() { printf '00000000-0000-4000-8000-%012d' "$1"; }
O=$(u 1); U=$(u 2); USR=$(u 6)
chk "153 aplicada (tabelas existem)" "$(p "select count(*) from pg_class where relname in ('fin_vendas_canal','fin_vendas_ajustes')")" "2"
chk "RLS ligada nas duas" "$(p "select count(*) from pg_class where relname in ('fin_vendas_canal','fin_vendas_ajustes') and relrowsecurity")" "2"
chk "nenhuma policy" "$(p "select count(*) from pg_policies where tablename in ('fin_vendas_canal','fin_vendas_ajustes')")" "0"
chk "anon não lê" "$(p "select has_table_privilege('anon','public.fin_vendas_canal','select')")" "f"
chk "authenticated não lê" "$(p "select has_table_privilege('authenticated','public.fin_vendas_ajustes','select')")" "f"
chk "service_role sem DELETE" "$(p "select has_table_privilege('service_role','public.fin_vendas_canal','delete')")" "f"
chk "entra na guarda de transferência de unidades" "$(p "select 'fin_vendas_canal' = any(public.gestao_financeira_tabelas_da_unidade()) and 'fin_vendas_ajustes' = any(public.gestao_financeira_tabelas_da_unidade())")" "t"
ins() { q "insert into fin_vendas_canal(organizacao_id,unidade_id,competencia,canal,valor_painel_centavos,valor_gerencial_centavos,fonte,criado_por) values ('$O','$U','$1','$2',$3,$4,'ensaio','$USR') returning id"; }
ID1=$(ins 2026-09-01 'Balcao' 600000 600000 | head -1 | tr -d '')
chk "insere canal válido" "$([ -n "$ID1" ] && echo ok)" "ok"
chk "um canal ativo por mês (duplicata recusada)" "$(ins 2026-09-01 'Balcao' 1 1 | grep -c 'ux_fin_vendas_canal_ativo')" "1"
chk "competência precisa ser dia 1" "$(ins 2026-09-15 'iFood' 1 1 | grep -c 'violates check')" "1"
chk "valor negativo recusado" "$(ins 2026-09-01 'iFood' -5 1 | grep -c 'violates check')" "1"
chk "organização/unidade inconsistentes recusadas pela guarda de escopo" "$(q "insert into fin_vendas_canal(organizacao_id,unidade_id,competencia,canal,valor_painel_centavos,valor_gerencial_centavos,fonte) values ('$(u 4)','$U','2026-09-01','X',1,1,'e')" | grep -ci 'erro\|error')" "1"
chk "cancelar sem motivo recusado" "$(q "update fin_vendas_canal set status='cancelada', cancelado_por='$USR', cancelado_em=now() where id='$ID1'" | grep -c 'fin_vcanal_cancelamento')" "1"
chk "competência não muda (imutável)" "$(q "update fin_vendas_canal set competencia='2026-10-01' where id='$ID1'" | grep -c 'fin_campo_imutavel')" "1"
AJ=$(q "insert into fin_vendas_ajustes(organizacao_id,unidade_id,competencia,canal,tipo,valor_centavos,descricao,criado_por) values ('$O','$U','2026-09-01','iFood','estimativa',-50000,'Taxa de entrega e descontos (estimado)','$USR') returning id" | head -1 | tr -d '')
chk "ajuste nasce estimado" "$(p "select estado from fin_vendas_ajustes where id='$AJ'")" "estimado"
chk "ajuste com valor zero recusado" "$(q "insert into fin_vendas_ajustes(organizacao_id,unidade_id,competencia,canal,tipo,valor_centavos,descricao) values ('$O','$U','2026-09-01','iFood','outro',0,'zero')" | grep -c 'violates check')" "1"
chk "confirmar exige quem/quando (constraint)" "$(q "update fin_vendas_ajustes set estado='confirmado' where id='$AJ'" | grep -c 'fin_vajuste_confirmacao')" "1"
chk "confirma com autor e data" "$(q "update fin_vendas_ajustes set estado='confirmado', confirmado_por='$USR', confirmado_em=now(), evidencia='doc' where id='$AJ' returning estado" | grep -c '^confirmado')" "1"
chk "confirmado não volta a estimado" "$(q "update fin_vendas_ajustes set estado='estimado', confirmado_por=null, confirmado_em=null where id='$AJ'" | grep -c 'ajuste confirmado nao volta')" "1"
chk "trilha de auditoria gravou" "$([ "$(p "select count(*) from fin_auditoria where entidade in ('fin_vendas_canal','fin_vendas_ajustes')")" -ge 3 ] && echo ok)" "ok"
psql $H -U dono_sim -d "$DB" -v ON_ERROR_STOP=1 -q -f "$M/153_financeiro_2_vendas_por_canal.sql" 2>&1 | grep -v NOTICE; chk "reaplicar é idempotente" "$?" "1"
chk "rollback RECUSA com dados" "$(psql $H -U dono_sim -d "$DB" -v ON_ERROR_STOP=1 -q -f "$M/153_rollback.sql" 2>&1 | grep -c 'ROLLBACK 153 RECUSADO')" "1"
p "set session_replication_role = replica; delete from fin_vendas_ajustes; delete from fin_vendas_canal" >/dev/null 2>&1
psql $H -U dono_sim -d "$DB" -v ON_ERROR_STOP=1 -q -f "$M/153_rollback.sql" >/dev/null 2>&1
chk "rollback sem dados remove as tabelas" "$(p "select count(*) from pg_class where relname in ('fin_vendas_canal','fin_vendas_ajustes')")" "0"
chk "rollback devolve a lista de unidades da 152" "$(p "select 'fin_vendas_canal' = any(public.gestao_financeira_tabelas_da_unidade())")" "f"
echo "---"; [ "$FALHAS" = 0 ] && echo "ENSAIO 153: tudo certo" || echo "ENSAIO 153: $FALHAS falha(s)"; exit $FALHAS
