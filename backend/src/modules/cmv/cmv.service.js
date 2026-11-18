import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { resolverTabelaComercialUnidade, normalizarCanalTabela, empresaExigeTabelaComercial } from "../../shared/tabelaComercial.js";

// Margem/CMV por produto x canal x tabela (view vw_produto_margem).
//
// CONTRATO MANTIDO DE PROPÓSITO: `tabela` ausente/undefined continua
// devolvendo TODAS as tabelas do canal (nunca decide sozinha uma "tabela
// oficial") — outros consumidores (ex. `porProduto`/`margemProduto` abaixo,
// e comparações explícitas) dependem desse comportamento. Quem precisa da
// regra "sem tabela oficial => erro, nunca a primeira encontrada" usa
// `listarMargensOficialOuComparacao` abaixo, não esta função diretamente.
export async function listarMargens({ organizacaoId, canal, tabela }) {
  let q = supabase
    .from("vw_produto_margem")
    .select("produto_id, nome, tamanho, canal, tabela, preco, custo, comissao_pct, lucro_liquido, cmv_pct, desatualizado")
    .eq("organizacao_id", organizacaoId)
    .order("nome");
  if (canal) q = q.eq("canal", canal);
  if (tabela) q = q.eq("tabela", tabela);
  const { data, error } = await q;
  if (error) throw ApiError.internal(error.message);
  return data;
}

/**
 * Ponto de entrada do Dashboard comum e de Produtos/CMV — NUNCA usado para
 * "ver todas as tabelas" (isso continua sendo `listarMargens({tabela: undefined})`
 * direto, uma operação explícita e separada, ver comentário acima).
 *
 * Três casos, sem meio-termo (ver decisão registrada no pedido original):
 *   1. `tabelaComparacao` informada -> MODO COMPARAÇÃO: usa a tabela pedida
 *      tal como veio, tabelaOficial só some junto pra a tela poder rotular.
 *   2. Sem `tabelaComparacao` e a unidade TEM tabela oficial pro canal -> usa
 *      a oficial, sempre.
 *   3. Sem `tabelaComparacao` e a unidade NÃO tem tabela oficial (ou nenhuma
 *      unidade está selecionada) -> erro controlado (`codigo` no ApiError),
 *      nunca cai pra "primeira tabela"/"todas as tabelas" silenciosamente.
 *
 * @param {{organizacaoId: string, unidadeId: string|null, canal?: string, tabelaComparacao?: string|null}} p
 * @param {{resolverTabela: typeof resolverTabelaComercialUnidade, listarMargens: typeof listarMargens}} [deps] injeção para teste.
 */
export async function listarMargensOficialOuComparacao(
  { organizacaoId, unidadeId, canal, tabelaComparacao },
  deps = { resolverTabela: resolverTabelaComercialUnidade, listarMargens, exigeTabela: empresaExigeTabelaComercial },
) {
  const canalResolvido = normalizarCanalTabela(canal);
  const { tabelaOficial } = await deps.resolverTabela({ unidadeId, canal: canalResolvido });

  if (tabelaComparacao) {
    const data = await deps.listarMargens({ organizacaoId, canal: canalResolvido, tabela: tabelaComparacao });
    return { data, canal: canalResolvido, tabela: tabelaComparacao, tabelaOficial, comparando: true };
  }

  if (!tabelaOficial && unidadeId && deps.exigeTabela && !(await deps.exigeTabela({ organizacaoId }))) {
    // Empresa própria (sem modelo inicial Subway): não usa tabela comercial — sem erro nem aviso. O preço é um só por
    // canal (Balcão, iFood), guardado sem tabela; devolve o que houver no canal.
    const data = await deps.listarMargens({ organizacaoId, canal: canalResolvido });
    return { data, canal: canalResolvido, tabela: null, tabelaOficial: null, comparando: false, exigeTabela: false };
  }

  if (!tabelaOficial) {
    const semUnidade = !unidadeId;
    const erro = ApiError.badRequest(
      semUnidade
        ? "Selecione uma unidade para ver o Dashboard/Produtos-CMV — a tabela comercial é configurada por unidade."
        : `Tabela comercial (${canalResolvido === "ifood" ? "iFood" : "balcão"}) não configurada para esta unidade. Configure em Configurações → Tabelas Comerciais.`,
    );
    erro.codigo = semUnidade ? "UNIDADE_NAO_SELECIONADA" : "TABELA_NAO_CONFIGURADA";
    throw erro;
  }

  const data = await deps.listarMargens({ organizacaoId, canal: canalResolvido, tabela: tabelaOficial });
  return { data, canal: canalResolvido, tabela: tabelaOficial, tabelaOficial, comparando: false };
}

// CMV de 1 produto (todas as combinações canal/tabela)
export async function margemProduto({ organizacaoId, produtoId }) {
  const { data, error } = await supabase
    .from("vw_produto_margem")
    .select("*")
    .eq("organizacao_id", organizacaoId)
    .eq("produto_id", produtoId);
  if (error) throw ApiError.internal(error.message);
  return data;
}
