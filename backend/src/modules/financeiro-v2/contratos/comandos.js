// Contratos de entrada do núcleo. Cada validador recebe a entrada bruta e devolve o comando NORMALIZADO
// (chaves em ordem fixa, textos aparados, valores conferidos) ou lança ErroFinanceiro. Nada além do validado chega às regras.
// Organização, unidade e usuário NUNCA fazem parte de um comando: vêm do contexto.
import { CODIGO, falhar } from "../dominio/erros.js";
import {
  ALVO_LIQUIDACAO, CANAL, CLASSIFICACAO, CONCILIAVEIS, ESTADO_COMPETENCIA, FORMA_PAGAMENTO, MOTIVO_ESTORNO, NATUREZA_LANCAMENTO,
  NATUREZA_MOVIMENTACAO, PROCESSADOR, SENTIDO, SISTEMA_FONTE, SISTEMAS_QUE_ORIGINAM_VENDA, TIPO, TIPO_CONTA, TIPO_CONTRAPARTE,
  TIPO_DOCUMENTO, VINCULAVEIS,
} from "../dominio/catalogos.js";
import { MODELO_DE_PLANO } from "../dominio/planoDeContas.js";
import { codigoDeOperadora } from "../dominio/operadoras.js";
import { bandeiraNormalizada } from "../dominio/taxasContratadas.js";
import { MOEDA_PADRAO, exigirCentavos, somar, somarLista } from "../dominio/dinheiro.js";
import { competenciaDe, exigirCompetencia, exigirData } from "../dominio/tempo.js";
import { exigirInteiro, exigirLista, exigirObjeto, exigirTexto, exigirUmDe, exigirUuid, semCamposDesconhecidos, uuidOpcional } from "../dominio/validacao.js";

/**
 * @typedef {{sistema:string, idExterno:string|null}} Fonte
 * @typedef {{forma:string, processador:string|null, valorCentavos:number}} PagamentoDeVenda
 * @typedef {{tipo:string, valorCentavos:number}} Deducao
 * @typedef {{tipo:string, id:string, valorCentavos:number}} ReferenciaConciliavel
 */

function fonte(f, { obrigatoria = false, exigirId = false } = {}) {
  if (f === undefined || f === null) {
    if (obrigatoria) falhar(CODIGO.ENTRADA_INVALIDA, "fonte é obrigatória.", { campo: "fonte" });
    return null;
  }
  semCamposDesconhecidos(f, ["sistema", "idExterno"], "fonte");
  const sistema = exigirUmDe(f.sistema, SISTEMA_FONTE, "fonte.sistema");
  const idExterno = exigirTexto(f.idExterno, "fonte.idExterno", { max: 120, opcional: !(exigirId && sistema !== SISTEMA_FONTE.MANUAL) });
  return { sistema, idExterno };
}

const moeda = (m) => {
  if (m !== undefined && m !== MOEDA_PADRAO) falhar(CODIGO.ENTRADA_INVALIDA, "Somente BRL é suportado nesta versão.", { campo: "moeda" });
  return MOEDA_PADRAO;
};

const booleano = (v, campo, padrao = false) => {
  if (v === undefined || v === null) return padrao;
  if (typeof v !== "boolean") falhar(CODIGO.ENTRADA_INVALIDA, `${campo} deve ser verdadeiro ou falso.`, { campo });
  return v;
};
const dataOpcional = (v, campo) => (v === undefined || v === null ? null : exigirData(v, campo));
const codigoDeCategoria = (v, campo = "categoria") => {
  const t = exigirTexto(v, campo, { max: 80 });
  if (!/^[A-Z][A-Z0-9_]*$/.test(t)) falhar(CODIGO.ENTRADA_INVALIDA, `${campo} deve ser um código em maiúsculas (letras, números e _).`, { campo });
  return t;
};
const justificativa = (v) => exigirTexto(v, "justificativa", { max: 500 });

/**
 * Um pagamento de venda. Três dimensões independentes: forma (como o cliente pagou), processador (quem fica devendo
 * o repasse, se houver) e conta (onde o dinheiro entrou, quando entrou direto).
 *  - com processador → nasce um recebível contra o processador; não existe conta de entrada agora.
 *  - sem processador → dinheiro/Pix recebido direto: NÃO gera recebível. Com `contaId`, já registra a entrada na conta;
 *    sem `contaId`, a entrada será reconhecida depois, pelo extrato, via conciliação.
 */
function pagamentoDeVenda(p, campo) {
  semCamposDesconhecidos(p, ["forma", "processador", "valorCentavos", "contaId", "dataPagamento", "bandeira", "operadora", "descricaoOriginal"], campo);
  const forma = exigirUmDe(p.forma, FORMA_PAGAMENTO, `${campo}.forma`);
  const processador = p.processador === undefined || p.processador === null ? null : exigirUmDe(p.processador, PROCESSADOR, `${campo}.processador`);
  if (forma === FORMA_PAGAMENTO.DINHEIRO && processador) falhar(CODIGO.ENTRADA_INVALIDA, "Pagamento em dinheiro não tem processador.", { campo: `${campo}.processador` });
  const contaId = uuidOpcional(p.contaId, `${campo}.contaId`);
  if (processador && contaId) falhar(CODIGO.ENTRADA_INVALIDA, "Pagamento com processador não entra direto em conta: o repasse é que entra, depois.", { campo: `${campo}.contaId` });
  const saida = { forma, processador, valorCentavos: exigirCentavos(p.valorCentavos, `${campo}.valorCentavos`, { positivo: true }) };
  // Campos opcionais só aparecem quando informados: a impressão de idempotência de quem não os usa continua a mesma.
  if (contaId) saida.contaId = contaId;
  if (p.dataPagamento !== undefined && p.dataPagamento !== null) saida.dataPagamento = dataOpcional(p.dataPagamento, `${campo}.dataPagamento`);
  // Fase 02: bandeira (cartão/voucher), operadora (código do cadastro) e a descrição ORIGINAL da fonte (auditoria).
  if (p.bandeira !== undefined && p.bandeira !== null && p.bandeira !== "") {
    if (![FORMA_PAGAMENTO.DEBITO, FORMA_PAGAMENTO.CREDITO, FORMA_PAGAMENTO.VALE].includes(forma)) falhar(CODIGO.ENTRADA_INVALIDA, "Bandeira só em débito, crédito ou vale.", { campo: `${campo}.bandeira` });
    saida.bandeira = bandeiraNormalizada(exigirTexto(p.bandeira, `${campo}.bandeira`, { max: 30 }));
  }
  if (p.operadora !== undefined && p.operadora !== null && p.operadora !== "") {
    if (!processador) falhar(CODIGO.ENTRADA_INVALIDA, "Operadora só em pagamento com processador.", { campo: `${campo}.operadora` });
    saida.operadora = codigoDeOperadora(p.operadora, `${campo}.operadora`);
  }
  if (p.descricaoOriginal !== undefined && p.descricaoOriginal !== null && p.descricaoOriginal !== "") saida.descricaoOriginal = exigirTexto(p.descricaoOriginal, `${campo}.descricaoOriginal`, { max: 120 });
  return saida;
}

/**
 * COMPOSIÇÃO ECONÔMICA da venda (opcional; venda sem composição segue o contrato anterior):
 *   receita própria (= brutoCentavos) = itens + acréscimos + serviços da empresa;
 *   descontos: cada um com SEU financiador — LOJA (dedução comercial), TERCEIRO (subsídio: só com DOCUMENTO que comprove o
 *   ressarcimento vira recebível do terceiro; sem documento, fica como dedução a classificar — nada de recebível fictício),
 *   PENDENTE (financiador não comprovado: dedução a classificar);
 *   pagamentos do consumidor = receita − descontos da loja/pendentes − subsídios de terceiros.
 * Valores cobrados em nome de terceiros ainda não têm tratamento (exigem obrigação com o terceiro): são recusados.
 */
export const FINANCIADOR_DESCONTO = Object.freeze(["LOJA", "TERCEIRO", "PENDENTE"]);
function composicaoDeVenda(e, brutoCentavos) {
  semCamposDesconhecidos(e, ["itensCentavos", "acrescimosCentavos", "servicosCentavos", "terceirosCentavos", "descontos"], "composicao");
  const itensCentavos = exigirCentavos(e.itensCentavos, "composicao.itensCentavos", { naoNegativo: true });
  const acrescimosCentavos = exigirCentavos(e.acrescimosCentavos ?? 0, "composicao.acrescimosCentavos", { naoNegativo: true });
  const servicosCentavos = exigirCentavos(e.servicosCentavos ?? 0, "composicao.servicosCentavos", { naoNegativo: true });
  if (exigirCentavos(e.terceirosCentavos ?? 0, "composicao.terceirosCentavos", { naoNegativo: true }) > 0) {
    falhar(CODIGO.ENTRADA_INVALIDA, "Valores cobrados em nome de terceiros ainda não têm tratamento (exigem obrigação com o terceiro).", { campo: "composicao.terceirosCentavos" });
  }
  const descontos = exigirLista(e.descontos ?? [], "composicao.descontos", { min: 0, max: 20 }).map((d, i) => {
    semCamposDesconhecidos(d, ["valorCentavos", "financiador", "terceiro", "descricao", "documentoId"], `composicao.descontos[${i}]`);
    const financiador = exigirUmDe(d.financiador, FINANCIADOR_DESCONTO, `composicao.descontos[${i}].financiador`);
    if (financiador !== "TERCEIRO" && d.terceiro !== undefined && d.terceiro !== null) falhar(CODIGO.ENTRADA_INVALIDA, "Só desconto de TERCEIRO indica o terceiro.", { campo: `composicao.descontos[${i}].terceiro` });
    return {
      valorCentavos: exigirCentavos(d.valorCentavos, `composicao.descontos[${i}].valorCentavos`, { positivo: true }), financiador,
      terceiro: financiador === "TERCEIRO" ? exigirUmDe(d.terceiro, PROCESSADOR, `composicao.descontos[${i}].terceiro`) : null,
      descricao: exigirTexto(d.descricao, `composicao.descontos[${i}].descricao`, { opcional: true }),
      documentoId: uuidOpcional(d.documentoId, `composicao.descontos[${i}].documentoId`),
    };
  });
  if (somar(itensCentavos, acrescimosCentavos, servicosCentavos) !== brutoCentavos) {
    falhar(CODIGO.VALOR_INVALIDO, "brutoCentavos deve ser a receita própria: itens + acréscimos + serviços (nunca o valor após descontos).", { campo: "brutoCentavos" });
  }
  if (somarLista(descontos, (d) => d.valorCentavos) > brutoCentavos) falhar(CODIGO.VALOR_INVALIDO, "Descontos superam a receita da venda.", { campo: "composicao.descontos" });
  return { itensCentavos, acrescimosCentavos, servicosCentavos, terceirosCentavos: 0, descontos };
}

const documentos = (ids, campo = "documentoIds") => [...new Set(exigirLista(ids ?? [], campo, { min: 0, max: 50 }).map((id, i) => exigirUuid(id, `${campo}[${i}]`)))];

export function validarConta(e) {
  semCamposDesconhecidos(e, ["tipo", "nome", "instituicao"], "conta");
  return { tipo: exigirUmDe(e.tipo, TIPO_CONTA, "tipo"), nome: exigirTexto(e.nome, "nome", { max: 80 }), instituicao: exigirTexto(e.instituicao, "instituicao", { max: 80, opcional: true }) };
}

export function validarContraparte(e) {
  semCamposDesconhecidos(e, ["tipo", "nome"], "contraparte");
  return { tipo: exigirUmDe(e.tipo, TIPO_CONTRAPARTE, "tipo"), nome: exigirTexto(e.nome, "nome", { max: 120 }) };
}

export function validarVenda(e) {
  semCamposDesconhecidos(e, ["canal", "dataVenda", "competencia", "brutoCentavos", "moeda", "pagamentos", "pagamentoParcial", "fonte", "descricao", "composicao"], "venda");
  const dataVenda = exigirData(e.dataVenda, "dataVenda");
  const brutoCentavos = exigirCentavos(e.brutoCentavos, "brutoCentavos", { positivo: true });
  const f = fonte(e.fonte, { obrigatoria: true, exigirId: true });
  if (!SISTEMAS_QUE_ORIGINAM_VENDA.includes(f.sistema)) {
    falhar(CODIGO.FONTE_NAO_ORIGINA_VENDA, "Este sistema não origina vendas: seus registros são evidência de pagamento e entram por conciliação.", { sistema: f.sistema });
  }
  const pagamentoParcial = booleano(e.pagamentoParcial, "pagamentoParcial");
  // Com composição, a lista pode ficar vazia só quando nada cabe ao consumidor (ex.: subsídio integral de terceiro): a soma abaixo confere.
  const comComposicao = e.composicao !== undefined && e.composicao !== null;
  const pagamentos = exigirLista(e.pagamentos, "pagamentos", { min: pagamentoParcial || comComposicao ? 0 : 1, max: 20 }).map((p, i) => pagamentoDeVenda(p, `pagamentos[${i}]`));
  const pago = somarLista(pagamentos, (p) => p.valorCentavos);
  const composicao = e.composicao === undefined || e.composicao === null ? null : composicaoDeVenda(e.composicao, brutoCentavos);
  // O consumidor paga a receita menos os descontos (da loja, pendentes e subsídios de terceiros — estes o terceiro paga).
  const aPagar = brutoCentavos - somarLista(composicao?.descontos ?? [], (d) => d.valorCentavos);
  // Sem declarar pagamento parcial, a soma tem de FECHAR: diferença silenciosa esconde erro de importação.
  if (pago > aPagar || (!pagamentoParcial && pago !== aPagar)) {
    falhar(CODIGO.PAGAMENTOS_NAO_FECHAM, "A soma das formas de pagamento deve ser igual ao valor bruto da venda (ou menor, se a venda for declarada com pagamento parcial).");
  }
  return {
    canal: exigirUmDe(e.canal, CANAL, "canal"),
    dataVenda,
    competencia: e.competencia === undefined ? competenciaDe(dataVenda) : exigirCompetencia(e.competencia),
    brutoCentavos,
    moeda: moeda(e.moeda),
    pagamentos,
    fonte: f,
    descricao: exigirTexto(e.descricao, "descricao", { opcional: true }),
    ...(pagamentoParcial ? { pagamentoParcial } : {}),
    ...(composicao ? { composicao } : {}),
  };
}

export function validarPagamentoDeVenda(e) {
  semCamposDesconhecidos(e, ["vendaId", "forma", "processador", "valorCentavos", "contaId", "dataPagamento", "fonte"], "pagamento");
  const { vendaId, fonte: f, ...p } = e;
  return { vendaId: exigirUuid(vendaId, "vendaId"), ...pagamentoDeVenda(p, "pagamento"), fonte: fonte(f) };
}

export function validarEstornoDePagamento(e) {
  semCamposDesconhecidos(e, ["pagamentoId", "valorCentavos", "motivo", "justificativa", "contaId", "dataEfetiva", "documentoId"], "estorno");
  return {
    pagamentoId: exigirUuid(e.pagamentoId, "pagamentoId"),
    valorCentavos: e.valorCentavos === undefined || e.valorCentavos === null ? null : exigirCentavos(e.valorCentavos, "valorCentavos", { positivo: true }),
    motivo: exigirUmDe(e.motivo, MOTIVO_ESTORNO, "motivo"),
    justificativa: justificativa(e.justificativa),
    contaId: uuidOpcional(e.contaId, "contaId"),
    dataEfetiva: dataOpcional(e.dataEfetiva, "dataEfetiva"),
    documentoId: uuidOpcional(e.documentoId, "documentoId"),
  };
}

/** 17/11/2026 — correção de entrada em conta de um pagamento de venda: só venda, pagamento e justificativa (nada de valor/conta/data). */
export function validarCorrecaoDeEntrada(e) {
  semCamposDesconhecidos(e, ["vendaId", "pagamentoId", "justificativa"], "correção de entrada");
  return { vendaId: exigirUuid(e.vendaId, "vendaId"), pagamentoId: exigirUuid(e.pagamentoId, "pagamentoId"), justificativa: justificativa(e.justificativa) };
}

const cancelamento = (campoId, nome) => (e) => {
  semCamposDesconhecidos(e, [campoId, "justificativa"], nome);
  return { [campoId]: exigirUuid(e[campoId], campoId), justificativa: justificativa(e.justificativa) };
};
export const validarCancelamentoVenda = cancelamento("vendaId", "cancelamento");
export const validarCancelamentoRecebivel = cancelamento("recebivelId", "cancelamento");
export const validarEstornoMovimentacao = cancelamento("movimentacaoId", "estorno");
export const validarEstornoTransferencia = cancelamento("transferenciaId", "estorno");

export function validarCategoria(e) {
  semCamposDesconhecidos(e, ["codigo", "nome", "classificacao", "natureza", "paiCodigo", "aceitaLancamento", "exigeDocumento"], "categoria");
  return {
    codigo: codigoDeCategoria(e.codigo, "codigo"),
    nome: exigirTexto(e.nome, "nome", { max: 120 }),
    // Categoria filha herda a classificação da superior; a raiz precisa informar.
    classificacao: e.classificacao === undefined || e.classificacao === null ? null : exigirUmDe(e.classificacao, CLASSIFICACAO, "classificacao"),
    natureza: e.natureza === undefined || e.natureza === null ? null : exigirUmDe(e.natureza, NATUREZA_LANCAMENTO, "natureza"),
    paiCodigo: e.paiCodigo === undefined || e.paiCodigo === null ? null : codigoDeCategoria(e.paiCodigo, "paiCodigo"),
    aceitaLancamento: booleano(e.aceitaLancamento, "aceitaLancamento", true),
    exigeDocumento: booleano(e.exigeDocumento, "exigeDocumento", false),
  };
}

export function validarAlteracaoCategoria(e) {
  semCamposDesconhecidos(e, ["codigo", "mudancas", "justificativa"], "alteracaoDeCategoria");
  semCamposDesconhecidos(e.mudancas, ["nome", "ativa", "aceitaLancamento", "exigeDocumento"], "mudancas");
  const mudancas = {};
  if (e.mudancas.nome !== undefined) mudancas.nome = exigirTexto(e.mudancas.nome, "mudancas.nome", { max: 120 });
  for (const campo of ["ativa", "aceitaLancamento", "exigeDocumento"]) {
    if (e.mudancas[campo] !== undefined) mudancas[campo] = booleano(e.mudancas[campo], `mudancas.${campo}`);
  }
  if (!Object.keys(mudancas).length) falhar(CODIGO.ENTRADA_INVALIDA, "Nenhuma mudança informada.");
  return { codigo: codigoDeCategoria(e.codigo, "codigo"), mudancas, justificativa: justificativa(e.justificativa) };
}

export function validarImplantacaoDePlano(e) {
  semCamposDesconhecidos(e, ["modelo"], "implantacao");
  return { modelo: exigirUmDe(e.modelo, Object.keys(MODELO_DE_PLANO), "modelo") };
}

export function validarObrigacao(e) {
  semCamposDesconhecidos(e, ["contraparteId", "contraparteNova", "valorOriginalCentavos", "moeda", "categoria", "descricao", "competencia", "dataEmissao", "vencimento", "parcelas", "recorrencia", "documentoIds", "fonte", "identificador", "observacao"], "obrigacao");
  // Abertura: fornecedor NOVO criado na MESMA transação da obrigação (nunca fica órfão se a obrigação for recusada).
  if ((e.contraparteId === undefined) === (e.contraparteNova === undefined)) falhar(CODIGO.ENTRADA_INVALIDA, "Informe a contraparte existente OU a nova (exatamente uma).", { campo: "contraparteId" });
  const dataEmissao = exigirData(e.dataEmissao, "dataEmissao");
  const vencimento = exigirData(e.vencimento, "vencimento");
  if (vencimento < dataEmissao) falhar(CODIGO.DATA_INVALIDA, "O vencimento não pode ser anterior à emissão.", { campo: "vencimento" });
  const parcelas = e.parcelas === undefined ? 1 : exigirInteiro(e.parcelas, "parcelas", { min: 1, max: 120 });
  const valorOriginalCentavos = exigirCentavos(e.valorOriginalCentavos, "valorOriginalCentavos", { positivo: true });
  if (valorOriginalCentavos < parcelas) falhar(CODIGO.VALOR_INVALIDO, "Valor insuficiente para a quantidade de parcelas.", { campo: "parcelas" });
  let recorrencia = null;
  if (e.recorrencia !== undefined && e.recorrencia !== null) {
    semCamposDesconhecidos(e.recorrencia, ["periodicidade", "diaDoMes"], "recorrencia");
    recorrencia = { periodicidade: exigirUmDe(e.recorrencia.periodicidade, ["MENSAL"], "recorrencia.periodicidade"), diaDoMes: exigirInteiro(e.recorrencia.diaDoMes, "recorrencia.diaDoMes", { min: 1, max: 31 }) };
  }
  return {
    ...(e.contraparteNova !== undefined ? { contraparteNova: validarContraparte(e.contraparteNova) } : { contraparteId: exigirUuid(e.contraparteId, "contraparteId") }),
    valorOriginalCentavos,
    moeda: moeda(e.moeda),
    categoria: codigoDeCategoria(e.categoria),
    descricao: exigirTexto(e.descricao, "descricao"),
    competencia: exigirCompetencia(e.competencia),
    dataEmissao,
    vencimento,
    parcelas,
    recorrencia,
    documentoIds: documentos(e.documentoIds),
    fonte: fonte(e.fonte),
    // Título anterior à abertura: número do documento/repasse/pedido, usado na conferência das importações posteriores.
    ...(e.identificador !== undefined && e.identificador !== null && e.identificador !== "" ? { identificador: identificadorDoTitulo(e.identificador) } : {}),
    // 27/11: observação dita (ex.: composição de um empréstimo pago por boleto) — só quando informada (a impressão das demais não muda)
    ...(e.observacao !== undefined && e.observacao !== null && e.observacao !== "" ? { observacao: exigirTexto(e.observacao, "observacao", { max: 500 }) } : {}),
  };
}

/**
 * 26/11 — conta a pagar RELATADA (sem documento) em parcelas com vencimentos EXPLÍCITOS (ex.: cartão: 19/12 e 19/01). Cada parcela
 * traz o próprio valor; a soma é o total do lançamento. Vencimentos em ordem estritamente crescente, nunca antes da emissão;
 * a competência é a da COMPRA (nunca derivada dos vencimentos). Sem documento, sem recorrência, de 1 a 24 parcelas.
 */
export function validarContaParcelada(e) {
  semCamposDesconhecidos(e, ["contraparteNova", "categoria", "descricao", "competencia", "dataEmissao", "parcelas", "moeda", "fonte", "formaPagamento", "observacao"], "contaParcelada");
  if (!Array.isArray(e.parcelas) || e.parcelas.length < 1 || e.parcelas.length > 24) falhar(CODIGO.ENTRADA_INVALIDA, "Informe de 1 a 24 parcelas.", { campo: "parcelas" });
  const dataEmissao = exigirData(e.dataEmissao, "dataEmissao");
  const parcelas = e.parcelas.map((p, i) => {
    semCamposDesconhecidos(p, ["vencimento", "valorCentavos"], `parcelas[${i}]`);
    return { vencimento: exigirData(p.vencimento, `parcelas[${i}].vencimento`), valorCentavos: exigirCentavos(p.valorCentavos, `parcelas[${i}].valorCentavos`, { positivo: true }) };
  });
  for (const [i, p] of parcelas.entries()) {
    if (p.vencimento < dataEmissao) falhar(CODIGO.DATA_INVALIDA, "O vencimento não pode ser anterior à emissão.", { campo: `parcelas[${i}].vencimento` });
    if (i > 0 && p.vencimento <= parcelas[i - 1].vencimento) falhar(CODIGO.DATA_INVALIDA, "Os vencimentos das parcelas precisam estar em ordem crescente.", { campo: `parcelas[${i}].vencimento` });
  }
  return {
    contraparteNova: validarContraparte(e.contraparteNova),
    categoria: codigoDeCategoria(e.categoria),
    descricao: exigirTexto(e.descricao, "descricao"),
    competencia: exigirCompetencia(e.competencia),
    dataEmissao,
    parcelas,
    valorOriginalCentavos: parcelas.reduce((s, p) => s + p.valorCentavos, 0),
    moeda: moeda(e.moeda),
    formaPagamento: e.formaPagamento === undefined || e.formaPagamento === null ? null : exigirUmDe(e.formaPagamento, ["CARTAO", "BOLETO", "PIX", "DINHEIRO", "TRANSFERENCIA"], "formaPagamento"),
    // 27/11: observações ditas pela pessoa (ex.: composição "Jailton R$ 395,34; Vanessa R$ 2.515,74"), preservadas na conta (texto livre)
    observacao: e.observacao === undefined || e.observacao === null || e.observacao === "" ? null : exigirTexto(e.observacao, "observacao", { max: 500 }),
    fonte: fonte(e.fonte),
  };
}

/** Identificador externo de um título (NF, ID do repasse, pedido, Stone ID): comparado sem maiúsculas nem espaços. */
export const identificadorDoTitulo = (v) => exigirTexto(v, "identificador", { max: 80 }).replace(/\s+/g, "").toUpperCase();

export function validarRecebivel(e) {
  semCamposDesconhecidos(e, ["processador", "contraparteId", "contraparteNova", "canal", "vendaId", "brutoCentavos", "moeda", "retencoes", "dataPrevista", "competencia", "descricao", "documentoIds", "fonte", "anteriorAAbertura", "dataOrigem", "identificador"], "recebivel");
  const processador = e.processador === undefined || e.processador === null ? null : exigirUmDe(e.processador, PROCESSADOR, "processador");
  const contraparteId = uuidOpcional(e.contraparteId, "contraparteId");
  const contraparteNova = e.contraparteNova === undefined || e.contraparteNova === null ? null : validarContraparte(e.contraparteNova);
  if ([processador, contraparteId, contraparteNova].filter(Boolean).length !== 1) falhar(CODIGO.ENTRADA_INVALIDA, "Informe o devedor: processador OU contraparte (exatamente um).");
  // Abertura: título que já estava em aberto ANTES da competência de início. Sem retenções (pertencem ao período anterior,
  // que o v2 não apura) e sem venda (a venda é de antes do v2): é só a posição inicial do ativo.
  const anteriorAAbertura = booleano(e.anteriorAAbertura, "anteriorAAbertura");
  let dataOrigem = null;
  if (anteriorAAbertura) {
    dataOrigem = exigirData(e.dataOrigem, "dataOrigem");
    if ((e.retencoes ?? []).length) falhar(CODIGO.ENTRADA_INVALIDA, "Título anterior à abertura entra pelo saldo a receber, sem retenções.", { campo: "retencoes" });
    if (e.vendaId !== undefined && e.vendaId !== null) falhar(CODIGO.ENTRADA_INVALIDA, "Título anterior à abertura não se vincula a venda do v2.", { campo: "vendaId" });
  } else if ((e.dataOrigem ?? null) !== null || (e.identificador ?? "") !== "") falhar(CODIGO.ENTRADA_INVALIDA, "dataOrigem e identificador só valem para título anterior à abertura.", { campo: "dataOrigem" });
  const brutoCentavos = exigirCentavos(e.brutoCentavos, "brutoCentavos", { positivo: true });
  // Retenção = o que o processador/canal desconta do repasse. A CATEGORIA de cada uma define a natureza econômica
  // (dedução comercial, despesa de recebimento, despesa comercial, marketing, encargo financeiro...).
  const retencoes = exigirLista(e.retencoes ?? [], "retencoes", { min: 0, max: 50 }).map((d, i) => {
    semCamposDesconhecidos(d, ["categoria", "valorCentavos", "descricao"], `retencoes[${i}]`);
    return {
      categoria: codigoDeCategoria(d.categoria, `retencoes[${i}].categoria`),
      valorCentavos: exigirCentavos(d.valorCentavos, `retencoes[${i}].valorCentavos`, { positivo: true }),
      descricao: exigirTexto(d.descricao, `retencoes[${i}].descricao`, { opcional: true }),
    };
  });
  if (somarLista(retencoes, (d) => d.valorCentavos) > brutoCentavos) falhar(CODIGO.VALOR_INVALIDO, "As retenções não podem superar o valor bruto.", { campo: "retencoes" });
  const competencia = exigirCompetencia(e.competencia);
  if (anteriorAAbertura && dataOrigem >= `${competencia}-01`) falhar(CODIGO.DATA_INVALIDA, "Título anterior à abertura tem origem antes do 1º dia da competência de início.", { campo: "dataOrigem" });
  const identificador = anteriorAAbertura && (e.identificador ?? "") !== "" ? identificadorDoTitulo(e.identificador) : null;
  return {
    processador,
    contraparteId,
    // Campos novos só aparecem quando usados: a impressão de idempotência dos recebíveis já existentes não muda.
    ...(contraparteNova ? { contraparteNova } : {}),
    ...(anteriorAAbertura ? { anteriorAAbertura: true, dataOrigem, ...(identificador ? { identificador } : {}) } : {}),
    canal: e.canal === undefined || e.canal === null ? null : exigirUmDe(e.canal, CANAL, "canal"),
    vendaId: uuidOpcional(e.vendaId, "vendaId"),
    brutoCentavos,
    moeda: moeda(e.moeda),
    retencoes,
    dataPrevista: e.dataPrevista === undefined || e.dataPrevista === null ? null : exigirData(e.dataPrevista, "dataPrevista"),
    competencia,
    descricao: exigirTexto(e.descricao, "descricao", { opcional: true }),
    documentoIds: documentos(e.documentoIds),
    fonte: fonte(e.fonte),
  };
}

export function validarMovimentacao(e) {
  semCamposDesconhecidos(e, ["contaId", "dataEfetiva", "sentido", "valorCentavos", "moeda", "natureza", "descricao", "documentoId", "fonte"], "movimentacao");
  const natureza = exigirUmDe(e.natureza, NATUREZA_MOVIMENTACAO, "natureza");
  if (natureza === NATUREZA_MOVIMENTACAO.TRANSFERENCIA_INTERNA) {
    falhar(CODIGO.TRANSFERENCIA_INVALIDA, "Transferência interna só existe como par saída+entrada: use registrarTransferencia.");
  }
  if (natureza === NATUREZA_MOVIMENTACAO.DEVOLUCAO) {
    falhar(CODIGO.ENTRADA_INVALIDA, "Devolução ao cliente nasce do estorno de um pagamento de venda: use estornarPagamentoDeVenda.", { campo: "natureza" });
  }
  const sentido = exigirUmDe(e.sentido, SENTIDO, "sentido");
  if ((natureza === NATUREZA_MOVIMENTACAO.PAGAMENTO && sentido !== SENTIDO.SAIDA) || (natureza === NATUREZA_MOVIMENTACAO.RECEBIMENTO && sentido !== SENTIDO.ENTRADA)) {
    falhar(CODIGO.ENTRADA_INVALIDA, "Natureza incompatível com o sentido da movimentação.", { campo: "natureza" });
  }
  return {
    contaId: exigirUuid(e.contaId, "contaId"),
    dataEfetiva: exigirData(e.dataEfetiva, "dataEfetiva"),
    sentido,
    valorCentavos: exigirCentavos(e.valorCentavos, "valorCentavos", { positivo: true }),
    moeda: moeda(e.moeda),
    natureza,
    descricao: exigirTexto(e.descricao, "descricao", { opcional: true }),
    documentoId: uuidOpcional(e.documentoId, "documentoId"),
    fonte: fonte(e.fonte),
  };
}

export function validarLiquidacao(e) {
  semCamposDesconhecidos(e, ["movimentacaoId", "alocacoes"], "liquidacao");
  const alocacoes = exigirLista(e.alocacoes, "alocacoes", { min: 1, max: 200 }).map((a, i) => {
    semCamposDesconhecidos(a, ["alvoTipo", "alvoId", "valorCentavos"], `alocacoes[${i}]`);
    return {
      alvoTipo: exigirUmDe(a.alvoTipo, ALVO_LIQUIDACAO, `alocacoes[${i}].alvoTipo`),
      alvoId: exigirUuid(a.alvoId, `alocacoes[${i}].alvoId`),
      valorCentavos: exigirCentavos(a.valorCentavos, `alocacoes[${i}].valorCentavos`, { positivo: true }),
    };
  });
  if (new Set(alocacoes.map((a) => a.alvoId)).size !== alocacoes.length) {
    falhar(CODIGO.ENTRADA_INVALIDA, "O mesmo título aparece mais de uma vez na liquidação.", { campo: "alocacoes" });
  }
  return { movimentacaoId: exigirUuid(e.movimentacaoId, "movimentacaoId"), alocacoes };
}

export function validarEstornoLiquidacao(e) {
  semCamposDesconhecidos(e, ["liquidacaoId", "valorCentavos", "justificativa", "documentoId"], "estorno");
  return {
    liquidacaoId: exigirUuid(e.liquidacaoId, "liquidacaoId"),
    // Sem valor = estorno TOTAL do que ainda está válido. Com valor = estorno parcial.
    valorCentavos: e.valorCentavos === undefined || e.valorCentavos === null ? null : exigirCentavos(e.valorCentavos, "valorCentavos", { positivo: true }),
    justificativa: justificativa(e.justificativa),
    documentoId: uuidOpcional(e.documentoId, "documentoId"),
  };
}

export function validarTransferencia(e) {
  semCamposDesconhecidos(e, ["contaOrigemId", "contaDestinoId", "valorCentavos", "moeda", "dataEfetiva", "descricao", "fonte"], "transferencia");
  const contaOrigemId = exigirUuid(e.contaOrigemId, "contaOrigemId");
  const contaDestinoId = exigirUuid(e.contaDestinoId, "contaDestinoId");
  if (contaOrigemId === contaDestinoId) falhar(CODIGO.TRANSFERENCIA_INVALIDA, "Origem e destino devem ser contas diferentes.");
  return {
    contaOrigemId,
    contaDestinoId,
    valorCentavos: exigirCentavos(e.valorCentavos, "valorCentavos", { positivo: true }),
    moeda: moeda(e.moeda),
    dataEfetiva: exigirData(e.dataEfetiva, "dataEfetiva"),
    descricao: exigirTexto(e.descricao, "descricao", { opcional: true }),
    fonte: fonte(e.fonte),
  };
}

export function validarAjuste(e) {
  semCamposDesconhecidos(e, ["alvoTipo", "alvoId", "valorCentavos", "motivo", "categoria", "competencia", "documentoId"], "ajuste");
  return {
    alvoTipo: exigirUmDe(e.alvoTipo, ALVO_LIQUIDACAO, "alvoTipo"),
    alvoId: exigirUuid(e.alvoId, "alvoId"),
    valorCentavos: exigirCentavos(e.valorCentavos, "valorCentavos", { naoZero: true }),
    motivo: exigirTexto(e.motivo, "motivo", { max: 500 }),
    categoria: codigoDeCategoria(e.categoria),
    competencia: e.competencia === undefined || e.competencia === null ? null : exigirCompetencia(e.competencia),
    documentoId: uuidOpcional(e.documentoId, "documentoId"),
  };
}

export function validarCorrecaoObrigacao(e) {
  semCamposDesconhecidos(e, ["obrigacaoId", "mudancas", "justificativa", "versaoEsperada"], "correcao");
  semCamposDesconhecidos(e.mudancas, ["vencimento", "descricao", "contraparteId"], "mudancas");
  const mudancas = {};
  if (e.mudancas.contraparteId !== undefined) mudancas.contraparteId = exigirUuid(e.mudancas.contraparteId, "mudancas.contraparteId");
  if (e.mudancas.vencimento !== undefined) mudancas.vencimento = exigirData(e.mudancas.vencimento, "mudancas.vencimento");
  if (e.mudancas.descricao !== undefined) mudancas.descricao = exigirTexto(e.mudancas.descricao, "mudancas.descricao");
  if (!Object.keys(mudancas).length) falhar(CODIGO.ENTRADA_INVALIDA, "Nenhuma mudança informada.");
  return {
    obrigacaoId: exigirUuid(e.obrigacaoId, "obrigacaoId"),
    mudancas,
    justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500 }),
    versaoEsperada: e.versaoEsperada === undefined ? null : exigirInteiro(e.versaoEsperada, "versaoEsperada", { min: 1 }),
  };
}

/**
 * 28/11 (0036) — correção CADASTRAL estreita de conta a pagar. `abrangencia`: PARCELA (só a conta indicada) ou GRUPO (todas as
 * parcelas da compra). Vencimento só por PARCELA (cada parcela tem o seu). `versaoEsperada` OBRIGATÓRIA (a versão vista no resumo:
 * uma confirmação antiga nunca altera conta que mudou). Valor, competência e categoria NÃO entram aqui.
 */
export function validarCorrecaoDeContaAPagar(e) {
  semCamposDesconhecidos(e, ["obrigacaoId", "abrangencia", "mudancas", "justificativa", "versaoEsperada", "versoes"], "correcaoDeConta");
  semCamposDesconhecidos(e.mudancas, ["contraparteId", "contraparteNova", "vencimento", "descricao", "observacao", "formaPagamento"], "mudancas");
  const m = e.mudancas;
  if (m.contraparteId !== undefined && m.contraparteNova !== undefined) falhar(CODIGO.ENTRADA_INVALIDA, "Informe o fornecedor existente OU o novo.", { campo: "mudancas.contraparteId" });
  const mudancas = {};
  if (m.contraparteId !== undefined) mudancas.contraparteId = exigirUuid(m.contraparteId, "mudancas.contraparteId");
  if (m.contraparteNova !== undefined) mudancas.contraparteNova = validarContraparte(m.contraparteNova);
  if (m.vencimento !== undefined) mudancas.vencimento = exigirData(m.vencimento, "mudancas.vencimento");
  if (m.descricao !== undefined) mudancas.descricao = exigirTexto(m.descricao, "mudancas.descricao", { max: 300 });
  if (m.observacao !== undefined) mudancas.observacao = m.observacao === null ? null : exigirTexto(m.observacao, "mudancas.observacao", { max: 500 });
  if (m.formaPagamento !== undefined) mudancas.formaPagamento = m.formaPagamento === null ? null : exigirUmDe(m.formaPagamento, ["CARTAO", "BOLETO", "PIX", "DINHEIRO", "TRANSFERENCIA"], "mudancas.formaPagamento");
  if (!Object.keys(mudancas).length) falhar(CODIGO.ENTRADA_INVALIDA, "Nenhuma mudança informada.");
  const abrangencia = exigirUmDe(e.abrangencia ?? "PARCELA", ["PARCELA", "GRUPO"], "abrangencia");
  if (abrangencia === "GRUPO" && mudancas.vencimento) falhar(CODIGO.ENTRADA_INVALIDA, "Vencimento se corrige parcela por parcela.", { campo: "mudancas.vencimento" });
  // GRUPO: a versão de CADA parcela vista no resumo (id → versão). O conjunto confirmado é exatamente esse — nem mais, nem menos.
  let versoes = null;
  if (abrangencia === "GRUPO") {
    if (!e.versoes || typeof e.versoes !== "object" || Array.isArray(e.versoes) || !Object.keys(e.versoes).length) falhar(CODIGO.ENTRADA_INVALIDA, "Informe a versão de cada parcela confirmada.", { campo: "versoes" });
    versoes = Object.fromEntries(Object.entries(e.versoes).map(([id, v]) => [exigirUuid(id, "versoes"), exigirInteiro(v, "versoes", { min: 1 })]));
  } else if (e.versoes !== undefined) falhar(CODIGO.ENTRADA_INVALIDA, "Versões por parcela só na correção de todas as parcelas.", { campo: "versoes" });
  return {
    obrigacaoId: exigirUuid(e.obrigacaoId, "obrigacaoId"), abrangencia, mudancas, versoes,
    justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500 }),
    versaoEsperada: exigirInteiro(e.versaoEsperada, "versaoEsperada", { min: 1 }),
  };
}

export function validarCancelamentoObrigacao(e) {
  semCamposDesconhecidos(e, ["obrigacaoId", "justificativa"], "cancelamento");
  return { obrigacaoId: exigirUuid(e.obrigacaoId, "obrigacaoId"), justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500 }) };
}

// 28/11 (0037) — operações ESTREITAS de conta a pagar existente (MOVA Operador Financeiro, fase 2). `versoes` = id → versão de CADA
// registro confirmado no resumo (parcelas e, quando a operação o altera, o lançamento): o conjunto confirmado é exatamente esse.
const versoesConfirmadas = (v, campo = "versoes") => {
  if (!v || typeof v !== "object" || Array.isArray(v) || !Object.keys(v).length) falhar(CODIGO.ENTRADA_INVALIDA, "Informe a versão de cada registro confirmado.", { campo });
  return Object.fromEntries(Object.entries(v).map(([id, n]) => [exigirUuid(id, campo), exigirInteiro(n, campo, { min: 1 })]));
};
const justificativaDaConta = (e) => exigirTexto(e.justificativa, "justificativa", { max: 500 });
export function validarReclassificacaoDeConta(e) {
  semCamposDesconhecidos(e, ["obrigacaoId", "categoria", "versoes", "justificativa"], "reclassificacaoDeConta");
  return { obrigacaoId: exigirUuid(e.obrigacaoId, "obrigacaoId"), categoria: exigirTexto(e.categoria, "categoria", { max: 80 }), versoes: versoesConfirmadas(e.versoes), justificativa: justificativaDaConta(e) };
}
export function validarAjusteDeContaAPagar(e) {
  semCamposDesconhecidos(e, ["obrigacaoId", "valorCorretoCentavos", "versaoEsperada", "justificativa"], "ajusteDeConta");
  return { obrigacaoId: exigirUuid(e.obrigacaoId, "obrigacaoId"), valorCorretoCentavos: exigirInteiro(e.valorCorretoCentavos, "valorCorretoCentavos", { min: 1 }),
    versaoEsperada: exigirInteiro(e.versaoEsperada, "versaoEsperada", { min: 1 }), justificativa: justificativaDaConta(e) };
}
export function validarMudancaDeCompetencia(e) {
  semCamposDesconhecidos(e, ["obrigacaoId", "competencia", "versoes", "justificativa"], "competenciaDeConta");
  return { obrigacaoId: exigirUuid(e.obrigacaoId, "obrigacaoId"), competencia: exigirCompetencia(e.competencia, "competencia"), versoes: versoesConfirmadas(e.versoes), justificativa: justificativaDaConta(e) };
}
export function validarCancelamentoDeContaAPagar(e) {
  semCamposDesconhecidos(e, ["obrigacaoId", "abrangencia", "versoes", "justificativa"], "cancelamentoDeConta");
  return { obrigacaoId: exigirUuid(e.obrigacaoId, "obrigacaoId"), abrangencia: exigirUmDe(e.abrangencia, ["PARCELA", "GRUPO"], "abrangencia"), versoes: versoesConfirmadas(e.versoes), justificativa: justificativaDaConta(e) };
}

/**
 * Execução 08C — confirmação de reclassificação. `versaoEsperada` (a versão vista na prévia) é OBRIGATÓRIA: uma prévia
 * antiga nunca autoriza alterar um lançamento que mudou. `documentoId`: evidência EXISTENTE no escopo a vincular.
 */
export function validarReclassificacao(e) {
  semCamposDesconhecidos(e, ["lancamentoId", "categoria", "justificativa", "versaoEsperada", "documentoId"], "reclassificacao");
  return {
    lancamentoId: exigirUuid(e.lancamentoId, "lancamentoId"), categoria: codigoDeCategoria(e.categoria), justificativa: justificativa(e.justificativa),
    versaoEsperada: exigirInteiro(e.versaoEsperada, "versaoEsperada", { min: 1 }),
    documentoId: e.documentoId === undefined || e.documentoId === null ? null : exigirUuid(e.documentoId, "documentoId"),
  };
}

/** Consulta/prévia de reclassificação: um lançamento (com categoria opcional para a prévia) OU uma movimentação. */
export function validarConsultaDeReclassificacao(e) {
  semCamposDesconhecidos(e, ["lancamentoId", "movimentacaoId", "categoria"], "consulta");
  if ((e.lancamentoId === undefined) === (e.movimentacaoId === undefined)) falhar(CODIGO.ENTRADA_INVALIDA, "Informe o lançamento OU a movimentação.");
  if (e.movimentacaoId !== undefined) return { movimentacaoId: exigirUuid(e.movimentacaoId, "movimentacaoId"), lancamentoId: null, categoria: null };
  return { lancamentoId: exigirUuid(e.lancamentoId, "lancamentoId"), movimentacaoId: null, categoria: e.categoria === undefined || e.categoria === null || e.categoria === "" ? null : codigoDeCategoria(e.categoria) };
}

/** Correção cadastral de lançamento. Valor, competência e natureza NÃO se corrigem aqui: cancela-se e registra-se de novo. */
export function validarCorrecaoLancamento(e) {
  semCamposDesconhecidos(e, ["lancamentoId", "mudancas", "justificativa"], "correcao");
  semCamposDesconhecidos(e.mudancas, ["descricao", "dataOperacao"], "mudancas");
  const mudancas = {};
  if (e.mudancas.descricao !== undefined) mudancas.descricao = exigirTexto(e.mudancas.descricao, "mudancas.descricao");
  if (e.mudancas.dataOperacao !== undefined) mudancas.dataOperacao = exigirData(e.mudancas.dataOperacao, "mudancas.dataOperacao");
  if (!Object.keys(mudancas).length) falhar(CODIGO.ENTRADA_INVALIDA, "Nenhuma mudança informada.");
  return { lancamentoId: exigirUuid(e.lancamentoId, "lancamentoId"), mudancas, justificativa: justificativa(e.justificativa) };
}

const SHA256 = /^[0-9a-f]{64}$/;
export function validarDocumento(e) {
  semCamposDesconhecidos(e, ["origem", "arquivoId", "hashSha256", "tipo", "competencia", "recebidoEm", "substituiId", "descricao"], "documento");
  if (typeof e.hashSha256 !== "string" || !SHA256.test(e.hashSha256.toLowerCase())) {
    falhar(CODIGO.DOCUMENTO_INVALIDO, "hashSha256 deve ser o SHA-256 do arquivo original (64 dígitos hexadecimais).", { campo: "hashSha256" });
  }
  return {
    origem: exigirUmDe(e.origem, SISTEMA_FONTE, "origem"),
    arquivoId: exigirTexto(e.arquivoId, "arquivoId", { max: 200 }),
    hashSha256: e.hashSha256.toLowerCase(),
    tipo: exigirUmDe(e.tipo, TIPO_DOCUMENTO, "tipo"),
    competencia: e.competencia === undefined || e.competencia === null ? null : exigirCompetencia(e.competencia),
    recebidoEm: exigirData(e.recebidoEm, "recebidoEm"),
    substituiId: uuidOpcional(e.substituiId, "substituiId"),
    descricao: exigirTexto(e.descricao, "descricao", { opcional: true }),
  };
}

export function validarVinculoDocumental(e) {
  semCamposDesconhecidos(e, ["documentoId", "registroTipo", "registroId"], "vinculo");
  return { documentoId: exigirUuid(e.documentoId, "documentoId"), registroTipo: exigirUmDe(e.registroTipo, VINCULAVEIS, "registroTipo"), registroId: exigirUuid(e.registroId, "registroId") };
}

function lado(lista, campo) {
  const refs = exigirLista(lista, campo, { min: 1, max: 200 }).map((r, i) => {
    semCamposDesconhecidos(r, ["tipo", "id", "valorCentavos"], `${campo}[${i}]`);
    return { tipo: exigirUmDe(r.tipo, CONCILIAVEIS, `${campo}[${i}].tipo`), id: exigirUuid(r.id, `${campo}[${i}].id`), valorCentavos: exigirCentavos(r.valorCentavos, `${campo}[${i}].valorCentavos`, { positivo: true }) };
  });
  return refs;
}

export function validarCorrespondencia(e) {
  semCamposDesconhecidos(e, ["ladoA", "ladoB", "evidenciaDocumentoIds", "justificativa"], "correspondencia");
  const ladoA = lado(e.ladoA, "ladoA");
  const ladoB = lado(e.ladoB, "ladoB");
  const chaves = [...ladoA, ...ladoB].map((r) => `${r.tipo}:${r.id}`);
  if (new Set(chaves).size !== chaves.length) falhar(CODIGO.CONCILIACAO_INVALIDA, "O mesmo registro aparece mais de uma vez na correspondência.");
  const justificativa = exigirTexto(e.justificativa, "justificativa", { max: 500, opcional: true });
  if (ladoA.length > 1 && ladoB.length > 1 && !justificativa) {
    falhar(CODIGO.CONCILIACAO_INVALIDA, "Correspondência de muitos para muitos exige justificativa financeira.");
  }
  return { ladoA, ladoB, evidenciaDocumentoIds: documentos(e.evidenciaDocumentoIds, "evidenciaDocumentoIds"), justificativa };
}

export function validarDecisaoConciliacao(e) {
  semCamposDesconhecidos(e, ["correspondenciaId", "justificativa", "evidenciaDocumentoIds", "baixar"], "decisao");
  const evidencias = e.evidenciaDocumentoIds === undefined ? [] : [...new Set(exigirLista(e.evidenciaDocumentoIds, "evidenciaDocumentoIds", { min: 1, max: 20 }).map((x, i) => exigirUuid(x, `evidenciaDocumentoIds[${i}]`)))];
  // doc 33: "baixar" = ao confirmar conta × saída do extrato, dá baixa na conta na MESMA transação (nunca por padrão).
  return { correspondenciaId: exigirUuid(e.correspondenciaId, "correspondenciaId"), justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500, opcional: true }), evidenciaDocumentoIds: evidencias, baixar: e.baixar === true };
}

/**
 * Pendência DOCUMENTADA no fechamento (Execução 06D). Documentar não resolve: registra o que falta, o impacto e quem cuida.
 * O responsável, se informado, é conferido no núcleo (precisa ter acesso à unidade) — nunca um nome livre.
 */
function pendenciaDocumentada(p, campo) {
  if (typeof p === "string") falhar(CODIGO.ENTRADA_INVALIDA, `${campo}: descreva a pendência com descrição e impacto (texto solto não é aceito).`, { campo });
  semCamposDesconhecidos(p, ["chave", "descricao", "impacto", "responsavelId", "evidenciaDocumentoIds", "documentacaoFaltante", "decisao"], campo);
  return {
    chave: exigirTexto(p.chave, `${campo}.chave`, { max: 200, opcional: true }),
    descricao: exigirTexto(p.descricao, `${campo}.descricao`, { max: 500 }),
    impacto: exigirTexto(p.impacto, `${campo}.impacto`, { max: 500 }),
    responsavelId: uuidOpcional(p.responsavelId, `${campo}.responsavelId`),
    evidenciaDocumentoIds: documentos(p.evidenciaDocumentoIds, `${campo}.evidenciaDocumentoIds`),
    documentacaoFaltante: exigirTexto(p.documentacaoFaltante, `${campo}.documentacaoFaltante`, { max: 500, opcional: true }),
    decisao: exigirTexto(p.decisao, `${campo}.decisao`, { max: 500, opcional: true }),
  };
}

export function validarMudancaDeEstado(e) {
  semCamposDesconhecidos(e, ["competencia", "novoEstado", "metodologia", "metodologiaVersao", "pendencias", "justificativa", "confirmar"], "mudancaDeEstado");
  return {
    competencia: exigirCompetencia(e.competencia),
    novoEstado: exigirUmDe(e.novoEstado, ESTADO_COMPETENCIA, "novoEstado"),
    metodologia: exigirTexto(e.metodologia, "metodologia", { max: 2000, opcional: true }),
    metodologiaVersao: exigirTexto(e.metodologiaVersao, "metodologiaVersao", { max: 120, opcional: true }),
    pendencias: exigirLista(e.pendencias ?? [], "pendencias", { min: 0, max: 100 }).map((p, i) => pendenciaDocumentada(p, `pendencias[${i}]`)),
    justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500, opcional: true }),
    confirmar: e.confirmar === true,
  };
}

/**
 * 08E (F-2) — vincular uma SAÍDA bancária já registrada (extrato) a uma ou mais contas a pagar. Não cria movimento nem
 * despesa: só liquida (baixa) as contas com parte do valor ainda não alocado da saída.
 */
export function validarVinculoDeExtrato(e) {
  semCamposDesconhecidos(e, ["movimentacaoId", "versaoMovimentacao", "alocacoes", "documentoId", "comprovanteSemArquivo", "justificativa", "confirmar", "pagamentoAntecipado", "jurosCentavos"], "vinculo");
  // 26/11 — comprovante comum NÃO arquivado: só os dados conferidos do arquivo (hash) servem de evidência; nunca simula documento.
  if (e.comprovanteSemArquivo !== undefined && e.comprovanteSemArquivo !== null) {
    if (e.documentoId) falhar(CODIGO.ENTRADA_INVALIDA, "Informe o documento OU os dados do comprovante sem arquivo, não os dois.", { campo: "comprovanteSemArquivo" });
    if (typeof e.comprovanteSemArquivo !== "object" || !/^[0-9a-f]{64}$/.test(String(e.comprovanteSemArquivo.hashSha256 ?? ""))) falhar(CODIGO.ENTRADA_INVALIDA, "Dados do comprovante inválidos.", { campo: "comprovanteSemArquivo" });
  }
  const alocacoes = exigirLista(e.alocacoes, "alocacoes", { min: 1, max: 50 }).map((a, i) => {
    semCamposDesconhecidos(a, ["obrigacaoId", "valorCentavos"], `alocacoes[${i}]`);
    return { obrigacaoId: exigirUuid(a.obrigacaoId, `alocacoes[${i}].obrigacaoId`), valorCentavos: exigirCentavos(a.valorCentavos, `alocacoes[${i}].valorCentavos`, { positivo: true }) };
  });
  if (new Set(alocacoes.map((a) => a.obrigacaoId)).size !== alocacoes.length) falhar(CODIGO.ENTRADA_INVALIDA, "A mesma conta aparece mais de uma vez no vínculo.", { campo: "alocacoes" });
  return {
    movimentacaoId: exigirUuid(e.movimentacaoId, "movimentacaoId"),
    versaoMovimentacao: exigirInteiro(e.versaoMovimentacao, "versaoMovimentacao", { min: 1 }),
    alocacoes, documentoId: uuidOpcional(e.documentoId, "documentoId"),
    comprovanteSemArquivo: e.comprovanteSemArquivo ? { hashSha256: e.comprovanteSemArquivo.hashSha256, tipoMime: typeof e.comprovanteSemArquivo.tipoMime === "string" ? e.comprovanteSemArquivo.tipoMime.slice(0, 80) : null, tamanhoBytes: Number.isSafeInteger(e.comprovanteSemArquivo.tamanhoBytes) ? e.comprovanteSemArquivo.tamanhoBytes : null } : null,
    justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500 }),
    confirmar: e.confirmar === true,
    // Execução 09: identificação EXPLÍCITA de pagamento antecipado (saída anterior à emissão da conta).
    pagamentoAntecipado: e.pagamentoAntecipado === true,
    // Parte do valor vinculado que é JURO/MULTA do fornecedor (já INCLUÍDA em alocacoes[0].valorCentavos): vira ajuste da própria conta.
    jurosCentavos: e.jurosCentavos === undefined || e.jurosCentavos === null || e.jurosCentavos === 0 ? 0 : exigirCentavos(e.jurosCentavos, "jurosCentavos", { positivo: true }),
  };
}

export function validarPreviaDeVinculo(e) {
  semCamposDesconhecidos(e, ["obrigacaoId", "movimentacaoId", "valorCentavos"], "previa");
  return {
    obrigacaoId: exigirUuid(e.obrigacaoId, "obrigacaoId"), movimentacaoId: uuidOpcional(e.movimentacaoId, "movimentacaoId"),
    valorCentavos: e.valorCentavos === undefined || e.valorCentavos === null ? null : exigirCentavos(e.valorCentavos, "valorCentavos", { positivo: true }),
  };
}

/**
 * 08E — documentar UMA pendência no fechamento (ressalva candidata). A chave é obrigatória: só se documenta pendência que
 * existe na competência. Decisão e "o que falta"/evidência são exigidas na avaliação (ressalvas.js), não aqui.
 */
export function validarDocumentacaoDePendencia(e) {
  semCamposDesconhecidos(e, ["competencia", "pendencia", "justificativa"], "documentacao");
  const pendencia = pendenciaDocumentada(e.pendencia ?? {}, "pendencia");
  if (!pendencia.chave) falhar(CODIGO.ENTRADA_INVALIDA, "Informe a pendência (chave) a documentar.", { campo: "pendencia.chave" });
  return { competencia: exigirCompetencia(e.competencia), pendencia, justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500, opcional: true }) };
}

export function validarConsultaComposicao(e) {
  semCamposDesconhecidos(e, ["indicador", "competencia", "canal", "classificacao"], "consulta");
  return {
    indicador: exigirTexto(e.indicador, "indicador", { max: 60 }),
    competencia: exigirCompetencia(e.competencia),
    canal: e.canal === undefined || e.canal === null ? null : exigirUmDe(e.canal, CANAL, "canal"),
    classificacao: e.classificacao === undefined || e.classificacao === null ? null : exigirUmDe(e.classificacao, CLASSIFICACAO, "classificacao"),
  };
}

export function validarConsultaHistorico(e) {
  semCamposDesconhecidos(e, ["registroTipo", "registroId"], "consulta");
  return { registroTipo: exigirUmDe(e.registroTipo, TIPO, "registroTipo"), registroId: exigirUuid(e.registroId, "registroId") };
}

export { exigirObjeto };
