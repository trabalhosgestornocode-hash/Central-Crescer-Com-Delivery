#!/bin/bash
# Dump COMPLEMENTAR (somente leitura) das 4 tabelas tocadas pelas migrations 132–136 em PRODUÇÃO, cifrado em fluxo com `age`
# (o dado em claro nunca toca o disco), e conferência por contagem+hash. Mesmas travas do aplicar_prod_132_136.sh: a conexão vem SÓ
# de PROD_CONN no terminal do operador; recusa o projeto de teste e portas/hosts que não sejam de produção.
#
#   PROD_CONN=... bash dump_prod_4tabelas.sh            -> grava <pasta>/prod-4tabelas-<carimbo>.dump.age + .sha256 + .hashes.txt
# Pasta (fora do Git e do OneDrive): padrão C:\Users\<usuário>\backups-prod\pr55-132-136 (BACKUP_DIR para trocar).
# Chave PÚBLICA: <pasta>/destinatario.agepub (só cifra). A privada fica em outro lugar (não é lida aqui).
set -uo pipefail
REF_PROD=uqybgauuxcrqzquultfu; REF_TESTE=wiqqsxnysbzhcrzrrean
CONN="${PROD_CONN:-}"
DIR="${BACKUP_DIR:-$HOME/backups-prod/pr55-132-136}"
PG_BIN="/c/Program Files/PostgreSQL/17/bin"; PSQL="$PG_BIN/psql"; PGDUMP="$PG_BIN/pg_dump"
[ -x "$PSQL" ] || { PSQL=psql; PGDUMP=pg_dump; }
falhar() { echo "PARADO: $*" >&2; exit 1; }
[ -n "$CONN" ] || falhar "defina PROD_CONN no seu terminal (não cole a conexão no chat)"
case "$CONN" in *"$REF_TESTE"*) falhar "PROD_CONN aponta para o projeto de TESTE";; esac
[[ "$CONN" =~ @db\.$REF_PROD\.supabase\.co:5432/ || "$CONN" =~ postgres\.$REF_PROD[:@].*pooler\.supabase\.com:5432/ ]] \
  || falhar "host/porta não são de produção ($REF_PROD, conexão direta ou pooler de SESSÃO 5432)"
command -v age >/dev/null || falhar "age não encontrado"
[ -f "$DIR/destinatario.agepub" ] || falhar "sem $DIR/destinatario.agepub (chave pública)"
export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=120000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=60000"
export PGAPPNAME=pr55-dump-leitura PGCLIENTENCODING=UTF8 PGCONNECT_TIMEOUT=15
T=$(date -u +%Y%m%dT%H%M%SZ); SAIDA="$DIR/prod-4tabelas-$T.dump.age"
HASHES="select 'unidades|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(x)::text, ';' order by x.id), '')) from unidades x
 union all select 'comunicacao_categorias|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(x)::text, ';' order by x.codigo), '')) from comunicacao_categorias x
 union all select 'comunicacao_configuracoes|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(x)::text, ';' order by x.chave), '')) from comunicacao_configuracoes x
 union all select 'comunicacao_destinatario_categorias|'||count(*)||'|'||md5(coalesce(string_agg(to_jsonb(x)::text, ';' order by to_jsonb(x)::text), '')) from comunicacao_destinatario_categorias x"
"$PSQL" "$CONN" -X -tA -c "$HASHES" > "$DIR/prod-4tabelas-$T.hashes.txt" || falhar "não consegui calcular os hashes"
"$PGDUMP" "$CONN" -Fc --lock-wait-timeout=5s -t public.unidades -t public.comunicacao_categorias -t public.comunicacao_configuracoes \
  -t public.comunicacao_destinatario_categorias | age -R "$DIR/destinatario.agepub" -o "$SAIDA" || falhar "pg_dump/age falhou (nada válido gravado)"
[ -s "$SAIDA" ] || falhar "arquivo vazio"
sha256sum "$SAIDA" | cut -d' ' -f1 > "$SAIDA.sha256"
echo "OK: $SAIDA ($(wc -c < "$SAIDA") bytes) sha256=$(cut -c1-16 "$SAIDA.sha256")…"
echo "hashes no momento do dump:"; cat "$DIR/prod-4tabelas-$T.hashes.txt"
