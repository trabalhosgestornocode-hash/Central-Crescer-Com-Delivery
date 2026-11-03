// Pedidos SINTÉTICOS no formato da API Foody v1.2 (inclusive os campos não documentados vistos no JSON real). Nenhum dado
// real: nomes, telefones e endereços são fictícios e existem só para provar que o saneamento os descarta.
let seq = 0;
export function pedidoApi(o = {}) {
  seq++;
  const temEntregador = o.entregador !== null;
  return {
    uid: o.uid ?? `uid-${seq}`,
    id: o.id ?? String(1000 + seq),
    status: o.status ?? "closed",
    date: o.date ?? "2026-10-25T12:00:00-03:00",
    creationDate: o.date ?? "2026-10-25T12:00:00-03:00",
    acceptanceDate: o.acceptanceDate ?? null,
    readyDate: o.readyDate ?? null,
    despatchDate: o.despatchDate ?? null,
    collectedDate: o.collectedDate ?? null,
    deliveryDate: o.deliveryDate ?? null,
    closedDate: o.closedDate ?? null,
    cancelledDate: o.cancelledDate ?? null,
    deliveryDueDate: o.deliveryDueDate ?? null,
    cancellationReason: o.cancellationReason ?? null,
    cancellationText: o.cancellationText ?? null,
    courierFee: o.courierFee ?? 10,
    deliveryFee: o.deliveryFee ?? 5,
    orderTotal: o.orderTotal ?? 50,
    paymentMethod: o.paymentMethod ?? "online",
    despatchMode: "manual",
    orderDetails: o.orderDetails ?? "1x Sub Frango Teriyaki 15cm",
    notes: "Interfone 12, falar com Maria Fictícia",
    orderTrackerUrl: "https://exemplo.invalid/rastreio/abc",
    ifoodLocalizer: "",
    courier: temEntregador ? { courierName: o.entregador ?? "Entregador Ficticio A", courierPhone: "+55 11 90000-0000", courierType: o.courierType ?? "internal" } : null,
    collectionPoint: { name: o.pontoColeta ?? "Subway Saci", address: { streetName: "Rua Fictícia", streetNumber: "1" } },
    customer: { customerName: "Cliente Fictício", customerPhone: "+55 11 98888-0000", customerEmail: "cliente@exemplo.invalid" },
    deliveryPoint: { address: "Rua do Cliente Fictício, 99", coordinates: { lat: -23.5, lng: -46.6 }, complement: "ap 1" },
    campoNovoQualquer: "ignorar",
  };
}
export const ORG_A = "11111111-1111-4111-8111-111111111111";
export const UNI_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const ORG_B = "22222222-2222-4222-8222-222222222222";
export const UNI_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const SEGREDO_TESTE = "segredo-de-teste-local-com-mais-de-32-caracteres";
export const TOKEN_TESTE = "tok_TESTE_nao_real_0123456789abcdef";
