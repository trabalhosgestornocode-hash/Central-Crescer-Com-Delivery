// (fora de test/ de propósito: `node --test test/` executaria este arquivo como se fosse um teste)
// Backend FALSO do cache de retry — a MESMA semântica das funções da migration 105 (whatsapp_retry_cache_gravar /
// _consumir), testada de verdade contra Postgres em backend/test/whatsapp-retry-cache-migration-pg.test.js:
//   * fencing: só o dono atual da lease (gatewayProcessId + leaseEpoch) grava/lê — senão erro com `.leaseStale`;
//   * gravar é idempotente e NUNCA sobrescreve um id já gravado;
//   * consumir: NAO_ENCONTRADA | EXPIRADA (e apaga) | ESGOTADA | OK (incrementa reenvios, devolve o ciphertext).
// Guarda exatamente o que o Gateway mandou: é assim que os testes provam que o "banco" só vê ciphertext.
export function criarBackendRetryFalso({ agora = Date.now, lease = { gatewayProcessId: "11111111-2222-4333-8444-555555555555", leaseEpoch: 7 } } = {}) {
  const linhas = new Map(); // providerMessageId -> registro gravado
  const chamadas = { salvar: [], consumir: [] };
  const falhas = { salvar: [], consumir: [] }; // fila de erros a lançar nas próximas chamadas
  const donoValido = (p) => p?.gatewayProcessId === lease.gatewayProcessId && p?.leaseEpoch === lease.leaseEpoch;
  const stale = () => Object.assign(new Error("WHATSAPP_GATEWAY_LEASE_STALE"), { leaseStale: true, codigo: "WHATSAPP_GATEWAY_UNAVAILABLE" });

  return {
    lease, linhas, chamadas,
    /** Faz as próximas `n` chamadas de `op` ('salvar'|'consumir') lançarem `erro()` (ex.: backend fora do ar, 404). */
    falharProximas(op, n, erro) { for (let i = 0; i < n; i++) falhas[op].push(erro); },
    trocarDono(novo) { Object.assign(lease, novo); },
    async salvarRetryCache(p) {
      chamadas.salvar.push(p);
      const f = falhas.salvar.shift(); if (f) throw f();
      if (!donoValido(p)) throw stale();
      if (linhas.has(p.providerMessageId)) return { ok: true, resultado: "JA_EXISTIA" };
      linhas.set(p.providerMessageId, { ...p, reenvios: 0, expiraEm: agora() + p.ttlSegundos * 1000 });
      return { ok: true, resultado: "GRAVADO" };
    },
    async consumirRetryCache(p) {
      chamadas.consumir.push(p);
      const f = falhas.consumir.shift(); if (f) throw f();
      if (!donoValido(p)) throw stale();
      const r = linhas.get(p.providerMessageId);
      if (!r) return { ok: true, resultado: "NAO_ENCONTRADA" };
      if (r.expiraEm <= agora()) { linhas.delete(p.providerMessageId); return { ok: true, resultado: "EXPIRADA" }; }
      if (r.reenvios >= r.maxReenvios) return { ok: true, resultado: "ESGOTADA", reenvios: r.reenvios, maxReenvios: r.maxReenvios };
      r.reenvios += 1;
      return { ok: true, resultado: "OK", payloadCifrado: r.payloadCifrado, payloadVersao: r.payloadVersao, destinoHash: r.destinoHash, destinoLidHash: r.destinoLidHash ?? null, reenvios: r.reenvios, maxReenvios: r.maxReenvios };
    },
  };
}

/** Erros no formato de backendClient.js: rede/5xx (transitório) e 404 de rota ainda inexistente (capacidade ausente). */
export const erroBackendFora = () => Object.assign(new Error("WHATSAPP_GATEWAY_UNAVAILABLE"), { codigo: "WHATSAPP_GATEWAY_UNAVAILABLE", detalheInterno: { status: 503 } });
export const erroRotaAusente = () => Object.assign(new Error("WHATSAPP_GATEWAY_UNAVAILABLE"), { codigo: "WHATSAPP_GATEWAY_UNAVAILABLE", capacidadeAusente: true, detalheInterno: { status: 404 } });
