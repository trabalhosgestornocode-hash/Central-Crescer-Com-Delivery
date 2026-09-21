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

// LIMITES DE CORPO (finitos, sempre) ------------------------------------------------------------
// GENÉRICO — heartbeat, lease, reset, confirmar...: bodies de poucas centenas de bytes; 256 KiB já é folgado.
export const LIMITE_CORPO_PADRAO_BYTES = 256 * 1024;
// AUTH-STATE — `POST /eventos/auth-state` carrega o blob de auth do Baileys (creds + TODAS as chaves Signal)
// cifrado e em base64. NÃO é pequeno: em 2026-09-19 chegou a ~253 KB de body (189,6 KB em claro) e CRESCEU a cada
// reconexão; o teto único de 256 KiB fez o backend responder 413, a persistência falhou e o Gateway ficou preso em
// DISCONNECTED (Checkpoint C3.5-C.8). 1 MiB ≈ 4x o body observado; NÃO é uma cura do crescimento (que segue em
// investigação), só a margem para o blob deixar de ser rejeitado enquanto isso.
export const LIMITE_AUTH_STATE_PADRAO_BYTES = 1024 * 1024;
// Teto ABSOLUTO do que a env pode pedir para o auth-state: nunca "ilimitado", nem por engano de configuração.
export const LIMITE_AUTH_STATE_TETO_BYTES = 4 * 1024 * 1024;
const ROTA_AUTH_STATE = /^\/eventos\/auth-state\/?$/i; // só ESTA rota (não /reset nem /confirmar)

/** Inteiro positivo finito, senão `padrao` (uma env corrompida — "abc", 0, -1, Infinity, "" — nunca vira NaN/ilimitado). */
export function lerLimiteBytes(valorEnv, padrao) {
  if (valorEnv === undefined || valorEnv === null || String(valorEnv).trim() === "") return padrao;
  const n = Number(valorEnv);
  return Number.isSafeInteger(n) && n > 0 ? n : padrao;
}

/**
 * Checkpoint G.3.3-B — parser FAIL-CLOSED, só para WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES (o genérico
 * WHATSAPP_GATEWAY_MAX_BODY_BYTES continua em `lerLimiteBytes` acima, com o comportamento de sempre — fora de
 * escopo deste checkpoint). Ausente/vazia ⇒ `LIMITE_AUTH_STATE_PADRAO_BYTES` (1 MiB), sem erro — mesmo
 * comportamento de antes quando a env nunca existiu. Um valor EXPLICITAMENTE fornecido (dígitos, sem sinal, sem
 * ponto, sem lixo à direita) e válido (>0, <= teto) é usado exatamente como está — nunca ajustado por
 * `Math.min`/`Math.max` silencioso. Um valor fornecido e INVÁLIDO (zero, negativo, decimal, texto, "2097152x",
 * acima do teto) LANÇA: Gateway e backend precisam interpretar a mesma env da mesma forma, e um valor errado aqui
 * nunca pode virar silenciosamente "1 MiB" ou "4 MiB" — o Gateway calcularia headroom contra um número que a rota
 * na verdade não aceita. Quem chama decide o que fazer com o erro (ver montarWhatsappGatewayRouter: a feature
 * simplesmente não é montada — nunca derruba o resto do backend).
 */
export function lerLimiteAuthStateBytes(valorEnv) {
  if (valorEnv === undefined || valorEnv === null || String(valorEnv).trim() === "") return LIMITE_AUTH_STATE_PADRAO_BYTES;
  const texto = String(valorEnv).trim();
  if (!/^\d+$/.test(texto)) {
    throw new Error(`WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES precisa ser um inteiro positivo em bytes, sem sinal e sem casas decimais (recebido: "${valorEnv}")`);
  }
  const n = Number(texto);
  if (!(n > 0)) {
    throw new Error(`WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES precisa ser > 0 (recebido: ${n})`);
  }
  if (n > LIMITE_AUTH_STATE_TETO_BYTES) {
    throw new Error(`WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES (${n}) não pode passar de ${LIMITE_AUTH_STATE_TETO_BYTES} bytes (4 MiB)`);
  }
  return n;
}

/**
 * @param {object} [opts]
 * @param {ReturnType<import('../providers/baileysGateway.provider.js').criarBaileysGatewayProvider>} [opts.provider]
 * @param {object} [opts.repo] Injeção explícita — só para testes. Sem isto,
 *   produção usa `criarRepoSupabase()`.
 * @returns {{ path: string, router: import('express').Router, limiteCorpoBytes: number, limiteAuthStateBytes: number, repo: object } | null}
 *   `repo` vem junto só para introspecção/teste (qual repositório foi
 *   efetivamente escolhido) — app.js usa só `path`/`router`.
 */
export function montarWhatsappGatewayRouter({ provider, repo } = {}) {
  const segredo = process.env.WHATSAPP_GATEWAY_SECRET;
  const organizacaoId = process.env.WHATSAPP_GATEWAY_ORGANIZACAO_ID;
  if (!segredo || !organizacaoId) return null; // feature inativa — nada montado

  const repoEfetivo = repo ?? criarRepoSupabase();
  const limiteCorpoBytes = lerLimiteBytes(process.env.WHATSAPP_GATEWAY_MAX_BODY_BYTES, LIMITE_CORPO_PADRAO_BYTES);
  // Checkpoint G.3.3-B — fail-closed: uma env EXPLICITAMENTE inválida para o auth-state nunca mais cai num
  // Math.min/Math.max silencioso (podia virar 1 MiB ou 4 MiB sem avisar). Erro aqui = a feature Gateway não é
  // montada (mesmo padrão de "sem segredo/organizacao_id, rota não sobe" acima) — nunca derruba o resto do
  // backend, que serve dezenas de features não relacionadas. Nunca menor que o limite genérico (Math.max
  // preservado: senão a rota "grande" ficaria mais restrita que as pequenas).
  let limiteAuthStateBytes;
  try {
    limiteAuthStateBytes = Math.max(limiteCorpoBytes, lerLimiteAuthStateBytes(process.env.WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES));
  } catch (e) {
    console.error(JSON.stringify({ evento: "whatsapp_gateway.configuracao_invalida", motivo: e.message }));
    return null;
  }
  // Telemetria SEGURA de boot (Checkpoint G.3.3-B, item 6) — só o limite efetivo, nada de segredo/env bruta/auth-state.
  console.log(JSON.stringify({
    evento: "whatsapp_gateway.montado",
    authStateMaxBodyBytes: limiteAuthStateBytes,
    authStateMaxBodyMiB: Math.round((limiteAuthStateBytes / (1024 * 1024)) * 100) / 100,
  }));

  const router = express.Router();
  // ORDEM IMPORTA (a mesma lógica de app.js: "a primeira que casar vence" — body-parser marca `req._body` e o
  // parser seguinte não reprocessa). O parser DEDICADO precisa vir ANTES do genérico: se viesse depois, o genérico
  // (256 KiB) já teria rejeitado com 413 e o dedicado nunca seria atingido. Só POST /eventos/auth-state entra nele.
  const rawAuthState = express.raw({ type: "*/*", limit: limiteAuthStateBytes });
  router.use((req, res, next) => {
    if (req.method !== "POST" || !ROTA_AUTH_STATE.test(req.path)) return next();
    // O HMAC assina o corpo, então só dá para verificá-lo DEPOIS de ler. Antes de aceitar ler até `limiteAuthStateBytes`,
    // exige ao menos a PRESENÇA dos 3 headers de assinatura — barra o tráfego anônimo sem custo. (Autenticidade
    // continua sendo decidida só por `exigirHmac`, logo abaixo.)
    if (!req.get("X-Gateway-Timestamp") || !req.get("X-Gateway-Nonce") || !req.get("X-Gateway-Signature")) {
      return res.status(401).json({ error: "unauthorized" });
    }
    return rawAuthState(req, res, next);
  });
  router.use(express.raw({ type: "*/*", limit: limiteCorpoBytes }));
  router.use(exigirHmac(segredo));
  router.use(criarWhatsappGatewayRouter({ repo: repoEfetivo, organizacaoId, provider }));

  return { path: "/internal/comunicacao", router, limiteCorpoBytes, limiteAuthStateBytes, repo: repoEfetivo };
}
