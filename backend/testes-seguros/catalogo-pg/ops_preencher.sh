#!/usr/bin/env bash
# Funções compartilhadas pelos testes dos scripts database/ops/remover_catalogo_modelo_indevido_*.sql.
# Preenche os marcadores do APLICAR com o que o PREVIEW imprimiu — o mesmo que o operador copia à mão em produção.

# valor_preview "<saída do PREVIEW com -F '='>" chave
valor_preview() { echo "$1" | grep "^$2=" | head -1 | cut -d= -f2-; }

# preencher_aplicar <saída do PREVIEW> <org_id> <arquivo APLICAR> [sobrescritas "chave=valor" ...] > aplicar.sql
preencher_aplicar() {
  local prev="$1" org="$2" modelo="$3"; shift 3
  declare -A V=(
    [ORG_ID]="$org" [ORG_NOME]="$(valor_preview "$prev" org_nome)" [MODELO_ID]="$(valor_preview "$prev" org_modelo_origem_id)"
    [ESPERADO_PRODUTOS]="$(valor_preview "$prev" produtos_a_remover)" [ESPERADO_INSUMOS]="$(valor_preview "$prev" insumos_a_remover)"
    [ESPERADO_FICHA]="$(valor_preview "$prev" linhas_ficha_a_remover)" [ESPERADO_PRECOS]="$(valor_preview "$prev" precos_a_remover)"
    [IDS_MD5_PRODUTOS]="$(valor_preview "$prev" ids_md5_produtos)" [IDS_MD5_INSUMOS]="$(valor_preview "$prev" ids_md5_insumos)"
    [IDS_MD5_FICHA]="$(valor_preview "$prev" ids_md5_ficha)" [IDS_MD5_PRECOS]="$(valor_preview "$prev" ids_md5_precos)"
  )
  for kv in "$@"; do V[${kv%%=*}]="${kv#*=}"; done
  local s; s="$(cat "$modelo")"
  for k in "${!V[@]}"; do s="${s//<$k>/${V[$k]}}"; done
  if echo "$s" | grep -q '<[A-Z][A-Z_]*>'; then echo "marcador não preenchido: $(echo "$s" | grep -o '<[A-Z][A-Z_]*>' | sort -u | tr '\n' ' ')" >&2; return 1; fi
  printf '%s\n' "$s"
}

# colunas de produção que o esquema mínimo dos testes não tem (só o necessário para os scripts)
STUBS_OPS_SQL="
alter table organizacoes add column if not exists eh_modelo boolean not null default false;
alter table organizacoes add column if not exists modelo_origem_id uuid references organizacoes(id);
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
"
