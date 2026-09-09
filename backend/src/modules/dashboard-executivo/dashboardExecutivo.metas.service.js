// Resolução de metas de rentabilidade — cascata unidade > organização > global,
// agora também filtrada pelo MODELO LOGÍSTICO do iFood da unidade (Marketplace
// x Full Service — cada um tem metas bem diferentes). Metas ficam centralizadas
// em `metas_indicadores` (migration 023/024) para não se espalharem/duplicarem
// pelo código.
//
// Este arquivo também guarda o modelo logístico de cada unidade
// (unidades.modelo_logistico_ifood, migration 024) e a auditoria da troca
// (unidade_modelo_logistico_historico) — mora aqui porque é o mesmo conceito
// de "configuração que decide qual meta vale", não um domínio à parte.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { MODELOS_LOGISTICOS, ROTULO_MODELO } from "./dashboardExecutivo.calc.js";

export const INDICADORES = ["taxas_comissoes", "servicos_promocoes", "taxas_entregadores", "total_deducoes"];

/**
 * Resolve as metas efetivas para uma unidade, em cascata: linha específica da
 * unidade -> linha da organização (unidade_id null) -> linha global (ambos
 * null) — sempre restrita ao MODELO LOGÍSTICO informado. `meta_ideal`/`limite`
 * são gravados como fração (0.2050) e aqui já saem convertidos para
 * porcentagem (0-100), a escala que `dashboardExecutivo.calc.js` usa.
 * @param {{organizacaoId: string, unidadeId: string, modeloLogistico: string}} p
 * @returns {Promise<Record<string, {metaIdeal: number, limite: number}>>}
 */
export async function resolverMetas({ organizacaoId, unidadeId, modeloLogistico }) {
  const { data, error } = await supabase
    .from("metas_indicadores")
    .select("organizacao_id, unidade_id, indicador, meta_ideal, limite")
    .eq("modelo_logistico", modeloLogistico)
    .or(`unidade_id.eq.${unidadeId},and(unidade_id.is.null,organizacao_id.eq.${organizacaoId}),and(unidade_id.is.null,organizacao_id.is.null)`);

  if (error) throw ApiError.internal(error.message);
  return escolherMetas(data ?? [], { organizacaoId, unidadeId });
}

/**
 * Cascata PURA unidade > organização > global sobre linhas de
 * `metas_indicadores` já filtradas por modelo logístico. Fonte única da regra:
 * `resolverMetas` (uma unidade) e o lote do Painel Administrativo
 * (`administrativo.service.js#lucratividadeSemanal`) chamam esta função.
 * `meta_ideal`/`limite` são fração no banco (0.2050) e saem em % (0–100).
 * @param {Array<{organizacao_id: string|null, unidade_id: string|null, indicador: string, meta_ideal: number, limite: number}>} linhas
 * @param {{organizacaoId: string, unidadeId: string}} alvo
 * @returns {Record<string, {metaIdeal: number, limite: number}>}
 */
export function escolherMetas(linhas, { organizacaoId, unidadeId }) {
  // Prioridade: unidade (3) > organização (2) > global (1). Mantém a de maior.
  const prioridade = (l) => (l.unidade_id ? 3 : l.organizacao_id ? 2 : 1);
  const aplica = (l) =>
    l.unidade_id === unidadeId
    || (l.unidade_id == null && l.organizacao_id === organizacaoId)
    || (l.unidade_id == null && l.organizacao_id == null);

  const porIndicador = new Map();
  for (const linha of linhas ?? []) {
    if (!aplica(linha)) continue;
    const atual = porIndicador.get(linha.indicador);
    if (!atual || prioridade(linha) > prioridade(atual)) porIndicador.set(linha.indicador, linha);
  }

  /** @type {Record<string, {metaIdeal: number, limite: number}>} */
  const resultado = {};
  for (const indicador of INDICADORES) {
    const linha = porIndicador.get(indicador);
    if (!linha) continue;
    resultado[indicador] = { metaIdeal: Number(linha.meta_ideal) * 100, limite: Number(linha.limite) * 100 };
  }
  return resultado;
}

// ---------------------------------------------------------------------------
// MODELO LOGÍSTICO DA UNIDADE (Marketplace x Full Service)
// ---------------------------------------------------------------------------

/**
 * `organizacaoId` é defesa em profundidade: todo caminho que chega aqui já
 * passou por `resolverUnidadeAlvo` (que valida a unidade contra o tenant),
 * mas a função não deve depender só disso — filtra de novo na própria query.
 * @param {{unidadeId: string, organizacaoId: string}} p
 * @returns {Promise<{unidadeId: string, organizacaoId: string, nome: string, modeloLogistico: string, modeloLogisticoRotulo: string, ehTeste: boolean}>}
 */
export async function obterModeloLogistico({ unidadeId, organizacaoId }) {
  const { data, error } = await supabase
    .from("unidades").select("id, organizacao_id, nome, modelo_logistico_ifood, eh_teste")
    .eq("id", unidadeId).eq("organizacao_id", organizacaoId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!data) throw ApiError.notFound("Unidade não encontrada.");
  return {
    unidadeId: data.id,
    organizacaoId: data.organizacao_id,
    nome: data.nome,
    modeloLogistico: data.modelo_logistico_ifood,
    modeloLogisticoRotulo: ROTULO_MODELO[data.modelo_logistico_ifood] ?? data.modelo_logistico_ifood,
    ehTeste: data.eh_teste === true,
  };
}

/**
 * Troca o modelo logístico do iFood de uma unidade. Sempre grava uma linha em
 * `unidade_modelo_logistico_historico` — mesmo se o modelo "novo" for igual
 * ao atual, o pedido de troca fica registrado (evita erro de digitação
 * silenciosa achando que mudou e não mudou nada).
 * @param {{unidadeId: string, organizacaoId: string, modeloNovo: unknown, usuario: {id?: string, nome?: string, email?: string}, motivo?: unknown, observacao?: unknown}} p
 */
export async function definirModeloLogistico({ unidadeId, organizacaoId, modeloNovo: modeloNovoBruto, usuario, motivo, observacao }) {
  const modeloNovo = v.umDe(modeloNovoBruto, "Modelo logístico", MODELOS_LOGISTICOS);

  const { data: unidade, error: eUni } = await supabase
    .from("unidades").select("id, organizacao_id, modelo_logistico_ifood").eq("id", unidadeId).eq("organizacao_id", organizacaoId).maybeSingle();
  if (eUni) throw ApiError.internal(eUni.message);
  if (!unidade) throw ApiError.notFound("Unidade não encontrada.");

  const modeloAnterior = unidade.modelo_logistico_ifood;

  const { error: eUpd } = await supabase
    .from("unidades").update({ modelo_logistico_ifood: modeloNovo }).eq("id", unidadeId).eq("organizacao_id", organizacaoId);
  if (eUpd) throw ApiError.badRequest(eUpd.message);

  const { error: eHist } = await supabase.from("unidade_modelo_logistico_historico").insert({
    unidade_id: unidadeId,
    organizacao_id: organizacaoId,
    modelo_anterior: modeloAnterior,
    modelo_novo: modeloNovo,
    usuario_id: usuario?.id ?? null,
    usuario_nome: usuario?.nome ?? null,
    usuario_email: usuario?.email ?? null,
    motivo: v.textoOpcional(motivo, "Motivo", { max: 500 }),
    observacao: v.textoOpcional(observacao, "Observação", { max: 500 }),
  });
  if (eHist) console.error("[dashboard-executivo] falha ao registrar histórico de modelo logístico:", eHist.message);

  return {
    unidadeId, modeloAnterior, modeloNovo,
    modeloLogisticoRotulo: ROTULO_MODELO[modeloNovo] ?? modeloNovo,
    mudou: modeloAnterior !== modeloNovo,
  };
}

/** @param {{unidadeId: string, organizacaoId: string}} p */
export async function historicoModeloLogistico({ unidadeId, organizacaoId }) {
  const { data, error } = await supabase
    .from("unidade_modelo_logistico_historico")
    .select("modelo_anterior, modelo_novo, usuario_nome, usuario_email, motivo, observacao, created_at")
    .eq("unidade_id", unidadeId)
    .eq("organizacao_id", organizacaoId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw ApiError.internal(error.message);
  return (data ?? []).map((r) => ({
    modeloAnterior: r.modelo_anterior,
    modeloAnteriorRotulo: r.modelo_anterior ? (ROTULO_MODELO[r.modelo_anterior] ?? r.modelo_anterior) : null,
    modeloNovo: r.modelo_novo,
    modeloNovoRotulo: ROTULO_MODELO[r.modelo_novo] ?? r.modelo_novo,
    usuarioNome: r.usuario_nome, usuarioEmail: r.usuario_email,
    motivo: r.motivo, observacao: r.observacao,
    createdAt: r.created_at,
  }));
}
