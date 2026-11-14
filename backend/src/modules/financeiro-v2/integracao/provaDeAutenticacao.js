// PROVA DE AUTENTICAÇÃO FORTE (Execução 09B) — o Financeiro v2 não confia em `aal`/`mfaEm` já prontos: deriva a prova
// do PRÓPRIO token de acesso do provedor de identidade, verificado por uma porta `verificarAssinatura` (no servidor).
//
// O que conta como prova de segundo fator RECENTE para a conta X:
//   1. assinatura válida do provedor (porta) — nada montado pelo navegador ou pela aplicação passa;
//   2. token não expirado e emitido no passado (iat ≤ agora + tolerância);
//   3. `sub` = X (o fator é da conta que está agindo — troca de identidade é recusada);
//   4. `aal` = "aal2";
//   5. `amr` contém um método de SEGUNDO FATOR (totp/webauthn/phone) com carimbo numérico em SEGUNDOS, coerente
//      (carimbo ≤ iat + tolerância e ≤ agora + tolerância) e dentro da janela (10 min). Senha, link mágico, OTP por
//      e-mail e o PIN operacional da plataforma NÃO são segundo fator.
// Qualquer dúvida → recusa. A unidade do carimbo (segundos) segue a especificação do provedor e PRECISA ser confirmada
// contra um token real num projeto descartável antes do uso (doc 23, § 4).
import { createHmac, timingSafeEqual } from "node:crypto";

export const JANELA_SEGUNDO_FATOR_MS = 10 * 60 * 1000;
const TOLERANCIA_MS = 60 * 1000;
/** Métodos aceitos como segundo fator (formato do provedor). PIN, senha, e-mail e link mágico ficam de fora. */
export const METODOS_DE_SEGUNDO_FATOR = Object.freeze(["totp", "webauthn", "phone", "mfa/totp", "mfa/webauthn", "mfa/phone"]);

export const MOTIVO_PROVA = Object.freeze({
  SEM_TOKEN: "MFA_SEM_TOKEN",
  ASSINATURA_INVALIDA: "MFA_ASSINATURA_INVALIDA",
  TOKEN_EXPIRADO: "MFA_TOKEN_EXPIRADO",
  OUTRA_CONTA: "MFA_DE_OUTRA_CONTA",
  SEM_AAL2: "MFA_REQUERIDA",
  SEM_FATOR: "MFA_SEM_SEGUNDO_FATOR",
  CARIMBO_INCOERENTE: "MFA_CARIMBO_INCOERENTE",
  ANTIGA: "REAUTENTICACAO_RECENTE",
  INDISPONIVEL: "MFA_INDISPONIVEL",
});

const b64 = (s) => Buffer.from(s, "base64url");

/**
 * Verificador HS256 de REFERÊNCIA (testes locais e provedores que assinam com segredo compartilhado). Em produção, a
 * porta deve usar a chave de assinatura real do provedor (ex.: JWKS) ou a validação do próprio provedor — nunca um
 * segredo exposto à aplicação comum. Devolve o payload só se a assinatura conferir; nunca lança.
 * @param {string} segredo
 */
export function verificadorHs256(segredo) {
  if (typeof segredo !== "string" || segredo.length < 32) throw new Error("Segredo de verificação ausente ou curto.");
  return (token) => {
    try {
      const partes = String(token ?? "").split(".");
      if (partes.length !== 3) return null;
      const cab = JSON.parse(b64(partes[0]).toString("utf8"));
      if (cab?.alg !== "HS256") return null; // "none" e trocas de algoritmo são recusadas
      const esperada = createHmac("sha256", segredo).update(`${partes[0]}.${partes[1]}`).digest();
      const recebida = b64(partes[2]);
      if (recebida.length !== esperada.length || !timingSafeEqual(recebida, esperada)) return null;
      return JSON.parse(b64(partes[1]).toString("utf8"));
    } catch {
      return null;
    }
  };
}

/**
 * @param {object} p
 * @param {(token: string) => (object|null|Promise<object|null>)} p.verificarAssinatura payload SÓ se o token for autêntico
 * @param {() => Date} [p.relogio]
 */
export function criarVerificadorDeMfa({ verificarAssinatura, relogio = () => new Date(), janelaMs = JANELA_SEGUNDO_FATOR_MS }) {
  if (typeof verificarAssinatura !== "function") throw new Error("O verificador de MFA exige a porta de verificação de assinatura.");
  return Object.freeze({
    /**
     * @param {{tokenDeAcesso: string, contaId: string}} e
     * @returns {Promise<{ok:true, contaId:string, segundoFatorEm:number, metodo:string, sessaoDoProvedor:string|null}|{ok:false, motivo:string}>}
     */
    async provar({ tokenDeAcesso, contaId }) {
      if (typeof tokenDeAcesso !== "string" || !tokenDeAcesso) return { ok: false, motivo: MOTIVO_PROVA.SEM_TOKEN };
      let p = null;
      try { p = await verificarAssinatura(tokenDeAcesso); } catch { p = null; }
      if (!p || typeof p !== "object") return { ok: false, motivo: MOTIVO_PROVA.ASSINATURA_INVALIDA };
      const agora = relogio().getTime();
      if (!Number.isFinite(p.exp) || p.exp * 1000 <= agora) return { ok: false, motivo: MOTIVO_PROVA.TOKEN_EXPIRADO };
      if (!Number.isFinite(p.iat) || p.iat * 1000 > agora + TOLERANCIA_MS) return { ok: false, motivo: MOTIVO_PROVA.CARIMBO_INCOERENTE };
      if (typeof p.sub !== "string" || p.sub.toLowerCase() !== String(contaId ?? "").toLowerCase()) return { ok: false, motivo: MOTIVO_PROVA.OUTRA_CONTA };
      if (p.aal !== "aal2") return { ok: false, motivo: MOTIVO_PROVA.SEM_AAL2 };
      const fatores = (Array.isArray(p.amr) ? p.amr : []).filter((m) => m && typeof m === "object" && METODOS_DE_SEGUNDO_FATOR.includes(String(m.method)));
      if (!fatores.length) return { ok: false, motivo: MOTIVO_PROVA.SEM_FATOR };
      const t = Math.max(...fatores.map((m) => Number(m.timestamp)));
      // Carimbo em SEGUNDOS: em milissegundos ele cairia no "futuro" e é recusado (não há conversão adivinhada).
      if (!Number.isFinite(t) || t <= 0 || t * 1000 > agora + TOLERANCIA_MS || t > p.iat + TOLERANCIA_MS / 1000) return { ok: false, motivo: MOTIVO_PROVA.CARIMBO_INCOERENTE };
      if (agora - t * 1000 > janelaMs) return { ok: false, motivo: MOTIVO_PROVA.ANTIGA };
      const metodo = String(fatores.find((m) => Number(m.timestamp) === t).method);
      return { ok: true, contaId: p.sub.toLowerCase(), segundoFatorEm: t * 1000, metodo, sessaoDoProvedor: typeof p.session_id === "string" ? p.session_id : null };
    },
  });
}
