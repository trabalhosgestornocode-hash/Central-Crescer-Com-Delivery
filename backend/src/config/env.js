// Carrega e valida variáveis de ambiente. Rode com: node --env-file=.env
import crypto from "node:crypto";

const obrigatorias = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"];
const faltando = obrigatorias.filter((k) => !process.env[k]);
if (faltando.length) {
  console.error(`[config] Variáveis de ambiente faltando: ${faltando.join(", ")}`);
  console.error("Copie backend/.env.example para backend/.env e preencha.");
  process.exit(1);
}

// Segredo que assina o Context Token (a empresa da sessão). Se não vier do
// ambiente, é DERIVADO da service_role key — que já é um segredo forte e
// exclusivo do servidor. Derivar, em vez de exigir a variável, evita quebrar um
// deploy existente; derivar, em vez de sortear, mantém os tokens válidos entre
// reinícios e entre instâncias do Render (um segredo aleatório por processo
// invalidaria a sessão de todo mundo a cada deploy).
//
// Ainda assim, o ideal é definir CONTEXT_TOKEN_SECRET: assim rotacionar a chave
// do Supabase não derruba todas as sessões, e vice-versa.
const contextTokenSecret = process.env.CONTEXT_TOKEN_SECRET
  || crypto.createHmac("sha256", process.env.SUPABASE_SERVICE_ROLE_KEY)
      .update("crescer:context-token:v1").digest("hex");

if (!process.env.CONTEXT_TOKEN_SECRET && process.env.NODE_ENV === "production") {
  console.warn("[config] CONTEXT_TOKEN_SECRET não definida — usando segredo derivado da service_role key. Defina a variável para desacoplar a rotação das chaves.");
}

// Segredo que assina o Profile Selection Token (Fase H — a prova de que o PIN
// do perfil foi validado). Mesma estratégia do Context Token, mas DERIVAÇÃO
// DISTINTA ("crescer:profile-selection:v1" != "crescer:context-token:v1") —
// assim as duas chaves são criptograficamente independentes mesmo quando ambas
// caem no fallback, e um Context Token nunca verifica como selection token.
const profileSelectionSecret = process.env.PROFILE_SELECTION_TOKEN_SECRET
  || crypto.createHmac("sha256", process.env.SUPABASE_SERVICE_ROLE_KEY)
      .update("crescer:profile-selection:v1").digest("hex");

export const config = {
  port: Number(process.env.PORT) || 3001,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY, // pública — enviada ao frontend p/ Supabase Auth
  contextTokenSecret,
  profileSelectionSecret,
  // Validade do GRANT Realtime (public.realtime_channel_grants), em segundos
  // — curta de propósito (ver realtime.grants.service.js): o Context Token
  // dura 8h porque `requireContexto` relê `sessoes_contexto` a CADA
  // requisição REST, tornando revogação instantânea; uma conexão Realtime
  // não faz uma requisição por evento, então é a validade curta + renovação
  // periódica que limita por quanto tempo um contexto revogado ainda pode
  // ouvir eventos. Não precisa de segredo nenhum — a linha do grant é
  // validada pela RLS de `realtime.messages` contra o JWT normal do Supabase
  // Auth (auth.uid()), nunca um token que o Crescer assina.
  realtimeCredentialTtlS: Number(process.env.REALTIME_CREDENTIAL_TTL_S) || 5 * 60,
  // Janela que define "usuário online" no Dashboard Global (minutos).
  janelaOnlineMin: Number(process.env.JANELA_ONLINE_MIN) || 15,
  // Credenciais dos apps iFood (Portal do Desenvolvedor). Opcionais: vazio =
  // o fluxo OAuth responde IFOOD_APP_SEM_CREDENCIAL de forma controlada.
  // Lido só aqui; `credenciaisDoApp()` (ifoodToken.service.js) consome
  // `config.ifood[appType].{clientId,clientSecret}` — appType ∈ analytics|financial.
  ifood: {
    analytics: {
      clientId: process.env.IFOOD_ANALYTICS_CLIENT_ID || null,
      clientSecret: process.env.IFOOD_ANALYTICS_CLIENT_SECRET || null,
    },
    financial: {
      clientId: process.env.IFOOD_FINANCIAL_CLIENT_ID || null,
      clientSecret: process.env.IFOOD_FINANCIAL_CLIENT_SECRET || null,
    },
  },
};
