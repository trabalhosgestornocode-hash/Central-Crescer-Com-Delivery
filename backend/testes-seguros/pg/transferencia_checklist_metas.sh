#!/bin/bash
# Transferência/promoção de unidades × metas do Checklist (127) e correção 131 — SOMENTE PostgreSQL LOCAL DESCARTÁVEL
# (cluster com MARCADOR_DESCARTAVEL em 127.0.0.1:54321; mesmas travas de transferencia_unidades.sh).
# Monta, a partir do git e da árvore de trabalho (nada de banco remoto):
#   mt_main   = cadeia REAL de origin/main (000 → 068…119 → 123…128 → 120 → 121 → 122), como dono não-superusuário (privilégios do Supabase)
#   mt_131    = mt_main + 131 (só a correção)
#   mt_branch = mt_main + 129 → 130 → 131 desta árvore (a branch inteira)
# e prova: o defeito na main; a correção; transferência e promoção; isolamento; privilégios mínimos; compatibilidade com 129/130;
# controle negativo (rollback da 131 devolve o defeito) e idempotência.
# Uso: PG_CLUSTER_DIR=<cluster descartável> bash backend/testes-seguros/pg/transferencia_checklist_metas.sh
set -u
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8   # mensagens em inglês só nas conexões do superusuário (o dono não pode mudar lc_messages)
AQUI="$(cd "$(dirname "$0")" && pwd)"; R="${REPO:-$(cd "$AQUI/../../.." && pwd)}"; M="$R/database/migrations"
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR (cluster DESCARTÁVEL local, com o arquivo MARCADOR_DESCARTAVEL)}"
REF_BASE="${REF_BASE:-origin/main}"
H="-h 127.0.0.1 -p 54321"; SU="psql $H -U postgres -X -q -v ON_ERROR_STOP=1"
FALHOU=""; N_OK=0; N_F=0
ok() { echo "OK    $1"; N_OK=$((N_OK+1)); }; bad() { echo "FALHA $1"; FALHOU=1; N_F=$((N_F+1)); }; info() { echo "INFO  $1"; }
[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo "RECUSADO: sem MARCADOR_DESCARTAVEL em $CLUSTER"; exit 2; }
psql $H -U postgres -tAc "show data_directory" | grep -qF "$CLUSTER" || { echo "RECUSADO: o servidor em 127.0.0.1:54321 não é o cluster descartável"; exit 2; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
q() { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d "$1" -c "$2" 2>&1; }
sr() { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d "$1" -c "set role service_role; $2" 2>&1 | grep -v '^SET$'; }   # como o backend
como() { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d "$1" -c "set role $2; $3" 2>&1 | grep -v '^SET$'; }

ORG_A=00000000-0000-0000-0000-0000000d0a01; ORG_B=00000000-0000-0000-0000-0000000d0b01; ORG_C=00000000-0000-0000-0000-0000000d0c01
U1=00000000-0000-0000-0000-0000000d0e01; U2=00000000-0000-0000-0000-0000000d0e02; U3=00000000-0000-0000-0000-0000000d0e03
ATOR=00000000-0000-0000-0000-00000000a70b

# ---------- montagem ----------
psql $H -U postgres -tAc "select 1 from pg_roles where rolname='dono_sim'" | grep -q 1 || \
  $SU -d postgres -c "create role dono_sim login nosuperuser nobypassrls createrole" -c "create role anon nologin" -c "create role authenticated nologin" -c "create role service_role nologin bypassrls" >/dev/null 2>&1
novo_banco() { $SU -d postgres -c "drop database if exists $1" -c "create database $1 owner dono_sim ${2:+template $2}" 2>&1 | grep -v -i "notice\|nota"; }
aplicar() { psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d "$1" -f "$2" > "$TMP/ap.log" 2>&1; }
novo_banco mt_main
$SU -d mt_main -c "grant all on schema public to dono_sim; grant usage on schema public to anon, authenticated, service_role" >/dev/null
psql $H -U dono_sim -X -q -d mt_main -c "alter default privileges in schema public grant all on tables to anon, authenticated, service_role; alter default privileges in schema public grant all on sequences to anon, authenticated, service_role; alter default privileges in schema public grant all on functions to anon, authenticated, service_role" >/dev/null
$SU -d mt_main -f "$AQUI/stub_supabase_externo.sql" >/dev/null 2>&1 || { bad "stub do Supabase"; exit 1; }
LISTA=$(git -C "$R" ls-tree --name-only "$REF_BASE" database/migrations/ | sed 's#database/migrations/##' | grep -v rollback | grep -E '^(000_|06[89]_|0[7-9][0-9]_|1[01][0-9]_|12[3-8]_)' | sort)
NM=0; for f in $LISTA 120_gestao_financeira_fundacao.sql 121_gestao_financeira_dominio.sql 122_conciliacao_periodos.sql; do
  git -C "$R" show "$REF_BASE:database/migrations/$f" > "$TMP/$f"
  aplicar mt_main "$TMP/$f" || { bad "main: $f"; grep -m2 -i "erro\|error" "$TMP/ap.log"; exit 1; }; NM=$((NM+1))
done
ok "mt_main: $NM migrations REAIS de $REF_BASE @ $(git -C "$R" rev-parse --short "$REF_BASE") (até a 128, Financeiro 120–122 por último) como dono não-superusuário"
novo_banco mt_131 mt_main; aplicar mt_131 "$M/131_checklist_metas_transferencia_unidade.sql" && ok "mt_131: main + 131" || { bad "131 sobre a main"; cat "$TMP/ap.log" | head -3; }
novo_banco mt_branch mt_main
for f in 129_ifood_privilegios_minimos.sql 130_operacional_camada_fechamento.sql 131_checklist_metas_transferencia_unidade.sql; do
  aplicar mt_branch "$M/$f" || { bad "branch: $f"; head -3 "$TMP/ap.log"; }
done
ok "mt_branch: main + 129 → 130 → 131 (árvore de trabalho)"
aplicar mt_branch "$M/131_checklist_metas_transferencia_unidade.sql" && ok "131 reaplicada: idempotente" || bad "131 não é idempotente"

# ---------- cenário (igual nos três bancos) ----------
CEN="insert into auth.users (id) values ('$ATOR') on conflict do nothing;
insert into organizacoes (id, nome) values ('$ORG_A', '[MT] A'), ('$ORG_B', '[MT] B'), ('$ORG_C', '[MT] C');
insert into unidades (id, organizacao_id, nome) values ('$U1', '$ORG_A', '[MT] u1'), ('$U2', '$ORG_A', '[MT] u2'), ('$U3', '$ORG_A', '[MT] u3');"
# $4 = meta de preparo (valores diferentes geram versão nova; iguais não geram — regra da 127)
METAS() { sr "$1" "select resultado from checklist_metas_salvar('$ORG_A','$2',$3,${4:-20},80,15,80,35,80,'interface',null,null,'teste',null)"; }
for b in mt_main mt_131 mt_branch; do
  q $b "$CEN" >/dev/null
  R0="$(METAS $b $U1 0 20) $(METAS $b $U1 1 21) $(METAS $b $U3 0 20)"
  [ "$R0" = "salvo salvo salvo" ] && [ "$(q $b "select count(*) from checklist_metas_historico")" = "3" ] \
    && ok "$b: metas pela função da 127 como service_role (unidade 1: 2 versões; unidade 3: 1)" || bad "$b: metas iniciais: $R0"
done
EXTRA="insert into ifood_pedidos (order_id, merchant_id, organizacao_id, unidade_id) values ('mt-pedido-1', 'm-mt', '$ORG_A', '$U1');
insert into operacional_pedidos (order_id, organizacao_id, unidade_id, chave, merchant_id, fonte_hash, regra_versao) values ('mt-pedido-1', '$ORG_A', '$U1', 'abcdef0123456789', 'm-mt', 'h', 1);"
q mt_branch "$EXTRA" >/dev/null
sr mt_branch "select resultado from operacional_fechamento_registrar('$ORG_A','$U1','2026-10-27','CONSOLIDADO','10000000-0000-4000-8000-0000000000aa',1,'America/Sao_Paulo','padrao_plataforma','manual',null,null,'{}','{}','{}','{}','[]','hash-mt')" | grep -q REGISTRADO \
  && ok "mt_branch: pedido iFood, projeção operacional e fechamento CONSOLIDADO da unidade 1 criados" || bad "mt_branch: dados das 129/130"
q mt_branch "insert into operacional_mensagens_simuladas (organizacao_id, unidade_id, fechamento_id, fechamento_versao, status, chave_idempotencia, mensagem) select '$ORG_A','$U1', id, 1, 'SIMULATED', 'mt-k1', 'm' from operacional_fechamentos where unidade_id = '$U1'" >/dev/null

FOTO="select md5(string_agg(t, '|' order by t)) from (
  select (to_jsonb(m) - 'organizacao_id')::text t from checklist_metas m where unidade_id = '$U1'
  union all select (to_jsonb(h) - 'organizacao_id')::text from checklist_metas_historico h where unidade_id = '$U1') x"
TRANSF="select (r - 'unidadeId' - 'novaOrganizacaoId' - 'organizacaoAnteriorId')::text from transferir_unidade_organizacao('$U1', '$ORG_B', '$ATOR') r"

# ---------- 1) defeito na main ----------
R1=$(sr mt_main "$TRANSF")
echo "$R1" | grep -q "permission denied for table checklist_metas" && ok "1  [main] transferência falha: permission denied for table checklist_metas (defeito reproduzido)" || bad "1  [main] esperava permission denied; veio: $R1"
[ "$(q mt_main "select organizacao_id from unidades where id='$U1'")" = "$ORG_A" ] && ok "1b [main] nada mudou (transação desfeita)" || bad "1b [main] estado parcial"
R1c=$(sr mt_main "select (r - 'unidadeId' - 'novaOrganizacaoId' - 'organizacaoAnteriorId')::text from transferir_unidade_organizacao('$U2', '$ORG_B', '$ATOR') r")
echo "$R1c" | grep -q "permission denied for table checklist_metas" && ok "1c [main] falha também para unidade SEM metas (a tabela inteira bloqueia)" || bad "1c [main] veio: $R1c"

# ---------- 2) correção ----------
for b in mt_131 mt_branch; do
  F0=$(q $b "$FOTO")
  R2=$(sr $b "$TRANSF")
  echo "$R2" | grep -qi "error\|denied" && bad "2  [$b] transferência falhou: $R2" || ok "2  [$b] transferência conclui como service_role"
  [ "$(q $b "select count(*) from checklist_metas where unidade_id='$U1' and organizacao_id='$ORG_B'")" = "1" ] \
    && [ "$(q $b "select count(*) from checklist_metas_historico where unidade_id='$U1' and organizacao_id <> '$ORG_B'")" = "0" ] \
    && ok "2b [$b] metas e histórico da unidade 1 acompanham a unidade (empresa B)" || bad "2b [$b] metas/histórico não remapeados"
  [ "$(q $b "$FOTO")" = "$F0" ] && ok "2c [$b] conteúdo de metas e histórico idêntico (só organizacao_id mudou)" || bad "2c [$b] conteúdo alterado"
  [ "$(q $b "select count(*) from checklist_metas where unidade_id='$U3' and organizacao_id='$ORG_A'")" = "1" ] && ok "2d [$b] metas de OUTRA unidade da empresa A intactas" || bad "2d [$b] outra unidade afetada"
done
[ "$(q mt_branch "select string_agg(organizacao_id::text, ',') from (select organizacao_id from ifood_pedidos where unidade_id='$U1' union all select organizacao_id from operacional_pedidos where unidade_id='$U1' union all select organizacao_id from operacional_fechamentos where unidade_id='$U1' union all select organizacao_id from operacional_mensagens_simuladas where unidade_id='$U1') x")" = "$ORG_B,$ORG_B,$ORG_B,$ORG_B" ] \
  && ok "3  [branch] 129/130 compatíveis: pedido iFood, projeção, fechamento (imutável) e simulação acompanham a unidade" || bad "3  [branch] tabelas da 129/130 não remapeadas"
[ "$(q mt_branch "select hash_conteudo || '|' || status from operacional_fechamentos where unidade_id='$U1'")" = "hash-mt|CONSOLIDADO" ] && ok "3b [branch] conteúdo do fechamento intacto após a transferência" || bad "3b [branch] fechamento alterado"

# ---------- 4) promoção ----------
P=$(sr mt_branch "select (r - 'unidadeId' - 'novaOrganizacaoId' - 'organizacaoAnteriorId')::text from promover_unidade_para_empresa('$U2', '[MT] promovida', '$ATOR') r")
if echo "$P" | grep -qi "error"; then
  echo "$P" | grep -q "checklist_metas" && bad "4  promoção ainda bloqueada por checklist_metas: $P" \
    || info "4  promoção falha por OUTRO defeito preexistente (não é da 127): $(echo "$P" | head -1)"
  PM=$(sr mt_main "select (r - 'unidadeId' - 'novaOrganizacaoId' - 'organizacaoAnteriorId')::text from promover_unidade_para_empresa('$U2', '[MT] promovida', '$ATOR') r")
  info "4  na main a promoção falha com: $(echo "$PM" | head -1)"
else ok "4  promoção da unidade 2 conclui como service_role: $P"; fi
# a etapa de remapeamento da promoção (a que a 127 quebrava), isolada: unidade 3 (com metas) vai para a empresa C
R4=$(sr mt_branch "update unidades set organizacao_id = '$ORG_C' where id = '$U3'; select remapear_organizacao_em_tabelas_de_unidade('$U3', '$ORG_A', '$ORG_C')::text")
echo "$R4" | grep -q '"checklist_metas": 1' && echo "$R4" | grep -q '"checklist_metas_historico": 1' && ok "4b remapeamento (etapa da promoção/transferência) como service_role move metas e histórico: $R4" || bad "4b remapeamento: $R4"
R4m=$(sr mt_main "update unidades set organizacao_id = '$ORG_C' where id = '$U3'; select remapear_organizacao_em_tabelas_de_unidade('$U3', '$ORG_A', '$ORG_C')::text")
echo "$R4m" | grep -q "permission denied for table checklist_metas" && ok "4c [main] a mesma etapa falha na main (controle)" || bad "4c [main] veio: $R4m"

# ---------- 5) isolamento e privilégios mínimos ----------
E=$(sr mt_branch "update checklist_metas set organizacao_id = '$ORG_A' where unidade_id = '$U1'")
echo "$E" | grep -q "não pertence à organização" && ok "5a service_role NÃO move metas para empresa que não é a da unidade" || bad "5a: $E"
E=$(sr mt_branch "update checklist_metas_historico set organizacao_id = '$ORG_A' where unidade_id = '$U1'")
echo "$E" | grep -q "somente inclusão" && ok "5b service_role NÃO move histórico para empresa que não é a da unidade" || bad "5b: $E"
E=$(sr mt_branch "update checklist_metas set preparo_meta_min = 99 where unidade_id = '$U1'")
echo "$E" | grep -q "permission denied" && ok "5c service_role NÃO altera valores de meta direto (escrita só pela função da 127)" || bad "5c: $E"
E=$(sr mt_branch "update checklist_metas_historico set novo = '{}'::jsonb where unidade_id = '$U1'")
echo "$E" | grep -q "permission denied" && ok "5d service_role NÃO altera conteúdo do histórico" || bad "5d: $E"
E=$(sr mt_branch "delete from checklist_metas_historico where unidade_id = '$U1'")
echo "$E" | grep -q "permission denied" && ok "5e service_role NÃO apaga histórico" || bad "5e: $E"
E=$(q mt_branch "update checklist_metas_historico set novo = '{}'::jsonb where unidade_id = '$U1'")
echo "$E" | grep -q "somente inclusão" && ok "5f nem o dono altera conteúdo do histórico (gatilho)" || bad "5f: $E"
for papel in anon authenticated; do
  E=$(como mt_branch $papel "select count(*) from checklist_metas; update checklist_metas set organizacao_id = organizacao_id")
  echo "$E" | grep -q "permission denied" && ok "5g $papel sem acesso a checklist_metas" || bad "5g $papel: $E"
done
V=$(q mt_branch "select string_agg(t || '.' || c.column_name, ',') from (values ('checklist_metas'),('checklist_metas_historico')) v(t) join information_schema.columns c on c.table_name = v.t and c.table_schema='public' where has_column_privilege('service_role', format('public.%I', v.t), c.column_name, 'UPDATE')")
[ "$V" = "checklist_metas.organizacao_id,checklist_metas_historico.organizacao_id" ] && ok "5h privilégio mínimo: service_role só tem UPDATE em organizacao_id (nenhuma outra coluna)" || bad "5h UPDATE em: $V"
V=$(q mt_branch "select string_agg(t || '/' || p, ',') from (values ('checklist_metas'),('checklist_metas_historico')) v(t) cross join unnest(array['insert','delete','truncate','references','trigger']) p where has_table_privilege('service_role', format('public.%I', v.t), p)")
[ -z "$V" ] && ok "5i service_role sem INSERT/DELETE/TRUNCATE/REFERENCES/TRIGGER direto nas duas tabelas" || bad "5i: $V"
# escrita normal de metas continua funcionando depois da transferência (na empresa nova)
[ "$(sr mt_branch "select resultado from checklist_metas_salvar('$ORG_B','$U1',2,25,80,15,80,35,80,'interface',null,null,'teste',null)")" = "salvo" ] && ok "5j metas da unidade transferida continuam editáveis pela função (empresa B, versão 3)" || bad "5j checklist_metas_salvar após a transferência"
[ "$(sr mt_branch "select resultado from checklist_metas_salvar('$ORG_A','$U1',3,22,80,15,80,35,80,'interface',null,null,'teste',null)")" != "salvo" ] && ok "5k a empresa antiga não grava metas da unidade transferida" || bad "5k empresa antiga gravou metas"

# ---------- 6) controle negativo e reaplicação ----------
novo_banco mt_rb mt_main; q mt_rb "$CEN" >/dev/null; METAS mt_rb $U1 0 >/dev/null
aplicar mt_rb "$M/131_checklist_metas_transferencia_unidade.sql" && aplicar mt_rb "$M/131_rollback.sql" && aplicar mt_rb "$M/131_rollback.sql" || bad "6 rollback"
sr mt_rb "$TRANSF" | grep -q "permission denied for table checklist_metas" && ok "6  rollback da 131 (2×, idempotente) devolve o defeito: a correção é necessária" || bad "6 controle negativo"
aplicar mt_rb "$M/131_checklist_metas_transferencia_unidade.sql" && ! sr mt_rb "$TRANSF" | grep -qi "error" && ok "6b reaplicar a 131 corrige de novo" || bad "6b reaplicação"
[ "$(q mt_rb "select pg_get_functiondef('checklist_metas_validar_tenant()'::regprocedure) = (select pg_get_functiondef('checklist_metas_validar_tenant()'::regprocedure))")" = "t" ] || true
E=$(psql $H -U dono_sim -X -q -d mt_main -c "begin; drop table checklist_metas_historico, checklist_metas cascade;" -f "$M/131_checklist_metas_transferencia_unidade.sql" 2>&1 | grep -c "exige a migration 127")
[ "$E" -ge 1 ] && ok "6c sem a 127 a 131 recusa (nunca aplica parcialmente)" || info "6c verificação da recusa sem a 127 não conclusiva"

echo; echo "TOTAL: $((N_OK+N_F)) verificações, $N_F falhas"
[ -z "$FALHOU" ] && echo "TRANSFERÊNCIA × METAS DO CHECKLIST: OK" || { echo "TRANSFERÊNCIA × METAS DO CHECKLIST: HÁ FALHAS"; exit 1; }
