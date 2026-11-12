// Erros do núcleo Financeiro v2. O domínio NÃO conhece HTTP: a tradução para status fica no adaptador futuro.

export const CODIGO = Object.freeze({
  CONTEXTO_INVALIDO: "FV2_CONTEXTO_INVALIDO",
  ESCOPO_NAO_AUTORIZADO: "FV2_ESCOPO_NAO_AUTORIZADO",
  PERMISSAO_INSUFICIENTE: "FV2_PERMISSAO_INSUFICIENTE",
  ENTRADA_INVALIDA: "FV2_ENTRADA_INVALIDA",
  VALOR_INVALIDO: "FV2_VALOR_INVALIDO",
  DATA_INVALIDA: "FV2_DATA_INVALIDA",
  NAO_ENCONTRADO: "FV2_NAO_ENCONTRADO",
  CONFLITO_IDEMPOTENCIA: "FV2_CONFLITO_IDEMPOTENCIA",
  CONFLITO_VERSAO: "FV2_CONFLITO_VERSAO",
  FONTE_NAO_ORIGINA_VENDA: "FV2_FONTE_NAO_ORIGINA_VENDA",
  PAGAMENTOS_NAO_FECHAM: "FV2_PAGAMENTOS_NAO_FECHAM",
  LIQUIDACAO_EXCEDE_SALDO: "FV2_LIQUIDACAO_EXCEDE_SALDO",
  LIQUIDACAO_EXCEDE_MOVIMENTACAO: "FV2_LIQUIDACAO_EXCEDE_MOVIMENTACAO",
  LIQUIDACAO_INCOMPATIVEL: "FV2_LIQUIDACAO_INCOMPATIVEL",
  AJUSTE_EXCEDE_SALDO: "FV2_AJUSTE_EXCEDE_SALDO",
  TRANSFERENCIA_INVALIDA: "FV2_TRANSFERENCIA_INVALIDA",
  OPERACAO_INVALIDA: "FV2_OPERACAO_INVALIDA",
  COMPETENCIA_HOMOLOGADA: "FV2_COMPETENCIA_HOMOLOGADA",
  TRANSICAO_INVALIDA: "FV2_TRANSICAO_INVALIDA",
  CONCILIACAO_INVALIDA: "FV2_CONCILIACAO_INVALIDA",
  DOCUMENTO_INVALIDO: "FV2_DOCUMENTO_INVALIDO",
  REPOSITORIO_INVALIDO: "FV2_REPOSITORIO_INVALIDO",
});

export class ErroFinanceiro extends Error {
  /**
   * @param {string} codigo um valor de CODIGO
   * @param {string} mensagem
   * @param {Record<string, unknown>} [detalhes] nunca incluir valores sensíveis (documentos, segredos)
   */
  constructor(codigo, mensagem, detalhes = {}) {
    super(mensagem);
    this.name = "ErroFinanceiro";
    this.codigo = codigo;
    this.detalhes = Object.freeze({ ...detalhes });
  }
}

/** @returns {never} */
export function falhar(codigo, mensagem, detalhes) {
  throw new ErroFinanceiro(codigo, mensagem, detalhes);
}
