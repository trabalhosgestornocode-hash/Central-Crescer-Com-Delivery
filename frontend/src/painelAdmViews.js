// As telas do PAINEL ADMINISTRATIVO — central de acompanhamento cross-tenant.
//
// Telas reais consumindo /api/v1/administrativo/*. Nenhuma view opera sob
// contexto de empresa — não há req.tenant, não há Context Token. A navegação
// para o detalhe de uma empresa ou o calendário de uma unidade é interna ao
// painel (pilha em painelAdm.js), NÃO uma troca de contexto.
//
// PERÍODO ATIVO: todas as chamadas levam `mes=AAAA-MM` (o período escolhido no
// cabeçalho). O período atravessa a navegação interna — abrir uma empresa ou
// uma unidade não perde o mês que o gestor estava olhando.
//
// Padrão de cada tela: um CONSTRUTOR PURO `htmlX(dados)` -> string (testável
// sem DOM) + o orquestrador `renderViewPadm` que busca, injeta e liga eventos,
// tratando loading (skeleton) / erro / vazio. `null` do backend nunca vira
// número.

import { el, els, escapeHtml, normalizarBusca } from "./utils.js";
import { icon } from "./icons.js";
import { painelAdmApi } from "./painelAdmApi.js";
import { renderPerformance } from './performance.js';
import { renderDesenvolvimento, montarCardDesenvolvimento } from './desenvolvimento.js';
import { SECOES_PDF, secoesPadrao, gerarPdf, previewPdf, nomeArquivoPdf } from "./painelAdmPdf.js";
import {
  card, cards, secao, carregando, erro, vazio, busca, metrica, barraSaude,
  chipCriticidade, chipCategoria, chip, notaHerdada,
  fmtPct, fmtConformidade, fmtNum, fmtData, fmtDataCurta, fmtMesLongo, fmtDiasPendentes,
  CATEGORIA_D1, CRITICIDADE, ORDEM_ACAO, EXPLICACAO_D1, estadoDiaCalendario, rotuloFinanceiroDia,
  realce, seloPendencia, blocoEmpresa, filtroSeveridade, filtrarEmpresas,
  contagensEmpresas, severidadeDe, qtdPendentes, linhaUnidadePendente,
  fmtDinheiro, fmtDinheiroCurto, fmtVariacao, fmtVariacaoPP,
  tomVariacao, seloProvisorio, textoCobertura, linhaRanking, barrasEvolucao,
} from "./painelAdmUi.js";

/** Áreas gerenciais existentes e agenda oficial do desenvolvimento. */
export const TELAS_PADM = [
  { id: "visao-geral", label: "Visão Geral",          icone: "target" },
  { id: 'performance', label: 'Central de Performance', icone: 'target' },
  { id: "diario",      label: "Monitoramento Diário", icone: "calendar" },
  { id: "pendencias",  label: "Pendências",           icone: "alert-triangle" },
  { id: "empresas",    label: "Empresas",             icone: "building" },
  { id: "relatorios",  label: "Relatórios",           icone: "archive" },
  { id: 'desenvolvimento', label: 'Agenda de Demandas', icone: 'calendar' },
];

const view = () => el("#padm-view");

// Filtros server-side do Monitoramento Diário — persistem entre re-renders da
// própria tela; zeram ao trocar de aba (painelAdm.js). O período NÃO mora aqui:
// é global do painel e chega por `opts.mes`.
export const filtrosDiario = { data: "", organizacaoId: "", status: "", criticidade: "" };
export function resetFiltrosDiario() {
  filtrosDiario.data = ""; filtrosDiario.organizacaoId = "";
  filtrosDiario.status = ""; filtrosDiario.criticidade = "";
}

/**
 * Estado das telas de IDENTIFICAÇÃO (Empresas e Pendências). Vive aqui porque
 * é preferência de leitura do gestor, não dado do servidor: nenhuma dessas
 * escolhas refaz chamada de rede — tudo filtra/reagrupa o que já veio.
 */
export const viewEmpresas = { filtro: "todas", termo: "" };
export const viewPendencias = { agrupar: "empresa", filtro: "todas", termo: "" };
/**
 * Aba interna da área Relatórios + escopo dos rankings.
 * `semana`: dia de início do BLOCO semanal (AAAA-MM-DD) analisado nas abas
 * Lucratividade e Rentabilidade — bloco fixo do mês (1: 01–07 · 2: 08–14 ·
 * 3: 15–21 · 4: 22–fim). `null` = bloco que contém D-1 (o backend resolve). As
 * demais chaves são preferência de leitura das abas semanais — nenhuma refaz rede.
 */
export const viewRelatorios = {
  aba: "resumo", escopo: "empresas",
  semana: null,
  lucModelo: "todos", lucBusca: "",
  ordFat: { col: "faturamento", dir: "desc" },   // ranking de faturamento (unidades)
  ordDed: { col: "folgaLimitePp", dir: "desc" }, // eficiência de deduções (unidades)
  rentBusca: "", ordRent: { col: "rentabilidadePct", dir: "desc" },
};
/** Seções marcadas no modal do PDF — preferência de leitura, não dado. */
export const secoesPdf = secoesPadrao();
export function resetSecoesPdf() { Object.assign(secoesPdf, secoesPadrao()); }
export function resetFiltrosIdentificacao() {
  viewEmpresas.filtro = "todas"; viewEmpresas.termo = "";
  viewPendencias.agrupar = "empresa"; viewPendencias.filtro = "todas"; viewPendencias.termo = "";
  viewRelatorios.aba = "resumo"; viewRelatorios.escopo = "empresas";
  viewRelatorios.semana = null;
  viewRelatorios.lucModelo = "todos"; viewRelatorios.lucBusca = "";
  viewRelatorios.ordFat = { col: "faturamento", dir: "desc" };
  viewRelatorios.ordDed = { col: "folgaLimitePp", dir: "desc" };
  viewRelatorios.rentBusca = ""; viewRelatorios.ordRent = { col: "rentabilidadePct", dir: "desc" };
  ultimoDados.lucratividade = null; ultimoDados.semanaCarregada = null;
}

// ---------------------------------------------------------------------------
// Orquestrador
// ---------------------------------------------------------------------------

/** Ganchos injetados por painelAdm.js: navegação interna + acesso revogado. */
let nav = { abrirEmpresa() {}, abrirUnidade() {}, irParaTela() {}, voltar() {}, mudarPeriodo() {}, recarregar() {}, aoAcessoRevogado: null };
export function ligarNavegacao(ganchos) { nav = { ...nav, ...ganchos }; }

/** Silhueta de carregamento por tipo de tela. */
const FORMA_SK = { calendario: "calendario", pendencias: "lista", empresas: "lista", diario: "lista" };
const formaDe = (entrada) =>
  entrada.tipo === "calendario" ? "calendario" : (FORMA_SK[entrada.id] ?? "painel");

/**
 * Renderiza uma entrada da pilha de navegação do painel.
 * @param {{tipo: "tela"|"empresa"|"calendario", id?: string, empresaId?: string, empresaNome?: string, unidadeId?: string, unidadeNome?: string}} entrada
 * @param {{api?: typeof painelAdmApi, mes?: string}} [opts] `mes` = período ativo (AAAA-MM)
 */
export async function renderViewPadm(entrada = { tipo: "tela", id: "visao-geral" }, opts = {}) {
  const api = opts.api ?? painelAdmApi;
  const mes = opts.mes || undefined;
  const v = view();
  if (!v) return;
  if (entrada.id === 'performance') return renderPerformance(v, api, mes, nav.aoAcessoRevogado);
  if (entrada.id === 'desenvolvimento') return renderDesenvolvimento(v, api, nav.aoAcessoRevogado);


  v.innerHTML = carregando(formaDe(entrada));
  try {
    if (entrada.tipo === "empresa") {
      const dados = await api.detalheEmpresa(entrada.empresaId, { mes });
      v.innerHTML = htmlDetalheEmpresa(dados);
      ligarDetalhe();
    } else if (entrada.tipo === "calendario") {
      const dados = await api.calendarioUnidade(entrada.unidadeId, mes);
      v.innerHTML = htmlCalendario(dados, entrada.unidadeNome);
      ligarCalendario({
        api,
        unidadeId: entrada.unidadeId,
        unidadeNome: entrada.unidadeNome ?? dados?.unidade?.unidadeNome,
        motivos: dados?.motivos,
      });
    } else if (entrada.id === "diario") {
      const dados = await api.monitoramentoDiario(filtrosSemVazio(mes));
      v.innerHTML = htmlDiario(dados, filtrosDiario);
      ligarDiario(api, mes);
    } else if (entrada.id === "relatorios") {
      ultimoDados.apiAtual = api;
      ultimoDados.relatorio = await api.relatorioResumo({ mes });
      ultimoDados.evolucao = await api.relatorioEvolucao({ mes });
      ultimoDados.mesAtivo = mes ?? null;
      pintarRelatorios();
    } else if (entrada.id === "pendencias") {
      ultimoDados.pendencias = await api.pendencias({ mes });
      pintarPendencias();
    } else if (entrada.id === "empresas") {
      ultimoDados.empresas = await api.empresas({ mes });
      pintarEmpresas();
    } else {
      v.innerHTML = htmlVisaoGeral(await api.visaoGeral({ mes }));
      ligarLista();
      montarCardDesenvolvimento(v, api, () => nav.irParaTela('desenvolvimento'));
    }
  } catch (e) {
    if (e && e.status === 403) {
      nav.aoAcessoRevogado?.(e.message || "Seu acesso ao Painel Administrativo não está mais disponível.");
      return;
    }
    v.innerHTML = erro(e);
  }
}

/**
 * Última resposta de cada tela de identificação. Trocar filtro, agrupamento ou
 * busca REPINTA a partir daqui — nenhuma dessas ações é uma pergunta nova ao
 * servidor, e o gestor não deve pagar latência para reordenar o que já viu.
 */
const ultimoDados = {
  empresas: null, pendencias: null, relatorio: null, evolucao: null, mesAtivo: null, apiAtual: null,
  lucratividade: null, semanaCarregada: null,
};

/** `true` para as abas semanais (Lucratividade / Rentabilidade). */
const abaSemanal = (aba) => aba === "lucratividade" || aba === "rentabilidade";

function pintarRelatorios() {
  const v = view();
  if (!v || !ultimoDados.relatorio) return;

  const semanal = abaSemanal(viewRelatorios.aba);
  const chaveSemana = viewRelatorios.semana ?? "corrente";

  // Aba semanal e o pacote em cache não é o da semana pedida -> skeleton + fetch.
  if (semanal && ultimoDados.semanaCarregada !== chaveSemana) {
    ultimoDados.lucratividade = null;
    v.innerHTML = htmlRelatorios(ultimoDados.relatorio, ultimoDados.evolucao, viewRelatorios, null);
    ligarRelatorios();
    carregarLucratividade();
    return;
  }

  v.innerHTML = htmlRelatorios(ultimoDados.relatorio, ultimoDados.evolucao, viewRelatorios, ultimoDados.lucratividade);
  ligarRelatorios();
}

/** Busca o pacote semanal e repinta. Sincroniza `viewRelatorios.semana` com o início do bloco que o backend resolveu. */
async function carregarLucratividade() {
  const api = ultimoDados.apiAtual ?? painelAdmApi;
  try {
    const pacote = await api.relatorioLucratividade({ semana: viewRelatorios.semana || undefined });
    // CONTRATO: o ranking é por unidade -> `unidades` é sempre um array. Se vier
    // outra coisa (ex.: backend desatualizado servindo o contrato antigo
    // `empresas`/`lojas`), falha ALTO em vez de renderizar tabelas vazias em
    // silêncio — foi exatamente esse silêncio que escondeu um servidor stale.
    if (!pacote || !Array.isArray(pacote.unidades)) {
      const err = new Error("Resposta inesperada do relatório semanal (sem `unidades`). O servidor pode estar desatualizado — recarregue a página ou reinicie o backend.");
      err.status = pacote ? 200 : 0;
      throw err;
    }
    ultimoDados.lucratividade = pacote;
    viewRelatorios.semana = pacote?.semana?.inicio ?? viewRelatorios.semana;
    ultimoDados.semanaCarregada = viewRelatorios.semana ?? "corrente";
    // se o gestor trocou de aba enquanto carregava, respeita a escolha atual
    if (abaSemanal(viewRelatorios.aba)) pintarRelatorios();
  } catch (e) {
    if (e && e.status === 403) {
      nav.aoAcessoRevogado?.(e.message || "Seu acesso ao Painel Administrativo não está mais disponível.");
      return;
    }
    const v = view();
    if (v) v.innerHTML = erro(e);
  }
}

function ligarRelatorios() {
  ligarNav();
  els("[data-padm-aba]").forEach((b) =>
    b.addEventListener("click", () => { viewRelatorios.aba = b.dataset.padmAba; pintarRelatorios(); }));
  els("[data-padm-escopo]").forEach((b) =>
    b.addEventListener("click", () => { viewRelatorios.escopo = b.dataset.padmEscopo; pintarRelatorios(); }));
  el('[data-padm-acao="csv"]')?.addEventListener("click", aoExportarCsv);
  el('[data-padm-acao="pdf"]')?.addEventListener("click", () => abrirModalPdf());

  // Navegação semanal — força recarga (a semana muda o pacote inteiro).
  els("[data-padm-semana]").forEach((b) => b.addEventListener("click", () => {
    if (b.disabled) return;
    const base = viewRelatorios.semana ?? semanaDe(hojeIsoLocal()).inicio;
    const acao = b.dataset.padmSemana;
    viewRelatorios.semana = acao === "atual" ? null
      : acao === "anterior" ? deslocarSemana(base, -1)
      : deslocarSemana(base, 1);
    pintarRelatorios();
  }));

  // Filtro de modelo / ordenação por coluna — só repintam do cache.
  els("[data-padm-luc-modelo]").forEach((b) => b.addEventListener("click", () => {
    viewRelatorios.lucModelo = b.dataset.padmLucModelo; pintarRelatorios();
  }));
  els("[data-padm-ord]").forEach((th) => th.addEventListener("click", () => {
    const [alvo, col] = th.dataset.padmOrd.split(":");
    const ord = { fat: viewRelatorios.ordFat, ded: viewRelatorios.ordDed, rent: viewRelatorios.ordRent }[alvo];
    if (!ord) return;
    ord.dir = ord.col === col && ord.dir === "desc" ? "asc" : "desc";
    ord.col = col;
    pintarRelatorios();
  }));
  ligarBuscaCampo("#padm-busca-luc", (val) => { viewRelatorios.lucBusca = val; });
  ligarBuscaCampo("#padm-busca-rent", (val) => { viewRelatorios.rentBusca = val; });
}

/** Exporta a aba corrente: as semanais têm CSV próprio; as demais, o relatório mensal. */
function aoExportarCsv() {
  if (viewRelatorios.aba === "lucratividade") return baixarCsvSemanal("lucratividade");
  if (viewRelatorios.aba === "rentabilidade") return baixarCsvSemanal("rentabilidade");
  return baixarCsv(ultimoDados.relatorio, viewRelatorios);
}

/** Busca com debounce que devolve o foco ao campo recriado (padrão da área). */
function ligarBuscaCampo(seletor, aplicar) {
  const inp = el(seletor);
  if (!inp) return;
  let t;
  inp.addEventListener("input", () => {
    clearTimeout(t);
    const valor = inp.value;
    t = setTimeout(() => {
      aplicar(valor);
      pintarRelatorios();
      const novo = el(seletor);
      if (novo) { novo.focus(); novo.setSelectionRange?.(valor.length, valor.length); }
    }, 160);
  });
}

function pintarEmpresas() {
  const v = view();
  if (!v || !ultimoDados.empresas) return;
  v.innerHTML = htmlEmpresas(ultimoDados.empresas, viewEmpresas);
  ligarNav();
  ligarBarraIdentificacao({
    estado: viewEmpresas, buscaId: "#padm-busca-empresas", repintar: pintarEmpresas,
  });
}

function pintarPendencias() {
  const v = view();
  if (!v || !ultimoDados.pendencias) return;
  v.innerHTML = htmlPendencias(ultimoDados.pendencias, viewPendencias);
  ligarNav();
  ligarBarraIdentificacao({
    estado: viewPendencias, buscaId: "#padm-busca-pendencias", repintar: pintarPendencias, comAgrupar: true,
  });
}

/** Filtros preenchidos + o período ativo. Chave ausente ≠ chave `undefined`. */
const filtrosSemVazio = (mes) => {
  const o = {};
  if (mes) o.mes = mes;
  for (const [k, val] of Object.entries(filtrosDiario)) if (val) o[k] = val;
  return o;
};

/** Faixa de contexto do período — repetida no topo de cada tela de dados. */
function faixaPeriodo(d, rotulo = "Fechamento monitorado") {
  const ref = d?.d1 ?? d?.referencia;
  const fechado = d?.mesCorrente === false;
  return `
    <div class="padm-faixa">
      <span class="padm-faixa-item"><b>${escapeHtml(fmtMesLongo(d?.periodo))}</b></span>
      <span class="padm-faixa-sep"></span>
      <span class="padm-faixa-item">${escapeHtml(rotulo)}: <b>${fmtData(ref)}</b></span>
      ${fechado ? `<span class="padm-faixa-tag">mês fechado</span>` : ""}
    </div>`;
}

// ===========================================================================
// 1. VISÃO GERAL
// ===========================================================================

/** @param {object} d saída de GET /administrativo/visao-geral */
export function htmlVisaoGeral(d) {
  const r = d?.resumo ?? {};
  const empresas = d?.empresas ?? [];
  const confD1 = fmtConformidade(r.conformidadeD1);
  const confMes = fmtConformidade(r.conformidadeMes, { semBase: "Sem dias esperados" });
  const elegiveisD1 = (r.concluidasD1 ?? 0) + (r.emPreenchimentoD1 ?? 0) + (r.naoRealizadasD1 ?? 0) + (r.sequenciaBloqueadaD1 ?? 0);

  // Contadores de pendência: o backend manda prontos; se vier de uma versão
  // antiga do contrato, derivam das empresas (nunca quebra a tela).
  const comPendencia = empresas.filter((e) => qtdPendentes(e) > 0);
  const nEmpresasPend = r.empresasComPendencia ?? comPendencia.length;
  const nUnidadesPend = r.unidadesComPendencia ?? comPendencia.reduce((n, e) => n + qtdPendentes(e), 0);
  const nSaudaveis = r.empresasSaudaveis ?? (empresas.length - comPendencia.length);

  const topo = cards([
    card({
      label: "Empresas com pendência", valor: fmtNum(nEmpresasPend), icone: "building",
      tom: nEmpresasPend > 0 ? "critico" : "ok", destaque: nEmpresasPend > 0,
      acao: "empresas-pendencia",
      nota: nEmpresasPend > 0
        ? `de ${fmtNum(r.empresasMonitoradas)} monitoradas · ${fmtNum(nSaudaveis)} sem pendência`
        : `todas as ${fmtNum(r.empresasMonitoradas)} empresas em dia`,
    }),
    card({
      label: "Unidades com pendência", valor: fmtNum(nUnidadesPend), icone: "store",
      tom: nUnidadesPend > 0 ? "critico" : "ok", destaque: nUnidadesPend > 0,
      acao: "unidades-pendencia",
      nota: `de ${fmtNum(r.unidadesMonitoradas)} unidades monitoradas`,
    }),
    card({
      label: "Críticas", valor: fmtNum(r.criticas), icone: "alert-triangle",
      tom: (r.criticas ?? 0) > 0 ? "critico" : "neutro",
      nota: (r.criticas ?? 0) > 0 ? "sequência travada ou pendência acumulada" : "nenhuma unidade travada",
    }),
    card({
      label: "Atenção", valor: fmtNum(r.atencao), icone: "clock",
      tom: (r.atencao ?? 0) > 0 ? "atencao" : "neutro",
      acao: "atencao",
      nota: (r.atencao ?? 0) > 0 ? "fechamento de ontem em aberto" : "nada em aberto",
    }),
    card({
      label: "Em dia", valor: fmtNum(r.emDia), icone: "check-circle", tom: "ok",
      acao: "em-dia",
      nota: "unidades sem pendência no período",
    }),
    card({
      label: "Conformidade D-1", valor: confD1.texto, icone: "target",
      progresso: confD1.fracao,
      nota: confD1.vazio ? confD1.nota : `${fmtNum(r.concluidasD1)} de ${fmtNum(elegiveisD1)} fecharam`,
    }),
    card({
      label: "Conformidade do mês", valor: confMes.texto, icone: "trending-up",
      progresso: confMes.fracao,
      nota: confMes.vazio ? confMes.nota : `${fmtNum(r.mesCompleto)} de ${fmtNum(r.mesEsperado)} dias`,
    }),
  ].join(""));

  return `
    ${faixaPeriodo(d)}
    ${topo}
    ${detalhesCardsVisao(empresas)}
    ${faixaFinanceira(d?.faturamento)}
    ${secaoAcaoNecessaria(d?.acaoNecessariaHoje ?? [], d)}
    ${secaoEmpresasComPendencia(empresas)}`;
}

function detalheCardVisao({ id, titulo, sub, corpo, tom = "" }) {
  return `
    <section class="padm-card-detalhe ${tom ? `padm-card-detalhe--${tom}` : ""}" id="padm-card-detalhe-${id}"
             data-padm-card-painel="${id}" aria-labelledby="padm-card-detalhe-titulo-${id}" hidden>
      <header class="padm-card-detalhe-head">
        <div>
          <h2 id="padm-card-detalhe-titulo-${id}">${escapeHtml(titulo)}</h2>
          <p>${escapeHtml(sub)}</p>
        </div>
        <button type="button" class="padm-card-detalhe-fechar" data-padm-card-fechar aria-label="Fechar lista">×</button>
      </header>
      <div class="padm-card-detalhe-corpo">${corpo}</div>
    </section>`;
}

/** Mini-badge numérico para o resumo de cada linha das listas dos cards. */
const miniBadge = (n, rotulo, tom) =>
  n > 0 ? `<span class="padm-mini padm-mini--${tom}">${fmtNum(n)} ${escapeHtml(rotulo)}</span>` : "";

function listaEmpresasCard(empresas) {
  if (!empresas.length) return vazio("Nenhuma empresa nesta situação", "Não há empresas com pendência no período selecionado.");
  return `<ul class="padm-card-lista">${empresas.map((e) => {
    const n = qtdPendentes(e);
    const meta = n
      ? [
          miniBadge(n, `pendente${n === 1 ? "" : "s"}`, e.criticas > 0 ? "critico" : "atencao"),
          miniBadge(e.criticas ?? 0, `crítica${(e.criticas ?? 0) === 1 ? "" : "s"}`, "critico"),
          miniBadge(e.atencao ?? 0, "em atenção", "atencao"),
        ].filter(Boolean).join("")
      : `<span class="padm-mini padm-mini--ok">sem pendência</span>`;
    return `<li>
      <button type="button" class="padm-card-lista-item" data-padm-nav="empresa" data-id="${escapeHtml(e.organizacaoId ?? "")}" data-nome="${escapeHtml(e.empresaNome ?? "")}">
        <span class="padm-card-lista-icone">${icon("building", { size: 14 })}</span>
        <span class="padm-card-lista-texto">
          <b>${escapeHtml(e.empresaNome ?? "—")}</b>
          <span class="padm-card-lista-meta">${meta}</span>
        </span>
        <span class="padm-item-ir" aria-hidden="true">›</span>
      </button>
    </li>`;
  }).join("")}</ul>`;
}

function gruposUnidadesCard(empresas, selecionar) {
  const grupos = empresas
    .map((e) => ({ empresa: e, unidades: selecionar(e) }))
    .filter((g) => g.unidades.length);
  if (!grupos.length) return vazio("Nenhuma unidade nesta situação", "Não há unidades correspondentes no período selecionado.");
  return `<div class="padm-card-grupos">${grupos.map(({ empresa, unidades }) => `
    <section class="padm-card-grupo">
      <header>
        <button type="button" data-padm-nav="empresa" data-id="${escapeHtml(empresa.organizacaoId ?? "")}" data-nome="${escapeHtml(empresa.empresaNome ?? "")}">
          ${icon("building", { size: 12 })}<b>${escapeHtml(empresa.empresaNome ?? "—")}</b>
        </button>
        <span>${unidades.length} unidade${unidades.length === 1 ? "" : "s"}</span>
      </header>
      <ul class="padm-card-lista">${unidades.map((u) => `
        <li>
          <button type="button" class="padm-card-lista-item padm-card-lista-item--${CRITICIDADE[u.criticidade]?.classe ?? "muted"}" data-padm-nav="unidade" data-id="${escapeHtml(u.unidadeId ?? "")}" data-nome="${escapeHtml(u.unidadeNome ?? "")}">
            <span class="padm-card-lista-icone">${icon("store", { size: 14 })}</span>
            <span class="padm-card-lista-texto">
              <b>${escapeHtml(u.unidadeNome ?? "—")}</b>
              <small>${escapeHtml(u.criticidade === "em_dia" ? "Em dia no período" : (CATEGORIA_D1[u.d1Status]?.rotulo ?? "Com pendência"))}${u.diasPendentes > 0 ? ` · ${escapeHtml(fmtDiasPendentes(u.diasPendentes))}` : ""}</small>
            </span>
            <span class="padm-item-ir" aria-hidden="true">›</span>
          </button>
        </li>`).join("")}</ul>
    </section>`).join("")}</div>`;
}

/** Listas abertas pelos quatro cards de identificação da Visão Geral. */
export function detalhesCardsVisao(empresas = []) {
  const comPendencia = empresas.filter((e) => qtdPendentes(e) > 0);
  return `<div class="padm-cards-detalhes">
    ${detalheCardVisao({
      id: "empresas-pendencia", titulo: "Empresas com pendência",
      sub: "Empresas que possuem ao menos uma unidade pendente no período.", tom: "critico",
      corpo: listaEmpresasCard(comPendencia),
    })}
    ${detalheCardVisao({
      id: "unidades-pendencia", titulo: "Unidades com pendência",
      sub: "Lista completa, agrupada por empresa e ordenada pela prioridade já calculada.", tom: "critico",
      corpo: gruposUnidadesCard(comPendencia, (e) => e.pendentes ?? []),
    })}
    ${detalheCardVisao({
      id: "atencao", titulo: "Unidades em atenção",
      sub: "Unidades com fechamento em aberto, agrupadas por empresa.", tom: "atencao",
      corpo: gruposUnidadesCard(empresas, (e) => (e.pendentes ?? []).filter((u) => u.criticidade === "atencao")),
    })}
    ${detalheCardVisao({
      id: "em-dia", titulo: "Unidades em dia",
      sub: "Unidades sem pendência no período selecionado, agrupadas por empresa.", tom: "ok",
      corpo: gruposUnidadesCard(empresas, (e) => e.emDiaLista ?? []),
    })}
  </div>`;
}

/**
 * Faixa financeira da home executiva: quanto a rede faturou no período, quanto
 * ainda é provisório, a cobertura e os líderes. Fica ABAIXO da pendência de
 * propósito — o painel é de monitoramento; o dinheiro é contexto, não a manchete.
 */
function faixaFinanceira(f) {
  if (!f || f.total == null) return "";
  return secao({
    titulo: "Faturamento da rede",
    icone: "banknote",
    sub: "Período selecionado",
    acoes: `<button class="btn btn-ghost btn-sm" data-padm-ir="relatorios">Ver relatórios ›</button>`,
    corpo: `
      <div class="padm-fin-faixa">
        <div class="padm-fin-total">
          <b class="padm-fin-valor">${escapeHtml(fmtDinheiro(f.total))}</b>
          <span class="padm-fin-linhas">
            ${textoCobertura(f.cobertura) ? `<span>Cobertura <b>${escapeHtml(textoCobertura(f.cobertura))}</b></span>` : ""}
            <span>Confirmado <b>${escapeHtml(fmtDinheiroCurto(f.confirmado))}</b></span>
          </span>
          ${seloProvisorio(f)}
        </div>
        <div class="padm-fin-lideres">
          ${f.liderEmpresa ? `<span class="padm-fin-lider" data-padm-nav="empresa" data-id="${escapeHtml(f.liderEmpresa.organizacaoId ?? "")}" data-nome="${escapeHtml(f.liderEmpresa.nome ?? "")}" tabindex="0" role="button"><small>Empresa líder</small><b>${escapeHtml(f.liderEmpresa.nome ?? "—")}</b><i>${escapeHtml(fmtDinheiroCurto(f.liderEmpresa.total))}</i></span>` : ""}
          ${f.liderUnidade ? `<span class="padm-fin-lider" data-padm-nav="unidade" data-id="${escapeHtml(f.liderUnidade.unidadeId ?? "")}" data-nome="${escapeHtml(f.liderUnidade.nome ?? "")}" tabindex="0" role="button"><small>Unidade líder</small><b>${escapeHtml(f.liderUnidade.nome ?? "—")}</b><i>${escapeHtml(fmtDinheiroCurto(f.liderUnidade.total))}</i></span>` : ""}
        </div>
      </div>`,
  });
}

function secaoAcaoNecessaria(itens, d) {
  const pendentes = itens.filter((it) => it.categoria !== "concluido");
  const concluidas = itens.length - pendentes.length;

  const grupos = ORDEM_ACAO
    .filter((cat) => cat !== "concluido")
    .map((cat) => ({ cat, meta: CATEGORIA_D1[cat], itens: itens.filter((it) => it.categoria === cat) }))
    .filter((g) => g.itens.length);

  const corpo = pendentes.length
    ? `<div class="padm-acao">${grupos.map(grupoAcao).join("")}</div>`
    : vazio(
        "Nada pendente neste fechamento",
        `Todas as ${fmtNum(concluidas)} unidade(s) elegíveis concluíram o fechamento de ${fmtData(d?.d1)}.`,
      );

  const selo = pendentes.length
    ? `<span class="padm-selo padm-selo--critico">${pendentes.length} a resolver</span>`
    : `<span class="padm-selo padm-selo--ok">tudo em dia</span>`;

  return secao({
    titulo: "Ação necessária",
    icone: "list-checks",
    sub: pendentes.length
      ? `Prioridade de cima para baixo${concluidas ? ` · ${concluidas} unidade(s) já concluíram` : ""}`
      : "",
    acoes: selo,
    corpo,
  });
}

function grupoAcao(g) {
  return `
    <div class="padm-grupo padm-grupo--${g.meta.classe}">
      <header class="padm-grupo-head">
        <span class="padm-grupo-ic">${icon(g.meta.icone, { size: 15 })}</span>
        <span class="padm-grupo-tit">${escapeHtml(g.meta.rotulo)}</span>
        <span class="padm-grupo-cont">${g.itens.length}</span>
      </header>
      <p class="padm-grupo-ajuda">${escapeHtml(EXPLICACAO_D1[g.cat] ?? "")}</p>
      <ul class="padm-grupo-lista">${g.itens.map((it, i) => itemAcao(it, i + 1)).join("")}</ul>
    </div>`;
}

/**
 * Item da Ação necessária — escaneável: EMPRESA em cima (é o que o gestor
 * cobra), unidade em destaque, e a métrica do período à direita.
 * `it.pendencia` é a contagem DO PERÍODO; `it.herdada` vira nota, nunca soma.
 */
function itemAcao(it, ordem) {
  const dias = fmtDiasPendentes(it.pendencia?.total);
  const desde = it.pendencia?.desde ? `desde ${fmtDataCurta(it.pendencia.desde)}` : "";
  return `
    <li class="padm-item" data-padm-nav="unidade" data-id="${escapeHtml(it.unidadeId ?? "")}" data-nome="${escapeHtml(it.unidadeNome ?? "")}" tabindex="0" role="button">
      <span class="padm-item-ordem">${ordem}</span>
      <span class="padm-item-txt">
        <span class="padm-item-emp">${icon("building", { size: 11 })}${escapeHtml(it.empresaNome ?? "—")}</span>
        <b>${escapeHtml(it.unidadeNome ?? "—")}</b>
        ${notaHerdada(it.herdada)}
      </span>
      ${dias
        ? `<span class="padm-item-pend"><b>${escapeHtml(dias)}</b>${desde ? `<small>${escapeHtml(desde)}</small>` : ""}</span>`
        : `<span class="padm-item-pend padm-item-pend--zero"><b>D-1</b><small>fechamento de ontem</small></span>`}
      <span class="padm-item-ir" aria-hidden="true">›</span>
    </li>`;
}

/**
 * A seção que responde "QUAIS empresas têm problema, e quais unidades delas".
 * Empresas com pendência vêm primeiro e JÁ ABERTAS (o painel não esconde
 * pendência); as saudáveis ficam recolhidas num bloco discreto no fim.
 */
function secaoEmpresasComPendencia(empresas) {
  if (!empresas.length) return "";
  const comPendencia = empresas.filter((e) => qtdPendentes(e) > 0);
  const saudaveis = empresas.filter((e) => qtdPendentes(e) === 0);

  const corpo = comPendencia.length
    ? `<div class="padm-emps">${comPendencia.map((e) => blocoEmpresa(e, { aberto: true })).join("")}</div>`
    : vazio("Nenhuma empresa com pendência", "Todas as empresas monitoradas estão em dia neste período.");

  const bloco = secao({
    titulo: "Empresas com pendência",
    icone: "building",
    sub: comPendencia.length ? "Da mais grave para a menos grave · as unidades pendentes já estão listadas" : "",
    acoes: comPendencia.length ? `<span class="padm-selo padm-selo--critico">${comPendencia.length} empresa(s)</span>` : "",
    corpo,
  });

  if (!saudaveis.length) return bloco;
  return bloco + `
    <details class="padm-saudaveis">
      <summary>
        <span class="padm-emp-seta" aria-hidden="true">›</span>
        ${icon("check-circle", { size: 14 })}
        <b>${saudaveis.length} empresa(s) sem pendência</b>
        <small>${escapeHtml(saudaveis.map((e) => e.empresaNome ?? "—").join(" · "))}</small>
      </summary>
      <div class="padm-emps">${saudaveis.map((e) => blocoEmpresa(e, { aberto: false })).join("")}</div>
    </details>`;
}

// ===========================================================================
// 2. MONITORAMENTO DIÁRIO
// ===========================================================================

export function htmlDiario(d, filtros = filtrosDiario) {
  const unidades = d?.unidades ?? [];
  const opcoesEmpresa = [...new Map(unidades.map((u) => [u.organizacaoId, u.empresaNome])).entries()]
    .filter(([id]) => id)
    .sort((a, b) => String(a[1] ?? "").localeCompare(String(b[1] ?? ""), "pt-BR"));

  const filtroBar = `
    <div class="padm-filtros">
      <label class="padm-f-campo">
        <span>Dia</span>
        <input type="date" id="padm-f-data" value="${escapeHtml(filtros.data || (d?.referencia ?? ""))}" max="${escapeHtml(d?.referencia ?? "")}" />
      </label>
      ${seletor("padm-f-empresa", "Empresa", filtros.organizacaoId, opcoesEmpresa.map(([id, nome]) => [id, nome ?? id]))}
      ${seletor("padm-f-status", "Status do dia", filtros.status, Object.entries(CATEGORIA_D1).filter(([k]) => k !== "nao_aplicavel").map(([k, v]) => [k, v.rotulo]))}
      ${seletor("padm-f-criticidade", "Criticidade", filtros.criticidade, Object.entries(CRITICIDADE).map(([k, v]) => [k, v.rotulo]))}
      <button class="btn btn-ghost btn-sm padm-f-limpar" data-padm-acao="limpar-filtros">Limpar</button>
    </div>`;

  const corpo = unidades.length
    ? `<ul class="padm-lista">${unidades.map(linhaDiario).join("")}</ul>`
    : vazio("Nenhuma unidade neste recorte", "Ajuste o dia ou os filtros acima.", { tom: "neutro", icone: "inbox" });

  return `
    ${faixaPeriodo(d, "Dia consultado")}
    ${filtroBar}
    ${busca("padm-busca-diario")}
    ${secao({ titulo: "Unidades", icone: "store", sub: `${unidades.length} no recorte`, corpo })}`;
}

function linhaDiario(u) {
  const dias = fmtDiasPendentes(u.diasPendentes);
  const antiga = u.pendenciaMaisAntiga ? `desde ${fmtDataCurta(u.pendenciaMaisAntiga)}` : "";
  return `
    <li class="padm-item padm-item--${CRITICIDADE[u.criticidade]?.classe ?? "muted"}" data-padm-nav="unidade" data-id="${escapeHtml(u.unidadeId ?? "")}" data-nome="${escapeHtml(u.unidadeNome ?? "")}" tabindex="0" role="button" data-busca="${escapeHtml(normalizarBusca(`${u.empresaNome} ${u.unidadeNome}`))}">
      <span class="padm-item-txt">
        <b>${escapeHtml(u.unidadeNome ?? "—")}</b>
        <small>${escapeHtml(u.empresaNome ?? "—")}</small>
        ${notaHerdada(u.pendenciaHerdada, u.pendenciaHerdadaDesde)}
      </span>
      <span class="padm-item-tags">
        ${chipCategoria(u.categoria, { comIcone: true })}
        ${chipCriticidade(u.criticidade)}
      </span>
      <span class="padm-item-dados">
        ${dias || antiga ? `<span class="padm-dado padm-dado--alerta"><small>no período</small><b>${escapeHtml([dias, antiga].filter(Boolean).join(" · "))}</b></span>` : ""}
        <span class="padm-dado"><small>mês</small><b>${fmtConformidade(u.conformidadeMes, { semBase: "—" }).texto}</b></span>
        <span class="padm-dado"><small>últ. fechamento</small><b>${fmtDataCurta(u.ultimoConcluido)}</b></span>
      </span>
      <span class="padm-item-ir" aria-hidden="true">›</span>
    </li>`;
}

function seletor(id, label, valor, pares) {
  return `
    <label class="padm-f-campo">
      <span>${escapeHtml(label)}</span>
      <select id="${id}">
        <option value="">Todos</option>
        ${pares.map(([v, r]) => `<option value="${escapeHtml(v)}" ${v === valor ? "selected" : ""}>${escapeHtml(r)}</option>`).join("")}
      </select>
    </label>`;
}

// ===========================================================================
// 3. PENDÊNCIAS — fila de trabalho prioritária
// ===========================================================================

export function htmlPendencias(d, estado = viewPendencias) {
  const todas = d?.unidades ?? [];
  if (!todas.length) {
    return `${faixaPeriodo(d, "Fechamento cobrado")}${vazio(
      "Nenhuma pendência",
      "Todas as unidades monitoradas estão em dia no fechamento deste período.",
    )}`;
  }

  const termo = normalizarBusca(estado.termo ?? "");
  const porFiltro = (u) => {
    if (estado.filtro === "criticas") return u.criticidade === "critico";
    if (estado.filtro === "atencao") return u.criticidade === "atencao";
    if (estado.filtro === "travadas") return !!u.sequenciaBloqueada;
    return true;
  };
  const visiveis = todas
    .filter(porFiltro)
    .filter((u) => !termo || normalizarBusca(`${u.empresaNome} ${u.unidadeNome}`).includes(termo));

  const contagens = {
    todas: todas.length,
    criticas: todas.filter((u) => u.criticidade === "critico").length,
    atencao: todas.filter((u) => u.criticidade === "atencao").length,
    travadas: todas.filter((u) => u.sequenciaBloqueada).length,
  };

  const corpo = visiveis.length
    ? (estado.agrupar === "status" ? agruparPorStatus(visiveis, termo) : agruparPorEmpresa(visiveis, termo))
    : vazio(
        termo ? `Nada encontrado para "${estado.termo}"` : "Nenhuma pendência neste filtro",
        termo ? "A busca cobre empresa e unidade." : "Troque o filtro acima.",
        { tom: "muted", icone: "inbox" },
      );

  const segFiltro = [
    ["todas", "Todas"], ["criticas", "Críticas"], ["atencao", "Atenção"], ["travadas", "Sequência travada"],
  ].map(([v, r]) => `<button class="padm-segm-btn ${v === estado.filtro ? "ativo" : ""}" data-padm-filtro="${v}">${r}<span class="padm-segm-n">${contagens[v]}</span></button>`).join("");

  const segAgrupar = [["empresa", "Por empresa"], ["status", "Por tipo de pendência"]]
    .map(([v, r]) => `<button class="padm-segm-btn ${v === estado.agrupar ? "ativo" : ""}" data-padm-agrupar="${v}">${r}</button>`).join("");

  return `
    ${faixaPeriodo(d, "Fechamento cobrado")}
    <div class="padm-barra-id">
      <div class="padm-segm">${segFiltro}</div>
      <div class="padm-segm padm-segm--alt">${segAgrupar}</div>
      ${busca("padm-busca-pendencias", "Buscar empresa ou unidade… (ex.: Piracicaba)", estado.termo)}
    </div>
    ${secao({
      titulo: "Fila de pendências",
      icone: "alert-triangle",
      sub: "Ordenada por gravidade — resolva de cima para baixo",
      acoes: `<span class="padm-selo padm-selo--critico">${visiveis.length} de ${todas.length}</span>`,
      corpo,
    })}`;
}

/**
 * Linha da fila de pendências — escaneável: empresa em cima, unidade em
 * destaque, tipo da pendência, dias NO PERÍODO e a nota de herança.
 */
function linhaPendencia(u, ordem, termo = "") {
  const dias = fmtDiasPendentes(u.diasPendentes);
  const desde = u.pendenciaMaisAntiga ? `desde ${fmtDataCurta(u.pendenciaMaisAntiga)}` : "";
  return `
    <li class="padm-item" data-padm-nav="unidade" data-id="${escapeHtml(u.unidadeId ?? "")}" data-nome="${escapeHtml(u.unidadeNome ?? "")}" tabindex="0" role="button">
      <span class="padm-item-ordem">${ordem}</span>
      <span class="padm-item-txt">
        <span class="padm-item-emp">${icon("building", { size: 11 })}${realce(u.empresaNome, termo)}</span>
        <b>${realce(u.unidadeNome, termo)}</b>
        ${notaHerdada(u.pendenciaHerdada, u.pendenciaHerdadaDesde)}
      </span>
      <span class="padm-item-tags">
        ${chipCategoria(u.d1Status, { comIcone: true })}
        ${chipCriticidade(u.criticidade)}
        ${u.sequenciaBloqueada ? `<span class="padm-chip padm-chip--critico">${icon("ban", { size: 12 })}travada</span>` : ""}
      </span>
      <span class="padm-item-pend">
        <b>${escapeHtml(dias || "D-1")}</b>
        <small>${escapeHtml(dias ? (desde || "no período") : "fechamento de ontem")}</small>
      </span>
      <span class="padm-item-ir" aria-hidden="true">›</span>
    </li>`;
}

/** Agrupa a fila por EMPRESA — responde "quais empresas têm mais pendência". */
function agruparPorEmpresa(unidades, termo) {
  const mapa = new Map();
  for (const u of unidades) {
    const k = u.organizacaoId ?? "sem_empresa";
    if (!mapa.has(k)) mapa.set(k, { organizacaoId: u.organizacaoId, empresaNome: u.empresaNome, itens: [] });
    mapa.get(k).itens.push(u);
  }
  // A ordem da fila já vem do backend; o grupo herda a posição do seu 1º item.
  return `<div class="padm-grupos">${[...mapa.values()].map((g) => {
    const criticas = g.itens.filter((u) => u.criticidade === "critico").length;
    const tom = criticas > 0 ? "critico" : "atencao";
    return `
      <div class="padm-grupo padm-grupo--${tom}">
        <header class="padm-grupo-head">
          <span class="padm-grupo-ic">${icon("building", { size: 15 })}</span>
          <span class="padm-grupo-tit">${realce(g.empresaNome, termo)}</span>
          <span class="padm-grupo-cont">${g.itens.length}</span>
          <button class="padm-grupo-abrir" data-padm-nav="empresa" data-id="${escapeHtml(g.organizacaoId ?? "")}" data-nome="${escapeHtml(g.empresaNome ?? "")}">detalhe ›</button>
        </header>
        <p class="padm-grupo-ajuda">${criticas ? `${criticas} unidade(s) crítica(s)` : "unidades em atenção"} · ${g.itens.length} pendente(s)</p>
        <ul class="padm-grupo-lista">${g.itens.map((u, i) => linhaPendencia(u, i + 1, termo)).join("")}</ul>
      </div>`;
  }).join("")}</div>`;
}

/** Agrupa a fila por TIPO de pendência — responde "o que está acontecendo". */
function agruparPorStatus(unidades, termo) {
  const grupos = ORDEM_ACAO
    .map((cat) => ({ cat, meta: CATEGORIA_D1[cat], itens: unidades.filter((u) => u.d1Status === cat) }))
    .filter((g) => g.itens.length);
  const outras = unidades.filter((u) => !ORDEM_ACAO.includes(u.d1Status));
  if (outras.length) grupos.push({ cat: "outras", meta: { classe: "muted", rotulo: "Outras", icone: "inbox" }, itens: outras });

  return `<div class="padm-grupos">${grupos.map((g) => `
    <div class="padm-grupo padm-grupo--${g.meta.classe}">
      <header class="padm-grupo-head">
        <span class="padm-grupo-ic">${icon(g.meta.icone, { size: 15 })}</span>
        <span class="padm-grupo-tit">${escapeHtml(g.meta.rotulo)}</span>
        <span class="padm-grupo-cont">${g.itens.length}</span>
      </header>
      <p class="padm-grupo-ajuda">${escapeHtml(EXPLICACAO_D1[g.cat] ?? "")}</p>
      <ul class="padm-grupo-lista">${g.itens.map((u, i) => linhaPendencia(u, i + 1, termo)).join("")}</ul>
    </div>`).join("")}</div>`;
}

// ===========================================================================
// 4. EMPRESAS
// ===========================================================================

export function htmlEmpresas(d, estado = viewEmpresas) {
  const todas = d?.empresas ?? [];
  if (!todas.length) {
    return `${faixaPeriodo(d)}${vazio(
      "Nenhuma empresa monitorada",
      "Nenhuma organização ativa tem o módulo Dashboard iFood habilitado.",
      { tom: "muted", icone: "building" },
    )}`;
  }

  const termo = normalizarBusca(estado.termo ?? "");
  const filtradas = filtrarEmpresas(todas, estado.filtro);
  const visiveis = termo
    ? filtradas.filter((e) => normalizarBusca([e.empresaNome, ...(e.pendentes ?? []).map((u) => u.unidadeNome)].join(" ")).includes(termo))
    : filtradas;

  const corpo = visiveis.length
    ? `<div class="padm-emps">${visiveis.map((e) => blocoEmpresa(e, { termo })).join("")}</div>`
    : vazio(
        termo ? `Nada encontrado para "${estado.termo}"` : "Nenhuma empresa neste filtro",
        termo ? "A busca cobre nome da empresa e das unidades pendentes." : "Troque o filtro acima.",
        { tom: "muted", icone: "inbox" },
      );

  return `
    ${faixaPeriodo(d)}
    <div class="padm-barra-id">
      ${filtroSeveridade(estado.filtro, contagensEmpresas(todas))}
      ${busca("padm-busca-empresas", "Buscar empresa ou unidade… (ex.: Mogi, Centro)", estado.termo)}
    </div>
    ${secao({
      titulo: "Empresas monitoradas",
      icone: "building",
      sub: "Expanda uma empresa para ver as unidades pendentes",
      acoes: `<span class="padm-selo padm-selo--${visiveis.some((e) => (e.criticas ?? 0) > 0) ? "critico" : "ok"}">${visiveis.length} de ${todas.length}</span>`,
      corpo,
    })}`;
}

// ===========================================================================
// 5. DETALHE DA EMPRESA
// ===========================================================================

export function htmlDetalheEmpresa(d) {
  const org = d?.organizacao ?? {};
  const c = d?.consolidado ?? {};
  const unidades = d?.unidades ?? [];
  const resumo = d?.resumo ?? null;
  const confD1 = fmtConformidade(c.conformidadeD1);
  const confMes = fmtConformidade(c.conformidadeMes, { semBase: "Sem dias esperados" });

  // A separação é a resposta visual a "quais unidades desta empresa estão
  // pendentes": o gestor não deve ter que ler status linha a linha.
  const pendentes = unidades.filter((u) => u.criticidade !== "em_dia");
  const emDia = unidades.filter((u) => u.criticidade === "em_dia");

  const topo = cards([
    card({ label: "Unidades", valor: fmtNum(unidades.length), icone: "store" }),
    card({
      label: "Com pendência", valor: fmtNum(pendentes.length), icone: "alert-triangle",
      tom: pendentes.length > 0 ? "critico" : "ok", destaque: pendentes.length > 0,
      nota: pendentes.length ? "listadas abaixo, da pior para a melhor" : "nenhuma unidade pendente",
    }),
    card({ label: "Críticas", valor: fmtNum(c.criticas), icone: "ban", tom: (c.criticas ?? 0) > 0 ? "critico" : "neutro" }),
    card({ label: "Atenção", valor: fmtNum(c.atencao), icone: "clock", tom: (c.atencao ?? 0) > 0 ? "atencao" : "neutro" }),
    card({ label: "Em dia", valor: fmtNum(c.emDia), icone: "check-circle", tom: "ok" }),
    card({ label: "Conformidade D-1", valor: confD1.texto, icone: "target", progresso: confD1.fracao, nota: confD1.vazio ? confD1.nota : "" }),
    card({ label: "Conformidade do mês", valor: confMes.texto, icone: "trending-up", progresso: confMes.fracao, nota: confMes.vazio ? confMes.nota : "" }),
  ].join(""));

  const pior = resumo?.piorUnidade
    ? `<div class="padm-prioridade">${icon("target", { size: 14 })}<span>Prioridade: <b>${escapeHtml(resumo.piorUnidade.unidadeNome ?? "—")}</b> — ${escapeHtml((CATEGORIA_D1[resumo.piorUnidade.d1Status] ?? {}).rotulo ?? "—")}</span></div>`
    : "";

  const secPendentes = pendentes.length
    ? secao({
        titulo: "Unidades com pendência",
        icone: "alert-triangle",
        sub: "Da mais grave para a menos grave · toque para o calendário",
        acoes: `<span class="padm-selo padm-selo--critico">${pendentes.length}</span>`,
        corpo: `<ul class="padm-lista">${pendentes.map((u, i) => linhaUnidadeDetalhe(u, i + 1)).join("")}</ul>`,
      })
    : secao({
        titulo: "Unidades com pendência",
        icone: "check-circle",
        corpo: vazio("Nenhuma unidade pendente", "Toda a empresa está em dia neste período."),
      });

  const secEmDia = emDia.length
    ? `<details class="padm-saudaveis">
         <summary>
           <span class="padm-emp-seta" aria-hidden="true">›</span>
           ${icon("check-circle", { size: 14 })}
           <b>${emDia.length} unidade(s) em dia</b>
           <small>${escapeHtml(emDia.map((u) => u.unidadeNome ?? "—").join(" · "))}</small>
         </summary>
         <ul class="padm-lista">${emDia.map((u, i) => linhaUnidadeDetalhe(u, i + 1)).join("")}</ul>
       </details>`
    : "";

  return `
    ${cabecalhoDetalhe({
      voltar: "Voltar",
      titulo: org.nome ?? "—",
      selo: chip({ classe: org.status === "ativa" ? "ok" : "muted", rotulo: rotuloStatusOrg(org.status) }),
      sub: `${fmtNum(unidades.length)} unidade(s) monitoradas · fechamento cobrado ${fmtData(d?.d1)}`,
    })}
    ${faixaPeriodo(d)}
    ${pior}
    ${topo}
    ${secPendentes}
    ${secEmDia}`;
}

/** Linha de unidade no detalhe — mostra a frase operacional, não só o enum. */
function linhaUnidadeDetalhe(u, ordem) {
  const dias = fmtDiasPendentes(u.diasPendentes);
  const cat = CATEGORIA_D1[u.d1Status] ?? { classe: "muted", rotulo: u.d1Status ?? "—" };
  return `
    <li class="padm-item" data-padm-nav="unidade" data-id="${escapeHtml(u.unidadeId ?? "")}" data-nome="${escapeHtml(u.unidadeNome ?? "")}" tabindex="0" role="button">
      <span class="padm-item-ordem">${ordem}</span>
      <span class="padm-item-txt">
        <b>${escapeHtml(u.unidadeNome ?? "—")}</b>
        <small>${escapeHtml(EXPLICACAO_D1[u.d1Status] ?? cat.rotulo)}</small>
        ${notaHerdada(u.pendenciaHerdada, u.pendenciaHerdadaDesde)}
      </span>
      <span class="padm-item-tags">
        ${chipCategoria(u.d1Status, { comIcone: true })}
        ${chipCriticidade(u.criticidade)}
      </span>
      <span class="padm-item-dados">
        ${dias ? `<span class="padm-dado padm-dado--alerta"><small>no período</small><b>${escapeHtml(dias)}</b></span>` : ""}
        <span class="padm-dado"><small>conf. mês</small><b>${fmtConformidade(u.conformidadeMes, { semBase: "—" }).texto}</b></span>
      </span>
      <span class="padm-item-ir" aria-hidden="true">›</span>
    </li>`;
}

const rotuloStatusOrg = (s) => ({ ativa: "Ativa", teste: "Em teste", bloqueada: "Bloqueada", suspensa: "Suspensa", cancelada: "Cancelada" }[s] ?? (s ?? "—"));

function cabecalhoDetalhe({ voltar, titulo, selo = "", sub = "" }) {
  return `
    <div class="padm-detalhe-head">
      <button class="btn btn-ghost btn-sm padm-voltar" data-padm-acao="voltar">
        <span aria-hidden="true">‹</span> ${escapeHtml(voltar)}
      </button>
      <div class="padm-detalhe-titulo"><h2>${escapeHtml(titulo)}</h2>${selo}</div>
      ${sub ? `<p class="padm-detalhe-sub">${escapeHtml(sub)}</p>` : ""}
    </div>`;
}

// ===========================================================================
// 6. CALENDÁRIO DA UNIDADE
// ===========================================================================

const LEGENDA_CAL = [
  ["concluido", "Concluído"],
  ["regularizado", "Regularizado após liberação"],
  ["em-preenchimento", "Em preenchimento"],
  ["liberado", "Liberado administrativamente"],
  ["nao-realizado", "Não realizado"],
  ["bloqueado", "Bloqueado pela sequência"],
  ["hoje", "Hoje"],
  ["futuro", "Ainda não venceu"],
  ["na", "Não aplicável"],
];

/**
 * Lista dos dias que exigem atenção — a tabela do item 1 do pedido. Só entra
 * dia que o painel considera cobrável e que ainda não fechou (`NAO_LANCADO`)
 * ou que fechou por liberação (para mostrar a regularização).
 *
 * A ação "Desbloquear" aparece SÓ onde o backend disse `podeDesbloquear` —
 * nenhuma regra de disponibilidade é recalculada aqui (item 4 do pedido).
 * @param {Array<object>} dias
 */
export function htmlDiasPendentes(dias = []) {
  const relevantes = dias.filter((d) => d.painel === "NAO_LANCADO" || d.situacaoDesbloqueio);
  if (!relevantes.length) {
    return `<p class="padm-vazio">Nenhum dia pendente ou liberado neste mês.</p>`;
  }

  const linhas = relevantes.map((dia) => {
    const est = estadoDiaCalendario(dia);
    const lib = dia.liberacaoAtiva;
    const acao = dia.podeDesbloquear
      ? `<button type="button" class="btn btn-sm" data-padm-desbloquear="${escapeHtml(dia.data)}">Desbloquear financeiro</button>`
      : lib && dia.situacaoDesbloqueio === "aguardando_lancamento"
        ? `<button type="button" class="btn btn-ghost btn-sm" data-padm-revogar="${escapeHtml(lib.id)}" data-padm-data="${escapeHtml(dia.data)}">Revogar liberação</button>`
        : `<span class="padm-dia-acao-vazia">—</span>`;

    // Procedência: quem liberou e quando. Some depois da revogação, mas
    // continua no histórico do backend.
    const porQuem = lib
      ? `<small class="padm-dia-origem">Liberado por ${escapeHtml(lib.criadoPorNome ?? "—")} em ${escapeHtml(fmtDataHoraCurta(lib.criadoEm))}${lib.motivoRotulo ? ` · ${escapeHtml(lib.motivoRotulo)}` : ""}</small>`
      : "";

    return `
      <li class="padm-dia-item padm-dia-item--${est.classe}">
        <span class="padm-dia-data"><b>${escapeHtml(fmtDiaCurto(dia.data))}</b></span>
        <span class="padm-dia-estado">
          <span class="padm-dia-rotulo">${escapeHtml(rotuloFinanceiroDia(dia))}</span>
          ${porQuem}
        </span>
        <span class="padm-dia-acao">${acao}</span>
      </li>`;
  }).join("");

  return `<ul class="padm-dias-lista">${linhas}</ul>`;
}

/** "02 SET" — rótulo curto do dia na lista. */
function fmtDiaCurto(iso) {
  const MESES = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];
  const [, m, d] = String(iso ?? "").split("-");
  return m && d ? `${d} ${MESES[Number(m) - 1] ?? ""}`.trim() : String(iso ?? "—");
}

/** "04/09/2026 10:32" a partir de um timestamptz; "—" quando ausente. */
function fmtDataHoraCurta(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function htmlCalendario(d, unidadeNome) {
  const dias = d?.dias ?? [];
  const nome = unidadeNome || d?.unidade?.unidadeNome || "Unidade";
  const podeAvancar = mesPodeAvancar(d?.mes, d?.dataReferencia);

  const primeiro = dias[0]?.data ? new Date(dias[0].data + "T12:00:00") : null;
  const offset = primeiro ? (primeiro.getDay() + 6) % 7 : 0; // semana começa segunda

  const celulas = [
    ...Array.from({ length: offset }, () => `<span class="padm-cal-dia padm-cal-dia--fora" aria-hidden="true"></span>`),
    ...dias.map((dia) => {
      const est = estadoDiaCalendario(dia);
      const n = Number(dia.data.slice(8, 10));
      return `<span class="padm-cal-dia padm-cal-dia--${est.classe}" title="${escapeHtml(fmtData(dia.data))} — ${escapeHtml(est.rotulo)}" aria-label="${escapeHtml(fmtData(dia.data))} — ${escapeHtml(est.rotulo)}"><i>${n}</i></span>`;
    }),
  ].join("");

  const contagem = dias.reduce((acc, dia) => {
    const c = estadoDiaCalendario(dia).classe;
    acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});

  // Destaque de risco (item 12): liberado e ainda vazio continua cobrando.
  const aguardando = d?.liberacoes?.total ?? 0;

  return `
    ${cabecalhoDetalhe({
      voltar: "Voltar",
      titulo: nome,
      sub: d?.unidade?.empresaNome ? `${d.unidade.empresaNome} · ${fmtMesLongo(d?.mes)}` : fmtMesLongo(d?.mes),
    })}
    ${d?.sequenciaBloqueada ? `<div class="padm-aviso padm-aviso--critico">${icon("ban", { size: 15 })}<span><b>Sequência bloqueada.</b> Há dia(s) sem lançamento travando os seguintes — resolva o mais antigo primeiro.</span></div>` : ""}
    ${aguardando > 0 ? `<div class="padm-aviso padm-aviso--atencao">${icon("clock", { size: 15 })}<span><b>${aguardando} dia${aguardando > 1 ? "s" : ""} liberado${aguardando > 1 ? "s" : ""} administrativamente</b> aguardando a unidade lançar o financeiro.</span></div>` : ""}
    <div class="padm-cal-wrap">
      <div class="padm-cal">
        <header class="padm-cal-nav">
          <button class="btn btn-ghost btn-sm" data-padm-acao="mes-anterior" aria-label="Mês anterior">‹</button>
          <b class="padm-cal-mes">${escapeHtml(fmtMesLongo(d?.mes))}</b>
          <button class="btn btn-ghost btn-sm" data-padm-acao="mes-proximo" aria-label="Próximo mês" ${podeAvancar ? "" : "disabled"}>›</button>
        </header>
        <div class="padm-cal-semana">${["seg", "ter", "qua", "qui", "sex", "sáb", "dom"].map((x) => `<span>${x}</span>`).join("")}</div>
        <div class="padm-cal-grade">${celulas}</div>
      </div>
      <aside class="padm-cal-lado">
        <h3>Como ler</h3>
        <ul class="padm-cal-legenda">
          ${LEGENDA_CAL.map(([c, r]) => `
            <li><i class="padm-cal-dia--${c}"></i><span>${escapeHtml(r)}</span><b>${contagem[c] ? contagem[c] : ""}</b></li>`).join("")}
        </ul>
      </aside>
    </div>
    <section class="padm-dias">
      <h3>Dias pendentes</h3>
      <p class="padm-dias-ajuda">
        Liberar um dia apenas <b>permite</b> que a unidade lance o financeiro dele —
        não preenche nada nem conclui o dia. A unidade ainda precisa entrar no
        Dashboard iFood e preencher.
      </p>
      ${htmlDiasPendentes(dias)}
    </section>`;
}

/** "próximo mês" só até o mês corrente (dataReferencia). Sem futuro infinito. */
export function mesPodeAvancar(mesIso, hojeIso) {
  if (!mesIso || !hojeIso) return false;
  return mesIso < hojeIso.slice(0, 7);
}

/** Soma `delta` meses a "AAAA-MM". */
export function deslocarMes(mesIso, delta) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(mesIso ?? ""));
  if (!m) return mesIso;
  let ano = Number(m[1]);
  let mes = Number(m[2]) + delta;
  while (mes < 1) { mes += 12; ano -= 1; }
  while (mes > 12) { mes -= 12; ano += 1; }
  return `${ano}-${String(mes).padStart(2, "0")}`;
}

// ===========================================================================
// 7. RELATÓRIOS — resumo executivo, rankings e evolução
// ===========================================================================

/**
 * ÁREA RELATÓRIOS — uma tela, abas internas. Substituiu o "Histórico"
 * informativo: agora há dado real de período para relatar.
 *
 * @param {object} d saída de /relatorios/resumo
 * @param {object} ev saída de /relatorios/evolucao
 * @param {{aba: string, escopo: string}} estado
 * @param {object|null} luc saída de /relatorios/lucratividade (abas semanais)
 */
export function htmlRelatorios(d, ev, estado = viewRelatorios, luc = null) {
  const abas = [
    ["resumo", "Resumo executivo", "clipboard-list"],
    ["faturamento", "Faturamento", "banknote"],
    ["conformidade", "Conformidade", "target"],
    ["evolucao", "Evolução", "trending-up"],
    ["lucratividade", "Lucratividade", "wallet"],
    ["rentabilidade", "Rentabilidade", "trending-up"],
  ];
  const nav = `<div class="padm-abas" role="tablist">${abas.map(([id, rot, ic]) => `
    <button class="padm-aba ${id === estado.aba ? "ativo" : ""}" data-padm-aba="${id}" role="tab" aria-selected="${id === estado.aba}">
      ${icon(ic, { size: 14 })}${escapeHtml(rot)}
    </button>`).join("")}</div>`;

  const semanal = abaSemanal(estado.aba);
  const corpo =
    estado.aba === "faturamento" ? abaFaturamento(d, estado)
    : estado.aba === "conformidade" ? abaConformidade(d, estado)
    : estado.aba === "evolucao" ? abaEvolucao(d, ev)
    : estado.aba === "lucratividade" ? abaLucratividade(luc, estado)
    : estado.aba === "rentabilidade" ? abaRentabilidade(luc, estado)
    : abaResumo(d);

  return `
    ${semanal ? navegadorSemana(luc, estado) : faixaPeriodo(d)}
    <div class="padm-barra-id">
      ${nav}
      <span class="padm-exportar">
        <button class="btn btn-ghost btn-sm" data-padm-acao="csv">${icon("package", { size: 13 })}CSV</button>
        ${semanal ? "" : `<button class="btn btn-primary btn-sm" data-padm-acao="pdf">${icon("receipt", { size: 13 })}Gerar relatório PDF</button>`}
      </span>
    </div>
    ${corpo}`;
}

/** Cartão de comparação com o mês anterior (período equivalente). */
function cardComparacao(c, chave, { rotulo, atual, formata, maiorEhMelhor = true, modo = "pct" }) {
  const bloco = c?.[chave];
  if (!bloco) return card({ label: rotulo, valor: formata(atual), icone: "trending-up" });
  const varia = modo === "pp" ? bloco.variacaoPP : bloco.variacao;
  const t = tomVariacao(varia, { maiorEhMelhor });
  // `absoluto`: a variação de PENDÊNCIAS é uma contagem (−5 pendências), não
  // uma fração — formatá-la como percentual viraria "−500%".
  const txt = modo === "pp" ? fmtVariacaoPP(varia)
    : modo === "absoluto" ? (varia == null ? "" : `${varia > 0 ? "+" : ""}${fmtNum(varia)}`)
    : fmtVariacao(varia);
  return card({
    label: rotulo,
    valor: formata(atual),
    icone: "trending-up",
    tom: t.classe === "neutro" ? "" : t.classe,
    nota: txt ? `${t.seta} ${txt} vs ${fmtMesLongo(c.periodo)} (1–${String(c.diasEquivalentes).padStart(2, "0")})` : "sem base comparável",
  });
}

function abaResumo(d) {
  const o = d?.operacao ?? {};
  const cf = d?.conformidade ?? {};
  const f = d?.faturamento ?? {};
  const c = d?.comparacao;

  const operacao = cards([
    card({ label: "Empresas monitoradas", valor: fmtNum(o.empresasMonitoradas), icone: "building" }),
    card({ label: "Unidades monitoradas", valor: fmtNum(o.unidadesMonitoradas), icone: "store" }),
    card({ label: "Empresas com pendência", valor: fmtNum(o.empresasComPendencia), icone: "alert-triangle", tom: o.empresasComPendencia > 0 ? "critico" : "ok" }),
    card({ label: "Unidades com pendência", valor: fmtNum(o.unidadesComPendencia), icone: "alert-triangle", tom: o.unidadesComPendencia > 0 ? "critico" : "ok" }),
    card({ label: "Críticas", valor: fmtNum(o.criticas), icone: "ban", tom: o.criticas > 0 ? "critico" : "" }),
    card({ label: "Atenção", valor: fmtNum(o.atencao), icone: "clock", tom: o.atencao > 0 ? "atencao" : "" }),
    card({ label: "Em dia", valor: fmtNum(o.emDia), icone: "check-circle", tom: "ok" }),
  ].join(""));

  const saude = cards([
    cardComparacao(c, "conformidadeMes", {
      rotulo: "Conformidade do mês", atual: cf.mes, formata: fmtPct, modo: "pp",
    }),
    card({ label: "Conformidade D-1", valor: fmtPct(cf.d1), icone: "target", progresso: cf.d1 ?? null, nota: `${fmtNum(cf.mesCompleto)} de ${fmtNum(cf.mesEsperado)} dias no mês` }),
    cardComparacao(c, "pendencias", {
      rotulo: "Pendências", atual: (o.criticas ?? 0) + (o.atencao ?? 0), formata: fmtNum,
      maiorEhMelhor: false, modo: "absoluto",
    }),
  ].join(""));

  const financeiro = `
    <div class="padm-fin-destaque">
      <div class="padm-fin-total">
        <span class="padm-fin-rot">Faturamento do período</span>
        <b class="padm-fin-valor">${escapeHtml(fmtDinheiro(f.total))}</b>
        <span class="padm-fin-linhas">
          <span>Confirmado <b>${escapeHtml(fmtDinheiro(f.confirmado))}</b></span>
          <span>Provisório <b>${escapeHtml(fmtDinheiro(f.provisorio))}</b></span>
          ${textoCobertura(f.cobertura) ? `<span>Cobertura <b>${escapeHtml(textoCobertura(f.cobertura))}</b></span>` : ""}
        </span>
        ${seloProvisorio(f)}
      </div>
      ${c?.faturamento ? `<div class="padm-fin-comp padm-fin-comp--${tomVariacao(c.faturamento.variacao).classe}">
        <span class="padm-fin-comp-v">${tomVariacao(c.faturamento.variacao).seta} ${escapeHtml(fmtVariacao(c.faturamento.variacao) || "—")}</span>
        <small>vs ${escapeHtml(fmtMesLongo(c.periodo))} · mesmos ${c.diasEquivalentes} dias${c.faturamento.incluiProvisorio ? " · inclui dados não finalizados" : ""}</small>
      </div>` : ""}
      <div class="padm-fin-lideres">
        ${f.liderEmpresa ? `<span class="padm-fin-lider"><small>Empresa líder</small><b>${escapeHtml(f.liderEmpresa.nome ?? "—")}</b><i>${escapeHtml(fmtDinheiro(f.liderEmpresa.total))}</i></span>` : ""}
        ${f.liderUnidade ? `<span class="padm-fin-lider"><small>Unidade líder</small><b>${escapeHtml(f.liderUnidade.nome ?? "—")}</b><i>${escapeHtml(fmtDinheiro(f.liderUnidade.total))}</i></span>` : ""}
      </div>
    </div>`;

  const prio = d?.prioridades ?? {};
  const listaPrio = (prio.empresas ?? []).length
    ? `<ul class="padm-lista">${prio.empresas.map((e, i) => `
        <li class="padm-item" data-padm-nav="empresa" data-id="${escapeHtml(e.organizacaoId ?? "")}" data-nome="${escapeHtml(e.empresaNome ?? "")}" tabindex="0" role="button">
          <span class="padm-item-ordem">${i + 1}</span>
          <span class="padm-item-txt">
            <b>${escapeHtml(e.empresaNome ?? "—")}</b>
            <small>${e.unidadesPendentes} unidade(s) pendente(s)${e.piorUnidade ? ` · prioridade: ${escapeHtml(e.piorUnidade.unidadeNome ?? "—")}` : ""}</small>
          </span>
          <span class="padm-item-tags">
            ${e.criticas > 0 ? `<span class="padm-chip padm-chip--critico">${e.criticas} crítica(s)</span>` : ""}
            ${e.atencao > 0 ? `<span class="padm-chip padm-chip--atencao">${e.atencao} atenção</span>` : ""}
          </span>
          <span class="padm-item-ir" aria-hidden="true">›</span>
        </li>`).join("")}</ul>`
    : vazio("Nenhuma empresa com pendência", "A rede está em dia neste período.");

  const r = d?.rankings ?? {};
  const top = (titulo, itens, tipo, icone) => secao({
    titulo, icone,
    corpo: (itens ?? []).length
      ? `<ul class="padm-ranks">${itens.map((i) => linhaRanking(i, { tipo })).join("")}</ul>`
      : vazio("Sem dado no período", "", { tom: "muted", icone: "inbox" }),
  });

  return `
    ${secao({ titulo: "Operação", icone: "building", corpo: operacao })}
    ${secao({ titulo: "Financeiro", icone: "banknote", corpo: financeiro })}
    ${secao({ titulo: "Conformidade", icone: "target", corpo: saude })}
    ${secao({ titulo: "Prioridades", icone: "alert-triangle", sub: "Empresas que mais precisam de ação", corpo: listaPrio })}
    ${top("Top 5 — faturamento", r.faturamentoEmpresas, "faturamento", "banknote")}
    ${top("Top 5 — conformidade", r.conformidadeEmpresas, "conformidade", "target")}
    ${top("Maior atenção necessária", r.atencaoEmpresas, "conformidade", "clock")}`;
}

/** Alternador empresas | unidades, comum às abas de ranking. */
function segEscopo(estado) {
  return `<div class="padm-segm padm-segm--alt">${[["empresas", "Empresas"], ["unidades", "Unidades"]]
    .map(([v, r]) => `<button class="padm-segm-btn ${v === estado.escopo ? "ativo" : ""}" data-padm-escopo="${v}">${r}</button>`)
    .join("")}</div>`;
}

function abaFaturamento(d, estado) {
  const r = d?.rankings ?? {};
  const itens = estado.escopo === "unidades" ? r.faturamentoUnidades : r.faturamentoEmpresas;
  const f = d?.faturamento ?? {};
  return `
    ${segEscopo(estado)}
    ${secao({
      titulo: `Ranking de faturamento — ${estado.escopo === "unidades" ? "unidades" : "empresas"}`,
      icone: "banknote",
      sub: "Posição = faturamento absoluto do período. A cobertura mostra se o dado está completo.",
      acoes: `<span class="padm-selo padm-selo--ok">${escapeHtml(fmtDinheiro(f.total))} na rede</span>`,
      corpo: (itens ?? []).length
        ? `<ul class="padm-ranks">${itens.map((i) => linhaRanking(i, { tipo: "faturamento" })).join("")}</ul>`
        : vazio("Sem faturamento no período", "Nenhuma unidade monitorada lançou o financeiro.", { tom: "muted", icone: "inbox" }),
    })}`;
}

function abaConformidade(d, estado) {
  const r = d?.rankings ?? {};
  return `
    ${secao({
      titulo: "Melhores em conformidade",
      icone: "check-circle",
      sub: "Percentual real de dias lançados no período",
      corpo: (r.conformidadeEmpresas ?? []).length
        ? `<ul class="padm-ranks">${r.conformidadeEmpresas.map((i) => linhaRanking(i, { tipo: "conformidade" })).join("")}</ul>`
        : vazio("Sem base de conformidade", "", { tom: "muted", icone: "inbox" }),
    })}
    ${secao({
      titulo: "Maior atenção necessária",
      icone: "clock",
      sub: "As mesmas empresas, pela outra ponta — onde apoiar primeiro",
      corpo: (r.atencaoEmpresas ?? []).length
        ? `<ul class="padm-ranks">${r.atencaoEmpresas.map((i) => linhaRanking(i, { tipo: "conformidade" })).join("")}</ul>`
        : vazio("Sem base de conformidade", "", { tom: "muted", icone: "inbox" }),
    })}`;
}

function abaEvolucao(d, ev) {
  const serie = ev?.serie ?? [];
  const comDado = serie.filter((p) => p.valor != null);
  const total = comDado.reduce((s, p) => s + Number(p.valor), 0);
  const media = comDado.length ? total / comDado.length : null;
  const melhor = comDado.length ? comDado.reduce((m, p) => (Number(p.valor) > Number(m.valor) ? p : m)) : null;

  return `
    ${cards([
      card({ label: "Faturamento acumulado", valor: fmtDinheiro(d?.faturamento?.total), icone: "banknote" }),
      card({ label: "Média por dia lançado", valor: fmtDinheiro(media), icone: "trending-up", nota: `${comDado.length} dia(s) com lançamento` }),
      card({ label: "Melhor dia", valor: melhor ? fmtDinheiro(melhor.valor) : "—", icone: "target", nota: melhor ? fmtData(melhor.data) : "sem base" }),
    ].join(""))}
    ${secao({
      titulo: "Evolução do faturamento",
      icone: "bar-chart",
      sub: "Valor de cada dia (delta do acumulado). Dia sem lançamento fica vazio — nunca estimado.",
      corpo: barrasEvolucao(serie),
    })}`;
}

// ===========================================================================
// 7b. RELATÓRIOS — abas SEMANAIS (Lucratividade / Rentabilidade)
// ===========================================================================
//
// Duas perguntas gerenciais diferentes, duas abas:
//   Lucratividade — faturamento + eficiência das deduções (por modelo).
//   Rentabilidade — quanto sobra depois das deduções do iFood.
// As duas leem o MESMO pacote /relatorios/lucratividade e o MESMO bloco semanal.
// A semana é um BLOCO FIXO DO MÊS (1: 01–07 · 2: 08–14 · 3: 15–21 · 4: 22–fim):
// nunca cruza meses, nunca há Semana 5. Filtro/busca/ordenação repintam do
// cache — sem refetch.

/** Hoje no fuso local (aproximação — o backend é a autoridade da semana). */
function hojeIsoLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const _pad2 = (x) => String(x).padStart(2, "0");
const _ultimoDiaMes = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).getUTCDate();
const _DIA_INICIO_BLOCO = { 1: 1, 2: 8, 3: 15, 4: 22 };

/**
 * Bloco semanal fixo do mês que contém `iso` (1: 01–07 · 2: 08–14 · 3: 15–21 ·
 * 4: 22–último dia). Dias 22+ pertencem sempre à Semana 4 — nunca há Semana 5.
 */
export function semanaDe(iso) {
  const [ano, mes, dia] = String(iso).split("-").map(Number);
  const indice = dia <= 7 ? 1 : dia <= 14 ? 2 : dia <= 21 ? 3 : 4;
  const d0 = _DIA_INICIO_BLOCO[indice];
  const df = indice < 4 ? d0 + 6 : _ultimoDiaMes(ano, mes);
  return { ano, mes, indice, inicio: `${ano}-${_pad2(mes)}-${_pad2(d0)}`, fim: `${ano}-${_pad2(mes)}-${_pad2(df)}` };
}

/**
 * Desloca `n` blocos (±). Semana 4 -> Semana 1 do mês seguinte; Semana 1 ->
 * Semana 4 do mês anterior (inclusive virada de ano). Devolve o `inicio` do bloco alvo.
 */
export function deslocarSemana(inicioIso, n) {
  const b = semanaDe(inicioIso);
  const ord = ((b.ano * 12) + (b.mes - 1)) * 4 + (b.indice - 1) + Math.trunc(n);
  const indice = ((ord % 4) + 4) % 4 + 1;
  const meses = Math.floor(ord / 4);
  const ano = Math.floor(meses / 12);
  const mes = (((meses % 12) + 12) % 12) + 1;
  return semanaDe(`${ano}-${_pad2(mes)}-${_pad2(_DIA_INICIO_BLOCO[indice])}`).inicio;
}

/** "Semana 2 · 08/09 – 14/09/2026". */
function fmtIntervaloSemana(sem) {
  if (!sem?.inicio || !sem?.fim) return "—";
  const rot = sem.indice ? `Semana ${sem.indice} · ` : "";
  return `${rot}${fmtDataCurta(sem.inicio)} – ${fmtData(sem.fim)}`;
}

/** Percentual JÁ em escala 0–100 (convenção da rentabilidade/metas). */
function pctReal(v, casas = 1) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return "—";
  return `${Number(v).toFixed(casas).replace(".", ",")}%`;
}
/** Pontos percentuais já em escala 0–100 (folga, delta de rentabilidade). */
function ppReal(v, { sinal = false } = {}) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return "";
  const n = Number(v);
  return `${sinal && n >= 0 ? "+" : ""}${n.toFixed(1).replace(".", ",")} p.p.`;
}

/** Navegador de bloco semanal — substitui a faixa de período mensal nas abas semanais. */
function navegadorSemana(luc, estado) {
  // Antes do 1º fetch usamos o bloco calculado no cliente só para o rótulo.
  const local = semanaDe(estado?.semana ?? hojeIsoLocal());
  const sem = luc?.semana ?? local;
  const corrente = luc ? luc.semana?.ehSemanaCorrente : true;
  const podeAvancar = luc ? !!luc.podeAvancar : false;
  return `
    <div class="padm-faixa padm-faixa--semana" role="group" aria-label="Semana analisada">
      <button class="padm-per-seta" data-padm-semana="anterior" aria-label="Semana anterior">${icon("chevron-left", { size: 15 })}</button>
      <span class="padm-faixa-item padm-semana-rot">
        <b>${escapeHtml(fmtIntervaloSemana(sem))}</b>
        <small>${corrente ? "semana em curso · dados até D-1" : "semana fechada"}</small>
      </span>
      <button class="padm-per-seta" data-padm-semana="proxima" aria-label="Próxima semana" ${podeAvancar ? "" : "disabled"}>${icon("chevron-right", { size: 15 })}</button>
      <button class="padm-per-atual" data-padm-semana="atual" ${corrente ? "hidden" : ""}>Semana atual</button>
    </div>`;
}

const ROTULO_STATUS_DED = {
  dentro_da_meta: "Dentro do ideal",
  dentro_do_limite: "Dentro do limite",
  atencao: "Acima do limite",
  sem_dados: "Sem meta/modelo",
};
const TOM_STATUS_DED = { dentro_da_meta: "ok", dentro_do_limite: "ok", atencao: "critico", sem_dados: "muted" };
function chipStatusDed(status) {
  const chave = status?.chave ?? "sem_dados";
  return `<span class="padm-chip padm-chip--${TOM_STATUS_DED[chave] ?? "muted"}">${escapeHtml(ROTULO_STATUS_DED[chave] ?? "—")}</span>`;
}

/** Célula de variação (fração) com seta + tom. */
function celulaVar(frac, { maiorEhMelhor = true } = {}) {
  const t = tomVariacao(frac, { maiorEhMelhor });
  const txt = fmtVariacao(frac);
  return `<span class="padm-var padm-var--${t.classe}">${t.seta} ${escapeHtml(txt || "—")}</span>`;
}

/**
 * Tabela do relatório semanal. `cols`: [{ key, rot, cel(row), alinhar?, sortVal? }].
 * `alvo` = "fat" | "ded" | "rent" liga o cabeçalho ao estado de ordenação
 * (`viewRelatorios.ord*`); `alvo = "fix"` = recorte com ordem fixa (cabeçalho
 * não clicável).
 */
function tabelaOrd({ alvo, cols, linhas, ord, nav, vazioMsg }) {
  if (!linhas.length) return vazio(vazioMsg ?? "Sem dados na semana", "", { tom: "muted", icone: "inbox" });
  const dados = ordenarLinhas(linhas, ord, cols);
  const fixa = alvo === "fix";
  const th = cols.map((c) => {
    const ativo = !fixa && ord?.col === c.key;
    const seta = ativo ? (ord.dir === "desc" ? " ↓" : " ↑") : "";
    const attrs = fixa ? "" : ` data-padm-ord="${alvo}:${c.key}" role="button" tabindex="0"`;
    return `<th class="${c.alinhar === "num" ? "padm-td-num" : ""} ${ativo ? "padm-th-ativo" : ""}"${attrs}>${escapeHtml(c.rot)}${seta}</th>`;
  }).join("");
  const linhasHtml = dados.map((row, i) => {
    const navAttr = nav ? nav(row) : "";
    const tds = cols.map((c) => `<td class="${c.alinhar === "num" ? "padm-td-num" : ""}">${c.cel(row, i)}</td>`).join("");
    return `<tr ${navAttr} ${navAttr ? 'tabindex="0" role="button"' : ""}>${tds}</tr>`;
  }).join("");
  return `<div class="padm-tabela-wrap"><table class="padm-tabela"><thead><tr>${th}</tr></thead><tbody>${linhasHtml}</tbody></table></div>`;
}

function ordenarLinhas(linhas, ord, cols) {
  if (!ord?.col) return linhas;
  const col = cols.find((c) => c.key === ord.col);
  if (!col) return linhas;
  const val = col.sortVal ?? ((r) => r[ord.col]);
  const sinal = ord.dir === "asc" ? 1 : -1;
  return [...linhas].sort((a, b) => {
    const va = val(a), vb = val(b);
    const na = va == null, nb = vb == null;
    if (na && nb) return 0;
    if (na) return 1;           // "sem dado" sempre por último
    if (nb) return -1;
    if (typeof va === "string") return sinal * va.localeCompare(vb, "pt-BR");
    return sinal * (va - vb);
  });
}

// Toda linha das abas semanais navega para a UNIDADE (calendário). A empresa é
// só contexto visual — nunca um alvo de navegação nem de ranking.
const navLoja = (r) => `data-padm-nav="unidade" data-id="${escapeHtml(r.unidadeId ?? "")}" data-nome="${escapeHtml(r.nome ?? "")}"`;

const casaBusca = (termo, ...campos) =>
  !termo || normalizarBusca(campos.filter(Boolean).join(" ")).includes(normalizarBusca(termo));

/** Célula "Unidade / Empresa" — a empresa aparece só como contexto. */
const celUnidade = (r, termo) => `<b>${realce(r.nome, termo)}</b><small>${realce(r.empresaNome, termo)}</small>`;

// ---------------------------------------------------------------------------
// ABA LUCRATIVIDADE — faturamento + eficiência das deduções (sem rentabilidade)
// A UNIDADE é a entidade ranqueada; a empresa é só contexto.
// ---------------------------------------------------------------------------
function abaLucratividade(luc, estado) {
  if (!luc) return carregando("painel");
  const rede = luc.rede ?? {};
  const unidades = luc.unidades ?? [];
  const dst = luc.destaques ?? {};

  const cardEficiencia = (rotulo, un, icone) => {
    if (!un) return card({ label: rotulo, valor: "—", icone, nota: "sem unidade com meta de modelo definida" });
    return card({
      label: rotulo, valor: escapeHtml(un.nome), icone,
      nota: `${escapeHtml(un.empresaNome ?? "")} · ${pctReal(un.deducoesPct)} de deduções · limite ${un.modeloLogisticoRotulo ?? "—"} ${pctReal(un.meta?.limite)} · folga ${ppReal(un.folgaLimitePp, { sinal: true })}`,
    });
  };

  const liderFat = [...unidades].filter((u) => u.faturamento != null).sort((a, b) => b.faturamento - a.faturamento)[0];
  const resumo = cards([
    card({ label: "Faturamento total da rede", valor: fmtDinheiro(rede.faturamento), icone: "banknote",
      nota: rede.variacaoFaturamento != null ? `${fmtVariacao(rede.variacaoFaturamento)} vs semana anterior` : "sem base comparável" }),
    card({ label: "Maior faturamento da semana", valor: liderFat ? escapeHtml(liderFat.nome) : "—", icone: "award",
      nota: liderFat ? `${escapeHtml(liderFat.empresaNome ?? "")} · ${fmtDinheiro(liderFat.faturamento)}` : "sem faturamento na semana" }),
    cardEficiencia("Melhor eficiência de deduções", dst.melhorEficiencia, "trending-up"),
    cardEficiencia("Pior eficiência de deduções", dst.piorEficiencia, "trending-down"),
  ].join(""));

  // Ranking semanal de faturamento — TODAS as unidades elegíveis (sem Top N).
  const unidadesBusca = unidades.filter((u) => casaBusca(estado.lucBusca, u.nome, u.empresaNome));
  const colsFat = [
    { key: "nome", rot: "Unidade / Empresa", alinhar: "txt", cel: (r) => celUnidade(r, estado.lucBusca) },
    { key: "modeloLogisticoRotulo", rot: "Modelo", alinhar: "txt", cel: (r) => escapeHtml(r.modeloLogisticoRotulo ?? "—") },
    { key: "faturamento", rot: "Faturamento da semana", alinhar: "num", cel: (r) => `<b>${fmtDinheiro(r.faturamento)}</b>` },
    { key: "variacaoFaturamento", rot: "vs semana anterior", alinhar: "num", cel: (r) => celulaVar(r.variacaoFaturamento) },
  ];

  // Eficiência de deduções — TODAS as unidades, modelo-aware.
  const dedFiltradas = unidades
    .filter((u) => estado.lucModelo === "todos" || u.modeloLogistico === estado.lucModelo)
    .filter((u) => casaBusca(estado.lucBusca, u.nome, u.empresaNome));
  const colsDed = [
    { key: "nome", rot: "Unidade / Empresa", alinhar: "txt", cel: (r) => celUnidade(r, estado.lucBusca) },
    { key: "modeloLogisticoRotulo", rot: "Modelo", alinhar: "txt", cel: (r) => escapeHtml(r.modeloLogisticoRotulo ?? "—") },
    { key: "deducoesPct", rot: "% real", alinhar: "num", cel: (r) => pctReal(r.deducoesPct) },
    { key: "limite", rot: "Meta / limite do modelo", alinhar: "num", sortVal: (r) => r.meta?.limite ?? null,
      cel: (r) => r.meta ? `${pctReal(r.meta.metaIdeal)} / ${pctReal(r.meta.limite)}` : "—" },
    { key: "folgaLimitePp", rot: "Folga p/ limite", alinhar: "num",
      cel: (r) => r.folgaLimitePp == null ? "—" : `<span class="padm-var padm-var--${r.folgaLimitePp >= 0 ? "ok" : "critico"}">${ppReal(r.folgaLimitePp, { sinal: true })}</span>` },
    { key: "status", rot: "Status", alinhar: "txt", sortVal: (r) => r.folgaLimitePp ?? null, cel: (r) => chipStatusDed(r.status) },
  ];

  const segModelo = `<div class="padm-segm padm-segm--alt">${[["todos", "Todos"], ["marketplace", "Marketplace"], ["full_service", "Full Service"]]
    .map(([v, r]) => `<button class="padm-segm-btn ${v === estado.lucModelo ? "ativo" : ""}" data-padm-luc-modelo="${v}">${r}</button>`).join("")}</div>`;

  const menor = luc.atencao?.menorFaturamento ?? [];
  const colsMenor = [
    { key: "nome", rot: "Unidade / Empresa", alinhar: "txt", cel: (r) => celUnidade(r, "") },
    { key: "faturamento", rot: "Faturamento", alinhar: "num", cel: (r) => fmtDinheiro(r.faturamento) },
    { key: "variacaoFaturamento", rot: "vs semana anterior", alinhar: "num", cel: (r) => celulaVar(r.variacaoFaturamento) },
    { key: "posicaoGeral", rot: "Posição geral", alinhar: "num", cel: (r) => r.posicaoGeral ?? "—" },
  ];

  return `
    ${secao({ titulo: "Resumo da semana", icone: "wallet", corpo: resumo })}
    ${secao({
      titulo: "Ranking semanal de faturamento",
      icone: "banknote", sub: "Todas as unidades da frota iFood monitorada disputam individualmente. A empresa aparece só como contexto. Sem recorte de Top N.",
      acoes: busca("padm-busca-luc", "Buscar unidade ou empresa…", estado.lucBusca),
      corpo: tabelaOrd({ alvo: "fat", cols: colsFat, linhas: unidadesBusca, ord: estado.ordFat, nav: navLoja, vazioMsg: "Nenhuma unidade com faturamento na semana" }),
    })}
    ${secao({
      titulo: "Eficiência de descontos e deduções",
      icone: "target",
      sub: "Todas as unidades, cada uma medida frente ao limite do SEU modelo (Marketplace × Full Service) — nunca pelo percentual bruto.",
      acoes: segModelo,
      corpo: tabelaOrd({ alvo: "ded", cols: colsDed, linhas: dedFiltradas, ord: estado.ordDed, nav: navLoja, vazioMsg: "Nenhuma unidade no filtro atual" }),
    })}
    ${secao({
      titulo: "10 menores faturamentos",
      icone: "trending-down", sub: "Recorte das unidades que exigem atenção pelo faturamento da semana.",
      corpo: tabelaOrd({ alvo: "fix", cols: colsMenor, linhas: menor, ord: { col: "faturamento", dir: "asc" }, nav: navLoja, vazioMsg: "Sem base para o recorte" }),
    })}`;
}

// ---------------------------------------------------------------------------
// ABA RENTABILIDADE — quanto sobra depois das deduções do iFood
// A UNIDADE é a entidade ranqueada; a empresa é só contexto.
// ---------------------------------------------------------------------------
function abaRentabilidade(luc, estado) {
  if (!luc) return carregando("painel");
  const rede = luc.rede ?? {};
  const unidades = luc.unidades ?? [];
  const dst = luc.destaques ?? {};

  const liderPct = [...unidades].filter((u) => u.rentabilidadePct != null).sort((a, b) => b.rentabilidadePct - a.rentabilidadePct)[0];
  const liderRl = [...unidades].filter((u) => u.receitaLiquida != null).sort((a, b) => b.receitaLiquida - a.receitaLiquida)[0];

  const resumo = cards([
    card({ label: "Receita líquida total da rede", valor: fmtDinheiro(rede.receitaLiquida), icone: "banknote",
      nota: rede.variacaoReceitaLiquida != null ? `${fmtVariacao(rede.variacaoReceitaLiquida)} vs semana anterior` : "sem base comparável" }),
    card({ label: "Rentabilidade média da rede", valor: pctReal(rede.rentabilidadeMediaRede), icone: "trending-up",
      nota: rede.variacaoRentabilidadeMediaPp != null ? `${ppReal(rede.variacaoRentabilidadeMediaPp, { sinal: true })} vs semana anterior` : "média ponderada Σ receita ÷ Σ faturamento" }),
    card({ label: "Maior rentabilidade %", valor: liderPct ? escapeHtml(liderPct.nome) : "—", icone: "award",
      nota: liderPct ? `${escapeHtml(liderPct.empresaNome ?? "")} · ${pctReal(liderPct.rentabilidadePct)} · ${fmtDinheiro(liderPct.rentabilidadeReais)}` : "sem base na semana" }),
    card({ label: "Maior receita líquida R$", valor: liderRl ? escapeHtml(liderRl.nome) : "—", icone: "banknote",
      nota: liderRl ? `${escapeHtml(liderRl.empresaNome ?? "")} · ${fmtDinheiro(liderRl.receitaLiquida)}` : "sem base na semana" }),
  ].join(""));

  const dm = dst.maiorRentabilidade;
  const destaque = dm ? `
    <div class="padm-fin-destaque padm-destaque-rent">
      <div class="padm-fin-total">
        <span class="padm-fin-rot">Maior rentabilidade do período</span>
        <b class="padm-fin-valor">${escapeHtml(dm.nome)}</b>
        <span class="padm-fin-linhas">
          <span>Empresa <b>${escapeHtml(dm.empresaNome ?? "—")}</b></span>
          <span>Rentabilidade <b>${pctReal(dm.rentabilidadePct)}</b></span>
          <span>Em reais <b>${fmtDinheiro(dm.rentabilidadeReais)}</b></span>
          <span>Faturamento <b>${fmtDinheiro(dm.faturamento)}</b></span>
        </span>
      </div>
    </div>` : vazio("Sem rentabilidade calculável na semana", "", { tom: "muted", icone: "inbox" });

  const unidadesBusca = unidades.filter((u) => casaBusca(estado.rentBusca, u.nome, u.empresaNome));
  const cols = [
    { key: "nome", rot: "Unidade / Empresa", alinhar: "txt", cel: (r) => celUnidade(r, estado.rentBusca) },
    { key: "modeloLogisticoRotulo", rot: "Modelo", alinhar: "txt", cel: (r) => escapeHtml(r.modeloLogisticoRotulo ?? "—") },
    { key: "faturamento", rot: "Faturamento", alinhar: "num", cel: (r) => fmtDinheiro(r.faturamento) },
    { key: "deducoes", rot: "Deduções R$", alinhar: "num", cel: (r) => fmtDinheiro(r.deducoes) },
    { key: "deducoesPct", rot: "Deduções %", alinhar: "num", cel: (r) => pctReal(r.deducoesPct) },
    { key: "receitaLiquida", rot: "Receita líquida R$", alinhar: "num", cel: (r) => `<b>${fmtDinheiro(r.receitaLiquida)}</b>` },
    { key: "rentabilidadePct", rot: "Rentabilidade %", alinhar: "num", cel: (r) => `<b>${pctReal(r.rentabilidadePct)}</b>` },
    { key: "variacaoRentabilidadePp", rot: "vs semana anterior", alinhar: "num",
      cel: (r) => r.variacaoRentabilidadePp == null ? "—" : `<span class="padm-var padm-var--${r.variacaoRentabilidadePp >= 0 ? "ok" : "critico"}">${ppReal(r.variacaoRentabilidadePp, { sinal: true })}</span>` },
  ];

  const menorFat = luc.atencao?.menorFaturamento ?? [];
  const menorRent = luc.atencao?.menorRentabilidade ?? [];
  const colsMenorFat = [
    { key: "nome", rot: "Unidade / Empresa", alinhar: "txt", cel: (r) => celUnidade(r, "") },
    { key: "faturamento", rot: "Faturamento", alinhar: "num", cel: (r) => fmtDinheiro(r.faturamento) },
    { key: "rentabilidadePct", rot: "Rentabilidade %", alinhar: "num", cel: (r) => pctReal(r.rentabilidadePct) },
    { key: "variacaoFaturamento", rot: "vs semana anterior", alinhar: "num", cel: (r) => celulaVar(r.variacaoFaturamento) },
    { key: "posicaoGeral", rot: "Posição geral", alinhar: "num", cel: (r) => r.posicaoGeral ?? "—" },
  ];
  const colsMenorRent = [
    { key: "nome", rot: "Unidade / Empresa", alinhar: "txt", cel: (r) => celUnidade(r, "") },
    { key: "faturamento", rot: "Faturamento", alinhar: "num", cel: (r) => fmtDinheiro(r.faturamento) },
    { key: "receitaLiquida", rot: "Receita líquida R$", alinhar: "num", cel: (r) => fmtDinheiro(r.receitaLiquida) },
    { key: "rentabilidadePct", rot: "Rentabilidade %", alinhar: "num", cel: (r) => pctReal(r.rentabilidadePct) },
    { key: "posicaoGeral", rot: "Posição geral", alinhar: "num", cel: (r) => r.posicaoGeral ?? "—" },
  ];

  return `
    ${secao({ titulo: "Resumo da semana", icone: "trending-up", corpo: resumo })}
    ${secao({ titulo: "Maior rentabilidade do período", icone: "award", corpo: destaque })}
    ${secao({
      titulo: "Ranking de Rentabilidade",
      icone: "trending-up", sub: "Todas as unidades da frota iFood monitorada, da maior para a menor rentabilidade. A empresa aparece só como contexto. Receita líquida = faturamento − deduções do iFood.",
      acoes: busca("padm-busca-rent", "Buscar unidade ou empresa…", estado.rentBusca),
      corpo: tabelaOrd({ alvo: "rent", cols, linhas: unidadesBusca, ord: estado.ordRent, nav: navLoja, vazioMsg: "Nenhuma unidade com rentabilidade calculável na semana" }),
    })}
    ${secao({
      titulo: "Operações que exigem atenção",
      icone: "alert-triangle",
      sub: "Dois recortes independentes de UNIDADES — uma unidade pode aparecer nos dois.",
      corpo: `
        <h3 class="padm-sub-h">10 menores em faturamento</h3>
        ${tabelaOrd({ alvo: "fix", cols: colsMenorFat, linhas: menorFat, ord: { col: "faturamento", dir: "asc" }, nav: navLoja, vazioMsg: "Sem base para o recorte" })}
        <h3 class="padm-sub-h">10 menores em rentabilidade</h3>
        ${tabelaOrd({ alvo: "fix", cols: colsMenorRent, linhas: menorRent, ord: { col: "rentabilidadePct", dir: "asc" }, nav: navLoja, vazioMsg: "Sem base para o recorte" })}`,
    })}`;
}

// ---------------------------------------------------------------------------
// CSV — sem dependência: Blob + createObjectURL
// ---------------------------------------------------------------------------

/** Escapa um campo CSV (aspas duplicadas, campo entre aspas). */
export function csvCampo(v) {
  if (v === null || v === undefined) return "";
  const t = String(v);
  return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** Monta o CSV (`;` — o separador que o Excel pt-BR espera). */
export function montarCsv(linhas) {
  return (linhas ?? []).map((l) => l.map(csvCampo).join(";")).join("\r\n");
}

/**
 * CSV do relatório. Uma seção por bloco, na mesma ordem da tela — o arquivo é
 * o relatório, não um dump da API.
 */
export function csvDoRelatorio(d, estado = viewRelatorios) {
  const o = d?.operacao ?? {}, cf = d?.conformidade ?? {}, f = d?.faturamento ?? {};
  const L = [];
  L.push(["Painel Administrativo — Relatório Executivo"]);
  L.push(["Período", fmtMesLongo(d?.periodo)], ["Fechamento monitorado", fmtData(d?.d1)], []);

  L.push(["OPERAÇÃO"]);
  L.push(["Empresas monitoradas", o.empresasMonitoradas], ["Unidades monitoradas", o.unidadesMonitoradas]);
  L.push(["Empresas com pendência", o.empresasComPendencia], ["Unidades com pendência", o.unidadesComPendencia]);
  L.push(["Críticas", o.criticas], ["Atenção", o.atencao], ["Em dia", o.emDia], []);

  L.push(["CONFORMIDADE"]);
  L.push(["D-1", fmtPct(cf.d1)], ["Mês", fmtPct(cf.mes)], ["Dias completos", cf.mesCompleto], ["Dias esperados", cf.mesEsperado], []);

  L.push(["FINANCEIRO"]);
  L.push(["Faturamento total", fmtDinheiro(f.total)]);
  L.push(["Faturamento confirmado", fmtDinheiro(f.confirmado)]);
  L.push(["Faturamento provisório (não finalizado)", fmtDinheiro(f.provisorio)]);
  L.push(["Cobertura", textoCobertura(f.cobertura)]);
  if (d?.comparacao?.faturamento) {
    L.push([`Variação vs ${fmtMesLongo(d.comparacao.periodo)} (1–${d.comparacao.diasEquivalentes})`, fmtVariacao(d.comparacao.faturamento.variacao) || "sem base"]);
    if (d.comparacao.faturamento.incluiProvisorio) L.push(["Aviso", "A comparação inclui dados não finalizados"]);
  }
  L.push([]);

  const r = d?.rankings ?? {};
  const bloco = (titulo, itens, cols, linha) => {
    L.push([titulo]); L.push(cols);
    for (const i of itens ?? []) L.push(linha(i));
    L.push([]);
  };
  bloco("RANKING — FATURAMENTO (EMPRESAS)", r.faturamentoEmpresas,
    ["Posição", "Empresa", "Faturamento", "Confirmado", "Provisório", "Cobertura", "Conformidade"],
    (i) => [i.posicao, i.nome, fmtDinheiro(i.faturamento?.total), fmtDinheiro(i.faturamento?.confirmado),
            fmtDinheiro(i.faturamento?.provisorio), textoCobertura(i.cobertura), fmtPct(i.conformidadeMes)]);
  bloco("RANKING — FATURAMENTO (UNIDADES)", r.faturamentoUnidades,
    ["Posição", "Unidade", "Empresa", "Faturamento", "Cobertura", "Conformidade"],
    (i) => [i.posicao, i.nome, i.empresaNome, fmtDinheiro(i.faturamento?.total), textoCobertura(i.cobertura), fmtPct(i.conformidadeMes)]);
  bloco("RANKING — CONFORMIDADE", r.conformidadeEmpresas,
    ["Posição", "Empresa", "Conformidade", "Faturamento"],
    (i) => [i.posicao, i.nome, fmtPct(i.conformidadeMes), fmtDinheiro(i.faturamento?.total)]);
  bloco("MAIOR ATENÇÃO NECESSÁRIA", r.atencaoEmpresas,
    ["Posição", "Empresa", "Conformidade", "Faturamento"],
    (i) => [i.posicao, i.nome, fmtPct(i.conformidadeMes), fmtDinheiro(i.faturamento?.total)]);
  bloco("PRIORIDADES — EMPRESAS COM PENDÊNCIA", d?.prioridades?.empresas,
    ["Empresa", "Unidades pendentes", "Críticas", "Atenção", "Pendência mais antiga", "Prioridade"],
    (e) => [e.empresaNome, e.unidadesPendentes, e.criticas, e.atencao, fmtData(e.pendenciaMaisAntiga), e.piorUnidade?.unidadeNome ?? ""]);

  void estado;
  return montarCsv(L);
}

/** Dispara o download. `﻿` (BOM) faz o Excel abrir em UTF-8. */
function baixarArquivoCsv(texto, nome) {
  const blob = new Blob(["﻿" + texto], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function baixarCsv(d, estado) {
  baixarArquivoCsv(csvDoRelatorio(d, estado), `painel-administrativo-${d?.periodo ?? "periodo"}.csv`);
}

/** Número em escala 0–100 -> "12,34" (sem símbolo, para o Excel calcular). */
const csvPct = (v) => (v == null || !Number.isFinite(Number(v)) ? "" : Number(v).toFixed(2).replace(".", ","));
const csvFrac = (v) => (v == null || !Number.isFinite(Number(v)) ? "" : (Number(v) * 100).toFixed(2).replace(".", ","));

/** CSV das abas semanais — a aba corrente, na mesma ordem da tela. Uma linha por UNIDADE. */
export function csvDaLucratividade(luc) {
  const L = [];
  const s = luc?.semana ?? {};
  const un = luc?.unidades ?? [];
  L.push(["Painel Administrativo — Lucratividade semanal"]);
  L.push(["Semana", s.indice ? `Semana ${s.indice} (${fmtData(s.inicio)} a ${fmtData(s.fim)})` : `${fmtData(s.inicio)} a ${fmtData(s.fim)}`], ["Dados até", fmtData(s.ateData)], []);

  L.push(["RANKING SEMANAL DE FATURAMENTO (UNIDADES)"]);
  L.push(["Posição", "Unidade", "Empresa", "Modelo", "Faturamento", "Faturamento semana anterior", "Variação %"]);
  un.forEach((u, i) => L.push([
    i + 1, u.nome, u.empresaNome, u.modeloLogisticoRotulo ?? "", fmtDinheiro(u.faturamento),
    fmtDinheiro(u.faturamentoAnterior), csvFrac(u.variacaoFaturamento),
  ]));
  L.push([]);

  L.push(["EFICIÊNCIA DE DESCONTOS E DEDUÇÕES (UNIDADES)"]);
  L.push(["Unidade", "Empresa", "Modelo", "% real deduções", "Meta ideal %", "Limite %", "Folga p/ limite (p.p.)", "Status"]);
  un.forEach((u) => L.push([
    u.nome, u.empresaNome, u.modeloLogisticoRotulo ?? "",
    csvPct(u.deducoesPct), csvPct(u.meta?.metaIdeal), csvPct(u.meta?.limite),
    csvPct(u.folgaLimitePp), ROTULO_STATUS_DED[u.status?.chave ?? "sem_dados"],
  ]));
  L.push([]);

  L.push(["10 MENORES FATURAMENTOS (UNIDADES)"]);
  L.push(["Unidade", "Empresa", "Faturamento", "Variação %", "Posição geral"]);
  (luc?.atencao?.menorFaturamento ?? []).forEach((u) => L.push([
    u.nome, u.empresaNome, fmtDinheiro(u.faturamento), csvFrac(u.variacaoFaturamento), u.posicaoGeral ?? "",
  ]));
  return montarCsv(L);
}

export function csvDaRentabilidade(luc) {
  const L = [];
  const s = luc?.semana ?? {};
  const un = luc?.unidades ?? [];
  L.push(["Painel Administrativo — Rentabilidade semanal"]);
  L.push(["Semana", s.indice ? `Semana ${s.indice} (${fmtData(s.inicio)} a ${fmtData(s.fim)})` : `${fmtData(s.inicio)} a ${fmtData(s.fim)}`], ["Dados até", fmtData(s.ateData)], []);

  L.push(["RANKING DE RENTABILIDADE (UNIDADES)"]);
  L.push(["Posição", "Unidade", "Empresa", "Modelo", "Faturamento", "Deduções R$", "Deduções %", "Receita líquida R$", "Rentabilidade %", "Variação (p.p.)"]);
  un.forEach((u, i) => L.push([
    i + 1, u.nome, u.empresaNome, u.modeloLogisticoRotulo ?? "", fmtDinheiro(u.faturamento), fmtDinheiro(u.deducoes),
    csvPct(u.deducoesPct), fmtDinheiro(u.receitaLiquida), csvPct(u.rentabilidadePct), csvPct(u.variacaoRentabilidadePp),
  ]));
  L.push([]);

  L.push(["OPERAÇÕES QUE EXIGEM ATENÇÃO — 10 MENORES EM FATURAMENTO (UNIDADES)"]);
  L.push(["Unidade", "Empresa", "Faturamento", "Rentabilidade %", "Variação %", "Posição geral"]);
  (luc?.atencao?.menorFaturamento ?? []).forEach((u) => L.push([
    u.nome, u.empresaNome, fmtDinheiro(u.faturamento), csvPct(u.rentabilidadePct), csvFrac(u.variacaoFaturamento), u.posicaoGeral ?? "",
  ]));
  L.push([]);

  L.push(["OPERAÇÕES QUE EXIGEM ATENÇÃO — 10 MENORES EM RENTABILIDADE (UNIDADES)"]);
  L.push(["Unidade", "Empresa", "Faturamento", "Receita líquida R$", "Rentabilidade %", "Posição geral"]);
  (luc?.atencao?.menorRentabilidade ?? []).forEach((u) => L.push([
    u.nome, u.empresaNome, fmtDinheiro(u.faturamento), fmtDinheiro(u.receitaLiquida), csvPct(u.rentabilidadePct), u.posicaoGeral ?? "",
  ]));
  return montarCsv(L);
}

function baixarCsvSemanal(qual) {
  const luc = ultimoDados.lucratividade;
  if (!luc) return;
  const sem = luc.semana?.inicio ?? "semana";
  if (qual === "rentabilidade") return baixarArquivoCsv(csvDaRentabilidade(luc), `rentabilidade-semana-${sem}.csv`);
  return baixarArquivoCsv(csvDaLucratividade(luc), `lucratividade-semana-${sem}.csv`);
}

// ---------------------------------------------------------------------------
// Ligação de eventos (após cada render)
// ---------------------------------------------------------------------------

function ligarLista() {
  ligarNav();
  ligarCardsResumo();
  els("[data-padm-ir]").forEach((b) =>
    b.addEventListener("click", () => nav.irParaTela?.(b.dataset.padmIr)));
  ligarBuscaLocal();
}

function ligarCardsResumo() {
  const botoes = els("[data-padm-card]");
  const paineis = els("[data-padm-card-painel]");
  const caixa = el(".padm-cards-detalhes");
  // No mobile a lista abre como painel deslizante sobre a tela (CSS via :has);
  // travar o scroll do fundo mantém a leitura organizada.
  const travar = (on) => { try { document.body?.classList?.toggle("padm-sheet-lock", on); } catch { /* fake DOM */ } };

  const fecharTodos = () => {
    botoes.forEach((b) => { b.setAttribute("aria-expanded", "false"); b.classList.remove("padm-card--ativo"); });
    paineis.forEach((p) => { p.hidden = true; });
    travar(false);
  };
  botoes.forEach((b) => b.addEventListener("click", () => {
    const painel = el(`#padm-card-detalhe-${b.dataset.padmCard}`);
    const abrir = painel?.hidden ?? false;
    fecharTodos();
    if (!painel || !abrir) return;
    painel.hidden = false;
    b.setAttribute("aria-expanded", "true");
    b.classList.add("padm-card--ativo");
    travar(true);
    painel.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }));
  els("[data-padm-card-fechar]").forEach((b) => b.addEventListener("click", fecharTodos));
  // toque fora do painel (no fundo escurecido do modo mobile) fecha
  caixa?.addEventListener?.("click", (e) => { if (e.target === caixa) fecharTodos(); });
}

function ligarNav() {
  els("[data-padm-nav]").forEach((n) => {
    const ir = () => {
      const tipo = n.dataset.padmNav;
      if (tipo === "empresa") nav.abrirEmpresa(n.dataset.id, n.dataset.nome);
      else if (tipo === "unidade") nav.abrirUnidade(n.dataset.id, n.dataset.nome);
    };
    n.addEventListener("click", ir);
    n.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ir(); } });
  });
}

/**
 * Liga os segmentos (filtro / agrupamento) e a busca das telas de
 * identificação. A busca repinta para poder DESTACAR o termo — esconder linhas
 * não mostraria onde bateu, e o gestor perderia o contexto da empresa.
 */
function ligarBarraIdentificacao({ estado, buscaId, repintar, comAgrupar = false }) {
  els("[data-padm-filtro]").forEach((b) =>
    b.addEventListener("click", () => { estado.filtro = b.dataset.padmFiltro; repintar(); }));
  if (comAgrupar) {
    els("[data-padm-agrupar]").forEach((b) =>
      b.addEventListener("click", () => { estado.agrupar = b.dataset.padmAgrupar; repintar(); }));
  }
  const inp = el(buscaId);
  if (!inp) return;
  let t;
  inp.addEventListener("input", () => {
    clearTimeout(t);
    const valor = inp.value;
    t = setTimeout(() => {
      estado.termo = valor;
      repintar();
      // devolve o foco/cursor ao campo recriado, senão o gestor perde a digitação
      const novo = el(buscaId);
      if (novo) { novo.focus(); novo.setSelectionRange?.(valor.length, valor.length); }
    }, 160);
  });
}

function ligarBuscaLocal() {
  els('input[type="search"][id^="padm-busca"]').forEach((inp) => {
    inp.addEventListener("input", () => {
      const termo = normalizarBusca(inp.value);
      els("[data-busca]").forEach((row) => {
        row.hidden = termo ? !row.dataset.busca.includes(termo) : false;
      });
    });
  });
}

function ligarDiario(api, mes) {
  ligarLista();
  const aplicar = () => renderViewPadm({ tipo: "tela", id: "diario" }, { api, mes });
  const bind = (sel, chave) => {
    const n = el(sel);
    if (n) n.addEventListener("change", () => { filtrosDiario[chave] = n.value; aplicar(); });
  };
  bind("#padm-f-data", "data");
  bind("#padm-f-empresa", "organizacaoId");
  bind("#padm-f-status", "status");
  bind("#padm-f-criticidade", "criticidade");
  el('[data-padm-acao="limpar-filtros"]')?.addEventListener("click", () => { resetFiltrosDiario(); aplicar(); });
}

function ligarDetalhe() {
  ligarNav();
  el('[data-padm-acao="voltar"]')?.addEventListener("click", () => nav.voltar?.());
}

/**
 * O calendário navega o PERÍODO GLOBAL — mudar o mês aqui move o painel
 * inteiro, para o gestor não voltar e encontrar outro mês.
 */
function ligarCalendario(ctx = {}) {
  el('[data-padm-acao="voltar"]')?.addEventListener("click", () => nav.voltar?.());
  el('[data-padm-acao="mes-anterior"]')?.addEventListener("click", () => nav.mudarPeriodo?.(-1));
  const prox = el('[data-padm-acao="mes-proximo"]');
  if (prox && !prox.disabled) prox.addEventListener("click", () => nav.mudarPeriodo?.(+1));

  els("[data-padm-desbloquear]").forEach((b) =>
    b.addEventListener("click", () => abrirModalDesbloqueio({
      ...ctx, data: b.dataset.padmDesbloquear,
    })));
  els("[data-padm-revogar]").forEach((b) =>
    b.addEventListener("click", () => confirmarRevogacao({
      ...ctx, desbloqueioId: b.dataset.padmRevogar, data: b.dataset.padmData,
    })));
}

// ===========================================================================
// 6.1 DESBLOQUEIO ADMINISTRATIVO DE UM DIA (migration 068)
//
// O painel NUNCA decide se um dia pode ser liberado — ele só oferece a ação
// onde o backend marcou `podeDesbloquear`. Aqui há apenas coleta de motivo,
// confirmação explícita e o recarregamento da tela.
// ===========================================================================

/** Motivos vindos do backend (fonte única); fallback só para o modal não vazar vazio. */
const MOTIVOS_FALLBACK = {
  dia_nao_lancado: "Dia não lançado pela unidade",
  falha_operacional: "Falha operacional",
  dados_posteriores: "Dados disponíveis posteriormente",
  correcao_administrativa: "Correção administrativa",
  outro: "Outro",
};

/**
 * HTML do modal de liberação. Construtor PURO — o teste monta e inspeciona
 * sem abrir nada (mesma disciplina de `htmlModalPdf`).
 * @param {{data: string, unidadeNome?: string, motivos?: Record<string,string>, erro?: string|null, salvando?: boolean}} ctx
 */
export function htmlModalDesbloqueio(ctx = {}) {
  const motivos = ctx.motivos ?? MOTIVOS_FALLBACK;
  const opcoes = Object.entries(motivos)
    .map(([v, r]) => `<option value="${escapeHtml(v)}">${escapeHtml(r)}</option>`).join("");

  return `
    <div class="padm-modal-fundo" data-padm-acao="fechar-desbloqueio"></div>
    <div class="padm-modal" role="dialog" aria-modal="true" aria-labelledby="padm-desb-tit">
      <header class="padm-modal-head">
        <h2 id="padm-desb-tit">Desbloquear financeiro</h2>
        <button class="padm-modal-x" data-padm-acao="fechar-desbloqueio" aria-label="Fechar">✕</button>
      </header>
      <div class="padm-modal-corpo">
        <p class="padm-desb-aviso">
          Este desbloqueio permitirá que a unidade lance manualmente o financeiro de
          <b>${escapeHtml(fmtData(ctx.data))}</b>${ctx.unidadeNome ? ` (${escapeHtml(ctx.unidadeNome)})` : ""}
          mesmo fora da sequência normal do Dashboard iFood.
        </p>
        <p class="padm-desb-nota">
          A liberação <b>não</b> preenche valores nem conclui o dia — a unidade
          ainda precisa lançar os dados normalmente.
        </p>
        <label class="padm-campo">
          <span>Motivo</span>
          <select data-padm-desb-motivo>${opcoes}</select>
        </label>
        <label class="padm-campo" data-padm-desb-obs-campo hidden>
          <span>Observação</span>
          <textarea data-padm-desb-obs rows="3" maxlength="500"
            placeholder="Descreva o motivo desta liberação."></textarea>
        </label>
        ${ctx.erro ? `<p class="padm-erro">${escapeHtml(ctx.erro)}</p>` : ""}
      </div>
      <footer class="padm-modal-pe">
        <button class="btn btn-ghost" data-padm-acao="fechar-desbloqueio">Cancelar</button>
        <button class="btn" data-padm-acao="desb-confirmar" ${ctx.salvando ? "disabled" : ""}>
          ${ctx.salvando ? "Liberando…" : "Confirmar desbloqueio"}
        </button>
      </footer>
    </div>`;
}

function pintarModalDesbloqueio(ctx) {
  const cx = caixaModal();
  if (!cx) return;
  cx.hidden = false;
  cx.innerHTML = htmlModalDesbloqueio(ctx);

  els('[data-padm-acao="fechar-desbloqueio"]').forEach((b) => b.addEventListener("click", fecharModalDesbloqueio));

  // "Outro" é o único motivo que exige texto — o backend recusa sem ele.
  const sel = el("[data-padm-desb-motivo]");
  const campoObs = el("[data-padm-desb-obs-campo]");
  const sincronizarObs = () => { if (campoObs) campoObs.hidden = sel?.value !== "outro"; };
  sel?.addEventListener("change", sincronizarObs);
  sincronizarObs();

  el('[data-padm-acao="desb-confirmar"]')?.addEventListener("click", () => confirmarDesbloqueio(ctx));
}

export function fecharModalDesbloqueio() {
  const cx = caixaModal();
  if (!cx) return;
  cx.hidden = true;
  cx.innerHTML = "";
}

/** @param {{unidadeId: string, unidadeNome?: string, data: string, api?: object, motivos?: object}} ctx */
export function abrirModalDesbloqueio(ctx = {}) {
  pintarModalDesbloqueio({ ...ctx, erro: null, salvando: false });
}

async function confirmarDesbloqueio(ctx) {
  const api = ctx.api ?? painelAdmApi;
  const motivo = el("[data-padm-desb-motivo]")?.value ?? "dia_nao_lancado";
  const observacao = el("[data-padm-desb-obs]")?.value?.trim() || undefined;

  if (motivo === "outro" && !observacao) {
    pintarModalDesbloqueio({ ...ctx, erro: "Descreva o motivo na observação." });
    return;
  }

  pintarModalDesbloqueio({ ...ctx, salvando: true, erro: null });
  try {
    await api.desbloquearDia(ctx.unidadeId, { data: ctx.data, motivo, observacao });
    fecharModalDesbloqueio();
    nav.recarregar?.();
  } catch (e) {
    if (e?.status === 403) {
      fecharModalDesbloqueio();
      nav.aoAcessoRevogado?.(e.message || "Seu acesso ao Painel Administrativo não está mais disponível.");
      return;
    }
    pintarModalDesbloqueio({ ...ctx, salvando: false, erro: e?.message ?? "Não foi possível liberar este dia." });
  }
}

/**
 * Revogar é destrutivo do ponto de vista do operador da loja (o dia volta a
 * travar), então confirma antes. Não usa modal próprio: é uma pergunta de
 * sim/não, sem dado a coletar.
 */
async function confirmarRevogacao(ctx = {}) {
  const api = ctx.api ?? painelAdmApi;
  const ok = globalThis.confirm?.(
    `Revogar a liberação de ${fmtData(ctx.data)}? O dia volta a seguir a regra normal do Dashboard iFood.`,
  );
  if (!ok) return;
  try {
    await api.revogarDesbloqueio(ctx.unidadeId, ctx.desbloqueioId);
    nav.recarregar?.();
  } catch (e) {
    if (e?.status === 403) {
      nav.aoAcessoRevogado?.(e.message || "Seu acesso ao Painel Administrativo não está mais disponível.");
      return;
    }
    globalThis.alert?.(e?.message ?? "Não foi possível revogar a liberação.");
  }
}

// ===========================================================================
// 8. RELATÓRIO EXECUTIVO EM PDF
// ===========================================================================

/** Estado do modal — a resposta do endpoint fica em cache enquanto ele vive. */
let pdfDados = null;

/**
 * HTML do modal de geração. Construtor PURO — o teste monta e inspeciona sem
 * abrir nada.
 * @param {{periodo?: string, carregando?: boolean, erro?: string|null}} ctx
 * @param {Record<string, boolean>} secoes
 */
export function htmlModalPdf(ctx = {}, secoes = secoesPdf) {
  const itens = SECOES_PDF.map((sec) => `
    <label class="padm-pdf-opt">
      <input type="checkbox" data-padm-secao="${sec.id}" ${secoes[sec.id] ? "checked" : ""} />
      <span>${escapeHtml(sec.label)}</span>
    </label>`).join("");

  return `
    <div class="padm-modal-fundo" data-padm-acao="fechar-pdf"></div>
    <div class="padm-modal" role="dialog" aria-modal="true" aria-labelledby="padm-pdf-tit">
      <header class="padm-modal-head">
        <div>
          <h2 id="padm-pdf-tit">Relatório executivo</h2>
          <p>Período: <b>${escapeHtml(fmtMesLongo(ctx.periodo))}</b></p>
        </div>
        <button class="padm-modal-x" data-padm-acao="fechar-pdf" aria-label="Fechar">✕</button>
      </header>

      <div class="padm-modal-corpo">
        <span class="padm-pdf-rot">Incluir no relatório</span>
        <div class="padm-pdf-opts">${itens}</div>
        ${ctx.erro ? `<p class="padm-pdf-erro">${escapeHtml(ctx.erro)}</p>` : ""}
        <p class="padm-pdf-nota">
          O arquivo é salvo pelo diálogo do navegador — escolha <b>Salvar como PDF</b>.
          Nome sugerido: <code>${escapeHtml(nomeArquivoPdf(ctx.periodo))}</code>
        </p>
      </div>

      <footer class="padm-modal-pe">
        <button class="btn btn-ghost btn-sm" data-padm-acao="fechar-pdf">Cancelar</button>
        <button class="btn btn-ghost btn-sm" data-padm-acao="pdf-preview" ${ctx.carregando ? "disabled" : ""}>Visualizar</button>
        <button class="btn btn-primary btn-sm" data-padm-acao="pdf-gerar" ${ctx.carregando ? "disabled" : ""}>
          ${ctx.carregando ? "Preparando…" : "Gerar PDF"}
        </button>
      </footer>
    </div>`;
}

const caixaModal = () => el("#padm-modal");

function pintarModalPdf(ctx) {
  const cx = caixaModal();
  if (!cx) return;
  cx.hidden = false;
  cx.innerHTML = htmlModalPdf(ctx, secoesPdf);

  els('[data-padm-acao="fechar-pdf"]').forEach((b) => b.addEventListener("click", fecharModalPdf));
  els("[data-padm-secao]").forEach((c) =>
    c.addEventListener("change", () => { secoesPdf[c.dataset.padmSecao] = !!c.checked; }));
  el('[data-padm-acao="pdf-gerar"]')?.addEventListener("click", () => {
    if (pdfDados) gerarPdf(pdfDados, secoesPdf);
  });
  el('[data-padm-acao="pdf-preview"]')?.addEventListener("click", () => {
    if (pdfDados) previewPdf(pdfDados, secoesPdf);
  });
}

export function fecharModalPdf() {
  const cx = caixaModal();
  if (!cx) return;
  cx.hidden = true;
  cx.innerHTML = "";
  pdfDados = null;
}

/**
 * Abre o modal e busca o pacote do relatório. O 403 segue a mesma regra do
 * resto do painel: volta para a seleção de ambiente.
 * @param {{api?: object, mes?: string}} [opts]
 */
export async function abrirModalPdf(opts = {}) {
  const api = opts.api ?? ultimoDados.apiAtual ?? painelAdmApi;
  const mes = opts.mes ?? ultimoDados.mesAtivo ?? undefined;

  pdfDados = null;
  pintarModalPdf({ periodo: mes ?? ultimoDados.relatorio?.periodo, carregando: true });
  try {
    pdfDados = await api.relatorioExecutivo({ mes });
    pintarModalPdf({ periodo: pdfDados.periodo, carregando: false });
  } catch (e) {
    if (e && e.status === 403) {
      fecharModalPdf();
      nav.aoAcessoRevogado?.(e.message || "Seu acesso ao Painel Administrativo não está mais disponível.");
      return;
    }
    pintarModalPdf({
      periodo: mes, carregando: true,
      erro: /failed to fetch|networkerror/i.test(e?.message ?? "")
        ? "Falha de conexão ao preparar o relatório. Tente novamente."
        : (e?.message ?? "Não foi possível preparar o relatório."),
    });
  }
}
