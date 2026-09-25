// CENTRAL DE COMUNICAÇÃO — linguagem visual de STATUS. Uma só fonte para "Conectado, Confirmado, Pendente, Atenção, Falha, Programado, Enviado, Pausado…".
// REGRA DE ACESSIBILIDADE: o significado nunca depende só da cor. Todo status tem (1) desenho próprio, (2) texto, (3) forma de selo/badge e (4) tom com contraste AA.
// Módulo PURO (dados → HTML), sem estado nem DOM.

import { escapeHtml as e } from "../utils.js";
import { icon } from "../icons.js";

/** id → { icone, tom, texto }. `tom`: ok | atencao | critico | info | neutro (mapeados em central.css como --cc-st-*). */
export const STATUS = Object.freeze({
  conectado: { icone: "wifi", tom: "ok", texto: "Conectado" },
  desconectado: { icone: "wifi-off", tom: "neutro", texto: "Desconectado" },
  conectando: { icone: "refresh", tom: "atencao", texto: "Conectando" },
  qr: { icone: "qr-code", tom: "atencao", texto: "Aguardando QR Code" },
  reconectando: { icone: "refresh", tom: "atencao", texto: "Reconectando" },
  invalida: { icone: "alert-octagon", tom: "critico", texto: "Sessão inválida" },
  confirmado: { icone: "shield-check", tom: "ok", texto: "Confirmado" },
  pendente: { icone: "hourglass", tom: "atencao", texto: "Pendente" },
  atencao: { icone: "alert-triangle", tom: "atencao", texto: "Atenção" },
  falha: { icone: "alert-octagon", tom: "critico", texto: "Falha" },
  programado: { icone: "calendar", tom: "info", texto: "Programado" },
  enviado: { icone: "send", tom: "ok", texto: "Enviado" },
  pausado: { icone: "pause", tom: "neutro", texto: "Pausado" },
  ativo: { icone: "check-circle", tom: "ok", texto: "Ativo" },
  sem_pendencia: { icone: "minus-circle", tom: "neutro", texto: "Sem pendência" },
});

/** Estado do Gateway (UI) → status visual. */
export const STATUS_DO_ESTADO_CONEXAO = Object.freeze({
  CONNECTED: "conectado", DISCONNECTED: "desconectado", CONNECTING: "conectando", WAITING_QR: "qr", RECONNECTING: "reconectando", AUTH_ERROR: "invalida",
});

/** Status da mensagem (outbox) → { status, texto }. SENT NUNCA vira "Entregue". */
export function statusDaMensagem(s) {
  switch (s) {
    case "SCHEDULED": case "PROCESSING": return { status: "programado", texto: "Programada" };
    case "SENDING": return { status: "programado", texto: "Enviando" };
    case "SENT": return { status: "enviado", texto: "Enviada" };
    case "DELIVERED": return { status: "enviado", texto: "Entregue" };
    case "READ": return { status: "enviado", texto: "Lida" };
    case "FAILED": case "BLOCKED": return { status: "falha", texto: s === "BLOCKED" ? "Bloqueada" : "Falhou" };
    case "DELIVERY_UNKNOWN": return { status: "atencao", texto: "Entrega incerta" };
    case "CANCELLED": return { status: "pausado", texto: "Cancelada" };
    default: return { status: "atencao", texto: "Situação desconhecida" };
  }
}

/** Badge: ícone + texto + forma. `texto` substitui o padrão; `tam`: "p" | "m". */
export function badge(id, { texto, tam = "m", classe = "" } = {}) {
  const s = STATUS[id] ?? STATUS.atencao;
  return `<span class="cc-st cc-st--${s.tom} cc-st--${tam}${classe ? ` ${classe}` : ""}" data-status="${e(STATUS[id] ? id : "atencao")}">${icon(s.icone, { size: tam === "p" ? 12 : 14 })}<span>${e(texto ?? s.texto)}</span></span>`;
}

/**
 * Selo de identidade: o avatar da conta dentro de um anel que muda de forma conforme a situação, com um selo circular no canto.
 *  confirmada ⇒ anel contínuo verde + escudo com check · pendente ⇒ anel tracejado âmbar que gira devagar + ampulheta ·
 *  sem_conta ⇒ anel tracejado cinza + wifi cortado · erro ⇒ anel vermelho + alerta.
 * @param {{situacao: 'confirmada'|'pendente'|'sem_conta'|'erro', conteudo: string, tam?: 'm'|'g'|'x'}} p
 */
export function seloIdentidade({ situacao = "sem_conta", conteudo = "", tam = "g" } = {}) {
  const ic = { confirmada: "shield-check", pendente: "hourglass", sem_conta: "wifi-off", erro: "alert-octagon" }[situacao] ?? "wifi-off";
  const rotulo = { confirmada: "Conta confirmada", pendente: "Conta ainda não confirmada", sem_conta: "Nenhuma conta conectada", erro: "Sessão inválida" }[situacao] ?? "";
  return `<div class="cc-selo cc-selo--${e(situacao)} cc-selo--${e(tam)}" role="img" aria-label="${e(rotulo)}"><i class="cc-selo-anel" aria-hidden="true"></i><div class="cc-selo-miolo">${conteudo}</div><span class="cc-selo-marca" aria-hidden="true">${icon(ic, { size: tam === "x" ? 20 : 15 })}</span></div>`;
}

/** Situação do selo a partir do estado da sessão + status da identidade. */
export function situacaoDoSelo(estado, identidadeStatus) {
  if (estado === "AUTH_ERROR") return "erro";
  if (estado !== "CONNECTED") return "sem_conta";
  return identidadeStatus === "CONFIRMADA" ? "confirmada" : "pendente";
}
