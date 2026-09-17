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

  gatewayVersion: process.env.npm_package_version ?? "0.1.0",
  providerInstanceId: process.env.WHATSAPP_PROVIDER_INSTANCE_ID ?? "default",
};

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
}
