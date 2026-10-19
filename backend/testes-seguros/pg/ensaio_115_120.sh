#!/bin/bash
# Ensaio 115 × 120–122 (pré-voo do T3, doc 23) — SOMENTE PostgreSQL LOCAL DESCARTÁVEL (cluster com MARCADOR_DESCARTAVEL, 127.0.0.1:54321).
# Reproduz o estado do Supabase de testes compartilhado lido no diagnóstico (diagnostico_115.sql): cadeia da main com a 115 NÃO efetiva
# (115_rollback reabre as 4 views e as RPCs) e sem as funções bonificacao_* (ausentes lá). Prova, executando as funções SÓ aqui:
#   R  risco efetivo sem a 115, sob o RLS real da main (anon sem login; authenticated membro de 2 empresas);
#   A  ordem recomendada: 115 → 120 → 121 → 122;
#   B  120 → 121 → 122 sem a 115 (a 120 não fecha o que é da 115) e a 115 depois (compatível);
#   =  A e B terminam com os mesmos privilégios e a mesma definição de remapear.
# Uso: PG_CLUSTER_DIR=C:/Users/.../pg-descartavel bash backend/testes-seguros/pg/ensaio_115_120.sh
set -u
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
AQUI="$(cd "$(dirname "$0")" && pwd)"; R="${REPO:-$(cd "$AQUI/../../.." && pwd)}"
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR (cluster DESCARTÁVEL local, com o arquivo MARCADOR_DESCARTAVEL)}"
REF_BASE="${REF_BASE:-origin/main}"
H="-h 127.0.0.1 -p 54321"; SU="psql $H -U postgres -X -q -v ON_ERROR_STOP=1"
FALHOU=""; ok() { echo "OK    $1"; }; bad() { echo "FALHA $1"; FALHOU=1; }; info() { echo "INFO  $1"; }
[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo "RECUSADO: sem MARCADOR_DESCARTAVEL em $CLUSTER"; exit 2; }
psql $H -U postgres -tAc "show data_directory" | grep -qF "$CLUSTER" || { echo "RECUSADO: o servidor em 127.0.0.1:54321 não é o cluster descartável"; exit 2; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
q() { psql $H -U postgres -X -tA -d "$1" -c "$2" 2>&1; }
dono() { psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d "$1" -f "$2" 2>&1; }
M="$R/database/migrations"; P122="$R/docs/gestao-financeira/proposta-122"

# ---------- montagem: cadeia da main (como em transferencia_unidades.sh), depois o estado do banco de testes ----------
psql $H -U postgres -tAc "select 1 from pg_roles where rolname='dono_sim'" | grep -q 1 || {
  $SU -d postgres -c "create role dono_sim login nosuperuser nobypassrls createrole" -c "create role anon nologin" -c "create role authenticated nologin" -c "create role service_role nologin bypassrls" >/dev/null 2>&1; }
novo_banco() { $SU -d postgres -c "drop database if exists $1" -c "create database $1 owner dono_sim ${2:+template $2}" 2>&1 | grep -v NOTICE; }
novo_banco e115_base
$SU -d e115_base -c "grant all on schema public to dono_sim; grant usage on schema public to anon, authenticated, service_role" >/dev/null
psql $H -U dono_sim -X -q -d e115_base -c "alter default privileges in schema public grant all on tables to anon, authenticated, service_role; alter default privileges in schema public grant all on sequences to anon, authenticated, service_role; alter default privileges in schema public grant all on functions to anon, authenticated, service_role" >/dev/null
$SU -d e115_base -f "$AQUI/stub_supabase_externo.sql" >/dev/null 2>&1 || { bad "stub do Supabase"; exit 1; }
LISTA=$(git -C "$R" ls-tree --name-only "$REF_BASE" database/migrations/ | sed 's#database/migrations/##' | grep -v rollback | grep -E '^(000_|06[89]_|0[7-9][0-9]_|1[01][0-9]_|12[3-9]_)' | sort)
N=0; for f in $LISTA; do
  git -C "$R" show "$REF_BASE:database/migrations/$f" > "$TMP/$f"
  psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d e115_base -f "$TMP/$f" > "$TMP/$f.log" 2>&1 || { bad "base: $f"; grep -m2 ERRO "$TMP/$f.log"; exit 1; }; N=$((N+1))
done
ok "e115_base: $N migrations de $REF_BASE @ $(git -C "$R" rev-parse --short "$REF_BASE") (inclui a 115)"
novo_banco e115_teste e115_base
dono e115_teste "$M/115_rollback.sql" >/dev/null || { bad "115_rollback"; exit 1; }
$SU -d e115_teste -c "drop function public.bonificacao_congelar_competencia(uuid,uuid,integer,integer,text,jsonb,jsonb,text,uuid,text); drop function public.bonificacao_reabrir_competencia(uuid,integer,integer,text,uuid,text)" >/dev/null 2>&1 || { bad "remover bonificacao_*"; exit 1; }

RPCS="'converter_empresa_para_unidade','excluir_organizacao_definitivamente','promover_unidade_para_empresa','remapear_organizacao_em_tabelas_de_unidade','transferir_unidade_organizacao'"
VIEWS="'vw_estoque_critico','vw_faturamento_diario','vw_produto_margem','vw_produtos_vendidos'"
ABERTOS="select (select count(*) from pg_proc p, unnest(array['anon','authenticated']) r where p.pronamespace='public'::regnamespace and p.proname in ($RPCS) and has_function_privilege(r, p.oid, 'execute'))
  || '/' || (select count(*) from pg_class c, unnest(array['anon','authenticated']) r where c.relnamespace='public'::regnamespace and c.relname in ($VIEWS) and has_table_privilege(r, c.oid, 'select'))
  || '/' || (select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ($RPCS) and has_function_privilege('service_role', p.oid, 'execute'))
  || '/' || (select count(*) from pg_class c where c.relnamespace='public'::regnamespace and c.relname in ($VIEWS) and has_table_privilege('service_role', c.oid, 'select'))"
[ "$(q e115_teste "$ABERTOS")" = "10/8/5/4" ] && ok "e115_teste reproduz o banco de testes: anon+authenticated executam as 5 RPCs (10) e leem as 4 views (8); service_role 5/4; bonificacao_* ausentes" \
  || bad "estado do banco de testes não reproduzido: $(q e115_teste "$ABERTOS")"

# Cenário: empresas A e B, unidade U em A com uma conexão iFood e uma venda; usuário X membro ativo de A e de B (papel comum, não SuperAdmin)
A=00000000-0000-0000-0000-0000000115a1; B=00000000-0000-0000-0000-0000000115b1; U=00000000-0000-0000-0000-0000000115c1; X=00000000-0000-0000-0000-0000000115d1
CEN="insert into auth.users (id) values ('$X'), ('00000000-0000-0000-0000-00000000a70a') on conflict do nothing;
insert into organizacoes (id, nome) values ('$A', '[115] A'), ('$B', '[115] B');
insert into unidades (id, organizacao_id, nome) values ('$U', '$A', '[115] U');
insert into ifood_conexoes (organizacao_id, unidade_id) values ('$A', '$U');
insert into vendas (unidade_id, valor_total) values ('$U', 123.45);
set session_replication_role = replica;  -- so para o vinculo sem perfil operacional (FK); CHECKs continuam valendo (ASCII: -c no Windows)
insert into usuarios_organizacoes (usuario_id, organizacao_id, papel, ativo, perfil_id) values ('$X', '$A', 'viewer', true, gen_random_uuid()), ('$X', '$B', 'viewer', true, gen_random_uuid());
insert into usuarios_unidades (usuario_id, unidade_id, papel, ativo, perfil_id) values ('$X', '$U', 'viewer', true, gen_random_uuid());
insert into parser_fd_importacoes (organizacao_id, unidade_id, periodo_inicio, periodo_fim, hash_arquivo) values ('$A', '$U', date '2026-09-01', date '2026-09-30', repeat('ab', 32));"
q e115_teste "$CEN" > "$TMP/cen" ; grep -q ERRO "$TMP/cen" && { bad "cenário: $(cat "$TMP/cen")"; exit 1; }
ANON="set role anon; set request.jwt.claims = '{\"role\":\"anon\"}';"
AUTH="set role authenticated; set request.jwt.claims = '{\"sub\":\"$X\",\"role\":\"authenticated\"}';"
SR="set role service_role;"
ESTADO="select (select organizacao_id from unidades where id='$U')::text || ' ifood=' || (select string_agg(organizacao_id::text, ',') from ifood_conexoes where unidade_id='$U')
  || ' parser=' || (select string_agg(organizacao_id::text, ',') from parser_fd_importacoes where unidade_id='$U')"
E0=$(q e115_teste "$ESTADO")
como() { psql $H -U postgres -X -q -tA -d "$1" -c "$2 $3" 2>&1; }   # $1 banco, $2 papel, $3 SQL

# ---------- R) risco efetivo SEM a 115 (o que o banco de testes tem hoje) ----------
V=$(como e115_teste "$ANON" "select count(*) from vw_faturamento_diario"); T=$(como e115_teste "$ANON" "select count(*) from vendas")
[ "$V" = "1" ] && [ "$T" = "0" ] && ok "R1 anon (sem login): a view devolve o faturamento ($V linha) que o RLS da tabela vendas esconde ($T) — a view roda como o dono e ignora o RLS" || bad "R1: view=$V tabela=$T"
O=$(como e115_teste "$ANON" "select transferir_unidade_organizacao('$U', '$B', '00000000-0000-0000-0000-00000000a70a')")
echo "$O" | grep -q "Unidade não encontrada" && [ "$(q e115_teste "$ESTADO")" = "$E0" ] && ok "R2 anon: transferir executa, mas o RLS esconde a unidade ('Unidade não encontrada'); nada muda" || bad "R2: $O"
O=$(como e115_teste "$ANON" "select remapear_organizacao_em_tabelas_de_unidade('$U', '$A', '$B')")
[ "$O" = "{}" ] && [ "$(q e115_teste "$ESTADO")" = "$E0" ] && ok "R3 anon: remapear executa e não altera nenhuma linha (sem policy para anon)" || bad "R3: $O"
O=$(como e115_teste "$AUTH" "select transferir_unidade_organizacao('$U', '$B', '00000000-0000-0000-0000-00000000a70a')")
echo "$O" | grep -q ERRO && [ "$(q e115_teste "$ESTADO")" = "$E0" ]   && ok "R4 authenticated (membro de A e B): transferir executa e chega a mover a unidade, mas aborta inteira ($(echo "$O" | head -1 | cut -c1-80)); nada muda" || bad "R4: $O | $(q e115_teste "$ESTADO")"
VARRE="select c1.table_name::text as t from information_schema.columns c1 join information_schema.columns c2 on c2.table_schema=c1.table_schema and c2.table_name=c1.table_name and c2.column_name='unidade_id'
  join information_schema.tables tt on tt.table_schema=c1.table_schema and tt.table_name=c1.table_name and tt.table_type='BASE TABLE'
  where c1.table_schema='public' and c1.column_name='organizacao_id' and c1.table_name not in ('martin_brower_vinculos','sessoes_contexto','insumo_historico')
    and not has_table_privilege('authenticated', format('%I.%I', c1.table_schema, c1.table_name), 'update')"
NFALTA=$(q e115_teste "select count(*) from ($VARRE) s")
O=$(como e115_teste "$AUTH" "select remapear_organizacao_em_tabelas_de_unidade('$U', '$A', '$B')")
echo "$O" | grep -qi "permission denied\|permissão negada" && [ "$(q e115_teste "$ESTADO")" = "$E0" ] \
  && ok "R5 authenticated: remapear direto aborta inteira porque falta UPDATE em $NFALTA tabela(s) da varredura (no banco de testes: 8); nada muda" || bad "R5: $O"
novo_banco e115_r5 e115_teste
q e115_r5 "do \$\$ declare r record; begin for r in $VARRE loop execute format('grant select, update on public.%I to authenticated', r.t); end loop; end \$\$" >/dev/null
O=$(como e115_r5 "$AUTH" "select remapear_organizacao_em_tabelas_de_unidade('$U', '$A', '$B')"); E1=$(q e115_r5 "$ESTADO")
[ "$E1" = "$A ifood=$B parser=$B" ] && ok "R5b risco LATENTE: com SELECT+UPDATE nessas tabelas (um GRANT de qualquer frente), o mesmo authenticated grava $O — conexão iFood e importação do Parser FD em B com a unidade em A, sem auditoria. A 115 é o que impede isso por desenho"   || bad "R5b: esperado ifood em B com a unidade em A; veio $O | $E1"
$SU -d postgres -c "drop database if exists e115_r5" >/dev/null 2>&1
O=$(como e115_teste "$AUTH" "update unidades set organizacao_id='$B' where id='$U' returning 1")
[ "$O" = "1" ] && info "R6 [fora da 115] authenticated membro de A e B também consegue UPDATE direto de unidades.organizacao_id pela tabela (policy rls_unidades_tenant da main); a 115 não trata tabelas" || info "R6: $O"
q e115_teste "update unidades set organizacao_id='$A' where id='$U'" >/dev/null
[ "$(q e115_teste "$ESTADO")" = "$E0" ] || { bad "cenário não restaurado"; exit 1; }

# ---------- A) ordem recomendada: 115 → 120 → 121 → 122 ----------
novo_banco e115_a e115_teste
O=$(dono e115_a "$M/115_fecha_acesso_direto_residual.sql")
echo "$O" | grep -q "4 views e 5 funções" && ok "A1 115 aplica sem as bonificacao_* (como no banco de testes): $(echo "$O" | grep -o '4 views e 5 funções[^.]*')" || bad "A1 115: $O"
[ "$(q e115_a "$ABERTOS")" = "0/0/5/4" ] && ok "A2 depois da 115: anon/authenticated 0 RPCs e 0 views; service_role mantém 5 RPCs e 4 views (backend intacto)" || bad "A2: $(q e115_a "$ABERTOS")"
dono e115_a "$M/115_fecha_acesso_direto_residual.sql" | grep -q "4 views e 5 funções" && ok "A3 115 reaplicada: idempotente" || bad "A3 115 não idempotente"
O1=$(como e115_a "$ANON" "select count(*) from vw_faturamento_diario"); O2=$(como e115_a "$AUTH" "select remapear_organizacao_em_tabelas_de_unidade('$U', '$A', '$B')")
echo "$O1" | grep -qi "permission denied\|permissão negada" && echo "$O2" | grep -qi "permission denied\|permissão negada" && [ "$(q e115_a "$ESTADO")" = "$E0" ] \
  && ok "A4 R1 e R5 fechados: anon sem leitura da view; authenticated sem EXECUTE em remapear" || bad "A4: $O1 | $O2"
O=$(como e115_a "$SR" "select (r - 'unidadeId' - 'novaOrganizacaoId' - 'organizacaoAnteriorId')::text from transferir_unidade_organizacao('$U', '$B', '00000000-0000-0000-0000-00000000a70a') r")
[ "$(q e115_a "$ESTADO")" = "$B ifood=$B parser=$B" ] && ok "A5 backend (service_role) continua transferindo depois da 115: $O" || bad "A5: $O"
q e115_a "set role service_role; select transferir_unidade_organizacao('$U', '$A', '00000000-0000-0000-0000-00000000a70a')" >/dev/null
for f in "$M/120_gestao_financeira_fundacao.sql" "$M/121_gestao_financeira_dominio.sql" "$P122/122_conciliacao_periodos.provisorio.sql"; do
  O=$(dono e115_a "$f") || { bad "A6 $(basename "$f") depois da 115: $(echo "$O" | grep -m2 ERRO)"; break; }
done; [ -z "$FALHOU" ] && ok "A6 120 → 121 → 122 aplicam depois da 115 (pré e pós-condições da 120 passam)"
[ "$(q e115_a "$ABERTOS")" = "0/0/5/4" ] && ok "A7 a 120 (create or replace de remapear) preserva o fechamento da 115: 0/0/5/4" || bad "A7: $(q e115_a "$ABERTOS")"
O=$(como e115_a "$SR" "select (r - 'unidadeId' - 'novaOrganizacaoId' - 'organizacaoAnteriorId')::text from transferir_unidade_organizacao('$U', '$B', '00000000-0000-0000-0000-00000000a70a') r")
[ "$(q e115_a "$ESTADO")" = "$B ifood=$B parser=$B" ] && ok "A8 com 115+120–122: transferência pelo backend de unidade sem Financeiro igual à da main: $O" || bad "A8: $O"
q e115_a "set role service_role; select transferir_unidade_organizacao('$U', '$A', '00000000-0000-0000-0000-00000000a70a')" >/dev/null
O=$(como e115_a "$AUTH" "update unidades set organizacao_id='$B' where id='$U'")
echo "$O" | grep -qi "permission denied\|permissão negada" && [ "$(q e115_a "$ESTADO")" = "$E0" ] \
  && ok "A9 efeito colateral da 120 (desejado): o UPDATE direto de R6 por authenticated agora falha (o gatilho chama a guarda, sem EXECUTE para ele)" || bad "A9: $O"
O=$(como e115_a "$AUTH" "update unidades set nome = nome where id='$U' returning 1")
[ "$O" = "1" ] && ok "A10 authenticated continua podendo editar outras colunas da unidade (o gatilho só olha organizacao_id)" || bad "A10: $O"

# ---------- B) sem a 115: 120 → 121 → 122; depois a 115 ----------
novo_banco e115_b e115_teste
for f in "$M/120_gestao_financeira_fundacao.sql" "$M/121_gestao_financeira_dominio.sql" "$P122/122_conciliacao_periodos.provisorio.sql"; do
  O=$(dono e115_b "$f") || { bad "B1 $(basename "$f") sem a 115: $(echo "$O" | grep -m2 ERRO)"; break; }
done; ok "B1 120 → 121 → 122 aplicam SEM a 115 (não dependem dela)"
[ "$(q e115_b "$ABERTOS")" = "10/8/5/4" ] && ok "B2 a 120 NÃO fecha o que é da 115: anon/authenticated continuam com EXECUTE nas 5 RPCs e SELECT nas 4 views" || bad "B2: $(q e115_b "$ABERTOS")"
V=$(como e115_b "$ANON" "select count(*) from vw_faturamento_diario")
[ "$V" = "1" ] && ok "B3 sem a 115, a exposição das views continua depois do Financeiro (R1 = $V linha)" || bad "B3: $V"
O=$(como e115_b "$AUTH" "select remapear_organizacao_em_tabelas_de_unidade('$U', '$A', '$B')")
echo "$O" | grep -qi "permission denied\|permissão negada" && [ "$(q e115_b "$ESTADO")" = "$E0" ] \
  && ok "B4 efeito da 120 sem a 115: R5 deixa de funcionar porque a guarda financeira (sem EXECUTE para authenticated) aborta remapear" || bad "B4: $O"
DEF="select md5(pg_get_functiondef('public.remapear_organizacao_em_tabelas_de_unidade(uuid,uuid,uuid)'::regprocedure))"
D0=$(q e115_b "$DEF")
O=$(dono e115_b "$M/115_fecha_acesso_direto_residual.sql")
echo "$O" | grep -q "4 views e 5 funções" && ok "B5 115 aplica DEPOIS da 120–122 (pré e pós-condições passam)" || bad "B5: $O"
[ "$(q e115_b "$DEF")" = "$D0" ] && [ "$(q e115_b "$ABERTOS")" = "0/0/5/4" ] && ok "B6 a 115 não toca na definição de remapear (guarda preservada) e fecha 0/0/5/4" || bad "B6"
G="select has_function_privilege('service_role', 'public.gestao_financeira_verificar_unidade_transferivel(uuid)', 'execute')::text || has_function_privilege('service_role', 'public.gestao_financeira_tabelas_da_unidade()', 'execute')::text
  || (select count(*) from pg_trigger where tgrelid='public.unidades'::regclass and tgname='trg_unidades_guarda_financeiro' and tgenabled <> 'D')"
[ "$(q e115_b "$G")" = "truetrue1" ] && ok "B7 depois da 115: guardas da 120 continuam executáveis pelo service_role e o gatilho em unidades continua ativo" || bad "B7: $(q e115_b "$G")"

# ---------- = A e B convergem ----------
ACL="select string_agg(x, ' | ' order by x) from (
  select p.oid::regprocedure::text || '=' || coalesce(p.proacl::text, '') as x from pg_proc p where p.pronamespace='public'::regnamespace
   and (p.proname in ($RPCS) or p.proname like 'gestao\_financeira\_%' or p.proname like 'fin\_%' or p.proname like 'gfc\_%')
  union all select c.relname || '=' || coalesce(c.relacl::text, '') from pg_class c where c.relnamespace='public'::regnamespace
   and (c.relname in ($VIEWS) or c.relname like 'fin\_%' or c.relname like 'gestao\_financeira\_%')) s"
[ "$(q e115_a "$ACL")" = "$(q e115_b "$ACL")" ] && [ "$(q e115_a "$DEF")" = "$(q e115_b "$DEF")" ] \
  && ok "=  115→120–122 e 120–122→115 terminam com privilégios idênticos ($(q e115_a "select count(*) from pg_proc where pronamespace='public'::regnamespace and (proname like 'fin\_%' or proname like 'gestao\_financeira\_%' or proname like 'gfc\_%')") funções financeiras + alvos da 115) e a mesma remapear" \
  || bad "as duas ordens divergem em privilégios ou na definição de remapear"

echo; [ -z "$FALHOU" ] && echo "ENSAIO 115 × 120–122: TUDO OK" || echo "ENSAIO 115 × 120–122: HÁ FALHAS"
for b in e115_teste e115_a e115_b e115_r5; do $SU -d postgres -c "drop database if exists $b" >/dev/null 2>&1; done
[ -z "$FALHOU" ]
