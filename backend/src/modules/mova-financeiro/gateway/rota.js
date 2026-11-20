// Rota Gateway → backend do MOVA: `POST /eventos/mova-grupo`, montada DENTRO do router HMAC do Gateway
// (comunicacao/gateway/whatsappGateway.bootstrap.js) e SOMENTE quando um receptor do MOVA é injetado. Em produção nada injeta
// ⇒ a rota não existe (404) e o fluxo atual do Gateway fica exatamente como era.
// Códigos: 202 enfileirado · 200 duplicado/ignorado · 400 recusado · 503 indisponível (o Gateway tenta de novo).
import { Router } from "express";

export const ROTA_EVENTO_MOVA = "/eventos/mova-grupo";
export const LIMITE_CORPO_MOVA_BYTES = 21 * 1024 * 1024; // mídia de até 15 MB em base64 + envelope

const STATUS = { ENFILEIRADO: 202, DUPLICADO: 200, IGNORADO: 200, RECUSADO: 400, INDISPONIVEL: 503 };

/** @param {{receptor:{receber:Function}}} deps */
export function criarRotaEventosMova({ receptor }) {
  const r = Router();
  r.post(ROTA_EVENTO_MOVA, async (req, res, next) => {
    try {
      const out = await receptor.receber(req.corpoJson, { formato: "GATEWAY" });
      res.status(STATUS[out.status] ?? 500).json({ status: out.status, motivo: out.motivo ?? null });
    } catch (e) { next(e); }
  });
  return r;
}
