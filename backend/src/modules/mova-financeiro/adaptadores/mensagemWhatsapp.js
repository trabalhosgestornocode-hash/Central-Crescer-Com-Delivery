// Leitura do conteúdo de uma mensagem do WhatsApp no formato do protocolo (o mesmo `message` que o Baileys entrega e que a
// Evolution API repassa no webhook `messages.upsert`). Puro: só lê, nunca baixa mídia, nunca loga.
// Devolve tipo, texto/legenda (entrada NÃO confiável), mensagem citada (resposta) e o descritor da mídia, se houver.

const TEXTO_MAX = 4096;
const limpar = (s) => (typeof s === "string" ? Array.from(s.replace(/\u0000/g, "").trim()).slice(0, TEXTO_MAX).join("") || null : null);

/** Desembrulha os envelopes comuns (efêmera, view-once, documento com legenda). */
function desembrulhar(m) {
  let atual = m;
  for (let i = 0; i < 4 && atual && typeof atual === "object"; i++) {
    const proximo = atual.ephemeralMessage?.message ?? atual.viewOnceMessage?.message ?? atual.viewOnceMessageV2?.message ?? atual.documentWithCaptionMessage?.message ?? null;
    if (!proximo) break;
    atual = proximo;
  }
  return atual && typeof atual === "object" ? atual : null;
}

/**
 * @param {any} message objeto `message` do protocolo
 * @returns {{tipo:'TEXTO'|'IMAGEM'|'DOCUMENTO'|'AUDIO'|'OUTRO', texto:string|null, respostaA:string|null, midia:null|{mime:string|null, nomeArquivo:string|null, tamanhoBytes:number|null, base64:string|null}}}
 */
export function lerMensagem(message) {
  const m = desembrulhar(message);
  const vazio = { tipo: "OUTRO", texto: null, respostaA: null, midia: null };
  if (!m) return vazio;
  const ctx = (x) => (typeof x?.contextInfo?.stanzaId === "string" && x.contextInfo.stanzaId ? x.contextInfo.stanzaId : null);
  const tamanho = (x) => { const n = Number(x?.fileLength); return Number.isInteger(n) && n > 0 ? n : null; };
  if (typeof m.conversation === "string") return { ...vazio, tipo: "TEXTO", texto: limpar(m.conversation) };
  if (m.extendedTextMessage) return { ...vazio, tipo: "TEXTO", texto: limpar(m.extendedTextMessage.text), respostaA: ctx(m.extendedTextMessage) };
  if (m.imageMessage) {
    const x = m.imageMessage;
    return { tipo: "IMAGEM", texto: limpar(x.caption), respostaA: ctx(x), midia: { mime: x.mimetype ?? null, nomeArquivo: null, tamanhoBytes: tamanho(x), base64: null } };
  }
  if (m.documentMessage) {
    const x = m.documentMessage;
    return { tipo: "DOCUMENTO", texto: limpar(x.caption), respostaA: ctx(x), midia: { mime: x.mimetype ?? null, nomeArquivo: typeof x.fileName === "string" ? x.fileName.slice(0, 200) : null, tamanhoBytes: tamanho(x), base64: null } };
  }
  if (m.audioMessage) {
    const x = m.audioMessage;
    return { tipo: "AUDIO", texto: null, respostaA: ctx(x), midia: { mime: (x.mimetype ?? "").split(";")[0] || null, nomeArquivo: null, tamanhoBytes: tamanho(x), base64: null } };
  }
  return vazio;
}
