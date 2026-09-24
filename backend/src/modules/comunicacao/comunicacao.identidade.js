// IDENTIDADE CONFIRMADA da conta do WhatsApp — módulo NEUTRO (sem dependência do Painel), usado por TODOS os caminhos que podem tirar uma mensagem do sistema:
// envio manual, teste controlado, worker/automação e a própria chamada ao provider (WhatsAppService).
//
// REGRA: só existe "confirmada" quando (a) o Gateway está CONECTADO com heartbeat fresco E (b) o número conectado tem o MESMO hash (sha256 do E.164 do JID) que o operador
// confirmou na aba Conexão. CONNECTED sozinho não basta. Qualquer dúvida (sem banco, sem organização, erro de leitura, hash diferente, conta pendente, QR, troca) ⇒ NÃO confirmada.
// A confirmação NÃO é um booleano solto: é o hash da conta concreta. Reiniciar a MESMA conta preserva; outra conta invalida (hash difere); desconectar zera.
import { createHash } from "node:crypto";
import { supabase } from "../../config/supabase.js";

export const INSTANCIA = "default";
export const HEARTBEAT_FRESCO_MS = 2 * 60_000;

const agoraDe = (deps) => (typeof deps.agora === "function" ? deps.agora() : new Date());
const envDe = (deps) => deps.env ?? process.env;
const orgId = (deps) => deps.organizacaoConexaoId ?? envDe(deps).WHATSAPP_GATEWAY_ORGANIZACAO_ID ?? null;
const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };

export const hashTelefone = (e164) => createHash("sha256").update(String(e164 ?? "")).digest("hex");

/**
 * Os 6 estados da UI a partir do que o Gateway diz AGORA (`live`) e do que o banco sabe (`db`). Sem o Gateway, só o banco conta — e um CONNECTED com heartbeat velho
 * vira DESCONECTADO (nunca "conectado" por inércia). WAITING_QR = conectando com QR à espera; RECONNECTING = conectando de novo depois de uma queda.
 * @param {{live?: object|null, db?: object|null, agora?: Date}} p
 * @returns {'CONNECTED'|'DISCONNECTED'|'CONNECTING'|'WAITING_QR'|'RECONNECTING'|'AUTH_ERROR'}
 */
export function derivarEstado({ live = null, db = null, agora = new Date() } = {}) {
  if (live && typeof live.status === "string") {
    if (live.status === "LOGGED_OUT") return "AUTH_ERROR";
    if (live.status === "CONNECTED") return "CONNECTED";
    if (live.status === "CONNECTING") return live.qrDisponivel ? "WAITING_QR" : live.reconectando ? "RECONNECTING" : "CONNECTING";
    return live.reconectando ? "RECONNECTING" : "DISCONNECTED";
  }
  const fresco = !!db?.last_seen_at && agora.getTime() - ms(db.last_seen_at) <= HEARTBEAT_FRESCO_MS;
  if (db?.status === "LOGGED_OUT") return "AUTH_ERROR";
  if (db?.status === "CONNECTED" && fresco) return "CONNECTED";
  if (db?.status === "CONNECTING" && fresco) return "CONNECTING";
  return "DISCONNECTED";
}

/** Situação da identidade: só CONFIRMADA quando o número conectado é EXATAMENTE o que o operador confirmou. */
export function statusIdentidade({ conectado, identidade, telefoneAtual }) {
  if (!conectado) return "SEM_CONTA";
  if (identidade?.status === "CONFIRMADA" && telefoneAtual && identidade.telefone_hash === hashTelefone(telefoneAtual)) return "CONFIRMADA";
  return "PENDENTE_CONFIRMACAO";
}

export async function lerConexaoDb(deps) {
  const org = orgId(deps); if (!org) return null;
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("whatsapp_conexoes")
    .select("status, telefone_e164, connected_at, disconnected_at, last_seen_at, lease_expires_at, gateway_version, last_error_class, desired_connection_state")
    .eq("organizacao_id", org).eq("provider_instance_id", INSTANCIA).maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

export async function lerIdentidade(deps) {
  const org = orgId(deps); if (!org) return null;
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("whatsapp_identidade").select("*").eq("organizacao_id", org).eq("provider_instance_id", INSTANCIA).maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

/** Resumo BARATO (só banco) para a Visão geral / Automações / gates. Nunca lança (erro ⇒ null ⇒ não confirmada). */
export async function resumoIdentidade(deps = {}) {
  try {
    const [dbCon, identidade] = await Promise.all([lerConexaoDb(deps), lerIdentidade(deps)]);
    const conectado = derivarEstado({ db: dbCon, agora: agoraDe(deps) }) === "CONNECTED";
    const st = statusIdentidade({ conectado, identidade, telefoneAtual: dbCon?.telefone_e164 });
    return { status: st, confirmada: st === "CONFIRMADA", ambiente: identidade?.ambiente ?? "TESTE", nomeOperacional: st === "CONFIRMADA" ? identidade?.nome_operacional ?? null : null };
  } catch { return null; }
}

/** Gate: a conta conectada É a que o operador confirmou? (só banco; fail-closed) */
export async function identidadeConfirmada(deps = {}) {
  const r = await resumoIdentidade(deps);
  return r?.confirmada === true;
}

/** Gate pronto para injetar no WhatsAppService (worker, teste controlado, envio manual). Sem organização/banco ⇒ sempre `false`. */
export function criarGateIdentidade(deps = {}) {
  return () => identidadeConfirmada(deps);
}
