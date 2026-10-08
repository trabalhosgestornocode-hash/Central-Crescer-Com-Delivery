// GRUPO INTERNO da operação ("Crescer Com Delivery - Central") — o ÚNICO destino em grupo do sistema. Exceção estreita aprovada:
// o Gateway só aceita o JID configurado nele (WHATSAPP_GRUPO_INTERNO_JID) e o backend só envia ao JID configurado AQUI (mesma env,
// mesmo valor — os dois lados precisam concordar). Nunca para cliente/franqueado: o grupo não é contato nem organização.
//
// IDEMPOTÊNCIA (migration 109, comunicacao_envios_grupo): UNIQUE(chave_idempotencia). Quem consegue o INSERT é o ÚNICO que chama o
// Gateway; duplo clique, retry, restart ou outra instância encontram a linha e NÃO enviam. Falha classificada como em
// comunicacao.entrega.js: pré-envio comprovado ⇒ FAILED (com motivo); qualquer dúvida ⇒ DELIVERY_UNKNOWN (nunca reenvio automático).
//
// Só passa pelo provider via WhatsAppService (kill switch + conta confirmada) — a invariante "Provider.send* só em whatsapp.service.js"
// continua valendo (test/comunicacao-arquitetura-provider.test.js).

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { classificarErroEnvio } from "./comunicacao.entrega.js";
import { CLASSIFICACAO_ERRO } from "./comunicacao.constants.js";
import { REGEX_JID_GRUPO } from "./providers/baileysGateway.provider.js";
import { ModoDesabilitadoError, IdentidadeNaoConfirmadaError } from "./whatsapp.service.js";

export const TABELA = "comunicacao_envios_grupo";
export const TIPO_ENVIO_GRUPO = Object.freeze({ TESTE: "TESTE_GRUPO", RELATORIO_DASHBOARD_IFOOD: "RELATORIO_DASHBOARD_IFOOD" });
export const STATUS_ENVIO_GRUPO = Object.freeze({
  PROCESSING: "PROCESSING", SENDING: "SENDING", SENT: "SENT", FAILED: "FAILED", DELIVERY_UNKNOWN: "DELIVERY_UNKNOWN",
});
/** Nome humano do grupo — só para exibição/conferência. O envio usa SEMPRE o JID persistente. */
export const NOME_GRUPO_INTERNO = "Crescer Com Delivery - Central";

/** JID do grupo interno configurado no backend, ou `null` (ausente ou fora do formato ⇒ nenhum envio a grupo). */
export function grupoInternoJidDoAmbiente(env = process.env) {
  const jid = String(env.WHATSAPP_GRUPO_INTERNO_JID ?? "").trim();
  return jid && REGEX_JID_GRUPO.test(jid) ? jid : null;
}

/** JID mascarado para log/UI resumida: só os 4 últimos dígitos (mesma regra do Gateway). */
export function mascararJidGrupo(jid) {
  const id = String(jid ?? "").split("@")[0].replace(/\D/g, "");
  return id ? `…${id.slice(-4)}@g.us` : null;
}

export const chaveTesteGrupo = (testeId) => `grupo_teste:${testeId}`;

/** Texto EXATO do teste controlado do grupo (nunca um relatório). */
export function textoTesteGrupo() {
  return [
    "🧪 TESTE DE AUTOMAÇÃO",
    "",
    "Crescer com Delivery",
    "",
    "Este é um teste do sistema de alertas do Dashboard iFood.",
    "",
    "Grupo configurado corretamente.",
    "",
    "Nenhuma ação é necessária.",
  ].join("\n");
}

/** Log estruturado com o prefixo pedido pela operação. Nunca conteúdo, telefone, JID inteiro ou credencial. */
export function logGrupo(nivel, evento, dados = {}) {
  const linha = JSON.stringify({ escopo: "[IFoodDashboardAlert]", evento, ...dados });
  (nivel === "error" ? console.error : nivel === "warn" ? console.warn : console.log)(linha);
}

/**
 * Motivo legível e ESTÁVEL de uma falha (vocabulário fechado; nunca a mensagem crua do provider).
 * @param {any} e
 */
export function motivoDaFalha(e) {
  if (e instanceof ModoDesabilitadoError) return "modo_whatsapp_desabilitado";
  if (e instanceof IdentidadeNaoConfirmadaError) return "conta_whatsapp_nao_confirmada";
  const m = String(e?.message ?? "");
  if (m.includes("WHATSAPP_GATEWAY_NOT_CONNECTED") || m.includes("BAILEYS_GATEWAY_UNREACHABLE") || m.includes("BAILEYS_GATEWAY_DISABLED")) return "whatsapp_gateway_unavailable";
  if (m.includes("WHATSAPP_GATEWAY_GROUP_NOT_AUTHORIZED")) return "grupo_nao_autorizado_no_gateway";
  if (m.includes("WHATSAPP_GATEWAY_GROUP_NOT_FOUND")) return "grupo_nao_encontrado";
  if (m.includes("WHATSAPP_GATEWAY_GROUP_SEND_FORBIDDEN")) return "grupo_sem_permissao_de_envio";
  if (m.includes("WHATSAPP_GATEWAY_GROUP_LOOKUP_FAILED")) return "consulta_grupo_falhou";
  if (m.includes("BAILEYS_GATEWAY_EFEITOS_EXTERNOS_BLOQUEADOS")) return "efeitos_externos_bloqueados";
  if (m.includes("BAILEYS_GATEWAY_INVALID_MESSAGE")) return "pedido_invalido";
  if (m.includes("BAILEYS_GATEWAY_TIMEOUT")) return "timeout_gateway";
  return "erro_envio";
}

// ---------------------------------------------------------------------------
// Repositório (service_role; RLS deny-all para anon/authenticated)
// ---------------------------------------------------------------------------

export async function obterPorChave(chave, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from(TABELA).select("*").eq("chave_idempotencia", chave).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  return data ?? null;
}

/** INSERT idempotente. `{criado: true}` só para quem venceu a UNIQUE — e só ele pode chamar o Gateway. */
async function reservar(linha, deps) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from(TABELA).insert(linha).select("*").single();
  if (!error && data) return { criado: true, envio: data };
  if (error && String(error.code) !== "23505") throw ApiError.internal(error.message);
  const existente = await obterPorChave(linha.chave_idempotencia, deps);
  if (!existente) throw ApiError.internal("envio ao grupo: nem criado nem encontrado");
  return { criado: false, envio: existente };
}

async function atualizar(id, campos, deps, { statusEsperado } = {}) {
  const db = deps.supabase ?? supabase;
  let q = db.from(TABELA).update(campos).eq("id", id);
  if (statusEsperado) q = q.eq("status", statusEsperado);
  const { data, error } = await q.select("*").maybeSingle();
  if (error) throw ApiError.internal(error.message);
  return data ?? null;
}

/** Últimos envios de um tipo (observabilidade do Painel). */
export async function listarUltimos({ tipo, limite = 10 } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  let q = db.from(TABELA).select("id, tipo, data_referencia, status, motivo, provider_message_id, resumo, tentativas, criado_em, enviado_em, falhou_em");
  if (tipo) q = q.eq("tipo", tipo);
  const { data, error } = await q.order("criado_em", { ascending: false }).limit(limite);
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Envio — UM provider call no máximo por chave
// ---------------------------------------------------------------------------

/**
 * Reserva (idempotente) e, SÓ se este chamador é o criador, envia UM texto ao grupo interno.
 * @param {{tipo: string, chave: string, grupoJid: string, conteudo: string, dataReferencia?: string|null, resumo?: object,
 *   criadoPor?: string|null, whatsAppService: {enviarTextoGrupoInterno: Function}}} p
 * @returns {Promise<{resultado: 'JA_EXISTIA'|'ENVIADO'|'FALHOU'|'ENTREGA_INCERTA', envio: object, motivo?: string}>}
 */
export async function enviarAoGrupoInterno({ tipo, chave, grupoJid, conteudo, dataReferencia = null, resumo = {}, criadoPor = null, whatsAppService }, deps = {}) {
  if (!REGEX_JID_GRUPO.test(String(grupoJid ?? ""))) throw ApiError.badRequest("Grupo interno não configurado.", { codigo: "GRUPO_NAO_CONFIGURADO" });
  const jidLog = mascararJidGrupo(grupoJid);
  const { criado, envio } = await reservar({
    tipo, chave_idempotencia: chave, grupo_jid: grupoJid, data_referencia: dataReferencia, conteudo, resumo, criado_por: criadoPor,
    status: STATUS_ENVIO_GRUPO.PROCESSING,
  }, deps);
  if (!criado) {
    logGrupo("info", "envio_ja_existia", { tipo, envioId: envio.id, status: envio.status });
    return { resultado: "JA_EXISTIA", envio };
  }

  // PROCESSING -> SENDING com guarda de status: só UM chamador passa daqui com esta linha.
  const emEnvio = await atualizar(envio.id, { status: STATUS_ENVIO_GRUPO.SENDING, tentativas: (envio.tentativas ?? 0) + 1 }, deps, { statusEsperado: STATUS_ENVIO_GRUPO.PROCESSING });
  if (!emEnvio) return { resultado: "JA_EXISTIA", envio: (await obterPorChave(chave, deps)) ?? envio };

  logGrupo("info", "envio_iniciado", { tipo, envioId: envio.id, grupo: jidLog });
  let r;
  try {
    r = await whatsAppService.enviarTextoGrupoInterno({ grupoJid, texto: conteudo, idempotencyKey: chave });
  } catch (e) {
    const classificacao = (e instanceof ModoDesabilitadoError || e instanceof IdentidadeNaoConfirmadaError) ? CLASSIFICACAO_ERRO.PERMANENTE : classificarErroEnvio(e);
    const incerto = classificacao === CLASSIFICACAO_ERRO.INCERTO;
    const motivo = motivoDaFalha(e);
    const status = incerto ? STATUS_ENVIO_GRUPO.DELIVERY_UNKNOWN : STATUS_ENVIO_GRUPO.FAILED;
    const final = await atualizar(envio.id, { status, motivo, falhou_em: new Date().toISOString() }, deps).catch((err) => {
      logGrupo("error", "registro_falha_nao_gravado", { envioId: envio.id, erro: String(err?.message ?? err).slice(0, 200) });
      return null;
    });
    logGrupo("error", "ERRO", { tipo, envioId: envio.id, status, motivo, classificacao, grupo: jidLog });
    return { resultado: incerto ? "ENTREGA_INCERTA" : "FALHOU", envio: final ?? { ...emEnvio, status, motivo }, motivo };
  }

  const providerMessageId = typeof r?.providerMessageId === "string" ? r.providerMessageId.slice(0, 200) : null;
  const nomeGrupo = typeof r?.grupo?.nome === "string" ? r.grupo.nome.slice(0, 120) : null;
  const final = await atualizar(envio.id, {
    status: STATUS_ENVIO_GRUPO.SENT, provider_message_id: providerMessageId, enviado_em: r?.enviadoEm ?? new Date().toISOString(),
    resumo: { ...(envio.resumo ?? {}), grupo_nome: nomeGrupo },
  }, deps).catch((err) => {
    // O envio JÁ aconteceu: a linha fica SENDING (nunca reenviada — a chave é única). Só o registro falhou.
    logGrupo("error", "envio_confirmado_registro_falhou", { envioId: envio.id, erro: String(err?.message ?? err).slice(0, 200) });
    return null;
  });
  logGrupo("info", "envio_concluido", { tipo, envioId: envio.id, messageId: providerMessageId, grupo: jidLog });
  return { resultado: "ENVIADO", envio: final ?? { ...emEnvio, status: STATUS_ENVIO_GRUPO.SENT, provider_message_id: providerMessageId } };
}
