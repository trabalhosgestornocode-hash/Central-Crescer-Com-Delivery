// EXCEÇÃO ESTREITA DE GRUPO — o Gateway continua sem bulk, broadcast ou "grupos em geral" (README, routes.js). O que existe aqui:
//   * listagem SÓ LEITURA dos grupos de que a conta participa (nome + JID + tamanho), para o operador descobrir o JID real do grupo
//     interno da operação no Painel Administrativo — nunca participantes, telefones, descrição ou foto;
//   * consulta/validação do grupo interno CONFIGURADO (WHATSAPP_GRUPO_INTERNO_JID) antes de qualquer envio.
//
// FAIL-CLOSED, mesmo espírito de src/destinatario.js: qualquer coisa diferente de "é exatamente o grupo configurado, ele existe, a
// conta participa e pode enviar" NÃO envia — e o erro sai com `preEnvio = true` (nada saiu):
//   GRUPO_NAO_AUTORIZADO   (sem grupo configurado / JID pedido ≠ configurado)       — PERMANENTE
//   GRUPO_INEXISTENTE      (o WhatsApp não devolve o grupo / a conta não participa) — PERMANENTE
//   GRUPO_SEM_PERMISSAO    (grupo só-admins e a conta não é admin)                 — PERMANENTE
//   CONSULTA_GRUPO_FALHOU  (rejeição, timeout, resposta ilegível)                  — transitório

import { jidNormalizedUser } from "baileys";
import { erro, CODIGOS } from "./errors.js";
import { REGEX_JID_GRUPO } from "./config.js";

export const TIMEOUT_CONSULTA_GRUPO_MS = 15_000;

const falha = (codigo, detalhe) => { const e = erro(codigo, detalhe); e.preEnvio = true; return e; };

async function comTimeout(promessa, timeoutMs, agendar = setTimeout, cancelar = clearTimeout) {
  let timer;
  try {
    const timeout = new Promise((_, rej) => { timer = agendar(() => rej(new Error("timeout")), timeoutMs); });
    return await Promise.race([promessa, timeout]);
  } finally {
    if (timer !== undefined) cancelar(timer);
  }
}

/** JID de grupo mascarado para log: só os 4 últimos dígitos do id (suficiente para correlacionar). */
export function mascararJidGrupo(jid) {
  const id = String(jid ?? "").split("@")[0].replace(/\D/g, "");
  return id ? `…${id.slice(-4)}@g.us` : null;
}

/** Nome do grupo saneado para devolver ao backend (nunca vai ao log). */
const nomeSeguro = (s) => (typeof s === "string" && s.trim() ? s.trim().slice(0, 120) : null);

/**
 * O pedido é para o grupo interno configurado? Única porta de entrada do envio a grupo.
 * @param {string|null} grupoJidPedido
 * @param {string|null} grupoJidConfigurado
 */
export function exigirGrupoAutorizado(grupoJidPedido, grupoJidConfigurado) {
  if (!grupoJidConfigurado) throw falha(CODIGOS.GRUPO_NAO_AUTORIZADO, "grupo interno não configurado");
  if (typeof grupoJidPedido !== "string" || !REGEX_JID_GRUPO.test(grupoJidPedido)) throw falha(CODIGOS.GRUPO_NAO_AUTORIZADO, "jid fora do formato de grupo");
  if (grupoJidPedido !== grupoJidConfigurado) throw falha(CODIGOS.GRUPO_NAO_AUTORIZADO, "jid diferente do configurado");
}

/**
 * Identidades da PRÓPRIA conta (PN e LID): num grupo com addressing_mode=lid o participante vem como LID.
 * @param {{user?: {id?: string, lid?: string}}} socket
 */
function identidadesDaConta(socket) {
  const ids = new Set();
  for (const bruto of [socket?.user?.id, socket?.user?.lid]) {
    if (typeof bruto !== "string" || !bruto) continue;
    try { ids.add(jidNormalizedUser(bruto)); } catch { /* ignora formato inesperado */ }
  }
  return ids;
}

/**
 * Lista os grupos de que a conta participa — só nome, JID, tamanho e se só admins enviam.
 * @param {{socket: {groupFetchAllParticipating?: () => Promise<Record<string, any>>}, timeoutMs?: number}} p
 * @returns {Promise<Array<{jid: string, nome: string|null, participantes: number|null, somenteAdminsEnviam: boolean}>>}
 */
export async function listarGruposDaConta({ socket, timeoutMs = TIMEOUT_CONSULTA_GRUPO_MS }) {
  if (typeof socket?.groupFetchAllParticipating !== "function") throw falha(CODIGOS.CONSULTA_GRUPO_FALHOU, "socket sem groupFetchAllParticipating");
  let resposta;
  try {
    resposta = await comTimeout(socket.groupFetchAllParticipating(), timeoutMs);
  } catch (e) {
    throw falha(CODIGOS.CONSULTA_GRUPO_FALHOU, e?.message === "timeout" ? "timeout" : (e?.name ?? "erro"));
  }
  if (!resposta || typeof resposta !== "object") throw falha(CODIGOS.CONSULTA_GRUPO_FALHOU, "resposta ilegível");
  return Object.values(resposta)
    .filter((g) => g && typeof g.id === "string" && REGEX_JID_GRUPO.test(g.id))
    .map((g) => ({
      jid: g.id,
      nome: nomeSeguro(g.subject),
      participantes: Number.isInteger(g.size) ? g.size : (Array.isArray(g.participants) ? g.participants.length : null),
      somenteAdminsEnviam: g.announce === true,
    }))
    .sort((a, b) => String(a.nome ?? "").localeCompare(String(b.nome ?? ""), "pt-BR"));
}

/**
 * Consulta o grupo no PRÓPRIO WhatsApp (`groupMetadata`) e diz se a conta participa e pode enviar. Não lança por "não participa" /
 * "sem permissão" — devolve os fatos; quem decide bloquear é `exigirGrupoEnviavel`.
 * @param {{socket: object, grupoJid: string, timeoutMs?: number}} p
 * @returns {Promise<{jid: string, nome: string|null, participantes: number|null, participa: boolean, souAdmin: boolean, somenteAdminsEnviam: boolean, podeEnviar: boolean}>}
 */
export async function consultarGrupo({ socket, grupoJid, timeoutMs = TIMEOUT_CONSULTA_GRUPO_MS }) {
  if (typeof socket?.groupMetadata !== "function") throw falha(CODIGOS.CONSULTA_GRUPO_FALHOU, "socket sem groupMetadata");
  let meta;
  try {
    meta = await comTimeout(socket.groupMetadata(grupoJid), timeoutMs);
  } catch (e) {
    // O servidor responde item-not-found / forbidden (404/403) quando o grupo não existe ou a conta saiu dele.
    const code = e?.data ?? e?.output?.statusCode;
    if (code === 404 || code === 403 || code === 401) throw falha(CODIGOS.GRUPO_INEXISTENTE, `groupMetadata ${code}`);
    throw falha(CODIGOS.CONSULTA_GRUPO_FALHOU, e?.message === "timeout" ? "timeout" : (e?.name ?? "erro"));
  }
  if (!meta || typeof meta !== "object" || meta.id !== grupoJid) throw falha(CODIGOS.CONSULTA_GRUPO_FALHOU, "metadados incoerentes");

  const eu = identidadesDaConta(socket);
  const participantes = Array.isArray(meta.participants) ? meta.participants : [];
  const meu = participantes.find((p) => [p?.id, p?.jid, p?.lid].some((id) => typeof id === "string" && eu.has(id)));
  const participa = Boolean(meu);
  const souAdmin = meu?.admin === "admin" || meu?.admin === "superadmin";
  const somenteAdminsEnviam = meta.announce === true;
  return {
    jid: meta.id,
    nome: nomeSeguro(meta.subject),
    participantes: Number.isInteger(meta.size) ? meta.size : participantes.length,
    participa, souAdmin, somenteAdminsEnviam,
    podeEnviar: participa && (!somenteAdminsEnviam || souAdmin),
  };
}

/** Bloqueia (pré-envio) quem não pode receber a mensagem da conta. */
export function exigirGrupoEnviavel(info) {
  if (!info.participa) throw falha(CODIGOS.GRUPO_INEXISTENTE, "a conta não participa do grupo");
  if (!info.podeEnviar) throw falha(CODIGOS.GRUPO_SEM_PERMISSAO, "grupo só-admins e a conta não é admin");
}
