// Tokens de acesso SINTÉTICOS (formato do provedor de identidade: JWT com sub, aal, amr[{method, timestamp(s)}], iat,
// exp, session_id), assinados com um segredo de TESTE. Nunca é a chave de nenhum projeto real.
import { createHmac } from "node:crypto";

export const SEGREDO_SINTETICO = "segredo-sintetico-de-teste-09b-nao-e-de-nenhum-projeto";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

export function assinar(payload, { segredo = SEGREDO_SINTETICO, alg = "HS256" } = {}) {
  const cab = b64({ alg, typ: "JWT" });
  const corpo = b64(payload);
  return `${cab}.${corpo}.${createHmac("sha256", segredo).update(`${cab}.${corpo}`).digest("base64url")}`;
}

/**
 * @param {object} o
 * @param {number} o.agoraMs
 * @param {string} o.conta  `sub`
 * @param {string} [o.aal] padrão aal2
 * @param {string|null} [o.metodo] método do segundo fator (null = só senha)
 * @param {number} [o.fatorHaS] há quantos segundos o fator foi usado (padrão 60)
 * @param {number} [o.iatHaS] há quantos segundos o token foi emitido (padrão 30)
 * @param {number} [o.expEmS] expira em (padrão 3600)
 * @param {boolean} [o.carimboEmMs] grava o carimbo em milissegundos (formato ERRADO, deve ser recusado)
 */
export function tokenSintetico({ agoraMs, conta, aal = "aal2", metodo = "totp", fatorHaS = 60, iatHaS = 30, expEmS = 3600, carimboEmMs = false, segredo, extra = {} }) {
  const s = Math.floor(agoraMs / 1000);
  const amr = [{ method: "password", timestamp: s - 3600 }];
  if (metodo) amr.push({ method: metodo, timestamp: carimboEmMs ? (s - fatorHaS) * 1000 : s - fatorHaS });
  return assinar({ sub: conta, aal, amr, iat: s - iatHaS, exp: s + expEmS, session_id: "sessao-do-provedor-sintetica", ...extra }, segredo ? { segredo } : {});
}
