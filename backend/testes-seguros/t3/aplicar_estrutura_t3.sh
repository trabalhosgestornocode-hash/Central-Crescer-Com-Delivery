#!/bin/bash
# T3 — aplica a ESTRUTURA no projeto Supabase DESCARTÁVEL, em duas etapas com autorizações DISTINTAS. Nunca roda sem o pré-voo (fase A) aprovado.
#   etapa "base":       000_base_migration.sql (consolida 001–067) → 068…119 → 123…125, nas versões EXATAS de origin/main (como em produção)
#   etapa "financeiro": 120 → 121 → 122 (proposta), nas versões desta branch de integração
# Uso (terminal limpo, só com as variáveis T3_*):
#   T3_AUTORIZO_BASE=SIM       bash backend/testes-seguros/t3/aplicar_estrutura_t3.sh base
#   T3_AUTORIZO_120_122=SIM    bash backend/testes-seguros/t3/aplicar_estrutura_t3.sh financeiro
#   (sem a variável de autorização: só LISTA o que seria aplicado, sem conectar)
# Cada arquivo roda como está (vários têm begin/commit próprios e a 112 usa ALTER TYPE … ADD VALUE, que não aceita transação externa).
# Pára no PRIMEIRO erro. Grava log por arquivo em ${T3_EVIDENCIAS:-./evidencias-t3}/estrutura/. Nunca lê backend/.env.
set -u
ETAPA="${1:-}"; AQUI="$(cd "$(dirname "$0")" && pwd)"; RAIZ="$(cd "$AQUI/../../.." && pwd)"
case "$ETAPA" in base|financeiro) ;; *) echo "uso: $0 base|financeiro"; exit 2;; esac
node "$AQUI/preflight_t3.mjs" > /dev/null || { echo "RECUSADO: o pré-voo (fase A) falhou — rode: node backend/testes-seguros/t3/preflight_t3.mjs"; exit 2; }
EV="${T3_EVIDENCIAS:-./evidencias-t3}/estrutura"; TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
if [ "$ETAPA" = base ]; then
  AUT="${T3_AUTORIZO_BASE:-}"
  git -C "$RAIZ" rev-parse --verify -q origin/main >/dev/null || { echo "origin/main ausente (git fetch)"; exit 2; }
  LISTA=$(git -C "$RAIZ" ls-tree --name-only origin/main database/migrations/ | sed 's#database/migrations/##' | grep -v rollback | grep -E '^(000_|06[89]_|0[7-9][0-9]_|1[01][0-9]_|12[3-9]_)' | sort)
  for f in $LISTA; do git -C "$RAIZ" show "origin/main:database/migrations/$f" > "$TMP/$f"; done
  echo "origem: origin/main @ $(git -C "$RAIZ" rev-parse --short origin/main)"
else
  AUT="${T3_AUTORIZO_120_122:-}"
  cp "$RAIZ/database/migrations/120_gestao_financeira_fundacao.sql" "$RAIZ/database/migrations/121_gestao_financeira_dominio.sql" "$TMP/"
  cp "$RAIZ/docs/gestao-financeira/proposta-122/122_conciliacao_periodos.provisorio.sql" "$TMP/122_conciliacao_periodos.provisorio.sql"
  LISTA="120_gestao_financeira_fundacao.sql 121_gestao_financeira_dominio.sql 122_conciliacao_periodos.provisorio.sql"
  echo "origem: $(git -C "$RAIZ" branch --show-current) @ $(git -C "$RAIZ" rev-parse --short HEAD)"
fi
echo "projeto: ${T3_PROJECT_REF} | etapa: $ETAPA | arquivos: $(echo $LISTA | wc -w)"; for f in $LISTA; do echo "  $f  sha256=$(sha256sum "$TMP/$f" | cut -c1-16)"; done
[ "$AUT" = "SIM" ] || { echo "Somente listagem (falta a autorização da etapa: T3_AUTORIZO_BASE / T3_AUTORIZO_120_122 = SIM). Nada foi conectado."; exit 0; }
mkdir -p "$EV"
for f in $LISTA; do
  if psql "$T3_PSQL_CONN" -X -q -v ON_ERROR_STOP=1 -f "$TMP/$f" > "$EV/$f.log" 2>&1; then echo "OK    $f"; else echo "ERRO  $f (ver $EV/$f.log) — PARADO"; exit 1; fi
done
echo "etapa $ETAPA concluída. Próximo passo do roteiro: doc 14 §3."
