#!/bin/bash
# ENSAIO DE RECUPERAÇÃO DE DADOS (não só de schema) do Financeiro — LOCAL DESCARTÁVEL.
# Prova o procedimento lógico do plano (§6): exportar os dados financeiros (fin_* e gestao_financeira_*) ANTES da janela, e restaurá-los
# num banco limpo com o mesmo schema, com conteúdo IDÊNTICO (impressão digital md5 por tabela). Complementa o PITR do Supabase (que só o
# operador confere no painel). Uso: PG_CLUSTER_DIR=~/pg-descartavel bash backend/testes-seguros/producao/ensaio_recuperacao_151.sh
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
S="$(cd "$(dirname "$0")" && pwd)"; R="$(cd "$S/../../.." && pwd)"; M="$R/database/migrations"
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR}"; H="-h 127.0.0.1 -p 54321"
[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo "sem marcador: recusado"; exit 2; }
psql $H -U postgres -tAc "show data_directory" | grep -qF "$CLUSTER" || { echo "cluster inesperado: recusado"; exit 2; }
TMP="$(mktemp -d)"; [ -n "$MANTER" ] && echo "TMP=$TMP" || trap 'rm -rf "$TMP"' EXIT
NP=0; NF=0; pass() { echo "PASS $1"; NP=$((NP+1)); }; fail() { echo "FAIL $1 :: $2"; NF=$((NF+1)); }
q() { printf '%s\n' "$2" | psql $H -U postgres -d "$1" -q -tA -v ON_ERROR_STOP=1 -f - 2>&1; }
montar() { # banco com o schema de produção + 151, sem dados financeiros
  psql $H -U postgres -q -d postgres -c "drop database if exists $1 with (force)" -c "create database $1 owner dono_sim template estrut_base" 2>&1 | grep -v NOTICE
  for f in 120_gestao_financeira_fundacao.sql 121_gestao_financeira_dominio.sql 122_conciliacao_periodos.sql 126_financeiro_autoconcessao_superadmin.sql 151_financeiro_2_contas_pagar.sql; do
    psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d $1 -f "$M/$f" >/dev/null 2>&1 || { echo "schema $f falhou"; exit 1; }
  done; }
IMP="select string_agg(relname || '=' || (xpath('/row/h/text()', query_to_xml(format('select count(*) || '':'' || md5(coalesce(string_agg(t::text, ''|'' order by t::text), '''')) as h from public.%I t', relname), false, true, '')))[1]::text, E'\n' order by relname)
       from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and (relname like 'fin\\_%' or relname like 'gestao\\_financeira\\_%')"
U() { printf '00000000-0000-4000-8000-%012d' "$1"; }
montar fin20orig
q fin20orig "insert into organizacoes(id,nome) values ('$(U 1)','[REC] QA sintética'); insert into unidades(id,organizacao_id,nome) values ('$(U 2)','$(U 1)','[REC] Loja');
set role service_role;
insert into fin_contas(id,organizacao_id,unidade_id,nome,tipo_conta) values ('$(U 3)','$(U 1)','$(U 2)','BANCO','banco');
insert into fin_plano_contas(id,organizacao_id,tipo,natureza,nome,papel) values ('$(U 4)','$(U 1)','DESPESA','FIXA','INSUMOS','despesa_fixa');
insert into fin_lancamentos(id,organizacao_id,unidade_id,conta_id,categoria_id,descricao,sentido,valor_centavos,data_movimento) values ('$(U 5)','$(U 1)','$(U 2)','$(U 3)','$(U 4)','PIX','saida',83241,'2026-09-18');
insert into fin_fornecedores(id,organizacao_id,nome) values ('$(U 6)','$(U 1)','Embalagens sintéticas');
insert into fin_obrigacoes(id,organizacao_id,unidade_id,fornecedor_id,categoria_id,descricao,competencia,vencimento,valor_original_centavos) values ('$(U 7)','$(U 1)','$(U 2)','$(U 6)','$(U 4)','Copos','2026-09-01','2026-09-12',81000);
insert into fin_pagamentos(id,organizacao_id,unidade_id,obrigacao_id,conta_id,data_pagamento,valor_centavos) values ('$(U 8)','$(U 1)','$(U 2)','$(U 7)','$(U 3)','2026-09-18',83241);
select fin_obrigacao_quitar('$(U 1)','$(U 2)','$(U 9)','$(U 7)');
select fin_obrigacao_classificar('$(U 1)','$(U 2)','$(U 9)','$(U 7)','juros');
insert into fin_conciliacao_saidas(organizacao_id,unidade_id,grupo,pagamento_id,lancamento_id,valor_alocado_centavos,status,regra) values ('$(U 1)','$(U 2)','$(U 10)','$(U 8)','$(U 5)',83241,'sugerido','exato');
select fin_conciliacao_saida_confirmar('$(U 1)','$(U 2)','$(U 9)','$(U 10)',null);" >/dev/null || { echo "seed falhou"; exit 1; }
ANTES=$(q fin20orig "$IMP")
echo "$ANTES" | grep -q "^fin_obrigacoes=1:" && echo "$ANTES" | grep -q "^fin_auditoria=" && pass "R01 banco de origem com dados financeiros (incl. 151, auditoria e período)" || fail R01 "$ANTES"
# 1) EXPORTAR (o que o operador faz ANTES da janela; o arquivo fica fora do Git e com acesso restrito)
pg_dump $H -U postgres -d fin20orig --data-only --format=custom -t 'public.fin_*' -t 'public.gestao_financeira_*' -f "$TMP/fin.dump" 2>"$TMP/dump.err" && pass "R02 exportação lógica dos dados financeiros (pg_dump --data-only, padrões fin_* e gestao_financeira_*)" || fail R02 "$(head -2 $TMP/dump.err)"
NT=$(q fin20orig "select count(*) from pg_class where relnamespace='public'::regnamespace and relkind='r' and (relname like 'fin\_%' or relname like 'gestao\_financeira\_%')" | tr -d '')
ND=$(pg_restore -l "$TMP/fin.dump" | grep -c "TABLE DATA public \(fin_\|gestao_financeira_\)")
[ "$NT" = "$ND" ] && [ "$NT" -gt 15 ] && pass "R02b o dump contém TODAS as $NT tabelas financeiras (conferência obrigatória antes da janela)" || fail R02b "tabelas=$NT no dump=$ND"
# 2) RESTAURAR num banco limpo com o mesmo schema (organizações/unidades = dados de plataforma, que o PITR cobre; aqui recriadas)
montar fin20rest
q fin20rest "insert into organizacoes(id,nome) values ('$(U 1)','[REC] QA sintética'); insert into unidades(id,organizacao_id,nome) values ('$(U 2)','$(U 1)','[REC] Loja');" >/dev/null
pg_restore $H -U postgres -d fin20rest --data-only --disable-triggers --single-transaction "$TMP/fin.dump" 2>"$TMP/rest.err" && pass "R03 restauração em banco limpo (uma transação; gatilhos desligados só durante a carga)" || fail R03 "$(head -3 $TMP/rest.err)"
DEPOIS=$(q fin20rest "$IMP")
[ "$ANTES" = "$DEPOIS" ] && pass "R04 conteúdo restaurado IDÊNTICO ao original em TODAS as tabelas financeiras (md5 por tabela)" || fail R04 "$(diff <(echo "$ANTES") <(echo "$DEPOIS") | head -6)"
# 3) depois da restauração as regras continuam valendo (gatilhos religados)
OUT=$(q fin20rest "set role service_role; update fin_obrigacoes set valor_original_centavos = 1 where id = '$(U 7)';")
echo "$OUT" | grep -q "fin2_obrigacao_quitada" && pass "R05 após a restauração as travas do banco voltam a valer (conta quitada não muda de valor)" || fail R05 "$OUT"
OUT=$(q fin20rest "set role service_role; select count(*) from fin_auditoria;")
[ "$OUT" = "$(q fin20orig "set role service_role; select count(*) from fin_auditoria;")" ] && pass "R06 trilha de auditoria restaurada sem duplicar (gatilhos de auditoria não disparam na carga)" || fail R06 "$OUT"
[ -n "$MANTER" ] || psql $H -U postgres -q -d postgres -c "drop database if exists fin20orig with (force)" -c "drop database if exists fin20rest with (force)" >/dev/null 2>&1
echo; echo "RESUMO: $NP PASS, $NF FAIL"; [ $NF = 0 ]
