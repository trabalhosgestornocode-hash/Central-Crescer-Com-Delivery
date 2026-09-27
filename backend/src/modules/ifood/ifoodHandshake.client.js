// Handshake / Plataforma de negociação do iFood — respostas às disputas (HANDSHAKE_DISPUTE).
//
// Portal oficial (Order > Plataforma de negociação + Guia de negociação, 2026-09-27):
//   POST /order/v1.0/disputes/{disputeId}/accept       body opcional {reason?, detailReason?}   -> 201 {id,status:"ACCEPTED",disputeId}
//   POST /order/v1.0/disputes/{disputeId}/reject       body {reason}                            -> 201 {status:"REJECTED"}
//   POST /order/v1.0/disputes/{disputeId}/alternative  body {type, metadata}                    -> 201 {status:"ALTERNATIVE_REPLIED"}
//   erros: 401 · 404 DISPUTE_NOT_FOUND · 422 DISPUTE_ALREADY_ANSWERED · 400 INVALID_REASON/INVALID_AMOUNT
// Uma resposta por disputeId (não reutilizável) => NUNCA repetir automaticamente (`semRetry`).
// Não obtém token: recebe `accessToken` já resolvido.

import { IFOOD_ROTAS } from "./ifood.constants.js";
import { ifoodErro, IFOOD_ERROS } from "./ifood.errors.js";
import * as httpClient from "./ifoodHttp.client.js";

const idValido = (id) => typeof id === "string" && id.trim().length > 0 && id.length <= 100;
const ok2xx = (status) => status >= 200 && status < 300;

async function responder(rota, corpo, { accessToken, disputeId, rotulo, http }) {
  if (!idValido(disputeId)) throw ifoodErro(IFOOD_ERROS.IFOOD_REQUISICAO_INVALIDA, { detalhes: { motivo: "disputeId inválido" } });
  const r = await http.postJson(rota, corpo, {
    accessToken, rotulo, contexto: "order", comStatus: true, semRetry: true, semCorpo: corpo === null,
  });
  const c = r.corpo && typeof r.corpo === "object" ? r.corpo : {};
  return { status: r.status, aceito: ok2xx(r.status), settlementId: c.id ?? null, settlementStatus: c.status ?? null, resposta: c };
}

/** `reason`/`detailReason` só quando a disputa exige (ex.: DELAY exige um motivo de metadata.acceptCancellationReasons). */
export function aceitarDisputa({ accessToken, disputeId, reason = null, detailReason = null, http = httpClient }) {
  const corpo = reason ? { reason, ...(detailReason ? { detailReason: String(detailReason).slice(0, 250) } : {}) } : null;
  return responder(IFOOD_ROTAS.disputeAccept(disputeId), corpo, { accessToken, disputeId, rotulo: "handshake.accept", http });
}

export function rejeitarDisputa({ accessToken, disputeId, reason, http = httpClient }) {
  if (!reason || !String(reason).trim()) throw ifoodErro(IFOOD_ERROS.IFOOD_RESPOSTA_DISPUTA_INVALIDA, { detalhes: { motivo: "reject exige reason" } });
  return responder(IFOOD_ROTAS.disputeReject(disputeId), { reason: String(reason).trim() }, { accessToken, disputeId, rotulo: "handshake.reject", http });
}

/** type: REFUND | BENEFIT (metadata.amount {value,currency}) | ADDITIONAL_TIME (metadata.additionalTimeInMinutes, additionalTimeReason). */
export function proporAlternativa({ accessToken, disputeId, type, metadata, http = httpClient }) {
  if (!["REFUND", "BENEFIT", "ADDITIONAL_TIME"].includes(type) || !metadata || typeof metadata !== "object") {
    throw ifoodErro(IFOOD_ERROS.IFOOD_RESPOSTA_DISPUTA_INVALIDA, { detalhes: { motivo: "alternative exige type e metadata válidos" } });
  }
  return responder(IFOOD_ROTAS.disputeAlternative(disputeId), { type, metadata }, { accessToken, disputeId, rotulo: "handshake.alternative", http });
}
