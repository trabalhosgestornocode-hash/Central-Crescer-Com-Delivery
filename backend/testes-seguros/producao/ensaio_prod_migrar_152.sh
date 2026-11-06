#!/bin/bash
# ENSAIO do prod-migrar-152.mjs num banco LOCAL DESCARTÁVEL que reproduz a produção ATUAL: cadeia origin/main (estrut_base) + 120 → 121 → 122 → 126 → 151,
# com DADOS FINANCEIROS SINTÉTICOS já existentes (inclusive contas a pagar da 151). Uso:
#   PG_CLUSTER_DIR=~/pg-descartavel bash backend/testes-seguros/producao/ensaio_prod_migrar_152.sh
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
S="$(cd "$(dirname "$0")" && pwd)"; R="$(cd "$S/../../.." && pwd)"; M="$R/database/migrations"
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR (cluster DESCARTÁVEL local com MARCADOR_DESCARTAVEL)}"
H="-h 127.0.0.1 -p 54321"; DB=fin20ens152
[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo "sem marcador: recusado"; exit 2; }
psql $H -U postgres -tAc "show data_directory" | grep -qF "$CLUSTER" || { echo "cluster inesperado: recusado"; exit 2; }
psql $H -U postgres -tAc "select 1 from pg_database where datname='estrut_base'" | grep -q 1 || { echo "falta estrut_base: rode antes backend/testes-seguros/pg/transferencia_unidades.sh"; exit 2; }
NP=0; NF=0; pass() { echo "PASS $1"; NP=$((NP+1)); }; fail() { echo "FAIL $1 :: $2"; NF=$((NF+1)); }
su_() { printf '%s\n' "$1" | psql $H -U postgres -d $DB -q -tA -v ON_ERROR_STOP=1 -f - 2>&1; }
u() { printf '00000000-0000-4000-8000-%012d' "$1"; }
novo() { # $1 = "sem151" para simular produção SEM a 151
  psql $H -U postgres -q -d postgres -c "drop database if exists $DB with (force)" -c "create database $DB owner dono_sim template estrut_base" 2>&1 | grep -v NOTICE
  LISTA="120_gestao_financeira_fundacao.sql 121_gestao_financeira_dominio.sql 122_conciliacao_periodos.sql 126_financeiro_autoconcessao_superadmin.sql"; [ "$1" = "sem151" ] || LISTA="$LISTA 151_financeiro_2_contas_pagar.sql"
  for f in $LISTA; do psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d $DB -f "$M/$f" >/dev/null 2>&1 || { echo "base $f falhou"; exit 1; }; done
  su_ "insert into organizacoes(id,nome) values ('$(u 1)','[ENS] Empresa existente'); insert into unidades(id,organizacao_id,nome) values ('$(u 2)','$(u 1)','[ENS] Loja');
       set role service_role;
       insert into fin_contas(id,organizacao_id,unidade_id,nome,tipo_conta) values ('$(u 3)','$(u 1)','$(u 2)','BANCO','banco');
       insert into fin_plano_contas(id,organizacao_id,tipo,natureza,nome,papel) values ('$(u 4)','$(u 1)','DESPESA','FIXA','ALUGUEL','despesa_fixa');
       insert into fin_lancamentos(organizacao_id,unidade_id,conta_id,categoria_id,descricao,sentido,valor_centavos,data_movimento) values ('$(u 1)','$(u 2)','$(u 3)','$(u 4)','aluguel','saida',150000,'2026-09-05');" >/dev/null
  [ "$1" = "sem151" ] || su_ "set role service_role; insert into fin_fornecedores(id,organizacao_id,nome) values ('$(u 5)','$(u 1)','Fornecedor');
       insert into fin_obrigacoes(id,organizacao_id,unidade_id,fornecedor_id,categoria_id,descricao,competencia,vencimento,valor_original_centavos) values ('$(u 6)','$(u 1)','$(u 2)','$(u 5)','$(u 4)','aluguel','2026-09-01','2026-09-05',150000);
       insert into fin_pagamentos(organizacao_id,unidade_id,obrigacao_id,conta_id,data_pagamento,valor_centavos) values ('$(u 1)','$(u 2)','$(u 6)','$(u 3)','2026-09-05',150000);" >/dev/null
}
EVD="$(mktemp -d)"; trap 'rm -rf "$EVD"' EXIT
psql $H -U postgres -q -d postgres -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname='operador_ens') then create role operador_ens login nosuperuser bypassrls; end if; end \$\$; grant dono_sim to operador_ens;" >/dev/null 2>&1
roda() { PROD_ENSAIO_LOCAL=1 PROD_CONN="postgresql://operador_ens@127.0.0.1:54321/$DB" PROD_EVIDENCIAS="$EVD" node "$S/prod-migrar-152.mjs" "$@" 2>&1; }
AGORA=$(date -u +%Y-%m-%dT%H:%MZ)

novo sem151
OUT=$(roda preflight); echo "$OUT" | grep -q "dependência ausente: tabelas_151" && echo "$OUT" | grep -q "NÃO APLICAR" && pass "P01 produção SEM a 151 → preflight NÃO APLICAR" || fail P01 "$(echo "$OUT" | tail -3)"

novo
OUT=$(roda preflight); IDENT=$(echo "$OUT" | sed -n 's/^PROD_IDENTIDADE=//p')
echo "$OUT" | grep -q "PREFLIGHT: OK" && [ -n "$IDENT" ] && pass "P02 produção com a 151 → PREFLIGHT: OK e identidade" || fail P02 "$(echo "$OUT" | tail -4)"
OUT=$(PROD_IDENTIDADE=$IDENT roda exportar); EXP=$(echo "$OUT" | sed -n 's/^PROD_EXPORTACAO=//p')
echo "$OUT" | grep -q "EXPORTAÇÃO: OK" && [ -n "$EXP" ] && pass "P03 exportação financeira (inclui as tabelas da 151) conferida" || fail P03 "$(echo "$OUT" | tail -3)"
OUT=$(PROD_IDENTIDADE=$IDENT PROD_EXPORTACAO=$EXP PROD_AUTORIZO=SIM roda aplicar); echo "$OUT" | grep -q "RECUSADO" && ! su_ "select to_regclass('fin_rateios') is not null" | grep -q t && pass "P04 aplicar SEM backup confirmado é recusado (nada criado)" || fail P04 "$(echo "$OUT" | tail -2)"
OUT=$(PROD_SHA152_ESPERADO=$(printf '0%.0s' $(seq 64)) PROD_IDENTIDADE=$IDENT roda preflight); echo "$OUT" | grep -q "arquivo diferente do revisado" && pass "P05 sha256 da 152 diferente do revisado é recusado" || fail P05 "$(echo "$OUT" | tail -2)"
ANTES=$(su_ "select md5(string_agg(t::text,'|' order by t::text)) from (select * from fin_obrigacoes union all select * from fin_obrigacoes where false) t")
OUT=$(PROD_IDENTIDADE=$IDENT PROD_EXPORTACAO=$EXP PROD_BACKUP_CONFIRMADO=SIM PROD_BACKUP_TIPO=pitr PROD_BACKUP_HORARIO=$AGORA PROD_AUTORIZO=SIM roda aplicar)
DEPOIS=$(su_ "select md5(string_agg(t::text,'|' order by t::text)) from (select * from fin_obrigacoes union all select * from fin_obrigacoes where false) t")
echo "$OUT" | grep -q "RESULTADO: OK — 152 aplicada" && [ "$ANTES" = "$DEPOIS" ] && pass "P06 aplicar com backup e exportação: 152 criada; contas a pagar da 151 idênticas" || fail P06 "$(echo "$OUT" | tail -3)"
OUT=$(PROD_IDENTIDADE=$IDENT roda verificar); echo "$OUT" | grep -q "VERIFICAÇÃO: OK — 152 completa" && pass "P07 verificar após a aplicação" || fail P07 "$(echo "$OUT" | tail -3)"
OUT=$(roda preflight); echo "$OUT" | grep -q "objetos da 152 já existem" && pass "P08 preflight após aplicar recusa reaplicar (objetos já existem)" || fail P08 "$(echo "$OUT" | tail -2)"
OUT=$(su_ "select gestao_financeira_verificar_unidade_transferivel('$(u 2)');" ); echo "$OUT" | grep -q "não pode ser transferida" && pass "P09 guarda de transferência continua barrando a loja com dados" || fail P09 "$OUT"
su_ "set role service_role; insert into fin_dividas(organizacao_id,unidade_id,natureza,credor) values ('$(u 1)','$(u 2)','propria','Banco');" >/dev/null
OUT=$(PROD_IDENTIDADE=$IDENT PROD_AUTORIZO_REVERSAO=SIM roda reverter); echo "$OUT" | grep -q "REVERSÃO RECUSADA" && su_ "select to_regclass('fin_dividas') is not null" | grep -q t && pass "P10 reverter com dados da 152 é RECUSADO (nada apagado)" || fail P10 "$(echo "$OUT" | tail -2)"

novo
OUT=$(roda preflight); IDENT=$(echo "$OUT" | sed -n 's/^PROD_IDENTIDADE=//p'); OUT=$(PROD_IDENTIDADE=$IDENT roda exportar); EXP=$(echo "$OUT" | sed -n 's/^PROD_EXPORTACAO=//p')
PROD_IDENTIDADE=$IDENT PROD_EXPORTACAO=$EXP PROD_BACKUP_CONFIRMADO=SIM PROD_BACKUP_TIPO=pitr PROD_BACKUP_HORARIO=$AGORA PROD_AUTORIZO=SIM roda aplicar >/dev/null
OUT=$(PROD_IDENTIDADE=$IDENT PROD_AUTORIZO_REVERSAO=SIM roda reverter); echo "$OUT" | grep -q "REVERSÃO: OK" && pass "P11 reverter sem dados volta exatamente ao estado da 151" || fail P11 "$(echo "$OUT" | tail -3)"
OUT=$(roda preflight); echo "$OUT" | grep -q "PREFLIGHT: OK" && pass "P12 após reverter, o preflight volta a aceitar (lista de tabelas = versão da 151)" || fail P12 "$(echo "$OUT" | tail -3)"

novo
su_ "create or replace function public.gestao_financeira_tabelas_da_unidade() returns text[] language sql immutable set search_path = pg_catalog, pg_temp as \$\$ select array['fin_contas']::text[] \$\$;" >/dev/null
OUT=$(roda preflight); echo "$OUT" | grep -q "DIFERE da versão da 151" && echo "$OUT" | grep -q "NÃO APLICAR" && pass "P13 lista de tabelas alterada em produção → preflight NÃO APLICAR" || fail P13 "$(echo "$OUT" | tail -3)"
OUT=$(PROD_CONN="postgresql://postgres:x@db.wiqqsxnysbzhcrzrrean.supabase.co:5432/postgres?sslmode=require" node "$S/prod-migrar-152.mjs" preflight 2>&1); echo "$OUT" | grep -q "projeto de TESTES" && pass "P14 conexão do projeto de testes é recusada (mesmas travas da 151)" || fail P14 "$OUT"
OUT=$(PROD_SO_TRAVAS=1 PROD_CONN="postgresql://postgres:x@db.uqybgauuxcrqzquultfu.supabase.co:5432/#?host=127.0.0.1" node "$S/prod-migrar-152.mjs" preflight 2>&1); echo "$OUT" | grep -q "contém '#'" && pass "P15 desvio de destino por '#?host=' é recusado" || fail P15 "$OUT"
psql $H -U postgres -q -d postgres -c "drop database if exists $DB with (force)" >/dev/null 2>&1
echo; echo "RESUMO: $NP PASS, $NF FAIL"; [ $NF = 0 ]
