// Coexistência das ações assíncronas com UM `action_state` + `action_uncertain` (Checkpoint D).
//
// MODELO (regras explícitas — ver docs/ifood-order-actions.md §3):
//   * Uma ação em andamento por pedido. `<acao>_sending` (envio em voo) e `<acao>_requested` (iFood aceitou, evento pendente,
//     com ou sem incerteza) BLOQUEIAM toda outra ação: nada é sobrescrito, então nada se perde.
//   * `<acao>_failed` (recusa definitiva) NÃO bloqueia: nada ficou pendente no iFood.
//   * Exceção explícita: `substituirPendente: true`, só depois de IFOOD_ORDER.reenvioIncertoAposMs sem evento.
//   * Cancelamento em andamento bloqueia ready/dispatch/confirm.
//   * Quem limpa o action_state: SÓ o evento oficial que corresponde à ação (ready ← SPE/RTP+, dispatch ← DSP+, cancel ← CAN,
//     confirm ← CFM+). CANCELLED/CONCLUDED encerram o que estava pendente. CARF converte cancel_* em cancel_failed.
//   * Eventos ATRASADOS (estágio anterior ao da ação pendente) nunca limpam nem alteram uma ação mais recente.
//   * Handshake é independente (`ifood_disputas`): nunca lê nem escreve o action_state.
//
// Rodar: node --experimental-vm-modules --test test/ifood-order-action-coexistence.test.js
import test from "node:test";
import assert from "node:assert/strict";

process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";

const { IFOOD_ERROS, ifoodErro } = await import("../src/modules/ifood/ifood.errors.js");
const { IFOOD_ORDER } = await import("../src/modules/ifood/ifood.constants.js");
const { notificarPronto, despachar, cancelar } = await import("../src/modules/ifood/ifoodOrderActions.service.js");
const { confirmarPedido } = await import("../src/modules/ifood/ifoodOrder.service.js");
const { responderDisputa } = await import("../src/modules/ifood/ifoodHandshake.service.js");
const { processarLote, extrasDoEvento, extrasDeCancelamentoRecusado } = await import("../src/modules/ifood/ifoodEvents.service.js");
const { criarRepoEmMemoria, criarRelogio, criarTokenFake, ev, t, ORG_A, UN_A, M_A } = await import("./helpers/ifood-events-fakes.js");

const silencio = () => {};
const ORDER = "order-1";
const MOTIVOS = [{ code: "501", description: "PROBLEMAS DE SISTEMA" }];
const erro = (codigo, detalhes) => ifoodErro(IFOOD_ERROS[codigo], detalhes ? { detalhes } : undefined);

function clienteFake({ ready = [], dispatch = [], cancel = [], confirm = [] } = {}) {
  const chamadas = { ready: [], dispatch: [], cancel: [], motivos: [], confirm: [] };
  const prox = (fila, padrao) => { const r = fila.length > 1 ? fila.shift() : (fila[0] ?? padrao); if (r instanceof Error) throw r; return r; };
  const ok = { status: 202, aceito: true };
  return {
    chamadas,
    total: () => chamadas.ready.length + chamadas.dispatch.length + chamadas.cancel.length + chamadas.confirm.length,
    async notificarPedidoPronto(a) { chamadas.ready.push(a); return prox(ready, ok); },
    async despacharPedido(a) { chamadas.dispatch.push(a); return prox(dispatch, ok); },
    async solicitarCancelamento(a) { chamadas.cancel.push(a); return prox(cancel, ok); },
    async confirmarPedido(a) { chamadas.confirm.push(a); return prox(confirm, ok); },
    async listarMotivosCancelamento(a) { chamadas.motivos.push(a); return structuredClone(MOTIVOS); },
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
const pedidoDe = (a) => a.repo.pedidos.get(ORDER);
const dep = (a, client, extra = {}) => ({ organizacaoId: ORG_A, unidadeId: UN_A, orderId: ORDER, repo: a.repo, token: a.token, client, agora: a.relogio.agora, log: silencio, ...extra });
let seq = 0;
const evento = (a, code, min = 20, extra = {}) => a.eventos([ev(`c-${code}-${(seq += 1)}`, code, { min, ...extra })]);

async function preparar(a, codigos = ["PLC", "CFM"]) {
  await a.eventos(codigos.map((c, i) => ev(`p-${c}-${(seq += 1)}`, c, { min: i })));
  await a.repo.atualizarPedido({ pedido: pedidoDe(a), campos: { order_type: "DELIVERY", delivery_by: "MERCHANT", details_status: "OK", order_created_at: t(0) } });
}
const snapshot = (a) => { const p = pedidoDe(a); return { s: p.action_state, u: p.action_uncertain, n: p.action_attempts, st: p.status_oficial, r: p.ready_requested_at, d: p.dispatch_requested_at, c: p.cancel_requested_at }; };
const HSD = (id, meta, min = 5) => ev(id, "HSD", { min, orderId: ORDER, merchantId: M_A, metadata: meta });
const HSS = (id, meta, min = 6) => ev(id, "HSS", { min, orderId: ORDER, merchantId: M_A, metadata: meta });
const disputa = (id = "disp-1", o = {}) => ({ id, action: "CANCELLATION", handshakeType: "PREPARATION_TIME", handshakeGroup: "CUSTOMER_ORDER_SUPPORT", message: "x", expiresAt: t(30), timeoutAction: "REJECT_CANCELLATION", createdAt: t(0), alternatives: [], ...o });

// ===========================================================================
// 1) ready_requested + tentativa de cancelamento
// ===========================================================================
test("ready_requested + cancelamento: BLOQUEADO (AGUARDANDO_EVENTO) — nenhum POST, nem consulta de motivos; nada é sobrescrito; o RTP libera", async () => {
  const a = await ambiente();
  await preparar(a);
  const c = clienteFake();
  await notificarPronto(dep(a, c));
  const antes = snapshot(a);
  const r = await cancelar(dep(a, c, { motivo: "501" }));
  assert.equal(r.resultado, "AGUARDANDO_EVENTO");
  assert.equal(r.motivo, "acao_pendente");
  assert.equal(r.pendente, "ready");
  assert.equal(c.chamadas.cancel.length, 0);
  assert.equal(c.chamadas.motivos.length, 0, "nem consulta os motivos");
  assert.deepEqual(snapshot(a), antes, "action_state, tentativas e carimbos intactos");
  assert.equal(pedidoDe(a).cancel_reason_code, null);

  await evento(a, "RTP", 3);                                     // o evento do ready o resolve...
  assert.equal(pedidoDe(a).action_state, "none");
  const r2 = await cancelar(dep(a, c, { motivo: "501" }));       // ...e só então o cancelamento pode partir
  assert.equal(r2.resultado, "SOLICITADO");
  assert.equal(pedidoDe(a).action_state, "cancel_requested");
  assert.equal(pedidoDe(a).ready_event_at, t(3));
});

test("ready_requested + cancelamento com `substituirPendente`: só depois de 3 min sem evento; o ready fica preservado (carimbo + auditoria) e o RTP tardio não apaga o cancelamento", async () => {
  const a = await ambiente();
  await preparar(a);
  const c = clienteFake();
  await notificarPronto(dep(a, c));
  const readyEm = pedidoDe(a).ready_requested_at;

  assert.equal((await cancelar(dep(a, c, { motivo: "501", substituirPendente: true }))).resultado, "AGUARDANDO_EVENTO", "explícito, mas cedo demais");
  assert.equal(c.chamadas.cancel.length, 0);

  a.relogio.avancarS(IFOOD_ORDER.reenvioIncertoAposMs / 1000 + 1);
  assert.equal((await cancelar(dep(a, c, { motivo: "501" }))).resultado, "AGUARDANDO_EVENTO", "sem o pedido explícito continua bloqueado");
  const r = await cancelar(dep(a, c, { motivo: "501", substituirPendente: true }));
  assert.equal(r.resultado, "SOLICITADO");
  let p = pedidoDe(a);
  assert.equal(p.action_state, "cancel_requested");
  assert.equal(p.ready_requested_at, readyEm, "a intenção do ready continua registrada");
  assert.equal(p.ready_event_at, null);
  assert.deepEqual(a.repo.acoes.map((x) => [x.acao, x.resultado]), [["ready", "ACEITA_202"], ["cancel", "ACEITA_202"]]);

  await evento(a, "RTP", 9);                                     // RTP TARDIO com cancelamento pendente
  p = pedidoDe(a);
  assert.equal(p.action_state, "cancel_requested", "o RTP não limpa o cancelamento");
  assert.equal(p.status_oficial, "READY_TO_PICKUP");
  assert.equal(p.ready_event_at, t(9), "mas o carimbo do ready é registrado");
  await evento(a, "CAN", 12);
  assert.equal(pedidoDe(a).status_oficial, "CANCELLED");
  assert.equal(pedidoDe(a).action_state, "none");
});

// ===========================================================================
// 2) dispatch_requested + HANDSHAKE_DISPUTE
// ===========================================================================
test("dispatch_requested + HANDSHAKE_DISPUTE: coexistem — a disputa é independente e o action_state operacional não é tocado", async () => {
  const a = await ambiente();
  await preparar(a, ["PLC", "CFM", "RTP"]);
  const c = clienteFake();
  await despachar(dep(a, c));
  const antes = snapshot(a);

  await a.eventos([HSD("h1", disputa())]);
  assert.deepEqual(snapshot(a), antes, "HSD não altera action_state/uncertain/tentativas");
  assert.equal(a.repo.disputas.get("disp-1").status, "ABERTA");

  // responder a disputa NÃO exige nem altera o estado operacional
  const hc = { async aceitarDisputa() { return { status: 201, aceito: true, resposta: { status: "ACCEPTED" } }; } };
  const r = await responderDisputa({ organizacaoId: ORG_A, unidadeId: UN_A, disputeId: "disp-1", decisao: "ACCEPT", repo: a.repo, token: a.token, client: hc, agora: a.relogio.agora, log: silencio });
  assert.equal(r.resultado, "SOLICITADO");
  assert.deepEqual(snapshot(a), antes, "responder a disputa também não mexe no action_state");
  assert.equal(a.repo.disputas.get("disp-1").status, "RESPONDIDA");

  await evento(a, "DSP", 8);                                     // o dispatch se resolve normalmente...
  assert.equal(pedidoDe(a).action_state, "none");
  assert.equal(pedidoDe(a).status_oficial, "DISPATCHED");
  assert.equal(a.repo.disputas.get("disp-1").status, "RESPONDIDA", "...e a disputa segue no seu próprio ciclo");
  await a.eventos([HSS("s1", { id: "st1", disputeId: "disp-1", status: "ACCEPTED", createdAt: t(9) })]);
  assert.equal(a.repo.disputas.get("disp-1").status, "ENCERRADA");
});

test("dispatch_requested + disputa aceita que resulta em cancelamento oficial: o CAN encerra a ação pendente e a disputa encerra separado", async () => {
  const a = await ambiente();
  await preparar(a, ["PLC", "CFM", "RTP"]);
  await despachar(dep(a, clienteFake()));
  await a.eventos([HSD("h1", disputa())]);
  await a.eventos([HSS("s1", { id: "st1", disputeId: "disp-1", status: "ACCEPTED", createdAt: t(7) }, 7)]);
  await evento(a, "CAN", 8);
  assert.equal(pedidoDe(a).status_oficial, "CANCELLED");
  assert.equal(pedidoDe(a).action_state, "none", "CANCELLED encerra o dispatch pendente");
  assert.equal(a.repo.disputas.get("disp-1").status, "ENCERRADA");
});

test("Handshake NUNCA lê nem escreve o action_state: para todos os 13 estados, HSD/HSS deixam estado, incerteza e tentativas idênticos", async () => {
  const estados = ["none", ...["confirm", "ready", "dispatch", "cancel"].flatMap((x) => ["sending", "requested", "failed"].map((f) => `${x}_${f}`))];
  for (const estado of estados) {
    const a = await ambiente();
    await preparar(a);
    await a.repo.atualizarPedido({ pedido: pedidoDe(a), campos: { action_state: estado, action_uncertain: estado.endsWith("_requested"), action_attempts: 2 } });
    const antes = snapshot(a);
    await a.eventos([HSD("h1", disputa()), HSS("s1", { id: "st", disputeId: "disp-1", status: "REJECTED", createdAt: t(7) }, 7)]);
    assert.deepEqual(snapshot(a), antes, estado);
    assert.equal(a.repo.disputas.get("disp-1").status, "ENCERRADA");
  }
});

// ===========================================================================
// 3) action_uncertain=true + nova ação mutante
// ===========================================================================
test("action_uncertain=true + nova ação mutante: bloqueada (AGUARDANDO_EVENTO 'acao_incerta_pendente'); a incerteza é PRESERVADA", async () => {
  const a = await ambiente();
  await preparar(a);
  const c = clienteFake({ ready: [erro("IFOOD_INDISPONIVEL", { motivo: "timeout" }), { status: 202, aceito: true }] });
  await notificarPronto(dep(a, c));                              // ready incerto
  const antes = snapshot(a);
  assert.deepEqual([antes.s, antes.u], ["ready_requested", true]);

  const r = await cancelar(dep(a, c, { motivo: "501" }));
  assert.equal(r.resultado, "AGUARDANDO_EVENTO");
  assert.equal(r.motivo, "acao_incerta_pendente");
  assert.equal(r.incerto, true);
  assert.equal(r.pendente, "ready");
  const d = await despachar(dep(a, c));                          // dispatch também não sai (ready sem evento oficial)
  assert.equal(d.resultado, "AGUARDANDO_EVENTO");
  assert.equal(c.chamadas.cancel.length + c.chamadas.dispatch.length + c.chamadas.motivos.length, 0);
  assert.deepEqual(snapshot(a), antes, "action_uncertain continua true; nada foi sobrescrito");

  // o evento resolve a incerteza (nenhum reenvio) e libera as demais ações
  await evento(a, "RTP", 4);
  assert.deepEqual([pedidoDe(a).action_state, pedidoDe(a).action_uncertain], ["none", false]);
  assert.equal((await despachar(dep(a, c))).resultado, "SOLICITADO");
});

test("action_uncertain=true: cancelamento incerto bloqueia ready/dispatch/confirm (estado inválido, nada enviado) e continua incerto", async () => {
  const a = await ambiente();
  await preparar(a);
  const c = clienteFake({ cancel: [erro("IFOOD_INDISPONIVEL", { motivo: "timeout" })] });
  await cancelar(dep(a, c, { motivo: "501" }));
  const antes = snapshot(a);
  assert.deepEqual([antes.s, antes.u], ["cancel_requested", true]);
  await assert.rejects(notificarPronto(dep(a, c)), (e) => e.details.motivo === "cancelamento_em_andamento");
  await assert.rejects(despachar(dep(a, c)), (e) => e.codigo === IFOOD_ERROS.IFOOD_PEDIDO_ESTADO_INVALIDO);
  assert.equal(c.chamadas.ready.length + c.chamadas.dispatch.length, 0);
  assert.deepEqual(snapshot(a), antes);
});

test("action_uncertain=true + substituirPendente (explícito, ≥ 3 min): permitido; a nova ação parte com incerteza zerada e a anterior fica na auditoria como INCERTO", async () => {
  const a = await ambiente();
  await preparar(a);
  const c = clienteFake({ ready: [erro("IFOOD_INDISPONIVEL", { motivo: "timeout" })] });
  await notificarPronto(dep(a, c));
  a.relogio.avancarS(IFOOD_ORDER.reenvioIncertoAposMs / 1000 + 1);
  const r = await cancelar(dep(a, c, { motivo: "501", substituirPendente: true }));
  assert.equal(r.resultado, "SOLICITADO");
  assert.deepEqual([pedidoDe(a).action_state, pedidoDe(a).action_uncertain], ["cancel_requested", false]);
  assert.deepEqual(a.repo.acoes.map((x) => [x.acao, x.resultado]), [["ready", "INCERTO"], ["cancel", "ACEITA_202"]]);
  assert.ok(pedidoDe(a).ready_requested_at && pedidoDe(a).ready_event_at === null, "a intenção do ready continua rastreável");
});

// ===========================================================================
// 4) cancel_requested + RTP/DSP tardios
// ===========================================================================
test("cancel_requested + chegada TARDIA de RTP: o cancelamento continua pendente; o estado oficial avança (monotônico); CAN encerra", async () => {
  const a = await ambiente();
  await preparar(a);
  await cancelar(dep(a, clienteFake(), { motivo: "501" }));
  const cancelEm = pedidoDe(a).cancel_requested_at;
  await evento(a, "RTP", 6);
  const p = pedidoDe(a);
  assert.equal(p.action_state, "cancel_requested", "RTP não limpa o cancelamento");
  assert.equal(p.action_uncertain, false);
  assert.equal(p.cancel_requested_at, cancelEm);
  assert.equal(p.cancel_reason_code, "501");
  assert.equal(p.status_oficial, "READY_TO_PICKUP");
  assert.equal(p.ready_event_at, t(6));
  await evento(a, "CAN", 8);
  assert.deepEqual([pedidoDe(a).status_oficial, pedidoDe(a).action_state, pedidoDe(a).cancel_event_at], ["CANCELLED", "none", t(8)]);
});

test("cancel_requested + chegada TARDIA de DSP: idem — só o CAN (ou CARF) resolve o cancelamento", async () => {
  const a = await ambiente();
  await preparar(a, ["PLC", "CFM", "RTP"]);
  await cancelar(dep(a, clienteFake(), { motivo: "501" }));
  await evento(a, "DSP", 6);
  let p = pedidoDe(a);
  assert.equal(p.action_state, "cancel_requested");
  assert.equal(p.status_oficial, "DISPATCHED");
  assert.equal(p.dispatch_event_at, t(6));
  // o iFood recusa o cancelamento (já despachado): CARF => cancel_failed; o estado oficial NÃO é tocado
  await evento(a, "CARF", 7);
  p = pedidoDe(a);
  assert.equal(p.action_state, "cancel_failed");
  assert.equal(p.status_oficial, "DISPATCHED");
  assert.equal(p.cancel_failed_event_at, t(7));
});

test("cancel_requested incerto + RTP/DSP tardios: a incerteza só cai com o CAN", async () => {
  const a = await ambiente();
  await preparar(a, ["PLC", "CFM", "RTP"]);
  await cancelar(dep(a, clienteFake({ cancel: [erro("IFOOD_INDISPONIVEL", { motivo: "timeout" })] }), { motivo: "501" }));
  await evento(a, "DSP", 6);
  assert.deepEqual([pedidoDe(a).action_state, pedidoDe(a).action_uncertain], ["cancel_requested", true]);
  await evento(a, "CAN", 9);
  assert.deepEqual([pedidoDe(a).action_state, pedidoDe(a).action_uncertain, pedidoDe(a).status_oficial], ["none", false, "CANCELLED"]);
});

// ===========================================================================
// 5) Eventos atrasados não apagam uma ação mais recente
// ===========================================================================
test("evento ATRASADO (reentrega de CFM/RTP com outro id) não apaga a ação mais recente", async () => {
  const a = await ambiente();
  await preparar(a);                                             // CONFIRMED
  const c = clienteFake();
  await notificarPronto(dep(a, c));                              // ready_requested
  await evento(a, "CFM", 30);                                    // CFM reentregue, createdAt "novo" — é anterior ao ready
  assert.equal(pedidoDe(a).action_state, "ready_requested", "CFM atrasado não limpa o ready");
  assert.equal(pedidoDe(a).status_oficial, "CONFIRMED");
  await evento(a, "RTP", 31);
  assert.equal(pedidoDe(a).action_state, "none");
  await despachar(dep(a, c));                                    // dispatch_requested
  await evento(a, "RTP", 40);                                    // RTP reentregue: anterior ao dispatch
  assert.equal(pedidoDe(a).action_state, "dispatch_requested", "RTP atrasado não limpa o dispatch");
  await evento(a, "DSP", 41);
  assert.equal(pedidoDe(a).action_state, "none");
});

test("MATRIZ pura: para os 13 action_state × todos os eventos de status + CARF, o resultado é sempre 'inalterado' ou 'limpa/marca só o que corresponde'", () => {
  const ESTADOS = ["none", ...["confirm", "ready", "dispatch", "cancel"].flatMap((x) => ["sending", "requested", "failed"].map((f) => `${x}_${f}`))];
  const STATUS = ["PLACED", "CONFIRMED", "SEPARATION_STARTED", "SEPARATION_ENDED", "READY_TO_PICKUP", "DISPATCHED", "CONCLUDED", "CANCELLED"];
  // Esperado: quais (acao, status) limpam. Só as ações PENDENTES (sending/requested) são limpas; failed e none nunca mudam.
  const LIMPA = {
    confirm: (s) => s !== "PLACED",
    ready: (s) => ["SEPARATION_ENDED", "READY_TO_PICKUP", "DISPATCHED", "CONCLUDED", "CANCELLED"].includes(s),
    dispatch: (s) => ["DISPATCHED", "CONCLUDED", "CANCELLED"].includes(s),
    cancel: (s) => s === "CANCELLED",
  };
  for (const estado of ESTADOS) {
    for (const status of STATUS) {
      const pedido = { action_state: estado, action_uncertain: estado.endsWith("_requested") };
      const ex = extrasDoEvento(pedido, status, { createdAt: t(1), recebidoEm: t(1) });
      const acao = estado === "none" ? null : estado.split("_")[0];
      const pendente = /_(sending|requested)$/.test(estado);
      const deveLimpar = !!acao && LIMPA[acao](status);
      const rot = `${estado} × ${status}`;
      if (deveLimpar) { assert.equal(ex.action_state, "none", rot); assert.equal(ex.action_uncertain, false, rot); }
      else assert.equal(ex.action_state, undefined, `${rot}: não pode alterar o action_state`);
      // um evento de status NUNCA cria um estado de ação: só pode zerar
      assert.ok(ex.action_state === undefined || ex.action_state === "none", rot);
      // *_failed também é zerado pelo evento correspondente (a ação já foi superada pelo estado oficial) — nunca reabre nada
      if (!pendente && !deveLimpar) assert.equal(ex.action_state, undefined, rot);
    }
    // CARF só converte cancel_* pendente em cancel_failed; nenhum outro estado é tocado
    const ex = extrasDeCancelamentoRecusado({ action_state: estado, action_uncertain: estado.endsWith("_requested") }, { createdAt: t(2) });
    if (/^cancel_(sending|requested)$/.test(estado)) { assert.equal(ex.action_state, "cancel_failed", estado); assert.equal(ex.action_uncertain, false); }
    else assert.equal(ex.action_state, undefined, `${estado}: CARF não pode alterar`);
  }
});

// ===========================================================================
// 6) NADA é sobrescrito: par (ação pendente X) × (nova ação Y)
// ===========================================================================
test("PROPRIEDADE: com qualquer ação X pendente (sending fresco ou requested, incerta ou não), qualquer OUTRA ação Y não envia POST nem altera o estado", async () => {
  const acoesY = [
    { nome: "ready", status: "CONFIRMED", chamar: (a, c) => notificarPronto(dep(a, c)) },
    { nome: "dispatch", status: "READY_TO_PICKUP", chamar: (a, c) => despachar(dep(a, c)) },
    { nome: "cancel", status: "CONFIRMED", chamar: (a, c) => cancelar(dep(a, c, { motivo: "501" })) },
  ];
  for (const X of ["confirm", "ready", "dispatch", "cancel"]) {
    for (const [fase, incerto] of [["sending", false], ["requested", false], ["requested", true]]) {
      for (const Y of acoesY) {
        if (Y.nome === X) continue;
        const a = await ambiente();
        await preparar(a, Y.status === "READY_TO_PICKUP" ? ["PLC", "CFM", "RTP"] : ["PLC", "CFM"]);
        await a.repo.atualizarPedido({ pedido: pedidoDe(a), campos: { action_state: `${X}_${fase}`, action_uncertain: incerto, action_attempts: 1, action_requested_at: a.relogio.agora().toISOString(), [`${X}_requested_at`]: a.relogio.agora().toISOString() } });
        const antes = snapshot(a);
        const c = clienteFake();
        const r = await Y.chamar(a, c).then((x) => x, (e) => ({ erro: e.codigo }));
        const rot = `${X}_${fase}${incerto ? "(incerto)" : ""} + ${Y.nome}`;
        assert.equal(c.total(), 0, `${rot}: nenhum POST`);
        assert.equal(c.chamadas.motivos.length, 0, `${rot}: nenhuma consulta`);
        assert.deepEqual(snapshot(a), antes, `${rot}: nada sobrescrito`);
        assert.ok(r.erro || ["AGUARDANDO_EVENTO", "EM_ENVIO", "JA_EXECUTADO"].includes(r.resultado), `${rot}: resultado ${JSON.stringify(r)}`);
      }
    }
  }
});

test("`*_failed` NÃO bloqueia (nada ficou pendente no iFood): a próxima ação parte e sobrescreve o failed", async () => {
  for (const X of ["ready", "dispatch", "cancel"]) {
    const a = await ambiente();
    await preparar(a);
    await a.repo.atualizarPedido({ pedido: pedidoDe(a), campos: { action_state: `${X}_failed`, action_last_error: "X" } });
    const r = await notificarPronto(dep(a, clienteFake()));
    assert.equal(r.resultado, "SOLICITADO", X);
    assert.equal(pedidoDe(a).action_state, "ready_requested");
    assert.equal(pedidoDe(a).action_last_error, null);
  }
});

test("`<acao>_sending` mais velho que 30 s (envio interrompido) é tratado como INCERTO — não como 'não enviado'", async () => {
  const a = await ambiente();
  await preparar(a);
  await a.repo.atualizarPedido({ pedido: pedidoDe(a), campos: { action_state: "ready_sending", action_requested_at: a.relogio.agora().toISOString(), ready_requested_at: a.relogio.agora().toISOString() } });
  a.relogio.avancarS(IFOOD_ORDER.sendingReassumivelMs / 1000 + 1);
  const c = clienteFake();
  const r = await notificarPronto(dep(a, c));
  assert.equal(r.resultado, "AGUARDANDO_EVENTO");
  assert.equal(r.motivo, "envio_interrompido");
  const r2 = await cancelar(dep(a, c, { motivo: "501" }));
  assert.equal(r2.resultado, "AGUARDANDO_EVENTO", "outra ação também não passa por cima do envio interrompido");
  assert.equal(c.total(), 0);
});

// ===========================================================================
// 7) confirm (Checkpoint C) também não sobrescreve
// ===========================================================================
test("confirm não sobrescreve um cancelamento pendente (mesmo com o pedido ainda PLACED)", async () => {
  const a = await ambiente();
  await a.eventos([ev("p1", "PLC")]);
  await a.repo.atualizarPedido({ pedido: pedidoDe(a), campos: { action_state: "cancel_requested", action_uncertain: true, cancel_requested_at: t(0) } });
  const c = clienteFake();
  await assert.rejects(confirmarPedido(dep(a, c)), (e) => e.codigo === IFOOD_ERROS.IFOOD_PEDIDO_ESTADO_INVALIDO && e.details.motivo === "cancelamento_em_andamento");
  assert.equal(c.chamadas.confirm.length, 0);
  assert.deepEqual([pedidoDe(a).action_state, pedidoDe(a).action_uncertain], ["cancel_requested", true]);
  // cancel_failed não bloqueia o confirm
  await a.repo.atualizarPedido({ pedido: pedidoDe(a), campos: { action_state: "cancel_failed", action_uncertain: false } });
  assert.equal((await confirmarPedido(dep(a, c))).resultado, "SOLICITADO");
  assert.equal(pedidoDe(a).action_state, "confirm_requested");
});
