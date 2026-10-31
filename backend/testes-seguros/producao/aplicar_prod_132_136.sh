#!/bin/bash
# Aplicação CONTROLADA das migrations 132–136 em PRODUÇÃO (uqybgauuxcrqzquultfu) — PR #55. Procedimento: docs/configuracoes-2-notificacoes/17-*.md
# Mesmo modelo de prod-migrar*.mjs: só um OPERADOR AUTORIZADO roda, no PRÓPRIO terminal; a conexão vem SÓ de PROD_CONN (nunca lida de
# arquivo, impressa nem gravada). Evidências fora do Git (PROD_EVIDENCIAS, padrão: pasta temporária do sistema).
#
#   bash aplicar_prod_132_136.sh pacote                    -> regera o pacote do commit b76a81a e confere SHA-256 e \r (não conecta)
#   bash aplicar_prod_132_136.sh prevoo                    -> SOMENTE LEITURA: pré-voo + portões (nada de 132–136, sem locks/transações abertas)
#   PROD_AUTORIZO=SIM PROD_BACKUP_CONFIRMADO=SIM bash aplicar_prod_132_136.sh aplicar
#                                                          -> pacote + pré-voo + portões + aplicação (UMA transação) + validação
#   bash aplicar_prod_132_136.sh validar                   -> SOMENTE LEITURA: validação pós (18 itens) + pré-voo pós
# Ensaio: PROD_ENSAIO_LOCAL=1 aceita só 127.0.0.1:${PROD_ENSAIO_PORTA:-54321} com MARCADOR_DESCARTAVEL em PG_CLUSTER_DIR.
set -uo pipefail
COMMIT=b76a81a
SHA_APLICAR=ecbd2aaa06ad5ae5afdd0e7bfa626beb836c45f55bc94770b0818f1988fe17f5
SHA_REVERTER=3f9371a904f0fd077c8c4c712615b0eec6821fc853e159a8950134a517dd226e
REF_PROD=uqybgauuxcrqzquultfu; REF_TESTE=wiqqsxnysbzhcrzrrean
AQUI="$(cd "$(dirname "$0")" && pwd)"; RAIZ="$(cd "$AQUI/../../.." && pwd)"
PSQL="${PSQL:-/c/Program Files/PostgreSQL/17/bin/psql}"; [ -x "$PSQL" ] || PSQL=psql
EVID="${PROD_EVIDENCIAS:-${TMPDIR:-/tmp}/evidencias-prod-132-136}"; mkdir -p "$EVID"
CONN="${PROD_CONN:-}"; MODO="${1:-}"
carimbo() { date -u +%Y%m%dT%H%M%SZ; }
ocultar() { local l; while IFS= read -r l || [ -n "$l" ]; do if [ -n "$CONN" ]; then printf '%s\n' "${l//"$CONN"/<conexão>}"; else printf '%s\n' "$l"; fi; done; }
falhar() { echo "PARADO: $*" >&2; exit 1; }

travas() {
  [ -n "$CONN" ] || falhar "defina PROD_CONN no seu terminal (não cole a conexão no chat)"
  case "$CONN" in *"$REF_TESTE"*) falhar "PROD_CONN aponta para o projeto de TESTE";; esac
  if [ "${PROD_ENSAIO_LOCAL:-}" = "1" ]; then
    [[ "$CONN" =~ @127\.0\.0\.1:${PROD_ENSAIO_PORTA:-54321}/ ]] || falhar "ensaio: só 127.0.0.1:${PROD_ENSAIO_PORTA:-54321}"
    [ -f "${PG_CLUSTER_DIR:-/nao}/MARCADOR_DESCARTAVEL" ] || falhar "ensaio: PG_CLUSTER_DIR sem MARCADOR_DESCARTAVEL"
  else
    [[ "$CONN" =~ @db\.$REF_PROD\.supabase\.co:5432/ || "$CONN" =~ postgres\.$REF_PROD[:@].*pooler\.supabase\.com:5432/ ]] \
      || falhar "host/porta não são de produção ($REF_PROD, conexão direta ou pooler de SESSÃO 5432)"
  fi
}
# Sessão de leitura: o servidor recusa qualquer escrita.
ler() { PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=60000 -c lock_timeout=2000" PGAPPNAME=pr55-132-136-leitura \
          PGCLIENTENCODING=UTF8 PGCONNECT_TIMEOUT=15 "$PSQL" "$CONN" -X -v ON_ERROR_STOP=1 -tA "$@" 2>&1 | ocultar; }

gerar_pacote() {
  local tmp; tmp="$(mktemp -d)"
  git -C "$RAIZ" archive "$COMMIT" database/migrations backend/testes-seguros/supabase-teste/gerar_pacote.mjs | tar -x -C "$tmp" || falhar "git archive $COMMIT"
  node "$tmp/backend/testes-seguros/supabase-teste/gerar_pacote.mjs" "$tmp/pacote" --transacao > /dev/null || falhar "gerar_pacote"
  local a r; a="$(sha256sum "$tmp/pacote/pacote_aplicar.sql" | cut -d' ' -f1)"; r="$(sha256sum "$tmp/pacote/pacote_reverter.sql" | cut -d' ' -f1)"
  [ "$a" = "$SHA_APLICAR" ] || falhar "SHA-256 do pacote_aplicar = $a (esperado $SHA_APLICAR)"
  [ "$r" = "$SHA_REVERTER" ] || falhar "SHA-256 do pacote_reverter = $r (esperado $SHA_REVERTER)"
  [ "$(tr -cd '\r' < "$tmp/pacote/pacote_aplicar.sql" | wc -c)" = "0" ] || falhar "pacote com \\r"
  cp "$tmp/pacote/pacote_aplicar.sql" "$tmp/pacote/pacote_reverter.sql" "$EVID/"
  echo "pacote OK: $COMMIT aplicar=$a reverter=$r (cópias em $EVID)"
}

prevoo() {
  local f="$EVID/prevoo-$1-$(carimbo).json"
  ler -f "$AQUI/prevoo_prod_132_136.sql" > "$f" || falhar "pré-voo (ver $f)"
  node -e '
    const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const a = p.ausencia_132_136, s = p.sessoes, d = p.dependencias, e = [];
    if (process.argv[2] === "antes") {
      if (a.tabelas.length || a.funcoes.length || a.gatilhos.length || a.colunas.length || a.chave_selecao_por_escopo) e.push("já existe objeto de 132–136");
      if (p.migrations.ja_registradas_132_136) e.push("132–136 já registradas");
      if (!d.agendar_igual_main_104 || !d.resolver_igual_ref || !d.cota_igual_ref || !d.remapear_igual_ref) e.push("função de referência diferente da homologada");
    }
    if (s.idle_in_transaction) e.push("sessão idle in transaction");
    if (s.aguardando_lock) e.push("sessão esperando lock");
    if (s.locks_nas_tabelas_alvo.length && process.argv[2] === "antes") e.push("lock nas tabelas-alvo: " + s.locks_nas_tabelas_alvo.join(","));
    if (s.transacao_mais_longa_s > 60) e.push("transação aberta há " + s.transacao_mais_longa_s + " s");
    if (e.length) { console.error(e.join("; ")); process.exit(1); }
    console.error("pré-voo " + process.argv[2] + " OK: " + p.identidade.versao + ", migrations " + p.migrations.registradas + ", fila " + JSON.stringify(p.d1_linha_de_base.mensagens_por_status));
  ' "$f" "$1" || falhar "portão do pré-voo $1 (ver $f)"
  echo "$f"
}

validar() {
  local f="$EVID/validacao-$(carimbo).json"
  ler -f "$AQUI/validar_pos_prod_132_136.sql" > "$f" || falhar "validação (ver $f)"
  node -e '
    const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const ruins = Object.entries(v).filter(([, x]) => x.ok !== true).map(([k]) => k);
    console.log("validação: " + (Object.keys(v).length - ruins.length) + "/" + Object.keys(v).length + (ruins.length ? " — FALHOU: " + ruins.join(", ") : " ok"));
    process.exit(ruins.length ? 1 : 0);
  ' "$f" || falhar "validação com item ok:false — NÃO reverter automaticamente; seguir o cenário B do doc 17 (ver $f)"
}

comparar() {  # dados antes × depois (o que as migrations NÃO podem mudar)
  node -e '
    const fs = require("fs"); const a = JSON.parse(fs.readFileSync(process.argv[1], "utf8")), b = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const pares = [["unidades.hash_sem_colunas_novas", a.unidades.hash_sem_colunas_novas, b.unidades.hash_sem_colunas_novas],
      ["destinatários", a.d1_linha_de_base.dest_categorias, b.d1_linha_de_base.dest_categorias],
      ["contatos da empresa", a.d1_linha_de_base.contatos_empresa, b.d1_linha_de_base.contatos_empresa],
      ["contatos whatsapp", a.d1_linha_de_base.contatos_whatsapp, b.d1_linha_de_base.contatos_whatsapp],
      ["configurações (sem a chave nova)", a.d1_linha_de_base.configuracoes_hash_sem_chave_nova, b.d1_linha_de_base.configuracoes_hash_sem_chave_nova],
      ["categorias ativas", JSON.stringify(a.d1_linha_de_base.categorias_ativas), JSON.stringify(b.d1_linha_de_base.categorias_ativas)]];
    let ruim = 0; for (const [n, x, y] of pares) { const ok = x === y; ruim += !ok; console.log((ok ? "igual   " : "MUDOU   ") + n); }
    console.log("fila antes " + JSON.stringify(a.d1_linha_de_base.mensagens_por_status) + " | depois " + JSON.stringify(b.d1_linha_de_base.mensagens_por_status) + " (só o worker muda a fila)");
    process.exit(ruim ? 1 : 0);
  ' "$1" "$2" || falhar "dado que as migrations não podem mudar MUDOU — cenário B do doc 17"
}

case "$MODO" in
  pacote) gerar_pacote ;;
  prevoo) travas; prevoo antes > /dev/null && echo "pré-voo somente leitura OK (evidência em $EVID)" ;;
  validar) travas; validar ;;
  aplicar)
    travas
    [ "${PROD_AUTORIZO:-}" = "SIM" ] || falhar "defina PROD_AUTORIZO=SIM (autorização expressa para ESCREVER em produção)"
    [ "${PROD_BACKUP_CONFIRMADO:-}" = "SIM" ] || falhar "defina PROD_BACKUP_CONFIRMADO=SIM (backup do dia conferido no painel)"
    gerar_pacote
    ANTES="$(prevoo antes | tail -1)" || exit 1
    echo "aplicando o pacote (uma transação; statement_timeout 300 s; lock_timeout 5 s por migration)…"
    LOG="$EVID/aplicacao-$(carimbo).log"
    PGOPTIONS="-c statement_timeout=300000" PGAPPNAME=pr55-132-136-aplicacao PGCLIENTENCODING=UTF8 PGCONNECT_TIMEOUT=15 \
      "$PSQL" "$CONN" -X -q -v ON_ERROR_STOP=1 -f "$EVID/pacote_aplicar.sql" > "$LOG" 2>&1
    RC=$?; ocultar < "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
    if [ "$RC" != "0" ]; then
      echo "FALHOU antes do COMMIT (rc=$RC): a transação foi desfeita pelo PostgreSQL. Log: $LOG"
      prevoo antes > /dev/null && echo "conferido: nada de 132–136 ficou; nada registrado (cenário A do doc 17)."
      exit 1
    fi
    echo "COMMIT ok. Validando…"
    validar
    DEPOIS="$(prevoo depois | tail -1)" || exit 1
    comparar "$ANTES" "$DEPOIS"
    echo "APLICADO E VALIDADO. Próximo passo (autorização própria): merge do PR #55. Evidências: $EVID" ;;
  *) echo "uso: bash $0 pacote|prevoo|aplicar|validar"; exit 2 ;;
esac
