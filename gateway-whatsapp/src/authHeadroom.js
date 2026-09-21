// Checkpoint G.0.1 — guarda de AUTH HEADROOM para o motor de OFFLINE_RECOVERY (Partes K-R do checkpoint).
//
// PROBLEMA: o motor de recovery (src/offlineRecovery.js) só recebe `lerAuthHeadroomOk(): boolean` — de propósito
// (Parte N do checkpoint: "o motor deve continuar recebendo apenas lerAuthHeadroomOk(); a lógica de bytes/
// percentual fica no wiring/config"). Este módulo É essa lógica: pura, sem Baileys, sem rede, sem `ev`/`ws`/`socket`.
//
// FONTE REAL (Parte L): reaproveita `authAdapter.obterUltimoTamanho()` (src/authState.js) — o MESMO `corpoBytes`
// que a telemetria `auth_state.metricas` já calcula a partir de `cifrado.length` (nenhuma segunda serialização
// pesada do auth state só para isto; ver o comentário em authState.js#salvarSnapshot).
//
// FAIL-CLOSED (Parte Q): métrica ausente (nunca gravou nesta sessão do processo) OU valor inválido (não-finito,
// negativo) ⇒ `ok()` devolve `false`. "Desconhecido" NUNCA é tratado como seguro.
//
// LIMIAR (Partes M-O): o Gateway NUNCA lê o limite real do backend (WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES é
// um segredo/config do OUTRO processo) — usa uma referência local e conservadora: `limiteBytes` (1 MiB, o mesmo
// valor documentado) e `maxUsagePct` (percentual desse limite que o recovery aceita usar; o resto é margem).
export const LIMITE_BYTES_1MIB = 1024 * 1024;
export const MAX_USAGE_PCT_PADRAO = 85;

/**
 * @param {object} deps
 * @param {() => ({corpoBytes: number, medidoEm: number} | null)} deps.obterUltimoTamanho normalmente
 *   `authAdapter.obterUltimoTamanho` — nunca lançar é responsabilidade DESTE módulo, não de quem injeta.
 * @param {number} [deps.limiteBytes] referência local do limite de corpo (padrão 1 MiB)
 * @param {number} [deps.maxUsagePct] percentual do limite que o recovery aceita usar (0 < pct < 100)
 */
export function criarGuardaAuthHeadroom({ obterUltimoTamanho, limiteBytes = LIMITE_BYTES_1MIB, maxUsagePct = MAX_USAGE_PCT_PADRAO } = {}) {
  if (typeof obterUltimoTamanho !== "function") throw new TypeError("obterUltimoTamanho é obrigatório");
  if (!(limiteBytes > 0)) throw new RangeError("limiteBytes deve ser > 0");
  if (!(maxUsagePct > 0 && maxUsagePct < 100)) throw new RangeError("maxUsagePct deve estar entre 0 e 100 (exclusivo)");
  const limiteUsoBytes = limiteBytes * (maxUsagePct / 100);

  /** `corpoBytes` válido (finito, >= 0) ou null — nunca lança. */
  function corpoBytesConhecido() {
    try {
      const info = obterUltimoTamanho();
      const v = info?.corpoBytes;
      return Number.isFinite(v) && v >= 0 ? v : null;
    } catch {
      return null; // erro ao ler a fonte é tratado como "desconhecido" — nunca como "seguro"
    }
  }

  return {
    /** true SÓ quando há uma medição válida E ela está abaixo do limiar. Nunca lança. */
    ok() {
      const corpoBytes = corpoBytesConhecido();
      return corpoBytes !== null && corpoBytes < limiteUsoBytes;
    },
    /** Instantâneo SEGURO (só números/booleanos) para logs/painéis — nunca o auth state em si. */
    estado() {
      const corpoBytes = corpoBytesConhecido();
      return {
        corpoBytesConhecido: corpoBytes !== null,
        usagePct: corpoBytes === null ? null : Math.round((corpoBytes / limiteBytes) * 1000) / 10,
        headroomBytes: corpoBytes === null ? null : Math.max(0, Math.round(limiteBytes - corpoBytes)),
        limiteUsoBytes: Math.round(limiteUsoBytes),
        limiteBytes, maxUsagePct,
      };
    },
  };
}
