// Carrega e valida variáveis de ambiente. Rode com: node --env-file=.env
import crypto from "node:crypto";
import { resolverFixtureFinanceira } from "../modules/ifood/ifood.ambienteTeste.js";
import { parsearUnidadesPiloto } from "../modules/ifood/ifoodOrderPiloto.js";

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

// Fixture financeira do iFood: valor inválido ou `true` fora do ambiente de teste
// impede a subida — nunca roda em silêncio contra produção.
let ifoodFinancialFixture;
try {
  ifoodFinancialFixture = resolverFixtureFinanceira(process.env);
} catch (e) {
  console.error(`[config] ${e.message}`);
  process.exit(1);
}

// Unidades liberadas para o piloto do app Order (fail-closed: vazio = nenhuma). Valor inválido é
// ignorado e só CONTADO no log — os ids nunca são impressos.
const ifoodOrderPiloto = parsearUnidadesPiloto(process.env.IFOOD_ORDER_PILOT_UNITS);
if (ifoodOrderPiloto.ignorados > 0) {
  console.warn(`[config] IFOOD_ORDER_PILOT_UNITS: ${ifoodOrderPiloto.ignorados} valor(es) ignorado(s) (não são UUID de unidade).`);
}

// Unidades em HOMOLOGAÇÃO Financial (header x-request-homologation só para elas — ver
// ifoodFinancialHomologacao.js). Mesmo parser fail-closed do piloto Order: vazio = nenhuma;
// inválido é ignorado e só CONTADO no log — os ids nunca são impressos.
const ifoodFinancialHomologacao = parsearUnidadesPiloto(process.env.IFOOD_FINANCIAL_HOMOLOGATION_UNITS);
if (ifoodFinancialHomologacao.ignorados > 0) {
  console.warn(`[config] IFOOD_FINANCIAL_HOMOLOGATION_UNITS: ${ifoodFinancialHomologacao.ignorados} valor(es) ignorado(s) (não são UUID de unidade).`);
}

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
  // `config.ifood[appType].{clientId,clientSecret}` — appType ∈ analytics|financial|order.
  //
  // `homologacao` (IFOOD_HOMOLOGATION_MODE=true) e `test` (IFOOD_TEST_CLIENT_*)
  // dão suporte ao aplicativo distribuído de teste do iFood (laboratório de
  // homologação, antes da homologação dos apps reais). Quando ligado,
  // `credenciaisDoApp()` devolve SEMPRE `ifood.test` — para analytics E
  // financial — mas o `app_type` continua sendo gravado como analytics ou
  // financial no banco (nada muda no fluxo OAuth nem no schema). Ver
  // `estaEmHomologacaoIfood()` em ifoodToken.service.js.
  ifood: {
    homologacao: process.env.IFOOD_HOMOLOGATION_MODE === "true",
    // Pedir a FIXTURE do iFood em TODAS as APIs Financial, para todas as unidades (default false).
    // Só pode ser true em ambiente seguro de teste — o guard acima recusa produção/Render.
    // Independente de `homologacao`. Só o backend lê; nunca vem de query/frontend.
    financialFixture: ifoodFinancialFixture,
    // Homologação Financial POR UNIDADE (IFOOD_FINANCIAL_HOMOLOGATION_UNITS): só estas unidades
    // enviam x-request-homologation. Vale em produção. Ver ifoodFinancialHomologacao.js.
    financialHomologacaoUnidades: ifoodFinancialHomologacao.unidades,
    analytics: {
      clientId: process.env.IFOOD_ANALYTICS_CLIENT_ID || null,
      clientSecret: process.env.IFOOD_ANALYTICS_CLIENT_SECRET || null,
    },
    financial: {
      clientId: process.env.IFOOD_FINANCIAL_CLIENT_ID || null,
      clientSecret: process.env.IFOOD_FINANCIAL_CLIENT_SECRET || null,
    },
    // App distribuído homologado de Order + Events (central-ccd). Opcional: sem ele, `order`
    // segue fora do OAuth fora de homologação (ver appTypesDoOAuth em ifoodToken.service.js).
    order: {
      clientId: process.env.IFOOD_ORDER_CLIENT_ID || null,
      clientSecret: process.env.IFOOD_ORDER_CLIENT_SECRET || null,
    },
    // Unidades do piloto do app Order (IFOOD_ORDER_PILOT_UNITS). As credenciais acima só dizem que o app
    // existe; usar o Order (status, OAuth) exige a unidade nesta lista. Ver ifoodOrderPiloto.js.
    orderPilotoUnidades: ifoodOrderPiloto.unidades,
    // Validação FINAL do vínculo manual de merchant (checagem de autorização no iFood + promoção da conexão).
    // Desligada por padrão: só com IFOOD_ORDER_MERCHANT_VALIDACAO_ENABLED=true, em janela acompanhada.
    // Informar e conferir o ID da loja NÃO dependem desta flag (não chamam o iFood).
    orderMerchantValidacao: process.env.IFOOD_ORDER_MERCHANT_VALIDACAO_ENABLED === "true",
    // Aplicativo distribuído de teste — só usado quando `homologacao` é true.
    test: {
      clientId: process.env.IFOOD_TEST_CLIENT_ID || null,
      clientSecret: process.env.IFOOD_TEST_CLIENT_SECRET || null,
    },
    // MODO TEMPORÁRIO DE DESENVOLVIMENTO — app CENTRALIZADO de teste ("Teste (C)").
    // NÃO é o modelo do produto (o produto é DISTRIBUÍDO) e NÃO reaproveita
    // IFOOD_TEST_CLIENT_* (esses identificam o Teste (D), distribuído). Serve só
    // para desenvolver/validar Events, Order etc. enquanto o Teste (D) está
    // bloqueado. Só funciona com o banco de teste e fora do Render (ver
    // ifood.ambienteTeste.js). Token vem de client_credentials e fica em memória.
    centralizedTest: {
      modo: process.env.IFOOD_CENTRALIZED_TEST_MODE === "true",
      clientId: process.env.IFOOD_CENTRALIZED_TEST_CLIENT_ID || null,
      clientSecret: process.env.IFOOD_CENTRALIZED_TEST_CLIENT_SECRET || null,
    },
  },
};
