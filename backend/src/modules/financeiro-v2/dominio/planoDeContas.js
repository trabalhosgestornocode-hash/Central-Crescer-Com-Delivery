// Plano de contas GERENCIAL. As classificações principais são fixas (catalogos.js); as categorias são cadastro
// hierárquico de cada unidade. Aqui ficam só as regras puras e os MODELOS de implantação — nenhum valor financeiro.
//
// Regra das taxas (corrigida na Execução 01B): um valor descontado do repasse NÃO é automaticamente dedução da receita.
// Cada retenção é classificada pela sua natureza econômica (a categoria decide):
//   desconto comercial → dedução comercial        taxa da maquininha → despesa de recebimento
//   comissão do marketplace → despesa comercial   mensalidade → despesa com plataforma
//   anúncios → marketing                          antecipação → encargo financeiro (exige documento)
import { CODIGO, falhar } from "./erros.js";
import { CANAL, CLASSIFICACAO as C, NATUREZA_LANCAMENTO as N, NATUREZAS_DA_CLASSIFICACAO } from "./catalogos.js";

/** Natureza efetiva de uma categoria: a informada (se a classificação permitir) ou a padrão da classificação. */
export function naturezaDaCategoria(classificacao, natureza) {
  const permitidas = NATUREZAS_DA_CLASSIFICACAO[classificacao];
  if (!permitidas) falhar(CODIGO.CATEGORIA_INVALIDA, "Classificação desconhecida.", { classificacao });
  if (natureza === undefined || natureza === null) return permitidas[0];
  if (!permitidas.includes(natureza)) falhar(CODIGO.CATEGORIA_INVALIDA, "Natureza incompatível com a classificação.", { classificacao, natureza });
  return natureza;
}

/** Filha herda a classificação da mãe; não existe categoria filha de classificação diferente. */
export function exigirFilhaCompativel(pai, filha) {
  if (!pai.ativa) falhar(CODIGO.CATEGORIA_INVALIDA, "A categoria superior está inativa.");
  if (pai.classificacao !== filha.classificacao) {
    falhar(CODIGO.CATEGORIA_INVALIDA, "A categoria deve ter a mesma classificação da categoria superior.", { esperado: pai.classificacao });
  }
}

/** Categoria pronta para receber lançamento. */
export function exigirLancavel(categoria) {
  if (!categoria.ativa || !categoria.aceitaLancamento) {
    falhar(CODIGO.CATEGORIA_INVALIDA, "A categoria está inativa ou é apenas agrupadora.", { categoria: categoria.codigo });
  }
  return categoria;
}

/**
 * Valor do lançamento gerado por um AJUSTE de título, conforme a natureza da categoria.
 * Obrigação: aumentar a dívida é despesa (+); reduzir com categoria de receita é ganho (+).
 * Recebível: reduzir o que se espera receber é despesa/dedução (+); aumentar com categoria de receita é ganho (+).
 */
export function valorDoLancamentoDeAjuste(alvoEhObrigacao, natureza, valorCentavos) {
  const ehReceita = natureza === N.RECEITA;
  if (alvoEhObrigacao) return ehReceita ? -valorCentavos : valorCentavos;
  return ehReceita ? valorCentavos : -valorCentavos;
}

const g = (codigo, nome, classificacao, extra = {}) => ({ codigo, nome, classificacao, pai: null, aceitaLancamento: false, ...extra });
const f = (codigo, nome, pai, extra = {}) => ({ codigo, nome, pai, aceitaLancamento: true, ...extra });

export const CATEGORIA_DE_VENDA = Object.freeze(Object.fromEntries(Object.values(CANAL).map((c) => [c, `VENDA_${c}`])));
export const CATEGORIA_DEVOLUCAO = "DEVOLUCOES_E_ESTORNOS";
export const CATEGORIA_VENDA_AGREGADA = "VENDAS_AGREGADAS_SEM_CANAL";
export const CATEGORIA_DESCONTO_A_CLASSIFICAR = "DESCONTOS_A_CLASSIFICAR";
/**
 * Despesa/obrigação cuja natureza econômica AINDA NÃO foi comprovada (boleto sem identificação, saída do extrato que
 * precisa virar conta). Existe como dívida, mas NÃO entra em nenhuma linha da DRE até ser reclassificada
 * (Execução 06B, auditoria A.2). "OUTRAS_DESPESAS" é categoria confirmada — não serve de provisória.
 */
export const CATEGORIA_DESPESA_A_CLASSIFICAR = "DESPESAS_A_CLASSIFICAR";

/** Modelo genérico: serve a qualquer empresa. As categorias `doSistema` são usadas pelo próprio núcleo. */
const BASE = [
  g("RECEITA_OPERACIONAL", "Receita operacional", C.RECEITA_OPERACIONAL),
  f("VENDA_BALCAO", "Vendas no balcão", "RECEITA_OPERACIONAL", { doSistema: true }),
  f("VENDA_IFOOD", "Vendas pelo iFood", "RECEITA_OPERACIONAL", { doSistema: true }),
  f("VENDA_ANOTA_AI", "Vendas pelo Anota AI", "RECEITA_OPERACIONAL", { doSistema: true }),
  f("VENDA_OUTRO", "Vendas por outros canais", "RECEITA_OPERACIONAL", { doSistema: true }),
  // Receita de relatório AGREGADO (total do dia, sem pedido nem canal): nunca é distribuída entre canais por suposição.
  f(CATEGORIA_VENDA_AGREGADA, "Vendas agregadas por dia (sem canal identificado)", "RECEITA_OPERACIONAL", { doSistema: true }),
  g("DEDUCOES_COMERCIAIS", "Deduções comerciais da receita", C.DEDUCOES_COMERCIAIS),
  f("DESCONTOS_COMERCIAIS", "Descontos comerciais concedidos", "DEDUCOES_COMERCIAIS"),
  f(CATEGORIA_DEVOLUCAO, "Devoluções e estornos a clientes", "DEDUCOES_COMERCIAIS", { doSistema: true }),
  // Desconto cujo financiador (loja × terceiro) a fonte não comprova: dedução conservadora, PENDENTE de classificação.
  f(CATEGORIA_DESCONTO_A_CLASSIFICAR, "Descontos com financiador não comprovado (a classificar)", "DEDUCOES_COMERCIAIS", { doSistema: true }),
  g("CUSTOS_OPERACIONAIS", "Custos operacionais gerenciais", C.CUSTOS_OPERACIONAIS),
  f("INSUMOS", "Insumos", "CUSTOS_OPERACIONAIS"),
  f("EMBALAGENS", "Descartáveis e embalagens", "CUSTOS_OPERACIONAIS"),
  g("DESPESAS_COMERCIAIS", "Despesas comerciais", C.DESPESAS_COMERCIAIS),
  f("COMISSOES_DE_PLATAFORMA", "Comissões de plataformas de venda", "DESPESAS_COMERCIAIS"),
  g("DESPESAS_RECEBIMENTO_PROCESSAMENTO", "Despesas com recebimento e processamento", C.DESPESAS_RECEBIMENTO_PROCESSAMENTO),
  f("TAXAS_DE_PROCESSAMENTO", "Taxas de processamento de pagamentos", "DESPESAS_RECEBIMENTO_PROCESSAMENTO"),
  g("DESPESAS_ADMINISTRATIVAS", "Despesas administrativas", C.DESPESAS_ADMINISTRATIVAS),
  f("DESPESAS_ADMINISTRATIVAS_GERAIS", "Despesas administrativas gerais", "DESPESAS_ADMINISTRATIVAS"),
  g("PESSOAL", "Pessoal", C.PESSOAL),
  f("SALARIOS_E_ENCARGOS", "Salários e encargos", "PESSOAL"),
  g("MARKETING", "Marketing", C.MARKETING),
  f("ANUNCIOS_E_DIVULGACAO", "Anúncios e divulgação", "MARKETING"),
  g("DESPESAS_PLATAFORMAS", "Despesas com plataformas", C.DESPESAS_PLATAFORMAS),
  f("MENSALIDADES_DE_PLATAFORMAS", "Mensalidades de plataformas", "DESPESAS_PLATAFORMAS"),
  g("DESPESAS_FINANCEIRAS", "Despesas financeiras", C.DESPESAS_FINANCEIRAS),
  f("JUROS_E_TARIFAS_BANCARIAS", "Juros e tarifas bancárias", "DESPESAS_FINANCEIRAS"),
  f("TAXAS_ANTECIPACAO", "Taxas de antecipação de recebíveis", "DESPESAS_FINANCEIRAS", { exigeDocumento: true }),
  g("TRIBUTOS", "Tributos", C.TRIBUTOS),
  f("TRIBUTOS_SOBRE_VENDAS", "Tributos sobre vendas", "TRIBUTOS", { natureza: N.DEDUCAO }),
  f("TRIBUTOS_DIVERSOS", "Outros tributos e taxas", "TRIBUTOS"),
  g("OUTROS_EFEITOS_GERENCIAIS", "Outros efeitos gerenciais", C.OUTROS_EFEITOS_GERENCIAIS),
  f("OUTRAS_DESPESAS", "Outras despesas", "OUTROS_EFEITOS_GERENCIAIS"),
  f(CATEGORIA_DESPESA_A_CLASSIFICAR, "Despesas a classificar (natureza não comprovada)", "OUTROS_EFEITOS_GERENCIAIS", { doSistema: true }),
  f("OUTRAS_RECEITAS", "Outras receitas", "OUTROS_EFEITOS_GERENCIAIS", { natureza: N.RECEITA }),
  f("DESCONTOS_OBTIDOS", "Descontos obtidos de fornecedores", "OUTROS_EFEITOS_GERENCIAIS", { natureza: N.RECEITA }),
  g("MOVIMENTACOES_PATRIMONIAIS", "Movimentações patrimoniais sem impacto direto no resultado", C.MOVIMENTACOES_PATRIMONIAIS),
  f("EMPRESTIMOS_E_FINANCIAMENTOS", "Empréstimos e financiamentos (principal)", "MOVIMENTACOES_PATRIMONIAIS"),
  f("APORTES_E_RETIRADAS", "Aportes e retiradas de sócios", "MOVIMENTACOES_PATRIMONIAIS"),
  f("IMOBILIZADO", "Compra de equipamentos e bens", "MOVIMENTACOES_PATRIMONIAIS"),
];

/** Complemento OPCIONAL de uma açaiteria. Outra empresa implanta só o BASE ou cadastra as próprias categorias. */
const ACAITERIA = [
  f("FRUTAS", "Frutas", "INSUMOS"),
  f("SUPERMERCADO", "Supermercado", "INSUMOS"),
  f("BROWNIES", "Brownies", "INSUMOS"),
  f("MIX", "Mix", "INSUMOS"),
  f("SUCO", "Suco", "INSUMOS"),
  f("ENTREGADORES_PROPRIOS", "Entregadores Próprios (Motoboys)", "DESPESAS_COMERCIAIS"),
  f("COMISSOES_IFOOD", "Comissões iFood", "DESPESAS_COMERCIAIS"),
  f("PROMOCOES_SUBSIDIADAS", "Promoções subsidiadas pela loja", "DEDUCOES_COMERCIAIS"),
  f("TAXAS_STONE", "Taxas Stone", "DESPESAS_RECEBIMENTO_PROCESSAMENTO"),
  f("MENSALIDADE_IFOOD", "Mensalidade iFood", "DESPESAS_PLATAFORMAS"),
  f("ANUNCIOS_IFOOD", "Anúncios iFood", "MARKETING"),
];

export const MODELO_DE_PLANO = Object.freeze({ BASE: Object.freeze(BASE), ACAITERIA: Object.freeze([...BASE, ...ACAITERIA]) });

/** Definição de uma categoria do sistema e de suas ascendentes, da raiz para a folha. */
export function cadeiaDoSistema(codigo) {
  const cadeia = [];
  for (let atual = BASE.find((c) => c.codigo === codigo); atual; atual = BASE.find((c) => c.codigo === atual.pai)) cadeia.unshift(atual);
  if (!cadeia.length) falhar(CODIGO.CATEGORIA_INVALIDA, "Categoria do sistema desconhecida.", { codigo });
  return cadeia;
}
