// Order Details do iFood — interpretação do `GET /order/v1.0/orders/{id}`.
//
// Fonte: portal iFood, Order > "Detalhes de pedido" (conferido em 2026-09-27).
//
// PRINCÍPIOS
//   * O payload bruto é preservado INTEIRO (`payload`) + hash estável: nada do que o iFood manda
//     é descartado. Os campos extraídos são um ÍNDICE OPERACIONAL, não um substituto.
//   * Itens, complementos e customizações ficam como o iFood enviou (`items`), sem achatar.
//   * Tolerante: campo ausente = null; campo com tipo inesperado = null + aviso. Só é INVÁLIDO
//     o que impede o uso seguro: não ser objeto, sem `id`, `id` diferente do pedido consultado, ou
//     `merchant.id` diferente do merchant do pedido local (proteção multi-tenant).
//   * Dados pessoais (customer, endereço) ficam só em colunas jsonb de tabela backend-only (RLS
//     deny-all) e NUNCA vão para log.

import { hashDoPayload } from "./ifoodEvents.parser.js";

const texto = (v, max = 500) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const numero = (v) => (typeof v === "number" && Number.isFinite(v) ? v : (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null));
const dataIso = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const objeto = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
const lista = (v) => (Array.isArray(v) ? v : null);
const unicos = (xs) => [...new Set(xs.filter(Boolean))];

export const TIPOS_PEDIDO = Object.freeze(["DELIVERY", "TAKEOUT", "DINE_IN", "INDOOR"]);

/**
 * Resumo de pagamentos: métodos, bandeiras, troco e o que já foi pago / falta cobrar.
 * Mantém `payments` inteiro à parte (o resumo é só para consulta rápida).
 */
export function resumirPagamentos(payments) {
  const p = objeto(payments);
  const metodos = lista(p?.methods) ?? [];
  const nomes = unicos(metodos.map((m) => texto(m?.method, 40)?.toUpperCase()));
  const bandeiras = unicos(metodos.map((m) => texto(m?.card?.brand, 60)));
  const trocos = metodos.map((m) => numero(m?.cash?.changeFor)).filter((n) => n !== null);
  return {
    payment_methods: nomes,
    card_brands: bandeiras,
    cash_change_for: trocos.length ? Math.max(...trocos) : null,
    payment_prepaid: numero(p?.prepaid),
    payment_pending: numero(p?.pending),
    has_offline_payment: metodos.some((m) => String(m?.type ?? "").toUpperCase() === "OFFLINE"),
  };
}

/** Quem financia o desconto: soma de `sponsorshipValues` por patrocinador (IFOOD, MERCHANT, EXTERNAL, CHAIN). */
export function resumirPatrocinioDescontos(benefits) {
  const porPatrocinador = {};
  for (const b of lista(benefits) ?? []) {
    for (const s of lista(b?.sponsorshipValues) ?? []) {
      const nome = texto(s?.name, 40);
      const valor = numero(s?.value);
      if (nome && valor !== null) porPatrocinador[nome] = Math.round(((porPatrocinador[nome] ?? 0) + valor) * 100) / 100;
    }
  }
  return porPatrocinador;
}

/**
 * @param {any} raw corpo do GET /orders/{id}
 * @param {{orderIdEsperado?: string, merchantIdEsperado?: string}} [esperado]
 * @returns {{valido: true, pedido: object, payload: object, payloadHash: string, avisos: string[]}
 *          | {valido: false, motivo: string}}
 */
export function interpretarPedido(raw, { orderIdEsperado, merchantIdEsperado } = {}) {
  const r = objeto(raw);
  if (!r) return { valido: false, motivo: "payload não é um objeto" };
  const id = texto(r.id, 100);
  if (!id) return { valido: false, motivo: "payload sem id" };
  if (orderIdEsperado && id !== orderIdEsperado) return { valido: false, motivo: "id do payload diferente do pedido consultado" };

  const merchantNoPayload = texto(objeto(r.merchant)?.id, 100);
  if (merchantIdEsperado && merchantNoPayload && merchantNoPayload !== merchantIdEsperado) {
    return { valido: false, motivo: "merchant do payload diferente do merchant do pedido local" };
  }

  const avisos = [];
  const tipo = texto(r.orderType ?? r.type, 20)?.toUpperCase() ?? null;
  if (!tipo) avisos.push("sem orderType");
  else if (!TIPOS_PEDIDO.includes(tipo)) avisos.push(`orderType desconhecido: ${tipo}`);

  const itens = lista(r.items);
  if (r.items !== undefined && r.items !== null && !itens) avisos.push("items não é uma lista");
  if (!itens || itens.length === 0) avisos.push("pedido sem itens");
  for (const [i, it] of (itens ?? []).entries()) {
    if (!objeto(it)) { avisos.push(`item ${i} inválido`); continue; }
    if (numero(it.quantity) === null) avisos.push(`item ${i} sem quantity`);
  }

  const total = objeto(r.total);
  const cliente = objeto(r.customer);
  const entrega = objeto(r.delivery);
  const retirada = objeto(r.takeout);
  const agenda = objeto(r.schedule) ?? objeto(objeto(r.scheduled)?.schedule);
  const pagamentos = resumirPagamentos(r.payments);
  const beneficios = lista(r.benefits);

  const pedido = {
    order_id: id,
    merchant_id_payload: merchantNoPayload,
    display_id: texto(r.displayId, 60),
    order_type: tipo,
    order_timing: texto(r.orderTiming, 20)?.toUpperCase() ?? null,
    category: texto(r.category, 40),
    sales_channel: texto(r.salesChannel, 60),
    is_test: typeof r.isTest === "boolean" ? r.isTest : (typeof r.test === "boolean" ? r.test : null),
    order_created_at: dataIso(r.createdAt),
    preparation_start_at: dataIso(r.preparationStartDateTime),
    scheduled_start_at: dataIso(agenda?.deliveryDateTimeStart),
    scheduled_end_at: dataIso(agenda?.deliveryDateTimeEnd),
    delivery_by: texto(entrega?.deliveredBy, 20),
    pickup_code: texto(entrega?.pickupCode, 40),
    delivery_observations: texto(entrega?.observations, 1000),
    takeout_observations: texto(retirada?.observations, 1000),
    extra_info: texto(r.extraInfo, 1000),

    total_sub_total: numero(total?.subTotal),
    total_delivery_fee: numero(total?.deliveryFee),
    total_additional_fees: numero(total?.additionalFees),
    total_benefits: numero(total?.benefits),
    total_order_amount: numero(total?.orderAmount),

    ...pagamentos,
    discount_sponsors: resumirPatrocinioDescontos(beneficios),

    customer_document_number: texto(cliente?.documentNumber, 40),
    customer_document_type: texto(cliente?.documentType, 30),

    items_count: itens ? itens.length : 0,
    // Preservados como o iFood enviou (sem achatar): itens/complementos/customizações, benefícios, pagamentos, etc.
    items: itens,
    benefits: beneficios,
    payments: objeto(r.payments),
    customer: cliente,
    delivery: entrega,
    takeout: retirada,
    dine_in: objeto(r.dineIn),
    indoor: objeto(r.indoor),
    schedule: agenda,
    additional_fees: lista(r.additionalFees),
    additional_info: objeto(r.additionalInfo),
  };

  return { valido: true, pedido, payload: r, payloadHash: hashDoPayload(r), avisos };
}
