// Limites de taxa (rate limiting) — VALORES CENTRALIZADOS, nunca espalhados
// pelo código. Cada limite é sobrescrevível por variável de ambiente para
// ajuste em produção sem redeploy de código.
//
// FILOSOFIA (igual a ifood.ratelimit.js / martinbrower.ratelimit.js, que já
// existiam): janela deslizante em memória do processo, chaveada pela CONTA
// autenticada (req.user.id) — não por IP, porque atrás do proxy do Render o
// IP é compartilhado. Onde faz sentido complementar por IP (ataque distribuído
// entre contas a partir de uma origem), usa-se `req.ip` (que respeita o
// `trust proxy` já configurado em app.js), NUNCA o header x-forwarded-for cru.
//
// Os limites são DELIBERADAMENTE GENEROSOS: o objetivo desta fase é barrar
// abuso grosseiro (brute force, spam, automação, loop, geração de custo), não
// modelar um plano comercial. Aperte depois com dados reais de uso.

/** Lê um inteiro positivo de env, com default. Valor inválido/ausente -> default. */
function intEnv(chave, padrao) {
  const v = Number(process.env[chave]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : padrao;
}

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;

/**
 * Limites das rotas gerais / de sessão / administrativas.
 * Cada entrada: { max, janelaMs }.
 */
export const RATE_LIMIT = {
  // Teto grosseiro para TODA a API autenticada, por conta. ~2 req/s sustentado.
  // Uma tela pesada dispara ~10-30 requisições; isto só pega abuso real.
  apiGlobal: {
    max: intEnv("RATE_LIMIT_API_MAX", 600),
    janelaMs: intEnv("RATE_LIMIT_API_JANELA_MS", 5 * MIN),
  },

  // POST /sessao/selecionar-perfil — o passo do PIN. Chaveado por CONTA para
  // que TODOS os perfis da mesma conta dividam o mesmo orçamento (senão um
  // atacante com a senha ataca N perfis em paralelo, 5 tentativas cada, e
  // contorna parte do lockout individual). Ver também o limite por IP abaixo.
  pinPorConta: {
    max: intEnv("RATE_LIMIT_PIN_CONTA_MAX", 15),
    janelaMs: intEnv("RATE_LIMIT_PIN_JANELA_MS", 10 * MIN),
  },
  // Mesmo endpoint, chaveado por IP — pega spray a partir de uma origem só,
  // trocando de conta a cada tentativa. Folga maior (várias contas legítimas
  // podem sair do mesmo NAT corporativo).
  pinPorIp: {
    max: intEnv("RATE_LIMIT_PIN_IP_MAX", 50),
    janelaMs: intEnv("RATE_LIMIT_PIN_JANELA_MS", 10 * MIN),
  },

  // POST /sessao/selecionar — troca de empresa/unidade. Rotineiro, mas não às
  // centenas por minuto.
  selecionarContexto: {
    max: intEnv("RATE_LIMIT_CONTEXTO_MAX", 40),
    janelaMs: intEnv("RATE_LIMIT_CONTEXTO_JANELA_MS", 10 * MIN),
  },

  // POST /sessao/senha — definição da própria senha. Acontece 1x no primeiro
  // acesso e raramente depois.
  trocarSenha: {
    max: intEnv("RATE_LIMIT_SENHA_MAX", 6),
    janelaMs: intEnv("RATE_LIMIT_SENHA_JANELA_MS", 15 * MIN),
  },

  // Importações/uploads (Vendas, Parser Food Delivery, Bonificação, Martin
  // Brower import manual) — parse síncrono de arquivo grande no event loop.
  importacao: {
    max: intEnv("RATE_LIMIT_IMPORT_MAX", 30),
    janelaMs: intEnv("RATE_LIMIT_IMPORT_JANELA_MS", 10 * MIN),
  },

  // Painel SuperAdmin — já é restrito a SuperAdmin; o limite é só uma rede
  // contra script descontrolado. Folgado para não atrapalhar operação em lote.
  plataforma: {
    max: intEnv("RATE_LIMIT_PLATAFORMA_MAX", 400),
    janelaMs: intEnv("RATE_LIMIT_PLATAFORMA_JANELA_MS", 5 * MIN),
  },

  // Painel Administrativo (monitoramento cross-tenant, só leitura). Idem.
  administrativo: {
    max: intEnv("RATE_LIMIT_ADMINISTRATIVO_MAX", 400),
    janelaMs: intEnv("RATE_LIMIT_ADMINISTRATIVO_JANELA_MS", 5 * MIN),
  },

  // Aba Conexão — ações que mexem na sessão do WhatsApp (iniciar, confirmar, cancelar, desconectar, trocar, identidade). Poucas por natureza.
  comunicacaoConexao: {
    max: intEnv("RATE_LIMIT_COMUNICACAO_CONEXAO_MAX", 20),
    janelaMs: intEnv("RATE_LIMIT_COMUNICACAO_CONEXAO_JANELA_MS", 10 * MIN),
  },

  // Central de Comunicação — mensagens MANUAIS enviadas por um operador. Protege o número do WhatsApp (ban por volume) e barra script: por CONTA,
  // bem abaixo do teto geral. Só POST .../conversas/:id/mensagens passa por aqui.
  comunicacaoManual: {
    max: intEnv("RATE_LIMIT_COMUNICACAO_MANUAL_MAX", 30),
    janelaMs: intEnv("RATE_LIMIT_COMUNICACAO_MANUAL_JANELA_MS", 10 * MIN),
  },
};

/**
 * Limites do AGENTE CRESCER (assistente de IA) — proteção FINANCEIRA contra
 * spam / automação / loop / consumo acidental enorme.
 *
 * DUAS CAMADAS:
 *   1. MEMÓRIA, por conta (agente.routes.js): pré-filtro barato que corta
 *      rajada antes de tocar o banco. Reseta no restart do processo.
 *   2. RESERVA ATÔMICA no banco (migration 067 — agente_reservar_quota):
 *      a autoridade. Uma transação incrementa ORG + CONTA + PERFIL de uma vez;
 *      se um passar do limite, ROLLBACK de todos -> 429. Sobrevive a restart e
 *      é correta sob concorrência e com múltiplas instâncias.
 *
 * Todos generosos e ajustáveis por env. NÃO é um plano comercial.
 */
export const RATE_LIMIT_AGENTE = {
  // --- 1. memória, por conta -------------------------------------------
  memoriaPorContaMinuto: {
    max: intEnv("RATE_LIMIT_AGENTE_MEM_CONTA_MIN_MAX", 12),
    janelaMs: MIN,
  },
  memoriaPorContaHora: {
    max: intEnv("RATE_LIMIT_AGENTE_MEM_CONTA_HORA_MAX", 120),
    janelaMs: HORA,
  },

  // --- 2. reserva atômica no banco (janelas em SEGUNDOS) --------------
  // Cada escopo tem uma janela de HORA e uma de DIA. `chave`:
  //   org    -> req.tenant.organizacaoId
  //   conta  -> req.user.id
  //   perfil -> req.perfil.id  (pulado em impersonação — não há perfil)
  // NENHUMA vem do corpo da requisição.
  atomica: {
    org: [
      { janelaSegundos: 3600, max: intEnv("RATE_LIMIT_AGENTE_ORG_HORA_MAX", 300) },
      { janelaSegundos: 86400, max: intEnv("RATE_LIMIT_AGENTE_ORG_DIA_MAX", 1500) },
    ],
    conta: [
      { janelaSegundos: 3600, max: intEnv("RATE_LIMIT_AGENTE_CONTA_HORA_MAX", 120) },
      { janelaSegundos: 86400, max: intEnv("RATE_LIMIT_AGENTE_CONTA_DIA_MAX", 600) },
    ],
    perfil: [
      { janelaSegundos: 3600, max: intEnv("RATE_LIMIT_AGENTE_PERFIL_HORA_MAX", 80) },
      { janelaSegundos: 86400, max: intEnv("RATE_LIMIT_AGENTE_PERFIL_DIA_MAX", 400) },
    ],
  },
};
