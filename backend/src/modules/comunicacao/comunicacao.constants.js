// Vocabulário canônico do módulo de Comunicação (WhatsApp). Use estas
// constantes em vez de string solta — mesmo espírito de shared/auditoria.js#ACOES
// e shared/modulos.js#MODULOS.

/** Modo operacional global do canal. Lido/escrito via comunicacao.config.js. */
export const MODOS = Object.freeze({
  /** Alertas proativos + respostas — o modo pleno. */
  NORMAL: "NORMAL",
  /** Só responde quem escreveu primeiro. Nunca inicia conversa. */
  REACTIVE_ONLY: "REACTIVE_ONLY",
  /** Nenhuma comunicação sai nem é processada. */
  DISABLED: "DISABLED",
});

/** Severidade reaproveitada de administrativo.status.js#ROLLUP — nunca uma segunda classificação. */
export const SEVERIDADE = Object.freeze({
  ATENCAO: "atencao",
  CRITICO: "critico",
});

/** Ciclo de vida do ALERTA (a pendência + sua comunicação). */
export const STATUS_ALERTA = Object.freeze({
  DETECTED: "DETECTED",
  SCHEDULED: "SCHEDULED",
  PROCESSING: "PROCESSING",
  SENT: "SENT",
  DELIVERED: "DELIVERED",
  READ: "READ",
  RESPONDED: "RESPONDED",
  RESOLVED: "RESOLVED",
  CANCELLED: "CANCELLED",
  BLOCKED: "BLOCKED",
  FAILED: "FAILED",
});

/** Alertas nestes status não geram um novo alerta duplicado — ainda "ativos". */
export const STATUS_ALERTA_ATIVOS = Object.freeze(
  Object.values(STATUS_ALERTA).filter((s) => s !== STATUS_ALERTA.RESOLVED && s !== STATUS_ALERTA.CANCELLED)
);

/**
 * Ciclo de vida de UMA linha da fila (comunicacao_mensagens).
 *
 * SENDING e DELIVERY_UNKNOWN existem por causa de uma distinção que
 * importa muito quando o provider é externo (Checkpoint C+): idempotência
 * garante um único JOB LÓGICO, NÃO uma única ENTREGA FÍSICA no WhatsApp.
 * Se o processo morre bem no meio da chamada de envio ao provider, não sabemos
 * se a mensagem chegou. SENDING é gravado ANTES da chamada externa (rastro
 * durável); se o lease expirar nesse estado, vira DELIVERY_UNKNOWN — nunca
 * volta sozinho para SCHEDULED (isso seria reenvio cego).
 */
export const STATUS_MENSAGEM = Object.freeze({
  SCHEDULED: "SCHEDULED",
  PROCESSING: "PROCESSING",
  SENDING: "SENDING",
  SENT: "SENT",
  DELIVERED: "DELIVERED",
  READ: "READ",
  /** Lease de um SENDING expirou sem resolução — "não sei se enviou". Nunca retry automático. */
  DELIVERY_UNKNOWN: "DELIVERY_UNKNOWN",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  BLOCKED: "BLOCKED",
});

/**
 * Resultado que o dono do token de fencing grava ao FINALIZAR um envio
 * (comunicacao_finalizar_envio, migration 087). `RETRY` = falha PRÉ-ENVIO
 * comprovada -> SCHEDULED com backoff (ou FAILED se esgotou as tentativas).
 */
export const RESULTADO_FINAL_ENVIO = Object.freeze({
  SENT: "SENT",
  DELIVERY_UNKNOWN: "DELIVERY_UNKNOWN",
  FAILED: "FAILED",
  RETRY: "RETRY",
});

/** Destinos permitidos ao sair de PROCESSING sem enviar (comunicacao_encerrar_processamento). */
export const DESTINO_SEM_ENVIO = Object.freeze({
  BLOCKED: "BLOCKED",
  CANCELLED: "CANCELLED",
  FAILED: "FAILED",
  /** Adiamento de motivo transitório. */
  SCHEDULED: "SCHEDULED",
});

/**
 * Classificação de um erro de envio — decide se é seguro fazer retry
 * automático. Ver comunicacao.entrega.js#classificarErroEnvio.
 */
export const CLASSIFICACAO_ERRO = Object.freeze({
  /** Sabemos que NÃO chegou a sair (falhou antes do efeito externo) — retry seguro (se não for permanente). */
  RETRYAVEL: "RETRYAVEL",
  /** Sabemos que é definitivo (provider rejeitou de forma clara, ex.: número inválido) — nunca retry. */
  PERMANENTE: "PERMANENTE",
  /** NÃO sabemos se chegou (timeout/crash a meio da chamada) — nunca retry automático. */
  INCERTO: "INCERTO",
});

/**
 * Motivos de bloqueio do Policy Engine — vocabulário fechado. `allowed:
 * false` sempre vem acompanhado de um destes (nunca uma string livre).
 */
export const MOTIVOS_BLOQUEIO = Object.freeze({
  DISABLED: "DISABLED",
  /** `modo` ausente/desconhecido/corrompido — fail-closed, nunca "provavelmente NORMAL". */
  MODO_INVALIDO: "MODO_INVALIDO",
  REACTIVE_ONLY_BLOQUEIA_PROATIVO: "REACTIVE_ONLY_BLOQUEIA_PROATIVO",
  OPT_OUT: "OPT_OUT",
  /** Sem consentimento EXPLÍCITO (`consentimento === true`). Distinto de OPT_OUT: opt_out=false não é consentimento. */
  NO_CONSENT: "NO_CONSENT",
  NO_PHONE: "NO_PHONE",
  PHONE_NOT_VERIFIED: "PHONE_NOT_VERIFIED",
  USER_INACTIVE: "USER_INACTIVE",
  SEM_VINCULO: "SEM_VINCULO",
  CONTATO_AMBIGUO: "CONTATO_AMBIGUO",
  /** A empresa (organização) não está habilitada para WhatsApp proativo. */
  EMPRESA_DESABILITADA: "EMPRESA_DESABILITADA",
  /** O tipo deste alerta não está entre os permitidos para a empresa. */
  TIPO_NAO_PERMITIDO: "TIPO_NAO_PERMITIDO",
  PENDING_RESOLVED: "PENDING_RESOLVED",
  DUPLICATE: "DUPLICATE",
  COOLDOWN: "COOLDOWN",
  OUTSIDE_ALLOWED_WINDOW: "OUTSIDE_ALLOWED_WINDOW",
  RATE_LIMIT: "RATE_LIMIT",
  SAFE_MODE: "SAFE_MODE",
  PROVIDER_OFFLINE: "PROVIDER_OFFLINE",
});

/**
 * Motivos que podem DEIXAR de valer sozinhos (a janela abre, o cooldown
 * acaba, o Gateway reconecta, o operador religa o modo). Uma mensagem
 * bloqueada por eles NÃO pode virar BLOCKED terminal — é ADIADA (volta a
 * SCHEDULED com `disponivel_em` futuro). Todo o resto é decisão sobre o
 * DESTINATÁRIO/EMPRESA (opt-out, sem consentimento, sem vínculo, tipo não
 * autorizado...) que só uma ação humana muda -> BLOCKED terminal.
 */
export const MOTIVOS_BLOQUEIO_TRANSITORIOS = Object.freeze(new Set([
  MOTIVOS_BLOQUEIO.DISABLED,
  MOTIVOS_BLOQUEIO.MODO_INVALIDO,
  MOTIVOS_BLOQUEIO.REACTIVE_ONLY_BLOQUEIA_PROATIVO,
  MOTIVOS_BLOQUEIO.COOLDOWN,
  MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW,
  MOTIVOS_BLOQUEIO.RATE_LIMIT,
  MOTIVOS_BLOQUEIO.SAFE_MODE,
  MOTIVOS_BLOQUEIO.PROVIDER_OFFLINE,
]));

/** Bloqueio que pode passar sozinho? Motivo desconhecido -> `false` (terminal, o mais conservador). */
export const bloqueioEhTransitorio = (motivo) => MOTIVOS_BLOQUEIO_TRANSITORIOS.has(motivo);

/** Fase 1: único monitor ligado (ajuste aprovado — não generalizar ainda). */
export const TIPOS_ALERTA = Object.freeze({
  DASHBOARD_IFOOD_D1: "dashboard_ifood_d1",
});

/** Canais suportados pela fila (hoje só 'whatsapp' é usado). */
export const CANAIS = Object.freeze({ WHATSAPP: "whatsapp" });

/** Direção de uma linha de comunicacao_mensagens. */
export const DIRECAO = Object.freeze({ SAIDA: "saida", ENTRADA: "entrada" });
