#!/bin/bash
# Configurações 2.0 + Central de Notificações (132–135) — SOMENTE PostgreSQL LOCAL DESCARTÁVEL (cluster com MARCADOR_DESCARTAVEL,
# 127.0.0.1:54321; mesmas travas de transferencia_checklist_metas.sh). Nada de banco remoto.
#   nt_main   = cadeia REAL de origin/main (até a 131), como dono não-superusuário com os privilégios do Supabase
#   nt_branch = nt_main + 132 → 133 → 134 → 135 (árvore de trabalho)
# Prova: D-1 IDÊNTICO (mesmas mensagens/chaves/conteúdo/horários) antes e depois das migrations e na ativação M3; M3 atômica,
# idempotente, sem estado intermediário (duas sessões), equivalência verificada; unidades posteriores não herdam; transferência
# sem tocar a função da 054; OTP (uso único, 5 tentativas, 60 s, concorrência); consentimento; revogação imediata (legado e fila);
# privilégios mínimos; nenhuma tabela nova com o par organizacao_id+unidade_id; rollbacks.
# Uso: PG_CLUSTER_DIR=<cluster descartável> bash backend/testes-seguros/pg/notificacoes_config2.sh
set -u
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
AQUI="$(cd "$(dirname "$0")" && pwd)"; R="${REPO:-$(cd "$AQUI/../../.." && pwd)}"; M="$R/database/migrations"
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR (cluster DESCARTÁVEL local, com o arquivo MARCADOR_DESCARTAVEL)}"
REF_BASE="${REF_BASE:-origin/main}"
H="-h 127.0.0.1 -p 54321"; SU="psql $H -U postgres -X -q -v ON_ERROR_STOP=1"
FALHOU=""; N_OK=0; N_F=0
ok() { echo "OK    $1"; N_OK=$((N_OK+1)); }; bad() { echo "FALHA $1"; FALHOU=1; N_F=$((N_F+1)); }; info() { echo "INFO  $1"; }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — esperado [$3], obtido [$2]"; fi; }
[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo "RECUSADO: sem MARCADOR_DESCARTAVEL em $CLUSTER"; exit 2; }
psql $H -U postgres -tAc "show data_directory" | grep -qF "$CLUSTER" || { echo "RECUSADO: o servidor em 127.0.0.1:54321 não é o cluster descartável"; exit 2; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
q() { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d "$1" -c "$2" 2>&1; }
sr() { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d "$1" -c "set role service_role; $2" 2>&1 | grep -v '^SET$'; }
como() { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d "$1" -c "set role $2; $3" 2>&1 | grep -v '^SET$'; }

# ---------- montagem: cadeia real da main ----------
psql $H -U postgres -tAc "select 1 from pg_roles where rolname='dono_sim'" | grep -q 1 || \
  $SU -d postgres -c "create role dono_sim login nosuperuser nobypassrls createrole" -c "create role anon nologin" -c "create role authenticated nologin" -c "create role service_role nologin bypassrls" >/dev/null 2>&1
novo_banco() { $SU -d postgres -c "drop database if exists $1" -c "create database $1 owner dono_sim ${2:+template $2}" 2>&1 | grep -v -i "notice\|nota"; }
aplicar() { psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d "$1" -f "$2" > "$TMP/ap.log" 2>&1; }
novo_banco nt_main
$SU -d nt_main -c "grant all on schema public to dono_sim; grant usage on schema public to anon, authenticated, service_role" >/dev/null
psql $H -U dono_sim -X -q -d nt_main -c "alter default privileges in schema public grant all on tables to anon, authenticated, service_role; alter default privileges in schema public grant all on sequences to anon, authenticated, service_role; alter default privileges in schema public grant all on functions to anon, authenticated, service_role" >/dev/null
$SU -d nt_main -f "$AQUI/stub_supabase_externo.sql" >/dev/null 2>&1 || { bad "stub do Supabase"; exit 1; }
LISTA=$(git -C "$R" ls-tree --name-only "$REF_BASE" database/migrations/ | sed 's#database/migrations/##' | grep -v rollback | grep -E '^(000_|06[89]_|0[7-9][0-9]_|1[01][0-9]_|12[3-8]_)' | sort)
NM=0; for f in $LISTA 120_gestao_financeira_fundacao.sql 121_gestao_financeira_dominio.sql 122_conciliacao_periodos.sql 129_ifood_privilegios_minimos.sql 130_operacional_camada_fechamento.sql 131_checklist_metas_transferencia_unidade.sql; do
  git -C "$R" show "$REF_BASE:database/migrations/$f" > "$TMP/$f"
  aplicar nt_main "$TMP/$f" || { bad "main: $f"; grep -m3 -i "erro\|error" "$TMP/ap.log"; exit 1; }; NM=$((NM+1))
done
ok "nt_main: $NM migrations REAIS de $REF_BASE @ $(git -C "$R" rev-parse --short "$REF_BASE") (até a 131) como dono não-superusuário"
FN_AG="select md5(pg_get_functiondef('comunicacao_agendar_mensagens_alerta(uuid,text,text,jsonb,integer)'::regprocedure))"
FN_RES="select md5(pg_get_functiondef('comunicacao_resolver_destinatarios(uuid,text)'::regprocedure))"
MD_AG_MAIN=$(q nt_main "$FN_AG"); MD_RES_MAIN=$(q nt_main "$FN_RES")

novo_banco nt_branch nt_main
for f in 132_configuracoes2_fuso_unidade_convites_usuario.sql 133_notificacoes_escopos_snapshot_m3.sql 134_notificacoes_otp_consentimento.sql 135_notificacoes_cotas_categoria.sql; do
  aplicar nt_branch "$M/$f" && ok "nt_branch: $f aplicada" || { bad "nt_branch: $f"; head -5 "$TMP/ap.log"; exit 1; }
done
for f in 132_configuracoes2_fuso_unidade_convites_usuario.sql 133_notificacoes_escopos_snapshot_m3.sql 134_notificacoes_otp_consentimento.sql 135_notificacoes_cotas_categoria.sql; do
  aplicar nt_branch "$M/$f" || bad "reaplicar $f (idempotência)"; done; ok "132–135 reaplicadas: idempotentes"
chk "resolvedor do D-1 (104) intacto na branch" "$(q nt_branch "$FN_RES")" "$MD_RES_MAIN"
chk "seleção por escopo nasce DESLIGADA e o snapshot vazio" "$(q nt_branch "select comunicacao_selecao_por_escopo_ligada()::text || '/' || (select count(*) from comunicacao_legado_snapshot) || '/' || (select count(*) from comunicacao_destinatario_escopos)")" "false/0/0"

# ---------- estrutura e privilégios ----------
PAR="select coalesce(string_agg(c.relname, ','), '(nenhuma)') from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relkind='r' and c.relname in ('usuarios_convites','comunicacao_destinatario_escopos','comunicacao_legado_snapshot','comunicacao_convites','comunicacao_desafios_titular','comunicacao_consentimentos','comunicacao_termos')
   and exists (select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='organizacao_id' and not a.attisdropped)
   and exists (select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='unidade_id' and not a.attisdropped)"
chk "D-11: nenhuma tabela nova tem o par organizacao_id + unidade_id (fora do remapeamento)" "$(q nt_branch "$PAR")" "(nenhuma)"
TABS="usuarios_convites comunicacao_destinatario_escopos comunicacao_legado_snapshot comunicacao_convites comunicacao_desafios_titular comunicacao_consentimentos comunicacao_termos"
PRIV=0; for t in $TABS; do for p in anon authenticated; do
  v=$(q nt_branch "select has_table_privilege('$p','$t','SELECT') or has_table_privilege('$p','$t','INSERT') or has_table_privilege('$p','$t','UPDATE') or has_table_privilege('$p','$t','DELETE')")
  [ "$v" = "f" ] || { PRIV=1; info "$p tem privilégio em $t"; }; done; done
[ $PRIV = 0 ] && ok "anon/authenticated sem NENHUM privilégio nas 7 tabelas novas" || bad "privilégio de cliente em tabela nova"
chk "service_role: snapshot e livro-razão sem UPDATE/DELETE; escopo sem DELETE" "$(q nt_branch "select has_table_privilege('service_role','comunicacao_legado_snapshot','UPDATE')::text||has_table_privilege('service_role','comunicacao_consentimentos','DELETE')::text||has_table_privilege('service_role','comunicacao_destinatario_escopos','DELETE')::text")" "falsefalsefalse"
chk "anon/authenticated sem EXECUTE em NENHUMA função nova (inclusive gatilhos)" "$(q nt_branch "select coalesce(string_agg(p.proname, ','), '0') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname ~ '^(comunicacao_(ativar|desativar|escopo|legado|desafio|titular|revogar|resolver_destinatarios_(unidade|por_escopo)|cota|selecao|faixa|registro_imutavel|consentimento|bloquear|convites)|usuarios_convite|unidades_validar)' and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))")" "0"

# ---------- cenário (igual nos dois bancos) ----------
ORG_A=00000000-0000-0000-0000-0000000f0a01; ORG_B=00000000-0000-0000-0000-0000000f0b01; ORG_C=00000000-0000-0000-0000-0000000f0c01
ATOR=00000000-0000-0000-0000-00000000a70f
UA() { printf '00000000-0000-0000-0000-0000000f0e%02d' "$1"; }
CE() { printf '00000000-0000-0000-0000-0000000fce%02d' "$1"; }; CW() { printf '00000000-0000-0000-0000-0000000fcf%02d' "$1"; }
ALR() { printf '00000000-0000-0000-0000-0000000fa%03d' "$1"; }
CEN="insert into auth.users (id) values ('$ATOR') on conflict do nothing;
insert into modulos (id, nome, categoria) values ('ifood_dashboard', 'Dashboard iFood', 'operacao') on conflict (id) do nothing;
insert into organizacoes (id, nome, status) values ('$ORG_A','[NT] A','ativa'),('$ORG_B','[NT] B','ativa'),('$ORG_C','[NT] C','ativa');
insert into unidades (id, organizacao_id, nome, ativo, eh_teste) values
 ('$(UA 1)','$ORG_A','A1',true,false),('$(UA 2)','$ORG_A','A2',true,false),('$(UA 3)','$ORG_A','A3',true,false),('$(UA 4)','$ORG_A','A4',true,false),
 ('$(UA 5)','$ORG_A','A5',true,false),('$(UA 6)','$ORG_A','A6',true,false),('$(UA 7)','$ORG_A','A-inativa',false,false),('$(UA 8)','$ORG_A','A-teste',true,true),
 ('$(UA 11)','$ORG_B','B1',true,false),('$(UA 21)','$ORG_C','C1',true,false);
insert into organizacao_modulos (organizacao_id, modulo_id) values ('$ORG_A','ifood_dashboard'),('$ORG_B','ifood_dashboard'),('$ORG_C','ifood_dashboard');
insert into unidade_modulos (unidade_id, modulo_id) select id, 'ifood_dashboard' from unidades where organizacao_id in ('$ORG_A','$ORG_B','$ORG_C');
insert into contatos_whatsapp (id, telefone_e164, verificado, verificado_em, consentimento, consentimento_em, opt_out) values
 ('$(CW 1)','+5511900000001',true,now(),true,now(),false),('$(CW 2)','+5511900000002',true,now(),true,now(),false),
 ('$(CW 3)','+5511900000003',true,now(),true,now(),false),('$(CW 4)','+5511900000004',true,now(),true,now(),true);
insert into comunicacao_contatos_empresa (id, organizacao_id, nome, telefone_e164, tipo, contato_whatsapp_id, whatsapp_status, whatsapp_validado_em, ativo) values
 ('$(CE 1)','$ORG_A','Ana','+5511900000001','principal','$(CW 1)','VALIDADO',now(),true),
 ('$(CE 2)','$ORG_A','Joao','+5511900000002','secundario','$(CW 2)','VALIDADO',now(),true),
 ('$(CE 3)','$ORG_B','Ana (B)','+5511900000001','principal','$(CW 1)','VALIDADO',now(),true),
 ('$(CE 4)','$ORG_C','Marta','+5511900000004','principal','$(CW 4)','VALIDADO',now(),true);
insert into comunicacao_destinatario_categorias (contato_empresa_id, organizacao_id, categoria, habilitado)
 select id, organizacao_id, 'pendencia_d1', true from comunicacao_contatos_empresa where organizacao_id in ('$ORG_A','$ORG_B','$ORG_C');
insert into comunicacao_habilitacoes (organizacao_id, habilitado, tipos_permitidos, timezone, envio_automatico) values
 ('$ORG_A',true,'{dashboard_ifood_d1}','America/Sao_Paulo',true),('$ORG_B',true,'{dashboard_ifood_d1}','America/Porto_Velho',true),('$ORG_C',true,'{dashboard_ifood_d1}','America/Santarem',true);"
for b in nt_main nt_branch; do q $b "$CEN" > "$TMP/cen.log"; grep -qi "erro\|error" "$TMP/cen.log" && { bad "$b: cenário"; head -3 "$TMP/cen.log"; }; done
ok "cenário: 3 empresas (A com 6 unidades + inativa + de teste), 4 destinatários legados, 1 número em 2 empresas, 1 opt-out, 3 fusos"

ALERTAS() { # $1 banco  $2 data  $3 offset de id ; um alerta D-1 DETECTED por unidade do universo
  local i=$3 sql=""; for u in $(UA 1) $(UA 2) $(UA 3) $(UA 4) $(UA 5) $(UA 6) $(UA 11) $(UA 21); do i=$((i+1))
    org=$ORG_A; case $u in $(UA 11)) org=$ORG_B;; $(UA 21)) org=$ORG_C;; esac
    sql="$sql insert into comunicacao_alertas (id, organizacao_id, unidade_id, tipo_alerta, data_referencia, severidade, chave_dedupe) values ('$(ALR $i)','$org','$u','dashboard_ifood_d1','$2','atencao','nt:$u:$2');"; done
  q $1 "$sql" > "$TMP/al.log" 2>&1
}
AGENDAR() { # agenda as iniciais de TODOS os alertas DETECTED com os legados da empresa (o JS propõe pela lista da empresa)
  sr $1 "select count(*) from (select comunicacao_agendar_mensagens_alerta(a.id, 'inicial', null,
      (select jsonb_agg(jsonb_build_object('contato_empresa_id', ce.id, 'conteudo', 'Pendencia D-1 de ' || a.data_referencia, 'disponivel_em', '2026-11-03T11:00:00Z', 'expira_em', '2026-11-03T21:00:00Z'))
         from comunicacao_contatos_empresa ce where ce.organizacao_id = a.organizacao_id)) from comunicacao_alertas a where a.status = 'DETECTED' order by a.id) x" >/dev/null
}
FOTO_MSG="select md5(coalesce(string_agg(concat_ws('|', alerta_id, contato_empresa_id, idempotency_key, tipo, conteudo, disponivel_em, expira_em, metadados::text, status, telefone_snapshot), ';' order by idempotency_key), '')) || ':' || count(*) from comunicacao_mensagens"
grep -q "chave_dedupe" <(q nt_main "select column_name from information_schema.columns where table_name='comunicacao_alertas'") || \
  { ALERTAS() { local i=$3 sql=""; for u in $(UA 1) $(UA 2) $(UA 3) $(UA 4) $(UA 5) $(UA 6) $(UA 11) $(UA 21); do i=$((i+1)); org=$ORG_A; case $u in $(UA 11)) org=$ORG_B;; $(UA 21)) org=$ORG_C;; esac
      sql="$sql insert into comunicacao_alertas (id, organizacao_id, unidade_id, tipo_alerta, data_referencia, severidade) values ('$(ALR $i)','$org','$u','dashboard_ifood_d1','$2','atencao');"; done; q $1 "$sql" > "$TMP/al.log" 2>&1; }; }

# ---------- 1. D-1 idêntico com a seleção DESLIGADA (padrão) ----------
for b in nt_main nt_branch; do ALERTAS $b 2026-11-02 0; AGENDAR $b; done
F1M=$(q nt_main "$FOTO_MSG"); F1B=$(q nt_branch "$FOTO_MSG")
chk "D-1 com a seleção desligada: mesmas mensagens (destinatários, chaves, conteúdo, horários, metadados, status) na main e na branch" "$F1B" "$F1M"
info "mensagens D-1 geradas: ${F1M#*:} (opt-out e categorias fora; 7 empresas×unidades)"
for b in nt_main nt_branch; do AGENDAR $b; done   # 2ª rodada do agendador: idempotência (mesma chave ⇒ nenhuma linha nova)
chk "D-1 idempotente: reagendar não cria nem altera mensagens (branch igual à 1ª rodada)" "$(q nt_branch "$FOTO_MSG")" "$F1B"
chk "D-1 idempotente: main e branch iguais após reagendar" "$(q nt_branch "$FOTO_MSG")" "$(q nt_main "$FOTO_MSG")"
FILA_DEF="select md5(string_agg(x, ';' order by x)) from (select column_name||':'||data_type||':'||coalesce(column_default,'')||':'||is_nullable x from information_schema.columns where table_schema='public' and table_name='comunicacao_mensagens'
  union all select 'c:'||pg_get_constraintdef(oid) from pg_constraint where conrelid='public.comunicacao_mensagens'::regclass
  union all select 't:'||tgname||':'||pg_get_triggerdef(oid) from pg_trigger where tgrelid='public.comunicacao_mensagens'::regclass and not tgisinternal) y"
chk "fila do D-1 (comunicacao_mensagens): colunas, restrições e gatilhos idênticos aos da main" "$(q nt_branch "$FILA_DEF")" "$(q nt_main "$FILA_DEF")"
for t in OPT_OUT; do chk "motivo $t idêntico" "$(sr nt_branch "select e->>'motivo' from jsonb_array_elements(comunicacao_resolver_destinatarios_unidade('$ORG_C','$(UA 21)','dashboard_ifood_d1')) e")" "$(sr nt_main "select e->>'motivo' from jsonb_array_elements(comunicacao_resolver_destinatarios('$ORG_C','dashboard_ifood_d1')) e")"; done

# ---------- 2. ativação M3: universo inválido, divergência plantada, atomicidade ----------
UNIV="[$(for u in $(UA 1) $(UA 2) $(UA 3) $(UA 4) $(UA 5) $(UA 6); do printf '{"unidade_id":"%s","organizacao_id":"%s"},' $u $ORG_A; done)"'{"unidade_id":"'$(UA 11)'","organizacao_id":"'$ORG_B'"},{"unidade_id":"'$(UA 21)'","organizacao_id":"'$ORG_C'"}]'
MIG=10000000-0000-4000-8000-0000000000f1
UNIV_RUIM="[{\"unidade_id\":\"$(UA 7)\",\"organizacao_id\":\"$ORG_A\"}]"
sr nt_branch "select comunicacao_ativar_selecao_por_escopo('$MIG', '$UNIV_RUIM'::jsonb, 'ifood_dashboard', '$ATOR')" | grep -q "ATIVACAO_UNIVERSO_INVALIDO" && ok "M3: unidade inativa no universo → recusa" || bad "M3 aceitou unidade inativa"
chk "M3 recusada não gravou nada (flag/snapshot/escopos)" "$(q nt_branch "select comunicacao_selecao_por_escopo_ligada()::text || '/' || (select count(*) from comunicacao_legado_snapshot) || '/' || (select count(*) from comunicacao_destinatario_escopos)")" "false/0/0"
# divergência plantada: um escopo SUSPENSO pré-existente para um legado faz a seleção nova diferir → rollback total
q nt_branch "insert into comunicacao_legado_snapshot (id, migracao_id, contato_empresa_id, organizacao_na_migracao_id, unidade_na_migracao_id, hash_linha) values ('20000000-0000-4000-8000-0000000000aa','20000000-0000-4000-8000-0000000000ab','$(CE 2)','$ORG_A','$(UA 3)','x');
 insert into comunicacao_destinatario_escopos (contato_empresa_id, unidade_escopo_id, categoria, origem_autorizacao, origem_vinculo, snapshot_id, suspenso_em) values ('$(CE 2)','$(UA 3)','pendencia_d1','LEGACY_ACTIVE','SNAPSHOT_MIGRACAO','20000000-0000-4000-8000-0000000000aa', now())" >/dev/null
sr nt_branch "select comunicacao_ativar_selecao_por_escopo('$MIG', '$UNIV'::jsonb, 'ifood_dashboard', '$ATOR')" | grep -q "ATIVACAO_EQUIVALENCIA_FALHOU" && ok "M3: divergência plantada → ATIVACAO_EQUIVALENCIA_FALHOU" || bad "M3 não detectou a divergência"
chk "M3 com divergência: rollback total (flag desligada, snapshot da migração vazio)" "$(q nt_branch "select comunicacao_selecao_por_escopo_ligada()::text || '/' || (select count(*) from comunicacao_legado_snapshot where migracao_id='$MIG')")" "false/0"
q nt_branch "set session_replication_role = replica; delete from comunicacao_destinatario_escopos; delete from comunicacao_legado_snapshot" >/dev/null

# ---------- 3. sem estado intermediário: ativação e agendamento concorrentes (duas sessões reais) ----------
for b in nt_main nt_branch; do ALERTAS $b 2026-11-03 100; done
( PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d nt_branch -c "set role service_role; begin; select comunicacao_ativar_selecao_por_escopo('$MIG', '$UNIV'::jsonb, 'ifood_dashboard', '$ATOR')->>'resultado'; select pg_sleep(3); commit;" > "$TMP/ativ.out" 2>&1 ) &
PID=$!; sleep 1
AGENDAR nt_branch; AGENDAR nt_main     # durante a transação da ativação (ainda não comitada)
wait $PID
grep -q "ATIVADA" "$TMP/ativ.out" && ok "M3 ATIVADA (sessão 1) enquanto a sessão 2 agendava o D-1" || { bad "ativação concorrente"; cat "$TMP/ativ.out"; }
chk "sem estado intermediário: o D-1 agendado durante a ativação é idêntico ao da main" "$(q nt_branch "$FOTO_MSG")" "$(q nt_main "$FOTO_MSG")"
chk "snapshot = legados com D-1 × unidades do universo (A:2×6 + B:1 + C:1 = 14), escopos iguais" "$(q nt_branch "select count(*) || '/' || (select count(*) from comunicacao_destinatario_escopos where origem_vinculo='SNAPSHOT_MIGRACAO') from comunicacao_legado_snapshot where migracao_id='$MIG'")" "14/14"
chk "unidade inativa e de teste fora do snapshot" "$(q nt_branch "select count(*) from comunicacao_legado_snapshot where unidade_na_migracao_id in ('$(UA 7)','$(UA 8)')")" "0"
chk "M3 idempotente: segunda chamada = JA_ATIVADA, sem linhas novas" "$(sr nt_branch "select comunicacao_ativar_selecao_por_escopo('$MIG', '$UNIV'::jsonb, 'ifood_dashboard', '$ATOR')->>'resultado'")/$(q nt_branch "select count(*) from comunicacao_legado_snapshot")" "JA_ATIVADA/14"
sr nt_branch "select comunicacao_ativar_selecao_por_escopo('20000000-0000-4000-8000-0000000000ff', '$UNIV'::jsonb, 'ifood_dashboard', '$ATOR')" | grep -q "ATIVACAO_JA_LIGADA_COM_OUTRA_MIGRACAO" && ok "M3 com outra migração após ligada → recusa" || bad "M3 aceitou segunda migração"
sr nt_branch "update comunicacao_legado_snapshot set ativo = false" | grep -q "permission denied" && ok "snapshot: service_role sem UPDATE (privilégio)" || bad "snapshot alterável pelo service_role"
q nt_branch "update comunicacao_legado_snapshot set ativo = false" | grep -q "imutável" && ok "snapshot imutável mesmo para o dono (trigger)" || bad "snapshot alterável pelo dono"
sr nt_branch "delete from comunicacao_legado_snapshot" | grep -qi "imutável\|permission denied" && ok "snapshot imutável (DELETE recusado)" || bad "snapshot apagável"

# ---------- 4. depois da ativação: D-1 idêntico nas unidades do snapshot; unidade nova não herda ----------
for b in nt_main nt_branch; do ALERTAS $b 2026-11-04 200; AGENDAR $b; done
chk "D-1 depois da ativação M3: idêntico ao da main nas unidades existentes" "$(q nt_branch "$FOTO_MSG")" "$(q nt_main "$FOTO_MSG")"
NU=00000000-0000-0000-0000-0000000f0e09
for b in nt_main nt_branch; do q $b "insert into unidades (id, organizacao_id, nome, ativo, eh_teste) values ('$NU','$ORG_A','A-nova',true,false); insert into unidade_modulos values ('$NU','ifood_dashboard');
  insert into comunicacao_alertas (id, organizacao_id, unidade_id, tipo_alerta, data_referencia, severidade) values ('$(ALR 900)','$ORG_A','$NU','dashboard_ifood_d1','2026-11-04','atencao')" >/dev/null; AGENDAR $b; done
chk "comportamento anterior (main): unidade nova recebe dos legados da empresa" "$(q nt_main "select count(*) from comunicacao_mensagens where alerta_id='$(ALR 900)'")" "2"
chk "D-16 (branch, M3 ligada): unidade nova NÃO herda legados" "$(q nt_branch "select count(*) from comunicacao_mensagens where alerta_id='$(ALR 900)'")" "0"
chk "gerente de OUTRA unidade não vincula legado à unidade nova" "$(sr nt_branch "select comunicacao_legado_vincular_unidade('$ORG_A','$(UA 1)','$(CE 1)','$NU','$ATOR')" | grep -c ESCOPO_FORA_DO_SEU_ALCANCE)" "1"
chk "vínculo explícito de legado à unidade nova (só D-1)" "$(sr nt_branch "select comunicacao_legado_vincular_unidade('$ORG_A', null, '$(CE 1)','$NU','$ATOR')->>'resultado'")" "VINCULADO"
q nt_branch "update comunicacao_alertas set status='DETECTED' where id='$(ALR 900)'" >/dev/null; AGENDAR nt_branch
chk "após o vínculo explícito a unidade nova recebe só do legado vinculado" "$(q nt_branch "select count(*) from comunicacao_mensagens where alerta_id='$(ALR 900)'")" "1"
sr nt_branch "insert into comunicacao_destinatario_escopos (contato_empresa_id, unidade_escopo_id, categoria, origem_autorizacao, origem_vinculo) values ('$(CE 1)','$(UA 1)','fechamento_operacional_diario','LEGACY_ACTIVE','INCLUSAO_ADMIN')" | grep -q "comunicacao_escopo_legado_so_d1" && ok "legado nunca ganha outra categoria (CHECK no banco)" || bad "legado aceitou categoria nova"
sr nt_branch "insert into comunicacao_destinatario_escopos (contato_empresa_id, unidade_escopo_id, categoria, origem_autorizacao, origem_vinculo) values ('$(CE 1)','$(UA 11)','pendencia_d1','LEGACY_ACTIVE','INCLUSAO_ADMIN')" | grep -q "não pertence à empresa" && ok "escopo com unidade de outra empresa recusado (trigger)" || bad "escopo de outra empresa aceito"

# ---------- 5. suspensão e revogação: efeito imediato, inclusive mensagens enfileiradas ----------
for b in nt_main nt_branch; do ALERTAS $b 2026-11-05 300; AGENDAR $b; done
FILA_A1=$(q nt_branch "select count(*) from comunicacao_mensagens where contato_empresa_id='$(CE 1)' and unidade_id='$(UA 1)' and status in ('SCHEDULED','PROCESSING')")
FILA_A2=$(q nt_branch "select count(*) from comunicacao_mensagens where contato_empresa_id='$(CE 1)' and unidade_id='$(UA 2)' and status in ('SCHEDULED','PROCESSING')")
chk "suspensão pelo gerente de A1: só o escopo de A1; cancela TODA a fila daquela unidade ($FILA_A1) e nenhuma de A2 ($FILA_A2)" "$(sr nt_branch "select comunicacao_escopo_suspender('$ORG_A','$(UA 1)','$(CE 1)','$(UA 1)','pendencia_d1',true,'teste','$ATOR')->>'mensagens_canceladas'")/$(q nt_branch "select count(*) from comunicacao_mensagens where contato_empresa_id='$(CE 1)' and unidade_id='$(UA 1)' and status in ('SCHEDULED','PROCESSING')")/$(q nt_branch "select count(*) from comunicacao_mensagens where contato_empresa_id='$(CE 1)' and unidade_id='$(UA 2)' and status in ('SCHEDULED','PROCESSING')")" "$FILA_A1/0/$FILA_A2"
[ "$FILA_A1" -gt 0 ] && ok "havia fila real a cancelar ($FILA_A1)" || bad "cenário sem fila para a suspensão"
chk "gerente de A1 não suspende escopo de A2" "$(sr nt_branch "select comunicacao_escopo_suspender('$ORG_A','$(UA 1)','$(CE 1)','$(UA 2)','pendencia_d1',true,'x','$ATOR')" | grep -c ESCOPO_FORA_DO_SEU_ALCANCE)" "1"
HM=$(printf 'a%.0s' {1..64})
chk "revogação do titular (legado, empresa A, D-1): cancela a fila e desliga a categoria legada" "$(sr nt_branch "select comunicacao_revogar('$HM', array['$(CE 2)']::uuid[], array['pendencia_d1'], null, 'pagina_gestao_otp', null, null, false, null)->>'resultado'")/$(q nt_branch "select habilitado from comunicacao_destinatario_categorias where contato_empresa_id='$(CE 2)'")/$(q nt_branch "select count(*) from comunicacao_mensagens where contato_empresa_id='$(CE 2)' and status in ('SCHEDULED','PROCESSING')")" "REVOGADO/f/0"
chk "revogação vale também na seleção ANTERIOR (portão real do JIT): legado revogado inelegível" "$(sr nt_branch "select e->>'motivo' from jsonb_array_elements(comunicacao_resolver_destinatarios('$ORG_A','dashboard_ifood_d1')) e where e->>'contato_empresa_id'='$(CE 2)'")" "CATEGORIA_NAO_HABILITADA"
sr nt_branch "update comunicacao_destinatario_categorias set habilitado = true where contato_empresa_id='$(CE 2)'" | grep -q "só um novo consentimento" && ok "gestor/Painel ADM NÃO reativa categoria revogada pelo titular" || bad "reativação de revogada permitida"
chk "revogação na empresa A não afeta o mesmo número na empresa B" "$(q nt_branch "select habilitado from comunicacao_destinatario_categorias where contato_empresa_id='$(CE 3)'")" "t"
chk "nenhum CONCEDIDO foi fabricado para legados" "$(q nt_branch "select count(*) from comunicacao_consentimentos where acao='CONCEDIDO'")" "0"
q nt_branch "insert into comunicacao_consentimentos (telefone_hmac, organizacao_id, categoria, acao, origem) values ('$HM','$ORG_A','pendencia_d1','CONCEDIDO','pedido_registrado_gestor')" | grep -q "comunicacao_consent_concedido_prova" && ok "CONCEDIDO sem prova (OTP + termo) é recusado pelo banco" || bad "CONCEDIDO sem prova aceito"

# ---------- 6. OTP e consentimento ----------
H1=$(printf 'b%.0s' {1..64}); H2=$(printf 'c%.0s' {1..64}); COD=$(printf 'd%.0s' {1..64}); ERR=$(printf 'e%.0s' {1..64}); TK=$(printf 'f%.0s' {1..64})
CV=$(sr nt_branch "insert into comunicacao_convites (token_hash, organizacao_id, unidades_pretendidas, categorias_pretendidas, nome, telefone_cifrado, telefone_hmac, telefone_mascarado, expira_em, simulado) values ('$TK','$ORG_A', array['$(UA 1)']::uuid[], array['fechamento_operacional_diario','pendencia_d1'], 'Nova', 'cifrado', '$H1', '+551********09', now() + interval '72 hours', true) returning id" | head -1)
sr nt_branch "insert into comunicacao_convites (token_hash, organizacao_id, unidades_pretendidas, categorias_pretendidas, nome, telefone_cifrado, telefone_hmac, telefone_mascarado, expira_em, unidade_permitida) values ('$(printf '1%.0s' {1..64})','$ORG_A', array['$(UA 2)']::uuid[], array['pendencia_d1'], 'X', 'c', '$H1', '+551********09', now() + interval '1 hour', '$(UA 1)')" | grep -q "só convida para a própria unidade" && ok "gerente de A1 não convida para A2 (banco)" || bad "convite fora da unidade aceito"
D1=$(sr nt_branch "select comunicacao_desafio_criar('verificacao','$CV','cifrado','$H1','$COD',null,true,1)->>'desafio_id'")
chk "reenvio antes de 60 s → AGUARDE" "$(sr nt_branch "select comunicacao_desafio_criar('verificacao','$CV','cifrado','$H1','$COD',null,true,1)->>'resultado'")" "AGUARDE"
for i in 1 2 3 4; do R4=$(sr nt_branch "select comunicacao_desafio_verificar('$D1','$ERR')->>'resultado'"); done
chk "4 códigos errados → INCORRETO" "$R4" "INCORRETO"
chk "5ª tentativa errada → BLOQUEADO" "$(sr nt_branch "select comunicacao_desafio_verificar('$D1','$ERR')->>'resultado'")" "BLOQUEADO"
chk "código certo depois do bloqueio → INVALIDO" "$(sr nt_branch "select comunicacao_desafio_verificar('$D1','$COD')->>'resultado'")" "INVALIDO"
# gestão anti-enumeração: o backend escolhe o id do desafio ANTES de saber se o número existe (resposta sem esperar o banco)
IDG=10000000-0000-4000-8000-0000000000d1; HG1=$(printf 'e%.0s' $(seq 64)); HG2=$(printf 'f%.0s' $(seq 64))
chk "desafio de gestão com o id escolhido pelo backend" "$(sr nt_branch "select comunicacao_desafio_criar('gestao',null,'cifrado','$HG1','$COD',null,true,1,'$IDG')->>'desafio_id'")" "$IDG"
chk "id de desafio repetido é recusado (chave primária)" "$(sr nt_branch "select comunicacao_desafio_criar('gestao',null,'cifrado','$HG2','$COD',null,true,1,'$IDG')" | grep -c 'duplicate key')" "1"
q nt_branch "update comunicacao_desafios_titular set ultimo_envio_em = now() - interval '2 minutes'" >/dev/null
D2=$(sr nt_branch "select comunicacao_desafio_criar('verificacao','$CV','cifrado','$H1','$COD',null,true,1)->>'desafio_id'")
# concorrência real: duas sessões verificam o MESMO código certo ao mesmo tempo → só uma vence
for s in 1 2; do ( PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d nt_branch -c "set role service_role; select comunicacao_desafio_verificar('$D2','$COD')->>'resultado'" > "$TMP/v$s" 2>&1 ) & done; wait
chk "concorrência: o mesmo código usado por duas sessões → 1 VERIFICADO e 1 INVALIDO" "$(cat "$TMP/v1" "$TMP/v2" | grep -v '^SET$' | sort | tr '\n' ' ')" "INVALIDO VERIFICADO "
chk "replay do código já consumido → INVALIDO" "$(sr nt_branch "select comunicacao_desafio_verificar('$D2','$COD')->>'resultado'")" "INVALIDO"
chk "termo antigo/inexistente → TERMO_DESATUALIZADO" "$(sr nt_branch "select comunicacao_titular_consentir('$CV','$D2', array['fechamento_operacional_diario'], 99, '+5511900000009', null, 'teste')->>'resultado'")" "TERMO_DESATUALIZADO"
chk "categoria não convidada → recusa" "$(sr nt_branch "select comunicacao_titular_consentir('$CV','$D2', array['disputas'], 1, '+5511900000009', null, 'teste')->>'resultado'")" "CATEGORIA_NAO_CONVIDADA"
R6=$(sr nt_branch "select comunicacao_titular_consentir('$CV','$D2', array['fechamento_operacional_diario'], 1, '+5511900000009', null, 'teste')")
echo "$R6" | grep -q '"CONSENTIDO"' && ok "titular consentiu só no fechamento (subconjunto escolhido por ele)" || bad "consentimento: $R6"
chk "livro-razão: 1 CONCEDIDO com termo, hash e evidência (desafio), marcado SIMULADO" "$(q nt_branch "select count(*) || '/' || bool_and(termo_hash is not null and evidencia_id = '$D2' and simulado) from comunicacao_consentimentos where acao='CONCEDIDO'")" "1/true"
chk "novo destinatário NÃO entra no D-1 legado (NAO_VALIDADO; contatos_whatsapp intocado)" "$(sr nt_branch "select e->>'motivo' from jsonb_array_elements(comunicacao_resolver_destinatarios('$ORG_A','dashboard_ifood_d1')) e where e->>'nome'='Nova'")/$(q nt_branch "select count(*) from contatos_whatsapp")" "WHATSAPP_NAO_VALIDADO/4"
chk "escopo CONVITE_OTP criado como verificação SIMULADA" "$(q nt_branch "select count(*) from comunicacao_destinatario_escopos where origem_autorizacao='CONVITE_OTP' and verificacao_simulada")" "1"

# ---------- 7. cotas por categoria (D-9) ----------
chk "D-1 sem cota própria (regra atual intacta); fechamento com cota própria" "$(q nt_branch "select (cota is null)::text from comunicacao_categorias where codigo='pendencia_d1'")/$(q nt_branch "select cota->>'por_destinatario_dia' from comunicacao_categorias where codigo='fechamento_operacional_diario'")" "true/2"
chk "cota da categoria nova disponível (simulações não contam)" "$(sr nt_branch "select comunicacao_cota_categoria_disponivel('fechamento_operacional_diario','$(CE 1)','$(UA 1)','$ORG_A', now() - interval '1 day')->>'disponivel'")" "true"
chk "função de reserva do D-1 (comunicacao_reservar_envio) intacta" "$(q nt_branch "select md5(pg_get_functiondef(p.oid)) from pg_proc p where p.proname='comunicacao_reservar_envio'")" "$(q nt_main "select md5(pg_get_functiondef(p.oid)) from pg_proc p where p.proname='comunicacao_reservar_envio'")"

# ---------- 8. D-14 convite de usuário e D-15 fuso ----------
q nt_branch "update unidades set timezone = 'Lua/Base' where id = '$(UA 1)'" | grep -q "fuso inválido" && ok "fuso IANA inválido recusado" || bad "fuso inválido aceito"
chk "fuso IANA válido aceito" "$(q nt_branch "update unidades set timezone = 'America/Porto_Velho', horario_funcionamento = '{\"seg\":[{\"inicio\":\"10:00\",\"fim\":\"23:30\"}]}' where id = '$(UA 11)' returning timezone" | head -1)" "America/Porto_Velho"
TKU=$(printf '2%.0s' {1..64}); EH=$(printf '3%.0s' {1..64})
sr nt_branch "insert into usuarios_convites (token_hash, organizacao_id, papel, email_hmac, email_cifrado, expira_em) values ('$TKU','$ORG_A','operations','$EH','c', now() + interval '72 hours')" >/dev/null
chk "convite de usuário: e-mail divergente → recusa" "$(sr nt_branch "select usuarios_convite_consumir('$TKU','$HM','$ATOR')->>'resultado'")" "EMAIL_DIVERGENTE"
for s in 1 2; do ( PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d nt_branch -c "set role service_role; select usuarios_convite_consumir('$TKU','$EH','$ATOR')->>'resultado'" > "$TMP/u$s" 2>&1 ) & done; wait
chk "convite de usuário: uso único sob concorrência → 1 CONSUMIDO e 1 JA_USADO" "$(cat "$TMP/u1" "$TMP/u2" | grep -v '^SET$' | sort | tr '\n' ' ')" "CONSUMIDO JA_USADO "
sr nt_branch "insert into usuarios_convites (token_hash, organizacao_id, papel, email_hmac, email_cifrado, expira_em) values ('$(printf '4%.0s' {1..64})','$ORG_A','viewer','$EH','c', now() + interval '80 hours')" | grep -q "usuarios_convites_validade" && ok "convite com validade > 72 h recusado" || bad "convite > 72 h aceito"

# ---------- 9. transferência de unidade SEM modificar a função (D-11) ----------
FOTO_ESC="select md5(string_agg(t, ';' order by t)) from (select (to_jsonb(e) - 'atualizado_em')::text t from comunicacao_destinatario_escopos e union all select to_jsonb(s)::text from comunicacao_legado_snapshot s union all select to_jsonb(c)::text from comunicacao_consentimentos c) x"
chk "função de transferência idêntica à da main (não modificada)" "$(q nt_branch "select md5(pg_get_functiondef('remapear_organizacao_em_tabelas_de_unidade(uuid,uuid,uuid)'::regprocedure))")" "$(q nt_main "select md5(pg_get_functiondef('remapear_organizacao_em_tabelas_de_unidade(uuid,uuid,uuid)'::regprocedure))")"
E0=$(q nt_branch "$FOTO_ESC")
TR=$(sr nt_branch "select transferir_unidade_organizacao('$(UA 2)', '$ORG_B', '$ATOR') is not null")
chk "transferência da unidade A2 (com escopos, snapshot e livro-razão presentes) conclui" "$TR" "t"
chk "escopos, snapshot e livro-razão intocados pela transferência" "$(q nt_branch "$FOTO_ESC")" "$E0"
chk "autorização NÃO atravessa empresas: a empresa B não enxerga legados de A na unidade transferida" "$(sr nt_branch "select count(*) from jsonb_array_elements(comunicacao_resolver_destinatarios_unidade('$ORG_B','$(UA 2)','dashboard_ifood_d1')) e where (e->>'elegivel')::boolean and e->>'contato_empresa_id' in ('$(CE 1)','$(CE 2)')")" "0"
chk "e a empresa A não envia mais para a unidade transferida" "$(sr nt_branch "select count(*) from jsonb_array_elements(comunicacao_resolver_destinatarios_unidade('$ORG_A','$(UA 2)','dashboard_ifood_d1')) e where (e->>'elegivel')::boolean")" "0"

# ---------- 10. rollbacks ----------
novo_banco nt_rb nt_main
for f in 132_configuracoes2_fuso_unidade_convites_usuario.sql 133_notificacoes_escopos_snapshot_m3.sql 134_notificacoes_otp_consentimento.sql 135_notificacoes_cotas_categoria.sql; do aplicar nt_rb "$M/$f"; done
for f in 135_rollback.sql 134_rollback.sql 133_rollback.sql 132_rollback.sql; do aplicar nt_rb "$M/$f" || { bad "rollback $f"; head -3 "$TMP/ap.log"; }; done
chk "rollbacks 135→132: agendamento do D-1 idêntico ao da main" "$(q nt_rb "$FN_AG")" "$MD_AG_MAIN"
chk "rollbacks: nenhuma tabela nova sobra" "$(q nt_rb "select count(*) from pg_class where relname in ('usuarios_convites','comunicacao_destinatario_escopos','comunicacao_legado_snapshot','comunicacao_convites','comunicacao_desafios_titular','comunicacao_consentimentos','comunicacao_termos')")" "0"
for f in 132_configuracoes2_fuso_unidade_convites_usuario.sql 133_notificacoes_escopos_snapshot_m3.sql 134_notificacoes_otp_consentimento.sql 135_notificacoes_cotas_categoria.sql; do aplicar nt_rb "$M/$f" || bad "reaplicar após rollback: $f"; done
ok "132–135 reaplicadas após o rollback"

echo; echo "RESUMO: $N_OK verificações OK, $N_F falha(s)"
[ "${MANTER_BANCOS:-}" = "1" ] || for b in nt_main nt_branch nt_rb; do $SU -d postgres -c "drop database if exists $b" >/dev/null 2>&1; done   # MANTER_BANCOS=1: inspeção depois
[ -z "$FALHOU" ] && echo "TUDO OK" || { echo "HÁ FALHAS"; exit 1; }
