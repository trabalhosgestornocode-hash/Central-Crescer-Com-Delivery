// Order do iFood (Checkpoint C): parser dos detalhes, cliente HTTP (fetch FALSO), persistência
// idempotente, multi-tenant, máquina de estados (evento oficial x ação local) e confirm.
//
// Rodar: node --experimental-vm-modules --test test/ifood-order-details-confirm.test.js
import test from "node:test";
import assert from "node:assert/strict";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";

const httpReal = await import("../src/modules/ifood/ifoodHttp.client.js");
const { IFOOD_ERROS, ifoodErro } = await import("../src/modules/ifood/ifood.errors.js");
const { IFOOD_ORDER, IFOOD_ROTAS } = await import("../src/modules/ifood/ifood.constants.js");
const { interpretarPedido } = await import("../src/modules/ifood/ifoodOrder.parser.js");
const orderClientReal = await import("../src/modules/ifood/ifoodOrder.client.js");
const {
  buscarEPersistirDetalhes, processarDetalhesPendentes, detalhesDevidos, confirmarPedido, calcularSla,
} = await import("../src/modules/ifood/ifoodOrder.service.js");
const { processarLote } = await import("../src/modules/ifood/ifoodEvents.service.js");
const { criarPoller } = await import("../src/modules/ifood/ifoodEvents.poller.js");
const eventsClientReal = await import("../src/modules/ifood/ifoodEvents.client.js");
const {
  criarRepoEmMemoria, criarRelogio, criarTokenFake, criarClienteFake, ev, t,
  ORG_A, UN_A, ORG_B, UN_B, M_A, M_B, CONEXAO_A, CONEXAO_B, pilotoDe
} = await import("./helpers/ifood-events-fakes.js");

const silencio = () => {};
const ORDER = "order-1";

// ---------------------------------------------------------------------------
// Payload realista de Order Details (campos do portal oficial, 2026-09-27)
// ---------------------------------------------------------------------------
function detalhesCompletos(orderId = ORDER, merchantId = M_A) {
  return {
    id: orderId, displayId: "1234", orderType: "DELIVERY", orderTiming: "IMMEDIATE", salesChannel: "IFOOD",
    category: "FOOD", createdAt: t(0), preparationStartDateTime: t(1), isTest: true, extraInfo: "Sem talheres",
    merchant: { id: merchantId, name: "Loja Teste" },
    customer: {
      id: "cli-1", name: "Cliente Sigiloso", documentNumber: "12345678909", documentType: "CPF", ordersCountOnMerchant: 3,
      phone: { number: "0800123456", localizer: "12345678", localizerExpiration: t(120) },
    },
    items: [
      {
        index: 1, id: "it-1", uniqueId: "u-1", name: "Sub 30cm", type: "DEFAULT", quantity: 2, unit: "UN",
        unitPrice: 25, optionsPrice: 6, totalPrice: 56, price: 50, observations: "sem cebola",
        options: [
          { index: 1, id: "op-1", name: "Queijo extra", groupName: "Adicionais", type: "DEFAULT", quantity: 1, unitPrice: 3, addition: 0, price: 3, customization: [] },
          { index: 2, id: "op-2", name: "Bacon", groupName: "Adicionais", type: "DEFAULT", quantity: 1, unitPrice: 3, addition: 0, price: 3 },
        ],
      },
      { index: 2, id: "it-2", name: "Refri", type: "DEFAULT", quantity: 1, unit: "UN", unitPrice: 6, price: 6, totalPrice: 6, observations: "" },
    ],
    benefits: [{
      value: 10, target: "CART", targetId: null, campaign: { id: "c1", name: "Cupom" },
      sponsorshipValues: [{ name: "IFOOD", value: 6, description: "iFood" }, { name: "MERCHANT", value: 4, description: "Loja" }],
    }],
    additionalFees: [{ type: "SMALL_ORDER_FEE", description: "Taxa pedido pequeno", value: 2 }],
    total: { subTotal: 62, deliveryFee: 5, additionalFees: 2, benefits: 10, orderAmount: 59 },
    payments: {
      prepaid: 30, pending: 29,
      methods: [
        { value: 30, currency: "BRL", type: "ONLINE", method: "CREDIT", prepaid: true, card: { brand: "VISA" } },
        { value: 29, currency: "BRL", type: "OFFLINE", method: "CASH", prepaid: false, cash: { changeFor: 50 } },
      ],
    },
    delivery: {
      mode: "DEFAULT", deliveredBy: "IFOOD", pickupCode: "4321", deliveryDateTime: t(40), observations: "Portão azul",
      deliveryAddress: { streetName: "Rua X", coordinates: { latitude: -5.1, longitude: -42.8 } },
    },
    additionalInfo: { metadata: { origem: "app" } },
  };
}

// ---------------------------------------------------------------------------
// Fakes: fetch (HTTP real do cliente), cliente de Order, token
// ---------------------------------------------------------------------------
function fetchFalso(respostas) {
  const chamadas = [];
  const fila = [...respostas];
  let ultima = respostas.at(-1);
  const impl = async (url, opts) => {
    chamadas.push({ url, method: opts?.method, headers: opts?.headers, body: opts?.body });
    if (fila.length) ultima = fila.shift();
    const r = ultima;
    if (r.erroRede) throw new Error("ECONNRESET");
    if (r.timeout) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
    return {
      ok: r.status >= 200 && r.status < 300, status: r.status,
      headers: { get: (h) => (h.toLowerCase() === "content-type" ? (r.contentType ?? "application/json") : h.toLowerCase() === "retry-after" ? (r.retryAfter ?? null) : null) },
      text: async () => (typeof r.corpo === "string" ? r.corpo : JSON.stringify(r.corpo ?? {})),
    };
  };
  return { chamadas, impl };
}
const httpComFetch = (impl) => ({
  getJson: (c, o) => httpReal.getJson(c, { ...o, fetchImpl: impl }),
  postJson: (c, b, o) => httpReal.postJson(c, b, { ...o, fetchImpl: impl }),
});

/** Cliente de Order programável (fila de respostas por método). */
function orderClientFake({ detalhes = [], confirms = [], aoConfirmar } = {}) {
  const chamadas = { detalhes: [], confirm: [] };
  return {
    chamadas,
    async buscarDetalhesPedido({ accessToken, orderId }) {
      chamadas.detalhes.push({ accessToken, orderId });
      const r = detalhes.length > 1 ? detalhes.shift() : detalhes[0];
      if (r instanceof Error) throw r;
      return structuredClone(r);
    },
    async confirmarPedido({ accessToken, orderId }) {
      chamadas.confirm.push({ accessToken, orderId });
      await aoConfirmar?.();
      const r = confirms.length > 1 ? confirms.shift() : (confirms[0] ?? { status: 202, aceito: true });
      if (r instanceof Error) throw r;
      return r;
    },
  };
}
const erro = (codigo, detalhes) => ifoodErro(IFOOD_ERROS[codigo], detalhes ? { detalhes } : undefined);

async function ambiente({ conexoes } = {}) {
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio, ...(conexoes ? { conexoes } : {}) });
  const token = criarTokenFake({ escopo: "app" });
  const mapa = new Map(repo.conexoes.map((c) => [c.merchant_id, c]));
  const eventos = (brutos, { conexoesPorMerchant = mapa } = {}) =>
    processarLote({ eventosBrutos: brutos, conexoesPorMerchant, repo, agora: relogio.agora, log: silencio });
  return { relogio, repo, token, mapa, eventos };
}
const dep = (a, client, extra = {}) => ({ repo: a.repo, token: a.token, client, agora: a.relogio.agora, log: silencio, ...extra });
const pedidoDe = (a, orderId = ORDER) => a.repo.pedidos.get(orderId);

// ===========================================================================
// 1) PARSER
// ===========================================================================
test("parser: payload completo — preserva itens, complementos, observações, pagamento, descontos e fiscal", () => {
  const raw = detalhesCompletos();
  const r = interpretarPedido(raw, { orderIdEsperado: ORDER, merchantIdEsperado: M_A });
  assert.equal(r.valido, true);
  const p = r.pedido;
  assert.equal(p.order_id, ORDER);
  assert.equal(p.merchant_id_payload, M_A);
  assert.equal(p.display_id, "1234");
  assert.equal(p.order_type, "DELIVERY");
  assert.equal(p.order_timing, "IMMEDIATE");
  assert.equal(p.order_created_at, t(0));
  assert.equal(p.is_test, true);
  assert.equal(p.pickup_code, "4321");
  assert.equal(p.delivery_observations, "Portão azul");
  assert.equal(p.delivery_by, "IFOOD");
  assert.equal(p.extra_info, "Sem talheres");
  // itens / complementos / quantidades / observações — sem achatar
  assert.equal(p.items_count, 2);
  assert.equal(p.items[0].quantity, 2);
  assert.equal(p.items[0].observations, "sem cebola");
  assert.deepEqual(p.items[0].options.map((o) => o.name), ["Queijo extra", "Bacon"]);
  assert.equal(p.items[0].options[0].groupName, "Adicionais");
  // pagamento
  assert.deepEqual(p.payment_methods, ["CREDIT", "CASH"]);
  assert.deepEqual(p.card_brands, ["VISA"]);
  assert.equal(p.cash_change_for, 50);
  assert.equal(p.has_offline_payment, true);
  assert.equal(p.payment_prepaid, 30);
  assert.equal(p.payment_pending, 29);
  // descontos e quem paga
  assert.equal(p.total_benefits, 10);
  assert.deepEqual(p.discount_sponsors, { IFOOD: 6, MERCHANT: 4 });
  assert.equal(p.benefits[0].target, "CART");
  // totais
  assert.equal(p.total_order_amount, 59);
  assert.equal(p.total_delivery_fee, 5);
  // fiscal
  assert.equal(p.customer_document_number, "12345678909");
  assert.equal(p.customer_document_type, "CPF");
  // bruto + hash
  assert.deepEqual(r.payload, raw);
  assert.match(r.payloadHash, /^[0-9a-f]{64}$/);
  assert.equal(interpretarPedido(structuredClone(raw)).payloadHash, r.payloadHash, "hash estável");
  assert.deepEqual(r.avisos, []);
});

test("parser: aceita variantes do portal (`type`/`test`) e agendamento (SCHEDULED)", () => {
  const raw = { ...detalhesCompletos(), orderType: undefined, type: "TAKEOUT", isTest: undefined, test: false, orderTiming: "SCHEDULED",
    schedule: { deliveryDateTimeStart: t(60), deliveryDateTimeEnd: t(90) } };
  const r = interpretarPedido(raw, { orderIdEsperado: ORDER });
  assert.equal(r.valido, true);
  assert.equal(r.pedido.order_type, "TAKEOUT");
  assert.equal(r.pedido.is_test, false);
  assert.equal(r.pedido.order_timing, "SCHEDULED");
  assert.equal(r.pedido.scheduled_start_at, t(60));
  assert.equal(r.pedido.scheduled_end_at, t(90));
});

test("parser: payload inesperado é rejeitado ou tolerado com aviso — nunca lança", () => {
  for (const ruim of [null, undefined, "texto", 42, [], [{ id: "x" }], {}, { id: "" }]) {
    const r = interpretarPedido(ruim, { orderIdEsperado: ORDER });
    assert.equal(r.valido, false, JSON.stringify(ruim));
    assert.ok(r.motivo);
  }
  assert.equal(interpretarPedido({ id: "outro" }, { orderIdEsperado: ORDER }).valido, false, "id diferente do consultado");
  // merchant do payload diferente do merchant do pedido local: recusa (multi-tenant)
  const m = interpretarPedido(detalhesCompletos(ORDER, M_B), { orderIdEsperado: ORDER, merchantIdEsperado: M_A });
  assert.equal(m.valido, false);
  // campos com tipo errado: tolera, vira null/aviso
  const t1 = interpretarPedido({ id: ORDER, items: "não é lista", total: "x", payments: [], orderType: "ALIEN", createdAt: "ontem" }, { orderIdEsperado: ORDER });
  assert.equal(t1.valido, true);
  assert.equal(t1.pedido.order_created_at, null);
  assert.equal(t1.pedido.total_order_amount, null);
  assert.equal(t1.pedido.items_count, 0);
  assert.ok(t1.avisos.some((a) => /orderType desconhecido/.test(a)));
  assert.ok(t1.avisos.some((a) => /items não é uma lista/.test(a)));
  const t2 = interpretarPedido({ id: ORDER, orderType: "DELIVERY", items: [{ name: "sem quantity" }, "lixo"] }, { orderIdEsperado: ORDER });
  assert.ok(t2.avisos.some((a) => /sem quantity/.test(a)));
  assert.ok(t2.avisos.some((a) => /item 1 inválido/.test(a)));
});

// ===========================================================================
// 2) CLIENTE HTTP (fetch falso) — Order Details
// ===========================================================================
test("HTTP detalhes: 200 válido — GET no path oficial com Bearer", async () => {
  const f = fetchFalso([{ status: 200, corpo: detalhesCompletos() }]);
  const r = await orderClientReal.buscarDetalhesPedido({ accessToken: "tok", orderId: ORDER, http: httpComFetch(f.impl) });
  assert.equal(r.id, ORDER);
  assert.equal(f.chamadas[0].url, `https://mock.ifood.test${IFOOD_ROTAS.orderDetalhes(ORDER)}`);
  assert.equal(f.chamadas[0].url, "https://mock.ifood.test/order/v1.0/orders/order-1");
  assert.equal(f.chamadas[0].method, "GET");
  assert.equal(f.chamadas[0].headers.Authorization, "Bearer tok");
});

test("HTTP detalhes: pedido inexistente (404) -> IFOOD_PEDIDO_NAO_ENCONTRADO, sem retry", async () => {
  const f = fetchFalso([{ status: 404, corpo: {} }]);
  await assert.rejects(orderClientReal.buscarDetalhesPedido({ accessToken: "t", orderId: ORDER, http: httpComFetch(f.impl) }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_PEDIDO_NAO_ENCONTRADO && e.statusCode === 404);
  assert.equal(f.chamadas.length, 1);
});

test("HTTP detalhes: 401 -> IFOOD_TOKEN_EXPIRADO, sem retry", async () => {
  const f = fetchFalso([{ status: 401 }]);
  await assert.rejects(orderClientReal.buscarDetalhesPedido({ accessToken: "t", orderId: ORDER, http: httpComFetch(f.impl) }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO);
  assert.equal(f.chamadas.length, 1);
});

test("HTTP detalhes: 429 persistente -> IFOOD_RATE_LIMITED (com retentativas)", async () => {
  const f = fetchFalso([{ status: 429, retryAfter: "0" }]);
  await assert.rejects(orderClientReal.buscarDetalhesPedido({ accessToken: "t", orderId: ORDER, http: httpComFetch(f.impl) }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_RATE_LIMITED);
  assert.ok(f.chamadas.length > 1);
});

test("HTTP detalhes: 5xx persistente -> IFOOD_INDISPONIVEL", async () => {
  const f = fetchFalso([{ status: 503 }]);
  await assert.rejects(orderClientReal.buscarDetalhesPedido({ accessToken: "t", orderId: ORDER, http: httpComFetch(f.impl) }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_INDISPONIVEL);
  assert.ok(f.chamadas.length > 1);
});

test("HTTP detalhes: timeout (AbortError) -> IFOOD_INDISPONIVEL", async () => {
  const f = fetchFalso([{ timeout: true }]);
  await assert.rejects(orderClientReal.buscarDetalhesPedido({ accessToken: "t", orderId: ORDER, http: httpComFetch(f.impl) }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_INDISPONIVEL && e.details?.motivo === "timeout");
});

test("HTTP detalhes: orderId vazio/absurdo nem chega à rede", async () => {
  const f = fetchFalso([{ status: 200, corpo: {} }]);
  for (const id of ["", "  ", null, undefined, "x".repeat(101)]) {
    await assert.rejects(orderClientReal.buscarDetalhesPedido({ accessToken: "t", orderId: id, http: httpComFetch(f.impl) }));
  }
  assert.equal(f.chamadas.length, 0);
});

test("HTTP detalhes: orderId é codificado no path (sem injeção de rota)", async () => {
  const f = fetchFalso([{ status: 200, corpo: {} }]);
  await orderClientReal.buscarDetalhesPedido({ accessToken: "t", orderId: "a/../b?x=1", http: httpComFetch(f.impl) });
  assert.equal(f.chamadas[0].url, "https://mock.ifood.test/order/v1.0/orders/a%2F..%2Fb%3Fx%3D1");
});

// ===========================================================================
// 3) CLIENTE HTTP — Confirm
// ===========================================================================
test("HTTP confirm: POST no path oficial, SEM corpo, Bearer; 202 ACCEPTED -> {status:202, aceito:true}", async () => {
  const f = fetchFalso([{ status: 202, corpo: { status: "ACCEPTED" } }]);
  const r = await orderClientReal.confirmarPedido({ accessToken: "tok", orderId: ORDER, http: httpComFetch(f.impl) });
  assert.deepEqual(r, { status: 202, aceito: true });
  const c = f.chamadas[0];
  assert.equal(c.url, "https://mock.ifood.test/order/v1.0/orders/order-1/confirm");
  assert.equal(c.method, "POST");
  assert.equal(c.body, undefined, "confirm não envia corpo");
  assert.equal(c.headers.Authorization, "Bearer tok");
  assert.equal(c.headers["Content-Type"], "application/json");
});

test("HTTP confirm: 202 com corpo vazio também é aceito; 200 sem ACCEPTED não é", async () => {
  const a = await orderClientReal.confirmarPedido({ accessToken: "t", orderId: ORDER, http: httpComFetch(fetchFalso([{ status: 202, corpo: "" }]).impl) });
  assert.equal(a.aceito, true);
  const b = await orderClientReal.confirmarPedido({ accessToken: "t", orderId: ORDER, http: httpComFetch(fetchFalso([{ status: 200, corpo: {} }]).impl) });
  assert.equal(b.aceito, false);
});

test("HTTP confirm: 401 / 404 / 409 / 422 / 5xx / timeout", async () => {
  const cod = async (resp) => orderClientReal.confirmarPedido({ accessToken: "t", orderId: ORDER, http: httpComFetch(fetchFalso([resp]).impl) })
    .then(() => null, (e) => e);
  assert.equal((await cod({ status: 401 })).codigo, IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO);
  assert.equal((await cod({ status: 404 })).codigo, IFOOD_ERROS.IFOOD_PEDIDO_NAO_ENCONTRADO);
  const e409 = await cod({ status: 409 });
  assert.equal(e409.codigo, IFOOD_ERROS.IFOOD_ACAO_PEDIDO_RECUSADA);
  assert.equal(e409.details.status, 409);
  assert.equal((await cod({ status: 422 })).codigo, IFOOD_ERROS.IFOOD_ACAO_PEDIDO_RECUSADA);
  assert.equal((await cod({ status: 503 })).codigo, IFOOD_ERROS.IFOOD_INDISPONIVEL);
  assert.equal((await cod({ timeout: true })).codigo, IFOOD_ERROS.IFOOD_INDISPONIVEL);
});

// ===========================================================================
// 4) DETALHES — persistência, idempotência, multi-tenant
// ===========================================================================
async function comPedidoPlaced(a, { orderId = ORDER, min = 0, merchantId = M_A } = {}) {
  await a.eventos([ev("e-plc", "PLC", { min, orderId, merchantId })]);
  return pedidoDe(a, orderId);
}

test("detalhes: busca, interpreta e persiste tudo (bruto + operacional) no pedido do tenant", async () => {
  const a = await ambiente();
  await comPedidoPlaced(a);
  a.relogio.avancarS(5);
  const client = orderClientFake({ detalhes: [detalhesCompletos()] });
  const r = await buscarEPersistirDetalhes({ pedido: pedidoDe(a), conexaoId: "con-a", ...dep(a, client) });
  assert.equal(r.resultado, "GRAVADO");

  const p = pedidoDe(a);
  assert.equal(p.details_status, "OK");
  assert.equal(p.details_tentativas, 1);
  assert.equal(p.details_fetched_at, a.relogio.agora().toISOString());
  assert.equal(p.display_id, "1234");
  assert.equal(p.pickup_code, "4321");
  assert.equal(p.items.length, 2);
  assert.deepEqual(p.details_payload, detalhesCompletos());
  assert.match(p.details_payload_hash, /^[0-9a-f]{64}$/);
  assert.equal(p.organizacao_id, ORG_A);
  assert.equal(p.unidade_id, UN_A);
  assert.equal(p.merchant_id, M_A);
  // token pedido como "order" pela interface comum
  assert.deepEqual(a.token.chamadas.at(-1), { conexaoId: "con-a", appType: "order" });
  // detalhes NÃO mexem no estado oficial
  assert.equal(p.status_oficial, "PLACED");
  assert.equal(p.action_state, "none");
});

test("persistência repetida: mesmo payload = SEM_MUDANCA (não regrava); payload novo = regrava e mantém 1ª busca", async () => {
  const a = await ambiente();
  await comPedidoPlaced(a);
  const client = orderClientFake({ detalhes: [detalhesCompletos()] });
  await buscarEPersistirDetalhes({ pedido: pedidoDe(a), conexaoId: "con-a", ...dep(a, client) });
  const primeiraBusca = pedidoDe(a).details_fetched_at;
  const atualizadoEm = pedidoDe(a).details_atualizado_em;

  a.relogio.avancarS(60);
  const r2 = await buscarEPersistirDetalhes({ pedido: pedidoDe(a), conexaoId: "con-a", ...dep(a, client) });
  assert.equal(r2.resultado, "SEM_MUDANCA");
  assert.equal(pedidoDe(a).details_atualizado_em, atualizadoEm, "nada regravado");
  assert.equal(a.repo.pedidos.size, 1, "continua um único pedido");

  // iFood devolve o pedido alterado (ex.: observação nova): regrava, sem perder a data da 1ª busca
  const alterado = detalhesCompletos();
  alterado.items[0].observations = "sem cebola e sem tomate";
  const c2 = orderClientFake({ detalhes: [alterado] });
  a.relogio.avancarS(60);
  const r3 = await buscarEPersistirDetalhes({ pedido: pedidoDe(a), conexaoId: "con-a", ...dep(a, c2) });
  assert.equal(r3.resultado, "GRAVADO");
  assert.equal(pedidoDe(a).items[0].observations, "sem cebola e sem tomate");
  assert.equal(pedidoDe(a).details_fetched_at, primeiraBusca);
});

test("detalhes: 404 -> NAO_ENCONTRADO com backoff exponencial; volta a ficar OK quando o iFood disponibiliza", async () => {
  const a = await ambiente();
  await comPedidoPlaced(a);
  const client = orderClientFake({ detalhes: [erro("IFOOD_PEDIDO_NAO_ENCONTRADO"), erro("IFOOD_PEDIDO_NAO_ENCONTRADO"), detalhesCompletos()] });
  const passo = () => processarDetalhesPendentes({ ...dep(a, client), conexoesPorMerchant: a.mapa });

  let r = await passo();
  assert.equal(r.naoEncontrados, 1);
  assert.equal(pedidoDe(a).details_status, "NAO_ENCONTRADO");
  assert.equal(pedidoDe(a).details_tentativas, 1);

  // dentro do backoff (2 s): não busca de novo
  a.relogio.avancarS(1);
  r = await passo();
  assert.equal(r.tentados, 0);
  assert.equal(client.chamadas.detalhes.length, 1);

  a.relogio.avancarS(2);                       // 3 s >= 2 s
  r = await passo();
  assert.equal(r.naoEncontrados, 1);
  assert.equal(pedidoDe(a).details_tentativas, 2);

  a.relogio.avancarS(3);                       // 3 s < 4 s (2ª espera dobra)
  assert.equal((await passo()).tentados, 0);
  a.relogio.avancarS(2);                       // 5 s >= 4 s
  r = await passo();
  assert.equal(r.gravados, 1);
  assert.equal(pedidoDe(a).details_status, "OK");
  assert.equal(pedidoDe(a).details_tentativas, 3);
});

test("detalhes: pura — janela de 10 min p/ 404, retenção de 7 dias, teto de tentativas, backoff com teto", () => {
  const agora = Date.parse("2026-09-27T12:00:00.000Z");
  const base = { details_status: "NAO_ENCONTRADO", details_tentativas: 3, details_ultima_tentativa_em: new Date(agora - 60_000).toISOString(),
    primeiro_evento_em: new Date(agora - 5 * 60_000).toISOString() };
  assert.equal(detalhesDevidos(base, agora), true);
  assert.equal(detalhesDevidos({ ...base, primeiro_evento_em: new Date(agora - 11 * 60_000).toISOString() }, agora), false, "404 além de 10 min: desiste");
  assert.equal(detalhesDevidos({ ...base, details_status: "ERRO", primeiro_evento_em: new Date(agora - 11 * 60_000).toISOString() }, agora), true, "erro transitório segue tentando");
  assert.equal(detalhesDevidos({ ...base, details_status: "ERRO", primeiro_evento_em: new Date(agora - 8 * 86_400_000).toISOString() }, agora), false, "além de 7 dias");
  assert.equal(detalhesDevidos({ ...base, details_tentativas: IFOOD_ORDER.maxTentativasDetalhes }, agora), false);
  assert.equal(detalhesDevidos({ ...base, details_status: "OK" }, agora), false);
  assert.equal(detalhesDevidos({ ...base, details_status: "PENDENTE", details_tentativas: 0, details_ultima_tentativa_em: null }, agora), true);
  // backoff tem teto
  const longo = { ...base, details_status: "ERRO", details_tentativas: 11, details_ultima_tentativa_em: new Date(agora - IFOOD_ORDER.detalhesBackoffMaxMs + 1000).toISOString() };
  assert.equal(detalhesDevidos(longo, agora), false);
  assert.equal(detalhesDevidos({ ...longo, details_ultima_tentativa_em: new Date(agora - IFOOD_ORDER.detalhesBackoffMaxMs).toISOString() }, agora), true);
});

test("detalhes: 401, 5xx e timeout viram ERRO reprocessável; 429 interrompe o passo", async () => {
  const a = await ambiente();
  await comPedidoPlaced(a);
  for (const codigo of ["IFOOD_TOKEN_EXPIRADO", "IFOOD_INDISPONIVEL"]) {
    const client = orderClientFake({ detalhes: [erro(codigo)] });
    const r = await buscarEPersistirDetalhes({ pedido: pedidoDe(a), conexaoId: "con-a", ...dep(a, client) });
    assert.equal(r.resultado, "ERRO");
    assert.equal(pedidoDe(a).details_status, "ERRO");
    assert.equal(pedidoDe(a).details_ultimo_erro, codigo);
  }
  // 429: para o passo (não insiste nos demais pedidos)
  await a.eventos([ev("e-plc2", "PLC", { min: 1, orderId: "order-2" })]);
  const client = orderClientFake({ detalhes: [erro("IFOOD_RATE_LIMITED")] });
  a.relogio.avancarS(600);
  const r = await processarDetalhesPendentes({ ...dep(a, client), conexoesPorMerchant: a.mapa });
  assert.equal(r.rateLimited, true);
  assert.equal(r.tentados, 1, "parou no primeiro 429");
});

test("detalhes: payload inválido (id trocado / merchant de outro tenant) NÃO é gravado", async () => {
  const a = await ambiente();
  await comPedidoPlaced(a);
  for (const bruto of [detalhesCompletos("order-OUTRO"), detalhesCompletos(ORDER, M_B), "não é json"]) {
    const client = orderClientFake({ detalhes: [bruto] });
    const r = await buscarEPersistirDetalhes({ pedido: pedidoDe(a), conexaoId: "con-a", ...dep(a, client) });
    assert.equal(r.resultado, "INVALIDO");
    assert.equal(pedidoDe(a).details_payload, null);
    assert.equal(pedidoDe(a).details_status, "ERRO");
    assert.equal(pedidoDe(a).display_id ?? null, null);
  }
});

test("MULTI-TENANT: detalhes só são buscados com a conexão do MESMO tenant do pedido; pedido de outra unidade não é tocado", async () => {
  const a = await ambiente();
  await comPedidoPlaced(a);                                                          // pedido da unidade A
  await a.eventos([ev("e-b", "PLC", { orderId: "order-b", merchantId: M_B })]);      // pedido da unidade B
  const client = orderClientFake({ detalhes: [detalhesCompletos()] });

  // mapa adulterado: merchant A apontando para a conexão da unidade B => recusa (sem token, sem chamada)
  const mapaErrado = new Map([[M_A, { ...CONEXAO_B }], [M_B, { ...CONEXAO_B }]]);
  const r = await processarDetalhesPendentes({ ...dep(a, client), conexoesPorMerchant: mapaErrado });
  assert.equal(r.semConexao, 1, "pedido de A com conexão de B: recusado");
  assert.equal(client.chamadas.detalhes.filter((c) => c.orderId === ORDER).length, 0);
  assert.equal(pedidoDe(a).details_tentativas, 0);
});

// ===========================================================================
// 5) CONFIRM — máquina de estados
// ===========================================================================
async function pronto(a, { detalhes = true } = {}) {
  await comPedidoPlaced(a);
  if (detalhes) await buscarEPersistirDetalhes({ pedido: pedidoDe(a), conexaoId: "con-a", ...dep(a, orderClientFake({ detalhes: [detalhesCompletos()] })) });
}
const conf = (a, client, extra = {}) => confirmarPedido({ organizacaoId: ORG_A, unidadeId: UN_A, orderId: ORDER, ...dep(a, client), ...extra });

test("confirm válido: 202 => action_state=confirm_requested; estado OFICIAL continua PLACED (202 não confirma)", async () => {
  const a = await ambiente();
  await pronto(a);
  a.relogio.avancarS(30);
  const client = orderClientFake({ confirms: [{ status: 202, aceito: true }] });
  const r = await conf(a, client);

  assert.equal(r.resultado, "SOLICITADO");
  assert.equal(r.httpStatus, 202);
  assert.equal(r.oficial, false);
  const p = pedidoDe(a);
  assert.equal(p.action_state, "confirm_requested");
  assert.equal(p.status_oficial, "PLACED", "NUNCA CONFIRMED só porque o iFood respondeu 202");
  assert.equal(p.confirm_http_status, 202);
  assert.equal(p.confirm_attempts, 1);
  assert.equal(p.confirm_requested_at, a.relogio.agora().toISOString());
  assert.equal(p.confirmed_event_at, null);
  assert.equal(client.chamadas.confirm.length, 1);
  assert.deepEqual(a.token.chamadas.at(-1), { conexaoId: "con-a", appType: "order" });
  assert.deepEqual(a.repo.acoes.map((x) => x.resultado), ["ACEITA_202"]);
});

test("confirm repetido: nenhum segundo POST (idempotente localmente)", async () => {
  const a = await ambiente();
  await pronto(a);
  const client = orderClientFake();
  await conf(a, client);
  const r2 = await conf(a, client);
  const r3 = await conf(a, client);
  assert.equal(r2.resultado, "JA_SOLICITADO");
  assert.equal(r3.resultado, "JA_SOLICITADO");
  assert.equal(client.chamadas.confirm.length, 1);
  assert.equal(pedidoDe(a).confirm_attempts, 1);
  assert.equal(pedidoDe(a).status_oficial, "PLACED");
});

test("confirm em estado inválido: sem pedido, sem estado oficial, CANCELLED, DISPATCHED -> recusado sem chamar o iFood", async () => {
  const a = await ambiente();
  const client = orderClientFake();
  // inexistente
  await assert.rejects(conf(a, client), (e) => e.codigo === IFOOD_ERROS.IFOOD_PEDIDO_LOCAL_NAO_ENCONTRADO);
  // esqueleto sem estado oficial (ex.: evento que não é de status)
  await a.eventos([ev("e-x", "CAR", { min: 0 })]);
  assert.equal(pedidoDe(a).status_oficial, null);
  await assert.rejects(conf(a, client), (e) => e.codigo === IFOOD_ERROS.IFOOD_PEDIDO_ESTADO_INVALIDO);

  for (const [code, esperado] of [["CAN", "CANCELLED"], ["DSP", "DISPATCHED"]]) {
    const b = await ambiente();
    await comPedidoPlaced(b);
    await b.eventos([ev(`e-${code}`, code, { min: 5 })]);
    assert.equal(pedidoDe(b).status_oficial, esperado);
    const c = orderClientFake();
    await assert.rejects(conf(b, c), (e) => e.codigo === IFOOD_ERROS.IFOOD_PEDIDO_ESTADO_INVALIDO && e.details.statusOficial === esperado);
    assert.equal(c.chamadas.confirm.length, 0);
  }
  assert.equal(client.chamadas.confirm.length, 0);
});

test("confirm em pedido já CONFIRMED (oficial): JA_CONFIRMADO_OFICIAL, sem POST", async () => {
  const a = await ambiente();
  await pronto(a);
  await a.eventos([ev("e-cfm", "CFM", { min: 2 })]);
  const client = orderClientFake();
  const r = await conf(a, client);
  assert.equal(r.resultado, "JA_CONFIRMADO_OFICIAL");
  assert.equal(r.oficial, true);
  assert.equal(client.chamadas.confirm.length, 0);
});

test("MULTI-TENANT: confirm com orderId de OUTRA unidade/organização = pedido inexistente; nada é enviado nem alterado", async () => {
  const a = await ambiente();
  await a.eventos([ev("e-b", "PLC", { orderId: "order-b", merchantId: M_B })]);   // pedido da unidade B
  const client = orderClientFake();
  await assert.rejects(
    confirmarPedido({ organizacaoId: ORG_A, unidadeId: UN_A, orderId: "order-b", ...dep(a, client) }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_PEDIDO_LOCAL_NAO_ENCONTRADO);
  await assert.rejects(   // mesma organização errada / unidade certa
    confirmarPedido({ organizacaoId: ORG_A, unidadeId: UN_B, orderId: "order-b", ...dep(a, client) }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_PEDIDO_LOCAL_NAO_ENCONTRADO);
  assert.equal(client.chamadas.confirm.length, 0);
  assert.equal(pedidoDe(a, "order-b").action_state, "none");
  // e o dono consegue
  const r = await confirmarPedido({ organizacaoId: ORG_B, unidadeId: UN_B, orderId: "order-b", ...dep(a, client) });
  assert.equal(r.resultado, "SOLICITADO");
  assert.equal(client.chamadas.confirm[0].orderId, "order-b");
});

test("confirm recusado pelo iFood (409/422) ou falha de rede: confirm_failed, erro propagado, e nova tentativa é permitida", async () => {
  const a = await ambiente();
  await pronto(a);
  const client = orderClientFake({ confirms: [erro("IFOOD_ACAO_PEDIDO_RECUSADA", { status: 409 }), erro("IFOOD_INDISPONIVEL"), { status: 202, aceito: true }] });

  await assert.rejects(conf(a, client), (e) => e.codigo === IFOOD_ERROS.IFOOD_ACAO_PEDIDO_RECUSADA);
  assert.equal(pedidoDe(a).action_state, "confirm_failed");
  assert.equal(pedidoDe(a).confirm_last_error, "IFOOD_ACAO_PEDIDO_RECUSADA");
  assert.equal(pedidoDe(a).confirm_http_status, 409);
  assert.equal(pedidoDe(a).status_oficial, "PLACED");

  await assert.rejects(conf(a, client), (e) => e.codigo === IFOOD_ERROS.IFOOD_INDISPONIVEL);
  assert.equal(pedidoDe(a).action_state, "confirm_failed");
  assert.equal(pedidoDe(a).confirm_attempts, 2);

  const r = await conf(a, client);
  assert.equal(r.resultado, "SOLICITADO");
  assert.equal(pedidoDe(a).action_state, "confirm_requested");
  assert.equal(pedidoDe(a).confirm_attempts, 3);
  assert.equal(pedidoDe(a).confirm_last_error, null);
  assert.deepEqual(a.repo.acoes.map((x) => x.resultado), ["RECUSADA", "FALHOU", "ACEITA_202"]);
});

test("confirm: 200 sem ACCEPTED não é sucesso (confirm_failed) e sem conexão viva não envia", async () => {
  const a = await ambiente();
  await pronto(a);
  const c1 = orderClientFake({ confirms: [{ status: 200, aceito: false }] });
  await assert.rejects(conf(a, c1), (e) => e.codigo === IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA);
  assert.equal(pedidoDe(a).action_state, "confirm_failed");

  a.repo.conexoes.length = 0;                       // conexão revogada
  const c2 = orderClientFake();
  await assert.rejects(conf(a, c2), (e) => e.codigo === IFOOD_ERROS.IFOOD_CONEXAO_NAO_ENCONTRADA);
  assert.equal(c2.chamadas.confirm.length, 0);
});

test("202 SEM evento posterior: permanece PLACED + confirm_requested e o SLA acusa estouro após 8 min", async () => {
  const a = await ambiente();
  await pronto(a);
  await conf(a, orderClientFake());
  // pedido criado no iFood em t(0)
  await a.repo.atualizarPedido({ pedido: pedidoDe(a), campos: { order_created_at: t(0) } });

  a.relogio.avancarS(7 * 60);
  let sla = calcularSla(pedidoDe(a), a.relogio.agoraMs());
  assert.equal(sla.situacao, "AGUARDANDO_EVENTO_CONFIRMED");
  assert.ok(sla.ms.restante_para_o_limite > 0);

  a.relogio.avancarS(2 * 60);                        // 9 min sem o evento
  sla = calcularSla(pedidoDe(a), a.relogio.agoraMs());
  assert.equal(sla.situacao, "SLA_ESTOURADO");
  assert.equal(pedidoDe(a).status_oficial, "PLACED", "sem evento, nada vira CONFIRMED");
  assert.equal(pedidoDe(a).action_state, "confirm_requested");
});

test("evento CONFIRMED depois do pedido: estado oficial vira CONFIRMED, ação resolvida e SLA medido", async () => {
  const a = await ambiente();
  await pronto(a);
  a.relogio.avancarS(40);
  await conf(a, orderClientFake());
  await a.repo.atualizarPedido({ pedido: pedidoDe(a), campos: { order_created_at: t(0) } });

  a.relogio.avancarS(3);
  await a.eventos([ev("e-cfm", "CFM", { min: 1 })]);      // createdAt do evento = t(1)
  const p = pedidoDe(a);
  assert.equal(p.status_oficial, "CONFIRMED");
  assert.equal(p.status_oficial_evento_id, "e-cfm");
  assert.equal(p.action_state, "none", "o evento oficial resolveu a espera");
  assert.equal(p.confirmed_event_at, t(1));
  assert.equal(p.confirmed_event_received_at, a.relogio.agora().toISOString());
  assert.equal(p.confirm_requested_at, new Date(Date.parse(t(0)) + 40_000).toISOString(), "histórico do pedido de confirm preservado");

  const sla = calcularSla(p, a.relogio.agoraMs());
  assert.equal(sla.situacao, "CONFIRMADO_NO_SLA");
  assert.equal(sla.ms.criacao_ate_confirmed, 60_000);
  assert.equal(sla.ms.criacao_ate_confirm_solicitado, 40_000);
  assert.equal(sla.ms.confirm_solicitado_ate_evento_confirmed, 20_000);
});

test("SLA: os cinco carimbos são gravados (order_created_at, event_received_at, details_fetched_at, confirm_requested_at, confirmed_event_at)", async () => {
  const a = await ambiente();
  await a.eventos([ev("e-plc", "PLC", { min: 0 })]);
  a.relogio.avancarS(4);
  const bruto = detalhesCompletos();                      // createdAt = t(0)
  await buscarEPersistirDetalhes({ pedido: pedidoDe(a), conexaoId: "con-a", ...dep(a, orderClientFake({ detalhes: [bruto] })) });
  a.relogio.avancarS(6);
  await conf(a, orderClientFake());
  a.relogio.avancarS(10);
  await a.eventos([ev("e-cfm", "CFM", { min: 0.5 })]);

  const p = pedidoDe(a);
  const ms = (x) => Date.parse(x);
  assert.equal(p.order_created_at, t(0));
  assert.equal(p.placed_event_created_at, t(0));
  assert.equal(ms(p.placed_event_received_at), BASE + 0);                   // recebido junto do lote (relógio na base)
  assert.equal(ms(p.details_fetched_at) - ms(p.placed_event_received_at), 4000);
  assert.equal(ms(p.confirm_requested_at) - ms(p.details_fetched_at), 6000);
  assert.equal(p.confirmed_event_at, t(0.5));
  const sla = calcularSla(p, a.relogio.agoraMs());
  assert.equal(sla.ms.evento_recebido_ate_detalhes, 4000);
  assert.equal(sla.ms.criacao_ate_confirmed, 30_000);
  assert.equal(sla.situacao, "CONFIRMADO_NO_SLA");
});
const BASE = Date.parse("2026-09-27T12:00:00.000Z");

test("evento CONFIRMED ANTES da leitura local (chega durante o POST): oficial CONFIRMED e a resposta 202 NÃO desfaz nem sobrescreve", async () => {
  const a = await ambiente();
  await pronto(a);
  const client = orderClientFake({
    aoConfirmar: () => a.eventos([ev("e-cfm", "CFM", { min: 1 })]),   // o evento é processado enquanto o POST está em voo
  });
  const r = await conf(a, client);
  const p = pedidoDe(a);
  assert.equal(p.status_oficial, "CONFIRMED");
  assert.equal(p.action_state, "none", "CAS: 'confirm_requested' não sobrescreve a resolução do evento");
  assert.equal(r.resultado, "SOLICITADO");
  assert.equal(r.oficial, true);
  assert.equal(r.statusOficial, "CONFIRMED");
  assert.equal(p.confirmed_event_at, t(1));
});

test("evento fora de ordem: CFM antes de PLC -> fica CONFIRMED, PLC tardio não regride mas registra o carimbo do PLACED", async () => {
  const a = await ambiente();
  await a.eventos([ev("e-cfm", "CFM", { min: 1 })]);
  assert.equal(pedidoDe(a).status_oficial, "CONFIRMED");
  assert.equal(pedidoDe(a).placed_event_created_at, null);
  await a.eventos([ev("e-plc", "PLC", { min: 0 })]);
  const p = pedidoDe(a);
  assert.equal(p.status_oficial, "CONFIRMED");
  assert.equal(p.status_oficial_evento_id, "e-cfm");
  assert.equal(p.placed_event_created_at, t(0));
  assert.equal(a.repo.eventos.get("e-plc").processing_status, "IGNORADO");
});

test("regressão proibida: nenhum evento anterior desfaz o estado (mesmo com createdAt posterior)", async () => {
  const a = await ambiente();
  await a.eventos([ev("e1", "PLC", { min: 0 }), ev("e2", "CFM", { min: 1 }), ev("e3", "DSP", { min: 2 })]);
  assert.equal(pedidoDe(a).status_oficial, "DISPATCHED");
  await a.eventos([ev("e4", "CFM", { min: 9 }), ev("e5", "PLC", { min: 10 })]);      // reentrega tardia, createdAt "novo"
  assert.equal(pedidoDe(a).status_oficial, "DISPATCHED");
  assert.equal(pedidoDe(a).status_oficial_evento_id, "e3");
  // PLC reentregue não reescreve o carimbo do SLA
  assert.equal(pedidoDe(a).placed_event_created_at, t(0));
});

test("estados terminais não regridem: CANCELLED/CONCLUDED ignoram CFM/DSP/PLC posteriores; e a ação pendente é encerrada", async () => {
  const a = await ambiente();
  await pronto(a);
  await conf(a, orderClientFake());                             // confirm_requested
  await a.eventos([ev("e-can", "CAN", { min: 3 })]);            // o iFood cancelou (ex.: estourou 8 min)
  let p = pedidoDe(a);
  assert.equal(p.status_oficial, "CANCELLED");
  assert.equal(p.action_state, "none", "cancelamento oficial encerra a espera do confirm");
  assert.equal(p.confirmed_event_at, null);

  await a.eventos([ev("e-cfm", "CFM", { min: 4 }), ev("e-dsp", "DSP", { min: 5 }), ev("e-plc2", "PLC", { min: 6 })]);
  p = pedidoDe(a);
  assert.equal(p.status_oficial, "CANCELLED");
  assert.equal(p.status_oficial_evento_id, "e-can");
  // O CFM tardio é um fato (o iFood confirmou antes de cancelar): o carimbo histórico é gravado, mas o
  // pedido NÃO é reaberto — o estado oficial segue CANCELLED.
  assert.equal(p.confirmed_event_at, t(4));

  const b = await ambiente();
  await b.eventos([ev("f1", "PLC", { min: 0 }), ev("f2", "CON", { min: 5 })]);
  await b.eventos([ev("f3", "DSP", { min: 6 }), ev("f4", "CFM", { min: 7 })]);
  assert.equal(pedidoDe(b).status_oficial, "CONCLUDED");
  // e confirm num pedido terminal é recusado
  const c = orderClientFake();
  await assert.rejects(conf(b, c), (e) => e.codigo === IFOOD_ERROS.IFOOD_PEDIDO_ESTADO_INVALIDO);
  assert.equal(c.chamadas.confirm.length, 0);
});

test("evento repetido (mesmo id) é idempotente e não mexe nos carimbos", async () => {
  const a = await ambiente();
  await a.eventos([ev("e1", "PLC", { min: 0 })]);
  const antes = structuredClone(pedidoDe(a));
  a.relogio.avancarS(30);
  await a.eventos([ev("e1", "PLC", { min: 0 })]);
  assert.deepEqual(pedidoDe(a), antes);
});

// ===========================================================================
// 6) POLLER — passo de detalhes (opt-in)
// ===========================================================================
function montarPoller(a, { detalhes, evts }) {
  const client = criarClienteFake(eventsClientReal, { respostasPolling: [evts] });
  return { client, poller: criarPoller({ repo: a.repo, token: a.token, client, holder: "h1", agora: a.relogio.agora, log: silencio, detalhes, unidadesPiloto: pilotoDe(a.repo) }) };
}

test("poller com `detalhes`: no mesmo ciclo do PLC busca os detalhes; sem `detalhes` (padrão) não busca nada", async () => {
  const a = await ambiente();
  const orderClient = orderClientFake({ detalhes: [detalhesCompletos()] });
  const { poller } = montarPoller(a, { detalhes: { client: orderClient }, evts: [ev("e-plc", "PLC", { min: 0 })] });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "OK");
  assert.equal(r.acks, 1);
  assert.equal(r.detalhes.gravados, 1);
  assert.equal(pedidoDe(a).details_status, "OK");
  assert.equal(pedidoDe(a).status_oficial, "PLACED");
  assert.equal(a.repo.eventos.get("e-plc").acknowledged_at !== null, true, "ACK continua depois de persistir");

  const b = await ambiente();
  const { poller: p2 } = montarPoller(b, { detalhes: null, evts: [ev("e-plc", "PLC", { min: 0 })] });
  const r2 = await p2.executarCiclo();
  assert.equal(r2.detalhes, undefined);
  assert.equal(pedidoDe(b).details_status, "PENDENTE");
});

test("poller: falha no passo de detalhes não derruba o ciclo nem o ACK", async () => {
  const a = await ambiente();
  const orderClient = orderClientFake({ detalhes: [erro("IFOOD_INDISPONIVEL")] });
  const { poller } = montarPoller(a, { detalhes: { client: orderClient }, evts: [ev("e-plc", "PLC", { min: 0 })] });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "OK");
  assert.equal(r.acks, 1);
  assert.equal(r.detalhes.erros, 1);
  assert.equal(pedidoDe(a).details_status, "ERRO");
});

// ===========================================================================
// 7) ESCOPO: nada além do que o Checkpoint C autoriza
// ===========================================================================
test("escopo (Checkpoint D): o cliente de Order expõe detalhes, confirm, ready, dispatch e cancelamento — e nada além (sem startPreparation/tracking/códigos)", () => {
  assert.deepEqual(Object.keys(orderClientReal).sort(),
    ["CORPO_DISPATCH", "buscarDetalhesPedido", "confirmarPedido", "despacharPedido", "listarMotivosCancelamento", "notificarPedidoPronto", "solicitarCancelamento"]);
  assert.deepEqual(Object.keys(IFOOD_ROTAS).filter((k) => /^order/i.test(k)).sort(),
    ["orderCancellationReasons", "orderConfirm", "orderDetalhes", "orderDispatch", "orderReadyToPickup", "orderRequestCancellation"]);
  assert.deepEqual(Object.keys(IFOOD_ROTAS).filter((k) => /^dispute/i.test(k)).sort(), ["disputeAccept", "disputeAlternative", "disputeReject"]);
});
