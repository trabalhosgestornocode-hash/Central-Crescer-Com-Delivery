// SAIPOS — principal fonte OPERACIONAL das vendas da loja. Quatro leitores, um por relatório.
// Regras: forma de pagamento NÃO é canal; o total do relatório de formas de pagamento NÃO é faturamento bruto;
// diferença entre relatórios é DETECTADA (aplicacao/importacoes.js → compararRelatoriosSaipos), nunca ajustada.
// Os valores financeiros do iFood são reconciliados com a apuração oficial do iFood (fontes/ifood.js), não com o SAIPOS.
import { somar, subtrair } from "../../dominio/dinheiro.js";
import { rotulo } from "../leitor.js";
import { DIVERGENCIA, conferirTotalDeclarado, diferenca } from "../motor.js";
import { classificarPorPalavras, col, definirFonte, formaDePagamento } from "./comum.js";

/** Canal de ORIGEM do pedido. Desconhecido fica nulo (pendência), nunca vira Balcão por padrão. */
export function canalSaipos(texto) {
  return classificarPorPalavras(texto, [
    ["IFOOD", ["ifood"]],
    ["ANOTA_AI", ["anota ai", "anotaai"]],
    ["BALCAO", ["balcao", "loja", "salao", "mesa", "retirada no balcao"]],
    ["OUTRO", ["delivery proprio", "telefone", "whatsapp", "site", "cardapio digital"]],
  ]);
}

const ehLinhaDeTotal = (campo) => (u) => /^total/.test(rotulo(u.bruto(campo)));
const CANCELADO = (texto) => /cancel/.test(rotulo(texto));

export const SAIPOS_VENDAS = definirFonte({
  fonte: "SAIPOS",
  tipoRelatorio: "SAIPOS_VENDAS",
  tipoDocumento: "RELATORIO_VENDAS",
  descricao: "relatório de vendas por pedido do SAIPOS",
  colunas: {
    pedido: col(["Pedido", "Nº Pedido", "Numero do pedido", "Código do pedido"]),
    data: col(["Data", "Data do pedido", "Data/Hora"]),
    canal: col(["Canal", "Canal de venda", "Origem"]),
    itens: col(["Itens", "Valor dos itens", "Subtotal"]),
    desconto: col(["Desconto", "Descontos"]),
    acrescimo: col(["Acréscimo", "Acréscimos"]),
    taxaEntrega: col(["Taxa de entrega", "Entrega"]),
    total: col(["Total", "Valor total", "Valor da venda"]),
    forma: col(["Forma de pagamento", "Pagamento"]),
    situacao: col(["Situação", "Status"]),
    autorizacao: col(["Autorização", "NSU", "Código de autorização"], false),
    loja: col(["Loja", "Estabelecimento"], false),
  },
  ehTotal: ehLinhaDeTotal("pedido"),
  lerTotal: (u) => ({ valorCentavos: u.valor("total") }),
  converter(u) {
    const quando = u.dataHora("data");
    const itens = u.valor("itens");
    const desconto = u.valor("desconto");
    const acrescimo = u.valor("acrescimo");
    const taxa = u.valor("taxaEntrega");
    const total = u.valor("total");
    const pedido = u.texto("pedido");
    if (u.erros.length) return null;
    const canalOriginal = u.bruto("canal");
    const formaOriginal = u.bruto("forma");
    return {
      tipoRegistro: "PEDIDO", idExterno: pedido, data: quando.data, valorCentavos: total,
      dados: {
        hora: quando.hora, canal: canalSaipos(canalOriginal), canalOriginal, formaPagamento: formaDePagamento(formaOriginal), formaOriginal,
        itensCentavos: itens, descontoCentavos: desconto, acrescimoCentavos: acrescimo, taxaEntregaCentavos: taxa, totalCentavos: total,
        cancelado: CANCELADO(u.bruto("situacao")), situacaoOriginal: u.bruto("situacao"),
        autorizacao: u.bruto("autorizacao") || null, estabelecimento: u.bruto("loja") || null,
      },
    };
  },
  fechar(registros, { declarados }) {
    const divergencias = [];
    for (const r of registros) {
      const d = r.dados;
      const calculado = subtrair(somar(d.itensCentavos, d.acrescimoCentavos, d.taxaEntregaCentavos), d.descontoCentavos);
      if (calculado !== d.totalCentavos) divergencias.push(diferenca(DIVERGENCIA.LINHA_NAO_FECHA, `Pedido ${r.idExterno}: itens − desconto + acréscimo + entrega não fecha com o total.`, calculado, d.totalCentavos, { linha: r.linha }));
      if (!d.canal) divergencias.push({ codigo: DIVERGENCIA.VALOR_A_CLASSIFICAR, mensagem: `Pedido ${r.idExterno}: canal "${d.canalOriginal}" não reconhecido.`, linha: r.linha });
    }
    const validos = (r) => !r.dados.cancelado;
    const total = conferirTotalDeclarado(registros, declarados, { tipoRegistro: "PEDIDO", rotuloTotal: "total de vendas", filtro: validos });
    const porCanal = {};
    for (const r of registros.filter(validos)) porCanal[r.dados.canal ?? "NAO_IDENTIFICADO"] = somar(porCanal[r.dados.canal ?? "NAO_IDENTIFICADO"] ?? 0, r.valorCentavos);
    const cancelados = registros.filter((r) => r.dados.cancelado);
    return {
      controles: {
        faturamentoCentavos: total.encontrado, pedidosValidos: registros.length - cancelados.length,
        canceladosCentavos: cancelados.reduce((s, r) => somar(s, r.valorCentavos), 0), porCanal,
      },
      divergencias: [...divergencias, ...total.divergencias],
    };
  },
});

/** Leitor de relatório de TOTAIS (uma linha por canal, por forma ou por dia). Sem identificador da fonte: impressão digital. */
function relatorioDeTotais({ tipoRelatorio, descricao, tipoRegistro, chave, rotulos, usaData = false }) {
  return definirFonte({
    fonte: "SAIPOS",
    tipoRelatorio,
    tipoDocumento: "RELATORIO_VENDAS",
    descricao,
    colunas: { [chave]: col(rotulos), quantidade: col(["Quantidade", "Qtd", "Pedidos", "Quantidade de pedidos"], false), valor: col(["Valor", "Total", "Faturamento", "Valor total"]) },
    ehTotal: ehLinhaDeTotal(chave),
    lerTotal: (u) => ({ valorCentavos: u.valor("valor") }),
    converter(u) {
      const valor = u.valor("valor");
      const data = usaData ? u.data(chave) : null;
      if (u.erros.length) return null;
      const quantidade = u.bruto("quantidade") && /^\d+$/.test(u.bruto("quantidade")) ? Number(u.bruto("quantidade")) : null;
      const original = u.bruto(chave);
      const dados = { quantidade, [`${chave}Original`]: original };
      if (chave === "canal") dados.canal = canalSaipos(original);
      if (chave === "forma") dados.formaPagamento = formaDePagamento(original);
      // Data do registro de totais do período = último dia do período (preenchida pelo motor via periodo).
      return { tipoRegistro, idExterno: null, data: data ?? u.periodo.fim, valorCentavos: valor, dados, identidade: { tipoRegistro, chave: rotulo(original), inicio: u.periodo.inicio, fim: u.periodo.fim } };
    },
    fechar(registros, { declarados }) {
      const total = conferirTotalDeclarado(registros, declarados, { tipoRegistro, rotuloTotal: descricao });
      return { controles: { totalCentavos: total.encontrado }, divergencias: total.divergencias };
    },
  });
}

export const SAIPOS_VENDAS_POR_CANAL = relatorioDeTotais({
  tipoRelatorio: "SAIPOS_VENDAS_POR_CANAL", descricao: "relatório de vendas por canal do SAIPOS", tipoRegistro: "TOTAL_CANAL", chave: "canal", rotulos: ["Canal", "Canal de venda", "Origem"],
});
export const SAIPOS_FORMAS_PAGAMENTO = relatorioDeTotais({
  tipoRelatorio: "SAIPOS_FORMAS_PAGAMENTO", descricao: "relatório de formas de pagamento do SAIPOS", tipoRegistro: "TOTAL_FORMA", chave: "forma", rotulos: ["Forma de pagamento", "Forma", "Pagamento"],
});
export const SAIPOS_VENDAS_DIARIAS = relatorioDeTotais({
  tipoRelatorio: "SAIPOS_VENDAS_DIARIAS", descricao: "relatório de vendas diárias do SAIPOS", tipoRegistro: "TOTAL_DIA", chave: "data", rotulos: ["Data", "Dia"], usaData: true,
});

export const FONTES_SAIPOS = Object.freeze([SAIPOS_VENDAS, SAIPOS_VENDAS_POR_CANAL, SAIPOS_FORMAS_PAGAMENTO, SAIPOS_VENDAS_DIARIAS]);
