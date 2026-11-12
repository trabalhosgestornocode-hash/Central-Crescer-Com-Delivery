// FOODY DELIVERY — fonte operacional do valor DEVIDO aos entregadores próprios. Não comprova pagamento: o pagamento
// bancário é ligado depois, por conciliação (Foody × Unicred). Nada aqui cria despesa — e por isso não há como duplicar
// despesas que já tenham vindo de planilhas antigas de frete (o financeiro antigo nem é lido).
// Cada entregador mantém suas entregas e seu subtotal; a soma dos detalhes precisa bater com os subtotais e com o total.
import { somar } from "../../dominio/dinheiro.js";
import { rotulo } from "../leitor.js";
import { DIVERGENCIA, diferenca } from "../motor.js";
import { classificarPorPalavras, col, definirFonte } from "./comum.js";

const situacaoFoody = (t) => classificarPorPalavras(t, [["TAXA_REJEITADA", ["rejeit", "recusad"]], ["CANCELADA", ["cancel"]], ["ENTREGUE", ["entreg", "conclu", "finaliz"]]]);

export const FOODY_ENTREGAS = definirFonte({
  fonte: "FOODY",
  tipoRelatorio: "FOODY_ENTREGAS",
  tipoDocumento: "APURACAO_ENTREGADORES",
  descricao: "relatório de entregas por entregador do Foody",
  colunas: {
    pedido: col(["Pedido", "Nº do pedido", "Código do pedido"]),
    data: col(["Data", "Data da entrega"]),
    entregador: col(["Entregador", "Motoboy"]),
    taxa: col(["Taxa de entrega", "Taxa cobrada"]),
    custo: col(["Custo reconhecido", "Valor do entregador", "Repasse ao entregador"]),
    situacao: col(["Situação", "Status"]),
    totalDevido: col(["Total devido", "Subtotal"], false),
  },
  // Linha sem pedido = subtotal de um entregador ou total geral do relatório.
  ehTotal: (u) => !u.bruto("pedido"),
  lerTotal(u) {
    const valor = u.valor("totalDevido");
    if (valor === null) return null;
    const quem = u.bruto("entregador");
    return /^total/.test(rotulo(quem)) ? { tipo: "TOTAL", valorCentavos: valor } : { tipo: "SUBTOTAL", entregador: quem, valorCentavos: valor };
  },
  converter(u) {
    const pedido = u.texto("pedido");
    const data = u.data("data");
    const entregador = u.texto("entregador");
    const taxa = u.valor("taxa");
    const custo = u.valor("custo");
    if (u.erros.length) return null;
    const situacao = situacaoFoody(u.bruto("situacao")) ?? "NAO_RECONHECIDA";
    return {
      tipoRegistro: "ENTREGA", idExterno: pedido, data, valorCentavos: custo,
      dados: { entregador, taxaEntregaCentavos: taxa, custoReconhecidoCentavos: custo, situacao, situacaoOriginal: u.bruto("situacao"), devido: situacao === "ENTREGUE" },
    };
  },
  fechar(registros, { declarados }) {
    const divergencias = [];
    const porEntregador = {};
    for (const r of registros) {
      const e = (porEntregador[r.dados.entregador] ??= { entregas: 0, devidoCentavos: 0, declaradoCentavos: null });
      if (r.dados.situacao === "NAO_RECONHECIDA") divergencias.push({ codigo: DIVERGENCIA.VALOR_A_CLASSIFICAR, mensagem: `Pedido ${r.idExterno}: situação "${r.dados.situacaoOriginal}" não reconhecida.`, linha: r.linha });
      if (!r.dados.devido) continue;
      e.entregas += 1;
      e.devidoCentavos = somar(e.devidoCentavos, r.valorCentavos);
    }
    for (const d of declarados.filter((x) => x.tipo === "SUBTOTAL")) {
      const e = (porEntregador[d.entregador] ??= { entregas: 0, devidoCentavos: 0, declaradoCentavos: null });
      e.declaradoCentavos = d.valorCentavos;
      if (d.valorCentavos !== e.devidoCentavos) divergencias.push(diferenca(DIVERGENCIA.TOTAL_NAO_CONFERE, "Subtotal do entregador não confere com as entregas listadas.", d.valorCentavos, e.devidoCentavos, { linha: d.linha }));
    }
    const devido = Object.values(porEntregador).reduce((s, e) => somar(s, e.devidoCentavos), 0);
    for (const d of declarados.filter((x) => x.tipo === "TOTAL")) {
      if (d.valorCentavos !== devido) divergencias.push(diferenca(DIVERGENCIA.TOTAL_NAO_CONFERE, "Total devido do relatório não confere com a soma dos entregadores.", d.valorCentavos, devido, { linha: d.linha }));
    }
    return { controles: { devidoCentavos: devido, porEntregador }, divergencias };
  },
});

export const FONTES_FOODY = Object.freeze([FOODY_ENTREGAS]);
