#!/bin/bash
# ENSAIO do prod-migrar-fin2.mjs (migrations 153 → 154 → 155) num banco LOCAL DESCARTÁVEL que reproduz a produção ALVO: cadeia origin/main (estrut_base) + 120 → 121 → 122 → 126 → 151 → 152,
# com DADOS FINANCEIROS SINTÉTICOS já existentes (inclusive pagamentos da 151). Uso:
#   PG_CLUSTER_DIR=~/pg-descartavel bash backend/testes-seguros/producao/ensaio_prod_migrar_fin2.sh
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
S="$(cd "$(dirname "$0")" && pwd)"; R="$(cd "$S/../../.." && pwd)"; M="$R/database/migrations"
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR (cluster DESCARTÁVEL local com MARCADOR_DESCARTAVEL)}"
H="-h 127.0.0.1 -p 54321"; DB=fin20ensfin2
[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo "sem marcador: recusado"; exit 2; }
psql $H -U postgres -tAc "show data_directory" | grep -qF "$CLUSTER" || { echo "cluster inesperado: recusado"; exit 2; }
psql $H -U postgres -tAc "select 1 from pg_database where datname='estrut_base'" | grep -q 1 || { echo "falta estrut_base: rode antes backend/testes-seguros/pg/transferencia_unidades.sh"; exit 2; }
NP=0; NF=0; pass() { echo "PASS $1"; NP=$((NP+1)); }; fail() { echo "FAIL $1 :: $2"; NF=$((NF+1)); }
su_() { printf '%s\n' "$1" | psql $H -U postgres -d $DB -q -tA -v ON_ERROR_STOP=1 -f - 2>&1; }
u() { printf '00000000-0000-4000-8000-%012d' "$1"; }
novo() { # $1 = "sem152" simula produção SEM a 152
  psql $H -U postgres -q -d postgres -c "drop database if exists $DB with (force)" -c "create database $DB owner dono_sim template estrut_base" 2>&1 | grep -v NOTICE
  LISTA="120_gestao_financeira_fundacao.sql 121_gestao_financeira_dominio.sql 122_conciliacao_periodos.sql 126_financeiro_autoconcessao_superadmin.sql 151_financeiro_2_contas_pagar.sql"; [ "$1" = "sem152" ] || LISTA="$LISTA 152_financeiro_2_rateios_recebiveis_dividas.sql"
  for f in $LISTA; do psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d $DB -f "$M/$f" >/dev/null 2>&1 || { echo "base $f falhou"; exit 1; }; done
  su_ "insert into organizacoes(id,nome) values ('$(u 1)','[ENS] Empresa existente'); insert into unidades(id,organizacao_id,nome) values ('$(u 2)','$(u 1)','[ENS] Loja');
       set role service_role;
       insert into fin_contas(id,organizacao_id,unidade_id,nome,tipo_conta) values ('$(u 3)','$(u 1)','$(u 2)','BANCO','banco');
       insert into fin_plano_contas(id,organizacao_id,tipo,natureza,nome,papel) values ('$(u 4)','$(u 1)','DESPESA','FIXA','ALUGUEL','despesa_fixa');
       insert into fin_lancamentos(organizacao_id,unidade_id,conta_id,categoria_id,descricao,sentido,valor_centavos,data_movimento) values ('$(u 1)','$(u 2)','$(u 3)','$(u 4)','aluguel','saida',150000,'2026-09-05');
       insert into fin_fornecedores(id,organizacao_id,nome) values ('$(u 5)','$(u 1)','Fornecedor');
       insert into fin_obrigacoes(id,organizacao_id,unidade_id,fornecedor_id,categoria_id,descricao,competencia,vencimento,valor_original_centavos) values ('$(u 6)','$(u 1)','$(u 2)','$(u 5)','$(u 4)','aluguel','2026-09-01','2026-09-05',150000);
       insert into fin_pagamentos(organizacao_id,unidade_id,obrigacao_id,conta_id,data_pagamento,valor_centavos) values ('$(u 1)','$(u 2)','$(u 6)','$(u 3)','2026-09-05',150000);" >/dev/null
}
EVD="$(mktemp -d)"; trap 'rm -rf "$EVD"' EXIT
psql $H -U postgres -q -d postgres -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname='operador_ens') then create role operador_ens login nosuperuser bypassrls; end if; end \$\$; grant dono_sim to operador_ens;" >/dev/null 2>&1
roda() { PROD_ENSAIO_LOCAL=1 PROD_CONN="postgresql://operador_ens@127.0.0.1:54321/$DB" PROD_EVIDENCIAS="$EVD" node "$S/prod-migrar-fin2.mjs" "$@" 2>&1; }
AGORA=$(date -u +%Y-%m-%dT%H:%MZ)
ident() { roda preflight "$1" | sed -n 's/^PROD_IDENTIDADE=//p'; }
exporta() { PROD_IDENTIDADE=$1 roda exportar "$2" | sed -n 's/^PROD_EXPORTACAO=//p'; }
aplica() { PROD_IDENTIDADE=$1 PROD_EXPORTACAO=$2 PROD_BACKUP_CONFIRMADO=SIM PROD_BACKUP_TIPO=pitr PROD_BACKUP_HORARIO=$AGORA PROD_AUTORIZO=SIM roda aplicar "$3"; }
imp() { su_ "select md5(string_agg(t::text,'|' order by t::text)) from (select * from fin_lancamentos) t"; }
impp() { su_ "select md5(string_agg((to_jsonb(t) - 'origem_pagamento' - 'terceiro_nome' - 'divida_id')::text,'|' order by (to_jsonb(t) - 'origem_pagamento' - 'terceiro_nome' - 'divida_id')::text)) from fin_pagamentos t"; }

novo sem152
OUT=$(roda preflight 153); echo "$OUT" | grep -q "dependência ausente: tabelas_152" && echo "$OUT" | grep -q "NÃO APLICAR" && pass "Q01 produção SEM a 152 → preflight 153 NÃO APLICAR" || fail Q01 "$(echo "$OUT" | tail -3)"

novo
OUT=$(roda conferir); echo "$OUT" | grep -q "152: sim | 153: não | 154: não | 155: não" && echo "$OUT" | grep -q "versão da 152" && pass "Q02 conferir (somente leitura): 152 aplicada, 153–155 ainda não" || fail Q02 "$(echo "$OUT" | tail -3)"
OUT=$(roda preflight 154); echo "$OUT" | grep -q "a 153 precisa estar aplicada antes da 154" && pass "Q03 ordem: 154 sem a 153 → recusada" || fail Q03 "$(echo "$OUT" | tail -3)"
OUT=$(roda preflight 155); echo "$OUT" | grep -q "a 154 precisa estar aplicada antes da 155" && pass "Q04 ordem: 155 sem a 154 → recusada" || fail Q04 "$(echo "$OUT" | tail -3)"
roda conferir >/dev/null; BASE=$(ls -t "$EVD"/fin2-estado-conferir-*.log | head -1)
ID=$(ident 153); OUT=$(roda preflight 153); echo "$OUT" | grep -q "PREFLIGHT 153: OK" && [ -n "$ID" ] && pass "Q05 preflight 153 OK com identidade" || fail Q05 "$(echo "$OUT" | tail -3)"
EXP=$(exporta $ID 153); [ -n "$EXP" ] && pass "Q06 exportação financeira conferida (todas as tabelas fin_*)" || fail Q06 "sem exportação"
OUT=$(PROD_IDENTIDADE=$ID PROD_EXPORTACAO=$EXP PROD_AUTORIZO=SIM roda aplicar 153); echo "$OUT" | grep -q "RECUSADO" && ! su_ "select to_regclass('fin_vendas_canal') is not null" | grep -q t && pass "Q07 aplicar 153 SEM backup confirmado é recusado (nada criado)" || fail Q07 "$(echo "$OUT" | tail -3)"
OUT=$(PROD_SHA153_ESPERADO=$(printf '0%.0s' $(seq 64)) PROD_IDENTIDADE=$ID roda preflight 153); echo "$OUT" | grep -q "arquivo diferente do revisado" && pass "Q08 sha256 diferente do revisado é recusado" || fail Q08 "$(echo "$OUT" | tail -2)"
A1=$(imp); AP1=$(impp)
OUT=$(aplica $ID $EXP 153); echo "$OUT" | grep -q "RESULTADO 153: OK" && [ "$A1" = "$(imp)" ] && pass "Q09 aplicar 153: tabelas criadas, nada existente mudou" || fail Q09 "$(echo "$OUT" | tail -3)"
OUT=$(PROD_IDENTIDADE=$ID roda verificar 153); echo "$OUT" | grep -q "VERIFICAÇÃO 153: OK" && pass "Q10 verificar 153" || fail Q10 "$(echo "$OUT" | tail -3)"
OUT=$(roda preflight 153); echo "$OUT" | grep -q "objetos da 153 já existem" && pass "Q11 reaplicar a 153 é recusado" || fail Q11 "$(echo "$OUT" | tail -2)"
ID=$(ident 154); EXP=$(exporta $ID 154); OUT=$(aplica $ID $EXP 154)
echo "$OUT" | grep -q "RESULTADO 154: OK" && [ "$AP1" = "$(impp)" ] && pass "Q12 aplicar 154: colunas novas; conteúdo antigo de fin_pagamentos IDÊNTICO" || fail Q12 "$(echo "$OUT" | tail -3)"
su_ "select count(*) from fin_pagamentos where origem_pagamento <> 'conta'" | grep -q '^0$' && pass "Q13 todo pagamento existente continua com origem 'conta'" || fail Q13 "pagamento fora de 'conta'"
su_ "select is_nullable from information_schema.columns where table_name='fin_pagamentos' and column_name='conta_id'" | grep -q YES && pass "Q14 conta_id agora opcional (origem pendente / por terceiro)" || fail Q14 "conta_id ainda obrigatório"
OUT=$(PROD_IDENTIDADE=$ID roda verificar 154); echo "$OUT" | grep -q "VERIFICAÇÃO 154: OK" && pass "Q15 verificar 154" || fail Q15 "$(echo "$OUT" | tail -3)"
ID=$(ident 155); EXP=$(exporta $ID 155); OUT=$(aplica $ID $EXP 155)
echo "$OUT" | grep -q "RESULTADO 155: OK" && [ "$A1" = "$(imp)" ] && pass "Q16 aplicar 155: tabelas e funções 1:N; lançamentos idênticos" || fail Q16 "$(echo "$OUT" | tail -3)"
OUT=$(PROD_IDENTIDADE=$ID roda verificar 155); echo "$OUT" | grep -q "VERIFICAÇÃO 155: OK" && pass "Q17 verificar 155" || fail Q17 "$(echo "$OUT" | tail -3)"
OUT=$(roda conferir); echo "$OUT" | grep -q "152: sim | 153: sim | 154: sim | 155: sim" && echo "$OUT" | grep -q "guarda: inalterada" && pass "Q18 conferir após tudo: 152–155 aplicadas e guarda de transferência inalterada" || fail Q18 "$(echo "$OUT" | tail -3)"
OUT=$(PROD_COMPARAR_COM="$BASE" roda conferir); echo "$OUT" | grep -q "CONTEÚDO alterado: nenhuma" && echo "$OUT" | grep -q "tabelas novas: fin_" && pass "Q18b conferir comparado com o estado ANTES: nenhuma tabela existente mudou; só as novas apareceram" || fail Q18b "$(echo "$OUT" | tail -3)"
OUT=$(su_ "select gestao_financeira_verificar_unidade_transferivel('$(u 2)');"); echo "$OUT" | grep -q "não pode ser transferida" && pass "Q19 guarda de transferência continua barrando a loja com dados" || fail Q19 "$OUT"
OUT=$(PROD_IDENTIDADE=$ID PROD_AUTORIZO_REVERSAO=SIM roda reverter 154); echo "$OUT" | grep -q "reverta a 155 antes da 154" && pass "Q20 reversão em ordem inversa: 154 antes da 155 é recusada" || fail Q20 "$(echo "$OUT" | tail -2)"
su_ "set role service_role; insert into fin_vendas_canal(organizacao_id,unidade_id,competencia,canal,valor_painel_centavos,valor_gerencial_centavos,fonte) values ('$(u 1)','$(u 2)','2026-09-01','Balcao',100000,100000,'ensaio');" >/dev/null
OUT=$(PROD_IDENTIDADE=$ID PROD_AUTORIZO_REVERSAO=SIM roda reverter 155); echo "$OUT" | grep -q "REVERSÃO 155: OK" && pass "Q21 reverter 155 (vazia) volta ao estado anterior" || fail Q21 "$(echo "$OUT" | tail -3)"
OUT=$(PROD_IDENTIDADE=$ID PROD_AUTORIZO_REVERSAO=SIM roda reverter 154); echo "$OUT" | grep -q "REVERSÃO 154: OK" && pass "Q22 reverter 154 (sem pagamento fora de 'conta') volta ao estado anterior" || fail Q22 "$(echo "$OUT" | tail -3)"
OUT=$(PROD_IDENTIDADE=$ID PROD_AUTORIZO_REVERSAO=SIM roda reverter 153); echo "$OUT" | grep -q "REVERSÃO RECUSADA" && su_ "select to_regclass('fin_vendas_canal') is not null" | grep -q t && pass "Q23 reverter 153 COM dados é RECUSADO (nada apagado)" || fail Q23 "$(echo "$OUT" | tail -3)"
[ "$AP1" = "$(impp)" ] && [ "$A1" = "$(imp)" ] && pass "Q24 após as reversões, o conteúdo financeiro existente continua idêntico" || fail Q24 "conteúdo mudou"

novo
su_ "create or replace function public.gestao_financeira_tabelas_da_unidade() returns text[] language sql immutable set search_path = pg_catalog, pg_temp as \$\$ select array['fin_contas']::text[] \$\$;" >/dev/null
OUT=$(roda preflight 153); echo "$OUT" | grep -q "DIFERE da versão esperada" && echo "$OUT" | grep -q "NÃO APLICAR" && pass "Q25 lista de tabelas alterada em produção → preflight NÃO APLICAR" || fail Q25 "$(echo "$OUT" | tail -3)"
OUT=$(PROD_CONN="postgresql://postgres:x@db.wiqqsxnysbzhcrzrrean.supabase.co:5432/postgres?sslmode=require" node "$S/prod-migrar-fin2.mjs" preflight 153 2>&1); echo "$OUT" | grep -q "projeto de TESTES" && pass "Q26 conexão do projeto de testes é recusada" || fail Q26 "$(echo "$OUT" | tail -2)"
OUT=$(PROD_SO_TRAVAS=1 PROD_CONN="postgresql://postgres:x@db.uqybgauuxcrqzquultfu.supabase.co:5432/#?host=127.0.0.1" node "$S/prod-migrar-fin2.mjs" preflight 153 2>&1); echo "$OUT" | grep -q "contém '#'" && pass "Q27 desvio de destino por '#?host=' é recusado" || fail Q27 "$(echo "$OUT" | tail -2)"
OUT=$(node "$S/prod-migrar-fin2.mjs" preflight 999 2>&1); echo "$OUT" | grep -q "informe a migration" && pass "Q28 número de migration inválido é recusado" || fail Q28 "$(echo "$OUT" | tail -2)"
psql $H -U postgres -q -d postgres -c "drop database if exists $DB with (force)" >/dev/null 2>&1
echo; echo "RESUMO: $NP PASS, $NF FAIL"; [ $NF = 0 ]
