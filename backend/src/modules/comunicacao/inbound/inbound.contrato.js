// Checkpoint F — CONTRATO do evento inbound de WhatsApp (Gateway → `POST /eventos/mensagem-recebida`) e a política de estado/automação.
//
// Fonte ÚNICA (pura, sem I/O) de três coisas, usadas em profundidade por rota, repo, provider e service:
//   1. validarEventoInbound  — schema ESTRITO (chaves fechadas, tipos exatos, enums fechados) + regras CROSS-FIELD.
//   2. decidirEstadoInbound  — em que ESTADO o evento é persistido (RECEIVED | HISTORICO | QUARANTINED | IGNORED; PROCESSED é reservado).
//   3. motivoBloqueioAutomacao — FAIL-CLOSED: só um evento LIVE, de cliente direto, sem fromMe/falha/stub, pode chegar a um fluxo automático.
//
// Por que existe: o Gateway derivava o "telefone" de qualquer JID (um LID de 15 dígitos passa no formato E.164). Agora o Gateway diz de ONDE veio o
// telefone (`telefoneOrigem`) e o backend recusa qualquer combinação incoerente. `validar.js` (shared) coage tipos (booleano/texto) — inadequado para
// um contrato estrito —, por isso o schema é próprio, no mesmo estilo: devolve um CÓDIGO fechado do primeiro erro (nunca o valor recebido).
//
// Vocabulários = os do Gateway (gateway-whatsapp/src/inboundContrato.js + inboundScope.js). test/whatsapp-inbound-contrato.test.js trava a paridade.

export const CONTRATO_INBOUND_VERSAO = 1;
export const ORIGENS_TIPO = Object.freeze(["LIVE", "OFFLINE_NORMAL", "OFFLINE_RECOVERY"]);
export const ORIGENS_JID_TIPO = Object.freeze(["direct_pn", "direct_lid_self", "direct_lid_other", "group", "status", "broadcast", "newsletter", "meta_ai", "technical", "unknown"]);
export const ORIGENS_TELEFONE = Object.freeze(["JID_PN", "SENDER_PN"]);
export const MOTIVOS_FALHA_DECRYPT = Object.freeze(["bad_mac", "sem_sessao_compativel", "sem_sessao", "sem_conteudo", "chave_ja_usada", "prekey_invalida", "sender_key", "outro"]);
export const ESTADOS_INBOUND = Object.freeze(["RECEIVED", "HISTORICO", "QUARANTINED", "IGNORED", "PROCESSED"]);
/** chats de CLIENTE direto: os únicos que um fluxo futuro pode tratar (grupo/status/newsletter/broadcast/meta_ai/técnico/desconhecido/LID próprio não). */
export const JID_TIPOS_CLIENTE = Object.freeze(["direct_pn", "direct_lid_other"]);

/** Central de Comunicação — TIPO do conteúdo (vocabulário do Gateway) e limite do texto. */
export const TIPOS_CONTEUDO = Object.freeze(["texto", "midia", "outro"]);
export const TEXTO_MAX = 4096;
/** Chaves ADITIVAS e OPCIONAIS (um Gateway antigo não as envia): ausentes = sem conteúdo. Aceitas juntas ou nenhuma. */
const CHAVES_CONTEUDO = Object.freeze(["tipoConteudo", "texto"]);

const CHAVES = Object.freeze(["contratoInbound", "providerMessageId", "origemTipo", "origemJidTipo", "fromMe", "telefoneE164", "telefoneOrigem", "falhaDecrypt", "motivoFalhaDecrypt", "stubSistema", "recebidoEm"]);
const E164 = /^\+[1-9][0-9]{7,14}$/;
const ID_PROVIDER = /^[A-Za-z0-9_.:-]{1,128}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const FUTURO_MAX_MS = 10 * 60_000;

const ehObjeto = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * @param {unknown} corpo
 * @param {{agora?: () => number}} [o]
 * @returns {{ok: true, evento: object} | {ok: false, erro: string}} `erro` é um CÓDIGO fechado (nunca ecoa o valor recebido)
 */
export function validarEventoInbound(corpo, { agora = () => Date.now() } = {}) {
  if (!ehObjeto(corpo)) return { ok: false, erro: "corpo_invalido" };
  for (const k of Object.keys(corpo)) if (!CHAVES.includes(k) && !CHAVES_CONTEUDO.includes(k)) return { ok: false, erro: "campo_desconhecido" };   // inclui organizacao_id/estado injetados
  for (const k of CHAVES) if (!(k in corpo)) return { ok: false, erro: `${k}_ausente` };
  const c = corpo;
  if (c.contratoInbound !== CONTRATO_INBOUND_VERSAO) return { ok: false, erro: "contratoInbound" };
  if (typeof c.providerMessageId !== "string" || !ID_PROVIDER.test(c.providerMessageId)) return { ok: false, erro: "providerMessageId" };
  if (!ORIGENS_TIPO.includes(c.origemTipo)) return { ok: false, erro: "origemTipo" };
  if (!ORIGENS_JID_TIPO.includes(c.origemJidTipo)) return { ok: false, erro: "origemJidTipo" };
  if (typeof c.fromMe !== "boolean") return { ok: false, erro: "fromMe" };
  if (typeof c.falhaDecrypt !== "boolean") return { ok: false, erro: "falhaDecrypt" };
  if (typeof c.stubSistema !== "boolean") return { ok: false, erro: "stubSistema" };
  if (c.telefoneE164 !== null && (typeof c.telefoneE164 !== "string" || !E164.test(c.telefoneE164))) return { ok: false, erro: "telefoneE164" };
  if (c.telefoneOrigem !== null && !ORIGENS_TELEFONE.includes(c.telefoneOrigem)) return { ok: false, erro: "telefoneOrigem" };
  if (c.motivoFalhaDecrypt !== null && !MOTIVOS_FALHA_DECRYPT.includes(c.motivoFalhaDecrypt)) return { ok: false, erro: "motivoFalhaDecrypt" };
  if (typeof c.recebidoEm !== "string" || !ISO_UTC.test(c.recebidoEm)) return { ok: false, erro: "recebidoEm" };
  const t = Date.parse(c.recebidoEm);
  if (!Number.isFinite(t) || t > agora() + FUTURO_MAX_MS) return { ok: false, erro: "recebidoEm" };

  // ---- CONTEÚDO (opcional; se um vier, os dois vêm) ----
  if (("tipoConteudo" in c) !== ("texto" in c)) return { ok: false, erro: "conteudo_incompleto" };
  if ("tipoConteudo" in c) {
    if (!TIPOS_CONTEUDO.includes(c.tipoConteudo)) return { ok: false, erro: "tipoConteudo" };
    if (c.tipoConteudo === "texto") {
      if (typeof c.texto !== "string" || c.texto === "" || Array.from(c.texto).length > TEXTO_MAX || c.texto.includes("\u0000")) return { ok: false, erro: "texto" };
    } else if (c.texto !== null) return { ok: false, erro: "texto_incoerente" };
  }

  // ---- CROSS-FIELD ----
  if ((c.telefoneE164 === null) !== (c.telefoneOrigem === null)) return { ok: false, erro: "telefone_origem_incoerente" };
  if (c.telefoneE164 !== null) {
    if (c.fromMe) return { ok: false, erro: "telefone_com_from_me" };
    const casa = (c.origemJidTipo === "direct_pn" && c.telefoneOrigem === "JID_PN") || (c.origemJidTipo === "direct_lid_other" && c.telefoneOrigem === "SENDER_PN");
    if (!casa) return { ok: false, erro: "telefone_jid_nao_suportado" };            // LID sem PN explícito, grupo, status, newsletter, broadcast... nunca têm telefone
  }
  if (c.falhaDecrypt && c.motivoFalhaDecrypt === null) return { ok: false, erro: "falha_sem_motivo" };
  if (!c.falhaDecrypt && c.motivoFalhaDecrypt !== null) return { ok: false, erro: "motivo_sem_falha" };
  if (c.falhaDecrypt && c.stubSistema) return { ok: false, erro: "falha_e_stub_sistema" };
  // Privacidade: texto/mídia só de chat direto de cliente COM telefone real, sem fromMe/falha/stub (o Gateway já filtra; o backend não confia).
  if ("tipoConteudo" in c && c.tipoConteudo !== "outro" && (c.telefoneE164 === null || c.fromMe || c.falhaDecrypt || c.stubSistema)) return { ok: false, erro: "conteudo_nao_elegivel" };

  return { ok: true, evento: { ...c } };
}

/**
 * Estado com que o evento é PERSISTIDO. Ordem = prioridade. Nada aqui dispara ação: é só a classificação.
 *   fromMe / stub de protocolo / chat que não é de cliente direto  ⇒ IGNORED
 *   OFFLINE_RECOVERY                                               ⇒ QUARANTINED (nunca automação, nunca resposta)
 *   falha de decrypt                                               ⇒ QUARANTINED (evento técnico, não é texto de cliente)
 *   LIVE                                                           ⇒ RECEIVED    (elegível ao fluxo futuro normal)
 *   OFFLINE_NORMAL                                                 ⇒ HISTORICO   (histórico/offline)
 * PROCESSED é reservado para um checkpoint futuro: nada aqui o produz.
 */
export function decidirEstadoInbound(e) {
  if (e.fromMe !== false || e.stubSistema !== false) return "IGNORED";
  if (!JID_TIPOS_CLIENTE.includes(e.origemJidTipo)) return "IGNORED";
  if (e.origemTipo === "OFFLINE_RECOVERY") return "QUARANTINED";
  if (e.falhaDecrypt !== false) return "QUARANTINED";
  if (e.origemTipo === "LIVE") return "RECEIVED";
  return "HISTORICO";
}

/**
 * FAIL-CLOSED. `null` = elegível a automação; qualquer outra coisa é o CÓDIGO fechado do bloqueio. Aceita o evento validado ou um registro
 * persistido (com `estado`). Campo ausente/de tipo errado ⇒ bloqueado (nunca "provavelmente ok").
 */
export function motivoBloqueioAutomacao(x) {
  if (!ehObjeto(x) || x.contratoInbound !== CONTRATO_INBOUND_VERSAO || !CHAVES.every((k) => k in x)) return "contrato_invalido";
  if (x.origemTipo === "OFFLINE_RECOVERY") return "recovery";
  if (x.origemTipo !== "LIVE") return "origem_nao_live";
  if (x.fromMe !== false) return "from_me";
  if (x.falhaDecrypt !== false) return "falha_decrypt";
  if (x.stubSistema !== false) return "stub_sistema";
  if (!JID_TIPOS_CLIENTE.includes(x.origemJidTipo)) return "jid_nao_suportado";
  if ("estado" in x && x.estado !== "RECEIVED") return "estado_nao_elegivel";
  return null;
}
