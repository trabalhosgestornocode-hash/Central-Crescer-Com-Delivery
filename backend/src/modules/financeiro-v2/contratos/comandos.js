// Contratos de entrada do núcleo. Cada validador recebe a entrada bruta e devolve o comando NORMALIZADO
// (chaves em ordem fixa, textos aparados, valores conferidos) ou lança ErroFinanceiro. Nada além do validado chega às regras.
// Organização, unidade e usuário NUNCA fazem parte de um comando: vêm do contexto.
import { CODIGO, falhar } from "../dominio/erros.js";
import {
  ALVO_LIQUIDACAO, CANAL, CONCILIAVEIS, ESTADO_COMPETENCIA, FORMA_PAGAMENTO, NATUREZA_MOVIMENTACAO, PROCESSADOR, SENTIDO,
  SISTEMA_FONTE, SISTEMAS_QUE_ORIGINAM_VENDA, TIPO, TIPO_CONTA, TIPO_CONTRAPARTE, TIPO_DOCUMENTO, VINCULAVEIS,
} from "../dominio/catalogos.js";
import { MOEDA_PADRAO, exigirCentavos, somarLista } from "../dominio/dinheiro.js";
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
  semCamposDesconhecidos(e, ["canal", "dataVenda", "competencia", "brutoCentavos", "moeda", "pagamentos", "fonte", "descricao"], "venda");
  const dataVenda = exigirData(e.dataVenda, "dataVenda");
  const brutoCentavos = exigirCentavos(e.brutoCentavos, "brutoCentavos", { positivo: true });
  const f = fonte(e.fonte, { obrigatoria: true, exigirId: true });
  if (!SISTEMAS_QUE_ORIGINAM_VENDA.includes(f.sistema)) {
    falhar(CODIGO.FONTE_NAO_ORIGINA_VENDA, "Este sistema não origina vendas: seus registros são evidência de pagamento e entram por conciliação.", { sistema: f.sistema });
  }
  const pagamentos = exigirLista(e.pagamentos, "pagamentos", { min: 1, max: 20 }).map((p, i) => {
    semCamposDesconhecidos(p, ["forma", "processador", "valorCentavos"], `pagamentos[${i}]`);
    const forma = exigirUmDe(p.forma, FORMA_PAGAMENTO, `pagamentos[${i}].forma`);
    const processador = p.processador === undefined || p.processador === null ? null : exigirUmDe(p.processador, PROCESSADOR, `pagamentos[${i}].processador`);
    if (forma === FORMA_PAGAMENTO.DINHEIRO && processador) falhar(CODIGO.ENTRADA_INVALIDA, "Pagamento em dinheiro não tem processador.", { campo: `pagamentos[${i}].processador` });
    return { forma, processador, valorCentavos: exigirCentavos(p.valorCentavos, `pagamentos[${i}].valorCentavos`, { positivo: true }) };
  });
  if (somarLista(pagamentos, (p) => p.valorCentavos) !== brutoCentavos) {
    falhar(CODIGO.PAGAMENTOS_NAO_FECHAM, "A soma das formas de pagamento deve ser igual ao valor bruto da venda.");
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
  };
}

export function validarObrigacao(e) {
  semCamposDesconhecidos(e, ["contraparteId", "valorOriginalCentavos", "moeda", "categoria", "descricao", "competencia", "dataEmissao", "vencimento", "parcelas", "recorrencia", "documentoIds", "fonte"], "obrigacao");
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
    contraparteId: exigirUuid(e.contraparteId, "contraparteId"),
    valorOriginalCentavos,
    moeda: moeda(e.moeda),
    categoria: exigirTexto(e.categoria, "categoria", { max: 80 }),
    descricao: exigirTexto(e.descricao, "descricao"),
    competencia: exigirCompetencia(e.competencia),
    dataEmissao,
    vencimento,
    parcelas,
    recorrencia,
    documentoIds: documentos(e.documentoIds),
    fonte: fonte(e.fonte),
  };
}

export function validarRecebivel(e) {
  semCamposDesconhecidos(e, ["processador", "contraparteId", "canal", "vendaId", "brutoCentavos", "moeda", "deducoes", "dataPrevista", "competencia", "descricao", "documentoIds", "fonte"], "recebivel");
  const processador = e.processador === undefined || e.processador === null ? null : exigirUmDe(e.processador, PROCESSADOR, "processador");
  const contraparteId = uuidOpcional(e.contraparteId, "contraparteId");
  if (!processador === !contraparteId) falhar(CODIGO.ENTRADA_INVALIDA, "Informe o devedor: processador OU contraparte (exatamente um).");
  const brutoCentavos = exigirCentavos(e.brutoCentavos, "brutoCentavos", { positivo: true });
  const deducoes = exigirLista(e.deducoes ?? [], "deducoes", { min: 0, max: 50 }).map((d, i) => {
    semCamposDesconhecidos(d, ["tipo", "valorCentavos"], `deducoes[${i}]`);
    return { tipo: exigirTexto(d.tipo, `deducoes[${i}].tipo`, { max: 80 }), valorCentavos: exigirCentavos(d.valorCentavos, `deducoes[${i}].valorCentavos`, { positivo: true }) };
  });
  if (somarLista(deducoes, (d) => d.valorCentavos) > brutoCentavos) falhar(CODIGO.VALOR_INVALIDO, "As deduções não podem superar o valor bruto.", { campo: "deducoes" });
  return {
    processador,
    contraparteId,
    canal: e.canal === undefined || e.canal === null ? null : exigirUmDe(e.canal, CANAL, "canal"),
    vendaId: uuidOpcional(e.vendaId, "vendaId"),
    brutoCentavos,
    moeda: moeda(e.moeda),
    deducoes,
    dataPrevista: e.dataPrevista === undefined || e.dataPrevista === null ? null : exigirData(e.dataPrevista, "dataPrevista"),
    competencia: exigirCompetencia(e.competencia),
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
  semCamposDesconhecidos(e, ["liquidacaoId", "justificativa"], "estorno");
  return { liquidacaoId: exigirUuid(e.liquidacaoId, "liquidacaoId"), justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500 }) };
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
    categoria: exigirTexto(e.categoria, "categoria", { max: 80 }),
    competencia: e.competencia === undefined || e.competencia === null ? null : exigirCompetencia(e.competencia),
    documentoId: uuidOpcional(e.documentoId, "documentoId"),
  };
}

export function validarCorrecaoObrigacao(e) {
  semCamposDesconhecidos(e, ["obrigacaoId", "mudancas", "justificativa", "versaoEsperada"], "correcao");
  semCamposDesconhecidos(e.mudancas, ["vencimento", "descricao"], "mudancas");
  const mudancas = {};
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

export function validarCancelamentoObrigacao(e) {
  semCamposDesconhecidos(e, ["obrigacaoId", "justificativa"], "cancelamento");
  return { obrigacaoId: exigirUuid(e.obrigacaoId, "obrigacaoId"), justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500 }) };
}

export function validarReclassificacao(e) {
  semCamposDesconhecidos(e, ["lancamentoId", "categoria", "justificativa"], "reclassificacao");
  return { lancamentoId: exigirUuid(e.lancamentoId, "lancamentoId"), categoria: exigirTexto(e.categoria, "categoria", { max: 80 }), justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500 }) };
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
  semCamposDesconhecidos(e, ["correspondenciaId", "justificativa"], "decisao");
  return { correspondenciaId: exigirUuid(e.correspondenciaId, "correspondenciaId"), justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500, opcional: true }) };
}

export function validarMudancaDeEstado(e) {
  semCamposDesconhecidos(e, ["competencia", "novoEstado", "metodologia", "pendencias", "justificativa"], "mudancaDeEstado");
  return {
    competencia: exigirCompetencia(e.competencia),
    novoEstado: exigirUmDe(e.novoEstado, ESTADO_COMPETENCIA, "novoEstado"),
    metodologia: exigirTexto(e.metodologia, "metodologia", { max: 2000, opcional: true }),
    pendencias: exigirLista(e.pendencias ?? [], "pendencias", { min: 0, max: 100 }).map((p, i) => exigirTexto(p, `pendencias[${i}]`, { max: 500 })),
    justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500, opcional: true }),
  };
}

export function validarConsultaComposicao(e) {
  semCamposDesconhecidos(e, ["indicador", "competencia"], "consulta");
  return { indicador: exigirTexto(e.indicador, "indicador", { max: 60 }), competencia: exigirCompetencia(e.competencia) };
}

export function validarConsultaHistorico(e) {
  semCamposDesconhecidos(e, ["registroTipo", "registroId"], "consulta");
  return { registroTipo: exigirUmDe(e.registroTipo, TIPO, "registroTipo"), registroId: exigirUuid(e.registroId, "registroId") };
}

export { exigirObjeto };
