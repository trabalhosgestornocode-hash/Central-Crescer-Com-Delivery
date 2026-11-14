// CANAL AUTENTICADO entre o backend da plataforma e o GATEWAY DE AUTORIDADE do Financeiro v2 (Execução 10).
//
// O gateway é um serviço SEPARADO, o único com a credencial `fv2_autoridade` do banco. O backend comum nunca a vê: ele só
// PEDE sessões de banco ao gateway, por HTTP, assinando cada pedido com uma chave própria deste canal (HMAC-SHA256 sobre
// método, caminho, instante, nonce e corpo). O gateway recusa: assinatura errada, instante fora de ±60 s e nonce repetido.
// A chave do canal NÃO é a credencial do banco: vazá-la não dá acesso aos dados (o gateway ainda confere, no provedor de
// identidade, o token do próprio usuário e o banco ainda exige concessão ativa).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const CABECALHO = Object.freeze({ INSTANTE: "x-fv2-instante", NONCE: "x-fv2-nonce", ASSINATURA: "x-fv2-assinatura", TOKEN: "x-fv2-token-usuario" });
export const TOLERANCIA_CANAL_MS = 60 * 1000;
const CHAVE_MINIMA = 32;

export function exigirChaveDoCanal(chave) {
  if (typeof chave !== "string" || chave.length < CHAVE_MINIMA) throw new Error("Financeiro v2: chave do canal com o gateway ausente ou curta (mínimo 32 caracteres).");
  return chave;
}

const base = ({ metodo, caminho, instante, nonce, corpo }) => `${metodo.toUpperCase()}\n${caminho}\n${instante}\n${nonce}\n${corpo}`;
const hmac = (chave, texto) => createHmac("sha256", chave).update(texto).digest("hex");

/** Cabeçalhos de um pedido assinado (o token do usuário vai em cabeçalho próprio e NÃO entra em log). */
export function assinarPedido({ chave, metodo = "POST", caminho, corpo, agoraMs = Date.now() }) {
  exigirChaveDoCanal(chave);
  const instante = String(agoraMs);
  const nonce = randomBytes(16).toString("hex");
  return { [CABECALHO.INSTANTE]: instante, [CABECALHO.NONCE]: nonce, [CABECALHO.ASSINATURA]: hmac(chave, base({ metodo, caminho, instante, nonce, corpo })) };
}

/**
 * Conferência no GATEWAY. `noncesVistos` é um Map nonce → expiraEm (o chamador o mantém e limpa).
 * @returns {{ok:true}|{ok:false, motivo:string}}
 */
export function conferirPedido({ chave, metodo, caminho, corpo, cabecalhos, agoraMs = Date.now(), noncesVistos }) {
  const instante = Number(cabecalhos?.[CABECALHO.INSTANTE]);
  const nonce = String(cabecalhos?.[CABECALHO.NONCE] ?? "");
  const recebida = String(cabecalhos?.[CABECALHO.ASSINATURA] ?? "");
  if (!Number.isFinite(instante) || Math.abs(agoraMs - instante) > TOLERANCIA_CANAL_MS) return { ok: false, motivo: "CANAL_INSTANTE_FORA_DA_JANELA" };
  if (!/^[0-9a-f]{32}$/.test(nonce)) return { ok: false, motivo: "CANAL_NONCE_INVALIDO" };
  const esperada = Buffer.from(hmac(chave, base({ metodo, caminho, instante: String(instante), nonce, corpo })), "hex");
  const dada = /^[0-9a-f]{64}$/.test(recebida) ? Buffer.from(recebida, "hex") : Buffer.alloc(0);
  if (dada.length !== esperada.length || !timingSafeEqual(dada, esperada)) return { ok: false, motivo: "CANAL_ASSINATURA_INVALIDA" };
  if (noncesVistos.has(nonce)) return { ok: false, motivo: "CANAL_NONCE_REPETIDO" };
  noncesVistos.set(nonce, agoraMs + 2 * TOLERANCIA_CANAL_MS);
  for (const [n, vence] of noncesVistos) if (vence < agoraMs) noncesVistos.delete(n);
  return { ok: true };
}
