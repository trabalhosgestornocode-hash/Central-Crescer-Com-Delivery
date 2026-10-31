// Webhook da Meta (WhatsApp Cloud API) — SÓ status de entrega. Montado ANTES do express.json() (a assinatura é do corpo CRU) e só
// quando WHATSAPP_CLOUD_APP_SECRET existir: sem a variável a rota não existe (404). O GET (handshake) exige WHATSAPP_CLOUD_VERIFY_TOKEN.
// Ordem do POST: limite por IP → assinatura (nada é lido do banco antes) → JSON → eventos idempotentes. Resposta 200 sem corpo útil;
// falha de banco = 500 para a Meta reentregar (a gravação é idempotente). Nunca registra telefone, corpo ou cabeçalhos.
import express, { Router } from "express";
import { assinaturaValida, handshakeWebhook, extrairStatus } from "./notificacoes.whatsappOficial.js";
import { limiteDeTaxa, ipCliente } from "../../shared/rateLimit.js";
import { supabase } from "../../config/supabase.js";

export const CAMINHO_WEBHOOK_WHATSAPP = "/api/publico/notificacoes/webhook/whatsapp";
const LIMITE_CORPO = 256 * 1024;

export async function registrarEventos(itens, deps = {}) {
  if (!itens.length) return 0;
  const p = itens.map((i) => ({ chave: i.chave, provedor_msg_id: i.provedorId, status: i.status, codigo_erro: Number.isInteger(i.codigoErro) ? i.codigoErro : null }));
  const { data, error } = await (deps.supabase ?? supabase).rpc("comunicacao_provedor_registrar_eventos", { p });
  if (error) throw new Error(`webhook_eventos: ${error.code ?? "erro"}`);
  return Number(data ?? 0);
}

export function montarWebhookWhatsapp(env = process.env, deps = {}) {
  const appSecret = String(env.WHATSAPP_CLOUD_APP_SECRET ?? "").trim();
  if (!appSecret) return null;
  const verifyToken = String(env.WHATSAPP_CLOUD_VERIFY_TOKEN ?? "").trim();
  const router = Router();
  router.use(limiteDeTaxa({ escopo: "notificacoes:webhook", max: Number(env.RATE_LIMIT_WEBHOOK_WHATSAPP_MAX ?? 600), janelaMs: 60_000, chave: (req) => ipCliente(req) }));
  router.get("/", (req, res) => {
    const desafio = handshakeWebhook(req.query, verifyToken);
    res.set("Cache-Control", "no-store");
    return desafio === null ? res.status(403).end() : res.status(200).type("text/plain").send(desafio);
  });
  router.post("/", express.raw({ type: "*/*", limit: LIMITE_CORPO }), async (req, res) => {
    const cru = Buffer.isBuffer(req.body) ? req.body : null;
    if (!cru || !assinaturaValida(cru, req.get("X-Hub-Signature-256"), appSecret)) return res.status(401).end();
    let payload;
    try { payload = JSON.parse(cru.toString("utf8")); } catch { return res.status(400).end(); }
    try {
      const itens = extrairStatus(payload);
      const novos = await registrarEventos(itens, deps);
      console.log(JSON.stringify({ evento: "webhook_whatsapp.recebido", recebidos: itens.length, novos }));
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.warn(JSON.stringify({ evento: "webhook_whatsapp.falhou", motivo: String(e?.message ?? "erro").slice(0, 60) }));
      return res.status(500).end();
    }
  });
  return { path: CAMINHO_WEBHOOK_WHATSAPP, router };
}
