// PARSER FOOD DELIVERY — Central de Conciliação Food Delivery: recebe o
// relatório, separa operações, identifica entregadores, classifica
// AUTOMATICAMENTE se um cancelamento recebe taxa (motor de classificação em
// backend/.../parserFoodDelivery.classificacao.js), calcula valores, detalha
// o pagamento de cada entregador e mantém histórico auditável por período.
// Mesmo esqueleto de bonificacaoMensal.js: abas + estado de módulo próprio,
// reset ao trocar de unidade (nunca mistura dados entre unidades).
import { el, escapeHtml, toast, fmtMoeda, fmtDataHora } from "./utils.js";
import { icon } from "./icons.js";
import { state } from "./state.js";
import { pode } from "./sessao.js";
import {
  pfdPeriodo, pfdImportacoes, pfdImportacaoDetalhe, pfdArquivoImportacao, pfdAlterarClassificacao, pfdExcluirImportacao,
  pfdCatalogos, pfdLancamentoExcluir, pfdLancamentoRestaurar,
} from "./api.js";
import { abrirImportarFoodDeliveryModal } from "./parserFoodDeliveryImportModal.js";
import { abrirLancamentoModal, abrirEntregadoresModal } from "./parserFoodDeliveryLancamentoModal.js";
import { registrarResetDeContexto, geracaoContexto, contextoMudou } from "./contextoEscopo.js";
import { botaoContextualHtml, ligarBotoesContextuais, sincronizarContextoPainel } from "./agentePainel.js";

import { montarCalendario } from "./parserFoodDeliveryCalendario.js";

let consultaAtual = 0;
let consultando = false;
let erroConsulta = null;

const ABAS = [
  { id: "visao", icon: "bar-chart", label: "Visão Geral" },
  { id: "pedidos", icon: "receipt", label: "Pedidos" },
  { id: "cancelamentos", icon: "ban", label: "Cancelamentos" },
  { id: "lancamentos", icon: "banknote", label: "Lançamentos" },
  { id: "entregadores", icon: "users", label: "Entregadores" },
  { id: "historico", icon: "archive", label: "Histórico" },
];

// Origem de um registro (item 1 do pedido). Badge discreto, sem vermelho de
// marca, sem emoji. iFood = dado do relatório; os demais = ajuste operacional.
const ORIGEM_ROTULO = {
  ifood: { label: "iFood", classe: "muted" },
  manual: { label: "Manual", classe: "info" },
  taxa_adicional: { label: "Taxa adicional", classe: "warn" },
  avulso: { label: "Avulso", classe: "ok" },
};
const badgeOrigem = (origem) => {
  const o = ORIGEM_ROTULO[origem] || { label: origem || "—", classe: "muted" };
  return `<span class="pill ${o.classe}">${escapeHtml(o.label)}</span>`;
};

const STATUS_ROTULO = {
  incluido: { label: "Incluído", classe: "ok" },
  cancelado_com_taxa: { label: "Cancelado com taxa", classe: "warn" },
  excluido: { label: "Excluído", classe: "bad" },
};

// classe do pill na tabela de ignorados — chave é `operacao` (subway com
// classificacaoIgnorado === "Sem entregador" cai no default "muted").
const CLASSE_IGNORADO = {
  acai_no_grau: "bad",
  revisao_necessaria: "warn",
};

// Resultado da classificação AUTOMÁTICA de um cancelamento — paleta reservada
// (vermelho fica só pra marca/erro real; "não recebe taxa" é um resultado
// esperado do sistema, não um erro, por isso é cinza e não vermelho).
const CLASSIFICACAO_ROTULO = {
  recebe_taxa: { label: "Recebe taxa", classe: "ok" },
  nao_recebe_taxa: { label: "Não recebe taxa", classe: "muted" },
  revisar: { label: "Revisão necessária", classe: "warn" },
};
const CONFIANCA_ROTULO = { muito_alta: "Confiança muito alta", alta: "Confiança alta", inconclusiva: "Revisão necessária" };
const FILTROS_CANCELAMENTO = [["todos", "Todos"], ["recebe_taxa", "Recebe taxa"], ["nao_recebe_taxa", "Não recebe"], ["revisar", "Revisão"]];
// Timeline do pedido (motor de classificação) — só renderiza os passos que
// têm timestamp no relatório.
const ETAPAS_TIMELINE = [
  ["dataHora", "Pedido recebido"], ["dataDespachado", "Despachado"], ["dataAceito", "Aceito"],
  ["dataColetado", "Coletado"], ["dataChegadaEntrega", "Chegada para entrega"], ["dataCancelado", "Cancelado"],
];
const PERIODOS_PFD = [["hoje", "Hoje"], ["ontem", "Ontem"], ["7d", "7 dias"], ["mes", "Este mês"], ["custom", "Personalizado"]];

const pfd = {
  aba: "visao",
  atual: null,        // { importacao, resumo, entregadores, pedidos, pedidosIgnorados, [consolidado, fontes] } — importação(ões) aberta(s) no momento
  historico: null,
  carregandoHistorico: false,
  filtros: { busca: "", status: "todos", entregador: "todos" },
  filtrosCancelamentos: { busca: "", status: "todos" },
  filtrosLancamentos: { busca: "", origem: "todos", incluirExcluidos: false },
  periodo: { chave: null, ini: null, fim: null },
  ordEntregadores: "taxas", // taxas | entregas | nome
  verIgnorados: false, // alterna a tabela da aba Pedidos entre Subway e "ignorados"
  catalogos: null, // { motivosTaxaAdicional, motivosAvulso, rotulosOrigem } — carregado uma vez
};

registrarResetDeContexto(() => {
  consultaAtual++; consultando = false; erroConsulta = null;
  pfd.aba = "visao";
  pfd.atual = null;
  pfd.historico = null;
  pfd.filtros = { busca: "", status: "todos", entregador: "todos" };
  pfd.filtrosCancelamentos = { busca: "", status: "todos" };
  pfd.filtrosLancamentos = { busca: "", origem: "todos", incluirExcluidos: false };
  pfd.periodo = { chave: null, ini: null, fim: null };
  pfd.ordEntregadores = "taxas";
  pfd.verIgnorados = false;
  fecharPfdDrawer();
  fecharMenuAcoes();
});

const podeImportar = () => pode("parser_food_delivery.importar");
const podeExcluir = () => pode("parser_food_delivery.excluir");
const podeClassificar = () => pode("parser_food_delivery.classificar");
const vazio = (icone, titulo, msg, extra = "", classe = "") =>
  `<div class="estado ${classe}"><span class="estado-ic">${icon(icone, { size: 24 })}</span><h3>${escapeHtml(titulo)}</h3><p>${escapeHtml(msg)}</p>${extra}</div>`;
const carregando = () => `<div class="estado"><div class="spinner"></div>Carregando…</div>`;
// Skeleton (mesmo componente .vd-skel já usado em vendas.js — sem duplicar
// CSS) pro CONTEÚDO da tela, não a tela inteira: cabeçalho e abas continuam
// visíveis e clicáveis, só a área de dados pisca em "carregando".
const skeletonVisaoGeral = () => `
  <div class="vd-skel vd-skel-linha" style="max-width:420px"></div>
  <div class="vd-cards">${Array.from({ length: 4 }).map(() => '<div class="vd-skel vd-skel-card"></div>').join("")}</div>
  <div class="vd-skels">${Array.from({ length: 5 }).map(() => '<div class="vd-skel vd-skel-linha"></div>').join("")}</div>`;
const skeletonTabela = () => `<div class="vd-skels">${Array.from({ length: 8 }).map(() => '<div class="vd-skel vd-skel-linha"></div>').join("")}</div>`;
const fmtDataBr = (iso) => (iso ? iso.split("-").reverse().join("/") : "—");
const fmtPeriodo = (ini, fim) => (!ini ? "—" : ini === fim ? fmtDataBr(ini) : `${fmtDataBr(ini)} até ${fmtDataBr(fim)}`);

// Rastreia o carregamento em andamento — usado por `abrirParserPedidoPorNumero`/
// `abrirParserCancelamentos` (Etapa F.1) pra esperar `pfd.atual` estar
// populado antes de procurar um pedido, já que `irPara()` (router.js) NUNCA
// espera a view terminar de carregar (fire-and-forget). Sem isso, uma action
// que navega e imediatamente procura um pedido quase sempre "não encontraria
// nada", mesmo quando o pedido existe — só ainda não tinha chegado.
let carregamentoAtual = Promise.resolve();

export function renderParserFoodDelivery() {
  carregamentoAtual = executarRenderParserFoodDelivery();
  return carregamentoAtual;
}

/** Resolve quando o carregamento MAIS RECENTE da tela termina — ver comentário acima. */
export async function aguardarCarregamentoParser() {
  await carregamentoAtual;
}

async function executarRenderParserFoodDelivery() {
  const g = geracaoContexto();
  const view = el("#view");
  if (!view) return;
  view.innerHTML = carregando();
  const unidadeNome = state.sessao?.unidade?.nome;
  if (!state.sessao?.unidade?.id) {
    view.innerHTML = vazio("store", "Selecione uma unidade", "O Parser Food Delivery é por unidade. Selecione uma unidade no seletor de contexto para continuar.");
    return;
  }
  montarLayout(unidadeNome);
  carregarCatalogos();
  await carregarHistorico();
  if (contextoMudou(g)) return;
  if (!pfd.atual && !pfd.periodo.chave && pfd.historico?.length) {
    const ultima = pfd.historico.find((h) => h.status === "concluida");
    if (ultima) await selecionarPeriodo("custom", { ini: ultima.periodoInicio, fim: ultima.periodoFim });
  }
  if (contextoMudou(g)) return;
  renderAbaAtual();
}

function montarLayout(unidadeNome) {
  const view = el("#view");
  view.innerHTML = `
    <div class="pfd-page">
      <header class="dex-head pfd-head">
        <div class="dex-head-txt">
          <h2><img src="/assets/menu-parser-food-delivery.png" alt="" class="pfd-logo" /> Parser Food Delivery</h2>
          <p>Conciliação e análise operacional dos pedidos Food Delivery.</p>
        </div>
        <div class="pfd-head-acoes">
          <span class="bm-unidade-chip">${icon("store", { size: 14 })} ${escapeHtml(unidadeNome || "—")}</span>
          ${podeImportar() ? `<button class="btn btn-primary" id="pfd-importar">${icon("upload", { size: 15 })} Importar relatório</button>` : ""}
        </div>
      </header>
      <nav class="dex-nav pfd-nav" aria-label="Seções do Parser Food Delivery">
        ${ABAS.map((a) => `<button class="dex-tab ${a.id === pfd.aba ? "ativo" : ""}" data-aba="${a.id}">${icon(a.icon, { size: 15 })} ${a.label}</button>`).join("")}
      </nav>
      <div id="pfd-periodo-nav"></div>
      <div id="pfd-conteudo" class="bm-conteudo">${skeletonVisaoGeral()}</div>
    </div>`;

  el("#pfd-importar")?.addEventListener("click", () => {
    const g = geracaoContexto();
    abrirImportarFoodDeliveryModal({ unidadeNome, onSalvo: (resultado) => {
      if (!contextoMudou(g)) return aoConfirmarImportacao(resultado);
    } });
  });
  view.querySelectorAll(".dex-tab").forEach((b) => b.addEventListener("click", () => irParaAba(b.dataset.aba)));
}

function irParaAba(aba) {
  pfd.aba = aba;
  el("#view")?.querySelectorAll(".dex-tab").forEach((b) => b.classList.toggle("ativo", b.dataset.aba === aba));
  renderAbaAtual();
}

/** Usada pela action "parser_cancelamentos" do Agente Crescer (Etapa F.1). */
export function abrirParserCancelamentos() {
  irParaAba("cancelamentos");
}

/**
 * Usada pela action "parser_order" do Agente Crescer (Etapa F.1). Abre a
 * aba de Cancelamentos e, se o pedido estiver na importação ATUALMENTE
 * carregada, abre o drawer dele — nunca busca em outro período (isso exigiria
 * uma consulta nova; se não achar, avisa em vez de inventar).
 * @param {string} numero
 */
export async function abrirParserPedidoPorNumero(numero) {
  irParaAba("cancelamentos");
  const alvo = String(numero ?? "").trim();
  if (!alvo) return;
  const p = (pfd.atual?.pedidos ?? []).find((x) => x.numeroPedido === alvo);
  if (!p) { toast(`O pedido #${alvo} não está no período atualmente carregado no Parser.`); return; }
  abrirDrawerCancelamento(p.id);
}

async function aoConfirmarImportacao(resultado) {
  const g = geracaoContexto();
  pfd.aba = "visao";
  await selecionarPeriodo("custom", { ini: resultado.importacao.periodoInicio, fim: resultado.importacao.periodoFim });
  if (contextoMudou(g)) return;
  await carregarHistorico();
  if (!contextoMudou(g)) renderAbaAtual();
}

async function carregarCatalogos() {
  if (pfd.catalogos) return;
  pfd.catalogos = {}; // marca como "tentado" — não refaz a chamada a cada render
  try { const { data } = await pfdCatalogos(); if (data) pfd.catalogos = data; }
  catch { /* catálogo é opcional para a tela abrir — os modais lidam com a ausência */ }
}

async function carregarHistorico() {
  const g = geracaoContexto();
  pfd.carregandoHistorico = true;
  try {
    const { data } = await pfdImportacoes();
    if (contextoMudou(g)) return false;
    pfd.historico = data;
    return true;
  } catch (e) {
    if (contextoMudou(g)) return false;
    toast("Erro ao carregar histórico: " + e.message);
    pfd.historico = pfd.historico || [];
    return false;
  } finally {
    if (!contextoMudou(g)) pfd.carregandoHistorico = false;
  }
}

async function abrirImportacao(id, { silencioso = false } = {}) {
  const g = geracaoContexto();
  const consulta = ++consultaAtual;
  fecharPfdDrawer(); consultando = true; erroConsulta = null;
  renderAbaAtual();
  try {
    const { data } = await pfdImportacaoDetalhe(id);
    if (contextoMudou(g) || consulta !== consultaAtual) return false;
    consultando = false; pfd.atual = data;
    pfd.periodo = { chave: null, ini: data.importacao.periodoInicio, fim: data.importacao.periodoFim };
    if (!silencioso) { pfd.aba = "visao"; renderAbaAtual(); }
    else atualizarPeriodoNav();
    return true;
  } catch (e) {
    if (contextoMudou(g)) return false;
    if (consulta !== consultaAtual) return false;
    consultando = false; erroConsulta = e.message;
    pfd.atual = null; renderAbaAtual();
    toast("Erro ao abrir importação: " + e.message);
    return false;
  }
}

/** Espelha aba + período atuais em `state` pro Agente Crescer montar o Page Context (ver agentePageContext.js) — nunca lido de volta aqui. */
function sincronizarEstadoAgente() {
  const dataRef = pfd.periodo.ini || pfd.atual?.importacao?.periodoInicio || null;
  const [ano, mes] = dataRef ? dataRef.split("-").map(Number) : [null, null];
  state.contextoParser = { aba: pfd.aba, ano: ano || null, mes: mes || null, dataInicio: pfd.periodo.ini, dataFim: pfd.periodo.fim };
  sincronizarContextoPainel();
}

function renderAbaAtual() {
  sincronizarEstadoAgente();
  const box = el("#pfd-conteudo");
  if (!box) return;
  el("#view")?.querySelectorAll(".dex-tab").forEach((b) => b.classList.toggle("ativo", b.dataset.aba === pfd.aba));
  if (consultando) { box.innerHTML = skeletonVisaoGeral(); atualizarPeriodoNav(); return; }
  if (erroConsulta && pfd.aba !== "historico") {
    box.innerHTML = vazio("alert-triangle", "Não foi possível carregar o período", erroConsulta, `<button class="btn btn-ghost" id="pfd-tentar">Tentar novamente</button>`, "erro");
    el("#pfd-tentar")?.addEventListener("click", () => selecionarPeriodo("custom", pfd.periodo));
    atualizarPeriodoNav(); return;
  }
  if (pfd.aba === "historico") { box.innerHTML = skeletonTabela(); renderHistorico(box); atualizarPeriodoNav(); return; }
  // A aba Lançamentos vive num plano à parte do iFood: renderiza mesmo sem
  // pedidos importados no período (pode haver avulsos/manuais).
  if (pfd.aba === "lancamentos" && pfd.atual) { renderLancamentos(box); atualizarPeriodoNav(); return; }
  if (pfd.atual?.consolidado && pfd.atual.importacao.totalPedidos === 0 && !(pfd.atual.lancamentos?.length)) {
    box.innerHTML = vazio("calendar", "Sem dados no período", "Não existem dados importados para o período selecionado.");
    atualizarPeriodoNav(); return;
  }
  if (!pfd.atual) {
    box.innerHTML = vazio("inbox", "Nenhuma importação para este período",
      podeImportar() ? "Importe um relatório Food Delivery ou abra uma importação no Histórico." : "Nenhuma importação disponível para esta unidade ainda.",
      pfd.historico?.length ? `<button class="btn btn-ghost btn-sm" id="pfd-ir-historico">${icon("archive", { size: 14 })} Ver Histórico</button>` : "");
    el("#pfd-ir-historico")?.addEventListener("click", () => irParaAba("historico"));
    atualizarPeriodoNav();
    return;
  }
  if (pfd.aba === "visao") renderVisaoGeral(box);
  else if (pfd.aba === "pedidos") renderPedidos(box);
  else if (pfd.aba === "cancelamentos") renderCancelamentos(box);
  else if (pfd.aba === "lancamentos") renderLancamentos(box);
  else if (pfd.aba === "entregadores") renderEntregadores(box);
  atualizarPeriodoNav();
}

// ---------------------------------------------------------------------------
// NAVEGAÇÃO DE PERÍODO — calendário e atalhos consultam o backend.
// As setas pertencem somente à inspeção de uma importação do Histórico.
// ---------------------------------------------------------------------------
function isoLocalPfd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function datasDoPeriodoPfd(p) {
  const hoje = new Date(new Date().toLocaleDateString("sv-SE", { timeZone: "America/Fortaleza" }) + "T12:00:00");
  if (p === "hoje") return [isoLocalPfd(hoje), isoLocalPfd(hoje)];
  if (p === "ontem") { const d = new Date(hoje); d.setDate(d.getDate() - 1); return [isoLocalPfd(d), isoLocalPfd(d)]; }
  if (p === "7d") { const d = new Date(hoje); d.setDate(d.getDate() - 6); return [isoLocalPfd(d), isoLocalPfd(hoje)]; }
  if (p === "mes") return [isoLocalPfd(new Date(hoje.getFullYear(), hoje.getMonth(), 1)), isoLocalPfd(hoje)];
  return [null, null];
}

function resumoFonte(imp) {
  return { id: imp.id, nomeArquivo: imp.nomeArquivo, periodoInicio: imp.periodoInicio, periodoFim: imp.periodoFim, criadoEm: imp.criadoEm, usuarioNome: imp.usuarioNome };
}
async function selecionarPeriodo(chave, custom = {}) {
  const [ini, fim] = chave === "custom"
    ? [custom.ini ?? pfd.periodo.ini, custom.fim ?? pfd.periodo.fim]
    : datasDoPeriodoPfd(chave);
  if (!ini || !fim) { abrirCalendario(); return; }
  const g = geracaoContexto();
  const consulta = ++consultaAtual;
  fecharPfdDrawer();
  pfd.periodo = { chave, ini, fim };
  pfd.atual = null;
  consultando = true; erroConsulta = null;
  renderAbaAtual();
  try {
    const { data } = await pfdPeriodo(ini, fim);
    if (contextoMudou(g) || consulta !== consultaAtual) return;
    pfd.atual = data;
    pfd.filtros = { busca: "", status: "todos", entregador: "todos" };
    pfd.filtrosCancelamentos = { busca: "", status: "todos" };
    pfd.verIgnorados = false;
  } catch (e) {
    if (contextoMudou(g) || consulta !== consultaAtual) return;
    erroConsulta = e.message;
  } finally {
    if (!contextoMudou(g) && consulta === consultaAtual) { consultando = false; renderAbaAtual(); }
  }
}

function historicoOrdenadoPorPeriodo() {
  return [...(pfd.historico || [])].filter((h) => h.periodoInicio).sort((a, b) => (a.periodoInicio < b.periodoInicio ? -1 : a.periodoInicio > b.periodoInicio ? 1 : 0));
}
async function navegarImportacaoAdjacente(direcao) {
  const lista = historicoOrdenadoPorPeriodo();
  const idx = lista.findIndex((h) => h.id === pfd.atual?.importacao?.id);
  if (idx < 0) return;
  const alvo = lista[idx + direcao];
  if (!alvo) { toast(direcao > 0 ? "Não há importação mais recente." : "Não há importação anterior."); return; }
  pfd.periodo.chave = null;
  await abrirImportacao(alvo.id);
}

function contagemRelatorios() {
  if (!pfd.atual) return 0;
  if (pfd.atual.consolidado) return pfd.atual.fontes?.length || 0;
  return pfd.atual.importacao?.id ? 1 : 0;
}

function renderPeriodoNavHtml() {
  if (pfd.aba === "historico") return "";
  const mostrarSetas = pfd.atual && !pfd.atual.consolidado && pfd.atual.importacao?.id;
  const qtdRelatorios = contagemRelatorios();
  return `
    <div class="pfd-periodo-nav pfd-controls">
      <div class="pfd-controls-esq">
        <div class="vd-chips">
          ${PERIODOS_PFD.map(([v, l]) => `<button class="vd-chip ${v === pfd.periodo.chave ? "ativo" : ""}" data-periodo="${v}">${l}</button>`).join("")}
        </div>
        <details class="pfd-cal" id="pfd-cal">
          <summary class="pfd-cal-btn">${icon("calendar", { size: 14 })} <span>${pfd.periodo.ini ? `${fmtDataBr(pfd.periodo.ini)} a ${fmtDataBr(pfd.periodo.fim)}` : "Selecionar período"}</span></summary>
          <div class="pfd-cal-painel" id="pfd-cal-painel"></div>
        </details>
      </div>
      <div class="pfd-controls-dir">
        ${mostrarSetas ? `<span class="pfd-periodo-setas">
          <button class="btn btn-ghost btn-sm" id="pfd-periodo-anterior" title="Importação anterior">${icon("chevron-left", { size: 15 })}</button>
          <span>Inspeção da importação</span>
          <button class="btn btn-ghost btn-sm" id="pfd-periodo-seguinte" title="Importação seguinte">${icon("chevron-right", { size: 15 })}</button>
        </span>` : ""}
        ${qtdRelatorios ? `<span class="pfd-relatorios-tag">${icon("file-text", { size: 13 })} ${qtdRelatorios} ${qtdRelatorios === 1 ? "relatório" : "relatórios"}</span>` : ""}
        ${qtdRelatorios ? `<button class="btn btn-ghost btn-sm" id="pfd-detalhes-relatorio-nav">${icon("file-text", { size: 14 })} Detalhes</button>` : ""}
      </div>
    </div>`;
}
function abrirCalendario() {
  const calendario = el("#pfd-cal");
  if (calendario) calendario.open = true;
}
function atualizarPeriodoNav() {
  const alvo = el("#pfd-periodo-nav");
  if (!alvo) return;
  alvo.innerHTML = renderPeriodoNavHtml();
  alvo.querySelectorAll("[data-periodo]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.periodo === "custom") abrirCalendario();
    else selecionarPeriodo(b.dataset.periodo);
  }));
  const painel = el("#pfd-cal-painel");
  if (painel) montarCalendario(painel, { ...pfd.periodo, onSelecionar: (range) => selecionarPeriodo("custom", range) });
  el("#pfd-periodo-anterior")?.addEventListener("click", () => navegarImportacaoAdjacente(-1));
  el("#pfd-periodo-seguinte")?.addEventListener("click", () => navegarImportacaoAdjacente(1));
  el("#pfd-detalhes-relatorio-nav")?.addEventListener("click", () => { if (pfd.atual) abrirDrawerRelatorio(); });
  el("#pfd-cal")?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.currentTarget.open = false; e.currentTarget.querySelector("summary").focus(); }
  });
}

// ---------------------------------------------------------------------------
// DRAWER lateral (mesmo padrão de bonificacaoMensal.js#abrirDrawerDia) —
// reaproveitado tanto pros "Detalhes do relatório" quanto pro detalhe de um
// cancelamento (timeline + classificação + alteração manual).
// ---------------------------------------------------------------------------
let pfdDrawerEl = null;
function fecharPfdDrawer() {
  if (!pfdDrawerEl) return;
  pfdDrawerEl.classList.remove("aberto");
  const alvo = pfdDrawerEl;
  setTimeout(() => alvo.remove(), 220);
  pfdDrawerEl = null;
  document.removeEventListener("keydown", onEscPfdDrawer);
  // Fecha tanto o drawer de relatório quanto o de cancelamento — só este
  // último preenche "pedido aberto", mas limpar sempre é seguro (idempotente).
  state.detalheAberto.pedido = null;
  sincronizarContextoPainel();
}
function onEscPfdDrawer(e) { if (e.key === "Escape") fecharPfdDrawer(); }
function abrirPfdDrawer(html) {
  fecharPfdDrawer();
  pfdDrawerEl = document.createElement("div");
  pfdDrawerEl.className = "bm-drawer-overlay";
  pfdDrawerEl.innerHTML = `<aside class="bm-drawer"><button class="modal-close" aria-label="Fechar">×</button><div class="bm-drawer-conteudo">${html}</div></aside>`;
  pfdDrawerEl.addEventListener("click", (e) => { if (e.target === pfdDrawerEl) fecharPfdDrawer(); });
  document.body.appendChild(pfdDrawerEl);
  document.addEventListener("keydown", onEscPfdDrawer);
  requestAnimationFrame(() => pfdDrawerEl.classList.add("aberto"));
  pfdDrawerEl.querySelector(".modal-close").addEventListener("click", fecharPfdDrawer);
  return pfdDrawerEl;
}

function abrirDrawerRelatorio() {
  const fontes = pfd.atual.fontes || (pfd.atual.importacao?.id ? [resumoFonte(pfd.atual.importacao)] : []);
  const item = (lbl, val) => `<div class="vd-pv-item"><span>${lbl}</span><b>${val}</b></div>`;
  abrirPfdDrawer(`
    <h3>${icon("file-text", { size: 17 })} Detalhes do relatório</h3>
    ${fontes.length ? fontes.map((f) => `
      <div class="bm-drawer-bloco">
        <div class="vd-pv-titulo">${escapeHtml(f.nomeArquivo || "Arquivo")}</div>
        <div class="vd-pv-grid">
          ${item("Período", fmtPeriodo(f.periodoInicio, f.periodoFim))}
          ${item("Importado por", escapeHtml(f.usuarioNome || "—"))}
          ${item("Data/hora", fmtDataHora(f.criadoEm))}
        </div>
      </div>`).join("") : `<p class="dex-diag-vazio">Sem detalhes de origem disponíveis.</p>`}
    ${fontes.length > 1 ? `<p class="dex-diag-vazio">Visão consolidada de ${fontes.length} relatórios. Arquivos e auditoria permanecem no Histórico.</p>` : ""}
  `);
}

// ---------------------------------------------------------------------------
// VISÃO GERAL
// ---------------------------------------------------------------------------
function distribuicaoBar(itens) {
  const total = itens.reduce((s, i) => s + i.valor, 0) || 1;
  const barras = itens.filter((i) => i.valor > 0)
    .map((i) => `<div class="pfd-dist-segment pfd-dist-${i.cor}" style="width:${(i.valor / total * 100).toFixed(2)}%" title="${escapeHtml(i.label)}: ${i.valor}"></div>`).join("");
  const legenda = itens.map((i) => `<span class="pfd-dist-leg-item"><i class="pfd-dist-dot pfd-dist-${i.cor}"></i><span>${escapeHtml(i.label)}</span><b>${i.valor}</b></span>`).join("");
  return `<div class="pfd-dist-bar">${barras}</div><div class="pfd-dist-legenda">${legenda}</div>`;
}

function distribuicaoDoRelatorioHtml() {
  const { importacao, resumo } = pfd.atual;
  const semColunaDetalhes = importacao.colunaDetalhesEncontrada === false;
  const itens = [
    { label: "Subway Saci", valor: importacao.pedidosSubway ?? resumo.totalPedidos, cor: "ok" },
    { label: "Açaí no Grau", valor: importacao.pedidosAcai ?? 0, cor: "info" },
    { label: "Sem entregador", valor: importacao.pedidosSemEntregador ?? 0, cor: "muted" },
    { label: "Operação indefinida", valor: importacao.pedidosRevisao ?? 0, cor: "warn" },
  ];
  const excluidos = (importacao.pedidosAcai || 0) + (importacao.pedidosSemEntregador || 0) + (importacao.pedidosRevisao || 0);
  return `
    ${distribuicaoBar(itens)}
    ${semColunaDetalhes ? `<p class="pfd-secao-nota pfd-secao-nota--warn">${icon("alert-triangle", { size: 14 })} Este relatório não trouxe a coluna "Detalhes do pedido" — não foi possível separar por operação; todos os pedidos foram considerados Subway Saci.</p>` : ""}
    ${excluidos > 0 ? `<div class="pfd-secao-faixa">
      <span>${excluidos} ${excluidos === 1 ? "pedido foi excluído" : "pedidos foram excluídos"} pelos critérios de elegibilidade.</span>
      <button class="btn btn-ghost btn-sm" id="pfd-ver-ignorados-visao">${icon("eye", { size: 14 })} Ver excluídos</button>
    </div>` : ""}`;
}

function pfdSecao(iconeNome, titulo, sub, conteudo, { plano = false } = {}) {
  return `
    <section class="pfd-secao${plano ? " pfd-secao--plano" : ""}">
      <div class="pfd-secao-head">
        <h3>${icon(iconeNome, { size: 16 })} ${titulo}</h3>
        ${sub ? `<p>${sub}</p>` : ""}
      </div>
      ${conteudo}
    </section>`;
}

function renderVisaoGeral(box) {
  const { importacao, resumo, entregadores } = pfd.atual;
  const consolidado = !!pfd.atual.consolidado;
  const custoReal = resumo.custoReal || { ifood: resumo.taxasValidas, taxasAdicionais: 0, manuais: 0, avulsos: 0, ajustesManuais: 0, total: resumo.taxasValidas, qtdPedidosComTaxaAdicional: 0 };
  const top = [...entregadores].sort((a, b) => (b.custoTotal ?? b.taxasValidas) - (a.custoTotal ?? a.taxasValidas)).slice(0, 5);
  const temRevisaoPendente = resumo.canceladosRevisao > 0;
  const totalDist = importacao.totalPedidos || 0;

  const card = (iconeNome, lbl, val, sub, tone, destino, filtro = "todos") => `
    <button type="button" class="vd-card pfd-card-link pfd-kpi pfd-kpi--${tone}" data-card="${destino}" data-filtro="${filtro}">
      <div class="vd-card-topo"><span class="vd-card-ico">${icon(iconeNome, { size: 16 })}</span><span class="vd-card-lbl">${lbl}</span></div>
      <div class="vd-card-val">${val}</div>${sub ? `<div class="vd-card-sub">${sub}</div>` : ""}
    </button>`;

  const statusItem = (lbl, val, tone) => `
    <div class="pfd-status-item pfd-status--${tone}">
      <span class="pfd-status-lbl">${lbl}</span>
      <span class="pfd-status-val">${val}</span>
    </div>`;

  box.innerHTML = `
    <p class="pfd-meta-linha">
      ${consolidado
        ? `Período consolidado de <b>${pfd.atual.fontes.length} ${pfd.atual.fontes.length === 1 ? "relatório" : "relatórios"}</b>`
        : `Última importação em <b>${fmtDataHora(importacao.criadoEm)}</b> por <b>${escapeHtml(importacao.usuarioNome || "—")}</b>`}
    </p>

    <div class="vd-cards pfd-kpis">
      ${card("receipt", "Pedidos válidos", resumo.totalPedidos, "Pedidos considerados na análise", "neutro", "pedidos", "todos")}
      ${card("check-circle", "Entregues / Finalizados", resumo.entregues, "Concluídos no período", "pos", "pedidos", "entregues")}
      ${card("ban", "Cancelados", resumo.cancelados, "Pedidos cancelados no período", "neg", "cancelamentos", "todos")}
      ${card("wallet", "Custo total com entregadores", fmtMoeda(custoReal.total), "iFood + ajustes operacionais", "destaque", "entregadores", "todos")}
    </div>

    ${custoReal.ajustesManuais > 0 ? pfdSecao("banknote", "Custo real com entregadores",
      "Composição por origem — o valor do iFood não é alterado", `
      <div class="pfd-conciliacao">
        <div class="pfd-conc-linha"><span>${badgeOrigem("ifood")} Taxas iFood</span><b>${fmtMoeda(custoReal.ifood)}</b></div>
        ${custoReal.taxasAdicionais ? `<div class="pfd-conc-linha"><span>${badgeOrigem("taxa_adicional")} Taxas adicionais${custoReal.qtdPedidosComTaxaAdicional ? ` (${custoReal.qtdPedidosComTaxaAdicional} ${custoReal.qtdPedidosComTaxaAdicional === 1 ? "pedido" : "pedidos"})` : ""}</span><b>${fmtMoeda(custoReal.taxasAdicionais)}</b></div>` : ""}
        ${custoReal.manuais ? `<div class="pfd-conc-linha"><span>${badgeOrigem("manual")} Lançamentos manuais</span><b>${fmtMoeda(custoReal.manuais)}</b></div>` : ""}
        ${custoReal.avulsos ? `<div class="pfd-conc-linha"><span>${badgeOrigem("avulso")} Lançamentos avulsos</span><b>${fmtMoeda(custoReal.avulsos)}</b></div>` : ""}
        <div class="pfd-conc-divisor"></div>
        <div class="pfd-conc-linha pfd-conc-final"><span>Custo total com entregadores</span><b>${fmtMoeda(custoReal.total)}</b></div>
      </div>
      <div class="pfd-secao-acoes"><button class="btn btn-ghost btn-sm" id="pfd-ver-lancamentos">${icon("arrow-right", { size: 14 })} Ver lançamentos</button></div>`) : ""}

    ${pfdSecao("activity", "Status da análise", "Classificação automática dos cancelamentos do período", `
      <div class="pfd-status-band">
        ${statusItem("Com taxa", resumo.canceladosRecebemTaxa, "pos")}
        ${statusItem("Sem taxa", resumo.canceladosNaoRecebemTaxa, "neutro")}
        ${statusItem("Em revisão", resumo.canceladosRevisao, "warn")}
        ${statusItem("Descartados", fmtMoeda(resumo.taxasDescartadas), "neg")}
      </div>`)}

    ${pfdSecao("layers", "Distribuição dos pedidos",
      `${totalDist} ${totalDist === 1 ? "pedido encontrado" : "pedidos encontrados"} no período`,
      distribuicaoDoRelatorioHtml())}

    ${pfdSecao("scale", "Resumo financeiro", "", `
      <div class="pfd-conciliacao">
        <div class="pfd-conc-linha"><span>Taxas encontradas</span><b>${fmtMoeda(resumo.taxasBrutas)}</b></div>
        <div class="pfd-conc-linha pfd-conc-neg"><span>Taxas descartadas</span><b>− ${fmtMoeda(resumo.taxasDescartadas)}</b></div>
        <div class="pfd-conc-divisor"></div>
        <div class="pfd-conc-linha pfd-conc-final"><span>Valor final devido</span><b>${fmtMoeda(resumo.taxasValidas)}</b></div>
      </div>`)}

    ${pfdSecao("ban", "Análise dos cancelamentos", "", `
      <p class="pfd-secao-texto">
        ${resumo.cancelados === 0 ? "Nenhum pedido cancelado neste período."
          : temRevisaoPendente ? `Existem <b>${resumo.canceladosRevisao}</b> ${resumo.canceladosRevisao === 1 ? "cancelamento que precisa" : "cancelamentos que precisam"} de validação manual.`
          : "Todos os cancelamentos do período foram classificados automaticamente."}
      </p>
      ${resumo.cancelados > 0 ? `<div class="pfd-secao-acoes"><button class="btn btn-ghost btn-sm" id="pfd-ver-cancelamentos">${icon("arrow-right", { size: 14 })} Ver cancelamentos</button></div>` : ""}`)}

    ${pfdSecao("award", "Ranking resumido de entregadores", "", `
      <div class="tabela-wrap"><table class="grid">
        <thead><tr><th>Entregador</th><th class="num">Entregas</th><th class="num">Cancel. com taxa</th><th class="num">Cancel. sem taxa</th><th class="num">Custo total</th></tr></thead>
        <tbody>${top.map((e) => `<tr><td>${escapeHtml(e.entregador)}</td><td class="num">${e.entregues}</td><td class="num">${e.canceladosComTaxa}</td><td class="num">${e.canceladosSemTaxa}</td><td class="num">${fmtMoeda(e.custoTotal ?? e.taxasValidas)}</td></tr>`).join("")}</tbody>
      </table></div>
      <div class="pfd-secao-acoes"><button class="btn btn-ghost btn-sm" id="pfd-ver-todos-entregadores">${icon("arrow-right", { size: 14 })} Ver todos os entregadores</button></div>`)}`;

  box.querySelectorAll("[data-card]").forEach((b) => b.addEventListener("click", () => {
    pfd.filtros = { busca: "", status: b.dataset.filtro, entregador: "todos" };
    pfd.filtrosCancelamentos = { busca: "", status: "todos" };
    pfd.verIgnorados = false;
    irParaAba(b.dataset.card);
  }));
  el("#pfd-ver-todos-entregadores")?.addEventListener("click", () => irParaAba("entregadores"));
  el("#pfd-ver-cancelamentos")?.addEventListener("click", () => { pfd.filtrosCancelamentos = { busca: "", status: "todos" }; irParaAba("cancelamentos"); });
  el("#pfd-ver-ignorados-visao")?.addEventListener("click", () => { pfd.verIgnorados = true; irParaAba("pedidos"); });
  el("#pfd-ver-lancamentos")?.addEventListener("click", () => irParaAba("lancamentos"));
}

// ---------------------------------------------------------------------------
// PEDIDOS — tabela pesquisável e filtrável
// ---------------------------------------------------------------------------
const FILTROS_STATUS = [
  ["todos", "Todos"], ["entregues", "Entregues"], ["cancelados", "Cancelados"],
  ["com_taxa", "Com taxa"], ["sem_taxa", "Sem taxa"],
];

const pedidoCancelado = (p) => p.cancelado ?? (p.statusConciliacao !== "incluido");

function pedidosFiltrados() {
  const termo = pfd.filtros.busca.trim().toLowerCase();
  return pfd.atual.pedidos.filter((p) => {
    if (termo && !`${p.numeroPedido} ${p.entregador || ""}`.toLowerCase().includes(termo)) return false;
    if (pfd.filtros.entregador !== "todos" && (p.entregadorChave || p.entregador) !== pfd.filtros.entregador) return false;
    if (pfd.filtros.status === "entregues" && pedidoCancelado(p)) return false;
    if (pfd.filtros.status === "cancelados" && !pedidoCancelado(p)) return false;
    if (pfd.filtros.status === "com_taxa" && p.statusConciliacao === "excluido") return false;
    if (pfd.filtros.status === "sem_taxa" && p.statusConciliacao !== "excluido") return false;
    return true;
  });
}

function renderPedidos(box) {
  const entregadoresUnicos = [...pfd.atual.entregadores].sort((a, b) => a.entregador.localeCompare(b.entregador, "pt-BR"));
  const qtdIgnorados = pfd.atual.pedidosIgnorados?.length || 0;
  box.innerHTML = `
    <div class="ed-acoes" style="justify-content:flex-start;margin-bottom:12px">
      <button class="btn btn-sm ${pfd.verIgnorados ? "btn-ghost" : "btn-primary"}" id="pfd-toggle-subway">${icon("receipt", { size: 14 })} Pedidos Subway (${pfd.atual.pedidos.length})</button>
      <button class="btn btn-sm ${pfd.verIgnorados ? "btn-primary" : "btn-ghost"}" id="pfd-toggle-ignorados">${icon("eye", { size: 14 })} Pedidos ignorados (${qtdIgnorados})</button>
    </div>
    ${pfd.verIgnorados ? `<div id="pfd-tabela-pedidos"></div>` : `
    <div class="vd-filtros">
      <div class="busca"><input id="pfd-busca" type="search" placeholder="Buscar por código ou entregador..." value="${escapeHtml(pfd.filtros.busca)}"></div>
      <div class="vd-f-bloco"><span class="vd-f-lbl">Status</span><div class="vd-chips">
        ${FILTROS_STATUS.map(([v, l]) => `<button class="vd-chip ${v === pfd.filtros.status ? "ativo" : ""}" data-status="${v}">${l}</button>`).join("")}
      </div></div>
      <div class="vd-f-bloco"><span class="vd-f-lbl">Entregador</span>
        <select id="pfd-f-entregador"><option value="todos">Todos</option>${entregadoresUnicos.map((e) => `<option value="${escapeHtml(e.chave || e.entregador)}" ${(e.chave || e.entregador) === pfd.filtros.entregador ? "selected" : ""}>${escapeHtml(e.entregador)}</option>`).join("")}</select>
      </div>
    </div>
    <div id="pfd-tabela-pedidos"></div>`}`;

  el("#pfd-toggle-subway").addEventListener("click", () => { pfd.verIgnorados = false; renderPedidos(box); });
  el("#pfd-toggle-ignorados").addEventListener("click", () => { pfd.verIgnorados = true; renderPedidos(box); });

  if (pfd.verIgnorados) { renderTabelaIgnorados(); return; }

  el("#pfd-busca").addEventListener("input", (e) => { pfd.filtros.busca = e.target.value; renderTabelaPedidos(); });
  el("#pfd-f-entregador").addEventListener("change", (e) => { pfd.filtros.entregador = e.target.value; renderTabelaPedidos(); });
  box.querySelectorAll(".vd-chip").forEach((b) => b.addEventListener("click", () => {
    pfd.filtros.status = b.dataset.status;
    box.querySelectorAll(".vd-chip").forEach((x) => x.classList.toggle("ativo", x === b));
    renderTabelaPedidos();
  }));
  renderTabelaPedidos();
}

function renderTabelaPedidos() {
  const alvo = el("#pfd-tabela-pedidos");
  if (!alvo) return;
  const lista = pedidosFiltrados();
  if (!lista.length) { alvo.innerHTML = vazio("search", "Nenhum pedido encontrado", "Ajuste a busca ou os filtros."); return; }
  alvo.innerHTML = `<div class="tabela-wrap"><table class="grid">
    <thead><tr><th>Código</th><th>Data</th><th>Entregador</th><th>Origem</th><th>Situação</th><th class="num">Taxa</th><th class="num">Custo total</th><th>Status</th><th>Classificação</th><th></th></tr></thead>
    <tbody>${lista.map((p) => {
      const st = STATUS_ROTULO[p.statusConciliacao] || { label: p.statusConciliacao, classe: "muted" };
      const cancelado = pedidoCancelado(p);
      const efetiva = cancelado ? classificacaoEfetiva(p) : null;
      const cl = efetiva ? (CLASSIFICACAO_ROTULO[efetiva] || { label: efetiva, classe: "muted" }) : null;
      const nExtras = p.custosAdicionais?.length || 0;
      const overrideManual = !!p.classificacaoOverrideEm;
      return `<tr>
        <td>${escapeHtml(p.numeroPedido)}</td>
        <td>${fmtDataHora(p.dataHora)}</td>
        <td>${escapeHtml(p.entregador || "—")}</td>
        <td>${badgeOrigem("ifood")}</td>
        <td>${escapeHtml(p.situacao || "—")}</td>
        <td class="num">${fmtMoeda(p.taxaEntregador)}</td>
        <td class="num">${nExtras ? `<b>${fmtMoeda(p.custoTotalPedido)}</b> <span class="pfd-mini-tag">+${nExtras}</span>` : fmtMoeda(p.custoTotalPedido ?? p.taxaEntregador)}</td>
        <td><span class="pill ${st.classe}">${st.label}</span></td>
        <td>${cl ? `<span class="pill ${cl.classe}">${cl.label}</span>${overrideManual ? ` <span class="pfd-mini-tag" title="Classificação alterada manualmente">manual</span>` : ""}` : "—"}</td>
        <td><button class="btn btn-ghost btn-sm" data-acao-pedido="${p.id}">Ações</button></td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>
  <p class="dex-diag-vazio">${lista.length} de ${pfd.atual.pedidos.length} pedidos.</p>`;
  alvo.querySelectorAll("[data-acao-pedido]").forEach((b) => b.addEventListener("click", (ev) => abrirMenuAcoesPedido(ev.currentTarget, b.dataset.acaoPedido)));
}

// ---------------------------------------------------------------------------
// MENU "Ações" de uma linha de pedido (item 18) — Ver detalhes / Editar
// classificação / Adicionar taxa de entregador. Pedido do iFood não se
// exclui isoladamente (só a importação inteira, no Histórico).
// ---------------------------------------------------------------------------
let menuAcoesEl = null;
function fecharMenuAcoes() { menuAcoesEl?.remove(); menuAcoesEl = null; document.removeEventListener("click", fecharMenuAcoesFora, true); }
function fecharMenuAcoesFora(e) { if (menuAcoesEl && !menuAcoesEl.contains(e.target)) fecharMenuAcoes(); }
function abrirMenuAcoesPedido(botao, pedidoId) {
  fecharMenuAcoes();
  const p = (pfd.atual?.pedidos || []).find((x) => x.id === pedidoId);
  if (!p) return;
  const cancelado = pedidoCancelado(p);
  const itens = [
    { rot: "Ver detalhes", ic: "eye", fn: () => abrirDrawerDetalhePedido(pedidoId) },
    ...(cancelado && podeClassificar() ? [{ rot: "Editar classificação", ic: "pencil", fn: () => abrirDrawerCancelamento(pedidoId) }] : []),
    ...(podeImportar() ? [{ rot: "Adicionar taxa de entregador", ic: "plus", fn: () => abrirModalTaxaAdicional(p) }] : []),
  ];
  const r = botao.getBoundingClientRect();
  menuAcoesEl = document.createElement("div");
  menuAcoesEl.className = "pfd-menu-acoes";
  menuAcoesEl.style.cssText = `position:fixed;top:${Math.round(r.bottom + 4)}px;left:${Math.round(r.right - 220)}px;z-index:60`;
  menuAcoesEl.innerHTML = itens.map((it, i) => `<button class="pfd-menu-item" data-i="${i}">${icon(it.ic, { size: 14 })} ${escapeHtml(it.rot)}</button>`).join("");
  document.body.appendChild(menuAcoesEl);
  menuAcoesEl.querySelectorAll("[data-i]").forEach((b) => b.addEventListener("click", () => { const it = itens[Number(b.dataset.i)]; fecharMenuAcoes(); it.fn(); }));
  setTimeout(() => document.addEventListener("click", fecharMenuAcoesFora, true), 0);
}

function abrirModalTaxaAdicional(pedido) {
  abrirLancamentoModal({
    modo: "taxa_adicional", pedido, catalogos: pfd.catalogos,
    onSalvo: async () => { await recarregarAtual(); toast("Taxa de entregador adicionada."); },
  });
}

/** Recarrega a importação/período atualmente aberto (após um lançamento). */
async function recarregarAtual() {
  if (pfd.atual?.importacao?.id && !pfd.atual.consolidado) await abrirImportacao(pfd.atual.importacao.id, { silencioso: true });
  else await selecionarPeriodo(pfd.periodo.chave || "custom", pfd.periodo);
  renderAbaAtual();
}

// ---------------------------------------------------------------------------
// DRAWER — detalhe completo do pedido (item 19): dados originais + entregador
// final + taxa original + classificação + custos adicionais + custo total.
// ---------------------------------------------------------------------------
function abrirDrawerDetalhePedido(pedidoId) {
  const p = (pfd.atual?.pedidos || []).find((x) => x.id === pedidoId);
  if (!p) return;
  const cancelado = pedidoCancelado(p);
  const efetiva = cancelado ? classificacaoEfetiva(p) : null;
  const cl = efetiva ? (CLASSIFICACAO_ROTULO[efetiva] || { label: efetiva, classe: "muted" }) : null;
  const extras = p.custosAdicionais || [];
  const item = (lbl, val) => `<div class="vd-pv-item"><span>${lbl}</span><b>${val}</b></div>`;
  abrirPfdDrawer(`
    <h3>Pedido #${escapeHtml(p.numeroPedido)}</h3>
    <div class="bm-drawer-bloco">
      <div class="vd-pv-titulo">Entrega principal</div>
      <div class="vd-pv-grid">
        ${item("Entregador final", escapeHtml(p.entregador || "—"))}
        ${item("Taxa (iFood)", fmtMoeda(p.taxaEntregador))}
        ${item("Data / hora", fmtDataHora(p.dataHora))}
        ${item("Situação", escapeHtml(p.situacao || "—"))}
        ${item("Origem", badgeOrigem("ifood"))}
        ${item("Classificação", cl ? `<span class="pill ${cl.classe}">${cl.label}</span>` : "—")}
      </div>
      ${p.classificacaoOverrideEm ? `<p class="dex-diag-vazio">Classificação alterada manualmente por <b>${escapeHtml(p.classificacaoOverrideUsuarioNome || "—")}</b> em ${fmtDataHora(p.classificacaoOverrideEm)}${p.classificacaoOverrideMotivo ? `. Motivo: "${escapeHtml(p.classificacaoOverrideMotivo)}"` : ""}.</p>` : ""}
    </div>

    <div class="bm-drawer-bloco">
      <div class="vd-pv-titulo">Custos adicionais</div>
      ${extras.length ? `<ul class="pfd-custos-lista">${extras.map((e) => `
        <li><span>${escapeHtml(e.entregadorNome || "—")}</span>
          <b>${fmtMoeda(e.valor)}</b>
          <span class="pfd-custos-motivo">${badgeOrigem(e.origem)} ${escapeHtml(e.motivoRotulo || "—")}${e.observacao ? ` — ${escapeHtml(e.observacao)}` : ""}</span></li>`).join("")}</ul>`
        : `<p class="dex-diag-vazio">Nenhum custo adicional lançado para este pedido.</p>`}
      ${podeImportar() ? `<button class="btn btn-ghost btn-sm" id="pfd-add-taxa-drawer">${icon("plus", { size: 14 })} Adicionar taxa de entregador</button>` : ""}
    </div>

    <div class="pfd-conc-linha pfd-conc-final"><span>Custo total deste pedido</span><b>${fmtMoeda(p.custoTotalPedido ?? p.taxaEntregador)}</b></div>
  `);
  el("#pfd-add-taxa-drawer")?.addEventListener("click", () => { fecharPfdDrawer(); abrirModalTaxaAdicional(p); });
}

// ---------------------------------------------------------------------------
// "VER PEDIDOS IGNORADOS" — conferir se o parser não descartou algo
// incorretamente. Mostra código, descrição, motivo e a operação identificada.
// ---------------------------------------------------------------------------
function renderTabelaIgnorados() {
  const alvo = el("#pfd-tabela-pedidos");
  if (!alvo) return;
  const lista = pfd.atual.pedidosIgnorados || [];
  if (!lista.length) { alvo.innerHTML = vazio("check-circle", "Nenhum pedido ignorado", "Todos os pedidos deste relatório foram identificados como Subway Saci."); return; }
  alvo.innerHTML = `<div class="tabela-wrap"><table class="grid">
    <thead><tr><th>Código</th><th>Descrição / produtos</th><th>Motivo</th><th>Classificação</th></tr></thead>
    <tbody>${lista.map((p) => {
      const classe = CLASSE_IGNORADO[p.operacao] || "muted";
      return `<tr>
        <td>${escapeHtml(p.numeroPedido)}</td>
        <td style="white-space:normal;max-width:360px">${escapeHtml((p.detalhesPedido || "—").slice(0, 160))}</td>
        <td style="white-space:normal;max-width:280px">${escapeHtml(p.motivoIgnorado || "—")}</td>
        <td><span class="pill ${classe}">${escapeHtml(p.classificacaoIgnorado || p.operacao)}</span></td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>
  <p class="dex-diag-vazio">${lista.length} pedido(s) ignorado(s) desta conciliação — não entram em nenhum valor financeiro.</p>`;
}

// ---------------------------------------------------------------------------
// CANCELAMENTOS — a principal aba nova: filtra/pesquisa os cancelados e
// abre o detalhe (timeline + classificação automática + alteração manual).
// ---------------------------------------------------------------------------
/** "Classificação efetiva": se há override manual, deriva do status pós-override; senão usa a decisão automática do motor. */
function classificacaoEfetiva(p) {
  if (p.classificacaoEfetiva) return p.classificacaoEfetiva;
  if (p.classificacaoOverrideEm) return p.statusConciliacao === "excluido" ? "nao_recebe_taxa" : "recebe_taxa";
  return p.classificacaoCancelamento || (p.statusConciliacao === "excluido" ? "nao_recebe_taxa" : "recebe_taxa");
}
function pedidosCancelados() { return (pfd.atual?.pedidos || []).filter(pedidoCancelado); }
function cancelamentosFiltrados() {
  const termo = pfd.filtrosCancelamentos.busca.trim().toLowerCase();
  return pedidosCancelados().filter((p) => {
    if (termo && !`${p.numeroPedido} ${p.entregador || ""}`.toLowerCase().includes(termo)) return false;
    if (pfd.filtrosCancelamentos.status !== "todos" && classificacaoEfetiva(p) !== pfd.filtrosCancelamentos.status) return false;
    return true;
  });
}

function renderCancelamentos(box) {
  const total = pedidosCancelados().length;
  if (!total) { box.innerHTML = vazio("check-circle", "Nenhum cancelamento neste período", "Todos os pedidos deste período foram entregues normalmente."); return; }
  box.innerHTML = `
    <div class="vd-filtros">
      <div class="busca"><input id="pfd-canc-busca" type="search" placeholder="Buscar por código ou entregador..." value="${escapeHtml(pfd.filtrosCancelamentos.busca)}"></div>
      <div class="vd-f-bloco"><span class="vd-f-lbl">Classificação</span><div class="vd-chips">
        ${FILTROS_CANCELAMENTO.map(([v, l]) => `<button class="vd-chip ${v === pfd.filtrosCancelamentos.status ? "ativo" : ""}" data-status-canc="${v}">${l}</button>`).join("")}
      </div></div>
      ${botaoContextualHtml("parser_food_delivery")}
    </div>
    <div id="pfd-tabela-cancelamentos"></div>`;
  el("#pfd-canc-busca").addEventListener("input", (e) => { pfd.filtrosCancelamentos.busca = e.target.value; renderTabelaCancelamentos(); });
  box.querySelectorAll("[data-status-canc]").forEach((b) => b.addEventListener("click", () => {
    pfd.filtrosCancelamentos.status = b.dataset.statusCanc;
    box.querySelectorAll("[data-status-canc]").forEach((x) => x.classList.toggle("ativo", x === b));
    renderTabelaCancelamentos();
  }));
  ligarBotoesContextuais(box);
  renderTabelaCancelamentos();
}

function renderTabelaCancelamentos() {
  const alvo = el("#pfd-tabela-cancelamentos");
  if (!alvo) return;
  const lista = cancelamentosFiltrados();
  if (!lista.length) { alvo.innerHTML = vazio("search", "Nenhum cancelamento encontrado", "Ajuste a busca ou os filtros."); return; }
  alvo.innerHTML = `<div class="tabela-wrap"><table class="grid">
    <thead><tr><th>Pedido</th><th>Entregador</th><th>Confiança</th><th>Classificação</th><th class="num">Taxa</th><th></th></tr></thead>
    <tbody>${lista.map((p) => {
      const efetiva = classificacaoEfetiva(p);
      const cl = CLASSIFICACAO_ROTULO[efetiva] || { label: efetiva, classe: "muted" };
      const conf = p.classificacaoOverrideEm ? "Alterado manualmente" : (CONFIANCA_ROTULO[p.classificacaoNivelConfianca] || "Sem análise automática");
      return `<tr>
        <td>${escapeHtml(p.numeroPedido)}</td>
        <td>${escapeHtml(p.entregador || "—")}</td>
        <td>${escapeHtml(conf)}</td>
        <td><span class="pill ${cl.classe}">${cl.label}</span></td>
        <td class="num">${fmtMoeda(p.taxaEntregador)}</td>
        <td><button class="btn btn-ghost btn-sm" data-ver-canc="${p.id}">Ver detalhes</button></td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>
  <p class="dex-diag-vazio">${lista.length} de ${pedidosCancelados().length} cancelamento(s).</p>`;
  alvo.querySelectorAll("[data-ver-canc]").forEach((b) => b.addEventListener("click", () => abrirDrawerCancelamento(b.dataset.verCanc)));
}

function duracaoHumanaFront(iniIso, fimIso) {
  if (!iniIso || !fimIso) return null;
  const ini = new Date(iniIso).getTime(), fim = new Date(fimIso).getTime();
  if (Number.isNaN(ini) || Number.isNaN(fim) || fim < ini) return null;
  const totalSeg = Math.round((fim - ini) / 1000);
  const min = Math.floor(totalSeg / 60), seg = totalSeg % 60;
  return min > 0 ? `${min}min${String(seg).padStart(2, "0")}s` : `${seg}s`;
}

function eventosTimeline(pedido) {
  return ETAPAS_TIMELINE
    .map(([campo, label], ordem) => ({ campo, label, ordem, data: pedido[campo], ms: new Date(pedido[campo]).getTime() }))
    .filter((e) => e.data && !Number.isNaN(e.ms))
    .sort((a, b) => a.ms - b.ms || a.ordem - b.ordem);
}

function timelineInconsistente(eventos) {
  return eventos.some((e, i) => i > 0 && e.ordem < eventos[i - 1].ordem);
}

function abrirDrawerCancelamento(pedidoId) {
  const p = (pfd.atual?.pedidos || []).find((x) => x.id === pedidoId);
  if (!p) return;
  abrirPfdDrawer(drawerCancelamentoHtml(p));
  wireDrawerCancelamento(p);
  // "pedido aberto" pro Page Context do Agente Crescer — só o número (ver
  // state.js#detalheAberto), nunca valor/taxa/classificação.
  state.detalheAberto.pedido = p.numeroPedido;
  sincronizarContextoPainel();
}

function drawerCancelamentoHtml(p) {
  const passos = eventosTimeline(p);
  const inconsistente = timelineInconsistente(passos);
  const efetiva = classificacaoEfetiva(p);
  const cl = CLASSIFICACAO_ROTULO[efetiva] || { label: efetiva, classe: "muted" };
  const durColetaCancel = duracaoHumanaFront(p.dataColetado, p.dataCancelado);
  const podeAlterar = podeClassificar() && (p.importacaoId || pfd.atual.importacao?.id);

  return `
    <h3>Pedido #${escapeHtml(p.numeroPedido)}</h3>
    <p class="dex-diag-vazio">${escapeHtml(p.entregador || "—")}</p>
    ${passos.length ? `
      <ul class="hist-timeline pfd-timeline">
        ${passos.map(({ campo, label }) => `
          <li class="hist-evento">
            <span class="hist-avatar pfd-timeline-dot ${campo === "dataCancelado" ? "pfd-timeline-dot-cancelado" : ""}">${campo === "dataCancelado" ? icon("ban", { size: 12 }) : ""}</span>
            <div class="hist-corpo">
              <div class="hist-cabecalho"><b>${label}</b></div>
              <div class="hist-data">${fmtDataHora(p[campo])}</div>
            </div>
          </li>`).join("")}
      </ul>
      ${inconsistente ? `<p class="dex-diag-vazio"><span class="pill warn">atenção</span> Há eventos fora da ordem operacional esperada neste relatório.</p>` : ""}
      ${durColetaCancel ? `<p class="dex-diag-vazio">${durColetaCancel} entre coleta e cancelamento.</p>` : ""}
    ` : `<p class="dex-diag-vazio">Este relatório não trouxe os horários de despacho/aceite/coleta deste pedido.</p>`}

    <div class="bm-drawer-bloco">
      <span class="pill ${cl.classe}" style="font-size:14px">${cl.label}${p.taxaEntregador != null ? ` — ${fmtMoeda(p.taxaEntregador)}` : ""}</span>
      <p style="margin-top:8px">${escapeHtml(p.classificacaoMotivo || "Sem análise automática registrada (importação anterior à automação, ou motivo indisponível).")}</p>
      ${p.classificacaoOverrideEm ? `<p class="dex-diag-vazio">Alterado manualmente por <b>${escapeHtml(p.classificacaoOverrideUsuarioNome || "—")}</b> em ${fmtDataHora(p.classificacaoOverrideEm)}. Motivo: "${escapeHtml(p.classificacaoOverrideMotivo || "")}"</p>` : ""}
    </div>

    ${p.razaoCancelamento || p.justificativaCancelamento ? `
      <div class="bm-drawer-bloco">
        <div class="vd-pv-titulo">Razão / justificativa do cancelamento</div>
        <p class="dex-diag-vazio">${escapeHtml(p.razaoCancelamento || "—")}${p.justificativaCancelamento ? " — " + escapeHtml(p.justificativaCancelamento) : ""}</p>
      </div>` : ""}

    ${podeAlterar ? `
      <div class="bm-drawer-bloco" id="pfd-override-bloco">
        <button class="btn btn-ghost btn-sm" id="pfd-abrir-override">${icon("pencil", { size: 14 })} Alterar classificação</button>
        <div id="pfd-override-form" hidden>
          <div class="vd-chips" style="margin-top:8px">
            <button class="vd-chip" data-destino="recebe_taxa">Recebe taxa</button>
            <button class="vd-chip" data-destino="nao_recebe_taxa">Não recebe taxa</button>
          </div>
          <textarea id="pfd-override-motivo" placeholder="Motivo da alteração (obrigatório)" class="pfd-override-textarea"></textarea>
          <div class="ed-acoes"><button class="btn btn-primary btn-sm" id="pfd-confirmar-override" disabled>Confirmar alteração</button></div>
        </div>
      </div>` : ""}`;
}

function wireDrawerCancelamento(p) {
  const abrir = el("#pfd-abrir-override");
  const form = el("#pfd-override-form");
  abrir?.addEventListener("click", () => { form.hidden = false; abrir.hidden = true; });
  let destino = null;
  const btnConfirmar = el("#pfd-confirmar-override");
  const motivoEl = el("#pfd-override-motivo");
  const checar = () => { if (btnConfirmar) btnConfirmar.disabled = !destino || motivoEl.value.trim().length < 3; };
  pfdDrawerEl?.querySelectorAll("[data-destino]").forEach((b) => b.addEventListener("click", () => {
    destino = b.dataset.destino;
    pfdDrawerEl.querySelectorAll("[data-destino]").forEach((x) => x.classList.toggle("ativo", x === b));
    checar();
  }));
  motivoEl?.addEventListener("input", checar);
  btnConfirmar?.addEventListener("click", async () => {
    const g = geracaoContexto();
    const importacaoId = p.importacaoId || pfd.atual.importacao.id;
    const consulta = consultaAtual;
    btnConfirmar.disabled = true; btnConfirmar.textContent = "Salvando…";
    try {
      const { data } = await pfdAlterarClassificacao(importacaoId, p.id, { classificacaoFinal: destino, motivo: motivoEl.value.trim() });
      if (contextoMudou(g)) return; // trocou de unidade enquanto salvava — não sobrescreve o estado da unidade nova
      if (consulta !== consultaAtual) return;
      if (pfd.atual.consolidado) await selecionarPeriodo("custom", pfd.periodo);
      else pfd.atual = { ...pfd.atual, ...data };
      await carregarHistorico();
      if (contextoMudou(g)) return;
      toast("Classificação alterada.");
      fecharPfdDrawer();
      renderAbaAtual();
    } catch (e) {
      if (contextoMudou(g)) return;
      toast("Erro ao alterar classificação: " + e.message);
      btnConfirmar.disabled = false; btnConfirmar.textContent = "Confirmar alteração";
    }
  });
}

// ---------------------------------------------------------------------------
// LANÇAMENTOS — custos com entregadores fora do relatório do iFood
// (itens 4, 5, 7, 8 do pedido). Avulsos + entregas manuais + taxas
// adicionais do período. Origem sempre visível.
// ---------------------------------------------------------------------------
const FILTROS_ORIGEM_LANC = [["todos", "Todos"], ["taxa_adicional", "Taxa adicional"], ["manual", "Manual"], ["avulso", "Avulso"]];

function lancamentosFiltrados() {
  const termo = pfd.filtrosLancamentos.busca.trim().toLowerCase();
  return (pfd.atual?.lancamentos || []).filter((l) => {
    if (!pfd.filtrosLancamentos.incluirExcluidos && l.excluido) return false;
    if (pfd.filtrosLancamentos.origem !== "todos" && l.origem !== pfd.filtrosLancamentos.origem) return false;
    if (termo && !`${l.entregadorNome || ""} ${l.numeroPedido || ""} ${l.motivoRotulo || ""}`.toLowerCase().includes(termo)) return false;
    return true;
  });
}

function renderLancamentos(box) {
  const podeMexer = podeImportar();
  box.innerHTML = `
    <div class="ed-acoes" style="justify-content:space-between;margin-bottom:12px">
      <div class="vd-chips">
        ${FILTROS_ORIGEM_LANC.map(([v, l]) => `<button class="vd-chip ${v === pfd.filtrosLancamentos.origem ? "ativo" : ""}" data-origem-lanc="${v}">${l}</button>`).join("")}
      </div>
      ${podeMexer ? `<div class="ed-acoes" style="gap:8px">
        <button class="btn btn-ghost btn-sm" id="pfd-nova-entrega">${icon("plus", { size: 14 })} Nova entrega</button>
        <button class="btn btn-primary btn-sm" id="pfd-novo-avulso">${icon("plus", { size: 14 })} Novo lançamento avulso</button>
      </div>` : ""}
    </div>
    <div class="vd-filtros">
      <div class="busca"><input id="pfd-lanc-busca" type="search" placeholder="Buscar por entregador, pedido ou motivo..." value="${escapeHtml(pfd.filtrosLancamentos.busca)}"></div>
      <label class="vd-f-bloco" style="flex-direction:row;align-items:center;gap:6px">
        <input type="checkbox" id="pfd-lanc-excluidos" ${pfd.filtrosLancamentos.incluirExcluidos ? "checked" : ""}> <span class="vd-f-lbl">Mostrar excluídos</span>
      </label>
    </div>
    <div id="pfd-tabela-lancamentos"></div>`;
  box.querySelectorAll("[data-origem-lanc]").forEach((b) => b.addEventListener("click", () => {
    pfd.filtrosLancamentos.origem = b.dataset.origemLanc;
    box.querySelectorAll("[data-origem-lanc]").forEach((x) => x.classList.toggle("ativo", x === b));
    renderTabelaLancamentos();
  }));
  el("#pfd-lanc-busca")?.addEventListener("input", (e) => { pfd.filtrosLancamentos.busca = e.target.value; renderTabelaLancamentos(); });
  el("#pfd-lanc-excluidos")?.addEventListener("change", (e) => { pfd.filtrosLancamentos.incluirExcluidos = e.target.checked; renderTabelaLancamentos(); });
  el("#pfd-novo-avulso")?.addEventListener("click", () => abrirLancamentoModal({
    modo: "avulso", catalogos: pfd.catalogos, dataSugerida: pfd.periodo.fim || pfd.periodo.ini,
    onSalvo: async () => { await recarregarAtual(); toast("Lançamento avulso registrado."); },
  }));
  el("#pfd-nova-entrega")?.addEventListener("click", () => abrirLancamentoModal({
    modo: "manual", catalogos: pfd.catalogos, dataSugerida: pfd.periodo.fim || pfd.periodo.ini,
    onSalvo: async () => { await recarregarAtual(); toast("Entrega manual registrada."); },
  }));
  renderTabelaLancamentos();
}

function renderTabelaLancamentos() {
  const alvo = el("#pfd-tabela-lancamentos");
  if (!alvo) return;
  const lista = lancamentosFiltrados();
  const total = (pfd.atual?.resumo?.custoReal?.ajustesManuais) ?? 0;
  if (!lista.length) {
    alvo.innerHTML = vazio("banknote", "Nenhum lançamento no período",
      podeImportar() ? "Use \"Novo lançamento avulso\" ou \"Nova entrega\" para registrar um custo com entregador." : "Nenhum lançamento operacional registrado para este período.");
    return;
  }
  alvo.innerHTML = `<div class="tabela-wrap"><table class="grid">
    <thead><tr><th>Data</th><th>Entregador</th><th>Origem</th><th>Pedido</th><th>Motivo</th><th class="num">Valor</th><th>Status</th><th></th></tr></thead>
    <tbody>${lista.map((l) => `
      <tr class="${l.excluido ? "pfd-linha-excluida" : ""}">
        <td>${escapeHtml(fmtDataBr(l.data))}${l.hora ? ` ${escapeHtml(String(l.hora).slice(0, 5))}` : ""}</td>
        <td>${escapeHtml(l.entregadorNome || "—")}</td>
        <td>${badgeOrigem(l.origem)}</td>
        <td>${l.numeroPedido ? `${escapeHtml(l.numeroPedido)}${l.pedidoDisponivel === false ? ` <span class="pfd-mini-tag" title="Pedido original excluído">indisponível</span>` : ""}` : "—"}</td>
        <td>${escapeHtml(l.motivoRotulo || "—")}${l.motivoDescricao ? ` — ${escapeHtml(l.motivoDescricao)}` : ""}</td>
        <td class="num">${fmtMoeda(l.valor)}</td>
        <td>${l.excluido ? `<span class="pill bad">Excluído</span>` : `<span class="pill ok">Ativo</span>`}</td>
        <td><button class="btn btn-ghost btn-sm" data-acao-lanc="${l.id}">Ações</button></td>
      </tr>`).join("")}</tbody>
  </table></div>
  <p class="dex-diag-vazio">${lista.length} lançamento(s) · total de ajustes no período: <b>${fmtMoeda(total)}</b></p>`;
  alvo.querySelectorAll("[data-acao-lanc]").forEach((b) => b.addEventListener("click", (ev) => abrirMenuAcoesLancamento(ev.currentTarget, b.dataset.acaoLanc)));
}

function abrirMenuAcoesLancamento(botao, lancId) {
  fecharMenuAcoes();
  const l = (pfd.atual?.lancamentos || []).find((x) => x.id === lancId);
  if (!l) return;
  const itens = [];
  if (!l.excluido && podeImportar()) itens.push({ rot: "Editar", ic: "pencil", fn: () => abrirLancamentoModal({
    modo: l.origem, lancamento: l, catalogos: pfd.catalogos,
    onSalvo: async () => { await recarregarAtual(); toast("Lançamento atualizado."); },
  }) });
  if (!l.excluido && podeExcluir()) itens.push({ rot: "Excluir", ic: "trash", fn: () => excluirLancamentoUi(l) });
  if (l.excluido && podeExcluir()) itens.push({ rot: "Restaurar", ic: "undo", fn: () => restaurarLancamentoUi(l) });
  if (!itens.length) return;
  const r = botao.getBoundingClientRect();
  menuAcoesEl = document.createElement("div");
  menuAcoesEl.className = "pfd-menu-acoes";
  menuAcoesEl.style.cssText = `position:fixed;top:${Math.round(r.bottom + 4)}px;left:${Math.round(r.right - 180)}px;z-index:60`;
  menuAcoesEl.innerHTML = itens.map((it, i) => `<button class="pfd-menu-item" data-i="${i}">${icon(it.ic, { size: 14 })} ${escapeHtml(it.rot)}</button>`).join("");
  document.body.appendChild(menuAcoesEl);
  menuAcoesEl.querySelectorAll("[data-i]").forEach((b) => b.addEventListener("click", () => { const it = itens[Number(b.dataset.i)]; fecharMenuAcoes(); it.fn(); }));
  setTimeout(() => document.addEventListener("click", fecharMenuAcoesFora, true), 0);
}

async function excluirLancamentoUi(l) {
  const motivo = prompt(`Motivo da exclusão deste lançamento (${l.origemRotulo} — ${fmtMoeda(l.valor)}):`);
  if (!motivo || motivo.trim().length < 3) { if (motivo !== null) toast("Informe um motivo com ao menos 3 caracteres."); return; }
  const g = geracaoContexto();
  try {
    await pfdLancamentoExcluir(l.id, motivo.trim());
    if (contextoMudou(g)) return;
    await recarregarAtual();
    toast("Lançamento excluído.");
  } catch (e) { toast("Erro ao excluir: " + e.message); }
}

async function restaurarLancamentoUi(l) {
  const g = geracaoContexto();
  try {
    await pfdLancamentoRestaurar(l.id);
    if (contextoMudou(g)) return;
    await recarregarAtual();
    toast("Lançamento restaurado.");
  } catch (e) { toast("Erro ao restaurar: " + e.message); }
}

// ---------------------------------------------------------------------------
// ENTREGADORES — ranking
// ---------------------------------------------------------------------------
const ORD_ENTREGADORES = [["taxas", "Valor de taxas"], ["entregas", "Quantidade de entregas"], ["nome", "Nome"]];

function entregadoresOrdenados() {
  const lista = [...pfd.atual.entregadores];
  if (pfd.ordEntregadores === "entregas") return lista.sort((a, b) => b.totalPedidos - a.totalPedidos);
  if (pfd.ordEntregadores === "nome") return lista.sort((a, b) => a.entregador.localeCompare(b.entregador, "pt-BR"));
  return lista.sort((a, b) => (b.custoTotal ?? b.taxasValidas) - (a.custoTotal ?? a.taxasValidas));
}

function renderEntregadores(box) {
  box.innerHTML = `
    <div class="ed-acoes" style="justify-content:space-between;margin-bottom:12px">
      <div class="vd-f-bloco"><span class="vd-f-lbl">Ordenar por</span><div class="vd-chips">
        ${ORD_ENTREGADORES.map(([v, l]) => `<button class="vd-chip ${v === pfd.ordEntregadores ? "ativo" : ""}" data-ord="${v}">${l}</button>`).join("")}
      </div></div>
      ${podeImportar() ? `<button class="btn btn-ghost btn-sm" id="pfd-gerir-entregadores">${icon("users", { size: 14 })} Gerenciar entregadores</button>` : ""}
    </div>
    <div class="vd-cards-sub" id="pfd-entregadores-lista"></div>`;
  box.querySelectorAll(".vd-chip").forEach((b) => b.addEventListener("click", () => {
    pfd.ordEntregadores = b.dataset.ord;
    box.querySelectorAll(".vd-chip").forEach((x) => x.classList.toggle("ativo", x === b));
    renderListaEntregadores();
  }));
  el("#pfd-gerir-entregadores")?.addEventListener("click", () => abrirEntregadoresModal({ onMudou: () => recarregarAtual() }));
  renderListaEntregadores();
}

function renderListaEntregadores() {
  const alvo = el("#pfd-entregadores-lista");
  if (!alvo) return;
  const lista = entregadoresOrdenados();
  if (!lista.length) { alvo.innerHTML = vazio("users", "Nenhum entregador", "Este relatório não trouxe pedidos com entregador identificado."); return; }
  alvo.innerHTML = lista.map((e, i) => {
    const ajustes = (e.taxasAdicionais || 0) + (e.manuais || 0) + (e.avulsos || 0);
    return `
    <div class="vd-card pfd-entregador-card">
      <div class="vd-card-topo">
        <span class="pfd-entregador-pos${i < 3 ? " pfd-entregador-pos--top" : ""}">${i + 1}</span>
        <span class="vd-card-lbl">${escapeHtml(e.entregador)}${e.somenteLancamentos ? ` ${badgeOrigem("avulso")}` : ""}</span>
      </div>
      <div class="vd-card-val">${fmtMoeda(e.custoTotal ?? e.taxasValidas)}</div>
      <div class="vd-card-sub">${e.totalPedidos} pedidos · ${e.entregues} entregues · ${e.canceladosComTaxa} cancel. com taxa · ${e.canceladosSemTaxa} cancel. sem taxa${e.canceladosRevisao ? ` · ${e.canceladosRevisao} em revisão` : ""}</div>
      ${ajustes ? `<div class="vd-card-sub">iFood ${fmtMoeda(e.taxasValidas)} · ajustes ${fmtMoeda(ajustes)}</div>` : ""}
      <button class="btn btn-ghost btn-sm" data-pedidos-entregador="${escapeHtml(e.chave || e.entregador)}">${icon("arrow-right", { size: 13 })} Ver pedidos</button>
    </div>`;
  }).join("");
  alvo.querySelectorAll("[data-pedidos-entregador]").forEach((b) => b.addEventListener("click", () => {
    pfd.verIgnorados = false;
    pfd.filtros = { busca: "", status: "todos", entregador: b.dataset.pedidosEntregador };
    irParaAba("pedidos");
  }));
}

// ---------------------------------------------------------------------------
// HISTÓRICO
// ---------------------------------------------------------------------------
async function renderHistorico(box) {
  if (pfd.historico == null) await carregarHistorico();
  if (!pfd.historico?.length) { box.innerHTML = vazio("archive", "Nenhuma importação ainda", "Importações confirmadas aparecem aqui."); return; }
  box.innerHTML = `<div class="tabela-wrap"><table class="grid">
    <thead><tr><th>Período</th><th>Arquivo</th><th class="num">Pedidos</th><th class="num">Taxas válidas</th><th class="num">Taxas descartadas</th><th>Usuário</th><th>Importado em</th><th></th></tr></thead>
    <tbody>${pfd.historico.map((h) => `
      <tr class="pfd-hist-linha" data-id="${h.id}" style="cursor:pointer">
        <td>${fmtPeriodo(h.periodoInicio, h.periodoFim)}</td>
        <td>${escapeHtml(h.nomeArquivo || "—")}</td>
        <td class="num">${h.totalPedidos}</td>
        <td class="num">${fmtMoeda(h.taxasValidas)}</td>
        <td class="num">${fmtMoeda(h.taxasDescartadas)}</td>
        <td>${escapeHtml(h.usuarioNome || "—")}</td>
        <td>${fmtDataHora(h.criadoEm)}</td>
        <td><div class="acoes"><button class="acao-btn pfd-hist-arquivo" data-id="${h.id}" title="Ver arquivo original" aria-label="Ver arquivo original">${icon("paperclip", { size: 15 })}</button>${podeExcluir() ? `<button class="acao-btn acao-perigo pfd-hist-excluir" data-id="${h.id}" title="Excluir importação" aria-label="Excluir importação">${icon("trash", { size: 15 })}</button>` : ""}</div></td>
      </tr>`).join("")}</tbody>
  </table></div>`;

  box.querySelectorAll(".pfd-hist-linha").forEach((tr) => tr.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    const entrada = pfd.historico.find((h) => h.id === tr.dataset.id);
    if (entrada?.status !== "concluida") { toast("Esta importação não foi concluída. Importe novamente o arquivo para analisar seus dados."); return; }
    pfd.periodo.chave = null;
    box.innerHTML = skeletonVisaoGeral(); // feedback imediato — abrirImportacao troca pra aba Visão Geral quando terminar
    abrirImportacao(tr.dataset.id);
  }));
  box.querySelectorAll(".pfd-hist-arquivo").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    try { const { data } = await pfdArquivoImportacao(b.dataset.id); window.open(data.url, "_blank"); }
    catch (err) { toast("Erro ao abrir arquivo: " + err.message); }
  }));
  box.querySelectorAll(".pfd-hist-excluir").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const motivo = prompt("Motivo da exclusão desta importação:\n\n(isso também libera o arquivo para reimportação)");
    if (!motivo) return;
    if (!confirm("Excluir de vez esta importação? Esta ação não pode ser desfeita.")) return;
    const g = geracaoContexto();
    try {
      await pfdExcluirImportacao(b.dataset.id, motivo);
      if (contextoMudou(g)) return;
      toast("Importação excluída.");
      if (pfd.atual?.importacao?.id === b.dataset.id) pfd.atual = null;
      await carregarHistorico();
      if (contextoMudou(g)) return;
      if (pfd.atual?.consolidado) await selecionarPeriodo("custom", pfd.periodo);
      renderAbaAtual();
    } catch (err) { toast("Erro: " + err.message); }
  }));
}
