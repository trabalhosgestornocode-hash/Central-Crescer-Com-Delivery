#!/bin/bash
# Gera o NOTIFICACOES_SEGREDO_MESTRE (48 bytes aleatórios do CSPRNG do sistema, base64url ≈ 64 caracteres) SEM exibi-lo.
#   * Guarda uma cópia CIFRADA com `age` (chave PÚBLICA do responsável) fora do Git e do OneDrive;
#   * copia o valor em claro SÓ para a área de transferência (para colar no campo de variável do Render) e a limpa em CLIP_SEGUNDOS;
#   * nunca imprime o valor, nunca grava em claro, nunca reutiliza IFOOD_TOKEN_SECRET (valor novo a cada execução).
# Recusa sobrescrever: se já existir uma cópia cifrada do segredo, para (NÃO substituir um segredo que já cifrou dados).
#
#   bash gerar_segredo_notificacoes.sh            -> gera, cifra, copia para a área de transferência
# Depois: colar no Render (Environment → NOTIFICACOES_SEGREDO_MESTRE) e conferir pelo comprimento, nunca pelo valor.
set -uo pipefail
DIR="${BACKUP_DIR:-$HOME/backups-prod/pr55-132-136}"
SAIDA="$DIR/NOTIFICACOES_SEGREDO_MESTRE.age"
CLIP_SEGUNDOS="${CLIP_SEGUNDOS:-120}"
falhar() { echo "PARADO: $*" >&2; exit 1; }
command -v age >/dev/null || falhar "age não encontrado"
[ -f "$DIR/destinatario.agepub" ] || falhar "sem $DIR/destinatario.agepub (chave pública do responsável)"
[ ! -e "$SAIDA" ] || falhar "já existe $SAIDA — não vou gerar outro segredo por cima (rotacionar exige decisão: convites cifrados ficariam ilegíveis)"
VALOR="$(head -c 48 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
[ "${#VALOR}" -ge 48 ] || falhar "valor gerado curto demais (${#VALOR})"
printf '%s' "$VALOR" | age -R "$DIR/destinatario.agepub" -o "$SAIDA" || falhar "falha ao cifrar a cópia"
[ -s "$SAIDA" ] || falhar "cópia cifrada vazia"
printf '%s' "$VALOR" | clip.exe 2>/dev/null || powershell.exe -NoProfile -Command "Set-Clipboard -Value '$VALOR'" || falhar "não consegui usar a área de transferência"
echo "OK: segredo gerado (${#VALOR} caracteres). Cópia cifrada: $SAIDA ($(wc -c < "$SAIDA") bytes, sha256=$(sha256sum "$SAIDA" | cut -c1-16)…)."
echo "O valor está SÓ na área de transferência; será limpa em ${CLIP_SEGUNDOS}s."
( sleep "$CLIP_SEGUNDOS"; printf '' | clip.exe 2>/dev/null ) >/dev/null 2>&1 &
unset VALOR
