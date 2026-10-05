// Acompanhamento automático da Reconciliation On Demand do iFood.
//
// Critério oficial de homologação Financial: "Implementar polling com backoff
// exponencial" e "Tratar erro 409 e reutilizar requestId" (o 409 é resolvido
// no backend). Este módulo é PURO quanto a efeitos: recebe `consultar`,
// `dormir` e `agora` injetados — sem DOM, sem fetch, testável em Node.
//
// Política (doc oficial de Sales/Rate limit: "backoff exponencial — aguarde
// 2s, 4s, 8s..." e "respeite o retry-after"):
//   * primeira consulta IMEDIATA (o arquivo pode já estar pronto);
//   * depois espera 2s, 4s, 8s, 16s, 30s, 30s... (teto de 30s — nada de
//     polling agressivo);
//   * 429/indisponibilidade: o backend já respeitou o Retry-After nas suas
//     tentativas; aqui o erro só ESTICA a espera (dobra) e conta como falha
//     transitória — N seguidas encerram com erro;
//   * erro definitivo (solicitação desconhecida/expirada, sem permissão,
//     sessão) encerra na hora, sem insistir;
//   * teto de tempo total: encerra como "tempo_esgotado" (o processamento
//     pode continuar no iFood — a UI oferece "Verificar agora");
//   * cancelável (sair da tela, trocar de unidade, nova solicitação).

export const POLLING_RECONCILIACAO = Object.freeze({
  atrasoInicialMs: 2_000,
  fator: 2,
  atrasoMaxMs: 30_000,
  tempoTotalMaxMs: 10 * 60_000,
  maxErrosTransitoriosSeguidos: 4,
});

// Erros que não melhoram esperando — encerrar o acompanhamento.
const ERROS_DEFINITIVOS = new Set([
  "IFOOD_RECONCILIATION_SOLICITACAO_NAO_ENCONTRADA",
  "IFOOD_RECONCILIATION_INVALIDA",
  "IFOOD_MERCHANT_SEM_PERMISSAO",
  "IFOOD_TOKEN_EXPIRADO",
  "IFOOD_REFRESH_FALHOU",
  "IFOOD_CONEXAO_NAO_ENCONTRADA",
  "IFOOD_FINANCIAL_SEM_MERCHANT",
  "MFA_REQUERIDA",
]);

const STATUS_TERMINAIS = new Set(["processed", "error"]);

/** Próxima espera do backoff exponencial, com teto. */
export function proximoAtraso(atualMs, cfg = POLLING_RECONCILIACAO) {
  return Math.min(Math.max(atualMs, 1) * cfg.fator, cfg.atrasoMaxMs);
}

/** Erro transitório (vale esperar e tentar de novo)? Sem `codigo` = rede/servidor. */
export function erroTransitorio(e) {
  return !ERROS_DEFINITIVOS.has(e?.codigo);
}

/** Espera cancelável (resolve cedo quando o sinal aborta). */
export function dormirCancelavel(ms, sinal) {
  return new Promise((resolve) => {
    if (sinal?.aborted) return resolve();
    const t = setTimeout(() => { sinal?.removeEventListener?.("abort", fim); resolve(); }, ms);
    function fim() { clearTimeout(t); resolve(); }
    sinal?.addEventListener?.("abort", fim, { once: true });
  });
}

/**
 * @param {object} p
 * @param {(requestId: string) => Promise<{status: string, finalizado?: boolean}>} p.consultar
 * @param {(evento: object) => void} [p.aoAtualizar] fase: processando | instavel
 * @param {(ms: number, sinal: AbortSignal) => Promise<void>} [p.dormir]
 * @param {() => number} [p.agora]
 * @param {object} [p.config]
 * @returns {{ iniciar: (requestId: string) => Promise<object>, cancelar: () => void, readonly ativo: boolean }}
 *   Resultado final: { estado: 'concluido'|'falhou'|'erro'|'tempo_esgotado'|'cancelado', resultado?, erro?, tentativas }
 */
export function criarAcompanhamentoReconciliacao({ consultar, aoAtualizar = () => {}, dormir = dormirCancelavel, agora = Date.now, config = POLLING_RECONCILIACAO } = {}) {
  let ctrl = null;

  async function iniciar(requestId) {
    ctrl?.abort();
    const meu = new AbortController();
    ctrl = meu;
    const inicio = agora();
    let atraso = config.atrasoInicialMs;
    let errosSeguidos = 0;
    let tentativas = 0;

    try {
      for (;;) {
        if (meu.signal.aborted) return { estado: "cancelado", tentativas };
        tentativas += 1;
        try {
          const r = await consultar(requestId);
          if (meu.signal.aborted) return { estado: "cancelado", tentativas };
          errosSeguidos = 0;
          if (r?.finalizado || STATUS_TERMINAIS.has(r?.status)) {
            return { estado: r.status === "processed" ? "concluido" : "falhou", resultado: r, tentativas };
          }
          aoAtualizar({ fase: "processando", resultado: r, tentativas, proximaEmMs: atraso });
        } catch (e) {
          if (meu.signal.aborted) return { estado: "cancelado", tentativas };
          if (!erroTransitorio(e)) return { estado: "erro", erro: e, tentativas };
          errosSeguidos += 1;
          if (errosSeguidos >= config.maxErrosTransitoriosSeguidos) return { estado: "erro", erro: e, tentativas };
          // Rate limit: além do backoff normal, dobra a espera desta rodada.
          if (e?.codigo === "IFOOD_RATE_LIMITED") atraso = proximoAtraso(atraso, config);
          aoAtualizar({ fase: "instavel", erro: e, tentativas, proximaEmMs: atraso });
        }
        if (agora() - inicio + atraso > config.tempoTotalMaxMs) return { estado: "tempo_esgotado", tentativas };
        await dormir(atraso, meu.signal);
        atraso = proximoAtraso(atraso, config);
      }
    } finally {
      if (ctrl === meu) ctrl = null;
    }
  }

  return {
    iniciar,
    cancelar() { ctrl?.abort(); ctrl = null; },
    get ativo() { return ctrl !== null; },
  };
}
