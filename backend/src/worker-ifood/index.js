// Entrypoint do worker de Events do iFood — PROCESSO SEPARADO (nunca iniciado
// pelo backend HTTP principal; server.js não importa nada daqui).
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
const os = await import("node:os");
const { randomBytes } = await import("node:crypto");
const tokenService = await import("../modules/ifood/ifoodToken.service.js");
const repoEvents = await import("../modules/ifood/ifoodEvents.repository.js");
const repoOrder = await import("../modules/ifood/ifoodOrder.repository.js");
const { criarPoller, criarLoopDoPoller } = await import("../modules/ifood/ifoodEvents.poller.js");
const { MODOS_AUTH } = await import("../modules/ifood/ifoodAuthProvider.js");
const { centralizadoTestePermitido } = await import("../modules/ifood/ifood.ambienteTeste.js");
const { executarWorker } = await import("./lifecycle.js");

for (const a of cfg.avisos) ifoodLog("warn", "worker.config_ajustada", { aviso: a });

const modo = tokenService.modoDeAutenticacao();
if (modo === MODOS_AUTH.CENTRALIZED_TEST) {
  const permitido = centralizadoTestePermitido(process.env);
  if (!permitido.ok) {
    console.error(`iFood Events worker RECUSADO: modo centralized_test não permitido (${permitido.motivos.join("; ")}).`);
    process.exit(1);
  }
}

const holder = `${os.hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
const repo = { ...repoEvents, ...repoOrder };
// Order Details (Checkpoint C) exige a migration 102: só liga com IFOOD_ORDER_DETAILS_ENABLED=true.
const detalhes = process.env.IFOOD_ORDER_DETAILS_ENABLED === "true" ? {} : null;
const poller = criarPoller({ repo, token: tokenService, holder, leaseTtlS: cfg.leaseTtlS, detalhes });

let ultimoResultado = null;
const loop = criarLoopDoPoller({
  poller, intervaloMs: cfg.intervaloMs,
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
