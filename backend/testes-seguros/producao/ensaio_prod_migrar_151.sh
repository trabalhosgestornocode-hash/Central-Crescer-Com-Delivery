#!/bin/bash
# ENSAIO do prod-migrar-151.mjs num banco LOCAL DESCARTÁVEL que reproduz produção: cadeia origin/main (estrut_base, montada por
# backend/testes-seguros/pg/transferencia_unidades.sh) + 120 → 121 → 122 → 126, com DADOS FINANCEIROS SINTÉTICOS já existentes.
# Conecta como dono_sim (dono não-superusuário, como o postgres do Supabase). Uso:
#   PG_CLUSTER_DIR=~/pg-descartavel bash backend/testes-seguros/producao/ensaio_prod_migrar_151.sh
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
S="$(cd "$(dirname "$0")" && pwd)"; R="$(cd "$S/../../.." && pwd)"; M="$R/database/migrations"
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR (cluster DESCARTÁVEL local com MARCADOR_DESCARTAVEL)}"
H="-h 127.0.0.1 -p 54321"; DB=fin20ens
[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo "sem marcador: recusado"; exit 2; }
psql $H -U postgres -tAc "show data_directory" | grep -qF "$CLUSTER" || { echo "cluster inesperado: recusado"; exit 2; }
psql $H -U postgres -tAc "select 1 from pg_database where datname='estrut_base'" | grep -q 1 || { echo "falta estrut_base: rode antes backend/testes-seguros/pg/transferencia_unidades.sh"; exit 2; }
NP=0; NF=0; pass() { echo "PASS $1"; NP=$((NP+1)); }; fail() { echo "FAIL $1 :: $2"; NF=$((NF+1)); }
su_() { printf '%s\n' "$1" | psql $H -U postgres -d $DB -q -tA -v ON_ERROR_STOP=1 -f - 2>&1; }
novo() { # $1 = "sem126" para simular produção SEM a 126
  psql $H -U postgres -q -d postgres -c "drop database if exists $DB with (force)" -c "create database $DB owner dono_sim template estrut_base" 2>&1 | grep -v NOTICE
  LISTA="120_gestao_financeira_fundacao.sql 121_gestao_financeira_dominio.sql 122_conciliacao_periodos.sql"; [ "$1" = "sem126" ] || LISTA="$LISTA 126_financeiro_autoconcessao_superadmin.sql"
  for f in $LISTA; do
    psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d $DB -f "$M/$f" >/dev/null 2>&1 || { echo "base $f falhou"; exit 1; }
  done
  # dados financeiros "existentes" (sintéticos), como uma empresa que já usa o financeiro anterior
  su_ "insert into organizacoes(id,nome) values ('00000000-0000-4000-8000-00000000e001','[ENS] Empresa existente'),('00000000-0000-4000-8000-00000000e00a','[ENS] QA Financeiro 2.0');
       insert into unidades(id,organizacao_id,nome) values ('00000000-0000-4000-8000-00000000e002','00000000-0000-4000-8000-00000000e001','[ENS] Loja'),('00000000-0000-4000-8000-00000000e00b','00000000-0000-4000-8000-00000000e00a','[ENS] Loja QA');
       set role service_role;
       insert into fin_contas(id,organizacao_id,unidade_id,nome,tipo_conta) values ('00000000-0000-4000-8000-00000000e003','00000000-0000-4000-8000-00000000e001','00000000-0000-4000-8000-00000000e002','BANCO','banco');
       insert into fin_plano_contas(id,organizacao_id,tipo,natureza,nome,papel) values ('00000000-0000-4000-8000-00000000e004','00000000-0000-4000-8000-00000000e001','DESPESA','FIXA','ALUGUEL','despesa_fixa');
       insert into fin_lancamentos(organizacao_id,unidade_id,conta_id,categoria_id,descricao,sentido,valor_centavos,data_movimento) values ('00000000-0000-4000-8000-00000000e001','00000000-0000-4000-8000-00000000e002','00000000-0000-4000-8000-00000000e003','00000000-0000-4000-8000-00000000e004','Aluguel','saida',360000,'2026-10-05');" >/dev/null || { echo "seed falhou"; exit 1; }
}
EVD="$(mktemp -d)"; [ -n "$MANTER" ] && echo "EVD=$EVD" || trap 'rm -rf "$EVD"' EXIT
# papel do operador no ensaio: dono com leitura total (como o postgres do Supabase precisa ser para exportar tudo). dono_sim (sem BYPASSRLS) só na prova E22.
psql $H -U postgres -q -d postgres -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname='operador_ens') then create role operador_ens login nosuperuser bypassrls; end if; end \$\$; grant dono_sim to operador_ens" >/dev/null 2>&1
roda() { PROD_ENSAIO_LOCAL=1 PROD_CONN="postgresql://operador_ens@127.0.0.1:54321/$DB" PROD_EVIDENCIAS="$EVD" node "$S/prod-migrar-151.mjs" "$@" 2>&1; }
roda_dono() { PROD_ENSAIO_LOCAL=1 PROD_CONN="postgresql://dono_sim@127.0.0.1:54321/$DB" PROD_EVIDENCIAS="$EVD" node "$S/prod-migrar-151.mjs" "$@" 2>&1; }
AGORA=$(date -u +%Y-%m-%dT%H:%MZ); ANTIGO=$(date -u -d '-3 hours' +%Y-%m-%dT%H:%MZ)
BK="PROD_BACKUP_CONFIRMADO=SIM PROD_BACKUP_TIPO=pitr PROD_BACKUP_HORARIO=$AGORA"

novo sem126
OUT=$(roda preflight); echo "$OUT" | grep -q "a migration 126 não está em vigor" && echo "$OUT" | grep -q "NÃO APLICAR" && pass "E15 produção SEM a 126 → preflight NÃO APLICAR" || fail E15 "$(echo "$OUT" | tail -4)"

novo
OUT=$(PROD_CONN="postgresql://dono_sim@db.wiqqsxnysbzhcrzrrean.supabase.co:5432/postgres" node "$S/prod-migrar-151.mjs" preflight 2>&1); echo "$OUT" | grep -q "RECUSADO: PROD_CONN aponta para o projeto de TESTES" && pass "E01 conexão do projeto de TESTES é recusada" || fail E01 "$OUT"
OUT=$(PROD_CONN="postgresql://postgres.uqybgauuxcrqzquultfu@aws-0-us-west-2.pooler.supabase.com:6543/postgres" node "$S/prod-migrar-151.mjs" preflight 2>&1); echo "$OUT" | grep -q "porta 6543" && pass "E02 pooler em modo transação (6543) é recusado" || fail E02 "$OUT"
OUT=$(roda_dono preflight); echo "$OUT" | grep -q "não tem BYPASSRLS" && pass "E22 papel sem leitura total (exportação ficaria incompleta) → preflight NÃO APLICAR" || fail E22 "$(echo "$OUT" | tail -3)"
OUT=$(roda preflight); echo "$OUT" | grep -q "PREFLIGHT: OK" && echo "$OUT" | grep -q "versão da 120" && pass "E03 preflight (read-only): dependências, funções compartilhadas = versão da 120, níveis antigos → OK" || fail E03 "$(echo "$OUT" | tail -5)"
IDENT=$(echo "$OUT" | sed -n 's/^PROD_IDENTIDADE=//p')
ESP=$(su_ "select md5((select system_identifier::text from pg_control_system()) || '|' || (select oid::text from pg_database where datname = current_database()) || '|' || current_database())")
[ -n "$IDENT" ] && [ "$IDENT" = "$ESP" ] && pass "E34 (M-1) PROD_IDENTIDADE deriva do system_identifier do cluster (único por cluster), não só de oids fixos" || fail E34 "ident=$IDENT esp=$ESP"
su_ "revoke execute on function pg_control_system() from public;" >/dev/null
OUT=$(roda preflight); su_ "grant execute on function pg_control_system() to public;" >/dev/null
echo "$OUT" | grep -q "leitura falhou" && echo "$OUT" | grep -qi "pg_control_system" && ! echo "$OUT" | grep -q "PREFLIGHT: OK" && pass "E35 (M-1) sem acesso ao system_identifier o preflight é RECUSADO (fail-closed)" || fail E35 "$(echo "$OUT" | tail -2)"
OUT=$(PROD_IDENTIDADE=$IDENT PROD_AUTORIZO=SIM roda aplicar); echo "$OUT" | grep -q "PROD_BACKUP_CONFIRMADO" && pass "E04 aplicar sem confirmar o backup é recusado" || fail E04 "$OUT"
OUT=$(env PROD_IDENTIDADE=$IDENT PROD_AUTORIZO=SIM PROD_BACKUP_CONFIRMADO=SIM PROD_BACKUP_TIPO=pitr bash -c "$(declare -f roda); EVD=$EVD; DB=$DB; S=$S; roda aplicar"); echo "$OUT" | grep -q "PROD_BACKUP_HORARIO" && pass "E16 aplicar sem o HORÁRIO do último backup é recusado" || fail E16 "$OUT"
OUT=$(env PROD_IDENTIDADE=$IDENT PROD_AUTORIZO=SIM PROD_BACKUP_CONFIRMADO=SIM PROD_BACKUP_TIPO=pitr PROD_BACKUP_HORARIO=$ANTIGO bash -c "$(declare -f roda); EVD=$EVD; DB=$DB; S=$S; roda aplicar"); echo "$OUT" | grep -q "antigo demais" && pass "E17 backup PITR com mais de 1 h é recusado" || fail E17 "$OUT"
OUT=$(env PROD_IDENTIDADE=$IDENT PROD_AUTORIZO=SIM $BK bash -c "$(declare -f roda); EVD=$EVD; DB=$DB; S=$S; roda aplicar"); echo "$OUT" | grep -q "não há exportação" && pass "E18 aplicar SEM exportação financeira conferida é recusado" || fail E18 "$OUT"
OUT=$(PROD_IDENTIDADE=$IDENT roda exportar); EXP=$(echo "$OUT" | sed -n 's/^PROD_EXPORTACAO=//p'); echo "$OUT" | grep -q "EXPORTAÇÃO: OK" && [ -n "$EXP" ] && pass "E19 exportar: pg_dump somente leitura + conferência de TODAS as tabelas financeiras + sha256" || fail E19 "$OUT"
OUT=$(env PROD_IDENTIDADE=$IDENT PROD_AUTORIZO=SIM PROD_EXPORTACAO=0000 $BK bash -c "$(declare -f roda); EVD=$EVD; DB=$DB; S=$S; roda aplicar"); echo "$OUT" | grep -q "PROD_EXPORTACAO ausente ou diferente" && pass "E20 aplicar com sha256 de exportação errado é recusado" || fail E20 "$OUT"
OUT=$(env PROD_IDENTIDADE=errada PROD_AUTORIZO=SIM $BK bash -c "$(declare -f roda); EVD=$EVD; DB=$DB; S=$S; roda aplicar"); echo "$OUT" | grep -q "PROD_IDENTIDADE ausente ou diferente" && pass "E05 aplicar com identidade diferente da lida no preflight é recusado" || fail E05 "$OUT"
OUT=$(env PROD_IDENTIDADE=$IDENT PROD_AUTORIZO=SIM PROD_EXPORTACAO=$EXP $BK bash -c "$(declare -f roda); EVD=$EVD; DB=$DB; S=$S; roda aplicar"); echo "$OUT" | grep -q "RESULTADO: OK" && pass "E06 aplicar: 151 aplicada; NENHUMA tabela existente mudou de conteúdo (impressão digital); tabelas novas vazias" || fail E06 "$(echo "$OUT" | tail -4)"
OUT=$(PROD_IDENTIDADE=$IDENT roda verificar); echo "$OUT" | grep -q "VERIFICAÇÃO: OK" && pass "E07 verificar: 4 tabelas, RLS, gatilhos, funções da 151, níveis novos" || fail E07 "$(echo "$OUT" | tail -3)"
OUT=$(env PROD_IDENTIDADE=$IDENT PROD_AUTORIZO=SIM PROD_EXPORTACAO=$EXP $BK bash -c "$(declare -f roda); EVD=$EVD; DB=$DB; S=$S; roda aplicar"); echo "$OUT" | grep -qE "objetos da 151 já existem|a exportação não contém" && pass "E08 aplicar de novo é recusado (já aplicada / exportação anterior à 151)" || fail E08 "$(echo "$OUT" | tail -3)"
ARQ=$(ls "$EVD"/151-exportacao-financeiro-*.dump | head -1); printf 'x' >> "$ARQ"
OUT=$(env PROD_IDENTIDADE=$IDENT PROD_AUTORIZO=SIM PROD_EXPORTACAO=$EXP $BK bash -c "$(declare -f roda); EVD=$EVD; DB=$DB; S=$S; roda aplicar"); echo "$OUT" | grep -q "alterado depois de exportado" && pass "E21 exportação adulterada depois de conferida é detectada" || fail E21 "$(echo "$OUT" | grep RECUSADO | head -2)"
su_ "set role service_role; insert into fin_fornecedores(organizacao_id,nome) values ('00000000-0000-4000-8000-00000000e00a','Fornecedor QA sintético');" >/dev/null
OUT=$(PROD_IDENTIDADE=$IDENT PROD_QA_ORG=00000000-0000-4000-8000-00000000e00a roda isolamento); echo "$OUT" | grep -q "ISOLAMENTO: OK" && pass "E09 isolamento: dados da 151 só na organização de QA → OK" || fail E09 "$OUT"
su_ "set role service_role; insert into fin_fornecedores(organizacao_id,nome) values ('00000000-0000-4000-8000-00000000e001','Fornecedor fora do QA');" >/dev/null
OUT=$(PROD_IDENTIDADE=$IDENT PROD_QA_ORG=00000000-0000-4000-8000-00000000e00a roda isolamento); echo "$OUT" | grep -q "ISOLAMENTO: FALHA" && pass "E10 isolamento: registro fora da organização de QA é DETECTADO" || fail E10 "$OUT"
OUT=$(PROD_IDENTIDADE=$IDENT PROD_AUTORIZO_REVERSAO=SIM roda reverter); echo "$OUT" | grep -q "REVERSÃO RECUSADA" && pass "E11 reverter com dados da 151 é RECUSADO (nada é apagado em silêncio)" || fail E11 "$(echo "$OUT" | tail -3)"
# ---- limpeza da organização de QA (passo limpar-qa) ----
QA=00000000-0000-4000-8000-00000000e00a; QAU=00000000-0000-4000-8000-00000000e00b
su_ "set role service_role;
insert into fin_contas(id,organizacao_id,unidade_id,nome,tipo_conta) values ('00000000-0000-4000-8000-00000000e0c1','$QA','$QAU','BANCO QA','banco');
insert into fin_plano_contas(id,organizacao_id,tipo,natureza,nome,papel) values ('00000000-0000-4000-8000-00000000e0c2','$QA','DESPESA','FIXA','INSUMOS QA','despesa_fixa');
insert into fin_obrigacoes(id,organizacao_id,unidade_id,fornecedor_id,categoria_id,descricao,competencia,vencimento,valor_original_centavos) values ('00000000-0000-4000-8000-00000000e0c3','$QA','$QAU',(select id from fin_fornecedores where organizacao_id='$QA' limit 1),'00000000-0000-4000-8000-00000000e0c2','Conta QA','2026-10-01','2026-10-05',10000);
insert into fin_pagamentos(organizacao_id,unidade_id,obrigacao_id,conta_id,data_pagamento,valor_centavos) values ('$QA','$QAU','00000000-0000-4000-8000-00000000e0c3','00000000-0000-4000-8000-00000000e0c1','2026-10-05',5000);" >/dev/null
# fecha outubro na unidade de QA (como a homologação fará): os dados da QA ficam num mês FECHADO
su_ "begin; select set_config('fin.fechando_periodo', (select id::text from fin_periodos where unidade_id='$QAU' and mes='2026-10-01'), true);
update fin_periodos set status='fechado', fechado_por='$QA', fechado_em=now(), snapshot='{}' where unidade_id='$QAU' and mes='2026-10-01'; commit;" >/dev/null
OUT=$(PROD_IDENTIDADE=$IDENT PROD_QA_ORG=$QA PROD_QA_NOME="[ENS] QA Financeiro 2.0" roda limpar-qa); echo "$OUT" | grep -q "não a identifica como QA sintética" && pass "E24 limpeza recusada quando o nome não identifica a organização como QA sintética" || fail E24 "$(echo "$OUT" | tail -2)"
su_ "update organizacoes set nome='[ENS] QA Financeiro 2.0 (sintética)' where id='$QA';" >/dev/null
OUT=$(PROD_IDENTIDADE=$IDENT PROD_QA_ORG=$QA PROD_QA_NOME="QA errado (sintética)" roda limpar-qa); echo "$OUT" | grep -q "não confere exatamente" && pass "E25 limpeza recusada quando o nome informado não confere com o da organização" || fail E25 "$(echo "$OUT" | tail -2)"
OUT=$(PROD_IDENTIDADE=$IDENT PROD_QA_ORG=$QA PROD_QA_NOME="[ENS] QA Financeiro 2.0 (sintética)" roda limpar-qa); N=$(su_ "select count(*) from fin_obrigacoes where organizacao_id='$QA'")
echo "$OUT" | grep -q "SIMULAÇÃO — nada foi apagado" && [ "$N" = "1" ] && pass "E26 sem autorização é só SIMULAÇÃO (conta o que seria apagado; nada muda)" || fail E26 "$OUT / $N"
OUT=$(PROD_IDENTIDADE=$IDENT PROD_QA_ORG=$QA PROD_QA_NOME="[ENS] QA Financeiro 2.0 (sintética)" PROD_AUTORIZO_LIMPEZA=SIM roda limpar-qa); echo "$OUT" | grep -q "PROD_FLAG_SEM_QA" && pass "E27 limpeza recusada sem confirmar que a QA saiu do feature flag" || fail E27 "$(echo "$OUT" | tail -2)"
FORA_ANTES=$(su_ "select md5(string_agg(t::text,'|' order by t::text)) from fin_fornecedores t where organizacao_id <> '$QA'")
OUT=$(PROD_IDENTIDADE=$IDENT PROD_QA_ORG=$QA PROD_QA_NOME="[ENS] QA Financeiro 2.0 (sintética)" PROD_FLAG_SEM_QA=SIM PROD_AUTORIZO_LIMPEZA=SIM roda limpar-qa)
QA_DEPOIS=$(su_ "select (select count(*) from fin_fornecedores where organizacao_id='$QA') + (select count(*) from fin_obrigacoes where organizacao_id='$QA') + (select count(*) from fin_pagamentos where organizacao_id='$QA')")
FORA_DEPOIS=$(su_ "select md5(string_agg(t::text,'|' order by t::text)) from fin_fornecedores t where organizacao_id <> '$QA'")
TRG=$(su_ "select tgenabled from pg_trigger where tgname='trg_fin_pagamentos_periodo'")
echo "$OUT" | grep -q "LIMPEZA: OK" && [ "$QA_DEPOIS" = "0" ] && [ "$FORA_ANTES" = "$FORA_DEPOIS" ] && [ "$TRG" = "O" ] && pass "E28 limpeza executada: dados da QA (inclusive em mês FECHADO) apagados; outra empresa idêntica; gatilho de período religado" || fail E28 "$(echo "$OUT" | tail -3) qa=$QA_DEPOIS trg=$TRG"
L=$(su_ "select count(*) from fin_contas where organizacao_id='$QA'") ; [ "$L" = "1" ] && pass "E29 a limpeza NÃO toca o financeiro anterior da QA (contas/plano/lançamentos/períodos) nem a auditoria" || fail E29 "contas QA=$L"
su_ "delete from fin_fornecedores;" >/dev/null   # fornecedor da OUTRA empresa criado no E10 (só no ensaio): o rollback exige as tabelas da 151 vazias
OUT=$(PROD_IDENTIDADE=$IDENT PROD_AUTORIZO_REVERSAO=SIM roda reverter); echo "$OUT" | grep -q "REVERSÃO: OK" && pass "E12 reverter sem dados: volta ao estado da 120–126, conteúdo das tabelas existentes idêntico" || fail E12 "$(echo "$OUT" | tail -3)"
OUT=$(roda preflight); echo "$OUT" | grep -q "PREFLIGHT: OK" && pass "E13 depois da reversão o preflight volta a OK (funções da 120, níveis antigos)" || fail E13 "$(echo "$OUT" | tail -3)"
# drift: alguém alterou a função compartilhada em produção → o preflight precisa recusar
su_ "create or replace function public.gestao_financeira_tabelas_da_unidade() returns text[] language sql immutable set search_path = pg_catalog, pg_temp as \$\$ select array['fin_contas']::text[] \$\$;" >/dev/null
OUT=$(roda preflight); echo "$OUT" | grep -q "DIFERE da versão da 120" && pass "E14 função compartilhada alterada em produção (drift) → preflight NÃO APLICAR" || fail E14 "$(echo "$OUT" | tail -3)"
novo
su_ "alter table unidades disable trigger trg_unidades_guarda_financeiro;" >/dev/null
OUT=$(roda preflight); echo "$OUT" | grep -q "trg_unidades_guarda_financeiro ausente ou desabilitado" && pass "E23 (3ª rev. B-3) guarda de transferência desligada em unidades → preflight NÃO APLICAR" || fail E23 "$(echo "$OUT" | tail -3)"
psql $H -U postgres -q -d postgres -c "drop database if exists $DB with (force)" >/dev/null 2>&1
# ---- revisão final M-1 / M-2: identificação inequívoca do destino ----
P="postgresql://postgres:x@db.uqybgauuxcrqzquultfu.supabase.co:5432/postgres"
OUT=$(PROD_CONN="$P?host=127.0.0.1&port=54321" node "$S/prod-migrar-151.mjs" preflight 2>&1); echo "$OUT" | grep -q 'parâmetro de conexão não permitido na URL: "host"' && echo "$OUT" | grep -q '"port"' && pass "E30 (M-2) URL de produção com ?host=/&port= desviando para outro servidor é RECUSADA" || fail E30 "$OUT"
OUT=$(PROD_CONN="$P?hostaddr=127.0.0.1" node "$S/prod-migrar-151.mjs" preflight 2>&1); OUT2=$(PROD_CONN="$P?service=x" node "$S/prod-migrar-151.mjs" preflight 2>&1)
echo "$OUT" | grep -q '"hostaddr"' && echo "$OUT2" | grep -q '"service"' && pass "E31 (M-2) hostaddr= e service= também recusados" || fail E31 "$OUT / $OUT2"
OUT=$(PROD_CONN="postgresql://postgres:x@db.uqybgauuxcrqzquultfu.supabase.co,127.0.0.1:5432/postgres" node "$S/prod-migrar-151.mjs" preflight 2>&1); echo "$OUT" | grep -q "mais de um host" && pass "E32 (M-2) lista de hosts na conexão é recusada" || fail E32 "$OUT"
OUT=$(PROD_CONN="$P?sslmode=disable" node "$S/prod-migrar-151.mjs" preflight 2>&1); echo "$OUT" | grep -q 'sslmode="disable" não permitido' && pass "E33 (M-2) sslmode=disable recusado em produção" || fail E33 "$OUT"

# ---- reverificação M-2: formato estrito da conexão (PROD_SO_TRAVAS=1: nenhuma conexão é aberta) ----
tr_() { PROD_SO_TRAVAS=1 PROD_CONN="$1" node "$S/prod-migrar-151.mjs" preflight 2>&1; }
H=db.uqybgauuxcrqzquultfu.supabase.co
OUT=$(tr_ "postgresql://postgres:x@$H:5432/#?host=127.0.0.1&port=54321&dbname=postgres&sslmode=disable"); echo "$OUT" | grep -q "contém '#'" && ! echo "$OUT" | grep -q "TRAVAS: OK" && pass "E36 (M-2) '/#?host=…' (a libpq não trata # como fragmento) é RECUSADO" || fail E36 "$OUT"
OUT=$(tr_ "postgresql://postgres:x@$H:5432/outro"); echo "$OUT" | grep -q "fora do formato exigido" && pass "E37 (M-2) banco diferente de postgres recusado" || fail E37 "$OUT"
OUT=$(tr_ "postgresql://postgres:a@b@$H:5432/postgres"); echo "$OUT" | grep -q "RECUSADO" && ! echo "$OUT" | grep -q "TRAVAS: OK" && pass "E38 (M-2) '@' literal na senha recusado" || fail E38 "$OUT"
OUT=$(tr_ "postgresql://postgres:ab%40c%23d@$H:5432/postgres?sslmode=require"); echo "$OUT" | grep -q "TRAVAS: OK" && pass "E39 formato correto da conexão direta (senha codificada) é aceito pelas travas" || fail E39 "$OUT"
OUT=$(tr_ "postgresql://postgres.uqybgauuxcrqzquultfu:x@aws-0-us-west-2.pooler.supabase.com:5432/postgres?sslmode=require"); echo "$OUT" | grep -q "TRAVAS: OK" && pass "E40 formato correto do pooler de sessão é aceito pelas travas" || fail E40 "$OUT"
OUT=$(tr_ "postgresql://postgres:x@$H/postgres"); echo "$OUT" | grep -q "fora do formato exigido" && pass "E41 porta implícita recusada (precisa ser :5432 explícita)" || fail E41 "$OUT"
OUT=$(tr_ "postgresql://postgresdb.uqybgauuxcrqzquultfu.supabase.co:5432/postgres"); echo "$OUT" | grep -q "fora do formato exigido" && pass "E42 (M-2) usuário/host sem @ (host forjado) recusado" || fail E42 "$OUT"

OUT=$(PROD_SO_TRAVAS=1 PROD_ENSAIO_LOCAL=1 PROD_CONN="postgresql://operador_ens@nao-existe.invalid:5432/x@127.0.0.1:54321/" node "$S/prod-migrar-151.mjs" preflight 2>&1); echo "$OUT" | grep -q "ensaio: só 127.0.0.1" && ! echo "$OUT" | grep -q "TRAVAS: OK" && pass "E43 modo ensaio: host fictício com '@127.0.0.1:54321/' no nome do banco é RECUSADO (trava ancorada)" || fail E43 "$OUT"

echo; echo "RESUMO: $NP PASS, $NF FAIL"; [ $NF = 0 ]
