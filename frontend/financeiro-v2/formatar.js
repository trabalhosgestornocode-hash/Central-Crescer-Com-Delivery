// Formatação de APRESENTAÇÃO (pt-BR). Nenhuma fórmula financeira: só transforma valores já calculados pelo motor.
/** Centavos → "R$ 1.234,56" só com texto (sem aritmética de ponto flutuante). Nulo/indefinido NUNCA vira R$ 0,00. */
export function moeda(centavos) {
  if (centavos === null || centavos === undefined) return "Valor desconhecido";
  const t = String(centavos).replace("-", "").padStart(3, "0");
  const inteiro = t.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${String(centavos).startsWith("-") ? "−" : ""}R$ ${inteiro},${t.slice(-2)}`;
}

/** Centésimos de ponto percentual (10000 = 100%) → "12,34%". */
export function percentual(centesimos) {
  if (centesimos === null || centesimos === undefined) return "—";
  const t = String(Math.abs(centesimos)).padStart(3, "0");
  return `${centesimos < 0 ? "−" : ""}${t.slice(0, -2)},${t.slice(-2)}%`;
}

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
export const competencia = (aaaamm) => (/^\d{4}-\d{2}$/.test(aaaamm ?? "") ? `${MESES[Number(aaaamm.slice(5)) - 1]} de ${aaaamm.slice(0, 4)}` : "—");
export const dataBR = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso ?? "") ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");

/** Situação de confiabilidade → rótulo, classe visual e explicação curta. */
export const SITUACOES = Object.freeze({
  CONFIRMADO: { rotulo: "Confirmado", classe: "ok", explicacao: "Competência homologada e sem pendências." },
  CALCULADO_AGUARDANDO_CONFERENCIA: { rotulo: "Aguardando conferência", classe: "info", explicacao: "Calculado; a competência está em fechamento com pendências documentadas." },
  PRELIMINAR: { rotulo: "Preliminar", classe: "info", explicacao: "Calculado com os registros atuais; a competência ainda não foi homologada." },
  PARCIAL: { rotulo: "Parcial", classe: "alerta", explicacao: "Há vendas ou operações ainda não aplicadas: o valor está incompleto." },
  PENDENTE_DE_CLASSIFICACAO: { rotulo: "Pendente de classificação", classe: "alerta", explicacao: "Há valores com classificação provisória (ex.: desconto sem financiador comprovado)." },
  BLOQUEADO_POR_EVIDENCIA_INSUFICIENTE: { rotulo: "Sem evidência suficiente", classe: "erro", explicacao: "Não há registros suficientes: o valor é desconhecido, não zero." },
});
export const situacao = (codigo) => SITUACOES[codigo] ?? { rotulo: "Situação desconhecida", classe: "erro", explicacao: "" };

export const CANAIS = Object.freeze({ BALCAO: "Balcão", IFOOD: "iFood", ANOTA_AI: "Anota AI", OUTRO: "Outros canais", NAO_IDENTIFICADO: "Sem canal identificado" });
export const nomeCanal = (c) => CANAIS[c] ?? c;

export const CLASSIFICACOES = Object.freeze({
  DESPESAS_COMERCIAIS: "Comissões e despesas comerciais", DESPESAS_RECEBIMENTO_PROCESSAMENTO: "Taxas de processamento", MARKETING: "Anúncios e promoções",
  DESPESAS_PLATAFORMAS: "Despesas de plataforma", DESPESAS_FINANCEIRAS: "Encargos financeiros", DESPESAS_ADMINISTRATIVAS: "Administrativas", PESSOAL: "Pessoal",
  TRIBUTOS: "Tributos", CUSTOS_OPERACIONAIS: "Custos operacionais",
});

/** Escapa texto para HTML (todo texto vindo do servidor passa por aqui). */
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

// ------------------------------------------------------------------------------------------- tesouraria (Execução 06A)
/** Situações de títulos e movimentos: rótulo, cor (usada com moderação) e explicação curta. */
export const SITUACOES_TITULO = Object.freeze({
  EM_ABERTO: { rotulo: "Em aberto", classe: "info", explicacao: "Ainda não venceu e nada foi pago." },
  PARCIALMENTE_PAGO: { rotulo: "Parcialmente pago", classe: "info", explicacao: "Parte foi paga; o saldo continua em aberto." },
  PAGO: { rotulo: "Pago", classe: "ok", explicacao: "Saldo zerado por pagamentos registrados." },
  VENCIDO: { rotulo: "Vencido", classe: "erro", explicacao: "O vencimento passou e ainda há saldo. Vencer não marca como pago." },
  CANCELADO: { rotulo: "Cancelado", classe: "neutro", explicacao: "Cancelado com histórico; não entra nos totais." },
  AGUARDANDO_CLASSIFICACAO_OU_EVIDENCIA: { rotulo: "Aguardando classificação", classe: "alerta", explicacao: "Natureza econômica não comprovada: a dívida existe, mas fica fora da DRE até ser classificada." },
  A_RECEBER: { rotulo: "A receber", classe: "info", explicacao: "Previsão documentada; ainda não venceu." },
  PARCIALMENTE_RECEBIDO: { rotulo: "Parcialmente recebido", classe: "info", explicacao: "Parte já entrou na conta; o saldo continua pendente." },
  RECEBIDO: { rotulo: "Recebido", classe: "ok", explicacao: "Saldo zerado por créditos registrados na conta." },
  ATRASADO: { rotulo: "Atrasado", classe: "erro", explicacao: "A data prevista passou e o crédito não apareceu." },
  SEM_PREVISAO_CONFIAVEL: { rotulo: "Sem previsão confiável", classe: "alerta", explicacao: "Não há documento com a data de pagamento: a data não é presumida." },
  EM_DIVERGENCIA: { rotulo: "Em divergência", classe: "erro", explicacao: "O valor recebido não fecha com o esperado; a diferença está registrada." },
});
export const situacaoTitulo = (codigo) => SITUACOES_TITULO[codigo] ?? { rotulo: "Situação desconhecida", classe: "neutro", explicacao: "" };

export const DEVEDORES = Object.freeze({ STONE: "Stone", IFOOD: "iFood", ANOTA_AI: "Anota AI", OPERADORA_BENEFICIOS: "Operadora de benefícios", MAQUINA_TERCEIROS: "Máquina de terceiros", OUTRO: "Outro" });
export const nomeDevedor = (d) => (d?.tipo === "PROCESSADORA" ? DEVEDORES[d.nome] ?? d.nome : d?.nome ?? "Devedor não identificado");
export const TIPOS_RECEBIVEL = Object.freeze({ RECEBIMENTO_DIRETO: "Recebimento direto", RECEBIVEL_DE_OPERADORA: "Recebível de operadora", REPASSE: "Repasse" });
export const NATUREZAS_FLUXO = Object.freeze({
  RECEBIMENTO_DIRETO_DE_VENDA: "Venda recebida direto na conta", RECEBIMENTO_DE_TITULO: "Recebimento de título", PAGAMENTO_DE_OBRIGACAO: "Pagamento de conta",
  DEVOLUCAO_A_CLIENTE: "Devolução a cliente", SEM_VINCULO: "Sem vínculo identificado", CONTA_A_PAGAR: "Conta a pagar", CONTA_VENCIDA_EM_ABERTO: "Conta vencida em aberto",
  RECORRENCIA_PREVISTA: "Recorrência prevista (estimada)", RECEBIMENTO_DIRETO: "Recebimento direto previsto", RECEBIVEL_DE_OPERADORA: "Recebível de operadora", REPASSE: "Repasse previsto",
});
export const MOTIVOS_PARCIAL = Object.freeze({
  SALDO_DISPONIVEL_DESCONHECIDO: "Falta o saldo informado (extrato ou contagem) de alguma conta.",
  RECEBIVEIS_SEM_PREVISAO_CONFIAVEL: "Há valores a receber sem data documentada: ficaram fora da projeção.",
  INCLUI_RECORRENCIAS_ESTIMADAS: "Inclui contas recorrentes estimadas pelo último valor.",
});
export const EVENTOS = Object.freeze({
  CRIACAO: "Registrado", LIQUIDACAO: "Pagamento/recebimento vinculado", ESTORNO: "Estorno", AJUSTE: "Ajuste documentado", CORRECAO: "Correção",
  CANCELAMENTO: "Cancelado", CONCILIACAO: "Conciliação", RECLASSIFICACAO: "Reclassificação", OPERACAO_DE_CAIXA: "Operação de caixa", FECHAMENTO_DE_CAIXA: "Fechamento de caixa",
});
export const OPERACOES_CAIXA = Object.freeze({ ENTRADA: "Entrada", SAIDA: "Saída", SANGRIA: "Sangria", SUPRIMENTO: "Suprimento" });
export const TIPOS_DOCUMENTO = Object.freeze({
  EXTRATO_BANCARIO: "Extrato bancário", RELATORIO_VENDAS: "Relatório de vendas", RELATORIO_PROCESSADOR: "Relatório da processadora", DEMONSTRATIVO_REPASSE: "Demonstrativo de repasse",
  NOTA_FISCAL: "Nota fiscal", BOLETO: "Boleto", COMPROVANTE: "Comprovante", APURACAO_ENTREGADORES: "Apuração de entregadores", CONTRATO: "Contrato", OUTRO: "Documento",
});

/**
 * Descrição técnica do backend → texto para o gestor. A original segue disponível como evidência (atributo title).
 * Só apresentação: nunca muda valores nem classificações.
 */
export function descricaoLegivel(texto) {
  if (!texto) return "";
  const venda = /^Venda (BALCAO|IFOOD|ANOTA_AI|OUTRO)$/.exec(texto);
  if (venda) return `Venda — ${CANAIS[venda[1]]}`;
  const direto = /^Recebimento direto de venda \((\w+)\)$/.exec(texto);
  if (direto) return `Venda recebida ${({ DINHEIRO: "em dinheiro", PIX: "por Pix", DEBITO: "no débito", CREDITO: "no crédito" })[direto[1]] ?? ""}`.trim();
  const entregas = /^Entregas de (\d{4}-\d{2}-\d{2}) a (\d{4}-\d{2}-\d{2})$/.exec(texto);
  if (entregas) return `Entregas de ${dataBR(entregas[1])} a ${dataBR(entregas[2])}`;
  return texto.replace(/\b([A-Z]{2,}(?:_[A-Z]+)+)\b/g, (c) => c.toLowerCase().replaceAll("_", " ")).replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, "$3/$2/$1");
}

// ------------------------------------------------------------------------------------- vendas e recebimentos (Execução 06B)
export const SITUACOES_VENDA = Object.freeze({
  AGUARDANDO_PAGAMENTO: { rotulo: "Aguardando pagamento", classe: "alerta", explicacao: "Ainda faltam pagamentos informados para fechar o valor cobrado." },
  AGUARDANDO_RECEBIMENTO: { rotulo: "Aguardando recebimento", classe: "info", explicacao: "Paga pelo consumidor; o dinheiro ainda não entrou (ou não foi identificado) na conta." },
  RECEBIDA_SEM_COMPROVACAO: { rotulo: "Recebida sem comprovação", classe: "alerta", explicacao: "O crédito foi registrado, mas sem extrato, conciliação ou contagem de caixa que o comprove." },
  RECEBIDA_E_COMPROVADA: { rotulo: "Recebida e comprovada", classe: "ok", explicacao: "Todo o valor entrou na conta e o crédito está comprovado." },
  EM_DIVERGENCIA: { rotulo: "Em divergência", classe: "erro", explicacao: "Há valor que não fecha (pagamento ou recebimento divergente)." },
  CANCELADA: { rotulo: "Cancelada", classe: "neutro", explicacao: "Cancelada com histórico; fora dos totais." },
  AGREGADA_SEM_DETALHE: { rotulo: "Agregada (sem pedidos)", classe: "neutro", explicacao: "Total do dia de um relatório agregado: sem pedidos, canal ou forma de pagamento." },
});
export const situacaoVenda = (c) => SITUACOES_VENDA[c] ?? { rotulo: "Situação desconhecida", classe: "neutro", explicacao: "" };
export const CONFIABILIDADES = Object.freeze({
  DOCUMENTADA: { rotulo: "Documentada", classe: "ok", explicacao: "Veio de relatório importado e sem pendências." },
  REGISTRADA_SEM_DOCUMENTO: { rotulo: "Registrada sem documento", classe: "info", explicacao: "Registro manual, sem relatório de origem vinculado." },
  AGREGADA_SEM_DETALHE: { rotulo: "Agregada", classe: "neutro", explicacao: "Total diário: sem granularidade por pedido." },
  COM_PENDENCIA: { rotulo: "Com pendência", classe: "alerta", explicacao: "Há informação faltando ou provisória (veja as pendências)." },
});
export const SITUACOES_RECEBIMENTO = Object.freeze({
  NAO_RECEBIDO: { rotulo: "Não recebido", classe: "alerta", explicacao: "Nenhum crédito vinculado ainda." },
  PARCIALMENTE_RECEBIDO: { rotulo: "Parcialmente recebido", classe: "info", explicacao: "Parte foi creditada; há saldo restante." },
  RECEBIDO_SEM_COMPROVACAO: { rotulo: "Recebido sem comprovação", classe: "alerta", explicacao: "Crédito registrado sem extrato bancário ou conciliação." },
  RECEBIDO_E_COMPROVADO: { rotulo: "Recebido e comprovado", classe: "ok", explicacao: "Crédito comprovado por extrato ou conciliação." },
  CANCELADO: { rotulo: "Cancelado", classe: "neutro", explicacao: "Cancelado junto com a venda." },
});
export const situacaoRecebimento = (c) => SITUACOES_RECEBIMENTO[c] ?? { rotulo: "—", classe: "neutro", explicacao: "" };
export const COMPROVACOES = Object.freeze({ CONCILIADA: "Conciliado", EXTRATO_BANCARIO: "Extrato bancário", CONTAGEM_DE_CAIXA: "Contagem de caixa", SEM_COMPROVACAO: "Sem comprovação" });
export const TIPOS_COMPONENTE = Object.freeze({
  DESCONTO_DA_LOJA: "Desconto da loja", DESCONTO_FINANCIADOR_NAO_COMPROVADO: "Desconto (financiador não comprovado)", SUBSIDIO_DE_TERCEIRO: "Subsídio de terceiro (comprovado)",
  DEVOLUCAO: "Devolução ao cliente", TAXA_DE_PROCESSAMENTO: "Taxa de processamento", COMISSAO: "Comissão", ANUNCIO: "Anúncio", MENSALIDADE: "Mensalidade",
  ENCARGO_FINANCEIRO: "Encargo financeiro (antecipação)", AJUSTE_COMERCIAL: "Ajuste comercial", ESTORNO: "Estorno", OUTRO_AJUSTE: "Outro ajuste",
});
export const LINHAS_DRE = Object.freeze({
  DEDUCOES_COMERCIAIS: "Deduções comerciais", DESPESAS_OPERACIONAIS: "Despesas operacionais", RESULTADO_FINANCEIRO: "Resultado financeiro", CUSTOS_OPERACIONAIS: "Custos operacionais",
  DEMAIS_EFEITOS_GERENCIAIS: "Demais efeitos", NENHUMA_SUBSIDIO_A_RECEBER: "Fora da DRE (a receber do terceiro)", FORA_ATE_CLASSIFICAR: "Fora da DRE até classificar", FORA_DO_RESULTADO: "Fora do resultado",
});
export const ETAPAS = Object.freeze({
  VENDA_REGISTRADA: "Venda registrada", PAGAMENTO_INFORMADO: "Pagamento informado", TRANSACAO_PROCESSADA: "Transação processada", TAXA_IDENTIFICADA: "Taxa identificada",
  RECEBIVEL_FORMADO: "Recebível formado", REPASSE_INFORMADO: "Repasse informado", CREDITO_BANCARIO_IDENTIFICADO: "Crédito na conta", CONCILIACAO_CONFIRMADA: "Conciliação confirmada",
  ESTORNO: "Estorno", CANCELAMENTO: "Cancelamento",
});
export const DIVERGENCIAS_VENDA = Object.freeze({
  VENDA_SEM_PAGAMENTO: "Venda sem pagamento", PAGAMENTO_INCOMPATIVEL: "Pagamento incompatível", TRANSACAO_SEM_PEDIDO: "Transação sem pedido", RECEBIVEL_SEM_REPASSE: "Recebível sem repasse",
  RECEBIVEL_ATRASADO: "Recebimento atrasado", REPASSE_INFORMADO_SEM_CREDITO: "Repasse sem crédito bancário", CREDITO_SEM_COMPROVACAO_BANCARIA: "Crédito sem comprovação bancária",
  RECEBIMENTO_DIRETO_NAO_IDENTIFICADO: "Recebimento direto não identificado", TAXA_OU_VALOR_DIVERGENTE: "Taxa ou valor divergente", DESCONTO_SEM_FINANCIADOR: "Desconto sem financiador",
  VENDA_SEM_CANAL: "Venda sem canal", TOTAIS_DE_RELATORIOS_DIFERENTES: "Relatórios com totais diferentes", SOBREPOSICAO_AGREGADO_PEDIDOS: "Agregado × pedidos no mesmo dia",
});
export const FORMAS = Object.freeze({ DINHEIRO: "Dinheiro", PIX: "Pix", DEBITO: "Cartão de débito", CREDITO: "Cartão de crédito", VALE: "Vale", OUTRA: "Não detalhada", DESCONHECIDA: "Desconhecida" });
export const PENDENCIAS_VENDA = Object.freeze({
  PAGAMENTO_PENDENTE: "pagamento pendente", DESCONTO_SEM_FINANCIADOR: "desconto sem financiador", FORMA_NAO_DETALHADA: "forma não detalhada", CREDITO_DIRETO_NAO_IDENTIFICADO: "crédito a identificar",
  EM_DIVERGENCIA: "em divergência", SEM_GRANULARIDADE: "sem pedidos", CANAL_NAO_IDENTIFICADO: "canal não identificado", SEM_DOCUMENTO_DE_ORIGEM: "sem documento de origem",
});
export const CATEGORIAS_BANCARIAS = Object.freeze({
  TARIFA: "Tarifa", SEGURO: "Seguro", EMPRESTIMO: "Empréstimo", PAGAMENTO_BOLETO: "Pagamento de boleto", ARRECADACAO_CONVENIO: "Arrecadação/convênio", CREDITO_ADQUIRENTE: "Crédito de adquirente",
  REPASSE_PLATAFORMA: "Repasse de plataforma", PAGAMENTO_PLATAFORMA: "Pagamento a plataforma", PIX_RECEBIDO: "Pix recebido", PIX_ENVIADO: "Pix enviado", TRANSFERENCIA: "Transferência", OUTRO: "Outro",
});

// ------------------------------------------------------------------------------------- central de conferências (Execução 06C)
const rotulos = (o) => Object.freeze(Object.fromEntries(Object.entries(o).map(([k, [rotulo, classe, explicacao = ""]]) => [k, { rotulo, classe, explicacao }])));
export const ESTADOS_IMPORTACAO = rotulos({
  RECEBIDO: ["Recebido", "info", "Arquivo guardado no cofre."], EM_VALIDACAO: ["Em validação", "info", "O leitor está conferindo o arquivo."],
  PRONTO_PARA_IMPORTAR: ["Pronto para importar", "alerta", "Prévia gerada: falta a revisão e a confirmação."], IMPORTADO: ["Importado", "ok", "Registros gravados sem efeito financeiro."],
  IMPORTADO_COM_PENDENCIAS: ["Importado com pendências", "alerta", "Gravado com divergências aceitas e justificadas."], REJEITADO: ["Rejeitado", "erro", "O arquivo não pôde ser lido como o relatório declarado."],
  SUBSTITUIDO: ["Substituído", "neutro", "Uma versão corrigida passou a valer."],
});
export const ESTADOS_PROPOSTA = rotulos({
  PROPOSTA: ["Para revisar", "info", "Formada a partir do arquivo; ainda sem decisão."], AGUARDANDO_EVIDENCIA: ["Aguardando evidência", "alerta", "Falta documento: não pode ser aprovada assim."],
  AGUARDANDO_REVISAO: ["Revisão com justificativa", "alerta", "Há dúvida: aprovar exige justificativa."], APROVADA: ["Aprovada (não aplicada)", "info", "Aprovada, mas ainda sem efeito financeiro."],
  APLICADA: ["Aplicada", "ok", "O efeito foi registrado uma única vez."], REJEITADA: ["Rejeitada", "neutro", "Descartada com justificativa."], SUBSTITUIDA: ["Substituída", "neutro", "Outra proposta passou a valer."],
});
export const CONFIANCAS = Object.freeze({ ALTA: "Confiança alta", MEDIA: "Confiança média", BAIXA: "Confiança baixa" });
export const SITUACOES_CORRESPONDENCIA = rotulos({
  CANDIDATA: ["Candidata", "info", "Sugestão: ainda não é conciliação."], CONFIRMADA: ["Confirmada", "ok", "Decidida por uma pessoa, com histórico."],
  REJEITADA: ["Rejeitada", "neutro", "Descartada com justificativa."], DIVERGENTE: ["Divergente", "erro", "Diferença registrada com justificativa."],
  AGUARDANDO_DOCUMENTO: ["Aguardando documento", "alerta", "Hipótese plausível sem o documento que a comprove."],
});
export const SITUACOES_PENDENCIA = rotulos({
  ABERTA: ["Aberta", "erro", "Precisa ser resolvida ou documentada."], AGUARDANDO_DOCUMENTO: ["Aguardando documento", "alerta", "Falta o documento indicado."],
  AGUARDANDO_DECISAO: ["Aguardando decisão", "info", "Alguém precisa revisar e decidir."], EXPLICADA_PARCIALMENTE: ["Explicada em parte", "alerta", "Há explicação registrada, sem comprovação completa."],
  INFORMATIVA: ["Informativa", "neutro", "Registrada para contexto; não precisa de ação."],
});
export const ESTADOS_COMPETENCIA = rotulos({
  ABERTA: ["Competência aberta", "info"], FECHAMENTO_PRELIMINAR: ["Fechamento preliminar", "info"],
  FECHAMENTO_COM_PENDENCIAS: ["Fechamento com pendências documentadas", "alerta"], FECHAMENTO_HOMOLOGADO: ["Fechamento gerencial homologado", "ok"],
});
export const SITUACOES_SECAO = rotulos({ CONFERIDO: ["Conferido", "ok"], PENDENTE: ["Exige documentação", "alerta"], BLOQUEIA: ["Bloqueia a homologação", "erro"], EM_ABERTO_NAO_BLOQUEIA: ["Em aberto (não bloqueia)", "info"] });
export const FONTES_NOME = Object.freeze({ SAIPOS: "SAIPOS", STONE: "Stone", IFOOD: "iFood", FOODY: "Foody", UNICRED: "Unicred", ANOTA_AI: "Anota AI", MANUAL: "Registro manual" });
export const PERMISSOES = Object.freeze({
  "financeiro_v2.ver": "ver", "financeiro_v2.importar": "importar arquivos", "financeiro_v2.registrar": "registrar", "financeiro_v2.revisar": "revisar propostas",
  "financeiro_v2.conciliar": "conciliar", "financeiro_v2.fechar": "fechar competência", "financeiro_v2.homologar": "homologar", "financeiro_v2.corrigir": "corrigir em fechamento",
});
