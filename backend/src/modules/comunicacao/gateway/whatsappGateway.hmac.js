// Autenticação servidor-servidor por HMAC — Backend <-> gateway-whatsapp.
//
// MESMO algoritmo canônico já validado em produção por
// worker-martinbrower/src/auth.middleware.js (e reimplementado de forma
// independente em gateway-whatsapp/src/hmac.js). Reimplementado aqui pela
// terceira vez, de propósito: este é o primeiro módulo em que o BACKEND é
// quem VERIFICA uma assinatura recebida (até hoje o backend só assinava
// chamadas ao worker Martin Brower — nunca recebeu HMAC de ninguém). Não
// compartilha arquivo com martinbrower.remote.worker.js: são fronteiras de
// confiança diferentes (segredos diferentes, processos diferentes do outro
// lado), e o próprio precedente do projeto (worker-martinbrower já não
// compartilha pacote com o backend) é reaproveitar o ALGORITMO, não montar
// um pacote compartilhado entre integrações que não deveriam se acoplar.
//
// O QUE É ASSINADO
//   timestamp \n nonce \n MÉTODO \n path+querystring \n sha256(corpo)
//
// USADO NAS DUAS DIREÇÕES:
//   `assinarRequisicao` — quando o BACKEND é o cliente (chamando as rotas
//   Backend -> Gateway do gateway-whatsapp: connect/disconnect/status/
//   messages/...).
//   `exigirHmac` — quando o BACKEND é o servidor (recebendo os eventos
//   Gateway -> Backend em whatsappGateway.routes.js).

import { createHmac, timingSafeEqual, createHash, randomBytes } from "node:crypto";

export const JANELA_MS = 60_000;
const NONCE_TETO = 10_000;
const LIMPEZA_MS = 30_000;

const noncesVistos = new Map();

const limpeza = setInterval(() => {
  const agora = Date.now();
  for (const [nonce, expira] of noncesVistos) {
    if (expira <= agora) noncesVistos.delete(nonce);
  }
}, LIMPEZA_MS);
limpeza.unref?.();

export function _resetarNonces() { noncesVistos.clear(); }
export function _tamanhoCacheNonces() { return noncesVistos.size; }

export function montarMensagem({ timestamp, nonce, metodo, caminho, corpo }) {
  const hashCorpo = createHash("sha256").update(corpo ?? "").digest("hex");
  return [timestamp, nonce, String(metodo).toUpperCase(), caminho, hashCorpo].join("\n");
}

export function assinar({ segredo, timestamp, nonce, metodo, caminho, corpo }) {
  return createHmac("sha256", segredo)
    .update(montarMensagem({ timestamp, nonce, metodo, caminho, corpo }))
    .digest("hex");
}

function iguaisEmTempoConstante(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** Monta os headers de uma requisição assinada — backend como CLIENTE. */
export function assinarRequisicao({ segredo, metodo, caminho, corpo }) {
  const timestamp = String(Date.now());
  const nonce = randomBytes(18).toString("base64url");
  const assinatura = assinar({ segredo, timestamp, nonce, metodo, caminho, corpo });
  return {
    "X-Gateway-Timestamp": timestamp,
    "X-Gateway-Nonce": nonce,
    "X-Gateway-Signature": assinatura,
  };
}

/**
 * Middleware Express — backend como SERVIDOR (recebe eventos do Gateway).
 * Exige `express.raw()` antes dele.
 */
export function exigirHmac(segredo) {
  if (!segredo) throw new Error("WHATSAPP_GATEWAY_SECRET ausente — a rota recusa subir sem segredo.");

  return (req, res, next) => {
    const timestamp = req.get("X-Gateway-Timestamp");
    const nonce = req.get("X-Gateway-Nonce");
    const assinatura = req.get("X-Gateway-Signature");

    const recusar = () => res.status(401).json({ error: "unauthorized" });

    if (!timestamp || !nonce || !assinatura) return recusar();
    if (!/^\d{10,13}$/.test(timestamp)) return recusar();
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return recusar();

    const agora = Date.now();
    const ts = Number(timestamp);
    if (Math.abs(agora - ts) > JANELA_MS) return recusar();

    if (noncesVistos.has(nonce)) return recusar();
    if (noncesVistos.size >= NONCE_TETO) return res.status(503).json({ error: "backend_busy" });

    const corpo = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const caminho = req.originalUrl;

    const esperada = assinar({ segredo, timestamp, nonce, metodo: req.method, caminho, corpo });
    if (!iguaisEmTempoConstante(assinatura, esperada)) return recusar();

    noncesVistos.set(nonce, agora + JANELA_MS);

    try {
      req.corpoJson = corpo ? JSON.parse(corpo) : {};
    } catch {
      return res.status(400).json({ error: "corpo_invalido" });
    }
    next();
  };
}
