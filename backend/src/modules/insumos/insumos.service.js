import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import {
  custoUnitario, variacaoPct, validarCompraInsumo, UNIDADES, unidadeValida,
} from "./insumos.calc.js";
import {
  carregarGrafo, produtosAfetadosPorInsumo, recalcularCache, custoTotalProduto, lerTudo,
} from "../produtos/custo.js";

// "Categoria" do insumo = enum tipo_insumo já existente no banco (não cria
// tabela nova de categorias nesta etapa). Rótulos pt-BR para a tela.
export const CATEGORIAS_INSUMO = [
  "proteina", "queijo", "molho", "vegetal", "pao", "embalagem",
  "bebida", "descartavel", "doce", "chips", "outro",
];
export const CATEGORIA_ROTULO = {
  proteina: "Proteína", queijo: "Queijo", molho: "Molho", vegetal: "Vegetal",
  pao: "Pão", embalagem: "Embalagem", bebida: "Bebida", descartavel: "Descartável",
  doce: "Doce", chips: "Chips", outro: "Outro",
};

const RE_COLUNA_AUSENTE = /does not exist|schema cache|could not find/i;

// Colunas adicionadas pela migration 021. Se ela ainda não rodou, escrevemos
// só as colunas legadas (best-effort, mesmo espírito de produto_historico).
const COLUNAS_NOVAS = ["descricao", "forma_compra", "preco_atualizado_em", "created_by"];

/** Remove as colunas novas de um payload (fallback quando a migration falta). */
function semColunasNovas(obj) {
  const copia = { ...obj };
  for (const c of COLUNAS_NOVAS) delete copia[c];
  return copia;
}

// ---------------------------------------------------------------------------
// Normalização de entrada (fronteira HTTP → forma canônica)
// ---------------------------------------------------------------------------
function normalizarDados(body, { parcial = false } = {}) {
  const dados = {};
  const b = v.corpo(body);

  if (!parcial || b.nome !== undefined) dados.nome = v.texto(b.nome, "Nome", { min: 1, max: 160 });
  if (b.codigo !== undefined) dados.codigo = v.textoOpcional(b.codigo, "Código", { max: 60 });
  if (b.tipo !== undefined) dados.tipo = v.umDe(b.tipo, "Categoria", CATEGORIAS_INSUMO);
  if (b.descricao !== undefined) dados.descricao = v.textoOpcional(b.descricao, "Descrição", { max: 500 });
  if (b.fornecedor_id !== undefined) dados.fornecedor_id = v.uuidOpcional(b.fornecedor_id, "Fornecedor");
  if (b.forma_compra !== undefined) dados.forma_compra = v.textoOpcional(b.forma_compra, "Forma de compra", { max: 60 });
  if (b.ativo !== undefined) dados.ativo = v.booleano(b.ativo, true);

  if (b.unidade_medida !== undefined) dados.unidade_medida = v.umDe(b.unidade_medida, "Unidade-base", UNIDADES);
  if (b.preco_caixa !== undefined) dados.preco_caixa = b.preco_caixa === "" || b.preco_caixa === null ? null : v.numero(b.preco_caixa, "Preço da embalagem", { min: 0 });
  if (b.rendimento !== undefined) dados.rendimento = b.rendimento === "" || b.rendimento === null ? null : v.numero(b.rendimento, "Quantidade contida", { min: 0 });
  if (b.fator_correcao !== undefined) dados.fator_correcao = v.numeroOpcional(b.fator_correcao, "Fator de correção", { min: 0, padrao: 1 });
  if (b.preco_atualizado_em !== undefined) dados.preco_atualizado_em = v.dataOpcional(b.preco_atualizado_em, "Data do preço");

  return { dados, observacao: v.textoOpcional(b.observacao, "Observação", { max: 500 }) };
}

/** Calcula o custo por unidade-base a partir dos campos de compra. */
function calcularCusto({ preco_caixa, rendimento, fator_correcao }) {
  return custoUnitario({ precoCompra: preco_caixa, quantidadeEmbalagem: rendimento, fatorCorrecao: fator_correcao ?? 1 });
}

/** Projeção de um insumo para a API (custo e rótulos já resolvidos). */
function paraApi(i) {
  const custo = i.preco_unitario != null ? Number(i.preco_unitario) : null;
  return {
    id: i.id,
    nome: i.nome,
    codigo: i.codigo ?? null,
    categoria: i.tipo,
    categoria_rotulo: CATEGORIA_ROTULO[i.tipo] ?? i.tipo,
    descricao: i.descricao ?? null,
    fornecedor_id: i.fornecedor_id ?? null,
    forma_compra: i.forma_compra ?? null,
    preco_caixa: i.preco_caixa != null ? Number(i.preco_caixa) : null,
    rendimento: i.rendimento != null ? Number(i.rendimento) : null,
    unidade_base: i.unidade_medida,
    fator_correcao: i.fator_correcao != null ? Number(i.fator_correcao) : 1,
    custo_unitario: custo,
    sem_custo: custo == null || custo <= 0,
    preco_atualizado_em: i.preco_atualizado_em ?? i.updated_at ?? null,
    ativo: i.ativo !== false,
    updated_at: i.updated_at ?? null,
    created_at: i.created_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// LISTAGEM + INDICADORES
// ---------------------------------------------------------------------------
export async function listarInsumos({ organizacaoId, busca, categoria, status, semPreco }) {
  // Paginado (teto de 1.000 linhas por resposta do PostgREST); nome + id = ordem determinística entre páginas.
  const { data, error } = await lerTudo((de, ate) => {
    let q = supabase.from("insumos").select("*").eq("organizacao_id", organizacaoId);
    if (categoria) q = q.eq("tipo", categoria);
    if (status === "ativo") q = q.eq("ativo", true);
    if (status === "inativo") q = q.eq("ativo", false);
    return q.order("nome").order("id").range(de, ate);
  });
  if (error) throw ApiError.internal(error.message);

  let itens = (data ?? []).map(paraApi);

  if (busca) {
    const termo = String(busca).trim().toLowerCase();
    itens = itens.filter((i) =>
      i.nome.toLowerCase().includes(termo) || (i.codigo ?? "").toLowerCase().includes(termo));
  }
  if (semPreco) itens = itens.filter((i) => i.sem_custo);

  // Indicadores calculados sobre a base COMPLETA (independem dos filtros de tela).
  const todos = (data ?? []).map(paraApi);
  const seteDias = Date.now() - 7 * 24 * 3600 * 1000;
  const stats = {
    ativos: todos.filter((i) => i.ativo).length,
    sem_custo: todos.filter((i) => i.ativo && i.sem_custo).length,
    inativos: todos.filter((i) => !i.ativo).length,
    atualizados_recentes: todos.filter((i) => i.preco_atualizado_em && new Date(i.preco_atualizado_em).getTime() >= seteDias).length,
    total: todos.length,
  };

  return { itens, stats };
}

// ---------------------------------------------------------------------------
// DETALHE (insumo + histórico + produtos que usam)
// ---------------------------------------------------------------------------
export async function obterInsumo({ organizacaoId, id }) {
  const insumoId = v.uuid(id, "Insumo");
  const { data: insumo, error } = await supabase
    .from("insumos").select("*").eq("organizacao_id", organizacaoId).eq("id", insumoId).single();
  if (error || !insumo) throw ApiError.notFound("Insumo não encontrado.");

  const [historico, produtos] = await Promise.all([
    listarHistorico({ organizacaoId, insumoId }),
    produtosQueUsam({ organizacaoId, insumoId }),
  ]);

  return { ...paraApi(insumo), historico: historico.itens, historico_pendente: historico.pendente, produtos };
}

/** Produtos (com custo atual) que utilizam o insumo — direta ou indiretamente. */
export async function produtosQueUsam({ organizacaoId, insumoId }) {
  const grafo = await carregarGrafo(organizacaoId);
  const ids = produtosAfetadosPorInsumo(insumoId, grafo);
  return ids
    .map((pid) => ({
      id: pid,
      nome: grafo.nomeProdById.get(pid) ?? "Produto",
      custo_atual: custoTotalProduto(pid, grafo),
    }))
    .sort((a, b) => a.nome.localeCompare(b.nome));
}

// ---------------------------------------------------------------------------
// CRIAÇÃO
// ---------------------------------------------------------------------------
export async function criarInsumo({ organizacaoId, dados: body, usuario }) {
  const { dados } = normalizarDados(body, { parcial: false });

  const erro = validarCompraInsumo({ preco: dados.preco_caixa, quantidadeEmbalagem: dados.rendimento, unidadeBase: dados.unidade_medida });
  if (erro) throw ApiError.badRequest(erro);

  const custo = calcularCusto(dados);
  const linha = {
    organizacao_id: organizacaoId,
    nome: dados.nome,
    codigo: dados.codigo ?? null,
    tipo: dados.tipo ?? "outro",
    descricao: dados.descricao ?? null,
    fornecedor_id: dados.fornecedor_id ?? null,
    forma_compra: dados.forma_compra ?? null,
    unidade_medida: dados.unidade_medida ?? "un",
    preco_caixa: dados.preco_caixa ?? null,
    rendimento: dados.rendimento ?? null,
    fator_correcao: dados.fator_correcao ?? 1,
    preco_unitario: custo ?? 0,
    preco_atualizado_em: custo != null ? (dados.preco_atualizado_em ?? new Date().toISOString()) : null,
    created_by: usuario?.id ?? null,
    ativo: dados.ativo ?? true,
  };

  let res = await supabase.from("insumos").insert(linha).select("*").single();
  if (res.error && RE_COLUNA_AUSENTE.test(res.error.message)) {
    res = await supabase.from("insumos").insert(semColunasNovas(linha)).select("*").single();
  }
  if (res.error) {
    if (/duplicate key|unique/i.test(res.error.message)) throw ApiError.badRequest("Já existe um insumo com este código nesta empresa.");
    throw ApiError.badRequest(res.error.message);
  }
  return paraApi(res.data);
}

// ---------------------------------------------------------------------------
// ATUALIZAÇÃO (com histórico de preço + recálculo em cascata)
// ---------------------------------------------------------------------------
export async function atualizarInsumo({ organizacaoId, id, dados: body, usuario }) {
  const insumoId = v.uuid(id, "Insumo");
  const { dados, observacao } = normalizarDados(body, { parcial: true });

  const { data: antes, error: eAntes } = await supabase
    .from("insumos").select("*").eq("organizacao_id", organizacaoId).eq("id", insumoId).single();
  if (eAntes || !antes) throw ApiError.notFound("Insumo não encontrado.");

  // Estado efetivo após aplicar as mudanças (para revalidar e recalcular custo).
  const efetivo = {
    preco_caixa: dados.preco_caixa !== undefined ? dados.preco_caixa : antes.preco_caixa,
    rendimento: dados.rendimento !== undefined ? dados.rendimento : antes.rendimento,
    fator_correcao: dados.fator_correcao !== undefined ? dados.fator_correcao : antes.fator_correcao,
    unidade_medida: dados.unidade_medida !== undefined ? dados.unidade_medida : antes.unidade_medida,
  };
  const erro = validarCompraInsumo({ preco: efetivo.preco_caixa, quantidadeEmbalagem: efetivo.rendimento, unidadeBase: efetivo.unidade_medida });
  if (erro) throw ApiError.badRequest(erro);

  const custoAntes = antes.preco_unitario != null ? Number(antes.preco_unitario) : null;
  const custoNovo = calcularCusto(efetivo);

  // Detecta mudança que afeta o custo unitário (preço, rendimento, unidade, fator).
  const mudouCusto =
    (dados.preco_caixa !== undefined && Number(dados.preco_caixa ?? NaN) !== Number(antes.preco_caixa ?? NaN)) ||
    (dados.rendimento !== undefined && Number(dados.rendimento ?? NaN) !== Number(antes.rendimento ?? NaN)) ||
    (dados.fator_correcao !== undefined && Number(dados.fator_correcao ?? 1) !== Number(antes.fator_correcao ?? 1)) ||
    (dados.unidade_medida !== undefined && dados.unidade_medida !== antes.unidade_medida) ||
    (custoNovo ?? 0) !== (custoAntes ?? 0);

  const patch = { ...dados };
  patch.preco_unitario = custoNovo ?? 0;
  if (mudouCusto) patch.preco_atualizado_em = dados.preco_atualizado_em ?? new Date().toISOString();

  let res = await supabase.from("insumos").update(patch).eq("id", insumoId).eq("organizacao_id", organizacaoId).select("*").single();
  if (res.error && RE_COLUNA_AUSENTE.test(res.error.message)) {
    res = await supabase.from("insumos").update(semColunasNovas(patch)).eq("id", insumoId).eq("organizacao_id", organizacaoId).select("*").single();
  }
  if (res.error) {
    if (/duplicate key|unique/i.test(res.error.message)) throw ApiError.badRequest("Já existe um insumo com este código nesta empresa.");
    throw ApiError.badRequest(res.error.message);
  }

  // Histórico: registra a mudança de preço/custo (best-effort — não derruba o salvar).
  if (mudouCusto) {
    await registrarHistorico({
      organizacaoId, insumoId, usuario, observacao,
      preco_anterior: antes.preco_caixa, preco_novo: efetivo.preco_caixa,
      custo_anterior: custoAntes, custo_novo: custoNovo,
      variacao_pct: variacaoPct(custoAntes, custoNovo),
      unidade_medida_anterior: antes.unidade_medida, unidade_medida_nova: efetivo.unidade_medida,
    });
  }

  // Recálculo automático dos produtos que usam este insumo.
  let recalculados = 0;
  if (mudouCusto) {
    const grafo = await carregarGrafo(organizacaoId);
    const afetados = produtosAfetadosPorInsumo(insumoId, grafo);
    recalculados = await recalcularCache({ organizacaoId, produtoIds: afetados, grafo });
  }

  return { insumo: paraApi(res.data), recalculados, custo_mudou: mudouCusto };
}

// ---------------------------------------------------------------------------
// INATIVAÇÃO / REATIVAÇÃO (lógica — nunca exclui insumo com vínculos)
// ---------------------------------------------------------------------------
export async function definirAtivo({ organizacaoId, id, ativo, usuario }) {
  const insumoId = v.uuid(id, "Insumo");
  const alvo = v.booleano(ativo, false);

  const { data: antes, error } = await supabase
    .from("insumos").select("id, ativo").eq("organizacao_id", organizacaoId).eq("id", insumoId).single();
  if (error || !antes) throw ApiError.notFound("Insumo não encontrado.");

  // Ao inativar, informa quantos produtos serão afetados (para a mensagem).
  let produtosAfetados = 0;
  if (!alvo) {
    const grafo = await carregarGrafo(organizacaoId);
    produtosAfetados = produtosAfetadosPorInsumo(insumoId, grafo).length;
  }

  const { error: eUpd } = await supabase
    .from("insumos").update({ ativo: alvo }).eq("id", insumoId).eq("organizacao_id", organizacaoId);
  if (eUpd) throw ApiError.badRequest(eUpd.message);

  return { ativo: alvo, produtos_afetados: produtosAfetados };
}

// ---------------------------------------------------------------------------
// HISTÓRICO
// ---------------------------------------------------------------------------
async function registrarHistorico(dados) {
  const linha = {
    organizacao_id: dados.organizacaoId,
    insumo_id: dados.insumoId,
    preco_anterior: dados.preco_anterior ?? null,
    preco_novo: dados.preco_novo ?? null,
    custo_anterior: dados.custo_anterior ?? null,
    custo_novo: dados.custo_novo ?? null,
    variacao_pct: dados.variacao_pct ?? null,
    unidade_medida_anterior: dados.unidade_medida_anterior ?? null,
    unidade_medida_nova: dados.unidade_medida_nova ?? null,
    usuario_id: dados.usuario?.id ?? null,
    usuario_nome: dados.usuario?.nome ?? null,
    usuario_email: dados.usuario?.email ?? null,
    observacao: dados.observacao ?? null,
  };
  try {
    const { error } = await supabase.from("insumo_historico").insert(linha);
    if (error && !RE_COLUNA_AUSENTE.test(error.message)) console.warn("[insumo_historico] não registrado:", error.message);
  } catch (e) {
    console.warn("[insumo_historico] exceção:", e.message);
  }
}

export async function listarHistorico({ organizacaoId, insumoId }) {
  const { data, error } = await supabase
    .from("insumo_historico")
    .select("preco_anterior, preco_novo, custo_anterior, custo_novo, variacao_pct, unidade_medida_anterior, unidade_medida_nova, usuario_nome, usuario_email, observacao, created_at")
    .eq("organizacao_id", organizacaoId)
    .eq("insumo_id", insumoId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    if (RE_COLUNA_AUSENTE.test(error.message)) return { pendente: true, itens: [] };
    throw ApiError.internal(error.message);
  }
  return { pendente: false, itens: data ?? [] };
}

// ---------------------------------------------------------------------------
// EXCLUSÃO DE INSUMO
//
// Exclui de verdade, mas só quando não há vínculo histórico. Três vínculos
// BLOQUEIAM (são `on delete restrict` no banco; aqui viram mensagem clara):
//   * ficha_tecnica          -> o insumo compõe produtos. O caminho é INATIVAR.
//   * movimentacoes_estoque  -> há movimentação registrada.
//   * pedidos_compra_itens   -> há compra registrada.
// O histórico de preço (insumo_historico) e o saldo de estoque saem em cascade.
// ---------------------------------------------------------------------------
export async function excluirInsumo({ organizacaoId, id }) {
  const insumoId = v.uuid(id, "Insumo");

  const { data: insumo } = await supabase
    .from("insumos").select("id, nome").eq("organizacao_id", organizacaoId).eq("id", insumoId).single();
  if (!insumo) throw ApiError.notFound("Insumo não encontrado.");

  // 1) Está em alguma ficha técnica? (bloqueio mais comum)
  const { data: emFicha } = await supabase
    .from("ficha_tecnica").select("produto_id").eq("insumo_id", insumoId);
  if (emFicha?.length) {
    const ids = [...new Set(emFicha.map((f) => f.produto_id))];
    const { data: prods } = await supabase
      .from("produtos").select("nome").eq("organizacao_id", organizacaoId).in("id", ids);
    const nomes = (prods ?? []).map((p) => p.nome).slice(0, 8).join(", ");
    throw new ApiError(409, `"${insumo.nome}" não pode ser excluído: é usado na ficha técnica de ${ids.length} produto(s) — ${nomes}${ids.length > 8 ? "…" : ""}. Remova-o dessas fichas ou inative o insumo.`,
      { bloqueio: "ficha", quantidade: ids.length, produtos: nomes, sugestao: "inativar" });
  }

  // 2) Tem movimentação de estoque ou compra registrada?
  for (const [tabela, rotulo] of [["movimentacoes_estoque", "movimentação de estoque"], ["pedidos_compra_itens", "item de pedido de compra"]]) {
    const { count, error } = await supabase.from(tabela).select("id", { count: "exact", head: true }).eq("insumo_id", insumoId);
    if (error) continue; // tabela ausente no ambiente: não é bloqueio
    if (count > 0) {
      throw new ApiError(409, `"${insumo.nome}" não pode ser excluído: possui ${count} ${rotulo}(ns) registrada(s). Inative o insumo para preservar o histórico.`,
        { bloqueio: tabela, quantidade: count, sugestao: "inativar" });
    }
  }

  const { error } = await supabase.from("insumos").delete().eq("id", insumoId).eq("organizacao_id", organizacaoId);
  if (error) throw ApiError.badRequest(error.message);
  return { excluido: true, nome: insumo.nome };
}
