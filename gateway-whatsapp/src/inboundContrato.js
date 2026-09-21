// Checkpoint F — CONTRATO do evento inbound (Gateway → backend `POST /eventos/mensagem-recebida`).
//
// PROBLEMA QUE ISTO RESOLVE
//   O caminho antigo derivava o "telefone" de qualquer JID com `deJid()` (`"+" + jid.split("@")[0].split(":")[0]`). Um LID de 15 dígitos
//   (`100000000000001@lid`), um id de grupo, o `status@broadcast` ou um newsletter viravam um "telefone" que passa no formato E.164; stubs de falha
//   de decrypt eram encaminhados como se fossem mensagem normal; e nada dizia se a mensagem chegou AO VIVO ou da fila offline. Este módulo é a
//   ÚNICA fonte do evento inbound: atribuição correta, origem por mensagem, falha de decrypt explícita.
//
// REGRAS (todas testadas em test/inboundContrato.test.js)
//   - `origemJidTipo` vem de `classificarJid` (inboundScope.js) — a única classificação de JID do projeto (helpers oficiais do Baileys).
//   - `telefoneE164` só existe com EVIDÊNCIA REAL de telefone (PN): (a) o chat é `direct_pn` e o JID é de telefone; ou (b) o chat é um LID de
//     OUTRA pessoa e o Baileys entregou explicitamente o telefone dela em `key.senderPn` (JID `@s.whatsapp.net` válido). Nunca por heurística de
//     dígitos. `fromMe`, o próprio número, LID próprio, grupo, status, broadcast, newsletter, meta_ai, técnico e desconhecido ⇒ `null`.
//     `telefoneOrigem` (JID_PN | SENDER_PN) registra de ONDE veio, para o backend impor a regra cross-field.
//   - `origemTipo` é por MENSAGEM (mapa em memória id da stanza → origem, alimentado pelo `CB:message` com a mesma regra do Baileys:
//     `!!attrs.offline` ⇒ offline), NUNCA pelo `type` consolidado do `messages.upsert` (que é o do 1º item do buffer). Origem desconhecida ⇒
//     `OFFLINE_NORMAL` (fail-safe: só `LIVE` é elegível a automação futura). `OFFLINE_RECOVERY` existe no contrato mas nada aqui o produz.
//   - `falhaDecrypt`/`motivoFalhaDecrypt`: stub CIPHERTEXT ⇒ true + motivo em vocabulário FECHADO (`classificarMotivoFalha`); nunca o texto do erro.
//   - `stubSistema`: outro stub de protocolo (não é texto de cliente).
//
// NADA aqui loga, persiste, faz flush, mexe no buffer, envia ou decide automação. O mapa de origem é limitado e nunca expõe ids.

import { isJidUser, jidDecode, proto } from "baileys";
import { classificarJid, classificarMotivoFalha, TIPOS_JID, MOTIVOS_FALHA_DECRYPT } from "./inboundScope.js";

export const CONTRATO_INBOUND_VERSAO = 1;
export const ORIGENS_INBOUND = Object.freeze(["LIVE", "OFFLINE_NORMAL", "OFFLINE_RECOVERY"]);
export const ORIGENS_DE_TELEFONE = Object.freeze(["JID_PN", "SENDER_PN"]);
export const ORIGEM_PADRAO = "OFFLINE_NORMAL";
export { TIPOS_JID, MOTIVOS_FALHA_DECRYPT };

const SEM_TELEFONE = Object.freeze({ telefoneE164: null, telefoneOrigem: null });

/** "+E164" de um JID de TELEFONE (`@s.whatsapp.net`, device removido) ou null. NUNCA aceita LID, grupo, status, newsletter... */
export function telefoneDeJidPn(jid) {
  try {
    if (typeof jid !== "string" || !isJidUser(jid)) return null;
    const user = jidDecode(jid)?.user;
    if (typeof user !== "string" || !/^[1-9][0-9]{7,14}$/.test(user)) return null;
    return `+${user}`;
  } catch {
    return null;
  }
}

/**
 * Telefone REAL do remetente, ou null. Ver as regras no cabeçalho.
 * @param {{origemJidTipo: string, fromMe: boolean, remoteJid?: any, senderPn?: any, identidade?: {pnUser?: string|null}}} p
 * @returns {{telefoneE164: string|null, telefoneOrigem: 'JID_PN'|'SENDER_PN'|null}}
 */
export function extrairTelefoneReal(p) {
  const { origemJidTipo, fromMe, remoteJid, senderPn, identidade } = p ?? {};
  if (fromMe !== false) return SEM_TELEFONE;                       // mensagem da própria conta (ou indeterminado) nunca cria contato de cliente
  const propria = (tel) => Boolean(identidade?.pnUser) && tel === `+${identidade.pnUser}`;
  if (origemJidTipo === "direct_pn") {
    const tel = telefoneDeJidPn(remoteJid);
    return tel && !propria(tel) ? { telefoneE164: tel, telefoneOrigem: "JID_PN" } : SEM_TELEFONE;
  }
  if (origemJidTipo === "direct_lid_other") {
    const tel = telefoneDeJidPn(senderPn);                          // SÓ o PN explícito que o Baileys entregou; nunca os dígitos do LID
    return tel && !propria(tel) ? { telefoneE164: tel, telefoneOrigem: "SENDER_PN" } : SEM_TELEFONE;
  }
  return SEM_TELEFONE;                                              // LID próprio, grupo, status, broadcast, newsletter, meta_ai, técnico, desconhecido
}

/**
 * Mapa em memória (LIMITADO) id da stanza → origem. Alimentado pelo `CB:message` (mesma regra do Baileys: `!!attrs.offline`).
 * `consumir` devolve a origem e libera a entrada; id ausente/desconhecido ⇒ ORIGEM_PADRAO (fail-safe, nunca LIVE por omissão).
 * Nunca loga nem expõe ids. `novoSocket` limpa (o buffer do socket anterior morreu com ele).
 *
 * Checkpoint G — `rotularOffline` (injetável) decide o rótulo de um nó offline NO MOMENTO em que ele é registrado:
 * "OFFLINE_NORMAL" (padrão, comportamento de sempre) ou "OFFLINE_RECOVERY" enquanto o motor de recovery estiver
 * ativo. `promoverPendentesParaRecovery()` (seção 31 do checkpoint) promove as entradas AINDA pendentes (chegaram
 * antes do recovery começar, ainda não consumidas) de OFFLINE_NORMAL para OFFLINE_RECOVERY — sem nunca logar id.
 */
export function criarRastreadorOrigem({ max = 5000, rotularOffline = () => "OFFLINE_NORMAL" } = {}) {
  if (!Number.isInteger(max) || max < 1) throw new RangeError("max deve ser inteiro >= 1");
  const mapa = new Map();
  return {
    registrar(node) {
      const id = node?.attrs?.id;
      if (typeof id !== "string" || id === "") return;
      mapa.delete(id);                                              // reinsere no fim (ordem de chegada)
      let rotulo = "LIVE";
      if (node.attrs.offline) { try { rotulo = rotularOffline() === "OFFLINE_RECOVERY" ? "OFFLINE_RECOVERY" : "OFFLINE_NORMAL"; } catch { rotulo = "OFFLINE_NORMAL"; } }
      mapa.set(id, rotulo);
      if (mapa.size > max) mapa.delete(mapa.keys().next().value);   // descarta a MAIS ANTIGA
    },
    consumir(id) {
      if (typeof id !== "string" || !mapa.has(id)) return ORIGEM_PADRAO;
      const origem = mapa.get(id); mapa.delete(id);
      return origem;
    },
    novoSocket() { mapa.clear(); },
    /** promove as entradas PENDENTES de OFFLINE_NORMAL para OFFLINE_RECOVERY (nunca toca LIVE nem loga ids) */
    promoverPendentesParaRecovery() {
      for (const [id, origem] of mapa) if (origem === "OFFLINE_NORMAL") mapa.set(id, "OFFLINE_RECOVERY");
    },
    tamanho: () => mapa.size,
  };
}

/** Liga o rastreador ao `CB:message` do ws (passivo: só LÊ; `prependListener` para registrar antes do handler do Baileys). */
export function observarOrigem(socket, rastreador) {
  rastreador.novoSocket();
  const ws = socket?.ws;
  const fn = (node) => { try { rastreador.registrar(node); } catch { /* observação nunca interfere */ } };
  try {
    if (typeof ws?.prependListener === "function") ws.prependListener("CB:message", fn);
    else if (typeof ws?.on === "function") ws.on("CB:message", fn);
    else return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Monta o evento inbound do contrato a partir de um item de `messages.upsert`. Devolve `null` se não há id (sem id não há como deduplicar).
 * @param {any} m item de messages.upsert
 * @param {{origemTipo?: string, identidade?: {lidUser?: string|null, pnUser?: string|null}, agora?: () => Date}} [o]
 */
export function montarEventoInbound(m, { origemTipo, identidade, agora = () => new Date() } = {}) {
  const key = m?.key ?? {};
  const providerMessageId = typeof key.id === "string" && key.id !== "" ? key.id : null;
  if (providerMessageId === null) return null;
  const origemJidTipo = classificarJid(key.remoteJid, identidade);
  const fromMe = key.fromMe === true;
  const falhaDecrypt = m?.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT;
  const { telefoneE164, telefoneOrigem } = extrairTelefoneReal({ origemJidTipo, fromMe, remoteJid: key.remoteJid, senderPn: key.senderPn, identidade });
  return {
    contratoInbound: CONTRATO_INBOUND_VERSAO,
    providerMessageId,
    origemTipo: ORIGENS_INBOUND.includes(origemTipo) ? origemTipo : ORIGEM_PADRAO,
    origemJidTipo,
    fromMe,
    telefoneE164,
    telefoneOrigem,
    falhaDecrypt,
    motivoFalhaDecrypt: falhaDecrypt ? classificarMotivoFalha(m?.messageStubParameters?.[0]) : null,
    stubSistema: m?.messageStubType != null && !falhaDecrypt,
    recebidoEm: agora().toISOString(),
  };
}
