// Checkpoint H.4-B.4 — CONTRATO das confirmações de entrega do provider (Gateway → `POST /eventos/status-provider`) e a
// MÁQUINA MONOTÔNICA de status da mensagem. Fonte única, pura (sem I/O), espelhada pela RPC SQL
// `comunicacao_registrar_status_provider` (migration 095), que é a AUTORIDADE — esta cópia serve à rota (validação na
// fronteira), ao repo em memória (testes) e para travar a paridade por teste.
//
// SEMÂNTICA (o enum do banco NÃO foi renomeado — ver docs/comunicacao-entrega-confirmavel-h4b4.md):
//   SENT      = enviado/aceito pelo provider LOCAL (o `sendMessage()` do Baileys resolveu; o id é gerado localmente)
//   DELIVERED = confirmação de entrega do WhatsApp (receipt sem `type`)
//   READ      = confirmação de leitura (receipt `read`/`played`)
// Na UI, SENT deve aparecer como "Enviado ao WhatsApp"/"Enviado ao provedor" — NUNCA como "Entregue".
//
// SERVER_ACK (o servidor do WhatsApp aceitou o stanza) e PROVIDER_ERROR (o servidor rejeitou) NÃO viram status: ficam em
// metadados.provider_ack / provider_erro (evidência de diagnóstico).
//
// Vocabulário = o do Gateway (gateway-whatsapp/src/entregaProvider.js); test/whatsapp-status-provider-contrato.test.js trava a paridade.

export const CONTRATO_STATUS_VERSAO = 1;
/**
 * v2 — receipt VINCULADO à origem do envio (endurecimento de tenant, 25/09/2026). Além do v1 carrega `providerInstanceId` (instância emissora, conferida
 * contra a instância configurada) e `correlationId` (a `idempotencyKey` do pedido de envio, que só o Gateway que enviou guardou). Só o v2 pode alcançar uma
 * mensagem de OUTRA organização que a da conexão (ex.: envio manual do Central), e só quando id do provider + correlationId apontam para o MESMO registro.
 * v1 (Gateway antigo) segue exatamente como antes: só a org da conexão.
 */
export const CONTRATO_STATUS_VERSAO_VINCULADO = 2;
export const STATUS_PROVIDER_EVENTO = Object.freeze(["SERVER_ACK", "DELIVERED", "READ", "PROVIDER_ERROR"]);
export const RESULTADOS_STATUS_PROVIDER = Object.freeze(["NAO_ENCONTRADA", "AMBIGUA", "ESTADO_NAO_ELEGIVEL", "APLICADO", "DUPLICADO", "ACK_REGISTRADO", "ERRO_REGISTRADO"]);

/** posto de cada status na cadeia monotônica; fora dela = a mensagem NUNCA é alterada por um receipt. */
const POSTO = Object.freeze({ SENT: 1, DELIVERED: 2, READ: 3 });

const CHAVES = Object.freeze(["contratoStatus", "providerMessageId", "status", "ocorridoEm", "ackTipo", "erroCodigo", "providerInstanceId", "correlationId"]);
const CHAVES_V2 = Object.freeze(["providerInstanceId", "correlationId"]);
const ID_INSTANCIA = /^[A-Za-z0-9_.-]{1,64}$/;
const ID_CORRELACAO = /^[A-Za-z0-9_.:-]{1,200}$/;   // o Gateway trunca a idempotencyKey em 200
const OBRIGATORIAS = Object.freeze(["contratoStatus", "providerMessageId", "status"]);
const ID_PROVIDER = /^[A-Za-z0-9_.:-]{1,128}$/;
const CODIGO = /^[A-Za-z0-9_.:-]{1,40}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const FUTURO_MAX_MS = 10 * 60_000;

const ehObjeto = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * @param {unknown} corpo
 * @param {{agora?: () => number}} [o]
 * @returns {{ok: true, evento: {providerMessageId: string, status: string, ocorridoEm: string|null, ackTipo: string|null, erroCodigo: string|null, contrato?: 2, providerInstanceId?: string, correlationId?: string}} | {ok: false, erro: string}}
 *   `erro` é um CÓDIGO fechado (nunca ecoa o valor recebido)
 */
export function validarEventoStatusProvider(corpo, { agora = () => Date.now() } = {}) {
  if (!ehObjeto(corpo)) return { ok: false, erro: "corpo_invalido" };
  for (const k of Object.keys(corpo)) if (!CHAVES.includes(k)) return { ok: false, erro: "campo_desconhecido" };   // inclui organizacao_id/mensagem_id injetados
  for (const k of OBRIGATORIAS) if (!(k in corpo)) return { ok: false, erro: `${k}_ausente` };
  const c = corpo;
  if (c.contratoStatus !== CONTRATO_STATUS_VERSAO && c.contratoStatus !== CONTRATO_STATUS_VERSAO_VINCULADO) return { ok: false, erro: "contratoStatus" };
  const vinculado = c.contratoStatus === CONTRATO_STATUS_VERSAO_VINCULADO;
  if (!vinculado) for (const k of CHAVES_V2) if (k in c) return { ok: false, erro: "campo_desconhecido" };   // v1 nunca carrega os campos do v2
  if (vinculado) {
    for (const k of CHAVES_V2) if (!(k in c)) return { ok: false, erro: `${k}_ausente` };
    if (typeof c.providerInstanceId !== "string" || !ID_INSTANCIA.test(c.providerInstanceId)) return { ok: false, erro: "providerInstanceId" };
    if (typeof c.correlationId !== "string" || !ID_CORRELACAO.test(c.correlationId)) return { ok: false, erro: "correlationId" };
  }
  if (typeof c.providerMessageId !== "string" || !ID_PROVIDER.test(c.providerMessageId)) return { ok: false, erro: "providerMessageId" };
  if (!STATUS_PROVIDER_EVENTO.includes(c.status)) return { ok: false, erro: "status" };
  let ocorridoEm = null;
  if (c.ocorridoEm !== undefined && c.ocorridoEm !== null) {
    if (typeof c.ocorridoEm !== "string" || !ISO_UTC.test(c.ocorridoEm)) return { ok: false, erro: "ocorridoEm" };
    const t = Date.parse(c.ocorridoEm);
    if (!Number.isFinite(t) || t > agora() + FUTURO_MAX_MS) return { ok: false, erro: "ocorridoEm" };
    ocorridoEm = c.ocorridoEm;
  }
  let ackTipo = null;
  if (c.ackTipo !== undefined && c.ackTipo !== null) {
    if (typeof c.ackTipo !== "string" || !CODIGO.test(c.ackTipo)) return { ok: false, erro: "ackTipo" };
    ackTipo = c.ackTipo;
  }
  let erroCodigo = null;
  if (c.erroCodigo !== undefined && c.erroCodigo !== null) {
    if (typeof c.erroCodigo !== "string" || !CODIGO.test(c.erroCodigo)) return { ok: false, erro: "erroCodigo" };
    erroCodigo = c.erroCodigo;
  }
  // ---- CROSS-FIELD ----
  if (c.status === "PROVIDER_ERROR" && erroCodigo === null) return { ok: false, erro: "erroCodigo_ausente" };
  if (c.status !== "PROVIDER_ERROR" && erroCodigo !== null) return { ok: false, erro: "erroCodigo_incoerente" };
  const base = { providerMessageId: c.providerMessageId, status: c.status, ocorridoEm, ackTipo, erroCodigo };
  return { ok: true, evento: vinculado ? { ...base, contrato: CONTRATO_STATUS_VERSAO_VINCULADO, providerInstanceId: c.providerInstanceId, correlationId: c.correlationId } : base };
}

/**
 * Espelho PURO da regra monotônica da RPC (095) para DELIVERED/READ.
 * @param {string} statusAtual status da mensagem
 * @param {'DELIVERED'|'READ'} statusEvento
 * @returns {{elegivel: boolean, avanca: boolean, novo: string}}
 *   `elegivel=false`: o estado atual nunca é tocado por receipt (SENDING, DELIVERY_UNKNOWN, FAILED, CANCELLED…).
 *   `avanca=false`: evento repetido/atrasado — o status NÃO muda (READ nunca volta a DELIVERED).
 */
export function proximoStatusMensagem(statusAtual, statusEvento) {
  const atual = POSTO[statusAtual];
  const novo = POSTO[statusEvento === "DELIVERED" || statusEvento === "READ" ? statusEvento : "SENT"];
  if (atual === undefined || (statusEvento !== "DELIVERED" && statusEvento !== "READ")) return { elegivel: false, avanca: false, novo: statusAtual };
  return novo > atual ? { elegivel: true, avanca: true, novo: statusEvento } : { elegivel: true, avanca: false, novo: statusAtual };
}
