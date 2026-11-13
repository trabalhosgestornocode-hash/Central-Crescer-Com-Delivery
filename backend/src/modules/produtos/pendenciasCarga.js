// Pendências da CARGA (importação de planilha) que impedem homologar — núcleo PURO (sem banco).
//
// Por que existe: quando a planilha tem uma linha sem quantidade ou um nome que não casa com o cadastro, o
// importador NÃO grava a linha. A ficha que sobra tem custo em todos os itens restantes, então o status
// dinâmico (`status_ficha`) diz "completa" — e o custo, menor que o real, poderia ser homologado (inclusive em
// lote). Estas pendências descrevem a ORIGEM e não se resolvem sozinhas: valem até alguém da empresa
// conferir a ficha e marcá-las como conferidas (registrado com quem/quando).
//
// Pendências DINÂMICAS (insumo sem custo, sem componentes, insumo inativo) continuam avaliadas pelo
// status da ficha; aqui só entra o que o banco não consegue reavaliar sozinho.

export const CODIGOS_CARGA_BLOQUEANTES = Object.freeze(new Set([
  "linha_sem_quantidade", "componente_nao_encontrado", "linha_com_erro_na_planilha",
  "custo_planilha_invalido", "sem_rendimento", "layout_inesperado", "ciclo_na_receita",
]));

/** Pendências da carga ainda abertas (bloqueantes e não conferidas). */
export function pendenciasCargaAbertas(pendencias) {
  return (Array.isArray(pendencias) ? pendencias : []).filter((p) => CODIGOS_CARGA_BLOQUEANTES.has(p?.codigo) && !p?.conferida_em);
}

/**
 * Bloqueios de carga do produto: os PRÓPRIOS e os herdados das preparações que ele usa (em qualquer nível).
 * @param {string} produtoId
 * @param {{fichaByProd: Map<string, Array<object>>, nomeProdById?: Map<string, string>}} grafo
 * @param {Map<string, Array<object>>} pendenciasPorProduto produto_id -> pendências gravadas na origem da carga
 * @returns {{proprias: Array<object>, preparacoes: Array<{id: string, nome: string|null}>, bloqueado: boolean}}
 */
export function bloqueiosDaCarga(produtoId, grafo, pendenciasPorProduto) {
  const proprias = pendenciasCargaAbertas(pendenciasPorProduto?.get(produtoId));
  const preparacoes = [];
  const vistos = new Set([produtoId]);
  const pilha = [...subprodutos(produtoId, grafo)];
  while (pilha.length) {
    const id = pilha.pop();
    if (vistos.has(id)) continue;
    vistos.add(id);
    if (pendenciasCargaAbertas(pendenciasPorProduto?.get(id)).length) preparacoes.push({ id, nome: grafo.nomeProdById?.get(id) ?? null });
    pilha.push(...subprodutos(id, grafo));
  }
  return { proprias, preparacoes, bloqueado: proprias.length > 0 || preparacoes.length > 0 };
}

function subprodutos(id, grafo) {
  return (grafo.fichaByProd?.get(id) ?? []).filter((f) => f.subproduto_id && f.ativo !== false).map((f) => f.subproduto_id);
}

/**
 * Marca as pendências de carga abertas como conferidas (devolve NOVO array; não muta a entrada).
 * Pendências que não são de carga, ou já conferidas, ficam como estão.
 */
export function conferirPendenciasCarga(pendencias, { quando, quem }) {
  return (Array.isArray(pendencias) ? pendencias : []).map((p) =>
    CODIGOS_CARGA_BLOQUEANTES.has(p?.codigo) && !p?.conferida_em ? { ...p, conferida_em: quando, conferida_por: quem ?? null } : p);
}
