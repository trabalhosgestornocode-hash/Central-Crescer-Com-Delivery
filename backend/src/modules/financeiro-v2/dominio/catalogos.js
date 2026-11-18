// Catálogos fechados do Financeiro v2. Cada dimensão é um catálogo PRÓPRIO: canal, forma de pagamento e processador
// nunca se misturam (iFood, por exemplo, aparece como canal, como processador e como sistema de origem — três papéis distintos).

const enumerar = (...valores) => Object.freeze(Object.fromEntries(valores.map((v) => [v, v])));

/** Tipos de registro persistidos pelo núcleo. */
export const TIPO = enumerar(
  "CONTA", "CONTRAPARTE", "LANCAMENTO", "VENDA", "OBRIGACAO", "RECEBIVEL", "MOVIMENTACAO", "LIQUIDACAO",
  "TRANSFERENCIA", "AJUSTE", "DOCUMENTO", "VINCULO_DOCUMENTAL", "CORRESPONDENCIA", "COMPETENCIA",
  "CATEGORIA", "PAGAMENTO_VENDA", "ESTORNO", "IMPORTACAO", "REGISTRO_FONTE", "CONCESSAO", "PROPOSTA", "DIVERGENCIA_FONTE",
  "SALDO_CONTA", "SESSAO_CAIXA",
  "VERSAO_FECHAMENTO", "ATRIBUICAO_PENDENCIA", "CANAL_PROCESSADOR", "CONFIGURACAO_UNIDADE",
  "ABERTURA", "FECHAMENTO_CAIXA", "SEMANA_ENTREGADORES", "FECHAMENTO_ENTREGADOR", "EXTRA_ENTREGADOR",
);

/** Conta financeira = onde o dinheiro DA EMPRESA está. Processadores (Stone, iFood, vales) NÃO são contas: geram recebíveis. */
export const TIPO_CONTA = enumerar("BANCARIA", "CAIXA_FISICO");

export const TIPO_CONTRAPARTE = enumerar("FORNECEDOR", "OPERADORA", "CLIENTE", "PRESTADOR", "OUTRO");

/**
 * Natureza ECONÔMICA (resultado). Não descreve entrada/saída de dinheiro.
 * PATRIMONIAL nunca entra no resultado (principal de empréstimo, aporte, retirada, compra de equipamento).
 */
export const NATUREZA_LANCAMENTO = enumerar("RECEITA", "DEDUCAO", "DESPESA", "PATRIMONIAL");
export const SITUACAO_LANCAMENTO = enumerar("ATIVO", "CANCELADO");

/**
 * Classificações principais do plano de contas gerencial (fixas). As CATEGORIAS são cadastro de cada unidade.
 * A natureza de um lançamento vem da categoria; a primeira natureza de cada classificação é a padrão.
 */
export const CLASSIFICACAO = enumerar(
  "RECEITA_OPERACIONAL", "DEDUCOES_COMERCIAIS", "CUSTOS_OPERACIONAIS", "DESPESAS_COMERCIAIS",
  "DESPESAS_RECEBIMENTO_PROCESSAMENTO", "DESPESAS_ADMINISTRATIVAS", "PESSOAL", "MARKETING", "DESPESAS_PLATAFORMAS",
  "DESPESAS_FINANCEIRAS", "TRIBUTOS", "OUTROS_EFEITOS_GERENCIAIS", "MOVIMENTACOES_PATRIMONIAIS",
);
export const NATUREZAS_DA_CLASSIFICACAO = Object.freeze({
  RECEITA_OPERACIONAL: Object.freeze(["RECEITA"]),
  DEDUCOES_COMERCIAIS: Object.freeze(["DEDUCAO"]),
  CUSTOS_OPERACIONAIS: Object.freeze(["DESPESA"]),
  DESPESAS_COMERCIAIS: Object.freeze(["DESPESA"]),
  DESPESAS_RECEBIMENTO_PROCESSAMENTO: Object.freeze(["DESPESA"]),
  DESPESAS_ADMINISTRATIVAS: Object.freeze(["DESPESA"]),
  PESSOAL: Object.freeze(["DESPESA"]),
  MARKETING: Object.freeze(["DESPESA"]),
  DESPESAS_PLATAFORMAS: Object.freeze(["DESPESA"]),
  DESPESAS_FINANCEIRAS: Object.freeze(["DESPESA"]),
  TRIBUTOS: Object.freeze(["DESPESA", "DEDUCAO"]),
  OUTROS_EFEITOS_GERENCIAIS: Object.freeze(["DESPESA", "RECEITA"]),
  MOVIMENTACOES_PATRIMONIAIS: Object.freeze(["PATRIMONIAL"]),
});

/** Canal de origem da venda (um por venda). */
export const CANAL = enumerar("BALCAO", "IFOOD", "ANOTA_AI", "NOVENTA_E_NOVE_FOOD", "OUTRO");
/** Forma de pagamento (uma venda pode ter várias). */
export const FORMA_PAGAMENTO = enumerar("DINHEIRO", "PIX", "DEBITO", "CREDITO", "VALE", "OUTRA");
/** Processador/intermediário que fica devendo o repasse. */
export const PROCESSADOR = enumerar("STONE", "PAGBANK", "MAQUININHA_IFOOD", "IFOOD", "ANOTA_AI", "NOVENTA_E_NOVE_FOOD", "OPERADORA_BENEFICIOS", "MAQUINA_TERCEIROS", "OUTRO");

/** Sistema de onde um dado veio. */
export const SISTEMA_FONTE = enumerar("SAIPOS", "IFOOD", "ANOTA_AI", "STONE", "UNICRED", "FOODY", "MANUAL", "OUTRO");
/**
 * Só estes sistemas podem ORIGINAR uma venda. Relatórios de processador (Stone) e extratos (Unicred) são evidência de
 * pagamento/recebimento da mesma venda — entram por conciliação, nunca como venda nova (evita faturamento em dobro).
 */
export const SISTEMAS_QUE_ORIGINAM_VENDA = Object.freeze([SISTEMA_FONTE.SAIPOS, SISTEMA_FONTE.IFOOD, SISTEMA_FONTE.ANOTA_AI, SISTEMA_FONTE.MANUAL]);

export const SITUACAO_VENDA = enumerar("ATIVA", "CANCELADA");
/** Pagamento de venda é registro próprio: uma venda pode ter vários, de formas e processadores diferentes, em datas diferentes. */
export const SITUACAO_PAGAMENTO = enumerar("VALIDO", "ESTORNADO_PARCIAL", "ESTORNADO", "CANCELADO");

export const SITUACAO_TITULO = enumerar("ABERTA", "PARCIAL", "QUITADA", "CANCELADA");
export const ALVO_LIQUIDACAO = enumerar("OBRIGACAO", "RECEBIVEL");
export const SITUACAO_LIQUIDACAO = enumerar("VALIDA", "ESTORNADA_PARCIAL", "ESTORNADA");

export const SENTIDO = enumerar("ENTRADA", "SAIDA");
/** DEVOLUCAO só nasce de um estorno de pagamento de venda (dinheiro que volta ao cliente). */
export const NATUREZA_MOVIMENTACAO = enumerar("PAGAMENTO", "RECEBIMENTO", "TRANSFERENCIA_INTERNA", "DEVOLUCAO", "OUTRA");
export const SITUACAO_MOVIMENTACAO = enumerar("VALIDA", "ESTORNADA");
export const SITUACAO_TRANSFERENCIA = enumerar("VALIDA", "ESTORNADA");
export const SITUACAO_CONCILIACAO = enumerar("NAO_CONCILIADA", "PARCIAL", "CONCILIADA");

/**
 * Por que um pagamento de venda é estornado:
 *  DEVOLUCAO_AO_CLIENTE  → o cliente recebeu o dinheiro de volta: reduz a receita (dedução comercial), sem apagar a venda.
 *  CORRECAO_DE_PAGAMENTO → o pagamento foi registrado errado (forma/processador): a receita não muda; a venda volta a ter
 *                          valor pendente, que um novo pagamento completa.
 */
export const MOTIVO_ESTORNO = enumerar("DEVOLUCAO_AO_CLIENTE", "CORRECAO_DE_PAGAMENTO");
export const ALVO_ESTORNO = enumerar("LIQUIDACAO", "PAGAMENTO_VENDA", "MOVIMENTACAO", "TRANSFERENCIA");

export const TIPO_DOCUMENTO = enumerar(
  "EXTRATO_BANCARIO", "RELATORIO_VENDAS", "RELATORIO_PROCESSADOR", "DEMONSTRATIVO_REPASSE", "NOTA_FISCAL", "BOLETO",
  "COMPROVANTE", "APURACAO_ENTREGADORES", "CONTRATO", "OUTRO",
);
/** Tipos de registro que podem receber vínculo documental. */
export const VINCULAVEIS = Object.freeze([
  TIPO.LANCAMENTO, TIPO.VENDA, TIPO.OBRIGACAO, TIPO.RECEBIVEL, TIPO.MOVIMENTACAO, TIPO.LIQUIDACAO, TIPO.TRANSFERENCIA,
  TIPO.AJUSTE, TIPO.CORRESPONDENCIA, TIPO.COMPETENCIA, TIPO.PAGAMENTO_VENDA, TIPO.ESTORNO, TIPO.IMPORTACAO, TIPO.REGISTRO_FONTE, TIPO.PROPOSTA, TIPO.DIVERGENCIA_FONTE,
]);

export const SITUACAO_CORRESPONDENCIA = enumerar("CANDIDATA", "CONFIRMADA", "DIVERGENTE", "REJEITADA", "AGUARDANDO_DOCUMENTO");
/** Tipos de registro que podem compor um lado de uma correspondência (REGISTRO_FONTE = linha importada, ainda sem efeito financeiro). */
export const CONCILIAVEIS = Object.freeze([TIPO.MOVIMENTACAO, TIPO.RECEBIVEL, TIPO.OBRIGACAO, TIPO.VENDA, TIPO.REGISTRO_FONTE]);

/**
 * Relações de conciliação preparadas na Execução 02. Cada uma liga registros de fontes DIFERENTES que descrevem o mesmo
 * dinheiro; nenhuma cria efeito financeiro novo. MANUAL = montada por uma pessoa (conta a pagar × pagamento, transferência...).
 */
export const RELACAO_CORRESPONDENCIA = enumerar(
  "SAIPOS_X_STONE", "STONE_X_RECEBIMENTO", "RECEBIMENTO_STONE_X_UNICRED", "IFOOD_X_UNICRED", "FOODY_X_UNICRED", "OBRIGACAO_X_MOVIMENTACAO", "MANUAL",
);
/** Força da regra que propôs a candidata: FORTE = identificador comum; FRACA = só valor/data (nunca é prova). */
export const FORCA_CORRESPONDENCIA = enumerar("FORTE", "FRACA");

/**
 * Estado de uma IMPORTAÇÃO (o arquivo e seu processamento). NÃO é o estado de conferência dos valores:
 * importar não confirma, não concilia e não homologa nada.
 */
export const ESTADO_IMPORTACAO = enumerar(
  "RECEBIDO", "EM_VALIDACAO", "PRONTO_PARA_IMPORTAR", "IMPORTADO", "IMPORTADO_COM_PENDENCIAS", "REJEITADO", "SUBSTITUIDO",
);
/** Conferência de cada registro importado — independe do estado da importação. */
export const CONFERENCIA_REGISTRO = enumerar("NAO_CONFERIDO", "CONFERIDO", "DIVERGENTE");
export const SITUACAO_REGISTRO_FONTE = enumerar("ATIVO", "SUBSTITUIDO");
/** Liberação de acesso financeiro_v2.* de um usuário numa unidade. */
export const SITUACAO_CONCESSAO = enumerar("ATIVA", "REVOGADA");

/**
 * Formação financeira (Execução 03): registro importado → PROPOSTA → revisão → aplicação autorizada → operação.
 * Importar nunca cria efeito financeiro; só a aplicação de uma proposta APROVADA cria (uma única vez).
 */
export const ESTADO_PROPOSTA = enumerar("PROPOSTA", "AGUARDANDO_EVIDENCIA", "AGUARDANDO_REVISAO", "APROVADA", "APLICADA", "REJEITADA", "SUBSTITUIDA");
export const OPERACAO_PROPOSTA = enumerar(
  "VENDA", "VENDA_AGREGADA", "PAGAMENTO_STONE", "OBRIGACAO_ENTREGADOR", "MOVIMENTACAO_BANCARIA",
);
export const CONFIANCA = enumerar("ALTA", "MEDIA", "BAIXA");
export const ESTADO_DIVERGENCIA_FONTE = enumerar("ABERTA", "EXPLICADA_PARCIALMENTE", "RESOLVIDA");

export const ESTADO_COMPETENCIA = enumerar("ABERTA", "FECHAMENTO_PRELIMINAR", "FECHAMENTO_COM_PENDENCIAS", "FECHAMENTO_HOMOLOGADO");

export const EVENTO_HISTORICO = enumerar(
  "CRIACAO", "CORRECAO", "RECLASSIFICACAO", "CANCELAMENTO", "LIQUIDACAO", "ESTORNO", "AJUSTE", "CONCILIACAO",
  "MUDANCA_ESTADO", "SUBSTITUICAO", "CORRECAO_EM_FECHAMENTO", "PAGAMENTO", "IMPORTACAO", "OPERACAO_DE_CAIXA", "FECHAMENTO_DE_CAIXA",
  "ATUALIZACAO_POSTERIOR_AO_FECHAMENTO", "ACESSO_DOCUMENTO", "ATRIBUICAO", "PROVISIONAMENTO", "CONFIGURACAO",
  // 08E: pendência documentada no fechamento (ressalva) — o registro alterado é a competência.
  "DOCUMENTACAO_DE_PENDENCIA",
);

/**
 * Caixa físico (Execução 06A): a sessão compara o saldo TEÓRICO (abertura + movimentos) com o CONTADO no fechamento.
 * A diferença fica registrada; nunca vira ajuste automático.
 */
export const SITUACAO_SESSAO_CAIXA = enumerar("ABERTA", "FECHADA");
export const OPERACAO_CAIXA = enumerar("ENTRADA", "SAIDA", "SANGRIA", "SUPRIMENTO");

/**
 * Execução 06D — versões de fechamento. Cada passagem por um estado de fechamento grava um RETRATO imutável da apuração
 * (indicadores, DRE e impressão). A versão HOMOLOGADA é a referência oficial da competência: nunca é reescrita; reabrir
 * cria histórico e a próxima homologação gera outra versão.
 */
export const TIPO_VERSAO_FECHAMENTO = enumerar("PRELIMINAR", "COM_PENDENCIAS", "HOMOLOGADA");

/** Responsável por uma pendência da Central de Conferências. */
export const SITUACAO_ATRIBUICAO = enumerar("ATRIBUIDA", "EM_ANALISE", "AGUARDANDO_TERCEIRO", "CONCLUIDA");

/** Cadastro de canais e processadores DA UNIDADE (06D). Canal, forma de pagamento e processador são papéis distintos. */
export const PAPEL_COMERCIAL = enumerar("CANAL", "PROCESSADOR");
export const SITUACAO_CADASTRO = enumerar("ATIVO", "INATIVO");
