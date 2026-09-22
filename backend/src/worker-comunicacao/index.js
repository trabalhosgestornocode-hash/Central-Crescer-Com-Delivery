// Entrypoint do worker de comunicação — PROCESSO SEPARADO, nunca iniciado
// pelo backend HTTP principal (server.js não importa nada daqui). Roda como
// um segundo Render Private Service, no mesmo pacote/rootDir do backend
// (reaproveita node_modules/env/bootstrap — ver docs/comunicacao-worker-h2a.md
// para a justificativa de não criar um pacote `worker-comunicacao/` à parte).
//
// Padrão operacional REAPROVEITADO de worker-martinbrower/src/server.js:
// config fail-closed antes de subir, /health antes de qualquer outra coisa,
// shutdown gracioso em SIGTERM/SIGINT, uncaughtException derruba o processo,
// unhandledRejection só loga. NADA de Playwright/sessions/HMAC daquele
// worker foi reaproveitado — só a forma do processo.

import express from "express";
import { carregarConfig } from "./config.js";
import { criarLoopWorker } from "./loop.js";
import { workerLog } from "./worker-comunicacao.logsafe.js";
import { modoAtual } from "../modules/comunicacao/comunicacao.config.js";
import { executarCiclo } from "../modules/comunicacao/comunicacao.alertas.service.js";
import { criarWhatsAppService } from "../modules/comunicacao/whatsapp.service.js";
import { criarBaileysGatewayProvider } from "../modules/comunicacao/providers/baileysGateway.provider.js";

// Falhar no boot é melhor que subir com config incompleta/inválida
// (intervalo, URL do Gateway ou segredo HMAC — ver config.js#carregarConfig).
const config = carregarConfig();

const whatsAppService = criarWhatsAppService({
  provider: criarBaileysGatewayProvider({ gatewayUrl: config.gatewayUrl, segredoHmac: config.segredoHmac }),
});

const loop = criarLoopWorker({
  executarCiclo, modoAtual, whatsAppService, intervalMs: config.intervalMs,
  log: (nivel, evento, dados) => workerLog(nivel, evento, dados),
});

const app = express();
app.disable("x-powered-by");

// Probe de liveness — sempre 200 se o processo está respondendo, mesmo com
// workerState=DISABLED (é um estado operacional válido, não um erro).
// Nenhum dado sensível: só estado do processo e agregados de tempo.
app.get("/health", (_req, res) => {
  const { estado, lastCycleAt, lastCycleStatus } = loop.obterEstado();
  res.status(200).json({
    status: "ok",
    workerState: estado,
    uptimeSegundos: Math.round(process.uptime()),
    lastCycleAt,
    lastCycleStatus,
  });
});
app.use((_req, res) => res.status(404).json({ error: "not_found" }));

const servidor = app.listen(config.porta, () => {
  workerLog("info", "comunicacao.worker_boot", { porta: config.porta, intervalMs: config.intervalMs });
});

loop.iniciar();

let encerrando = false;
async function encerrar(sinal) {
  if (encerrando) return;
  encerrando = true;
  await loop.encerrar(sinal);
  servidor.close();
  process.exit(0);
}
for (const sinal of ["SIGTERM", "SIGINT"]) process.on(sinal, () => encerrar(sinal));

// Mesmo padrão do worker-martinbrower: uma exceção genuinamente não tratada
// não pode deixar o processo vivo num estado desconhecido.
process.on("uncaughtException", (e) => {
  workerLog("error", "comunicacao.worker_excecao_nao_capturada", { mensagem: String(e?.message ?? e) });
  process.exit(1);
});
process.on("unhandledRejection", (motivo) => {
  workerLog("error", "comunicacao.worker_promessa_rejeitada", { mensagem: String(motivo?.message ?? motivo) });
});
