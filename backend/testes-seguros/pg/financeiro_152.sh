#!/bin/bash
# Provas da migration 152 (rateios, recebíveis, dívidas) em banco DESCARTÁVEL. Dados 100% sintéticos.
#   PG_CLUSTER_DIR=<cluster> bash backend/testes-seguros/pg/financeiro_152.sh
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
S="$(cd "$(dirname "$0")" && pwd)"; R="$(cd "$S/../../.." && pwd)"
DB=fin20p152
bash "$S/../financeiro-2-0/preparar_banco.sh" $DB >/dev/null || { echo "preparo falhou"; exit 1; }
Q() { psql -h 127.0.0.1 -p 54321 -U postgres -d $DB -tA -v ON_ERROR_STOP=1 -q -f - 2>&1; }
NP=0; NF=0
pass() { NP=$((NP+1)); echo "PASS $1"; }
fail() { NF=$((NF+1)); echo "FAIL $1 :: $2"; }
espera_erro() { local id="$1" txt="$2" pad="$3" sql="$4"; local o; o=$(echo "$sql" | Q); echo "$o" | grep -q "$pad" && pass "$id $txt" || fail "$id $txt" "$(echo "$o" | head -2)"; }
espera_ok() { local id="$1" txt="$2" sql="$3" esp="$4"; local o; o=$(echo "$sql" | Q | tail -1); [ "$o" = "$esp" ] && pass "$id $txt" || fail "$id $txt" "obtido: $o"; }
u() { printf '00000000-0000-4000-8000-%012d' "$1"; }
ORG=$(u 1); UNI=$(u 2); ORGB=$(u 4); UNIB=$(u 5); USR=$(u 900)

# base sintética: conta, categoria, fornecedor, obrigação de 1.000,00 competência set
echo "set role service_role;
insert into fin_contas(id,organizacao_id,unidade_id,nome,tipo_conta) values ('$(u 10)','$ORG','$UNI','BANCO','banco'),('$(u 11)','$ORGB','$UNIB','BANCO B','banco');
insert into fin_plano_contas(id,organizacao_id,tipo,natureza,nome,papel) values ('$(u 20)','$ORG','CUSTO','VARIAVEL','INSUMOS','custo_variavel'),('$(u 21)','$ORG','RECEITA','VARIAVEL','RECEITA','receita_operacional');
insert into fin_fornecedores(id,organizacao_id,nome) values ('$(u 30)','$ORG','Fornecedor');
insert into fin_obrigacoes(id,organizacao_id,unidade_id,fornecedor_id,categoria_id,descricao,competencia,vencimento,valor_original_centavos) values ('$(u 40)','$ORG','$UNI','$(u 30)','$(u 20)','compra','2026-09-01','2026-09-10',100000);
insert into fin_lancamentos(id,organizacao_id,unidade_id,conta_id,categoria_id,descricao,sentido,valor_centavos,data_movimento,status) values ('$(u 50)','$ORG','$UNI','$(u 10)','$(u 21)','repasse','entrada',30000,'2026-09-15','realizado'),('$(u 51)','$ORG','$UNI','$(u 10)','$(u 20)','saida','saida',100,'2026-09-15','realizado');" | Q >/dev/null

P='[{"competencia":"2026-08-01","valorCentavos":60000},{"competencia":"2026-09-01","valorCentavos":40000}]'
espera_ok R01 "rateio válido (Σ parcelas = elegível) é gravado pela função" "set role service_role; select count(*) from (select fin_rateio_definir('$ORG','$UNI','$USR','$(u 40)',100000,'dias_consumo','consumo de 30 dias','NF 123','$P'::jsonb)) x; select count(*) from fin_rateio_parcelas;" "2"
espera_erro R02 "soma das parcelas diferente do elegível é recusada" "fin2_rateio_soma_divergente" "set role service_role; select fin_rateio_definir('$ORG','$UNI','$USR','$(u 40)',100000,'dias_consumo','consumo','x','[{\"competencia\":\"2026-09-01\",\"valorCentavos\":90000}]'::jsonb);"
espera_erro R03 "elegível acima do valor original é recusado" "fin2_rateio_valor_invalido" "set role service_role; select fin_rateio_definir('$ORG','$UNI','$USR','$(u 40)',100001,'outro','acima','x','[{\"competencia\":\"2026-09-01\",\"valorCentavos\":100001}]'::jsonb);"
espera_erro R04 "inserir parcela fora da função é recusado" "fin2_rateio_via_funcao" "set role service_role; insert into fin_rateio_parcelas(organizacao_id,unidade_id,rateio_id,competencia,valor_centavos) select '$ORG','$UNI',id,'2026-10-01',1 from fin_rateios limit 1;"
espera_erro R05 "aprovar diretamente por UPDATE é recusado" "fin2_rateio_via_funcao" "set role service_role; update fin_rateios set status='aprovado', aprovado_por='$USR', aprovado_em=now();"
espera_ok R06 "redefinir substitui o ativo (anterior cancelado, com histórico) e mantém 1 ativo" "set role service_role; select fin_rateio_definir('$ORG','$UNI','$USR','$(u 40)',80000,'producao','20% fora do resultado: estorno parcial','NF 123','[{\"competencia\":\"2026-09-01\",\"valorCentavos\":80000}]'::jsonb); select count(*) filter (where status<>'cancelado') || '/' || count(*) from fin_rateios;" "1/2"
espera_ok R07 "aprovar pela função grava responsável e data" "set role service_role; select fin_rateio_aprovar('$ORG','$UNI','$USR',(select id from fin_rateios where status='proposto')); select status || ':' || (aprovado_por is not null) from fin_rateios where status<>'cancelado';" "aprovado:true"
espera_ok R08 "rateio não toca pagamentos nem o extrato" "select (select count(*) from fin_pagamentos) || '/' || (select count(*) from fin_lancamentos);" "0/2"
espera_ok R09 "trilha: criação, substituição e aprovação ficam na auditoria" "select (count(*) >= 5)::text from fin_auditoria where entidade in ('fin_rateios','fin_rateio_parcelas');" "true"
# fecha agosto e tenta redefinir (parcela de agosto mudaria)
echo "set role service_role; select fin_rateio_definir('$ORG','$UNI','$USR','$(u 40)',100000,'dias_consumo','volta para agosto','x','$P'::jsonb);
begin; select set_config('fin.fechando_periodo', (select id::text from fin_periodos where unidade_id='$UNI' and mes='2026-08-01'), true);
update fin_periodos set status='fechado', fechado_por='$USR', fechado_em=now(), snapshot='{}' where unidade_id='$UNI' and mes='2026-08-01'; commit;" | Q >/dev/null
espera_erro R10 "com agosto FECHADO, rateio que toca agosto não pode ser redefinido" "fechad" "set role service_role; select fin_rateio_definir('$ORG','$UNI','$USR','$(u 40)',100000,'outro','tentativa','x','[{\"competencia\":\"2026-09-01\",\"valorCentavos\":100000}]'::jsonb);"

# ---- recebíveis ----
echo "set role service_role; insert into fin_recebiveis(id,organizacao_id,unidade_id,origem,contraparte,competencia,valor_original_centavos,previsao,conta_id) values ('$(u 60)','$ORG','$UNI','repasse','iFood','2026-09-01',50000,'2026-09-30','$(u 10)');" | Q >/dev/null
espera_ok C01 "recebimento parcial vinculado a entrada existente (sem criar caixa)" "set role service_role; insert into fin_recebimentos(organizacao_id,unidade_id,recebivel_id,data,valor_centavos,conta_id,lancamento_id) values ('$ORG','$UNI','$(u 60)','2026-09-15',30000,'$(u 10)','$(u 50)'); select count(*) from fin_lancamentos;" "2"
espera_erro C02 "recebido acima do valor original é recusado" "fin2_recebimento_excede_recebivel" "set role service_role; insert into fin_recebimentos(organizacao_id,unidade_id,recebivel_id,data,valor_centavos,conta_id) values ('$ORG','$UNI','$(u 60)','2026-09-20',20002,'$(u 10)');"
espera_erro C03 "dois recebimentos não podem somar mais que a entrada do extrato" "fin2_recebimento_excede_entrada" "set role service_role; insert into fin_recebiveis(id,organizacao_id,unidade_id,origem,contraparte,competencia,valor_original_centavos) values ('$(u 61)','$ORG','$UNI','venda','Cliente','2026-09-01',90000); insert into fin_recebimentos(organizacao_id,unidade_id,recebivel_id,data,valor_centavos,conta_id,lancamento_id) values ('$ORG','$UNI','$(u 61)','2026-09-15',2,'$(u 10)','$(u 50)');"
espera_erro C04 "vincular a uma SAÍDA do extrato é recusado" "fin2_recebimento_lancamento_invalido" "set role service_role; insert into fin_recebimentos(organizacao_id,unidade_id,recebivel_id,data,valor_centavos,conta_id,lancamento_id) values ('$ORG','$UNI','$(u 60)','2026-09-15',100,'$(u 10)','$(u 51)');"
espera_erro C05 "conta de outra empresa é recusada" "fin_escopo_invalido" "set role service_role; insert into fin_recebimentos(organizacao_id,unidade_id,recebivel_id,data,valor_centavos,conta_id) values ('$ORG','$UNI','$(u 60)','2026-09-16',100,'$(u 11)');"
espera_erro C06 "recebimento não muda de valor (cancele e registre outro)" "fin_campo_imutavel" "set role service_role; update fin_recebimentos set valor_centavos = 1;"
espera_erro C07 "recebimento em mês FECHADO é recusado" "fechad" "set role service_role; insert into fin_recebimentos(organizacao_id,unidade_id,recebivel_id,data,valor_centavos,conta_id) values ('$ORG','$UNI','$(u 60)','2026-08-20',1,'$(u 10)');"

# ---- dívidas ----
echo "set role service_role; insert into fin_dividas(id,organizacao_id,unidade_id,natureza,credor,parcelas_total,entra_pe_financeiro,pendencia_documental) values ('$(u 70)','$ORG','$UNI','propria','Banco X',42,true,'contrato não anexado');" | Q >/dev/null
espera_ok D01 "dívida com valor original DESCONHECIDO fica nula (nunca zero) e com pendência documental" "select coalesce(valor_original_centavos::text,'null') || ':' || documentada || ':' || (pendencia_documental is not null) from fin_dividas;" "null:false:true"
espera_ok D02 "parcela separa principal, juros e encargos" "set role service_role; insert into fin_divida_eventos(organizacao_id,unidade_id,divida_id,data,tipo,principal_centavos,juros_centavos,encargos_centavos,parcela_numero) values ('$ORG','$UNI','$(u 70)','2026-09-10','amortizacao',80000,15000,326,36); select principal_centavos+juros_centavos+encargos_centavos from fin_divida_eventos;" "95326"
espera_erro D03 "evento sem valor é recusado" "fin_dev_valor_positivo" "set role service_role; insert into fin_divida_eventos(organizacao_id,unidade_id,divida_id,data,tipo) values ('$ORG','$UNI','$(u 70)','2026-09-11','outro');"
espera_erro D04 "saldo informado exige data" "fin_div_saldo_com_data" "set role service_role; update fin_dividas set saldo_informado_centavos = 100;"
espera_erro D05 "evento de dívida em mês FECHADO é recusado" "fechad" "set role service_role; insert into fin_divida_eventos(organizacao_id,unidade_id,divida_id,data,tipo,principal_centavos) values ('$ORG','$UNI','$(u 70)','2026-08-05','amortizacao',1);"
espera_erro D06 "natureza inválida é recusada" "violates check\|viola a restri" "set role service_role; insert into fin_dividas(organizacao_id,unidade_id,natureza,credor) values ('$ORG','$UNI','qualquer','x');"

# ---- segurança e transferência ----
espera_ok S01 "anon/authenticated não leem nem escrevem as tabelas novas" "select (has_table_privilege('anon','fin_rateios','select') or has_table_privilege('authenticated','fin_recebiveis','insert') or has_table_privilege('authenticated','fin_dividas','select'))::text;" "false"
espera_ok S02 "service_role não pode apagar (sem DELETE)" "select has_table_privilege('service_role','fin_rateios','delete')::text;" "false"
espera_erro S03 "unidade com rateio/recebível/dívida NÃO pode ser transferida de empresa" "rateios\|recebiveis\|dividas" "select gestao_financeira_verificar_unidade_transferivel('$UNI');"
espera_erro S04 "rollback da 152 recusa com dados" "ROLLBACK 152 RECUSADO" "$(cat "$R/database/migrations/152_rollback.sql")"
# rollback em banco vazio funciona e restaura a lista da 151
bash "$S/../financeiro-2-0/preparar_banco.sh" fin20p152v >/dev/null
O=$(psql -h 127.0.0.1 -p 54321 -U postgres -d fin20p152v -tA -q -v ON_ERROR_STOP=1 -f "$R/database/migrations/152_rollback.sql" 2>&1; echo "select to_regclass('fin_rateios') is null and array_length(gestao_financeira_tabelas_da_unidade(),1) = 16;" | psql -h 127.0.0.1 -p 54321 -U postgres -d fin20p152v -tA)
echo "$O" | tail -1 | grep -q '^t$' && pass "S05 rollback em banco vazio remove a 152 e restaura a lista da 151" || fail S05 "$O"
psql -h 127.0.0.1 -p 54321 -U postgres -d postgres -q -c "drop database if exists fin20p152v with (force)" >/dev/null 2>&1

echo; echo "RESUMO: $NP PASS, $NF FAIL"; [ $NF = 0 ]
