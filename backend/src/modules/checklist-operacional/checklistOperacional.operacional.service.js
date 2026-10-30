// Dashboard Operacional 2.0 — orquestração: projeção incremental, lista de pedidos, Ficha 360°, fechamento diário e
// simulação de WhatsApp. Tenant SEMPRE do Context Token. Nada aqui chama o iFood, o poller, o ACK ou o WhatsApp real.
//
// PROJEÇÃO SOB DEMANDA (incremental): antes de ler a camada analítica de uma janela, compara ifood_pedidos.atualizado_em e os
// eventos recebidos depois da última projeção; só os pedidos que mudaram são reprojetados (lendo o JSON bruto). Os demais saem
// direto de operacional_pedidos. A mesma função serve à reconstrução histórica (`forcar`).
//
// FECHAMENTO: tempos, atrasos e horários vêm de obterDashboard (o MESMO cálculo da tela, para a mesma competência);
// cancelamentos oficiais, descontos e clientes vêm da projeção; disputas de ifood_disputas. A gravação é versionada e
// serializada no banco (operacional_fechamento_registrar).

import { randomUUID } from "node:crypto";
import * as repoChecklist from "./checklistOperacional.repository.js";
import * as repoOperacional from "./checklistOperacional.operacional.repository.js";
import { obterDashboard, fusoDaUnidade } from "./checklistOperacional.service.js";
import { resolverFuso as regraFuso, resolverPeriodoDaUnidade, hojeDaUnidade, fusoDoInstante } from "./checklistOperacional.fuso.js";
import { simularNotificacaoFechamento } from "../notificacoes/notificacoes.fechamento.js";
import * as repoNotificacoes from "../notificacoes/notificacoes.repository.js";
import { projetarPedido, REGRA_PROJECAO } from "./checklistOperacional.projecao.js";
import { calcularFechamento, hashDoConteudo, janelaDaCompetencia, STATUS_FECHAMENTO, REGRA_FECHAMENTO } from "./checklistOperacional.fechamento.js";
import { gerarDiagnostico } from "./checklistOperacional.diagnostico.js";
import { redigirDiagnostico } from "./checklistOperacional.redacao.js";
import { montarFicha, itemDaLista } from "./checklistOperacional.ficha.js";
import { gerarMensagem, validarMensagem, chaveSimulacao, criarTransporte, STATUS_SIMULACAO, TRANSPORTE_SIMULADO } from "./checklistOperacional.whatsapp.js";
import { resolverPeriodo, dataValida, hojeNoFuso } from "./checklistOperacional.periodos.js";
import { linhaDoTempoDasMetas } from "./checklistOperacional.metas.js";
import { enviarMensagem } from "../agente/agente.provider.js";
import { reservarQuotaAgente, registrarUso } from "../agente/agente.uso.service.js";
import { calcularCustoUso } from "../agente/agente.pricing.js";
import { ApiError } from "../../shared/ApiError.js";

/**
 * Infraestrutura de IA do Agente Crescer (mesmo provider, mesma reserva de cota, mesmo registro de custo por organização).
 * Só é usada com OPERACIONAL_DIAGNOSTICO_IA_ENABLED=true; sem isso a redação é determinística (checklistOperacional.redacao.js).
 */
export const IA_PADRAO = Object.freeze({
  enviarMensagem,
  reservarQuota: reservarQuotaAgente,
  registrarUso: ({ organizacaoId, unidadeId, model, usage, durationMs }) => {
    const u = usage ?? {};
    const custo = calcularCustoUso({ model, ...u });
    return registrarUso({
      organizacaoId, unidadeId, conversaId: null, usuarioId: null, provider: "anthropic", model, pricingVersion: custo.pricingVersion,
      inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheCreationTokens: u.cacheCreationTokens, cacheReadTokens: u.cacheReadTokens,
      estimatedCostUsd: custo.estimatedCostUsd, toolCallsCount: 0, toolsUsed: ["fechamento_operacional"], durationMs, success: true,
    });
  },
});

const FOLGA_MS = 48 * 3_600_000;   // pedidos que atravessam a meia-noite / chegam tarde ao banco
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const dep = (deps) => ({ repo: deps.repo ?? repoChecklist, op: deps.op ?? repoOperacional });
const indisponivel = (e) => {
  if (e?.codigo === "OPERACIONAL_INDISPONIVEL") { const x = new ApiError(503, e.message); x.codigo = e.codigo; throw x; }
  throw e;
};

/**
 * Fuso (D-15): regra única em checklistOperacional.fuso.js. Sem argumentos = fuso da plataforma (comportamento anterior).
 * A origem é gravada em cada fechamento ("unidade" | "padrao_plataforma").
 */
export function resolverFuso(p = {}) { return regraFuso(p); }

/** Competência de ONTEM da unidade, no fuso que a regra manda usar (agendador). */
export async function competenciaDeOntem({ organizacaoId, unidadeId, agoraMs, deps = {} }) {
  const fusoUnidade = await fusoDaUnidade(dep(deps).repo, { organizacaoId, unidadeId });
  const { hoje } = hojeDaUnidade({ agoraMs, fusoUnidade });
  const d = new Date(Date.parse(hoje + "T12:00:00Z") - 86_400_000);
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------------------------------------------------------------
// Projeção
// ------------------------------------------------------------------------------------------------------------------------

/**
 * Garante a projeção atualizada dos pedidos do tenant registrados em [desde, ate) e devolve as linhas atuais.
 * @returns {Promise<{linhas: object[], reprojetados: number, inalterados: number, falhas: number}>}
 */
export async function sincronizarProjecao({ organizacaoId, unidadeId, desdeIso, ateIso, forcar = false, agora = () => new Date(), deps = {} }) {
  const { op } = dep(deps);
  const fontes = await op.listarVersoesDaFonte({ organizacaoId, unidadeId, desdeIso, ateIso });
  const ids = fontes.map((f) => f.order_id);
  if (!ids.length) return { linhas: [], reprojetados: 0, inalterados: 0, falhas: 0 };

  const atuais = new Map((await op.listarProjetadoEm({ organizacaoId, unidadeId, orderIds: ids })).map((p) => [p.order_id, p]));
  const fontePorId = new Map(fontes.map((f) => [f.order_id, f]));
  // Tudo comparado no relógio do BANCO (o que a projeção viu × o que a fonte tem agora) — nunca com o relógio da aplicação.
  // Evento fora de ordem nem sempre mexe em ifood_pedidos.atualizado_em: procura eventos recebidos depois do ÚLTIMO evento que a
  // projeção mais defasada do lote viu (pode reprojetar a mais — nunca a menos).
  const vistos = [...atuais.values()].map((p) => p.fonte?.ultimoEventoRecebidoEm).filter(Boolean);
  const desdeEvento = vistos.length === atuais.size && vistos.length ? vistos.reduce((m, x) => (Date.parse(x) < Date.parse(m) ? x : m)) : null;
  const comEventoNovo = !forcar && atuais.size ? await op.listarPedidosComEventoNovo({ organizacaoId, unidadeId, orderIds: ids, desdeIso: desdeEvento ?? "1970-01-01T00:00:00.000Z" }) : new Map();

  const pendentes = ids.filter((id) => {
    if (forcar) return true;
    const p = atuais.get(id);
    if (!p || p.regra_versao !== REGRA_PROJECAO) return true;
    const f = fontePorId.get(id);
    const fonteMudou = (f?.atualizado_em ?? null) !== (p.fonte?.pedidoAtualizadoEm ?? null)
      && !(f?.atualizado_em && p.fonte?.pedidoAtualizadoEm && Date.parse(f.atualizado_em) === Date.parse(p.fonte.pedidoAtualizadoEm));
    const recebidoNovo = comEventoNovo.get(id);   // maior received_at depois do corte, só deste pedido
    const eventoNovo = !!recebidoNovo && (!p.fonte?.ultimoEventoRecebidoEm || Date.parse(recebidoNovo) > Date.parse(p.fonte.ultimoEventoRecebidoEm));
    return fonteMudou || eventoNovo;
  });
  let falhas = 0;
  if (pendentes.length) {
    const [pedidos, eventos] = await Promise.all([
      op.listarPedidosFonte({ organizacaoId, unidadeId, orderIds: pendentes }),
      op.listarEventosDosPedidos({ organizacaoId, unidadeId, orderIds: pendentes }),
    ]);
    const porPedido = new Map();
    for (const e of eventos) (porPedido.get(e.order_id) ?? porPedido.set(e.order_id, []).get(e.order_id)).push(e);
    const projetadoEm = agora().toISOString();
    const novas = [];
    for (const pedido of pedidos) {
      // Trava dupla de tenant: a linha da fonte tem de ser do tenant pedido.
      if (pedido.organizacao_id !== organizacaoId || pedido.unidade_id !== unidadeId) { falhas += 1; continue; }
      // Mesmo com o mesmo fonte_hash a linha é regravada: o `projetado_em` novo é o que impede reprojetar de novo na próxima leitura.
      try { novas.push({ ...projetarPedido({ pedido, eventos: porPedido.get(pedido.order_id) ?? [] }), projetado_em: projetadoEm }); } catch { falhas += 1; }
    }
    await op.gravarProjecoes(novas);
  }
  const linhas = await op.listarProjecoesDaJanela({ organizacaoId, unidadeId, desdeIso, ateIso });
  return { linhas, reprojetados: pendentes.length - falhas, inalterados: ids.length - pendentes.length, falhas };
}

/** Linha do tempo das metas até `ateIso` (sem a migration 127: lista vazia — nenhum pedido avaliado contra meta). */
async function metasAte({ organizacaoId, unidadeId, ateIso, repo }) {
  try { return linhaDoTempoDasMetas(await repo.listarVersoesMetas({ organizacaoId, unidadeId, ateIso })); } catch (e) {
    if (e?.codigo === "METAS_INDISPONIVEIS") return [];
    throw e;
  }
}

// ------------------------------------------------------------------------------------------------------------------------
// Pedidos e Ficha 360°
// ------------------------------------------------------------------------------------------------------------------------

export async function listarPedidos({ organizacaoId, unidadeId, filtro = {}, agora = () => new Date(), deps = {} }) {
  const { repo, op } = dep(deps);
  const agoraMs = agora().getTime();
  const fusoUnidade = await fusoDaUnidade(repo, { organizacaoId, unidadeId });
  const { periodo, fuso, origem: fusoOrigem } = resolverPeriodoDaUnidade({ filtro, agoraMs, fusoUnidade });
  if (!periodo.ok) { const e = ApiError.badRequest(periodo.mensagem); e.codigo = periodo.codigo; throw e; }
  const desdeIso = new Date(periodo.atual.inicioMs).toISOString();
  const ateIso = new Date(periodo.atual.fimMs).toISOString();
  try {
    const sinc = await sincronizarProjecao({ organizacaoId, unidadeId, desdeIso: new Date(periodo.atual.inicioMs - 3_600_000).toISOString(), ateIso: new Date(Math.min(periodo.atual.fimMs + FOLGA_MS, agoraMs + 60_000)).toISOString(), agora, deps });
    const metas = await metasAte({ organizacaoId, unidadeId, ateIso, repo });
    const doPeriodo = sinc.linhas.filter((p) => { const t = Date.parse(p.plc_em ?? p.pedido_criado_em); return Number.isFinite(t) && t >= periodo.atual.inicioMs && t < periodo.atual.fimMs; });
    const itens = doPeriodo.map((p) => itemDaLista(p, metas)).sort((a, b) => String(b.recebidoEm).localeCompare(String(a.recebidoEm)));
    return {
      periodo: { inicio: periodo.atual.inicio, fim: periodo.atual.fim, fuso, fusoOrigem },
      total: itens.length, itens,
      projecao: { reprojetados: sinc.reprojetados, inalterados: sinc.inalterados, falhas: sinc.falhas },
      servidorEm: new Date(agoraMs).toISOString(),
    };
  } catch (e) { return indisponivel(e); }
}

export async function obterFicha({ organizacaoId, unidadeId, chave, agora = () => new Date(), deps = {} }) {
  const { repo, op } = dep(deps);
  if (typeof chave !== "string" || !/^[0-9a-f]{16}$/.test(chave)) throw ApiError.badRequest("Pedido inválido.");
  try {
    let p = await op.obterProjecaoPorChave({ organizacaoId, unidadeId, chave });
    if (!p) throw ApiError.notFound("Pedido não encontrado nesta unidade.");
    // Atualiza só este pedido se a fonte mudou depois da projeção.
    const [fonte] = await op.listarPedidosFonte({ organizacaoId, unidadeId, orderIds: [p.order_id] });
    const novoEvento = await op.listarPedidosComEventoNovo({ organizacaoId, unidadeId, orderIds: [p.order_id], desdeIso: p.fonte?.ultimoEventoRecebidoEm ?? "1970-01-01T00:00:00.000Z" });
    const fonteMudou = fonte && Date.parse(fonte.atualizado_em) !== Date.parse(p.fonte?.pedidoAtualizadoEm ?? "");
    if (fonte && (fonteMudou || novoEvento.size || p.regra_versao !== REGRA_PROJECAO)) {
      const eventos = await op.listarEventosDosPedidos({ organizacaoId, unidadeId, orderIds: [p.order_id] });
      const linha = { ...projetarPedido({ pedido: fonte, eventos }), projetado_em: agora().toISOString() };
      await op.gravarProjecoes([linha]);
      p = linha;
    }
    const [metas, disputas, unidadeNome] = await Promise.all([
      metasAte({ organizacaoId, unidadeId, ateIso: agora().toISOString(), repo }),
      op.listarDisputasDoPedido({ organizacaoId, unidadeId, orderId: p.order_id }),
      Promise.resolve(repo.obterNomeUnidade?.({ organizacaoId, unidadeId })).catch(() => null),
    ]);
    // D-15: horários exibidos no fuso do dia operacional do pedido (mesma regra do Dashboard e do fechamento)
    const fusoUnidade = await fusoDaUnidade(repo, { organizacaoId, unidadeId });
    const { fuso } = fusoDoInstante({ instanteMs: Date.parse(p.plc_em ?? p.pedido_criado_em ?? ""), fusoUnidade });
    return { ficha: { ...montarFicha({ projecao: p, linhaDoTempoMetas: metas, disputas, unidadeNome }), fuso }, servidorEm: agora().toISOString() };
  } catch (e) { return indisponivel(e); }
}

// ------------------------------------------------------------------------------------------------------------------------
// Fechamento diário
// ------------------------------------------------------------------------------------------------------------------------

/**
 * Gera (ou reaproveita) o fechamento de uma competência. Idempotente: o mesmo conteúdo e status não criam versão nova.
 * @param {{organizacaoId: string, unidadeId: string, competencia: string, origem?: 'manual'|'agendado'|'reprocessamento',
 *          geradoPor?: string|null, motivo?: string|null, execucaoId?: string, agora?: () => Date, deps?: object}} p
 */
export async function gerarFechamento({ organizacaoId, unidadeId, competencia, origem = "manual", geradoPor = null, motivo = null, execucaoId = randomUUID(), agora = () => new Date(), deps = {} }) {
  const { repo, op } = dep(deps);
  const agoraMs = agora().getTime();
  if (!dataValida(competencia)) throw ApiError.badRequest("Competência inválida. Use AAAA-MM-DD.");
  // D-15: a competência decide o fuso (≥ corte e unidade com fuso → fuso da unidade). O Dashboard "C a C" decide igual.
  const fusoUnidade = await fusoDaUnidade(repo, { organizacaoId, unidadeId });
  const { fuso, origem: fusoOrigem } = regraFuso({ fusoUnidade, data: competencia });
  const hoje = hojeNoFuso(agoraMs, fuso);
  if (!dataValida(competencia)) throw ApiError.badRequest("Competência inválida. Use AAAA-MM-DD.");
  if (competencia > hoje) throw ApiError.badRequest("A competência não pode ser futura.");
  if (!["manual", "agendado", "reprocessamento"].includes(origem)) throw ApiError.badRequest("Origem inválida.");
  if (!RE_UUID.test(execucaoId)) throw ApiError.badRequest("Execução inválida.");
  const motivoLimpo = typeof motivo === "string" && motivo.trim() ? motivo.trim().slice(0, 500) : null;

  try {
    const janela = janelaDaCompetencia(competencia, fuso);
    const desdeIso = new Date(janela.inicioMs).toISOString();
    const ateIso = new Date(janela.fimMs).toISOString();

    const dashboard = await obterDashboard({ organizacaoId, unidadeId, filtro: { periodo: "personalizado", inicio: competencia, fim: competencia }, agora, deps: { repo } });
    const sinc = await sincronizarProjecao({
      organizacaoId, unidadeId, desdeIso: new Date(janela.inicioMs - FOLGA_MS).toISOString(),
      ateIso: new Date(Math.min(janela.fimMs + FOLGA_MS, agoraMs + 60_000)).toISOString(), agora, deps,
    });
    const projecoes = sinc.linhas;
    const [disputas, sinais, primeiroPedidoEm] = await Promise.all([
      op.listarDisputasDaJanela({ organizacaoId, unidadeId, desdeIso, ateIso }),
      op.sinaisDeRecebimento({ organizacaoId, unidadeId, desdeIso, ateIso }),
      repo.obterPrimeiroPedidoEm({ organizacaoId, unidadeId }),
    ]);
    const cobertura = {
      primeiroPedidoEm,
      semCobertura: !primeiroPedidoEm || Date.parse(primeiroPedidoEm) >= janela.fimMs,
      eventosNoDia: sinais.eventosNoDia,
      semSinalDeRecebimento: competencia < hoje && sinais.eventosNoDia === 0 && !!primeiroPedidoEm && Date.parse(primeiroPedidoEm) < janela.fimMs,
      ultimoEventoRecebidoEm: sinais.ultimoEventoRecebidoEm,
      projecaoComFalha: sinc.falhas > 0,
    };

    const f = calcularFechamento({ competencia, hoje, agoraMs, fuso, fusoOrigem, dashboard, projecoes, disputas, cobertura });
    const diag = gerarDiagnostico(f);
    const texto = await redigirDiagnostico({ diag, organizacaoId, unidadeId }, deps.ia ?? IA_PADRAO);
    const diagnostico = { ...diag, texto };

    // Revisão: já havia versão CONSOLIDADO/REVISADO e o conteúdo mudou → REVISADO (com motivo).
    let status = f.status;
    const ultima = await op.obterUltimoFechamento({ organizacaoId, unidadeId, competencia });
    let hash = hashDoConteudo({ status, indicadores: f.indicadores, pendencias: f.pendencias, diagnostico, cobertura: f.cobertura });
    let motivoFinal = motivoLimpo;
    if (ultima && ["CONSOLIDADO", "REVISADO"].includes(ultima.status) && status === STATUS_FECHAMENTO.CONSOLIDADO) {
      const hashComoConsolidado = hash;
      const hashComoRevisado = hashDoConteudo({ status: STATUS_FECHAMENTO.REVISADO, indicadores: f.indicadores, pendencias: f.pendencias, diagnostico, cobertura: f.cobertura });
      if (ultima.hash_conteudo !== hashComoConsolidado && ultima.hash_conteudo !== hashComoRevisado) {
        status = STATUS_FECHAMENTO.REVISADO;
        hash = hashComoRevisado;
        motivoFinal = motivoLimpo ?? (origem === "manual" ? null : "Reprocessamento: os dados do dia mudaram depois da consolidação.");
        if (!motivoFinal) throw ApiError.badRequest("Esta competência já foi consolidada e os números mudaram: informe o motivo da revisão.");
      } else {
        status = ultima.status;
        hash = ultima.hash_conteudo;
      }
    }

    const fonte = {
      dashboard: "obterDashboard (mesmo cálculo da tela)", projecao: "operacional_pedidos", regraProjecao: REGRA_PROJECAO,
      pedidosProjetados: projecoes.length, reprojetados: sinc.reprojetados, disputas: disputas.length,
      janela: f.janela, geradoEm: new Date(agoraMs).toISOString(), statusMotivo: f.statusMotivo, metasAplicaveis: f.metasAplicaveis,
      avisosDeQualidade: f.avisosDeQualidade,
    };
    const r = await op.registrarFechamento({
      organizacaoId, unidadeId, competencia, status, execucaoId, regraVersao: REGRA_FECHAMENTO, fuso, fusoOrigem, origem,
      geradoPor, motivo: motivoFinal, fonte, cobertura: f.cobertura, indicadores: f.indicadores, diagnostico, pendencias: f.pendencias, hash,
    });
    const registrado = await op.obterFechamento({ organizacaoId, unidadeId, id: r.id });
    let notificacoes = null;
    if (r.resultado === "REGISTRADO") notificacoes = await notificarFechamentoSimulado({ organizacaoId, unidadeId, fechamento: registrado, agoraMs, fuso, deps });
    return { resultado: r.resultado, fechamento: registrado, notificacoes };
  } catch (e) { return indisponivel(e); }
}

/**
 * Central de Notificações (SIMULAÇÃO): depois de uma versão nova CONSOLIDADO/REVISADO, gera o aviso de cada destinatário ATIVO da
 * categoria `fechamento_operacional_diario` com o MESMO texto da prévia. Nunca lança (o fechamento não depende disso) e só roda
 * com as dependências reais (produção/teste de integração) ou quando os testes injetam `deps.notificacoes`.
 */
async function notificarFechamentoSimulado({ organizacaoId, unidadeId, fechamento, agoraMs, fuso, deps }) {
  const repoN = deps.notificacoes ?? (deps.op ? null : repoNotificacoes);
  if (!repoN || !fechamento) return null;
  try {
    const previa = await previaWhatsapp({ organizacaoId, unidadeId, id: fechamento.id, deps });
    const inicioDia = janelaDaCompetencia(hojeNoFuso(agoraMs, fuso), fuso).inicioMs;
    return await simularNotificacaoFechamento({ organizacaoId, unidadeId, fechamento, mensagem: previa.mensagem,
      inicioDiaIso: new Date(inicioDia).toISOString(), deps: { repo: repoN, op: dep(deps).op } });
  } catch { return { simuladas: 0, motivo: "FALHA_NA_SIMULACAO" }; }
}

export async function listarFechamentos({ organizacaoId, unidadeId, competencia = null, deps = {} }) {
  const { op } = dep(deps);
  if (competencia != null && !dataValida(competencia)) throw ApiError.badRequest("Competência inválida.");
  try { return { itens: await op.listarFechamentos({ organizacaoId, unidadeId, competencia }) }; } catch (e) { return indisponivel(e); }
}

export async function obterFechamento({ organizacaoId, unidadeId, id, deps = {} }) {
  const { op } = dep(deps);
  if (!RE_UUID.test(String(id ?? ""))) throw ApiError.badRequest("Fechamento inválido.");
  try {
    const f = await op.obterFechamento({ organizacaoId, unidadeId, id });
    if (!f) throw ApiError.notFound("Fechamento não encontrado nesta unidade.");
    return f;
  } catch (e) { return indisponivel(e); }
}

// ------------------------------------------------------------------------------------------------------------------------
// WhatsApp — SOMENTE simulação
// ------------------------------------------------------------------------------------------------------------------------

/** URL do relatório completo: só com base https configurada (nenhuma por padrão — então nenhum link sai). */
function linkDoRelatorio(fechamento, env = process.env) {
  const base = String(env.OPERACIONAL_RELATORIO_URL_BASE ?? "").trim();
  return /^https:\/\/[^\s]+$/.test(base) ? `${base.replace(/\/+$/, "")}/#checklist-operacional` : null;
}

export async function previaWhatsapp({ organizacaoId, unidadeId, id, deps = {} }) {
  const f = await obterFechamento({ organizacaoId, unidadeId, id, deps });
  const { repo, op } = dep(deps);
  const unidadeNome = await Promise.resolve(repo.obterNomeUnidade?.({ organizacaoId, unidadeId })).catch(() => null);
  let mensagem;
  try { mensagem = gerarMensagem({ fechamento: f, unidadeNome, link: linkDoRelatorio(f, deps.env) }); } catch (e) {
    return { status: STATUS_SIMULACAO.ERROR, mensagem: null, validacao: { ok: false, problemas: [{ codigo: "FALHA_NA_GERACAO", mensagem: "Não foi possível montar a mensagem." }] }, fechamento: { id: f.id, versao: f.versao, status: f.status } };
  }
  const validacao = validarMensagem(mensagem, { fechamento: f });
  const historico = await op.listarSimulacoes({ organizacaoId, unidadeId, fechamentoId: f.id }).catch(() => []);
  return {
    status: validacao.ok ? STATUS_SIMULACAO.READY_FOR_REVIEW : STATUS_SIMULACAO.BLOCKED,
    mensagem, validacao, transporte: TRANSPORTE_SIMULADO, envioReal: false,
    fechamento: { id: f.id, versao: f.versao, status: f.status, competencia: f.competencia },
    historico,
  };
}

/** Registra UMA tentativa simulada (transporte noop). A mesma mensagem do mesmo fechamento nunca é registrada duas vezes. */
export async function simularWhatsapp({ organizacaoId, unidadeId, id, criadoPor = null, deps = {} }) {
  const { op } = dep(deps);
  const previa = await previaWhatsapp({ organizacaoId, unidadeId, id, deps });
  const transporte = criarTransporte(TRANSPORTE_SIMULADO);
  let status = previa.status === STATUS_SIMULACAO.READY_FOR_REVIEW ? STATUS_SIMULACAO.SIMULATED : previa.status;
  let erro = null;
  if (status === STATUS_SIMULACAO.SIMULATED) {
    try { await transporte.enviar({ texto: previa.mensagem }); } catch (e) { status = STATUS_SIMULACAO.ERROR; erro = "falha no transporte simulado"; }
  }
  const linha = {
    organizacao_id: organizacaoId, unidade_id: unidadeId, fechamento_id: previa.fechamento.id, fechamento_versao: previa.fechamento.versao,
    canal: "whatsapp", transporte: transporte.nome, status, chave_idempotencia: chaveSimulacao(previa.fechamento.id, previa.mensagem ?? `erro:${status}`),
    mensagem: previa.mensagem, tamanho: previa.mensagem?.length ?? null, validacao: previa.validacao, erro, criado_por: criadoPor,
  };
  try {
    const r = await op.registrarSimulacao(linha);
    return { simulacao: r.linha, duplicada: r.duplicada, envioReal: false, previa };
  } catch (e) { return indisponivel(e); }
}
