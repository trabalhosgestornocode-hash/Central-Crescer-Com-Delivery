// ADAPTADOR Evolution API → evento bruto do MOVA (desacoplado: o motor nunca vê o formato da Evolution).
//
// SITUAÇÃO: SIMULADO. Não existe instância Evolution configurada neste projeto (o canal real hoje é o Gateway Baileys
// próprio, `gateway-whatsapp/`). O formato abaixo segue o webhook `messages.upsert` documentado da Evolution API v2
// ({event, instance, data:{key:{remoteJid, fromMe, id, participant}, message, messageTimestamp}}) e NÃO foi conferido com
// uma instância real — a homologação exige um payload real capturado (sem dados pessoais) antes de ligar.
//
// Só lê. Não baixa mídia (o receptor faz isso pela porta `obterMidia`, DEPOIS de conferir o grupo autorizado).
import { lerMensagem } from "./mensagemWhatsapp.js";

export const EVENTOS_ACEITOS = Object.freeze(["messages.upsert", "MESSAGES_UPSERT"]);

/**
 * @param {any} payload corpo do webhook
 * @returns {{ok:true, bruto:object} | {ok:false, motivo:string}}
 */
export function normalizarEvolution(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, motivo: "payload_invalido" };
  if (!EVENTOS_ACEITOS.includes(payload.event)) return { ok: false, motivo: "evento_ignorado" };
  const d = payload.data;
  const key = d?.key;
  if (!key || typeof key.id !== "string" || !key.id) return { ok: false, motivo: "sem_id" };
  if (typeof key.remoteJid !== "string" || !key.remoteJid.endsWith("@g.us")) return { ok: false, motivo: "nao_e_grupo" };
  const instancia = typeof payload.instance === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(payload.instance) ? payload.instance : "padrao";
  const lida = lerMensagem(d.message);
  // base64 só existe quando a instância está configurada com "webhook base64"; senão a mídia é obtida pela porta do receptor.
  if (lida.midia && typeof d.message?.base64 === "string") lida.midia.base64 = d.message.base64;
  const ts = Number(d.messageTimestamp);
  return {
    ok: true,
    bruto: {
      provedor: "EVOLUTION",
      eventoId: `evo:${instancia}:${key.id}`,
      mensagemId: key.id,
      grupoId: key.remoteJid,
      participanteId: typeof key.participant === "string" && key.participant ? key.participant : null,
      fromMe: key.fromMe === true,
      ...lida,
      recebidoEm: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : null,
    },
  };
}
