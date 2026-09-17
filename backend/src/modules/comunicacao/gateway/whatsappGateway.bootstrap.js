// Monta (ou não) o router Gateway -> Backend, conforme configuração.
//
// GUARDA DE BOOT (crítica): `exigirHmac()` lança se o segredo estiver
// ausente — correto para gateway-whatsapp/src/server.js (processo dedicado,
// deve mesmo recusar subir sem segredo). Mas este arquivo vive DENTRO do
// backend principal, que serve dezenas de outras features já em produção —
// ele NUNCA pode falhar no boot por causa de uma feature nova ainda
// inativa. Por isso: sem WHATSAPP_GATEWAY_SECRET/WHATSAPP_GATEWAY_ORGANIZACAO_ID
// configurados, a rota simplesmente NÃO é montada (404 nesses paths) — o
// resto do backend sobe normalmente.
//
// REPOSITORY (Checkpoint C2 — migration 083 já aplicada em produção):
// sem `opts.repo`, esta função usa SEMPRE `criarRepoSupabase()` (o real).
// `criarRepoEmMemoria()` só entra por injeção EXPLÍCITA (testes) — nunca por
// omissão, nunca como fallback automático. Se o Supabase falhar em runtime,
// os métodos do repo real lançam (ApiError.internal) e
// whatsappGateway.routes.js propaga via `next(e)` — fail-closed: um erro de
// persistência vira um 5xx visível, nunca um "sucesso" silencioso gravado só
// em memória e perdido no próximo restart.

import express from "express";
import { exigirHmac } from "./whatsappGateway.hmac.js";
import { criarWhatsappGatewayRouter } from "./whatsappGateway.routes.js";
import { criarRepoSupabase } from "./whatsappGateway.repo.js";

/**
 * @param {object} [opts]
 * @param {ReturnType<import('../providers/baileysGateway.provider.js').criarBaileysGatewayProvider>} [opts.provider]
 * @param {object} [opts.repo] Injeção explícita — só para testes. Sem isto,
 *   produção usa `criarRepoSupabase()`.
 * @returns {{ path: string, router: import('express').Router, limiteCorpoBytes: number, repo: object } | null}
 *   `repo` vem junto só para introspecção/teste (qual repositório foi
 *   efetivamente escolhido) — app.js usa só `path`/`router`.
 */
export function montarWhatsappGatewayRouter({ provider, repo } = {}) {
  const segredo = process.env.WHATSAPP_GATEWAY_SECRET;
  const organizacaoId = process.env.WHATSAPP_GATEWAY_ORGANIZACAO_ID;
  if (!segredo || !organizacaoId) return null; // feature inativa — nada montado

  const repoEfetivo = repo ?? criarRepoSupabase();
  const limiteCorpoBytes = Number(process.env.WHATSAPP_GATEWAY_MAX_BODY_BYTES ?? 256 * 1024);

  const router = express.Router();
  router.use(express.raw({ type: "*/*", limit: limiteCorpoBytes }));
  router.use(exigirHmac(segredo));
  router.use(criarWhatsappGatewayRouter({ repo: repoEfetivo, organizacaoId, provider }));

  return { path: "/internal/comunicacao", router, limiteCorpoBytes, repo: repoEfetivo };
}
