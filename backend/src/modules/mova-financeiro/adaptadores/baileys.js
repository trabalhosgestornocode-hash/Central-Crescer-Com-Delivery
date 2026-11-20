// ADAPTADOR Baileys → evento bruto do MOVA.
//
// SITUAÇÃO: PREPARADO, NÃO LIGADO. O Gateway próprio (`gateway-whatsapp/`) hoje NÃO encaminha conteúdo de grupo: o contrato
// inbound (gateway-whatsapp/src/inboundContrato.js) manda grupo como `origemJidTipo: "group"` sem texto nem mídia, e o
// backend o persiste como IGNORED (backend/src/modules/comunicacao/inbound/inbound.contrato.js). Ligar este adaptador exige
// uma rota NOVA e separada no Gateway, restrita aos grupos autorizados do MOVA — mudança de outra execução, com autorização.
// Este arquivo só define o mapeamento (item de `messages.upsert` do Baileys → evento bruto) para que essa rota não precise
// inventar formato. Nada aqui altera as mensagens automáticas atuais.
import { lerMensagem } from "./mensagemWhatsapp.js";

/**
 * @param {any} item um item de `messages.upsert` (WAMessage)
 * @returns {{ok:true, bruto:object} | {ok:false, motivo:string}}
 */
export function normalizarBaileys(item) {
  const key = item?.key;
  if (!key || typeof key.id !== "string" || !key.id) return { ok: false, motivo: "sem_id" };
  if (typeof key.remoteJid !== "string" || !key.remoteJid.endsWith("@g.us")) return { ok: false, motivo: "nao_e_grupo" };
  if (item.messageStubType != null) return { ok: false, motivo: "stub_sistema" };
  const ts = Number(item.messageTimestamp);
  return {
    ok: true,
    bruto: {
      provedor: "BAILEYS",
      eventoId: `bly:${key.id}`,
      mensagemId: key.id,
      grupoId: key.remoteJid,
      participanteId: typeof key.participant === "string" && key.participant ? key.participant : null,
      fromMe: key.fromMe === true,
      ...lerMensagem(item.message),
      recebidoEm: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : null,
    },
  };
}
