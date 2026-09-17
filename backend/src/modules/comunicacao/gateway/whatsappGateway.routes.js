// Rotas Gateway -> Backend (Checkpoint C0, item 7 / C1, item 7).
//
// Isolamento da API pública (Checkpoint C1, item 6): estas rotas NÃO ficam
// sob /api/v1 (que exige `requireAuth`, um JWT de usuário Supabase — o
// Gateway não tem, nem deveria ter, um usuário). Elas são montadas
// separadamente em backend/src/app.js, ANTES do `requireAuth`, protegidas
// exclusivamente pelo HMAC de whatsappGateway.hmac.js. Isso é o que as torna
// "não utilizáveis como API pública normal": sem o segredo, 401 sempre —
// nenhuma sessão de usuário, por mais privilegiada, abre essas rotas.
//
// `organizacaoId` NÃO vem do Gateway (ele não conhece organizações/unidades
// — boundary do Checkpoint C0, item 4). Vem de configuração do BACKEND
// (WHATSAPP_GATEWAY_ORGANIZACAO_ID), porque C1 assume um único número/
// gateway para uma única organização (Checkpoint C0, item 20 — não
// superdimensionar agora). Generalizar para múltiplos números é trabalho
// futuro explícito, não um atalho silencioso.

import { Router } from "express";

/**
 * @param {object} deps
 * @param {ReturnType<import('./whatsappGateway.repo.js').criarRepoEmMemoria>} deps.repo
 * @param {string} deps.organizacaoId
 * @param {import('../whatsapp.provider.js').WhatsAppProvider & {_receberEventoMensagem?: Function}} [deps.provider]
 *   opcional — quando presente, repassa o evento de mensagem recebida para
 *   os handlers registrados via `provider.onMessage()` (Checkpoint F).
 *   Sem isso, mensagem recebida só fica registrada pelo repo.
 */
export function criarWhatsappGatewayRouter({ repo, organizacaoId, provider }) {
  const router = Router();

  router.post("/eventos/mensagem-recebida", async (req, res, next) => {
    try {
      const payload = req.corpoJson ?? {};
      await repo.registrarMensagemRecebida(organizacaoId, payload);
      provider?._receberEventoMensagem?.(payload);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  router.post("/eventos/status-provider", async (req, res, next) => {
    try {
      await repo.registrarStatusProvider(organizacaoId, req.corpoJson ?? {});
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  router.post("/eventos/heartbeat", async (req, res, next) => {
    try {
      await repo.registrarHeartbeat(organizacaoId, req.corpoJson ?? {});
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  router.post("/eventos/auth-state", async (req, res, next) => {
    try {
      const { authStateEncrypted, authStateVersion } = req.corpoJson ?? {};
      if (typeof authStateEncrypted !== "string" || !authStateEncrypted) {
        return res.status(400).json({ error: "authStateEncrypted ausente" });
      }
      // O backend armazena SÓ o ciphertext — nunca decifra (não tem a
      // chave). Ver Checkpoint C0, item 8/11.
      await repo.salvarAuthState(organizacaoId, { authStateEncrypted, authStateVersion });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  router.get("/auth-state", async (req, res, next) => {
    try {
      const authStateEncrypted = await repo.obterAuthState(organizacaoId);
      res.json(authStateEncrypted ? { authStateEncrypted } : {});
    } catch (e) { next(e); }
  });

  return router;
}
