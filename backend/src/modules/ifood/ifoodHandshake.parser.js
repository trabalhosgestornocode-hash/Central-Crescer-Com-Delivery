// Handshake / Plataforma de negociação — interpretação dos eventos HANDSHAKE_DISPUTE (HSD) e HANDSHAKE_SETTLEMENT (HSS).
//
// Fonte: portal iFood, Order > Plataforma de negociação e Guia de negociação (2026-09-27).
// DIVERGÊNCIA DOCUMENTADA: a página de "Eventos de pedido" mostra `metadata.dispute {status, proposalValue, ...}` e
// `metadata.dispute.resolution`, enquanto "Plataforma de negociação" mostra `metadata` = HandshakeDispute (id, action,
// handshakeType, expiresAt, timeoutAction, alternatives...) e `metadata` = HandshakeSettlement (id, disputeId, status).
// Adotado: a forma da "Plataforma de negociação" é a principal; a forma aninhada (`metadata.dispute`) é aceita como
// fallback. O payload BRUTO é sempre guardado. Nada é inventado: campo ausente = null.

const texto = (v, max = 500) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const objeto = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
const lista = (v) => (Array.isArray(v) ? v : null);
const dataIso = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

export const STATUS_SETTLEMENT = Object.freeze(["ACCEPTED", "REJECTED", "EXPIRED", "ALTERNATIVE_REPLIED"]);
/** Settlements que ENCERRAM a negociação (ALTERNATIVE_REPLIED espera a resposta final do cliente). */
export const SETTLEMENT_FINAL = Object.freeze(new Set(["ACCEPTED", "REJECTED", "EXPIRED"]));
export const TIPOS_HANDSHAKE = Object.freeze(["AFTER_DELIVERY", "DELAY", "PREPARATION_TIME", "AFTER_DELIVERY_PARTIALLY"]);

/** Procura `campo` no metadata e, como fallback, em metadata.dispute e em metadata.metadata (o guia mostra os dois níveis). */
function pegar(meta, campo) {
  for (const nivel of [meta, objeto(meta?.dispute), objeto(meta?.metadata)]) {
    if (nivel && nivel[campo] !== undefined && nivel[campo] !== null) return nivel[campo];
  }
  return null;
}

/** @returns {{valido: true, disputa: object, avisos: string[]} | {valido: false, motivo: string}} */
export function interpretarDisputa(metadata) {
  const m = objeto(metadata);
  if (!m) return { valido: false, motivo: "HANDSHAKE_DISPUTE sem metadata" };
  // O id da negociação é `id` na documentação; `disputeId` é aceito como alias (o sandbox já divergiu da doc em outros campos).
  const id = texto(pegar(m, "id") ?? pegar(m, "disputeId"), 100);
  if (!id) return { valido: false, motivo: "HANDSHAKE_DISPUTE sem id da negociação" };

  const avisos = [];
  const tipo = texto(pegar(m, "handshakeType"), 40);
  if (tipo && !TIPOS_HANDSHAKE.includes(tipo)) avisos.push(`handshakeType desconhecido: ${tipo}`);
  const alternativas = lista(pegar(m, "alternatives"));
  const motivosAceite = lista(pegar(m, "acceptCancellationReasons"));
  const expira = dataIso(pegar(m, "expiresAt"));
  if (!expira) avisos.push("sem expiresAt");

  return {
    valido: true, avisos,
    disputa: {
      dispute_id: id,
      action: texto(pegar(m, "action"), 40),
      handshake_type: tipo,
      handshake_group: texto(pegar(m, "handshakeGroup"), 60),
      message: texto(pegar(m, "message"), 1000),
      parent_dispute_id: texto(pegar(m, "parentDisputeId"), 100),
      expires_at: expira,
      timeout_action: texto(pegar(m, "timeoutAction"), 40),
      alternatives: alternativas ?? [],
      accept_cancellation_reasons: motivosAceite ?? [],
      evidences: lista(pegar(m, "evidences")) ?? [],
      dispute_created_at: dataIso(pegar(m, "createdAt")),
      dispute_payload: m,
    },
  };
}

/** @returns {{valido: true, settlement: object, avisos: string[]} | {valido: false, motivo: string}} */
export function interpretarSettlement(metadata) {
  const m = objeto(metadata);
  if (!m) return { valido: false, motivo: "HANDSHAKE_SETTLEMENT sem metadata" };
  const disputeId = texto(m.disputeId ?? objeto(m.dispute)?.id, 100);
  if (!disputeId) return { valido: false, motivo: "HANDSHAKE_SETTLEMENT sem disputeId" };
  const avisos = [];
  const statusBruto = texto(m.status ?? objeto(m.dispute)?.status, 40);
  const status = statusBruto ? statusBruto.toUpperCase() : null;
  if (!status || !STATUS_SETTLEMENT.includes(status)) avisos.push(`status de settlement fora do catálogo: ${statusBruto ?? "(vazio)"}`);
  return {
    valido: true, avisos,
    settlement: {
      dispute_id: disputeId,
      settlement_id: texto(m.id, 100),
      status: status && STATUS_SETTLEMENT.includes(status) ? status : "DESCONHECIDO",
      status_bruto: statusBruto,
      reason: texto(m.reason ?? objeto(m.dispute)?.resolution, 500),
      selected_alternative: objeto(m.selectedDisputeAlternative),
      created_at: dataIso(m.createdAt),
      final: !!status && SETTLEMENT_FINAL.has(status),
    },
  };
}
