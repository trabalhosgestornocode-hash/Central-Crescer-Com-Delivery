// Autenticação servidor-servidor por HMAC — Gateway <-> Backend Crescer.
//
// MESMO algoritmo já validado em produção por
// worker-martinbrower/src/auth.middleware.js (e no lado cliente, backend/src/
// modules/martinbrower/martinbrower.remote.worker.js). Reimplementado aqui
// como cópia independente, de propósito: os dois processos (backend e
// gateway-whatsapp) são deployados e versionados separadamente, o mesmo
// motivo pelo qual worker-martinbrower já não compartilha pacote com o
// backend hoje. Alterar o formato aqui exige alterar o lado backend também —
// os testes dos dois lados cobrem o formato canônico.
//
// O QUE É ASSINADO
//   timestamp \n nonce \n MÉTODO \n path+querystring \n sha256(corpo)
//
// PROTEÇÕES
//   * janela de 60 s (timestamp fora disso, passado OU futuro = rejeitado)
//   * nonce de uso único dentro da janela (replay = rejeitado)
//   * comparação em tempo constante (timingSafeEqual)
//   * cache de nonces com teto e limpeza — não cresce indefinidamente
//   * segredo e assinatura completa NUNCA são logados
//
// Usado nas DUAS direções: `assinarRequisicao` monta os headers quando este
// processo é o CLIENTE (Gateway -> Backend); `exigirHmac` verifica quando
// este processo é o SERVIDOR (Backend -> Gateway).

import { createHmac, timingSafeEqual, createHash, randomBytes } from "node:crypto";
import { log, prefixoAssinatura } from "./logsafe.js";

export const JANELA_MS = 60_000; // ±60 s, mesmo valor do worker-martinbrower
const NONCE_TETO = 10_000;
const LIMPEZA_MS = 30_000;

const noncesVistos = new Map(); // nonce -> instante em que expira

const limpeza = setInterval(() => {
  const agora = Date.now();
  for (const [nonce, expira] of noncesVistos) {
    if (expira <= agora) noncesVistos.delete(nonce);
  }
}, LIMPEZA_MS);
limpeza.unref?.();

export function _resetarNonces() { noncesVistos.clear(); }
export function _tamanhoCacheNonces() { return noncesVistos.size; }

/** Monta a mensagem canônica. Os dois lados precisam gerar IDÊNTICA. */
export function montarMensagem({ timestamp, nonce, metodo, caminho, corpo }) {
  const hashCorpo = createHash("sha256").update(corpo ?? "").digest("hex");
  return [timestamp, nonce, String(metodo).toUpperCase(), caminho, hashCorpo].join("\n");
}

export function assinar({ segredo, timestamp, nonce, metodo, caminho, corpo }) {
  return createHmac("sha256", segredo)
    .update(montarMensagem({ timestamp, nonce, metodo, caminho, corpo }))
    .digest("hex");
}

// Comparação em tempo constante. Tamanhos diferentes não podem ir para
// timingSafeEqual (ele lança), então o tamanho é checado antes — isso não
// vaza informação útil, já que o tamanho da assinatura é fixo e público.
function iguaisEmTempoConstante(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Monta os headers de uma requisição assinada, para quando ESTE processo é
 * o cliente. `corpo` já deve ser a string EXATA que vai no corpo HTTP — ela
 * é serializada uma única vez e assinada nesses bytes.
 */
export function assinarRequisicao({ segredo, metodo, caminho, corpo }) {
  const timestamp = String(Date.now());
  const nonce = randomBytes(18).toString("base64url"); // 24 chars, dentro do formato aceito
  const assinatura = assinar({ segredo, timestamp, nonce, metodo, caminho, corpo });
  return {
    "X-Gateway-Timestamp": timestamp,
    "X-Gateway-Nonce": nonce,
    "X-Gateway-Signature": assinatura,
  };
}

/**
 * Middleware Express. Exige `express.raw()` antes dele, para que o corpo
 * assinado seja exatamente o que trafegou — reserializar JSON mudaria os
 * bytes e quebraria a assinatura.
 */
export function exigirHmac(segredo) {
  if (!segredo) throw new Error("WHATSAPP_GATEWAY_SECRET ausente — recusa subir sem segredo.");

  return (req, res, next) => {
    const timestamp = req.get("X-Gateway-Timestamp");
    const nonce = req.get("X-Gateway-Nonce");
    const assinatura = req.get("X-Gateway-Signature");

    const recusar = (motivo, detalhe = {}) => {
      log("warn", "hmac.recusado", { motivo, ...detalhe, assinatura: prefixoAssinatura(assinatura) });
      // Resposta genérica: não confirmamos QUAL parte falhou.
      return res.status(401).json({ error: "unauthorized" });
    };

    if (!timestamp || !nonce || !assinatura) return recusar("cabecalho ausente");
    if (!/^\d{10,13}$/.test(timestamp)) return recusar("timestamp malformado");
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return recusar("nonce malformado");

    const agora = Date.now();
    const ts = Number(timestamp);
    // Janela simétrica: rejeita passado E futuro além de ±60s (o relógio do
    // outro lado pode estar levemente à frente ou atrás).
    if (Math.abs(agora - ts) > JANELA_MS) {
      return recusar("timestamp fora da janela", { desvioMs: agora - ts });
    }

    if (noncesVistos.has(nonce)) return recusar("replay (nonce reutilizado)");
    if (noncesVistos.size >= NONCE_TETO) {
      log("error", "hmac.cache_cheio", { tamanho: noncesVistos.size });
      return res.status(503).json({ error: "gateway_busy" });
    }

    const corpo = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const caminho = req.originalUrl; // inclui a query string

    const esperada = assinar({ segredo, timestamp, nonce, metodo: req.method, caminho, corpo });
    if (!iguaisEmTempoConstante(assinatura, esperada)) {
      return recusar("assinatura invalida", { caminho });
    }

    // Só registra o nonce DEPOIS de a assinatura conferir: senão um
    // atacante poderia queimar nonces legítimos enviando lixo assinado errado.
    noncesVistos.set(nonce, agora + JANELA_MS);

    try {
      req.corpoJson = corpo ? JSON.parse(corpo) : {};
    } catch {
      return res.status(400).json({ error: "corpo_invalido" });
    }
    next();
  };
}
