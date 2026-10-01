// (fora de test/ de propósito: `node --test test/` executaria este arquivo como se fosse um teste)
// C.9.5 — PROTÓTIPO DE PROJETO do failsafe da fila offline. NÃO é importado por src/, NÃO roda em produção.
// Existe para provar, com testes, a máquina de estados, a regra OFFLINE_STALLED, a classificação de origem e a ausência de
// corrida/duplo flush ANTES de qualquer implementação. Sem dependência do Baileys: relógio, saúde do socket, contagem de
// retidas e o `flush` são injetados (na integração real: ev.isBuffering()/ev.flush() do socket atual).
//
// ESTADOS
//   CONNECTING       — socket novo, nada visto da fase offline
//   OFFLINE_LOADING  — preview/1º nó offline visto; mensagens offline podem ficar retidas; nenhuma automação
//   OFFLINE_STALLED  — failsafe: buffer ativo + marcador ausente + SEM progresso por `stallDetectionMs` (ou teto absoluto)
//                      com o socket saudável ⇒ recuperação (um único flush) e RECOVERY_PATH_USED
//   LIVE             — só com o marcador de fim (caminho normal) ou depois da recuperação (com a marca de que NÃO foi o oficial)
//
// GARANTIAS (cobertas por testes)
//   - toda transição é compare-and-set sobre (geracaoDoSocket, fase): evento de socket antigo é ignorado;
//   - o flush de recuperação roda no máximo UMA vez por socket (guarda de reentrância);
//   - marcador e watchdog concorrentes: exatamente um caminho vence; o marcador tardio nunca gera um 2º flush;
//   - socket fechado ⇒ nunca liberar (o buffer morre com o socket): só contar a perda.
export const FASE = Object.freeze({ CONNECTING: "CONNECTING", OFFLINE_LOADING: "OFFLINE_LOADING", OFFLINE_STALLED: "OFFLINE_STALLED", LIVE: "LIVE" });
export const ORIGEM = Object.freeze({ LIVE: "LIVE", OFFLINE_NORMAL: "OFFLINE_NORMAL", OFFLINE_RECOVERY: "OFFLINE_RECOVERY" });

export function criarFailsafeOffline({
  agora = () => Date.now(),
  stallDetectionMs = 30_000,
  absoluteMaxOfflineMs = 180_000,
  keepAliveLimiteMs = 35_000,          // keepAliveIntervalMs(30 s)+5 s do Baileys: além disso o próprio Baileys derruba o socket
  maxRecuperacoesPorSocket = 5,        // teto de flushes de recuperação por socket (defesa contra laço patológico)
  socketSaudavel = () => true,
  retidas = () => 0,
  bufferAtivo = () => false,
  liberar = () => false,                // executa ev.flush() do socket ATUAL (síncrono); true = drenou de fato
  aoEvento = () => {},                  // evento técnico SEM dados pessoais
} = {}) {
  if (!(stallDetectionMs > 0)) throw new RangeError("stallDetectionMs deve ser > 0");
  if (!(absoluteMaxOfflineMs > stallDetectionMs)) throw new RangeError("absoluteMaxOfflineMs deve ser > stallDetectionMs");
  if (stallDetectionMs >= keepAliveLimiteMs) throw new RangeError("stallDetectionMs deve ficar ABAIXO do limite de keep-alive do Baileys (senão o socket cai antes do veredito)");

  let geracao = 0;
  let s = novo();
  let emRecuperacao = false;
  /** contexto do flush em curso, para rotular a origem das mensagens liberadas. */
  let contextoFlush = null;
  const m = {
    offline_stall_count: 0, offline_recovery_flush_total: 0, offline_normal_flush_total: 0, offline_recovery_messages: 0,
    offline_retained_lost_total: 0, offline_late_marker_total: 0, offline_stall_deferred_total: 0, offline_stall_without_retained_total: 0, offline_residual_recovery_total: 0,
  };

  function novo() {
    return { fase: FASE.CONNECTING, inicioEm: null, ultimoProgressoEm: null, recuperacoes: 0, nos: 0, enfileiradas: 0, batches: 0, fimRecebido: false, caminhoRecuperacaoUsado: false, marcadorTardio: false };
  }
  const evento = (nome, extra = {}) => { try { aoEvento({ evento: nome, geracao, fase: s.fase, ...extra }); } catch { /* observabilidade nunca interfere */ } };
  const atual = (g) => g === geracao;

  function entrarCarregando() {
    if (s.fase !== FASE.CONNECTING) return;
    s.fase = FASE.OFFLINE_LOADING; s.inicioEm = agora(); s.ultimoProgressoEm = s.inicioEm;
    evento("offline_loading");
  }
  const progresso = () => { s.ultimoProgressoEm = agora(); };

  return {
    /** novo socket (nova conexão): invalida TODOS os tokens anteriores. Se havia retidas no socket velho, elas MORRERAM com ele. */
    novoSocket() {
      if (s.fase === FASE.OFFLINE_LOADING || s.fase === FASE.OFFLINE_STALLED) {
        let perdidas = 0; try { perdidas = retidas(); } catch { /* idem */ }
        if (perdidas > 0) { m.offline_retained_lost_total += perdidas; evento("offline_retained_lost", { retidas: perdidas }); }
      }
      geracao += 1; s = novo(); emRecuperacao = false; contextoFlush = null;
      return geracao;
    },
    aoPreview(g) { if (!atual(g)) return; entrarCarregando(); progresso(); },
    aoBatchSolicitado(g) { if (!atual(g)) return; entrarCarregando(); s.batches += 1; progresso(); },
    aoNoOffline(g) { if (!atual(g)) return; entrarCarregando(); s.nos += 1; progresso(); },
    /** uma mensagem terminou de ser PROCESSADA (decifrada e enfileirada no buffer): também é progresso — o processamento serial pode durar
     *  bem mais que a chegada da rajada de nós; sem isto um backlog grande seria confundido com estagnação. */
    aoEnfileirada(g) { if (!atual(g)) return; entrarCarregando(); s.enfileiradas += 1; progresso(); },
    /** nó VIVO: o próprio Baileys faz buffer→flush dele (não é evidência de fim do offline; só progresso). */
    aoNoVivo(g) { if (!atual(g)) return; progresso(); },
    /** deve rodar ANTES do handler do Baileys (ws.prependListener): rotula o flush que ele vai fazer como o oficial. */
    aoMarcadorAntes(g) {
      if (!atual(g)) return;
      if (s.fase === FASE.LIVE || s.fase === FASE.OFFLINE_STALLED) { s.marcadorTardio = true; m.offline_late_marker_total += 1; evento("offline_late_marker"); return; }
      entrarCarregando(); s.fimRecebido = true; progresso();
      contextoFlush = "MARCADOR";
    },
    /** deve rodar DEPOIS do handler do Baileys (o flush oficial já ocorreu). */
    aoMarcadorDepois(g) {
      if (!atual(g)) return;
      if (contextoFlush === "MARCADOR") { contextoFlush = null; if (s.fase === FASE.OFFLINE_LOADING) { s.fase = FASE.LIVE; m.offline_normal_flush_total += 1; evento("live_por_marcador"); } }
    },
    aoSocketFechado(g) { if (!atual(g)) return; evento("socket_fechado"); },
    /** um flush terminou (por qualquer caminho): é progresso. */
    aoFlush(g) { if (!atual(g)) return; progresso(); },

    /**
     * Chamado periodicamente por UM timer do processo (nunca por um timer por mensagem). Só age em OFFLINE_LOADING.
     * Regra: sem marcador  E  (sem progresso ≥ stallDetectionMs  OU  tempo total ≥ absoluteMaxOfflineMs)  E  socket saudável.
     */
    tick(g) {
      if (!atual(g) || emRecuperacao) return false;
      const carregando = s.fase === FASE.OFFLINE_LOADING;
      const residual = s.fase === FASE.LIVE;            // o oficial (marcador) ou a recuperação já ocorreram; ainda pode sobrar retenção
      if (!carregando && !residual) return false;
      if (carregando && s.fimRecebido) return false;    // marcador visto: o handler oficial está em curso
      const t = agora();
      const semProgresso = t - s.ultimoProgressoEm >= stallDetectionMs;
      const tetoAbsoluto = carregando && t - s.inicioEm >= absoluteMaxOfflineMs;
      if (!semProgresso && !tetoAbsoluto) return false;
      if (residual) return recuperarResidual(t);
      let saudavel = false; try { saudavel = socketSaudavel() === true; } catch { saudavel = false; }
      if (!saudavel) { m.offline_stall_deferred_total += 1; evento("offline_stall_adiado_socket_nao_saudavel"); return false; }
      // ---- compare-and-set: a partir daqui, este é O caminho vencedor ----
      s.fase = FASE.OFFLINE_STALLED; m.offline_stall_count += 1;
      const n = safeNumero(retidas);
      evento("offline_stalled", { retidas: n, segundosSemProgresso: Math.round((t - s.ultimoProgressoEm) / 1000), motivo: semProgresso ? "sem_progresso" : "teto_absoluto", socketSaudavel: true, nosOfflineVistos: s.nos, batches: s.batches });
      if (n > 0 && safeBool(bufferAtivo)) {
        emRecuperacao = true; contextoFlush = "RECUPERACAO";
        let drenou = false;
        try { drenou = liberar() === true; } finally { contextoFlush = null; emRecuperacao = false; }
        s.caminhoRecuperacaoUsado = true;
        if (drenou) { m.offline_recovery_flush_total += 1; m.offline_recovery_messages += n; }
        evento("recovery_flush", { RECOVERY_PATH_USED: true, retidas: n, drenou });
      } else {
        m.offline_stall_without_retained_total += 1;
        s.caminhoRecuperacaoUsado = true;
        evento("recovery_sem_retidas", { RECOVERY_PATH_USED: true });
      }
      s.fase = FASE.LIVE;   // liberado, MAS marcado: o caminho oficial (marcador) não ocorreu
      return true;
    },

    /**
     * Rótulo de origem de UMA mensagem entregue ao listener de messages.upsert.
     * `veioDeNoOffline` = o stanza tinha attrs.offline truthy (regra do Baileys), guardado em memória por id.
     */
    classificar({ veioDeNoOffline }) {
      if (!veioDeNoOffline) return ORIGEM.LIVE;
      return contextoFlush === "RECUPERACAO" ? ORIGEM.OFFLINE_RECOVERY : ORIGEM.OFFLINE_NORMAL;
    },
    contexto: () => contextoFlush,

    estado: () => ({ ...s, geracao }),
    fase: () => s.fase,
    metricas: () => ({ ...m, offline_state: s.fase, recovery_path_used: s.caminhoRecuperacaoUsado, offline_nodes_received: s.nos, offline_batches_requested: s.batches, offline_last_progress_at: s.ultimoProgressoEm }),
  };

  /** LIVE + buffer ativo + retidas + silêncio: o que sobrou depois do flush (mensagens processadas depois dele rearmam o buffer). */
  function recuperarResidual(t) {
    const n = safeNumero(retidas);
    if (!(n > 0 && safeBool(bufferAtivo))) return false;            // nada preso: nenhum evento, nenhum flush
    if (s.recuperacoes >= maxRecuperacoesPorSocket) { evento("offline_recovery_teto_por_socket", { recuperacoes: s.recuperacoes }); return false; }
    let saudavel = false; try { saudavel = socketSaudavel() === true; } catch { saudavel = false; }
    if (!saudavel) { m.offline_stall_deferred_total += 1; evento("offline_stall_adiado_socket_nao_saudavel"); return false; }
    emRecuperacao = true; contextoFlush = "RECUPERACAO";
    let drenou = false;
    try { drenou = liberar() === true; } finally { contextoFlush = null; emRecuperacao = false; }
    s.recuperacoes += 1; s.caminhoRecuperacaoUsado = true; m.offline_residual_recovery_total += 1;
    if (drenou) { m.offline_recovery_flush_total += 1; m.offline_recovery_messages += n; }
    evento("recovery_flush", { RECOVERY_PATH_USED: true, retidas: n, drenou, motivo: "retencao_residual", segundosSemProgresso: Math.round((t - s.ultimoProgressoEm) / 1000) });
    progresso();
    return true;
  }

  function safeNumero(f) { try { const n = Number(f()); return Number.isFinite(n) && n > 0 ? n : 0; } catch { return 0; } }
  function safeBool(f) { try { return f() === true; } catch { return false; } }
}

/**
 * Tabela de decisão da ENTRADA (o que fazer com uma mensagem recebida). Defesa em profundidade: cada camada
 * (Gateway, backend, Agente) reavalia o MESMO predicado com os dados que ela tem — nenhuma confia só na anterior.
 */
export function decidirEntrada({ origem, duplicada, modoComunicacao, falhaDecrypt = false }) {
  const modoLiberado = modoComunicacao === "NORMAL";
  return {
    persistir: !falhaDecrypt && !duplicada,                       // stub de falha de decrypt não é conteúdo
    contarDuplicada: Boolean(duplicada),
    encaminharAoAgente: origem === ORIGEM.LIVE && !duplicada && !falhaDecrypt && modoLiberado,
    permitirEnvio: origem === ORIGEM.LIVE && !duplicada && !falhaDecrypt && modoLiberado,   // DISABLED é soberano
    marcarParaRevisaoHumana: origem === ORIGEM.OFFLINE_RECOVERY && !duplicada && !falhaDecrypt,
  };
}
