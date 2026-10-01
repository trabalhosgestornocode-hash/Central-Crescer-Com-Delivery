// Estado do iFood Events NESTA instância, para leitura do /health e do status da integração.
// Só um getter em memória registrado pelo host embarcado (src/worker-ifood/embedded.js): nada de I/O, nada de
// segredo, nenhum import de poller/worker. Em rolling deploy cada instância tem o seu.
//
// Mesmo padrão de src/worker-comunicacao/estado.js.

let obterEstadoAtual = null;

/** Registrado pelo host com `supervisor.obterEstado` (ou um getter fixo, ex.: desabilitado); `null` limpa. */
export function registrarEstadoEvents(fn) { obterEstadoAtual = typeof fn === "function" ? fn : null; }

/** @returns {{estado: string, [k: string]: any}} Nunca lança. Sem registro = Events não roda nesta instância. */
export function lerEstadoEvents() {
  if (!obterEstadoAtual) return { estado: "disabled" };
  try { return obterEstadoAtual() ?? { estado: "disabled" }; } catch { return { estado: "degraded", motivo: "estado_ilegivel" }; }
}

/**
 * Recorte para o status da integração (usuário da unidade): só o estado do subsistema e horários.
 * Sem titular do lease nem contadores — esses agregam TODAS as lojas e ficam nos logs estruturados.
 */
export function resumoEventsParaStatus() {
  const e = lerEstadoEvents();
  return {
    estado: e.estado,
    ultimoCicloEm: e.ultimoCicloEm ?? null,
    ultimoCicloOkEm: e.ultimoCicloOkEm ?? null,
    proximaTentativaEm: e.proximaTentativaEm ?? null,
  };
}
