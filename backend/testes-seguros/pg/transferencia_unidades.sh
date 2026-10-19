#!/bin/bash
# Transferência/promoção de unidades × Financeiro (120 §5b) — SOMENTE PostgreSQL LOCAL DESCARTÁVEL (cluster com MARCADOR_DESCARTAVEL, 127.0.0.1:54321).
# Monta, a partir do git (nada de banco remoto):
#   estrut_base  = cadeia de origin/main (000 → 068…119 → 123…125), como em produção, SEM Financeiro
#   estrut_antes = estrut_base + 120 → 121 → 122 na versão ANTERIOR à correção (REF_ANTES) — reproduz o defeito
#   estrut_fin   = estrut_base + 120 → 121 → 122 desta árvore de trabalho (com a correção)
# e roda: suíte funcional (transferencia_unidades.sql), equivalência com/sem Financeiro, concorrência, atomicidade e o ciclo de rollback.
# Uso: PG_CLUSTER_DIR=C:/Users/.../pg-descartavel bash backend/testes-seguros/pg/transferencia_unidades.sh
set -u
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
AQUI="$(cd "$(dirname "$0")" && pwd)"; R="${REPO:-$(cd "$AQUI/../../.." && pwd)}"
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR (cluster DESCARTÁVEL local, com o arquivo MARCADOR_DESCARTAVEL)}"
REF_BASE="${REF_BASE:-origin/main}"; REF_ANTES="${REF_ANTES:-c8b11ae}"
H="-h 127.0.0.1 -p 54321"; SU="psql $H -U postgres -X -q -v ON_ERROR_STOP=1"
FALHOU=""; ok() { echo "OK    $1"; }; bad() { echo "FALHA $1"; FALHOU=1; }; info() { echo "INFO  $1"; }
[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo "RECUSADO: sem MARCADOR_DESCARTAVEL em $CLUSTER"; exit 2; }
psql $H -U postgres -tAc "show data_directory" | grep -qF "$CLUSTER" || { echo "RECUSADO: o servidor em 127.0.0.1:54321 não é o cluster descartável"; exit 2; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
q() { psql $H -U postgres -X -tA -d "$1" -c "$2" 2>&1; }

# ---------- montagem ----------
psql $H -U postgres -tAc "select 1 from pg_roles where rolname='dono_sim'" | grep -q 1 || {
  $SU -d postgres -c "create role dono_sim login nosuperuser nobypassrls createrole" -c "create role anon nologin" -c "create role authenticated nologin" -c "create role service_role nologin bypassrls" >/dev/null 2>&1; }
novo_banco() { $SU -d postgres -c "drop database if exists $1" -c "create database $1 owner dono_sim ${2:+template $2}" 2>&1 | grep -v NOTICE; }
novo_banco estrut_base
$SU -d estrut_base -c "grant all on schema public to dono_sim; grant usage on schema public to anon, authenticated, service_role" >/dev/null
psql $H -U dono_sim -X -q -d estrut_base -c "alter default privileges in schema public grant all on tables to anon, authenticated, service_role; alter default privileges in schema public grant all on sequences to anon, authenticated, service_role; alter default privileges in schema public grant all on functions to anon, authenticated, service_role" >/dev/null
$SU -d estrut_base -f "$AQUI/stub_supabase_externo.sql" >/dev/null 2>&1 || { bad "stub do Supabase"; exit 1; }
LISTA=$(git -C "$R" ls-tree --name-only "$REF_BASE" database/migrations/ | sed 's#database/migrations/##' | grep -v rollback | grep -E '^(000_|06[89]_|0[7-9][0-9]_|1[01][0-9]_|12[3-9]_)' | sort)
N=0; for f in $LISTA; do
  git -C "$R" show "$REF_BASE:database/migrations/$f" > "$TMP/$f"
  psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d estrut_base -f "$TMP/$f" > "$TMP/$f.log" 2>&1 || { bad "base: $f"; grep -m2 ERRO "$TMP/$f.log"; exit 1; }; N=$((N+1))
done
ok "estrut_base: $N migrations de $REF_BASE @ $(git -C "$R" rev-parse --short "$REF_BASE") aplicadas como dono_sim (não-superusuário)"
fin() { # $1 banco, $2 ref git ou vazio (árvore de trabalho)
  for f in database/migrations/120_gestao_financeira_fundacao.sql database/migrations/121_gestao_financeira_dominio.sql docs/gestao-financeira/proposta-122/122_conciliacao_periodos.provisorio.sql; do
    if [ -n "$2" ]; then git -C "$R" show "$2:$f" > "$TMP/x.sql"; else cp "$R/$f" "$TMP/x.sql"; fi
    psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d "$1" -f "$TMP/x.sql" > "$TMP/x.log" 2>&1 || { bad "$1: $(basename $f)"; grep -m3 ERRO "$TMP/x.log"; return 1; }
  done; }
novo_banco estrut_antes estrut_base; fin estrut_antes "$REF_ANTES" && ok "estrut_antes: 120–122 de $REF_ANTES (antes da correção)"
novo_banco estrut_fin estrut_base; fin estrut_fin "" && ok "estrut_fin: 120–122 da árvore de trabalho (com a correção)"
psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d estrut_fin -f "$R/docs/gestao-financeira/proposta-122/122_conciliacao_periodos.provisorio.sql" >/dev/null 2>&1 && ok "122 reaplicada (idempotente)" || bad "122 não é idempotente"

# Cenário mínimo de transferência (unidade com dados operacionais, sem Financeiro), igual nos três bancos
CEN="insert into auth.users (id) values ('00000000-0000-0000-0000-00000000a70a') on conflict do nothing;
insert into organizacoes (id, nome) values ('00000000-0000-0000-0000-0000000e0a01', '[TU] eq A'), ('00000000-0000-0000-0000-0000000e0b01', '[TU] eq B');
insert into unidades (id, organizacao_id, nome) values ('00000000-0000-0000-0000-0000000e0c01', '00000000-0000-0000-0000-0000000e0a01', '[TU] eq');
insert into dashboard_ifood_unidade_config (organizacao_id, unidade_id) values ('00000000-0000-0000-0000-0000000e0a01', '00000000-0000-0000-0000-0000000e0c01');
insert into ifood_conexoes (organizacao_id, unidade_id) values ('00000000-0000-0000-0000-0000000e0a01', '00000000-0000-0000-0000-0000000e0c01');
insert into dispositivos_exibicao (organizacao_id, unidade_id, nome, token_hash, autorizado_por_conta_id, expira_em) values ('00000000-0000-0000-0000-0000000e0a01', '00000000-0000-0000-0000-0000000e0c01', 'TV', repeat('cd', 32), gen_random_uuid(), now() + interval '1 day');"
TRANSF="set role service_role; select (r - 'unidadeId' - 'novaOrganizacaoId' - 'organizacaoAnteriorId')::text from transferir_unidade_organizacao('00000000-0000-0000-0000-0000000e0c01', '00000000-0000-0000-0000-0000000e0b01', '00000000-0000-0000-0000-00000000a70a') r;"
ESTADO="select jsonb_build_object('unidade', (select organizacao_id from unidades where id = '00000000-0000-0000-0000-0000000e0c01'),
  'ifood', (select jsonb_agg(organizacao_id) from ifood_conexoes where unidade_id = '00000000-0000-0000-0000-0000000e0c01'),
  'config', (select jsonb_agg(organizacao_id) from dashboard_ifood_unidade_config where unidade_id = '00000000-0000-0000-0000-0000000e0c01'),
  'aparelho', (select jsonb_agg(jsonb_build_array(organizacao_id, revogado_em is not null, motivo_revogacao)) from dispositivos_exibicao where unidade_id = '00000000-0000-0000-0000-0000000e0c01'),
  'aud', (select count(*) from plataforma_auditoria where acao = 'unidade.transferida_entre_empresas'))::text"

# ---------- reprodução do defeito (antes da correção) ----------
q estrut_antes "$CEN" >/dev/null
R_ANTES=$(psql $H -U postgres -X -tA -d estrut_antes -c "$TRANSF" 2>&1)
echo "$R_ANTES" | grep -q "permission denied for table fin_auditoria\|permissão negada para tabela fin_auditoria" \
  && ok "[antes] transferência de unidade SEM dado financeiro falha: permission denied for table fin_auditoria (defeito reproduzido)" \
  || bad "[antes] esperava permission denied em fin_auditoria; veio: $R_ANTES"

# ---------- equivalência com/sem Financeiro (a correção não muda a transferência de quem não usa o Financeiro) ----------
q estrut_base "$CEN" >/dev/null; q estrut_fin "$CEN" >/dev/null
for b in estrut_base estrut_fin; do psql $H -U postgres -X -tA -d $b -c "$TRANSF" 2>&1 | grep -v "^SET$" > "$TMP/r_$b"; q $b "$ESTADO" > "$TMP/e_$b"; done
sed -i 's/"[0-9a-f-]\{36\}"/"<id>"/g' "$TMP/e_estrut_base" "$TMP/e_estrut_fin"
cmp -s "$TMP/r_estrut_base" "$TMP/r_estrut_fin" && ok "equivalência: retorno da transferência idêntico sem e com Financeiro: $(cat "$TMP/r_estrut_fin")" || bad "retornos diferem: $(cat "$TMP/r_estrut_base") × $(cat "$TMP/r_estrut_fin")"
cmp -s "$TMP/e_estrut_base" "$TMP/e_estrut_fin" && ok "equivalência: estado final idêntico (unidade, iFood, config, aparelho do Checklist, auditoria)" || bad "estados diferem: $(cat "$TMP/e_estrut_base") × $(cat "$TMP/e_estrut_fin")"
P0=$(psql $H -U postgres -X -tA -d estrut_base -c "set role service_role; select promover_unidade_para_empresa('00000000-0000-0000-0000-0000000e0c01', 'x', '00000000-0000-0000-0000-00000000a70a')" 2>&1)
echo "$P0" | grep -q "ON CONFLICT" && info "[pré-existente na main, SEM Financeiro] promover_unidade_para_empresa falha com 42P10 (ON CONFLICT (usuario_id, organizacao_id) sem constraint desde a 063)" || info "promoção sem Financeiro: $P0"

# ---------- suíte funcional (cenários 0–8 e 10b) ----------
novo_banco estrut_suite estrut_fin
$SU -d estrut_suite -c "delete from dispositivos_exibicao; delete from dashboard_ifood_unidade_config; delete from ifood_conexoes; delete from sessoes_contexto; delete from plataforma_auditoria; delete from unidades; delete from organizacoes" >/dev/null 2>&1
psql $H -U postgres -X -q -d estrut_suite -f "$AQUI/transferencia_unidades.sql" > "$TMP/suite.out" 2>&1 || { bad "suíte SQL abortou"; tail -5 "$TMP/suite.out"; }
sed -n '/====RESULTADO====/,$p' "$TMP/suite.out" | grep -v '====RESULTADO====' | sed 's/^OK   /OK   /'
grep -q "^TOTAL: .*, 0 falhas" "$TMP/suite.out" || FALHOU=1

# ---------- 9) concorrência entre lançamento financeiro e transferência ----------
CONC_SETUP="insert into organizacoes (id, nome) values ('00000000-0000-0000-0000-0000000c0a01', '[TU] c A'), ('00000000-0000-0000-0000-0000000c0b01', '[TU] c B');
insert into unidades (id, organizacao_id, nome) values ('00000000-0000-0000-0000-0000000c0c01', '00000000-0000-0000-0000-0000000c0a01', '[TU] c1'), ('00000000-0000-0000-0000-0000000c0c02', '00000000-0000-0000-0000-0000000c0a01', '[TU] c2'), ('00000000-0000-0000-0000-0000000c0c03', '00000000-0000-0000-0000-0000000c0a01', '[TU] c3');"
# primeiro registro financeiro da unidade (conta + lançamento) numa só transação, com a empresa ANTIGA
LANC() { echo "set role service_role; begin; with c as (insert into fin_contas (organizacao_id, unidade_id, nome) values ('00000000-0000-0000-0000-0000000c0a01', '$1', 'conta') returning id)
  insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, descricao, sentido, valor_centavos, data_movimento, classificacao_pendente) select '00000000-0000-0000-0000-0000000c0a01', '$1', id, 'x', 'entrada', 100, date '2026-09-10', true from c;
  select pg_sleep(${2:-0}); commit;"; }
TR() { echo "set role service_role; begin; select transferir_unidade_organizacao('$1', '00000000-0000-0000-0000-0000000c0b01', '00000000-0000-0000-0000-00000000a70a') is not null; select pg_sleep(${2:-0}); commit;"; }
INCONS="select count(*) from (select organizacao_id, unidade_id from fin_lancamentos union all select organizacao_id, unidade_id from fin_contas) f join unidades u on u.id = f.unidade_id where f.organizacao_id <> u.organizacao_id"
conc() { # $1 banco, $2 unidade
  # 9a: lançamento chega primeiro (segura FOR SHARE na unidade por 3 s); transferência espera e, ao seguir, enxerga o lançamento ⇒ recusa
  ( psql $H -U postgres -X -q -d $1 -c "$(LANC $2 3)" > "$TMP/9a_l" 2>&1 ) & sleep 1
  psql $H -U postgres -X -q -tA -d $1 -c "$(TR $2 0)" > "$TMP/9a_t" 2>&1; wait; }
q estrut_fin "$CONC_SETUP" >/dev/null
conc estrut_fin 00000000-0000-0000-0000-0000000c0c01
grep -q "registros no Financeiro" "$TMP/9a_t" && ! grep -q ERRO "$TMP/9a_l" && [ "$(q estrut_fin "select organizacao_id from unidades where id='00000000-0000-0000-0000-0000000c0c01'")" = "00000000-0000-0000-0000-0000000c0a01" ] \
  && ok "9a lançamento primeiro: transferência espera, vê o lançamento e é recusada; unidade fica na empresa A" || bad "9a: lanc=$(cat "$TMP/9a_l") transf=$(cat "$TMP/9a_t")"
# 9b: transferência chega primeiro (segura a unidade por 3 s); lançamento com a empresa antiga espera e é recusado
( psql $H -U postgres -X -q -tA -d estrut_fin -c "$(TR 00000000-0000-0000-0000-0000000c0c02 3)" > "$TMP/9b_t" 2>&1 ) & sleep 1
T0=$(date +%s); psql $H -U postgres -X -q -d estrut_fin -c "$(LANC 00000000-0000-0000-0000-0000000c0c02 0)" > "$TMP/9b_l" 2>&1; T1=$(date +%s); wait
grep -q "unidade nao pertence" "$TMP/9b_l" && ! grep -q ERRO "$TMP/9b_t" && [ $((T1-T0)) -ge 1 ] \
  && ok "9b transferência primeiro: lançamento esperou $((T1-T0)) s pela trava e foi recusado (unidade já é da empresa B)" || bad "9b: transf=$(cat "$TMP/9b_t") lanc=$(cat "$TMP/9b_l") espera=$((T1-T0))s"
[ "$(q estrut_fin "$INCONS")" = "0" ] && ok "9  nenhum registro financeiro com empresa diferente da empresa da unidade depois das corridas" || bad "9: inconsistência entre empresa da unidade e dos registros"
# 9c: CONTROLE NEGATIVO — sem o FOR SHARE (gatilho de escopo da versão anterior), a corrida 9b grava lançamento da empresa A numa unidade da empresa B
novo_banco estrut_ctl estrut_fin
$SU -d estrut_ctl -c "$(git -C "$R" show "$REF_ANTES:database/migrations/121_gestao_financeira_dominio.sql" | awk '/^create or replace function fin_validar_escopo\(\)/{p=1} p{print} p&&/^end \$\$;/{exit}')" >/dev/null 2>&1
( psql $H -U postgres -X -q -tA -d estrut_ctl -c "$(TR 00000000-0000-0000-0000-0000000c0c03 3)" > "$TMP/9c_t" 2>&1 ) & sleep 1
psql $H -U postgres -X -q -d estrut_ctl -c "$(LANC 00000000-0000-0000-0000-0000000c0c03 0)" > "$TMP/9c_l" 2>&1; wait
[ "$(q estrut_ctl "$INCONS")" != "0" ] && ok "9c controle negativo: SEM o FOR SHARE a mesma corrida deixa $(q estrut_ctl "$INCONS") registro(s) da empresa A na unidade da empresa B (o FOR SHARE é necessário)" \
  || info "9c controle negativo não reproduziu a corrida (transf=$(cat "$TMP/9c_t") lanc=$(cat "$TMP/9c_l"))"

# ---------- 10) falha sem alteração parcial (transação real, sem subtransação de teste) ----------
FOTO="select jsonb_build_object('u', (select organizacao_id from unidades where id = '00000000-0000-0000-0000-0000000c0c01'),
  'cfg', (select jsonb_agg(organizacao_id) from dashboard_ifood_unidade_config where unidade_id = '00000000-0000-0000-0000-0000000c0c01'),
  'ifood', (select jsonb_agg(organizacao_id) from ifood_conexoes where unidade_id = '00000000-0000-0000-0000-0000000c0c01'),
  'fin', (select jsonb_agg(organizacao_id) from fin_lancamentos where unidade_id = '00000000-0000-0000-0000-0000000c0c01'),
  'aud', (select count(*) from plataforma_auditoria), 'orgs', (select count(*) from organizacoes))::text"
q estrut_fin "insert into dashboard_ifood_unidade_config (organizacao_id, unidade_id) values ('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c0c01'); insert into ifood_conexoes (organizacao_id, unidade_id) values ('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c0c01')" >/dev/null
F0=$(q estrut_fin "$FOTO")
psql $H -U postgres -X -q -d estrut_fin -c "set role service_role; select transferir_unidade_organizacao('00000000-0000-0000-0000-0000000c0c01', '00000000-0000-0000-0000-0000000c0b01', '00000000-0000-0000-0000-00000000a70a')" > "$TMP/10a" 2>&1
psql $H -U postgres -X -q -d estrut_fin -c "set role service_role; select promover_unidade_para_empresa('00000000-0000-0000-0000-0000000c0c01', 'x', '00000000-0000-0000-0000-00000000a70a')" > "$TMP/10b" 2>&1
F1=$(q estrut_fin "$FOTO")
grep -q "registros no Financeiro" "$TMP/10a" && [ "$F0" = "$F1" ] && ok "10a transferência recusada como chamada real (RPC isolada): nada mudou — o UPDATE em unidades (feito ANTES da guarda) também foi desfeito" || bad "10a: $(cat "$TMP/10a") | $F0 × $F1"
grep -q "ON CONFLICT\|registros no Financeiro" "$TMP/10b" && [ "$F0" = "$F1" ] && ok "10b promoção recusada como chamada real: nenhuma organização criada, catálogo/módulos não clonados ($(head -1 "$TMP/10b" | cut -c1-110))" || bad "10b: $(cat "$TMP/10b")"
# 10c: falha no MEIO da varredura genérica (tabela não financeira) — unidade e tabelas já remapeadas voltam ao estado anterior
q estrut_fin "create function public.teste_falha_no_meio() returns trigger language plpgsql as \$\$ begin raise exception 'falha injetada no meio do remapeamento'; end \$\$;
  create trigger teste_falha_no_meio before update on public.ifood_conexoes for each row execute function public.teste_falha_no_meio();
  insert into dashboard_ifood_unidade_config (organizacao_id, unidade_id) values ('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c0c03');
  insert into ifood_conexoes (organizacao_id, unidade_id) values ('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c0c03')" >/dev/null
q estrut_fin "update unidades set organizacao_id = '00000000-0000-0000-0000-0000000c0a01' where id = '00000000-0000-0000-0000-0000000c0c03'" >/dev/null 2>&1
G0=$(q estrut_fin "select (select organizacao_id from unidades where id='00000000-0000-0000-0000-0000000c0c03')::text || (select string_agg(organizacao_id::text, ',') from dashboard_ifood_unidade_config where unidade_id='00000000-0000-0000-0000-0000000c0c03')")
psql $H -U postgres -X -q -d estrut_fin -c "set role service_role; select transferir_unidade_organizacao('00000000-0000-0000-0000-0000000c0c03', '00000000-0000-0000-0000-0000000c0b01', '00000000-0000-0000-0000-00000000a70a')" > "$TMP/10c" 2>&1
G1=$(q estrut_fin "select (select organizacao_id from unidades where id='00000000-0000-0000-0000-0000000c0c03')::text || (select string_agg(organizacao_id::text, ',') from dashboard_ifood_unidade_config where unidade_id='00000000-0000-0000-0000-0000000c0c03')")
q estrut_fin "drop trigger teste_falha_no_meio on public.ifood_conexoes; drop function public.teste_falha_no_meio()" >/dev/null
grep -q "falha injetada" "$TMP/10c" && [ "$G0" = "$G1" ] && ok "10c falha injetada no meio da varredura: dashboard_ifood_unidade_config (já remapeada) e a unidade voltaram ao estado anterior" || bad "10c: $(cat "$TMP/10c") | $G0 × $G1"

# ---------- ciclo de rollback: 122 → 121 → 120 devolve a função da 054 ----------
novo_banco estrut_rb estrut_base; fin estrut_rb "" >/dev/null
R120=$(psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d estrut_rb -f "$R/database/migrations/120_rollback.sql" 2>&1)
echo "$R120" | grep -q "desfaça 122 e 121 antes" && ok "rollback 120 com 121 presente: recusado (a função da 054 quebraria a transferência)" || bad "rollback 120 fora de ordem: $R120"
psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d estrut_rb -f "$R/docs/gestao-financeira/proposta-122/122_rollback.provisorio.sql" >/dev/null 2>&1 \
 && psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d estrut_rb -f "$R/database/migrations/121_rollback.sql" >/dev/null 2>&1 \
 && psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d estrut_rb -f "$R/database/migrations/120_rollback.sql" >/dev/null 2>&1 && ok "rollback 122 → 121 → 120 (sem dados)" || bad "rollback em ordem falhou"
DEF="select md5(pg_get_functiondef('public.remapear_organizacao_em_tabelas_de_unidade(uuid,uuid,uuid)'::regprocedure)) || ' ' || coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = 'public.remapear_organizacao_em_tabelas_de_unidade(uuid,uuid,uuid)'::regprocedure"
[ "$(q estrut_rb "$DEF")" = "$(q estrut_base "$DEF")" ] && ok "após o rollback, remapear_organizacao_em_tabelas_de_unidade é idêntica à da main (definição e privilégios)" || bad "função restaurada difere da main"
[ -z "$(q estrut_rb "select proname from pg_proc where proname like 'gestao\\_financeira\\_%'")" ] && ok "guarda e lista removidas pelo rollback" || bad "restaram funções gestao_financeira_*"
fin estrut_rb "" && ok "reaplica 120 → 121 → 122 depois do rollback"

echo; [ -z "$FALHOU" ] && echo "TRANSFERÊNCIA × FINANCEIRO: TUDO OK" || echo "TRANSFERÊNCIA × FINANCEIRO: HÁ FALHAS"
for b in estrut_antes estrut_suite estrut_ctl estrut_rb; do $SU -d postgres -c "drop database if exists $b" >/dev/null 2>&1; done
[ -z "$FALHOU" ]
