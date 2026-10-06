// Configuração do Dashboard iFood de UMA unidade pelo SuperAdmin (migration
// 108) — produto SIMPLIFICADO (Checkpoint F): uma única opção,
// "Considerar Sanduíches + Saladas no Dashboard iFood".
//
//   ligada    -> o lançamento diário pede Sanduíches e Saladas separados e o
//                servidor soma os dois na linha consolidada da unidade. A
//                taxa de entregadores é SEMPRE da unidade (informada uma vez).
//   desligada -> formulário padrão de sempre. Dias já lançados com Sanduíches
//                + Saladas continuam como foram gravados (histórico imutável).
//
// O SuperAdmin não escolhe nomes, quantidade, ordem nem escopo: o sistema
// garante exatamente as duas fontes (CANAIS_SANDUICHES_SALADAS), reutilizando
// os MESMOS ids em toda reativação. Nada é detectado pelo nome da unidade e
// nenhuma unidade é ligada automaticamente.
//
// Por dentro continua a estrutura genérica e testada: dashboard_ifood_unidade_
// config + dashboard_ifood_canais, gravados numa ÚNICA chamada à RPC
// transacional `dashboard_ifood_salvar_config_unidade` (migration 108 §7.2),
// com concorrência otimista por `versao`, auditoria do que DE FATO mudou e
// Realtime só depois do commit. Este service nunca escreve direto nas tabelas.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import { MODULOS, modulosDaEmpresa, modulosDaUnidade } from "../../shared/modulos.js";
import { obterModeloLogistico } from "../dashboard-executivo/dashboardExecutivo.metas.service.js";
import { indicadorAplicavel } from "../dashboard-executivo/dashboardExecutivo.calc.js";
import { EVENTOS_DASHBOARD_IFOOD } from "../dashboard-executivo/dashboardExecutivo.eventos.js";
import { emitirEventoRealtime } from "../realtime/emitirEvento.js";
import { lerConfigECanais, objetoAusente, TABELA_VALORES_CANAIS } from "../dashboard-executivo/dashboardExecutivo.canaisRepo.js";
import { CANAIS_SANDUICHES_SALADAS } from "../dashboard-executivo/dashboardExecutivo.canais.js";

const PADRAO = Object.freeze({ estrutura: "padrao", taxasEntregadoresEscopo: "unidade" });

const RPC_VERSAO = "dashboard_ifood_config_versao";
const RPC_SALVAR = "dashboard_ifood_salvar_config_unidade";

// Erros da RPC de configuração (prefixo estável — ver migration 108, seção 7.2).
const STATUS_ERRO_RPC = { UNIDADE_NAO_ENCONTRADA: 404, CONFIG_DESATUALIZADA: 409 };
const MSG_CONFLITO = "A configuração do Dashboard iFood desta unidade foi alterada por outra pessoa depois que você abriu a tela. Recarregue para ver a versão atual antes de salvar de novo.";

function erroDaRpc(error) {
  if (objetoAusente(error)) return new ApiError(409, "A configuração de canais do Dashboard iFood ainda não está disponível neste ambiente (migration 108 não aplicada).");
  const [, codigo, texto] = /^([A-Z_]+):\s*(.*)$/s.exec(error?.message ?? "") ?? [];
  if (codigo === "CONFIG_DESATUALIZADA") return conflito();
  if (codigo) return new ApiError(STATUS_ERRO_RPC[codigo] ?? 400, texto || codigo, { codigo });
  return ApiError.internal(error?.message ?? "Falha ao gravar a configuração.");
}

function conflito() {
  const e = new ApiError(409, MSG_CONFLITO, { codigo: "CONFIG_DESATUALIZADA" });
  e.codigo = "CONFIG_DESATUALIZADA";
  return e;
}

/** Chave de comparação de nome — espelha `lower(btrim(nome))` do índice único. */
const chaveNome = (nome) => String(nome).trim().toLocaleLowerCase("pt-BR");

/** Ordem determinística: `ordem`, depois nome, depois id. */
function ordenarCanais(canais) {
  return canais.slice().sort((a, b) =>
    (Number(a.ordem) - Number(b.ordem))
    || String(a.nome).localeCompare(String(b.nome), "pt-BR")
    || String(a.id).localeCompare(String(b.id)));
}

function dependencias(deps) {
  return {
    db: deps.supabase ?? supabase,
    registrar: deps.auditar ?? auditar,
    emitir: deps.emitirEvento ?? emitirEventoRealtime,
    modulosEmpresa: deps.modulosDaEmpresa ?? modulosDaEmpresa,
    modulosUnidade: deps.modulosDaUnidade ?? modulosDaUnidade,
    modeloLogistico: deps.obterModeloLogistico ?? obterModeloLogistico,
  };
}

async function carregarUnidade(db, id) {
  const { data, error } = await db.from("unidades").select("id, nome, organizacao_id").eq("id", id).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!data) throw ApiError.notFound("Unidade não encontrada.");
  return data;
}

/**
 * Estado atual completo (sem criar nada). `migracaoPendente` = a migration 108
 * ainda não foi aplicada neste banco: a tela mostra o aviso e salvar é recusado.
 */
async function carregarEstado(d, unidade) {
  // Versão PRIMEIRO, linhas depois: se alguém salvar no meio, o cliente fica
  // com versão antiga + linhas novas e o próximo salvamento dá conflito (409)
  // — o lado seguro. O contrário (versão nova + linhas antigas) permitiria
  // sobrescrever sem perceber.
  const versaoRes = await d.db.rpc(RPC_VERSAO, { p_unidade_id: unidade.id });
  if (objetoAusente(versaoRes.error)) return { migracaoPendente: true };
  if (versaoRes.error) throw ApiError.internal(versaoRes.error.message);

  // Mesmo leitor do lançamento (tenant) — uma fonte só para config + canais.
  const lido = await lerConfigECanais({ unidadeId: unidade.id, db: d.db });
  if (lido.ausente) return { migracaoPendente: true };

  const canais = ordenarCanais(lido.canais);
  let comHistorico = new Set();
  if (canais.length) {
    const { data, error } = await d.db.from(TABELA_VALORES_CANAIS).select("canal_id").eq("unidade_id", unidade.id);
    if (error && !objetoAusente(error)) throw ApiError.internal(error.message);
    comHistorico = new Set((data ?? []).map((r) => r.canal_id));
  }
  const cfg = lido.config;
  return {
    migracaoPendente: false,
    versao: versaoRes.data,
    configurada: !!cfg,
    estrutura: cfg?.estrutura === "multicanal" ? "multicanal" : PADRAO.estrutura,
    taxasEntregadoresEscopo: cfg?.taxas_entregadores_escopo === "canal" ? "canal" : PADRAO.taxasEntregadoresEscopo,
    canais: canais.map((c) => ({ id: c.id, nome: c.nome, ordem: c.ordem, ativo: c.ativo !== false, possuiHistorico: comHistorico.has(c.id) })),
  };
}

/** Status do módulo `ifood_dashboard` — leitura do estado REAL (empresa ∩ unidade), nunca um flag próprio. */
async function statusModulo(d, unidade) {
  const [daEmpresa, daUnidade] = await Promise.all([d.modulosEmpresa(unidade.organizacao_id), d.modulosUnidade(unidade.id)]);
  const disponivelNaEmpresa = daEmpresa.includes(MODULOS.IFOOD_DASHBOARD);
  const habilitadoNaUnidade = daUnidade.includes(MODULOS.IFOOD_DASHBOARD);
  return { id: MODULOS.IFOOD_DASHBOARD, disponivelNaEmpresa, habilitadoNaUnidade, ativo: disponivelNaEmpresa && habilitadoNaUnidade };
}

/** Modelo logístico VIGENTE hoje (linha do tempo existente) e se entregadores se aplica a ele. */
async function modeloVigente(d, unidade) {
  const m = await d.modeloLogistico({ unidadeId: unidade.id, organizacaoId: unidade.organizacao_id });
  return { modeloLogistico: m.modeloLogistico, modeloLogisticoRotulo: m.modeloLogisticoRotulo ?? m.modeloLogistico, entregadoresAplicavel: indicadorAplicavel(m.modeloLogistico, "taxas_entregadores") };
}

async function montarResposta(d, unidade) {
  const [estado, modulo, modelo] = await Promise.all([carregarEstado(d, unidade), statusModulo(d, unidade), modeloVigente(d, unidade)]);
  return {
    unidadeId: unidade.id, unidadeNome: unidade.nome, organizacaoId: unidade.organizacao_id,
    modulo, ...modelo,
    ...(estado.migracaoPendente
      ? { migracaoPendente: true, configurada: false, ...PADRAO, canais: [] }
      : estado),
    // A opção única da tela: multicanal = "Sanduíches + Saladas".
    sanduichesSaladas: !estado.migracaoPendente && estado.estrutura === "multicanal",
  };
}

// --------------------------------------------------------------------------
// GET /plataforma/unidades/:id/dashboard-ifood
// --------------------------------------------------------------------------
export async function obterConfigDashboardIfood(idBruto, deps = {}) {
  const d = dependencias(deps);
  const unidade = await carregarUnidade(d.db, v.uuid(idBruto, "Unidade"));
  return montarResposta(d, unidade);
}

// --------------------------------------------------------------------------
// PUT /plataforma/unidades/:id/dashboard-ifood
// Corpo: { sanduichesSaladas: boolean, versao: string }
// --------------------------------------------------------------------------

/**
 * O que gravar para ligar/desligar "Sanduíches + Saladas" — PURA (sem I/O),
 * exportada para teste direto.
 *
 * Ligar: estrutura multicanal, escopo de entregadores = unidade e exatamente
 * Sanduíches + Saladas ATIVOS, reaproveitando o canal existente de mesmo nome
 * (sem diferenciar maiúsculas) — mesmo id em toda reativação. Qualquer outro
 * canal que exista por histórico fica INATIVO (nunca apagado: a migration
 * proíbe e o histórico dele continua consultável).
 * Desligar: estrutura padrão; canais intocados.
 * @param {{estrutura: string, taxasEntregadoresEscopo: string, canais: Array<{id: string, nome: string, ordem: number, ativo: boolean}>}} atual
 * @param {boolean} ligar
 */
export function planejarSanduichesSaladas(atual, ligar) {
  if (!ligar) {
    return { estrutura: "padrao", escopo: "unidade", canais: null, mudou: atual.estrutura !== "padrao" };
  }
  const usados = new Set();
  const canais = CANAIS_SANDUICHES_SALADAS.map((nome) => {
    const existente = atual.canais.find((c) => !usados.has(c.id) && chaveNome(c.nome) === chaveNome(nome));
    if (existente) usados.add(existente.id);
    return existente ? { id: existente.id, nome, ativo: true } : { nome, ativo: true };
  });
  const outros = atual.canais.filter((c) => !usados.has(c.id)).map((c) => ({ id: c.id, nome: c.nome, ativo: false }));
  const desejados = [...canais, ...outros];
  const mesmosCanais = desejados.length === atual.canais.length && desejados.every((d, i) => {
    const a = atual.canais[i];
    return d.id && a && a.id === d.id && a.nome === d.nome && a.ativo === d.ativo && Number(a.ordem) === i;
  });
  const mudou = atual.estrutura !== "multicanal" || atual.taxasEntregadoresEscopo !== "unidade" || !mesmosCanais;
  return { estrutura: "multicanal", escopo: "unidade", canais: desejados, mudou };
}

/**
 * Liga/desliga "Sanduíches + Saladas" de forma atômica (RPC
 * `dashboard_ifood_salvar_config_unidade`): fontes + estrutura + escopo numa
 * única transação — ou tudo persiste, ou nada.
 *
 * Concorrência otimista: `body.versao` (devolvida pelo GET) é obrigatória;
 * tela desatualizada -> 409 (CONFIG_DESATUALIZADA), nunca sobrescrita
 * silenciosa. A RPC confere de novo sob lock.
 *
 * Ordem garantida: gravação confirmada -> auditoria (do que a RPC devolveu
 * como EFETIVAMENTE aplicado) -> Realtime. Em qualquer falha, nada é
 * auditado nem emitido.
 * @param {import('express').Request} req
 */
export async function salvarConfigDashboardIfood(req, idBruto, body, deps = {}) {
  const d = dependencias(deps);
  const unidade = await carregarUnidade(d.db, v.uuid(idBruto, "Unidade"));
  const estado = await carregarEstado(d, unidade);
  if (estado.migracaoPendente) {
    throw new ApiError(409, "A opção Sanduíches + Saladas ainda não está disponível neste ambiente (migration 108 não aplicada).");
  }

  const b = v.corpo(body);
  if (typeof b.sanduichesSaladas !== "boolean") throw ApiError.badRequest("Informe se a unidade considera Sanduíches + Saladas (sanduichesSaladas: true/false).");
  const versao = v.texto(b.versao, "Versão da configuração (recarregue a tela)", { min: 1, max: 100 });
  if (versao !== estado.versao) throw conflito();

  const plano = planejarSanduichesSaladas(estado, b.sanduichesSaladas);
  if (!plano.mudou) return { ...(await montarResposta(d, unidade)), alterado: false };

  const { data: aplicado, error } = await d.db.rpc(RPC_SALVAR, {
    p_unidade_id: unidade.id,
    p_organizacao_id: unidade.organizacao_id,
    p_versao: versao,
    p_estrutura: plano.estrutura,
    p_escopo: plano.escopo,
    p_canais: plano.canais ? plano.canais.map((c) => ({ ...(c.id ? { id: c.id } : {}), nome: c.nome, ativo: c.ativo })) : null,
    p_usuario_id: req.user?.id ?? null,
    p_usuario_nome: req.user?.nome ?? null,
    p_usuario_email: req.user?.email ?? null,
  });
  if (error) throw erroDaRpc(error);

  // --- daqui para baixo a gravação JÁ foi confirmada pelo banco ---
  const orgId = unidade.organizacao_id;
  const base = {
    atorId: req.user?.id ?? null, atorEmail: req.user?.email ?? null, atorTipo: "superadmin",
    entidade: "unidade", entidadeId: unidade.id, organizacaoId: orgId, ...origemDe(req),
  };
  const registrar = (acao, detalhes) => d.registrar({ ...base, acao, detalhes: { unidade: unidade.nome, modalidade: "sanduiches_saladas", ...detalhes } });
  const a = aplicado ?? {};
  if (a.estrutura) await registrar(ACOES.UNIDADE_DASHBOARD_IFOOD_ESTRUTURA, { de: a.estrutura.de, para: a.estrutura.para, sanduichesSaladas: a.estrutura.para === "multicanal" });
  if (a.escopo) await registrar(ACOES.UNIDADE_DASHBOARD_IFOOD_ENTREGADORES, { de: a.escopo.de, para: a.escopo.para });
  for (const c of a.criados ?? []) await registrar(ACOES.UNIDADE_DASHBOARD_IFOOD_CANAL_CRIADO, { canalId: c.id, nome: c.nome, ativo: c.ativo });
  for (const r of a.renomeados ?? []) await registrar(ACOES.UNIDADE_DASHBOARD_IFOOD_CANAL_RENOMEADO, { canalId: r.id, de: r.de, para: r.para });
  for (const c of a.ativados ?? []) await registrar(ACOES.UNIDADE_DASHBOARD_IFOOD_CANAL_ATIVADO, { canalId: c.id, nome: c.nome });
  for (const c of a.desativados ?? []) await registrar(ACOES.UNIDADE_DASHBOARD_IFOOD_CANAL_DESATIVADO, { canalId: c.id, nome: c.nome });

  // Payload mínimo (ids/versão) — quem estiver com o Dashboard aberto refaz o fetch.
  await d.emitir({
    tipo: EVENTOS_DASHBOARD_IFOOD.ESTRUTURA_ATUALIZADA,
    organizacaoId: orgId, unidadeId: unidade.id, entidadeId: unidade.id, versao: new Date().toISOString(),
  });

  return { ...(await montarResposta(d, unidade)), alterado: true };
}

/** @param {import('express').Request} req */
function origemDe(req) {
  const encaminhado = req.headers?.["x-forwarded-for"];
  const ip = (Array.isArray(encaminhado) ? encaminhado[0] : encaminhado)?.split(",")[0]?.trim()
    || req.socket?.remoteAddress || null;
  return { ip, userAgent: (typeof req.header === "function" ? req.header("user-agent") : null) || null };
}
