// Explicações em LINGUAGEM SIMPLES dos indicadores, campos e operações do Financeiro. Texto estático (não é dado): os VALORES vêm sempre do
// servidor. Cada explicação diz o que é, sem simplificar a ponto de ficar tecnicamente errada (ex.: faturamento ≠ recebimento).
// `fonte` indica onde o número nasce; `cuidado` o que NÃO deve ser confundido.
export const EXPLICACOES = Object.freeze({
  faturamentoBruto: { nome: "Faturamento bruto", simples: "Total vendido no mês, antes de qualquer desconto, taxa ou imposto.", formula: "soma das vendas diárias registradas", cuidado: "Venda não é dinheiro na conta: o que entrou de fato são os Recebimentos." },
  faturamentoLiquido: { nome: "Faturamento líquido", simples: "O que sobra do faturamento bruto depois das deduções consideradas (impostos sobre vendas, taxas e tarifas de venda, antecipação).", formula: "faturamento bruto − deduções" },
  deducoes: { nome: "Deduções", simples: "Valores que saem da venda antes de ela virar receita da empresa: imposto sobre vendas, taxas de cartão e do iFood, tarifas e antecipação de recebíveis.", formula: "soma das categorias de dedução, pelo mês do pagamento" },
  recebimentos: { nome: "Recebimentos", simples: "Dinheiro que efetivamente entrou nas contas bancárias e no caixa no mês.", formula: "entradas de receita operacional (sem transferências entre contas)", cuidado: "Não é o mesmo que faturamento: a venda de hoje pode ser recebida em outro dia." },
  cmv: { nome: "CMV (custo das mercadorias vendidas)", simples: "Quanto a empresa gastou com os produtos e insumos considerados no custo das vendas, conforme a metodologia do relatório.", formula: "soma de insumos e descartáveis, pela competência (valor original da conta a pagar)" },
  entregas: { nome: "Entregas", simples: "Custo das entregas feitas por entregadores próprios no mês, pela competência do serviço.", formula: "soma das categorias de entrega, pela competência" },
  custos: { nome: "Custos totais", simples: "Tudo o que foi gasto diretamente para produzir e entregar o que foi vendido.", formula: "CMV + entregas" },
  despesasVariaveis: { nome: "Despesas variáveis", simples: "Despesas que mudam conforme a operação do mês (por exemplo diárias e gastos não programados).", formula: "soma das categorias de despesa variável, pelo mês do pagamento" },
  despesasFixas: { nome: "Despesas fixas", simples: "Despesas que existem todo mês independentemente de quanto se vende (pessoal, aluguel, serviços, despesas financeiras).", formula: "soma das categorias de despesa fixa, pelo mês do pagamento" },
  despesas: { nome: "Despesas", simples: "Gastos de funcionamento da empresa que não são custo direto do produto vendido.", formula: "despesas variáveis + despesas fixas" },
  margemContribuicao: { nome: "Margem de contribuição", simples: "Quanto sobra das vendas para pagar as despesas fixas e gerar lucro, depois dos custos e das despesas que variam com a operação.", formula: "faturamento líquido − custos − despesas variáveis" },
  resultadoGerencial: { nome: "Lucro gerencial", simples: "Resultado depois das deduções, custos e despesas consideradas na metodologia gerencial. Não é o lucro contábil nem o fiscal.", formula: "margem de contribuição − despesas fixas" },
  margemLiquida: { nome: "Margem líquida", simples: "Quantos centavos de lucro gerencial sobram em cada R$ 1,00 de faturamento bruto.", formula: "lucro gerencial ÷ faturamento bruto", cuidado: "É um percentual, não um valor em reais." },
  resultadoCaixa: { nome: "Resultado de caixa", simples: "Diferença entre o dinheiro que entrou e o que saiu no mês, por regime de caixa.", formula: "recebimentos − pagamentos operacionais" },
  saldoDisponivel: { nome: "Saldo disponível", simples: "Dinheiro que o sistema calcula ter hoje nas contas e no caixa.", formula: "saldo de abertura + entradas − saídas, por conta", cuidado: "É um saldo calculado; só vira conferido quando comparado ao extrato." },
  contasAPagar: { nome: "Contas a pagar", simples: "O que a empresa ainda deve a fornecedores e prestadores e não pagou.", formula: "saldo em aberto das obrigações (vencidas + a vencer)" },
  contasAReceber: { nome: "Contas a receber", simples: "Valores que a empresa tem direito de receber e ainda não recebeu (fora das vendas do dia a dia).", formula: "valor original − recebido, dos recebíveis em aberto" },
  jurosEncargos: { nome: "Juros e encargos", simples: "Acréscimos pagos além do valor original das contas (juros, multas, encargos).", formula: "juros confirmados + juros presumidos" },
  jurosPresumidos: { nome: "Juros presumidos", simples: "Diferença positiva entre o valor original da obrigação e o total pago, ainda não classificada definitivamente como juros.", formula: "total pago − valor original (quando positivo)", cuidado: "Presumido não é juros definitivo até alguém classificar." },
  dividas: { nome: "Dívidas", simples: "Empréstimos e financiamentos que a empresa ainda precisa pagar (saldo devedor).", formula: "saldo devedor das dívidas ativas" },
  pontoEquilibrio: { nome: "Ponto de equilíbrio", simples: "Faturamento mínimo no mês para o lucro gerencial ficar em zero: abaixo disso a empresa tem prejuízo.", formula: "despesas fixas ÷ (margem de contribuição ÷ faturamento bruto)" },
  conciliacao: { nome: "Conciliação", simples: "Comparação dos lançamentos financeiros com os movimentos do extrato bancário, para ver se tudo bate.", formula: "lançamentos × extrato" },
  entregadores_proprios: { nome: "Entregadores Próprios (Motoboys)", simples: "Representa os pagamentos aos entregadores próprios da operação do Açaí no Grau. Não deve ser confundido com fretes de fornecedores, taxas de entrega do iFood ou outras despesas logísticas.", formula: "soma das contas a pagar da categoria, pela competência do serviço" },
  totalVendasCanais: { nome: "Total de vendas por canal", simples: "Soma do que cada canal (balcão, iFood, Anota Aí) mostra no painel de vendas da SAIPOS. É o total do painel, que pode diferir da base usada na DRE.", formula: "soma do total de cada canal no painel (SAIPOS)", cuidado: "Este total inclui taxas de entrega e descontos que a base da DRE não considera: veja a ponte." },
  baseDre: { nome: "Faturamento base da DRE", simples: "Faturamento bruto que alimenta a DRE gerencial: vendas do mês no Saci, que é o total do painel por canal já descontados os ajustes de taxas de entrega e descontos.", formula: "total do painel por canal + ajustes = base da DRE" },
  ajusteVendas: { nome: "Ajuste de vendas", simples: "Diferença entre o total que o painel mostra e a base da DRE (por exemplo, taxa de entrega e desconto que o painel soma). Não é taxa financeira nem dedução: por isso não entra em Deduções, evitando contar duas vezes.", formula: "base da DRE = painel + ajustes (negativos reduzem)", cuidado: "Ajuste estimado continua pendente até alguém confirmar com evidência." },
  entregadores: { nome: "Entregadores Próprios (Motoboys)", simples: "Pagamentos aos entregadores próprios da operação, pela competência do período de produção. Não confundir com frete de fornecedor nem com taxa de entrega do iFood.", formula: "soma das contas a pagar de entregadores, pela competência (com rateio quando o período atravessa dois meses)" },
  vendaBruta: { nome: "Venda bruta do dia", simples: "Total vendido no dia, antes de taxas, descontos e impostos. A soma dos dias é o faturamento do mês.", formula: "soma das vendas diárias registradas", cuidado: "Venda não é dinheiro na conta: o que entra no banco vem do extrato, com prazo e taxas." },
  especie: { nome: "Recebido em espécie", simples: "Parte das vendas do dia recebida em dinheiro. É conferida com as entradas do caixa físico no mesmo dia.", formula: "valor informado × entradas do caixa físico no dia", cuidado: "Dinheiro não é um canal de venda: não presuma que seja só o balcão." },
  sangria: { nome: "Sangria", simples: "Retirada de dinheiro do caixa físico (depósito no banco, pagamento a fornecedor, retirada do sócio…). Tem destino.", formula: "valor informado × saídas do caixa físico no dia", cuidado: "Sangria não é despesa por si só: só vira despesa se o gasto for lançado como despesa." },
  mediaDiaria: { nome: "Média diária de vendas", simples: "Quanto a loja vendeu por dia, em média, nos dias com venda registrada.", formula: "total de vendas brutas ÷ dias com venda registrada" },
  diasRegistrados: { nome: "Dias registrados", simples: "Quantos dias do mês já têm venda registrada. Dias sem registro (até hoje) aparecem para você completar.", formula: "dias com venda registrada ÷ dias do mês" },
  dreGerencial: { nome: "DRE Gerencial", simples: "Demonstrativo de resultados da empresa no mês, na metodologia gerencial: parte do faturamento e vai descontando deduções, custos e despesas até chegar ao lucro gerencial.", formula: "faturamento bruto − deduções − custos − despesas" },
});

/** Situação de qualidade do dado → rótulo e tom (cor), com texto que diz por que. */
export const SITUACOES = Object.freeze({
  confirmado: { rotulo: "Confirmado", tom: "ok", texto: "Dado registrado e conferido pelos próprios lançamentos." },
  pendente_contadora: { rotulo: "Pendente da contadora", tom: "warn", texto: "Depende de uma decisão contábil ainda não aprovada pela contadora." },
  parcial: { rotulo: "Parcial", tom: "warn", texto: "Falta parte dos dados: o número pode estar incompleto." },
  sem_dados: { rotulo: "Sem dados", tom: "muted", texto: "O sistema não tem a informação necessária para calcular." },
  divergente: { rotulo: "Divergente", tom: "bad", texto: "A soma das partes não confere com o total." },
});

export const CRITERIOS = Object.freeze({ caixa: "pagamento no mês", competencia: "competência do mês", rateio: "rateio por competência", fonte: "vendas registradas", informado: "informado", fora: "fora do resultado" });

export const explicacaoDe = (id) => {
  if (typeof id === "string" && id.startsWith("cat:")) { const t = CATEGORIAS_DESCRICAO[id.slice(4)]; return t ? { nome: id.slice(4).replace(/(^| )\w/g, (c) => c.toUpperCase()), simples: t, formula: "soma dos lançamentos da categoria no mês, conforme o critério da DRE" } : null; }
  return EXPLICACOES[id] ?? null;
};

/** Descrição simples das categorias do plano de contas (chave = nome sem acento, minúsculo). Só texto estático: os valores vêm do servidor. */
export const CATEGORIAS_DESCRICAO = Object.freeze({
  "insumos - distribuidora": "Compras do fornecedor principal de açaí e insumos. É o maior item do CMV.",
  "insumos - frutas": "Frutas e polpas compradas para a produção.",
  "insumos - supermercado": "Bombons e complementos comprados em supermercado.",
  "descartaveis": "Copos, colheres, embalagens e outros itens descartáveis.",
  "insumos - brownies": "Brownies comprados para venda.",
  "insumos - mix": "Insumos do fornecedor Mix Piauí.",
  "insumos - suco": "Sucos comprados para venda.",
  "simples nacional": "Imposto único sobre o faturamento (DAS). Reduz o faturamento até chegar ao líquido.",
  "tarifa vendas": "Taxas e comissões cobradas pelas plataformas e maquininhas sobre as vendas (iFood, Stone).",
  "taxa de antecipacao": "Custo de receber antes do prazo as vendas feitas no cartão ou no app.",
  "salario": "Folha de pagamento dos colaboradores.", "inss": "Contribuição previdenciária da folha.", "fgts": "Depósito do FGTS dos colaboradores.",
  "beneficios": "Vale-refeição, vale-transporte e saúde do trabalhador.", "ferias": "Férias pagas aos colaboradores.", "exame admissional/demissional": "Exames de entrada e saída de colaboradores.",
  "contabilidade": "Honorários do escritório de contabilidade.", "energia": "Conta de energia elétrica da loja.", "aluguel": "Aluguel do imóvel.",
  "tarifas": "Tarifas bancárias e de manutenção de conta.", "diarias": "Diárias pagas a extras que cobrem folgas ou picos.", "outras despesas": "Gastos pontuais que não têm categoria própria.",
  "emprestimo": "Parcelas de empréstimos. Ficam fora do resultado gerencial: são dívida, não despesa.", "marketing": "Divulgação e publicidade.", "manutencao predial": "Consertos e manutenção do imóvel.",
});
const semAcento = (t) => String(t ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
/** Chave de glossário de uma categoria (ou null quando não há descrição escrita). */
export const chaveCategoria = (rotulo) => (CATEGORIAS_DESCRICAO[semAcento(rotulo)] ? `cat:${semAcento(rotulo)}` : null);
