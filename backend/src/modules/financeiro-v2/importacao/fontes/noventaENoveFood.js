// 99FOOD — relatório oficial "Dados da loja": uma linha por DIA, com os totais informados pela plataforma.
// O arquivo não traz pedidos individuais, data de pagamento nem identificador do repasse: nada disso é presumido.
// O relatório não informa como as recompensas e a receita de ofertas compõem o repasse. Esses valores ficam guardados e
// visíveis, mas não viram receita nem despesa; a diferença para o repasse informado fica em conferência.
import { rotulo } from "../leitor.js";
import { DIVERGENCIA, diferenca } from "../motor.js";
import { col, definirFonte } from "./comum.js";

export const RELATORIO_99FOOD = "NOVENTA_E_NOVE_FOOD_RELATORIO";
const TOLERANCIA_POR_VENDA_CENTAVOS = 1; // o valor médio vem arredondado pela plataforma

export const NOVENTA_E_NOVE_FOOD_RELATORIO = definirFonte({
  fonte: "OUTRO",
  tipoRelatorio: RELATORIO_99FOOD,
  tipoDocumento: "DEMONSTRATIVO_REPASSE",
  descricao: "relatório oficial da 99Food (dados da loja)",
  formatosHomologados: ["xlsx"],
  aceitaZip: true,
  colunas: {
    data: col(["Data"]), nome: col(["Nome do estabelecimento"]), loja: col(["ID do loja", "ID da loja"]), cidade: col(["Cidade"], false),
    itens: col(["Vendas de itens"]), processamento: col(["Taxas de processamento de pagamento"]), comissao: col(["Despesas de comissão"]),
    quantidade: col(["Total de vendas realizadas"]), medio: col(["Valor médio dos pedidos"]), recompensas: col(["Recompensas da plataforma"]),
    ofertas: col(["Pedidos de oferta finalizados"]), repasse: col(["Valor do repasse"]), receitaOferta: col(["Receita de pedidos em oferta"]), marketing: col(["Despesas de marketing"]),
  },
  colunasOmitidas: ["Nome do signatário", "ID do signatário"],
  converter(u) {
    const data = u.data("data");
    const loja = u.texto("loja");
    const nome = u.texto("nome");
    const inteiro = (campo) => { const t = u.bruto(campo); if (!/^\d{1,6}$/.test(t)) { u.erro("VALOR_INVALIDO", `${campo} deve ser um número inteiro.`, campo); return 0; } return Number(t); };
    const dinheiro = (campo) => { const v = u.valor(campo); if (v !== null && v < 0) u.erro("VALOR_INVALIDO", `${campo} não pode ser negativo.`, campo); return v; };
    const itensCentavos = dinheiro("itens");
    const processamentoCentavos = dinheiro("processamento");
    const comissaoCentavos = dinheiro("comissao");
    const medioCentavos = dinheiro("medio");
    const recompensasCentavos = dinheiro("recompensas");
    const repasseCentavos = dinheiro("repasse");
    const receitaOfertaCentavos = dinheiro("receitaOferta");
    const marketingCentavos = dinheiro("marketing");
    const quantidade = inteiro("quantidade");
    const ofertas = inteiro("ofertas");
    if (u.erros.length) return null;
    return {
      tipoRegistro: "DIA_99FOOD", idExterno: `${loja}:${data}`, data, valorCentavos: itensCentavos,
      dados: { estabelecimento: loja, nomeDaLoja: nome, cidade: u.bruto("cidade") || null, quantidade, ofertas, itensCentavos, processamentoCentavos, comissaoCentavos, medioCentavos, marketingCentavos, recompensasCentavos, receitaOfertaCentavos, repasseCentavos },
    };
  },
  fechar(registros) {
    const { total, lojas, dias } = consolidar99Food(registros);
    const divergencias = [];
    if (lojas.length > 1) divergencias.push({ codigo: DIVERGENCIA.ESTABELECIMENTO_NAO_VERIFICADO, mensagem: `O arquivo traz ${lojas.length} lojas diferentes.` });
    for (const r of registros) {
      const d = r.dados;
      if (Math.abs(d.medioCentavos * d.quantidade - d.itensCentavos) > TOLERANCIA_POR_VENDA_CENTAVOS * Math.max(d.quantidade, 1)) divergencias.push({ codigo: DIVERGENCIA.LINHA_NAO_FECHA, mensagem: `Em ${r.data}, vendas de itens não fecham com a quantidade × valor médio.`, linha: r.linha });
    }
    if (total.diferencaRepasseCentavos) divergencias.push(diferenca(DIVERGENCIA.TOTAL_NAO_CONFERE, "O repasse informado não fecha com vendas − taxas − comissões − marketing: a diferença fica em conferência.", total.repasseCentavos, total.composicaoCentavos));
    return { controles: { relatorio99Food: { total, lojas, dias } }, divergencias };
  },
});

const novoTotal = () => ({ dias: 0, quantidade: 0, itensCentavos: 0, processamentoCentavos: 0, comissaoCentavos: 0, marketingCentavos: 0, recompensasCentavos: 0, receitaOfertaCentavos: 0, repasseCentavos: 0, composicaoCentavos: 0, diferencaRepasseCentavos: 0 });

/** Totais por dia e do período, sempre a partir das linhas do relatório. */
export function consolidar99Food(registros) {
  const total = novoTotal();
  const lojas = new Map();
  const dias = [...registros].map((r) => {
    const d = r.dados;
    const composicaoCentavos = d.itensCentavos - d.processamentoCentavos - d.comissaoCentavos - d.marketingCentavos;
    const dia = { data: r.data ?? r.dataReferencia, dias: 1, quantidade: d.quantidade, itensCentavos: d.itensCentavos, processamentoCentavos: d.processamentoCentavos, comissaoCentavos: d.comissaoCentavos, marketingCentavos: d.marketingCentavos, recompensasCentavos: d.recompensasCentavos, receitaOfertaCentavos: d.receitaOfertaCentavos, repasseCentavos: d.repasseCentavos, composicaoCentavos, diferencaRepasseCentavos: composicaoCentavos - d.repasseCentavos };
    for (const k of Object.keys(total)) total[k] += dia[k];
    lojas.set(d.estabelecimento, { id: d.estabelecimento, nome: d.nomeDaLoja, cidade: d.cidade });
    return dia;
  }).sort((a, x) => a.data.localeCompare(x.data));
  return { total, dias, lojas: [...lojas.values()] };
}

export const mesmaLoja = (a, b) => rotulo(a) === rotulo(b);
export const FONTES_99FOOD = Object.freeze([NOVENTA_E_NOVE_FOOD_RELATORIO]);
