// Política de AUTENTICAÇÃO FORTE RECENTE para operações administrativas sensíveis (concessões financeiras).
// Funções PURAS (relógio injetado), sem dependência de env/rede.
//
// Exige, ao mesmo tempo: (1) o JWT em AAL2 e (2) um passo de 2º fator (amr: totp/webauthn/phone/mfa) com
// carimbo de no máximo `janelaMs` atrás. Qualquer dúvida (sem amr, sem timestamp, carimbo no futuro) NEGA.
// O `amr[].timestamp` do JWT do Supabase é em SEGUNDOS — confirmar contra um JWT real (projeto descartável, T3) antes
// de liberar a flag FINANCEIRO_CONCESSOES_HABILITADAS.

export const JANELA_MFA_RECENTE_MS = 10 * 60 * 1000;
const TOLERANCIA_RELOGIO_MS = 60 * 1000;
const METODOS_SEGUNDO_FATOR = new Set(["totp", "webauthn", "phone", "mfa/totp", "mfa/webauthn", "mfa/phone"]);

/**
 * Instante (ms) do 2º fator mais recente declarado em `amr`, ou null.
 * @param {unknown} amr [{method, timestamp(s)}] já parseado do JWT
 * @returns {number|null}
 */
export function carimboDeSegundoFator(amr) {
  if (!Array.isArray(amr)) return null;
  let melhor = null;
  for (const m of amr) {
    if (typeof m !== "object" || m === null || !METODOS_SEGUNDO_FATOR.has(String(m.method))) continue;
    const t = Number(m.timestamp);
    if (Number.isFinite(t) && t > 0 && (melhor === null || t > melhor)) melhor = t;
  }
  return melhor === null ? null : Math.round(melhor * 1000);
}

/**
 * @param {{ aal?: string|null, mfaEm?: number|null }} usuario `req.user`
 * @param {number} [agora]
 * @param {number} [janelaMs]
 * @returns {{ok:true}|{ok:false, codigo:'MFA_REQUERIDA'|'REAUTENTICACAO_RECENTE'}}
 */
export function avaliarMfaRecente(usuario, agora = Date.now(), janelaMs = JANELA_MFA_RECENTE_MS) {
  if (usuario?.aal !== "aal2") return { ok: false, codigo: "MFA_REQUERIDA" };
  const t = usuario?.mfaEm;
  if (!Number.isFinite(t)) return { ok: false, codigo: "REAUTENTICACAO_RECENTE" };
  if (t > agora + TOLERANCIA_RELOGIO_MS) return { ok: false, codigo: "REAUTENTICACAO_RECENTE" }; // carimbo no futuro
  if (agora - t > janelaMs) return { ok: false, codigo: "REAUTENTICACAO_RECENTE" };
  return { ok: true };
}
