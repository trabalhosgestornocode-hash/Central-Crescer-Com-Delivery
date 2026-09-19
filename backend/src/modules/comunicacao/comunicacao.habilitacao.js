// Habilitação de WhatsApp PROATIVO por empresa (organização) e por tipo de
// alerta — a segunda metade do "fail-closed" (a primeira é o consentimento por
// CONTATO, em comunicacao.policy.js). Lê `comunicacao_habilitacoes` (migration
// 088), UMA linha por organização.
//
// FAIL-CLOSED ABSOLUTO — a resposta só abre com prova explícita:
//   * sem `organizacaoId`            -> fechada (NUNCA há fallback global: a habilitação
//                                        da organização A jamais vale para a B)
//   * sem linha                      -> fechada
//   * `habilitado !== true`          -> fechada
//   * habilitada mas SEM timezone    -> registro incompleto -> fechada
//   * habilitada mas SEM destinatário EXPLÍCITO (contato + perfil) -> fechada. Contato
//                                       cadastrado/verificado/consentido NÃO é destinatário
//                                       operacional: só o que foi configurado aqui.
//   * tipo fora de `tipos_permitidos`-> tipoPermitido=false
//   * erro ao ler o banco            -> o erro PROPAGA (não vira "desabilitada": um erro de
//                                        rede não pode transformar a mensagem em BLOCKED terminal)
//   * timezone presente mas INVÁLIDO / janelas próprias inválidas
//                                    -> configHorarioValida=false (a política ADIA com
//                                        CONFIG_INVALIDA; nunca assume UTC em silêncio)
//   * `pausado_ate` no futuro        -> empresaPausada=true (a política ADIA até lá;
//                                        não é BLOCKED permanente)
// `habilitado=true` sozinho NÃO basta: modo, consentimento, verificação, opt-out,
// tipo, janela, cooldown e cota continuam sendo avaliados pela política/reserva.
//
// DESTINATÁRIO (V1): pertence à ORGANIZAÇÃO. Uma organização multiunidade usa o MESMO
// destinatário para os alertas de todas as suas unidades; nada seleciona contato por unidade.
// "Override por unidade" seria uma feature explícita futura. Nenhum default aqui ativa
// comunicação sozinho: sem linha/sem habilitado/sem destinatário/timezone inválido = fechado.
//
// `processarProximoLote` recebe esta função por injeção (como
// `verificarPendenciaAindaExiste`) — os testes injetam uma habilitação explícita.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { timezoneValido, janelasValidas } from "./comunicacao.horario.js";

/**
 * @typedef {object} Habilitacao
 * @property {boolean} empresaHabilitada    a empresa optou por receber WhatsApp proativo (e o registro está completo)?
 * @property {boolean} tipoPermitido        este tipo de alerta está entre os permitidos dela?
 * @property {boolean} empresaPausada       há uma pausa temporária ativa (`pausado_ate` > agora)?
 * @property {Date|null} pausadoAte         fim da pausa (só se ativa)
 * @property {string|null} pausadoMotivo    auditoria/UX apenas — nunca decide nada
 * @property {string|null} destinatarioContatoId  contato do destinatário EXPLICITAMENTE configurado (null = nenhum)
 * @property {string|null} destinatarioPerfilId   perfil operacional do destinatário configurado
 * @property {string|null} timezone         IANA da organização (null se ausente)
 * @property {object|null} janelas          janelas PRÓPRIAS da organização (null = usa a config global)
 * @property {boolean} configHorarioValida  timezone IANA reconhecido e janelas próprias (se houver) válidas
 * @property {string}  fonte                de onde veio a decisão (diagnóstico/auditoria)
 */

/** @returns {Habilitacao} */
function fechada(fonte, extra = {}) {
  return {
    empresaHabilitada: false, tipoPermitido: false, empresaPausada: false, pausadoAte: null, pausadoMotivo: null,
    destinatarioContatoId: null, destinatarioPerfilId: null,
    timezone: null, janelas: null, configHorarioValida: false, fonte, ...extra,
  };
}

/**
 * Interpreta a linha de `comunicacao_habilitacoes` — função PURA (testável sem banco).
 * @param {object|null|undefined} linha
 * @param {string} tipoAlerta
 * @param {Date} agora
 * @returns {Habilitacao}
 */
export function interpretarHabilitacao(linha, tipoAlerta, agora = new Date()) {
  if (!linha || typeof linha !== "object") return fechada("SEM_REGISTRO");
  if (linha.habilitado !== true) return fechada("NAO_HABILITADA");

  const tz = typeof linha.timezone === "string" ? linha.timezone.trim() : "";
  if (!tz) return fechada("REGISTRO_INCOMPLETO_SEM_TIMEZONE");
  // sem destinatário EXPLÍCITO não há para quem enviar: fail-closed (o banco também barra: CHECK).
  const contatoId = typeof linha.destinatario_contato_id === "string" && linha.destinatario_contato_id ? linha.destinatario_contato_id : null;
  const perfilId = typeof linha.destinatario_perfil_id === "string" && linha.destinatario_perfil_id ? linha.destinatario_perfil_id : null;
  if (!contatoId || !perfilId) return fechada("REGISTRO_INCOMPLETO_SEM_DESTINATARIO");

  const tipos = Array.isArray(linha.tipos_permitidos) ? linha.tipos_permitidos : [];
  const janelasProprias = linha.janelas ?? null;
  const janelasOk = janelasProprias === null || janelasValidas(janelasProprias);

  const ate = linha.pausado_ate ? new Date(linha.pausado_ate) : null;
  // data ilegível em `pausado_ate` = pausa que não sabemos quando acaba -> trata como ATIVA (fail-closed).
  const pausaIlegivel = ate !== null && Number.isNaN(ate.getTime());
  const pausaAtiva = pausaIlegivel || (ate !== null && ate.getTime() > agora.getTime());

  return {
    empresaHabilitada: true,
    tipoPermitido: typeof tipoAlerta === "string" && tipoAlerta.length > 0 && tipos.includes(tipoAlerta),
    empresaPausada: pausaAtiva,
    pausadoAte: pausaAtiva && !pausaIlegivel ? ate : null,
    pausadoMotivo: linha.pausado_motivo ?? null,
    destinatarioContatoId: contatoId,
    destinatarioPerfilId: perfilId,
    timezone: tz,
    janelas: janelasOk ? janelasProprias : null,
    configHorarioValida: timezoneValido(tz) && janelasOk,
    fonte: "comunicacao_habilitacoes",
  };
}

/**
 * Janelas EFETIVAS de uma organização: as próprias (se houver) ou as globais.
 * Devolve `null` se não há uma janela válida — o chamador trata como CONFIG_INVALIDA.
 * @param {Habilitacao} habilitacao
 * @param {object} janelasGlobais
 * @returns {object|null}
 */
export function janelasEfetivas(habilitacao, janelasGlobais) {
  if (!habilitacao?.configHorarioValida) return null;
  const j = habilitacao.janelas ?? janelasGlobais;
  return janelasValidas(j) ? j : null;
}

/**
 * @param {{organizacaoId: string, tipoAlerta: string, agora?: Date}} params
 * @param {{supabase?: any}} [deps]
 * @returns {Promise<Habilitacao>}
 */
export async function resolverHabilitacaoEmpresa({ organizacaoId, tipoAlerta, agora = new Date() } = {}, deps = {}) {
  if (!organizacaoId || typeof organizacaoId !== "string") return fechada("SEM_ORGANIZACAO");
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_habilitacoes")
    .select("organizacao_id, habilitado, tipos_permitidos, timezone, janelas, pausado_ate, pausado_motivo, destinatario_contato_id, destinatario_perfil_id")
    .eq("organizacao_id", organizacaoId) // SEMPRE escopado à organização: sem fallback global
    .maybeSingle();
  // Falha de LEITURA (rede/PostgREST) NÃO é "empresa desabilitada": fechar aqui viraria um
  // BLOCKED terminal por um erro transitório e a mensagem se perderia em silêncio. O erro
  // PROPAGA — o job vira ERRO_INTERNO, o lease expira e ele é reprocessado. Nada é enviado
  // nesse meio-tempo (o provider só é chamado depois da política), então segue fail-closed.
  if (error) throw ApiError.internal(error.message);
  // defesa em profundidade: a linha devolvida tem de ser desta organização.
  if (data && data.organizacao_id !== organizacaoId) return fechada("REGISTRO_DE_OUTRA_ORGANIZACAO");
  return interpretarHabilitacao(data, tipoAlerta, agora);
}
