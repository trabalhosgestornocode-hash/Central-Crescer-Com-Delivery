// Peças puras da Central de Notificações: telefone, OTP, tokens, prazos e saneamento de log. Sem I/O.
import crypto from "node:crypto";
import { normalizarTelefone, mascararTelefone } from "../comunicacao/comunicacao.contatos.repo.js";

export const OTP = Object.freeze({ DIGITOS: 6, VALIDADE_MS: 5 * 60_000, MAX_TENTATIVAS: 5, REENVIO_MS: 60_000, JANELA_POS_VERIFICACAO_MS: 15 * 60_000 });
export const CONVITE_VALIDADE_MS = 72 * 3_600_000;
export const SESSAO_GESTAO_MS = 15 * 60_000;

const E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * Normaliza e VALIDA um WhatsApp internacional. Aceita o formato nacional brasileiro (10–11 dígitos) — a mesma regra do
 * cadastro atual (`normalizarTelefone`) —; qualquer outro precisa vir com "+DDI". Celular brasileiro: 11 dígitos começando
 * com 9 depois do DDD. Devolve null quando inválido (nunca "corrige" um número ambíguo).
 */
export function validarWhatsapp(bruto) {
  const e164 = normalizarTelefone(bruto);
  if (!e164 || !E164.test(e164)) return null;
  if (e164.startsWith("+55")) {
    const nac = e164.slice(3);
    if (nac.length !== 11 || nac[2] !== "9" || /^0/.test(nac)) return null;
  }
  return e164;
}

export const mascarar = (e164) => mascararTelefone(e164);

/** Código numérico de 6 dígitos por CSPRNG (zeros à esquerda preservados). */
export const gerarCodigoOtp = () => String(crypto.randomInt(0, 10 ** OTP.DIGITOS)).padStart(OTP.DIGITOS, "0");
/** Token de link (32 bytes, base64url) e o seu SHA-256 (o que vai ao banco). */
export const gerarToken = () => crypto.randomBytes(32).toString("base64url");
export const hashToken = (token) => crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
export const tokenValido = (token) => typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
export const codigoValido = (codigo) => typeof codigo === "string" && /^[0-9]{6}$/.test(codigo);

// ---------------------------------------------------------------------------------------------------------------------------
// Log seguro: nada de número completo, código OTP, token ou segredo — nem por engano
// ---------------------------------------------------------------------------------------------------------------------------
const CHAVES_PROIBIDAS = /telefone|phone|e164|codigo|code|otp|token|segredo|secret|senha|password|email|cifrad/i;
const RE_TELEFONE = /\+?\d[\d\s().-]{9,}\d/g;

/** Devolve uma cópia rasa sem chaves sensíveis e com qualquer sequência telefônica mascarada. */
export function sanitizarParaLog(obj) {
  if (obj == null || typeof obj !== "object") return typeof obj === "string" ? obj.replace(RE_TELEFONE, "[número]") : obj;
  const saida = {};
  for (const [k, v] of Object.entries(obj)) {
    if (CHAVES_PROIBIDAS.test(k)) { saida[k] = "[omitido]"; continue; }
    saida[k] = typeof v === "string" ? v.replace(RE_TELEFONE, "[número]") : (v && typeof v === "object" ? "[objeto]" : v);
  }
  return saida;
}

/** Log estruturado da Central (sempre sanitizado). */
export function logNotificacoes(nivel, evento, dados = {}) {
  const linha = { origem: "notificacoes", evento, ...sanitizarParaLog(dados) };
  (nivel === "error" ? console.error : nivel === "warn" ? console.warn : console.log)(JSON.stringify(linha));
}
