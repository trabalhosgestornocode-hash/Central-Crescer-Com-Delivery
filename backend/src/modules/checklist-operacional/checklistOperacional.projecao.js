// Dashboard Operacional 2.0 — PROJEÇÃO por pedido (função pura: ifood_pedidos + ifood_eventos → operacional_pedidos).
//
// É a camada analítica derivada (migration 130): uma linha por pedido, SEM dado pessoal, com a linha do tempo oficial, os
// valores operacionais, o cancelamento oficial e os problemas de integridade. Reconstruível a qualquer momento a partir do
// bruto (o poller e o ACK não sabem que ela existe).
//
// REGRAS
//   * Carimbo de cada etapa = createdAt do PRIMEIRO evento daquele código (mínimo por createdAt — independe da ordem de
//     chegada, de reentregas e de duplicatas). Sem evento, cai na coluna que o próprio Events já gravou em ifood_pedidos
//     (mesma origem); sem os dois, fica NULO. Nada é estimado.
//   * status_oficial é o de ifood_pedidos (máquina de estados do Events) — nunca recalculado aqui.
//   * O horário da conclusão vem do evento CON mesmo quando o pedido é cancelado depois (achado D-4 da auditoria).
//   * Cancelamento: metadata OFICIAL do CAN (código, descrição, origem, estágio) — copiada, nunca traduzida nem inferida.
//   * Dado pessoal NUNCA entra: cliente (nome, telefone, documento, endereço), entregador (nome, telefone, foto), códigos de
//     coleta/entrega, texto das observações (só a existência), dados de transação. De cliente fica só a CONTAGEM de pedidos
//     anteriores na loja (customer.ordersCountOnMerchant).
//   * Integridade: todo problema de dado vira um item em `integridade` — nunca é tratado como "sem problema".
//   * Idempotência: `fonte_hash` = hash estável do conteúdo projetado; mesmo hash = nada a regravar.

import { createHash } from "node:crypto";
import { chaveOpaca } from "./checklistOperacional.calc.js";
import { jsonEstavel } from "../ifood/ifoodEvents.parser.js";

export const REGRA_PROJECAO = 1;

/** Código do evento → coluna do carimbo na projeção. */
export const CARIMBOS = Object.freeze({
  PLC: "plc_em", CFM: "cfm_em", PRS: "prs_em", RTP: "rtp_em", ADR: "adr_em", GTO: "gto_em",
  AAO: "aao_em", CLT: "clt_em", DSP: "dsp_em", AAD: "aad_em", CON: "con_em", CAN: "can_em",
});

/** Coluna que o Events já grava em ifood_pedidos para o mesmo instante (usada quando a linha do evento não está disponível). */
const COLUNA_ORIGEM = Object.freeze({
  plc_em: "placed_event_created_at", cfm_em: "confirmed_event_at", rtp_em: "ready_event_at",
  dsp_em: "dispatch_event_at", can_em: "cancel_event_at",
});

export const LIMITE_ITENS = 50;
export const LIMITE_ADICIONAIS = 30;
export const LIMITE_LINHA_DO_TEMPO = 200;

const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const iso = (v) => { const t = ms(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const texto = (v, max = 120) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const numero = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const dinheiro = (v) => { const n = numero(v); return n == null ? null : Math.round(n * 100) / 100; };
const objeto = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
const lista = (v) => (Array.isArray(v) ? v : []);

/** "[PREPARATION_TIME]" → "PREPARATION_TIME" (o iFood manda o estágio entre colchetes). */
export const limparEstagio = (v) => texto(String(v ?? "").replace(/^\[|\]$/g, ""), 60);

/** Soma dos patrocínios por patrocinador (IFOOD / MERCHANT / CHAIN / EXTERNAL) — soma VALORES, nunca conta entradas. */
export function somarPatrocinios(benefits) {
  const soma = { MERCHANT: 0, IFOOD: 0, CHAIN: 0, EXTERNAL: 0 };
  let algum = false;
  for (const b of lista(benefits)) {
    for (const s of lista(b?.sponsorshipValues)) {
      const nome = texto(s?.name, 20)?.toUpperCase();
      const v = numero(s?.value);
      if (!nome || v == null || !(nome in soma)) continue;
      soma[nome] += v;
      algum = true;
    }
  }
  const r = (x) => Math.round(x * 100) / 100;
  return algum ? { loja: r(soma.MERCHANT), ifood: r(soma.IFOOD), rede: r(soma.CHAIN), externo: r(soma.EXTERNAL) } : null;
}

/** Itens SANEADOS: nome, código do PDV, quantidades e valores; das observações só fica a existência. */
export function sanearItens(items) {
  return lista(items).slice(0, LIMITE_ITENS).map((it, i) => ({
    indice: numero(it?.index) ?? i + 1,
    nome: texto(it?.name, 120) ?? "Item sem nome",
    codigo: texto(it?.externalCode, 60),
    quantidade: numero(it?.quantity),
    unidade: texto(it?.unit, 10),
    valorUnitario: dinheiro(it?.unitPrice),
    valorTotal: dinheiro(it?.totalPrice ?? it?.price),
    temObservacao: typeof it?.observations === "string" && it.observations.trim().length > 0,
    adicionais: lista(it?.options).slice(0, LIMITE_ADICIONAIS).map((o) => ({
      nome: texto(o?.name, 120) ?? "Adicional sem nome",
      grupo: texto(o?.groupName, 80),
      codigo: texto(o?.externalCode, 60),
      quantidade: numero(o?.quantity),
      valor: dinheiro(o?.price),
    })),
  }));
}

/** Eventos válidos, sem duplicata por id, em ordem de createdAt (sem data por último; empate pelo recebimento). */
export function eventosOrdenados(eventos) {
  const vistos = new Set();
  const out = [];
  for (const e of eventos ?? []) {
    if (!e || !e.event_id || vistos.has(e.event_id)) continue;
    vistos.add(e.event_id);
    out.push(e);
  }
  return out.sort((a, b) => {
    const ta = ms(a.event_created_at); const tb = ms(b.event_created_at);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    if (Number.isFinite(ta) !== Number.isFinite(tb)) return Number.isFinite(ta) ? -1 : 1;
    const ra = ms(a.received_at) || 0; const rb = ms(b.received_at) || 0;
    if (ra !== rb) return ra - rb;
    // Desempate determinístico (mesmo horário e mesmo recebimento): a ordem de chegada no lote não pode mudar o hash.
    return String(a.event_id) < String(b.event_id) ? -1 : String(a.event_id) > String(b.event_id) ? 1 : 0;
  });
}

function problema(codigo, mensagem) { return { codigo, mensagem }; }

/**
 * @param {{pedido: object, eventos?: object[]}} p
 *   pedido: linha de ifood_pedidos (inclusive details_payload); eventos: linhas de ifood_eventos do pedido
 *   ({event_id, event_code, event_created_at, received_at, metadata}).
 * @returns {object} linha de operacional_pedidos (sem projetado_em)
 */
export function projetarPedido({ pedido, eventos = [] }) {
  if (!pedido?.order_id) throw new Error("projetarPedido: pedido sem order_id");
  const doPedido = eventos.filter((e) => !e.order_id || e.order_id === pedido.order_id);
  const evs = eventosOrdenados(doPedido);
  const detalhes = objeto(pedido.details_payload);
  const integridade = [];

  // Carimbos: o MENOR createdAt de cada código.
  const carimbos = Object.fromEntries(Object.values(CARIMBOS).map((c) => [c, null]));
  let eventosSemData = 0;
  for (const e of evs) {
    const coluna = CARIMBOS[e.event_code];
    const t = iso(e.event_created_at);
    if (!t) { eventosSemData += 1; continue; }
    if (coluna && (!carimbos[coluna] || ms(t) < ms(carimbos[coluna]))) carimbos[coluna] = t;
  }
  for (const [coluna, origem] of Object.entries(COLUNA_ORIGEM)) if (!carimbos[coluna]) carimbos[coluna] = iso(pedido[origem]);
  if (!carimbos.con_em && pedido.status_oficial === "CONCLUDED") carimbos.con_em = iso(pedido.status_oficial_em);
  if (eventosSemData) integridade.push(problema("EVENTO_SEM_DATA", `${eventosSemData} evento(s) sem horário oficial: ficaram fora da linha do tempo.`));

  // Cancelamento oficial (primeiro CAN).
  const can = evs.find((e) => e.event_code === "CAN");
  const mCan = objeto(can?.metadata) ?? {};
  const cancel = {
    cancel_codigo: texto(mCan.CANCEL_CODE != null ? String(mCan.CANCEL_CODE) : null, 20),
    cancel_descricao: texto(mCan.CANCEL_CODE_DESCRIPTION ?? mCan.CANCEL_REASON, 200),
    cancel_origem: texto(mCan.CANCEL_ORIGIN, 60),
    cancel_estagio: limparEstagio(mCan.CANCEL_STAGE),
  };
  if (pedido.status_oficial === "CANCELLED" && !can) integridade.push(problema("CANCELAMENTO_SEM_EVENTO", "Pedido cancelado sem o evento CANCELLED disponível: motivo, origem e estágio desconhecidos."));

  // Alterações (ORDER_PATCHED).
  const opas = evs.filter((e) => e.event_code === "OPA" && iso(e.event_created_at));
  const ultimaAlteracao = opas.length ? iso(opas[opas.length - 1].event_created_at) : null;
  const detalhesEm = iso(pedido.details_atualizado_em);
  const desatualizados = !!ultimaAlteracao && (!detalhesEm || ms(ultimaAlteracao) > ms(detalhesEm));
  if (desatualizados) integridade.push(problema("DETALHES_DESATUALIZADOS", "O pedido foi alterado (ORDER_PATCHED) depois da última leitura dos detalhes: itens e valores podem não refletir a versão final."));

  // Detalhes (Order Details).
  if (!detalhes) integridade.push(problema("SEM_DETALHES", "Detalhes do pedido indisponíveis: tipo, itens e valores desconhecidos."));
  const total = objeto(detalhes?.total);
  const entrega = objeto(detalhes?.delivery);
  const cliente = objeto(detalhes?.customer);
  const pagamentos = objeto(detalhes?.payments);
  const metodos = lista(pagamentos?.methods);
  const patrocinio = somarPatrocinios(detalhes?.benefits);
  const anteriores = numero(cliente?.ordersCountOnMerchant);

  const tipo = pedido.order_type ?? texto(detalhes?.orderType, 20)?.toUpperCase() ?? null;
  if (!carimbos.plc_em) integridade.push(problema("SEM_CHEGADA", "Sem o carimbo oficial de chegada (PLACED): preparo e vida não são medidos."));
  if (tipo === "DELIVERY" && carimbos.con_em && !carimbos.dsp_em) integridade.push(problema("CONCLUIDO_SEM_DESPACHO", "Pedido de entrega concluído sem o evento de despacho: preparo e entrega não são medidos."));
  if (pedido.status_oficial === "CONCLUDED" && !carimbos.con_em) integridade.push(problema("CONCLUIDO_SEM_HORARIO", "Estado concluído sem o horário oficial da conclusão."));
  if (carimbos.con_em && carimbos.can_em) integridade.push(problema("CANCELADO_APOS_CONCLUSAO", "Pedido concluído e depois cancelado pelo iFood: vale o estado final (cancelado); o horário da conclusão fica registrado."));
  for (const [a, b, nome] of [["plc_em", "dsp_em", "despacho antes da chegada"], ["dsp_em", "con_em", "conclusão antes do despacho"], ["plc_em", "rtp_em", "pronto antes da chegada"], ["aao_em", "clt_em", "coleta antes da chegada do entregador"]]) {
    if (carimbos[a] && carimbos[b] && ms(carimbos[b]) < ms(carimbos[a])) integridade.push(problema("ORDEM_INVERTIDA", `Horários fora de ordem (${nome}): a etapa afetada não é medida.`));
  }

  const linhaDoTempo = evs
    .filter((e) => iso(e.event_created_at))
    .slice(0, LIMITE_LINHA_DO_TEMPO)
    .map((e) => ({ codigo: texto(e.event_code, 10), em: iso(e.event_created_at), recebidoEm: iso(e.received_at) }));

  const linha = {
    order_id: pedido.order_id,
    organizacao_id: pedido.organizacao_id,
    unidade_id: pedido.unidade_id,
    chave: chaveOpaca(pedido.order_id),
    merchant_id: pedido.merchant_id,
    display_id: pedido.display_id ?? texto(detalhes?.displayId, 60) ?? null,
    order_type: tipo,
    order_timing: pedido.order_timing ?? texto(detalhes?.orderTiming, 20)?.toUpperCase() ?? null,
    delivery_by: pedido.delivery_by ?? texto(entrega?.deliveredBy, 20) ?? null,
    delivery_mode: texto(entrega?.mode, 30),
    sales_channel: pedido.sales_channel ?? null,
    is_test: typeof pedido.is_test === "boolean" ? pedido.is_test : null,
    status_oficial: pedido.status_oficial ?? null,
    pedido_criado_em: iso(pedido.order_created_at),
    ...carimbos,
    preparo_recomendado_em: iso(pedido.preparation_start_at ?? detalhes?.preparationStartDateTime),
    previsao_entrega_em: iso(entrega?.deliveryDateTime),
    ...cancel,
    valor_itens: dinheiro(pedido.total_sub_total ?? total?.subTotal),
    valor_taxa_entrega: dinheiro(pedido.total_delivery_fee ?? total?.deliveryFee),
    valor_taxas_adicionais: dinheiro(pedido.total_additional_fees ?? total?.additionalFees),
    valor_descontos: dinheiro(pedido.total_benefits ?? total?.benefits),
    valor_total: dinheiro(pedido.total_order_amount ?? total?.orderAmount),
    desconto_loja: patrocinio?.loja ?? (detalhes ? 0 : null),
    desconto_ifood: patrocinio?.ifood ?? (detalhes ? 0 : null),
    desconto_rede: patrocinio?.rede ?? (detalhes ? 0 : null),
    desconto_externo: patrocinio?.externo ?? (detalhes ? 0 : null),
    cliente_pedidos_anteriores: anteriores != null && anteriores >= 0 ? Math.trunc(anteriores) : null,
    itens_qtd: detalhes ? lista(detalhes.items).length : null,
    itens: detalhes ? sanearItens(detalhes.items) : null,
    pagamento_metodos: [...new Set(metodos.map((m) => texto(m?.method, 30)?.toUpperCase()).filter(Boolean))],
    pagamento_na_entrega: detalhes ? metodos.some((m) => String(m?.type ?? "").toUpperCase() === "OFFLINE") : null,
    alteracoes: opas.length,
    ultima_alteracao_em: ultimaAlteracao,
    detalhes_desatualizados: desatualizados,
    eventos_qtd: evs.length,
    linha_do_tempo: linhaDoTempo,
    integridade,
    fonte: {
      detalhesHash: pedido.details_payload_hash ?? null,
      detalhesAtualizadoEm: detalhesEm,
      statusOficialEm: iso(pedido.status_oficial_em),
      eventos: evs.length,
      // Sobre TODAS as linhas recebidas (inclusive reentregas): é o corte que a sincronização incremental compara.
      ultimoEventoRecebidoEm: doPedido.reduce((m, e) => (iso(e.received_at) && (!m || ms(e.received_at) > ms(m)) ? iso(e.received_at) : m), null),
    },
    regra_versao: REGRA_PROJECAO,
  };
  linha.fonte_hash = createHash("sha256").update(jsonEstavel(linha)).digest("hex");
  // Versão da fonte vista nesta projeção (relógio do BANCO, fora do hash): a sincronização compara banco com banco, nunca
  // com o relógio da aplicação — assim uma diferença de relógio entre servidor e banco não esconde nenhuma atualização.
  linha.fonte = { ...linha.fonte, pedidoAtualizadoEm: pedido.atualizado_em ?? null };
  return linha;
}

/**
 * Linha da projeção no formato que as medições do Checklist já entendem (mesmas colunas de ifood_pedidos), para que o
 * fechamento use EXATAMENTE a mesma régua do Dashboard (medirPreparo/medirEntrega/medirVida).
 */
export function paraLinhaDoChecklist(p) {
  return {
    order_id: p.order_id, display_id: p.display_id, status_oficial: p.status_oficial,
    status_oficial_em: p.status_oficial === "CONCLUDED" ? p.con_em : p.status_oficial === "CANCELLED" ? p.can_em : null,
    order_type: p.order_type, delivery_by: p.delivery_by, order_timing: p.order_timing, is_test: p.is_test,
    order_created_at: p.pedido_criado_em, placed_event_created_at: p.plc_em, confirmed_event_at: p.cfm_em,
    ready_event_at: p.rtp_em, dispatch_event_at: p.dsp_em, cancel_event_at: p.can_em,
    primeiro_evento_em: p.plc_em, criado_em: p.plc_em, merchant_id: p.merchant_id,
  };
}
