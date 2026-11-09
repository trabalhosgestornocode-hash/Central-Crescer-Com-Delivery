// Clonagem do catálogo (categorias -> insumos -> produtos -> ficha técnica
// -> preços) de uma organização de ORIGEM para uma organização de DESTINO,
// com IDs NOVOS e nenhum vínculo remanescente com a origem — é a mesma
// lógica usada tanto para criar o Modelo Padrão (scripts/criar-modelo-padrao.js)
// quanto para provisionar uma empresa nova a partir de um modelo
// (plataforma.empresas.service.js#criarEmpresa).
//
// Recebe o CLIENTE Supabase como parâmetro (nunca importa um fixo) porque o
// script standalone usa seu próprio client (service role via env) e o
// backend usa o singleton de config/supabase.js — a lógica de clonagem é
// idêntica nos dois casos, só muda quem está conectado ao banco.
//
// O QUE NÃO É CLONADO (fora do escopo do Modelo Padrão — só catálogo):
//   * fornecedores (insumos ficam com fornecedor_id = null no destino);
//   * canais_venda (comissão por canal é configuração da empresa, não do catálogo);
//   * unidades, usuários, vendas, estoque, integrações, módulos habilitados.
import { randomUUID } from "node:crypto";

/** Insere em lotes — evita um único INSERT gigante se o catálogo for grande. */
async function inserirEmLotes(db, tabela, linhas, tamanhoLote = 500) {
  for (let i = 0; i < linhas.length; i += tamanhoLote) {
    const lote = linhas.slice(i, i + tamanhoLote);
    const { error } = await db.from(tabela).insert(lote);
    if (error) throw new Error(`insert ${tabela} (lote ${i}-${i + lote.length}): ${error.message}`);
  }
}

/**
 * Clona o catálogo de `origemId` para `destinoId`. Lança se qualquer etapa
 * falhar — quem chama decide se isso é fatal (script) ou se deve virar um
 * aviso não-fatal (criação de empresa, que já tem organização/unidade/
 * módulos gravados e não deve ser desfeita por causa disto).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {{origemId: string, destinoId: string}} p
 * @returns {Promise<{categorias: number, insumos: number, produtos: number, fichaTecnica: number, fichaIgnorada: number, precos: number}>}
 */
export async function clonarCatalogo(db, { origemId, destinoId }) {
  // ---- categorias ----
  const { data: categoriasOrigem, error: eCatSel } = await db
    .from("categorias").select("*").eq("organizacao_id", origemId);
  if (eCatSel) throw new Error(`categorias(select): ${eCatSel.message}`);

  const mapaCategorias = new Map(); // id antigo -> id novo
  const categoriasNovas = (categoriasOrigem ?? []).map((c) => {
    const novoId = randomUUID();
    mapaCategorias.set(c.id, novoId);
    return { id: novoId, organizacao_id: destinoId, nome: c.nome, tipo: c.tipo, ordem: c.ordem, ativo: c.ativo };
  });
  await inserirEmLotes(db, "categorias", categoriasNovas);

  // ---- insumos (fornecedor_id fica null — fornecedores não fazem parte do modelo) ----
  const { data: insumosOrigem, error: eInsSel } = await db
    .from("insumos").select("*").eq("organizacao_id", origemId);
  if (eInsSel) throw new Error(`insumos(select): ${eInsSel.message}`);

  const mapaInsumos = new Map();
  const insumosNovos = (insumosOrigem ?? []).map((i) => {
    const novoId = randomUUID();
    mapaInsumos.set(i.id, novoId);
    return {
      id: novoId, organizacao_id: destinoId,
      categoria_id: i.categoria_id ? (mapaCategorias.get(i.categoria_id) ?? null) : null,
      fornecedor_id: null,
      codigo: i.codigo, nome: i.nome, tipo: i.tipo, unidade_medida: i.unidade_medida,
      preco_caixa: i.preco_caixa, rendimento: i.rendimento, fator_correcao: i.fator_correcao,
      preco_unitario: i.preco_unitario, estoque_minimo: i.estoque_minimo, validade_dias: i.validade_dias,
      ativo: i.ativo, descricao: i.descricao, forma_compra: i.forma_compra,
    };
  });
  await inserirEmLotes(db, "insumos", insumosNovos);

  // ---- produtos (inclui sub-montagens: vendavel=false também é "produto") ----
  const { data: produtosOrigem, error: eProdSel } = await db
    .from("produtos").select("*").eq("organizacao_id", origemId);
  if (eProdSel) throw new Error(`produtos(select): ${eProdSel.message}`);

  const mapaProdutos = new Map();
  const produtosNovos = (produtosOrigem ?? []).map((p) => {
    const novoId = randomUUID();
    mapaProdutos.set(p.id, novoId);
    return {
      id: novoId, organizacao_id: destinoId,
      categoria_id: p.categoria_id ? (mapaCategorias.get(p.categoria_id) ?? null) : null,
      tipo: p.tipo, nome: p.nome, sku: p.sku, codigo_pdv: p.codigo_pdv, tamanho: p.tamanho,
      vendavel: p.vendavel, custo_manual: p.custo_manual, imagem_url: p.imagem_url, ativo: p.ativo,
      // Migration 157: só copia quando a coluna existe na origem (antes dela o insert não pode citar a coluna).
      // Homologação NÃO é clonada: o destino parte do padrão ('nao_aplicavel'), nunca herda aprovação alheia.
      ...(p.rendimento !== undefined ? { rendimento: p.rendimento, unidade_rendimento: p.unidade_rendimento ?? null } : {}),
      // custo_cache fica null de propósito — é recalculado ao vivo pela ficha
      // técnica (ver backend/src/modules/produtos/custo.js).
    };
  });
  await inserirEmLotes(db, "produtos", produtosNovos);

  // ---- ficha técnica — remapeia produto_id, insumo_id e subproduto_id.
  //      Como TODOS os produtos já foram clonados acima, referências
  //      produto->produto (subproduto_id) resolvem sem depender de ordem. ----
  const idsProdutosOrigem = (produtosOrigem ?? []).map((p) => p.id);
  let fichaOrigem = [];
  if (idsProdutosOrigem.length) {
    const { data, error } = await db.from("ficha_tecnica").select("*").in("produto_id", idsProdutosOrigem);
    if (error) throw new Error(`ficha_tecnica(select): ${error.message}`);
    fichaOrigem = data ?? [];
  }

  let fichaIgnorada = 0;
  const fichaNova = fichaOrigem.flatMap((f) => {
    const novoProdutoId = mapaProdutos.get(f.produto_id);
    const novoInsumoId = f.insumo_id ? mapaInsumos.get(f.insumo_id) : null;
    const novoSubprodutoId = f.subproduto_id ? mapaProdutos.get(f.subproduto_id) : null;
    // Linha órfã (aponta pra insumo/produto que sumiu do mapa) não é inventada — pulada e contada.
    if (!novoProdutoId || (f.insumo_id && !novoInsumoId) || (f.subproduto_id && !novoSubprodutoId)) {
      fichaIgnorada++;
      return [];
    }
    return [{
      id: randomUUID(), produto_id: novoProdutoId, insumo_id: novoInsumoId, subproduto_id: novoSubprodutoId,
      quantidade: f.quantidade, observacao: f.observacao,
      unidade_uso: f.unidade_uso, quantidade_informada: f.quantidade_informada,
      ordem: f.ordem, ativo: f.ativo,
    }];
  });
  await inserirEmLotes(db, "ficha_tecnica", fichaNova);

  // ---- preços por canal/tabela ----
  let precosOrigem = [];
  if (idsProdutosOrigem.length) {
    const { data, error } = await db.from("produto_precos").select("*").in("produto_id", idsProdutosOrigem);
    if (error) throw new Error(`produto_precos(select): ${error.message}`);
    precosOrigem = data ?? [];
  }
  const precosNovos = precosOrigem.flatMap((pr) => {
    const novoProdutoId = mapaProdutos.get(pr.produto_id);
    if (!novoProdutoId) return [];
    return [{
      id: randomUUID(), produto_id: novoProdutoId, canal: pr.canal, tabela: pr.tabela,
      preco: pr.preco, desatualizado: pr.desatualizado,
    }];
  });
  await inserirEmLotes(db, "produto_precos", precosNovos);

  return {
    categorias: categoriasNovas.length, insumos: insumosNovos.length, produtos: produtosNovos.length,
    fichaTecnica: fichaNova.length, fichaIgnorada, precos: precosNovos.length,
  };
}
