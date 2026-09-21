// Checkpoint G — OFFLINE_RECOVERY: máquina de estados OPCIONAL (kill-switch, nasce desligada) que transforma o
// diagnóstico do watchdog OBSERVE (offlineObserve.js, inalterado por este checkpoint) numa tentativa CONTROLADA de
// concluir a sincronização offline, em vez de simplesmente registrar que ela travou.
//
// GARANTIA ESTRUTURAL DE NÃO INTERFERÊNCIA (mesmo desenho do offlineObserve.js — ver o cabeçalho dele)
//   Este módulo NÃO importa o Baileys e NÃO recebe `ev`, `ws` nem o socket. Ele só recebe:
//     - eventos observados (nó offline/vivo, marcador, fechamento), como dados;
//     - LEITORES por geração de socket (lerBufferAtivo, lerSocketAberto, lerOfflineFimRecebido, lerMensagensRetidas,
//       lerFaseObservador, lerAuthHeadroomOk, lerIdentidadeDisponivel);
//     - `pedirBatch` — a ÚNICA ação que este módulo pode desencadear: pede à camada de wiring (que tem o socket)
//       para reenviar EXATAMENTE o mesmo frame que o Baileys manda sozinho no 1º preview
//       (`{tag:'ib', attrs:{}, content:[{tag:'offline_batch', attrs:{count:'100'}}]}` — auditado em
//       node_modules/baileys/lib/Socket/socket.js). Este módulo nunca monta esse frame nem conhece `sendNode`.
//     - `emitir` (log estruturado) e `agendar/cancelar` (timer).
//   PROIBIDO POR DESENHO (e travado por teste estático em test/offlineRecovery.test.js): flush manual. Este módulo
//   nunca chama nem recebe `ev.flush`/`ev.buffer`/`sendNode`/`sendMessage`/`.end`/`.close`/`relayMessage`/`.query`.
//   A ÚNICA saída para "destravar" é o marcador oficial (`CB:ib,,offline`) chegar e o Baileys fazer o SEU flush.
//
// GATILHO — não reimplementa o watchdog. Lê a FASE que offlineObserve.js já calculou (`lerFaseObservador`), por
// tick próprio: entra em RECOVERING quando essa fase é OFFLINE_STALLED_OBSERVED, pela PRIMEIRA vez nesta geração,
// com TODAS as precondições da seção 19 do checkpoint (fail-closed: qualquer leitor ausente ⇒ false):
//   fase === OFFLINE_STALLED_OBSERVED, bufferAtivo, !offlineFimRecebido, mensagensRetidas > 0, socketAberto,
//   identidadeDisponivel (sem o módulo de fingerprint não há como medir "progresso útil" ⇒ nunca inicia),
//   authHeadroomOk, habilitado() === true.
//
// PAGINAÇÃO — cada `pedirBatch()` é seguido de uma janela de "quietude" (`batchQuietMs`): o lote é considerado
// ENCERRADO quando nenhum nó (offline ou vivo) chega por esse tempo. Progresso ÚTIL = nó offline cujo fingerprint
// (injetado pela camada de identidade já existente, offlineIdentidade.js) ainda não tinha sido visto NESTA geração
// ("novo"). Um lote 100% duplicado/vazio incrementa `consecutiveNoProgressBatches`; ao atingir o teto, ABORTA.
// NUNCA `while(true)`: todo pedido novo passa por TODOS os limites (seção 24) antes de sair.
//
// SAÍDAS (motivo FECHADO, nunca o texto de um erro): marker_received (sucesso — o Baileys segue seu flush oficial,
// nenhum flush é chamado por aqui) | live_node (não compete: cancela o resto, não flush) | socket_closed |
// max_batches | max_nodes | max_duration | no_progress | auth_headroom | disabled (kill-switch virou false em
// pleno RECOVERING) | internal_error.
//
// NUNCA registra JID, LID, telefone, id de mensagem, conteúdo ou payload: só inteiros, booleanos e vocabulário fechado.

export const FASE_RECOVERY = Object.freeze({
  IDLE: "IDLE",
  RECOVERING: "RECOVERING",
  DONE: "DONE",
});

export const MOTIVOS_FINALIZACAO = Object.freeze([
  "marker_received", "live_node", "socket_closed", "max_batches", "max_nodes",
  "max_duration", "no_progress", "auth_headroom", "disabled", "internal_error",
]);

export const PADROES_RECOVERY = Object.freeze({
  tickMs: 500,
  batchQuietMs: 5_000,
  maxRecoveryBatches: 5,
  maxRecoveryNodes: 500,
  maxRecoveryDurationMs: 30_000,
  maxConsecutiveNoProgressBatches: 2,
});

/**
 * @param {object} deps
 * @param {() => number} [deps.agora]
 * @param {(nivel: string, evento: string, dados?: object) => void} deps.emitir
 * @param {() => (number|null)} [deps.obterEpoch]
 * @param {(fn: () => void, ms: number) => any} [deps.agendar]
 * @param {(h: any) => void} [deps.cancelar]
 * @param {() => boolean} [deps.habilitado] kill-switch — lido a cada tick, inclusive DURANTE o recovery
 * @param {number} [deps.tickMs]
 * @param {number} [deps.batchQuietMs]
 * @param {number} [deps.maxRecoveryBatches]
 * @param {number} [deps.maxRecoveryNodes]
 * @param {number} [deps.maxRecoveryDurationMs]
 * @param {number} [deps.maxConsecutiveNoProgressBatches]
 */
export function criarMotorRecovery({
  agora = () => Date.now(),
  emitir,
  obterEpoch = () => null,
  agendar = setInterval,
  cancelar = clearInterval,
  habilitado = () => false,
  tickMs = PADROES_RECOVERY.tickMs,
  batchQuietMs = PADROES_RECOVERY.batchQuietMs,
  maxRecoveryBatches = PADROES_RECOVERY.maxRecoveryBatches,
  maxRecoveryNodes = PADROES_RECOVERY.maxRecoveryNodes,
  maxRecoveryDurationMs = PADROES_RECOVERY.maxRecoveryDurationMs,
  maxConsecutiveNoProgressBatches = PADROES_RECOVERY.maxConsecutiveNoProgressBatches,
} = {}) {
  if (!(tickMs > 0)) throw new RangeError("tickMs deve ser > 0");
  if (!(batchQuietMs > 0)) throw new RangeError("batchQuietMs deve ser > 0");
  if (!Number.isInteger(maxRecoveryBatches) || maxRecoveryBatches < 1) throw new RangeError("maxRecoveryBatches deve ser inteiro >= 1");
  if (!Number.isInteger(maxRecoveryNodes) || maxRecoveryNodes < 1) throw new RangeError("maxRecoveryNodes deve ser inteiro >= 1");
  if (!(maxRecoveryDurationMs > 0)) throw new RangeError("maxRecoveryDurationMs deve ser > 0");
  if (!Number.isInteger(maxConsecutiveNoProgressBatches) || maxConsecutiveNoProgressBatches < 1) throw new RangeError("maxConsecutiveNoProgressBatches deve ser inteiro >= 1");

  let geracao = 0;
  /** @type {any} */
  let s = null;
  const totais = {
    iniciados: 0, sucesso: 0, abortados: 0, batchesSolicitados: 0, nodesRecebidos: 0,
    nodesUnicos: 0, duplicados: 0, loteSemProgresso: 0, marcadorTardioDuranteRecovery: 0,
  };

  const logar = (evento, dados) => { try { emitir("info", evento, dados); } catch { /* observabilidade nunca interfere */ } };
  const epoch = () => { try { const e = obterEpoch(); return Number.isFinite(e) ? e : null; } catch { return null; } };
  const lerBool = (f, padrao = false) => { try { const v = f?.(); return typeof v === "boolean" ? v : padrao; } catch { return padrao; } };

  function novoEstado(g, leitores) {
    return {
      g, status: FASE_RECOVERY.IDLE, tentouIniciar: false, motivoFinal: null,
      iniciadoEm: null, ultimoEventoEm: null,
      batchesSolicitados: 0, nodesRecebidos: 0, nodesUnicos: 0, duplicados: 0,
      loteUnicos: 0, loteNodes: 0, consecutiveNoProgressBatches: 0,
      timer: null,
      lerBufferAtivo: leitores.lerBufferAtivo ?? (() => false),
      lerSocketAberto: leitores.lerSocketAberto ?? (() => false),
      lerOfflineFimRecebido: leitores.lerOfflineFimRecebido ?? (() => false),
      lerMensagensRetidas: leitores.lerMensagensRetidas ?? (() => 0),
      lerFaseObservador: leitores.lerFaseObservador ?? (() => null),
      lerAuthHeadroomOk: leitores.lerAuthHeadroomOk ?? (() => true),
      lerIdentidadeDisponivel: leitores.lerIdentidadeDisponivel ?? (() => false),
      pedirBatch: typeof leitores.pedirBatch === "function" ? leitores.pedirBatch : () => {},
      aoIniciar: typeof leitores.aoIniciar === "function" ? leitores.aoIniciar : () => {},
    };
  }

  /** só devolve o estado se o token é o da geração ATUAL e ela ainda não terminou/foi substituída */
  const ativo = (g) => (s && s.g === g ? s : null);

  function pararTimer(x) { if (x?.timer) { try { cancelar(x.timer); } catch { /* idem */ } x.timer = null; } }
  function iniciarTimer(x) {
    if (x.timer) return;
    try { x.timer = agendar(() => { try { tick(x.g); } catch { /* idem */ } }, tickMs); x.timer?.unref?.(); } catch { x.timer = null; }
  }

  function baseEvento(x) { return { socketGeneration: x.g, epoch: epoch() }; }

  function emitirLote(x, motivoEncerramentoLote) {
    logar("inbound.offline_recovery_batch", {
      ...baseEvento(x), batchNumber: x.batchesSolicitados, nodes: x.loteNodes, unique: x.loteUnicos,
      duplicates: x.loteNodes - x.loteUnicos, motivoEncerramentoLote,
    });
  }

  function encerrar(x, reason) {
    if (x.status !== FASE_RECOVERY.RECOVERING) return;
    x.status = FASE_RECOVERY.DONE;
    x.motivoFinal = reason;
    pararTimer(x);
    const sucesso = reason === "marker_received" || reason === "live_node";
    if (sucesso) totais.sucesso += 1; else totais.abortados += 1;
    const duracaoSegundos = x.iniciadoEm == null ? 0 : (agora() - x.iniciadoEm) / 1000;
    const evento = sucesso ? "inbound.offline_recovery_completed" : "inbound.offline_recovery_aborted";
    logar(evento, {
      ...baseEvento(x), reason, batchesRequested: x.batchesSolicitados, nodesReceived: x.nodesRecebidos,
      uniqueNodes: x.nodesUnicos, duplicates: x.duplicados, durationSeconds: Math.round(duracaoSegundos * 100) / 100,
      noProgressBatches: x.consecutiveNoProgressBatches,
      limits: { maxRecoveryBatches, maxRecoveryNodes, maxRecoveryDurationMs, maxConsecutiveNoProgressBatches, batchQuietMs },
    });
  }

  /** decide o que fazer quando um lote é considerado ENCERRADO (quietude atingida): abortar ou pedir o próximo */
  function decidirProximoPasso(x, t) {
    const semProgressoNoLote = x.loteUnicos === 0;
    emitirLote(x, semProgressoNoLote ? "sem_progresso" : "progresso");
    if (semProgressoNoLote) { x.consecutiveNoProgressBatches += 1; totais.loteSemProgresso += 1; } else { x.consecutiveNoProgressBatches = 0; }
    x.loteNodes = 0; x.loteUnicos = 0;

    if (x.consecutiveNoProgressBatches >= maxConsecutiveNoProgressBatches) { encerrar(x, "no_progress"); return; }
    if (!lerBool(x.lerSocketAberto)) { encerrar(x, "socket_closed"); return; }
    if (!lerBool(x.lerAuthHeadroomOk, true)) { encerrar(x, "auth_headroom"); return; }
    if (x.batchesSolicitados >= maxRecoveryBatches) { encerrar(x, "max_batches"); return; }
    if (x.nodesRecebidos >= maxRecoveryNodes) { encerrar(x, "max_nodes"); return; }
    if (!habilitado()) { encerrar(x, "disabled"); return; }

    x.batchesSolicitados += 1;
    x.ultimoEventoEm = t;
    try { x.pedirBatch(); } catch { encerrar(x, "internal_error"); }
  }

  function tentarIniciar(x, t) {
    if (x.tentouIniciar) return;                                    // só UMA tentativa por geração (marcador tardio ou não)
    if (x.lerFaseObservador() !== "OFFLINE_STALLED_OBSERVED") return;
    x.tentouIniciar = true;
    if (!habilitado()) return;                                       // kill-switch — comportamento idêntico a recovery inexistente
    const entrada = {
      bufferAtivo: lerBool(x.lerBufferAtivo), offlineFimRecebido: lerBool(x.lerOfflineFimRecebido),
      mensagensRetidas: (() => { try { const v = x.lerMensagensRetidas(); return Number.isFinite(v) ? v : 0; } catch { return 0; } })(),
      socketAberto: lerBool(x.lerSocketAberto), identidadeDisponivel: lerBool(x.lerIdentidadeDisponivel),
      authHeadroomOk: lerBool(x.lerAuthHeadroomOk, true),
    };
    const pode = entrada.bufferAtivo && !entrada.offlineFimRecebido && entrada.mensagensRetidas > 0
      && entrada.socketAberto && entrada.identidadeDisponivel && entrada.authHeadroomOk;
    if (!pode) return;                                                // fail-closed: qualquer precondição faltando, nunca inicia

    x.status = FASE_RECOVERY.RECOVERING;
    x.iniciadoEm = t; x.ultimoEventoEm = t;
    totais.iniciados += 1;
    try { x.aoIniciar(); } catch { /* promoção do rastreador de origem nunca derruba o motor */ }
    logar("inbound.offline_recovery_started", { ...baseEvento(x), mensagensRetidasNoInicio: entrada.mensagensRetidas });
    x.batchesSolicitados += 1;
    try { x.pedirBatch(); } catch { encerrar(x, "internal_error"); }
  }

  function tick(g) {
    const x = ativo(g); if (!x) return;
    const t = agora();
    if (x.status === FASE_RECOVERY.IDLE) { tentarIniciar(x, t); return; }
    if (x.status !== FASE_RECOVERY.RECOVERING) return;
    if (!habilitado()) { encerrar(x, "disabled"); return; }
    if (t - x.iniciadoEm >= maxRecoveryDurationMs) { encerrar(x, "max_duration"); return; }
    if (t - x.ultimoEventoEm >= batchQuietMs) decidirProximoPasso(x, t);
  }

  return {
    /** @param {{lerBufferAtivo?, lerSocketAberto?, lerOfflineFimRecebido?, lerMensagensRetidas?, lerFaseObservador?, lerAuthHeadroomOk?, lerIdentidadeDisponivel?, pedirBatch?, aoIniciar?}} [leitores] */
    novaGeracao(leitores = {}) {
      if (s) pararTimer(s);
      geracao += 1;
      s = novoEstado(geracao, leitores);
      iniciarTimer(s);
      return geracao;
    },

    /** nó OFFLINE chegou (message/receipt/notification). `progressoUtil` vem da identidade já existente (classificação "novo"). */
    aoNo(g, { progressoUtil } = {}) {
      const x = ativo(g); if (!x || x.status !== FASE_RECOVERY.RECOVERING) return;
      x.ultimoEventoEm = agora();
      x.nodesRecebidos += 1; x.loteNodes += 1; totais.nodesRecebidos += 1;
      if (progressoUtil) { x.nodesUnicos += 1; x.loteUnicos += 1; totais.nodesUnicos += 1; } else { x.duplicados += 1; totais.duplicados += 1; }
    },

    /** um nó VIVO (attrs.offline falso) chegou: tráfego natural voltou — não competir, cancelar o resto. */
    aoNoVivo(g) {
      const x = ativo(g); if (!x) return;
      if (x.status === FASE_RECOVERY.RECOVERING) encerrar(x, "live_node");
    },

    /** rodar ANTES do handler do Baileys (mesmo padrão do observador): o marcador chegou. */
    aoMarcador(g) {
      const x = ativo(g); if (!x) return;
      if (x.status === FASE_RECOVERY.RECOVERING) { totais.marcadorTardioDuranteRecovery += 1; encerrar(x, "marker_received"); return; }
      // IDLE (nunca tentou, ou tentou e as precondições não bateram) ou já DONE: marcador segue o caminho normal — nada a fazer.
      x.tentouIniciar = true; // um marcador natural fecha a janela de entrada desta geração (nunca mais tenta iniciar)
    },

    /** o socket dessa geração fechou. */
    aoFechado(g) {
      const x = ativo(g); if (!x) return;
      if (x.status === FASE_RECOVERY.RECOVERING) encerrar(x, "socket_closed");
      pararTimer(x);
    },

    /** um tick do relógio (o timer interno chama isto; testes chamam direto). */
    tick,

    /** true só enquanto esta geração está de fato paginando (usado para rotular origem OFFLINE_RECOVERY). */
    ativo: () => s?.status === FASE_RECOVERY.RECOVERING,

    /** cópia SÓ com números/booleanos/vocabulário fechado da geração atual. */
    estado() {
      if (!s) return null;
      return {
        socketGeneration: s.g, status: s.status, motivoFinal: s.motivoFinal, tentouIniciar: s.tentouIniciar,
        batchesSolicitados: s.batchesSolicitados, nodesRecebidos: s.nodesRecebidos, nodesUnicos: s.nodesUnicos,
        duplicados: s.duplicados, consecutiveNoProgressBatches: s.consecutiveNoProgressBatches,
      };
    },
    metricas: () => ({ ...totais }),
    parar() { pararTimer(s); },
  };
}
