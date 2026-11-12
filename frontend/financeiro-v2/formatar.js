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
  AGUARDANDO_CLASSIFICACAO_OU_EVIDENCIA: { rotulo: "Aguardando classificação", classe: "alerta", explicacao: "Lançado em categoria provisória: falta classificar." },
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
