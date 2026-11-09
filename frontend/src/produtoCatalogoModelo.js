// Modelo PURO das seções de catálogo dentro do detalhe do Produto (sem DOM/fetch).
// Só vale para produtos com catálogo controlado (`p.controlado`): o detalhe das Subways não usa nada daqui.
import { simularPreco, COMPONENTES } from "./simulacaoPreco.js";

const BLOQUEIOS = ["sem_componentes", "insumo_sem_custo", "insumo_inativo"];

/** Adapta o produto detalhado ao formato que `seloHomologacao` (fichasModelo) entende. */
export function itemDoProduto(p) {
  const h = p.homologacao_info ?? {};
  return {
    homologacao: h.estado ?? p.homologacao ?? "nao_aplicavel", homologacao_motivo: h.motivo ?? null,
    homologado_por_nome: h.homologado_por_nome ?? null, homologado_em: h.homologado_em ?? null,
    ficha_completa: !BLOQUEIOS.includes(p.status_ficha?.chave),
  };
}

/** A ficha pode ser homologada agora? (completa e ainda pendente) */
export const podeHomologarProduto = (p) => {
  const i = itemDoProduto(p);
  return i.ficha_completa && i.homologacao === "pendente";
};

/**
 * Margem de contribuição por preço cadastrado, com as condições comerciais DA EMPRESA para o canal do preço.
 * Canal sem condições => margem indisponível (`motivo: "canal_sem_condicoes"`), nunca assumida.
 * Condições presentes mas incompletas (taxas/promoções etc.) => calculada, marcada `parcial` com o que ficou de fora.
 * Ficha incompleta => sem custo, sem margem.
 * @param {{precos: Array<{canal: string, tabela?: string|null, preco: number|string}>, custo: number|null, custoDisponivel: boolean,
 *          condicoes: {canais: Array<object>}|null}} a
 */
export function margemPorPreco({ precos, custo, custoDisponivel, condicoes }) {
  return (precos ?? []).filter((x) => Number(x.preco) > 0).map((x) => {
    const preco = Number(x.preco);
    const base = { canal: x.canal, tabela: x.tabela ?? null, preco };
    if (!custoDisponivel || custo == null) return { ...base, cmvPct: null, lucro: null, margemPct: null, parcial: false, naoConsiderados: [], motivo: "ficha_incompleta" };
    const cond = condicoes?.canais?.find((c) => c.canal === x.canal) ?? null;
    const cmvPct = (Number(custo) / preco) * 100;
    if (!cond) return { ...base, cmvPct, lucro: null, margemPct: null, parcial: true, naoConsiderados: ["comissao"], motivo: "canal_sem_condicoes" };
    const r = simularPreco({
      custo: Number(custo), preco, comissao: cond.comissao, taxas: cond.taxas, promocao: cond.promocao, tributos: cond.tributos,
      entrega: cond.entrega_responsavel === "loja" ? cond.entrega_custo : null,
    });
    // Se a loja não é a responsável (ou não informou), entrega não faz parte da conta e não conta como "faltando".
    const faltando = r.naoConsiderados.filter((k) => k !== "entrega" || cond.entrega_responsavel === "loja");
    return { ...base, cmvPct, lucro: r.lucro, margemPct: r.margemPct, parcial: faltando.length > 0, naoConsiderados: faltando, motivo: faltando.length ? "condicoes_incompletas" : null };
  });
}

export const rotuloNaoConsiderado = (k) => (COMPONENTES.find((c) => c.chave === k)?.rotulo ?? k).toLowerCase();

/** Linhas da composição de custo, na ordem de leitura: ingredientes, preparações, embalagens. */
export function linhasFormacao(catalogo) {
  const l = catalogo?.formacao_custo?.lote ?? {};
  return [
    { chave: "ingredientes", rotulo: "Ingredientes", ...(l.ingredientes ?? { itens: 0, total: null }) },
    { chave: "preparacoes", rotulo: "Preparações intermediárias", ...(l.preparacoes ?? { itens: 0, total: null }) },
    { chave: "embalagens", rotulo: "Embalagens", ...(l.embalagens ?? { itens: 0, total: null }) },
  ].filter((x) => x.itens > 0);
}
