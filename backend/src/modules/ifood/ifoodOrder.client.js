// Order do iFood — chamadas HTTP (detalhes e confirm).
//
// Confirmado no portal oficial (Order > Endpoints / Detalhes / Workflow, 2026-09-27):
//   GET  https://merchant-api.ifood.com.br/order/v1.0/orders/{id}
//        200 = detalhes · 404 = id inválido, AINDA indisponível (o PLACED pode chegar antes dos
//        detalhes) ou pedido antigo (detalhes guardados só por 7 dias) · 401 = token expirado
//   POST https://merchant-api.ifood.com.br/order/v1.0/orders/{id}/confirm
//        sem corpo · Authorization Bearer · 202 {"status":"ACCEPTED"} · obrigatório em até 8 min
//        confirm repetido é ignorado (idempotente) · o RESULTADO chega como evento CONFIRMED (CFM)
//        401 = token expirado · após 8 min o pedido é cancelado pelo iFood
//
// Não obtém token (recebe `accessToken` já resolvido) e não sabe o modo de auth.
// 202 NÃO é estado oficial: quem decide o estado é o evento (ver ifoodOrder.service.js).

import { IFOOD_ROTAS } from "./ifood.constants.js";
import { ifoodErro, IFOOD_ERROS } from "./ifood.errors.js";
import * as httpClient from "./ifoodHttp.client.js";

const idValido = (orderId) => typeof orderId === "string" && orderId.trim().length > 0 && orderId.length <= 100;

/**
 * Detalhes do pedido. Devolve o corpo cru (o parser decide o que é válido).
 * @param {{accessToken: string, orderId: string, http?: object}} p
 */
export async function buscarDetalhesPedido({ accessToken, orderId, http = httpClient }) {
  if (!idValido(orderId)) throw ifoodErro(IFOOD_ERROS.IFOOD_REQUISICAO_INVALIDA, { detalhes: { motivo: "orderId inválido" } });
  return http.getJson(IFOOD_ROTAS.orderDetalhes(orderId), { accessToken, rotulo: "order.detalhes", contexto: "order" });
}

/**
 * Confirm. Devolve `{status, aceito}`: o HTTP real (202) e se o corpo trouxe ACCEPTED.
 * Quem chama NÃO pode tratar isto como "pedido confirmado".
 * @param {{accessToken: string, orderId: string, http?: object}} p
 */
export async function confirmarPedido({ accessToken, orderId, http = httpClient }) {
  if (!idValido(orderId)) throw ifoodErro(IFOOD_ERROS.IFOOD_REQUISICAO_INVALIDA, { detalhes: { motivo: "orderId inválido" } });
  const { status, corpo } = await http.postJson(IFOOD_ROTAS.orderConfirm(orderId), null, {
    accessToken, rotulo: "order.confirm", contexto: "order", semCorpo: true, comStatus: true,
  });
  return { status, aceito: status === 202 || String(corpo?.status ?? "").toUpperCase() === "ACCEPTED" };
}

// ---------------------------------------------------------------------------
// Checkpoint D — ações que MUDAM o pedido. Todas SEM retry automático (`semRetry`): timeout/5xx não prova que
// o iFood deixou de processar; quem chama aguarda o evento oficial em vez de repetir às cegas.
// ---------------------------------------------------------------------------

async function acaoSemCorpo(rota, { accessToken, orderId, rotulo, http }) {
  if (!idValido(orderId)) throw ifoodErro(IFOOD_ERROS.IFOOD_REQUISICAO_INVALIDA, { detalhes: { motivo: "orderId inválido" } });
  const { status, corpo } = await http.postJson(rota, null, {
    accessToken, rotulo, contexto: "order", semCorpo: true, comStatus: true, semRetry: true,
  });
  return { status, aceito: status === 202 || String(corpo?.status ?? "").toUpperCase() === "ACCEPTED" };
}

/** POST /orders/{id}/readyToPickup — sem corpo; 202 ACCEPTED; TAKEOUT, DINE_IN e DELIVERY. */
export const notificarPedidoPronto = ({ accessToken, orderId, http = httpClient }) =>
  acaoSemCorpo(IFOOD_ROTAS.orderReadyToPickup(orderId), { accessToken, orderId, rotulo: "order.ready", http });

/**
 * POST /orders/{id}/dispatch com corpo {"deliveredBy":"MERCHANT"} (documentação oficial atual, Order > Endpoints). Só existe para
 * DELIVERY com entrega própria: o corpo é FIXO em MERCHANT e o cliente RECUSA qualquer outro valor — nunca vai para a rede um
 * dispatch de marketplace/TAKEOUT/DINE_IN/INDOOR. Quem chama (service) só chega aqui depois da elegibilidade local.
 * `deliveredBy` é passado pelo service a partir dos detalhes do pedido (delivery_by), e aqui é conferido de novo.
 */
export const CORPO_DISPATCH = Object.freeze({ deliveredBy: "MERCHANT" });
export async function despacharPedido({ accessToken, orderId, deliveredBy = "MERCHANT", http = httpClient }) {
  if (!idValido(orderId)) throw ifoodErro(IFOOD_ERROS.IFOOD_REQUISICAO_INVALIDA, { detalhes: { motivo: "orderId inválido" } });
  if (deliveredBy !== CORPO_DISPATCH.deliveredBy) throw ifoodErro(IFOOD_ERROS.IFOOD_ACAO_NAO_ELEGIVEL, { detalhes: { motivo: "dispatch só para entrega própria (MERCHANT)", deliveredBy } });
  const { status, corpo } = await http.postJson(IFOOD_ROTAS.orderDispatch(orderId), { ...CORPO_DISPATCH }, {
    accessToken, rotulo: "order.dispatch", contexto: "order", comStatus: true, semRetry: true,
  });
  return { status, aceito: status === 202 || String(corpo?.status ?? "").toUpperCase() === "ACCEPTED" };
}

/**
 * GET /orders/{id}/cancellationReasons -> [{code, description, ...}] (lista OFICIAL, nunca fixa).
 * 204 (nenhuma política) volta como lista vazia. Leitura: pode repetir com segurança.
 */
export async function listarMotivosCancelamento({ accessToken, orderId, http = httpClient }) {
  if (!idValido(orderId)) throw ifoodErro(IFOOD_ERROS.IFOOD_REQUISICAO_INVALIDA, { detalhes: { motivo: "orderId inválido" } });
  const resp = await http.getJson(IFOOD_ROTAS.orderCancellationReasons(orderId), { accessToken, rotulo: "order.cancellationReasons", contexto: "order" });
  const lista = Array.isArray(resp) ? resp : Array.isArray(resp?.reasons) ? resp.reasons : null;
  if (!lista) {
    if (resp && typeof resp === "object" && Object.keys(resp).length === 0) return [];
    throw ifoodErro(IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA, { detalhes: { motivo: "cancellationReasons: formato inesperado" } });
  }
  // FORMA REAL (conferida ao vivo no sandbox, 2026-09-27): lista de {cancelCodeId, description}. A documentação mostra
  // {code, description} dentro de {reasons:[...]}. Aceitamos as duas e normalizamos para `code`, preservando os campos originais.
  const codigoDe = (r) => r?.cancelCodeId ?? r?.code;
  return lista
    .filter((r) => r && typeof r === "object" && codigoDe(r) !== undefined && codigoDe(r) !== null && String(codigoDe(r)).trim())
    .map((r) => ({ ...r, code: String(codigoDe(r)).trim(), description: typeof r.description === "string" ? r.description : null }));
}

/**
 * POST /orders/{id}/requestCancellation — 202; o resultado vem como evento CANCELLED ou CANCELLATION_REQUEST_FAILED.
 * CORPO REAL (descoberto no D3, HTTP 400 InvalidParameter: "Field 'cancellationCode' is required"): `{cancellationCode, reason}`.
 * A documentação mostra só `{"reason":"<code>"}`. `reason` (= código) identifica o motivo OFICIAL; `descricao` é o texto oficial
 * devolvido por cancellationReasons (vira o `reason` textual; se ausente, cai no código).
 */
export async function solicitarCancelamento({ accessToken, orderId, reason, descricao = null, http = httpClient }) {
  if (!idValido(orderId)) throw ifoodErro(IFOOD_ERROS.IFOOD_REQUISICAO_INVALIDA, { detalhes: { motivo: "orderId inválido" } });
  const codigo = String(reason ?? "").trim();
  if (!codigo) throw ifoodErro(IFOOD_ERROS.IFOOD_MOTIVO_CANCELAMENTO_INVALIDO);
  const { status, corpo } = await http.postJson(IFOOD_ROTAS.orderRequestCancellation(orderId), { cancellationCode: codigo, reason: (typeof descricao === "string" && descricao.trim()) ? descricao.trim().slice(0, 250) : codigo }, {
    accessToken, rotulo: "order.requestCancellation", contexto: "order", comStatus: true, semRetry: true,
  });
  return { status, aceito: status === 202 || String(corpo?.status ?? "").toUpperCase() === "ACCEPTED" };
}
