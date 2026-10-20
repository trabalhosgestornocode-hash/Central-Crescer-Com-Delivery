#!/bin/bash
# Simulação LOCAL do modelo de privilégios do Supabase para as migrations 120/121/122 (PostgreSQL descartável).
# O que reproduz: dono NÃO-superusuário e sem BYPASSRLS; default privileges concedendo ALL a anon/authenticated/service_role em
# tabelas, funções e sequências NOVAS; service_role com BYPASSRLS. O que NÃO reproduz (=> T3): atributos exatos dos papéis do
# Supabase, extensões/PostgREST/pg_graphql, e a ordem real de criação dos papéis.
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
S="$(cd "$(dirname "$0")" && pwd)"
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR (diretório de dados do cluster DESCARTÁVEL local, com o arquivo MARCADOR_DESCARTAVEL)}"
R="${REPO:-$(cd "$S/../../.." && pwd)}"
M="$R/database/migrations"; P122="${P122:-$R/database/migrations/122_conciliacao_periodos.sql}"; RB122="${RB122:-$R/database/migrations/122_rollback.sql}"
H="-h 127.0.0.1 -p 54321"; SU="psql $H -U postgres -q -v ON_ERROR_STOP=1"; DONO="psql $H -U dono_sim -q -v ON_ERROR_STOP=1"
FALHOU=""; ok() { echo "OK    $1"; }; bad() { echo "FALHA $1"; FALHOU=1; }; info() { echo "INFO  $1"; }

[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo "sem marcador"; exit 2; }
psql $H -U postgres -tAc "show data_directory" | grep -qF "$CLUSTER" || { echo "cluster inesperado"; exit 2; }

# ---- papéis e banco ----
$SU -d postgres -c "do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='dono_sim') then create role dono_sim login nosuperuser nobypassrls createrole; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end \$\$" >/dev/null 2>&1
$SU -d postgres -c "alter role anon nobypassrls" -c "alter role authenticated nobypassrls" -c "alter role service_role bypassrls" >/dev/null 2>&1
psql $H -U postgres -q -c "drop database if exists sim" -c "create database sim owner dono_sim" 2>&1 | grep -v NOTICE
$SU -d sim -c "grant all on schema public to dono_sim; grant usage on schema public to anon, authenticated, service_role" >/dev/null 2>&1
# default privileges do Supabase (executados pelo dono): tudo novo em public vira acessível aos três papéis
$DONO -d sim -c "alter default privileges in schema public grant all on tables to anon, authenticated, service_role; alter default privileges in schema public grant all on sequences to anon, authenticated, service_role; alter default privileges in schema public grant all on functions to anon, authenticated, service_role" >/dev/null 2>&1 && ok "default privileges do Supabase simulados (ALL para anon/authenticated/service_role em novos objetos)"
$DONO -d sim -f "$S/stub.sql" >/dev/null 2>&1 && ok "stub do esquema base aplicado COMO dono_sim (não-superusuário)"
psql $H -U postgres -tAc "select rolsuper, rolbypassrls from pg_roles where rolname='dono_sim'" | grep -q "^f|f$" && ok "dono_sim: nosuperuser, sem BYPASSRLS (pior caso para funções DEFINER e triggers)"

aplicar() { $DONO -d sim -f "$1" >/dev/null 2>"${TMPDIR:-/tmp}/err-pg.txt" && ok "aplica: $(basename "$1")" || { bad "aplica: $(basename "$1")"; head -3 "${TMPDIR:-/tmp}/err-pg.txt"; }; }
aplicar "$M/120_gestao_financeira_fundacao.sql"
aplicar "$M/121_gestao_financeira_dominio.sql"
aplicar "$P122"
aplicar "$P122"
aplicar "$M/121_gestao_financeira_dominio.sql"   # 121 reaplicada DEPOIS da 122 (restaura as versões da 121!)  -> ver nota abaixo
aplicar "$P122"                                   # e a 122 de novo: ordem canônica 120 -> 121 -> 122
[ -n "$APLICAR_122B" ] && { aplicar "$R/docs/gestao-financeira/proposta-122/122b_endurecimento.proposta.sql"; aplicar "$R/docs/gestao-financeira/proposta-122/122b_endurecimento.proposta.sql"; }

q() { psql $H -U postgres -d sim -tA -c "$1"; }

# ---- 1. tabelas: privilégios efetivos por papel ----
TAB="select c.relname from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' and (c.relname like 'fin\\_%' or c.relname like 'gestao\\_financeira\\_%')"
echo "tabelas cobertas: $(q "select count(*) from ($TAB) t")"
V=$(q "select string_agg(c.relname||'/'||r.rolname||'/'||p, ', ') from pg_class c cross join (values ('anon'),('authenticated')) r(rolname) cross join unnest(array['select','insert','update','delete','truncate','references','trigger']) p where c.relnamespace='public'::regnamespace and c.relkind='r' and (c.relname like 'fin\\_%' or c.relname like 'gestao\\_financeira\\_%') and has_table_privilege(r.rolname, c.oid, p)")
[ -z "$V" ] && ok "anon/authenticated: NENHUM privilégio em nenhuma tabela financeira (7 privilégios verificados por tabela)" || bad "anon/authenticated com acesso: $V"
V=$(q "select string_agg(c.relname||'/'||p, ', ') from pg_class c cross join unnest(array['delete','truncate','references','trigger']) p where c.relnamespace='public'::regnamespace and c.relkind='r' and (c.relname like 'fin\\_%' or c.relname like 'gestao\\_financeira\\_%') and has_table_privilege('service_role', c.oid, p)")
[ -z "$V" ] && ok "service_role: sem DELETE/TRUNCATE/REFERENCES/TRIGGER em nenhuma tabela" || bad "service_role com privilégio excessivo: $V"
V=$(q "select string_agg(c.relname||'/'||p, ', ') from pg_class c cross join unnest(array['insert','update']) p where c.relnamespace='public'::regnamespace and c.relkind='r' and c.relname in ('fin_auditoria','gestao_financeira_concessoes_auditoria') and has_table_privilege('service_role', c.oid, p) and c.relname='fin_auditoria'")
[ -z "$V" ] && ok "service_role não escreve em fin_auditoria (a trilha só é escrita por trigger DEFINER)" || bad "service_role escreve em fin_auditoria: $V"

# ---- 2. sequências ----
V=$(q "select string_agg(c.relname||'/'||r.rolname||'/'||p, ', ') from pg_class c cross join (values ('anon'),('authenticated')) r(rolname) cross join unnest(array['usage','select','update']) p where c.relnamespace='public'::regnamespace and c.relkind='S' and (c.relname like 'fin\\_%' or c.relname like 'gestao\\_financeira\\_%') and has_sequence_privilege(r.rolname, c.oid, p)")
[ -z "$V" ] && ok "sequências financeiras: anon/authenticated sem USAGE/SELECT/UPDATE" || bad "SEQUÊNCIAS EXPOSTAS a anon/authenticated: $V"
info "sequências financeiras: $(q "select string_agg(relname, ',') from pg_class where relnamespace='public'::regnamespace and relkind='S' and (relname like 'fin\\_%' or relname like 'gestao\\_financeira\\_%')")"
info "service_role em sequências: $(q "select string_agg(c.relname||'='||has_sequence_privilege('service_role', c.oid, 'usage')::text, ', ') from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='S' and (c.relname like 'fin\\_%' or c.relname like 'gestao\\_financeira\\_%')")"

# ---- 3. funções: EXECUTE efetivo ----
FN="select p.oid, p.proname, p.prosecdef, p.prorettype::regtype::text rt from pg_proc p where p.pronamespace='public'::regnamespace and (p.proname like 'fin\\_%' or p.proname like 'gfc\\_%')"
V=$(q "select string_agg(f.proname||'/'||r.rolname, ', ') from ($FN) f cross join (values ('anon'),('authenticated')) r(rolname) where has_function_privilege(r.rolname, f.oid, 'execute')")
[ -z "$V" ] && ok "NENHUMA função fin_*/gfc_* (RPC ou gatilho) executável por anon/authenticated (efetivo, incl. PUBLIC)" || bad "funções executáveis por anon/authenticated: $V"
info "funções com EXECUTE para service_role: $(q "select string_agg(f.proname, ', ' order by f.proname) from ($FN) f where f.rt <> 'trigger' and has_function_privilege('service_role', f.oid, 'execute')")"
V=$(q "select string_agg(f.proname, ', ') from ($FN) f where f.rt = 'trigger' and has_function_privilege('service_role', f.oid, 'execute')")
[ -z "$V" ] && ok "funções-gatilho: sem EXECUTE para service_role" || info "funções-gatilho com EXECUTE para service_role (não chamáveis como RPC, mas anotar): $V"

# ---- 4. SECURITY DEFINER: search_path e dono ----
V=$(q "select string_agg(proname, ', ') from pg_proc where pronamespace='public'::regnamespace and prosecdef and (proname like 'fin\\_%' or proname like 'gfc\\_%') and not (coalesce(proconfig, '{}')::text ~ 'search_path')")
[ -z "$V" ] && ok "toda função SECURITY DEFINER tem search_path fixo" || bad "DEFINER sem search_path: $V"
info "SECURITY DEFINER: $(q "select string_agg(proname||' ['||coalesce(proconfig::text,'-')||']', '; ') from pg_proc where pronamespace='public'::regnamespace and prosecdef and (proname like 'fin\\_%' or proname like 'gfc\\_%')")"
V=$(q "select string_agg(distinct pg_get_userbyid(p.proowner), ',') from pg_proc p where p.pronamespace='public'::regnamespace and (p.proname like 'fin\\_%' or p.proname like 'gfc\\_%')")
V2=$(q "select string_agg(distinct pg_get_userbyid(c.relowner), ',') from pg_class c where c.relnamespace='public'::regnamespace and (c.relname like 'fin\\_%' or c.relname like 'gestao\\_financeira\\_%')")
[ "$V" = "dono_sim" ] && [ "$V2" = "dono_sim" ] && ok "dono de tabelas e funções = dono_sim (não-superusuário, sem BYPASSRLS)" || bad "donos inesperados: funções=$V tabelas=$V2"

# ---- 5. RLS ----
V=$(q "select string_agg(relname, ',') from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' and (c.relname like 'fin\\_%' or c.relname like 'gestao\\_financeira\\_%') and not relrowsecurity")
[ -z "$V" ] && ok "RLS LIGADO em todas as tabelas financeiras" || bad "RLS desligado: $V"
POL=$(q "select count(*) from pg_policies where schemaname='public' and (tablename like 'fin\\_%' or tablename like 'gestao\\_financeira\\_%')"); [ "$POL" = "0" ] && ok "zero policies" || bad "policies=$POL"
info "FORCE RLS: $(q "select string_agg(relname||'='||relforcerowsecurity::text, ',') from pg_class where relnamespace='public'::regnamespace and relkind='r' and (relname like 'gestao\\_financeira\\_%' or relname='fin_lancamentos' or relname='fin_periodos')")"

# ---- 6. tentativas reais (SET ROLE) ----
tenta() { # papel, sql, esperado(neg|ok), descrição
  OUT=$(psql $H -U postgres -d sim -q -c "set role $1; $2" 2>&1); RC=$?
  if [ "$3" = "neg" ]; then echo "$OUT" | grep -qiE "permission denied|negada|não tem permissão|sem permissão" && ok "$4" || { bad "$4  (saída: $(echo "$OUT" | head -1))"; }
  else echo "$OUT" | grep -qiE "ERROR|ERRO" && bad "$4 (saída: $(echo "$OUT" | head -1))" || ok "$4"; fi
}
tenta anon "select * from fin_lancamentos limit 1" neg "anon: SELECT em fin_lancamentos negado"
tenta authenticated "update fin_lancamentos set status='cancelado'" neg "authenticated: UPDATE em fin_lancamentos negado"
tenta authenticated "select * from gestao_financeira_concessoes" neg "authenticated: SELECT em concessões negado"
tenta authenticated "insert into gestao_financeira_concessoes_auditoria(concessao_id,organizacao_id,unidade_id,perfil_id,evento) values (gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'concedida')" neg "authenticated: INSERT na auditoria de concessões negado"
tenta anon "select nextval('fin_auditoria_id_seq')" neg "anon: nextval da sequência de auditoria negado"
tenta authenticated "select nextval('gestao_financeira_concessoes_auditoria_id_seq')" neg "authenticated: nextval da sequência da auditoria de concessões negado"
tenta anon "select fin_fechar_periodo(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),date '2026-01-01',1,'x','{}',array[]::text[],false)" neg "anon: EXECUTE de fin_fechar_periodo negado"
tenta authenticated "select fin_cancelar_transferencia(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'motivo longo o bastante')" neg "authenticated: EXECUTE de fin_cancelar_transferencia negado"
tenta service_role "delete from fin_lancamentos" neg "service_role: DELETE em fin_lancamentos negado"
tenta service_role "truncate fin_lancamentos" neg "service_role: TRUNCATE em fin_lancamentos negado"
tenta service_role "insert into fin_auditoria(acao,entidade) values ('x','y')" neg "service_role: INSERT direto em fin_auditoria negado"
tenta service_role "select fin_desvincular_transferencia(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid())" neg "service_role: desvínculo SEM motivo (121) não é mais executável"
tenta service_role "select count(*) from fin_lancamentos" ok "service_role: SELECT em fin_lancamentos funciona (bypass de RLS do papel)"

# ---- 7. comportamento ponta a ponta COM os privilégios mínimos (service_role) ----
$SU -d sim -c "insert into organizacoes(id,nome) values ('00000000-0000-0000-0000-0000000000a1','Org A'); insert into unidades(id,organizacao_id,nome) values ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000a1','UA'); insert into perfis(id) values ('00000000-0000-0000-0000-000000000c01'); insert into perfis_operacionais(id,conta_id,nome) values ('00000000-0000-0000-0000-000000000d01','00000000-0000-0000-0000-000000000c01','P1'); insert into usuarios_unidades(usuario_id,unidade_id) values ('00000000-0000-0000-0000-000000000c01','00000000-0000-0000-0000-0000000000a2')" >/dev/null 2>&1
OUT=$(psql $H -U postgres -d sim -q -c "set role service_role; insert into gestao_financeira_concessoes(organizacao_id,unidade_id,perfil_id,nivel,concedida_por,motivo) values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000d01','gestor','00000000-0000-0000-0000-000000000999','Autorizado pela diretoria')" 2>&1)
echo "$OUT" | grep -qiE "ERROR|ERRO" && bad "service_role: conceder (INSERT + gatilhos + sequência da auditoria) FALHOU: $(echo "$OUT" | head -1)" || ok "service_role: INSERT em concessões funciona (gatilhos disparam sem EXECUTE direto; sequência da auditoria utilizável)"
[ "$(q "select count(*) from gestao_financeira_concessoes_auditoria where evento='concedida'")" = "1" ] && ok "trilha de auditoria da concessão gravada pelo gatilho" || bad "auditoria da concessão não gravada"
tenta service_role "delete from gestao_financeira_concessoes" neg "service_role: DELETE em concessões negado (revoga-se, não se apaga)"
tenta service_role "truncate gestao_financeira_concessoes_auditoria" neg "service_role: TRUNCATE na auditoria de concessões negado"
tenta service_role "select gfc_validar()" neg "service_role: chamar função-gatilho gfc_validar() negado"
OUT=$(psql $H -U postgres -d sim -q -c "set role service_role; update gestao_financeira_concessoes set revogada_em=now(), revogada_por='00000000-0000-0000-0000-000000000999', motivo_revogacao='Mudou de funcao na empresa'" 2>&1)
echo "$OUT" | grep -qiE "ERROR|ERRO" && bad "service_role: revogar falhou: $(echo "$OUT" | head -1)" || ok "service_role: revogar (UPDATE) funciona e gatilho de auditoria dispara"

echo; [ -z "$FALHOU" ] && echo "SIMULAÇÃO SUPABASE: SEM FALHAS" || echo "SIMULAÇÃO SUPABASE: COM FALHAS (ver acima)"
