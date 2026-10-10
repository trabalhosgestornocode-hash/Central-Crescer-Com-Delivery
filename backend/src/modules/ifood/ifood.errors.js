// Erros específicos da integração iFood.
//
// Cada erro carrega DOIS textos:
//   * codigo   — técnico, para log/auditoria (nunca contém segredo);
//   * message  — para o usuário final, em português claro, SEM jargão e SEM
//                nenhum dado sensível (secret, token, authorizationCode,
//                merchantId completo).
//
// Estende ApiError para atravessar o errorHandler já existente sem adaptação.
import { ApiError } from "../../shared/ApiError.js";

export class IfoodError extends ApiError {
  constructor(codigo, statusCode, message, details) {
    super(statusCode, message, details);
    this.name = "IfoodError";
    this.codigo = codigo;
  }
}

// codigo -> [status HTTP, mensagem ao usuário]
const CATALOGO = {
  IFOOD_APP_TYPE_INVALIDO: [400,
    "Aplicativo iFood inválido. Escolha entre desempenho (Analytics) e financeiro (Financial)."],
  // App Order existe no ambiente, mas a unidade não está no piloto (IFOOD_ORDER_PILOT_UNITS). 403 explícito,
  // sem nenhuma chamada ao iFood.
  IFOOD_ORDER_PILOTO_NAO_HABILITADO: [403,
    "Pedidos e eventos do iFood ainda não estão disponíveis para esta unidade."],
  IFOOD_APP_SEM_CREDENCIAL: [503,
    "As credenciais deste aplicativo iFood não estão configuradas neste ambiente. Fale com o suporte da plataforma."],
  IFOOD_OAUTH_SESSAO_NAO_ENCONTRADA: [404,
    "Não encontramos essa solicitação de autorização. Gere um novo código e tente novamente."],
  IFOOD_OAUTH_SESSAO_EXPIRADA: [400,
    "O código de vínculo expirou. Gere outro código."],
  IFOOD_OAUTH_SESSAO_JA_USADA: [409,
    "Essa autorização já foi concluída ou cancelada. Gere um novo código se precisar reconectar."],
  IFOOD_OAUTH_CODIGO_INVALIDO: [400,
    "Não foi possível concluir a autorização. Verifique o código de autorização fornecido pelo iFood e tente novamente, ou gere um novo código."],
  IFOOD_USER_CODE_FALHOU: [502,
    "Não foi possível gerar o código de vínculo com o iFood. Tente novamente em alguns minutos."],
  IFOOD_TOKEN_TROCA_FALHOU: [502,
    "Não foi possível concluir a autorização com o iFood. Gere um novo código e tente novamente."],
  IFOOD_TOKEN_EXPIRADO: [401,
    "Nossa conexão com o iFood expirou. Reconecte sua conta."],
  IFOOD_REFRESH_FALHOU: [401,
    "Nossa conexão com o iFood expirou e não foi possível renová-la. Reconecte sua conta."],
  IFOOD_CONEXAO_NAO_ENCONTRADA: [404,
    "Esta loja ainda não tem uma conexão com o iFood."],
  IFOOD_CREDENCIAL_NAO_ENCONTRADA: [404,
    "Este aplicativo iFood ainda não foi autorizado para esta loja."],

  // --- Merchant (blocos D/E) ---
  IFOOD_SEM_MERCHANT: [404,
    "Esta conta iFood não possui acesso a nenhuma loja."],
  IFOOD_MERCHANT_SEM_PERMISSAO: [403,
    "Você não tem permissão para vincular esta loja."],
  IFOOD_MERCHANT_NAO_ENCONTRADO: [404,
    "Não foi possível confirmar essa loja no iFood. Tente novamente."],
  IFOOD_VINCULO_DUPLICADO: [409,
    "Esta loja do iFood já está vinculada a outra unidade."],

  // --- Vínculo MANUAL do merchant (unidade só com o app Order — sem Merchant API nem Financial) ---
  IFOOD_ORDER_NAO_CONECTADO: [409,
    "Conecte os pedidos (app Order) desta unidade antes de informar a loja."],
  IFOOD_MERCHANT_ID_INVALIDO: [400,
    "O ID da loja não está no formato do iFood. Copie o ID exatamente como aparece no Portal do Parceiro."],
  IFOOD_MERCHANT_JA_VINCULADO: [409,
    "Esta unidade já tem uma loja iFood vinculada. Para trocar de loja, desconecte a integração primeiro."],
  IFOOD_VINCULO_MANUAL_INDISPONIVEL: [503,
    "O vínculo manual da loja ainda não está disponível neste ambiente. Fale com o suporte da plataforma."],
  IFOOD_VINCULO_NAO_ENCONTRADO: [404,
    "Nenhuma loja informada aguardando confirmação nesta unidade."],
  IFOOD_VINCULO_CONFIRMACAO_DIVERGENTE: [400,
    "O ID confirmado é diferente do ID informado. Confira o ID da loja no Portal do Parceiro."],
  IFOOD_VINCULO_ESTADO_INVALIDO: [409,
    "Esta etapa não está disponível no estado atual do vínculo da loja."],
  IFOOD_VINCULO_TENTATIVAS_ESGOTADAS: [429,
    "Limite de tentativas de vínculo desta loja atingido. Confira o ID no Portal do Parceiro e fale com o suporte da plataforma."],
  IFOOD_VALIDACAO_NAO_HABILITADA: [403,
    "A validação final da loja ainda não está liberada. Ela é feita em janela acompanhada pelo suporte da plataforma."],
  IFOOD_VALIDACAO_SEM_EVIDENCIA: [400,
    "Para validar a loja, confirme a conferência no Portal do Parceiro e a confirmação operacional."],

  // --- Financial (Fase 2 — Homologação) ---
  IFOOD_FINANCIAL_PERIODO_INVALIDO: [400,
    "Período inválido. Confira as datas informadas e o limite máximo permitido para esta consulta."],
  IFOOD_FINANCIAL_SEM_MERCHANT: [409,
    "Vincule uma loja do iFood a esta unidade antes de consultar dados financeiros."],
  IFOOD_RECONCILIATION_INVALIDA: [400,
    "Não foi possível processar essa solicitação de conciliação. Confira a competência informada."],
  // 409 do POST on-demand: já existe solicitação recente no iFood. O service retoma o requestId
  // registrado; este erro só chega ao usuário quando NÃO há requestId para retomar.
  IFOOD_RECONCILIATION_EM_ANDAMENTO: [409,
    "Já existe uma solicitação recente de conciliação para esta competência no iFood, feita fora desta Central. Aguarde alguns minutos e tente novamente."],
  IFOOD_RECONCILIATION_SOLICITACAO_NAO_ENCONTRADA: [404,
    "Não encontramos essa solicitação de conciliação para esta unidade. Gere uma nova solicitação."],
  IFOOD_RECONCILIATION_ARQUIVO_INDISPONIVEL: [409,
    "O arquivo de conciliação ainda não está pronto para download. Aguarde a conclusão do processamento."],
  // 404 de consultas Financial que significam "não há dados" — nunca "loja não encontrada".
  IFOOD_FINANCIAL_SEM_DADOS: [404,
    "Nenhum dado financeiro encontrado para o período informado."],

  // --- modo CENTRALIZED_TEST (temporário, só ambiente técnico) ---
  IFOOD_CENTRALIZADO_BLOQUEADO: [403,
    "O modo centralizado de teste do iFood só funciona no ambiente de desenvolvimento com o banco de teste."],
  IFOOD_CENTRALIZADO_FALHOU: [502,
    "Não foi possível autenticar no aplicativo centralizado de teste do iFood."],

  // --- Order (Checkpoint C) ---
  IFOOD_PEDIDO_NAO_ENCONTRADO: [404,
    "O iFood não encontrou este pedido (ainda indisponível, expirado ou inválido)."],
  IFOOD_ACAO_PEDIDO_RECUSADA: [409,
    "O iFood recusou a ação neste pedido."],
  IFOOD_PEDIDO_LOCAL_NAO_ENCONTRADO: [404,
    "Pedido não encontrado nesta unidade."],
  IFOOD_PEDIDO_ESTADO_INVALIDO: [409,
    "Esta ação não é permitida no estado atual do pedido."],
  IFOOD_ACAO_NAO_ELEGIVEL: [409,
    "Esta ação não está disponível para este tipo de pedido."],
  IFOOD_MOTIVO_CANCELAMENTO_INVALIDO: [400,
    "Motivo de cancelamento inválido para este pedido. Escolha um dos motivos oferecidos pelo iFood."],
  IFOOD_DISPUTA_NAO_ENCONTRADA: [404,
    "Negociação não encontrada nesta unidade."],
  IFOOD_DISPUTA_ENCERRADA: [409,
    "Esta negociação já foi respondida ou expirou."],
  IFOOD_RESPOSTA_DISPUTA_INVALIDA: [400,
    "Resposta inválida para esta negociação."],

  // --- transporte ---
  IFOOD_REQUISICAO_INVALIDA: [400,
    "O iFood recusou a requisição. Tente novamente; se persistir, fale com o suporte."],
  IFOOD_RATE_LIMITED: [429,
    "Muitas tentativas em pouco tempo. Aguarde um instante antes de tentar de novo."],
  IFOOD_INDISPONIVEL: [503,
    "O iFood está indisponível no momento. Tente novamente mais tarde."],
  IFOOD_RESPOSTA_INVALIDA: [502,
    "O iFood devolveu uma resposta em um formato inesperado. Tente novamente em alguns minutos."],
  IFOOD_CANCELADO: [499, "A operação foi cancelada."],
};

/** Fábrica única: ifoodErro('IFOOD_SEM_MERCHANT') ou com detalhes/mensagem própria. */
export function ifoodErro(codigo, { detalhes, mensagem } = {}) {
  const [status, msgPadrao] = CATALOGO[codigo] ?? [500, "Falha na integração com o iFood."];
  return new IfoodError(codigo, status, mensagem ?? msgPadrao, detalhes);
}

export const IFOOD_ERROS = Object.freeze(
  Object.fromEntries(Object.keys(CATALOGO).map((k) => [k, k]))
);

// Contextos das leituras Financial: 'financial' (Sales/Events) e os dois com
// 404 próprio — Settlements ("nenhuma liquidação no período") e Anticipation
// ("loja sem plano de antecipação"), ambos documentados na API oficial.
const CONTEXTOS_FINANCIAL = new Set(["financial", "settlements", "anticipations"]);

// Traduz um status HTTP do iFood para o erro de domínio correspondente.
// 400/401/403 NUNCA viram retry — quem chama usa isto para decidir.
export function erroPorStatusHttp(status, { contexto } = {}) {
  // Order: 404 = pedido inexistente/indisponível; 400/409/422 = ação recusada (status HTTP nos detalhes).
  if (contexto === "order") {
    if (status === 404) return ifoodErro(IFOOD_ERROS.IFOOD_PEDIDO_NAO_ENCONTRADO);
    if (status === 400 || status === 409 || status === 422) return ifoodErro(IFOOD_ERROS.IFOOD_ACAO_PEDIDO_RECUSADA, { detalhes: { status } });
  }
  if (status === 400) {
    // No fluxo OAuth, 400 quase sempre é "authorizationCode/verifier inválido".
    return ifoodErro(contexto === "oauth" ? IFOOD_ERROS.IFOOD_OAUTH_CODIGO_INVALIDO : IFOOD_ERROS.IFOOD_REQUISICAO_INVALIDA);
  }
  if (status === 401) return ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO);
  if (status === 403) {
    // Mesmo código (o frontend decide pelo `codigo`, nunca pela mensagem) —
    // só a mensagem muda para fazer sentido fora do fluxo de vínculo.
    if (CONTEXTOS_FINANCIAL.has(contexto)) {
      return ifoodErro(IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO, {
        mensagem: "Você não tem permissão para consultar os dados financeiros desta loja no iFood.",
      });
    }
    return ifoodErro(IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO);
  }
  if (status === 404) {
    // Reconciliation On Demand: requestId não encontrado OU expirado (TTL
    // documentado de 24h) — mensagem bem diferente de "loja não encontrada".
    if (contexto === "reconciliation") {
      return ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA, {
        mensagem: "Não encontramos essa solicitação de conciliação. Ela pode ter expirado (validade de 24 horas) — gere uma nova.",
      });
    }
    if (contexto === "settlements") {
      return ifoodErro(IFOOD_ERROS.IFOOD_FINANCIAL_SEM_DADOS, { mensagem: "Nenhuma liquidação encontrada para o período." });
    }
    if (contexto === "anticipations") {
      return ifoodErro(IFOOD_ERROS.IFOOD_FINANCIAL_SEM_DADOS, { mensagem: "A loja não possui plano de antecipação disponível no iFood." });
    }
    return ifoodErro(IFOOD_ERROS.IFOOD_MERCHANT_NAO_ENCONTRADO);
  }
  if (status === 409) {
    // POST .../reconciliation/on-demand: "There is already a recent and
    // valid request. Please try again later." (confirmado no Swagger). Doc:
    // "reutilize o requestId anterior" — código próprio para o service retomar
    // o requestId registrado (ifoodFinancial.service.js#solicitarReconciliationOnDemand).
    if (contexto === "reconciliation") return ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_EM_ANDAMENTO);
    return ifoodErro(IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA, { detalhes: { status } });
  }
  if (status === 429) return ifoodErro(IFOOD_ERROS.IFOOD_RATE_LIMITED);
  if (status >= 500) return ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL);
  return ifoodErro(IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA, { detalhes: { status } });
}

// Status que vale a pena repetir. 400/401/403/404 ficam de fora de propósito.
export function ehTransitorio(status) {
  return status === 429 || (status >= 500 && status <= 599);
}
