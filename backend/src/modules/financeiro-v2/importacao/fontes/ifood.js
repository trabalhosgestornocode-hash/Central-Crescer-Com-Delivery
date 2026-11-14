// IFOOD — apuração financeira OFICIAL da plataforma, preservada linha a linha. Contrato SINTÉTICO: não havia amostra real
// do arquivo exportado nesta execução; a compatibilidade documental fica PENDENTE (docs/financeiro-v2/05).
//
// Cada componente tem natureza econômica própria (sugestão de categoria do plano de contas; nada é lançado na importação):
//   vendas, taxas adicionais cobradas do consumidor, comissões, transação de pagamento, promoções (com quem subsidia),
//   Entrega Sob Demanda, mensalidade, anúncios, ajustes, antecipação, serviços descontados, repasses previstos e pagos.
// A antecipação de recebíveis do iFood JÁ está dentro da apuração: fica marcada para não ser descontada de novo.
// Componente não reconhecido não é adivinhado: vira pendência "a classificar".
import { somar } from "../../dominio/dinheiro.js";
import { rotulo } from "../leitor.js";
import { DIVERGENCIA, diferenca } from "../motor.js";
import { classificarPorPalavras, col, definirFonte } from "./comum.js";

/** componente → { categoriaSugerida, efeito } . efeito: RESULTADO (entra no resultado) | LIQUIDACAO (é o dinheiro do repasse). */
export const COMPONENTES_IFOOD = Object.freeze({
  VENDAS: { categoriaSugerida: "VENDA_IFOOD", efeito: "RESULTADO" },
  // Pode ser cobrança do iFood em benefício próprio: nunca vira receita da loja automaticamente.
  TAXA_ADICIONAL_CONSUMIDOR: { categoriaSugerida: null, efeito: "A_CLASSIFICAR" },
  COMISSAO: { categoriaSugerida: "COMISSOES_IFOOD", efeito: "RESULTADO" },
  TRANSACAO_PAGAMENTO: { categoriaSugerida: "TAXAS_DE_PROCESSAMENTO", efeito: "RESULTADO" },
  PROMOCAO_LOJA: { categoriaSugerida: "PROMOCOES_SUBSIDIADAS", efeito: "RESULTADO" },
  PROMOCAO_IFOOD: { categoriaSugerida: null, efeito: "INFORMATIVO" }, // subsidiada pelo iFood: não reduz o resultado da loja
  ENTREGA_SOB_DEMANDA: { categoriaSugerida: "COMISSOES_DE_PLATAFORMA", efeito: "RESULTADO" },
  MENSALIDADE: { categoriaSugerida: "MENSALIDADE_IFOOD", efeito: "RESULTADO" },
  ANUNCIOS: { categoriaSugerida: "ANUNCIOS_IFOOD", efeito: "RESULTADO" },
  AJUSTE: { categoriaSugerida: null, efeito: "A_CLASSIFICAR" },
  ANTECIPACAO: { categoriaSugerida: "TAXAS_ANTECIPACAO", efeito: "RESULTADO", jaIncluidaNaApuracao: true },
  SERVICOS_DESCONTADOS: { categoriaSugerida: null, efeito: "A_CLASSIFICAR" },
  REPASSE_PREVISTO: { categoriaSugerida: null, efeito: "LIQUIDACAO" },
  REPASSE_PAGO: { categoriaSugerida: null, efeito: "LIQUIDACAO" },
});

function componenteIfood(texto, responsavel) {
  const c = classificarPorPalavras(texto, [
    ["REPASSE_PAGO", ["repasse pago", "repasse realizado", "valor pago"]],
    ["REPASSE_PREVISTO", ["repasse previsto", "valor a receber", "previsao de repasse"]],
    ["ANTECIPACAO", ["antecipa"]],
    ["ENTREGA_SOB_DEMANDA", ["entrega sob demanda", "sob demanda", "logistica ifood"]],
    ["MENSALIDADE", ["mensalidade", "plano mensal"]],
    ["ANUNCIOS", ["anuncio", "impulsion", "patrocin"]],
    ["COMISSAO", ["comissao"]],
    ["TRANSACAO_PAGAMENTO", ["transacao de pagamento", "taxa de pagamento", "taxa de transacao"]],
    ["TAXA_ADICIONAL_CONSUMIDOR", ["taxa de servico", "taxa adicional", "pedido minimo"]],
    ["PROMOCAO", ["promoc", "cupom", "desconto"]],
    ["SERVICOS_DESCONTADOS", ["servico descontado", "servicos descontados"]],
    ["AJUSTE", ["ajuste", "estorno", "contestac"]],
    ["VENDAS", ["venda", "pedidos", "valor dos itens"]],
  ]);
  if (c !== "PROMOCAO") return c;
  const quem = rotulo(responsavel);
  if (/ifood/.test(quem)) return "PROMOCAO_IFOOD";
  if (/loja|restaurante|parceiro/.test(quem)) return "PROMOCAO_LOJA";
  return "PROMOCAO_SEM_RESPONSAVEL";
}

export const IFOOD_APURACAO = definirFonte({
  fonte: "IFOOD",
  tipoRelatorio: "IFOOD_APURACAO",
  tipoDocumento: "DEMONSTRATIVO_REPASSE",
  descricao: "apuração financeira do iFood",
  colunas: {
    data: col(["Data", "Data do lançamento", "Data de referência"]),
    componente: col(["Tipo", "Tipo de lançamento", "Componente"]),
    descricao: col(["Descrição", "Detalhe"], false),
    pedido: col(["Pedido", "ID do pedido"], false),
    valor: col(["Valor", "Valor (R$)"]),
    responsavel: col(["Responsável", "Subsidiado por", "Responsável pelo subsídio"], false),
    loja: col(["ID da loja", "Merchant ID", "Loja"], false),
  },
  ehTotal: (u) => /^total/.test(rotulo(u.bruto("componente"))),
  lerTotal: () => null,
  converter(u) {
    const data = u.data("data");
    const valor = u.valor("valor");
    if (u.erros.length) return null;
    const original = u.bruto("componente");
    const componente = componenteIfood(`${original} ${u.bruto("descricao")}`, u.bruto("responsavel"));
    const regra = COMPONENTES_IFOOD[componente] ?? null;
    return {
      tipoRegistro: "COMPONENTE_APURACAO", idExterno: null, data, valorCentavos: valor,
      dados: {
        componente: componente ?? "NAO_RECONHECIDO", componenteOriginal: original, descricao: u.bruto("descricao") || null, pedido: u.bruto("pedido") || null,
        responsavelSubsidio: u.bruto("responsavel") || null, categoriaSugerida: regra?.categoriaSugerida ?? null, efeito: regra?.efeito ?? "A_CLASSIFICAR",
        jaIncluidaNaApuracao: regra?.jaIncluidaNaApuracao === true, estabelecimento: u.bruto("loja") || null,
      },
      identidade: { data, componente: rotulo(original), descricao: rotulo(u.bruto("descricao")), pedido: u.bruto("pedido"), valor },
    };
  },
  fechar(registros) {
    const divergencias = [];
    const porComponente = {};
    for (const r of registros) {
      porComponente[r.dados.componente] = somar(porComponente[r.dados.componente] ?? 0, r.valorCentavos);
      if (r.dados.efeito === "A_CLASSIFICAR") divergencias.push({ codigo: DIVERGENCIA.VALOR_A_CLASSIFICAR, mensagem: `Componente "${r.dados.componenteOriginal}" sem classificação definida.`, linha: r.linha });
    }
    const composicao = registros.filter((r) => r.dados.efeito !== "LIQUIDACAO" && r.dados.efeito !== "INFORMATIVO").reduce((s, r) => somar(s, r.valorCentavos), 0);
    const previsto = porComponente.REPASSE_PREVISTO;
    if (previsto !== undefined && previsto !== composicao) {
      divergencias.push(diferenca(DIVERGENCIA.TOTAL_NAO_CONFERE, "A soma dos componentes da apuração não fecha com o repasse previsto.", previsto, composicao));
    }
    if (previsto !== undefined && porComponente.REPASSE_PAGO !== undefined && porComponente.REPASSE_PAGO !== previsto) {
      divergencias.push(diferenca(DIVERGENCIA.TOTAL_NAO_CONFERE, "Repasse pago difere do previsto (a diferença precisa de explicação documental).", previsto, porComponente.REPASSE_PAGO));
    }
    return { controles: { porComponente, composicaoCentavos: composicao, antecipacaoJaIncluidaNaApuracao: true }, divergencias };
  },
});

/**
 * Composição GERENCIAL do canal iFood a partir dos componentes da apuração — cada componente entra UMA vez, pela sua
 * natureza econômica (nada é subtraído duas vezes; antecipação já está dentro da apuração).
 *   líquido gerencial = vendas próprias − promoções da loja − comissões − transação − serviços − mensalidade − anúncios
 *                       − antecipação ± ajustes/serviços a classificar   (promoção financiada pelo iFood é só informativa)
 * Confere com o repasse previsto quando ele existe.
 * @param {Array<{componente:string, valorCentavos:number}>} componentes valores com o SINAL da apuração
 */
export function composicaoIfood(componentes) {
  const soma = (pred) => componentes.filter((c) => pred(c.componente)).reduce((s, c) => somar(s, c.valorCentavos), 0);
  const de = (...nomes) => soma((n) => nomes.includes(n));
  const efeito = (n) => COMPONENTES_IFOOD[n]?.efeito ?? "A_CLASSIFICAR";
  const r = {
    vendasProprias: de("VENDAS"), promocoesLoja: de("PROMOCAO_LOJA"), promocoesTerceiros: de("PROMOCAO_IFOOD"), comissoes: de("COMISSAO"),
    transacaoPagamento: de("TRANSACAO_PAGAMENTO"), servicos: de("ENTREGA_SOB_DEMANDA"), mensalidade: de("MENSALIDADE"), anuncios: de("ANUNCIOS"),
    antecipacao: de("ANTECIPACAO"), aClassificar: soma((n) => efeito(n) === "A_CLASSIFICAR"), repassePrevisto: componentes.some((c) => c.componente === "REPASSE_PREVISTO") ? de("REPASSE_PREVISTO") : null,
  };
  r.liquidoGerencial = soma((n) => !["LIQUIDACAO", "INFORMATIVO"].includes(efeito(n)));
  r.confereComRepasse = r.repassePrevisto === null ? null : r.repassePrevisto === r.liquidoGerencial;
  r.porNatureza = {
    RECEITA: r.vendasProprias, DEDUCAO: r.promocoesLoja,
    DESPESA: [r.comissoes, r.transacaoPagamento, r.servicos, r.mensalidade, r.anuncios, r.antecipacao].reduce((s, v) => somar(s, v), 0),
    A_CLASSIFICAR: r.aClassificar,
  };
  return r;
}

export const FONTES_IFOOD = Object.freeze([IFOOD_APURACAO]);
