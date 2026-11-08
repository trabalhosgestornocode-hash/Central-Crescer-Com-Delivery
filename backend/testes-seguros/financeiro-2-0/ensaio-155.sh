#!/bin/bash
# Ensaio da migration 155 (conciliação de UMA saída com 2–3 entradas) em banco LOCAL DESCARTÁVEL recém-criado.
# NUNCA toca produção (recusa banco fora de fin20*; exige o marcador do cluster descartável).
#   PG_CLUSTER_DIR="C:/Users/ponte/pg-descartavel" bash backend/testes-seguros/financeiro-2-0/ensaio-155.sh
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
S="$(cd "$(dirname "$0")" && pwd)"; R="$(cd "$S/../../.." && pwd)"; M="$R/database/migrations"
DB=fin20t155; H="-h 127.0.0.1 -p 54321"; FALHAS=0
bash "$S/preparar_banco.sh" "$DB" || { echo "preparar_banco falhou"; exit 1; }
q() { psql $H -U dono_sim -d "$DB" -tA -v ON_ERROR_STOP=1 -c "$1" 2>&1 | tr -d '\r'; }
chk() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (esperado '$3', obtido '$2')"; FALHAS=$((FALHAS+1)); fi; }
u() { printf '00000000-0000-4000-8000-%012d' "$1"; }
O=$(u 1); U=$(u 2); USR=$(u 6); O2=$(u 4); U2=$(u 5)
CT=$(u 201); STONE=$(u 202); UNI=$(u 203); OUTRA=$(u 204)
q "insert into fin_plano_contas(id,organizacao_id,tipo,natureza,nome,papel) values ('$CT','$O','DESPESA','FIXA','TRANSFERENCIA ENTRE CONTAS','transferencia')" >/dev/null
q "insert into fin_contas(id,organizacao_id,unidade_id,nome,tipo_conta) values ('$STONE','$O','$U','STONE','banco'),('$UNI','$O','$U','UNICRED','banco')" >/dev/null
lanc() { # id conta sentido valor [org unidade]
  q "insert into fin_lancamentos(id,organizacao_id,unidade_id,conta_id,categoria_id,sentido,valor_centavos,data_movimento,status,descricao,origem,classificacao_pendente) values ('$1','${5:-$O}','${6:-$U}','$2','$CT','$3',$4,'2026-09-10','realizado','Transferencia Stone Unicred','manual',true)"; }
SAI=$(u 300); E1=$(u 301); E2=$(u 302); E3=$(u 303); E4=$(u 304); EX=$(u 305); SAI2=$(u 306)
lanc $SAI $STONE saida 100000 >/dev/null; lanc $E1 $UNI entrada 60000 >/dev/null; lanc $E2 $UNI entrada 25000 >/dev/null; lanc $E3 $UNI entrada 15000 >/dev/null; lanc $E4 $UNI entrada 5000 >/dev/null
lanc $SAI2 $STONE saida 50000 >/dev/null; lanc $EX $UNI entrada 50000 >/dev/null
vinc() { q "select fin_vincular_transferencia_multipla('$O','$U','$USR','$1',$2,'$3')"; }
JUST="Stone creditou a Unicred em tres parcelas, conferido no extrato"

chk "tabelas e funções da 155 existem" "$(q "select count(*) from pg_class where relname in ('fin_transferencias_multiplas','fin_transferencias_multiplas_entradas')")/$(q "select count(*) from pg_proc where proname in ('fin_vincular_transferencia_multipla','fin_desvincular_transferencia_multipla')")" "2/2"
chk "somas diferentes são recusadas (R\$ 850 x R\$ 1.000)" "$(vinc $SAI "array['$E1','$E2']::uuid[]" "$JUST" | grep -c 'fin_multipla_soma')" "1"
chk "uma única entrada é recusada (use o vínculo 1:1)" "$(vinc $SAI "array['$E1']::uuid[]" "$JUST" | grep -c 'de 2 a 3')" "1"
chk "quatro entradas são recusadas" "$(vinc $SAI "array['$E1','$E2','$E3','$E4']::uuid[]" "$JUST" | grep -c 'de 2 a 3')" "1"
chk "entrada repetida é recusada" "$(vinc $SAI "array['$E1','$E1','$E2']::uuid[]" "$JUST" | grep -c 'repetidas')" "1"
chk "justificativa curta é recusada" "$(vinc $SAI "array['$E1','$E2','$E3']::uuid[]" "curta" | grep -c 'justificativa_obrigatoria')" "1"
lanc $OUTRA $STONE entrada 15000 "$O2" "$U2" >/dev/null 2>&1
chk "entrada de OUTRO tenant é recusada" "$(vinc $SAI "array['$E1','$E2','$OUTRA']::uuid[]" "$JUST" | grep -ci 'inexistente neste tenant\|violates\|erro')" "1"
q "insert into fin_lancamentos(id,organizacao_id,unidade_id,conta_id,categoria_id,sentido,valor_centavos,data_movimento,status,descricao,origem) values ('$(u 307)','$O','$U','$STONE','$CT','entrada',15000,'2026-09-10','realizado','mesma conta','manual')" >/dev/null
chk "entrada na MESMA conta da saída é recusada" "$(vinc $SAI "array['$E1','$E2','$(u 307)']::uuid[]" "$JUST" | grep -c 'mesma conta')" "1"
MID=$(vinc $SAI "array['$E1','$E2','$E3']::uuid[]" "$JUST" | head -1)
chk "1 saída + 3 entradas com soma exata (R\$ 1.000 = 600 + 250 + 150) é vinculada" "$([ -n "$MID" ] && echo ok)" "ok"
chk "vínculo guarda quem aprovou, a justificativa e o valor" "$(q "select aprovado_por::text||'|'||valor_centavos||'|'||quantidade_entradas from fin_transferencias_multiplas where id='$MID'")" "$USR|100000|3"
chk "as 3 entradas ficam registradas com seus valores" "$(q "select string_agg(valor_centavos::text, ',' order by valor_centavos) from fin_transferencias_multiplas_entradas where multipla_id='$MID'")" "15000,25000,60000"
chk "as 4 pernas deixam de ser pendentes" "$(q "select count(*) from fin_lancamentos where id in ('$SAI','$E1','$E2','$E3') and classificacao_pendente=false")" "4"
chk "a saída já vinculada não pode ser vinculada de novo" "$(vinc $SAI "array['$E4','$EX']::uuid[]" "$JUST" | grep -c 'fin_multipla')" "1"
chk "entrada já vinculada não serve a outro vínculo" "$(vinc $SAI2 "array['$E1','$EX']::uuid[]" "$JUST" | grep -ci 'fin_multipla\|soma')" "1"
chk "vínculo 1:1 com perna do 1:N é recusado" "$(q "insert into fin_transferencias(organizacao_id,unidade_id,lancamento_saida_id,lancamento_entrada_id) values ('$O','$U','$SAI','$EX')" | grep -c 'fin_multipla_conflito')" "1"
chk "valor de lançamento vinculado não muda" "$(q "update fin_lancamentos set valor_centavos=1 where id='$E1'" | grep -c 'fin_transferencia_multipla')" "1"
chk "status (cancelar) de lançamento vinculado é recusado" "$(q "update fin_lancamentos set status='cancelado' where id='$SAI'" | grep -c 'fin_transferencia_multipla')" "1"
chk "campos livres (descrição) continuam editáveis" "$(q "update fin_lancamentos set descricao='ajuste de texto' where id='$E1'" | grep -c 'UPDATE 1\|^$')" "1"
chk "vínculo não pode ser editado" "$(q "update fin_transferencias_multiplas set justificativa='alterada alterada' where id='$MID'" | grep -c 'fin_multipla_imutavel')" "1"
chk "service_role NÃO escreve direto nas tabelas novas" "$(q "select has_table_privilege('service_role','fin_transferencias_multiplas','insert,update,delete') or has_table_privilege('service_role','fin_transferencias_multiplas_entradas','insert,update,delete')")" "f"
chk "anon não lê as tabelas novas" "$(q "select has_table_privilege('anon','fin_transferencias_multiplas','select')")" "f"
chk "tabelas novas estão na guarda de transferência de unidade" "$(q "select 'fin_transferencias_multiplas'=any(gestao_financeira_tabelas_da_unidade()) and 'fin_transferencias_multiplas_entradas'=any(gestao_financeira_tabelas_da_unidade())")" "t"
chk "auditoria registra a criação do vínculo e das entradas" "$(q "select count(*) from fin_auditoria where entidade in ('fin_transferencias_multiplas','fin_transferencias_multiplas_entradas') and acao like '%insert'")" "4"
chk "desfazer SEM motivo é recusado" "$(q "select fin_desvincular_transferencia_multipla('$O','$U','$USR','$MID','curto')" | grep -c 'motivo_obrigatorio')" "1"
chk "desfazer em OUTRO tenant não encontra o vínculo" "$(q "select fin_desvincular_transferencia_multipla('$O2','$U2','$USR','$MID','motivo com mais de dez caracteres')")" "f"
chk "desfazer COM motivo funciona" "$(q "select fin_desvincular_transferencia_multipla('$O','$U','$USR','$MID','Vinculo feito com as entradas erradas')")" "t"
chk "após desfazer: vínculo e entradas removidos" "$(q "select (select count(*) from fin_transferencias_multiplas)+(select count(*) from fin_transferencias_multiplas_entradas)")" "0"
chk "após desfazer: as 4 pernas continuam ativas e voltam a pendentes, motivo na nota" "$(q "select count(*) from fin_lancamentos where id in ('$SAI','$E1','$E2','$E3') and status='realizado' and classificacao_pendente=true and nota_revisao like '%Vinculo feito com as entradas erradas%'")" "4"
chk "a trilha preserva a remoção" "$(q "select count(*) from fin_auditoria where entidade='fin_transferencias_multiplas' and acao like '%delete'")" "1"
MID2=$(vinc $SAI "array['$E1','$E2','$E3']::uuid[]" "$JUST" | head -1)
chk "pode vincular de novo depois de desfazer" "$([ -n "$MID2" ] && echo ok)" "ok"
psql $H -U postgres -d "$DB" -tA -c "set session_replication_role=replica; update fin_periodos set status='fechado' where unidade_id='$U' and mes='2026-09-01'" >/dev/null 2>&1   # simula o fechamento (a função real exige versão/fingerprint)
chk "período fechado impede desfazer" "$(q "select fin_desvincular_transferencia_multipla('$O','$U','$USR','$MID2','Tentativa em periodo fechado ok')" | grep -ci 'fechado')" "1"
echo "---"; [ $FALHAS -eq 0 ] && echo "ENSAIO 155: TUDO OK" || echo "ENSAIO 155: $FALHAS FALHA(S)"; exit $FALHAS
