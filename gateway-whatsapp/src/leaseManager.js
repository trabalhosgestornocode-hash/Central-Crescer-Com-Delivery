// LEASE + FENCING TOKEN — propriedade exclusiva da sessão WhatsApp entre
// processos concorrentes do Gateway (Checkpoint C3.5).
//
// POR QUE (achado ao vivo, Checkpoint C3): rolling deploy no Render manteve
// 3 instâncias coexistindo (`492hh` conectada de verdade, `j4jv6`/`8s9n5`
// ociosas). Mesmo ociosa, `j4jv6` escreveu um heartbeat DISCONNECTED no seu
// próprio shutdown — porque `desconectar()` sempre manda um heartbeat final,
// mesmo sem nunca ter tido socket. Isso sobrescreveu `disconnected_at` da
// sessão real com um timestamp tardio e sem relação com o encerramento de
// verdade. Este módulo resolve a causa raiz: só o processo que detém a
// LEASE (dono exclusivo, por organizacao_id+provider_instance_id) pode
// abrir socket/gravar heartbeat de conexão; um `lease_epoch` monotônico
// (fencing token) garante que uma gravação atrasada de um dono antigo
// nunca seja aceita pelo backend, mesmo que chegue depois do handover.
//
// NÃO faz restore automático (Checkpoint C3.5, item 17 — próxima etapa).
// Este módulo só decide LEADER vs STANDBY; quem abre socket continua sendo
// uma chamada explícita a `sessao.conectar()` (manual, via /connect), que
// agora recusa rodar se `souLeader()` for false.

import { log } from "./logsafe.js";

/**
 * @param {object} deps
 * @param {ReturnType<import('./backendClient.js').criarBackendClient>} deps.backendClient
 * @param {string} deps.gatewayProcessId UUID efêmero deste processo (Checkpoint C3.5, item 2) — gerado uma vez no boot, nunca reutilizado.
 * @param {number} deps.ttlMs
 * @param {number} deps.renewMs
 * @param {number} [deps.margemSegurancaMs]
 * @param {number} [deps.pollingStandbyMs]
 * @param {() => Promise<void>} deps.aoPerderLease chamado quando este processo deixa de ser leader — quem injeta decide o que fazer (fechar socket, etc.); erros aqui nunca travam o leaseManager.
 * @param {() => Promise<void>} [deps.aoTornarSeLeader] Checkpoint C3.5-B —
 *   chamado sempre que `leader` passa de `false` para `true` (acquire
 *   inicial bem-sucedido OU standby que conseguiu assumir depois de
 *   polling). NUNCA chamado em renew (mesmo epoch, já era leader) — é
 *   assim que se evita "renew -> restore, renew -> restore" (item 9 do
 *   Checkpoint C3.5-B). Quem injeta decide o que fazer (avaliar restore
 *   automático); erros aqui nunca travam o leaseManager.
 * @param {(fn: () => void, ms: number) => any} [deps.agendarIntervalo] injeção de setInterval, para teste sem tempo real.
 * @param {(id: any) => void} [deps.cancelarIntervalo] injeção de clearInterval.
 */
export function criarLeaseManager({
  backendClient, gatewayProcessId, ttlMs, renewMs, margemSegurancaMs = 2_000, pollingStandbyMs,
  aoPerderLease, aoTornarSeLeader, agendarIntervalo = setInterval, cancelarIntervalo = clearInterval,
}) {
  const pollingMs = pollingStandbyMs ?? renewMs;

  let leader = false;
  let epochAtual = null;
  let expiraEmLocal = null; // Date.now() + ttlMs no último acquire/renew bem-sucedido
  let timerAtivo = null; // um único timer por vez — ou renovação (leader), ou polling (standby)
  let parado = false; // true depois de pararTudo() — nenhum novo timer é agendado

  function limparTimer() {
    if (timerAtivo) cancelarIntervalo(timerAtivo);
    timerAtivo = null;
  }

  /** Entra em fail-safe: para de ser leader, avisa quem injetou, volta a tentar como standby. */
  async function perderLease(motivo) {
    if (!leader) return;
    leader = false;
    limparTimer();
    log("warn", "lease.perdida", { motivo, leaseEpochAnterior: epochAtual });
    epochAtual = null;
    expiraEmLocal = null;
    try { await aoPerderLease?.(); } catch (e) { log("error", "lease.callback_perda_falhou", { erro: e?.message }); }
    iniciarPollingStandby();
  }

  async function tentarAdquirir() {
    if (parado) return false;
    try {
      const r = await backendClient.adquirirLease({ gatewayProcessId, ttlMs });
      if (r?.acquired) {
        leader = true;
        epochAtual = r.leaseEpoch;
        expiraEmLocal = Date.now() + ttlMs;
        limparTimer();
        iniciarRenovacaoPeriodica();
        log("info", "lease.adquirida", { leaseEpoch: epochAtual });
        // tentarAdquirir() só é chamado enquanto standby (o timer que o
        // aciona é sempre trocado por iniciarRenovacaoPeriodica() no sucesso
        // — nunca chamado de novo enquanto já é leader), então todo sucesso
        // aqui É uma transição real false->true.
        try { await aoTornarSeLeader?.(); } catch (e) { log("error", "lease.callback_tornar_leader_falhou", { erro: e?.message }); }
        return true;
      }
      return false;
    } catch (e) {
      log("warn", "lease.tentativa_acquire_falhou", { erro: e?.message });
      return false;
    }
  }

  function iniciarPollingStandby() {
    if (parado) return;
    limparTimer();
    // Sem chaves — devolve a Promise de tentarAdquirir() (relevante para o
    // fake de teste, que faz `await` do retorno do callback do timer).
    timerAtivo = agendarIntervalo(() => tentarAdquirir(), pollingMs);
    timerAtivo?.unref?.();
  }

  function iniciarRenovacaoPeriodica() {
    limparTimer();
    timerAtivo = agendarIntervalo(() => renovar(), renewMs);
    timerAtivo?.unref?.();
  }

  async function renovar() {
    if (!leader || parado) return;
    try {
      const r = await backendClient.renovarLease({ gatewayProcessId, leaseEpoch: epochAtual, ttlMs });
      if (r?.renewed) {
        expiraEmLocal = Date.now() + ttlMs;
        return;
      }
      await perderLease("renew_rejeitado_pelo_backend");
    } catch (e) {
      // Falha de REDE (não sabemos se ainda somos owner) — item 13: não
      // podemos deixar o socket vivo além do instante em que a lease
      // PODERIA ter expirado e outro processo assumido. Autofencing pelo
      // relógio local, independente de conseguir falar com o backend.
      if (Date.now() >= expiraEmLocal - margemSegurancaMs) {
        await perderLease("renew_falhou_prazo_local_esgotado");
      } else {
        log("warn", "lease.renovacao_falhou_tentando_de_novo", { erro: e?.message });
      }
    }
  }

  return {
    /** Primeira tentativa, no boot. Se não ganhar, já entra em polling standby sozinho. */
    async iniciar() {
      const ganhou = await tentarAdquirir();
      if (!ganhou) iniciarPollingStandby();
      return ganhou;
    },
    souLeader: () => leader,
    /** {gatewayProcessId, leaseEpoch} — só enquanto leader; null em standby. */
    contexto: () => (leader ? { gatewayProcessId, leaseEpoch: epochAtual } : null),
    /**
     * Chamado por quem detectou (fora deste módulo — ex.: authState.js,
     * baileysSession.js) uma rejeição 409 WHATSAPP_GATEWAY_LEASE_STALE numa
     * gravação fenced. Mesmo efeito de perder no renew — nunca ignorado.
     */
    async notificarPerdaExterna(motivo) { await perderLease(motivo); },
    /** Para timers (renovação OU polling standby), sem mexer no contexto — usado no início do shutdown (item 9/10), antes de fechar socket. */
    pararTemporizadores() { parado = true; limparTimer(); },
    /** Só deve ser chamado pelo leader, DEPOIS do socket já fechado (item 9). Idempotente. */
    async liberar() {
      if (!leader || epochAtual == null) return { released: false };
      const epoch = epochAtual;
      try {
        const r = await backendClient.liberarLease({ gatewayProcessId, leaseEpoch: epoch });
        leader = false;
        epochAtual = null;
        expiraEmLocal = null;
        return r;
      } catch (e) {
        log("warn", "lease.release_falhou", { erro: e?.message });
        leader = false;
        epochAtual = null;
        expiraEmLocal = null;
        return { released: false };
      }
    },
  };
}
