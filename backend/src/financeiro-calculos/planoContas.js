// O plano de contas é DADO (por organização), não código. Cada categoria carrega um `papel`
// que determina sua participação nos cálculos. O motor só conhece papéis, nunca nomes de categoria.

export const PAPEL = Object.freeze({
  RECEITA_OPERACIONAL: "receita_operacional",
  CUSTO_VARIAVEL: "custo_variavel",
  DESPESA_VARIAVEL: "despesa_variavel",
  TRIBUTO: "tributo",
  DESPESA_FIXA: "despesa_fixa",
  DESPESA_PESSOAL: "despesa_pessoal",
  DESPESA_FINANCEIRA: "despesa_financeira",
  FINANCIAMENTO: "financiamento",
  TRANSFERENCIA: "transferencia",
  SALDO_ANTERIOR: "saldo_anterior",
});

export const PAPEIS = Object.freeze(Object.values(PAPEL));

export const SENTIDO = Object.freeze({ ENTRADA: "entrada", SAIDA: "saida" });

export const STATUS = Object.freeze({ REALIZADO: "realizado", PREVISTO: "previsto", CANCELADO: "cancelado" });

/**
 * Mapa genérico TIPO/NATUREZA (vocabulário do modelo de planilha) → papel.
 * É a ÚNICA ponte com o vocabulário legado e vive no importador; não depende de nome de empresa
 * nem de categoria. Combinação desconhecida → null (fica classificação pendente, nunca chute).
 */
const NORM = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toUpperCase();

export function papelDeTipoNatureza(tipo, natureza) {
  const t = NORM(tipo);
  const n = NORM(natureza);
  if (t === "SALDO ANTERIOR") return PAPEL.SALDO_ANTERIOR;
  if (t === "TRANSFERENCIA") return PAPEL.TRANSFERENCIA;
  if (t === "FINANCIAMENTOS" || t === "FINANCIAMENTO") return PAPEL.FINANCIAMENTO;
  if (t === "TRIBUTACAO" || t === "TRIBUTO") return PAPEL.TRIBUTO;
  if (t === "RECEITA") return PAPEL.RECEITA_OPERACIONAL;
  if (t === "CUSTO" && n === "VARIAVEL") return PAPEL.CUSTO_VARIAVEL;
  if (t === "DESPESA") {
    if (n === "VARIAVEL") return PAPEL.DESPESA_VARIAVEL;
    if (n === "FIXA") return PAPEL.DESPESA_FIXA;
    if (n === "PESSOAL") return PAPEL.DESPESA_PESSOAL;
    if (n === "FINANCEIRAS" || n === "FINANCEIRA") return PAPEL.DESPESA_FINANCEIRA;
  }
  return null;
}

/** Valida invariantes de uma categoria do plano. Retorna lista de erros (vazia = ok). */
export function validarCategoria(cat) {
  const erros = [];
  if (!cat || typeof cat !== "object") return ["categoria ausente"];
  if (!cat.id) erros.push("id obrigatório");
  if (!cat.nome || !String(cat.nome).trim()) erros.push("nome obrigatório");
  if (!PAPEIS.includes(cat.papel)) erros.push(`papel inválido: ${cat.papel}`);
  return erros;
}
