// Entrypoint do worker de Events do iFood — PROCESSO SEPARADO (nunca iniciado
// pelo backend HTTP principal; server.js não importa nada daqui). O modo
// EMBARCADO no Web Service é outro host (embedded.js) sobre o mesmo runtime.js.
//
//   npm run worker:ifood                       produção/Render: SÓ variáveis de ambiente do processo
//                                              (= node src/worker-ifood/index.js; nenhum arquivo .env)
//   npm run dev:worker:ifood                   desenvolvimento local (carrega backend/.env)
//   npm run worker:ifood:centralized-test      Teste (C), só ambiente técnico; ver scripts/
//
// Padrão operacional reaproveitado de worker-comunicacao/: config fail-closed,
// loop SERIAL (sem setInterval), shutdown gracioso em SIGTERM/SIGINT,
// uncaughtException derruba o processo, unhandledRejection só loga.
// Sinais, término inesperado e código de saída: ./lifecycle.js.
//
// UM poller por vez: `ifood_poller_lease` (relógio do banco). Restart seguro:
// o lease é liberado no shutdown gracioso; em queda brusca vence sozinho (TTL) e
// os eventos sem ACK voltam no polling (UNIQUE(event_id) impede efeito duplicado).
//
// MEMÓRIA: estado em memória mínimo (o cache do token e contadores). Todo o
// resto vive no banco; reiniciar não perde nada.
//
// ORDEM DE CARGA: a config do worker (pura) é lida ANTES de qualquer módulo que exija a config do
// backend (Supabase etc.). Desligado = sai com 0 sem carregar mais nada.

import { carregarConfigWorkerIfood } from "./config.js";
import { ifoodLog } from "../modules/ifood/ifood.logsafe.js";   // puro: sem config/ambiente

const cfg = carregarConfigWorkerIfood();

if (!cfg.habilitado) {
  ifoodLog("info", "worker.desabilitado", { motivo: "IFOOD_EVENTS_WORKER_ENABLED != true" });
  console.log("iFood Events worker DESABILITADO (IFOOD_EVENTS_WORKER_ENABLED != true).");
  process.exit(0);
}

const http = await import("node:http");
const { montarRuntimeEventsIfood } = await import("./runtime.js");   // mesma montagem do modo embarcado
const { executarWorker } = await import("./lifecycle.js");

for (const a of cfg.avisos) ifoodLog("warn", "worker.config_ajustada", { aviso: a });

const runtime = await montarRuntimeEventsIfood({ env: process.env, cfg });
if (!runtime.ok) {
  console.error(`iFood Events worker RECUSADO: ${runtime.motivo}.`);
  process.exit(1);
}
const { modo, holder, poller } = runtime;

let ultimoResultado = null;
const loop = runtime.criarLoop({
  aoFinalizarCiclo: (r) => { ultimoResultado = { ...r, em: new Date().toISOString() }; },
});

let health = null;
if (cfg.healthPort) {
  health = http.createServer((req, res) => {
    if (req.url !== "/health") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, servico: "ifood-events-worker", modo, intervaloMs: loop.intervaloMs, ultimoCiclo: poller.info.ultimoCiclo, ultimoResultado }));
  }).listen(cfg.healthPort);
}

ifoodLog("info", "worker.iniciado", { modo, intervaloMs: loop.intervaloMs, leaseTtlS: cfg.leaseTtlS, holder });
executarWorker({ loop, poller, health, log: ifoodLog });
