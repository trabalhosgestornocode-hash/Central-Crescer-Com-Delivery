// Events do iFood — chamadas HTTP (polling e ACK).
//
// Confirmado no portal oficial (Events > Polling de eventos, 2026-09-27):
//   GET  https://merchant-api.ifood.com.br/events/v1.0/events:polling
//        200 = array de eventos · 204 = nenhum evento · 400 = merchants demais
//        403 = falta permissão em algum merchant ({ unauthorizedMerchants: [...] })
//        429 = limite (6000 RPM/token) OU throttling por ACK ausente
//        header `x-polling-merchants`: máx. 100 ids por requisição
//        (sem filtros de types/groups: consumimos TUDO e decidimos localmente —
//         a doc avisa que eventos fora do filtro recebem auto-ACK)
//   POST https://merchant-api.ifood.com.br/events/v1.0/events/acknowledgment
//        corpo: [{ "id": "..." }] · 202 Accepted · até 2000 ids por requisição (guia)
//
// Este arquivo NÃO obtém token: recebe `accessToken` já resolvido pela interface
// comum (ifoodToken.service#comAccessTokenValido). Não sabe o modo de auth.

import { IFOOD_ROTAS, IFOOD_EVENTS } from "./ifood.constants.js";
import { ifoodErro, IFOOD_ERROS } from "./ifood.errors.js";
import * as httpClient from "./ifoodHttp.client.js";

const idsUnicos = (ids) => [...new Set((ids ?? []).map((x) => String(x ?? "").trim()).filter(Boolean))];

/**
 * Um polling. Devolve SEMPRE um array (204 -> []).
 * @param {{accessToken: string, merchantIds: string[], http?: object}} p
 */
export async function buscarEventos({ accessToken, merchantIds, http = httpClient }) {
  const merchants = idsUnicos(merchantIds);
  if (merchants.length === 0) throw ifoodErro(IFOOD_ERROS.IFOOD_REQUISICAO_INVALIDA, { detalhes: { motivo: "nenhum merchant no polling" } });
  if (merchants.length > IFOOD_EVENTS.maxMerchantsPorPolling) {
    throw ifoodErro(IFOOD_ERROS.IFOOD_REQUISICAO_INVALIDA, { detalhes: { motivo: `mais de ${IFOOD_EVENTS.maxMerchantsPorPolling} merchants no polling` } });
  }

  const resp = await http.getJson(IFOOD_ROTAS.eventsPolling, {
    accessToken,
    rotulo: "events.polling",
    contexto: "events",
    headers: { "x-polling-merchants": merchants.join(",") },
  });

  if (Array.isArray(resp)) return resp;
  // 204 (sem corpo): o cliente HTTP devolve {} — é "nenhum evento".
  if (resp && typeof resp === "object" && Object.keys(resp).length === 0) return [];
  throw ifoodErro(IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA, { detalhes: { motivo: "polling: resposta não é uma lista de eventos" } });
}

/**
 * ACK de UM lote (até 2000 ids). Quem chama divide em lotes com `dividirEmLotesDeAck`.
 * @param {{accessToken: string, eventIds: string[], http?: object}} p
 */
export async function confirmarEventos({ accessToken, eventIds, http = httpClient }) {
  const ids = idsUnicos(eventIds);
  if (ids.length === 0) return { enviados: 0 };
  if (ids.length > IFOOD_EVENTS.maxIdsPorAck) {
    throw ifoodErro(IFOOD_ERROS.IFOOD_REQUISICAO_INVALIDA, { detalhes: { motivo: `mais de ${IFOOD_EVENTS.maxIdsPorAck} ids no ACK` } });
  }
  await http.postJson(IFOOD_ROTAS.eventsAck, ids.map((id) => ({ id })), {
    accessToken, rotulo: "events.ack", contexto: "events",
  });
  return { enviados: ids.length };
}

/** Ids únicos divididos em lotes de no máximo `IFOOD_EVENTS.maxIdsPorAck`. */
export function dividirEmLotesDeAck(eventIds, tamanho = IFOOD_EVENTS.maxIdsPorAck) {
  const ids = idsUnicos(eventIds);
  const lotes = [];
  for (let i = 0; i < ids.length; i += tamanho) lotes.push(ids.slice(i, i + tamanho));
  return lotes;
}

/** Divide merchants em lotes de no máximo 100 (limite do header x-polling-merchants). */
export function dividirMerchantsEmLotes(merchantIds, tamanho = IFOOD_EVENTS.maxMerchantsPorPolling) {
  const ids = idsUnicos(merchantIds);
  const lotes = [];
  for (let i = 0; i < ids.length; i += tamanho) lotes.push(ids.slice(i, i + tamanho));
  return lotes;
}
