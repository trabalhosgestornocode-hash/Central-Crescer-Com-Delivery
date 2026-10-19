#!/bin/bash
# Ensaio do t3c.mjs (A1) — SOMENTE PostgreSQL LOCAL DESCARTÁVEL (MARCADOR_DESCARTAVEL, 127.0.0.1:54321). Nada remoto.
# Monta "t3c_compart", que imita o Supabase de testes compartilhado: cadeia da main, a 115 NÃO efetiva, sem bonificacao_*, organizações/unidades/
# dados/usuários REAIS (ids aleatórios) e um papel postgres_t3c como o postgres do Supabase (não superusuário, BYPASSRLS, membro de service_role/anon/authenticated).
# Prova: (N) cada trava recusa; (O) os scripts originais continuam recusando este banco e não foram alterados; (V) violação da allowlist faz ROLLBACK;
#        (P) fluxo completo preflight → m115 → migracoes → semente → provas → encerrar → verificar, sem nada mudar fora da allowlist (exceto modulos).
# Uso: PG_CLUSTER_DIR=C:/Users/.../pgdata bash backend/testes-seguros/t3/compartilhado/ensaio_t3c.sh
set -u
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
AQUI="$(cd "$(dirname "$0")" && pwd)"; R="$(cd "$AQUI/../../../.." && pwd)"; PG="$R/backend/testes-seguros/pg"
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR (cluster DESCARTÁVEL local, com MARCADOR_DESCARTAVEL)}"
H="-h 127.0.0.1 -p 54321"; SU="psql $H -U postgres -X -q -v ON_ERROR_STOP=1"
FALHOU=""; ok() { echo "OK    $1"; }; bad() { echo "FALHA $1"; FALHOU=1; }
[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo "RECUSADO: sem MARCADOR_DESCARTAVEL"; exit 2; }
psql $H -U postgres -tAc "show data_directory" | grep -qF "$CLUSTER" || { echo "RECUSADO: servidor não é o cluster descartável"; exit 2; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
q() { psql $H -U postgres -X -tA -d t3c_compart -c "$1" 2>&1; }

# ---------- montagem ----------
psql $H -U postgres -tAc "select 1 from pg_database where datname='e115_base'" | grep -q 1 || { echo "falta e115_base: rode antes backend/testes-seguros/pg/ensaio_115_120.sh"; exit 2; }
$SU -d postgres -c "drop database if exists t3c_compart" -c "create database t3c_compart owner dono_sim template e115_base" >/dev/null
psql $H -U postgres -tAc "select 1 from pg_roles where rolname='postgres_t3c'" | grep -q 1 || $SU -d postgres -c "create role postgres_t3c login nosuperuser bypassrls" >/dev/null
$SU -d postgres -c "grant dono_sim, anon, authenticated, service_role to postgres_t3c" >/dev/null 2>&1
$SU -d t3c_compart -c "grant all on schema public to postgres_t3c; alter default privileges for role postgres_t3c in schema public grant all on tables to anon, authenticated, service_role; alter default privileges for role postgres_t3c in schema public grant all on sequences to anon, authenticated, service_role; alter default privileges for role postgres_t3c in schema public grant all on functions to anon, authenticated, service_role" >/dev/null
psql $H -U dono_sim -X -q -v ON_ERROR_STOP=1 -d t3c_compart -f "$R/database/migrations/115_rollback.sql" >/dev/null
$SU -d t3c_compart -c "drop function public.bonificacao_congelar_competencia(uuid,uuid,integer,integer,text,jsonb,jsonb,text,uuid,text); drop function public.bonificacao_reabrir_competencia(uuid,integer,integer,text,uuid,text)" >/dev/null
# dados "reais" (ids aleatórios, fora de qualquer padrão de teste) que NÃO podem mudar
q "insert into auth.users (id, email) select gen_random_uuid(), 'real' || g || '@exemplo.invalid' from generate_series(1, 3) g;
with o as (insert into organizacoes (nome) select 'Empresa real ' || g from generate_series(1, 3) g returning id)
insert into unidades (organizacao_id, nome) select id, 'Loja real' from o;
insert into ifood_conexoes (organizacao_id, unidade_id) select organizacao_id, id from unidades;
insert into vendas (unidade_id, valor_total) select id, 99.9 from unidades;
insert into organizacao_modulos (organizacao_id, modulo_id) select o.id, m.id from organizacoes o, modulos m where m.ordem <= 3;
insert into plataforma_auditoria (acao, organizacao_id) select 'acao.real', id from organizacoes;" > "$TMP/dados" 2>&1
grep -q ERRO "$TMP/dados" && { bad "dados reais: $(cat "$TMP/dados")"; exit 1; }
REAL=$(q "select id from organizacoes order by nome limit 1")
ok "t3c_compart: main + 115 reaberta + 3 empresas/lojas/usuários reais; papel postgres_t3c (não superusuário, BYPASSRLS)"

T3C="node $AQUI/t3c.mjs"
BASE_ENV=(T3C_ENSAIO_LOCAL=1 PG_CLUSTER_DIR="$CLUSTER" T3C_PSQL_CONN="postgresql://postgres_t3c@127.0.0.1:54321/t3c_compart" T3C_CONFIRMO=COMPARTILHADO_wiqqsxnysbzhcrzrrean T3C_DONO=postgres_t3c T3C_EVIDENCIAS="$TMP/ev")
rodar() { env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" SYSTEMROOT="${SYSTEMROOT:-C:\\WINDOWS}" "$@" 2>&1; }   # terminal LIMPO + variáveis explícitas

# ---------- N) travas ----------
O=$(rodar $T3C preflight); echo "$O" | grep -q "RECUSADO: defina T3C_PSQL_CONN" && ok "N1 sem variáveis: recusa" || bad "N1: $O"
O=$(rodar "${BASE_ENV[@]}" QUALQUER="https://uqybgauuxcrqzquultfu.supabase.co" $T3C preflight); echo "$O" | grep -q "QUALQUER contém o ref de PRODUÇÃO" && ok "N2 ref de produção em QUALQUER variável do terminal: recusa" || bad "N2: $O"
O=$(rodar "${BASE_ENV[@]}" T3C_CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL $T3C preflight); echo "$O" | grep -q "T3C_CONFIRMO precisa ser" && ok "N3 token dos scripts descartáveis não serve: recusa" || bad "N3: $O"
O=$(rodar T3C_PSQL_CONN="postgresql://postgres@127.0.0.1:54321/t3c_compart" T3C_CONFIRMO=COMPARTILHADO_wiqqsxnysbzhcrzrrean T3C_PROJECT_REF=wiqqsxnysbzhcrzrrean $T3C preflight)
echo "$O" | grep -q "não é do projeto de testes" && ok "N4 fora do ensaio, conexão que não é db.<ref>.supabase.co: recusa" || bad "N4: $O"
O=$(rodar T3C_PSQL_CONN="postgresql://postgres:x@db.abcdefghijabcdefghij.supabase.co:5432/postgres" T3C_CONFIRMO=COMPARTILHADO_wiqqsxnysbzhcrzrrean T3C_PROJECT_REF=abcdefghijabcdefghij $T3C preflight)
echo "$O" | grep -q "T3C_PROJECT_REF precisa ser wiqqsxnysbzhcrzrrean" && ok "N5 outro projeto Supabase: recusa (só o ref exato de testes)" || bad "N5: $O"
O=$(rodar T3C_PSQL_CONN="postgresql://postgres.wiqqsxnysbzhcrzrrean:x@aws-0-sa-east-1.pooler.supabase.com:6543/postgres" T3C_CONFIRMO=COMPARTILHADO_wiqqsxnysbzhcrzrrean T3C_PROJECT_REF=wiqqsxnysbzhcrzrrean T3C_SUPABASE_URL=https://outro.supabase.co $T3C preflight)
echo "$O" | grep -q "T3C_SUPABASE_URL não é a URL do projeto de testes" && ! echo "$O" | grep -q "T3C_PSQL_CONN não é" && ok "N5b pooler com usuário postgres.<ref> aceito; URL de outro projeto recusada" || bad "N5b: $O"
O=$(rodar "${BASE_ENV[@]}" NODE_OPTIONS="--env-file=backend/.env" $T3C preflight); echo "$O" | grep -qE "NODE_OPTIONS com --env-file|--env-file= is not allowed in NODE_OPTIONS" && ! echo "$O" | grep -q '"identidade"' && ok "N6 NODE_OPTIONS --env-file: recusado (o próprio Node já barra; o t3c também) — nada conectado" || bad "N6: $O"
! grep -qE "from ['\"]dotenv|require\(['\"]dotenv|loadEnvFile|readFileSync\([^)]*\.env|--env-file=" "$AQUI/t3c.mjs" && ok "N6b t3c.mjs não lê arquivo .env (sem dotenv, loadEnvFile ou leitura de .env)" || bad "N6b t3c.mjs referencia leitura de .env"

O=$(rodar "${BASE_ENV[@]}" $T3C preflight); IDENT=$(echo "$O" | grep -o '"identidade": "[0-9a-f]*"' | cut -d'"' -f4); BASEF=$(echo "$O" | grep -o '"linhaDeBase": "[^"]*"' | cut -d'"' -f4)
NIMP=$(echo "$O" | grep -o '"tabelasImpressas": [0-9]*' | grep -o '[0-9]*$')
[ -n "$IDENT" ] && [ -f "$BASEF" ] && [ "${NIMP:-0}" -ge 50 ] && echo "$O" | grep -q '"m115Aplicada": false' && ok "P1 preflight (somente leitura): identidade $IDENT, linha de base com $NIMP tabelas impressas, detecta a 115 ausente" || bad "P1: $O"
ENV=("${BASE_ENV[@]}" T3C_IDENTIDADE="$IDENT")
CONT0=$(q "select count(*) from fin_auditoria" 2>/dev/null)
O=$(rodar "${ENV[@]}" $T3C migracoes); echo "$O" | grep -q "Somente listagem" && [ -z "$(q "select 1 from pg_class where relname='fin_contas'")" ] && ok "N7 sem T3C_AUTORIZO_MIGRACOES: só lista os 3 arquivos (sha256), não conecta para escrever" || bad "N7: $O"
O=$(rodar "${BASE_ENV[@]}" T3C_IDENTIDADE=deadbeef T3C_AUTORIZO_115=SIM $T3C m115); echo "$O" | grep -q "T3C_IDENTIDADE ausente ou diferente" && ok "N8 identidade diferente da lida no preflight: recusa" || bad "N8: $O"
O=$(rodar "${ENV[@]}" T3C_AUTORIZO_MIGRACOES=SIM $T3C migracoes); echo "$O" | grep -q "a 115 não está aplicada" && ok "N9 migracoes sem a 115: recusa (exige m115 ou T3C_SEM_115=CIENTE)" || bad "N9: $O"
O=$(rodar "${ENV[@]}" T3C_AUTORIZO_PROVAS=SIM T3C_ACEITO_DADOS_PERMANENTES=SIM $T3C provas parity_m1); echo "$O" | grep -q "fora do manifesto" && ok "N10 prova fora do manifesto (parity_m1, usa replica): recusa" || bad "N10: $O"
O=$(rodar "${ENV[@]}" $T3C bloqueados); [ "$(echo "$O" | grep -c '^BLOQUEADO')" -ge 7 ] && ok "N11 lista de bloqueados com motivo ($(echo "$O" | grep -c '^BLOQUEADO') itens)" || bad "N11: $O"

# lint e adaptação (unidade)
cat > "$TMP/lint.mjs" <<'JS'
const { lint, adaptar } = await import(process.argv[2]);
const casos = { "truncate public.vendas;": "truncate", "set session_replication_role = replica;": "session_replication_role", "set role supabase_admin;": "set role",
  "delete from public.organizacoes where true;": "delete fora", "delete from unidades;": "delete fora", "begin;": "controle de transação", "commit;": "controle de transação",
  "\\! rm -rf /": "meta-comando", "\\c outro_banco": "meta-comando", "grant all on x to anon;": "grant/revoke", "create table x (a int);": "create de objeto",
  "create or replace function public.f() returns int language sql as $$ select 1 $$;": "create function", "alter table unidades add column x int;": "alter",
  "\\set ON_ERROR_ROLLBACK off": "ON_ERROR_ROLLBACK", "select '00000000-0000-0000-0000-0000000000a1';": "não remapeado", "call x();": "call", "reset all;": "reset all" };
let f = 0;
for (const [sql, esperado] of Object.entries(casos)) { const a = lint(sql); if (!a.some((x) => x.includes(esperado))) { console.log(`FALHA lint não pegou: ${sql} -> ${a}`); f++; } }
const limpos = ["do $$ begin perform 1; end $$;", "create or replace function pg_temp.f() returns void language plpgsql as $$\nbegin\n  null;\nend $$;",
  "set role service_role; reset role; set role :\"DONO\";", "delete from fin_referencias where id = '1';", "delete from public.fin_saldos_abertura where false;", "\\if :{?DONO} \\else \\set DONO x \\endif"];
for (const s of limpos) { const a = lint(s); if (a.length) { console.log(`FALHA falso positivo: ${s} -> ${a}`); f++; } }
console.log(f ? `LINT ${f} falha(s)` : `LINT OK (${Object.keys(casos).length} proibidos pegos, ${limpos.length} legítimos aceitos)`);
JS
O=$(node "$TMP/lint.mjs" "file:///$(cygpath -m "$AQUI/t3c.mjs" 2>/dev/null || echo "$AQUI/t3c.mjs")"); echo "$O" | grep -q "^LINT OK" && ok "N12 $(echo "$O" | tail -1)" || bad "N12: $O"

# ---------- O) originais intactos e ainda recusando este banco ----------
git -C "$R" diff --quiet -- backend/testes-seguros/pg backend/testes-seguros/t3/guarda_descartavel.sql backend/testes-seguros/t3/seed_descartavel.sql backend/testes-seguros/t3/preflight_t3.mjs backend/testes-seguros/t3/f3_f4_e2e.mjs \
  && ok "O1 scripts originais sem alteração (git diff vazio)" || bad "O1 scripts originais alterados"
O=$(psql $H -U postgres -X -q -d t3c_compart -v CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL -f "$PG/adversarial122.sql" 2>&1 | head -3)
echo "$O" | grep -q "ha organizacoes que nao sao de teste" && ok "O2 adversarial122.sql original continua recusando um banco com empresas reais" || bad "O2: $O"
O=$(psql $H -U postgres -X -q -d t3c_compart -v CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL -f "$R/backend/testes-seguros/t3/seed_descartavel.sql" 2>&1 | head -3)
echo "$O" | grep -q "ha organizacoes que nao sao de teste" && ok "O3 seed_descartavel.sql original continua recusando" || bad "O3: $O"
O=$(env -i PATH="$PATH" T3_PROJECT_REF=wiqqsxnysbzhcrzrrean T3_SUPABASE_URL=https://wiqqsxnysbzhcrzrrean.supabase.co T3_PSQL_CONN=postgresql://x@db.wiqqsxnysbzhcrzrrean.supabase.co/p T3_SERVICE_ROLE_KEY=x T3_ANON_KEY=x T3_CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL node "$R/backend/testes-seguros/t3/preflight_t3.mjs" 2>&1)
echo "$O" | grep -q "projeto de teste COMPARTILHADO" && ok "O4 preflight_t3.mjs original continua recusando o projeto compartilhado" || bad "O4: $O"

# ---------- P) fluxo completo ----------
O=$(rodar "${ENV[@]}" T3C_AUTORIZO_115=SIM $T3C m115); echo "$O" | grep -q "PASSO OK" && echo "$O" | grep -q "fora da allowlist: sem mudança" && ok "P2 m115 aplicada pelo t3c; nenhum dado mudou" || bad "P2: $O"
O=$(rodar "${ENV[@]}" T3C_AUTORIZO_MIGRACOES=SIM $T3C migracoes); echo "$O" | grep -q "PASSO OK" && echo "$O" | grep -q "exceto o permitido: modulos" && ok "P3 migracoes 120 → 121 → 122 (122 com --single-transaction); fora da allowlist só 'modulos' mudou" || bad "P3: $O"
O=$(psql $H -U postgres -X -q -d t3c_compart -f "$R/backend/testes-seguros/t3/verificacoes_catalogo.sql" 2>&1); NT=$(echo "$O" | grep -cE '\| t\s*$'); NF=$(echo "$O" | grep -cE '\| f\s*$')
[ "$NF" = "0" ] && [ "$NT" -ge 23 ] && ok "P4 verificacoes_catalogo.sql: $NT × t, 0 × f" || bad "P4: t=$NT f=$NF $(echo "$O" | grep -E '\| f\s*$' | head -3)"
O=$(rodar "${ENV[@]}" T3C_AUTORIZO_SEMENTE=SIM $T3C semente); echo "$O" | grep -q "PASSO OK" && ok "P5 semente [T3-FIN] (2 empresas, 6 unidades) com conferência da allowlist" || bad "P5: $O"
O=$(rodar "${ENV[@]}" T3C_AUTORIZO_SEMENTE=SIM $T3C semente); echo "$O" | grep -q "PASSO OK" && ok "P5b semente idempotente" || bad "P5b: $O"
for p in d1 adv122 adv122c r1 transferencia f1; do
  O=$(rodar "${ENV[@]}" T3C_AUTORIZO_PROVAS=SIM T3C_ACEITO_DADOS_PERMANENTES=SIM $T3C provas $p); L=$(echo "$O" | grep -E "^(OK|FALHA) +$p:")
  echo "$O" | grep -q "PASSO OK" && ok "P6 provas $p: ${L#* }" || { bad "P6 provas $p: $L"; echo "$O" | grep -E "FALHA|VIOLACAO|RECUSADO|ERRO" | head -5; }
done
CORTES=$(rodar "${ENV[@]}" $T3C provas adv122,adv122c | grep -o "cortes: .*" | tr '\n' ' ')   # sem autorização: só lista o plano
[ -n "$CORTES" ] && ok "P7 cortes declarados (não executados no compartilhado): $CORTES" || bad "P7 cortes não listados"

# ---------- V) violação da allowlist ⇒ ROLLBACK ----------
cat > "$TMP/viol.mjs" <<'JS'
const { embrulhar } = await import(process.argv[2]);
process.stdout.write(embrulhar({ passo: "provas", iso: "repeatable read", tolerante: true, corpo: process.argv[3] }));
JS
U=$(cygpath -m "$AQUI/t3c.mjs" 2>/dev/null || echo "$AQUI/t3c.mjs")
viol() { node "$TMP/viol.mjs" "file:///$U" "$1" | psql "postgresql://postgres_t3c@127.0.0.1:54321/t3c_compart" -X -q -v T3C_CONFIRMO=COMPARTILHADO_wiqqsxnysbzhcrzrrean -v T3C_AUTORIZO=provas -v T3C_IDENTIDADE="$IDENT" -f - 2>&1; }
A0=$(q "select coalesce(observacoes,'') from organizacoes where id='$REAL'")
O=$(viol "update public.organizacoes set observacoes = 'adulterado' where id = '$REAL';")
echo "$O" | grep -q "VIOLACAO (t3c): dados FORA da allowlist mudaram: organizacoes" && [ "$(q "select coalesce(observacoes,'') from organizacoes where id='$REAL'")" = "$A0" ] \
  && ok "V1 corpo que altera empresa REAL: VIOLACAO e ROLLBACK (empresa intacta)" || bad "V1: $O"
O=$(viol "insert into public.fin_plano_contas (organizacao_id, tipo, natureza, nome, papel) values ('$REAL', 'RECEITA', 'RECEBIMENTO', 'X', 'receita_operacional');")
echo "$O" | grep -q "linhas financeiras fora da allowlist: .*FIN_FORA_DA_ALLOWLIST:fin_plano_contas=1" && [ "$(q "select count(*) from fin_plano_contas where organizacao_id='$REAL'")" = "0" ] \
  && ok "V2 linha financeira numa empresa REAL: VIOLACAO e ROLLBACK" || bad "V2: $O"
O=$(viol "insert into public.unidade_modulos (unidade_id, modulo_id) select id, 'gestao_financeira' from public.unidades where organizacao_id = '$REAL';")
echo "$O" | grep -q "VIOLACAO (t3c): dados FORA da allowlist mudaram: unidade_modulos" && ok "V3 habilitar o Financeiro numa loja REAL: VIOLACAO e ROLLBACK" || bad "V3: $O"
O=$(node "$TMP/viol.mjs" "file:///$U" "select 1;" | psql "postgresql://postgres_t3c@127.0.0.1:54321/t3c_compart" -X -q -v T3C_CONFIRMO=COMPARTILHADO_wiqqsxnysbzhcrzrrean -v T3C_AUTORIZO=semente -v T3C_IDENTIDADE="$IDENT" -f - 2>&1)
echo "$O" | grep -q "RECUSADO (t3c): confirmacao/autorizacao do passo provas" && ok "V4 SQL embrulhado de um passo não roda com a autorização de outro" || bad "V4: $O"

# ---------- encerramento e conferência final ----------
O=$(rodar "${ENV[@]}" T3C_AUTORIZO_ENCERRAMENTO=SIM $T3C encerrar); echo "$O" | grep -q "PASSO OK" && ok "P8 encerramento: módulo desabilitado, [T3-FIN] inativas, dados financeiros preservados" || bad "P8: $O"
[ "$(q "select count(*) from organizacao_modulos where modulo_id='gestao_financeira'")$(q "select count(*) from unidade_modulos where modulo_id='gestao_financeira'")" = "00" ] && [ "$(q "select count(*) from fin_lancamentos")" != "0" ] \
  && ok "P9 depois do encerramento: 0 habilitações do módulo; $(q "select count(*) from fin_lancamentos") lançamentos sintéticos ficam (inertes)" || bad "P9"
O=$(rodar "${ENV[@]}" T3C_LINHA_DE_BASE="$BASEF" $T3C verificar); echo "$O" | grep -q "^DIFERE  modulos" && [ "$(echo "$O" | grep -c '^DIFERE')" = "1" ] \
  && ok "P10 verificar × linha de base do preflight: fora da allowlist só 'modulos' (+1 linha do catálogo) mudou" || bad "P10: $O"
[ "$(q "select count(*) from fin_lancamentos where organizacao_id <> all(array['00000000-0000-0000-0000-0000000f1a01','00000000-0000-0000-0000-0000000f1a02']::uuid[])")" = "0" ] \
  && ok "P11 todas as linhas financeiras estão nas 2 empresas sintéticas" || bad "P11"

echo; [ -z "$FALHOU" ] && echo "ENSAIO T3C (A1): TUDO OK" || echo "ENSAIO T3C (A1): HÁ FALHAS"
$SU -d postgres -c "drop database if exists t3c_compart" >/dev/null 2>&1
[ -z "$FALHOU" ]
