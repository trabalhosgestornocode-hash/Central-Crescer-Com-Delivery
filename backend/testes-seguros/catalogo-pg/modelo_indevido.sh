#!/usr/bin/env bash
# Testa os scripts database/ops/remover_catalogo_modelo_indevido_{PREVIEW,APLICAR,REVERTER}.sql num Postgres DESCARTÁVEL.
# Cenário: empresa "J" recebeu por engano a cópia do catálogo-modelo (mesmo created_at) e DEPOIS uma carga de planilha.
# Uso: CAT_PG_DESCARTAVEL=1 CAT_PG_PORT=55420 PSQL=".../psql" ./modelo_indevido.sh
set -euo pipefail
[ "${CAT_PG_DESCARTAVEL:-}" = "1" ] || { echo "defina CAT_PG_DESCARTAVEL=1 (cluster temporário local)"; exit 2; }
HOST="${CAT_PG_HOST:-127.0.0.1}"; case "$HOST" in 127.0.0.1|localhost|::1) ;; *) echo "só loopback"; exit 2;; esac
PORT="${CAT_PG_PORT:-55420}"; PSQL="${PSQL:-psql}"; DB="cat_modelo_$$"
AQUI="$(cd "$(dirname "$0")" && pwd)"; M="$AQUI/../../../database/migrations"; OPS="$AQUI/../../../database/ops"
TMP="$(mktemp -d)"
run() { "$PSQL" -h "$HOST" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
q() { run -d "$DB" -tA -c "$1"; }
ok() { echo "ok - $1"; }
falha() { echo "FALHA: $1"; exit 1; }
run -d postgres -c "create database $DB"
trap 'run -d postgres -c "drop database if exists $DB" >/dev/null; rm -rf "$TMP"' EXIT
run -d "$DB" -f "$AQUI/00_stub.sql" >/dev/null 2>&1
run -d "$DB" -f "$AQUI/../../../database/schema.sql" >/dev/null 2>&1
for m in 002_produto_historico 004_custo_manual 021_insumos_ficha_cmv 022_origem_reconstrucao; do run -d "$DB" -f "$M/$m.sql" >/dev/null 2>&1; done
run -d "$DB" -f "$AQUI/05_seed_subway.sql" >/dev/null 2>&1
run -d "$DB" -f "$M/157_catalogo_empresa_rendimento_importacao.sql" >/dev/null 2>&1
run -d "$DB" -f "$M/158_condicoes_comerciais_e_invalidacao_homologacao.sql" >/dev/null 2>&1

J=e1000000-0000-4000-8000-0000000000e1
MOD=e0000000-0000-4000-8000-00000000a0a0
. "$AQUI/ops_preencher.sh"
run -d "$DB" -c "$STUBS_OPS_SQL" >/dev/null 2>&1
run -d "$DB" >/dev/null 2>&1 <<SQL
insert into organizacoes (id, nome, eh_modelo) values ('$MOD','Modelo Padrão', true);
insert into organizacoes (id, nome, modelo_origem_id) values ('$J','Empresa J — Centro', '$MOD');
insert into unidades (organizacao_id, nome) values ('$J','Loja J');
-- cópia do modelo (mesmo instante), com preparação, linha inativa e preços em várias tabelas
insert into insumos (id, organizacao_id, nome, unidade_medida, preco_unitario, created_at) values
 ('e2000000-0000-4000-8000-000000000001','$J','Pão','un',1.25,'2026-08-27 21:38:35.164424+00'),
 ('e2000000-0000-4000-8000-000000000002','$J','Frango','kg',30,'2026-08-27 21:38:35.164424+00');
insert into produtos (id, organizacao_id, nome, vendavel, tipo, created_at) values
 ('e3000000-0000-4000-8000-000000000001','$J','Recheio',false,'submontagem','2026-08-27 21:38:35.382094+00'),
 ('e3000000-0000-4000-8000-000000000002','$J','Sanduíche',true,'sanduiche','2026-08-27 21:38:35.382094+00');
insert into ficha_tecnica (produto_id, insumo_id, quantidade) values ('e3000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000002',0.076);
insert into ficha_tecnica (produto_id, subproduto_id, quantidade) values ('e3000000-0000-4000-8000-000000000002','e3000000-0000-4000-8000-000000000001',2);
insert into ficha_tecnica (produto_id, insumo_id, quantidade, ativo) values ('e3000000-0000-4000-8000-000000000002','e2000000-0000-4000-8000-000000000001',1,false);
insert into produto_precos (produto_id, canal, tabela, preco) values
 ('e3000000-0000-4000-8000-000000000002','balcao','A',20),('e3000000-0000-4000-8000-000000000002','ifood','Z1',25),('e3000000-0000-4000-8000-000000000001','balcao','A',1);
-- carga de planilha DEPOIS (o que a empresa realmente usa)
select fn_catalogo_importar('$J','planilha-j','{"insumos":[{"chave":"ing:POLPA","nome":"POLPA","tipo":"outro","unidade_medida":"g","preco_caixa":20,"rendimento":1000}],
 "produtos":[{"chave":"fin:j:COPO","nome":"COPO","tipo":"outro","vendavel":true,"rendimento":1,"linhas":[{"ref":"insumo","chave":"ing:POLPA","quantidade":300,"ordem":1}]}]}'::jsonb);
SQL
snap() { q "select md5(string_agg(x, '|' order by x)) from (
  select to_jsonb(p)::text x from produtos p union all select to_jsonb(i)::text from insumos i
  union all select to_jsonb(f)::text from ficha_tecnica f union all select to_jsonb(pp)::text from produto_precos pp
  union all select id||':'||coalesce(modelo_origem_id::text,'nulo') from organizacoes) t"; }
outras() { q "select md5(string_agg(x, '|' order by x)) from (
  select to_jsonb(p)::text x from produtos p where organizacao_id <> '$J' union all select to_jsonb(i)::text from insumos i where organizacao_id <> '$J'
  union all select to_jsonb(f)::text from ficha_tecnica f join produtos p on p.id=f.produto_id where p.organizacao_id <> '$J') t"; }
ANTES="$(snap)"; OUTRAS="$(outras)"

sed "s/<ORG_ID>/$J/g" "$OPS/remover_catalogo_modelo_indevido_PREVIEW.sql" > "$TMP/preview.sql"
PREV="$(run -d "$DB" -tA -F '=' -f "$TMP/preview.sql")"
echo "$PREV" | grep -q "^produtos_a_remover=2$" && echo "$PREV" | grep -q "^insumos_a_remover=2$" && echo "$PREV" | grep -q "^linhas_ficha_a_remover=3$" && echo "$PREV" | grep -q "^precos_a_remover=3$" \
  && ok "PREVIEW: 2 produtos, 2 insumos, 3 linhas de ficha e 3 preços do modelo (a carga da planilha NÃO entra)" || { echo "$PREV"; falha "PREVIEW"; }
[ "$(echo "$PREV" | grep '^TRAVA_' | grep -cv '=0$')" = "0" ] && ok "PREVIEW: nenhuma trava acionada" || falha "travas"
[ "$(snap)" = "$ANTES" ] && ok "PREVIEW não altera nada" || falha "preview alterou"

echo "$PREV" | grep -q "^org_modelo_origem_id=$MOD$" && echo "$PREV" | grep -q "^org_nome=Empresa J — Centro$" && ok "PREVIEW mostra a identidade (nome e modelo de origem)" || falha "identidade no PREVIEW"
APL="$OPS/remover_catalogo_modelo_indevido_APLICAR.sql"
aplicar() { preencher_aplicar "$PREV" "$J" "$APL" "$@" > "$TMP/aplicar.sql" || return 9; run -d "$DB" -tA -F '=' -f "$TMP/aplicar.sql" 2>&1; }
recusa() { local msg="$1" motivo="$2"; shift 2; local out; out="$(aplicar "$@")" && falha "aceitou: $msg"
  echo "$out" | grep -q "$motivo" || { echo "$out" | tail -3; falha "motivo errado para: $msg"; }
  [ "$(snap)" = "$ANTES" ] && ok "APLICAR recusado ($msg — \"$motivo\") e nada muda" || falha "alterou: $msg"; }

recusa "contagem diferente do PREVIEW" "Contagem diferente" "ESPERADO_PRODUTOS=3"
recusa "nome da empresa diferente" "Empresa não confere" "ORG_NOME=Outra Empresa"
recusa "modelo de origem diferente" "Modelo de origem não confere" "MODELO_ID=$J"
recusa "ids diferentes dos do PREVIEW" "impressão digital diferente" "IDS_MD5_PRECOS=00000000000000000000000000000000"
recusa "id de outra empresa" "Empresa não confere" "ORG_ID=a0000000-0000-4000-8000-000000000001"
( preencher_aplicar "$PREV" "$J" "$APL" "ORG_NOME=<ORG_NOME>" >/dev/null 2>&1 ) && falha "aceitou marcador vazio" || ok "marcador não preenchido é detectado antes de rodar"

q "insert into lotes (id, unidade_id, insumo_id, quantidade) select 'e9000000-0000-4000-8000-000000000001', id, 'e2000000-0000-4000-8000-000000000001', 1 from unidades where organizacao_id='$J'" >/dev/null
recusa "trava: lote de estoque (tabela em cascata)" "uso real dos itens-modelo"
q "delete from lotes where id='e9000000-0000-4000-8000-000000000001'" >/dev/null
q "update unidades set tabela_balcao='A' where organizacao_id='$J'" >/dev/null
OUT="$(aplicar)" && falha "aceitou com tabela oficial"; echo "$OUT" | grep -q "uso real dos itens-modelo" || falha "motivo tabela oficial"
q "update unidades set tabela_balcao=null where organizacao_id='$J'" >/dev/null
[ "$(snap)" = "$ANTES" ] && ok "APLICAR recusado (trava: tabela oficial em uso) e nada muda" || falha "alterou com tabela oficial"
# produto do modelo editado/adicionado depois do PREVIEW muda a impressão digital
q "insert into produto_precos (produto_id, canal, tabela, preco) values ('e3000000-0000-4000-8000-000000000001','ifood','Z1',2)" >/dev/null
OUT="$(aplicar)" && falha "aceitou com preço novo após o PREVIEW"; echo "$OUT" | grep -q "Contagem diferente" && ok "APLICAR recusado: preço criado depois do PREVIEW (contagem)" || falha "motivo preço novo"
q "delete from produto_precos where produto_id='e3000000-0000-4000-8000-000000000001' and tabela='Z1'" >/dev/null
[ "$(snap)" = "$ANTES" ] || falha "estado de teste não restaurado"

SAIDA="$(aplicar)" || { echo "$SAIDA"; falha "APLICAR"; }
LOTE="$(echo "$SAIDA" | grep '^lote de backup' | cut -d= -f2)"
[ "$(q "select count(*) from produtos where organizacao_id='$J'")" = "1" ] && [ "$(q "select nome from produtos where organizacao_id='$J'")" = "COPO" ]   && [ "$(q "select count(*) from insumos where organizacao_id='$J'")" = "1" ] && ok "APLICAR: sobra só o catálogo da planilha (COPO/POLPA)" || falha "sobrou modelo"
[ "$(q "select count(*) from produto_precos pp join produtos p on p.id=pp.produto_id where p.organizacao_id='$J'")" = "0" ] && ok "APLICAR: tabelas de preço do modelo removidas" || falha "precos"
[ "$(q "select count(*) from ficha_tecnica f join produtos p on p.id=f.produto_id where p.organizacao_id='$J'")" = "1" ] && ok "APLICAR: ficha da planilha intacta" || falha "ficha planilha"
[ "$(q "select coalesce(modelo_origem_id::text,'nulo') from organizacoes where id='$J'")" = "nulo" ] && ok "APLICAR: modelo_origem_id limpo (a aba Modelo Inicial não consegue reclonar)" || falha "modelo_origem_id"
[ "$(outras)" = "$OUTRAS" ] && ok "APLICAR: outras empresas intactas" || falha "outras empresas"
[ "$(q "select count(*) from backup_ops.modelo_indevido_produtos where lote='$LOTE'")" = "2" ] && [ "$(q "select modelo_origem_id from backup_ops.modelo_indevido_empresa where lote='$LOTE'")" = "$MOD" ]   && ok "APLICAR: cópia de segurança gravada, inclusive o modelo de origem (lote $LOTE)" || falha "backup"
[ "$(q "select has_schema_privilege('anon','backup_ops','USAGE')")" = "f" ] && ok "cópia de segurança fora do alcance de anon" || falha "backup exposto"

OUT="$(aplicar)" && falha "reaplicou"; echo "$OUT" | grep -q "Modelo de origem não confere" && ok "APLICAR repetido é recusado (modelo de origem já limpo)" || falha "motivo reaplicar"

sed "s/<LOTE>/$LOTE/g" "$OPS/remover_catalogo_modelo_indevido_REVERTER.sql" > "$TMP/reverter.sql"
run -d "$DB" -tA -f "$TMP/reverter.sql" >/dev/null || falha "REVERTER"
[ "$(snap)" = "$ANTES" ] && ok "REVERTER devolve exatamente as mesmas linhas e o modelo_origem_id" || falha "reverter difere"
run -d "$DB" -tA -f "$TMP/reverter.sql" >/dev/null 2>&1 && falha "reverteu duas vezes" || ok "REVERTER repetido é recusado"
echo "MODELO INDEVIDO: TODOS OS TESTES PASSARAM"
