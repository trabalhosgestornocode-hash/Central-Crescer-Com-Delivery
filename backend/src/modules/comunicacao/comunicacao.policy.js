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
//
// FAIL-CLOSED (D.3-C): a política só LIBERA quando cada condição exigida é
// EXATAMENTE o valor esperado (`=== true` / `=== false`). Campo ausente,
// `null`, `undefined` ou de tipo inesperado BLOQUEIA — nunca é lido como
// "provavelmente ok". `modo` é uma allowlist: qualquer valor fora de MODOS
// bloqueia. `ehProativo` que não é literalmente `false` é tratado como
// PROATIVO (o caso mais restritivo).

import { MODOS, MOTIVOS_BLOQUEIO, bloqueioEhTransitorio } from "./comunicacao.constants.js";

const MODOS_VALIDOS = new Set(Object.values(MODOS));

/**
 * @typedef {object} SnapshotEnvio
 * @property {string} modo                  MODOS.NORMAL | REACTIVE_ONLY | DISABLED (qualquer outro valor bloqueia)
 * @property {boolean} ehProativo            true = iniciado pelo sistema (alerta); false = resposta a mensagem recebida
 * @property {boolean} contatoExiste         há um contato resolvido?
 * @property {boolean} telefoneVerificado    contato.verificado (obrigatório === true)
 * @property {boolean} optOut                contato.opt_out (obrigatório === false)
 * @property {boolean} consentimento         contato.consentimento (PROATIVO exige === true; opt_out=false NÃO é consentimento)
 * @property {boolean} destinatarioAtivo     o perfil destinatário está ativo?
 * @property {boolean} vinculoValido         o destinatário pertence à organização/unidade deste envio?
 * @property {boolean} empresaHabilitada     a organização está habilitada para WhatsApp proativo? (PROATIVO exige === true)
 * @property {boolean} tipoPermitido         o tipo deste alerta é permitido para a organização? (PROATIVO exige === true)
 * @property {boolean} empresaPausada        a organização está em pausa (`pausado_ate` no futuro)? (PROATIVO exige === false)
 * @property {boolean} configHorarioValida   timezone IANA e janelas da organização válidos? (exige === true, proativo ou não; inválido = CONFIG_INVALIDA)
 * @property {boolean} pendenciaAindaExiste  a pendência que originou o alerta ainda é real (revalidada)?
 * @property {boolean} duplicado             já existe um envio ativo equivalente?
 * @property {boolean} cooldownAtivo         dentro do período de cooldown do tipo de alerta? (o service pode passar false: a decisão AUTORITATIVA é atômica em comunicacao_reservar_envio -> COOLDOWN)
 * @property {boolean} dentroDaJanela        agora está dentro do horário comercial permitido?
 * @property {boolean} rateLimitExcedido     estourou algum limite de taxa (por minuto/por contato/dia)? (idem: o consumo de capacidade é decidido atomicamente em comunicacao_reservar_envio -> RATE_LIMIT_*)
 * @property {boolean} providerConectado     o WhatsAppService reporta conexão ativa?
 * @property {boolean} [modoSeguro]          circuito de segurança ativo (opcional: só `true` bloqueia — o circuito ainda não existe)
 */

/**
 * @param {SnapshotEnvio} s
 * @returns {{allowed: boolean, reason: string|null}}
 */
export function avaliarEnvio(s) {
  const bloqueado = (reason) => ({ allowed: false, reason });

  // --- modo: allowlist (nunca fail-open para um valor que não conhecemos) ---
  if (!MODOS_VALIDOS.has(s?.modo)) return bloqueado(MOTIVOS_BLOQUEIO.MODO_INVALIDO);
  if (s.modo === MODOS.DISABLED) return bloqueado(MOTIVOS_BLOQUEIO.DISABLED);
  const proativo = s.ehProativo !== false;
  if (s.modo === MODOS.REACTIVE_ONLY && proativo) return bloqueado(MOTIVOS_BLOQUEIO.REACTIVE_ONLY_BLOQUEIA_PROATIVO);

  // --- destinatário: exige o valor esperado EXATO ---
  if (s.contatoExiste !== true) return bloqueado(MOTIVOS_BLOQUEIO.NO_PHONE);
  if (s.optOut !== false) return bloqueado(MOTIVOS_BLOQUEIO.OPT_OUT);
  if (s.telefoneVerificado !== true) return bloqueado(MOTIVOS_BLOQUEIO.PHONE_NOT_VERIFIED);
  // Consentimento é condição PRÓPRIA, distinta de opt-out: quem nunca disse
  // "pare" mas também nunca disse "pode" NÃO recebe mensagem proativa.
  if (proativo && s.consentimento !== true) return bloqueado(MOTIVOS_BLOQUEIO.NO_CONSENT);
  if (s.destinatarioAtivo !== true) return bloqueado(MOTIVOS_BLOQUEIO.USER_INACTIVE);
  if (s.vinculoValido !== true) return bloqueado(MOTIVOS_BLOQUEIO.SEM_VINCULO);

  // --- empresa/tipo: ter o telefone cadastrado não habilita ninguém ---
  if (proativo && s.empresaHabilitada !== true) return bloqueado(MOTIVOS_BLOQUEIO.EMPRESA_DESABILITADA);
  if (proativo && s.tipoPermitido !== true) return bloqueado(MOTIVOS_BLOQUEIO.TIPO_NAO_PERMITIDO);
  // habilitado=true não basta: a empresa não pode estar em pausa (`pausado_ate` no futuro -> ADIAMENTO,
  // nunca BLOCKED permanente; a pausa vencida volta sozinha à elegibilidade).
  if (proativo && s.empresaPausada !== false) return bloqueado(MOTIVOS_BLOQUEIO.EMPRESA_PAUSADA);

  // Proativo (alerta) só faz sentido se a pendência que o originou ainda existir.
  if (proativo && s.pendenciaAindaExiste !== true) return bloqueado(MOTIVOS_BLOQUEIO.PENDING_RESOLVED);

  if (s.duplicado !== false) return bloqueado(MOTIVOS_BLOQUEIO.DUPLICATE);
  if (s.cooldownAtivo !== false) return bloqueado(MOTIVOS_BLOQUEIO.COOLDOWN);
  // timezone/janelas inválidos: fail-closed (nunca UTC por omissão). Vale para proativo E reativo, pois
  // `dentroDaJanela` só é confiável se o horário da organização foi resolvido. Transitório: corrigir a config destrava.
  if (s.configHorarioValida !== true) return bloqueado(MOTIVOS_BLOQUEIO.CONFIG_INVALIDA);
  if (s.dentroDaJanela !== true) return bloqueado(MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW);
  if (s.rateLimitExcedido !== false) return bloqueado(MOTIVOS_BLOQUEIO.RATE_LIMIT);
  if (s.modoSeguro === true) return bloqueado(MOTIVOS_BLOQUEIO.SAFE_MODE);
  if (s.providerConectado !== true) return bloqueado(MOTIVOS_BLOQUEIO.PROVIDER_OFFLINE);

  return { allowed: true, reason: null };
}

export { bloqueioEhTransitorio };
