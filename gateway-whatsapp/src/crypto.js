// Cifra do auth state do Baileys — ANTES de sair deste processo pela rede.
//
// O backend armazena só o ciphertext (whatsapp_conexoes.auth_state_encrypted)
// e NUNCA recebe a chave de decifra. Um comprometimento isolado do backend
// não basta para sequestrar a sessão WhatsApp; é preciso comprometer também
// este processo (onde a chave mora).
//
// AES-256-GCM via `crypto` nativo do Node — nenhuma dependência nova.
// Formato versionado (permite trocar de esquema/chave sem quebrar linhas
// antigas — a versão fica em auth_state_version, ao lado do blob):
//
//   v1:<iv base64>:<authTag base64>:<ciphertext base64>
//
// A chave (WHATSAPP_AUTH_ENCRYPTION_KEY) é DIFERENTE do segredo HMAC —
// domínios de falha distintos: vazar o segredo HMAC permite forjar
// requisições; vazar esta chave permite decifrar um auth state já roubado.
// Não derive uma da outra.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const VERSAO_FORMATO = "v1";
const ALGORITMO = "aes-256-gcm";
const TAMANHO_IV = 12; // 96 bits, o recomendado para GCM
const TAMANHO_CHAVE = 32; // 256 bits

/**
 * Aceita a chave em base64 OU hex (a que vier no env). Falha alto e cedo se
 * o tamanho final não for exatamente 32 bytes — uma chave errada aqui não
 * pode silenciosamente virar "cifra fraca".
 */
export function normalizarChave(chaveEnv) {
  if (!chaveEnv || typeof chaveEnv !== "string") {
    throw new Error("WHATSAPP_AUTH_ENCRYPTION_KEY ausente ou inválida.");
  }
  const candidatos = [
    () => Buffer.from(chaveEnv, "base64"),
    () => Buffer.from(chaveEnv, "hex"),
  ];
  for (const gerar of candidatos) {
    let buf;
    try { buf = gerar(); } catch { continue; }
    if (buf.length === TAMANHO_CHAVE) return buf;
  }
  throw new Error(
    `WHATSAPP_AUTH_ENCRYPTION_KEY precisa decodificar para exatamente ${TAMANHO_CHAVE} bytes `
    + "(base64 ou hex). Gere com: openssl rand -base64 32",
  );
}

/** @param {string} plaintext @param {Buffer} chave @returns {string} formato versionado */
export function encriptar(plaintext, chave) {
  const iv = randomBytes(TAMANHO_IV);
  const cipher = createCipheriv(ALGORITMO, chave, iv);
  const parte1 = cipher.update(String(plaintext), "utf8");
  const parte2 = cipher.final();
  const ciphertext = Buffer.concat([parte1, parte2]);
  const authTag = cipher.getAuthTag();
  return [VERSAO_FORMATO, iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

/**
 * @param {string} formatado formato versionado (`v1:iv:authTag:ciphertext`)
 * @param {Buffer} chave
 * @returns {string} plaintext
 * @throws {Error} se a versão for desconhecida, o formato malformado, ou a
 *   auth tag não bater (corpo adulterado ou chave errada) — GCM garante que
 *   isso lança, nunca devolve um plaintext incorreto silenciosamente.
 */
export function decriptar(formatado, chave) {
  if (typeof formatado !== "string") throw new Error("Formato de auth state inválido (não é string).");
  const partes = formatado.split(":");
  if (partes.length !== 4) throw new Error("Formato de auth state malformado (esperado 4 segmentos).");
  const [versao, ivB64, authTagB64, ciphertextB64] = partes;
  if (versao !== VERSAO_FORMATO) throw new Error(`Versão de auth state desconhecida: ${versao}`);

  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  if (iv.length !== TAMANHO_IV) throw new Error("IV com tamanho inválido.");

  const decipher = createDecipheriv(ALGORITMO, chave, iv);
  decipher.setAuthTag(authTag);
  const parte1 = decipher.update(ciphertext);
  const parte2 = decipher.final(); // lança se a auth tag não bater
  return Buffer.concat([parte1, parte2]).toString("utf8");
}
