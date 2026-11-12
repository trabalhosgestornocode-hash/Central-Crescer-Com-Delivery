// STONE — processadora. Relatório de VENDAS = transações processadas (evidência de pagamento de uma venda que já
// existe no SAIPOS). Nunca origina venda, nunca prova depósito no banco e não é "Balcão" por padrão (canal fica nulo).
//   venda processada  → registro TRANSACAO (valor bruto);
//   taxa informada    → MDR + desconto de antecipação, como a Stone declara;
//   taxa calculada    → bruto − líquido (as duas são conferidas entre si);
//   recebível/repasse → relatório de RECEBIMENTOS (comportamento diferente: uma linha por parcela paga, por data de pagamento);
//   liquidação bancária → só o extrato Unicred comprova (fontes/unicred.js), por conciliação.
import { somar, subtrair } from "../../dominio/dinheiro.js";
import { centavosArredondados, centavosExatos, rotulo } from "../leitor.js";
import { DIVERGENCIA, diferenca } from "../motor.js";
import { classificarPorPalavras, col, definirFonte } from "./comum.js";

const produtoStone = (t) => classificarPorPalavras(t, [["PIX", ["pix"]], ["DEBITO", ["debito"]], ["CREDITO", ["credito"]], ["VALE", ["voucher", "vale"]]]);
const situacaoStone = (t) => classificarPorPalavras(t, [["CANCELADA", ["cancel", "estorn", "chargeback"]], ["NEGADA", ["negad", "recusad"]], ["PENDENTE", ["pendent", "em analise", "processando"]], ["APROVADA", ["aprovad", "autorizad", "capturad", "pag"]]]);

/**
 * Relatório de VENDAS da Stone — layout REAL conferido com a exportação de setembro/2026 (aba "Report", cabeçalho na
 * 1ª linha, todas as células como texto, valores com 6 casas decimais e descontos negativos). Também aceita os rótulos
 * do contrato sintético da Execução 02.
 *   - valores em MILIONÉSIMOS de real: o líquido e os descontos da Stone têm frações de centavo por transação; nada é
 *     arredondado linha a linha — os totais de conferência é que são levados ao centavo (meio para cima);
 *   - desconto total = |MDR| + |antecipação| + |desconto unificado| (a Stone informa a taxa do cartão no "unificado" e a
 *     do Pix no MDR); conferido contra bruto − líquido em cada linha;
 *   - número do cartão NÃO é guardado (nem mascarado);
 *   - situação: APROVADA | CANCELADA/NEGADA (rejeitadas) | PENDENTE | NAO_RECONHECIDA.
 */
export const STONE_VENDAS = definirFonte({
  fonte: "STONE",
  tipoRelatorio: "STONE_VENDAS",
  tipoDocumento: "RELATORIO_PROCESSADOR",
  descricao: "relatório de vendas (transações) da Stone",
  formatosHomologados: ["xlsx"],
  colunas: {
    id: col(["STONE ID", "Identificador da transação", "ID da transação", "Código da transação"]),
    quando: col(["DATA DA VENDA", "Data/Hora da venda", "Data/Hora"]),
    produto: col(["PRODUTO", "Tipo de produto"]),
    modalidade: col(["Modalidade", "Parcelamento"], false),
    parcelas: col(["N DE PARCELAS", "Nº de parcelas"], false),
    bandeira: col(["BANDEIRA"]),
    bruto: col(["VALOR BRUTO", "Valor da venda"]),
    mdr: col(["DESCONTO DE MDR", "Taxa MDR", "MDR"]),
    antecipacao: col(["DESCONTO DE ANTECIPACAO", "Desconto de antecipação", "Taxa de antecipação"], false),
    unificado: col(["DESCONTO UNIFICADO"], false),
    liquido: col(["VALOR LIQUIDO"]),
    situacao: col(["ULTIMO STATUS", "Status", "Situação"]),
    dataSituacao: col(["DATA DO ULTIMO STATUS"], false),
    stonecode: col(["STONECODE", "Stone Code", "Código do estabelecimento"], false),
    autorizacao: col(["CÓDIGO DE AUTORIZAÇÃO", "Código de autorização", "Autorização", "NSU"], false),
    captura: col(["MEIO DE CAPTURA"], false),
  },
  colunasOmitidas: ["N DO CARTAO", "Número do cartão"],
  ehTotal: (u) => /^total/.test(rotulo(u.bruto("id"))),
  lerTotal: (u) => ({ valorCentavos: u.valor("bruto") }),
  converter(u) {
    const id = u.texto("id");
    const quando = u.dataHora("quando");
    const bruto = u.micros("bruto");
    const mdr = u.micros("mdr");
    const antecipacao = u.micros("antecipacao", { opcional: true }) ?? 0;
    const unificado = u.micros("unificado", { opcional: true }) ?? 0;
    const liquido = u.micros("liquido");
    if (u.erros.length) return null;
    const brutoCentavos = centavosExatos(bruto);
    if (brutoCentavos === null) { u.erro("VALOR_INVALIDO", "Valor bruto com fração de centavo.", "bruto"); return null; }
    const situacao = situacaoStone(u.bruto("situacao"));
    const desconto = Math.abs(mdr) + Math.abs(antecipacao) + Math.abs(unificado);
    return {
      tipoRegistro: "TRANSACAO", idExterno: id, data: quando.data, valorCentavos: brutoCentavos,
      dados: {
        hora: quando.hora, natureza: "VENDA_PROCESSADA", canal: null, produto: produtoStone(u.bruto("produto")), produtoOriginal: u.bruto("produto"),
        modalidade: u.bruto("modalidade") || null, parcelas: u.bruto("parcelas") || null, bandeira: u.bruto("bandeira") || null,
        captura: u.bruto("captura") || null, brutoCentavos,
        brutoMicros: bruto, liquidoMicros: liquido, mdrMicros: mdr, antecipacaoMicros: antecipacao, unificadoMicros: unificado,
        descontoInformadoMicros: desconto, descontoCalculadoMicros: bruto - liquido,
        liquidoCentavos: centavosExatos(liquido) ?? centavosArredondados(liquido), liquidoTemFracaoDeCentavo: centavosExatos(liquido) === null,
        mdrCentavos: centavosArredondados(Math.abs(mdr)), antecipacaoCentavos: centavosArredondados(Math.abs(antecipacao)),
        taxaInformadaCentavos: centavosArredondados(desconto), taxaCalculadaCentavos: centavosArredondados(bruto - liquido),
        antecipada: antecipacao !== 0, situacao: situacao ?? "NAO_RECONHECIDA", situacaoOriginal: u.bruto("situacao"),
        dataSituacao: u.bruto("dataSituacao") || null, autorizacao: u.bruto("autorizacao") || null, estabelecimento: u.bruto("stonecode") || null,
      },
    };
  },
  fechar(registros) {
    const divergencias = [];
    const soma = { bruto: 0, liquido: 0, desconto: 0 };
    const contagem = { APROVADA: 0, REJEITADA: 0, PENDENTE: 0, NAO_RECONHECIDA: 0 };
    for (const r of registros) {
      const d = r.dados;
      if (d.descontoInformadoMicros !== d.descontoCalculadoMicros) {
        divergencias.push(diferenca(DIVERGENCIA.LINHA_NAO_FECHA, `Transação ${r.idExterno}: descontos informados diferem de bruto − líquido.`, d.taxaInformadaCentavos, d.taxaCalculadaCentavos, { linha: r.linha }));
      }
      const grupo = d.situacao === "APROVADA" ? "APROVADA" : ["CANCELADA", "NEGADA"].includes(d.situacao) ? "REJEITADA" : d.situacao === "PENDENTE" ? "PENDENTE" : "NAO_RECONHECIDA";
      contagem[grupo] += 1;
      if (grupo === "NAO_RECONHECIDA") divergencias.push({ codigo: DIVERGENCIA.VALOR_A_CLASSIFICAR, mensagem: `Transação ${r.idExterno}: situação "${d.situacaoOriginal}" não reconhecida.`, linha: r.linha });
      if (grupo === "APROVADA") { soma.bruto += d.brutoMicros; soma.liquido += d.liquidoMicros; soma.desconto += d.descontoInformadoMicros; }
    }
    return {
      controles: {
        aprovadas: contagem.APROVADA, rejeitadas: contagem.REJEITADA, pendentes: contagem.PENDENTE, situacaoNaoReconhecida: contagem.NAO_RECONHECIDA,
        brutoAprovadoCentavos: centavosArredondados(soma.bruto), liquidoAprovadoCentavos: centavosArredondados(soma.liquido),
        descontosAprovadosCentavos: centavosArredondados(soma.desconto), taxasInformadasCentavos: centavosArredondados(soma.desconto),
        liquidoAprovadoMicros: soma.liquido, descontosAprovadosMicros: soma.desconto,
        observacao: "Líquido e descontos somados em milionésimos e levados ao centavo só no total (meio para cima).",
      },
      divergencias,
    };
  },
});

/**
 * Relatório de RECEBIMENTOS da Stone (repasses por data de pagamento). Preparado para o futuro: contrato SINTÉTICO.
 * Identificação = identificador da transação + parcela (ambos vêm da fonte).
 */
export const STONE_RECEBIMENTOS = definirFonte({
  fonte: "STONE",
  tipoRelatorio: "STONE_RECEBIMENTOS",
  tipoDocumento: "DEMONSTRATIVO_REPASSE",
  descricao: "relatório de recebimentos da Stone",
  colunas: {
    pagamento: col(["Data do pagamento", "Data de recebimento", "Data do recebimento"]),
    transacao: col(["Identificador da transação", "ID da transação", "Stone ID"]),
    parcela: col(["Parcela", "Nº da parcela"], false),
    liquido: col(["Valor líquido", "Valor recebido"]),
    stonecode: col(["Stonecode", "Stone Code", "Código do estabelecimento"], false),
  },
  ehTotal: (u) => /^total/.test(rotulo(u.bruto("transacao"))),
  lerTotal: (u) => ({ valorCentavos: u.valor("liquido") }),
  converter(u) {
    const data = u.data("pagamento");
    const transacao = u.texto("transacao");
    const liquido = u.valor("liquido");
    if (u.erros.length) return null;
    const parcela = u.bruto("parcela") || "1";
    return {
      tipoRegistro: "RECEBIMENTO", idExterno: `${transacao}:${parcela}`, data, valorCentavos: liquido,
      dados: { transacaoId: transacao, parcela, liquidoCentavos: liquido, natureza: "REPASSE_PROCESSADORA", estabelecimento: u.bruto("stonecode") || null },
    };
  },
  fechar(registros, { declarados }) {
    const total = registros.reduce((s, r) => somar(s, r.valorCentavos), 0);
    const porData = {};
    for (const r of registros) porData[r.data] = somar(porData[r.data] ?? 0, r.valorCentavos);
    const divergencias = declarados.filter((d) => d.valorCentavos !== total).map((d) => diferenca(DIVERGENCIA.TOTAL_NAO_CONFERE, "A soma dos recebimentos não confere com o total declarado.", d.valorCentavos, total, { linha: d.linha }));
    return { controles: { recebidoCentavos: total, porData }, divergencias };
  },
});

export const FONTES_STONE = Object.freeze([STONE_VENDAS, STONE_RECEBIMENTOS]);
