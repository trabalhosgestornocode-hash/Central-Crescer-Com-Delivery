// STONE — processadora. Relatório de VENDAS = transações processadas (evidência de pagamento de uma venda que já
// existe no SAIPOS). Nunca origina venda, nunca prova depósito no banco e não é "Balcão" por padrão (canal fica nulo).
//   venda processada  → registro TRANSACAO (valor bruto);
//   taxa informada    → MDR + desconto de antecipação, como a Stone declara;
//   taxa calculada    → bruto − líquido (as duas são conferidas entre si);
//   recebível/repasse → relatório de RECEBIMENTOS (comportamento diferente: uma linha por parcela paga, por data de pagamento);
//   liquidação bancária → só o extrato Unicred comprova (fontes/unicred.js), por conciliação.
import { somar, subtrair } from "../../dominio/dinheiro.js";
import { rotulo } from "../leitor.js";
import { DIVERGENCIA, diferenca } from "../motor.js";
import { classificarPorPalavras, col, definirFonte } from "./comum.js";

const produtoStone = (t) => classificarPorPalavras(t, [["PIX", ["pix"]], ["DEBITO", ["debito"]], ["CREDITO", ["credito"]], ["VALE", ["voucher", "vale"]]]);
const situacaoStone = (t) => classificarPorPalavras(t, [["CANCELADA", ["cancel", "estorn", "chargeback"]], ["NEGADA", ["negad", "recusad"]], ["APROVADA", ["aprovad", "autorizad", "capturad", "pag"]]]);

export const STONE_VENDAS = definirFonte({
  fonte: "STONE",
  tipoRelatorio: "STONE_VENDAS",
  tipoDocumento: "RELATORIO_PROCESSADOR",
  descricao: "relatório de vendas (transações) da Stone",
  colunas: {
    id: col(["Identificador da transação", "ID da transação", "Stone ID", "Código da transação"]),
    quando: col(["Data da venda", "Data/Hora da venda", "Data/Hora"]),
    produto: col(["Produto", "Tipo de produto"]),
    modalidade: col(["Modalidade", "Parcelamento"], false),
    bandeira: col(["Bandeira"]),
    bruto: col(["Valor bruto", "Valor da venda"]),
    mdr: col(["Desconto de MDR", "Taxa MDR", "MDR"]),
    antecipacao: col(["Desconto de antecipação", "Taxa de antecipação"], false),
    liquido: col(["Valor líquido"]),
    situacao: col(["Status", "Situação"]),
    stonecode: col(["Stonecode", "Stone Code", "Código do estabelecimento"], false),
    autorizacao: col(["Autorização", "Código de autorização", "NSU"], false),
  },
  ehTotal: (u) => /^total/.test(rotulo(u.bruto("id"))),
  lerTotal: (u) => ({ valorCentavos: u.valor("bruto") }),
  converter(u) {
    const id = u.texto("id");
    const quando = u.dataHora("quando");
    const bruto = u.valor("bruto");
    const mdr = u.valor("mdr");
    const antecipacao = u.valor("antecipacao", { opcional: true }) ?? 0;
    const liquido = u.valor("liquido");
    if (u.erros.length) return null;
    const situacao = situacaoStone(u.bruto("situacao"));
    return {
      tipoRegistro: "TRANSACAO", idExterno: id, data: quando.data, valorCentavos: bruto,
      dados: {
        hora: quando.hora, natureza: "VENDA_PROCESSADA", canal: null, produto: produtoStone(u.bruto("produto")), produtoOriginal: u.bruto("produto"),
        modalidade: u.bruto("modalidade") || null, bandeira: u.bruto("bandeira"), brutoCentavos: bruto, mdrCentavos: mdr,
        antecipacaoCentavos: antecipacao, taxaInformadaCentavos: somar(mdr, antecipacao), taxaCalculadaCentavos: subtrair(bruto, liquido),
        liquidoCentavos: liquido, antecipada: antecipacao > 0, situacao: situacao ?? "NAO_RECONHECIDA", situacaoOriginal: u.bruto("situacao"),
        autorizacao: u.bruto("autorizacao") || null, estabelecimento: u.bruto("stonecode") || null,
      },
    };
  },
  fechar(registros) {
    const divergencias = [];
    let bruto = 0;
    let taxas = 0;
    let liquido = 0;
    for (const r of registros) {
      const d = r.dados;
      if (d.taxaInformadaCentavos !== d.taxaCalculadaCentavos) {
        divergencias.push(diferenca(DIVERGENCIA.LINHA_NAO_FECHA, `Transação ${r.idExterno}: taxa informada difere de bruto − líquido.`, d.taxaInformadaCentavos, d.taxaCalculadaCentavos, { linha: r.linha }));
      }
      if (d.situacao === "NAO_RECONHECIDA") divergencias.push({ codigo: DIVERGENCIA.VALOR_A_CLASSIFICAR, mensagem: `Transação ${r.idExterno}: situação "${d.situacaoOriginal}" não reconhecida.`, linha: r.linha });
      if (d.situacao === "APROVADA") { bruto = somar(bruto, d.brutoCentavos); taxas = somar(taxas, d.taxaInformadaCentavos); liquido = somar(liquido, d.liquidoCentavos); }
    }
    return { controles: { brutoAprovadoCentavos: bruto, taxasInformadasCentavos: taxas, liquidoAprovadoCentavos: liquido }, divergencias };
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
