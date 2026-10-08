// Rotas do Gateway — a direção Backend -> Gateway do protocolo (Checkpoint
// C0, item 6). Superfície deliberadamente pequena: sem bulk, sem broadcast,
// sem contacts dump, sem endpoint genérico para "executar um método
// qualquer do Baileys". Grupos: SÓ a exceção estreita de src/grupoInterno.js
// (listar nome/JID, e enviar texto ao ÚNICO grupo interno configurado).
//
// `idempotencyKey` chega em /messages só para CORRELAÇÃO no log — o Gateway
// NUNCA decide se um envio é duplicado; isso é responsabilidade do backend
// (UNIQUE em comunicacao_mensagens.idempotency_key + claim atômico). O
// Gateway é "burro" de propósito também aqui: ele tenta enviar o que o
// backend já aprovou, não guarda estado de negócio sobre o que já mandou.

import { Router } from "express";
import { log } from "./logsafe.js";
import { qrParaSvg } from "./qrSvg.js";

/**
 * @param {ReturnType<import('./baileysSession.js').criarSessaoBaileys>} sessao
 */
export function criarRotas(sessao, { executarOperacao, retryCache } = {}) {
  const router = Router();
  router.post("/whatsapp/operacao", async (req, res, next) => {
    try {
      if (!executarOperacao) return res.status(503).json({ error: "OPERACAO_NAO_SUPORTADA" });
      res.json(await executarOperacao(req.corpoJson));
    } catch (e) { next(e); }
  });

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
    // `qr` como sempre (compatível) + metadados do QR (quando nasce, quando expira, qual é) — nunca persistido nem logado.
    // `svg` = o mesmo QR já desenhado (a aba Conexão o mostra em <img>, sem biblioteca de terceiros no navegador).
    const qr = sessao.obterQrAtual();
    res.json({ qr, svg: qrParaSvg(qr), ...(sessao.infoQr?.() ?? {}) });
  });

  // Aba Conexão — perfil da PRÓPRIA conta conectada (nome, foto, recado, tipo). Só leitura; nunca devolve credencial.
  router.get("/whatsapp/perfil", async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json(await sessao.perfilConta());
    } catch (e) { next(e); }
  });

  // Aba Conexão — desconecta a CONTA: desvincula o aparelho (melhor esforço) e faz o reset já existente. Nunca apaga histórico (vive no backend).
  router.post("/whatsapp/desconectar-conta", async (req, res, next) => {
    try {
      const { desvincular } = req.corpoJson ?? {};
      res.json(await sessao.desconectarConta({ desvincular: desvincular !== false }));
    } catch (e) { next(e); }
  });

  router.post("/whatsapp/messages", async (req, res, next) => {
    try {
      const { telefoneE164, tipo, idempotencyKey, texto, urlImagem, legenda, urlDocumento, nomeArquivo } = req.corpoJson ?? {};
      // Reenvio sob retry (src/retryCache.js): o BACKEND decide por destinatário (allowlist por contato_id, que o Gateway
      // não conhece) e marca o pedido — corpo autenticado por HMAC. Só o booleano `true` exato vale; ausente, string,
      // número ou qualquer outra coisa ⇒ false (a mensagem é enviada igual, mas NÃO é guardada para reenvio).
      const retryResend = req.corpoJson?.retryResend === true;
      log("info", "mensagens.recebido_pedido_envio", { tipo, idempotencyKey, retryResend });

      let conteudo;
      if (tipo === "text") conteudo = { text: texto };
      else if (tipo === "image") conteudo = { image: { url: urlImagem }, caption: legenda };
      else if (tipo === "document") conteudo = { document: { url: urlDocumento }, fileName: nomeArquivo };
      else return res.status(400).json({ error: "WHATSAPP_GATEWAY_INVALID_MESSAGE", detalhe: "tipo desconhecido" });

      const resultado = await sessao.enviar({ tipo, telefoneE164, conteudo, correlationId: typeof idempotencyKey === "string" ? idempotencyKey.slice(0, 200) : null, retryResend });
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

  // Central de Comunicação — foto de perfil de UM número (o backend só pergunta por contatos autorizados e faz o cache). Não envia nada.
  router.post("/whatsapp/perfil-foto", async (req, res, next) => {
    try {
      const { telefoneE164 } = req.corpoJson ?? {};
      if (typeof telefoneE164 !== "string" || !/^\+[1-9][0-9]{7,14}$/.test(telefoneE164)) return res.status(400).json({ error: "WHATSAPP_GATEWAY_INVALID_PHONE" });
      res.set("Cache-Control", "no-store");
      res.json(await sessao.fotoPerfil({ telefoneE164 }));
    } catch (e) { next(e); }
  });

  // EXCEÇÃO ESTREITA DE GRUPO (src/grupoInterno.js) — listagem SÓ LEITURA (nome/JID/tamanho, nunca participantes) e envio de texto
  // SOMENTE ao grupo interno configurado em WHATSAPP_GRUPO_INTERNO_JID. Qualquer outro @g.us é recusado (403) antes do socket.
  router.get("/whatsapp/grupos", async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json(await sessao.listarGrupos());
    } catch (e) { next(e); }
  });

  router.post("/whatsapp/grupo-interno/verificar", async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json(await sessao.verificarGrupoInterno({ grupoJid: req.corpoJson?.grupoJid }));
    } catch (e) { next(e); }
  });

  router.post("/whatsapp/grupo-interno/messages", async (req, res, next) => {
    try {
      const { grupoJid, texto, idempotencyKey } = req.corpoJson ?? {};
      if (typeof texto !== "string" || !texto.trim() || texto.length > 4096) return res.status(400).json({ error: "WHATSAPP_GATEWAY_INVALID_MESSAGE", detalhe: "texto inválido" });
      log("info", "grupo.recebido_pedido_envio", { idempotencyKey });
      res.json(await sessao.enviarGrupoInterno({ grupoJid, texto, correlationId: typeof idempotencyKey === "string" ? idempotencyKey.slice(0, 200) : null }));
    } catch (e) { next(e); }
  });

  // Métricas do reenvio sob retry (src/retryCache.js) — SÓ números/vocabulário fechado (nunca id, JID ou conteúdo).
  // É o que mede a correção: retryRecebido, cacheHit, cacheMiss, reenvioEnviado, esgotado e cacheHitRate.
  router.get("/whatsapp/retry/metricas", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!retryCache) return res.status(404).json({ error: "not_found" });
    res.json(retryCache.metricas());
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
