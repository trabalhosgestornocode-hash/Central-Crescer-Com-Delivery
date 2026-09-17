// Servidor do Gateway.
//
// Nunca é exposto publicamente: no Render, sobe como Private Service
// (Checkpoint C0 — não provisionado neste checkpoint). Não há CORS, não há
// arquivo estático, não há rota pública além do /health.

import express from "express";
import makeWASocket, { DisconnectReason } from "baileys";
import { config, validarConfig } from "./config.js";
import { exigirHmac } from "./hmac.js";
import { criarRotas, health } from "./routes.js";
import { criarBackendClient } from "./backendClient.js";
import { criarAuthStateAdapter } from "./authState.js";
import { criarSessaoBaileys } from "./baileysSession.js";
import { log } from "./logsafe.js";

// Falhar no boot é melhor que subir sem autenticação ou sem cifra.
validarConfig();

const backendClient = criarBackendClient({
  backendUrl: config.backendUrl,
  segredoHmac: config.segredoHmac,
  timeoutMs: config.timeoutBackendMs,
});
const authAdapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: config.chaveEncriptacaoAuthState });
const sessao = criarSessaoBaileys({
  authAdapter,
  backendClient,
  config,
  fabricaSocket: makeWASocket,
  DisconnectReasonLoggedOut: DisconnectReason.loggedOut,
});

const app = express();
app.disable("x-powered-by");

// Probe do Render — antes do HMAC, de propósito. Não revela nada sensível.
app.get("/health", health);

// express.raw: o HMAC assina os BYTES recebidos. Reparsear/reserializar
// JSON mudaria a representação e quebraria a assinatura. As rotas usam
// `req.corpoJson`, produzido pelo middleware.
app.use(
  "/internal",
  express.raw({ type: "*/*", limit: config.limiteCorpoBytes }),
  exigirHmac(config.segredoHmac),
  criarRotas(sessao),
);

app.use((_req, res) => res.status(404).json({ error: "not_found" }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  log("error", "erro_nao_tratado", { rota: req.path, mensagem: err?.message });
  res.status(err?.status ?? 500).json({ error: err?.codigo ?? "WHATSAPP_GATEWAY_UNAVAILABLE" });
});

const servidor = app.listen(config.porta, () => {
  log("info", "gateway.iniciado", { porta: config.porta, gatewayVersion: config.gatewayVersion });
});

servidor.headersTimeout = 65_000;

// --- shutdown gracioso ------------------------------------------------
let encerrando = false;
async function encerrar(sinal) {
  if (encerrando) return;
  encerrando = true;
  log("warn", "gateway.encerrando", { sinal });
  servidor.close();
  await sessao.desconectar().catch(() => {});
  log("info", "gateway.encerrado", { sinal });
  process.exit(0);
}
for (const sinal of ["SIGTERM", "SIGINT"]) process.on(sinal, () => encerrar(sinal));

process.on("uncaughtException", async (e) => {
  log("error", "excecao_nao_capturada", { mensagem: e.message });
  await sessao.desconectar().catch(() => {});
  process.exit(1);
});
process.on("unhandledRejection", (motivo) => {
  log("error", "promessa_rejeitada", { mensagem: String(motivo?.message ?? motivo) });
});
