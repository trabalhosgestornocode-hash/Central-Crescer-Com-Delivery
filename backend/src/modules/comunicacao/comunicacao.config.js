// Configuração central do módulo de Comunicação — LIDA de
// `comunicacao_configuracoes` (autoridade em runtime, editável pelo Painel
// Administrativo no Checkpoint D, sem redeploy). As constantes `_PADRAO`
// abaixo são só o valor de BOOTSTRAP: se a tabela ainda não tiver a linha
// (ambiente sem a migration 082 aplicada, ou linha apagada manualmente),
// o código não quebra — cai no default documentado aqui, nunca falha
// fechado silenciosamente para "permitir tudo".
//
// Mesmo espírito de config/limites.js#intEnv: valor sobrescrevível, nunca
// mágico espalhado pelo código.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import { MODOS } from "./comunicacao.constants.js";
import { DISPONIBILIDADE_IFOOD_PADRAO, disponibilidadeValida, normalizarDisponibilidade } from "./comunicacao.disponibilidade.js";

function intEnv(chave, padrao) {
  const v = Number(process.env[chave]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : padrao;
}

/** Bootstrap — só usado se a linha correspondente não existir na tabela. */
const PADRAO = Object.freeze({
  modo: MODOS.DISABLED, // NUNCA nasce ligado — decisão explícita liga.
  janelas: Object.freeze({
    seg_sex: { inicio: "08:00", fim: "18:00" },
    sab: { inicio: "08:00", fim: "13:00" },
    dom: null,
  }),
  cooldowns_horas: Object.freeze({
    atencao: intEnv("WHATSAPP_COOLDOWN_ATENCAO_HORAS", 8),
    critico: intEnv("WHATSAPP_COOLDOWN_CRITICO_HORAS", 4),
  }),
  limites: Object.freeze({
    // DUAS camadas, ambas precisam ter vaga: global (o único número/sessão) e por organização (fairness).
    // Por organização: 3/min (aprovado). Se a linha de configuração não trouxer a chave, vale este default.
    // Nenhum default deste arquivo liga comunicação: `modo` nasce DISABLED e a habilitação é fail-closed.
    max_proativas_por_minuto: intEnv("WHATSAPP_MAX_PROACTIVE_PER_MINUTE", 5),
    max_proativas_por_minuto_por_organizacao: intEnv("WHATSAPP_MAX_PROACTIVE_PER_MINUTE_PER_ORG", 3),
    max_por_contato_por_dia: intEnv("WHATSAPP_MAX_PER_CONTACT_PER_DAY", 3),
  }),
  // TTL da mensagem: expira_em = disponivel_em + ttl_horas (aviso velho nunca sai).
  ttl_horas: 24,
  // Disponibilidade dos dados do iFood (D-1) — ver comunicacao.disponibilidade.js. Configurável no Painel.
  disponibilidade_ifood: DISPONIBILIDADE_IFOOD_PADRAO,
  // Teto do jitter determinístico (espalha os envios na abertura da janela; nunca passa do fechamento).
  jitter_max_minutos: 30,
});

/**
 * Lê uma chave de configuração. Degrada para o default documentado se a
 * tabela/linha não existir — nunca lança por isso (config ausente não pode
 * derrubar o pipeline; ver REGRA DE OURO de shared/auditoria.js#auditar,
 * mesmo espírito aqui).
 * @param {'modo'|'janelas'|'cooldowns_horas'|'limites'|'ttl_horas'|'jitter_max_minutos'|'disponibilidade_ifood'} chave
 * @param {{supabase?: any}} [deps]
 */
export async function obterConfig(chave, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_configuracoes").select("valor").eq("chave", chave).maybeSingle();
  if (error || !data) return PADRAO[chave];
  return data.valor;
}

/** Número finito > 0, senão o padrão: um TTL/jitter corrompido nunca vira "sem expiração" nem espalhamento infinito. */
const positivoOuPadrao = (valor, padrao) => (typeof valor === "number" && Number.isFinite(valor) && valor > 0 ? valor : padrao);

/** TTL das mensagens (horas), já normalizado. @param {{supabase?: any}} [deps] */
export async function obterTtlHoras(deps = {}) {
  return positivoOuPadrao(await obterConfig("ttl_horas", deps), PADRAO.ttl_horas);
}

/** Teto do jitter determinístico em ms, já normalizado. @param {{supabase?: any}} [deps] */
export async function obterJitterMaxMs(deps = {}) {
  return positivoOuPadrao(await obterConfig("jitter_max_minutos", deps), PADRAO.jitter_max_minutos) * 60_000;
}

/** Horários de disponibilidade do iFood (D-1), normalizados: ausente/corrompido cai no PADRÃO (a espera nunca é desligada). */
export async function obterDisponibilidadeIfood(deps = {}) {
  return normalizarDisponibilidade(await obterConfig("disponibilidade_ifood", deps));
}

/** Altera os horários de disponibilidade do iFood — SEMPRE auditado; `envios_permitidos_apos` não pode ser anterior a `dados_disponiveis_apos`. */
export async function definirDisponibilidadeIfood({ dadosDisponiveisApos, enviosPermitidosApos }, { atorPerfilId = null, atorId = null } = {}, deps = {}) {
  const valor = { dados_disponiveis_apos: dadosDisponiveisApos, envios_permitidos_apos: enviosPermitidosApos };
  if (!disponibilidadeValida(valor)) {
    throw ApiError.badRequest("Horários inválidos: use HH:MM e mantenha o horário de envio igual ou posterior ao de disponibilidade dos dados.", { codigo: "DISPONIBILIDADE_INVALIDA" });
  }
  const db = deps.supabase ?? supabase;
  const anterior = await obterConfig("disponibilidade_ifood", deps);
  const { error } = await db.from("comunicacao_configuracoes")
    .upsert({ chave: "disponibilidade_ifood", valor, atualizado_em: new Date().toISOString(), atualizado_por: atorPerfilId }, { onConflict: "chave" });
  if (error) throw ApiError.internal(error.message);
  await auditar({
    acao: ACOES.CONFIG_ALTERADA, atorId, perfilId: atorPerfilId, entidade: "comunicacao_configuracoes", entidadeId: "disponibilidade_ifood",
    detalhes: { chave: "disponibilidade_ifood", de: anterior, para: valor },
  });
  return valor;
}

const MODOS_VALIDOS = new Set(Object.values(MODOS));

/**
 * Normaliza o valor lido de `modo`: qualquer coisa fora de MODOS (null,
 * número, string com aspas embutidas de uma dupla codificação JSON, valor
 * digitado à mão...) vira DISABLED. FAIL-CLOSED — nunca "provavelmente
 * NORMAL". A mesma allowlist existe em comunicacao.policy.js (defesa em
 * profundidade).
 * @param {unknown} valor
 */
export function normalizarModo(valor) {
  return MODOS_VALIDOS.has(/** @type {any} */ (valor)) ? /** @type {string} */ (valor) : MODOS.DISABLED;
}

/** @param {{supabase?: any}} [deps] */
export async function modoAtual(deps = {}) {
  return normalizarModo(await obterConfig("modo", deps));
}

/**
 * Troca o modo operacional — SEMPRE auditado (item obrigatório: o modo
 * controla se mensagem sai ou não, é a alavanca mais sensível do módulo).
 * @param {'NORMAL'|'REACTIVE_ONLY'|'DISABLED'} novoModo
 * @param {{atorPerfilId?: string|null, atorId?: string|null, motivo?: string}} contexto
 * @param {{supabase?: any}} [deps]
 */
export async function definirModo(novoModo, { atorPerfilId = null, atorId = null, motivo = null } = {}, deps = {}) {
  if (!Object.values(MODOS).includes(novoModo)) {
    throw ApiError.badRequest(`Modo inválido: ${novoModo}`, { codigo: "MODO_INVALIDO" });
  }
  const db = deps.supabase ?? supabase;
  const anterior = await obterConfig("modo", deps); // valor BRUTO — a auditoria mostra até um valor corrompido
  // `valor` é jsonb: o supabase-js já serializa a string para um jsonb
  // string. NÃO usar JSON.stringify aqui — isso gravava `"\"NORMAL\""`
  // (aspas embutidas), e como a política só comparava com DISABLED/
  // REACTIVE_ONLY, definirModo(DISABLED) NÃO desligava o envio (provado
  // contra banco real no D.3).
  const { error } = await db.from("comunicacao_configuracoes")
    .upsert({ chave: "modo", valor: novoModo, atualizado_em: new Date().toISOString(), atualizado_por: atorPerfilId }, { onConflict: "chave" });
  if (error) throw ApiError.internal(error.message);

  await auditar({
    acao: ACOES.CONFIG_ALTERADA,
    atorId,
    perfilId: atorPerfilId,
    entidade: "comunicacao_configuracoes",
    entidadeId: "modo",
    detalhes: { chave: "modo", de: anterior, para: novoModo, motivo },
  });
  return novoModo;
}
