// POLICY ENGINE — autoridade única sobre "este envio pode sair?".
//
// Função PURA (sem I/O): recebe um SNAPSHOT já resolvido pelo chamador
// (fila.service.js) e devolve {allowed, reason}. Nunca lê banco, nunca
// decide sozinha o que consultar — isso garante que TODO o vocabulário de
// bloqueio (MOTIVOS_BLOQUEIO) é testável com objetos simples, sem mock de
// Supabase. Mesmo espírito de administrativo.status.js.
//
// INVARIANTE (ajuste aprovado): nenhum envio sai sem passar por
// `avaliarEnvio`. whatsapp.service.js é o ÚNICO chamador do Provider, e só
// é chamado depois de `avaliarEnvio` devolver `allowed: true` — ver
// comunicacao.alertas.service.js#processarProximoLote e o teste
// arquitetural em test/comunicacao-arquitetura-provider.test.js.

import { MODOS, MOTIVOS_BLOQUEIO } from "./comunicacao.constants.js";

/**
 * @typedef {object} SnapshotEnvio
 * @property {string} modo                  MODOS.NORMAL | REACTIVE_ONLY | DISABLED
 * @property {boolean} ehProativo            true = iniciado pelo sistema (alerta); false = resposta a mensagem recebida
 * @property {boolean} contatoExiste         há um contato resolvido?
 * @property {boolean} [telefoneVerificado]  contato.verificado
 * @property {boolean} [optOut]              contato.opt_out
 * @property {boolean} destinatarioAtivo     o perfil destinatário está ativo?
 * @property {boolean} vinculoValido         o destinatário pertence à organização/unidade deste envio?
 * @property {boolean} pendenciaAindaExiste  a pendência que originou o alerta ainda é real (revalidada)?
 * @property {boolean} duplicado             já existe um envio ativo equivalente?
 * @property {boolean} cooldownAtivo         dentro do período de cooldown do tipo de alerta?
 * @property {boolean} dentroDaJanela        agora está dentro do horário comercial permitido?
 * @property {boolean} rateLimitExcedido     estourou algum limite de taxa (por minuto/por contato/dia)?
 * @property {boolean} providerConectado     o WhatsAppService reporta conexão ativa?
 * @property {boolean} [modoSeguro]          circuito de segurança ativo (Checkpoint C+, opcional)
 */

/**
 * @param {SnapshotEnvio} s
 * @returns {{allowed: boolean, reason: string|null}}
 */
export function avaliarEnvio(s) {
  const bloqueado = (reason) => ({ allowed: false, reason });

  if (s.modo === MODOS.DISABLED) return bloqueado(MOTIVOS_BLOQUEIO.DISABLED);
  if (s.modo === MODOS.REACTIVE_ONLY && s.ehProativo) return bloqueado(MOTIVOS_BLOQUEIO.REACTIVE_ONLY_BLOQUEIA_PROATIVO);

  if (!s.contatoExiste) return bloqueado(MOTIVOS_BLOQUEIO.NO_PHONE);
  if (s.optOut) return bloqueado(MOTIVOS_BLOQUEIO.OPT_OUT);
  if (s.telefoneVerificado === false) return bloqueado(MOTIVOS_BLOQUEIO.PHONE_NOT_VERIFIED);
  if (!s.destinatarioAtivo) return bloqueado(MOTIVOS_BLOQUEIO.USER_INACTIVE);
  if (!s.vinculoValido) return bloqueado(MOTIVOS_BLOQUEIO.SEM_VINCULO);

  // Proativo (alerta) só faz sentido se a pendência que o originou ainda existir.
  if (s.ehProativo && s.pendenciaAindaExiste === false) return bloqueado(MOTIVOS_BLOQUEIO.PENDING_RESOLVED);

  if (s.duplicado) return bloqueado(MOTIVOS_BLOQUEIO.DUPLICATE);
  if (s.cooldownAtivo) return bloqueado(MOTIVOS_BLOQUEIO.COOLDOWN);
  if (!s.dentroDaJanela) return bloqueado(MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW);
  if (s.rateLimitExcedido) return bloqueado(MOTIVOS_BLOQUEIO.RATE_LIMIT);
  if (s.modoSeguro) return bloqueado(MOTIVOS_BLOQUEIO.SAFE_MODE);
  if (!s.providerConectado) return bloqueado(MOTIVOS_BLOQUEIO.PROVIDER_OFFLINE);

  return { allowed: true, reason: null };
}
