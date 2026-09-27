// Handshake / Plataforma de negociação (Checkpoint D): HANDSHAKE_DISPUTE (HSD) e HANDSHAKE_SETTLEMENT (HSS).
// Receber: persistir, deduplicar, tolerar fora de ordem. Responder: accept/reject/alternative — uma resposta por disputa,
// sem retry cego; o HTTP aceito NÃO encerra a negociação (só o evento HSS encerra).
//
// Rodar: node --experimental-vm-modules --test test/ifood-handshake.test.js
import test from "node:test";
import assert from "node:assert/strict";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";

const httpReal = await import("../src/modules/ifood/ifoodHttp.client.js");
const { IFOOD_ERROS, ifoodErro } = await import("../src/modules/ifood/ifood.errors.js");
const { IFOOD_ORDER } = await import("../src/modules/ifood/ifood.constants.js");
const hsClientReal = await import("../src/modules/ifood/ifoodHandshake.client.js");
const { responderDisputa, validarResposta, aplicarHandshake } = await import("../src/modules/ifood/ifoodHandshake.service.js");
const { interpretarDisputa, interpretarSettlement } = await import("../src/modules/ifood/ifoodHandshake.parser.js");
const { processarLote, reprocessarPendentes } = await import("../src/modules/ifood/ifoodEvents.service.js");
const {
  criarRepoEmMemoria, criarRelogio, criarTokenFake, ev, t, ORG_A, UN_A, ORG_B, UN_B, M_A, M_B, CONEXAO_A,
} = await import("./helpers/ifood-events-fakes.js");

const silencio = () => {};
const ORDER = "order-1";
const erro = (codigo, detalhes) => ifoodErro(IFOOD_ERROS[codigo], detalhes ? { detalhes } : undefined);

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
      headers: { get: (h) => (h.toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => (typeof r.corpo === "string" ? r.corpo : JSON.stringify(r.corpo ?? {})),
    };
  };
  return { chamadas, impl };
}
const httpComFetch = (impl) => ({ postJson: (c, b, o) => httpReal.postJson(c, b, { ...o, fetchImpl: impl }) });

/** Cliente de Handshake programável (fila por método; o último item se repete). */
function clienteFake({ accept = [], reject = [], alternative = [], aoEnviar } = {}) {
  const chamadas = { accept: [], reject: [], alternative: [] };
  const prox = (fila, padrao) => { const r = fila.length > 1 ? fila.shift() : (fila[0] ?? padrao); if (r instanceof Error) throw r; return r; };
  const ok = (status) => ({ status: 201, aceito: true, settlementId: "s-1", settlementStatus: status, resposta: { id: "s-1", status, disputeId: "d" } });
  return {
    chamadas,
    async aceitarDisputa(a) { chamadas.accept.push(a); await aoEnviar?.(); return prox(accept, ok("ACCEPTED")); },
    async rejeitarDisputa(a) { chamadas.reject.push(a); await aoEnviar?.(); return prox(reject, ok("REJECTED")); },
    async proporAlternativa(a) { chamadas.alternative.push(a); await aoEnviar?.(); return prox(alternative, ok("ALTERNATIVE_REPLIED")); },
  };
}

async function ambiente() {
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio });
  const token = criarTokenFake({ escopo: "app" });
  const mapa = new Map(repo.conexoes.map((c) => [c.merchant_id, c]));
  const eventos = (brutos) => processarLote({ eventosBrutos: brutos, conexoesPorMerchant: mapa, repo, agora: relogio.agora, log: silencio });
  return { relogio, repo, token, mapa, eventos };
}
const dispDe = (a, id = "disp-1") => a.repo.disputas.get(id);
const dep = (a, client, extra = {}) => ({ organizacaoId: ORG_A, unidadeId: UN_A, disputeId: "disp-1", repo: a.repo, token: a.token, client, agora: a.relogio.agora, log: silencio, ...extra });

const disputa = (id = "disp-1", o = {}) => ({
  id, action: "CANCELLATION", handshakeType: "PREPARATION_TIME", handshakeGroup: "CUSTOMER_ORDER_SUPPORT", message: "Comprei sem querer",
  expiresAt: t(30), timeoutAction: "REJECT_CANCELLATION", createdAt: t(0), alternatives: [], ...o,
});
const HSD = (id, meta, { min = 0, orderId = ORDER, merchantId = M_A } = {}) => ev(id, "HSD", { min, orderId, merchantId, metadata: meta });
const HSS = (id, meta, { min = 1, orderId = ORDER, merchantId = M_A } = {}) => ev(id, "HSS", { min, orderId, merchantId, metadata: meta });
const settle = (disputeId, status, o = {}) => ({ id: `set-${disputeId}-${status}`, disputeId, status, createdAt: t(1), ...o });
const ALT_REFUND = { id: "alt-1", type: "REFUND", metadata: { maxAmount: { currency: "BRL", value: "5000" } } };
const ALT_TIME = { id: "alt-2", type: "ADDITIONAL_TIME", metadata: { allowedsAdditionalTimeInMinutes: [10, 15, 30], allowedsAdditionalTimeReasons: ["HIGH_STORE_DEMAND", "OPERATIONAL_ISSUES"] } };

// ===========================================================================
// 1) RECEBER
// ===========================================================================
test("HSD novo: persistido com o tenant da CONEXÃO, campos oficiais e payload bruto; evento PROCESSADO e reconhecido", async () => {
  const a = await ambiente();
  const meta = disputa("disp-1", { handshakeType: "AFTER_DELIVERY", alternatives: [ALT_REFUND], metadata: { acceptCancellationReasons: ["PRODUCT_QUALITY"] }, evidences: [{ url: "https://x/y", contentType: "image/jpeg" }] });
  const { idsParaAck, resumo } = await a.eventos([HSD("h1", meta)]);
  assert.equal(resumo.processados, 1);
  assert.deepEqual(idsParaAck, ["h1"]);
  assert.equal(a.repo.eventos.get("h1").processing_status, "PROCESSADO");

  const d = dispDe(a);
  assert.equal(d.organizacao_id, ORG_A);
  assert.equal(d.unidade_id, UN_A);
  assert.equal(d.order_id, ORDER);
  assert.equal(d.merchant_id, M_A);
  assert.equal(d.status, "ABERTA");
  assert.equal(d.action, "CANCELLATION");
  assert.equal(d.handshake_type, "AFTER_DELIVERY");
  assert.equal(d.timeout_action, "REJECT_CANCELLATION");
  assert.equal(d.expires_at, t(30));
  assert.equal(d.alternatives[0].type, "REFUND");
  assert.deepEqual(d.accept_cancellation_reasons, ["PRODUCT_QUALITY"]);
  assert.equal(d.evidences.length, 1);
  assert.equal(d.dispute_payload.message, "Comprei sem querer", "payload bruto preservado");
  assert.equal(d.dispute_event_id, "h1");
  assert.equal(d.dispute_event_received_at, a.relogio.agora().toISOString());
  assert.equal(a.repo.pedidos.get(ORDER).organizacao_id, ORG_A, "esqueleto do pedido no mesmo tenant");
});

test("HSD duplicado: mesmo evento (reentrega) e mesma disputa com outro id de evento não duplicam nem alteram", async () => {
  const a = await ambiente();
  await a.eventos([HSD("h1", disputa())]);
  const antes = structuredClone(dispDe(a));
  const r1 = await a.eventos([HSD("h1", disputa())]);                                   // reentrega do mesmo evento
  assert.equal(r1.resumo.reentregas, 1);
  const r2 = await a.eventos([HSD("h2", disputa("disp-1", { message: "outra mensagem" }), { min: 2 })]);   // mesma disputa, evento novo
  assert.equal(r2.resumo.ignorados, 1);
  assert.equal(a.repo.disputas.size, 1);
  assert.deepEqual(dispDe(a), antes);
  assert.equal(a.repo.eventos.get("h2").processing_status, "IGNORADO");
});

test("HSD: forma aninhada (metadata.dispute) aceita como fallback; metadata inválido é IGNORADO sem quebrar o worker (evento guardado e reconhecido)", async () => {
  const a = await ambiente();
  const r = await a.eventos([HSD("h1", { disputable: true, dispute: { id: "disp-9", orderId: ORDER, status: "OPEN", expiresAt: t(20) } }), HSD("h2", null), HSD("h3", { semId: true })]);
  assert.equal(dispDe(a, "disp-9").expires_at, t(20));
  assert.equal(a.repo.eventos.get("h1").processing_status, "PROCESSADO");
  assert.equal(a.repo.eventos.get("h2").processing_status, "IGNORADO");
  assert.equal(a.repo.eventos.get("h3").processing_status, "IGNORADO");
  assert.deepEqual(r.idsParaAck.sort(), ["h1", "h2", "h3"], "política de ACK preservada");
  assert.equal(a.repo.disputas.size, 1);
  assert.equal(interpretarDisputa(undefined).valido, false);
  assert.equal(interpretarDisputa({ id: "x", handshakeType: "NOVO_TIPO" }).avisos.length > 0, true);
});

test("HSS: encerra a negociação; ACCEPTED/REJECTED/EXPIRED são finais; ALTERNATIVE_REPLIED espera o cliente e o final depois encerra", async () => {
  for (const final of ["ACCEPTED", "REJECTED", "EXPIRED"]) {
    const a = await ambiente();
    await a.eventos([HSD("h1", disputa())]);
    await a.eventos([HSS("s1", settle("disp-1", final, { reason: "motivo" }))]);
    const d = dispDe(a);
    assert.equal(d.status, "ENCERRADA", final);
    assert.equal(d.settlement_status, final);
    assert.equal(d.settlement_reason, "motivo");
    assert.equal(d.settlements.length, 1);
  }
  const a = await ambiente();
  await a.eventos([HSD("h1", disputa("disp-1", { handshakeType: "AFTER_DELIVERY", alternatives: [ALT_REFUND] }))]);
  await a.eventos([HSS("s1", settle("disp-1", "ALTERNATIVE_REPLIED", { selectedDisputeAlternative: { type: "REFUND", metadata: { amount: { currency: "BRL", value: "200" } } } }), { min: 1 })]);
  assert.equal(dispDe(a).status, "RESPONDIDA", "contraproposta enviada: ainda aguarda a resposta do cliente");
  await a.eventos([HSS("s2", settle("disp-1", "ACCEPTED"), { min: 2 })]);
  const d = dispDe(a);
  assert.equal(d.status, "ENCERRADA");
  assert.equal(d.settlement_status, "ACCEPTED");
  assert.deepEqual(d.settlements.map((s) => s.status), ["ALTERNATIVE_REPLIED", "ACCEPTED"]);
});

test("HSS duplicado (mesmo evento e reentrega) e settlement fora de catálogo: idempotente / guardado com aviso", async () => {
  const a = await ambiente();
  await a.eventos([HSD("h1", disputa())]);
  await a.eventos([HSS("s1", settle("disp-1", "REJECTED"))]);
  const antes = structuredClone(dispDe(a));
  await a.eventos([HSS("s1", settle("disp-1", "REJECTED"))]);                           // reentrega
  assert.deepEqual(dispDe(a), antes);
  const b = await ambiente();
  await b.eventos([HSD("h1", disputa())]);
  await b.eventos([HSS("s9", settle("disp-1", "ALGO_NOVO"))]);
  assert.equal(dispDe(b).status, "ABERTA", "status desconhecido não encerra nada");
  assert.equal(dispDe(b).settlements[0].status, "DESCONHECIDO");
  assert.equal(interpretarSettlement({ status: "ACCEPTED" }).valido, false, "sem disputeId");
  assert.equal(interpretarSettlement({ disputeId: "d", dispute: { status: "SETTLED", resolution: "MERCHANT_ACCEPTED" } }).valido, true);
});

test("evento FORA DE ORDEM: HSS antes do HSD cria o esqueleto encerrado; o HSD depois só COMPLETA os campos e nunca reabre", async () => {
  const a = await ambiente();
  await a.eventos([HSS("s1", settle("disp-1", "EXPIRED"), { min: 5 })]);
  assert.equal(dispDe(a).status, "ENCERRADA");
  assert.equal(dispDe(a).expires_at ?? null, null);
  await a.eventos([HSD("h1", disputa("disp-1", { handshakeType: "DELAY" }), { min: 0 })]);
  const d = dispDe(a);
  assert.equal(d.status, "ENCERRADA", "HSD tardio não reabre a negociação");
  assert.equal(d.handshake_type, "DELAY");
  assert.equal(d.expires_at, t(30));
  assert.equal(d.settlement_status, "EXPIRED");
  assert.equal(a.repo.eventos.get("h1").processing_status, "PROCESSADO");
  await assert.rejects(responderDisputa({ ...dep(a, clienteFake()), decisao: "ACCEPT" }), (e) => e.codigo === IFOOD_ERROS.IFOOD_DISPUTA_ENCERRADA);
});

test("settlement antigo depois de um final mais novo não desfaz o encerramento", async () => {
  const a = await ambiente();
  await a.eventos([HSD("h1", disputa("disp-1", { handshakeType: "AFTER_DELIVERY", alternatives: [ALT_REFUND] }))]);
  await a.eventos([HSS("s2", settle("disp-1", "ACCEPTED"), { min: 4 })]);
  await a.eventos([HSS("s1", settle("disp-1", "ALTERNATIVE_REPLIED"), { min: 2 })]);        // chegou atrasado
  const d = dispDe(a);
  assert.equal(d.status, "ENCERRADA");
  assert.equal(d.settlement_status, "ACCEPTED", "vale o mais recente por horário");
  assert.deepEqual(d.settlements.map((s) => s.status), ["ALTERNATIVE_REPLIED", "ACCEPTED"]);
});

test("pedido TERMINAL: a negociação pós-entrega (pedido CONCLUDED) é registrada e pode ser respondida; o estado oficial não muda", async () => {
  const a = await ambiente();
  await a.eventos([ev("p1", "PLC"), ev("p2", "CFM", { min: 1 }), ev("p3", "CON", { min: 5 })]);
  await a.eventos([HSD("h1", disputa("disp-1", { handshakeType: "AFTER_DELIVERY", alternatives: [ALT_REFUND] }), { min: 20 })]);
  assert.equal(a.repo.pedidos.get(ORDER).status_oficial, "CONCLUDED");
  assert.equal(dispDe(a).status, "ABERTA");
  const r = await responderDisputa({ ...dep(a, clienteFake()), decisao: "REJECT", reason: "PRODUCT_QUALITY" });
  assert.equal(r.resultado, "SOLICITADO");
  assert.equal(a.repo.pedidos.get(ORDER).status_oficial, "CONCLUDED");
});

test("MERCHANT incorreto / CROSS-TENANT no recebimento: nada é gravado no tenant errado", async () => {
  const a = await ambiente();
  await a.eventos([ev("p1", "PLC")]);
  const pedido = a.repo.pedidos.get(ORDER);
  const r = await aplicarHandshake({
    evento: { eventId: "hx", code: "HSD", orderId: ORDER, merchantId: "outro-merchant", createdAt: t(1), metadata: disputa() },
    pedido, tenant: { organizacaoId: ORG_A, unidadeId: UN_A }, repo: a.repo, log: silencio,
  });
  assert.deepEqual([r.status, r.erro, r.naoReprocessavel], ["FALHOU", "MERCHANT_DIVERGENTE", true]);
  assert.equal(a.repo.disputas.size, 0);

  // pedido da unidade A + evento do merchant B (tenant B): o pedido pertence a outro tenant
  const rr = await a.eventos([HSD("h2", disputa("disp-x"), { merchantId: M_B })]);
  assert.equal(rr.resumo.falhas, 1);
  assert.equal(a.repo.eventos.get("h2").last_error, "PEDIDO_DE_OUTRO_TENANT");
  assert.equal(a.repo.disputas.has("disp-x"), false);

  // a MESMA disputa já pertence ao tenant A: um evento do tenant B (pedido B) com o mesmo dispute id não a toca
  await a.eventos([HSD("h3", disputa("disp-1"))]);
  const antes = structuredClone(dispDe(a));
  await a.eventos([ev("pb", "PLC", { orderId: "order-b", merchantId: M_B })]);
  await a.eventos([HSD("h4", disputa("disp-1", { message: "invasor" }), { orderId: "order-b", merchantId: M_B })]);
  assert.deepEqual(dispDe(a), antes);
  assert.equal(a.repo.eventos.get("h4").last_error, "DISPUTA_DE_OUTRO_TENANT");
});

test("reprocessarPendentes recupera HSD/HSS persistidos (metadata vem do payload guardado)", async () => {
  const a = await ambiente();
  a.repo.falhar.garantirDisputa = 1;                            // falha ao processar o 1º evento
  await a.eventos([HSD("h1", disputa())]);
  assert.equal(a.repo.eventos.get("h1").processing_status, "FALHOU");
  assert.equal(a.repo.disputas.size, 0);
  const r = await reprocessarPendentes({ repo: a.repo, agora: a.relogio.agora, log: silencio });
  assert.equal(r.processados, 1);
  assert.equal(dispDe(a).expires_at, t(30));
  assert.equal(a.repo.eventos.get("h1").processing_status, "PROCESSADO");
});

// ===========================================================================
// 2) RESPONDER
// ===========================================================================
async function comDisputa(meta = disputa(), { pedidoCon = false } = {}) {
  const a = await ambiente();
  await a.eventos([ev("p1", "PLC"), ev("p2", "CFM", { min: 1 }), ...(pedidoCon ? [ev("p3", "CON", { min: 2 })] : [])]);
  await a.eventos([HSD("h1", meta, { min: 3 })]);
  return a;
}

test("ACCEPT (durante o preparo, sem corpo): 201 => RESPONDIDA; a negociação só ENCERRA com o HSS; auditoria completa", async () => {
  const a = await comDisputa();
  const c = clienteFake();
  const r = await responderDisputa({ ...dep(a, c), decisao: "ACCEPT" });
  assert.equal(r.resultado, "SOLICITADO");
  assert.equal(r.httpStatus, 201);
  const d = dispDe(a);
  assert.equal(d.status, "RESPONDIDA", "HTTP aceito não encerra");
  assert.equal(d.decision, "ACCEPT");
  assert.equal(d.decision_http_status, 201);
  assert.equal(d.decision_attempts, 1);
  assert.equal(d.decision_response.status, "ACCEPTED");
  assert.equal(c.chamadas.accept.length, 1);
  assert.equal(c.chamadas.accept[0].reason, null);
  assert.deepEqual(a.token.chamadas.at(-1), { conexaoId: "con-a", appType: "order" });
  const aud = a.repo.acoes.at(-1);
  assert.deepEqual([aud.acao, aud.resultado, aud.http_status, aud.dispute_id, aud.tentativa, aud.conexao_id], ["dispute_accept", "ACEITA", 201, "disp-1", 1, "con-a"]);
  assert.ok(aud.requested_at && aud.responded_at);
  assert.equal(a.repo.pedidos.get(ORDER).status_oficial, "CONFIRMED", "a resposta HTTP não altera o pedido");

  await a.eventos([HSS("s1", settle("disp-1", "ACCEPTED"), { min: 5 })]);
  assert.equal(dispDe(a).status, "ENCERRADA");
});

test("REJECT exige motivo; com motivo: 201 e corpo {reason}", async () => {
  const a = await comDisputa();
  const c = clienteFake();
  await assert.rejects(responderDisputa({ ...dep(a, c), decisao: "REJECT" }), (e) => e.codigo === IFOOD_ERROS.IFOOD_RESPOSTA_DISPUTA_INVALIDA);
  await assert.rejects(responderDisputa({ ...dep(a, c), decisao: "REJECT", reason: "  " }), (e) => e.codigo === IFOOD_ERROS.IFOOD_RESPOSTA_DISPUTA_INVALIDA);
  assert.equal(c.chamadas.reject.length, 0);
  assert.equal(dispDe(a).status, "ABERTA", "resposta inválida não reserva estado");
  const r = await responderDisputa({ ...dep(a, c), decisao: "REJECT", reason: "PREPARATION_IN_PROGRESS" });
  assert.equal(r.resultado, "SOLICITADO");
  assert.equal(c.chamadas.reject[0].reason, "PREPARATION_IN_PROGRESS");
  assert.deepEqual(a.repo.acoes.at(-1).request_payload, { reason: "PREPARATION_IN_PROGRESS" });
});

test("ALTERNATIVE: REFUND dentro do máximo; tempo adicional dentro do permitido; tudo fora do oferecido é recusado sem POST", async () => {
  const a = await comDisputa(disputa("disp-1", { handshakeType: "AFTER_DELIVERY", alternatives: [ALT_REFUND] }));
  const c = clienteFake();
  const invalidas = [
    { type: "REFUND", metadata: { amount: { value: "5001", currency: "BRL" } } },        // acima do maxAmount
    { type: "REFUND", metadata: { amount: { value: "0", currency: "BRL" } } },
    { type: "REFUND", metadata: { amount: { value: "abc", currency: "BRL" } } },
    { type: "REFUND", metadata: { amount: { value: "100" } } },                          // sem moeda
    { type: "ADDITIONAL_TIME", metadata: { additionalTimeInMinutes: 10, additionalTimeReason: "HIGH_STORE_DEMAND" } },   // não oferecida
    { type: "BENEFIT", metadata: { amount: { value: "100", currency: "BRL" } } },        // não oferecida
    { type: "OUTRO", metadata: {} },
  ];
  for (const alt of invalidas) {
    await assert.rejects(responderDisputa({ ...dep(a, c), decisao: "ALTERNATIVE", alternativa: alt }), (e) => e.codigo === IFOOD_ERROS.IFOOD_RESPOSTA_DISPUTA_INVALIDA, JSON.stringify(alt));
  }
  assert.equal(c.chamadas.alternative.length, 0);
  const r = await responderDisputa({ ...dep(a, c), decisao: "ALTERNATIVE", alternativa: { type: "REFUND", metadata: { amount: { value: "2000", currency: "BRL" } } } });
  assert.equal(r.resultado, "SOLICITADO");
  assert.deepEqual(c.chamadas.alternative[0].metadata, { amount: { value: "2000", currency: "BRL" } });
  assert.equal(dispDe(a).decision, "ALTERNATIVE");
  assert.equal(a.repo.acoes.at(-1).acao, "dispute_alternative");

  const b = await comDisputa(disputa("disp-1", { handshakeType: "DELAY", alternatives: [ALT_TIME], metadata: { acceptCancellationReasons: ["HIGH_STORE_DEMAND", "OTHER_REASONS"] } }));
  for (const meta of [{ additionalTimeInMinutes: 45, additionalTimeReason: "HIGH_STORE_DEMAND" }, { additionalTimeInMinutes: 10, additionalTimeReason: "INVENTADO" }, { additionalTimeReason: "HIGH_STORE_DEMAND" }]) {
    await assert.rejects(responderDisputa({ ...dep(b, c), decisao: "ALTERNATIVE", alternativa: { type: "ADDITIONAL_TIME", metadata: meta } }), (e) => e.codigo === IFOOD_ERROS.IFOOD_RESPOSTA_DISPUTA_INVALIDA);
  }
  const ok = await responderDisputa({ ...dep(b, c), decisao: "ALTERNATIVE", alternativa: { type: "ADDITIONAL_TIME", metadata: { additionalTimeInMinutes: 30, additionalTimeReason: "OPERATIONAL_ISSUES" } } });
  assert.equal(ok.resultado, "SOLICITADO");
});

test("matriz do iFood: durante o PREPARO só aceitar/rejeitar; DELAY exige motivo de aceite da lista; motivo de aceite fora da lista é recusado", () => {
  const prep = { handshake_type: "PREPARATION_TIME", alternatives: [], accept_cancellation_reasons: [] };
  assert.throws(() => validarResposta(prep, { decisao: "ALTERNATIVE", alternativa: { type: "REFUND", metadata: {} } }), (e) => /contraproposta|oferecida/.test(e.details?.motivo ?? ""));
  assert.equal(validarResposta(prep, { decisao: "ACCEPT" }).corpo, null);
  const delay = { handshake_type: "DELAY", alternatives: [ALT_TIME], accept_cancellation_reasons: ["HIGH_STORE_DEMAND", "OTHER_REASONS"] };
  assert.throws(() => validarResposta(delay, { decisao: "ACCEPT" }), (e) => /DELAY exige/.test(e.details?.motivo ?? ""));
  assert.throws(() => validarResposta(delay, { decisao: "ACCEPT", reason: "INVENTADO" }), (e) => /fora de acceptCancellationReasons/.test(e.details?.motivo ?? ""));
  assert.deepEqual(validarResposta(delay, { decisao: "ACCEPT", reason: "OTHER_REASONS", detailReason: "x".repeat(400) }).corpo.detailReason.length, 250);
  const depois = { handshake_type: "AFTER_DELIVERY", alternatives: [ALT_REFUND], accept_cancellation_reasons: ["PRODUCT_QUALITY"] };
  assert.equal(validarResposta(depois, { decisao: "ACCEPT" }).corpo, null, "após a entrega o corpo é opcional");
  assert.throws(() => validarResposta(depois, { decisao: "TALVEZ" }), (e) => /decisão desconhecida/.test(e.details?.motivo ?? ""));
});

test("decisão REPETIDA: nenhum segundo POST (JA_SOLICITADO), inclusive trocando de decisão", async () => {
  const a = await comDisputa();
  const c = clienteFake();
  await responderDisputa({ ...dep(a, c), decisao: "ACCEPT" });
  assert.equal((await responderDisputa({ ...dep(a, c), decisao: "ACCEPT" })).resultado, "JA_SOLICITADO");
  assert.equal((await responderDisputa({ ...dep(a, c), decisao: "REJECT", reason: "X" })).resultado, "JA_SOLICITADO", "uma resposta por disputeId");
  assert.equal(c.chamadas.accept.length + c.chamadas.reject.length, 1);
  assert.equal(dispDe(a).decision_attempts, 1);
});

test("TIMEOUT / 5xx: RESPOSTA_INCERTA + AGUARDANDO_EVENTO (o iFood pode ter processado); sem reenvio cego; o HSS resolve", async () => {
  for (const codigo of ["IFOOD_INDISPONIVEL", "IFOOD_RESPOSTA_INVALIDA"]) {
    const a = await comDisputa();
    const c = clienteFake({ accept: [erro(codigo, { motivo: "timeout" }), { status: 201, aceito: true, resposta: { status: "ACCEPTED" } }] });
    const r = await responderDisputa({ ...dep(a, c), decisao: "ACCEPT" });
    assert.equal(r.resultado, "AGUARDANDO_EVENTO", codigo);
    assert.equal(r.incerto, true);
    assert.equal(dispDe(a).status, "RESPOSTA_INCERTA");
    assert.equal(a.repo.acoes.at(-1).resultado, "INCERTO");
    assert.equal((await responderDisputa({ ...dep(a, c), decisao: "ACCEPT" })).resultado, "AGUARDANDO_EVENTO");
    assert.equal((await responderDisputa({ ...dep(a, c), decisao: "ACCEPT", permitirReenvioIncerto: true })).resultado, "AGUARDANDO_EVENTO", "explícito, mas cedo");
    assert.equal(c.chamadas.accept.length, 1);

    // o settlement chega: resolve a incerteza sem nenhum reenvio
    await a.eventos([HSS("s1", settle("disp-1", "ACCEPTED"), { min: 6 })]);
    assert.equal(dispDe(a).status, "ENCERRADA");
    await assert.rejects(responderDisputa({ ...dep(a, c), decisao: "ACCEPT" }), (e) => e.codigo === IFOOD_ERROS.IFOOD_DISPUTA_ENCERRADA);
    assert.equal(c.chamadas.accept.length, 1);
  }
  const b = await comDisputa();
  const c2 = clienteFake({ accept: [erro("IFOOD_INDISPONIVEL"), { status: 201, aceito: true, resposta: { status: "ACCEPTED" } }] });
  await responderDisputa({ ...dep(b, c2), decisao: "ACCEPT" });
  b.relogio.avancarS(IFOOD_ORDER.reenvioIncertoAposMs / 1000 + 1);
  b.repo.disputas.get("disp-1").expires_at = t(60);
  const r = await responderDisputa({ ...dep(b, c2), decisao: "ACCEPT", permitirReenvioIncerto: true });
  assert.equal(r.resultado, "SOLICITADO");
  assert.equal(c2.chamadas.accept.length, 2);
});

test("erros do iFood (401/404/422 já respondida/400): RESPOSTA_FALHOU, erro propagado, tentativa nova permitida (exceto ENCERRADA)", async () => {
  const a = await comDisputa();
  const c = clienteFake({ accept: [erro("IFOOD_ACAO_PEDIDO_RECUSADA", { status: 422 }), erro("IFOOD_TOKEN_EXPIRADO"), { status: 201, aceito: true, resposta: { status: "ACCEPTED" } }] });
  await assert.rejects(responderDisputa({ ...dep(a, c), decisao: "ACCEPT" }), (e) => e.codigo === IFOOD_ERROS.IFOOD_ACAO_PEDIDO_RECUSADA);
  assert.equal(dispDe(a).status, "RESPOSTA_FALHOU");
  assert.equal(dispDe(a).decision_http_status, 422);
  assert.equal(a.repo.acoes.at(-1).resultado, "RECUSADA");
  await assert.rejects(responderDisputa({ ...dep(a, c), decisao: "ACCEPT" }), (e) => e.codigo === IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO);
  assert.equal(dispDe(a).decision_attempts, 2);
  const r = await responderDisputa({ ...dep(a, c), decisao: "ACCEPT" });
  assert.equal(r.resultado, "SOLICITADO");
  assert.equal(dispDe(a).decision_attempts, 3);
  assert.equal(dispDe(a).status, "RESPONDIDA");
});

test("HSS chega DURANTE o POST: o settlement é a fonte; a resposta não reabre nem sobrescreve", async () => {
  const a = await comDisputa();
  const c = clienteFake({ aoEnviar: () => a.eventos([HSS("s1", settle("disp-1", "ACCEPTED"), { min: 6 })]) });
  const r = await responderDisputa({ ...dep(a, c), decisao: "ACCEPT" });
  assert.equal(r.resultado, "SOLICITADO");
  assert.equal(r.settlementJaChegou, true);
  assert.equal(dispDe(a).status, "ENCERRADA");
  assert.equal(r.status, "ENCERRADA");
});

test("prazo (expiresAt) vencido: nada é enviado (o iFood já aplicou timeoutAction)", async () => {
  const a = await comDisputa(disputa("disp-1", { expiresAt: t(10) }));
  a.relogio.avancarS(11 * 60);
  const c = clienteFake();
  await assert.rejects(responderDisputa({ ...dep(a, c), decisao: "ACCEPT" }), (e) => e.codigo === IFOOD_ERROS.IFOOD_DISPUTA_ENCERRADA && e.details.motivo === "prazo_expirado");
  assert.equal(c.chamadas.accept.length, 0);
});

test("CROSS-TENANT ao responder: disputa de outra unidade/organização = inexistente; nada enviado", async () => {
  const a = await comDisputa();
  const c = clienteFake();
  await assert.rejects(responderDisputa({ ...dep(a, c, { organizacaoId: ORG_B, unidadeId: UN_B }), decisao: "ACCEPT" }), (e) => e.codigo === IFOOD_ERROS.IFOOD_DISPUTA_NAO_ENCONTRADA);
  await assert.rejects(responderDisputa({ ...dep(a, c, { unidadeId: UN_B }), decisao: "ACCEPT" }), (e) => e.codigo === IFOOD_ERROS.IFOOD_DISPUTA_NAO_ENCONTRADA);
  await assert.rejects(responderDisputa({ ...dep(a, c, { disputeId: "nao-existe" }), decisao: "ACCEPT" }), (e) => e.codigo === IFOOD_ERROS.IFOOD_DISPUTA_NAO_ENCONTRADA);
  assert.equal(c.chamadas.accept.length, 0);
  assert.equal(dispDe(a).status, "ABERTA");
});

test("sem conexão viva para o merchant: nenhuma resposta enviada e a disputa não fica presa em RESPONDENDO", async () => {
  const a = await comDisputa();
  a.repo.conexoes.length = 0;
  const c = clienteFake();
  await assert.rejects(responderDisputa({ ...dep(a, c), decisao: "ACCEPT" }), (e) => e.codigo === IFOOD_ERROS.IFOOD_CONEXAO_NAO_ENCONTRADA);
  assert.equal(dispDe(a).status, "ABERTA");
  assert.equal(c.chamadas.accept.length, 0);
});

test("corrida: duas respostas simultâneas — só um POST (a outra vê EM_ENVIO)", async () => {
  const a = await comDisputa();
  let liberar;
  const trava = new Promise((r) => { liberar = r; });
  const c = clienteFake({ aoEnviar: () => trava });
  const p1 = responderDisputa({ ...dep(a, c), decisao: "ACCEPT" });
  await new Promise((r) => setImmediate(r));
  const r2 = await responderDisputa({ ...dep(a, c), decisao: "ACCEPT" });
  assert.equal(r2.resultado, "EM_ENVIO");
  liberar();
  assert.equal((await p1).resultado, "SOLICITADO");
  assert.equal(c.chamadas.accept.length, 1);
});

// ===========================================================================
// 3) HTTP real do cliente (fetch falso)
// ===========================================================================
test("HTTP: accept (sem corpo e com motivo), reject e alternative — paths, corpo e 201", async () => {
  const f1 = fetchFalso([{ status: 201, corpo: { id: "set-1", status: "ACCEPTED", disputeId: "disp-1" } }]);
  const r1 = await hsClientReal.aceitarDisputa({ accessToken: "tok", disputeId: "disp-1", http: httpComFetch(f1.impl) });
  assert.equal(r1.aceito, true);
  assert.equal(r1.settlementStatus, "ACCEPTED");
  assert.equal(f1.chamadas[0].url, "https://mock.ifood.test/order/v1.0/disputes/disp-1/accept");
  assert.equal(f1.chamadas[0].method, "POST");
  assert.equal(f1.chamadas[0].body, undefined, "aceite sem motivo: sem corpo");
  assert.equal(f1.chamadas[0].headers.Authorization, "Bearer tok");

  const f2 = fetchFalso([{ status: 201, corpo: { status: "ACCEPTED" } }]);
  await hsClientReal.aceitarDisputa({ accessToken: "t", disputeId: "d/1", reason: "STORE_SYSTEM_ISSUES", detailReason: "z".repeat(300), http: httpComFetch(f2.impl) });
  assert.equal(f2.chamadas[0].url, "https://mock.ifood.test/order/v1.0/disputes/d%2F1/accept");
  const corpo2 = JSON.parse(f2.chamadas[0].body);
  assert.equal(corpo2.reason, "STORE_SYSTEM_ISSUES");
  assert.equal(corpo2.detailReason.length, 250);

  const f3 = fetchFalso([{ status: 201, corpo: { status: "REJECTED" } }]);
  await hsClientReal.rejeitarDisputa({ accessToken: "t", disputeId: "disp-2", reason: "INVENTORY_CHECK", http: httpComFetch(f3.impl) });
  assert.equal(f3.chamadas[0].url, "https://mock.ifood.test/order/v1.0/disputes/disp-2/reject");
  assert.deepEqual(JSON.parse(f3.chamadas[0].body), { reason: "INVENTORY_CHECK" });
  await assert.rejects(async () => hsClientReal.rejeitarDisputa({ accessToken: "t", disputeId: "d", reason: "", http: httpComFetch(f3.impl) }));

  const f4 = fetchFalso([{ status: 201, corpo: { status: "ALTERNATIVE_REPLIED" } }]);
  const r4 = await hsClientReal.proporAlternativa({ accessToken: "t", disputeId: "disp-3", type: "REFUND", metadata: { amount: { value: "5000", currency: "BRL" } }, http: httpComFetch(f4.impl) });
  assert.equal(r4.settlementStatus, "ALTERNATIVE_REPLIED");
  assert.equal(f4.chamadas[0].url, "https://mock.ifood.test/order/v1.0/disputes/disp-3/alternative");
  assert.deepEqual(JSON.parse(f4.chamadas[0].body), { type: "REFUND", metadata: { amount: { value: "5000", currency: "BRL" } } });
  await assert.rejects(async () => hsClientReal.proporAlternativa({ accessToken: "t", disputeId: "d", type: "X", metadata: {}, http: httpComFetch(f4.impl) }));
  await assert.rejects(async () => hsClientReal.aceitarDisputa({ accessToken: "t", disputeId: "", http: httpComFetch(f1.impl) }));
});

test("HTTP: 401/404/422/400/429/5xx/timeout/rede — UMA chamada só (resposta de disputa nunca é repetida às cegas)", async () => {
  const esperado = [[401, "IFOOD_TOKEN_EXPIRADO"], [404, "IFOOD_PEDIDO_NAO_ENCONTRADO"], [422, "IFOOD_ACAO_PEDIDO_RECUSADA"], [400, "IFOOD_ACAO_PEDIDO_RECUSADA"], [429, "IFOOD_RATE_LIMITED"], [503, "IFOOD_INDISPONIVEL"]];
  for (const [status, codigo] of esperado) {
    const f = fetchFalso([{ status, corpo: { code: "DISPUTE_ALREADY_ANSWERED" } }]);
    const e = await hsClientReal.aceitarDisputa({ accessToken: "t", disputeId: "disp-1", http: httpComFetch(f.impl) }).then(() => null, (x) => x);
    assert.equal(e?.codigo, IFOOD_ERROS[codigo], String(status));
    assert.equal(f.chamadas.length, 1, `${status}: sem retry`);
  }
  for (const r of [{ timeout: true }, { erroRede: true }]) {
    const f = fetchFalso([r]);
    const e = await hsClientReal.aceitarDisputa({ accessToken: "t", disputeId: "disp-1", http: httpComFetch(f.impl) }).then(() => null, (x) => x);
    assert.equal(e.codigo, IFOOD_ERROS.IFOOD_INDISPONIVEL);
    assert.equal(f.chamadas.length, 1);
  }
});

test("auditoria das respostas: sem token/segredo e com o payload enviado", async () => {
  const a = await comDisputa();
  const c = clienteFake({ reject: [{ status: 201, aceito: true, resposta: { status: "REJECTED", accessToken: "vazou", nested: { client_secret: "s" } } }] });
  await responderDisputa({ ...dep(a, c), decisao: "REJECT", reason: "INVENTORY_CHECK" });
  const j = JSON.stringify([...a.repo.acoes, dispDe(a)]);
  assert.doesNotMatch(j, /vazou|tok-super-secreto-nao-logar|client_secret/);
  assert.deepEqual(a.repo.acoes.at(-1).request_payload, { reason: "INVENTORY_CHECK" });
  assert.equal(a.repo.acoes.at(-1).response_payload.status, "REJECTED");
});

// ===========================================================================
// 4) Ajustes da preparação do D4 (a doc já divergiu do sandbox em cancelamento)
// ===========================================================================
test("HSD com `disputeId` em vez de `id` (alias) ainda cria a negociação", async () => {
  const a = await ambiente();
  const { id, ...semId } = disputa("disp-alias");
  await a.eventos([HSD("h1", { ...semId, disputeId: "disp-alias" })]);
  assert.equal(dispDe(a, "disp-alias").expires_at, t(30));
  assert.equal(a.repo.eventos.get("h1").processing_status, "PROCESSADO");
});

test("HSD/HSS NÃO interpretável: evento guardado e reconhecido, mas com log de ERRO que expõe só os NOMES das chaves (nunca valores)", async () => {
  const a = await ambiente();
  const logs = [];
  const log = (nivel, ev, dados) => logs.push({ nivel, ev, dados });
  const r = await processarLote({
    eventosBrutos: [HSD("h1", { negociacaoId: "x", prazo: "2026", mensagemDoCliente: "SEGREDO-DO-CLIENTE" }), HSS("s1", { qualquer: 1 })],
    conexoesPorMerchant: a.mapa, repo: a.repo, agora: a.relogio.agora, log,
  });
  assert.deepEqual(r.idsParaAck.sort(), ["h1", "s1"], "continua reconhecendo (política de ACK)");
  assert.equal(a.repo.eventos.get("h1").payload.metadata.negociacaoId, "x", "payload bruto preservado para reprocessar depois");
  assert.equal(a.repo.disputas.size, 0);
  const erros = logs.filter((l) => l.nivel === "error" && /handshake\.(hsd|hss)_nao_interpretado/.test(l.ev));
  assert.equal(erros.length, 2);
  assert.deepEqual(erros[0].dados.chaves.sort(), ["mensagemDoCliente", "negociacaoId", "prazo"]);
  assert.doesNotMatch(JSON.stringify(logs), /SEGREDO-DO-CLIENTE/);
});

test("resposta de Handshake recusada: code/message do iFood vão para a disputa e para a auditoria (sem reenvio)", async () => {
  const a = await comDisputa();
  const e400 = Object.assign(erro("IFOOD_ACAO_PEDIDO_RECUSADA", { status: 400 }), { details: { status: 400, ifoodCode: "INVALID_REASON", ifoodMessage: "reason not allowed for this dispute" } });
  const c = clienteFake({ accept: [e400] });
  await assert.rejects(responderDisputa({ ...dep(a, c), decisao: "ACCEPT" }), (e) => e.codigo === IFOOD_ERROS.IFOOD_ACAO_PEDIDO_RECUSADA);
  assert.equal(dispDe(a).status, "RESPOSTA_FALHOU");
  assert.match(dispDe(a).decision_error, /INVALID_REASON: reason not allowed/);
  assert.equal(a.repo.acoes.at(-1).error_message, "INVALID_REASON: reason not allowed for this dispute");
  assert.equal(c.chamadas.accept.length, 1);
});
