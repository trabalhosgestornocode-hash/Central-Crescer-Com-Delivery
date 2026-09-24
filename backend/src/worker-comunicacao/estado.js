// Estado do worker EMBUTIDO (mesmo processo do backend), exposto SÓ para leitura do Painel (Central de Comunicação, H.4-B.5).
// Só um getter em memória registrado por lifecycle.js — nada de I/O, nada de segredo. Em rolling deploy cada instância tem o seu.

let obterEstadoAtual = null;

/** Chamado por lifecycle.js quando o laço inicia (`loop.obterEstado`) e, com `null`, quando para. */
export function registrarEstadoDoWorker(fn) { obterEstadoAtual = typeof fn === "function" ? fn : null; }

/** @returns {{estado: string, lastCycleAt: string|null, lastCycleStatus: string|null}|null} `null` = o worker não está rodando NESTA instância. */
export function lerEstadoDoWorker() {
  if (!obterEstadoAtual) return null;
  try { return obterEstadoAtual() ?? null; } catch { return null; }
}
