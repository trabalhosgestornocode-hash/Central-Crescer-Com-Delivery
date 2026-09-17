// Rotas do Gateway — a direção Backend -> Gateway do protocolo (Checkpoint
// C0, item 6). Superfície deliberadamente pequena: sem bulk, sem broadcast,
// sem groups/contacts dump, sem endpoint genérico para "executar um método
// qualquer do Baileys".
//
// `idempotencyKey` chega em /messages só para CORRELAÇÃO no log — o Gateway
// NUNCA decide se um envio é duplicado; isso é responsabilidade do backend
// (UNIQUE em comunicacao_mensagens.idempotency_key + claim atômico). O
// Gateway é "burro" de propósito também aqui: ele tenta enviar o que o
// backend já aprovou, não guarda estado de negócio sobre o que já mandou.

import { Router } from "express";
import { log } from "./logsafe.js";

/**
 * @param {ReturnType<import('./baileysSession.js').criarSessaoBaileys>} sessao
 */
export function criarRotas(sessao) {
  const router = Router();

  router.post("/whatsapp/connect", async (req, res, next) => {
    try {
      await sessao.conectar();
      res.json({ ok: true, status: sessao._status() });
    } catch (e) { next(e); }
  });

  router.post("/whatsapp/disconnect", async (req, res, next) => {
    try {
      await sessao.desconectar();
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  router.get("/whatsapp/status", async (req, res, next) => {
    try {
      res.json(await sessao.getStatus());
    } catch (e) { next(e); }
  });

  router.post("/whatsapp/messages", async (req, res, next) => {
    try {
      const { telefoneE164, tipo, idempotencyKey, texto, urlImagem, legenda, urlDocumento, nomeArquivo } = req.corpoJson ?? {};
      log("info", "mensagens.recebido_pedido_envio", { tipo, idempotencyKey });

      let conteudo;
      if (tipo === "text") conteudo = { text: texto };
      else if (tipo === "image") conteudo = { image: { url: urlImagem }, caption: legenda };
      else if (tipo === "document") conteudo = { document: { url: urlDocumento }, fileName: nomeArquivo };
      else return res.status(400).json({ error: "WHATSAPP_GATEWAY_INVALID_MESSAGE", detalhe: "tipo desconhecido" });

      const resultado = await sessao.enviar({ tipo, telefoneE164, conteudo });
      res.json(resultado);
    } catch (e) { next(e); }
  });

  router.post("/whatsapp/messages/:id/read", async (req, res, next) => {
    try {
      const { telefoneE164 } = req.corpoJson ?? {};
      await sessao.markAsRead({ providerMessageId: req.params.id, telefoneE164 });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  router.get("/whatsapp/messages/:id/status", async (req, res, next) => {
    try {
      res.json(await sessao.getMessageStatus(req.params.id));
    } catch (e) { next(e); }
  });

  return router;
}

export function health(_req, res) {
  res.json({ ok: true, service: "gateway-whatsapp", ts: new Date().toISOString() });
}
