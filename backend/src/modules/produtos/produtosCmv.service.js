// Produtos / CMV 2.0 — serviço da plataforma (saúde, Central de Pendências, correções guiadas, assistente,
// precificação, homologação revisada, indicadores para o Núcleo Mentorados).
//
// Não reimplementa regra: usa custo.js (grafo/cascata), diagnostico.js (pendências/elegibilidade),
// revisaoRendimento.js, aproveitamento.js, precificacao.js, cmv.condicoes.js e a homologação existente
// (definirHomologacao). Tudo escopado por organizacaoId (nunca aceita organização do corpo).

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { carregarGrafo, lerTudo, recalcularCache, produtosAfetadosPorProduto, produtosAfetadosPorInsumo, custoTotalProduto, componentesDiretos, rendimentoDe } from "./custo.js";
import { diagnosticarOrganizacao, elegibilidadeHomologacao, dimensoesDaFicha, CATALOGO_PENDENCIAS } from "./diagnostico.js";
import { previaRevisaoRendimentos, validarLoteRendimentos } from "./revisaoRendimento.js";
import { calcularAproveitamento } from "./aproveitamento.js";
import { simularPreco } from "./precificacao.js";
import { condicoesComerciais } from "../cmv/cmv.condicoes.js";
import { definirHomologacao } from "./produtos.service.js";
import { naturezaCusto } from "../insumos/insumos.calc.js";
import { pendenciasCargaAbertas, CODIGOS_CARGA_BLOQUEANTES } from "./pendenciasCarga.js";
import { homologadasComInconsistencia } from "./integridade.js";

const tabelaAusente = (e) => e && /does not exist|schema cache|could not find|column/i.test(e.message ?? "");

async function precosDaOrganizacao(grafo) {
  const ids = grafo.produtos.map((p) => p.id);
  const porProduto = new Map();
  for (let i = 0; i < ids.length; i += 150) {
    const bloco = ids.slice(i, i + 150);
    const r = await lerTudo((de, ate) => supabase.from("produto_precos").select("*").in("produto_id", bloco).order("id").range(de, ate));
    if (r.error) throw ApiError.internal(r.error.message);
    for (const l of r.data) {
      if (!porProduto.has(l.produto_id)) porProduto.set(l.produto_id, []);
      porProduto.get(l.produto_id).push(l);
    }
  }
  return porProduto;
}

async function origensDaOrganizacao(organizacaoId) {
  const r = await lerTudo((de, ate) => supabase.from("catalogo_origem").select("entidade_id, referencia, pendencias")
    .eq("organizacao_id", organizacaoId).eq("entidade", "produto").order("id").range(de, ate));
  if (r.error && !tabelaAusente(r.error)) throw ApiError.internal(r.error.message);
  return new Map((r.data ?? []).map((o) => [o.entidade_id, o]));
}

/** Contexto completo de UMA leitura (um grafo, sem N+1). */
async function contexto(organizacaoId) {
  const grafo = await carregarGrafo(organizacaoId);
  const [precos, condicoes, cargas] = await Promise.all([
    precosDaOrganizacao(grafo),
    condicoesComerciais({ organizacaoId }).catch(() => ({ configurado: false, canais: [] })),
    lerTudo((de, ate) => supabase.from("catalogo_origem").select("entidade_id, pendencias").eq("organizacao_id", organizacaoId).eq("entidade", "produto").order("id").range(de, ate)),
  ]);
  const cargaPorProduto = new Map();
  for (const o of cargas.data ?? []) cargaPorProduto.set(o.entidade_id, [...(cargaPorProduto.get(o.entidade_id) ?? []), ...(o.pendencias ?? [])]);
  const precoVigente = new Map([...precos].map(([id, ls]) => [id, Math.max(0, ...ls.map((l) => Number(l.preco) || 0)) || null]));
  // Mapa sempre "presente": a falta de preço é exibida como pendência (dimensão comercial, não técnica).
  const diag = diagnosticarOrganizacao(grafo, {
    precoVendaPorProduto: precoVigente.size ? precoVigente : new Map([["__sem_tabela__", null]]),
    pendenciasCarga: (pid) => pendenciasCargaAbertas(cargaPorProduto.get(pid) ?? []).filter((x) => CODIGOS_CARGA_BLOQUEANTES.has(x.codigo)),
  });
  return { grafo, precos, precoVigente, condicoes, diag };
}

/** Modelo de operação inferido dos DADOS (nunca do nome/ID): orienta quais etapas e textos o front mostra. */
export function perfilOperacao(grafo) {
  const ps = grafo.produtos.filter((p) => p.ativo !== false);
  const padronizadas = ps.filter((p) => p.homologacao === "nao_aplicavel").length;
  const preparacoes = ps.filter((p) => p.tipo === "submontagem").length;
  const aninhadas = [...grafo.fichaByProd.values()].flat().filter((f) => f.subproduto_id).length;
  const franquia = ps.length > 0 && padronizadas / ps.length >= 0.9;
  return {
    modelo: ps.length === 0 ? "sem_catalogo" : franquia ? "franquia_padronizada" : "marca_propria",
    total: ps.length, padronizadas, preparacoes, linhas_com_preparacao: aninhadas,
    // Franquia padronizada: sem assistente de receita própria (as fichas vêm da franqueadora).
    recursos: { assistente_receitas: !franquia, homologacao: !franquia, revisao_rendimentos: !franquia, preparacoes: preparacoes > 0 || !franquia },
  };
}

export async function saude({ organizacaoId }) {
  const { grafo, precos, precoVigente, condicoes, diag } = await contexto(organizacaoId);
  const vendaveis = diag.produtos.filter((p) => p.vendavel && p.tipo !== "submontagem");
  const comPreco = vendaveis.filter((p) => precoVigente.get(p.id) > 0).length;
  const temCond = !!condicoes.configurado;
  const dims = diag.produtos.map((p) => dimensoesDaFicha(p, { temPreco: precoVigente.get(p.id) > 0, temCondicoesCanal: temCond }));
  const { data: corr, error: eCorr } = await supabase.from("catalogo_correcoes").select("tipo, created_at").eq("organizacao_id", organizacaoId).order("created_at", { ascending: false }).limit(500);
  const evolucao = {};
  for (const c of tabelaAusente(eCorr) ? [] : corr ?? []) { const m = String(c.created_at).slice(0, 7); evolucao[m] = (evolucao[m] ?? 0) + 1; }
  const ultimaAtualizacaoCusto = [...grafo.insumoById.values()].map((i) => i.preco_atualizado_em).filter(Boolean).sort().at(-1) ?? null;
  return {
    perfil: perfilOperacao(grafo),
    resumo: diag.resumo,
    dimensoes: {
      receita_completa: dims.filter((d) => d.receita_completa).length,
      custo_confiavel: dims.filter((d) => d.custo_confiavel).length,
      cmv_disponivel: dims.filter((d) => d.cmv_disponivel).length,
      rentabilidade_disponivel: dims.filter((d) => d.rentabilidade_disponivel).length,
    },
    precos: { vendaveis: vendaveis.length, com_preco: comPreco, cobertura_pct: vendaveis.length ? (comPreco / vendaveis.length) * 100 : null, linhas: [...precos.values()].flat().length, condicoes_configuradas: temCond },
    causas_raiz: diag.causasRaiz.slice(0, 8).map(moldarCausa),
    evolucao_correcoes: Object.entries(evolucao).sort().map(([mes, n]) => ({ mes, correcoes: n })),
    ultima_atualizacao_custo: ultimaAtualizacaoCusto,
  };
}

const moldarCausa = (c) => ({
  chave: c.chave, codigo: c.codigo, criticidade: c.criticidade, alvo: c.alvo, nome: c.nome, detalhe: c.detalhe ?? null,
  problema: c.problema, impacto: c.impacto, correcao: c.correcao, onde: c.onde,
  qtd_impactados: c.qtd_impactados, qtd_diretos: c.diretos.length, impactados: c.impactados,
});

export async function pendencias({ organizacaoId }) {
  const { diag, grafo } = await contexto(organizacaoId);
  return {
    catalogo: CATALOGO_PENDENCIAS,
    causas_raiz: diag.causasRaiz.map(moldarCausa),
    produtos: diag.produtos.map((p) => ({ ...p, rendimento: rendimentoDe(p.id, grafo), unidade_rendimento: grafo.unidadeRendimentoById.get(p.id) ?? null, homologacao: elegibilidadeHomologacao(p) })),
  };
}

// ------------------------------------------------------------------ D1: custo zero declarado
/**
 * Prévia da correção por causa-raiz de um insumo sem custo: quantos produtos dependem dele e quantos AINDA ficariam com
 * outras pendências depois (o sistema não promete regularizar tudo com uma única correção).
 */
export async function previaCustoZero({ organizacaoId, insumoId }) {
  const id = v.uuid(insumoId, "Insumo");
  const { grafo, precoVigente } = await contexto(organizacaoId);
  const ins = grafo.insumoById.get(id);
  if (!ins) throw ApiError.notFound("Insumo não encontrado nesta unidade.");
  const antes = diagnosticarOrganizacao(grafo, { precoVendaPorProduto: precoVigente });
  const simulado = { ...grafo, insumoById: new Map(grafo.insumoById) };
  simulado.insumoById.set(id, { ...ins, preco_unitario: 0, custo_zero_declarado: true });
  const depois = diagnosticarOrganizacao(simulado, { precoVendaPorProduto: precoVigente });
  const afetados = new Set(produtosAfetadosPorInsumo(id, grafo));
  const porId = new Map(depois.produtos.map((p) => [p.id, p]));
  const lista = [...afetados].map((pid) => {
    const p = porId.get(pid); const ant = antes.produtos.find((x) => x.id === pid);
    return { id: pid, nome: p?.nome, situacao_antes: ant?.situacao, situacao_depois: p?.situacao, pendencias_restantes: [...new Set((p?.pendencias ?? []).map((x) => x.codigo))] };
  });
  return {
    insumo: { id, nome: ins.nome, natureza_custo: naturezaCusto(ins), preco_unitario: ins.preco_unitario ?? null },
    afetados: lista.length,
    ficariam_sem_pendencia: lista.filter((x) => !x.pendencias_restantes.length).length,
    continuariam_com_pendencia: lista.filter((x) => x.pendencias_restantes.length).length,
    itens: lista.sort((a, b) => a.pendencias_restantes.length - b.pendencias_restantes.length || String(a.nome).localeCompare(String(b.nome))),
    aviso: "Declarar custo zero é uma decisão de metodologia (ex.: água absorvida nas despesas operacionais). Não é feito automaticamente.",
  };
}

export async function definirCustoZero({ organizacaoId, insumoId, declarar, motivo, usuario }) {
  const id = v.uuid(insumoId, "Insumo");
  if (declarar && !String(motivo ?? "").trim()) throw ApiError.badRequest("Informe o motivo do custo zero (ex.: água da rede absorvida nas despesas operacionais).");
  const grafo = await carregarGrafo(organizacaoId);
  if (!grafo.insumoById.has(id)) throw ApiError.notFound("Insumo não encontrado nesta unidade.");
  const { data, error } = await supabase.rpc("fn_custo_zero", { p_org: organizacaoId, p_insumo: id, p_declarar: !!declarar, p_motivo: motivo ?? null, p_usuario_nome: usuario?.nome ?? null, p_usuario_email: usuario?.email ?? null });
  if (error) throw tabelaAusente(error) ? ApiError.badRequest("Custo zero declarado indisponível (migration 163 não aplicada).") : ApiError.badRequest(error.message);
  const afetados = produtosAfetadosPorInsumo(id, await carregarGrafo(organizacaoId));
  const recalculados = data?.alterado ? await recalcularCache({ organizacaoId, produtoIds: afetados }) : 0;
  return { ...data, recalculados };
}

// ------------------------------------------------------------------ D2: revisão de rendimentos
export async function previaRendimentos({ organizacaoId, sobrescritas }) {
  const [grafo, origem] = await Promise.all([carregarGrafo(organizacaoId), origensDaOrganizacao(organizacaoId)]);
  const sob = new Map(Object.entries(sobrescritas ?? {}).map(([k, x]) => [k, Number(x)]).filter(([, x]) => Number.isFinite(x) && x > 0));
  return { itens: previaRevisaoRendimentos(grafo, { origemPorProduto: origem, sobrescritas: sob }) };
}

export async function aplicarRendimentos({ organizacaoId, itens, usuario }) {
  const [grafo, origem] = await Promise.all([carregarGrafo(organizacaoId), origensDaOrganizacao(organizacaoId)]);
  const previa = previaRevisaoRendimentos(grafo, { origemPorProduto: origem });
  const erros = validarLoteRendimentos(itens, previa);
  if (erros.length) throw new ApiError(422, "Revise o lote antes de aplicar.", { erros });
  const payload = itens.map((i) => ({ produto_id: i.produto_id, rendimento_atual: Number(i.rendimento_atual), rendimento_novo: Number(i.rendimento_novo), justificativa: String(i.justificativa).trim() }));
  const { data, error } = await supabase.rpc("fn_corrigir_rendimentos", { p_org: organizacaoId, p_itens: payload, p_usuario_nome: usuario?.nome ?? null, p_usuario_email: usuario?.email ?? null });
  if (error) throw tabelaAusente(error) ? ApiError.badRequest("Correção de rendimentos indisponível (migration 163 não aplicada).") : new ApiError(409, error.message);
  const novo = await carregarGrafo(organizacaoId);
  const afetados = [...new Set(payload.flatMap((p) => produtosAfetadosPorProduto(p.produto_id, novo)))];
  return { ...data, recalculados: await recalcularCache({ organizacaoId, produtoIds: afetados, grafo: novo }) };
}

// ------------------------------------------------------------------ assistente: rascunhos e recuperação
const ETAPAS = ["identificacao", "ingredientes", "aproveitamento", "porcionamento", "complementares", "precos", "revisao"];
export const ETAPAS_POR_NATUREZA = {
  produto_final: ETAPAS,
  preparacao: ["identificacao", "ingredientes", "aproveitamento", "porcionamento", "revisao"], // sem preço: não é vendida
  revenda: ["identificacao", "complementares", "precos", "revisao"],                          // custo de aquisição, sem receita
};

/**
 * Recuperação de uma ficha EXISTENTE: aproveita o que é válido e aponta só as etapas pendentes.
 * Puro sobre o grafo + diagnóstico (testável).
 */
export function montarRecuperacao(produtoId, grafo, diagItem, precos = []) {
  const p = grafo.produtos.find((x) => x.id === produtoId);
  const natureza = p.tipo === "submontagem" || p.vendavel === false ? "preparacao" : "produto_final";
  const cods = new Set((diagItem?.pendencias ?? []).map((x) => x.codigo));
  const etapaDe = { sem_componentes: "ingredientes", quantidade_invalida: "ingredientes", insumo_sem_custo: "ingredientes", insumo_inativo: "ingredientes",
    preparacao_comprometida: "ingredientes", ciclo: "ingredientes", rendimento_unidade_suspeita: "porcionamento", rendimento_expansao_alta: "porcionamento",
    rendimento_sem_unidade: "porcionamento", sem_preco_venda: "precos" };
  const pendentes = new Set([...cods].map((c) => etapaDe[c]).filter(Boolean));
  const etapas = ETAPAS_POR_NATUREZA[natureza].map((e) => ({
    etapa: e,
    estado: pendentes.has(e) ? "pendente" : e === "revisao" ? (pendentes.size ? "bloqueada" : "pronta") : "valida",
    pendencias: (diagItem?.pendencias ?? []).filter((x) => etapaDe[x.codigo] === e).map((x) => ({ ...x, ...CATALOGO_PENDENCIAS[x.codigo] })),
  }));
  return {
    produto_id: produtoId, natureza, nome: p.nome,
    proxima_etapa: etapas.find((e) => e.estado === "pendente")?.etapa ?? "revisao",
    etapas,
    dados: {
      identificacao: { nome: p.nome, natureza, tipo: p.tipo, codigo_pdv: p.codigo_pdv ?? null },
      ingredientes: componentesDiretos(produtoId, grafo),
      porcionamento: { rendimento: rendimentoDe(produtoId, grafo), unidade_rendimento: grafo.unidadeRendimentoById.get(produtoId) ?? null },
      precos: precos.map((l) => ({ canal: l.canal, tabela: l.tabela, preco: Number(l.preco), origem: l.origem ?? null })),
    },
    custo_unitario: custoTotalProduto(produtoId, grafo),
  };
}

export async function recuperarFicha({ organizacaoId, produtoId }) {
  const id = v.uuid(produtoId, "Produto");
  const { grafo, precos, diag } = await contexto(organizacaoId);
  if (!grafo.produtos.some((p) => p.id === id)) throw ApiError.notFound("Produto não encontrado nesta unidade.");
  const rec = montarRecuperacao(id, grafo, diag.produtos.find((p) => p.id === id), precos.get(id) ?? []);
  const { data: rasc } = await supabase.from("produto_rascunhos").select("*").eq("organizacao_id", organizacaoId).eq("produto_id", id).maybeSingle();
  return { ...rec, rascunho: rasc ?? null };
}

export function validarRascunho(body) {
  const b = body && typeof body === "object" ? body : {};
  if (!ETAPAS_POR_NATUREZA[b.natureza]) throw ApiError.badRequest("Natureza inválida: produto_final, preparacao ou revenda.");
  if (!ETAPAS_POR_NATUREZA[b.natureza].includes(b.etapa ?? "identificacao")) throw ApiError.badRequest("Etapa inválida para esta natureza.");
  const dados = b.dados && typeof b.dados === "object" ? b.dados : {};
  if (JSON.stringify(dados).length > 200_000) throw ApiError.badRequest("Rascunho grande demais.");
  return { natureza: b.natureza, etapa: b.etapa ?? "identificacao", dados };
}

export async function salvarRascunho({ organizacaoId, id, body, usuario }) {
  const r = validarRascunho(body);
  const produtoId = body?.produto_id ? v.uuid(body.produto_id, "Produto") : null;
  if (produtoId) {
    const { data: p } = await supabase.from("produtos").select("id").eq("organizacao_id", organizacaoId).eq("id", produtoId).maybeSingle();
    if (!p) throw ApiError.notFound("Produto não encontrado nesta unidade.");
  }
  const quem = usuario?.nome ?? usuario?.email ?? null;
  const linha = { ...r, organizacao_id: organizacaoId, produto_id: produtoId, atualizado_por: quem, updated_at: new Date().toISOString() };
  const q = id
    ? supabase.from("produto_rascunhos").update(linha).eq("id", v.uuid(id, "Rascunho")).eq("organizacao_id", organizacaoId).select().single()
    : supabase.from("produto_rascunhos").insert({ ...linha, criado_por: quem }).select().single();
  const { data, error } = await q;
  if (error) throw tabelaAusente(error) ? ApiError.badRequest("Rascunhos indisponíveis (migration 163 não aplicada).") : ApiError.badRequest(error.message);
  return data;
}

export async function listarRascunhos({ organizacaoId }) {
  const { data, error } = await supabase.from("produto_rascunhos").select("id, produto_id, natureza, etapa, dados->identificacao, atualizado_por, updated_at")
    .eq("organizacao_id", organizacaoId).order("updated_at", { ascending: false }).limit(100);
  if (error) { if (tabelaAusente(error)) return []; throw ApiError.internal(error.message); }
  return data ?? [];
}

export async function obterRascunho({ organizacaoId, id }) {
  const { data } = await supabase.from("produto_rascunhos").select("*").eq("organizacao_id", organizacaoId).eq("id", v.uuid(id, "Rascunho")).maybeSingle();
  if (!data) throw ApiError.notFound("Rascunho não encontrado.");
  return data;
}

export async function excluirRascunho({ organizacaoId, id }) {
  const { error } = await supabase.from("produto_rascunhos").delete().eq("organizacao_id", organizacaoId).eq("id", v.uuid(id, "Rascunho"));
  if (error) throw ApiError.badRequest(error.message);
  return { ok: true };
}

/** Validação do aproveitamento de uma linha (o assistente chama antes de gravar). */
export async function validarAproveitamento({ organizacaoId, insumoId, entrada }) {
  const grafo = await carregarGrafo(organizacaoId);
  const ins = insumoId ? grafo.insumoById.get(v.uuid(insumoId, "Insumo")) : null;
  if (insumoId && !ins) throw ApiError.notFound("Insumo não encontrado nesta unidade.");
  return calcularAproveitamento({ ...entrada, aproveitamentoPct: entrada?.aproveitamentoPct ?? ins?.aproveitamento_pct ?? null,
    precoUnitarioBase: ins?.preco_unitario ?? null, fatorCorrecaoNoPrecoDoInsumo: ins?.fator_correcao ?? null });
}

/**
 * Cria o produto de uma ficha NOVA do assistente (marca própria). Nasce 'pendente' de homologação; ingredientes,
 * preparações e preços entram depois pelos endpoints que já existem (mesmas validações de unidade/ciclo/isolamento).
 * Franquia padronizada não cria receita própria por aqui.
 */
export async function criarFicha({ organizacaoId, body, usuario }) {
  const b = body ?? {};
  const nome = String(b.nome ?? "").trim();
  if (!nome || nome.length > 120) throw ApiError.badRequest("Informe o nome do produto (até 120 caracteres).");
  if (!ETAPAS_POR_NATUREZA[b.natureza]) throw ApiError.badRequest("Natureza inválida: produto_final, preparacao ou revenda.");
  const grafo = await carregarGrafo(organizacaoId);
  if (!perfilOperacao(grafo).recursos.assistente_receitas) throw new ApiError(409, "Esta unidade usa fichas padronizadas da franquia: novas receitas não são criadas por aqui.");
  const preparacao = b.natureza === "preparacao";
  const rendimento = b.rendimento == null || b.rendimento === "" ? 1 : Number(b.rendimento);
  if (!Number.isFinite(rendimento) || rendimento <= 0) throw ApiError.badRequest("Rendimento inválido.");
  const unidade = b.unidade_rendimento ?? (preparacao ? null : null);
  if (preparacao && !["g", "kg", "ml", "l", "un"].includes(unidade)) throw ApiError.badRequest("Informe em que unidade a preparação rende (g, kg, ml, l ou un).");
  const { data, error } = await supabase.from("produtos").insert({
    organizacao_id: organizacaoId, nome, tipo: preparacao ? "submontagem" : "outro", vendavel: !preparacao,
    rendimento, unidade_rendimento: preparacao ? unidade : null, homologacao: "pendente", ativo: true,
  }).select("id, nome").single();
  if (error) throw ApiError.badRequest(error.message);
  if (b.rascunho_id) await supabase.from("produto_rascunhos").update({ produto_id: data.id, atualizado_por: usuario?.nome ?? null, updated_at: new Date().toISOString() })
    .eq("id", v.uuid(b.rascunho_id, "Rascunho")).eq("organizacao_id", organizacaoId);
  return data;
}

// ------------------------------------------------------------------ precificação
export async function simular({ organizacaoId, produtoId, canal, preco, metaCmv, margemContribuicaoAlvo }) {
  const id = v.uuid(produtoId, "Produto");
  const { grafo, precos, condicoes, diag } = await contexto(organizacaoId);
  const item = diag.produtos.find((p) => p.id === id);
  if (!item) throw ApiError.notFound("Produto não encontrado nesta unidade.");
  const dims = dimensoesDaFicha(item, { temPreco: true, temCondicoesCanal: true });
  const precosProduto = precos.get(id) ?? [];
  let canais = (canal ? [canal] : [...new Set([...condicoes.canais.map((c) => c.canal), ...precosProduto.map((l) => l.canal)])]);
  if (!canais.length) canais = ["sem_canal"]; // ainda mostra CMV e margem bruta do preço simulado; o aviso explica a falta das deduções
  const custo = dims.custo_confiavel ? custoTotalProduto(id, grafo) : null;
  return {
    produto: { id, nome: item.nome, situacao: item.situacao, custo_confiavel: dims.custo_confiavel },
    canais: canais.map((c) => {
      const oficial = precosProduto.find((l) => l.canal === c);
      return { canal: c, preco_oficial: oficial ? Number(oficial.preco) : null, origem_preco: oficial?.origem ?? null,
        ...simularPreco({ custo, preco: preco ?? (oficial ? Number(oficial.preco) : null), metaCmv, margemContribuicaoAlvo, condicao: condicoes.canais.find((x) => x.canal === c) ?? null }) };
    }),
    aviso: "Simulação: nenhum preço real é alterado. Margem de contribuição não é lucro líquido (faltam despesas fixas).",
  };
}

// ------------------------------------------------------------------ homologação revisada
export async function previaHomologacao({ organizacaoId }) {
  const { diag } = await contexto(organizacaoId);
  const itens = diag.produtos.map((p) => ({ id: p.id, nome: p.nome, tipo: p.tipo, situacao: p.situacao, homologacao: p.homologacao, ...elegibilidadeHomologacao(p) }));
  return {
    elegiveis: itens.filter((i) => i.elegivel),
    bloqueadas: itens.filter((i) => !i.elegivel && i.situacao !== "homologada" && i.homologacao !== "nao_aplicavel"),
    homologadas: itens.filter((i) => i.situacao === "homologada").length,
    padronizadas: itens.filter((i) => i.homologacao === "nao_aplicavel").length,
    // Já homologadas que HOJE não passariam: só relatadas para revisão (nunca revogadas automaticamente).
    homologadas_inconsistentes: homologadasComInconsistencia({ diag }),
  };
}

/** Homologa SÓ o que a prévia atual considera elegível; o resto volta com o motivo. Cada um passa pela regra existente. */
export async function homologarSelecionadas({ organizacaoId, ids, usuario }) {
  if (!Array.isArray(ids) || !ids.length) throw ApiError.badRequest("Selecione ao menos uma ficha.");
  if (ids.length > 500) throw ApiError.badRequest("No máximo 500 fichas por vez.");
  const previa = await previaHomologacao({ organizacaoId });
  const elegivel = new Map(previa.elegiveis.map((i) => [i.id, i]));
  const bloqueio = new Map(previa.bloqueadas.map((i) => [i.id, i]));
  const resultado = { homologadas: [], recusadas: [] };
  for (const id of [...new Set(ids)]) {
    if (!elegivel.has(id)) { resultado.recusadas.push({ id, motivo: bloqueio.get(id)?.motivos.join("; ") || "Não elegível nesta unidade." }); continue; }
    try { const r = await definirHomologacao({ organizacaoId, produtoId: id, acao: "homologar", usuario }); if (r.alterado) resultado.homologadas.push(id); }
    catch (e) { resultado.recusadas.push({ id, motivo: e.message }); }
  }
  return resultado;
}

// ------------------------------------------------------------------ preço oficial (D4)
export async function definirPrecoOficial({ organizacaoId, produtoId, body, usuario }) {
  const id = v.uuid(produtoId, "Produto");
  const b = body ?? {};
  const preco = Number(b.preco);
  if (!Number.isFinite(preco) || preco <= 0) throw ApiError.badRequest("Informe o preço praticado (maior que zero). O sistema não estima preço.");
  if (!["balcao", "ifood", "uber", "app", "outro"].includes(b.canal)) throw ApiError.badRequest("Canal inválido.");
  const origem = String(b.origem ?? "manual").trim().slice(0, 120);
  if (/media|promoc/i.test(origem.normalize("NFD").replace(/[̀-ͯ]/g, ""))) throw ApiError.badRequest("Preço médio de pedidos ou promocional não é preço oficial.");
  const { data: p } = await supabase.from("produtos").select("id, tipo, vendavel").eq("organizacao_id", organizacaoId).eq("id", id).maybeSingle();
  if (!p) throw ApiError.notFound("Produto não encontrado nesta unidade.");
  if (p.vendavel === false) throw ApiError.badRequest("Preparação intermediária não vendida não tem preço de venda.");
  const tabela = b.tabela ?? "A";
  const { data: antes } = await supabase.from("produto_precos").select("id, preco").eq("produto_id", id).eq("canal", b.canal).eq("tabela", tabela).maybeSingle();
  const linha = { preco, desatualizado: false, origem, vigente_desde: b.vigente_desde ?? new Date().toISOString().slice(0, 10), informado_por: usuario?.nome ?? usuario?.email ?? null, atualizado_em: new Date().toISOString() };
  const { error } = antes
    ? await supabase.from("produto_precos").update(linha).eq("id", antes.id)
    : await supabase.from("produto_precos").insert({ ...linha, produto_id: id, canal: b.canal, tabela });
  if (error) throw tabelaAusente(error) ? ApiError.badRequest("Origem/vigência de preço indisponível (migration 163 não aplicada).") : ApiError.badRequest(error.message);
  const { error: eH } = await supabase.from("produto_precos_historico").insert({ organizacao_id: organizacaoId, produto_id: id, canal: b.canal, tabela, preco_anterior: antes?.preco ?? null, preco_novo: preco, origem, vigente_desde: linha.vigente_desde, informado_por: linha.informado_por });
  if (eH) console.warn("[precos] histórico não registrado:", eH.message);
  return { produto_id: id, canal: b.canal, tabela, preco, origem };
}

// ------------------------------------------------------------------ Núcleo Mentorados (leitura)
/** Indicadores compactos para leitura futura pelo Núcleo Mentorados (sem alterar aquele módulo). */
export async function indicadoresMentoria({ organizacaoId }) {
  const s = await saude({ organizacaoId });
  const total = s.resumo.produtos_finais + s.resumo.preparacoes;
  const criticas = s.causas_raiz.filter((c) => c.criticidade === "critica");
  return {
    modelo: s.perfil.modelo, total_fichas: total,
    qualidade_pct: s.resumo.qualidade_pct,
    homologacao_pct: total ? (s.resumo.homologadas / total) * 100 : null,
    cobertura_precos_pct: s.precos.cobertura_pct,
    pendencias_criticas: criticas.length, insumos_sem_custo: s.resumo.insumos_sem_custo,
    ultima_atualizacao_custo: s.ultima_atualizacao_custo, evolucao: s.evolucao_correcoes,
    precisa_intervencao: total > 0 && ((s.resumo.qualidade_pct ?? 0) < 60 || criticas.length > 5),
  };
}
