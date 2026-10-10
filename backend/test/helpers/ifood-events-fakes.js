// Fakes em memória para os testes de Events do iFood.
//
// O repositório em memória espelha a SEMÂNTICA do banco (migration 101), que foi
// validada num Postgres local descartável:
//   * ifood_eventos.event_id UNIQUE  -> inserirEventos devolve só os NOVOS (ON CONFLICT DO NOTHING);
//   * ifood_pedidos.order_id UNIQUE  -> garantirPedido é idempotente e devolve o pedido EXISTENTE;
//   * lease atômico com relógio do "banco" (`relogio.agoraMs()`): titular vivo bloqueia os outros,
//     vencido é tomado (geração + 1), mesmo titular renova, liberar só pelo titular.
// Injeção de falhas: `repo.falhar.<metodo> = n` faz as próximas n chamadas lançarem.

import { ifoodErro, IFOOD_ERROS } from "../../src/modules/ifood/ifood.errors.js";

export const BASE_MS = Date.parse("2026-09-27T12:00:00.000Z");
/** ISO de "base + n minutos". */
export const t = (min) => new Date(BASE_MS + min * 60_000).toISOString();

export function criarRelogio(inicioMs = BASE_MS) {
  let agora = inicioMs;
  return {
    agoraMs: () => agora,
    agora: () => new Date(agora),
    avancarS: (s) => { agora += s * 1000; },
  };
}

export const ORG_A = "org-a"; export const UN_A = "un-a";
export const ORG_B = "org-b"; export const UN_B = "un-b";
export const M_A = "aaaaaaaa-0000-4000-8000-00000000000a";
export const M_B = "bbbbbbbb-0000-4000-8000-00000000000b";

export const CONEXAO_A = { id: "con-a", organizacao_id: ORG_A, unidade_id: UN_A, merchant_id: M_A };
export const CONEXAO_B = { id: "con-b", organizacao_id: ORG_B, unidade_id: UN_B, merchant_id: M_B };

const CODIGOS = { PLC: "PLACED", CFM: "CONFIRMED", RTP: "READY_TO_PICKUP", DSP: "DISPATCHED", CON: "CONCLUDED", CAN: "CANCELLED", CAR: "CANCELLATION_REQUESTED", HSD: "HANDSHAKE_DISPUTE" };

/** Evento cru no formato da API de Events. */
export function ev(id, code, { min = 0, orderId = "order-1", merchantId = M_A, ...resto } = {}) {
  return { id, code, fullCode: CODIGOS[code] ?? code, orderId, merchantId, createdAt: t(min), salesChannel: "IFOOD", metadata: { CLIENT_ID: "x" }, ...resto };
}

/**
 * Allowlist do piloto para os testes que NÃO tratam do piloto: todas as unidades do repo fake (lida a cada
 * ciclo, como em produção). Sem isto o poller é fail-closed e não consulta ninguém.
 */
export const pilotoDe = (repo) => () => repo.conexoes.map((c) => c.unidade_id);

export function criarRepoEmMemoria({ relogio = criarRelogio(), conexoes = [CONEXAO_A, CONEXAO_B] } = {}) {
  const eventos = new Map();   // event_id -> linha
  const pedidos = new Map();   // order_id -> linha
  const acoes = [];            // ifood_pedido_acoes
  const disputas = new Map();  // ifood_disputas (dispute_id -> linha)
  let lease = null;            // { holder, ate, geracao }
  let seq = 0;
  const chamadas = [];         // ordem das chamadas (para provar "persiste antes do ACK")
  const falhar = {};
  const hook = (nome) => {
    chamadas.push(nome);
    if (falhar[nome] > 0) { falhar[nome] -= 1; throw new Error(`falha injetada em ${nome}`); }
  };
  const iso = () => relogio.agora().toISOString();

  const repo = {
    eventos, pedidos, chamadas, falhar, relogio,
    get lease() { return lease; },
    conexoes,
    filtrosPendentes: [],        // `unidades` recebido em cada listarEventosPendentes (escopo do piloto)

    async listarConexoesComMerchant() { hook("listarConexoesComMerchant"); return repo.conexoes.map(({ credOrder, ...c }) => ({ ...c })); },
    // Espelha o filtro do banco: só conexões COM credencial `order` (campo `credOrder` da conexão fake:
    // 'ativa' por padrão, 'reauth_required', ou null = conexão só com analytics/financial).
    async listarConexoesElegiveisParaEvents() {
      hook("listarConexoesElegiveisParaEvents");
      return repo.conexoes
        .map(({ credOrder = "ativa", ...c }) => ({ ...c, credencial_order_status: credOrder }))
        .filter((c) => c.credencial_order_status !== null);
    },

    async inserirEventos(linhas) {
      hook("inserirEventos");
      const novos = [];
      for (const l of linhas) {
        if (eventos.has(l.event_id)) continue;                     // ON CONFLICT DO NOTHING
        eventos.set(l.event_id, {
          id: `ev-${(seq += 1)}`, retry_count: 0, reentregas: 0, acknowledged_at: null, processed_at: null, last_error: null,
          ...l, payload: structuredClone(l.payload),
        });
        novos.push(l.event_id);
      }
      return novos;
    },
    async obterEventosPorIds(ids) { hook("obterEventosPorIds"); return ids.map((i) => eventos.get(i)).filter(Boolean).map((e) => ({ ...e })); },
    async marcarReentregas(ids) {
      hook("marcarReentregas");
      for (const i of ids) { const e = eventos.get(i); if (e) { e.reentregas += 1; e.ultima_entrega_em = iso(); } }
      return ids.length;
    },
    async atualizarEvento(eventId, campos) { hook("atualizarEvento"); Object.assign(eventos.get(eventId), campos); return [{ event_id: eventId }]; },
    async marcarAck(ids, quando) {
      hook("marcarAck");
      for (const i of ids) { const e = eventos.get(i); if (e && !e.acknowledged_at) e.acknowledged_at = quando; }
    },
    async listarEventosPendentes(limite, max, { unidades } = {}) {
      hook("listarEventosPendentes");
      repo.filtrosPendentes.push(unidades === undefined ? undefined : [...unidades]);
      if (Array.isArray(unidades) && unidades.length === 0) return [];
      return [...eventos.values()]
        .filter((e) => ["RECEBIDO", "FALHOU"].includes(e.processing_status) && e.retry_count < max && e.organizacao_id)
        .filter((e) => !Array.isArray(unidades) || unidades.includes(e.unidade_id))
        .slice(0, limite).map((e) => ({ ...e }));
    },

    async obterPedidoPorOrderId(orderId) { hook("obterPedidoPorOrderId"); const p = pedidos.get(orderId); return p ? { ...p } : null; },
    async garantirPedido({ orderId, merchantId, organizacaoId, unidadeId, eventoEm }) {
      hook("garantirPedido");
      if (!pedidos.has(orderId)) {
        pedidos.set(orderId, {
          id: `ped-${(seq += 1)}`, order_id: orderId, merchant_id: merchantId, organizacao_id: organizacaoId, unidade_id: unidadeId,
          status_oficial: null, status_oficial_evento_id: null, status_oficial_em: null,
          primeiro_evento_em: eventoEm ?? null, ultimo_evento_em: eventoEm ?? null,
          // migration 102 (defaults do banco)
          details_status: "PENDENTE", details_tentativas: 0, details_ultima_tentativa_em: null, details_ultimo_erro: null,
          details_fetched_at: null, details_atualizado_em: null, details_payload: null, details_payload_hash: null,
          action_state: "none", confirm_attempts: 0, confirm_last_error: null, confirm_http_status: null,
          placed_event_created_at: null, placed_event_received_at: null, confirm_requested_at: null,
          confirmed_event_at: null, confirmed_event_received_at: null, order_created_at: null,
          criado_em: iso(),
          // migration 103
          action_uncertain: false, action_attempts: 0, action_last_error: null, action_http_status: null, action_requested_at: null,
          ready_requested_at: null, ready_event_at: null, dispatch_requested_at: null, dispatch_event_at: null,
          cancel_requested_at: null, cancel_event_at: null, cancel_reason_code: null, cancel_reason_description: null, cancel_failed_event_at: null,
        });
      }
      return { ...pedidos.get(orderId) };
    },

    // ---- Order (migration 102) ----
    acoes,
    async obterPedidoDoTenant({ organizacaoId, unidadeId, orderId }) {
      hook("obterPedidoDoTenant");
      const p = pedidos.get(orderId);
      return p && p.organizacao_id === organizacaoId && p.unidade_id === unidadeId ? structuredClone(p) : null;
    },
    async obterConexaoAtivaDoMerchant({ organizacaoId, unidadeId, merchantId }) {
      hook("obterConexaoAtivaDoMerchant");
      const c = repo.conexoes.find((x) => x.merchant_id === merchantId && x.organizacao_id === organizacaoId && x.unidade_id === unidadeId);
      return c ? { ...c } : null;
    },
    async atualizarPedido({ pedido, campos, condicoes = {} }) {
      hook("atualizarPedido");
      const p = pedidos.get(pedido.order_id);
      if (!p || p.id !== pedido.id || p.organizacao_id !== pedido.organizacao_id || p.unidade_id !== pedido.unidade_id) return false;
      for (const [k, v] of Object.entries(condicoes)) if ((p[k] ?? null) !== v) return false;   // compare-and-set
      Object.assign(p, structuredClone(campos));
      return true;
    },
    async listarPedidosComDetalhesPendentes({ limite, maxTentativas, apartirDeIso }) {
      hook("listarPedidosComDetalhesPendentes");
      return [...pedidos.values()]
        .filter((p) => ["PENDENTE", "NAO_ENCONTRADO", "ERRO"].includes(p.details_status) && p.details_tentativas < maxTentativas
          && (p.primeiro_evento_em ?? "") >= apartirDeIso)
        .slice(0, limite).map((p) => structuredClone(p));
    },
    async registrarAcao({ pedido, acao, resultado, httpStatus = null, erroCodigo = null, conexaoId = null, tentativa = null,
      requestedAt = null, respondedAt = null, erroMensagem = null, requestPayload = null, responsePayload = null, disputeId = null }) {
      hook("registrarAcao");
      acoes.push({
        order_id: pedido.order_id, organizacao_id: pedido.organizacao_id, unidade_id: pedido.unidade_id, pedido_id: pedido.id, acao, resultado,
        http_status: httpStatus, erro_codigo: erroCodigo, conexao_id: conexaoId, tentativa, requested_at: requestedAt, responded_at: respondedAt,
        error_message: erroMensagem, request_payload: structuredClone(requestPayload), response_payload: structuredClone(responsePayload), dispute_id: disputeId,
      });
    },

    // ---- Disputas / Handshake (migration 103) ----
    disputas,
    async obterDisputaPorDisputeId(id) { hook("obterDisputaPorDisputeId"); const d = disputas.get(id); return d ? structuredClone(d) : null; },
    async obterDisputaDoTenant({ organizacaoId, unidadeId, disputeId }) {
      hook("obterDisputaDoTenant");
      const d = disputas.get(disputeId);
      return d && d.organizacao_id === organizacaoId && d.unidade_id === unidadeId ? structuredClone(d) : null;
    },
    async garantirDisputa(linha) {
      hook("garantirDisputa");
      if (!disputas.has(linha.dispute_id)) {
        disputas.set(linha.dispute_id, {
          id: `dis-${(seq += 1)}`, status: "ABERTA", decision: null, decision_attempts: 0, settlements: [], settlement_status: null,
          decision_requested_at: null, decision_http_status: null, decision_error: null, criado_em: iso(), ...structuredClone(linha),
        });
      }
      return structuredClone(disputas.get(linha.dispute_id));
    },
    async atualizarDisputa({ disputa, campos, condicoes = {} }) {
      hook("atualizarDisputa");
      const d = disputas.get(disputa.dispute_id);
      if (!d || d.id !== disputa.id || d.organizacao_id !== disputa.organizacao_id || d.unidade_id !== disputa.unidade_id) return false;
      for (const [k, v] of Object.entries(condicoes)) if ((d[k] ?? null) !== v) return false;
      Object.assign(d, structuredClone(campos));
      return true;
    },
    async listarDisputasDoTenant({ organizacaoId, unidadeId, status = null }) {
      hook("listarDisputasDoTenant");
      return [...disputas.values()].filter((d) => d.organizacao_id === organizacaoId && d.unidade_id === unidadeId && (!status || status.includes(d.status))).map((d) => structuredClone(d));
    },
    async aplicarStatusPedido({ pedido, esperadoStatusEm, novo }) {
      hook("aplicarStatusPedido");
      const p = pedidos.get(pedido.order_id);
      if (!p || p.id !== pedido.id || p.organizacao_id !== pedido.organizacao_id || p.unidade_id !== pedido.unidade_id) return false;
      if ((p.status_oficial_em ?? null) !== (esperadoStatusEm ?? null)) return false;      // compare-and-set
      Object.assign(p, { status_oficial: novo.status, status_oficial_evento_id: novo.eventId, status_oficial_em: novo.em, ultimo_evento_em: novo.ultimoEventoEm, ...(novo.extras ?? {}) });
      return true;
    },
    async registrarEventoNoPedido({ pedido, eventoEm, extras }) {
      hook("registrarEventoNoPedido");
      const p = pedidos.get(pedido.order_id);
      if (!p) return;
      Object.assign(p, extras ?? {});
      if (!eventoEm) return;
      if (!p.primeiro_evento_em || eventoEm < p.primeiro_evento_em) p.primeiro_evento_em = eventoEm;
      if (!p.ultimo_evento_em || eventoEm > p.ultimo_evento_em) p.ultimo_evento_em = eventoEm;
    },

    async adquirirLease({ holder, ttlS }) {
      hook("adquirirLease");
      const agora = relogio.agoraMs();
      if (!lease || lease.ate < agora) {
        lease = { holder, ate: agora + ttlS * 1000, geracao: (lease?.geracao ?? 0) + 1 };
        return { adquirido: true, holder, leaseAte: new Date(lease.ate).toISOString(), geracao: lease.geracao };
      }
      if (lease.holder === holder) {
        lease.ate = agora + ttlS * 1000;
        return { adquirido: true, holder, leaseAte: new Date(lease.ate).toISOString(), geracao: lease.geracao };
      }
      return { adquirido: false, holder: lease.holder, leaseAte: new Date(lease.ate).toISOString(), geracao: lease.geracao };
    },
    async liberarLease({ holder }) {
      hook("liberarLease");
      if (lease && lease.holder === holder) { lease.ate = relogio.agoraMs() - 1000; return true; }
      return false;
    },
  };
  return repo;
}

/** Fake da interface de token: nunca sabe o modo; guarda como foi chamada. */
export function criarTokenFake({ escopo = "app", token = "tok-super-secreto-nao-logar" } = {}) {
  const chamadas = [];
  return {
    chamadas,
    escopoDoToken: () => escopo,
    async comAccessTokenValido({ conexaoId, appType, fn }) {
      chamadas.push({ conexaoId, appType });
      return fn(token);
    },
  };
}

/**
 * Fake do cliente de Events. `respostasPolling` é uma fila: cada item é um array
 * (200), [] (204) ou um Error (lançado). Item função recebe ({merchantIds}) e devolve um dos anteriores.
 */
export function criarClienteFake(real, { respostasPolling = [], falhasAck = [] } = {}) {
  const polls = [];
  const acks = [];
  return {
    polls, acks, respostasPolling, falhasAck,
    dividirEmLotesDeAck: real.dividirEmLotesDeAck,
    dividirMerchantsEmLotes: real.dividirMerchantsEmLotes,
    async buscarEventos({ accessToken, merchantIds }) {
      polls.push({ accessToken, merchantIds: [...merchantIds] });
      let r = respostasPolling.length ? respostasPolling.shift() : [];
      if (typeof r === "function") r = r({ merchantIds });
      if (r instanceof Error) throw r;
      return structuredClone(r);
    },
    async confirmarEventos({ accessToken, eventIds }) {
      const f = falhasAck.length ? falhasAck.shift() : null;
      if (f) throw f;
      acks.push({ accessToken, eventIds: [...eventIds] });
      return { enviados: eventIds.length };
    },
  };
}

export const erroIfood = (codigo, detalhes) => ifoodErro(IFOOD_ERROS[codigo], detalhes ? { detalhes } : undefined);
