// Configuração do worker de Events do iFood (fail-closed).
//
// Lida pelos DOIS hosts do Events. `habilitado` é só do worker dedicado (processo separado, src/worker-ifood/index.js):
// roda se `IFOOD_EVENTS_WORKER_ENABLED=true`; sem isso, sai sem fazer nada. O modo embarcado no Web Service tem a
// flag própria (IFOOD_EVENTS_EMBEDDED_ENABLED, ver embedded.js) e usa daqui só intervalo e TTL do lease.
//
//   IFOOD_EVENTS_WORKER_ENABLED    'true' para ligar (padrão: desligado)
//   IFOOD_EVENTS_POLL_INTERVAL_MS  intervalo de início a início; NUNCA abaixo de 30000 (piso da doc iFood)
//   IFOOD_EVENTS_LEASE_TTL_S       validade do lease do poller (padrão 90; mínimo 45 e >= 2,5x o intervalo)
//   IFOOD_EVENTS_HEALTH_PORT       (opcional) porta de um /health mínimo, sem segredos

import { IFOOD_EVENTS } from "../modules/ifood/ifood.constants.js";

export function carregarConfigWorkerIfood(env = process.env) {
  const avisos = [];

  const habilitado = env.IFOOD_EVENTS_WORKER_ENABLED === "true";

  let intervaloMs = IFOOD_EVENTS.intervaloPollingMs;
  const bruto = env.IFOOD_EVENTS_POLL_INTERVAL_MS;
  if (bruto !== undefined && bruto !== "") {
    const n = Number(bruto);
    if (!Number.isFinite(n) || n <= 0) avisos.push(`IFOOD_EVENTS_POLL_INTERVAL_MS inválido ("${bruto}"): usando ${intervaloMs} ms`);
    else if (n < IFOOD_EVENTS.intervaloMinimoMs) avisos.push(`IFOOD_EVENTS_POLL_INTERVAL_MS=${n} abaixo do piso: usando ${IFOOD_EVENTS.intervaloMinimoMs} ms`), intervaloMs = IFOOD_EVENTS.intervaloMinimoMs;
    else intervaloMs = Math.trunc(n);
  }

  const ttlMin = Math.max(45, Math.ceil((intervaloMs * 2.5) / 1000));
  let leaseTtlS = IFOOD_EVENTS.leaseTtlS;
  const ttlBruto = env.IFOOD_EVENTS_LEASE_TTL_S;
  if (ttlBruto !== undefined && ttlBruto !== "") {
    const n = Number(ttlBruto);
    if (Number.isFinite(n) && n > 0) leaseTtlS = Math.min(600, Math.trunc(n));
    else avisos.push(`IFOOD_EVENTS_LEASE_TTL_S inválido ("${ttlBruto}"): usando ${leaseTtlS} s`);
  }
  if (leaseTtlS < ttlMin) { avisos.push(`lease TTL ${leaseTtlS}s abaixo do mínimo seguro: usando ${ttlMin}s`); leaseTtlS = ttlMin; }

  const porta = Number(env.IFOOD_EVENTS_HEALTH_PORT);
  const healthPort = Number.isInteger(porta) && porta > 0 && porta < 65536 ? porta : null;

  return { habilitado, intervaloMs, leaseTtlS, healthPort, avisos };
}
