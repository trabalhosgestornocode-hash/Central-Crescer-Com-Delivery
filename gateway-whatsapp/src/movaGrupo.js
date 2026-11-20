// MOVA — caminho ESPECÍFICO e CONTROLADO para mensagens dos grupos autorizados do Centro Financeiro (Execução 02).
//
// Por que existe: o contrato inbound geral (inboundContrato.js) descarta conteúdo de grupo de propósito (privacidade da
// Central de Comunicação) e o backend grava grupo como IGNORED. Isso NÃO muda. Este módulo é um caminho À PARTE, que:
//   - só olha grupos listados em WHATSAPP_MOVA_GRUPOS_JID (vazio/ausente ⇒ DESLIGADO: nada é lido, baixado ou enviado);
//   - usa o MESMO socket/sessão (nenhuma conexão nova, nenhuma credencial nova, nada no auth state);
//   - ignora mensagens da própria conta (fromMe — inclui as respostas do MOVA) e stubs de protocolo;
//   - preserva a mensagem respondida (`respostaA`) e o participante (JID; telefone só com PN explícito);
//   - baixa a mídia pelo socket existente (porta injetada `baixarMidia`) e manda em base64 ao backend, com teto de tamanho;
//   - deduplica dentro do processo (ids recentes); a deduplicação FINAL é do backend (eventoId `bly:<id>`), o que cobre
//     reconexão e reentrega da fila offline;
//   - envia por `notificar` (HMAC, rota /internal/comunicacao/eventos/mova-grupo) em best-effort, nunca bloqueando o fluxo atual.
// Nunca loga texto, legenda, mídia, telefone completo ou JID completo.
//
// Contrato de saída: espelho de backend/src/modules/mova-financeiro/adaptadores/gatewayBaileys.js.

export const CONTRATO_MOVA_VERSAO = 1;
export const MIDIA_MAX_BYTES = 15 * 1024 * 1024;
const REGEX_GRUPO = /^[0-9]{5,40}(-[0-9]{1,20})?@g\.us$/;
const TEXTO_MAX = 4096;

/** Lê WHATSAPP_MOVA_GRUPOS_JID (lista separada por vírgula). Valor fora do formato ⇒ erro no boot (fail-closed). */
export function lerGruposMova(valor) {
  const lista = String(valor ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const j of lista) if (!REGEX_GRUPO.test(j)) throw new Error("WHATSAPP_MOVA_GRUPOS_JID precisa listar JIDs de grupo (<numeros>@g.us) separados por vírgula");
  return Object.freeze([...new Set(lista)]);
}

const limpar = (s) => (typeof s === "string" ? Array.from(s.replace(/\u0000/g, "").trim()).slice(0, TEXTO_MAX).join("") || null : null);

function desembrulhar(m) {
  let atual = m;
  for (let i = 0; i < 4 && atual && typeof atual === "object"; i++) {
    const prox = atual.ephemeralMessage?.message ?? atual.viewOnceMessage?.message ?? atual.viewOnceMessageV2?.message ?? atual.documentWithCaptionMessage?.message ?? null;
    if (!prox) break;
    atual = prox;
  }
  return atual && typeof atual === "object" ? atual : null;
}

/** Tipo, texto/legenda, mensagem respondida e descritor de mídia (sem bytes). */
export function lerConteudo(message) {
  const m = desembrulhar(message);
  const vazio = { tipo: "OUTRO", texto: null, respostaA: null, midia: null };
  if (!m) return vazio;
  const ctx = (x) => (typeof x?.contextInfo?.stanzaId === "string" && x.contextInfo.stanzaId ? x.contextInfo.stanzaId : null);
  if (typeof m.conversation === "string") return { ...vazio, tipo: "TEXTO", texto: limpar(m.conversation) };
  if (m.extendedTextMessage) return { ...vazio, tipo: "TEXTO", texto: limpar(m.extendedTextMessage.text), respostaA: ctx(m.extendedTextMessage) };
  if (m.imageMessage) return { tipo: "IMAGEM", texto: limpar(m.imageMessage.caption), respostaA: ctx(m.imageMessage), midia: { mime: m.imageMessage.mimetype ?? "image/jpeg", nomeArquivo: null } };
  if (m.documentMessage) return { tipo: "DOCUMENTO", texto: limpar(m.documentMessage.caption), respostaA: ctx(m.documentMessage), midia: { mime: m.documentMessage.mimetype ?? "application/octet-stream", nomeArquivo: typeof m.documentMessage.fileName === "string" ? m.documentMessage.fileName.slice(0, 200) : null } };
  if (m.audioMessage) return { tipo: "AUDIO", texto: null, respostaA: ctx(m.audioMessage), midia: { mime: String(m.audioMessage.mimetype ?? "audio/ogg").split(";")[0], nomeArquivo: null } };
  return vazio;
}

/** "+E164" só de JID de telefone explícito (`<digitos>@s.whatsapp.net`); LID e o resto ⇒ null. */
function telefoneDe(jid) {
  const m = /^([1-9][0-9]{7,14})(:\d+)?@s\.whatsapp\.net$/.exec(String(jid ?? ""));
  return m ? `+${m[1]}` : null;
}

/**
 * Monta o payload (sem bytes de mídia) de um item de `messages.upsert`, ou null se não é do MOVA.
 * @param {any} m WAMessage
 * @param {{grupos:readonly string[], origemTipo?:string, agora?:() => Date}} o  origem POR MENSAGEM (rastreador do inbound)
 */
export function montarEventoMova(m, { grupos, origemTipo = "OFFLINE_NORMAL", agora = () => new Date() }) {
  const key = m?.key;
  if (!key || typeof key.id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key.id)) return null;
  if (typeof key.remoteJid !== "string" || !grupos.includes(key.remoteJid)) return null;   // só grupos AUTORIZADOS (privado nunca)
  if (key.fromMe === true) return null;                                                     // própria conta / respostas do MOVA
  if (m.messageStubType != null) return null;                                               // stub de protocolo
  const participante = typeof key.participant === "string" && /^[A-Za-z0-9_.:@-]{1,160}$/.test(key.participant) ? key.participant : null;
  const c = lerConteudo(m.message);
  const ts = Number(m.messageTimestamp);
  const nome = typeof m.pushName === "string" && m.pushName.trim() ? m.pushName.trim().slice(0, 60) : null;
  return {
    contratoMova: CONTRATO_MOVA_VERSAO,
    eventoId: `bly:${key.id}`,
    mensagemId: key.id,
    grupoId: key.remoteJid,
    participanteId: participante,
    telefoneE164: telefoneDe(key.participantPn ?? key.participant),
    nomeExibicao: nome,
    fromMe: false,
    tipo: c.tipo,
    texto: c.texto,
    respostaA: c.respostaA && /^[A-Za-z0-9_.:-]{1,128}$/.test(c.respostaA) ? c.respostaA : null,
    midia: c.midia ? { mime: c.midia.mime, nomeArquivo: c.midia.nomeArquivo, tamanhoBytes: null, base64: null } : null,
    recebidoEm: (Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : agora()).toISOString(),
    origemTipo: ["LIVE", "OFFLINE_NORMAL", "OFFLINE_RECOVERY"].includes(origemTipo) ? origemTipo : "OFFLINE_NORMAL",
  };
}

/**
 * @param {{grupos:readonly string[], notificar:(payload:object) => Promise<any>, baixarMidia?:(m:any, socket:any) => Promise<Uint8Array>,
 *          log?:Function, maxRecentes?:number, maxMidiaBytes?:number}} deps
 */
export function criarEncaminhadorMova({ grupos, notificar, baixarMidia = null, log = () => {}, maxRecentes = 2000, maxMidiaBytes = MIDIA_MAX_BYTES }) {
  const recentes = new Set();
  const ativo = Array.isArray(grupos) && grupos.length > 0;
  const lembrar = (id) => { recentes.add(id); if (recentes.size > maxRecentes) recentes.delete(recentes.values().next().value); };

  async function encaminhar(m, payload, socket) {
    if (payload.midia && baixarMidia) {
      try {
        const bytes = await baixarMidia(m, socket);
        if (bytes && bytes.length > 0 && bytes.length <= maxMidiaBytes) payload.midia = { ...payload.midia, tamanhoBytes: bytes.length, base64: Buffer.from(bytes).toString("base64") };
        else if (bytes && bytes.length > maxMidiaBytes) { payload.tipo = "OUTRO"; payload.midia = null; log("warn", "mova.midia_acima_do_limite", {}); }
      } catch { log("warn", "mova.midia_falhou", {}); }   // backend tenta pela porta dele ou responde "não consegui ler"
    }
    try { await notificar(payload); } catch (e) { log("warn", "mova.notificar_falhou", { erro: e?.codigo ?? e?.name ?? "erro" }); }
  }

  return Object.freeze({
    ativo,
    /** Chamado no `messages.upsert` do socket ATUAL. Nunca lança; nunca altera a lista recebida. */
    aoMensagens(messages, { origemDe = () => "OFFLINE_NORMAL", socket = null } = {}) {
      if (!ativo) return [];
      const enviados = [];
      for (const m of messages ?? []) {
        let payload = null;
        try { payload = montarEventoMova(m, { grupos, origemTipo: origemDe(m?.key?.id) }); } catch { payload = null; }
        if (!payload || recentes.has(payload.eventoId)) continue;
        lembrar(payload.eventoId);
        enviados.push(encaminhar(m, payload, socket));
      }
      return enviados;
    },
  });
}
