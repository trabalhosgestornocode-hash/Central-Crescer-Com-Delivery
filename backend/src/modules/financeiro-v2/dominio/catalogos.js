// Catálogos fechados do Financeiro v2. Cada dimensão é um catálogo PRÓPRIO: canal, forma de pagamento e processador
// nunca se misturam (iFood, por exemplo, aparece como canal, como processador e como sistema de origem — três papéis distintos).

const enumerar = (...valores) => Object.freeze(Object.fromEntries(valores.map((v) => [v, v])));

/** Tipos de registro persistidos pelo núcleo. */
export const TIPO = enumerar(
  "CONTA", "CONTRAPARTE", "LANCAMENTO", "VENDA", "OBRIGACAO", "RECEBIVEL", "MOVIMENTACAO", "LIQUIDACAO",
  "TRANSFERENCIA", "AJUSTE", "DOCUMENTO", "VINCULO_DOCUMENTAL", "CORRESPONDENCIA", "COMPETENCIA",
);

/** Conta financeira = onde o dinheiro DA EMPRESA está. Processadores (Stone, iFood, vales) NÃO são contas: geram recebíveis. */
export const TIPO_CONTA = enumerar("BANCARIA", "CAIXA_FISICO");

export const TIPO_CONTRAPARTE = enumerar("FORNECEDOR", "OPERADORA", "CLIENTE", "PRESTADOR", "OUTRO");

/** Natureza ECONÔMICA (resultado). Não descreve entrada/saída de dinheiro. */
export const NATUREZA_LANCAMENTO = enumerar("RECEITA", "DEDUCAO", "DESPESA");
export const SITUACAO_LANCAMENTO = enumerar("ATIVO", "CANCELADO");

/** Canal de origem da venda (um por venda). */
export const CANAL = enumerar("BALCAO", "IFOOD", "ANOTA_AI", "OUTRO");
/** Forma de pagamento (uma venda pode ter várias). */
export const FORMA_PAGAMENTO = enumerar("DINHEIRO", "PIX", "DEBITO", "CREDITO", "VALE", "OUTRA");
/** Processador/intermediário que fica devendo o repasse. */
export const PROCESSADOR = enumerar("STONE", "IFOOD", "ANOTA_AI", "OPERADORA_BENEFICIOS", "MAQUINA_TERCEIROS", "OUTRO");

/** Sistema de onde um dado veio. */
export const SISTEMA_FONTE = enumerar("SAIPOS", "IFOOD", "ANOTA_AI", "STONE", "UNICRED", "FOODY", "MANUAL", "OUTRO");
/**
 * Só estes sistemas podem ORIGINAR uma venda. Relatórios de processador (Stone) e extratos (Unicred) são evidência de
 * pagamento/recebimento da mesma venda — entram por conciliação, nunca como venda nova (evita faturamento em dobro).
 */
export const SISTEMAS_QUE_ORIGINAM_VENDA = Object.freeze([SISTEMA_FONTE.SAIPOS, SISTEMA_FONTE.IFOOD, SISTEMA_FONTE.ANOTA_AI, SISTEMA_FONTE.MANUAL]);

export const SITUACAO_TITULO = enumerar("ABERTA", "PARCIAL", "QUITADA", "CANCELADA");
export const ALVO_LIQUIDACAO = enumerar("OBRIGACAO", "RECEBIVEL");
export const SITUACAO_LIQUIDACAO = enumerar("VALIDA", "ESTORNADA");

export const SENTIDO = enumerar("ENTRADA", "SAIDA");
export const NATUREZA_MOVIMENTACAO = enumerar("PAGAMENTO", "RECEBIMENTO", "TRANSFERENCIA_INTERNA", "OUTRA");
export const SITUACAO_CONCILIACAO = enumerar("NAO_CONCILIADA", "PARCIAL", "CONCILIADA");

export const TIPO_DOCUMENTO = enumerar(
  "EXTRATO_BANCARIO", "RELATORIO_VENDAS", "RELATORIO_PROCESSADOR", "DEMONSTRATIVO_REPASSE", "NOTA_FISCAL", "BOLETO",
  "COMPROVANTE", "APURACAO_ENTREGADORES", "CONTRATO", "OUTRO",
);
/** Tipos de registro que podem receber vínculo documental. */
export const VINCULAVEIS = Object.freeze([
  TIPO.LANCAMENTO, TIPO.VENDA, TIPO.OBRIGACAO, TIPO.RECEBIVEL, TIPO.MOVIMENTACAO, TIPO.LIQUIDACAO, TIPO.TRANSFERENCIA,
  TIPO.AJUSTE, TIPO.CORRESPONDENCIA, TIPO.COMPETENCIA,
]);

export const SITUACAO_CORRESPONDENCIA = enumerar("CANDIDATA", "CONFIRMADA", "DIVERGENTE", "REJEITADA");
/** Tipos de registro que podem compor um lado de uma correspondência. */
export const CONCILIAVEIS = Object.freeze([TIPO.MOVIMENTACAO, TIPO.RECEBIVEL, TIPO.OBRIGACAO, TIPO.VENDA]);

export const ESTADO_COMPETENCIA = enumerar("ABERTA", "FECHAMENTO_PRELIMINAR", "FECHAMENTO_COM_PENDENCIAS", "FECHAMENTO_HOMOLOGADO");

export const EVENTO_HISTORICO = enumerar(
  "CRIACAO", "CORRECAO", "RECLASSIFICACAO", "CANCELAMENTO", "LIQUIDACAO", "ESTORNO", "AJUSTE", "CONCILIACAO",
  "MUDANCA_ESTADO", "SUBSTITUICAO",
);
