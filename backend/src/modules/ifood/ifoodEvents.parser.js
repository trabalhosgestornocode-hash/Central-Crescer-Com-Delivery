// Events do iFood — catálogo de códigos e normalização do evento cru.
//
// Fonte: portal iFood, Events > "Eventos de pedido" (conferido em 2026-09-27).
// Estrutura oficial do evento: id, code, fullCode, orderId, merchantId,
// createdAt, salesChannel, metadata.
//
// PRINCÍPIOS
//   * O evento cru é preservado INTEIRO (payload) + hash estável, para auditoria.
//   * Código fora do catálogo NÃO é erro: é `DESCONHECIDO` (guardado e reconhecido).
//   * Só o grupo ORDER_STATUS altera o estado OFICIAL do pedido.
//   * Sem `id` o evento não pode ser reconhecido (ACK exige o id) — é descartado
//     com log, nunca "inventamos" um id.

import { createHash } from "node:crypto";

/** Estados oficiais do pedido (fullCode do grupo ORDER_STATUS). */
export const STATUS_PEDIDO = Object.freeze({
  PLACED: "PLACED",
  CONFIRMED: "CONFIRMED",
  SEPARATION_STARTED: "SEPARATION_STARTED",
  SEPARATION_ENDED: "SEPARATION_ENDED",
  READY_TO_PICKUP: "READY_TO_PICKUP",
  DISPATCHED: "DISPATCHED",
  CONCLUDED: "CONCLUDED",
  CANCELLED: "CANCELLED",
});

/** Ordem do ciclo de vida — desempata eventos com o mesmo createdAt. */
export const RANK_STATUS = Object.freeze({
  PLACED: 10, CONFIRMED: 20, SEPARATION_STARTED: 30, SEPARATION_ENDED: 40,
  READY_TO_PICKUP: 50, DISPATCHED: 60, CONCLUDED: 90, CANCELLED: 100,
});

/** Estados finais: nenhum evento não-final os "desfaz". */
export const STATUS_TERMINAIS = Object.freeze(new Set([STATUS_PEDIDO.CONCLUDED, STATUS_PEDIDO.CANCELLED]));

const g = (grupo, fullCode, status = null) => Object.freeze({ grupo, fullCode, status });

/** code -> { grupo, fullCode, status }. `status` só existe em ORDER_STATUS. */
export const CATALOGO_EVENTOS = Object.freeze({
  // ORDER_STATUS
  PLC: g("ORDER_STATUS", "PLACED", STATUS_PEDIDO.PLACED),
  CFM: g("ORDER_STATUS", "CONFIRMED", STATUS_PEDIDO.CONFIRMED),
  SPS: g("ORDER_STATUS", "SEPARATION_STARTED", STATUS_PEDIDO.SEPARATION_STARTED),
  SPE: g("ORDER_STATUS", "SEPARATION_ENDED", STATUS_PEDIDO.SEPARATION_ENDED),
  RTP: g("ORDER_STATUS", "READY_TO_PICKUP", STATUS_PEDIDO.READY_TO_PICKUP),
  DSP: g("ORDER_STATUS", "DISPATCHED", STATUS_PEDIDO.DISPATCHED),
  CON: g("ORDER_STATUS", "CONCLUDED", STATUS_PEDIDO.CONCLUDED),
  CAN: g("ORDER_STATUS", "CANCELLED", STATUS_PEDIDO.CANCELLED),
  // CANCELLATION_REQUEST
  CAR: g("CANCELLATION_REQUEST", "CANCELLATION_REQUESTED"),
  CARF: g("CANCELLATION_REQUEST", "CANCELLATION_REQUEST_FAILED"),
  // ORDER_HANDSHAKE (Plataforma de Negociação) — tratados no Checkpoint D
  HSD: g("ORDER_HANDSHAKE", "HANDSHAKE_DISPUTE"),
  HSS: g("ORDER_HANDSHAKE", "HANDSHAKE_SETTLEMENT"),
  // DELIVERY
  ADR: g("DELIVERY", "ASSIGN_DRIVER"), GTO: g("DELIVERY", "GOING_TO_ORIGIN"),
  AAO: g("DELIVERY", "ARRIVED_AT_ORIGIN"), DDD: g("DELIVERY", "DELIVERY_DRIVER_DEALLOCATED"),
  CLT: g("DELIVERY", "COLLECTED"), AAD: g("DELIVERY", "ARRIVED_AT_DESTINATION"),
  DRGO: g("DELIVERY", "DELIVERY_RETURNING_TO_ORIGIN"), DRDO: g("DELIVERY", "DELIVERY_RETURNED_TO_ORIGIN"),
  DCR: g("DELIVERY", "DELIVERY_CANCELLATION_REQUESTED"), DDCR: g("DELIVERY", "DELIVERY_DROP_CODE_REQUESTED"),
  DDCS: g("DELIVERY", "DELIVERY_DROP_CODE_VALIDATION_SUCCESS"), DRCR: g("DELIVERY", "DELIVERY_RETURN_CODE_REQUESTED"),
  DPCR: g("DELIVERY", "DELIVERY_PICKUP_CODE_REQUESTED"), DPCS: g("DELIVERY", "DELIVERY_PICKUP_CODE_VALIDATION_SUCCESS"),
  // DELIVERY_ADDRESS
  DAR: g("DELIVERY_ADDRESS", "DELIVERY_ADDRESS_CHANGE_REQUESTED"), DAU: g("DELIVERY_ADDRESS", "DELIVERY_ADDRESS_CHANGE_USER_CONFIRMED"),
  DAA: g("DELIVERY_ADDRESS", "DELIVERY_ADDRESS_CHANGE_ACCEPTED"), DAD: g("DELIVERY_ADDRESS", "DELIVERY_ADDRESS_CHANGE_DENIED"),
  // DELIVERY_GROUP
  DGA: g("DELIVERY_GROUP", "DELIVERY_GROUP_ASSIGNED"), DGD: g("DELIVERY_GROUP", "DELIVERY_GROUP_DISMISSED"),
  DGAC: g("DELIVERY_GROUP", "DELIVERY_GROUP_ASSOCIATED"), DGDC: g("DELIVERY_GROUP", "DELIVERY_GROUP_DISSOCIATED"),
  DGU: g("DELIVERY_GROUP", "DELIVERY_GROUP_UPDATED"),
  // DELIVERY_ONDEMAND
  RDR: g("DELIVERY_ONDEMAND", "REQUEST_DRIVER"), RDS: g("DELIVERY_ONDEMAND", "REQUEST_DRIVER_SUCCESS"),
  RDF: g("DELIVERY_ONDEMAND", "REQUEST_DRIVER_FAILED"),
  DCRA: g("DELIVERY_ONDEMAND", "DELIVERY_CANCELLATION_REQUEST_ACCEPTED"), DCRR: g("DELIVERY_ONDEMAND", "DELIVERY_CANCELLATION_REQUEST_REJECTED"),
  // DELIVERY_COMPLEMENT
  RTS: g("DELIVERY_COMPLEMENT", "RETURN_TO_STORE"),
  // OUTROS
  OPA: g("OUTROS", "ORDER_PATCHED"), RPS: g("OUTROS", "RECOMMENDED_PREPARATION_START"),
  PRS: g("OUTROS", "PREPARATION_STARTED"), CPR: g("OUTROS", "CONSUMER_PREPARATION_TIME_REQUESTED"),
  CPT: g("OUTROS", "CHANGE_PREPARATION_TIME"), BOA: g("OUTROS", "BOX_ASSIGNED"), RFI: g("OUTROS", "READY_FOR_INVOICE"),
});

/** Classificação de um código: `{ conhecido, grupo, status }`. */
export function classificarCodigo(code) {
  const c = CATALOGO_EVENTOS[String(code ?? "")];
  return c ? { conhecido: true, grupo: c.grupo, status: c.status } : { conhecido: false, grupo: null, status: null };
}

/** JSON estável (chaves ordenadas) — base do hash do payload. */
export function jsonEstavel(valor) {
  if (valor === null || typeof valor !== "object") return JSON.stringify(valor);
  if (Array.isArray(valor)) return `[${valor.map(jsonEstavel).join(",")}]`;
  return `{${Object.keys(valor).sort().map((k) => `${JSON.stringify(k)}:${jsonEstavel(valor[k])}`).join(",")}}`;
}

export function hashDoPayload(payload) {
  return createHash("sha256").update(jsonEstavel(payload)).digest("hex");
}

const texto = (v, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/**
 * Evento cru do polling -> forma normalizada.
 * @returns {{valido: true, evento: object} | {valido: false, motivo: string}}
 */
export function normalizarEvento(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { valido: false, motivo: "não é um objeto" };
  const eventId = texto(raw.id, 100);
  if (!eventId) return { valido: false, motivo: "sem id (não pode ser reconhecido)" };

  const criado = raw.createdAt ? new Date(raw.createdAt) : null;
  const codigo = texto(raw.code, 40) ?? "UNKNOWN";
  return {
    valido: true,
    evento: {
      eventId,
      merchantId: texto(raw.merchantId, 100) ?? "UNKNOWN",
      orderId: texto(raw.orderId, 100),
      code: codigo,
      fullCode: texto(raw.fullCode, 100) ?? "UNKNOWN",
      salesChannel: texto(raw.salesChannel, 60),
      createdAt: criado && !Number.isNaN(criado.getTime()) ? criado.toISOString() : null,
      metadata: raw.metadata && typeof raw.metadata === "object" ? raw.metadata : null,
      payload: raw,
      payloadHash: hashDoPayload(raw),
      classificacao: classificarCodigo(codigo),
    },
  };
}

/** Ordena por createdAt (a API pode entregar fora de ordem). Estável; sem data vai primeiro. */
export function ordenarPorCriacao(eventos) {
  return eventos
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const ta = a.e.createdAt ? Date.parse(a.e.createdAt) : -Infinity;
      const tb = b.e.createdAt ? Date.parse(b.e.createdAt) : -Infinity;
      return ta === tb ? a.i - b.i : ta < tb ? -1 : 1;
    })
    .map((x) => x.e);
}
