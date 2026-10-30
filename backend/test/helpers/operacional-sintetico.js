// Dados SINTÉTICOS do Dashboard Operacional 2.0 (nenhum dado real): pedidos no formato de ifood_pedidos, eventos no formato de
// ifood_eventos (com payload/metadata realistas, inclusive dados pessoais FICTÍCIOS para provar que nada vaza), disputas e metas.
// E fakes em memória das duas camadas de repositório (checklistOperacional.repository / .operacional.repository), com o
// mesmo filtro de tenant e as mesmas regras do RPC operacional_fechamento_registrar (testado à parte contra Postgres real).

import { randomUUID } from "node:crypto";

export const ORG_A = "a0000000-0000-4000-8000-00000000000a";
export const ORG_B = "b0000000-0000-4000-8000-00000000000b";
export const UN_A1 = "a1000000-0000-4000-8000-0000000000a1";
export const UN_A2 = "a2000000-0000-4000-8000-0000000000a2";
export const UN_B1 = "b1000000-0000-4000-8000-0000000000b1";
export const TENANT_A1 = Object.freeze({ organizacaoId: ORG_A, unidadeId: UN_A1 });

/** Local (America/Sao_Paulo, UTC−3, sem horário de verão em 2026) → ISO UTC. */
export const local = (data, hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  const t = Date.parse(`${data}T00:00:00Z`) + (h + 3) * 3_600_000 + m * 60_000;
  return new Date(t).toISOString();
};
const mais = (iso, min) => new Date(Date.parse(iso) + min * 60_000).toISOString();

/** Dados pessoais FICTÍCIOS que NUNCA podem aparecer em projeção, ficha, fechamento, Excel ou mensagem. */
export const PII = Object.freeze({ nome: "Fulana Ficticia Da Silva", telefone: "11 98888-7777", cpf: "123.456.789-09", rua: "Rua Inventada Teste", entregador: "Entregador Ficticio Souza", foneEntregador: "11 97777-6666" });

let seq = 0;
const novoId = (pfx) => `${pfx}-${String(++seq).padStart(5, "0")}-0000-4000-8000-${String(seq).padStart(12, "0")}`.slice(0, 36);

function detalhes({ orderId, merchantId, display, tipo, entregaPor, itensValor, taxaEntrega, descontoLoja, descontoIfood, anteriores, observacao }) {
  const benefits = [];
  if (descontoLoja) benefits.push({ value: descontoLoja, target: "CART", campaign: { id: "c1", name: "Campanha loja" }, sponsorshipValues: [{ name: "MERCHANT", value: descontoLoja }, { name: "IFOOD", value: 0 }, { name: "CHAIN", value: 0 }, { name: "EXTERNAL", value: 0 }] });
  if (descontoIfood) benefits.push({ value: descontoIfood, target: "DELIVERY_FEE", campaign: { id: "c2", name: "Campanha iFood" }, sponsorshipValues: [{ name: "IFOOD", value: descontoIfood }, { name: "MERCHANT", value: 0 }, { name: "CHAIN", value: 0 }, { name: "EXTERNAL", value: 0 }] });
  const beneficios = (descontoLoja ?? 0) + (descontoIfood ?? 0);
  return {
    id: orderId, displayId: display, orderType: tipo, orderTiming: "IMMEDIATE", category: "FOOD", salesChannel: "IFOOD", isTest: false,
    merchant: { id: merchantId, name: "Loja Sintetica", business: { name: "IFOOD_MARKETPLACE" } },
    customer: { id: `cli-${display}`, name: PII.nome, phone: { number: PII.telefone, localizer: "12345678" }, documentNumber: PII.cpf, ordersCountOnMerchant: anteriores, segmentation: "Cliente" },
    items: [{ index: 1, id: "i1", uniqueId: "u1", name: "Sanduiche Sintetico", externalCode: "SKU-1", quantity: 1, unit: "UN", unitPrice: itensValor, price: itensValor, optionsPrice: 2, totalPrice: itensValor, observations: observacao ?? "",
      options: [{ index: 1, id: "o1", name: "Queijo extra", groupName: "Adicionais", externalCode: "ADD-1", quantity: 1, unitPrice: 2, price: 2 }] }],
    total: { subTotal: itensValor, deliveryFee: taxaEntrega, additionalFees: 0.99, benefits: beneficios, orderAmount: Math.round((itensValor + taxaEntrega + 0.99 - beneficios) * 100) / 100 },
    benefits,
    payments: { prepaid: itensValor, pending: 0, methods: [{ value: itensValor, currency: "BRL", type: "ONLINE", method: "PIX", transaction: { authorizationCode: "AUT123" } }] },
    ...(tipo === "DELIVERY" ? { delivery: { mode: "DEFAULT", deliveredBy: entregaPor, pickupCode: "4321", deliveryDateTime: null, deliveryAddress: { streetName: PII.rua, streetNumber: "100", city: "Cidade" } } } : { takeout: { mode: "DEFAULT" } }),
    preparationStartDateTime: null,
  };
}

/**
 * Um pedido + seus eventos. `min` = minutos a partir da chegada (PLC) para cada etapa; ausente = etapa não ocorreu.
 */
export function pedido({ org = ORG_A, un = UN_A1, merchant = "m-a1", data, hora, display, tipo = "DELIVERY", entregaPor = "IFOOD", status = "CONCLUDED",
  min = { cfm: 0.2, prs: 0.5, rtp: 9, adr: 3, aao: 12, clt: 14, dsp: 14, aad: 26, con: 27 }, cancel = null, conAntesDoCancel = false, opaApos = null,
  semDetalhes = false, teste = false, itensValor = 40, taxaEntrega = 6, descontoLoja = 0, descontoIfood = 0, anteriores = 3, observacao = null, duplicarEventos = false }) {
  const orderId = novoId("pd");
  const plc = local(data, hora);
  const ev = [];
  const add = (code, em, metadata = null) => ev.push({ event_id: novoId("ev"), order_id: orderId, organizacao_id: org, unidade_id: un, event_code: code, event_created_at: em, received_at: mais(em, 0.05), metadata });
  add("PLC", plc);
  if (min.cfm != null) add("CFM", mais(plc, min.cfm));
  if (min.prs != null) add("PRS", mais(plc, min.prs), { appName: "pdv", ORIGIN: "ORDER_API" });
  if (min.rtp != null) add("RTP", mais(plc, min.rtp));
  if (tipo === "DELIVERY" && entregaPor === "IFOOD") {
    if (min.adr != null) add("ADR", mais(plc, min.adr), { workerName: PII.entregador, workerPhone: PII.foneEntregador, workerVehicleType: "MOTORCYCLE" });
    if (min.aao != null) add("AAO", mais(plc, min.aao));
    if (min.clt != null) add("CLT", mais(plc, min.clt));
  }
  if (min.dsp != null && tipo === "DELIVERY") add("DSP", mais(plc, min.dsp));
  if (min.aad != null && tipo === "DELIVERY") add("AAD", mais(plc, min.aad));
  let statusEm = null;
  if (status === "CONCLUDED" || conAntesDoCancel) { add("CON", mais(plc, min.con)); statusEm = mais(plc, min.con); }
  if (cancel) {
    add("CAN", mais(plc, cancel.min), { CANCEL_CODE: cancel.codigo, CANCEL_CODE_DESCRIPTION: cancel.descricao, CANCEL_ORIGIN: cancel.origem, CANCEL_STAGE: `[${cancel.estagio}]`, CANCEL_USER: "u-ficticio" });
    statusEm = mais(plc, cancel.min);
  }
  if (opaApos != null) add("OPA", mais(plc, opaApos), { changes: [{ changeType: "DELETE_ITEMS" }] });
  if (duplicarEventos) for (const e of [...ev]) ev.push({ ...e, received_at: mais(e.received_at, 1) });   // reentrega (mesmo event_id)

  const d = semDetalhes ? null : detalhes({ orderId, merchantId: merchant, display, tipo, entregaPor, itensValor, taxaEntrega, descontoLoja, descontoIfood, anteriores, observacao });
  const t = d?.total ?? {};
  const linha = {
    id: randomUUID(), order_id: orderId, organizacao_id: org, unidade_id: un, merchant_id: merchant, display_id: semDetalhes ? null : display,
    order_type: semDetalhes ? null : tipo, order_timing: semDetalhes ? null : "IMMEDIATE", delivery_by: semDetalhes || tipo !== "DELIVERY" ? null : entregaPor,
    sales_channel: "IFOOD", is_test: teste, status_oficial: status, status_oficial_em: statusEm,
    order_created_at: semDetalhes ? null : mais(plc, -0.1), preparation_start_at: null,
    placed_event_created_at: plc, confirmed_event_at: min.cfm != null ? mais(plc, min.cfm) : null, ready_event_at: min.rtp != null ? mais(plc, min.rtp) : null,
    dispatch_event_at: min.dsp != null && tipo === "DELIVERY" ? mais(plc, min.dsp) : null, cancel_event_at: cancel ? mais(plc, cancel.min) : null,
    total_sub_total: t.subTotal ?? null, total_delivery_fee: t.deliveryFee ?? null, total_additional_fees: t.additionalFees ?? null, total_benefits: t.benefits ?? null, total_order_amount: t.orderAmount ?? null,
    details_payload: d, details_payload_hash: d ? `h-${orderId}` : null, details_status: d ? "OK" : "PENDENTE",
    details_atualizado_em: d ? mais(plc, 0.1) : null, primeiro_evento_em: plc, ultimo_evento_em: ev[ev.length - 1].event_created_at,
    criado_em: mais(plc, 0.05), atualizado_em: mais(ev[ev.length - 1].received_at, 0.01),
  };
  return { linha, eventos: ev };
}

/**
 * Cenário principal: unidade A1, competência 2026-10-27 (terça). Ver `docs/dashboard-operacional-2/02-homologacao.md`.
 */
export function cenarioPrincipal() {
  const D = "2026-10-27";
  const ps = [];
  // 20 entregas iFood normais (preparo 14 min, entrega 13, vida 27) espalhadas no almoço e jantar
  const horas = ["11:05", "11:20", "11:40", "12:00", "12:10", "12:15", "12:20", "12:30", "12:45", "13:00", "18:30", "19:00", "19:05", "19:10", "19:15", "19:20", "19:30", "19:40", "20:00", "20:30"];
  horas.forEach((h, k) => ps.push(pedido({ data: D, hora: h, display: `${1000 + k}`, anteriores: k % 4 === 0 ? 0 : 3, descontoLoja: k % 5 === 0 ? 8 : 0, descontoIfood: k % 3 === 0 ? 5 : 0 })));
  // 4 entregas atrasadas no jantar (preparo 30, entrega 20, vida 50)
  for (const [k, h] of ["19:25", "19:35", "19:45", "19:50"].entries()) {
    ps.push(pedido({ data: D, hora: h, display: `${1100 + k}`, min: { cfm: 0.2, prs: 0.5, rtp: 22, adr: 5, aao: 25, clt: 30, dsp: 30, aad: 48, con: 50 }, anteriores: 0 }));
  }
  // 2 entregas próprias
  ps.push(pedido({ data: D, hora: "12:05", display: "1200", entregaPor: "MERCHANT", min: { cfm: 0.1, prs: 0.4, rtp: 10, dsp: 11, aad: 20, con: 21 } }));
  ps.push(pedido({ data: D, hora: "20:10", display: "1201", entregaPor: "MERCHANT", min: { cfm: 0.1, prs: 0.4, rtp: 10, dsp: 11, aad: 20, con: 21 } }));
  // 2 retiradas (fora dos tempos)
  ps.push(pedido({ data: D, hora: "12:50", display: "1300", tipo: "TAKEOUT", min: { cfm: 0.1, prs: 0.3, rtp: 8, con: 15 } }));
  ps.push(pedido({ data: D, hora: "19:55", display: "1301", tipo: "TAKEOUT", min: { cfm: 0.1, prs: 0.3, rtp: 8, con: 15 } }));
  // 3 cancelamentos (2 com motivo oficial iguais, 1 durante o preparo)
  const c502 = { codigo: "502", descricao: "O pedido está duplicado", origem: "RESTAURANT", estagio: "PREPARATION_TIME" };
  ps.push(pedido({ data: D, hora: "12:35", display: "1400", status: "CANCELLED", min: { cfm: 0.2 }, cancel: { ...c502, min: 3 } }));
  ps.push(pedido({ data: D, hora: "19:12", display: "1401", status: "CANCELLED", min: { cfm: 0.2 }, cancel: { ...c502, min: 2 } }));
  ps.push(pedido({ data: D, hora: "20:15", display: "1402", status: "CANCELLED", min: { cfm: 0.2, prs: 0.5, rtp: 15, adr: 4, aao: 18 }, cancel: { codigo: "411", descricao: "O pedido está atrasado", origem: "CONSUMER_VIA_OPERATION", estagio: "DISPATCHED", min: 40 } }));
  // atravessa a meia-noite: recebido 27/10 23:50, concluído 28/10 00:20 (entra nos recebidos de 27, concluído em 28)
  ps.push(pedido({ data: D, hora: "23:50", display: "1500" , min: { cfm: 0.2, prs: 0.5, rtp: 9, adr: 3, aao: 12, clt: 14, dsp: 14, aad: 28, con: 30 } }));
  // recebido 26/10 23:55, concluído 27/10 00:25 (concluído em 27, recebido em 26)
  ps.push(pedido({ data: "2026-10-26", hora: "23:55", display: "0900", min: { cfm: 0.2, prs: 0.5, rtp: 9, adr: 3, aao: 12, clt: 14, dsp: 14, aad: 28, con: 30 } }));
  // alterado depois da leitura dos detalhes; e um sem detalhes; e um de teste; e um com eventos reentregues
  ps.push(pedido({ data: D, hora: "13:10", display: "1600", opaApos: 5 }));
  ps.push(pedido({ data: D, hora: "13:20", display: "1601", semDetalhes: true }));
  ps.push(pedido({ data: D, hora: "13:30", display: "1602", teste: true }));
  ps.push(pedido({ data: D, hora: "13:40", display: "1603", duplicarEventos: true, observacao: `Entregar para ${PII.nome}` }));
  // dia anterior (comparação): 10 pedidos normais
  for (let k = 0; k < 10; k += 1) ps.push(pedido({ data: "2026-10-26", hora: `1${k}:10`, display: `${800 + k}` }));
  // OUTRA unidade da mesma empresa e OUTRA empresa: nunca podem aparecer no tenant A1
  ps.push(pedido({ un: UN_A2, merchant: "m-a2", data: D, hora: "12:00", display: "A2-1" }));
  ps.push(pedido({ org: ORG_B, un: UN_B1, merchant: "m-b1", data: D, hora: "12:00", display: "B1-1" }));

  const disputas = [
    { org: ORG_A, un: UN_A1, order: ps[3].linha.order_id, handshake_type: "DELAY", action: "CANCELLATION", dispute_created_at: local(D, "12:20"), expires_at: local(D, "12:25"), settlement_status: "EXPIRED", settlement_at: local(D, "12:25"), status: "ENCERRADA", message: `Cliente ${PII.nome} reclamou` },
    { org: ORG_A, un: UN_A1, order: ps[12].linha.order_id, handshake_type: "AFTER_DELIVERY", action: "PROPOSED_AMOUNT_REFUND", dispute_created_at: local(D, "20:10"), expires_at: local(D, "20:15"), settlement_status: "ACCEPTED", settlement_at: local(D, "20:12"), status: "ENCERRADA", message: "texto do cliente" },
    { org: ORG_B, un: UN_B1, order: "outra", handshake_type: "DELAY", dispute_created_at: local(D, "12:00"), expires_at: local(D, "12:05"), settlement_status: "EXPIRED", settlement_at: local(D, "12:05"), status: "ENCERRADA" },
  ].map((d) => ({ organizacao_id: d.org, unidade_id: d.un, order_id: d.order, status: d.status, action: d.action ?? null, handshake_type: d.handshake_type, expires_at: d.expires_at, timeout_action: "REJECT_CANCELLATION", dispute_created_at: d.dispute_created_at, criado_em: d.dispute_created_at, settlement_status: d.settlement_status, settlement_at: d.settlement_at, message: d.message ?? null }));

  const metas = [{ organizacao_id: ORG_A, unidade_id: UN_A1, versao: 1, alterado_em: "2026-10-01T03:00:00.000Z", novo: { preparo: { meta: 20, avisoPct: 80 }, entrega: { meta: 15, avisoPct: 80 }, vida: { meta: 35, avisoPct: 80 } } }];
  return { competencia: D, pedidos: ps.map((p) => p.linha), eventos: ps.flatMap((p) => p.eventos), disputas, metas, porDisplay: Object.fromEntries(ps.map((p) => [p.linha.display_id ?? `sem-${p.linha.order_id}`, p.linha])) };
}

const mesmoTenant = (r, o, u) => r.organizacao_id === o && r.unidade_id === u;
const naJanela = (iso, a, b) => iso != null && iso >= a && iso < b;

/** Fake do checklistOperacional.repository (só o que obterDashboard e o service usam). */
export function repoFake(db) {
  return {
    async listarVersoesMetas({ organizacaoId, unidadeId, ateIso }) { return db.metas.filter((m) => mesmoTenant(m, organizacaoId, unidadeId) && m.alterado_em <= ateIso); },
    async listarPedidosDoPeriodo({ organizacaoId, unidadeId, desdeIso, ateIso }) { return db.pedidos.filter((p) => mesmoTenant(p, organizacaoId, unidadeId) && naJanela(p.criado_em, desdeIso, ateIso)); },
    async obterPrimeiroPedidoEm({ organizacaoId, unidadeId }) { return db.pedidos.filter((p) => mesmoTenant(p, organizacaoId, unidadeId)).map((p) => p.criado_em).sort()[0] ?? null; },
    async obterNomeUnidade() { return "Unidade Sintética"; },
  };
}

/** Fake do checklistOperacional.operacional.repository, com as regras do RPC de fechamento. */
export function opFake(db, { pedidoForaDoTenant = null } = {}) {
  db.projecoes ??= new Map();
  db.fechamentos ??= [];
  db.simulacoes ??= [];
  db.chamadas ??= { gravarProjecoes: 0, linhasGravadas: 0, rpc: 0 };
  return {
    async listarVersoesDaFonte({ organizacaoId, unidadeId, desdeIso, ateIso }) { return db.pedidos.filter((p) => mesmoTenant(p, organizacaoId, unidadeId) && naJanela(p.criado_em, desdeIso, ateIso)).map((p) => ({ order_id: p.order_id, atualizado_em: p.atualizado_em })); },
    async listarPedidosFonte({ organizacaoId, unidadeId, orderIds }) {
      const out = db.pedidos.filter((p) => mesmoTenant(p, organizacaoId, unidadeId) && orderIds.includes(p.order_id)).map((p) => structuredClone(p));
      if (pedidoForaDoTenant) out.push(structuredClone(pedidoForaDoTenant));
      return out;
    },
    async listarEventosDosPedidos({ organizacaoId, unidadeId, orderIds }) { return db.eventos.filter((e) => mesmoTenant(e, organizacaoId, unidadeId) && orderIds.includes(e.order_id)).map((e) => structuredClone(e)); },
    async listarPedidosComEventoNovo({ organizacaoId, unidadeId, orderIds, desdeIso }) {
      const m = new Map();
      for (const e of db.eventos) if (mesmoTenant(e, organizacaoId, unidadeId) && orderIds.includes(e.order_id) && e.received_at > desdeIso && (!m.get(e.order_id) || e.received_at > m.get(e.order_id))) m.set(e.order_id, e.received_at);
      return m;
    },
    async listarDisputasDaJanela({ organizacaoId, unidadeId, desdeIso, ateIso }) {
      return db.disputas.filter((d) => mesmoTenant(d, organizacaoId, unidadeId) && (naJanela(d.dispute_created_at, desdeIso, ateIso) || naJanela(d.settlement_at, desdeIso, ateIso) || d.settlement_status == null))
        .map(({ message: _m, ...d }) => d);
    },
    async listarDisputasDoPedido({ organizacaoId, unidadeId, orderId }) { return db.disputas.filter((d) => mesmoTenant(d, organizacaoId, unidadeId) && d.order_id === orderId).map(({ message: _m, ...d }) => d); },
    async sinaisDeRecebimento({ organizacaoId, unidadeId, desdeIso, ateIso }) {
      const evs = db.eventos.filter((e) => mesmoTenant(e, organizacaoId, unidadeId));
      return { eventosNoDia: evs.filter((e) => naJanela(e.event_created_at, desdeIso, ateIso)).length, ultimoEventoRecebidoEm: evs.map((e) => e.received_at).sort().pop() ?? null };
    },
    async listarProjetadoEm({ organizacaoId, unidadeId, orderIds }) { return orderIds.map((id) => db.projecoes.get(id)).filter((p) => p && mesmoTenant(p, organizacaoId, unidadeId)).map((p) => ({ order_id: p.order_id, projetado_em: p.projetado_em, regra_versao: p.regra_versao, fonte_hash: p.fonte_hash, fonte: structuredClone(p.fonte) })); },
    async gravarProjecoes(linhas) { db.chamadas.gravarProjecoes += 1; db.chamadas.linhasGravadas += linhas.length; for (const l of linhas) db.projecoes.set(l.order_id, structuredClone(l)); },
    async listarProjecoesDaJanela({ organizacaoId, unidadeId, desdeIso, ateIso }) {
      return [...db.projecoes.values()].filter((p) => mesmoTenant(p, organizacaoId, unidadeId) && (naJanela(p.plc_em, desdeIso, ateIso) || naJanela(p.con_em, desdeIso, ateIso) || naJanela(p.can_em, desdeIso, ateIso))).map((p) => structuredClone(p));
    },
    async obterProjecaoPorChave({ organizacaoId, unidadeId, chave }) { const p = [...db.projecoes.values()].find((x) => x.chave === chave && mesmoTenant(x, organizacaoId, unidadeId)); return p ? structuredClone(p) : null; },
    async registrarFechamento(p) {
      db.chamadas.rpc += 1;
      const existente = db.fechamentos.find((f) => f.execucao_id === p.execucaoId);
      if (existente) return { resultado: "JA_REGISTRADO", id: existente.id, versao: existente.versao, status: existente.status };
      const doDia = db.fechamentos.filter((f) => f.unidade_id === p.unidadeId && f.competencia === p.competencia).sort((a, b) => b.versao - a.versao);
      const ultima = doDia[0];
      if (ultima && ultima.hash_conteudo === p.hash && ultima.status === p.status) return { resultado: "SEM_MUDANCA", id: ultima.id, versao: ultima.versao, status: ultima.status };
      if (ultima && ["CONSOLIDADO", "REVISADO"].includes(ultima.status) && p.status === "PRELIMINAR") throw new Error("competência já consolidada não volta a PRELIMINAR");
      if (p.status === "REVISADO" && (!doDia.some((f) => ["CONSOLIDADO", "REVISADO"].includes(f.status)) || !p.motivo)) throw new Error("REVISADO exige consolidado anterior e motivo");
      const linha = {
        id: randomUUID(), organizacao_id: p.organizacaoId, unidade_id: p.unidadeId, competencia: p.competencia, versao: (ultima?.versao ?? 0) + 1, status: p.status,
        execucao_id: p.execucaoId, regra_versao: p.regraVersao, fuso: p.fuso, fuso_origem: p.fusoOrigem, origem: p.origem, gerado_por: p.geradoPor, motivo: p.motivo,
        substitui_id: ultima?.id ?? null, fonte: structuredClone(p.fonte), cobertura: structuredClone(p.cobertura), indicadores: structuredClone(p.indicadores),
        diagnostico: structuredClone(p.diagnostico), pendencias: structuredClone(p.pendencias), hash_conteudo: p.hash, gerado_em: p.fonte.geradoEm,
      };
      db.fechamentos.push(linha);
      return { resultado: "REGISTRADO", id: linha.id, versao: linha.versao, status: linha.status };
    },
    async listarFechamentos({ organizacaoId, unidadeId, competencia }) { return db.fechamentos.filter((f) => mesmoTenant(f, organizacaoId, unidadeId) && (!competencia || f.competencia === competencia)); },
    async obterFechamento({ organizacaoId, unidadeId, id }) { const f = db.fechamentos.find((x) => x.id === id && mesmoTenant(x, organizacaoId, unidadeId)); return f ? structuredClone(f) : null; },
    async obterUltimoFechamento({ organizacaoId, unidadeId, competencia }) { return db.fechamentos.filter((f) => mesmoTenant(f, organizacaoId, unidadeId) && f.competencia === competencia).sort((a, b) => b.versao - a.versao)[0] ?? null; },
    async registrarSimulacao(linha) {
      if (linha.transporte !== "noop") throw new Error("CHECK transporte = noop");
      const ex = db.simulacoes.find((s) => s.chave_idempotencia === linha.chave_idempotencia);
      if (ex) return { linha: ex, duplicada: true };
      const nova = { id: randomUUID(), criado_em: new Date().toISOString(), ...structuredClone(linha) };
      db.simulacoes.push(nova);
      return { linha: nova, duplicada: false };
    },
    async listarSimulacoes({ organizacaoId, unidadeId, fechamentoId }) { return db.simulacoes.filter((s) => mesmoTenant(s, organizacaoId, unidadeId) && s.fechamento_id === fechamentoId); },
  };
}

export function bancoSintetico() {
  const c = cenarioPrincipal();
  return { ...c, db: { pedidos: c.pedidos, eventos: c.eventos, disputas: c.disputas, metas: c.metas } };
}
