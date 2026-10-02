// Allowlist do REENVIO SOB RETRY (homologação) — quais destinatários podem ter a mensagem guardada pelo Gateway para
// reenvio quando o aparelho deles pede retry ("Aguardando mensagem…"; ver docs/whatsapp-retry-resend.md).
//
// QUEM DECIDE: o BACKEND. Para cada envio, whatsapp.service.js pergunta `permite(contatoId)` e manda ao Gateway só um
// booleano `retryResend: true` (no corpo assinado por HMAC). O Gateway não conhece contato_id nem regra de negócio: ele só
// guarda no cache de retry o que veio marcado — e só se a flag dele (WHATSAPP_RETRY_RESEND_ENABLED) estiver ligada.
//
// IDENTIFICADOR: `contato_id` interno (UUID de comunicacao_contatos) — presente nos três pontos de envio (alertas, manual
// da Central, teste). Nunca telefone, JID ou nome. Um UUID é globalmente único: autorizar um contato não autoriza nenhum
// outro, de nenhuma outra organização.
//
// FAIL CLOSED:
//   WHATSAPP_RETRY_RESEND_CONTATOS ausente/vazia           ⇒ ninguém
//   lista com QUALQUER item que não seja UUID              ⇒ ninguém (lista inteira descartada; nunca "aproveitar o resto")
//   contatoId ausente ou que não é UUID                    ⇒ não
//   contatoId UUID fora da lista                           ⇒ não
// Lida uma vez (na criação do serviço / boot): restart relê a mesma env ⇒ mesma política. Nada aqui loga ids.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ENV_RETRY_RESEND_CONTATOS = "WHATSAPP_RETRY_RESEND_CONTATOS";

const normalizar = (v) => String(v ?? "").trim().toLowerCase();

/**
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @returns {{permite: (contatoId: unknown) => boolean, estado: 'vazia'|'invalida'|'ativa', total: number}}
 *   `estado`/`total` são para log de boot (só contagem — nunca os ids).
 */
export function lerAllowlistRetryResend(env = process.env) {
  const bruto = String(env?.[ENV_RETRY_RESEND_CONTATOS] ?? "").trim();
  if (bruto === "") return { permite: () => false, estado: "vazia", total: 0 };
  const itens = bruto.split(",").map(normalizar);
  if (itens.some((id) => !UUID.test(id))) return { permite: () => false, estado: "invalida", total: 0 };
  const ids = new Set(itens);
  return {
    permite: (contatoId) => typeof contatoId === "string" && ids.has(normalizar(contatoId)) && UUID.test(normalizar(contatoId)),
    estado: "ativa",
    total: ids.size,
  };
}
