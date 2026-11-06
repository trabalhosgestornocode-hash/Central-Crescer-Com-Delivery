// Regras PADRÃO do DRE gerencial de referência, derivadas do plano de contas (papel + nome da categoria).
// São uma PROPOSTA versionada (aprovada:false) que reproduz a metodologia gerencial descrita pela contadora:
//   • CMV (insumos, descartáveis) e entregas por COMPETÊNCIA (valor original da conta a pagar);
//   • deduções (Simples, tarifas de venda, antecipação), despesas variáveis e fixas por CAIXA (pagamento no mês);
//   • empréstimos, parcelamentos, transferências e receitas do extrato FORA (a receita vem das vendas registradas).
// Cada categoria recebe a sua própria linha → a tela mostra, categoria a categoria, qual regra foi aplicada.
import { PAPEL } from "./planoContas.js";

export const VERSAO_REGRAS_PADRAO = "padrao-2026-11-proposta";
export const GRUPOS = Object.freeze({
  receita: "Faturamento bruto", deducoes: "Deduções", cmv: "CMV", entregas: "Entregas",
  variaveis: "Despesas variáveis", fixas: "Despesas fixas", fora: "Fora do resultado",
});

const sa = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();

/** Grupo e critério propostos para uma categoria do plano. */
export function classificarCategoria(cat) {
  const n = sa(cat.nome), p = cat.papel;
  if ([PAPEL.FINANCIAMENTO, PAPEL.TRANSFERENCIA, PAPEL.SALDO_ANTERIOR, PAPEL.RECEITA_OPERACIONAL].includes(p) || /PARCELAMENTO/.test(n))
    return { grupo: "fora", criterio: "fora", motivo: p === PAPEL.RECEITA_OPERACIONAL ? "receita vem das vendas registradas, não do extrato" : "fora do resultado gerencial" };
  if (p === PAPEL.TRIBUTO) return { grupo: "deducoes", criterio: "caixa", motivo: "tributo sobre vendas pago no mês" };
  if (/TARIFA VENDA|TAXA.*(ANTECIPA|IFOOD)/.test(n)) return { grupo: "deducoes", criterio: "caixa", motivo: "taxa/tarifa sobre vendas" };
  if (/FRETE|ENTREGA|MOTOBOY/.test(n)) return { grupo: "entregas", criterio: "competencia", motivo: "entregas por competência da produção" };
  if (p === PAPEL.CUSTO_VARIAVEL) return { grupo: "cmv", criterio: "competencia", motivo: "CMV por competência de consumo" };
  if (/DIARIA|OUTRAS DESPESAS|NAO PROGRAMAD|A IDENTIFICAR/.test(n)) return { grupo: "variaveis", criterio: "caixa", motivo: "despesa variável pelo pagamento" };
  if ([PAPEL.DESPESA_FIXA, PAPEL.DESPESA_PESSOAL, PAPEL.DESPESA_FINANCEIRA, PAPEL.DESPESA_VARIAVEL].includes(p)) return { grupo: "fixas", criterio: "caixa", motivo: "despesa fixa pelo pagamento" };
  return null;   // sem regra → resultado PARCIAL
}

/** Monta o objeto `regras` de montarDreReferencia a partir do plano de contas. */
export function regrasPadrao(planoContas) {
  const linhas = [{ codigo: "R01", descricao: "Faturamento bruto (vendas registradas)", grupo: "receita" }];
  const porCategoria = {}, grupos = { receita: ["R01"], deducoes: [], cmv: [], entregas: [], variaveis: [], fixas: [] }, semRegra = [];
  for (const c of [...planoContas].sort((a, b) => String(a.nome).localeCompare(String(b.nome)))) {
    const r = classificarCategoria(c);
    if (!r) { semRegra.push(c.nome); continue; }
    if (r.criterio === "fora") { porCategoria[c.nome] = { linha: null, criterio: "fora", grupo: "fora", motivo: r.motivo }; continue; }
    const codigo = `CAT:${c.nome}`;
    linhas.push({ codigo, descricao: c.nome, grupo: r.grupo });
    grupos[r.grupo].push(codigo);
    porCategoria[c.nome] = { linha: codigo, criterio: r.criterio, grupo: r.grupo, motivo: r.motivo };
  }
  return { versao: VERSAO_REGRAS_PADRAO, aprovada: false, linhas, porCategoria, grupos, fontes: { R01: "vendasBruto" }, semRegra };
}
