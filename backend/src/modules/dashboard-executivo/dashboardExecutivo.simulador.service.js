// Adaptador do endpoint legado GET /dashboard-executivo/simulador-preco.
// Período, preços e proteção da precificação são calculados uma vez em
// obterMes (dashboardExecutivo.service.js) e só reformatados aqui — sem
// duplicar cálculo. NÃO devolve meta/limite logístico: a proteção da
// precificação é um conceito só da simulação Balcão × iFood.
import { obterMes } from "./dashboardExecutivo.service.js";
import * as v from "../../shared/validar.js";
export const NOTA_MARGEM_IFOOD = "Margem estimada após o custo da ficha técnica, as Taxas e Comissões e os Serviços e Promoções do iFood — não é lucro líquido: ainda existem outros custos operacionais da loja (taxas de entregadores, ajustes contra a loja, aluguel, folha etc.) que não entram nesta conta.";
export const NOTA_MARGEM_BALCAO = "Margem estimada antes de demais despesas operacionais da loja.";

export async function simularPrecoProduto(p) {
  const canal = v.umDe(p.canal, "Canal", ["balcao", "ifood"]);
  const dados = await obterMes({ ...p,
    tabelaBalcao: p.tabelaBalcao ?? (canal === "balcao" ? p.tabela : undefined),
    tabelaIfood: p.tabelaIfood ?? (canal === "ifood" ? p.tabela : undefined),
  });
  if (dados.agregado) return { indisponivel: "Selecione uma unidade específica." };
  const pr = dados.protecaoPrecificacao;
  const lado = pr.comparacao[canal];
  return {
    ...lado,
    produto: pr.precos.produto,
    periodo: dados.periodo,
    protecaoPrecificacao: {
      tabelas: pr.precos.tabelas,
      diferencaPrecoReais: pr.diferencaPrecoReais,
      protecaoPrecificacaoPct: pr.protecaoPrecificacaoPct,
      ticketMedioIfood: pr.ticketMedioIfood,
      ticketMedioEquivalenteBalcao: pr.ticketMedioEquivalenteBalcao,
      protecaoFinanceiraReais: pr.protecaoFinanceiraReais,
      ticketMedioBase: pr.ticketMedioBase,
    },
    margemNota: canal === "balcao" ? NOTA_MARGEM_BALCAO : NOTA_MARGEM_IFOOD,
  };
}
