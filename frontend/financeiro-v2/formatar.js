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
