// Order do iFood (Checkpoint D): readyToPickup, dispatch e cancelamento.
// Regra central: HTTP aceito registra a INTENÇÃO (<acao>_requested); só o EVENTO oficial muda o estado.
//
// Rodar: node --experimental-vm-modules --test test/ifood-order-actions.test.js
import test from "node:test";
import assert from "node:assert/strict";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";

const httpReal = await import("../src/modules/ifood/ifoodHttp.client.js");
const { IFOOD_ERROS, ifoodErro } = await import("../src/modules/ifood/ifood.errors.js");
const { IFOOD_ORDER } = await import("../src/modules/ifood/ifood.constants.js");
const orderClientReal = await import("../src/modules/ifood/ifoodOrder.client.js");
const { notificarPronto, despachar, cancelar, listarMotivosCancelamento, avaliarElegibilidade } =
  await import("../src/modules/ifood/ifoodOrderActions.service.js");
const { processarLote, extrasDoEvento } = await import("../src/modules/ifood/ifoodEvents.service.js");
const { sanitizarParaAuditoria, classificarFalhaDeAcao } = await import("../src/modules/ifood/ifoodAcoes.util.js");
const {
  criarRepoEmMemoria, criarRelogio, criarTokenFake, ev, t, ORG_A, UN_A, ORG_B, UN_B, M_B,
} = await import("./helpers/ifood-events-fakes.js");

const silencio = () => {};
const ORDER = "order-1";
const MOTIVOS = [{ code: "501", description: "PROBLEMAS DE SISTEMA" }, { code: "503", description: "ITEM INDISPONÍVEL" }];

// ---------------------------------------------------------------------------
// fakes
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
      headers: { get: (h) => (h.toLowerCase() === "content-type" ? (r.contentType ?? "application/json") : null) },
      text: async () => (typeof r.corpo === "string" ? r.corpo : JSON.stringify(r.corpo ?? {})),
    };
  };
  return { chamadas, impl };
}
const httpComFetch = (impl) => ({
  getJson: (c, o) => httpReal.getJson(c, { ...o, fetchImpl: impl }),
  postJson: (c, b, o) => httpReal.postJson(c, b, { ...o, fetchImpl: impl }),
});
const erro = (codigo, detalhes) => ifoodErro(IFOOD_ERROS[codigo], detalhes ? { detalhes } : undefined);

/** Cliente de Order programável: cada método tem uma fila (o último item se repete) e um contador de chamadas. */
function clienteFake({ ready = [], dispatch = [], cancel = [], motivos = [MOTIVOS], aoEnviar } = {}) {
  const chamadas = { ready: [], dispatch: [], cancel: [], motivos: [] };
  const proximo = (fila, padrao) => { const r = fila.length > 1 ? fila.shift() : (fila[0] ?? padrao); if (r instanceof Error) throw r; return r; };
  return {
    chamadas,
    async notificarPedidoPronto(a) { chamadas.ready.push(a); await aoEnviar?.("ready"); return proximo(ready, { status: 202, aceito: true }); },
    async despacharPedido(a) { chamadas.dispatch.push(a); await aoEnviar?.("dispatch"); return proximo(dispatch, { status: 202, aceito: true }); },
    async solicitarCancelamento(a) { chamadas.cancel.push(a); await aoEnviar?.("cancel"); return proximo(cancel, { status: 202, aceito: true }); },
    async listarMotivosCancelamento(a) { chamadas.motivos.push(a); return structuredClone(proximo(motivos, [])); },
  };
}

async function ambiente() {
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio });
  const token = criarTokenFake({ escopo: "app" });
  const mapa = new Map(repo.conexoes.map((c) => [c.merchant_id, c]));
  const eventos = (brutos) => processarLote({ eventosBrutos: brutos, conexoesPorMerchant: mapa, repo, agora: relogio.agora, log: silencio });
  return { relogio, repo, token, eventos };
}
const pedidoDe = (a, id = ORDER) => a.repo.pedidos.get(id);
const dep = (a, client, extra = {}) => ({ organizacaoId: ORG_A, unidadeId: UN_A, orderId: ORDER, repo: a.repo, token: a.token, client, agora: a.relogio.agora, log: silencio, ...extra });

/** Pedido no tenant A com os eventos pedidos e os campos dos detalhes (tipo/entrega). */
async function preparar(a, { codigos = ["PLC", "CFM"], tipo = "DELIVERY", entrega = "MERCHANT", detalhes = true } = {}) {
  await a.eventos(codigos.map((c, i) => ev(`e-${c}-${i}`, c, { min: i })));
  if (detalhes) await a.repo.atualizarPedido({ pedido: pedidoDe(a), campos: { order_type: tipo, delivery_by: entrega, details_status: "OK", order_created_at: t(0) } });
  return pedidoDe(a);
}
let seqEv = 0;
const evento = (a, code, min = 10) => a.eventos([ev(`x-${code}-${(seqEv += 1)}`, code, { min })]);

// ===========================================================================
// 1) READY TO PICKUP
// ===========================================================================
test("ready: pedido CONFIRMED elegível — 202 => ready_requested; estado OFICIAL não muda; auditoria completa", async () => {
  for (const tipo of ["DELIVERY", "TAKEOUT", "DINE_IN"]) {
    const a = await ambiente();
    await preparar(a, { tipo });
    a.relogio.avancarS(20);
    const c = clienteFake();
    const r = await notificarPronto(dep(a, c));

    assert.equal(r.resultado, "SOLICITADO", tipo);
    assert.equal(r.httpStatus, 202);
    assert.equal(r.oficial, false);
    const p = pedidoDe(a);
    assert.equal(p.action_state, "ready_requested");
    assert.equal(p.status_oficial, "CONFIRMED", "202 NUNCA muda o estado oficial");
    assert.equal(p.ready_requested_at, a.relogio.agora().toISOString());
    assert.equal(p.ready_event_at, null);
    assert.equal(p.action_attempts, 1);
    assert.equal(p.action_uncertain, false);
    assert.equal(c.chamadas.ready.length, 1);
    assert.deepEqual(a.token.chamadas.at(-1), { conexaoId: "con-a", appType: "order" });

    const aud = a.repo.acoes.at(-1);
    assert.deepEqual([aud.acao, aud.resultado, aud.http_status, aud.tentativa, aud.conexao_id], ["ready", "ACEITA_202", 202, 1, "con-a"]);
    assert.ok(aud.requested_at && aud.responded_at, "requested_at e responded_at");
    assert.equal(aud.unidade_id, UN_A);
  }
});

test("ready: tipo não elegível (INDOOR/desconhecido) e detalhes ausentes — nenhum POST", async () => {
  const a = await ambiente();
  await preparar(a, { tipo: "INDOOR" });
  const c = clienteFake();
  await assert.rejects(notificarPronto(dep(a, c)), (e) => e.codigo === IFOOD_ERROS.IFOOD_ACAO_NAO_ELEGIVEL && e.details.orderType === "INDOOR");

  const b = await ambiente();
  await preparar(b, { detalhes: false });
  await assert.rejects(notificarPronto(dep(b, c)), (e) => e.codigo === IFOOD_ERROS.IFOOD_PEDIDO_ESTADO_INVALIDO && e.details.motivo === "detalhes_ausentes");
  assert.equal(c.chamadas.ready.length, 0);
});

test("ready: estado inválido (PLACED, sem estado, CANCELLED) — nenhum POST; estados já prontos => JA_EXECUTADO", async () => {
  for (const codigos of [["PLC"], ["CAR"], ["PLC", "CAN"]]) {
    const a = await ambiente();
    await preparar(a, { codigos });
    const c = clienteFake();
    await assert.rejects(notificarPronto(dep(a, c)), (e) => e.codigo === IFOOD_ERROS.IFOOD_PEDIDO_ESTADO_INVALIDO, codigos.join());
    assert.equal(c.chamadas.ready.length, 0);
  }
  for (const codigos of [["PLC", "CFM", "RTP"], ["PLC", "CFM", "SPE"], ["PLC", "CFM", "RTP", "DSP"]]) {
    const a = await ambiente();
    await preparar(a, { codigos });
    const c = clienteFake();
    const r = await notificarPronto(dep(a, c));
    assert.equal(r.resultado, "JA_EXECUTADO", codigos.join());
    assert.equal(c.chamadas.ready.length, 0);
  }
});

test("ready: repetido não gera POST duplicado (JA_SOLICITADO)", async () => {
  const a = await ambiente();
  await preparar(a);
  const c = clienteFake();
  await notificarPronto(dep(a, c));
  assert.equal((await notificarPronto(dep(a, c))).resultado, "JA_SOLICITADO");
  assert.equal((await notificarPronto(dep(a, c))).resultado, "JA_SOLICITADO");
  assert.equal(c.chamadas.ready.length, 1);
  assert.equal(pedidoDe(a).action_attempts, 1);
});

test("ready: 401 / 404 / 409 / 422 / 429 => ready_failed (recusa definitiva), erro propagado e nova tentativa permitida", async () => {
  for (const [codigo, status] of [["IFOOD_TOKEN_EXPIRADO", 401], ["IFOOD_PEDIDO_NAO_ENCONTRADO", 404], ["IFOOD_ACAO_PEDIDO_RECUSADA", 409], ["IFOOD_ACAO_PEDIDO_RECUSADA", 422], ["IFOOD_RATE_LIMITED", 429]]) {
    const a = await ambiente();
    await preparar(a);
    const c = clienteFake({ ready: [erro(codigo, { status }), { status: 202, aceito: true }] });
    await assert.rejects(notificarPronto(dep(a, c)), (e) => e.codigo === IFOOD_ERROS[codigo], String(status));
    let p = pedidoDe(a);
    assert.equal(p.action_state, "ready_failed", String(status));
    assert.equal(p.action_uncertain, false);
    assert.equal(p.action_last_error, codigo);
    assert.equal(p.status_oficial, "CONFIRMED");
    assert.notEqual(a.repo.acoes.at(-1).resultado, "ACEITA_202");
    // nova tentativa explícita: permitida (o iFood recusou, nada foi executado)
    const r = await notificarPronto(dep(a, c));
    assert.equal(r.resultado, "SOLICITADO");
    p = pedidoDe(a);
    assert.equal(p.action_state, "ready_requested");
    assert.equal(p.action_attempts, 2);
  }
});

test("ready: 5xx / timeout / rede => INCERTO (o iFood pode ter processado): ready_requested + action_uncertain, AGUARDANDO_EVENTO, sem reenvio", async () => {
  for (const codigo of ["IFOOD_INDISPONIVEL", "IFOOD_RESPOSTA_INVALIDA"]) {
    const a = await ambiente();
    await preparar(a);
    const c = clienteFake({ ready: [erro(codigo, { motivo: "timeout" }), { status: 202, aceito: true }] });
    const r = await notificarPronto(dep(a, c));
    assert.equal(r.resultado, "AGUARDANDO_EVENTO", codigo);
    assert.equal(r.incerto, true);
    const p = pedidoDe(a);
    assert.equal(p.action_state, "ready_requested");
    assert.equal(p.action_uncertain, true);
    assert.equal(p.status_oficial, "CONFIRMED", "incerto NÃO é estado oficial");
    assert.equal(a.repo.acoes.at(-1).resultado, "INCERTO");

    // repetir NÃO reenvia às cegas
    const r2 = await notificarPronto(dep(a, c));
    assert.equal(r2.resultado, "AGUARDANDO_EVENTO");
    assert.equal(c.chamadas.ready.length, 1);

    // só com pedido EXPLÍCITO e depois do prazo sem evento
    const cedo = await notificarPronto(dep(a, c, { permitirReenvioIncerto: true }));
    assert.equal(cedo.resultado, "AGUARDANDO_EVENTO", "explícito mas cedo demais");
    a.relogio.avancarS(IFOOD_ORDER.reenvioIncertoAposMs / 1000 + 1);
    const tarde = await notificarPronto(dep(a, c, { permitirReenvioIncerto: true }));
    assert.equal(tarde.resultado, "SOLICITADO");
    assert.equal(c.chamadas.ready.length, 2);
    assert.equal(pedidoDe(a).action_uncertain, false);
  }
});

test("ready: o EVENTO oficial fecha o ciclo — RTP resolve a ação, carimba ready_event_at e só então o estado oficial muda", async () => {
  const a = await ambiente();
  await preparar(a);
  await notificarPronto(dep(a, clienteFake()));
  assert.equal(pedidoDe(a).status_oficial, "CONFIRMED");
  a.relogio.avancarS(5);
  await evento(a, "RTP", 3);
  const p = pedidoDe(a);
  assert.equal(p.status_oficial, "READY_TO_PICKUP");
  assert.equal(p.action_state, "none");
  assert.equal(p.ready_event_at, t(3));
});

test("ready: evento oficial ANTES da resposta HTTP — o 202 não sobrescreve a resolução do evento", async () => {
  const a = await ambiente();
  await preparar(a);
  const c = clienteFake({ aoEnviar: () => evento(a, "RTP", 3) });
  const r = await notificarPronto(dep(a, c));
  const p = pedidoDe(a);
  assert.equal(p.status_oficial, "READY_TO_PICKUP");
  assert.equal(p.action_state, "none", "CAS: ready_requested não sobrescreve o none do evento");
  assert.equal(r.resultado, "SOLICITADO");
  assert.equal(r.eventoJaChegou, true);
  assert.equal(r.oficial, false);
});

test("ready: evento chegando DEPOIS de um timeout resolve a incerteza (nenhum reenvio foi necessário)", async () => {
  const a = await ambiente();
  await preparar(a);
  const c = clienteFake({ ready: [erro("IFOOD_INDISPONIVEL", { motivo: "timeout" })] });
  await notificarPronto(dep(a, c));
  assert.equal(pedidoDe(a).action_uncertain, true);
  await evento(a, "RTP", 4);
  const p = pedidoDe(a);
  assert.equal(p.action_state, "none");
  assert.equal(p.action_uncertain, false);
  assert.equal(p.status_oficial, "READY_TO_PICKUP");
  assert.equal((await notificarPronto(dep(a, c))).resultado, "JA_EXECUTADO");
  assert.equal(c.chamadas.ready.length, 1);
});

test("ready: cross-tenant — orderId de outra unidade = pedido inexistente; nada é enviado", async () => {
  const a = await ambiente();
  await a.eventos([ev("b1", "PLC", { orderId: "order-b", merchantId: M_B }), ev("b2", "CFM", { orderId: "order-b", merchantId: M_B, min: 1 })]);
  await a.repo.atualizarPedido({ pedido: pedidoDe(a, "order-b"), campos: { order_type: "DELIVERY", delivery_by: "MERCHANT" } });
  const c = clienteFake();
  await assert.rejects(notificarPronto(dep(a, c, { orderId: "order-b" })), (e) => e.codigo === IFOOD_ERROS.IFOOD_PEDIDO_LOCAL_NAO_ENCONTRADO);
  await assert.rejects(notificarPronto(dep(a, c, { orderId: "order-b", organizacaoId: ORG_A, unidadeId: UN_B })), (e) => e.codigo === IFOOD_ERROS.IFOOD_PEDIDO_LOCAL_NAO_ENCONTRADO);
  assert.equal(c.chamadas.ready.length, 0);
  const r = await notificarPronto(dep(a, c, { orderId: "order-b", organizacaoId: ORG_B, unidadeId: UN_B }));
  assert.equal(r.resultado, "SOLICITADO");
  assert.equal(c.chamadas.ready[0].orderId, "order-b");
});

// ===========================================================================
// 2) DISPATCH
// ===========================================================================
test("dispatch: DELIVERY própria DEPOIS do evento READY_TO_PICKUP — 202 => dispatch_requested; oficial só muda com DSP", async () => {
  const a = await ambiente();
  await preparar(a, { codigos: ["PLC", "CFM", "RTP"] });
  const c = clienteFake();
  const r = await despachar(dep(a, c));
  assert.equal(r.resultado, "SOLICITADO");
  let p = pedidoDe(a);
  assert.equal(p.action_state, "dispatch_requested");
  assert.equal(p.status_oficial, "READY_TO_PICKUP");
  assert.equal(p.dispatch_requested_at, a.relogio.agora().toISOString());
  assert.equal(c.chamadas.dispatch.length, 1);
  assert.deepEqual(a.repo.acoes.map((x) => [x.acao, x.resultado]), [["dispatch", "ACEITA_202"]]);

  await evento(a, "DSP", 12);
  p = pedidoDe(a);
  assert.equal(p.status_oficial, "DISPATCHED");
  assert.equal(p.action_state, "none");
  assert.equal(p.dispatch_event_at, t(12));
});

test("dispatch ANTES do ready: NENHUM POST (estado inválido) — inclusive com o ready já solicitado e o evento ainda pendente", async () => {
  const a = await ambiente();
  await preparar(a);                                        // CONFIRMED
  const c = clienteFake();
  await assert.rejects(despachar(dep(a, c)), (e) => e.codigo === IFOOD_ERROS.IFOOD_PEDIDO_ESTADO_INVALIDO && e.details.motivo === "ready_nao_comprovado");
  assert.equal(c.chamadas.dispatch.length, 0);

  await notificarPronto(dep(a, c));                          // ready 202, sem evento RTP ainda
  const r = await despachar(dep(a, c));
  assert.equal(r.resultado, "AGUARDANDO_EVENTO");
  assert.equal(r.motivo, "ready_aguardando_evento");
  assert.equal(c.chamadas.dispatch.length, 0, "ready_requested NÃO libera o dispatch: só o evento RTP");

  const b = await ambiente();                                // PLACED / CANCELLED
  for (const codigos of [["PLC"], ["PLC", "CFM", "CAN"]]) {
    const x = await ambiente();
    await preparar(x, { codigos });
    await assert.rejects(despachar(dep(x, c)), (e) => e.codigo === IFOOD_ERROS.IFOOD_PEDIDO_ESTADO_INVALIDO);
  }
  assert.equal(c.chamadas.dispatch.length, 0);
  assert.ok(b);
});

test("dispatch: tipos não elegíveis — marketplace (iFood entrega), TAKEOUT, DINE_IN, INDOOR — nenhum POST", async () => {
  const c = clienteFake();
  for (const [tipo, entrega] of [["DELIVERY", "IFOOD"], ["TAKEOUT", "MERCHANT"], ["DINE_IN", "MERCHANT"], ["INDOOR", "MERCHANT"], ["TAKEOUT", "IFOOD"]]) {
    const a = await ambiente();
    await preparar(a, { codigos: ["PLC", "CFM", "RTP"], tipo, entrega });
    await assert.rejects(despachar(dep(a, c)), (e) => e.codigo === IFOOD_ERROS.IFOOD_ACAO_NAO_ELEGIVEL, `${tipo}/${entrega}`);
  }
  const b = await ambiente();
  await preparar(b, { codigos: ["PLC", "CFM", "RTP"], detalhes: false });
  await assert.rejects(despachar(dep(b, c)), (e) => e.details.motivo === "detalhes_ausentes");
  assert.equal(c.chamadas.dispatch.length, 0);
});

test("dispatch: repetido (JA_SOLICITADO), já despachado (JA_EXECUTADO) e nunca um segundo POST", async () => {
  const a = await ambiente();
  await preparar(a, { codigos: ["PLC", "CFM", "RTP"] });
  const c = clienteFake();
  await despachar(dep(a, c));
  assert.equal((await despachar(dep(a, c))).resultado, "JA_SOLICITADO");
  await evento(a, "DSP", 12);
  assert.equal((await despachar(dep(a, c))).resultado, "JA_EXECUTADO");
  assert.equal(c.chamadas.dispatch.length, 1);
});

test("dispatch: timeout => INCERTO e AGUARDANDO_EVENTO; o DSP posterior resolve; sem reenvio cego", async () => {
  const a = await ambiente();
  await preparar(a, { codigos: ["PLC", "CFM", "RTP"] });
  const c = clienteFake({ dispatch: [erro("IFOOD_INDISPONIVEL", { motivo: "timeout" })] });
  const r = await despachar(dep(a, c));
  assert.equal(r.resultado, "AGUARDANDO_EVENTO");
  assert.equal(pedidoDe(a).action_state, "dispatch_requested");
  assert.equal(pedidoDe(a).action_uncertain, true);
  assert.equal((await despachar(dep(a, c))).resultado, "AGUARDANDO_EVENTO");
  assert.equal(c.chamadas.dispatch.length, 1);
  await evento(a, "DSP", 15);
  assert.equal(pedidoDe(a).status_oficial, "DISPATCHED");
  assert.equal(pedidoDe(a).action_uncertain, false);
});

test("dispatch: recusa do iFood (400/409/422) => dispatch_failed, sem alterar o estado oficial", async () => {
  const a = await ambiente();
  await preparar(a, { codigos: ["PLC", "CFM", "RTP"] });
  const c = clienteFake({ dispatch: [erro("IFOOD_ACAO_PEDIDO_RECUSADA", { status: 400 })] });
  await assert.rejects(despachar(dep(a, c)), (e) => e.codigo === IFOOD_ERROS.IFOOD_ACAO_PEDIDO_RECUSADA);
  assert.equal(pedidoDe(a).action_state, "dispatch_failed");
  assert.equal(pedidoDe(a).status_oficial, "READY_TO_PICKUP");
  assert.equal(a.repo.acoes.at(-1).resultado, "RECUSADA");
  assert.equal(a.repo.acoes.at(-1).http_status, 400);
});

test("dispatch: cross-tenant", async () => {
  const a = await ambiente();
  await a.eventos([ev("b1", "PLC", { orderId: "order-b", merchantId: M_B }), ev("b2", "CFM", { orderId: "order-b", merchantId: M_B, min: 1 }), ev("b3", "RTP", { orderId: "order-b", merchantId: M_B, min: 2 })]);
  await a.repo.atualizarPedido({ pedido: pedidoDe(a, "order-b"), campos: { order_type: "DELIVERY", delivery_by: "MERCHANT" } });
  const c = clienteFake();
  await assert.rejects(despachar(dep(a, c, { orderId: "order-b" })), (e) => e.codigo === IFOOD_ERROS.IFOOD_PEDIDO_LOCAL_NAO_ENCONTRADO);
  assert.equal(c.chamadas.dispatch.length, 0);
});

// ===========================================================================
// 3) CANCELAMENTO
// ===========================================================================
test("cancelamento — consulta de motivos: lista OFICIAL do iFood, lida do pedido do tenant (leitura, sem estado)", async () => {
  const a = await ambiente();
  await preparar(a);
  const c = clienteFake();
  const lista = await listarMotivosCancelamento(dep(a, c));
  assert.deepEqual(lista.map((m) => m.code), ["501", "503"]);
  assert.equal(pedidoDe(a).action_state, "none");
  assert.equal(c.chamadas.motivos.length, 1);
  await assert.rejects(listarMotivosCancelamento(dep(a, c, { orderId: "nao-existe" })), (e) => e.codigo === IFOOD_ERROS.IFOOD_PEDIDO_LOCAL_NAO_ENCONTRADO);
});

test("cancelamento: motivo OFICIAL válido — POST com o código; 202 => cancel_requested; estado só vira CANCELLED pelo evento; código e descrição preservados", async () => {
  const a = await ambiente();
  await preparar(a);
  const c = clienteFake();
  const r = await cancelar(dep(a, c, { motivo: "503" }));
  assert.equal(r.resultado, "SOLICITADO");
  const p = pedidoDe(a);
  assert.equal(p.action_state, "cancel_requested");
  assert.equal(p.status_oficial, "CONFIRMED", "202 NUNCA marca CANCELLED");
  assert.equal(p.cancel_reason_code, "503");
  assert.equal(p.cancel_reason_description, "ITEM INDISPONÍVEL");
  assert.equal(p.cancel_requested_at, a.relogio.agora().toISOString());
  assert.equal(c.chamadas.cancel.length, 1);
  assert.equal(c.chamadas.cancel[0].reason, "503");
  assert.deepEqual(a.repo.acoes.at(-1).request_payload, { cancellationCode: "503", reason: "ITEM INDISPONÍVEL" });
  assert.equal(c.chamadas.cancel[0].descricao, "ITEM INDISPONÍVEL");

  await evento(a, "CAN", 8);
  const f = pedidoDe(a);
  assert.equal(f.status_oficial, "CANCELLED");
  assert.equal(f.action_state, "none");
  assert.equal(f.cancel_event_at, t(8));
});

test("cancelamento: motivo inválido / vazio / lista vazia (204) — NENHUM POST", async () => {
  const a = await ambiente();
  await preparar(a);
  const c = clienteFake();
  for (const motivo of ["999", "abc", "", null, undefined, "50"]) {
    await assert.rejects(cancelar(dep(a, c, { motivo })), (e) => e.codigo === IFOOD_ERROS.IFOOD_MOTIVO_CANCELAMENTO_INVALIDO, String(motivo));
  }
  const vazio = clienteFake({ motivos: [[]] });
  await assert.rejects(cancelar(dep(a, vazio, { motivo: "501" })), (e) => e.codigo === IFOOD_ERROS.IFOOD_MOTIVO_CANCELAMENTO_INVALIDO && e.details.motivo === "sem_politica_de_cancelamento");
  assert.equal(c.chamadas.cancel.length + vazio.chamadas.cancel.length, 0);
  assert.equal(pedidoDe(a).action_state, "none", "motivo inválido não reserva estado");
  assert.equal(pedidoDe(a).cancel_reason_code, null);
});

test("cancelamento REJEITADO pelo iFood (CANCELLATION_REQUEST_FAILED): cancel_failed, estado oficial intacto, nova tentativa permitida", async () => {
  const a = await ambiente();
  await preparar(a);
  const c = clienteFake();
  await cancelar(dep(a, c, { motivo: "501" }));
  await evento(a, "CARF", 6);
  let p = pedidoDe(a);
  assert.equal(p.action_state, "cancel_failed");
  assert.equal(p.action_last_error, "CANCELLATION_REQUEST_FAILED");
  assert.equal(p.cancel_failed_event_at, t(6));
  assert.equal(p.status_oficial, "CONFIRMED");
  assert.equal(a.repo.eventos.get([...a.repo.eventos.keys()].at(-1)).processing_status, "PROCESSADO");

  const r = await cancelar(dep(a, c, { motivo: "501" }));
  assert.equal(r.resultado, "SOLICITADO");
  assert.equal(pedidoDe(a).action_attempts, 2);
  p = pedidoDe(a);
  assert.equal(p.action_state, "cancel_requested");
});

test("cancelamento: HTTP 400 (OrderExceededCancellationDeadline / em andamento), 404, 401, 429 => cancel_failed; timeout/5xx => INCERTO", async () => {
  for (const [codigo, status] of [["IFOOD_ACAO_PEDIDO_RECUSADA", 400], ["IFOOD_PEDIDO_NAO_ENCONTRADO", 404], ["IFOOD_TOKEN_EXPIRADO", 401], ["IFOOD_RATE_LIMITED", 429]]) {
    const a = await ambiente();
    await preparar(a);
    const c = clienteFake({ cancel: [erro(codigo, { status })] });
    await assert.rejects(cancelar(dep(a, c, { motivo: "501" })), (e) => e.codigo === IFOOD_ERROS[codigo]);
    assert.equal(pedidoDe(a).action_state, "cancel_failed", String(status));
    assert.equal(pedidoDe(a).status_oficial, "CONFIRMED");
  }
  const a = await ambiente();
  await preparar(a);
  const c = clienteFake({ cancel: [erro("IFOOD_INDISPONIVEL", { motivo: "timeout" })] });
  const r = await cancelar(dep(a, c, { motivo: "501" }));
  assert.equal(r.resultado, "AGUARDANDO_EVENTO");
  assert.equal(pedidoDe(a).action_uncertain, true);
  assert.equal((await cancelar(dep(a, c, { motivo: "501" }))).resultado, "AGUARDANDO_EVENTO");
  assert.equal(c.chamadas.cancel.length, 1, "cancelamento nunca é reenviado às cegas");
  await evento(a, "CAN", 9);
  assert.equal(pedidoDe(a).status_oficial, "CANCELLED");
  assert.equal(pedidoDe(a).action_uncertain, false);
});

test("cancelamento repetido: nenhum POST/GET extra; já cancelado => JA_EXECUTADO; concluído => estado inválido", async () => {
  const a = await ambiente();
  await preparar(a);
  const c = clienteFake();
  await cancelar(dep(a, c, { motivo: "501" }));
  const gets = c.chamadas.motivos.length;
  assert.equal((await cancelar(dep(a, c, { motivo: "501" }))).resultado, "JA_SOLICITADO");
  assert.equal(c.chamadas.cancel.length, 1);
  assert.equal(c.chamadas.motivos.length, gets, "repetição nem consulta os motivos de novo");
  await evento(a, "CAN", 8);
  assert.equal((await cancelar(dep(a, c, { motivo: "501" }))).resultado, "JA_EXECUTADO");

  const b = await ambiente();
  await preparar(b, { codigos: ["PLC", "CFM", "CON"] });
  await assert.rejects(cancelar(dep(b, c, { motivo: "501" })), (e) => e.codigo === IFOOD_ERROS.IFOOD_PEDIDO_ESTADO_INVALIDO);
  assert.equal(c.chamadas.cancel.length, 1);
});

test("cancelamento em andamento bloqueia ready/dispatch (nenhum POST)", async () => {
  const a = await ambiente();
  await preparar(a);
  const c = clienteFake();
  await cancelar(dep(a, c, { motivo: "501" }));
  await assert.rejects(notificarPronto(dep(a, c)), (e) => e.details.motivo === "cancelamento_em_andamento");
  assert.equal(c.chamadas.ready.length, 0);
});

test("cancelamento: cross-tenant (não lista motivos nem envia nada)", async () => {
  const a = await ambiente();
  await a.eventos([ev("b1", "PLC", { orderId: "order-b", merchantId: M_B }), ev("b2", "CFM", { orderId: "order-b", merchantId: M_B, min: 1 })]);
  const c = clienteFake();
  await assert.rejects(cancelar(dep(a, c, { orderId: "order-b", motivo: "501" })), (e) => e.codigo === IFOOD_ERROS.IFOOD_PEDIDO_LOCAL_NAO_ENCONTRADO);
  assert.equal(c.chamadas.motivos.length + c.chamadas.cancel.length, 0);
});

// ===========================================================================
// 4) MÁQUINA DE ESTADOS com as ações
// ===========================================================================
test("estado oficial nunca regride com as ações: RTP/CFM antigos depois de DSP; terminais intactos; duplicados", async () => {
  const a = await ambiente();
  await preparar(a, { codigos: ["PLC", "CFM", "RTP", "DSP"] });
  assert.equal(pedidoDe(a).status_oficial, "DISPATCHED");
  await a.eventos([ev("late-rtp", "RTP", { min: 30 }), ev("late-cfm", "CFM", { min: 31 })]);
  assert.equal(pedidoDe(a).status_oficial, "DISPATCHED");
  assert.equal(pedidoDe(a).ready_event_at, t(2), "carimbo do 1º RTP preservado");

  await a.eventos([ev("con", "CON", { min: 40 })]);
  assert.equal(pedidoDe(a).status_oficial, "CONCLUDED");
  await a.eventos([ev("late-dsp", "DSP", { min: 41 }), ev("late-can", "CAN", { min: 39 })]);
  assert.equal(pedidoDe(a).status_oficial, "CONCLUDED", "CAN mais antigo que CON não desfaz");

  const b = await ambiente();
  await preparar(b, { codigos: ["PLC", "CFM", "CAN"] });
  await b.eventos([ev("l1", "RTP", { min: 20 }), ev("l2", "DSP", { min: 21 })]);
  assert.equal(pedidoDe(b).status_oficial, "CANCELLED", "CANCELLED é terminal");

  const c = await ambiente();
  await c.eventos([ev("d1", "RTP", { min: 5 })]);                             // fora de ordem: RTP antes de PLC/CFM
  await c.eventos([ev("d2", "PLC", { min: 0 }), ev("d3", "CFM", { min: 1 })]);
  assert.equal(pedidoDe(c).status_oficial, "READY_TO_PICKUP");
  const antes = structuredClone(pedidoDe(c));
  await c.eventos([ev("d1", "RTP", { min: 5 })]);                             // duplicado
  assert.deepEqual(pedidoDe(c), antes);
});

test("resolução por ação (pura): cada evento só resolve a ação que lhe corresponde", () => {
  const p = (action_state) => ({ action_state, action_uncertain: false });
  const ex = (estado, status) => extrasDoEvento(p(estado), status, { createdAt: t(1), recebidoEm: t(1) });
  assert.equal(ex("ready_requested", "READY_TO_PICKUP").action_state, "none");
  assert.equal(ex("ready_requested", "SEPARATION_ENDED").action_state, "none");
  assert.equal(ex("ready_requested", "CONFIRMED").action_state, undefined, "CFM antigo não resolve o ready");
  assert.equal(ex("dispatch_requested", "READY_TO_PICKUP").action_state, undefined, "RTP antigo não resolve o dispatch");
  assert.equal(ex("dispatch_requested", "DISPATCHED").action_state, "none");
  assert.equal(ex("cancel_requested", "DISPATCHED").action_state, undefined, "só CANCELLED resolve o cancelamento");
  assert.equal(ex("cancel_requested", "CANCELLED").action_state, "none");
  assert.equal(ex("ready_requested", "CANCELLED").action_state, "none", "CANCELLED encerra o que estava pendente");
  assert.equal(ex("confirm_requested", "CONFIRMED").action_state, "none");
  assert.equal(ex("none", "DISPATCHED").action_state, undefined);
});

test("elegibilidade (pura) — matriz por ação, estado e tipo", () => {
  const p = (o) => ({ status_oficial: "CONFIRMED", action_state: "none", order_type: "DELIVERY", delivery_by: "MERCHANT", ...o });
  assert.equal(avaliarElegibilidade("ready", p({})).tipo, "OK");
  assert.equal(avaliarElegibilidade("ready", p({ status_oficial: "SEPARATION_STARTED" })).tipo, "OK");
  assert.equal(avaliarElegibilidade("dispatch", p({ status_oficial: "READY_TO_PICKUP" })).tipo, "OK");
  assert.equal(avaliarElegibilidade("cancel", p({ status_oficial: "DISPATCHED" })).tipo, "OK");
  assert.equal(avaliarElegibilidade("cancel", p({ status_oficial: "PLACED" })).tipo, "OK");
  assert.throws(() => avaliarElegibilidade("dispatch", p({ status_oficial: "CONFIRMED" })), (e) => e.details.motivo === "ready_nao_comprovado");
});

// ===========================================================================
// 5) HTTP real do cliente (fetch falso): sem retry nas ações mutantes
// ===========================================================================
test("HTTP ready: POST no path oficial, SEM corpo, Bearer; 202 ACCEPTED", async () => {
  const f = fetchFalso([{ status: 202, corpo: { status: "ACCEPTED" } }]);
  const r = await orderClientReal.notificarPedidoPronto({ accessToken: "tok", orderId: ORDER, http: httpComFetch(f.impl) });
  assert.deepEqual(r, { status: 202, aceito: true });
  const c = f.chamadas[0];
  assert.equal(c.url, "https://mock.ifood.test/order/v1.0/orders/order-1/readyToPickup");
  assert.equal(c.method, "POST");
  assert.equal(c.body, undefined);
  assert.equal(c.headers.Authorization, "Bearer tok");
});

test("HTTP dispatch: POST no path oficial COM corpo {\"deliveredBy\":\"MERCHANT\"}, Content-Type json, Bearer; 202 ACCEPTED", async () => {
  const f = fetchFalso([{ status: 202, corpo: { status: "ACCEPTED" } }]);
  const r = await orderClientReal.despacharPedido({ accessToken: "tok", orderId: ORDER, deliveredBy: "MERCHANT", http: httpComFetch(f.impl) });
  assert.deepEqual(r, { status: 202, aceito: true });
  const c = f.chamadas[0];
  assert.equal(c.url, "https://mock.ifood.test/order/v1.0/orders/order-1/dispatch");
  assert.equal(c.method, "POST");
  assert.deepEqual(JSON.parse(c.body), { deliveredBy: "MERCHANT" });
  assert.equal(c.headers["Content-Type"], "application/json");
  assert.equal(c.headers.Authorization, "Bearer tok");
  // sem `deliveredBy` explícito o padrão também é MERCHANT (único valor possível)
  const g = fetchFalso([{ status: 202, corpo: { status: "ACCEPTED" } }]);
  await orderClientReal.despacharPedido({ accessToken: "t", orderId: ORDER, http: httpComFetch(g.impl) });
  assert.deepEqual(JSON.parse(g.chamadas[0].body), { deliveredBy: "MERCHANT" });
});

test("HTTP dispatch: qualquer entrega que NÃO seja MERCHANT nunca chega à rede", async () => {
  const f = fetchFalso([{ status: 202, corpo: { status: "ACCEPTED" } }]);
  for (const deliveredBy of ["IFOOD", "ifood", "", null, "OUTRO"]) {
    await assert.rejects(orderClientReal.despacharPedido({ accessToken: "t", orderId: ORDER, deliveredBy, http: httpComFetch(f.impl) }),
      (e) => e.codigo === IFOOD_ERROS.IFOOD_ACAO_NAO_ELEGIVEL, String(deliveredBy));
  }
  assert.equal(f.chamadas.length, 0);
});

test("dispatch elegível: o service envia deliveredBy dos detalhes e audita o corpo enviado; inelegíveis (marketplace/TAKEOUT/DINE_IN/INDOOR) não geram POST", async () => {
  const a = await ambiente();
  await preparar(a, { codigos: ["PLC", "CFM", "RTP"] });
  const c = clienteFake();
  await despachar(dep(a, c));
  assert.equal(c.chamadas.dispatch.length, 1);
  assert.equal(c.chamadas.dispatch[0].deliveredBy, "MERCHANT");
  assert.deepEqual(a.repo.acoes.at(-1).request_payload, { deliveredBy: "MERCHANT" });
  assert.equal(a.repo.acoes.at(-1).acao, "dispatch");

  const c2 = clienteFake();
  for (const [tipo, entrega] of [["DELIVERY", "IFOOD"], ["TAKEOUT", "MERCHANT"], ["DINE_IN", "MERCHANT"], ["INDOOR", "MERCHANT"]]) {
    const b = await ambiente();
    await preparar(b, { codigos: ["PLC", "CFM", "RTP"], tipo, entrega });
    await assert.rejects(despachar(dep(b, c2)), (e) => e.codigo === IFOOD_ERROS.IFOOD_ACAO_NAO_ELEGIVEL, `${tipo}/${entrega}`);
    assert.equal(b.repo.acoes.length, 0, "nem auditoria de envio: nada foi tentado");
  }
  assert.equal(c2.chamadas.dispatch.length, 0);
});

test("HTTP: 401/404/409/422/429/5xx/timeout em ready, dispatch e cancel — UMA única chamada (sem retry automático)", async () => {
  const chamar = { ready: (h) => orderClientReal.notificarPedidoPronto({ accessToken: "t", orderId: ORDER, http: h }),
    dispatch: (h) => orderClientReal.despacharPedido({ accessToken: "t", orderId: ORDER, deliveredBy: "MERCHANT", http: h }),
    cancel: (h) => orderClientReal.solicitarCancelamento({ accessToken: "t", orderId: ORDER, reason: "501", http: h }) };
  const esperado = [[401, "IFOOD_TOKEN_EXPIRADO"], [404, "IFOOD_PEDIDO_NAO_ENCONTRADO"], [409, "IFOOD_ACAO_PEDIDO_RECUSADA"], [422, "IFOOD_ACAO_PEDIDO_RECUSADA"],
    [429, "IFOOD_RATE_LIMITED"], [503, "IFOOD_INDISPONIVEL"], [500, "IFOOD_INDISPONIVEL"]];
  for (const [nome, fn] of Object.entries(chamar)) {
    for (const [status, codigo] of esperado) {
      const f = fetchFalso([{ status }]);
      const e = await fn(httpComFetch(f.impl)).then(() => null, (x) => x);
      assert.equal(e?.codigo, IFOOD_ERROS[codigo], `${nome} ${status}`);
      assert.equal(f.chamadas.length, 1, `${nome} ${status}: mutante não é repetido`);
    }
    const ft = fetchFalso([{ timeout: true }]);
    const et = await fn(httpComFetch(ft.impl)).then(() => null, (x) => x);
    assert.equal(et.codigo, IFOOD_ERROS.IFOOD_INDISPONIVEL);
    assert.equal(ft.chamadas.length, 1, `${nome} timeout: uma chamada`);
    const fr = fetchFalso([{ erroRede: true }]);
    await fn(httpComFetch(fr.impl)).then(() => null, () => null);
    assert.equal(fr.chamadas.length, 1, `${nome} rede: uma chamada`);
  }
});

test("HTTP cancelamento: cancellationReasons (lista, 204, formato inesperado) e requestCancellation com corpo {reason}", async () => {
  const f = fetchFalso([{ status: 200, corpo: { reasons: [{ code: 501, description: "SISTEMA", extra: "x" }, { code: "503" }, { descricao: "sem code" }] } }]);
  const lista = await orderClientReal.listarMotivosCancelamento({ accessToken: "t", orderId: ORDER, http: httpComFetch(f.impl) });
  assert.deepEqual(lista.map((m) => m.code), ["501", "503"]);
  assert.equal(lista[0].extra, "x", "campos extras do iFood preservados");
  assert.equal(f.chamadas[0].url, "https://mock.ifood.test/order/v1.0/orders/order-1/cancellationReasons");
  assert.equal(f.chamadas[0].method, "GET");

  const vazio = await orderClientReal.listarMotivosCancelamento({ accessToken: "t", orderId: ORDER, http: httpComFetch(fetchFalso([{ status: 204, corpo: "" }]).impl) });
  assert.deepEqual(vazio, []);
  await assert.rejects(orderClientReal.listarMotivosCancelamento({ accessToken: "t", orderId: ORDER, http: httpComFetch(fetchFalso([{ status: 200, corpo: { x: 1 } }]).impl) }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA);

  const g = fetchFalso([{ status: 202, corpo: { status: "ACCEPTED" } }]);
  const r = await orderClientReal.solicitarCancelamento({ accessToken: "tok", orderId: ORDER, reason: "503", http: httpComFetch(g.impl) });
  assert.deepEqual(r, { status: 202, aceito: true });
  assert.equal(g.chamadas[0].url, "https://mock.ifood.test/order/v1.0/orders/order-1/requestCancellation");
  assert.equal(g.chamadas[0].method, "POST");
  assert.deepEqual(JSON.parse(g.chamadas[0].body), { cancellationCode: "503", reason: "503" }, "sem descrição: o reason cai no código");
  const h = fetchFalso([{ status: 202, corpo: { status: "ACCEPTED" } }]);
  await orderClientReal.solicitarCancelamento({ accessToken: "tok", orderId: ORDER, reason: "503", descricao: "Item indisponível/desatualizado", http: httpComFetch(h.impl) });
  assert.deepEqual(JSON.parse(h.chamadas[0].body), { cancellationCode: "503", reason: "Item indisponível/desatualizado" }, "corpo REAL exigido pelo iFood (cancellationCode)");
  await assert.rejects(orderClientReal.solicitarCancelamento({ accessToken: "t", orderId: ORDER, reason: "  ", http: httpComFetch(g.impl) }), (e) => e.codigo === IFOOD_ERROS.IFOOD_MOTIVO_CANCELAMENTO_INVALIDO);
});

test("HTTP: o GET de motivos PODE repetir (leitura); o POST mutante não", async () => {
  const f = fetchFalso([{ status: 503 }, { status: 200, corpo: { reasons: [{ code: "501" }] } }]);
  const r = await orderClientReal.listarMotivosCancelamento({ accessToken: "t", orderId: ORDER, http: httpComFetch(f.impl) });
  assert.equal(r.length, 1);
  assert.equal(f.chamadas.length, 2);
});

// ===========================================================================
// 6) AUDITORIA e segurança
// ===========================================================================
test("auditoria: nunca grava token/segredo (chaves sensíveis removidas; nada do token fake aparece nas ações)", async () => {
  const limpo = sanitizarParaAuditoria({ reason: "501", accessToken: "abc", Authorization: "Bearer x", nested: { client_secret: "s", refresh_token: "r", ok: 1 }, lista: [{ password: "p", v: 2 }] });
  assert.deepEqual(limpo, { reason: "501", nested: { ok: 1 }, lista: [{ v: 2 }] });
  assert.equal(sanitizarParaAuditoria(null), null);

  const a = await ambiente();
  await preparar(a);
  const c = clienteFake({ cancel: [erro("IFOOD_ACAO_PEDIDO_RECUSADA", { status: 400 })] });
  await notificarPronto(dep(a, c));
  await evento(a, "RTP", 3);                                                 // o ready se resolve; só então o cancelamento pode partir
  await cancelar(dep(a, c, { motivo: "501" })).catch(() => {});
  assert.ok(a.repo.acoes.length >= 2);
  assert.doesNotMatch(JSON.stringify(a.repo.acoes), /tok-super-secreto-nao-logar|Bearer /);
});

test("classificação de falhas: incerto x definitivo", () => {
  assert.equal(classificarFalhaDeAcao(erro("IFOOD_INDISPONIVEL")), "incerto");
  assert.equal(classificarFalhaDeAcao(erro("IFOOD_RESPOSTA_INVALIDA")), "incerto");
  assert.equal(classificarFalhaDeAcao(new Error("boom")), "incerto");
  for (const c of ["IFOOD_TOKEN_EXPIRADO", "IFOOD_PEDIDO_NAO_ENCONTRADO", "IFOOD_ACAO_PEDIDO_RECUSADA", "IFOOD_RATE_LIMITED", "IFOOD_MERCHANT_SEM_PERMISSAO"]) {
    assert.equal(classificarFalhaDeAcao(erro(c)), "definitivo", c);
  }
});

test("corrida: dois ready simultâneos — só um POST (o outro vê EM_ENVIO)", async () => {
  const a = await ambiente();
  await preparar(a);
  let liberar;
  const trava = new Promise((r) => { liberar = r; });
  const c = clienteFake({ aoEnviar: () => trava });
  const p1 = notificarPronto(dep(a, c));
  await new Promise((r) => setImmediate(r));
  const r2 = await notificarPronto(dep(a, c));
  assert.equal(r2.resultado, "EM_ENVIO");
  liberar();
  assert.equal((await p1).resultado, "SOLICITADO");
  assert.equal(c.chamadas.ready.length, 1);
});

test("HTTP cancelamento: FORMA REAL do sandbox — lista de {cancelCodeId, description} é normalizada para `code` (regressão: antes vinha vazia)", async () => {
  const real = [{ cancelCodeId: "501", description: "Problemas de sistema na loja" }, { cancelCodeId: "503", description: "Item indisponível/desatualizado" }, { cancelCodeId: "523", description: "Erro na promoção" }];
  const f = fetchFalso([{ status: 200, corpo: real }]);
  const lista = await orderClientReal.listarMotivosCancelamento({ accessToken: "t", orderId: ORDER, http: httpComFetch(f.impl) });
  assert.deepEqual(lista.map((m) => [m.code, m.description]), [["501", "Problemas de sistema na loja"], ["503", "Item indisponível/desatualizado"], ["523", "Erro na promoção"]]);
  assert.equal(lista[0].cancelCodeId, "501", "campo original preservado");
  // a forma da documentação continua aceita, e a lista vazia continua vazia
  const doc = await orderClientReal.listarMotivosCancelamento({ accessToken: "t", orderId: ORDER, http: httpComFetch(fetchFalso([{ status: 200, corpo: { reasons: [{ code: "501", description: "x" }] } }]).impl) });
  assert.deepEqual(doc.map((m) => m.code), ["501"]);
  const vazia = await orderClientReal.listarMotivosCancelamento({ accessToken: "t", orderId: ORDER, http: httpComFetch(fetchFalso([{ status: 200, corpo: [] }]).impl) });
  assert.deepEqual(vazia, []);
});

test("cancelar valida o motivo contra a lista OFICIAL na forma real (cancelCodeId) e envia o código", async () => {
  const a = await ambiente();
  await preparar(a);
  const real = [{ cancelCodeId: "501", description: "Problemas de sistema na loja" }];
  const c = clienteFake({ motivos: [real.map((r) => ({ ...r, code: r.cancelCodeId }))] });
  const r = await cancelar(dep(a, c, { motivo: "501" }));
  assert.equal(r.resultado, "SOLICITADO");
  assert.equal(pedidoDe(a).cancel_reason_description, "Problemas de sistema na loja");
});

test("recusa do iFood: code/message do corpo do erro (ex.: OrderExceededCancellationDeadline) vão para os detalhes e para a auditoria — sem corpo bruto", async () => {
  const f = fetchFalso([{ status: 400, corpo: { code: "OrderExceededCancellationDeadline", message: "Order has exceeded the time to be cancelled.", extra: { pii: "não vai" } } }]);
  const e = await orderClientReal.solicitarCancelamento({ accessToken: "t", orderId: ORDER, reason: "503", http: httpComFetch(f.impl) }).then(() => null, (x) => x);
  assert.equal(e.codigo, IFOOD_ERROS.IFOOD_ACAO_PEDIDO_RECUSADA);
  assert.equal(e.details.status, 400);
  assert.equal(e.details.ifoodCode, "OrderExceededCancellationDeadline");
  assert.match(e.details.ifoodMessage, /exceeded the time/);
  assert.equal(JSON.stringify(e.details).includes("pii"), false, "só code e message");
  assert.equal(f.chamadas.length, 1);

  const a = await ambiente();
  await preparar(a);
  const c = clienteFake({ cancel: [Object.assign(erro("IFOOD_ACAO_PEDIDO_RECUSADA", { status: 400 }), { details: { status: 400, ifoodCode: "OrderHasACancellationInProgress", ifoodMessage: "em andamento" } })] });
  await cancelar(dep(a, c, { motivo: "501" })).catch(() => {});
  assert.equal(a.repo.acoes.at(-1).error_message, "OrderHasACancellationInProgress: em andamento");
  assert.equal(a.repo.acoes.at(-1).resultado, "RECUSADA");
  // corpo ilegível/ausente: segue sem os campos
  const g = fetchFalso([{ status: 400, corpo: "não é json" }]);
  const e2 = await orderClientReal.solicitarCancelamento({ accessToken: "t", orderId: ORDER, reason: "503", http: httpComFetch(g.impl) }).then(() => null, (x) => x);
  assert.equal(e2.details.status, 400);
  assert.equal(e2.details.ifoodCode, undefined);
});
