// Order do iFood — detalhes do pedido e ação `confirm` (Checkpoint C).
//
// DUAS VERDADES SEPARADAS (regra central)
//   * `status_oficial`  — só muda por EVENTO oficial (ifoodEvents.service.js). Nunca por resposta HTTP.
//   * `action_state`    — o que NÓS fizemos: none | confirm_sending | confirm_requested | confirm_failed.
//   POST /confirm com 202 => action_state = confirm_requested. status_oficial continua PLACED até
//   chegar o evento CONFIRMED (CFM); nesse momento o service de Events resolve a ação.
//
// TOKEN: só pela interface comum (`token.comAccessTokenValido`, appType = "order"). Este módulo não
// sabe se o token é distribuído ou centralizado.
//
// MULTI-TENANT: o pedido é sempre lido por organização + unidade; pedido de outra unidade é
// indistinguível de pedido inexistente (IFOOD_PEDIDO_LOCAL_NAO_ENCONTRADO).

import { IFOOD_APP_ORDER, IFOOD_ORDER } from "./ifood.constants.js";
import { ifoodErro, IFOOD_ERROS } from "./ifood.errors.js";
import { ifoodLog } from "./ifood.logsafe.js";
import { STATUS_PEDIDO } from "./ifoodEvents.parser.js";
import * as orderClient from "./ifoodOrder.client.js";
import { interpretarPedido } from "./ifoodOrder.parser.js";

const msg = (e) => String(e?.message ?? e ?? "erro").slice(0, 300);
const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const intervaloMs = (de, ate) => {
  const a = ms(de); const b = ms(ate);
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
};

const comToken = (token, conexaoId, http, fn) => token.comAccessTokenValido({ conexaoId, appType: IFOOD_APP_ORDER, deps: { http }, fn });

// =====================================================================
// DETALHES
// =====================================================================

/** PURA: este pedido deve ter os detalhes buscados agora? (backoff exponencial + janelas documentadas) */
export function detalhesDevidos(pedido, agoraMs, cfg = IFOOD_ORDER) {
  if (pedido.details_status === "OK") return false;
  const tentativas = pedido.details_tentativas ?? 0;
  if (tentativas >= cfg.maxTentativasDetalhes) return false;

  const inicio = ms(pedido.primeiro_evento_em ?? pedido.criado_em);
  const idade = Number.isFinite(inicio) ? agoraMs - inicio : 0;
  if (idade > cfg.detalhesRetencaoDias * 86_400_000) return false;                 // o iFood só guarda 7 dias
  // 404 pode ser "ainda não disponível": só insistimos dentro da janela de 10 min a partir do 1º evento.
  if (pedido.details_status === "NAO_ENCONTRADO" && idade > cfg.detalhesJanelaRetentativasMs) return false;

  if (tentativas === 0 || !pedido.details_ultima_tentativa_em) return true;
  const espera = Math.min(cfg.detalhesBackoffBaseMs * 2 ** (tentativas - 1), cfg.detalhesBackoffMaxMs);
  return agoraMs - ms(pedido.details_ultima_tentativa_em) >= espera;
}

/**
 * Busca UMA vez os detalhes e persiste (idempotente por hash). Nunca lança por erro do iFood:
 * devolve o resultado para o ciclo do worker seguir. Lança só se o REPOSITÓRIO falhar.
 *
 * @returns {Promise<{resultado: 'GRAVADO'|'SEM_MUDANCA'|'NAO_ENCONTRADO'|'INVALIDO'|'ERRO', codigo?: string, avisos?: string[]}>}
 */
export async function buscarEPersistirDetalhes({ pedido, conexaoId = null, repo, token, client = orderClient, http, agora = () => new Date(), log = ifoodLog }) {
  const agoraIso = agora().toISOString();
  const tentativas = (pedido.details_tentativas ?? 0) + 1;
  const base = { details_tentativas: tentativas, details_ultima_tentativa_em: agoraIso };
  const registrar = (campos) => repo.atualizarPedido({ pedido, campos: { ...base, ...campos } });

  let bruto;
  try {
    bruto = await comToken(token, conexaoId, http, (accessToken) => client.buscarDetalhesPedido({ accessToken, orderId: pedido.order_id, http }));
  } catch (e) {
    const naoEncontrado = e?.codigo === IFOOD_ERROS.IFOOD_PEDIDO_NAO_ENCONTRADO;
    const codigo = e?.codigo ?? "ERRO_DESCONHECIDO";
    await registrar({ details_status: naoEncontrado ? "NAO_ENCONTRADO" : "ERRO", details_ultimo_erro: codigo });
    log(naoEncontrado ? "info" : "warn", "order.detalhes_falhou", { orderId: pedido.order_id, codigo, tentativa: tentativas });
    return { resultado: naoEncontrado ? "NAO_ENCONTRADO" : "ERRO", codigo };
  }

  const r = interpretarPedido(bruto, { orderIdEsperado: pedido.order_id, merchantIdEsperado: pedido.merchant_id });
  if (!r.valido) {
    await registrar({ details_status: "ERRO", details_ultimo_erro: `PAYLOAD_INVALIDO: ${r.motivo}`.slice(0, 200) });
    log("warn", "order.detalhes_invalidos", { orderId: pedido.order_id, motivo: r.motivo });
    return { resultado: "INVALIDO", codigo: "PAYLOAD_INVALIDO" };
  }

  // Idempotência: mesmo payload já gravado = nada a regravar.
  if (pedido.details_status === "OK" && pedido.details_payload_hash === r.payloadHash) {
    return { resultado: "SEM_MUDANCA", avisos: r.avisos };
  }

  const { merchant_id_payload: _descartado, order_id: _orderId, ...operacionais } = r.pedido;
  await registrar({
    ...operacionais,
    details_payload: r.payload, details_payload_hash: r.payloadHash, details_avisos: r.avisos,
    details_status: "OK", details_ultimo_erro: null,
    details_fetched_at: pedido.details_fetched_at ?? agoraIso,       // 1ª vez com sucesso (SLA)
    details_atualizado_em: agoraIso,
  });
  log("info", "order.detalhes_gravados", {
    orderId: pedido.order_id, itens: r.pedido.items_count, avisos: r.avisos.length, tentativa: tentativas,
  });
  return { resultado: "GRAVADO", avisos: r.avisos };
}

/**
 * Passo do ciclo do worker: busca os detalhes dos pedidos que estão devidos. Limitado por ciclo;
 * para no primeiro 429 (o iFood pede calma).
 *
 * @param {{conexoesPorMerchant: Map<string, {id: string}>}} p
 */
export async function processarDetalhesPendentes({
  repo, token, client = orderClient, http, conexoesPorMerchant, agora = () => new Date(), log = ifoodLog, cfg = IFOOD_ORDER,
}) {
  const agoraMs = agora().getTime();
  const candidatos = await repo.listarPedidosComDetalhesPendentes({
    limite: cfg.detalhesPorCiclo * 3, maxTentativas: cfg.maxTentativasDetalhes,
    apartirDeIso: new Date(agoraMs - cfg.detalhesRetencaoDias * 86_400_000).toISOString(),
  });
  const devidos = candidatos.filter((p) => detalhesDevidos(p, agoraMs, cfg)).slice(0, cfg.detalhesPorCiclo);

  const out = { tentados: 0, gravados: 0, semMudanca: 0, naoEncontrados: 0, erros: 0, semConexao: 0, rateLimited: false };
  for (const pedido of devidos) {
    const con = conexoesPorMerchant.get(pedido.merchant_id);
    // A conexão precisa continuar viva E ser da mesma unidade do pedido (tenant nunca vem do payload).
    if (!con || con.organizacao_id !== pedido.organizacao_id || con.unidade_id !== pedido.unidade_id) { out.semConexao += 1; continue; }
    out.tentados += 1;
    const r = await buscarEPersistirDetalhes({ pedido, conexaoId: con.id, repo, token, client, http, agora, log });
    if (r.resultado === "GRAVADO") out.gravados += 1;
    else if (r.resultado === "SEM_MUDANCA") out.semMudanca += 1;
    else if (r.resultado === "NAO_ENCONTRADO") out.naoEncontrados += 1;
    else out.erros += 1;
    if (r.codigo === IFOOD_ERROS.IFOOD_RATE_LIMITED) { out.rateLimited = true; break; }
  }
  return out;
}

// =====================================================================
// CONFIRM
// =====================================================================

const SENDING_REASSUMIVEL_MS = 30_000;   // confirm_sending mais velho que isto: quem enviou provavelmente caiu; o iFood ignora confirm repetido

/**
 * Resultado de `confirmarPedido`:
 *   SOLICITADO            — POST aceito (202); aguardando o evento CONFIRMED (estado oficial NÃO mudou)
 *   JA_SOLICITADO         — já havia pedido de confirm aceito; NENHUM novo POST
 *   JA_CONFIRMADO_OFICIAL — o evento CONFIRMED já chegou; nada a fazer
 *   EM_ENVIO              — outra chamada está enviando agora; nenhum POST
 */
export async function confirmarPedido({
  organizacaoId, unidadeId, orderId, repo, token, client = orderClient, http, agora = () => new Date(), log = ifoodLog,
}) {
  let pedido = await repo.obterPedidoDoTenant({ organizacaoId, unidadeId, orderId });
  if (!pedido) throw ifoodErro(IFOOD_ERROS.IFOOD_PEDIDO_LOCAL_NAO_ENCONTRADO);

  const auditar = (p, resultado, extra = {}) => Promise.resolve(repo.registrarAcao({ pedido: p, acao: "confirm", resultado, ...extra }))
    .catch((e) => log("warn", "order.auditoria_falhou", { orderId, erro: msg(e) }));

  // Reavalia no máximo 2 vezes (corrida com o evento CONFIRMED / outra chamada).
  for (let tentativa = 1; tentativa <= 2; tentativa += 1) {
    if (pedido.status_oficial === STATUS_PEDIDO.CONFIRMED) return { resultado: "JA_CONFIRMADO_OFICIAL", statusOficial: pedido.status_oficial, actionState: pedido.action_state, oficial: true };
    if (pedido.status_oficial !== STATUS_PEDIDO.PLACED) {
      throw ifoodErro(IFOOD_ERROS.IFOOD_PEDIDO_ESTADO_INVALIDO, { detalhes: { statusOficial: pedido.status_oficial ?? null } });
    }
    const estado = pedido.action_state ?? "none";
    // O confirm não sobrescreve outra ação pendente (ex.: cancelamento pedido antes do CFM): só parte de none / confirm_* / *_failed.
    if (!/^(none|confirm_(sending|requested|failed)|(ready|dispatch|cancel)_failed)$/.test(estado)) {
      throw ifoodErro(IFOOD_ERROS.IFOOD_PEDIDO_ESTADO_INVALIDO, { detalhes: { motivo: estado.startsWith("cancel_") ? "cancelamento_em_andamento" : "acao_pendente", actionState: estado } });
    }
    if (estado === "confirm_requested") {
      await auditar(pedido, "JA_SOLICITADA");
      return { resultado: "JA_SOLICITADO", statusOficial: pedido.status_oficial, actionState: estado, oficial: false };
    }
    if (estado === "confirm_sending") {
      const desde = ms(pedido.confirm_requested_at);
      const velho = Number.isFinite(desde) && agora().getTime() - desde > SENDING_REASSUMIVEL_MS;
      if (!velho) return { resultado: "EM_ENVIO", statusOficial: pedido.status_oficial, actionState: estado, oficial: false };
    }

    const agoraIso = agora().toISOString();
    const reservou = await repo.atualizarPedido({
      pedido,
      campos: {
        action_state: "confirm_sending", confirm_attempts: (pedido.confirm_attempts ?? 0) + 1, confirm_requested_at: pedido.confirm_requested_at ?? agoraIso,
        ...(pedido.action_uncertain !== undefined ? { action_uncertain: false } : {}),      // coluna da 103 (compatível com um banco só com a 102)
      },
      condicoes: { action_state: estado, status_oficial: STATUS_PEDIDO.PLACED },
    });
    if (!reservou) {
      pedido = await repo.obterPedidoDoTenant({ organizacaoId, unidadeId, orderId });
      if (!pedido) throw ifoodErro(IFOOD_ERROS.IFOOD_PEDIDO_LOCAL_NAO_ENCONTRADO);
      continue;
    }

    // ---- envia ----
    const conexao = await repo.obterConexaoAtivaDoMerchant({ organizacaoId, unidadeId, merchantId: pedido.merchant_id });
    let envio;
    try {
      if (!conexao) throw ifoodErro(IFOOD_ERROS.IFOOD_CONEXAO_NAO_ENCONTRADA);
      envio = await comToken(token, conexao.id, http, (accessToken) => client.confirmarPedido({ accessToken, orderId, http }));
    } catch (e) {
      const httpStatus = e?.details?.status ?? null;
      await repo.atualizarPedido({
        pedido,
        campos: { action_state: "confirm_failed", confirm_last_error: String(e?.codigo ?? "ERRO").slice(0, 100), confirm_http_status: httpStatus },
        condicoes: { action_state: "confirm_sending" },
      });
      await auditar(pedido, e?.codigo === IFOOD_ERROS.IFOOD_ACAO_PEDIDO_RECUSADA ? "RECUSADA" : "FALHOU", { httpStatus, erroCodigo: e?.codigo ?? null });
      log("warn", "order.confirm_falhou", { orderId, codigo: e?.codigo ?? null });
      throw e;
    }

    if (!envio.aceito) {
      await repo.atualizarPedido({
        pedido, campos: { action_state: "confirm_failed", confirm_last_error: "RESPOSTA_NAO_ACEITA", confirm_http_status: envio.status ?? null },
        condicoes: { action_state: "confirm_sending" },
      });
      await auditar(pedido, "FALHOU", { httpStatus: envio.status ?? null, erroCodigo: "RESPOSTA_NAO_ACEITA" });
      throw ifoodErro(IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA, { detalhes: { status: envio.status } });
    }

    // 202: o iFood ACEITOU o pedido de confirmação. NÃO é o estado oficial.
    // CAS: se o evento CONFIRMED chegou antes desta gravação, ele já resolveu a ação (none) e não sobrescrevemos.
    const gravou = await repo.atualizarPedido({
      pedido, campos: { action_state: "confirm_requested", confirm_http_status: envio.status, confirm_last_error: null },
      condicoes: { action_state: "confirm_sending" },
    });
    await auditar(pedido, "ACEITA_202", { httpStatus: envio.status });
    const atual = await repo.obterPedidoDoTenant({ organizacaoId, unidadeId, orderId });
    log("info", "order.confirm_solicitado", {
      orderId, httpStatus: envio.status, actionState: atual?.action_state ?? null, statusOficial: atual?.status_oficial ?? null, eventoJaChegou: !gravou,
    });
    return {
      resultado: "SOLICITADO", httpStatus: envio.status,
      statusOficial: atual?.status_oficial ?? pedido.status_oficial, actionState: atual?.action_state ?? "confirm_requested",
      oficial: atual?.status_oficial === STATUS_PEDIDO.CONFIRMED,
    };
  }
  throw ifoodErro(IFOOD_ERROS.IFOOD_PEDIDO_ESTADO_INVALIDO, { detalhes: { motivo: "corrida persistente" } });
}

// =====================================================================
// SLA
// =====================================================================

/**
 * PURA: medição de SLA da confirmação (limite documentado: 8 min desde a criação do pedido).
 * Os intervalos vêm dos cinco carimbos: order_created_at, placed_event_received_at,
 * details_fetched_at, confirm_requested_at, confirmed_event_at.
 */
export function calcularSla(pedido, agoraMs = Date.now(), limiteMs = IFOOD_ORDER.slaConfirmacaoMs) {
  const inicio = pedido.order_created_at ?? pedido.placed_event_created_at ?? null;
  const confirmouEm = pedido.confirmed_event_at ?? null;
  const fim = confirmouEm ? ms(confirmouEm) : agoraMs;
  const decorrido = Number.isFinite(ms(inicio)) ? fim - ms(inicio) : null;

  let situacao;
  if (confirmouEm) situacao = decorrido !== null && decorrido > limiteMs ? "CONFIRMADO_FORA_DO_SLA" : "CONFIRMADO_NO_SLA";
  else if (pedido.status_oficial && pedido.status_oficial !== STATUS_PEDIDO.PLACED) situacao = "ENCERRADO_SEM_CONFIRMACAO";
  else if (decorrido !== null && decorrido > limiteMs) situacao = "SLA_ESTOURADO";
  else if (pedido.action_state === "confirm_requested") situacao = "AGUARDANDO_EVENTO_CONFIRMED";
  else situacao = "AGUARDANDO_CONFIRM";

  return {
    situacao, limiteMs,
    order_created_at: pedido.order_created_at ?? null,
    placed_event_received_at: pedido.placed_event_received_at ?? null,
    details_fetched_at: pedido.details_fetched_at ?? null,
    confirm_requested_at: pedido.confirm_requested_at ?? null,
    confirmed_event_at: confirmouEm,
    ms: {
      criacao_ate_evento_recebido: intervaloMs(pedido.order_created_at, pedido.placed_event_received_at),
      evento_recebido_ate_detalhes: intervaloMs(pedido.placed_event_received_at, pedido.details_fetched_at),
      criacao_ate_confirm_solicitado: intervaloMs(inicio, pedido.confirm_requested_at),
      confirm_solicitado_ate_evento_confirmed: intervaloMs(pedido.confirm_requested_at, confirmouEm),
      criacao_ate_confirmed: confirmouEm ? decorrido : null,
      restante_para_o_limite: confirmouEm || decorrido === null ? null : limiteMs - decorrido,
    },
  };
}
