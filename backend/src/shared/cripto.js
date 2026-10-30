// Criptografia simétrica de segredos em repouso (AES-256-GCM).
//
// POR QUE EXISTE
//   A integração Martin Brower nunca guarda token (credencial efêmera, só em
//   memória). A integração oficial do iFood PRECISA persistir access/refresh
//   token entre requisições e entre reinícios do processo — então esses
//   valores têm que ir para o banco CIFRADOS, nunca em texto plano.
//
//   Este é o único lugar do backend que cifra/decifra segredo. Qualquer
//   coluna `*_cifrado` (ver migration 056) passa por aqui.
//
// CHAVE
//   Derivada de IFOOD_TOKEN_SECRET (obrigatória — o backend não sobe sem
//   ela, ver config/env.js) via scrypt com salt fixo. scrypt em vez de um
//   SHA-256 cru encarece um ataque de força bruta sobre o secret.
//
//   Lida de process.env DIRETO (não via config/env.js) e de forma preguiçosa
//   para manter este módulo desacoplado do resto da configuração — assim ele
//   é testável isoladamente, sem exigir as variáveis do Supabase.
//
// FORMATO DO TEXTO CIFRADO
//   "v1:" + base64url(iv) + ":" + base64url(authTag) + ":" + base64url(ciphertext)
//   * v1     -> versão do esquema, permite rotação futura sem ambiguidade;
//   * iv     -> 12 bytes aleatórios por operação (nunca reutilizado);
//   * authTag-> 16 bytes, garante integridade (decifrar falha se adulterado).
//
// NUNCA logue a entrada nem a saída destas funções.

import crypto from "node:crypto";

const VERSAO = "v1";
const ALGORITMO = "aes-256-gcm";
const IV_BYTES = 12;
const SALT = "crescer:ifood:token:v1"; // fixo de propósito — a entropia vem do secret
const MIN_SECRET_LEN = 16;

let chaveCache = null;

/** Deriva (uma vez) a chave de 32 bytes a partir de IFOOD_TOKEN_SECRET. */
function obterChave() {
  if (chaveCache) return chaveCache;
  const secret = process.env.IFOOD_TOKEN_SECRET;
  if (!secret || secret.length < MIN_SECRET_LEN) {
    throw new Error(
      `IFOOD_TOKEN_SECRET ausente ou curta demais (mínimo ${MIN_SECRET_LEN} caracteres). ` +
      "Defina a variável de ambiente antes de usar a integração iFood.",
    );
  }
  chaveCache = crypto.scryptSync(secret, SALT, 32);
  return chaveCache;
}

const b64u = (buf) => buf.toString("base64url");
const deB64u = (str) => Buffer.from(str, "base64url");

/**
 * Cifra um segredo. `null`/`undefined`/`""` passam direto como `null` — o
 * refreshToken do iFood pode legitimamente não vir na resposta.
 * @param {string|null|undefined} texto
 * @returns {string|null} texto cifrado no formato "v1:iv:tag:ct", ou null
 */
export function cifrar(texto) {
  if (texto == null || texto === "") return null;
  if (typeof texto !== "string") throw new TypeError("cifrar() espera string.");

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITMO, obterChave(), iv);
  const ct = Buffer.concat([cipher.update(texto, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSAO}:${b64u(iv)}:${b64u(tag)}:${b64u(ct)}`;
}

/**
 * Decifra um valor produzido por `cifrar`. `null`/`undefined`/`""` -> `null`.
 * Lança se o formato for inválido ou o dado tiver sido adulterado.
 * @param {string|null|undefined} cifrado
 * @returns {string|null}
 */
export function decifrar(cifrado) {
  if (cifrado == null || cifrado === "") return null;
  if (typeof cifrado !== "string") throw new TypeError("decifrar() espera string.");

  const partes = cifrado.split(":");
  if (partes.length !== 4 || partes[0] !== VERSAO) {
    throw new Error("Texto cifrado em formato inválido ou versão não suportada.");
  }
  const [, ivB64, tagB64, ctB64] = partes;

  const decipher = crypto.createDecipheriv(ALGORITMO, obterChave(), deB64u(ivB64));
  decipher.setAuthTag(deB64u(tagB64));
  const pt = Buffer.concat([decipher.update(deB64u(ctB64)), decipher.final()]);
  return pt.toString("utf8");
}

/**
 * Mascara um identificador para exibição/log — mostra só o início e o fim.
 * "550e8400-e29b-41d4-a716-446655440000" -> "550e****0000".
 * Usado para merchantId em respostas de API e logs (nunca o valor completo).
 * @param {string|null|undefined} valor
 * @returns {string|null}
 */
export function mascarar(valor) {
  const s = String(valor ?? "");
  if (!s) return null;
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

/** Reseta o cache da chave (uso exclusivo de teste, ao trocar o secret). */
export function _resetarChaveCache() {
  chaveCache = null;
}

/**
 * Cifra autenticada GENÉRICA (AES-256-GCM) com chave própria e AAD — para domínios que não são o iFood (ex.: números de
 * notificação, D-4). Não toca `cifrar`/`decifrar` acima (iFood). Formato: "k<versao>:iv:tag:ct". O AAD amarra o texto cifrado
 * ao seu uso (ex.: "telefone"): um valor cifrado para um campo não decifra em outro.
 * @param {Buffer} chave 32 bytes
 * @param {{ versao?: number }} [opcoes]
 */
export function criarCifraAutenticada(chave, { versao = 1 } = {}) {
  if (!Buffer.isBuffer(chave) || chave.length !== 32) throw new TypeError("criarCifraAutenticada: chave de 32 bytes obrigatória.");
  const prefixo = `k${versao}`;
  return {
    versao,
    cifrar(texto, aad) {
      if (typeof texto !== "string" || !texto) throw new TypeError("cifrar: texto obrigatório.");
      if (typeof aad !== "string" || !aad) throw new TypeError("cifrar: AAD obrigatório.");
      const iv = crypto.randomBytes(IV_BYTES);
      const c = crypto.createCipheriv(ALGORITMO, chave, iv);
      c.setAAD(Buffer.from(aad, "utf8"));
      const ct = Buffer.concat([c.update(texto, "utf8"), c.final()]);
      return `${prefixo}:${b64u(iv)}:${b64u(c.getAuthTag())}:${b64u(ct)}`;
    },
    decifrar(cifrado, aad) {
      const partes = String(cifrado ?? "").split(":");
      if (partes.length !== 4 || partes[0] !== prefixo) throw new Error("Texto cifrado em formato inválido ou versão de chave diferente.");
      const d = crypto.createDecipheriv(ALGORITMO, chave, deB64u(partes[1]));
      d.setAAD(Buffer.from(aad, "utf8"));
      d.setAuthTag(deB64u(partes[2]));
      return Buffer.concat([d.update(deB64u(partes[3])), d.final()]).toString("utf8");
    },
  };
}
