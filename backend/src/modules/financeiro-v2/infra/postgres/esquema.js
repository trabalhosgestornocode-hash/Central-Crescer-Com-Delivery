// Mapa registro do núcleo ⇄ tabela PostgreSQL (migração database/financeiro-v2/migracoes/0001_fundacao.sql).
// Cada campo relevante tem coluna TIPADA; o que não está mapeado vai para `extras` (jsonb) sem se perder.
//
// Tipos de coluna:
//   texto | uuid | inteiro | bool → como estão
//   centavos → BIGINT (trafega como texto e volta como inteiro seguro; nunca passa por ponto flutuante)
//   data     → DATE  ("AAAA-MM-DD")
//   instante → TIMESTAMPTZ (ISO-8601 UTC com milissegundos)
//   json     → JSONB
//   uuids    → UUID[]
//   fonte    → duas colunas: <coluna>_sistema e <coluna>_id_externo
import { TIPO } from "../../dominio/catalogos.js";

const c = (coluna, tipo = "texto") => Object.freeze({ coluna, tipo });

const COMUNS = Object.freeze({
  id: c("id", "uuid"),
  organizacaoId: c("organizacao_id", "uuid"),
  unidadeId: c("unidade_id", "uuid"),
  versao: c("versao", "inteiro"),
  criadoEm: c("criado_em", "instante"),
  criadoPor: c("criado_por", "uuid"),
  atualizadoEm: c("atualizado_em", "instante"),
  atualizadoPor: c("atualizado_por", "uuid"),
  chaveIdempotencia: c("chave_idempotencia"),
  impressao: c("impressao"),
});

const TITULO = {
  valorBaseCentavos: c("valor_base_centavos", "centavos"),
  liquidadoCentavos: c("liquidado_centavos", "centavos"),
  ajustesCentavos: c("ajustes_centavos", "centavos"),
  saldoCentavos: c("saldo_centavos", "centavos"),
  situacao: c("situacao"),
};

const tabela = (nome, campos) => Object.freeze({ tabela: nome, campos: Object.freeze({ ...COMUNS, ...campos }) });

export const ESQUEMA = Object.freeze({
  [TIPO.CONTA]: tabela("fv2_conta", { tipo: c("tipo"), nome: c("nome"), instituicao: c("instituicao"), ativa: c("ativa", "bool") }),
  [TIPO.CONTRAPARTE]: tabela("fv2_contraparte", { tipo: c("tipo"), nome: c("nome") }),
  [TIPO.CATEGORIA]: tabela("fv2_categoria", {
    codigo: c("codigo"), nome: c("nome"), classificacao: c("classificacao"), natureza: c("natureza"), paiId: c("pai_id", "uuid"),
    aceitaLancamento: c("aceita_lancamento", "bool"), exigeDocumento: c("exige_documento", "bool"), ativa: c("ativa", "bool"), doSistema: c("do_sistema", "bool"),
  }),
  [TIPO.DOCUMENTO]: tabela("fv2_documento", {
    origem: c("origem"), arquivoId: c("arquivo_id"), hashSha256: c("hash_sha256"), tipo: c("tipo"), competencia: c("competencia"),
    recebidoEm: c("recebido_em", "data"), substituiId: c("substitui_id", "uuid"), descricao: c("descricao"),
    versaoDocumento: c("versao_documento", "inteiro"), substituidoPorId: c("substituido_por_id", "uuid"), responsavelId: c("responsavel_id", "uuid"),
  }),
  [TIPO.LANCAMENTO]: tabela("fv2_lancamento", {
    situacao: c("situacao"), natureza: c("natureza"), valorCentavos: c("valor_centavos", "centavos"), moeda: c("moeda"),
    categoriaId: c("categoria_id", "uuid"), categoria: c("categoria_codigo"), classificacao: c("classificacao"), descricao: c("descricao"),
    dataOperacao: c("data_operacao", "data"), competencia: c("competencia"), fonte: c("fonte", "fonte"), canal: c("canal"),
    retidoNoRepasse: c("retido_no_repasse", "bool"), origem: c("origem", "json"),
  }),
  [TIPO.VENDA]: tabela("fv2_venda", {
    canal: c("canal"), dataVenda: c("data_venda", "data"), competencia: c("competencia"), brutoCentavos: c("bruto_centavos", "centavos"),
    pagoCentavos: c("pago_centavos", "centavos"), devolvidoCentavos: c("devolvido_centavos", "centavos"), moeda: c("moeda"),
    fonte: c("fonte", "fonte"), descricao: c("descricao"), lancamentoId: c("lancamento_id", "uuid"), situacao: c("situacao"),
    pagamentoParcial: c("pagamento_parcial", "bool"), pagamentos: c("pagamentos", "json"), pagamentoIds: c("pagamento_ids", "uuids"),
    descontosCentavos: c("descontos_centavos", "centavos"), composicao: c("composicao", "json"),
  }),
  [TIPO.PAGAMENTO_VENDA]: tabela("fv2_pagamento_venda", {
    vendaId: c("venda_id", "uuid"), indice: c("indice", "inteiro"), forma: c("forma"), processador: c("processador"),
    valorCentavos: c("valor_centavos", "centavos"), estornadoCentavos: c("estornado_centavos", "centavos"), moeda: c("moeda"),
    dataPagamento: c("data_pagamento", "data"), contaId: c("conta_id", "uuid"), recebivelId: c("recebivel_id", "uuid"),
    movimentacaoId: c("movimentacao_id", "uuid"), situacao: c("situacao"),
  }),
  [TIPO.OBRIGACAO]: tabela("fv2_obrigacao", {
    grupoId: c("grupo_id", "uuid"), lancamentoId: c("lancamento_id", "uuid"), contraparteId: c("contraparte_id", "uuid"), descricao: c("descricao"),
    moeda: c("moeda"), competencia: c("competencia"), dataEmissao: c("data_emissao", "data"), vencimento: c("vencimento", "data"),
    parcela: c("parcela", "json"), recorrencia: c("recorrencia", "json"), documentoIds: c("documento_ids", "uuids"), fonte: c("fonte", "fonte"), ...TITULO,
  }),
  [TIPO.RECEBIVEL]: tabela("fv2_recebivel", {
    processador: c("processador"), contraparteId: c("contraparte_id", "uuid"), canal: c("canal"), vendaId: c("venda_id", "uuid"),
    pagamentoId: c("pagamento_id", "uuid"), pagamentoIndice: c("pagamento_indice", "inteiro"), forma: c("forma"),
    brutoCentavos: c("bruto_centavos", "centavos"), moeda: c("moeda"), retencoes: c("retencoes", "json"), dataPrevista: c("data_prevista", "data"),
    competencia: c("competencia"), descricao: c("descricao"), documentoIds: c("documento_ids", "uuids"), fonte: c("fonte", "fonte"), ...TITULO,
  }),
  [TIPO.MOVIMENTACAO]: tabela("fv2_movimentacao", {
    contaId: c("conta_id", "uuid"), dataEfetiva: c("data_efetiva", "data"), sentido: c("sentido"), valorCentavos: c("valor_centavos", "centavos"),
    moeda: c("moeda"), natureza: c("natureza"), descricao: c("descricao"), documentoId: c("documento_id", "uuid"), fonte: c("fonte", "fonte"),
    transferenciaId: c("transferencia_id", "uuid"), pagamentoId: c("pagamento_id", "uuid"), estornoId: c("estorno_id", "uuid"),
    alocadoCentavos: c("alocado_centavos", "centavos"), situacao: c("situacao"), situacaoConciliacao: c("situacao_conciliacao"),
  }),
  [TIPO.LIQUIDACAO]: tabela("fv2_liquidacao", {
    movimentacaoId: c("movimentacao_id", "uuid"), alvoTipo: c("alvo_tipo"), alvoId: c("alvo_id", "uuid"), valorCentavos: c("valor_centavos", "centavos"),
    estornadoCentavos: c("estornado_centavos", "centavos"), dataEfetiva: c("data_efetiva", "data"), situacao: c("situacao"),
  }),
  [TIPO.TRANSFERENCIA]: tabela("fv2_transferencia", {
    contaOrigemId: c("conta_origem_id", "uuid"), contaDestinoId: c("conta_destino_id", "uuid"), valorCentavos: c("valor_centavos", "centavos"),
    moeda: c("moeda"), dataEfetiva: c("data_efetiva", "data"), descricao: c("descricao"), saidaId: c("saida_id", "uuid"),
    entradaId: c("entrada_id", "uuid"), fonte: c("fonte", "fonte"), situacao: c("situacao"),
  }),
  [TIPO.AJUSTE]: tabela("fv2_ajuste", {
    alvoTipo: c("alvo_tipo"), alvoId: c("alvo_id", "uuid"), valorCentavos: c("valor_centavos", "centavos"), motivo: c("motivo"),
    competencia: c("competencia"), documentoId: c("documento_id", "uuid"), lancamentoId: c("lancamento_id", "uuid"), estornoId: c("estorno_id", "uuid"),
  }),
  [TIPO.ESTORNO]: tabela("fv2_estorno", {
    alvoTipo: c("alvo_tipo"), alvoId: c("alvo_id", "uuid"), valorCentavos: c("valor_centavos", "centavos"), motivo: c("motivo"),
    justificativa: c("justificativa"), dataEfetiva: c("data_efetiva", "data"), documentoId: c("documento_id", "uuid"),
    lancamentoId: c("lancamento_id", "uuid"), movimentacaoId: c("movimentacao_id", "uuid"),
  }),
  [TIPO.VINCULO_DOCUMENTAL]: tabela("fv2_vinculo_documental", { documentoId: c("documento_id", "uuid"), registroTipo: c("registro_tipo"), registroId: c("registro_id", "uuid") }),
  [TIPO.CORRESPONDENCIA]: tabela("fv2_correspondencia", {
    ladoA: c("lado_a", "json"), ladoB: c("lado_b", "json"), evidenciaDocumentoIds: c("evidencia_documento_ids", "uuids"), justificativa: c("justificativa"),
    diferencaCentavos: c("diferenca_centavos", "centavos"), situacao: c("situacao"), responsavelId: c("responsavel_id", "uuid"),
    decididoEm: c("decidido_em", "instante"), justificativaDecisao: c("justificativa_decisao"),
    relacao: c("relacao"), regra: c("regra"), forca: c("forca"),
  }),
  [TIPO.IMPORTACAO]: tabela("fv2_importacao", {
    fonte: c("fonte"), tipoRelatorio: c("tipo_relatorio"), formato: c("formato"), documentoId: c("documento_id", "uuid"),
    periodoInicio: c("periodo_inicio", "data"), periodoFim: c("periodo_fim", "data"), estado: c("estado"), compatibilidade: c("compatibilidade"),
    previa: c("previa", "json"), impressaoPrevia: c("impressao_previa"), relatorio: c("relatorio", "json"),
    substituiImportacaoId: c("substitui_importacao_id", "uuid"), substituidaPorId: c("substituida_por_id", "uuid"),
    confirmadoPor: c("confirmado_por", "uuid"), confirmadoEm: c("confirmado_em", "instante"), justificativa: c("justificativa"),
  }),
  [TIPO.REGISTRO_FONTE]: tabela("fv2_registro_fonte", {
    importacaoId: c("importacao_id", "uuid"), documentoId: c("documento_id", "uuid"), fonte: c("fonte"), tipoRelatorio: c("tipo_relatorio"),
    tipoRegistro: c("tipo_registro"), idExterno: c("id_externo"), identificacao: c("identificacao"), linha: c("linha", "inteiro"),
    dataReferencia: c("data_referencia", "data"), competencia: c("competencia"), valorCentavos: c("valor_centavos", "centavos"),
    dados: c("dados", "json"), original: c("original", "json"), conferencia: c("conferencia"), situacao: c("situacao"),
    substituidoPorImportacaoId: c("substituido_por_importacao_id", "uuid"),
  }),
  [TIPO.PROPOSTA]: tabela("fv2_proposta", {
    operacao: c("operacao"), estado: c("estado"), fonte: c("fonte"), tipoRelatorio: c("tipo_relatorio"), importacaoId: c("importacao_id", "uuid"),
    documentoIds: c("documento_ids", "uuids"), registroIds: c("registro_ids", "uuids"), competencia: c("competencia"), dataOperacao: c("data_operacao", "data"),
    natureza: c("natureza"), valorCentavos: c("valor_centavos", "centavos"), categoriaSugerida: c("categoria_sugerida"), comando: c("comando", "json"),
    duplicidades: c("duplicidades", "json"), divergencias: c("divergencias", "json"), confianca: c("confianca"), justificativa: c("justificativa"),
    efeitos: c("efeitos", "json"), decididoPor: c("decidido_por", "uuid"), decididoEm: c("decidido_em", "instante"), substituidaPorId: c("substituida_por_id", "uuid"),
  }),
  [TIPO.DIVERGENCIA_FONTE]: tabela("fv2_divergencia_fonte", {
    tipo: c("tipo"), periodoInicio: c("periodo_inicio", "data"), periodoFim: c("periodo_fim", "data"), totais: c("totais", "json"),
    diferencaCentavos: c("diferenca_centavos", "centavos"), porDia: c("por_dia", "json"), atipicos: c("atipicos", "json"), explicacoes: c("explicacoes", "json"),
    estado: c("estado"), registroIds: c("registro_ids", "uuids"),
  }),
  [TIPO.CONCESSAO]: tabela("fv2_concessao", {
    usuarioId: c("usuario_id", "uuid"), acoes: c("acoes", "json"), situacao: c("situacao"), concedidoPor: c("concedido_por", "uuid"),
    justificativa: c("justificativa"),
  }),
  [TIPO.SALDO_CONTA]: tabela("fv2_saldo_conta", {
    contaId: c("conta_id", "uuid"), data: c("data", "data"), valorCentavos: c("valor_centavos", "centavos"), documentoId: c("documento_id", "uuid"), observacao: c("observacao"),
  }),
  [TIPO.SESSAO_CAIXA]: tabela("fv2_sessao_caixa", {
    contaId: c("conta_id", "uuid"), situacao: c("situacao"), dataAbertura: c("data_abertura", "data"), saldoAberturaCentavos: c("saldo_abertura_centavos", "centavos"),
    observacao: c("observacao"), operacoes: c("operacoes", "json"), dataFechamento: c("data_fechamento", "data"), entradasCentavos: c("entradas_centavos", "centavos"),
    saidasCentavos: c("saidas_centavos", "centavos"), teoricoCentavos: c("teorico_centavos", "centavos"), contadoCentavos: c("contado_centavos", "centavos"),
    diferencaCentavos: c("diferenca_centavos", "centavos"), justificativa: c("justificativa"), fechadoPor: c("fechado_por", "uuid"), fechadoEm: c("fechado_em", "instante"),
  }),
  [TIPO.COMPETENCIA]: tabela("fv2_competencia", {
    competencia: c("competencia"), estado: c("estado"), metodologia: c("metodologia"), pendencias: c("pendencias", "json"),
    revisoes: c("revisoes", "inteiro"), decididoPor: c("decidido_por", "uuid"), decididoEm: c("decidido_em", "instante"),
  }),
});

export const HISTORICO = Object.freeze({
  tabela: "fv2_historico",
  campos: Object.freeze({
    id: c("id", "uuid"), organizacaoId: c("organizacao_id", "uuid"), unidadeId: c("unidade_id", "uuid"), registroTipo: c("registro_tipo"),
    registroId: c("registro_id", "uuid"), evento: c("evento"), antes: c("antes", "json"), depois: c("depois", "json"),
    justificativa: c("justificativa"), usuarioId: c("usuario_id", "uuid"), em: c("em", "instante"),
  }),
});
