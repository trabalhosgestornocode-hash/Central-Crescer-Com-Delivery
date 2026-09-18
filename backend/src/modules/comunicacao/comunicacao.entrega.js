// Semântica de ENTREGA — separado do Policy Engine de propósito: aquele
// decide se um envio pode SAIR; este decide o que fazer com o RESULTADO de
// uma tentativa que já saiu (ou tentou sair). Função pura, sem I/O.
//
// IDEMPOTÊNCIA ≠ EXACTLY-ONCE EXTERNO (documentado explicitamente, pedido
// do Checkpoint B.1): a UNIQUE de idempotency_key + o claim atômico
// garantem um único JOB LÓGICO em comunicacao_mensagens — nunca duas
// linhas para o mesmo alerta. Isso NÃO garante uma única ENTREGA FÍSICA no
// WhatsApp quando existir um provider externo: se `sendMessage()` for
// aceito pelo provider e o processo cair ANTES de gravarmos SENT, o job
// lógico continua único, mas não sabemos se a mensagem física já saiu.
// Reenviar cegamente nesse caso duplicaria a entrega REAL, mesmo sem
// duplicar a linha no banco. `classificarErroEnvio` existe exatamente para
// impedir isso: erros SEM marcação explícita de "aconteceu antes do efeito
// externo" são tratados como INCERTOS, nunca como retryáveis.

import { CLASSIFICACAO_ERRO } from "./comunicacao.constants.js";

/**
 * @typedef {Error & {preEnvio?: boolean, permanente?: boolean}} ErroEnvio
 *   `preEnvio: true`   — o provider GARANTE que nada saiu (ex.: recusou a
 *                        conexão antes de tentar a chamada real).
 *   `permanente: true` — o provider disse, de forma definitiva, que isto
 *                        nunca vai funcionar (ex.: número inválido) — é uma
 *                        resposta CONHECIDA, não uma ambiguidade.
 *   nem um nem outro    — timeout, conexão caiu no meio, processo morreu:
 *                        não sabemos se o WhatsApp recebeu. INCERTO.
 */

/**
 * @param {ErroEnvio} erro
 * @returns {'RETRYAVEL'|'PERMANENTE'|'INCERTO'}
 */
export function classificarErroEnvio(erro) {
  if (erro?.preEnvio === true) {
    return erro?.permanente === true ? CLASSIFICACAO_ERRO.PERMANENTE : CLASSIFICACAO_ERRO.RETRYAVEL;
  }
  if (erro?.permanente === true) {
    // Não é pré-envio, mas é uma resposta CONHECIDA e definitiva do
    // provider (não uma ambiguidade) — ex.: "número não existe no
    // WhatsApp", devolvido depois de uma tentativa real. Falhou de forma
    // clara; não é "não sei".
    return CLASSIFICACAO_ERRO.PERMANENTE;
  }
  return CLASSIFICACAO_ERRO.INCERTO;
}

/**
 * Este resultado de classificação permite retry automático (respeitando
 * cooldown/janela/etc. do Policy Engine)? Só RETRYAVEL. PERMANENTE termina
 * em FAILED; INCERTO termina em DELIVERY_UNKNOWN — nenhum dos dois volta
 * sozinho para SCHEDULED.
 * @param {'RETRYAVEL'|'PERMANENTE'|'INCERTO'} classificacao
 */
export function permiteRetryAutomatico(classificacao) {
  return classificacao === CLASSIFICACAO_ERRO.RETRYAVEL;
}

/**
 * Backoff exponencial (em segundos) para um retry de falha PRÉ-ENVIO
 * comprovada — `tentativas` é o número da tentativa que acabou de falhar
 * (1 = primeira). Função pura; o teto evita esperas absurdas.
 * @param {number} tentativas
 * @param {{baseSegundos?: number, maxSegundos?: number}} [opts]
 */
export function backoffRetrySegundos(tentativas, { baseSegundos = 30, maxSegundos = 1800 } = {}) {
  const n = Math.max(1, Number.isFinite(tentativas) ? Math.floor(tentativas) : 1);
  return Math.min(maxSegundos, baseSegundos * 2 ** (n - 1));
}
