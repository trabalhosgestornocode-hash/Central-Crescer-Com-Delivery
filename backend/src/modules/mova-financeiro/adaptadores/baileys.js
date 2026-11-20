// ADAPTADOR item cru do Baileys (`messages.upsert`, WAMessage) → evento bruto do MOVA.
//
// Uso: FIXTURES e simulação (eventos representativos do formato real). Em produção futura o Gateway próprio já entrega o
// payload montado por gateway-whatsapp/src/movaGrupo.js (adaptadores/gatewayBaileys.js valida). As duas formas produzem o
// MESMO evento bruto — o eventoId é `bly:<id da mensagem>` nos dois, então reconexão/reentrega deduplicam igual.
// Mídia aqui chega sem bytes: o receptor usa a porta `obterMidia`.
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
  const nome = typeof item.pushName === "string" && item.pushName.trim() ? item.pushName.trim().slice(0, 60) : null;
  return {
    ok: true,
    bruto: {
      provedor: "BAILEYS",
      eventoId: `bly:${key.id}`,
      mensagemId: key.id,
      grupoId: key.remoteJid,
      participanteId: typeof key.participant === "string" && key.participant ? key.participant : null,
      telefoneE164: null,
      nomeExibicao: nome,
      fromMe: key.fromMe === true,
      ...lerMensagem(item.message),
      recebidoEm: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : null,
    },
  };
}
