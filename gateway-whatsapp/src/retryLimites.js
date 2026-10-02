// Limites do cache de retry (src/retryCache.js) — módulo SEM dependências para que src/config.js valide as envs no boot
// sem carregar o Baileys. As mesmas faixas são impostas pelas CHECKs/funções da migration 105 no lado do banco.
// Justificativa dos valores: docs/whatsapp-retry-resend.md (seção TTL).
export const RETRY_TTL_PADRAO_HORAS = 168; // 7 dias
export const RETRY_TTL_MIN_HORAS = 1;
export const RETRY_TTL_MAX_HORAS = 720; // 30 dias
export const RETRY_MAX_REENVIOS_PADRAO = 15; // 5 por aparelho (maxMsgRetryCount do Baileys) × ~3 aparelhos
export const RETRY_MAX_REENVIOS_TETO = 50;
