// MOVA CORE — auxiliares de LEITURA compartilhados pelo catálogo e pela análise (módulo próprio: sem import circular).
import { combina } from "./resolucao.js";

// F3: o casamento termo × cadastro é a camada de resolução (flexão, acento, digitação, abreviação, sufixo societário)
export const bate = (termo, ...textos) => combina(termo, ...textos);

/** Lê TODAS as páginas de uma consulta paginada (teto de páginas: nunca uma varredura sem fim). */
export async function todasAsPaginas(porta, op, escopo, entrada, { tamanho = 100, maxPaginas = 20 } = {}) {
  const itens = [];
  let primeira = null;
  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const r = await porta.ler(op, escopo, { ...entrada, pagina, tamanho });
    primeira ??= r;
    itens.push(...(r?.itens ?? []));
    if (!r?.paginacao || pagina >= r.paginacao.paginas) return { ...primeira, itens, truncado: false };
  }
  return { ...primeira, itens, truncado: true };
}

export const itemAPagar = (t) => ({
  id: t.id, fornecedor: t.fornecedor?.nome ?? null, descricao: t.descricao ?? null, categoria: t.categoria?.nome ?? t.categoria?.codigo ?? null,
  competencia: t.competencia ?? null, vencimento: t.vencimento ?? null, situacao: t.situacao, vencido: Boolean(t.vencido),
  valorCentavos: t.valorOriginalCentavos ?? t.valorCentavos ?? null, pagoCentavos: t.pagoCentavos ?? null, saldoCentavos: t.saldoCentavos ?? null,
});
