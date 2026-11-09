import { randomUUID } from "node:crypto";
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import {
  carregarGrafo, componentesDiretos, custoTotalProduto, ingredientesExplodidos,
  produtosAfetadosPorInsumo, produtosAfetadosPorProduto, recalcularCache, resumoProduto, homologacaoEfetiva,
  carregarMaoDeObra, custoMaoDeObraUnitario, rendimentoDe,
} from "./custo.js";
import {
  converterQuantidade, statusFicha, validarComponenteFicha, UNIDADES,
} from "../insumos/insumos.calc.js";

export async function listarProdutos({ organizacaoId, vendavel, tipo }) {
  let q = supabase
    .from("produtos")
    .select("id, nome, tipo, tamanho, vendavel, custo_cache, sku, codigo_pdv")
    .eq("organizacao_id", organizacaoId)
    .order("nome");
  if (vendavel !== undefined) q = q.eq("vendavel", vendavel);
  if (tipo) q = q.eq("tipo", tipo);
  const { data, error } = await q;
  if (error) throw ApiError.internal(error.message);
  return data;
}

// Produto + ficha técnica editável + ingredientes explodidos + preços + CMV/margem.
// Usa o grafo de custo compartilhado (custo.js) — mesma fonte do recálculo, sem
// duplicar fórmula. Isolamento por organização é garantido pelo grafo.
export async function obterProduto({ organizacaoId, id }) {
  const produtoId = v.uuid(id, "Produto");
  const { data: produto, error } = await supabase
    .from("produtos").select("*").eq("organizacao_id", organizacaoId).eq("id", produtoId).single();
  if (error || !produto) throw ApiError.notFound("Produto não encontrado");

  const [grafo, precosRes] = await Promise.all([
    carregarGrafo(organizacaoId),
    supabase.from("produto_precos").select("canal, tabela, preco, desatualizado").eq("produto_id", produtoId).order("canal"),
  ]);
  if (precosRes.error) throw ApiError.internal(precosRes.error.message);
  const precos = precosRes.data ?? [];

  const ficha = componentesDiretos(produtoId, grafo);            // 1 nível, editável
  const ingredientes = ingredientesExplodidos(produtoId, grafo); // até o insumo cru (compat modal)
  const custoCalculado = custoTotalProduto(produtoId, grafo);
  const custoManual = produto.custo_manual != null ? Number(produto.custo_manual) : null;
  const custo = custoManual != null ? custoManual : custoCalculado;

  const temPreco = precos.some((p) => Number(p.preco) > 0);
  const status = statusFicha({
    componentes: ficha.map((c) => ({ custoUnitarioBase: c.custo_unitario_base, insumoAtivo: c.insumo_ativo })),
    temPreco,
  });

  // Componentes no formato legado (mantém o modal atual funcionando).
  const componentes = ficha.map((c) => ({
    tipo: c.tipo, nome: c.nome, quantidade: c.quantidade, unidade: c.tipo === "insumo" ? c.unidade : null,
  }));

  return {
    ...produto,
    custo, custo_calculado: custoCalculado, custo_manual: custoManual,
    ingredientes, componentes, ficha, precos,
    qtd_componentes: ficha.length,
    status_ficha: status,
    rendimento: rendimentoDe(produtoId, grafo),
    homologacao_info: await infoHomologacao(produto, grafo),
    unidades: UNIDADES,
  };
}

/** Estado efetivo da homologação + quem homologou (nome) — para a ficha do produto. */
async function infoHomologacao(produto, grafo) {
  const ef = homologacaoEfetiva(produto.id, grafo);
  return { estado: ef.estado, motivo: ef.motivo, homologado_em: ef.estado === "homologada" ? produto.homologado_em ?? null : null, homologado_por_nome: ef.estado === "homologada" ? produto.homologado_por_nome ?? null : null, custo_homologado: ef.estado === "homologada" ? produto.homologado_custo ?? null : null };
}

// Atualiza campos do produto e/ou preços (upsert por canal/tabela).
// `usuario` = { id, nome, email } (vem do JWT via requireAuth) — usado na auditoria.
export async function atualizarProduto({ organizacaoId, id, dados, usuario }) {
  // Carrega o estado ATUAL (para diff da auditoria e checagem de existência).
  const { data: antes } = await supabase
    .from("produtos")
    .select("id, nome, tipo, tamanho, ativo")
    .eq("organizacao_id", organizacaoId)
    .eq("id", id)
    .single();
  if (!antes) throw ApiError.notFound("Produto não encontrado");

  const ROTULO_CAMPO = { nome: "Nome", tipo: "Categoria", tamanho: "Tamanho", ativo: "Status" };
  const mudancas = [];

  // 1) Campos básicos do produto
  const campos = {};
  for (const k of ["nome", "tipo", "tamanho", "ativo"]) if (dados[k] !== undefined) campos[k] = dados[k];
  if (campos.nome !== undefined && !String(campos.nome).trim()) throw ApiError.badRequest("Nome não pode ser vazio.");
  if (Object.keys(campos).length) {
    const { error } = await supabase.from("produtos").update(campos).eq("id", id).eq("organizacao_id", organizacaoId);
    if (error) throw ApiError.badRequest(error.message);
    // Diff dos campos básicos
    for (const k of Object.keys(campos)) {
      const de = antes[k];
      const para = campos[k];
      const igual = k === "ativo" ? !!de === !!para : String(de ?? "") === String(para ?? "");
      if (!igual) {
        mudancas.push({
          campo: k,
          rotulo: ROTULO_CAMPO[k] ?? k,
          valor_anterior: de === null || de === undefined ? null : String(de),
          valor_novo: para === null || para === undefined ? null : String(para),
        });
      }
    }
  }

  // 2) Preços (upsert por produto/canal/tabela)
  if (Array.isArray(dados.precos)) {
    const rows = dados.precos
      .filter((p) => p.canal && p.preco !== "" && Number(p.preco) >= 0)
      .map((p) => ({ produto_id: id, canal: p.canal, tabela: p.tabela ?? null, preco: Number(p.preco), desatualizado: !!p.desatualizado }));
    if (rows.length) {
      // Preços atuais (antes do upsert) para o diff da auditoria
      const { data: precosAntes } = await supabase
        .from("produto_precos").select("canal, tabela, preco").eq("produto_id", id);
      const antesMap = new Map((precosAntes ?? []).map((p) => [`${p.canal}|${p.tabela ?? ""}`, Number(p.preco)]));

      const { error } = await supabase.from("produto_precos").upsert(rows, { onConflict: "produto_id,canal,tabela" });
      if (error) throw ApiError.badRequest(error.message);

      for (const r of rows) {
        const de = antesMap.get(`${r.canal}|${r.tabela ?? ""}`);
        const para = Number(r.preco);
        if (de === undefined || Number(de) !== para) {
          const canalTxt = r.canal.charAt(0).toUpperCase() + r.canal.slice(1);
          mudancas.push({
            campo: "preco",
            rotulo: `Preço · ${canalTxt}${r.tabela ? ` (${r.tabela})` : ""}`,
            valor_anterior: de === undefined ? null : String(de),
            valor_novo: String(para),
          });
        }
      }
    }
  }

  // 3) Custo manual (override do custo calculado). '' ou null volta ao automático.
  //    Best-effort: se a coluna custo_manual não existir (migration 004 não rodada),
  //    ignora sem quebrar o restante do salvar.
  if (dados.custo !== undefined) {
    let custoManual = null;
    if (dados.custo !== "" && dados.custo !== null) {
      const n = Number(dados.custo);
      if (Number.isNaN(n) || n < 0) throw ApiError.badRequest("Custo inválido.");
      custoManual = n;
    }
    const { data: cAntes, error: eRead } = await supabase
      .from("produtos").select("custo_manual").eq("id", id).eq("organizacao_id", organizacaoId).single();
    const colunaAusente = eRead && /custo_manual|does not exist|schema cache|could not find/i.test(eRead.message);
    if (!colunaAusente) {
      const antesCusto = cAntes?.custo_manual != null ? Number(cAntes.custo_manual) : null;
      const { error } = await supabase.from("produtos").update({ custo_manual: custoManual })
        .eq("id", id).eq("organizacao_id", organizacaoId);
      if (error) throw ApiError.badRequest(error.message);
      if (antesCusto !== custoManual) {
        mudancas.push({
          campo: "custo", rotulo: "Custo",
          valor_anterior: antesCusto == null ? null : String(antesCusto),
          valor_novo: custoManual == null ? null : String(custoManual),
        });
      }
    }
  }

  // 3b) Rendimento da receita (migration 157). Só muda quando enviado; altera o custo UNITÁRIO,
  //     então o cache do produto e de quem o usa como submontagem é recalculado em cascata.
  if (dados.rendimento !== undefined || dados.unidade_rendimento !== undefined) {
    const patch = {};
    if (dados.rendimento !== undefined) {
      const n = Number(dados.rendimento);
      if (!Number.isFinite(n) || n <= 0) throw ApiError.badRequest("O rendimento deve ser maior que zero.");
      patch.rendimento = n;
    }
    if (dados.unidade_rendimento !== undefined) {
      if (dados.unidade_rendimento !== null && dados.unidade_rendimento !== "" && !UNIDADES.includes(dados.unidade_rendimento)) throw ApiError.badRequest("Unidade do rendimento inválida.");
      patch.unidade_rendimento = dados.unidade_rendimento || null;
    }
    const { data: rAntes, error: eR } = await supabase
      .from("produtos").select("rendimento, unidade_rendimento").eq("id", id).eq("organizacao_id", organizacaoId).single();
    if (eR) throw ApiError.badRequest("Rendimento indisponível neste ambiente (migration 157 não aplicada).");
    const { error } = await supabase.from("produtos").update(patch).eq("id", id).eq("organizacao_id", organizacaoId);
    if (error) throw ApiError.badRequest(error.message);
    if (patch.rendimento !== undefined && Number(rAntes.rendimento) !== patch.rendimento) {
      mudancas.push({ campo: "rendimento", rotulo: "Rendimento da receita", valor_anterior: String(rAntes.rendimento), valor_novo: String(patch.rendimento) });
      const grafo = await carregarGrafo(organizacaoId);
      await recalcularCache({ organizacaoId, produtoIds: produtosAfetadosPorProduto(id, grafo), grafo });
    }
    if (patch.unidade_rendimento !== undefined && (rAntes.unidade_rendimento ?? null) !== patch.unidade_rendimento) {
      mudancas.push({ campo: "unidade_rendimento", rotulo: "Unidade do rendimento", valor_anterior: rAntes.unidade_rendimento ?? null, valor_novo: patch.unidade_rendimento });
    }
  }

  // 4) Auditoria (best-effort: nunca derruba o salvar se a tabela não existir)
  await registrarHistorico({ organizacaoId, produtoId: id, usuario, mudancas });

  return obterProduto({ organizacaoId, id });
}

// ===========================================================================
// HOMOLOGAÇÃO da ficha (migration 157) — só para produtos de carga importada
// (homologacao != 'nao_aplicavel'). Subways/cadastro manual não têm esse controle.
// Homologar exige ficha ÍNTEGRA; reabrir devolve a 'pendente'. Sempre auditado.
// ===========================================================================
export async function definirHomologacao({ organizacaoId, produtoId, acao, usuario }) {
  const id = v.uuid(produtoId, "Produto");
  if (!["homologar", "reabrir"].includes(acao)) throw ApiError.badRequest('Ação inválida: use "homologar" ou "reabrir".');
  const { data: p, error } = await supabase
    .from("produtos").select("id, nome, homologacao").eq("organizacao_id", organizacaoId).eq("id", id).single();
  if (error && /homologacao|does not exist|schema cache|could not find/i.test(error.message)) throw ApiError.badRequest("Homologação indisponível neste ambiente (migration 157 não aplicada).");
  if (!p) throw ApiError.notFound("Produto não encontrado");
  if (p.homologacao === "nao_aplicavel" || p.homologacao == null) throw new ApiError(409, `"${p.nome}" não tem controle de homologação (cadastro manual).`);

  const grafo = await carregarGrafo(organizacaoId);
  const efetiva = homologacaoEfetiva(id, grafo);
  let custoAgora = null;
  if (acao === "homologar") {
    const res = resumoProduto({ produtoId: id, grafo, precoVenda: null });
    if (["sem_componentes", "insumo_sem_custo", "insumo_inativo"].includes(res.status_ficha.chave)) {
      throw new ApiError(409, `A ficha de "${p.nome}" está incompleta (${res.status_ficha.label}). Complete-a antes de homologar.`, { status_ficha: res.status_ficha });
    }
    custoAgora = custoTotalProduto(id, grafo); // custo HOMOLOGADO: base da invalidação por mudança de preço
  }
  const novo = acao === "homologar" ? "homologada" : "pendente";
  // Já está no estado pedido e o estado é VÁLIDO (nada mudou desde a homologação): nada a fazer.
  if (efetiva.estado === novo && !(novo === "homologada" && p.homologacao !== "homologada")) return { id, homologacao: novo, alterado: false };
  const patch = acao === "homologar"
    ? { homologacao: "homologada", homologacao_motivo: null, homologado_em: new Date().toISOString(), homologado_por: null, homologado_por_nome: usuario?.nome ?? usuario?.email ?? null, homologado_custo: custoAgora }
    : { homologacao: "pendente", homologacao_motivo: "reaberta_manualmente", homologado_em: null, homologado_por: null, homologado_por_nome: null, homologado_custo: null };
  const { error: eUp } = await supabase.from("produtos").update(patch).eq("id", id).eq("organizacao_id", organizacaoId);
  if (eUp) throw ApiError.badRequest(eUp.message);
  await registrarHistorico({ organizacaoId, produtoId: id, usuario, mudancas: [{ campo: "homologacao", rotulo: "Homologação da ficha", valor_anterior: efetiva.estado + (efetiva.motivo ? ` (${efetiva.motivo})` : ""), valor_novo: novo }] });
  return { id, homologacao: novo, alterado: true };
}

/** Homologa várias fichas de uma vez (cada uma validada individualmente: ficha incompleta é recusada e reportada). */
export async function homologarLote({ organizacaoId, ids, usuario }) {
  if (!Array.isArray(ids) || !ids.length) throw ApiError.badRequest("Informe ao menos uma ficha.");
  if (ids.length > 500) throw ApiError.badRequest("No máximo 500 fichas por vez.");
  const resultado = { homologadas: [], ja_estavam: [], recusadas: [] };
  for (const id of [...new Set(ids)]) {
    try {
      const r = await definirHomologacao({ organizacaoId, produtoId: id, acao: "homologar", usuario });
      (r.alterado ? resultado.homologadas : resultado.ja_estavam).push(id);
    } catch (e) {
      resultado.recusadas.push({ id, motivo: e.message });
    }
  }
  return resultado;
}

/**
 * Catálogo de fichas para a tela da empresa: tudo calculado a partir de UM grafo (sem N+1).
 * Categoria (Salgados/Doces/Bebidas) vem da origem da carga; produtos manuais ficam sem categoria.
 */
export async function listarFichasCatalogo({ organizacaoId }) {
  const [grafo, origemRes, modRes] = await Promise.all([
    carregarGrafo(organizacaoId),
    supabase.from("catalogo_origem").select("entidade_id, referencia, pendencias").eq("organizacao_id", organizacaoId).eq("entidade", "produto"),
    carregarMaoDeObra(organizacaoId).catch(() => new Map()),
  ]);
  const origem = new Map((origemRes.data ?? []).map((o) => [o.entidade_id, o]));
  const itens = grafo.produtos.map((p) => {
    const res = resumoProduto({ produtoId: p.id, grafo, precoVenda: null });
    const o = origem.get(p.id);
    const mod = custoMaoDeObraUnitario(modRes.get(p.id) ?? [], rendimentoDe(p.id, grafo));
    const bloqueada = ["sem_componentes", "insumo_sem_custo", "insumo_inativo"].includes(res.status_ficha.chave);
    return {
      id: p.id, nome: p.nome, ativo: p.ativo !== false,
      natureza: p.vendavel === false ? "preparacao" : "produto_final",
      categoria: o?.referencia?.fontes?.[0]?.categoria ?? null,
      origem: o ? { arquivo: o.referencia?.fontes?.[0]?.arquivo ?? null, aba: o.referencia?.fontes?.[0]?.aba ?? null } : null,
      rendimento: res.rendimento, unidade_rendimento: p.unidade_rendimento ?? null,
      custo_unitario: bloqueada ? null : res.custo_calculado, custo_mao_de_obra_unitario: mod,
      qtd_componentes: res.qtd_componentes, status_ficha: res.status_ficha, ficha_completa: !bloqueada,
      homologacao: res.homologacao, homologacao_motivo: res.homologacao_motivo,
      homologado_em: res.homologacao === "homologada" ? p.homologado_em ?? null : null,
      homologado_por_nome: res.homologacao === "homologada" ? p.homologado_por_nome ?? null : null,
      pendencias: o?.pendencias ?? [],
      pode_homologar: !bloqueada && res.homologacao === "pendente",
    };
  }).sort((a, b) => a.nome.localeCompare(b.nome));
  const resumo = {
    total: itens.length, produtos_finais: itens.filter((i) => i.natureza === "produto_final").length, preparacoes: itens.filter((i) => i.natureza === "preparacao").length,
    homologadas: itens.filter((i) => i.homologacao === "homologada").length, pendentes: itens.filter((i) => i.homologacao === "pendente").length,
    incompletas: itens.filter((i) => !i.ficha_completa).length, prontas_para_homologar: itens.filter((i) => i.pode_homologar).length,
  };
  return { resumo, itens };
}

// Pendências registradas na carga (catalogo_origem): o que precisa de conferência pela empresa.
export async function listarPendenciasCatalogo({ organizacaoId }) {
  const { data, error } = await supabase
    .from("catalogo_origem").select("entidade, entidade_id, chave, referencia, pendencias")
    .eq("organizacao_id", organizacaoId).neq("pendencias", "[]").limit(3000);
  if (error) throw ApiError.internal(error.message);
  const linhas = data ?? [];
  const ids = (e) => linhas.filter((l) => l.entidade === e).map((l) => l.entidade_id);
  const [prods, insu] = await Promise.all([
    ids("produto").length ? supabase.from("produtos").select("id, nome, homologacao").eq("organizacao_id", organizacaoId).in("id", ids("produto")) : { data: [] },
    ids("insumo").length ? supabase.from("insumos").select("id, nome").eq("organizacao_id", organizacaoId).in("id", ids("insumo")) : { data: [] },
  ]);
  const nome = new Map([...(prods.data ?? []), ...(insu.data ?? [])].map((r) => [r.id, r]));
  const itens = linhas.map((l) => ({
    entidade: l.entidade, id: l.entidade_id, nome: nome.get(l.entidade_id)?.nome ?? null,
    homologacao: nome.get(l.entidade_id)?.homologacao ?? null, chave: l.chave, origem: l.referencia?.fontes?.[0] ?? null, pendencias: l.pendencias,
  })).filter((i) => i.nome);
  return { total: itens.length, itens };
}

// Grava as mudanças na tabela de auditoria. Falhas são apenas logadas (best-effort).
async function registrarHistorico({ organizacaoId, produtoId, usuario, mudancas }) {
  if (!mudancas?.length) return;
  const alteracaoId = randomUUID();
  const linhas = mudancas.map((mc) => ({
    organizacao_id: organizacaoId,
    produto_id: produtoId,
    alteracao_id: alteracaoId,
    campo: mc.campo,
    rotulo: mc.rotulo,
    valor_anterior: mc.valor_anterior,
    valor_novo: mc.valor_novo,
    usuario_id: usuario?.id ?? null,
    usuario_nome: usuario?.nome ?? null,
    usuario_email: usuario?.email ?? null,
  }));
  try {
    const { error } = await supabase.from("produto_historico").insert(linhas);
    if (error) console.warn("[historico] não registrado:", error.message);
  } catch (e) {
    console.warn("[historico] exceção ao registrar:", e.message);
  }
}

// Lista o histórico de alterações de um produto, agrupado por "Salvar" (alteracao_id).
export async function listarHistoricoProduto({ organizacaoId, produtoId }) {
  const { data: prod } = await supabase
    .from("produtos").select("id, nome")
    .eq("organizacao_id", organizacaoId).eq("id", produtoId).single();
  if (!prod) throw ApiError.notFound("Produto não encontrado");

  const { data, error } = await supabase
    .from("produto_historico")
    .select("alteracao_id, campo, rotulo, valor_anterior, valor_novo, usuario_nome, usuario_email, created_at")
    .eq("organizacao_id", organizacaoId)
    .eq("produto_id", produtoId)
    .order("created_at", { ascending: false })
    .limit(300);

  if (error) {
    // Tabela ainda não criada (migration 002 não executada) → responde vazio + pendente
    if (/does not exist|schema cache|could not find the table/i.test(error.message)) {
      return { produto: prod.nome, pendente: true, alteracoes: [] };
    }
    throw ApiError.internal(error.message);
  }

  const grupos = new Map();
  for (const r of data ?? []) {
    if (!grupos.has(r.alteracao_id)) {
      grupos.set(r.alteracao_id, {
        alteracao_id: r.alteracao_id,
        created_at: r.created_at,
        usuario_nome: r.usuario_nome,
        usuario_email: r.usuario_email,
        mudancas: [],
      });
    }
    grupos.get(r.alteracao_id).mudancas.push({
      campo: r.campo, rotulo: r.rotulo,
      valor_anterior: r.valor_anterior, valor_novo: r.valor_novo,
    });
  }
  return { produto: prod.nome, pendente: false, alteracoes: [...grupos.values()] };
}

// Alterações mais recentes de TODA a organização (para o painel do Dashboard).
// Agrupa por "Salvar" (alteracao_id) e devolve os últimos `limite` eventos.
export async function listarHistoricoRecente({ organizacaoId, limite = 8 }) {
  const { data, error } = await supabase
    .from("produto_historico")
    .select("produto_id, alteracao_id, campo, rotulo, valor_anterior, valor_novo, usuario_nome, usuario_email, created_at")
    .eq("organizacao_id", organizacaoId)
    .order("created_at", { ascending: false })
    .limit(limite * 6); // sobra p/ agrupar várias mudanças num mesmo evento

  if (error) {
    if (/does not exist|schema cache|could not find the table/i.test(error.message)) {
      return { pendente: true, eventos: [] };
    }
    throw ApiError.internal(error.message);
  }

  const grupos = new Map();
  for (const r of data ?? []) {
    if (!grupos.has(r.alteracao_id)) {
      grupos.set(r.alteracao_id, {
        alteracao_id: r.alteracao_id, produto_id: r.produto_id, created_at: r.created_at,
        usuario_nome: r.usuario_nome, usuario_email: r.usuario_email, mudancas: [],
      });
    }
    grupos.get(r.alteracao_id).mudancas.push({
      campo: r.campo, rotulo: r.rotulo, valor_anterior: r.valor_anterior, valor_novo: r.valor_novo,
    });
  }
  let eventos = [...grupos.values()].slice(0, limite);

  // Nomes dos produtos envolvidos
  const ids = [...new Set(eventos.map((e) => e.produto_id))];
  if (ids.length) {
    const { data: prods } = await supabase
      .from("produtos").select("id, nome").eq("organizacao_id", organizacaoId).in("id", ids);
    const nomeById = Object.fromEntries((prods ?? []).map((p) => [p.id, p.nome]));
    eventos = eventos.map((e) => ({ ...e, produto_nome: nomeById[e.produto_id] ?? "Produto" }));
  }
  return { pendente: false, eventos };
}

// ===========================================================================
// FICHA TÉCNICA EDITÁVEL — adicionar / editar / remover componente
//
// Toda mutação: (1) valida o acesso do produto à organização; (2) valida o
// insumo/unidade; (3) grava a quantidade SEMPRE na unidade-base do insumo
// (mantendo fn_custo_produto e a baixa de estoque intactos); (4) recalcula em
// cascata o custo_cache do produto e de quem o usa como submontagem.
// ===========================================================================

const RE_COL_FICHA = /does not exist|schema cache|could not find/i;

/** Garante que o produto existe e pertence à organização. */
async function garantirProduto(organizacaoId, produtoId) {
  const { data } = await supabase
    .from("produtos").select("id, custo_manual").eq("organizacao_id", organizacaoId).eq("id", produtoId).single();
  if (!data) throw ApiError.notFound("Produto não encontrado");
  return data;
}

/** Recalcula em cascata e devolve o produto já atualizado + quantos recalcularam. */
async function recalcularEObter(organizacaoId, produtoId) {
  const grafo = await carregarGrafo(organizacaoId);
  const afetados = produtosAfetadosPorProduto(produtoId, grafo);
  const recalculados = await recalcularCache({ organizacaoId, produtoIds: afetados, grafo });
  const produto = await obterProduto({ organizacaoId, id: produtoId });
  return { produto, recalculados };
}

export async function adicionarComponente({ organizacaoId, produtoId, dados, usuario }) {
  const pid = v.uuid(produtoId, "Produto");
  await garantirProduto(organizacaoId, pid);
  const b = v.corpo(dados);
  const insumoId = v.uuid(b.insumo_id, "Insumo");

  // Insumo precisa ser DESTA organização e estar ativo.
  const { data: insumo } = await supabase
    .from("insumos").select("id, unidade_medida, ativo").eq("organizacao_id", organizacaoId).eq("id", insumoId).single();
  if (!insumo) throw ApiError.notFound("Insumo não encontrado nesta empresa.");
  if (insumo.ativo === false) throw ApiError.badRequest("Não é possível adicionar um insumo inativo à ficha.");

  const unidadeUso = v.umDe(b.unidade ?? insumo.unidade_medida, "Unidade utilizada", UNIDADES);
  const quantidade = v.numero(b.quantidade, "Quantidade utilizada", { min: 0 });
  const erro = validarComponenteFicha({ quantidade, unidadeUso, unidadeBase: insumo.unidade_medida });
  if (erro) throw ApiError.badRequest(erro);

  const qtdBase = converterQuantidade(quantidade, unidadeUso, insumo.unidade_medida);
  const linha = {
    produto_id: pid, insumo_id: insumoId, quantidade: qtdBase,
    unidade_uso: unidadeUso, quantidade_informada: quantidade,
    observacao: v.textoOpcional(b.observacao, "Observação", { max: 300 }),
    created_by: usuario?.id ?? null,
  };

  let res = await supabase.from("ficha_tecnica").insert(linha).select("id").single();
  if (res.error && RE_COL_FICHA.test(res.error.message)) {
    res = await supabase.from("ficha_tecnica")
      .insert({ produto_id: pid, insumo_id: insumoId, quantidade: qtdBase, observacao: linha.observacao })
      .select("id").single();
  }
  if (res.error) {
    if (/duplicate key|unique/i.test(res.error.message)) {
      throw ApiError.badRequest("Este insumo já está na ficha. Edite a quantidade em vez de duplicar.");
    }
    throw ApiError.badRequest(res.error.message);
  }
  return recalcularEObter(organizacaoId, pid);
}

export async function atualizarComponente({ organizacaoId, produtoId, fichaId, dados }) {
  const pid = v.uuid(produtoId, "Produto");
  const fid = v.uuid(fichaId, "Item da ficha");
  await garantirProduto(organizacaoId, pid);

  const { data: linha } = await supabase
    .from("ficha_tecnica").select("id, produto_id, insumo_id, subproduto_id").eq("id", fid).single();
  if (!linha || linha.produto_id !== pid) throw ApiError.notFound("Item da ficha não encontrado.");

  const b = v.corpo(dados);
  const patch = {};

  if (linha.insumo_id) {
    const { data: insumo } = await supabase
      .from("insumos").select("unidade_medida").eq("organizacao_id", organizacaoId).eq("id", linha.insumo_id).single();
    if (!insumo) throw ApiError.notFound("Insumo não encontrado.");
    const unidadeUso = v.umDe(b.unidade ?? insumo.unidade_medida, "Unidade utilizada", UNIDADES);
    const quantidade = v.numero(b.quantidade, "Quantidade utilizada", { min: 0 });
    const erro = validarComponenteFicha({ quantidade, unidadeUso, unidadeBase: insumo.unidade_medida });
    if (erro) throw ApiError.badRequest(erro);
    patch.quantidade = converterQuantidade(quantidade, unidadeUso, insumo.unidade_medida);
    patch.unidade_uso = unidadeUso;
    patch.quantidade_informada = quantidade;
  } else {
    // Submontagem/combo: quantidade em unidades do subproduto.
    const quantidade = v.numero(b.quantidade, "Quantidade", { min: 0 });
    if (quantidade <= 0) throw ApiError.badRequest("A quantidade deve ser maior que zero.");
    patch.quantidade = quantidade;
  }
  if (b.ativo !== undefined) patch.ativo = v.booleano(b.ativo, true);

  let res = await supabase.from("ficha_tecnica").update(patch).eq("id", fid);
  if (res.error && RE_COL_FICHA.test(res.error.message)) {
    res = await supabase.from("ficha_tecnica").update({ quantidade: patch.quantidade }).eq("id", fid);
  }
  if (res.error) throw ApiError.badRequest(res.error.message);
  return recalcularEObter(organizacaoId, pid);
}

export async function removerComponente({ organizacaoId, produtoId, fichaId }) {
  const pid = v.uuid(produtoId, "Produto");
  const fid = v.uuid(fichaId, "Item da ficha");
  await garantirProduto(organizacaoId, pid);

  const { data: linha } = await supabase
    .from("ficha_tecnica").select("id, produto_id").eq("id", fid).single();
  if (!linha || linha.produto_id !== pid) throw ApiError.notFound("Item da ficha não encontrado.");

  // Remover da ficha NÃO exclui o insumo da unidade — só a linha da ficha.
  const { error } = await supabase.from("ficha_tecnica").delete().eq("id", fid);
  if (error) throw ApiError.badRequest(error.message);
  return recalcularEObter(organizacaoId, pid);
}

// ===========================================================================
// EXCLUSÃO DE PRODUTO
//
// Exclui de verdade, mas só quando é seguro. Dois vínculos BLOQUEIAM (são
// `on delete restrict` no banco, e aqui viram mensagem clara em vez de erro
// de constraint):
//   * vendas_itens  -> o produto já foi vendido; apagá-lo reescreveria o
//                      histórico comercial. O caminho é INATIVAR.
//   * ficha_tecnica.subproduto_id -> o produto é componente de outra ficha.
// O que sai junto (cascade, e deve mesmo sair): a ficha do próprio produto,
// seus preços e seu histórico de alterações.
// ===========================================================================
export async function excluirProduto({ organizacaoId, id }) {
  const produtoId = v.uuid(id, "Produto");

  const { data: prod } = await supabase
    .from("produtos").select("id, nome").eq("organizacao_id", organizacaoId).eq("id", produtoId).single();
  if (!prod) throw ApiError.notFound("Produto não encontrado");

  // 1) Foi vendido?
  const { count: nVendas } = await supabase
    .from("vendas_itens").select("id", { count: "exact", head: true }).eq("produto_id", produtoId);
  if (nVendas > 0) {
    throw new ApiError(409, `"${prod.nome}" não pode ser excluído: possui ${nVendas} venda(s) registrada(s). Inative o produto para tirá-lo de circulação preservando o histórico.`,
      { bloqueio: "vendas", quantidade: nVendas, sugestao: "inativar" });
  }

  // 2) É componente da ficha de outro produto?
  const { data: usos } = await supabase
    .from("ficha_tecnica").select("produto_id").eq("subproduto_id", produtoId);
  if (usos?.length) {
    const ids = [...new Set(usos.map((u) => u.produto_id))];
    const { data: pais } = await supabase
      .from("produtos").select("nome").eq("organizacao_id", organizacaoId).in("id", ids);
    const nomes = (pais ?? []).map((p) => p.nome).join(", ");
    throw new ApiError(409, `"${prod.nome}" não pode ser excluído: é usado como componente em ${ids.length} produto(s) — ${nomes}. Remova-o dessas fichas primeiro.`,
      { bloqueio: "submontagem", produtos: nomes, sugestao: "remover-das-fichas" });
  }

  // Seguro: a ficha, os preços e o histórico saem em cascade.
  const { error } = await supabase.from("produtos").delete().eq("id", produtoId).eq("organizacao_id", organizacaoId);
  if (error) throw ApiError.badRequest(error.message);
  return { excluido: true, nome: prod.nome };
}
