// CONTRATO Gateway (Baileys) → backend para o MOVA: `POST /internal/comunicacao/eventos/mova-grupo` (HMAC).
// Espelho exato de gateway-whatsapp/src/movaGrupo.js (o Gateway monta; aqui só se valida). Chaves fechadas, tipos exatos,
// erro com CÓDIGO fechado (nunca ecoa o valor). Mídia vem em base64 (o Gateway baixa com a sessão que já existe).
export const CONTRATO_MOVA_VERSAO = 1;
const CHAVES = ["contratoMova", "eventoId", "mensagemId", "grupoId", "participanteId", "telefoneE164", "nomeExibicao", "fromMe", "tipo", "texto", "respostaA", "midia", "recebidoEm", "origemTipo"];
const CHAVES_MIDIA = ["mime", "nomeArquivo", "tamanhoBytes", "base64"];
const ID = /^[A-Za-z0-9_.:@-]{1,160}$/;
const JID = /^[A-Za-z0-9_.:@-]{1,160}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
export const BASE64_MAX = Math.ceil((15 * 1024 * 1024) / 3) * 4;
const ehObjeto = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * @returns {{ok:true, bruto:object} | {ok:false, motivo:string}}
 */
export function normalizarGatewayMova(c) {
  if (!ehObjeto(c)) return { ok: false, motivo: "corpo_invalido" };
  for (const k of Object.keys(c)) if (!CHAVES.includes(k)) return { ok: false, motivo: "campo_desconhecido" };
  for (const k of CHAVES) if (!(k in c)) return { ok: false, motivo: `${k}_ausente` };
  if (c.contratoMova !== CONTRATO_MOVA_VERSAO) return { ok: false, motivo: "contratoMova" };
  if (typeof c.eventoId !== "string" || !ID.test(c.eventoId) || typeof c.mensagemId !== "string" || !ID.test(c.mensagemId)) return { ok: false, motivo: "ids" };
  if (typeof c.grupoId !== "string" || !JID.test(c.grupoId)) return { ok: false, motivo: "grupoId" };
  // Conversa privada só no formato de JID de telefone (o Gateway só a envia na homologação privada, com o contato VERIFICADO);
  // se ela pode ser processada decide a configuração (lista de conversas autorizadas, modo HOMOLOGACAO).
  if (!c.grupoId.endsWith("@g.us") && !/^[1-9][0-9]{7,14}@s\.whatsapp\.net$/.test(c.grupoId)) return { ok: false, motivo: "nao_e_grupo" };
  if (c.participanteId !== null && (typeof c.participanteId !== "string" || !JID.test(c.participanteId))) return { ok: false, motivo: "participanteId" };
  if (c.telefoneE164 !== null && (typeof c.telefoneE164 !== "string" || !/^\+[1-9][0-9]{7,14}$/.test(c.telefoneE164))) return { ok: false, motivo: "telefoneE164" };
  if (c.nomeExibicao !== null && (typeof c.nomeExibicao !== "string" || c.nomeExibicao.length > 60)) return { ok: false, motivo: "nomeExibicao" };
  if (typeof c.fromMe !== "boolean") return { ok: false, motivo: "fromMe" };
  if (!["TEXTO", "IMAGEM", "DOCUMENTO", "AUDIO", "OUTRO"].includes(c.tipo)) return { ok: false, motivo: "tipo" };
  if (c.texto !== null && (typeof c.texto !== "string" || Array.from(c.texto).length > 4096)) return { ok: false, motivo: "texto" };
  if (c.respostaA !== null && (typeof c.respostaA !== "string" || !ID.test(c.respostaA))) return { ok: false, motivo: "respostaA" };
  if (typeof c.recebidoEm !== "string" || !ISO.test(c.recebidoEm)) return { ok: false, motivo: "recebidoEm" };
  if (!["LIVE", "OFFLINE_NORMAL", "OFFLINE_RECOVERY"].includes(c.origemTipo)) return { ok: false, motivo: "origemTipo" };
  let midia = null;
  if (c.midia !== null) {
    if (!ehObjeto(c.midia)) return { ok: false, motivo: "midia" };
    for (const k of Object.keys(c.midia)) if (!CHAVES_MIDIA.includes(k)) return { ok: false, motivo: "midia_campo_desconhecido" };
    const m = c.midia;
    if (typeof m.mime !== "string" || m.mime.length > 100) return { ok: false, motivo: "midia_mime" };
    if (m.nomeArquivo !== null && (typeof m.nomeArquivo !== "string" || m.nomeArquivo.length > 200)) return { ok: false, motivo: "midia_nome" };
    if (m.base64 !== null && (typeof m.base64 !== "string" || m.base64.length > BASE64_MAX || !BASE64.test(m.base64))) return { ok: false, motivo: "midia_base64" };
    midia = { mime: m.mime, nomeArquivo: m.nomeArquivo, tamanhoBytes: m.tamanhoBytes ?? null, base64: m.base64 };
  }
  if (["IMAGEM", "DOCUMENTO", "AUDIO"].includes(c.tipo) !== (midia !== null)) return { ok: false, motivo: "midia_incoerente" };
  return {
    ok: true,
    bruto: {
      provedor: "BAILEYS", eventoId: c.eventoId, mensagemId: c.mensagemId, grupoId: c.grupoId, participanteId: c.participanteId,
      telefoneE164: c.telefoneE164, nomeExibicao: c.nomeExibicao, fromMe: c.fromMe, tipo: c.tipo, texto: c.texto, respostaA: c.respostaA,
      midia, recebidoEm: c.recebidoEm, origemTipo: c.origemTipo,
    },
  };
}
