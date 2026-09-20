// Configuração do Gateway. Tudo por variável de ambiente — nenhum segredo
// hardcoded, nenhuma URL de produção fixa no código.
//
// REGRA DURA (Checkpoint C0/C1): este processo NUNCA recebe
// SUPABASE_SERVICE_ROLE_KEY nem qualquer credencial equivalente. Ele só
// conhece a URL do backend e os próprios segredos do protocolo interno.
// Ver test/config-sem-service-role.test.js e
// test/seguranca-sem-supabase.test.js para a verificação executável disso.

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
}
