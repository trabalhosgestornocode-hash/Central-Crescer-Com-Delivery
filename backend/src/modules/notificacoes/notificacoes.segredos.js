// Segredos da Central de Notificações (D-4). ÚNICO lugar que conhece as chaves.
//
// Uma env própria — NOTIFICACOES_SEGREDO_MESTRE (≥ 32 caracteres), separada de IFOOD_TOKEN_SECRET — e três subchaves
// derivadas por HKDF-SHA256 (domínios separados): cifra (AES-256-GCM dos números e e-mails), HMAC de identificação
// (busca/dedupe sem o valor em claro) e HMAC de OTP (o código nunca é guardado). Sem a env, a Central fica DESLIGADA
// (fail-closed): nenhuma rota de escrita funciona — nada é guardado em claro "provisoriamente".
//
// DESCRIPTOGRAFIA: só `decifrarTelefone`/`decifrarEmail`, chamados por notificacoes.envio.js (transporte do OTP) e pelos
// formulários de edição de quem tem `gerenciar` — teste arquitetural em test/notificacoes-arquitetura.test.js.
// NUNCA logue a entrada nem a saída destas funções.
import crypto from "node:crypto";
import { criarCifraAutenticada } from "../../shared/cripto.js";

const MIN = 32;
const VERSAO_CHAVE = 1;
let cache = null;

function chaves() {
  if (cache) return cache;
  const mestre = process.env.NOTIFICACOES_SEGREDO_MESTRE;
  if (!mestre || mestre.length < MIN) {
    const e = new Error("Central de Notificações indisponível neste ambiente (segredo não configurado).");
    e.codigo = "NOTIFICACOES_SEM_SEGREDO";
    throw e;
  }
  const derivar = (info) => Buffer.from(crypto.hkdfSync("sha256", Buffer.from(mestre, "utf8"), Buffer.from("crescer:notificacoes:v1", "utf8"), Buffer.from(info, "utf8"), 32));
  cache = {
    cifra: criarCifraAutenticada(derivar("cifra"), { versao: VERSAO_CHAVE }),
    hmacId: derivar("hmac-identificacao"),
    hmacOtp: derivar("hmac-otp"),
  };
  return cache;
}

/** A Central pode operar (segredo configurado)? Nunca lança. */
export function segredosDisponiveis() {
  try { chaves(); return true; } catch { return false; }
}

const hmac = (chave, texto) => crypto.createHmac("sha256", chave).update(String(texto), "utf8").digest("hex");

export const VERSAO_CHAVE_ATUAL = VERSAO_CHAVE;
export const cifrarTelefone = (e164) => chaves().cifra.cifrar(e164, "telefone");
export const decifrarTelefone = (cifrado) => chaves().cifra.decifrar(cifrado, "telefone");
export const cifrarEmail = (email) => chaves().cifra.cifrar(email, "email");
export const decifrarEmail = (cifrado) => chaves().cifra.decifrar(cifrado, "email");
/** HMAC do E.164 normalizado — identifica o número para dedupe, limites e livro-razão sem guardá-lo em claro. */
export const hmacTelefone = (e164) => hmac(chaves().hmacId, `tel:${e164}`);
export const hmacEmail = (email) => hmac(chaves().hmacId, `email:${String(email).trim().toLowerCase()}`);
export const hmacIp = (ip) => (ip ? hmac(chaves().hmacId, `ip:${ip}`) : null);
/** HMAC do código ligado ao desafio: o mesmo código em outro desafio dá outro valor (sem reaproveitamento). */
export const hmacCodigo = (desafioId, codigo) => hmac(chaves().hmacOtp, `${desafioId}:${codigo}`);

/** Comparação em tempo constante de dois hex de mesmo tamanho. */
export function compararSeguro(a, b) {
  const x = Buffer.from(String(a ?? ""), "utf8");
  const y = Buffer.from(String(b ?? ""), "utf8");
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** Só testes: zera o cache ao trocar a env. */
export function _resetarSegredos() { cache = null; }
