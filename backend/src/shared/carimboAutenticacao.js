// Função PURA, sem nenhuma dependência (nem de config/env): usada pela renovação e pelo script de verificação do JWT
// (backend/scripts/verificar-jwt-amr.mjs), que NÃO pode carregar variáveis de ambiente nem segredos.
/**
 * Carimbo da autenticação a partir das claims `amr` de um JWT já PARSEADO ([{method, timestamp}] em segundos).
 * Usa o mais RECENTE (um passo de MFA depois do login conta como autenticação). `null` se não houver.
 * @param {unknown} amr
 * @returns {number|null} ms desde a época
 */
export function carimboDeAutenticacao(amr) {
  if (!Array.isArray(amr)) return null;
  let melhor = null;
  for (const m of amr) {
    const t = typeof m === "object" && m !== null ? Number(m.timestamp) : NaN;
    if (Number.isFinite(t) && t > 0 && (melhor === null || t > melhor)) melhor = t;
  }
  return melhor === null ? null : Math.round(melhor * 1000);
}
