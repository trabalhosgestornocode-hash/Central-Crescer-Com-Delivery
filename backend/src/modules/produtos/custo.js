// Domínio de CUSTO do produto — explosão do BOM e recálculo em cascata.
//
// Este módulo é a ponte entre a ficha técnica (banco) e as fórmulas puras
// (insumos.calc.js). Ele NÃO reimplementa fórmula alguma: carrega o grafo da
// organização, percorre a árvore e delega o cálculo aritmético ao calc.
//
// Isolamento: tudo é escopado por organizacaoId. A ficha_tecnica não tem
// organizacao_id próprio (herda via produto_id), então SEMPRE a carregamos
// apenas para os produtos DESTA organização — nunca a ficha global.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { cmvPct, margem, statusFicha } from "../insumos/insumos.calc.js";

const PROF_MAX = 12; // trava contra ciclos na árvore de submontagens/combos

/**
 * Carrega o grafo de custo da organização: insumos, produtos e ficha técnica.
 * Seleciona `*` na ficha de propósito — é resiliente a colunas novas (unidade_uso,
 * quantidade_informada, ordem, ativo) ainda não migradas.
 * @param {string} organizacaoId
 */
export async function carregarGrafo(organizacaoId) {
  const [insumosRes, produtosRes] = await Promise.all([
    supabase.from("insumos")
      .select("id, nome, tipo, unidade_medida, preco_unitario, ativo, categoria_id")
      .eq("organizacao_id", organizacaoId),
    // `*` (e não colunas nomeadas): rendimento/homologacao são da migration 157 — antes dela
    // o select continua funcionando e o rendimento cai no padrão 1 (comportamento legado).
    supabase.from("produtos").select("*").eq("organizacao_id", organizacaoId),
  ]);
  if (insumosRes.error) throw ApiError.internal(insumosRes.error.message);
  if (produtosRes.error) throw ApiError.internal(produtosRes.error.message);

  const produtos = produtosRes.data ?? [];
  const orgProdutoIds = produtos.map((p) => p.id);
  const fichaRes = orgProdutoIds.length
    ? await supabase.from("ficha_tecnica").select("*").in("produto_id", orgProdutoIds)
    : { data: [], error: null };
  if (fichaRes.error) throw ApiError.internal(fichaRes.error.message);

  const insumoById = new Map((insumosRes.data ?? []).map((i) => [i.id, i]));
  const nomeProdById = new Map(produtos.map((p) => [p.id, p.nome]));
  const fichaByProd = new Map();
  for (const f of fichaRes.data ?? []) {
    if (!fichaByProd.has(f.produto_id)) fichaByProd.set(f.produto_id, []);
    fichaByProd.get(f.produto_id).push(f);
  }
  const rendimentoById = new Map(produtos.map((p) => [p.id, p.rendimento]));
  const homologacaoById = new Map(produtos.map((p) => [p.id, p.homologacao]));
  const homologadoCustoById = new Map(produtos.map((p) => [p.id, p.homologado_custo]));
  const homologacaoMotivoById = new Map(produtos.map((p) => [p.id, p.homologacao_motivo]));
  return { insumoById, nomeProdById, fichaByProd, produtos, rendimentoById, homologacaoById, homologadoCustoById, homologacaoMotivoById };
}

/**
 * Rendimento da receita (quantas unidades — ou g/ml, se for preparação por peso — o lote produz).
 * Ausente/inválido => 1 (comportamento legado das Subways). Espelha fn_custo_produto (migration 157).
 * @param {string} produtoId @param {object} grafo @returns {number}
 */
export function rendimentoDe(produtoId, grafo) {
  const r = Number(grafo.rendimentoById?.get(produtoId));
  return Number.isFinite(r) && r > 0 ? r : 1;
}

/** Uma linha da ficha está ativa? (coluna nova — default true se ausente). */
const linhaAtiva = (f) => f.ativo !== false;

/**
 * Custo total de um produto: explode a ficha até o insumo cru e soma
 * quantidade(base) × preço_unitário. Espelha exatamente fn_custo_produto.
 * @param {string} produtoId @param {object} grafo @returns {number}
 */
export function custoTotalProduto(produtoId, grafo, prof = 0) {
  if (prof > PROF_MAX) return 0;
  let total = 0;
  for (const f of grafo.fichaByProd.get(produtoId) ?? []) {
    if (!linhaAtiva(f)) continue;
    const qtd = Number(f.quantidade) || 0;
    if (f.insumo_id) {
      const ins = grafo.insumoById.get(f.insumo_id);
      total += qtd * Number(ins?.preco_unitario ?? 0);
    } else if (f.subproduto_id) {
      // custoTotalProduto(sub) já é o custo POR UNIDADE de rendimento da submontagem.
      total += qtd * custoTotalProduto(f.subproduto_id, grafo, prof + 1);
    }
  }
  // Custo UNITÁRIO: o lote (soma das linhas) dividido pelo que ele rende.
  return total / rendimentoDe(produtoId, grafo);
}

/** Variação relativa do custo, desde a homologação, que a invalida (mudança de preço de insumo, p.ex.). */
export const HOMOLOGACAO_TOLERANCIA_CUSTO = 0.005;

/**
 * Homologação EFETIVA: o estado gravado, a menos que o custo atual tenha se afastado do custo homologado
 * além da tolerância — aí vale 'pendente' com motivo 'custo_alterado' (composição e rendimento já são
 * invalidados no banco por gatilho, migration 158). Produtos sem controle ('nao_aplicavel') nunca mudam.
 * @returns {{estado: string, motivo: string|null}}
 */
export function homologacaoEfetiva(produtoId, grafo) {
  const estado = grafo.homologacaoById?.get(produtoId) ?? "nao_aplicavel";
  const motivo = grafo.homologacaoMotivoById?.get(produtoId) ?? null;
  if (estado !== "homologada") return { estado, motivo: estado === "pendente" ? motivo : null };
  const base = Number(grafo.homologadoCustoById?.get(produtoId));
  if (Number.isFinite(base) && base > 0) {
    const atual = custoTotalProduto(produtoId, grafo);
    if (Math.abs(atual - base) / base > HOMOLOGACAO_TOLERANCIA_CUSTO) return { estado: "pendente", motivo: "custo_alterado" };
  }
  return { estado, motivo: null };
}

/**
 * Custo da MÃO DE OBRA por unidade — indicador À PARTE do CMV de ingredientes/embalagens.
 * Null se faltar o custo por minuto de qualquer função (não inventa valor).
 * @param {Array<{minutos: number|string, custo_minuto: number|string|null}>} linhas
 * @param {number} rendimento
 * @returns {number|null}
 */
export function custoMaoDeObraUnitario(linhas, rendimento = 1) {
  if (!linhas?.length) return 0;
  let total = 0;
  for (const l of linhas) {
    if (l.custo_minuto == null || l.custo_minuto === "") return null;
    total += (Number(l.minutos) || 0) * Number(l.custo_minuto);
  }
  const r = Number(rendimento);
  return total / (Number.isFinite(r) && r > 0 ? r : 1);
}

/** Carrega a mão de obra por produto (tabela da migration 157). Só para as telas novas — nunca no caminho legado. */
export async function carregarMaoDeObra(organizacaoId) {
  const { data, error } = await supabase
    .from("ficha_mao_de_obra").select("produto_id, funcao, minutos, custo_minuto").eq("organizacao_id", organizacaoId);
  if (error) throw ApiError.internal(error.message);
  const porProduto = new Map();
  for (const l of data ?? []) {
    if (!porProduto.has(l.produto_id)) porProduto.set(l.produto_id, []);
    porProduto.get(l.produto_id).push(l);
  }
  return porProduto;
}

/**
 * Componentes DIRETOS (1 nível) de um produto, prontos para a ficha editável.
 * Cada linha traz o custo por unidade-base e o custo aplicado no produto.
 * @param {string} produtoId @param {object} grafo
 */
export function componentesDiretos(produtoId, grafo) {
  const linhas = (grafo.fichaByProd.get(produtoId) ?? [])
    .slice()
    .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0) || String(a.created_at).localeCompare(String(b.created_at)));

  return linhas.map((f) => {
    const ativo = linhaAtiva(f);
    if (f.insumo_id) {
      const ins = grafo.insumoById.get(f.insumo_id) ?? {};
      const custoUnitarioBase = ins.preco_unitario != null ? Number(ins.preco_unitario) : null;
      const unidadeBase = ins.unidade_medida ?? "un";
      // Unidade/qtd "como o usuário digitou" (colunas novas) ou fallback à base.
      const unidadeUso = f.unidade_uso ?? unidadeBase;
      const quantidadeInformada = f.quantidade_informada != null ? Number(f.quantidade_informada) : Number(f.quantidade);
      const custoAplicado = (Number(f.quantidade) || 0) * Number(custoUnitarioBase ?? 0);
      return {
        ficha_id: f.id,
        tipo: "insumo",
        insumo_id: f.insumo_id,
        nome: ins.nome ?? "?",
        categoria: ins.tipo ?? null,
        insumo_ativo: ins.ativo !== false,
        quantidade: quantidadeInformada,
        unidade: unidadeUso,
        quantidade_base: Number(f.quantidade),
        unidade_base: unidadeBase,
        custo_unitario_base: custoUnitarioBase,
        custo_aplicado: custoUnitarioBase == null ? null : custoAplicado,
        observacao: f.observacao ?? null,
        ativo,
      };
    }
    // Submontagem / combo (produto dentro de produto)
    const custoSub = custoTotalProduto(f.subproduto_id, grafo);
    return {
      ficha_id: f.id,
      tipo: "submontagem",
      subproduto_id: f.subproduto_id,
      nome: grafo.nomeProdById.get(f.subproduto_id) ?? "?",
      categoria: null,
      insumo_ativo: true,
      quantidade: Number(f.quantidade),
      unidade: "un",
      quantidade_base: Number(f.quantidade),
      unidade_base: "un",
      custo_unitario_base: custoSub,
      custo_aplicado: Number(f.quantidade) * custoSub,
      observacao: f.observacao ?? null,
      ativo: linhaAtiva(f),
    };
  });
}

/**
 * Ingredientes EXPLODIDOS até o insumo cru (acumula por insumo), no formato
 * que o modal de produto já consome. Mantido para compatibilidade visual.
 * @param {string} produtoId @param {object} grafo
 */
export function ingredientesExplodidos(produtoId, grafo) {
  const acumulado = new Map(); // insumo_id -> qtd base
  const explode = (pid, mult, prof = 0) => {
    if (prof > PROF_MAX) return;
    const rend = rendimentoDe(pid, grafo);
    for (const f of grafo.fichaByProd.get(pid) ?? []) {
      if (!linhaAtiva(f)) continue;
      const q = ((Number(f.quantidade) || 0) * mult) / rend;
      if (f.insumo_id) acumulado.set(f.insumo_id, (acumulado.get(f.insumo_id) ?? 0) + q);
      else if (f.subproduto_id) explode(f.subproduto_id, q, prof + 1);
    }
  };
  explode(produtoId, 1);

  return [...acumulado.entries()]
    .map(([iid, q]) => {
      const ins = grafo.insumoById.get(iid) ?? {};
      const custoUnit = ins.preco_unitario != null ? Number(ins.preco_unitario) : null;
      return {
        nome: ins.nome ?? "?",
        unidade: ins.unidade_medida ?? null,
        quantidade: q,
        custo_unitario: custoUnit,
        custo_total: custoUnit == null ? null : q * custoUnit,
        sem_custo: custoUnit == null || custoUnit <= 0,
      };
    })
    .sort((a, b) => (b.custo_total ?? 0) - (a.custo_total ?? 0));
}

/**
 * Resumo de custo/CMV/margem/status de um produto, a partir do grafo.
 * @param {{produtoId: string, grafo: object, precoVenda?: number|null, custoManual?: number|null}} p
 */
export function resumoProduto({ produtoId, grafo, precoVenda = null, custoManual = null }) {
  const componentes = componentesDiretos(produtoId, grafo);
  const custoCalculado = custoTotalProduto(produtoId, grafo);
  const custo = custoManual != null ? Number(custoManual) : custoCalculado;
  const temPreco = precoVenda != null && Number(precoVenda) > 0;
  const status = statusFicha({
    componentes: componentes.map((c) => ({ custoUnitarioBase: c.custo_unitario_base, insumoAtivo: c.insumo_ativo })),
    temPreco,
  });
  const m = margem(custo, precoVenda);
  // Só apresenta CMV quando a ficha está íntegra — nunca um CMV "falso".
  const cmv = status.chave === "insumo_sem_custo" ? null : cmvPct(custo, precoVenda);

  // CMV HOMOLOGADO: só existe com ficha íntegra E sem homologação pendente. Nunca um número "provisório" disfarçado.
  const { estado: homologacao, motivo: homologacaoMotivo } = homologacaoEfetiva(produtoId, grafo);
  const fichaIntegra = !["sem_componentes", "insumo_sem_custo", "insumo_inativo"].includes(status.chave);
  let cmvHomologado = null;
  let motivoSemCmvHomologado = null;
  if (!fichaIntegra) motivoSemCmvHomologado = "ficha_incompleta";
  else if (homologacao === "pendente") motivoSemCmvHomologado = "pendente_homologacao";
  else if (!temPreco) motivoSemCmvHomologado = "sem_preco";
  else cmvHomologado = cmv;
  return {
    rendimento: rendimentoDe(produtoId, grafo),
    homologacao, homologacao_motivo: homologacaoMotivo,
    cmv_homologado_pct: cmvHomologado,
    motivo_sem_cmv_homologado: motivoSemCmvHomologado,
    componentes,
    qtd_componentes: componentes.length,
    custo,
    custo_calculado: custoCalculado,
    custo_manual: custoManual,
    cmv_pct: cmv,
    margem_reais: m.reais,
    margem_pct: m.pct,
    status_ficha: status,
  };
}

/**
 * Ids dos produtos afetados por um insumo (direta ou indiretamente, via
 * submontagens/combos). Percorre a ficha de baixo para cima até o ponto fixo.
 * @param {string} insumoId @param {object} grafo @returns {string[]}
 */
export function produtosAfetadosPorInsumo(insumoId, grafo) {
  const afetados = new Set();
  // Nível 0: produtos que usam o insumo diretamente (linha ativa).
  for (const [produtoId, linhas] of grafo.fichaByProd) {
    if (linhas.some((f) => linhaAtiva(f) && f.insumo_id === insumoId)) afetados.add(produtoId);
  }
  // Propaga para quem usa esses produtos como submontagem, até estabilizar.
  let cresceu = true;
  while (cresceu) {
    cresceu = false;
    for (const [produtoId, linhas] of grafo.fichaByProd) {
      if (afetados.has(produtoId)) continue;
      if (linhas.some((f) => linhaAtiva(f) && f.subproduto_id && afetados.has(f.subproduto_id))) {
        afetados.add(produtoId);
        cresceu = true;
      }
    }
  }
  return [...afetados];
}

/**
 * Uso DIRETO (1 nível) de um insumo específico dentro de UM produto — a
 * linha exata da ficha, se existir, já com quantidade/unidade/custo aplicado
 * calculados. Diferente de `produtosAfetadosPorInsumo` (que também enxerga
 * uso INDIRETO via submontagem, sem uma quantidade única de sentido nesse
 * caso). Usado pelo Agente Crescer para "quanto desse insumo tem no produto
 * X" — nunca inventa uma quantidade quando o uso é só indireto: devolve null.
 * @param {string} produtoId @param {string} insumoId @param {object} grafo
 * @returns {{quantidade: number, unidade: string, custoAplicado: number}|null}
 */
export function usoDiretoDeInsumo(produtoId, insumoId, grafo) {
  const linha = (grafo.fichaByProd.get(produtoId) ?? []).find((f) => linhaAtiva(f) && f.insumo_id === insumoId);
  if (!linha) return null;
  const ins = grafo.insumoById.get(insumoId);
  const custoUnitarioBase = ins?.preco_unitario != null ? Number(ins.preco_unitario) : null;
  if (custoUnitarioBase == null) return null;
  const quantidade = Number(linha.quantidade) || 0;
  return { quantidade, unidade: ins.unidade_medida ?? "un", custoAplicado: quantidade * custoUnitarioBase };
}

/**
 * O próprio produto + todos que o usam como submontagem/combo (recursivo).
 * Usado para recalcular em cascata quando a ficha de um produto muda.
 * @param {string} produtoId @param {object} grafo @returns {string[]}
 */
export function produtosAfetadosPorProduto(produtoId, grafo) {
  const afetados = new Set([produtoId]);
  let cresceu = true;
  while (cresceu) {
    cresceu = false;
    for (const [pid, linhas] of grafo.fichaByProd) {
      if (afetados.has(pid)) continue;
      if (linhas.some((f) => linhaAtiva(f) && f.subproduto_id && afetados.has(f.subproduto_id))) {
        afetados.add(pid);
        cresceu = true;
      }
    }
  }
  return [...afetados];
}

/**
 * Recalcula e grava produtos.custo_cache para uma lista de produtos.
 * Respeita custo_manual (override) — igual a fn_custo_produto.
 * Best-effort por produto: uma falha isolada não derruba o lote.
 * @param {{organizacaoId: string, produtoIds: string[], grafo?: object}} p
 * @returns {Promise<number>} quantidade de produtos recalculados
 */
export async function recalcularCache({ organizacaoId, produtoIds, grafo }) {
  if (!produtoIds?.length) return 0;
  const g = grafo ?? (await carregarGrafo(organizacaoId));

  // custo_manual dos produtos alvo (override vence o calculado).
  const { data: manuais } = await supabase
    .from("produtos").select("id, custo_manual").eq("organizacao_id", organizacaoId).in("id", produtoIds);
  const manualById = new Map((manuais ?? []).map((p) => [p.id, p.custo_manual]));

  let ok = 0;
  for (const pid of produtoIds) {
    const manual = manualById.get(pid);
    const custo = manual != null ? Number(manual) : custoTotalProduto(pid, g);
    const { error } = await supabase
      .from("produtos").update({ custo_cache: custo }).eq("id", pid).eq("organizacao_id", organizacaoId);
    if (!error) ok += 1;
    else console.warn("[custo] recalc falhou para", pid, error.message);
  }
  return ok;
}
