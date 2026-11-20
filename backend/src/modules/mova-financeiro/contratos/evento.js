// CONTRATO do evento de grupo do MOVA — formato NEUTRO de provedor (Evolution API, Baileys ou simulado).
//
// Todo adaptador de provedor (adaptadores/*.js) converte o payload bruto NISTO; nada além deste formato chega ao motor.
// Regras:
//   - chaves fechadas e tipos exatos (campo desconhecido = recusa, inclusive `unidadeId`/`organizacaoId` injetados:
//     a unidade NUNCA vem do provedor nem da mensagem — é resolvida pelo motor a partir da configuração);
//   - `eventoId` é a chave de idempotência do EVENTO (reenvio de webhook = mesmo eventoId);
//   - mídia nunca viaja em claro aqui: só metadados + `sha256` + `referencia` opaca do armazenamento de evidências;
//   - texto e legenda são ENTRADA NÃO CONFIÁVEL (podem conter instruções maliciosas): o motor só os lê como dado.
// Nada aqui loga, persiste ou faz I/O. Erros devolvem um CÓDIGO fechado, nunca o valor recebido.

export const CONTRATO_EVENTO_VERSAO = 1;
export const PROVEDORES = Object.freeze(["EVOLUTION", "BAILEYS", "SIMULADO"]);
export const TIPOS_MENSAGEM = Object.freeze(["TEXTO", "IMAGEM", "DOCUMENTO", "AUDIO", "OUTRO"]);
export const MIMES_ACEITOS = Object.freeze(["image/jpeg", "image/png", "image/webp", "application/pdf", "audio/ogg", "audio/mpeg", "audio/mp4"]);
export const TEXTO_MAX = 4096;
export const MIDIA_MAX_BYTES = 15 * 1024 * 1024;

const CHAVES = Object.freeze(["contrato", "provedor", "eventoId", "mensagemId", "grupoId", "participanteId", "fromMe", "tipo", "texto", "respostaA", "midia", "recebidoEm"]);
const CHAVES_MIDIA = Object.freeze(["mime", "tamanhoBytes", "sha256", "nomeArquivo", "referencia"]);
const ID = /^[A-Za-z0-9_.:@-]{1,160}$/;
const GRUPO = /^[0-9]{5,40}(-[0-9]{1,20})?@g\.us$/;
const SHA = /^[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ehObjeto = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * @param {unknown} e
 * @returns {{ok:true, evento:object} | {ok:false, erro:string}}
 */
export function validarEvento(e) {
  if (!ehObjeto(e)) return { ok: false, erro: "corpo_invalido" };
  for (const k of Object.keys(e)) if (!CHAVES.includes(k)) return { ok: false, erro: "campo_desconhecido" };
  for (const k of CHAVES) if (!(k in e)) return { ok: false, erro: `${k}_ausente` };
  if (e.contrato !== CONTRATO_EVENTO_VERSAO) return { ok: false, erro: "contrato" };
  if (!PROVEDORES.includes(e.provedor)) return { ok: false, erro: "provedor" };
  if (typeof e.eventoId !== "string" || !ID.test(e.eventoId)) return { ok: false, erro: "eventoId" };
  if (typeof e.mensagemId !== "string" || !ID.test(e.mensagemId)) return { ok: false, erro: "mensagemId" };
  if (typeof e.grupoId !== "string" || !GRUPO.test(e.grupoId)) return { ok: false, erro: "grupoId" };
  if (e.participanteId !== null && (typeof e.participanteId !== "string" || !ID.test(e.participanteId))) return { ok: false, erro: "participanteId" };
  if (typeof e.fromMe !== "boolean") return { ok: false, erro: "fromMe" };
  if (!TIPOS_MENSAGEM.includes(e.tipo)) return { ok: false, erro: "tipo" };
  if (e.texto !== null && (typeof e.texto !== "string" || Array.from(e.texto).length > TEXTO_MAX || e.texto.includes("\u0000"))) return { ok: false, erro: "texto" };
  if (e.respostaA !== null && (typeof e.respostaA !== "string" || !ID.test(e.respostaA))) return { ok: false, erro: "respostaA" };
  if (typeof e.recebidoEm !== "string" || !ISO_UTC.test(e.recebidoEm) || !Number.isFinite(Date.parse(e.recebidoEm))) return { ok: false, erro: "recebidoEm" };
  const comMidia = ["IMAGEM", "DOCUMENTO", "AUDIO"].includes(e.tipo);
  if (comMidia !== (e.midia !== null)) return { ok: false, erro: "midia_incoerente" };
  if (e.midia !== null) {
    const m = e.midia;
    if (!ehObjeto(m)) return { ok: false, erro: "midia" };
    for (const k of Object.keys(m)) if (!CHAVES_MIDIA.includes(k)) return { ok: false, erro: "midia_campo_desconhecido" };
    if (!MIMES_ACEITOS.includes(m.mime)) return { ok: false, erro: "midia_mime" };
    if (!Number.isInteger(m.tamanhoBytes) || m.tamanhoBytes < 1 || m.tamanhoBytes > MIDIA_MAX_BYTES) return { ok: false, erro: "midia_tamanho" };
    if (typeof m.sha256 !== "string" || !SHA.test(m.sha256)) return { ok: false, erro: "midia_sha256" };
    if (m.nomeArquivo !== null && (typeof m.nomeArquivo !== "string" || m.nomeArquivo.length > 200)) return { ok: false, erro: "midia_nome" };
    if (typeof m.referencia !== "string" || !ID.test(m.referencia)) return { ok: false, erro: "midia_referencia" };
  }
  return { ok: true, evento: Object.freeze({ ...e, midia: e.midia ? Object.freeze({ ...e.midia }) : null }) };
}

/** Chave de idempotência do DOCUMENTO (mesmo arquivo reenviado em outra mensagem). */
export const chaveDoDocumento = (evento) => (evento?.midia?.sha256 ? `sha256:${evento.midia.sha256}` : null);
