// Entrypoint do worker de Events do iFood — PROCESSO SEPARADO (nunca iniciado
// pelo backend HTTP principal; server.js não importa nada daqui).
//
//   npm run worker:ifood                       (distribuído — modelo oficial; usa o .env)
//   npm run worker:ifood:centralized-test      (Teste (C), só ambiente técnico; ver scripts/)
//
// Padrão operacional reaproveitado de worker-comunicacao/: config fail-closed,
// loop SERIAL (sem setInterval), shutdown gracioso em SIGTERM/SIGINT,
// uncaughtException derruba o processo, unhandledRejection só loga.
//
// UM poller por vez: `ifood_poller_lease` (relógio do banco). Restart seguro:
// o lease é liberado no shutdown gracioso; em queda brusca vence sozinho (TTL) e
// os eventos sem ACK voltam no polling (UNIQUE(event_id) impede efeito duplicado).
//
// MEMÓRIA: estado em memória mínimo (o cache do token e contadores). Todo o
// resto vive no banco; reiniciar não perde nada.

import http from "node:http";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { carregarConfigWorkerIfood } from "./config.js";
import { ifoodLog } from "../modules/ifood/ifood.logsafe.js";
import * as tokenService from "../modules/ifood/ifoodToken.service.js";
import * as repoEvents from "../modules/ifood/ifoodEvents.repository.js";
import * as repoOrder from "../modules/ifood/ifoodOrder.repository.js";
import { criarPoller, criarLoopDoPoller } from "../modules/ifood/ifoodEvents.poller.js";
import { MODOS_AUTH } from "../modules/ifood/ifoodAuthProvider.js";
import { centralizadoTestePermitido } from "../modules/ifood/ifood.ambienteTeste.js";

const cfg = carregarConfigWorkerIfood();
for (const a of cfg.avisos) ifoodLog("warn", "worker.config_ajustada", { aviso: a });

if (!cfg.habilitado) {
  ifoodLog("info", "worker.desabilitado", { motivo: "IFOOD_EVENTS_WORKER_ENABLED != true" });
  console.log("iFood Events worker DESABILITADO (IFOOD_EVENTS_WORKER_ENABLED != true).");
  process.exit(0);
}

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

let encerrando = false;
async function encerrar(sinal) {
  if (encerrando) return;
  encerrando = true;
  ifoodLog("info", "worker.encerrando", { sinal });
  const forca = setTimeout(() => { console.error("shutdown demorou demais: saindo"); process.exit(1); }, 30_000);
  forca.unref?.();
  try { await loop.parar(); } catch (e) { ifoodLog("error", "worker.erro_no_shutdown", { erro: String(e?.message ?? e).slice(0, 200) }); }
  health?.close();
  ifoodLog("info", "worker.encerrado", {});
  process.exit(0);
}
process.on("SIGTERM", () => encerrar("SIGTERM"));
process.on("SIGINT", () => encerrar("SIGINT"));
process.on("uncaughtException", (e) => { ifoodLog("error", "worker.uncaughtException", { erro: String(e?.message ?? e).slice(0, 300) }); process.exit(1); });
process.on("unhandledRejection", (e) => { ifoodLog("error", "worker.unhandledRejection", { erro: String(e?.message ?? e).slice(0, 300) }); });

ifoodLog("info", "worker.iniciado", { modo, intervaloMs: loop.intervaloMs, leaseTtlS: cfg.leaseTtlS, holder });
loop.iniciar();
