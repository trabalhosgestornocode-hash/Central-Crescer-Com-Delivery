#!/bin/bash
# Ensaio da migration 154 (origem do pagamento: conta · origem pendente · pago por terceiro) em banco LOCAL DESCARTÁVEL recém-criado.
# NUNCA toca produção (recusa banco fora de fin20*; exige o marcador do cluster descartável).
#   PG_CLUSTER_DIR="C:/Users/ponte/pg-descartavel" bash backend/testes-seguros/financeiro-2-0/ensaio-154.sh
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
S="$(cd "$(dirname "$0")" && pwd)"; R="$(cd "$S/../../.." && pwd)"; M="$R/database/migrations"
DB=fin20t154; H="-h 127.0.0.1 -p 54321"; FALHAS=0
bash "$S/preparar_banco.sh" "$DB" || { echo "preparar_banco falhou"; exit 1; }
q() { psql $H -U dono_sim -d "$DB" -tA -v ON_ERROR_STOP=1 -c "$1" 2>&1 | tr -d '\r'; }
chk() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (esperado '$3', obtido '$2')"; FALHAS=$((FALHAS+1)); fi; }
u() { printf '00000000-0000-4000-8000-%012d' "$1"; }
O=$(u 1); U=$(u 2); USR=$(u 6); C1=$(u 201); F1=$(u 202); A1=$(u 203); B1=$(u 204); B2=$(u 205); D1=$(u 206); D2=$(u 207)
q "insert into fin_plano_contas(id,organizacao_id,tipo,natureza,nome,papel) values ('$C1','$O','DESPESA','FIXA','BENEFICIOS','despesa_pessoal')" >/dev/null
q "insert into fin_fornecedores(id,organizacao_id,nome) values ('$F1','$O','F')" >/dev/null
q "insert into fin_contas(id,organizacao_id,unidade_id,nome,tipo_conta) values ('$A1','$O','$U','UNICRED','banco')" >/dev/null
q "insert into fin_obrigacoes(id,organizacao_id,unidade_id,fornecedor_id,categoria_id,descricao,competencia,vencimento,valor_original_centavos) values ('$B1','$O','$U','$F1','$C1','Saude','2026-08-01','2026-09-10',8000),('$B2','$O','$U','$F1','$C1','Distribuidora','2026-09-01','2026-09-04',663360)" >/dev/null
q "insert into fin_dividas(id,organizacao_id,unidade_id,natureza,credor) values ('$D1','$O','$U','socio','Francisca')" >/dev/null
# dívida de OUTRA empresa (tenant diferente)
q "insert into fin_dividas(id,organizacao_id,unidade_id,natureza,credor) values ('$D2','$(u 4)','$(u 5)','socio','Outra')" >/dev/null
pag() { q "insert into fin_pagamentos(organizacao_id,unidade_id,obrigacao_id,conta_id,data_pagamento,valor_centavos,provisorio,origem_pagamento,terceiro_nome,divida_id,observacao,criado_por) values ('$O','$U','$1',$2,'2026-09-11',$3,$4,'$5',$6,$7,$8,'$USR') returning id"; }
chk "colunas novas existem" "$(q "select count(*) from information_schema.columns where table_name='fin_pagamentos' and column_name in ('origem_pagamento','terceiro_nome','divida_id')")" "3"
chk "conta_id deixou de ser obrigatória" "$(q "select is_nullable from information_schema.columns where table_name='fin_pagamentos' and column_name='conta_id'")" "YES"
chk "pagamento normal (com conta) continua válido" "$(pag $B2 "'$A1'" 100 false conta null null null | grep -c '^[0-9a-f]\{8\}-')" "1"
chk "origem 'conta' SEM conta é recusada" "$(pag $B1 null 8000 false conta null null null | grep -c 'fin_pag_origem_coerente')" "1"
chk "origem pendente sem fonte escrita é recusada" "$(pag $B1 null 8000 true origem_pendente null null null | grep -c 'fin_pag_origem_documentada')" "1"
chk "origem pendente NÃO pode nascer confirmada (não provisória)" "$(pag $B1 null 8000 false origem_pendente null null "'Apresentacao slide 12: pago em 11/09, conta nao informada'" | grep -c 'fin2_origem_pendente_provisorio')" "1"
PID=$(pag $B1 null 8000 true origem_pendente null null "'Apresentacao slide 12: pago em 11/09, conta nao informada'" | head -1)
chk "origem pendente provisória é aceita (sem conta, sem saída bancária)" "$([ -n "$PID" ] && echo ok)" "ok"
chk "terceiro sem dívida é recusado" "$(pag $B2 null 6000 false terceiro "'Francisca'" null "'Socia pagou com a conta pessoal (DEV-012)'" | grep -c 'fin_pag_origem_coerente')" "1"
chk "terceiro com dívida de OUTRA empresa é recusado" "$(pag $B2 null 6000 false terceiro "'Francisca'" "'$D2'" "'Socia pagou com a conta pessoal (DEV-012)'" | grep -ci 'outro tenant\|violates\|erro')" "1"
TID=$(pag $B2 null 663260 false terceiro "'Francisca (socia)'" "'$D1'" "'Socia pagou com a conta pessoal (DEV-012)'" | head -1)
chk "pago por terceiro com dívida do mesmo tenant é aceito" "$([ -n "$TID" ] && echo ok)" "ok"
chk "terceiro e dívida não mudam" "$(q "update fin_pagamentos set divida_id='$D2' where id='$TID'" | grep -c 'fin_campo_imutavel\|outro tenant')" "1"
chk "origem só evolui de origem_pendente para conta (terceiro→conta recusado)" "$(q "update fin_pagamentos set origem_pagamento='conta', conta_id='$A1', terceiro_nome=null, divida_id=null where id='$TID'" | grep -c 'fin_campo_imutavel')" "1"
# conciliação: nenhum vínculo com extrato para pagamento sem conta
q "insert into fin_lancamentos(id,organizacao_id,unidade_id,conta_id,categoria_id,sentido,valor_centavos,data_movimento,status,descricao,origem) values ('$(u 300)','$O','$U','$A1','$C1','saida',8000,'2026-09-11','realizado','Saida teste','manual')" | grep -q . || true
q "insert into fin_lancamentos(id,organizacao_id,unidade_id,conta_id,categoria_id,sentido,valor_centavos,data_movimento,status,descricao,origem) values ('$(u 301)','$O','$U','$A1','$C1','saida',663260,'2026-09-05','realizado','Saida teste 2','manual')" >/dev/null
chk "conciliar com extrato pagamento de origem pendente é recusado" "$(q "insert into fin_conciliacao_saidas(organizacao_id,unidade_id,grupo,pagamento_id,lancamento_id,valor_alocado_centavos,status,regra) values ('$O','$U','$(u 400)','$PID','$(u 300)',8000,'sugerido','manual')" | grep -c 'fin2_pagamento_sem_saida_bancaria')" "1"
chk "conciliar com extrato pagamento por terceiro é recusado" "$(q "insert into fin_conciliacao_saidas(organizacao_id,unidade_id,grupo,pagamento_id,lancamento_id,valor_alocado_centavos,status,regra) values ('$O','$U','$(u 401)','$TID','$(u 301)',663260,'sugerido','manual')" | grep -c 'fin2_pagamento_sem_saida_bancaria')" "1"
# resolução da origem pendente (uma vez)
chk "informar a conta de saída resolve a origem pendente" "$(q "update fin_pagamentos set origem_pagamento='conta', conta_id='$A1' where id='$PID' returning origem_pagamento" | head -1)" "conta"
chk "depois de resolvida, não volta a pendente" "$(q "update fin_pagamentos set origem_pagamento='origem_pendente', conta_id=null where id='$PID'" | grep -c 'fin_campo_imutavel\|fin_pag_origem_coerente')" "1"
psql $H -U dono_sim -d "$DB" -v ON_ERROR_STOP=1 -q -f "$M/154_financeiro_2_pagamento_origem.sql" 2>&1 | grep -v NOTICE | head -2; chk "reaplicar é idempotente" "${PIPESTATUS[0]}" "0"
chk "rollback RECUSA com pagamento por terceiro" "$(psql $H -U dono_sim -d "$DB" -v ON_ERROR_STOP=1 -q -f "$M/154_rollback.sql" 2>&1 | grep -c 'ROLLBACK 154 RECUSADO')" "1"
psql $H -U postgres -d "$DB" -q -c "set session_replication_role = replica; delete from fin_pagamentos where origem_pagamento <> 'conta'" >/dev/null 2>&1
psql $H -U dono_sim -d "$DB" -v ON_ERROR_STOP=1 -q -f "$M/154_rollback.sql" >/dev/null 2>&1
chk "rollback sem esses pagamentos devolve conta_id obrigatória" "$(q "select is_nullable from information_schema.columns where table_name='fin_pagamentos' and column_name='conta_id'")" "NO"
chk "rollback remove as colunas novas" "$(q "select count(*) from information_schema.columns where table_name='fin_pagamentos' and column_name in ('origem_pagamento','terceiro_nome','divida_id')")" "0"
echo "---"; [ "$FALHAS" = 0 ] && echo "ENSAIO 154: tudo certo" || echo "ENSAIO 154: $FALHAS falha(s)"; exit $FALHAS
