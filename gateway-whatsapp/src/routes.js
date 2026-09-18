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
      // Checkpoint C3.5-B, item 3 — só ESTA rota representa uma decisão real
      // do operador de querer estar conectado; grava desired_connection_
      // state=CONNECTED antes do socket (dentro de conectar()). Reconexão
      // automática pós-515 e o restore automático nunca passam por aqui.
      await sessao.conectar({ persistirIntencaoConectada: true });
      res.json({ ok: true, status: sessao._status() });
    } catch (e) { next(e); }
  });

  router.post("/whatsapp/disconnect", async (req, res, next) => {
    try {
      // Checkpoint C3.5-B, item 3 — só ESTA rota representa a decisão real
      // do operador de querer estar desconectado; grava desired_connection_
      // state=DISCONNECTED antes de fechar o socket. O shutdown técnico
      // (SIGTERM, em server.js#encerrar) chama sessao.desconectar() SEM este
      // parâmetro — de propósito, para nunca alterar a intenção do operador.
      await sessao.desconectar({ persistirIntencao: true });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Reset/re-pair explícito do operador (Checkpoint C3.5-B.2) — nunca
  // chamado automaticamente por nenhum outro caminho do Gateway.
  router.post("/whatsapp/reset", async (req, res, next) => {
    try {
      await sessao.resetarSessao();
      res.json({ ok: true, status: sessao._status() });
    } catch (e) { next(e); }
  });

  router.get("/whatsapp/status", async (req, res, next) => {
    try {
      res.json(await sessao.getStatus());
    } catch (e) { next(e); }
  });

  // QR de pareamento — só em memória (sessao.obterQrAtual()), nunca
  // persistido/logado/auditado. `no-store` porque é segredo transitório de
  // pareamento: nenhum cache (proxy, navegador) pode reter isto. Continua
  // atrás do MESMO exigirHmac() das demais rotas /internal — não é endpoint
  // público, não tem tela própria neste checkpoint (Checkpoint C3, seção 6).
  router.get("/whatsapp/qr", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ qr: sessao.obterQrAtual() });
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
