// Adaptador API Foody → registro saneado (foody_pedidos) → pedido no formato do Parser.
//
// O registro saneado é uma LISTA BRANCA: só entram os campos abaixo. Cliente, telefone, endereço, observações, link de
// rastreio, coordenadas e o nome do entregador NUNCA entram (o nome vira HMAC). Qualquer campo novo da API é ignorado.
//
// A operação é decidida pela MESMA função do Parser (classificarOperacao, sobre "Detalhes do pedido"), e o pedido adaptado
// tem exatamente os nomes de campo que o Parser usa — por isso o cálculo reaproveita o Parser sem duplicar regra.
//
// ISOLAMENTO ENTRE ORGANIZAÇÕES: a mesma conta Foody despacha pedidos de outra organização (ex.: Açaí no Grau, despachado pela
// conta da Subway Saci). Esses pedidos ficam no tenant da unidade dona da conta só no MÍNIMO LOGÍSTICO que a unidade tem direito
// a ver — o próprio entregador, a taxa paga a ele, as datas da entrega e a situação. Os dados COMERCIAIS da outra organização
// (produtos, valor do pedido, taxa cobrada do cliente, forma de pagamento, motivo/justificativa em texto livre) NUNCA são
// gravados. O banco reforça com o CHECK ck_foody_pedidos_outra_operacao_minima (migration 144).
// Pedido em dúvida (revisao_necessaria) mantém os detalhes, porque pode ser da própria unidade e precisa de revisão humana.
import { createHash } from "node:crypto";
import { classificarOperacao, OPERACAO } from "../parser-food-delivery/parserFoodDelivery.operacao.js";
import {
  STATUS_FOODY_PARA_SITUACAO, FORMA_PAGAMENTO, RAZAO_CANCELAMENTO, ENTREGADOR_TIPO, COURIER_TYPE_PROPRIO,
} from "./foody.constants.js";
import { paraParede } from "./foody.periodo.js";

const texto = (v, max) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const numero = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

/** courierType → catálogo fechado. Sem entregador (sem nome) = sem_entregador, independentemente do tipo. */
export function classificarTipoEntregador(courier) {
  const nome = courier && typeof courier.courierName === "string" ? courier.courierName.trim() : "";
  if (!nome) return ENTREGADOR_TIPO.SEM_ENTREGADOR;
  const tipo = String(courier.courierType ?? "").trim().toLowerCase();
  return COURIER_TYPE_PROPRIO.has(tipo) ? ENTREGADOR_TIPO.PROPRIO : ENTREGADOR_TIPO.NAO_CLASSIFICADO;
}

/** JSON estável (chaves ordenadas) para o hash de conteúdo. */
export function jsonEstavel(valor) {
  if (valor === null || typeof valor !== "object") return JSON.stringify(valor ?? null);
  if (Array.isArray(valor)) return `[${valor.map(jsonEstavel).join(",")}]`;
  return `{${Object.keys(valor).sort().map((k) => `${JSON.stringify(k)}:${jsonEstavel(valor[k])}`).join(",")}}`;
}
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Campos que entram no hash de conteúdo do pedido (não entram execução, timestamps de gravação nem tenant). */
const CAMPOS_CONTEUDO = [
  "numero_pedido", "data_hora", "status_foody", "situacao", "taxa_entregador", "taxa_entrega", "valor_total", "forma_pagamento",
  "modo_despacho", "detalhes_pedido", "operacao", "entregador_presente", "entregador_hash", "entregador_tipo",
  "entregador_tipo_bruto", "ponto_coleta", "data_aceito", "data_pronto", "data_despachado", "data_coletado", "data_entregue",
  "data_finalizado", "data_cancelado", "prazo_entrega", "cancelamento_razao", "cancelamento_justificativa",
];

/** Operação identificada que NÃO é a da unidade dona da conta (hoje: Açaí no Grau). Dúvida não conta como outra operação. */
export const ehOutraOperacao = (operacao) => operacao !== OPERACAO.SUBWAY && operacao !== OPERACAO.REVISAO_NECESSARIA;

/** Dados comerciais da outra organização que NUNCA são gravados no tenant da unidade dona da conta. */
export const CAMPOS_COMERCIAIS_OUTRA_OPERACAO = Object.freeze([
  "detalhes_pedido", "valor_total", "taxa_entrega", "forma_pagamento", "cancelamento_razao", "cancelamento_justificativa",
]);

function minimizarOutraOperacao(registro) {
  for (const k of CAMPOS_COMERCIAIS_OUTRA_OPERACAO) registro[k] = null;
  // O motivo do classificador cita os produtos encontrados (dado comercial da outra organização): fica só o rótulo.
  registro.operacao_motivo = "Pedido de outra operação despachado por esta conta: só o mínimo logístico é guardado.";
}

/**
 * Pedido cru da API → registro saneado. Devolve { registro } ou { erro } (pedido malformado vira pendência, nunca exceção).
 * @param {object} o pedido como veio da API
 * @param {{ hashEntregador: (nome:string)=>string|null }} deps
 */
export function sanearPedidoApi(o, { hashEntregador }) {
  if (!o || typeof o !== "object") return { erro: "PEDIDO_INVALIDO" };
  const uid = texto(o.uid, 80);
  const numeroPedido = texto(o.id, 40);
  const dataHora = paraParede(o.date);
  if (!uid) return { erro: "SEM_UID" };
  if (!numeroPedido) return { erro: "SEM_NUMERO", uid };
  if (!dataHora) return { erro: "SEM_DATA", uid };
  const statusFoody = texto(o.status, 40) ?? "desconhecido";
  const nome = o.courier && typeof o.courier.courierName === "string" ? o.courier.courierName.trim() : "";
  const tipo = classificarTipoEntregador(o.courier);
  const detalhes = texto(o.orderDetails, 4000);
  const op = classificarOperacao({ detalhesPedido: detalhes });

  const registro = {
    foody_uid: uid,
    numero_pedido: numeroPedido,
    competencia: dataHora.slice(0, 10),
    data_hora: dataHora,
    status_foody: statusFoody,
    situacao: STATUS_FOODY_PARA_SITUACAO[statusFoody] ?? statusFoody,
    taxa_entregador: numero(o.courierFee),
    taxa_entrega: numero(o.deliveryFee),
    valor_total: numero(o.orderTotal),
    forma_pagamento: o.paymentMethod == null ? null : (FORMA_PAGAMENTO[o.paymentMethod] ?? texto(o.paymentMethod, 40)),
    modo_despacho: texto(o.despatchMode, 40),
    detalhes_pedido: detalhes,
    operacao: op.operacao,
    operacao_motivo: texto(op.motivo, 500),
    entregador_presente: tipo !== ENTREGADOR_TIPO.SEM_ENTREGADOR,
    entregador_hash: tipo === ENTREGADOR_TIPO.SEM_ENTREGADOR ? null : hashEntregador(nome),
    entregador_tipo: tipo,
    entregador_tipo_bruto: o.courier ? texto(o.courier.courierType, 40) : null,
    ponto_coleta: texto(o.collectionPoint?.name, 120),
    // Campos não documentados mas presentes no JSON real (validação de 03/11/2026).
    data_aceito: paraParede(o.acceptanceDate),
    data_pronto: paraParede(o.readyDate),
    data_despachado: paraParede(o.despatchDate),
    data_coletado: paraParede(o.collectedDate),
    data_entregue: paraParede(o.deliveryDate),
    data_finalizado: paraParede(o.closedDate),
    data_cancelado: paraParede(o.cancelledDate),
    prazo_entrega: paraParede(o.deliveryDueDate),
    cancelamento_razao: o.cancellationReason == null ? null : (RAZAO_CANCELAMENTO[o.cancellationReason] ?? texto(o.cancellationReason, 80)),
    cancelamento_justificativa: texto(o.cancellationText, 300),
  };
  if (registro.entregador_presente && !registro.entregador_hash) return { erro: "HASH_ENTREGADOR_FALHOU", uid };
  if (ehOutraOperacao(registro.operacao)) minimizarOutraOperacao(registro);
  registro.fonte_hash = sha256(jsonEstavel(Object.fromEntries(CAMPOS_CONTEUDO.map((k) => [k, registro[k]]))));
  return { registro };
}

/**
 * Registro saneado → pedido no formato do Parser (mesmos nomes de campo do parserFoodDelivery.parser.js).
 * `entregador` recebe o HASH: as funções do Parser só precisam de uma chave estável por entregador, nunca do nome.
 * Chegada para entrega e distância não existem na API: ficam null (o motor de cancelamentos já trata a ausência).
 */
export function paraPedidoParser(r) {
  return {
    numeroPedido: r.numero_pedido,
    dataHora: r.data_hora,
    situacao: r.situacao,
    entregador: r.entregador_hash ?? null,
    taxaEntregador: r.taxa_entregador == null ? null : Number(r.taxa_entregador),
    valorTotalPedido: r.valor_total == null ? null : Number(r.valor_total),
    detalhesPedido: r.detalhes_pedido,
    formaPagamento: r.forma_pagamento,
    dataAceito: r.data_aceito, dataPronto: r.data_pronto, dataDespachado: r.data_despachado, dataColetado: r.data_coletado,
    dataEntregue: r.data_entregue, dataFinalizado: r.data_finalizado, dataCancelado: r.data_cancelado,
    prazoEntrega: r.prazo_entrega, dataChegadaEntrega: null,
    razaoCancelamento: r.cancelamento_razao, justificativaCancelamento: r.cancelamento_justificativa,
    distanciaRaioKm: null, distanciaRotaKm: null,
    // Campos próprios da camada central (o Parser ignora):
    operacao: r.operacao, entregadorTipo: r.entregador_tipo, foodyUid: r.foody_uid,
  };
}
