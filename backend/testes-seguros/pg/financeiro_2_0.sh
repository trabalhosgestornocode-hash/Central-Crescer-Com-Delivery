#!/bin/bash
# Provas da migration 151 (Financeiro 2.0: contas a pagar, acréscimos, conciliação de saídas) em PostgreSQL LOCAL DESCARTÁVEL.
# Modelo de privilégios do Supabase simulado (dono não-superusuário + default privileges + service_role BYPASSRLS), como sim_supabase.sh.
#   PG_CLUSTER_DIR=~/pg-descartavel bash backend/testes-seguros/pg/financeiro_2_0.sh
# Saída: uma linha PASS/FAIL por prova (ID estável, usado na matriz de testes). Recusa rodar fora do cluster descartável.
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
S="$(cd "$(dirname "$0")" && pwd)"
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR (cluster DESCARTÁVEL local com MARCADOR_DESCARTAVEL)}"
R="${REPO:-$(cd "$S/../../.." && pwd)}"; M="$R/database/migrations"
H="-h 127.0.0.1 -p 54321"; DB=fin20
[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo "sem marcador: recusado"; exit 2; }
psql $H -U postgres -tAc "show data_directory" | grep -qF "$CLUSTER" || { echo "cluster inesperado: recusado"; exit 2; }
psql $H -U postgres -tAc "show listen_addresses" | grep -qxE "127\.0\.0\.1|localhost" || { echo "cluster escutando fora do loopback: recusado"; exit 2; }

NP=0; NF=0
pass() { echo "PASS $1"; NP=$((NP+1)); }
fail() { echo "FAIL $1 :: $2"; NF=$((NF+1)); }
# SQL sempre por stdin (UTF-8): argumentos de linha de comando no Windows passam pela página de código ANSI e corrompem acentos
su_() { printf '%s
' "$1" | psql $H -U postgres -d $DB -q -tA -v ON_ERROR_STOP=1 -f - 2>&1; }
sr()  { printf 'set role service_role;
%s
' "$1" | psql $H -U postgres -d $DB -q -tA -v ON_ERROR_STOP=1 -f - 2>&1; }
como() { printf 'set role %s;
%s
' "$1" "$2" | psql $H -U postgres -d $DB -q -tA -v ON_ERROR_STOP=1 -f - 2>&1; }
erro() { echo "$1" | grep -qE "(^|: )(ERRO|ERROR):"; }   # NOTICE não é erro
neg() { local out; out=$(sr "$4"); if erro "$out" && echo "$out" | grep -qiE "$3"; then pass "$1 $2"; else fail "$1 $2" "$(echo "$out" | head -2 | tr '\n' ' ')"; fi; }
okk() { local out; out=$(sr "$3"); if erro "$out"; then fail "$1 $2" "$(echo "$out" | head -2 | tr '\n' ' ')"; else pass "$1 $2"; fi; }
eq()  { local out; out=$(sr "$3"); [ "$out" = "$4" ] && pass "$1 $2" || fail "$1 $2" "obtido=[$out] esperado=[$4]"; }
u() { printf '00000000-0000-4000-8000-%012d' "$1"; }

ORG_A=$(u 1); UNI_A=$(u 2); UNI_A2=$(u 3); ORG_B=$(u 4); UNI_B=$(u 5); USER=$(u 9); OPER=$(u 8)
CA=$(u 11); CA_CX=$(u 12); CA2=$(u 13); CB=$(u 14)
CAT=$(u 21); CAT_TR=$(u 22); CAT_REC=$(u 23); CAT_B=$(u 24)
FA=$(u 31); FB=$(u 32)

# ---------------- banco: papéis do Supabase simulados ----------------
psql $H -U postgres -q -d postgres -c "do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='dono_sim') then create role dono_sim login nosuperuser nobypassrls createrole; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end \$\$" >/dev/null 2>&1
psql $H -U postgres -q -d postgres -c "drop database if exists $DB" -c "create database $DB owner dono_sim" 2>&1 | grep -v NOTICE
su_ "grant all on schema public to dono_sim; grant usage on schema public to anon, authenticated, service_role" >/dev/null
DONO="psql $H -U dono_sim -d $DB -q -v ON_ERROR_STOP=1"
$DONO -c "alter default privileges in schema public grant all on tables to anon, authenticated, service_role; alter default privileges in schema public grant all on sequences to anon, authenticated, service_role; alter default privileges in schema public grant all on functions to anon, authenticated, service_role" >/dev/null 2>&1
$DONO -f "$S/stub.sql" >/dev/null 2>&1
ap() { $DONO -f "$1" >/dev/null 2>"${TMPDIR:-/tmp}/fin20-err.txt"; }
ok_ap=1
for f in 120_gestao_financeira_fundacao.sql 121_gestao_financeira_dominio.sql 122_conciliacao_periodos.sql; do ap "$M/$f" || { ok_ap=0; echo "base $f falhou: $(head -2 "${TMPDIR:-/tmp}/fin20-err.txt")"; }; done
ap "$M/151_financeiro_2_contas_pagar.sql" && pass "P01 151 aplica sobre 120/121/122 como dono não-superusuário (default privileges do Supabase)" || fail "P01 151 aplica" "$(head -3 "${TMPDIR:-/tmp}/fin20-err.txt" | tr '\n' ' ')"
ap "$M/151_financeiro_2_contas_pagar.sql" && pass "P02 151 idempotente (2ª aplicação)" || fail "P02 151 idempotente" "$(head -3 "${TMPDIR:-/tmp}/fin20-err.txt" | tr '\n' ' ')"
[ $ok_ap = 1 ] || { echo "base indisponível"; exit 1; }

# ---------------- privilégios ----------------
TABS="'fin_fornecedores','fin_obrigacoes','fin_pagamentos','fin_conciliacao_saidas'"
V=$(su_ "select string_agg(c.relname||'/'||r||'/'||p, ',') from pg_class c cross join unnest(array['anon','authenticated']) r cross join unnest(array['select','insert','update','delete','truncate','references','trigger']) p where c.relname in ($TABS) and has_table_privilege(r, c.oid, p)")
[ -z "$V" ] && pass "P03 anon/authenticated sem nenhum privilégio nas 4 tabelas novas" || fail "P03" "$V"
V=$(su_ "select string_agg(p.proname||'/'||r, ',') from pg_proc p cross join unnest(array['anon','authenticated']) r where p.pronamespace='public'::regnamespace and (p.proname like 'fin2\_%' or p.proname like 'fin\_obrigac%' or p.proname like 'fin\_conciliacao\_saida%' or p.proname in ('fin_fornecedores_guarda','fin_pagamentos_guarda')) and has_function_privilege(r, p.oid, 'execute')")
[ -z "$V" ] && pass "P04 anon/authenticated sem EXECUTE em nenhuma função nova (RPC, auxiliar ou gatilho)" || fail "P04" "$V"
V=$(su_ "select string_agg(c.relname||'/'||p, ',') from pg_class c cross join unnest(array['delete','truncate','references','trigger']) p where c.relname in ($TABS) and has_table_privilege('service_role', c.oid, p)")
[ -z "$V" ] && pass "P05 service_role sem DELETE/TRUNCATE/REFERENCES/TRIGGER nas tabelas novas" || fail "P05" "$V"
V=$(su_ "select count(*) filter (where not relrowsecurity) || '/' || (select count(*) from pg_policies where tablename in ($TABS)) from pg_class where relname in ($TABS)")
[ "$V" = "0/0" ] && pass "P06 RLS ligada e zero policies nas tabelas novas" || fail "P06" "$V"
V=$(su_ "select (array['fin_obrigacoes','fin_pagamentos','fin_conciliacao_saidas'] <@ public.gestao_financeira_tabelas_da_unidade())::text")
[ "$V" = "true" ] && pass "P07 tabelas novas na lista de transferência de unidade (guarda 120 §5b)" || fail "P07" "$V"
neg P09 "service_role: DELETE em fin_obrigacoes negado" "permiss|negad" "delete from fin_obrigacoes"
OUT=$(como anon "select * from fin_pagamentos"); erro "$OUT" && pass "P10 anon: SELECT em fin_pagamentos negado" || fail "P10" "$OUT"
OUT=$(como authenticated "select fin_obrigacao_quitar('$ORG_A','$UNI_A','$USER','$(u 999)')"); erro "$OUT" && echo "$OUT" | grep -qiE "permiss|negad" && pass "P11 authenticated: EXECUTE de fin_obrigacao_quitar negado" || fail "P11" "$OUT"

# ---------------- dados sintéticos ----------------
su_ "insert into organizacoes(id,nome) values ('$ORG_A','Org A (sintética)'),('$ORG_B','Org B (sintética)');
     insert into unidades(id,organizacao_id,nome) values ('$UNI_A','$ORG_A','A1'),('$UNI_A2','$ORG_A','A2'),('$UNI_B','$ORG_B','B1');
     insert into perfis(id) values ('$(u 41)'); insert into perfis_operacionais(id,conta_id,nome) values ('$(u 42)','$(u 41)','P');
     insert into usuarios_unidades(usuario_id,unidade_id) values ('$(u 41)','$UNI_A'); insert into usuarios_organizacoes(usuario_id,organizacao_id) values ('$(u 41)','$ORG_A')" >/dev/null
OUT=$(sr "insert into fin_contas(id,organizacao_id,unidade_id,nome,tipo_conta) values ('$CA','$ORG_A','$UNI_A','BANCO A','banco'),('$CA_CX','$ORG_A','$UNI_A','CAIXA A','caixa_fisico'),('$CA2','$ORG_A','$UNI_A2','BANCO A2','banco'),('$CB','$ORG_B','$UNI_B','BANCO B','banco');
  insert into fin_plano_contas(id,organizacao_id,tipo,natureza,nome,papel) values ('$CAT','$ORG_A','DESPESA','FIXA','INSUMOS','despesa_fixa'),('$CAT_TR','$ORG_A','TRANSFERENCIA','ENTRE CONTAS','ENTRE CONTAS','transferencia'),('$CAT_REC','$ORG_A','RECEITA','RECEBIMENTO','VENDAS','receita_operacional'),('$CAT_B','$ORG_B','DESPESA','FIXA','INSUMOS','despesa_fixa');
  insert into fin_fornecedores(id,organizacao_id,nome,criado_por) values ('$FA','$ORG_A','Embalagens Sintéticas','$USER'),('$FB','$ORG_B','Fornecedor B','$USER')")
erro "$OUT" && { echo "seed falhou: $OUT"; exit 1; }
# obrigação: id, fornecedor, categoria, competência, vencimento, valor (centavos), unidade, org
obr() { sr "insert into fin_obrigacoes(id,organizacao_id,unidade_id,fornecedor_id,categoria_id,descricao,competencia,vencimento,valor_original_centavos,criado_por,atualizado_por${9:+,provisoria}) values ('$1','${8:-$ORG_A}','${7:-$UNI_A}','$2','$3','Conta sintética','$4','$5',$6,'$USER','$USER'${9:+,true})"; }
pag() { sr "insert into fin_pagamentos(id,organizacao_id,unidade_id,obrigacao_id,conta_id,data_pagamento,valor_centavos,criado_por,atualizado_por) values ('$1','${6:-$ORG_A}','${7:-$UNI_A}','$2','$3','$4',$5,'$USER','$USER')"; }
lanc() { sr "insert into fin_lancamentos(id,organizacao_id,unidade_id,conta_id,categoria_id,descricao,sentido,valor_centavos,data_movimento,criado_por,atualizado_por) values ('$1','${7:-$ORG_A}','${8:-$UNI_A}','$2','${6:-$CAT}','EXTRATO SINTÉTICO','${5:-saida}',$4,'$3','$USER','$USER')"; }
vinc() { sr "insert into fin_conciliacao_saidas(organizacao_id,unidade_id,grupo,pagamento_id,lancamento_id,valor_alocado_centavos,status,regra,criado_por,atualizado_por) values ('${7:-$ORG_A}','${8:-$UNI_A}','$1','$2','$3',$4,'${5:-sugerido}','${6:-exato}','$USER','$USER')"; }

# ---------------- níveis ----------------
okk P08a "nível 'contador' aceito em concessão" "insert into gestao_financeira_concessoes(organizacao_id,unidade_id,perfil_id,nivel,concedida_por,motivo) values ('$ORG_A','$UNI_A','$(u 42)','contador','$(u 43)','Contadora sintética de teste')"
okk P08b "nível 'administrador' aceito (alteração de nível)" "update gestao_financeira_concessoes set nivel='administrador' where perfil_id='$(u 42)'"
neg P08c "nível desconhecido recusado" "check|viola" "update gestao_financeira_concessoes set nivel='dono' where perfil_id='$(u 42)'"
su_ "update gestao_financeira_concessoes set revogada_em=now(), revogada_por='$(u 43)', motivo_revogacao='Fim do teste de níveis' where perfil_id='$(u 42)'" >/dev/null

# ---------------- isolamento ----------------
neg I01 "obrigação com fornecedor de OUTRA organização recusada" "fin_escopo_invalido" "insert into fin_obrigacoes(organizacao_id,unidade_id,fornecedor_id,categoria_id,descricao,competencia,vencimento,valor_original_centavos) values ('$ORG_A','$UNI_A','$FB','$CAT','x','2026-07-01','2026-07-10',100)"
neg I02 "obrigação com categoria de OUTRA organização recusada" "fin_escopo_invalido" "insert into fin_obrigacoes(organizacao_id,unidade_id,fornecedor_id,categoria_id,descricao,competencia,vencimento,valor_original_centavos) values ('$ORG_A','$UNI_A','$FA','$CAT_B','x','2026-07-01','2026-07-10',100)"
neg I02b "obrigação com unidade de OUTRA organização recusada" "fin_escopo_invalido" "insert into fin_obrigacoes(organizacao_id,unidade_id,fornecedor_id,categoria_id,descricao,competencia,vencimento,valor_original_centavos) values ('$ORG_A','$UNI_B','$FA','$CAT','x','2026-07-01','2026-07-10',100)"
OUT=$(obr $(u 100) $FA $CAT 2026-09-01 2026-09-12 81000); erro "$OUT" && fail "seed CP 810" "$OUT"
neg I03 "pagamento em conta de OUTRA unidade recusado" "fin_escopo_invalido" "insert into fin_pagamentos(organizacao_id,unidade_id,obrigacao_id,conta_id,data_pagamento,valor_centavos) values ('$ORG_A','$UNI_A','$(u 100)','$CA2','2026-09-18',100)"
neg I04 "pagamento lançado na unidade A2 para obrigação da unidade A1 recusado" "fin_escopo_invalido" "insert into fin_pagamentos(organizacao_id,unidade_id,obrigacao_id,conta_id,data_pagamento,valor_centavos) values ('$ORG_A','$UNI_A2','$(u 100)','$CA2','2026-09-18',100)"
neg I06 "RPC quitar com contexto de OUTRO tenant: não encontrada" "fin2_obrigacao_nao_encontrada" "select fin_obrigacao_quitar('$ORG_B','$UNI_B','$USER','$(u 100)')"
neg I06b "RPC classificar com OUTRA unidade da mesma organização: não encontrada" "fin2_obrigacao_nao_encontrada" "select fin_obrigacao_classificar('$ORG_A','$UNI_A2','$USER','$(u 100)','juros')"

# ---------------- cálculo e regras da obrigação ----------------
okk C00 "pagamento de 832,41 registrado" "insert into fin_pagamentos(id,organizacao_id,unidade_id,obrigacao_id,conta_id,data_pagamento,valor_centavos,criado_por,atualizado_por) values ('$(u 200)','$ORG_A','$UNI_A','$(u 100)','$CA','2026-09-18',83241,'$USER','$USER')"
neg C07 "status 'quitada' por UPDATE direto recusado (só pela função)" "fin2_transicao_via_funcao" "update fin_obrigacoes set status='quitada', data_quitacao='2026-09-18', quitada_por='$USER', quitada_em=now() where id='$(u 100)'"
neg C04 "classificar obrigação NÃO quitada recusado" "fin2_obrigacao_nao_quitada" "select fin_obrigacao_classificar('$ORG_A','$UNI_A','$USER','$(u 100)','juros')"
eq C01a "quitação: data = último pagamento; diferença = 832,41 − 810,00 = 2241 centavos" "select (fin_obrigacao_quitar('$ORG_A','$UNI_A','$USER','$(u 100)')->>'data_quitacao') || '|' || ((select sum(valor_centavos) from fin_pagamentos where obrigacao_id='$(u 100)') - 81000)" "2026-09-18|2241"
eq C01b "percentual = 2241 ÷ 81000 = 2,77%" "select round(2241::numeric * 100 / 81000, 2)" "2.77"
neg C02 "acréscimo classificado como 'desconto' recusado" "fin2_classificacao_incompativel" "select fin_obrigacao_classificar('$ORG_A','$UNI_A','$USER','$(u 100)','desconto')"
neg C08 "classificação por UPDATE direto recusada" "fin2_transicao_via_funcao" "update fin_obrigacoes set classificacao_diferenca='juros', classificada_por='$USER', classificada_em=now() where id='$(u 100)'"
eq C01c "acréscimo classificado como 'juros' pela função" "select fin_obrigacao_classificar('$ORG_A','$UNI_A','$USER','$(u 100)','juros')->>'classificacao_diferenca'" "juros"
neg C09 "pagamento novo em obrigação QUITADA recusado" "fin2_obrigacao_nao_aberta" "insert into fin_pagamentos(organizacao_id,unidade_id,obrigacao_id,conta_id,data_pagamento,valor_centavos) values ('$ORG_A','$UNI_A','$(u 100)','$CA','2026-09-20',100)"
neg C10 "alterar valor de obrigação quitada recusado" "fin2_obrigacao_quitada" "update fin_obrigacoes set valor_original_centavos=82000 where id='$(u 100)'"
neg C11a "desfazer quitação sem motivo recusado" "fin2_motivo_obrigatorio" "select fin_obrigacao_desfazer_quitacao('$ORG_A','$UNI_A','$USER','$(u 100)','curto')"
eq C11b "desfazer quitação com motivo limpa a classificação" "select coalesce(fin_obrigacao_desfazer_quitacao('$ORG_A','$UNI_A','$USER','$(u 100)','Valor do boleto revisado')->>'classificacao_diferenca','null')" "null"
okk C11c "requitação após desfazer" "select fin_obrigacao_quitar('$ORG_A','$UNI_A','$USER','$(u 100)')"
# dois pagamentos (1.200 + 800 = 2.000): sem diferença
obr $(u 101) $FA $CAT 2026-09-01 2026-09-15 200000 >/dev/null; pag $(u 201) $(u 101) $CA 2026-09-10 120000 >/dev/null; pag $(u 202) $(u 101) $CA 2026-09-25 80000 >/dev/null
eq C03a "dois pagamentos (1.200 + 800) sobre 2.000: quita em 25/09 sem diferença" "select (fin_obrigacao_quitar('$ORG_A','$UNI_A','$USER','$(u 101)')->>'data_quitacao') || '|' || ((select sum(valor_centavos) from fin_pagamentos where obrigacao_id='$(u 101)') - 200000)" "2026-09-25|0"
neg C03b "classificar obrigação sem diferença recusado" "fin2_sem_diferenca" "select fin_obrigacao_classificar('$ORG_A','$UNI_A','$USER','$(u 101)','juros')"
# parcial (900 de 1.500), não quitada: nunca vira desconto
obr $(u 102) $FA $CAT 2026-09-01 2026-09-05 150000 >/dev/null; pag $(u 203) $(u 102) $CA 2026-09-05 90000 >/dev/null
neg C04b "pagamento PARCIAL não quitado: classificar como desconto recusado" "fin2_obrigacao_nao_quitada" "select fin_obrigacao_classificar('$ORG_A','$UNI_A','$USER','$(u 102)','desconto')"
# pago a menor e quitado: só 'desconto'
obr $(u 103) $FA $CAT 2026-09-01 2026-09-15 64000 >/dev/null; pag $(u 204) $(u 103) $CA 2026-09-15 61000 >/dev/null
okk C05a "pago a menor quitado" "select fin_obrigacao_quitar('$ORG_A','$UNI_A','$USER','$(u 103)')"
neg C05b "pago a menor: classificar como 'juros' recusado" "fin2_classificacao_incompativel" "select fin_obrigacao_classificar('$ORG_A','$UNI_A','$USER','$(u 103)','juros')"
obr $(u 104) $FA $CAT 2026-09-01 2026-09-20 10000 >/dev/null
neg C06 "quitação sem pagamento recusada" "fin2_quitacao_sem_pagamento" "select fin_obrigacao_quitar('$ORG_A','$UNI_A','$USER','$(u 104)')"
pag $(u 205) $(u 104) $CA 2026-09-20 10000 >/dev/null
neg C12a "cancelar obrigação com pagamento ativo recusado" "fin2_obrigacao_com_pagamento" "select fin_obrigacao_cancelar('$ORG_A','$UNI_A','$USER','$(u 104)','Lançada em duplicidade')"
okk C12b "cancelar pagamento com motivo" "update fin_pagamentos set status='cancelado', cancelado_por='$USER', cancelado_em=now(), motivo_cancelamento='Pagamento lançado por engano' where id='$(u 205)'"
eq C12c "cancelar obrigação sem pagamento ativo, com motivo" "select fin_obrigacao_cancelar('$ORG_A','$UNI_A','$USER','$(u 104)','Lançada em duplicidade')->>'status'" "cancelada"
neg C12d "obrigação cancelada é imutável" "fin2_obrigacao_cancelada_imutavel" "update fin_obrigacoes set observacoes='x' where id='$(u 104)'"

# ---------------- duplicidade / idempotência ----------------
okk D01a "obrigação importada com chave de origem" "insert into fin_obrigacoes(organizacao_id,unidade_id,fornecedor_id,categoria_id,descricao,competencia,vencimento,valor_original_centavos,origem,chave_origem) values ('$ORG_A','$UNI_A','$FA','$CAT','x','2026-09-01','2026-09-10',100,'importacao','central:CP-0001')"
neg D01b "mesma chave de origem recusada (reimportação não duplica)" "duplica|unique|ux_fin_obrigacoes_chave" "insert into fin_obrigacoes(organizacao_id,unidade_id,fornecedor_id,categoria_id,descricao,competencia,vencimento,valor_original_centavos,origem,chave_origem) values ('$ORG_A','$UNI_A','$FA','$CAT','x','2026-09-01','2026-09-10',100,'importacao','central:CP-0001')"
okk D01c "mesma chave em OUTRA unidade é outro registro" "insert into fin_obrigacoes(organizacao_id,unidade_id,fornecedor_id,categoria_id,descricao,competencia,vencimento,valor_original_centavos,origem,chave_origem) values ('$ORG_A','$UNI_A2','$FA','$CAT','x','2026-09-01','2026-09-10',100,'importacao','central:CP-0001')"
okk D02a "pagamento com chave de origem" "insert into fin_pagamentos(organizacao_id,unidade_id,obrigacao_id,conta_id,data_pagamento,valor_centavos,chave_origem) values ('$ORG_A','$UNI_A','$(u 102)','$CA','2026-09-06',1000,'central:PG-0001')"
neg D02b "pagamento com chave repetida recusado" "duplica|unique" "insert into fin_pagamentos(organizacao_id,unidade_id,obrigacao_id,conta_id,data_pagamento,valor_centavos,chave_origem) values ('$ORG_A','$UNI_A','$(u 102)','$CA','2026-09-06',1000,'central:PG-0001')"
neg D03 "fornecedor repetido (maiúsculas/espaços) recusado" "duplica|unique" "insert into fin_fornecedores(organizacao_id,nome) values ('$ORG_A','  EMBALAGENS sintéticas ')"

# ---------------- conciliação de saídas ----------------
lanc $(u 300) $CA 2026-09-18 83241 >/dev/null          # saída exata do pagamento de 832,41
lanc $(u 301) $CA 2026-09-26 200000 >/dev/null         # saída única para os 2 pagamentos (1.200 + 800) — agrupado
lanc $(u 302) $CA 2026-09-06 91250 >/dev/null          # saída 912,50 para o pagamento de 900 (divergente)
lanc $(u 303) $CA 2026-09-10 5000 saida $CAT_TR >/dev/null   # perna de transferência
lanc $(u 304) $CA 2026-09-10 5000 entrada $CAT_REC >/dev/null # entrada
neg K01 "vínculo inserido direto como 'conciliado' recusado (nunca automático)" "fin2_conciliacao_via_funcao" "insert into fin_conciliacao_saidas(organizacao_id,unidade_id,grupo,pagamento_id,lancamento_id,valor_alocado_centavos,status,regra,confirmado_por,confirmado_em,evidencia) values ('$ORG_A','$UNI_A','$(u 500)','$(u 200)','$(u 300)',83241,'conciliado','exato','$USER',now(),'{}')"
okk K03a "sugestão 1:1 exata criada (status sugerido)" "insert into fin_conciliacao_saidas(organizacao_id,unidade_id,grupo,pagamento_id,lancamento_id,valor_alocado_centavos,status,regra) values ('$ORG_A','$UNI_A','$(u 500)','$(u 200)','$(u 300)',83241,'sugerido','exato')"
neg K02 "UPDATE direto sugerido → conciliado recusado" "fin2_conciliacao_via_funcao|fin2_campo_via_funcao" "update fin_conciliacao_saidas set status='conciliado', confirmado_por='$USER', confirmado_em=now(), evidencia='{}' where grupo='$(u 500)'"
neg K06 "mesmo par pagamento ⇄ saída duplicado (ativo) recusado (guarda de alocação; índice único cobre a corrida)" "duplica|unique|fin2_alocacao_excedida" "insert into fin_conciliacao_saidas(organizacao_id,unidade_id,grupo,pagamento_id,lancamento_id,valor_alocado_centavos,status,regra) values ('$ORG_A','$UNI_A','$(u 501)','$(u 200)','$(u 300)',83241,'sugerido','exato')"
neg K05 "pagamento já alocado não pode ser sugerido para outra saída" "fin2_alocacao_excedida" "insert into fin_conciliacao_saidas(organizacao_id,unidade_id,grupo,pagamento_id,lancamento_id,valor_alocado_centavos,status,regra) values ('$ORG_A','$UNI_A','$(u 501)','$(u 200)','$(u 301)',83241,'sugerido','exato')"
neg I05 "vínculo com saída de OUTRA unidade recusado" "fin_escopo_invalido" "insert into fin_conciliacao_saidas(organizacao_id,unidade_id,grupo,pagamento_id,lancamento_id,valor_alocado_centavos,status,regra) values ('$ORG_A','$UNI_A2','$(u 502)','$(u 200)','$(u 300)',83241,'sugerido','exato')"
neg I07 "confirmar grupo com contexto de OUTRO tenant: não encontrado" "fin2_vinculo_nao_encontrado" "select fin_conciliacao_saida_confirmar('$ORG_B','$UNI_B','$USER','$(u 500)',null)"
eq K03b "confirmação humana dentro da tolerância devolve a evidência do extrato" "select fin_conciliacao_saida_confirmar('$ORG_A','$UNI_A','$USER','$(u 500)',null)->'lancamento'->>'id'" "$(u 300)"
eq K03d "grupo passa a 'conciliado' com autor e data" "select status || '|' || (confirmado_por = '$USER')::text || '|' || (confirmado_em is not null)::text from fin_conciliacao_saidas where grupo='$(u 500)'" "conciliado|true|true"
eq K03c "evidência preserva os identificadores dos pagamentos" "select evidencia->'pagamentos'->0->>'id' from fin_conciliacao_saidas where grupo='$(u 500)'" "$(u 200)"
neg K07 "vínculo com ENTRADA do extrato recusado" "fin2_lancamento_nao_e_saida" "insert into fin_conciliacao_saidas(organizacao_id,unidade_id,grupo,pagamento_id,lancamento_id,valor_alocado_centavos,status,regra) values ('$ORG_A','$UNI_A','$(u 503)','$(u 203)','$(u 304)',5000,'sugerido','manual')"
neg K08 "vínculo com perna de TRANSFERÊNCIA recusado" "fin2_lancamento_transferencia" "insert into fin_conciliacao_saidas(organizacao_id,unidade_id,grupo,pagamento_id,lancamento_id,valor_alocado_centavos,status,regra) values ('$ORG_A','$UNI_A','$(u 503)','$(u 203)','$(u 303)',5000,'sugerido','manual')"
okk K12a "agrupado: 1 saída de 2.000 ⇄ 2 pagamentos (1.200 + 800)" "insert into fin_conciliacao_saidas(organizacao_id,unidade_id,grupo,pagamento_id,lancamento_id,valor_alocado_centavos,status,regra) values ('$ORG_A','$UNI_A','$(u 504)','$(u 201)','$(u 301)',120000,'sugerido','agrupado'),('$ORG_A','$UNI_A','$(u 504)','$(u 202)','$(u 301)',80000,'sugerido','agrupado')"
neg K04a "agrupado com 16 dias de distância exige justificativa (tolerância 1 dia)" "fin2_justificativa_obrigatoria" "select fin_conciliacao_saida_confirmar('$ORG_A','$UNI_A','$USER','$(u 504)',null)"
okk K04b "com justificativa, confirma" "select fin_conciliacao_saida_confirmar('$ORG_A','$UNI_A','$USER','$(u 504)','Pix único do fornecedor quitando as duas parcelas')"
okk K13a "divergente: saída 912,50 × pagamento 900,00 registrado como divergente" "insert into fin_conciliacao_saidas(organizacao_id,unidade_id,grupo,pagamento_id,lancamento_id,valor_alocado_centavos,status,regra,diferenca_centavos) values ('$ORG_A','$UNI_A','$(u 505)','$(u 203)','$(u 302)',90000,'divergente','manual',1250)"
neg K09 "alterar valor de saída do extrato vinculada recusado" "fin2_lancamento_vinculado" "update fin_lancamentos set valor_centavos=83000 where id='$(u 300)'"
neg K10 "cancelar pagamento vinculado recusado" "fin2_pagamento_vinculado|fin2_obrigacao_nao_aberta" "update fin_pagamentos set status='cancelado', cancelado_por='$USER', cancelado_em=now(), motivo_cancelamento='tentativa de cancelar vinculado' where id='$(u 203)'"
neg K11a "revogar conciliação sem motivo recusado" "fin2_motivo_obrigatorio" "select fin_conciliacao_saida_revogar('$ORG_A','$UNI_A','$USER','$(u 500)','x')"
N0=$(su_ "select count(*) from fin_conciliacao_saidas")
eq K11b "revogar com motivo" "select fin_conciliacao_saida_revogar('$ORG_A','$UNI_A','$USER','$(u 500)','Vínculo feito com o extrato errado')" "1"
eq K11e "registro preservado: status revogado, evidência mantida, nada apagado" "select status || '|' || (evidencia is not null)::text || '|' || (select count(*) from fin_conciliacao_saidas) from fin_conciliacao_saidas where grupo='$(u 500)'" "revogado|true|$N0"
okk K11c "após revogar, o pagamento pode ser vinculado de novo" "insert into fin_conciliacao_saidas(organizacao_id,unidade_id,grupo,pagamento_id,lancamento_id,valor_alocado_centavos,status,regra) values ('$ORG_A','$UNI_A','$(u 506)','$(u 200)','$(u 300)',83241,'sugerido','exato')"
okk K11d "e confirmado de novo" "select fin_conciliacao_saida_confirmar('$ORG_A','$UNI_A','$USER','$(u 506)',null)"

# ---------------- auditoria ----------------
eq A01 "quitação auditada com o usuário como ator e antes/depois" "select count(*) > 0 from fin_auditoria where entidade='fin_obrigacoes' and entidade_id='$(u 100)' and ator_id='$USER' and antes->>'status'='aberta' and depois->>'status'='quitada'" "t"
eq A02 "classificação do acréscimo auditada (antes nulo → juros)" "select count(*) > 0 from fin_auditoria where entidade='fin_obrigacoes' and entidade_id='$(u 100)' and antes->>'classificacao_diferenca' is null and depois->>'classificacao_diferenca'='juros'" "t"
eq A03 "confirmação de conciliação auditada" "select count(*) >= 2 from fin_auditoria where entidade='fin_conciliacao_saidas' and depois->>'status'='conciliado'" "t"
neg A04 "trilha de auditoria imutável" "imutavel|permiss" "update fin_auditoria set acao='x'"

# ---------------- fechamento e reabertura ----------------
su_ "create schema if not exists teste; grant usage on schema teste to service_role;
create or replace function teste.fechar(o uuid, un uuid, m date) returns text language plpgsql as \$\$
declare v int; begin
  perform fin_abrir_periodo(o, un, '$USER', m);
  select versao into v from fin_periodos where unidade_id = un and mes = m;
  perform fin_fechar_periodo(o, un, '$USER', m, v, fin_fingerprint_periodo(o, un, m), '{}'::jsonb, fin_conciliacao_pendencias_ids(o, un, m), false);
  return (select status from fin_periodos where unidade_id = un and mes = m);
end \$\$; grant execute on function teste.fechar(uuid,uuid,date) to service_role;" >/dev/null
# Setembro tem: divergente (912,50×900), pago a menor 'a verificar' (CP 103) — bloqueado
neg F01 "fechar setembro com divergência de conciliação e pago a menor 'a verificar' recusado" "fin2_divergencias_bloqueadoras" "select teste.fechar('$ORG_A','$UNI_A','2026-09-01')"
eq F01b "o banco lista os bloqueios por tipo" "select string_agg(distinct x->>'tipo', ',' order by x->>'tipo') from jsonb_array_elements(fin2_bloqueios_fechamento('$ORG_A','$UNI_A','2026-09-01')) x" "divergencia_conciliacao,pago_a_menor_a_verificar"
# julho: quitação pendente (pago integral, não quitada) e registro provisório
obr $(u 110) $FA $CAT 2026-07-01 2026-07-10 50000 >/dev/null; pag $(u 210) $(u 110) $CA 2026-07-10 50000 >/dev/null
neg F03 "fechar julho com quitação pendente (pago integral, não quitada) recusado" "fin2_divergencias_bloqueadoras" "select teste.fechar('$ORG_A','$UNI_A','2026-07-01')"
okk F03b "quitar a conta de julho" "select fin_obrigacao_quitar('$ORG_A','$UNI_A','$USER','$(u 110)')"
obr $(u 111) $FA $CAT 2026-07-01 2026-07-20 30000 $UNI_A $ORG_A provisoria >/dev/null
neg F04 "fechar julho com registro PROVISÓRIO não confirmado recusado" "fin2_divergencias_bloqueadoras" "select teste.fechar('$ORG_A','$UNI_A','2026-07-01')"
neg F04b "confirmação do provisório por UPDATE direto recusada" "fin2_transicao_via_funcao" "update fin_obrigacoes set provisoria=false where id='$(u 111)'"
okk F04c "confirmar o provisório pela função" "select fin_obrigacao_confirmar_registro('$ORG_A','$UNI_A','$USER','$(u 111)')"
# acréscimo PRESUMIDO não classificado em julho NÃO bloqueia
obr $(u 112) $FA $CAT 2026-07-01 2026-07-05 20000 >/dev/null; pag $(u 211) $(u 112) $CA 2026-07-09 20460 >/dev/null; sr "select fin_obrigacao_quitar('$ORG_A','$UNI_A','$USER','$(u 112)')" >/dev/null
eq F05 "julho sem bloqueios (juro presumido não classificado não bloqueia) FECHA" "select teste.fechar('$ORG_A','$UNI_A','2026-07-01')" "fechado"
neg F06a "pagamento datado em mês FECHADO recusado" "fin_periodo_fechado" "insert into fin_pagamentos(organizacao_id,unidade_id,obrigacao_id,conta_id,data_pagamento,valor_centavos) values ('$ORG_A','$UNI_A','$(u 102)','$CA','2026-07-30',100)"
neg F06b "obrigação com competência FECHADA recusada" "fin_periodo_fechado" "insert into fin_obrigacoes(organizacao_id,unidade_id,fornecedor_id,categoria_id,descricao,competencia,vencimento,valor_original_centavos) values ('$ORG_A','$UNI_A','$FA','$CAT','x','2026-07-01','2026-08-10',100)"
neg F06c "classificar acréscimo de julho (mês fechado) recusado" "fin_periodo_fechado" "select fin_obrigacao_classificar('$ORG_A','$UNI_A','$USER','$(u 112)','juros')"
neg F06d "desfazer quitação de julho (mês fechado) recusado" "fin_periodo_fechado" "select fin_obrigacao_desfazer_quitacao('$ORG_A','$UNI_A','$USER','$(u 112)','Correção solicitada pela contadora')"
# conta de competência julho (fechada) paga com atraso em agosto: pode ser quitada (o acréscimo é de agosto)
neg F08 "reabertura de período pela função continua recusada (desabilitada — decisão LD-009/F-A preservada)" "reabertura_desabilitada|permiss|negad" "select fin_reabrir_periodo('$ORG_A','$UNI_A','$USER','2026-07-01',(select versao from fin_periodos where unidade_id='$UNI_A' and mes='2026-07-01'),'Correção solicitada pela contadora')"
neg F09 "reabertura por UPDATE direto recusada" "reabertura_desabilitada" "update fin_periodos set status='reaberto', reaberto_por='$USER', reaberto_em=now(), motivo_reabertura='Correção solicitada pela contadora' where unidade_id='$UNI_A' and mes='2026-07-01'"
# Simulação SÓ NO DESCARTÁVEL da habilitação futura (como superusuário, com a flag que a função habilitada usaria)
OUT=$(su_ "begin; select set_config('fin.reabertura_autorizada', (select id::text from fin_periodos where unidade_id='$UNI_A' and mes='2026-07-01'), true); update fin_periodos set status='reaberto', reaberto_por='$USER', reaberto_em=now(), motivo_reabertura='Simulacao de habilitacao futura (descartavel)' where unidade_id='$UNI_A' and mes='2026-07-01'; commit;")
erro "$OUT" && fail "F10a reabertura simulada" "$OUT" || pass "F10a [simulação da habilitação futura, só no descartável] período reaberto com motivo"
okk F10b "mês reaberto volta a aceitar correções (classificar o acréscimo de julho)" "select fin_obrigacao_classificar('$ORG_A','$UNI_A','$USER','$(u 112)','multa')"
obr $(u 114) $FA $CAT 2026-07-01 2026-07-25 70000 $UNI_A $ORG_A provisoria >/dev/null
neg F10c "refechar o mês reaberto com novo bloqueio (provisório) recusado" "fin2_divergencias_bloqueadoras" "select teste.fechar('$ORG_A','$UNI_A','2026-07-01')"
sr "select fin_obrigacao_confirmar_registro('$ORG_A','$UNI_A','$USER','$(u 114)')" >/dev/null
eq F10d "sem bloqueios, refecha" "select teste.fechar('$ORG_A','$UNI_A','2026-07-01')" "fechado"
# competência FECHADA (julho) paga com atraso em agosto (aberto): pagamento e quitação PERMITIDOS; o acréscimo vai para agosto
okk F11a "conta de competência julho (fechada): pagamento com atraso em agosto aceito" "insert into fin_pagamentos(id,organizacao_id,unidade_id,obrigacao_id,conta_id,data_pagamento,valor_centavos) values ('$(u 214)','$ORG_A','$UNI_A','$(u 114)','$CA','2026-08-03',71400)"
eq F11b "e quitada: acréscimo pertence a agosto (data da quitação)" "select fin_obrigacao_quitar('$ORG_A','$UNI_A','$USER','$(u 114)')->>'data_quitacao'" "2026-08-03"
neg F11c "mas alterar o VALOR dessa conta (afeta julho fechado) continua recusado" "fin_periodo_fechado|fin2_obrigacao_quitada" "update fin_obrigacoes set descricao='outra' where id='$(u 114)'"

# ---------------- concorrência: fechamento × pagamento simultâneo ----------------
obr $(u 120) $FA $CAT 2026-08-01 2026-08-10 1000 >/dev/null
( sr "begin; insert into fin_pagamentos(organizacao_id,unidade_id,obrigacao_id,conta_id,data_pagamento,valor_centavos) values ('$ORG_A','$UNI_A','$(u 120)','$CA','2026-08-10',1000); select pg_sleep(2); commit;" >/dev/null ) &
sleep 0.7
T0=$(date +%s%N)
OUT=$(sr "select teste.fechar('$ORG_A','$UNI_A','2026-08-01')")
T1=$(date +%s%N); wait
ESP=$(( (T1 - T0) / 1000000 ))
if erro "$OUT" && echo "$OUT" | grep -q "fin2_divergencias_bloqueadoras" && [ $ESP -ge 900 ]; then pass "X01 fechamento ESPEROU o pagamento concorrente (${ESP} ms) e viu a quitação pendente: recusado"
else fail "X01 concorrência fechamento × pagamento" "espera=${ESP}ms saída=$(echo "$OUT" | head -1)"; fi

# ---------------- achados da REVISÃO INDEPENDENTE (unidade A2, meses próprios) ----------------
CA2B=$(u 15)
okk H00 "conta extra na unidade A2 (para a prova de conta diferente)" "insert into fin_contas(id,organizacao_id,unidade_id,nome,tipo_conta) values ('$CA2B','$ORG_A','$UNI_A2','CAIXA A2','caixa_fisico')"
# #3 — quitação não pode ficar presa num mês fechado
obr $(u 130) $FA $CAT 2026-10-01 2026-10-10 10000 $UNI_A2 >/dev/null
pag $(u 230) $(u 130) $CA2 2026-10-10 10000 $ORG_A $UNI_A2 >/dev/null
pag $(u 231) $(u 130) $CA2 2026-11-02 1000 $ORG_A $UNI_A2 >/dev/null
neg H03a "#3 outubro com conta paga por inteiro em outubro (e pagamento extra em novembro) não fecha sem quitar" "fin2_divergencias_bloqueadoras" "select teste.fechar('$ORG_A','$UNI_A2','2026-10-01')"
okk H03b "#3 quitada (data = último pagamento, 02/11)" "select fin_obrigacao_quitar('$ORG_A','$UNI_A2','$USER','$(u 130)')"
eq H03c "#3 agora outubro fecha" "select teste.fechar('$ORG_A','$UNI_A2','2026-10-01')" "fechado"
okk H03d "#3 desfazer a quitação (novembro está aberto)" "select fin_obrigacao_desfazer_quitacao('$ORG_A','$UNI_A2','$USER','$(u 130)','Pagamento de novembro lançado em duplicidade')"
neg H03e "#3 cancelar o pagamento de novembro (deixaria a conta quitável só em outubro, fechado) é RECUSADO" "fin2_quitacao_em_mes_fechado" "update fin_pagamentos set status='cancelado', cancelado_por='$USER', cancelado_em=now(), motivo_cancelamento='Lançado em duplicidade' where id='$(u 231)'"
okk H03f "#3 a conta continua quitável (requitação em novembro)" "select fin_obrigacao_quitar('$ORG_A','$UNI_A2','$USER','$(u 130)')"
# #2 — sugestão que cruza um mês fechado continua descartável
obr $(u 131) $FA $CAT 2026-11-01 2026-11-30 20000 $UNI_A2 >/dev/null
pag $(u 232) $(u 131) $CA2 2026-11-30 20000 $ORG_A $UNI_A2 >/dev/null
sr "select fin_obrigacao_quitar('$ORG_A','$UNI_A2','$USER','$(u 131)')" >/dev/null
lanc $(u 330) $CA2 2026-12-01 20000 saida $CAT $ORG_A $UNI_A2 >/dev/null
vinc $(u 530) $(u 232) $(u 330) 20000 sugerido data_proxima $ORG_A $UNI_A2 >/dev/null
eq H02a "#2 novembro fecha com a sugestão pendente (sugestão não é divergência)" "select teste.fechar('$ORG_A','$UNI_A2','2026-11-01')" "fechado"
okk H02b "#2 a sugestão que cruza o mês fechado ainda pode ser REJEITADA" "update fin_conciliacao_saidas set status='rejeitado', rejeitado_por='$USER', rejeitado_em=now() where grupo='$(u 530)'"
okk H02c "#2 e a saída de dezembro volta a ser editável" "update fin_lancamentos set descricao='corrigida' , valor_centavos=19999 where id='$(u 330)'"
# #1 — uma saída pertence a um único grupo ativo
obr $(u 132) $FA $CAT 2026-12-01 2026-12-10 10000 $UNI_A2 >/dev/null
obr $(u 133) $FA $CAT 2026-12-01 2026-12-10 5000 $UNI_A2 >/dev/null
pag $(u 233) $(u 132) $CA2 2026-12-10 10000 $ORG_A $UNI_A2 >/dev/null
pag $(u 234) $(u 133) $CA2 2026-12-10 5000 $ORG_A $UNI_A2 >/dev/null
lanc $(u 331) $CA2 2026-12-10 10000 saida $CAT $ORG_A $UNI_A2 >/dev/null
vinc $(u 531) $(u 233) $(u 331) 10000 sugerido exato $ORG_A $UNI_A2 >/dev/null
sr "select fin_conciliacao_saida_confirmar('$ORG_A','$UNI_A2','$USER','$(u 531)',null)" >/dev/null
neg H01a "#1 segundo grupo DIVERGENTE na mesma saída já conciliada é recusado" "fin2_saida_ja_vinculada" "insert into fin_conciliacao_saidas(organizacao_id,unidade_id,grupo,pagamento_id,lancamento_id,valor_alocado_centavos,status,regra) values ('$ORG_A','$UNI_A2','$(u 532)','$(u 234)','$(u 331)',5000,'divergente','manual')"
eq H01b "#1 a saída continua com alocação = valor dela (nada acima)" "select sum(valor_alocado_centavos) from fin_conciliacao_saidas where lancamento_id='$(u 331)' and status in ('sugerido','conciliado','divergente')" "10000"
# #7 — categoria de saída vinculada
neg H07 "#7 trocar a categoria de uma saída conciliada (ex.: para transferência) é recusado" "fin2_lancamento_vinculado" "update fin_lancamentos set categoria_id='$CAT_TR' where id='$(u 331)'"
# #8 — evidência e autoria congeladas
neg H08a "#8 forjar a evidência de uma conciliação confirmada é recusado" "fin2_campo_via_funcao" "update fin_conciliacao_saidas set evidencia='{\"forjada\":true}' where grupo='$(u 531)'"
neg H08b "#8 trocar o autor da confirmação é recusado" "fin2_campo_via_funcao" "update fin_conciliacao_saidas set confirmado_por='$(u 777)' where grupo='$(u 531)'"
neg H08c "#8 trocar quem confirmou/quitou a obrigação é recusado" "fin2_transicao_via_funcao" "update fin_obrigacoes set quitada_em=now() - interval '30 days' where id='$(u 131)'"
# #6 — conta diferente exige justificativa
obr $(u 134) $FA $CAT 2026-12-01 2026-12-15 7000 $UNI_A2 >/dev/null
pag $(u 235) $(u 134) $CA2B 2026-12-15 7000 $ORG_A $UNI_A2 >/dev/null
lanc $(u 332) $CA2 2026-12-15 7000 saida $CAT $ORG_A $UNI_A2 >/dev/null
vinc $(u 533) $(u 235) $(u 332) 7000 sugerido manual $ORG_A $UNI_A2 >/dev/null
neg H06a "#6 pagamento no CAIXA × saída no BANCO (mesmo valor e data): confirmar sem justificativa é recusado" "fin2_justificativa_obrigatoria" "select fin_conciliacao_saida_confirmar('$ORG_A','$UNI_A2','$USER','$(u 533)',null)"
eq H06b "#6 com justificativa: concilia e a evidência registra a conta diferente" "select fin_conciliacao_saida_confirmar('$ORG_A','$UNI_A2','$USER','$(u 533)','Pago pelo caixa e depositado no banco no mesmo dia')->>'contaDiferente'" "true"
# #5 — pagamento provisório
obr $(u 135) $FA $CAT 2026-12-01 2026-12-20 3000 $UNI_A2 >/dev/null
okk H05a "#5 pagamento PROVISÓRIO (de operador) registrado" "insert into fin_pagamentos(id,organizacao_id,unidade_id,obrigacao_id,conta_id,data_pagamento,valor_centavos,provisorio) values ('$(u 236)','$ORG_A','$UNI_A2','$(u 135)','$CA2','2026-12-20',1000,true)"
eq H05b "#5 pagamento provisório aparece como bloqueio de dezembro" "select count(*) from jsonb_array_elements(fin2_bloqueios_fechamento('$ORG_A','$UNI_A2','2026-12-01')) x where x->>'tipo'='pagamento_provisorio' and x->>'ref'='$(u 236)'" "1"
neg H05c "#5 confirmar o pagamento provisório por UPDATE direto é recusado" "fin2_transicao_via_funcao" "update fin_pagamentos set provisorio=false where id='$(u 236)'"
okk H05d "#5 confirmação do registro" "select fin_obrigacao_confirmar_registro('$ORG_A','$UNI_A2','$USER','$(u 135)')"
eq H05e "#5 o pagamento provisório passa a confirmado, com autor" "select provisorio::text || '|' || (confirmado_por = '$USER')::text from fin_pagamentos where id='$(u 236)'" "false|true"
# #10 — provisória não reabre bloqueio de mês fechado
neg H10 "#10 devolver a PROVISÓRIA uma conta de competência fechada (outubro) é recusado" "fin_periodo_fechado" "update fin_obrigacoes set provisoria=true where id='$(u 130)'"

# ---------------- 2ª passada da revisão independente ----------------
# #3 (caminho restante), cenário do revisor: conta de competência JANEIRO/2027 (aberto), valor 150, paga 100 ANTECIPADAMENTE em dezembro;
# dezembro fecha (parcial não bloqueia). Reduzir o valor para 100 a deixaria paga por inteiro com o último pagamento num mês FECHADO.
obr $(u 140) $FA $CAT 2027-01-01 2027-01-10 15000 >/dev/null
pag $(u 240) $(u 140) $CA 2026-12-10 10000 >/dev/null
eq H11a "(2ª rev. #3) dezembro fecha com o pagamento antecipado parcial (parcial não bloqueia)" "select teste.fechar('$ORG_A','$UNI_A','2026-12-01')" "fechado"
neg H11b "(2ª rev. #3) reduzir o valor para 100 (quitável só em dezembro, fechado) é RECUSADO" "fin2_quitacao_em_mes_fechado" "update fin_obrigacoes set valor_original_centavos=10000 where id='$(u 140)'"
okk H11c "(2ª rev. #3) reduzir para um valor que ainda deixa saldo continua permitido" "update fin_obrigacoes set valor_original_centavos=12000 where id='$(u 140)'"
okk H11d "(2ª rev. #3) e a conta segue quitável: pagamento do saldo em janeiro" "insert into fin_pagamentos(organizacao_id,unidade_id,obrigacao_id,conta_id,data_pagamento,valor_centavos) values ('$ORG_A','$UNI_A','$(u 140)','$CA','2027-01-10',2000)"
eq H11e "(2ª rev. #3) quitada em janeiro (aberto)" "select fin_obrigacao_quitar('$ORG_A','$UNI_A','$USER','$(u 140)')->>'data_quitacao'" "2027-01-10"
# N1: classificar/reclassificar saída com vínculo ativo é livre; virar transferência continua recusado
CAT2=$(u 25)
okk H12a "(2ª rev. N1) nova categoria de despesa" "insert into fin_plano_contas(id,organizacao_id,tipo,natureza,nome,papel) values ('$CAT2','$ORG_A','DESPESA','VARIAVEL','EMBALAGENS','despesa_variavel')"
okk H12b "(2ª rev. N1) reclassificar entre despesas uma saída CONCILIADA é permitido (não exige revogar)" "update fin_lancamentos set categoria_id='$CAT2' where id='$(u 331)'"
neg H12c "(2ª rev. N1) mas virar transferência continua recusado" "fin2_lancamento_vinculado" "update fin_lancamentos set categoria_id='$CAT_TR' where id='$(u 331)'"
# INFO #8: diferença e dias do vínculo imutáveis
neg H13 "(2ª rev. #8) alterar diferenca/dias de um vínculo é recusado" "fin_campo_imutavel" "update fin_conciliacao_saidas set diferenca_centavos=-999, dias_diferenca=99 where grupo='$(u 531)'"

# ---------------- 3ª revisão independente ----------------
obr $(u 150) $FA $CAT 2027-02-01 2027-02-10 10000 >/dev/null
obr $(u 151) $FA $CAT 2027-02-01 2027-02-10 1000000 >/dev/null
pag $(u 250) $(u 150) $CA 2027-02-10 10000 >/dev/null
pag $(u 251) $(u 151) $CA 2027-02-10 1000000 >/dev/null
lanc $(u 350) $CA 2027-02-10 10000 >/dev/null
neg Z01 "(3ª rev. A-1) grupo DIVERGENTE com pagamentos acima da saída (R\$ 10.100 × R\$ 100) é recusado já na criação" "fin2_alocacao_excedida" "insert into fin_conciliacao_saidas(organizacao_id,unidade_id,grupo,pagamento_id,lancamento_id,valor_alocado_centavos,status,regra) values ('$ORG_A','$UNI_A','$(u 550)','$(u 250)','$(u 350)',10000,'divergente','manual'),('$ORG_A','$UNI_A','$(u 550)','$(u 251)','$(u 350)',1000000,'divergente','manual')"
neg Z02 "(3ª rev. M-1) alocação PARCIAL de pagamento é recusada" "fin2_alocacao_parcial" "insert into fin_conciliacao_saidas(organizacao_id,unidade_id,grupo,pagamento_id,lancamento_id,valor_alocado_centavos,status,regra) values ('$ORG_A','$UNI_A','$(u 551)','$(u 251)','$(u 350)',1,'sugerido','manual')"
vinc $(u 552) $(u 250) $(u 350) 10000 sugerido exato >/dev/null
sr "select fin_conciliacao_saida_confirmar('$ORG_A','$UNI_A','$USER','$(u 552)',null)" >/dev/null
obr $(u 152) $FA $CAT 2027-02-01 2027-02-10 500 >/dev/null; pag $(u 252) $(u 152) $CA 2027-02-10 500 >/dev/null
neg Z03 "(3ª rev. A-1/C1b) linha nova num grupo JÁ conciliado é recusada" "fin2_vinculo_encerrado_imutavel|fin2_alocacao_excedida" "insert into fin_conciliacao_saidas(organizacao_id,unidade_id,grupo,pagamento_id,lancamento_id,valor_alocado_centavos,status,regra) values ('$ORG_A','$UNI_A','$(u 552)','$(u 252)','$(u 350)',500,'divergente','manual')"
eq Z04 "(3ª rev. A-1) a saída continua com Σ conciliado = valor dela" "select sum(valor_alocado_centavos) from fin_conciliacao_saidas where lancamento_id='$(u 350)' and status in ('sugerido','conciliado','divergente')" "10000"
# M-2: pago a menor num mês que fechou → quitável no 1º mês aberto seguinte
obr $(u 153) $FA $CAT 2027-03-01 2027-03-05 10000 $UNI_A2 >/dev/null
pag $(u 253) $(u 153) $CA2 2027-03-05 9000 $ORG_A $UNI_A2 >/dev/null
eq Z05 "(3ª rev. M-2) março fecha (parcial não bloqueia)" "select teste.fechar('$ORG_A','$UNI_A2','2027-03-01')" "fechado"
eq Z06 "(3ª rev. M-2) a conta paga a menor continua QUITÁVEL: quitação datada no 1º mês aberto seguinte (abril)" "select fin_obrigacao_quitar('$ORG_A','$UNI_A2','$USER','$(u 153)')->>'data_quitacao'" "2027-04-01"
okk Z07 "(3ª rev. M-2) e a diferença (desconto) é classificada no mês aberto" "select fin_obrigacao_classificar('$ORG_A','$UNI_A2','$USER','$(u 153)','desconto')"
# B-1: REPEATABLE READ recusado
OUT=$(sr "begin isolation level repeatable read; insert into fin_fornecedores(organizacao_id,nome) values ('$ORG_A','RR teste'); insert into fin_obrigacoes(organizacao_id,unidade_id,fornecedor_id,categoria_id,descricao,competencia,vencimento,valor_original_centavos) values ('$ORG_A','$UNI_A','$FA','$CAT','x','2027-02-01','2027-02-10',100); commit;")
echo "$OUT" | grep -q "fin2_isolamento_invalido" && pass "Z08 (3ª rev. B-1) escrita do Financeiro 2.0 em REPEATABLE READ é recusada" || fail Z08 "$OUT"

# reverificação NOVO-1 / NOVO-2
OUT=$(sr "begin isolation level repeatable read; update fin_lancamentos set valor_centavos = 100 where id = '$(u 350)'; commit;")
echo "$OUT" | grep -q "fin2_isolamento_invalido" && pass "Z09 (NOVO-1) reduzir saída vinculada em REPEATABLE READ é recusado" || fail Z09 "$OUT"
okk Z10 "(NOVO-1) editar só a descrição de uma saída em REPEATABLE READ continua permitido (financeiro anterior intacto)" "begin isolation level repeatable read; update fin_lancamentos set descricao = 'nota' where id = '$(u 350)'; commit;"
obr $(u 154) $FA $CAT 2026-10-01 2026-10-05 10000 >/dev/null
pag $(u 254) $(u 154) $CA 2026-10-15 9000 >/dev/null
eq Z11a "(NOVO-2) outubro fecha na unidade A1 (pagamento parcial não bloqueia)" "select teste.fechar('$ORG_A','$UNI_A','2026-10-01')" "fechado"
eq Z11b "(NOVO-2) quitação com último pagamento em mês fechado cai no MÊS CORRENTE (data de hoje), não num mês passado ainda aberto" "select (fin_obrigacao_quitar('$ORG_A','$UNI_A','$USER','$(u 154)')->>'data_quitacao') = current_date::text" "t"

# ---------------- transferência de unidade com dados ----------------
OUT=$(su_ "select public.gestao_financeira_verificar_unidade_transferivel('$UNI_A')")
erro "$OUT" && pass "I08 unidade com contas a pagar NÃO pode ser transferida de empresa (guarda 120 conta as tabelas novas)" || fail "I08" "$OUT"

# ---------------- rollback ----------------
OUT=$($DONO -f "$M/151_rollback.sql" 2>&1); erro "$OUT" && echo "$OUT" | grep -q "ROLLBACK 151 recusado" && pass "R01 rollback recusado com dados (nada é perdido em silêncio)" || fail "R01" "$(echo "$OUT" | head -2)"
psql $H -U postgres -q -d postgres -c "drop database if exists ${DB}_rb" -c "create database ${DB}_rb owner dono_sim" >/dev/null 2>&1
psql $H -U postgres -q -d ${DB}_rb -c "grant all on schema public to dono_sim; grant usage on schema public to anon, authenticated, service_role" >/dev/null 2>&1
RB="psql $H -U dono_sim -d ${DB}_rb -q -v ON_ERROR_STOP=1"
$RB -c "alter default privileges in schema public grant all on tables to anon, authenticated, service_role; alter default privileges in schema public grant all on functions to anon, authenticated, service_role" >/dev/null 2>&1
$RB -f "$S/stub.sql" >/dev/null 2>&1
for f in 120_gestao_financeira_fundacao.sql 121_gestao_financeira_dominio.sql 122_conciliacao_periodos.sql 151_financeiro_2_contas_pagar.sql; do $RB -f "$M/$f" >/dev/null 2>&1; done
OUT=$($RB -f "$M/151_rollback.sql" 2>&1); OUT2=$($RB -f "$M/151_rollback.sql" 2>&1)
V=$(psql $H -U postgres -d ${DB}_rb -tA -c "select (select count(*) from pg_class where relname in ($TABS)) || '|' || (select count(*) from pg_proc where proname like 'fin2\_%' or proname like 'fin\_obrigac%' or proname like 'fin\_conciliacao\_saida%') || '|' || (select ('fin_obrigacoes' = any(public.gestao_financeira_tabelas_da_unidade()))::text) || '|' || (select pg_get_constraintdef(oid) from pg_constraint where conname='gestao_financeira_concessoes_nivel_check')")
if ! erro "$OUT" && ! erro "$OUT2" && [ "$V" = "0|0|false|CHECK ((nivel = ANY (ARRAY['leitura'::text, 'operador'::text, 'gestor'::text])))" ]; then pass "R02 rollback em banco sem dados: remove tudo, restaura lista e níveis; idempotente"; else fail "R02" "$V $(echo "$OUT $OUT2" | head -2)"; fi
OUT=$($RB -f "$M/151_financeiro_2_contas_pagar.sql" 2>&1); erro "$OUT" && fail "R03 reaplicação após rollback" "$OUT" || pass "R03 reaplicação após rollback"
printf '%s
' "create table fin_teste_futura (id uuid primary key, unidade_id uuid);
create or replace function public.gestao_financeira_tabelas_da_unidade() returns text[] language sql immutable set search_path = pg_catalog, pg_temp as \$\$ select array['gestao_financeira_concessoes','gestao_financeira_concessoes_auditoria','fin_contas','fin_saldos_abertura','fin_lancamentos','fin_transferencias','fin_periodos','fin_importacoes','fin_auditoria','fin_referencias','fin_conciliacao_resolucoes','fin_sangria_excecoes','fin_excecoes_fechamento','fin_obrigacoes','fin_pagamentos','fin_conciliacao_saidas','fin_teste_futura']::text[] \$\$;" | $RB -f - >/dev/null 2>&1
OUT=$($RB -f "$M/151_rollback.sql" 2>&1); erro "$OUT" && echo "$OUT" | grep -q "ROLLBACK 151 abortado" && pass "R04 (revisão #13) rollback recusa se uma tabela de migration futura ficaria fora da guarda de transferência" || fail "R04" "$(echo "$OUT" | grep -E 'ERRO|ERROR' | head -1)"
psql $H -U postgres -q -d postgres -c "drop database if exists ${DB}_rb" >/dev/null 2>&1

echo; echo "RESUMO: $NP PASS, $NF FAIL"
[ $NF = 0 ]
