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
//
// O modelo é TEMPORAL (migration 089): `unidades.modelo_logistico_ifood` é só o
// modelo VIGENTE HOJE; o que vale numa data passada vem dos pontos de troca
// datados em `unidade_modelo_logistico_historico.vigencia_inicio` (ver
// dashboardExecutivo.modeloTemporal.js). Quem interpreta um dado com data
// deve usar `obterModeloLogisticoNaData` / `linhaDoTempo`, nunca o valor atual.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { MODELOS_LOGISTICOS, ROTULO_MODELO, hojeIsoBrasil } from "./dashboardExecutivo.calc.js";
import {
  trocasDeLinhas, montarLinhaDoTempo, modeloNaData, validarNovaTroca,
} from "./dashboardExecutivo.modeloTemporal.js";

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

/** Coluna da migration 089 ainda não aplicada (deploy do backend antes do SQL). */
const colunaVigenciaAusente = (error) => error?.code === "42703" || /vigencia_inicio/i.test(error?.message ?? "");

/**
 * Pontos de troca DATADOS de uma ou mais unidades (migration 089), em ordem.
 * Tolerante a ambiente sem a migration: sem a coluna, devolve vazio — o
 * comportamento é o anterior (um único modelo, o atual). `estrito` (usado na
 * gravação) transforma essa ausência em erro claro.
 * @param {{unidadeIds: string[], organizacaoId?: string|null, estrito?: boolean}} p
 * @returns {Promise<Map<string, import("./dashboardExecutivo.modeloTemporal.js").TrocaModelo[]>>}
 */
export async function carregarTrocasModelo({ unidadeIds, organizacaoId = null, estrito = false }) {
  const porUnidade = new Map();
  if (!unidadeIds?.length) return porUnidade;
  let q = supabase
    .from("unidade_modelo_logistico_historico")
    .select("unidade_id, vigencia_inicio, modelo_anterior, modelo_novo")
    .in("unidade_id", unidadeIds)
    .not("vigencia_inicio", "is", null)
    .order("vigencia_inicio", { ascending: true });
  if (organizacaoId) q = q.eq("organizacao_id", organizacaoId);
  const { data, error } = await q;
  if (error) {
    if (colunaVigenciaAusente(error) && !estrito) return porUnidade;
    if (colunaVigenciaAusente(error)) {
      throw ApiError.internal("O histórico de modelo logístico com vigência requer a migration 089 (ainda não aplicada neste banco).");
    }
    throw ApiError.internal(error.message);
  }
  const agrupadas = new Map();
  for (const r of data ?? []) {
    if (!agrupadas.has(r.unidade_id)) agrupadas.set(r.unidade_id, []);
    agrupadas.get(r.unidade_id).push(r);
  }
  for (const [id, linhas] of agrupadas) porUnidade.set(id, trocasDeLinhas(linhas));
  return porUnidade;
}

/**
 * `organizacaoId` é defesa em profundidade: todo caminho que chega aqui já
 * passou por `resolverUnidadeAlvo` (que valida a unidade contra o tenant),
 * mas a função não deve depender só disso — filtra de novo na própria query.
 *
 * `modeloLogistico` é o modelo VIGENTE HOJE. `linhaDoTempo` traz os períodos de
 * vigência (cobre todo o tempo) — é ela, e não `modeloLogistico`, que deve
 * interpretar qualquer dado com data.
 * @param {{unidadeId: string, organizacaoId: string}} p
 * @returns {Promise<{unidadeId: string, organizacaoId: string, nome: string, modeloLogistico: string, modeloLogisticoRotulo: string, ehTeste: boolean, linhaDoTempo: import("./dashboardExecutivo.modeloTemporal.js").PeriodoModelo[]}>}
 */
export async function obterModeloLogistico({ unidadeId, organizacaoId }) {
  const { data, error } = await supabase
    .from("unidades").select("id, organizacao_id, nome, modelo_logistico_ifood, eh_teste")
    .eq("id", unidadeId).eq("organizacao_id", organizacaoId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!data) throw ApiError.notFound("Unidade não encontrada.");
  const trocas = (await carregarTrocasModelo({ unidadeIds: [unidadeId], organizacaoId })).get(unidadeId) ?? [];
  const linhaDoTempo = montarLinhaDoTempo({ modeloAtual: data.modelo_logistico_ifood, trocas });
  // Com trocas datadas a linha do tempo é a fonte do modelo vigente hoje.
  const modeloVigente = modeloNaData(linhaDoTempo, hojeIsoBrasil());
  return {
    unidadeId: data.id,
    organizacaoId: data.organizacao_id,
    nome: data.nome,
    modeloLogistico: modeloVigente,
    modeloLogisticoRotulo: ROTULO_MODELO[modeloVigente] ?? modeloVigente,
    ehTeste: data.eh_teste === true,
    linhaDoTempo,
  };
}

/**
 * Modelo logístico da unidade NUMA DATA (AAAA-MM-DD): o modelo vigente naquele
 * dia, não o atual. Regra: `vigencia_inicio <= data AND (fim IS NULL OR fim >= data)`.
 * @param {{unidadeId: string, organizacaoId: string, data: string}} p
 * @returns {Promise<{unidadeId: string, data: string, modeloLogistico: string, modeloLogisticoRotulo: string}>}
 */
export async function obterModeloLogisticoNaData({ unidadeId, organizacaoId, data }) {
  const dia = v.dataOpcional(data, "Data");
  if (!dia) throw ApiError.badRequest("Data é obrigatória.");
  const { linhaDoTempo } = await obterModeloLogistico({ unidadeId, organizacaoId });
  const modelo = modeloNaData(linhaDoTempo, dia);
  return { unidadeId, data: dia, modeloLogistico: modelo, modeloLogisticoRotulo: ROTULO_MODELO[modelo] ?? modelo };
}

/**
 * Troca o modelo logístico do iFood de uma unidade A PARTIR DE UMA DATA
 * (`vigenciaInicio`, obrigatória e explícita — nunca uma troca retroativa
 * silenciosa). Os dados anteriores à data continuam interpretados pelo modelo
 * que valia neles (ver dashboardExecutivo.modeloTemporal.js).
 *
 * Só se aceita uma troca DEPOIS da última já registrada (nada de reescrever
 * períodos passados) e nunca no futuro (`unidades.modelo_logistico_ifood`, o
 * "modelo de hoje", não tem agendador). Se o modelo pedido já é o vigente, não
 * há período novo: grava só a linha de auditoria do pedido (comportamento antigo).
 * @param {{unidadeId: string, organizacaoId: string, modeloNovo: unknown, vigenciaInicio: unknown, usuario: {id?: string, nome?: string, email?: string}, motivo?: unknown, observacao?: unknown, hojeIso?: string}} p
 */
export async function definirModeloLogistico({
  unidadeId, organizacaoId, modeloNovo: modeloNovoBruto, modeloAnterior: modeloAnteriorBruto, vigenciaInicio: vigenciaBruta,
  usuario, motivo, observacao, hojeIso = hojeIsoBrasil(),
}) {
  const modeloNovo = v.umDe(modeloNovoBruto, "Modelo logístico", MODELOS_LOGISTICOS);
  // Opcional: só para DECLARAR desde quando o modelo atual vale (ver validarNovaTroca).
  const modeloAnteriorInformado = v.umDeOpcional(modeloAnteriorBruto, "Modelo anterior", MODELOS_LOGISTICOS, null);
  const vigenciaInicio = v.dataOpcional(vigenciaBruta, "Data de vigência");
  if (!vigenciaInicio) throw ApiError.badRequest("Informe a data a partir da qual o novo modelo logístico passa a valer.");

  const { data: unidade, error: eUni } = await supabase
    .from("unidades").select("id, organizacao_id, modelo_logistico_ifood").eq("id", unidadeId).eq("organizacao_id", organizacaoId).maybeSingle();
  if (eUni) throw ApiError.internal(eUni.message);
  if (!unidade) throw ApiError.notFound("Unidade não encontrada.");

  const trocas = (await carregarTrocasModelo({ unidadeIds: [unidadeId], organizacaoId, estrito: true })).get(unidadeId) ?? [];
  const linhaDoTempo = montarLinhaDoTempo({ modeloAtual: unidade.modelo_logistico_ifood, trocas });
  const { mudou, modeloAnterior, historica } = validarNovaTroca({
    linhaDoTempo, trocas, modeloNovo, modeloAnterior: modeloAnteriorInformado, vigenciaInicio, hojeIso,
  });

  const auditoria = {
    unidade_id: unidadeId,
    organizacao_id: organizacaoId,
    modelo_anterior: modeloAnterior,
    modelo_novo: modeloNovo,
    usuario_id: usuario?.id ?? null,
    usuario_nome: usuario?.nome ?? null,
    usuario_email: usuario?.email ?? null,
    motivo: v.textoOpcional(motivo, "Motivo", { max: 500 }),
    observacao: v.textoOpcional(observacao, "Observação", { max: 500 }),
  };
  const resposta = {
    unidadeId, modeloAnterior, modeloNovo,
    modeloLogisticoRotulo: ROTULO_MODELO[modeloNovo] ?? modeloNovo,
    mudou,
    // true = declaração de "desde quando o modelo atual vale" (o modelo de hoje não muda).
    declaracaoHistorica: historica,
    vigenciaInicio: mudou ? vigenciaInicio : null,
    retroativa: mudou && vigenciaInicio < hojeIso,
  };

  if (!mudou) {
    // Pedido registrado, mas sem período novo (linha de auditoria sem vigência).
    const { error } = await supabase.from("unidade_modelo_logistico_historico").insert(auditoria);
    if (error) console.error("[dashboard-executivo] falha ao registrar histórico de modelo logístico:", error.message);
    return resposta;
  }

  // 1º o ponto de troca (o trigger da 089 barra vigência inconsistente), 2º o modelo "de hoje".
  const { data: criada, error: eHist } = await supabase
    .from("unidade_modelo_logistico_historico").insert({ ...auditoria, vigencia_inicio: vigenciaInicio }).select("id").single();
  if (eHist) {
    if (eHist.code === "23514" || eHist.code === "23505") throw ApiError.badRequest(eHist.message);
    throw ApiError.internal(eHist.message);
  }

  const { error: eUpd } = await supabase
    .from("unidades").update({ modelo_logistico_ifood: modeloNovo }).eq("id", unidadeId).eq("organizacao_id", organizacaoId);
  if (eUpd) {
    // Desfaz o ponto de troca: não deixa a história e o modelo de hoje divergirem.
    await supabase.from("unidade_modelo_logistico_historico").delete().eq("id", criada.id);
    throw ApiError.badRequest(eUpd.message);
  }
  return resposta;
}

/** @param {{unidadeId: string, organizacaoId: string}} p */
export async function historicoModeloLogistico({ unidadeId, organizacaoId }) {
  const { data, error } = await supabase
    .from("unidade_modelo_logistico_historico")
    .select("modelo_anterior, modelo_novo, usuario_nome, usuario_email, motivo, observacao, created_at, vigencia_inicio")
    .eq("unidade_id", unidadeId)
    .eq("organizacao_id", organizacaoId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    if (!colunaVigenciaAusente(error)) throw ApiError.internal(error.message);
    // Ambiente sem a migration 089: histórico sem vigência (comportamento anterior).
    const legado = await supabase
      .from("unidade_modelo_logistico_historico")
      .select("modelo_anterior, modelo_novo, usuario_nome, usuario_email, motivo, observacao, created_at")
      .eq("unidade_id", unidadeId).eq("organizacao_id", organizacaoId)
      .order("created_at", { ascending: false }).limit(100);
    if (legado.error) throw ApiError.internal(legado.error.message);
    return mapearHistorico(legado.data);
  }
  return mapearHistorico(data);
}

function mapearHistorico(linhas) {
  return (linhas ?? []).map((r) => ({
    modeloAnterior: r.modelo_anterior,
    modeloAnteriorRotulo: r.modelo_anterior ? (ROTULO_MODELO[r.modelo_anterior] ?? r.modelo_anterior) : null,
    modeloNovo: r.modelo_novo,
    modeloNovoRotulo: ROTULO_MODELO[r.modelo_novo] ?? r.modelo_novo,
    usuarioNome: r.usuario_nome, usuarioEmail: r.usuario_email,
    motivo: r.motivo, observacao: r.observacao,
    vigenciaInicio: r.vigencia_inicio ?? null,
    createdAt: r.created_at,
  }));
}
