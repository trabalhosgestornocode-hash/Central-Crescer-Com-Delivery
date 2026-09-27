// Handshake / Plataforma de negociação — persistência dos eventos e resposta às disputas.
//
// RECEBER (chamado por ifoodEvents.service#aplicarEfeito, já com o tenant resolvido pela CONEXÃO):
//   HANDSHAKE_DISPUTE  -> cria/completa `ifood_disputas` (idempotente por dispute_id)
//   HANDSHAKE_SETTLEMENT -> registra o settlement (dedupe por event_id) e encerra a negociação quando for final
//   Fora de ordem: um settlement pode chegar antes da disputa (cria esqueleto; a disputa depois só COMPLETA os campos,
//   nunca reabre uma negociação encerrada).
//
// RESPONDER (`responderDisputa`): accept / reject / alternative — UMA resposta por disputeId (não reutilizável):
//   * nunca repete às cegas (transporte sem retry); timeout/5xx => RESPOSTA_INCERTA + aguardar o HANDSHAKE_SETTLEMENT;
//   * HTTP aceito (201) NÃO encerra a negociação: só o evento HANDSHAKE_SETTLEMENT encerra (status ENCERRADA);
//   * valida a resposta contra o que o iFood ofereceu na própria disputa (alternativas, motivos, limites);
//   * prazo (`expiresAt`) vencido => nada é enviado (o iFood já aplicou `timeoutAction`).

import { IFOOD_APP_ORDER, IFOOD_ORDER } from "./ifood.constants.js";
import { ifoodErro, IFOOD_ERROS } from "./ifood.errors.js";
import { ifoodLog } from "./ifood.logsafe.js";
import * as handshakeClient from "./ifoodHandshake.client.js";
import { interpretarDisputa, interpretarSettlement } from "./ifoodHandshake.parser.js";
import { classificarFalhaDeAcao, mensagemSegura, sanitizarParaAuditoria } from "./ifoodAcoes.util.js";

const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const comToken = (token, conexaoId, http, fn) => token.comAccessTokenValido({ conexaoId, appType: IFOOD_APP_ORDER, deps: { http }, fn });
const ABERTAS = new Set(["ABERTA", "RESPOSTA_FALHOU"]);

// =====================================================================
// RECEBER
// =====================================================================

/**
 * @param {{evento: {eventId, code, orderId, merchantId, createdAt, metadata}, pedido: object, tenant: {organizacaoId, unidadeId}, repo: object, recebidoEm?: string}} p
 * @returns {Promise<{status: 'PROCESSADO'|'IGNORADO'|'FALHOU', erro?: string, naoReprocessavel?: boolean}>}
 */
export async function aplicarHandshake({ evento, pedido, tenant, repo, recebidoEm = null, log = ifoodLog }) {
  // O merchant do evento tem que ser o merchant do pedido (tenant nunca vem do payload, mas o cruzamento é exigido).
  if (pedido.merchant_id !== evento.merchantId) {
    log("error", "handshake.merchant_divergente", { orderId: evento.orderId, eventId: evento.eventId });
    return { status: "FALHOU", erro: "MERCHANT_DIVERGENTE", naoReprocessavel: true };
  }
  return evento.code === "HSS"
    ? aplicarSettlement({ evento, pedido, tenant, repo, log })
    : aplicarDisputa({ evento, pedido, tenant, repo, recebidoEm, log });
}

const doMesmoTenant = (d, t) => d.organizacao_id === t.organizacaoId && d.unidade_id === t.unidadeId;

async function garantir(repo, { disputeId, pedido, tenant, extra = {} }) {
  const existente = await repo.obterDisputaPorDisputeId(disputeId);
  if (existente) return existente;
  return repo.garantirDisputa({
    dispute_id: disputeId, order_id: pedido.order_id, pedido_id: pedido.id,
    organizacao_id: tenant.organizacaoId, unidade_id: tenant.unidadeId, merchant_id: pedido.merchant_id, ...extra,
  });
}

async function aplicarDisputa({ evento, pedido, tenant, repo, recebidoEm, log }) {
  const r = interpretarDisputa(evento.metadata);
  if (!r.valido) {
    // Não descartar em silêncio: uma negociação real tem PRAZO. O evento fica guardado (payload bruto) e este log expõe só os NOMES das chaves.
    log("error", "handshake.hsd_nao_interpretado", { eventId: evento.eventId, orderId: evento.orderId, motivo: r.motivo, chaves: Object.keys(evento.metadata ?? {}).slice(0, 30) });
    return { status: "IGNORADO", erro: r.motivo };
  }
  const d = r.disputa;

  const existente = await garantir(repo, {
    disputeId: d.dispute_id, pedido, tenant,
    extra: { ...d, dispute_event_id: evento.eventId, dispute_event_received_at: recebidoEm ?? null, status: "ABERTA" },
  });
  if (!doMesmoTenant(existente, tenant) || existente.order_id !== pedido.order_id) {
    log("error", "handshake.disputa_de_outro_tenant", { disputeId: d.dispute_id, eventId: evento.eventId });
    return { status: "FALHOU", erro: "DISPUTA_DE_OUTRO_TENANT", naoReprocessavel: true };
  }

  // Já existia (evento repetido com outro id, ou esqueleto criado por um settlement fora de ordem): só COMPLETA o que está vazio.
  const vazios = {};
  for (const [k, v] of Object.entries({ ...d, dispute_event_id: evento.eventId, dispute_event_received_at: recebidoEm ?? null })) {
    if (v === null || v === undefined) continue;
    const atual = existente[k];
    if (atual === null || atual === undefined || (Array.isArray(atual) && atual.length === 0 && Array.isArray(v) && v.length)) vazios[k] = v;
  }
  if (existente.dispute_event_id === evento.eventId) return { status: "PROCESSADO" };   // acabou de ser criada por este evento
  if (!Object.keys(vazios).length) return { status: "IGNORADO", erro: "disputa_ja_registrada" };
  await repo.atualizarDisputa({ disputa: existente, campos: vazios });                    // NUNCA toca em `status`
  return { status: "PROCESSADO" };
}

async function aplicarSettlement({ evento, pedido, tenant, repo, log }) {
  const r = interpretarSettlement(evento.metadata);
  if (!r.valido) {
    log("error", "handshake.hss_nao_interpretado", { eventId: evento.eventId, orderId: evento.orderId, motivo: r.motivo, chaves: Object.keys(evento.metadata ?? {}).slice(0, 30) });
    return { status: "IGNORADO", erro: r.motivo };
  }
  const s = r.settlement;

  for (let tentativa = 1; tentativa <= 2; tentativa += 1) {
    const existente = await garantir(repo, { disputeId: s.dispute_id, pedido, tenant, extra: { status: "ABERTA" } });
    if (!doMesmoTenant(existente, tenant) || existente.order_id !== pedido.order_id) {
      log("error", "handshake.settlement_de_outro_tenant", { disputeId: s.dispute_id, eventId: evento.eventId });
      return { status: "FALHOU", erro: "DISPUTA_DE_OUTRO_TENANT", naoReprocessavel: true };
    }
    if ((existente.settlements ?? []).some((x) => x.event_id === evento.eventId)) return { status: "IGNORADO", erro: "settlement_duplicado" };

    const em = evento.createdAt ?? s.created_at;
    const lista = [...(existente.settlements ?? []), { event_id: evento.eventId, settlement_id: s.settlement_id, status: s.status, reason: s.reason, at: em, selected_alternative: s.selected_alternative ?? null }]
      .sort((a, b) => (ms(a.at) || 0) - (ms(b.at) || 0));
    const ultimo = lista.at(-1);
    const temFinal = lista.some((x) => ["ACCEPTED", "REJECTED", "EXPIRED"].includes(x.status));
    const temAlternativa = lista.some((x) => x.status === "ALTERNATIVE_REPLIED");
    // Encerrada nunca reabre; ALTERNATIVE_REPLIED espera a resposta final do cliente.
    const status = temFinal ? "ENCERRADA" : temAlternativa ? "RESPONDIDA" : existente.status;

    const gravou = await repo.atualizarDisputa({
      disputa: existente,
      campos: { settlements: lista, settlement_status: ultimo.status, settlement_reason: ultimo.reason ?? null, settlement_at: ultimo.at ?? null, status },
      condicoes: { status: existente.status },
    });
    if (gravou) return { status: "PROCESSADO" };
  }
  throw new Error("não foi possível registrar o settlement (corrida persistente)");
}

// =====================================================================
// RESPONDER
// =====================================================================

const estadoDisputa = (detalhes) => ifoodErro(IFOOD_ERROS.IFOOD_DISPUTA_ENCERRADA, { detalhes });
const respostaInvalida = (motivo) => ifoodErro(IFOOD_ERROS.IFOOD_RESPOSTA_DISPUTA_INVALIDA, { detalhes: { motivo } });
const valorInteiro = (v) => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };

/**
 * PURA: valida a resposta contra o que o iFood OFERECEU na disputa (matriz da documentação).
 * @returns {{corpo: object|null, decision: 'ACCEPT'|'REJECT'|'ALTERNATIVE', reason: string|null}}  ou LANÇA IFOOD_RESPOSTA_DISPUTA_INVALIDA
 */
export function validarResposta(disputa, { decisao, reason = null, detailReason = null, alternativa = null }) {
  const tipo = disputa.handshake_type;
  const alternativas = Array.isArray(disputa.alternatives) ? disputa.alternatives : [];
  const motivosAceite = Array.isArray(disputa.accept_cancellation_reasons) ? disputa.accept_cancellation_reasons : [];

  if (decisao === "ACCEPT") {
    if (reason && motivosAceite.length && !motivosAceite.includes(reason)) throw respostaInvalida("motivo de aceite fora de acceptCancellationReasons");
    // DELAY exige um motivo de aceite (exemplo oficial). Nos demais o corpo é opcional.
    if (tipo === "DELAY" && motivosAceite.length && !reason) throw respostaInvalida("DELAY exige reason de acceptCancellationReasons");
    return { decision: "ACCEPT", reason: reason ?? null, corpo: reason ? { reason, ...(detailReason ? { detailReason: String(detailReason).slice(0, 250) } : {}) } : null };
  }
  if (decisao === "REJECT") {
    if (!reason || !String(reason).trim()) throw respostaInvalida("reject exige reason");
    return { decision: "REJECT", reason: String(reason).trim(), corpo: { reason: String(reason).trim() } };
  }
  if (decisao === "ALTERNATIVE") {
    if (tipo === "PREPARATION_TIME") throw respostaInvalida("durante o preparo só é possível aceitar ou rejeitar (sem contraproposta)");
    const t = alternativa?.type;
    const oferecida = alternativas.find((a) => a?.type === t);
    if (!oferecida) throw respostaInvalida(`alternativa ${t ?? "(vazia)"} não foi oferecida pelo iFood nesta negociação`);
    const meta = alternativa.metadata ?? {};
    if (t === "REFUND" || t === "BENEFIT") {
      const v = valorInteiro(meta.amount?.value);
      const max = valorInteiro(oferecida.metadata?.maxAmount?.value);
      if (!Number.isFinite(v) || v <= 0) throw respostaInvalida("valor inválido (inteiro em centavos)");
      if (Number.isFinite(max) && v > max) throw respostaInvalida("valor acima do máximo oferecido (maxAmount)");
      if (!meta.amount?.currency) throw respostaInvalida("moeda ausente");
      return { decision: "ALTERNATIVE", reason: t, corpo: { type: t, metadata: { amount: { value: String(v), currency: meta.amount.currency } } } };
    }
    if (t === "ADDITIONAL_TIME") {
      const permitidos = oferecida.metadata?.allowedsAdditionalTimeInMinutes;
      const motivos = oferecida.metadata?.allowedsAdditionalTimeReasons;
      if (!Number.isInteger(meta.additionalTimeInMinutes) || (Array.isArray(permitidos) && !permitidos.includes(meta.additionalTimeInMinutes))) throw respostaInvalida("minutos fora de allowedsAdditionalTimeInMinutes");
      if (Array.isArray(motivos) && motivos.length && !motivos.includes(meta.additionalTimeReason)) throw respostaInvalida("motivo fora de allowedsAdditionalTimeReasons");
      return { decision: "ALTERNATIVE", reason: t, corpo: { type: t, metadata: { additionalTimeInMinutes: meta.additionalTimeInMinutes, additionalTimeReason: meta.additionalTimeReason } } };
    }
    throw respostaInvalida("tipo de alternativa desconhecido");
  }
  throw respostaInvalida("decisão desconhecida");
}

/**
 * Resultado: SOLICITADO · JA_SOLICITADO · EM_ENVIO · AGUARDANDO_EVENTO. Exceções: DISPUTA_NAO_ENCONTRADA (outro tenant também),
 * DISPUTA_ENCERRADA (respondida/expirada/settlement recebido), RESPOSTA_DISPUTA_INVALIDA, erros do iFood.
 */
export async function responderDisputa({
  organizacaoId, unidadeId, disputeId, decisao, reason = null, detailReason = null, alternativa = null,
  repo, token, client = handshakeClient, http, agora = () => new Date(), log = ifoodLog, permitirReenvioIncerto = false,
}) {
  let disputa = await repo.obterDisputaDoTenant({ organizacaoId, unidadeId, disputeId });
  if (!disputa) throw ifoodErro(IFOOD_ERROS.IFOOD_DISPUTA_NAO_ENCONTRADA);
  const nowMs = () => agora().getTime();

  for (let volta = 1; volta <= 2; volta += 1) {
    if (disputa.status === "ENCERRADA") throw estadoDisputa({ motivo: "settlement_recebido", settlementStatus: disputa.settlement_status ?? null });
    if (disputa.status === "RESPONDIDA") return { resultado: "JA_SOLICITADO", disputeId, decision: disputa.decision ?? null, status: disputa.status };
    if (disputa.status === "RESPONDENDO") {
      const velho = nowMs() - (ms(disputa.decision_requested_at) || nowMs()) > IFOOD_ORDER.sendingReassumivelMs;
      if (!velho) return { resultado: "EM_ENVIO", disputeId, status: disputa.status };
      if (!permitirReenvioIncerto) return { resultado: "AGUARDANDO_EVENTO", incerto: true, disputeId, status: disputa.status };
    }
    if (disputa.status === "RESPOSTA_INCERTA") {
      const idade = nowMs() - (ms(disputa.decision_requested_at) || nowMs());
      if (!(permitirReenvioIncerto && idade >= IFOOD_ORDER.reenvioIncertoAposMs)) return { resultado: "AGUARDANDO_EVENTO", incerto: true, disputeId, status: disputa.status };
    }
    // Prazo vencido: o iFood já executou `timeoutAction`; responder agora seria inútil (e a API recusaria).
    if (disputa.expires_at && ms(disputa.expires_at) <= nowMs()) throw estadoDisputa({ motivo: "prazo_expirado", expiresAt: disputa.expires_at });

    const v = validarResposta(disputa, { decisao, reason, detailReason, alternativa });

    const pedido = await repo.obterPedidoDoTenant({ organizacaoId, unidadeId, orderId: disputa.order_id });
    if (!pedido) throw ifoodErro(IFOOD_ERROS.IFOOD_PEDIDO_LOCAL_NAO_ENCONTRADO);
    const conexao = await repo.obterConexaoAtivaDoMerchant({ organizacaoId, unidadeId, merchantId: pedido.merchant_id });
    if (!conexao) throw ifoodErro(IFOOD_ERROS.IFOOD_CONEXAO_NAO_ENCONTRADA);

    const tAntes = agora().toISOString();
    const tentativa = (disputa.decision_attempts ?? 0) + 1;
    const requestPayload = sanitizarParaAuditoria(v.corpo);
    const reservou = await repo.atualizarDisputa({
      disputa,
      campos: {
        status: "RESPONDENDO", decision: v.decision, decision_reason: v.reason, decision_request: requestPayload, decision_requested_at: tAntes,
        decision_attempts: tentativa, decision_error: null, decision_http_status: null,
      },
      condicoes: { status: disputa.status },
    });
    if (!reservou) {                                            // perdeu a corrida (ex.: settlement chegou): relê e reavalia
      disputa = await repo.obterDisputaDoTenant({ organizacaoId, unidadeId, disputeId });
      if (!disputa) throw ifoodErro(IFOOD_ERROS.IFOOD_DISPUTA_NAO_ENCONTRADA);
      continue;
    }

    const acao = v.decision === "ACCEPT" ? "dispute_accept" : v.decision === "REJECT" ? "dispute_reject" : "dispute_alternative";
    const auditar = (resultado, extra = {}) => Promise.resolve(repo.registrarAcao({
      pedido, acao, resultado, conexaoId: conexao.id, tentativa, requestedAt: tAntes, requestPayload, disputeId, ...extra,
    })).catch((e) => log("warn", "handshake.auditoria_falhou", { disputeId, erro: mensagemSegura(e) }));

    const enviar = (accessToken) => (v.decision === "ACCEPT"
      ? client.aceitarDisputa({ accessToken, disputeId, reason: v.corpo?.reason ?? null, detailReason: v.corpo?.detailReason ?? null, http })
      : v.decision === "REJECT"
        ? client.rejeitarDisputa({ accessToken, disputeId, reason: v.reason, http })
        : client.proporAlternativa({ accessToken, disputeId, type: v.corpo.type, metadata: v.corpo.metadata, http }));

    let envio;
    try {
      envio = await comToken(token, conexao.id, http, enviar);
    } catch (e) {
      const tDepois = agora().toISOString();
      const httpStatus = e?.details?.status ?? null;
      const incerto = classificarFalhaDeAcao(e) === "incerto";
      // Por que o iFood recusou (code/message do corpo do erro), quando houver — a doc já divergiu do sandbox (D3: cancellationCode).
      const motivoDoIfood = [e?.details?.ifoodCode, e?.details?.ifoodMessage].filter(Boolean).join(": ") || null;
      await repo.atualizarDisputa({
        disputa,
        campos: { status: incerto ? "RESPOSTA_INCERTA" : "RESPOSTA_FALHOU", decision_error: [String(e?.codigo ?? "ERRO"), motivoDoIfood].filter(Boolean).join(" — ").slice(0, 300), decision_http_status: httpStatus, decision_responded_at: tDepois },
        condicoes: { status: "RESPONDENDO" },
      });
      await auditar(incerto ? "INCERTO" : e?.codigo === IFOOD_ERROS.IFOOD_ACAO_PEDIDO_RECUSADA ? "RECUSADA" : "FALHOU",
        { respondedAt: tDepois, httpStatus, erroCodigo: e?.codigo ?? null, erroMensagem: motivoDoIfood ?? mensagemSegura(e) });
      if (incerto) {
        log("warn", "handshake.resposta_incerta", { disputeId, codigo: e?.codigo ?? null });
        return { resultado: "AGUARDANDO_EVENTO", incerto: true, disputeId, status: "RESPOSTA_INCERTA" };
      }
      throw e;
    }

    const tDepois = agora().toISOString();
    if (!envio.aceito) {
      await repo.atualizarDisputa({
        disputa, campos: { status: "RESPOSTA_FALHOU", decision_error: "RESPOSTA_NAO_ACEITA", decision_http_status: envio.status ?? null, decision_responded_at: tDepois },
        condicoes: { status: "RESPONDENDO" },
      });
      await auditar("FALHOU", { respondedAt: tDepois, httpStatus: envio.status ?? null, erroCodigo: "RESPOSTA_NAO_ACEITA" });
      throw ifoodErro(IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA, { detalhes: { status: envio.status } });
    }

    // HTTP aceito: a resposta foi ENVIADA. A negociação só ENCERRA com o evento HANDSHAKE_SETTLEMENT (CAS: se ele já chegou, não o sobrescrevemos).
    const resposta = sanitizarParaAuditoria(envio.resposta);
    const gravou = await repo.atualizarDisputa({
      disputa, campos: { status: "RESPONDIDA", decision_http_status: envio.status, decision_response: resposta, decision_responded_at: tDepois, decision_error: null },
      condicoes: { status: "RESPONDENDO" },
    });
    await auditar("ACEITA", { respondedAt: tDepois, httpStatus: envio.status, responsePayload: resposta });
    log("info", "handshake.resposta_enviada", { disputeId, decision: v.decision, httpStatus: envio.status, settlementJaChegou: !gravou });
    const atual = await repo.obterDisputaDoTenant({ organizacaoId, unidadeId, disputeId });
    return { resultado: "SOLICITADO", disputeId, decision: v.decision, httpStatus: envio.status, status: atual?.status ?? "RESPONDIDA", settlementJaChegou: !gravou };
  }
  throw estadoDisputa({ motivo: "corrida_persistente" });
}
