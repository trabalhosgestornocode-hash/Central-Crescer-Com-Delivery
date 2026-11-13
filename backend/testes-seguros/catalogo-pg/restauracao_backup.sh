#!/usr/bin/env bash
# Ensaio COMPLETO de remoção + restauração do catálogo-modelo indevido com os DADOS REAIS do backup (somente leitura de
# produção, ver docs/jah-acai-fichas/README.md), num Postgres DESCARTÁVEL local. Os dados nunca entram no repositório.
#
# Uso: CAT_PG_DESCARTAVEL=1 CAT_PG_PORT=55420 PSQL=".../psql" ./restauracao_backup.sh <pasta_backup> <org_id> [payload_carga.json]
#   <pasta_backup> com produtos.jsonl, insumos.jsonl, ficha_tecnica.jsonl, produto_precos.jsonl (1 linha = to_jsonb(linha)).
#   [payload_carga.json] opcional: carga de planilha aplicada DEPOIS na mesma empresa (deve sobreviver à remoção).
# Cobre: PREVIEW com as contagens reais; APLICAR (travas, backup em backup_ops); REVERTER pelo backup_ops; e
# RESTAURAÇÃO A PARTIR DO ARQUIVO (caminho de contingência se o backup_ops se perder). Outra empresa com as MESMAS
# linhas (o "modelo de origem", ids diferentes) precisa ficar intacta.
set -euo pipefail
[ "${CAT_PG_DESCARTAVEL:-}" = "1" ] || { echo "defina CAT_PG_DESCARTAVEL=1 (cluster temporário local)"; exit 2; }
HOST="${CAT_PG_HOST:-127.0.0.1}"; case "$HOST" in 127.0.0.1|localhost|::1) ;; *) echo "só loopback"; exit 2;; esac
[ $# -ge 2 ] || { echo "uso: $0 <pasta_backup> <org_id> [payload.json]"; exit 2; }
BK="$1"; ORG="$2"; PAYLOAD="${3:-}"
PORT="${CAT_PG_PORT:-55420}"; PSQL="${PSQL:-psql}"; DB="cat_restauro_$$"
AQUI="$(cd "$(dirname "$0")" && pwd)"; M="$AQUI/../../../database/migrations"; OPS="$AQUI/../../../database/ops"
TMP="$(mktemp -d)"
run() { PGCLIENTENCODING=UTF8 PGOPTIONS="-c TimeZone=UTC" "$PSQL" -h "$HOST" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
q() { run -d "$DB" -tA -c "$1" | tr -d '\r'; }
ok() { echo "ok - $1"; }
falha() { echo "FALHA: $1"; exit 1; }
winpath() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
run -d postgres -c "create database $DB"
trap 'run -d postgres -c "drop database if exists $DB" >/dev/null; rm -rf "$TMP"' EXIT
for f in "$AQUI/00_stub.sql" "$AQUI/../../../database/schema.sql"; do run -d "$DB" -f "$f" >/dev/null 2>&1; done
for m in 002_produto_historico 004_custo_manual 021_insumos_ficha_cmv 022_origem_reconstrucao; do run -d "$DB" -f "$M/$m.sql" >/dev/null 2>&1; done
run -d "$DB" -f "$AQUI/05_seed_subway.sql" >/dev/null 2>&1
run -d "$DB" -f "$M/157_catalogo_empresa_rendimento_importacao.sql" >/dev/null 2>&1
run -d "$DB" -f "$M/158_condicoes_comerciais_e_invalidacao_homologacao.sql" >/dev/null 2>&1
run -d "$DB" >/dev/null 2>&1 <<'SQL'
create table if not exists sw_produtos_vendidos (id uuid primary key default gen_random_uuid(), produto_id uuid references produtos(id) on delete set null);
create table if not exists sw_mapeamento_produtos (id uuid primary key default gen_random_uuid(), produto_id uuid references produtos(id) on delete set null);
create table if not exists vendas_itens (id uuid primary key default gen_random_uuid(), produto_id uuid references produtos(id));
create table if not exists movimentacoes_estoque (id uuid primary key default gen_random_uuid(), insumo_id uuid references insumos(id));
create table if not exists pedidos_compra_itens (id uuid primary key default gen_random_uuid(), insumo_id uuid references insumos(id));
create table if not exists insumo_historico (id uuid primary key default gen_random_uuid(), insumo_id uuid references insumos(id) on delete cascade);
create table if not exists produto_historico (id uuid primary key default gen_random_uuid(), produto_id uuid references produtos(id) on delete cascade);
create table if not exists sw_combo_componentes (id uuid primary key default gen_random_uuid(), produto_id uuid references produtos(id) on delete cascade);
create table if not exists estoque (id uuid primary key default gen_random_uuid(), insumo_id uuid references insumos(id) on delete cascade);
create table if not exists lotes (id uuid primary key default gen_random_uuid(), insumo_id uuid references insumos(id) on delete cascade);
create table if not exists divergencias_compra (id uuid primary key default gen_random_uuid(), insumo_id uuid references insumos(id) on delete set null);
create table if not exists martin_brower_vinculos (id uuid primary key default gen_random_uuid(), insumo_id uuid references insumos(id) on delete cascade);
SQL
TRG="$(q "select string_agg(tgrelid::regclass||':'||tgname, ',' order by 1) from pg_trigger where not tgisinternal and tgrelid in ('produtos'::regclass,'insumos'::regclass,'ficha_tecnica'::regclass,'produto_precos'::regclass)")"
echo "gatilhos locais: $TRG"

# carrega o backup (via CSV com separadores improváveis: o texto JSON vai intacto, sem interpretar barras)
carregar_arquivos() {  # $1 = tabela de destino temporária com coluna linha jsonb
  for t in produtos insumos ficha_tecnica produto_precos; do
    run -d "$DB" -c "\\copy $1_$t(linha) from '$(winpath "$BK/$t.jsonl")' with (format csv, quote e'\\x01', delimiter e'\\x02')"
  done
}
run -d "$DB" -c "create table bk_produtos(linha jsonb); create table bk_insumos(linha jsonb); create table bk_ficha_tecnica(linha jsonb); create table bk_produto_precos(linha jsonb);" >/dev/null
carregar_arquivos bk
N="$(q "select (select count(*) from bk_produtos)||'/'||(select count(*) from bk_insumos)||'/'||(select count(*) from bk_ficha_tecnica)||'/'||(select count(*) from bk_produto_precos)")"
ok "backup lido: produtos/insumos/ficha/preços = $N"
IFS=/ read -r NP NI NF NPP <<<"$N"

# empresa-alvo + unidade + as linhas reais do backup (mesmos ids e valores)
q "insert into organizacoes (id, nome) values ('$ORG','Empresa alvo'); insert into unidades (organizacao_id, nome) values ('$ORG','Matriz')" >/dev/null
q "insert into insumos select (jsonb_populate_record(null::insumos, linha)).* from bk_insumos;
   insert into produtos select (jsonb_populate_record(null::produtos, linha)).* from bk_produtos;
   insert into produto_precos select (jsonb_populate_record(null::produto_precos, linha)).* from bk_produto_precos;
   insert into ficha_tecnica select (jsonb_populate_record(null::ficha_tecnica, linha)).* from bk_ficha_tecnica;" >/dev/null
# "modelo de origem": OUTRA empresa com as mesmas linhas (ids novos) — não pode ser tocada
q "insert into organizacoes (id, nome) values ('f0000000-0000-4000-8000-0000000000f0','Modelo de origem');
   create temp table mapa as select (linha->>'id')::uuid antigo, gen_random_uuid() novo from bk_produtos union all select (linha->>'id')::uuid, gen_random_uuid() from bk_insumos;
   insert into insumos select (jsonb_populate_record(null::insumos, linha || jsonb_build_object('id',(select novo from mapa where antigo=(linha->>'id')::uuid),'organizacao_id','f0000000-0000-4000-8000-0000000000f0'))).* from bk_insumos;
   insert into produtos select (jsonb_populate_record(null::produtos, linha || jsonb_build_object('id',(select novo from mapa where antigo=(linha->>'id')::uuid),'organizacao_id','f0000000-0000-4000-8000-0000000000f0'))).* from bk_produtos;
   insert into ficha_tecnica (produto_id, insumo_id, quantidade, ativo) select (select novo from mapa where antigo=(linha->>'produto_id')::uuid), (select novo from mapa where antigo=(linha->>'insumo_id')::uuid), (linha->>'quantidade')::numeric, coalesce((linha->>'ativo')::boolean, true) from bk_ficha_tecnica;" >/dev/null
if [ -n "$PAYLOAD" ]; then
  run -d "$DB" -c "create table carga_payload(linha jsonb)" -c "\copy carga_payload(linha) from '$(winpath "$PAYLOAD")' with (format csv, quote e'\x01', delimiter e'\x02')" >/dev/null
  q "select fn_catalogo_importar('$ORG','carga-planilha', (select linha from carga_payload))" >/dev/null; ok "carga de planilha aplicada depois na mesma empresa"
fi

assin() { q "select md5(string_agg(x, '|' order by x)) from (
  select to_jsonb(p)::text x from produtos p where organizacao_id='$ORG' union all select to_jsonb(i)::text from insumos i where organizacao_id='$ORG'
  union all select to_jsonb(f)::text from ficha_tecnica f join produtos p on p.id=f.produto_id where p.organizacao_id='$ORG'
  union all select to_jsonb(pp)::text from produto_precos pp join produtos p on p.id=pp.produto_id where p.organizacao_id='$ORG') t"; }
outras() { q "select md5(string_agg(x, '|' order by x)) from (
  select to_jsonb(p)::text x from produtos p where organizacao_id<>'$ORG' union all select to_jsonb(i)::text from insumos i where organizacao_id<>'$ORG'
  union all select to_jsonb(f)::text from ficha_tecnica f join produtos p on p.id=f.produto_id where p.organizacao_id<>'$ORG'
  union all select to_jsonb(pp)::text from produto_precos pp join produtos p on p.id=pp.produto_id where p.organizacao_id<>'$ORG') t"; }
CARGA() { q "select count(*) from catalogo_origem where organizacao_id='$ORG' and entidade='produto'"; }
ANTES="$(assin)"; OUTRAS="$(outras)"; CARGA_ANTES="$(CARGA)"

sed "s/<ORG_ID>/$ORG/g" "$OPS/remover_catalogo_modelo_indevido_PREVIEW.sql" > "$TMP/p.sql"
PREV="$(run -d "$DB" -tA -F '=' -f "$TMP/p.sql" | tr -d '\r')"; echo "$PREV" | sed 's/^/   /'
for k in "produtos_a_remover=$NP" "insumos_a_remover=$NI" "linhas_ficha_a_remover=$NF" "precos_a_remover=$NPP"; do echo "$PREV" | grep -qx "$k" || falha "PREVIEW: esperado $k"; done
ok "PREVIEW = contagens do backup ($NP/$NI/$NF/$NPP)"
[ "$(echo "$PREV" | grep '^TRAVA_' | grep -cv '=0$')" = "0" ] && ok "nenhuma trava" || falha "trava acionada"

sed -e "s/<ORG_ID>/$ORG/g" -e "s/<ESPERADO_PRODUTOS>/$NP/" -e "s/<ESPERADO_INSUMOS>/$NI/" -e "s/<ESPERADO_FICHA>/$NF/" -e "s/<ESPERADO_PRECOS>/$NPP/" \
  "$OPS/remover_catalogo_modelo_indevido_APLICAR.sql" > "$TMP/a.sql"
SAIDA="$(run -d "$DB" -tA -F '=' -f "$TMP/a.sql" | tr -d '\r')" || falha "APLICAR"
LOTE="$(echo "$SAIDA" | grep '^lote de backup' | cut -d= -f2)"
RESTAM="$(q "select count(*) from produtos p where organizacao_id='$ORG' and not exists (select 1 from catalogo_origem o where o.entidade_id=p.id)")"
[ "$RESTAM" = "0" ] && ok "APLICAR: nenhum produto do modelo restou" || falha "restaram $RESTAM"
[ "$(CARGA)" = "$CARGA_ANTES" ] && [ "$(q "select count(*) from produtos where organizacao_id='$ORG'")" = "$CARGA_ANTES" ] && ok "APLICAR: carga da planilha intacta ($CARGA_ANTES produtos)" || falha "carga afetada"
[ "$(outras)" = "$OUTRAS" ] && ok "APLICAR: outras empresas (inclusive o modelo de origem) intactas" || falha "outras empresas"
[ "$(q "select count(*) from backup_ops.modelo_indevido_precos where lote='$LOTE'")" = "$NPP" ] && ok "backup_ops com os $NPP preços do lote" || falha "backup_ops"
DIF="$(q "select count(*) from ((select (linha->>'id') id, linha->>'nome' n, linha->>'custo_cache' c from backup_ops.modelo_indevido_produtos where lote='$LOTE')
         except (select linha->>'id', linha->>'nome', linha->>'custo_cache' from bk_produtos)) d")"
[ "$DIF" = "0" ] && ok "backup_ops confere com o arquivo (id, nome, custo)" || falha "backup_ops difere do arquivo ($DIF)"

sed "s/<LOTE>/$LOTE/g" "$OPS/remover_catalogo_modelo_indevido_REVERTER.sql" > "$TMP/r.sql"
run -d "$DB" -tA -f "$TMP/r.sql" >/dev/null || falha "REVERTER"
[ "$(assin)" = "$ANTES" ] && ok "REVERTER (backup_ops): empresa volta idêntica byte a byte" || falha "REVERTER difere"
[ "$(outras)" = "$OUTRAS" ] && ok "REVERTER: outras empresas intactas" || falha "REVERTER outras"

# contingência: remover de novo e restaurar A PARTIR DO ARQUIVO (sem backup_ops)
run -d "$DB" -tA -F '=' -f "$TMP/a.sql" >/dev/null || falha "2º APLICAR"
q "drop schema backup_ops cascade" >/dev/null
sed "s#<PASTA>#$(winpath "$BK")#g" "$OPS/remover_catalogo_modelo_indevido_RESTAURAR_ARQUIVO.sql" > "$TMP/arq.sql"
run -d "$DB" -f "$TMP/arq.sql" >/dev/null || falha "restauração pelo arquivo"
[ "$(assin)" = "$ANTES" ] && ok "RESTAURAÇÃO PELO ARQUIVO (sem backup_ops): empresa volta idêntica byte a byte" || falha "restauração pelo arquivo difere"
echo "RESTAURAÇÃO COM BACKUP REAL: TODOS OS TESTES PASSARAM"
