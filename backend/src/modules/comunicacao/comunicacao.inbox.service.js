// Decisão do INBOUND para a Central de Comunicação: um evento (já validado por inbound.contrato.js) vira mensagem de conversa SOMENTE se vier de um
// responsável AUTORIZADO (roster). Tudo o mais é IGNORADO — sem conversa, sem busca, sem texto persistido — e só deixa uma métrica AGREGADA por motivo
// (contador em memória: sem telefone, sem id, sem conteúdo).
//
// FAIL-CLOSED: qualquer dúvida (chat que não é direto, fromMe, falha de decrypt, stub, recovery, sem telefone real, telefone fora do roster, sem texto)
// ⇒ IGNORADO. O único caminho para INBOX é: cliente direto + LIVE/OFFLINE_NORMAL + telefone real + contato no roster + texto/mídia.
//
// NÃO toca o offline recovery: OFFLINE_RECOVERY nunca entra (a CHECK da tabela também o recusa). NÃO cria nada no outbox e NÃO dispara automação.

import { JID_TIPOS_CLIENTE } from "./inbound/inbound.contrato.js";
import * as rosterRepo from "./comunicacao.roster.js";
import * as inboxRepo from "./comunicacao.inbox.repo.js";

export const DESTINO = Object.freeze({ INBOX: "INBOX", IGNORADO: "IGNORADO" });
export const MOTIVOS_IGNORADO = Object.freeze([
  "chat_nao_direto", "from_me", "falha_decrypt", "stub_sistema", "recovery", "sem_telefone", "nao_autorizado", "sem_conteudo", "contrato_invalido",
]);

const contadores = new Map();
const contar = (motivo) => contadores.set(motivo, (contadores.get(motivo) ?? 0) + 1);

/** Métrica AGREGADA de eventos ignorados por motivo (sem telefone, sem id, sem conteúdo). Zera no restart. */
export function metricasInbox() {
  return { ignorados: Object.fromEntries(MOTIVOS_IGNORADO.map((m) => [m, contadores.get(m) ?? 0])), aceitos: contadores.get("_aceitos") ?? 0 };
}
/** Só para teste. */
export function _zerarMetricas() { contadores.clear(); }

const ignorar = (motivo) => { contar(motivo); return { destino: DESTINO.IGNORADO, motivo }; };

/**
 * @param {{organizacaoId: string, evento: object}} p `evento` = saída de validarEventoInbound (com tipoConteudo/texto opcionais)
 * @param {{supabase?: object, env?: object, roster?: {buscarAutorizadoPorTelefone: Function}, inbox?: {registrarMensagem: Function}}} [deps]
 * @returns {Promise<{destino: 'INBOX', contatoId: string, inserido: boolean} | {destino: 'IGNORADO', motivo: string}>}
 */
export async function processarInbound({ organizacaoId, evento }, deps = {}) {
  if (typeof organizacaoId !== "string" || organizacaoId === "" || evento === null || typeof evento !== "object") return ignorar("contrato_invalido");
  if (evento.fromMe !== false) return ignorar("from_me");
  if (evento.falhaDecrypt !== false) return ignorar("falha_decrypt");
  if (evento.stubSistema !== false) return ignorar("stub_sistema");
  if (!JID_TIPOS_CLIENTE.includes(evento.origemJidTipo)) return ignorar("chat_nao_direto");
  if (evento.origemTipo === "OFFLINE_RECOVERY") return ignorar("recovery");
  if (evento.origemTipo !== "LIVE" && evento.origemTipo !== "OFFLINE_NORMAL") return ignorar("contrato_invalido");
  if (typeof evento.telefoneE164 !== "string") return ignorar("sem_telefone");

  const tipoConteudo = evento.tipoConteudo ?? "outro";
  if (tipoConteudo !== "texto" && tipoConteudo !== "midia") return ignorar("sem_conteudo");

  const roster = deps.roster ?? rosterRepo;
  const contato = await roster.buscarAutorizadoPorTelefone(evento.telefoneE164, deps);
  if (!contato) return ignorar("nao_autorizado");

  const inbox = deps.inbox ?? inboxRepo;
  const r = await inbox.registrarMensagem({
    organizacaoId, contatoId: contato.contatoId, providerMessageId: evento.providerMessageId, origemTipo: evento.origemTipo,
    tipoConteudo, texto: tipoConteudo === "texto" ? evento.texto : null, recebidoEm: evento.recebidoEm, dias: inboxRepo.retencaoDias(deps.env ?? process.env),
  }, deps);
  contar("_aceitos");
  return { destino: DESTINO.INBOX, contatoId: contato.contatoId, inserido: r.inserido };
}
