// Configuração do Gateway. Tudo por variável de ambiente — nenhum segredo
// hardcoded, nenhuma URL de produção fixa no código.
//
// REGRA DURA (Checkpoint C0/C1): este processo NUNCA recebe
// SUPABASE_SERVICE_ROLE_KEY nem qualquer credencial equivalente. Ele só
// conhece a URL do backend e os próprios segredos do protocolo interno.
// Ver test/config-sem-service-role.test.js e
// test/seguranca-sem-supabase.test.js para a verificação executável disso.

// Checkpoint G.2.0 — parse NÃO permissivo (nunca `Number(env) || default`) para os caps do motor de
// OFFLINE_RECOVERY abaixo. Ausente ou vazio (após trim) ⇒ `undefined` — mesmo tratamento que os outros flags deste
// arquivo já dão a env vazia (ver offlineRecoveryHabilitado/offlineObserveHabilitado acima: string vazia cai no
// padrão, nunca é tratada como valor explícito). Qualquer OUTRO texto que não seja uma sequência de dígitos
// (negativo, decimal, texto, notação científica) vira `NaN`, que validarConfig() abaixo rejeita com o NOME da env
// errada — nunca cai silenciosamente num default quando o valor foi fornecido só que está errado.
function numeroInteiroEnvOuIndefinido(bruto) {
  if (bruto === undefined) return undefined;
  const texto = String(bruto).trim();
  if (texto === "") return undefined;
  return /^\d+$/.test(texto) ? Number(texto) : NaN;
}

// Checkpoint G.3.3 — teto ABSOLUTO que o backend aceita para a mesma env (mesmo valor, mesmo nome, de propósito —
// ver item 8 do checkpoint), replicado aqui SÓ como constante de validação (não há chamada de rede nova entre os
// processos). Fonte: backend/src/modules/comunicacao/gateway/whatsappGateway.bootstrap.js#LIMITE_AUTH_STATE_TETO_BYTES
// (4 MiB, `Math.min` sobre o valor configurado). Duplicado de propósito, mesmo padrão já usado pelo teto de lease
// (LEASE_TTL_MAX_MS, migration 084): o Gateway falha no boot com a MESMA regra que o backend aplicaria de qualquer
// forma, em vez de deixar o recovery acreditar ter mais espaço do que a rota `/eventos/auth-state` jamais aceitaria.
const AUTH_STATE_CAPACIDADE_TETO_BYTES = 4 * 1024 * 1024;

export const config = {
  // O Render injeta PORT; 8080 é o padrão de qualquer serviço aqui.
  porta: Number(process.env.PORT) || 8080,

  // URL do backend Crescer (para as chamadas Gateway -> Backend: eventos,
  // heartbeat, auth-state). Nunca aponta para Supabase.
  backendUrl: (process.env.WHATSAPP_BACKEND_URL ?? "").replace(/\/+$/, ""),

  // Segredo do HMAC (mesmo segredo assina as duas direções — Backend->Gateway
  // e Gateway->Backend — porque é a mesma fronteira de confiança). O processo
  // RECUSA subir sem ele.
  segredoHmac: process.env.WHATSAPP_GATEWAY_SECRET,

  // Chave de cifra do auth state (AES-256-GCM, 32 bytes em base64 ou hex).
  // DIFERENTE do segredo HMAC — domínios de falha distintos (ver
  // src/crypto.js). Só existe aqui; o backend nunca a recebe.
  chaveEncriptacaoAuthState: process.env.WHATSAPP_AUTH_ENCRYPTION_KEY,

  timeoutBackendMs: Number(process.env.WHATSAPP_BACKEND_TIMEOUT_MS ?? 15_000),
  limiteCorpoBytes: Number(process.env.WHATSAPP_MAX_BODY_BYTES ?? 256 * 1024),

  // Heartbeat para o backend — ver src/baileysSession.js.
  heartbeatMs: Number(process.env.WHATSAPP_HEARTBEAT_MS ?? 30_000),

  // Backoff de reconexão do socket Baileys.
  reconnect: {
    baseMs: Number(process.env.WHATSAPP_RECONNECT_BASE_MS ?? 1_000),
    tetoMs: Number(process.env.WHATSAPP_RECONNECT_TETO_MS ?? 60_000),
  },

  // Checkpoint C3.5-C.9.1 — telemetria ESTRUTURAL do auth state (evento `auth_state.metricas`:
  // só nomes de categoria, contagens e bytes). DESLIGADA por padrão; só liga com valor
  // explícito. NÃO controla a guarda de log da libsignal (essa é segurança e sempre ativa).
  metricasAuthHabilitadas: /^(1|true|yes|on)$/i.test(String(process.env.WHATSAPP_AUTH_METRICS_ENABLED ?? "").trim()),

  // Checkpoint C3.5-C.9.3 — escopo de INBOUND. ALL_SUPPORTED (padrão) = comportamento anterior; DIRECT_ONLY ignora
  // grupos/status/broadcast/newsletter ANTES de decifrar (chat direto sempre passa). Valor inválido cai no padrão e é
  // avisado no boot (server.js). Ver src/inboundScope.js.
  inboundEscopoBruto: process.env.WHATSAPP_INBOUND_SCOPE,
  // Contadores SANITIZADOS por tipo de JID (evento `inbound.contadores`). Desligado por padrão.
  inboundDiagHabilitado: /^(1|true|yes|on)$/i.test(String(process.env.WHATSAPP_INBOUND_DIAG_ENABLED ?? "").trim()),
  // Checkpoint C3.5-C.9.6 — observador da fila offline (máquina de estados DIAGNÓSTICA + watchdog em modo OBSERVE: nunca faz flush, nunca
  // altera mensagens). Só age com o diagnóstico acima LIGADO; ligado por padrão nesse caso. Kill-switch explícito: 0/false/no/off.
  offlineObserveHabilitado: !/^(0|false|no|off)$/i.test(String(process.env.WHATSAPP_OFFLINE_OBSERVE_ENABLED ?? "").trim()),
  // Checkpoint G — motor de OFFLINE_RECOVERY (src/offlineRecovery.js). NASCE DESLIGADO (o oposto do observador
  // acima): só age com um valor explícito ligando. Enquanto desligado, o comportamento é idêntico ao de f4720cb
  // (Checkpoint F) — ver a suíte de não-interferência em test/offlineRecoveryIntegracao.test.js. Só tem efeito
  // com offlineObserveHabilitado E o diagnóstico LIGADOS (ver src/inboundScope.js).
  offlineRecoveryHabilitado: /^(1|true|yes|on)$/i.test(String(process.env.WHATSAPP_OFFLINE_RECOVERY_ENABLED ?? "").trim()),
  // Checkpoint G.0.1 — Partes M-O: percentual do limite local de 1 MiB que o recovery aceita usar do auth-state
  // (src/authHeadroom.js). O Gateway NUNCA lê o limite real do backend (WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES
  // é config/segredo do OUTRO processo) — só uma referência conservadora própria. Default 85%: a baseline
  // conhecida (~72-73%) fica com margem para o crescimento observado entre reconexões sem tornar o recovery
  // impraticável; ver o racional completo no relatório do checkpoint.
  offlineRecoveryAuthMaxUsagePct: Number(process.env.WHATSAPP_OFFLINE_RECOVERY_AUTH_MAX_USAGE_PCT ?? 85),
  // Checkpoint G.3.3 — capacidade lógica de auth-state que o Gateway usa como referência para o headroom do
  // recovery (src/authHeadroom.js). MESMO NOME de env do backend (WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES —
  // whatsappGateway.bootstrap.js), de propósito: não há chamada nova entre os processos, então as duas envs
  // precisam ser configuradas ATOMICAMENTE para o mesmo valor (documentado; ver o relatório do checkpoint). Ausente
  // ⇒ `undefined` ⇒ authHeadroom.js usa seu próprio default de 1 MiB (LIMITE_BYTES_1MIB), idêntico ao
  // comportamento de antes deste checkpoint. NÃO é uma "cura" do crescimento do auth-state — só alinha a
  // referência do Gateway à capacidade real que o backend já aceitar.
  authStateCapacidadeBytes: numeroInteiroEnvOuIndefinido(process.env.WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES),
  // Checkpoint G.0.1 (Partes C-J) — nº máximo de chamadas a notificarMensagemRecebida em voo ao mesmo tempo (fila
  // local, src/filaConcorrenciaLimitada.js). Default 4: testado com backend falso rápido/lento/intermitente em
  // 1/2/4/8 (ver test/filaConcorrenciaLimitada.test.js) — nunca validado contra o backend REAL sob carga; ajustar
  // aqui sem precisar de deploy de código caso a telemetria de produção (`backend.chamada`, `notificar_mensagem_recebida.falhou`) peça.
  backendNotifyConcurrency: Number(process.env.WHATSAPP_BACKEND_NOTIFY_CONCURRENCY ?? 4),

  // Checkpoint G.2.0 — caps do motor de OFFLINE_RECOVERY (src/offlineRecovery.js, INALTERADO por este checkpoint),
  // agora OPCIONALMENTE configuráveis por env. Cada campo ausente/vazio fica `undefined`: server.js espalha este
  // objeto sobre o `offlineRecovery` passado a criarInboundGateway, e um valor `undefined` num destructuring com
  // default (a assinatura de criarMotorRecovery) se comporta EXATAMENTE como a chave nem existir — ou seja, sem
  // nenhuma destas 5 envs, o comportamento é idêntico ao de 963ffd4 (quando elas nem existiam). Ver
  // test/config.test.js e test/offlineRecoveryCapsWiring.test.js para a prova de equivalência. `tickMs` NÃO é
  // exposto por env neste checkpoint (fora de escopo) — continua só o default interno do motor.
  offlineRecoveryLimites: {
    maxRecoveryBatches: numeroInteiroEnvOuIndefinido(process.env.WHATSAPP_OFFLINE_RECOVERY_MAX_BATCHES),
    maxRecoveryNodes: numeroInteiroEnvOuIndefinido(process.env.WHATSAPP_OFFLINE_RECOVERY_MAX_NODES),
    maxRecoveryDurationMs: numeroInteiroEnvOuIndefinido(process.env.WHATSAPP_OFFLINE_RECOVERY_MAX_DURATION_MS),
    maxConsecutiveNoProgressBatches: numeroInteiroEnvOuIndefinido(process.env.WHATSAPP_OFFLINE_RECOVERY_MAX_NO_PROGRESS_BATCHES),
    batchQuietMs: numeroInteiroEnvOuIndefinido(process.env.WHATSAPP_OFFLINE_RECOVERY_BATCH_QUIET_MS),
  },

  gatewayVersion: process.env.npm_package_version ?? "0.1.0",
  providerInstanceId: process.env.WHATSAPP_PROVIDER_INSTANCE_ID ?? "default",

  // Lease/fencing (Checkpoint C3.5) — single owner da sessão entre
  // instâncias concorrentes (rolling deploy no Render). TTL/renew não
  // "adotados às cegas": renew a 1/3 do TTL dá duas tentativas de sobra
  // antes do prazo vencer, mesmo perdendo uma renovação por jitter de rede.
  lease: {
    ttlMs: Number(process.env.WHATSAPP_LEASE_TTL_MS ?? 45_000),
    renewMs: Number(process.env.WHATSAPP_LEASE_RENEW_MS ?? 15_000),
    // Fail-safe do lado do processo (Checkpoint C3.5, item 13): fecha o
    // socket este tanto ANTES do lease_expires_at local, mesmo sem
    // confirmação do backend — nunca confia só no relógio do servidor.
    margemSegurancaMs: Number(process.env.WHATSAPP_LEASE_MARGEM_MS ?? 2_000),
    // Standby tenta adquirir de novo nesta cadência (mesma do renew, por
    // simplicidade — não há razão para ser mais agressivo que isso).
    pollingStandbyMs: Number(process.env.WHATSAPP_LEASE_POLLING_STANDBY_MS ?? 15_000),
  },
};

// Mesmo teto validado dentro das funções SQL da migration 084
// (whatsapp_lease_acquire/whatsapp_lease_renew) — duplicado de propósito
// (mesmo padrão já usado pelo HMAC, replicado nos dois lados da fronteira
// de confiança): o Gateway falha no boot com a MESMA regra que o backend/
// Postgres aplicariam de qualquer forma, em vez de só descobrir isso na
// primeira tentativa de acquire, em produção.
const LEASE_TTL_MAX_MS = 300_000;

export function validarConfig() {
  const faltando = [];
  if (!config.segredoHmac) faltando.push("WHATSAPP_GATEWAY_SECRET");
  if (!config.chaveEncriptacaoAuthState) faltando.push("WHATSAPP_AUTH_ENCRYPTION_KEY");
  if (!config.backendUrl) faltando.push("WHATSAPP_BACKEND_URL");

  if (config.segredoHmac && config.segredoHmac.length < 32) {
    throw new Error("WHATSAPP_GATEWAY_SECRET curto demais (mínimo 32 caracteres). Gere com: openssl rand -base64 48");
  }
  if (faltando.length) {
    throw new Error(`Variáveis obrigatórias ausentes: ${faltando.join(", ")}`);
  }

  // Checkpoint C3.5-A — invariante de CONFIGURAÇÃO do Gateway (o Postgres
  // não precisa conhecer renewMs/margem; só ttlMs, que ele mesmo valida em
  // 1..300000ms). Falha rápido no BOOT, antes de qualquer tentativa de
  // acquire — uma combinação incoerente aqui significaria renovar tarde
  // demais (ou nunca a tempo) e perder a lease por configuração errada, não
  // por queda de rede de verdade.
  const { ttlMs, renewMs, margemSegurancaMs } = config.lease;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`WHATSAPP_LEASE_TTL_MS precisa ser um número positivo (recebido: ${ttlMs})`);
  }
  if (ttlMs > LEASE_TTL_MAX_MS) {
    throw new Error(`WHATSAPP_LEASE_TTL_MS (${ttlMs}) não pode passar de ${LEASE_TTL_MAX_MS}ms — mesmo teto que o backend/Postgres aplicam (migration 084)`);
  }
  if (!Number.isFinite(renewMs) || renewMs <= 0) {
    throw new Error(`WHATSAPP_LEASE_RENEW_MS precisa ser um número positivo (recebido: ${renewMs})`);
  }
  if (!Number.isFinite(margemSegurancaMs) || margemSegurancaMs < 0) {
    throw new Error(`WHATSAPP_LEASE_MARGEM_MS precisa ser um número não-negativo (recebido: ${margemSegurancaMs})`);
  }
  if (ttlMs <= renewMs + margemSegurancaMs) {
    throw new Error(
      `WHATSAPP_LEASE_TTL_MS (${ttlMs}) precisa ser MAIOR que WHATSAPP_LEASE_RENEW_MS + WHATSAPP_LEASE_MARGEM_MS `
      + `(${renewMs} + ${margemSegurancaMs} = ${renewMs + margemSegurancaMs}) — senão nunca sobra tempo real entre uma `
      + `renovação e o self-fencing preventivo antes do prazo vencer de verdade.`,
    );
  }

  // Checkpoint G.2.0 — cada cap do motor de recovery, só quando a env foi EXPLICITAMENTE fornecida (`undefined` =
  // ausente/vazia = ok, fica por conta do PADRÕES_RECOVERY de offlineRecovery.js). min=1 para todos, replicando aqui
  // de propósito a MESMA regra que criarMotorRecovery() já aplicaria internamente (mesmo padrão do
  // LEASE_TTL_MAX_MS acima: falhar CEDO, no boot, com o NOME da env errada — nunca um RangeError genérico vindo de
  // dentro do motor). Isto é o que impede, por exemplo, um WHATSAPP_OFFLINE_RECOVERY_MAX_BATCHES=0 ou "5x" de
  // silenciosamente virar o default de 5 batches: aqui ele FALHA, em vez de continuar.
  const CAPS_RECOVERY = [
    ["WHATSAPP_OFFLINE_RECOVERY_MAX_BATCHES", config.offlineRecoveryLimites.maxRecoveryBatches],
    ["WHATSAPP_OFFLINE_RECOVERY_MAX_NODES", config.offlineRecoveryLimites.maxRecoveryNodes],
    ["WHATSAPP_OFFLINE_RECOVERY_MAX_DURATION_MS", config.offlineRecoveryLimites.maxRecoveryDurationMs],
    ["WHATSAPP_OFFLINE_RECOVERY_MAX_NO_PROGRESS_BATCHES", config.offlineRecoveryLimites.maxConsecutiveNoProgressBatches],
    ["WHATSAPP_OFFLINE_RECOVERY_BATCH_QUIET_MS", config.offlineRecoveryLimites.batchQuietMs],
  ];
  for (const [nomeEnv, valor] of CAPS_RECOVERY) {
    if (valor === undefined) continue;
    if (!Number.isInteger(valor) || valor < 1) {
      throw new Error(`${nomeEnv} precisa ser um inteiro >= 1 (recebido: "${process.env[nomeEnv]}")`);
    }
  }

  // Checkpoint G.3.3 — mesma regra fail-closed dos caps de recovery acima: ausente = ok (fica no default de 1 MiB
  // de authHeadroom.js); um valor EXPLICITAMENTE fornecido e inválido (zero, negativo, decimal, texto) FALHA NO
  // BOOT, nunca cai silenciosamente num default menor que o pretendido. Teto de 4 MiB replicado do backend (ver a
  // constante acima) — nunca deixa o Gateway achar que tem mais espaço do que a rota `/eventos/auth-state`
  // jamais aceitaria, mesmo sem nenhuma chamada de rede nova entre os processos para confirmar isso em runtime.
  if (config.authStateCapacidadeBytes !== undefined) {
    const v = config.authStateCapacidadeBytes;
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES precisa ser um inteiro >= 1 (recebido: "${process.env.WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES}")`);
    }
    if (v > AUTH_STATE_CAPACIDADE_TETO_BYTES) {
      throw new Error(
        `WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES (${v}) não pode passar de ${AUTH_STATE_CAPACIDADE_TETO_BYTES} `
        + `(4 MiB) — mesmo teto que o backend aplica (whatsappGateway.bootstrap.js#LIMITE_AUTH_STATE_TETO_BYTES).`,
      );
    }
  }
}
