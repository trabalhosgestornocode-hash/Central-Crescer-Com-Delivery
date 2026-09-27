// Events do iFood — processamento de um lote de eventos.
//
// FLUXO (por lote devolvido pelo polling)
//   normalizar -> deduplicar no lote -> ordenar por createdAt
//     -> resolver tenant (merchantId -> conexão -> organização/unidade)
//     -> PERSISTIR (UNIQUE(event_id) = deduplicação atômica)
//     -> processar os NOVOS (estado do pedido pelo evento oficial)
//     -> devolver os ids a reconhecer (ACK — feito depois, pelo poller)
//
// REGRAS DE OURO
//   * ACK só depois de PERSISTIR. Se a persistência falha, este módulo LANÇA e nada
//     é reconhecido: o iFood reentrega (retenção de 8 h) e a UNIQUE impede duplicidade.
//   * Falha ao PROCESSAR um evento já persistido NÃO impede o ACK: o evento está
//     seguro no banco (status FALHOU, retry_count) e é reprocessado a partir dele
//     (`reprocessarPendentes`). Não reconhecer aqui só geraria reentregas e strikes
//     de throttling no iFood sem ganho de segurança.
//   * O estado do pedido só muda por EVENTO OFICIAL (grupo ORDER_STATUS). Nenhuma
//     ação nossa (confirm etc.) altera `status_oficial`.
//   * Evento de merchant sem conexão viva vai para QUARENTENA (sem tenant), é
//     reconhecido e nunca toca em nenhum pedido/tenant.
//   * Evento fora do catálogo: guardado como DESCONHECIDO e reconhecido.
//   * Tenant SEMPRE vem de ifood_conexoes, nunca do payload.

import { IFOOD_EVENTS } from "./ifood.constants.js";
import { aplicarHandshake } from "./ifoodHandshake.service.js";
import { ifoodLog, mascararId } from "./ifood.logsafe.js";
import {
  normalizarEvento, ordenarPorCriacao, classificarCodigo, RANK_STATUS, STATUS_TERMINAIS,
} from "./ifoodEvents.parser.js";

const msg = (e) => String(e?.message ?? e ?? "erro").slice(0, 300);
const ms = (iso) => (iso ? Date.parse(iso) : NaN);

/**
 * Decisão PURA: o evento de status deve alterar o estado oficial do pedido?
 * @param {{status_oficial: string|null, status_oficial_em: string|null}} pedido
 * @param {{status: string, createdAt: string|null}} evento
 * @returns {{aplicar: boolean, motivo?: string}}
 */
export function decidirTransicao(pedido, evento) {
  const atual = pedido.status_oficial;
  const novo = evento.status;
  if (!atual) return { aplicar: true };
  if (atual === novo) return { aplicar: false, motivo: "mesmo_status" };            // ex.: PLACED repetido com outro id

  const finalAtual = STATUS_TERMINAIS.has(atual);
  const finalNovo = STATUS_TERMINAIS.has(novo);
  if (finalAtual && !finalNovo) return { aplicar: false, motivo: "estado_final_nao_regride" };
  if (finalAtual && finalNovo) {
    // CONCLUDED x CANCELLED: vale o mais recente.
    const tNovo = ms(evento.createdAt);
    const tAtual = ms(pedido.status_oficial_em);
    if (Number.isFinite(tNovo) && Number.isFinite(tAtual) && tNovo <= tAtual) return { aplicar: false, motivo: "anterior_ao_estado_atual" };
    return { aplicar: true };
  }
  // O ciclo de vida é monotônico: um evento de estágio anterior NUNCA desfaz o atual,
  // mesmo que traga um createdAt posterior (reentrega/anomalia). Chegar fora de ordem
  // (ex.: CFM antes de PLC) cai aqui também. O horário só desempata estados finais.
  if ((RANK_STATUS[novo] ?? 0) < (RANK_STATUS[atual] ?? 0)) return { aplicar: false, motivo: "regressao_de_ciclo_de_vida" };
  return { aplicar: true };
}

/**
 * Efeito local de UM evento já persistido. Devolve o status final do evento.
 * @param {{eventId, code, orderId, merchantId, createdAt, classificacao}} evento
 * @param {{organizacaoId: string, unidadeId: string}} tenant
 * @returns {Promise<{status: 'PROCESSADO'|'IGNORADO'|'DESCONHECIDO'|'FALHOU', erro?: string, naoReprocessavel?: boolean}>}
 */
/**
 * Que eventos oficiais RESOLVEM (encerram a espera de) cada ação local. O HTTP aceito só registra a intenção
 * (<acao>_requested); é o evento que fecha o ciclo. Ready: SEPARATION_ENDED/READY_TO_PICKUP (a documentação diz que
 * /readyToPickup gera SEPARATION_ENDED) e qualquer estágio posterior; dispatch: DISPATCHED e posteriores; cancel: só CANCELLED
 * (a falha do cancelamento chega como CANCELLATION_REQUEST_FAILED e é tratada à parte); confirm: qualquer estágio após PLACED.
 * CANCELLED/CONCLUDED encerram tudo o que estava pendente (exceto o próprio cancel, que só CANCELLED resolve).
 */
const RESOLVE_ACAO = {
  confirm: (st) => st !== "PLACED",
  ready: (st) => ["SEPARATION_ENDED", "READY_TO_PICKUP", "DISPATCHED", "CONCLUDED", "CANCELLED"].includes(st),
  dispatch: (st) => ["DISPATCHED", "CONCLUDED", "CANCELLED"].includes(st),
  cancel: (st) => st === "CANCELLED",
};

/**
 * Colunas extras (SLA + carimbos + ação) que um evento de STATUS carrega. Só o que ainda está vazio no pedido
 * (o primeiro carimbo vale: PLACED/CONFIRMED reentregues não reescrevem o SLA). O evento que corresponde à ação pendente
 * RESOLVE a ação (action_state = none, action_uncertain = false): o iFood já disse o que aconteceu.
 */
export function extrasDoEvento(pedido, status, { createdAt, recebidoEm }) {
  const extras = {};
  const seVazio = (coluna, valor) => { if (valor && pedido[coluna] == null) extras[coluna] = valor; };
  if (status === "PLACED") {
    seVazio("placed_event_created_at", createdAt);
    seVazio("placed_event_received_at", recebidoEm);
    return extras;
  }
  if (status === "CONFIRMED") {
    seVazio("confirmed_event_at", createdAt);
    seVazio("confirmed_event_received_at", recebidoEm);
  }
  if (status === "READY_TO_PICKUP") seVazio("ready_event_at", createdAt);
  if (status === "DISPATCHED") seVazio("dispatch_event_at", createdAt);
  if (status === "CANCELLED") seVazio("cancel_event_at", createdAt);

  const estado = pedido.action_state ?? "none";
  const acao = estado === "none" ? null : estado.split("_")[0];
  if (acao && RESOLVE_ACAO[acao]?.(status)) {
    extras.action_state = "none";
    if (pedido.action_uncertain !== undefined) extras.action_uncertain = false;              // coluna da 103 (banco só com a 102 não a tem)
  }
  return extras;
}

/** CANCELLATION_REQUEST_FAILED: o iFood recusou o cancelamento pedido. Só afeta a ação `cancel` pendente (nunca o estado oficial). */
export function extrasDeCancelamentoRecusado(pedido, { createdAt }) {
  const extras = {};
  if (createdAt && (!pedido.cancel_failed_event_at || Date.parse(createdAt) > Date.parse(pedido.cancel_failed_event_at))) extras.cancel_failed_event_at = createdAt;
  if (/^cancel_(sending|requested)$/.test(pedido.action_state ?? "")) {
    Object.assign(extras, { action_state: "cancel_failed", action_uncertain: false, action_last_error: "CANCELLATION_REQUEST_FAILED" });   // só roda com a 103 (cancel_* nasce nela)
  }
  return extras;
}

export async function aplicarEfeito({ evento, tenant, repo, agora = () => new Date(), log = ifoodLog, recebidoEm = null }) {
  const cls = evento.classificacao ?? classificarCodigo(evento.code);
  if (!cls.conhecido) return { status: "DESCONHECIDO" };
  if (!evento.orderId) return { status: "IGNORADO", erro: "evento sem orderId" };

  const pedido0 = await repo.garantirPedido({
    orderId: evento.orderId, merchantId: evento.merchantId,
    organizacaoId: tenant.organizacaoId, unidadeId: tenant.unidadeId, eventoEm: evento.createdAt,
  });
  if (!pedido0) throw new Error("pedido não encontrado após garantirPedido");

  // Um pedido pertence a UM tenant. Se já existe em outro, este evento NUNCA o altera.
  if (pedido0.organizacao_id !== tenant.organizacaoId || pedido0.unidade_id !== tenant.unidadeId) {
    log("error", "events.pedido_de_outro_tenant", { orderId: evento.orderId, eventId: evento.eventId });
    return { status: "FALHOU", erro: "PEDIDO_DE_OUTRO_TENANT", naoReprocessavel: true };
  }

  if (cls.grupo === "ORDER_HANDSHAKE") {                        // HSD / HSS — Plataforma de negociação (Checkpoint D)
    await repo.registrarEventoNoPedido({ pedido: pedido0, eventoEm: evento.createdAt });
    return aplicarHandshake({ evento, pedido: pedido0, tenant, repo, recebidoEm: recebidoEm ?? agora().toISOString(), log });
  }
  if (evento.code === "CARF") {                                 // CANCELLATION_REQUEST_FAILED: falha do cancelamento pedido
    const extras = extrasDeCancelamentoRecusado(pedido0, { createdAt: evento.createdAt });
    await repo.registrarEventoNoPedido({ pedido: pedido0, eventoEm: evento.createdAt, extras });
    return { status: Object.keys(extras).length ? "PROCESSADO" : "IGNORADO" };
  }
  if (!cls.status) {                                            // conhecido, sem efeito de ESTADO (informativo)
    await repo.registrarEventoNoPedido({ pedido: pedido0, eventoEm: evento.createdAt });
    return { status: "IGNORADO" };
  }

  // ORDER_STATUS — compare-and-set, no máximo 2 tentativas (corrida improvável: 1 poller por vez).
  let pedido = pedido0;
  for (let tentativa = 1; tentativa <= 2; tentativa += 1) {
    const d = decidirTransicao(pedido, { status: cls.status, createdAt: evento.createdAt });
    const extras = extrasDoEvento(pedido, cls.status, { createdAt: evento.createdAt, recebidoEm: recebidoEm ?? agora().toISOString() });
    if (!d.aplicar) {
      // Não muda o estado oficial, mas o carimbo de SLA (ex.: PLACED que chegou depois do CONFIRMED) e a
      // resolução da ação continuam valendo.
      await repo.registrarEventoNoPedido({ pedido, eventoEm: evento.createdAt, extras });
      return { status: "IGNORADO", erro: d.motivo };
    }
    const em = evento.createdAt ?? agora().toISOString();
    const maiorUltimo = !pedido.ultimo_evento_em || ms(em) > ms(pedido.ultimo_evento_em) ? em : pedido.ultimo_evento_em;
    const gravou = await repo.aplicarStatusPedido({
      pedido, esperadoStatusEm: pedido.status_oficial_em ?? null,
      novo: { status: cls.status, eventId: evento.eventId, em, ultimoEventoEm: maiorUltimo, extras },
    });
    if (gravou) {
      log("info", "events.estado", {
        orderId: evento.orderId, previous: pedido.status_oficial ?? null, current: cls.status, source: "EVENT", eventId: evento.eventId,
      });
      return { status: "PROCESSADO" };
    }
    pedido = await repo.obterPedidoPorOrderId(evento.orderId);   // perdeu a corrida: relê e reavalia
    if (!pedido) throw new Error("pedido sumiu durante a atualização");
  }
  throw new Error("não foi possível aplicar o estado (corrida persistente)");
}

async function gravarResultado(repo, eventId, r, agora) {
  await repo.atualizarEvento(eventId, {
    processing_status: r.status,
    processed_at: agora().toISOString(),
    last_error: r.erro ?? null,
    ...(r.naoReprocessavel ? { retry_count: IFOOD_EVENTS.maxTentativasProcessamento } : {}),
  });
}

/**
 * Persiste e processa um lote de eventos crus.
 * LANÇA se a persistência falhar (nesse caso NADA deve ser reconhecido).
 *
 * @param {{
 *   eventosBrutos: any[],
 *   conexoesPorMerchant: Map<string, {id: string, organizacao_id: string, unidade_id: string}>,
 *   repo: object, agora?: () => Date, log?: Function,
 * }} p
 * @returns {Promise<{idsParaAck: string[], resumo: object}>}
 */
export async function processarLote({ eventosBrutos, conexoesPorMerchant, repo, agora = () => new Date(), log = ifoodLog }) {
  const resumo = {
    recebidos: eventosBrutos.length, invalidos: 0, duplicadosNoLote: 0, novos: 0, reentregas: 0,
    processados: 0, ignorados: 0, desconhecidos: 0, quarentena: 0, falhas: 0,
  };

  // 1) normaliza + dedupe no lote
  const vistos = new Set();
  const unicos = [];
  for (const raw of eventosBrutos) {
    const r = normalizarEvento(raw);
    if (!r.valido) { resumo.invalidos += 1; log("warn", "events.invalido", { motivo: r.motivo }); continue; }
    if (vistos.has(r.evento.eventId)) { resumo.duplicadosNoLote += 1; continue; }
    vistos.add(r.evento.eventId);
    unicos.push(r.evento);
  }
  if (unicos.length === 0) return { idsParaAck: [], resumo };

  // 2) a API pode entregar fora de ordem: processa por createdAt
  const ordenados = ordenarPorCriacao(unicos);
  const recebidoEm = agora().toISOString();

  // 3) resolve tenant (SEMPRE por conexão) e monta as linhas
  const tenantDe = (e) => conexoesPorMerchant.get(e.merchantId) ?? null;
  const linhas = ordenados.map((e) => {
    const con = tenantDe(e);
    return {
      event_id: e.eventId, merchant_id: e.merchantId, order_id: e.orderId,
      event_code: e.code, event_full_code: e.fullCode, sales_channel: e.salesChannel,
      event_created_at: e.createdAt,
      organizacao_id: con?.organizacao_id ?? null, unidade_id: con?.unidade_id ?? null, conexao_id: con?.id ?? null,
      received_at: recebidoEm, ultima_entrega_em: recebidoEm,
      processing_status: con ? "RECEBIDO" : "MERCHANT_DESCONHECIDO",
      payload: e.payload, payload_hash: e.payloadHash,
    };
  });

  // 4) PERSISTE (dedupe atômico). Falhou -> lança -> sem ACK.
  const inseridos = new Set(await repo.inserirEventos(linhas));
  resumo.novos = inseridos.size;

  const reentregues = ordenados.filter((e) => !inseridos.has(e.eventId)).map((e) => e.eventId);
  resumo.reentregas = reentregues.length;
  if (reentregues.length) {
    await repo.marcarReentregas(reentregues).catch((e) => log("warn", "events.marcar_reentrega_falhou", { erro: msg(e) }));
  }

  // 5) processa só os NOVOS, em ordem de criação
  for (const e of ordenados) {
    if (!inseridos.has(e.eventId)) continue;
    log("info", "events.recebido", {
      merchantId: mascararId(e.merchantId), eventId: e.eventId, orderId: e.orderId, code: e.code, receivedAt: recebidoEm,
    });
    const con = tenantDe(e);
    if (!con) { resumo.quarentena += 1; log("warn", "events.merchant_desconhecido", { merchantId: mascararId(e.merchantId), eventId: e.eventId }); continue; }
    try {
      const r = await aplicarEfeito({ evento: e, tenant: { organizacaoId: con.organizacao_id, unidadeId: con.unidade_id }, repo, agora, log, recebidoEm });
      await gravarResultado(repo, e.eventId, r, agora);
      if (r.status === "PROCESSADO") resumo.processados += 1;
      else if (r.status === "IGNORADO") resumo.ignorados += 1;
      else if (r.status === "DESCONHECIDO") resumo.desconhecidos += 1;
      else resumo.falhas += 1;
    } catch (err) {
      resumo.falhas += 1;
      log("error", "events.processamento_falhou", { eventId: e.eventId, erro: msg(err) });
      await repo.atualizarEvento(e.eventId, { processing_status: "FALHOU", last_error: msg(err), retry_count: 1 })
        .catch((e2) => log("error", "events.marcar_falha_falhou", { eventId: e.eventId, erro: msg(e2) }));
    }
  }

  // 6) reconhece TODOS os eventos persistidos do lote (novos, reentregues, desconhecidos, quarentena)
  return { idsParaAck: ordenados.map((e) => e.eventId), resumo };
}

/**
 * Reprocessa eventos persistidos que ficaram RECEBIDO/FALHOU (ex.: queda entre
 * persistir e processar). Não fala com o iFood.
 * @returns {Promise<{tentados: number, processados: number, falhas: number}>}
 */
export async function reprocessarPendentes({ repo, limite = 50, agora = () => new Date(), log = ifoodLog }) {
  const linhas = await repo.listarEventosPendentes(limite, IFOOD_EVENTS.maxTentativasProcessamento);
  const out = { tentados: linhas.length, processados: 0, falhas: 0 };
  for (const l of linhas) {
    const evento = {
      eventId: l.event_id, code: l.event_code, orderId: l.order_id, merchantId: l.merchant_id,
      createdAt: l.event_created_at, classificacao: classificarCodigo(l.event_code),
      metadata: l.payload?.metadata && typeof l.payload.metadata === "object" ? l.payload.metadata : null,
    };
    try {
      const r = await aplicarEfeito({ evento, tenant: { organizacaoId: l.organizacao_id, unidadeId: l.unidade_id }, repo, agora, log, recebidoEm: l.received_at ?? null });
      await gravarResultado(repo, l.event_id, r, agora);
      if (r.status === "FALHOU") out.falhas += 1; else out.processados += 1;
    } catch (err) {
      out.falhas += 1;
      log("warn", "events.reprocessamento_falhou", { eventId: l.event_id, tentativa: (l.retry_count ?? 0) + 1, erro: msg(err) });
      await repo.atualizarEvento(l.event_id, { processing_status: "FALHOU", last_error: msg(err), retry_count: (l.retry_count ?? 0) + 1 })
        .catch(() => {});
    }
  }
  return out;
}

/**
 * ACK em lotes. `confirmar(ids)` fala com o iFood (202). Depois de CADA lote
 * confirmado, grava acknowledged_at. Se um lote falhar, para e lança: os ids
 * restantes NÃO ficam marcados e voltam no próximo polling (idempotente).
 *
 * @param {{idsParaAck: string[], confirmar: (ids: string[]) => Promise<any>, dividir: (ids: string[]) => string[][], repo: object, agora?: () => Date, log?: Function}} p
 */
export async function enviarAcks({ idsParaAck, confirmar, dividir, repo, agora = () => new Date(), log = ifoodLog }) {
  let confirmados = 0;
  for (const lote of dividir(idsParaAck)) {
    await confirmar(lote);
    confirmados += lote.length;
    log("info", "events.ack", { qtd: lote.length });   // o status HTTP real fica no log api.ok do cliente
    // O iFood JÁ aceitou (202): falhar em gravar o carimbo local não pode abortar os demais lotes.
    await repo.marcarAck(lote, agora().toISOString())
      .catch((e) => log("warn", "events.marcar_ack_falhou", { qtd: lote.length, erro: msg(e) }));
  }
  return { confirmados };
}
