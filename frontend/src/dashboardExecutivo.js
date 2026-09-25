// DASHBOARD EXECUTIVO — lançamento financeiro diário por unidade (fechamento
// do iFood) com cálculo automático de percentuais, deduções, projeção,
// diagnóstico e recomendações. O franqueado preenche só os dados brutos;
// tudo o mais é calculado no backend (dashboardExecutivo.calc.js) e só
// exibido aqui.
import { el, els, escapeHtml, toast, fmtMoeda, fmtPct, fmtDataHora } from "./utils.js";
import { state } from "./state.js";
import { pode } from "./sessao.js";
import {
  dashExecUnidades, dashExecMes, dashExecHistorico,
  dashExecAtualizarModeloLogistico,
} from "./api.js";
import { INTEGRACOES_LOGOS } from "./config.js";
import {
  destruirGraficosDashboardExecutivo, barraComparativaMeta, roscaDeducoes,
  linhaEvolucao, linhaFinanceiroAcumulado, linhaDeducoesAcumuladas, barraComparativoMensal, visaoAnual,
} from "./charts.js";
import { registrarResetDeContexto, geracaoContexto, contextoMudou } from "./contextoEscopo.js";
import { abrirLancamentoModal, avisarAlteracaoExterna } from "./dashboardExecutivoForm.js";
import { registrarInteresse } from "./realtime/realtimeBus.js";
import { EVENTOS_DASHBOARD_IFOOD, RESINCRONIZACAO } from "./realtime/realtimeEvents.js";
import { abrirLancamentoMensalModal } from "./dashboardExecutivoMensal.js";
import { abrirTrocaModeloModal } from "./dashboardExecutivoModeloModal.js";
import { linhasSegmentos, avisoDivisaoIndisponivel, modeloDaData, avisoLancamentoMensalBloqueado } from "./dashboardExecutivoModelo.js";
import {
  montarConciliacao, linhasComparativoIndicadores, linhasComparativoOperacional, notaAmostraPequena,
} from "./dashboardExecutivoConciliacao.js";
import { montarSimuladorPreco } from "./dashboardExecutivoSimulador.js";
import { icon } from "./icons.js";
import { botaoContextualHtml, botaoDiagnosticoHtml, ligarBotoesContextuais, sincronizarContextoPainel } from "./agentePainel.js";
import { planoAcaoHtml, fmtPp } from "./dashboardExecutivoPlano.js";
// Formatadores de 2 casas — SÓ para a tabela de Indicadores de Rentabilidade
// (ver renderIndicadores). O resto do Dashboard segue `fmtPct`/`fmtPp` de 1 casa.
import { fmtPctRentabilidade, fmtPpRentabilidade } from "./dashboardExecutivoRentabilidade.js";

const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const ABAS = [
  { id: "visao", icone: "bar-chart", label: "Visão Geral" },
  { id: "lancamentos", icone: "calendar", label: "Lançamentos" },
  { id: "indicadores", icone: "target", label: "Indicadores" },
  { id: "historico", icone: "archive", label: "Histórico" },
];
// FINANCEIRO_PENDENTE é, no banco, um lançamento com status='rascunho' (ver
// dashboardExecutivo.calc.js#statusDiaBase — só existe pra não bloquear a
// SEQUÊNCIA do calendário enquanto o Financeiro daquele dia ainda não está
// disponível, ver RESOLVIDOS/migration 035). Ele já foi apresentado como
// "Preenchido" (verde) aqui — foi revertido: um rascunho continua rascunho
// na tela, mesmo quando a única coisa que falta é um dado que o sistema
// ainda não liberou. "Situação/Desempenho completos, só falta o Financeiro"
// segue comunicado do jeito certo: o badge complementar "Financeiro
// disponível" dentro do dia (ver badgeFinanceiro), nunca a cor do dia em si.
const STATUS_LEGENDA = [
  { chave: "PREENCHIDO", label: "Preenchido", classe: "ok" },
  { chave: "RASCUNHO", label: "Rascunho", classe: "warn" },
  { chave: "PENDENTE", label: "Pendente", classe: "bad" },
  { chave: "BLOQUEADO", label: "Bloqueado", classe: "muted" },
  { chave: "SEM_OPERACAO", label: "Sem operação", classe: "info" },
  { chave: "ZERO_VENDAS", label: "Zero vendas", classe: "info" },
  { chave: "FUTURO", label: "Futuro", classe: "muted" },
];
const STATUS_ROTULO = Object.fromEntries(STATUS_LEGENDA.map((s) => [s.chave, s]));
/** Status "de verdade" que cada status VISUAL usa pra pintar o dia — só o
 * mapeamento acima descrito. O status explícito do lançamento (rascunho x
 * finalizado) tem prioridade sobre qualquer heurística de "já tem dado
 * salvo" — é por isso que FINANCEIRO_PENDENTE (rascunho de verdade no
 * banco) vira RASCUNHO aqui, nunca PREENCHIDO. */
const statusVisual = (status) => (status === "FINANCEIRO_PENDENTE" ? "RASCUNHO" : status);

/** Situações em que a unidade operou e o Financeiro é um extrato REAL do
 * iFood — "normal" e "parcial" ("Funcionou, parcialmente"). Espelha
 * situacaoOperou() em dashboardExecutivo.calc.js. */
const situacaoOperou = (situacao) => situacao === "normal" || situacao === "parcial";

const hoje = new Date();
const dex = {
  aba: "visao",
  unidadeId: null,
  unidades: [],
  agregadoDisponivel: false,
  mes: hoje.getMonth() + 1,
  ano: hoje.getFullYear(),
  dadosMes: null,
  historico: null,
};

// Troca de unidade/empresa: nada do contexto anterior pode sobreviver aqui.
// `unidadeId` e `unidades` são os mais críticos — sem zerar, a tela podia
// insistir numa unidade que nem existe no contexto novo; `dadosMes` e
// `historico` são o dado financeiro em si. Mês/ano voltam ao mês corrente
// (é o padrão de quem acabou de entrar numa unidade).
registrarResetDeContexto(() => {
  dex.aba = "visao";
  dex.unidadeId = null;
  dex.unidades = [];
  dex.agregadoDisponivel = false;
  dex.mes = hoje.getMonth() + 1;
  dex.ano = hoje.getFullYear();
  dex.dadosMes = null;
  dex.historico = null;
  destruirGraficosDashboardExecutivo();
});

// ---------------------------------------------------------------------------
// REALTIME (Etapa 2 — piloto) — Dashboard iFood como primeiro módulo
// funcional a usar a infraestrutura da Etapa 1.
//
// NÃO reconstrói nada: um evento relevante só chama `carregarConteudo()`/
// `renderHistorico()`, os MESMOS caminhos que "salvar" já usa via `onSalvo`
// — cálculo, cards, gráficos, calendário e indicadores continuam vindo de
// lá, sem duplicação nenhuma aqui.
//
// Nunca chama `.channel()`/fala com o Realtime diretamente — só
// `realtimeBus.registrarInteresse`, o padrão central da Etapa 1.
// ---------------------------------------------------------------------------

/** Janela de coalescing: qualquer atualização (local OU remota) suprime a
 * próxima atualização remota que chegar pouco depois. Resolve dois casos com
 * o mesmo mecanismo simples: (1) o dispositivo que salvou não refaz o fetch
 * de novo só porque recebeu o eco do próprio Broadcast; (2) uma rajada de
 * eventos (lançamento mensal, duas edições quase juntas) não gera uma
 * cascata de GETs — só o primeiro dispara, o resto cai dentro da janela.
 * Contrapartida aceita: uma mudança GENUÍNA de outro dispositivo dentro dessa
 * janela pode demorar até `JANELA_SUPRIMIR_REFRESH_MS` pra aparecer aqui —
 * nunca fica permanentemente desatualizado, só atrasado por poucos segundos. */
const JANELA_SUPRIMIR_REFRESH_MS = 3000;
let ultimaAtualizacaoEm = 0;
const marcarAtualizacaoAgora = () => { ultimaAtualizacaoEm = Date.now(); };
const atualizacaoRecente = () => Date.now() - ultimaAtualizacaoEm < JANELA_SUPRIMIR_REFRESH_MS;

/** Só para teste: zera a janela de coalescing, para que testes de relevância
 * em sequência (cada um bem abaixo de 3s) não sejam suprimidos pelo refresh
 * do teste anterior — mesmo padrão de `realtimeBus.js#_resetParaTeste`. */
export function _resetCoalescingParaTeste() { ultimaAtualizacaoEm = 0; }

/** Eventos que podem descrever a MESMA entidade que um formulário tem aberto
 * — só edição/exclusão; criação sempre é uma entidade NOVA (nunca colide
 * com o id de um lançamento que já estava aberto). */
const EVENTOS_QUE_PODEM_CONFLITAR_COM_FORMULARIO = new Set([
  EVENTOS_DASHBOARD_IFOOD.LANCAMENTO_ATUALIZADO,
  EVENTOS_DASHBOARD_IFOOD.LANCAMENTO_EXCLUIDO,
]);

/** O contexto (empresa/unidade) do evento é o que esta tela está mostrando
 * agora? Fase O: em "Todas as unidades" (dex.unidadeId nulo), qualquer
 * unidade da MESMA empresa é relevante para o agregado — o canal
 * `empresa:X` já garante que só chega evento da empresa certa, mas a
 * checagem aqui é defensiva (nunca confia só no canal). */
function escopoBate(evento) {
  const minhaEmpresa = state.sessao.empresa?.id;
  if (minhaEmpresa && evento.organizacaoId && evento.organizacaoId !== minhaEmpresa) return false;
  if (dex.unidadeId) return evento.unidadeId === dex.unidadeId;
  return true;
}

/** A competência do evento é a que esta ABA está mostrando agora? "Histórico"
 * mostra o ANO inteiro (dashExecHistorico), não um mês — basta o ano bater.
 * As demais abas (Visão/Lançamentos/Indicadores) compartilham dex.dadosMes,
 * de um mês específico. Sem `competencia` no payload (defensivo), nunca
 * ignora por falta de dado. */
function competenciaBate(competencia) {
  if (!competencia) return true;
  const [anoEvento, mesEvento] = competencia.split("-").map(Number);
  if (dex.aba === "historico") return anoEvento === dex.ano;
  return anoEvento === dex.ano && mesEvento === dex.mes;
}

/** Modelo logístico não tem "competência": ele decide, ao vivo, como
 * QUALQUER mês é calculado (resolverMetas lê o modelo atual da unidade no
 * momento do fetch, nunca um snapshot por mês) — por isso é relevante para
 * o mês/aba que estiver aberto agora, sem checar competência. */
function eventoRelevanteParaTelaAtual(evento) {
  if (!escopoBate(evento)) return false;
  if (evento.tipo === EVENTOS_DASHBOARD_IFOOD.MODELO_LOGISTICO_ATUALIZADO) return true;
  return competenciaBate(evento.competencia);
}

/** Recarrega o que a ABA ATUAL de fato usa — nunca sempre `carregarConteudo`:
 * "Histórico" busca por conta própria (ano inteiro), fora de `dex.dadosMes`. */
function atualizarConteudoAtual(opts) {
  if (dex.aba === "historico") return renderHistorico(el("#dex-conteudo"), opts);
  return carregarConteudo(opts);
}

registrarInteresse({
  eventos: [...Object.values(EVENTOS_DASHBOARD_IFOOD), RESINCRONIZACAO],
  // Checagem barata: só continua se a tela estiver mesmo montada agora —
  // Fase J ("módulo não aberto? não faz nada; o próximo fetch normal já
  // vem atualizado"). O resto da lógica de relevância mora em aoReceber.
  relevante: () => state.rota === "dashboard-executivo",
  aoReceber: (evento) => {
    // Conflito com formulário aberto — SEMPRE, independente de mês/aba: o
    // usuário pode estar editando um lançamento de um mês diferente do que
    // a tela de fundo mostra no momento (ex.: reabriu de outra aba). Nunca
    // sobrescreve o que ele está digitando — só sinaliza (ver
    // dashboardExecutivoForm.js#avisarAlteracaoExterna).
    if (EVENTOS_QUE_PODEM_CONFLITAR_COM_FORMULARIO.has(evento.tipo)) avisarAlteracaoExterna(evento.entidadeId);

    if (evento.tipo === RESINCRONIZACAO) {
      // Reconectou depois de uma queda — Fase S/T: nunca tenta reproduzir os
      // eventos perdidos, só busca o estado ATUAL do banco pela tela aberta.
      if (!escopoBate(evento)) return;
    } else if (!eventoRelevanteParaTelaAtual(evento)) {
      return;
    }
    if (atualizacaoRecente()) return; // já atualizamos há pouco (local ou remoto) — evita refetch duplicado/rajada
    atualizarConteudoAtual({ silencioso: true });
  },
});

const podeLancar = () => pode("dashboard_executivo.lancar");
const vazio = (nomeIcone, titulo, msg, extra = "") =>
  `<div class="estado"><span class="estado-ic">${icon(nomeIcone, { size: 24 })}</span><h3>${escapeHtml(titulo)}</h3><p>${escapeHtml(msg)}</p>${extra}</div>`;
const carregando = () => `<div class="estado"><div class="spinner"></div>Carregando…</div>`;

export async function renderDashboardExecutivo() {
  const view = el("#view");
  if (!view) return;
  view.innerHTML = carregando();
  const g = geracaoContexto();
  try {
    const { data } = await dashExecUnidades();
    // Trocou de unidade enquanto isto voltava: esta lista é do contexto
    // ANTERIOR. Descarta — quem entrou na unidade nova já disparou o próprio
    // carregamento, e escrever aqui sobrescreveria a tela certa com dado velho.
    if (contextoMudou(g)) return;
    dex.unidades = data.unidades ?? [];
    dex.agregadoDisponivel = data.agregadoDisponivel;
    // O contexto pode ter mudado desde o último carregamento (ex.: "Trocar
    // unidade" no menu do usuário) — se a unidade que estava selecionada não
    // existe mais nesta lista (novo contexto, outra unidade/organização),
    // não insiste nela: o backend rejeitaria com "sem acesso a esta unidade".
    if (!dex.unidadeId || !dex.unidades.some((u) => u.id === dex.unidadeId)) {
      dex.unidadeId = dex.unidades[0]?.id ?? null;
    }
    montarLayout();
    await carregarConteudo();
  } catch (e) {
    if (contextoMudou(g)) return;
    view.innerHTML = vazio("alert-triangle", "Erro ao carregar", e.message, `<button class="btn btn-ghost btn-sm" id="dex-retry">Tentar novamente</button>`);
    el("#dex-retry")?.addEventListener("click", renderDashboardExecutivo);
  }
}

function montarLayout() {
  const view = el("#view");
  const anos = anosDisponiveis();
  view.innerHTML = `
    <div class="dex-head">
      <div class="dex-head-txt">
        <h2>${INTEGRACOES_LOGOS.ifood ? `<img src="${INTEGRACOES_LOGOS.ifood}" alt="iFood" class="dex-logo">` : ""}Dashboard iFood</h2>
        <p>Lançamento financeiro diário do iFood — preencha os dados brutos; percentuais, deduções e projeções são calculados automaticamente.</p>
        ${botaoContextualHtml("dashboard_executivo")}
      </div>
      <div id="dex-modelo-box" class="dex-modelo-box"></div>
    </div>
    <div class="dex-filtros">
      ${dex.unidades.length > 1 || dex.agregadoDisponivel ? `
      <label class="cfg-campo"><span>Unidade</span>
        <select id="dex-unidade">
          ${dex.unidades.map((u) => `<option value="${u.id}" ${u.id === dex.unidadeId ? "selected" : ""}>${escapeHtml(u.nome)}</option>`).join("")}
          ${dex.agregadoDisponivel ? `<option value="" ${!dex.unidadeId ? "selected" : ""}>Todas as unidades</option>` : ""}
        </select></label>` : ""}
      <label class="cfg-campo"><span>Mês</span>
        <select id="dex-mes">${MESES.map((m, i) => `<option value="${i + 1}" ${i + 1 === dex.mes ? "selected" : ""}>${m}</option>`).join("")}</select></label>
      <label class="cfg-campo"><span>Ano</span>
        <select id="dex-ano">${anos.map((a) => `<option value="${a}" ${a === dex.ano ? "selected" : ""}>${a}</option>`).join("")}</select></label>
      ${podeLancar() && dex.unidadeId ? `<button class="btn btn-ghost btn-sm dex-btn-lancamento-mensal" id="dex-lancamento-mensal" type="button">${icon("calendar", { size: 14 })} Lançar faturamento mensal</button>` : ""}
    </div>
    <nav class="dex-nav" aria-label="Seções do Dashboard iFood">
      ${ABAS.map((a) => `<button class="dex-tab ${a.id === dex.aba ? "ativo" : ""}" data-aba="${a.id}">${icon(a.icone, { size: 15 })} ${a.label}</button>`).join("")}
    </nav>
    <div id="dex-conteudo" class="dex-conteudo"></div>`;

  el("#dex-unidade")?.addEventListener("change", (e) => { dex.unidadeId = e.target.value || null; carregarConteudo(); });
  el("#dex-mes").addEventListener("change", (e) => { dex.mes = Number(e.target.value); carregarConteudo(); });
  el("#dex-ano").addEventListener("change", (e) => { dex.ano = Number(e.target.value); carregarConteudo(); });
  el("#dex-lancamento-mensal")?.addEventListener("click", () => {
    // Bloqueio preventivo (UX): o backend segue sendo a proteção real (409 em
    // período misto sem lote ainda) — isto só evita abrir o formulário para nada.
    const aviso = avisoLancamentoMensalBloqueado(dex.dadosMes?.modeloPeriodo, !!dex.dadosMes?.lancamentoMensal);
    if (aviso) { toast(aviso); return; }
    abrirLancamentoMensalModal({
      unidadeId: dex.unidadeId, mes: dex.mes, ano: dex.ano, modeloLogistico: dex.dadosMes?.modeloLogistico, onSalvo: carregarConteudo,
    });
  });
  ligarBotoesContextuais(view);
  view.querySelectorAll(".dex-tab").forEach((b) => b.addEventListener("click", () => irParaAba(b.dataset.aba)));
}

function anosDisponiveis() {
  const atual = hoje.getFullYear();
  const lista = [];
  for (let a = atual + 1; a >= atual - 3; a--) lista.push(a);
  return lista;
}

// `contextoMudou` só cobre troca de EMPRESA/UNIDADE (Context Token) — troca
// de MÊS/ANO no mesmo contexto não mexe nele. Sem uma guarda própria pra
// isso, duas chamadas de carregarConteudo() em voo ao mesmo tempo (usuário
// troca de mês rápido, ou a rede entrega fora de ordem) corriam risco real:
// se a resposta do mês ANTERIOR chegasse DEPOIS da resposta do mês atual,
// ela sobrescrevia `dex.dadosMes` com o mês errado — e a faixa "Faturamento
// mensal lançado" (que lê `dadosMes.lancamentoMensal`) acabava mostrando o
// lançamento de um mês enquanto a tela mostrava outro. `geracaoConteudo` é
// um contador simples: só a chamada mais recente pode gravar o resultado.
let geracaoConteudo = 0;

/**
 * Caminho oficial de recarregar o mês — usado por "salvar" (via `onSalvo`)
 * e agora também pelo Realtime (ver o registro acima). `silencioso` evita o
 * "pisca e recarrega tudo" (skeleton cheio) num refresh disparado por
 * evento — mantém o conteúdo atual na tela até a resposta nova chegar,
 * porque "tempo real" não deve parecer "a página recarregou sozinha".
 * @param {{silencioso?: boolean}} [opts]
 */
async function carregarConteudo({ silencioso = false } = {}) {
  const box = el("#dex-conteudo");
  if (!box) return;
  marcarAtualizacaoAgora();
  if (!silencioso) box.innerHTML = carregando();
  destruirGraficosDashboardExecutivo();
  // Espelho pro Agente Crescer montar o Page Context (agentePageContext.js)
  // — nunca lido de volta aqui, só escrito; state.js é a única ponte entre
  // esta tela e o painel, evita import circular entre os dois módulos.
  state.periodoDashboardExecutivo = { ano: dex.ano, mes: dex.mes };
  // Etapa H — cada carregamento novo do mês começa sem nenhum ponto de
  // atenção sob investigação; só volta a existir se o usuário clicar em
  // "✦ Diagnosticar..." de novo neste render (ver botaoDiagnosticoHtml).
  state.detalheAberto.attentionPoint = null;
  sincronizarContextoPainel();
  const g = geracaoContexto();
  const minhaGeracao = ++geracaoConteudo;
  const mesPedido = dex.mes, anoPedido = dex.ano;
  try {
    const { data } = await dashExecMes({ unidadeId: dex.unidadeId || undefined, mes: mesPedido, ano: anoPedido });
    if (contextoMudou(g)) return; // resposta da unidade/empresa anterior — descarta
    if (minhaGeracao !== geracaoConteudo) return; // resposta de um mês/ano que já não é mais o selecionado — descarta
    dex.dadosMes = data;
    renderModeloBox();
    renderAbaAtual();
  } catch (e) {
    if (contextoMudou(g)) return;
    if (minhaGeracao !== geracaoConteudo) return;
    box.innerHTML = vazio("alert-triangle", "Erro ao carregar", e.message, `<button class="btn btn-ghost btn-sm" id="dex-retry-mes">Tentar novamente</button>`);
    el("#dex-retry-mes")?.addEventListener("click", carregarConteudo);
  }
}

// ---------------------------------------------------------------------------
// MODELO LOGÍSTICO DO IFOOD (Marketplace x Full Service) — cabeçalho
// ---------------------------------------------------------------------------
const ROTULO_MODELO = { marketplace: "Marketplace", full_service: "Full Service" };

function renderModeloBox() {
  const caixa = el("#dex-modelo-box");
  const d = dex.dadosMes;
  if (!caixa || !d) return;

  if (d.agregado) {
    caixa.innerHTML = `<span class="dex-modelo-nota">${icon("tag", { size: 13 })} Modelo logístico: varia por unidade nesta visão consolidada</span>`;
    return;
  }

  // O <select> mostra o modelo de HOJE (`modeloAtual`); o modelo do PERÍODO
  // exibido pode ser outro (mês passado) ou "misto" — ver notaPeriodoModelo.
  const atual = d.modeloAtual?.modeloLogistico ?? d.modeloLogistico;
  const nota = notaPeriodoModelo(d);
  if (pode("dashboard_executivo.configurar")) {
    caixa.innerHTML = `<label class="dex-modelo-campo"><span>Modelo logístico</span>
      <select id="dex-modelo-select">
        <option value="marketplace" ${atual === "marketplace" ? "selected" : ""}>Marketplace</option>
        <option value="full_service" ${atual === "full_service" ? "selected" : ""}>Full Service</option>
      </select></label>${nota}`;
    el("#dex-modelo-select").addEventListener("change", (e) => trocarModeloLogistico(e.target.value, atual));
    // Unidade que já trocou no passado SEM data registrada (ex.: começou Marketplace, hoje é
    // Full Service): informa desde quando o modelo atual vale — é isso que separa os dias.
    if (!d.modeloAtual?.possuiTrocaDatada) {
      caixa.insertAdjacentHTML("beforeend", `<button class="btn btn-ghost btn-sm" id="dex-modelo-declarar" type="button" title="Informe desde quando o modelo atual vale; antes disso a unidade é lida como o outro modelo.">Informar quando o modelo atual começou</button>`);
      el("#dex-modelo-declarar").addEventListener("click", () => abrirTrocaModeloModal({
        unidadeId: dex.unidadeId, modeloAtual: atual, declararInicio: true, onSalvo: carregarConteudo,
      }));
    }
  } else {
    caixa.innerHTML = `<span class="dex-modelo-nota">${icon("tag", { size: 13 })} Modelo logístico: <b>${escapeHtml(d.modeloAtual?.modeloLogisticoRotulo ?? d.modeloLogisticoRotulo ?? ROTULO_MODELO[d.modeloLogistico] ?? "—")}</b></span>${nota}`;
  }
}

/**
 * Nota discreta sob o seletor: "Operação mista no período" (com os intervalos de
 * cada modelo e, se for o caso, por que os indicadores não puderam ser separados)
 * ou, para um mês de outro modelo que não o de hoje, "Neste período: Marketplace".
 */
function notaPeriodoModelo(d) {
  const mp = d.modeloPeriodo;
  if (mp?.misto) {
    const aviso = avisoDivisaoIndisponivel(mp);
    return `<div class="dex-modelo-misto" role="status">
      <span class="dex-modelo-nota">${icon("tag", { size: 13 })} Operação mista no período</span>
      <small>${linhasSegmentos(mp).map(escapeHtml).join(" · ")}</small>
      ${aviso ? `<small class="dex-modelo-aviso">${escapeHtml(aviso)}</small>` : ""}
    </div>`;
  }
  if (d.modeloAtual && d.modeloLogistico !== d.modeloAtual.modeloLogistico) {
    return `<div class="dex-modelo-misto" role="status"><small>Neste período: <b>${escapeHtml(d.modeloLogisticoRotulo ?? "—")}</b></small></div>`;
  }
  return "";
}

// A troca exige uma DATA de vigência explícita (nada de troca retroativa
// silenciosa) — ver dashboardExecutivoModeloModal.js.
function trocarModeloLogistico(modeloNovo, modeloAtual) {
  if (modeloNovo === modeloAtual) return;
  abrirTrocaModeloModal({
    unidadeId: dex.unidadeId, modeloAtual, modeloSugerido: modeloNovo,
    onSalvo: carregarConteudo,
    onCancelar: renderModeloBox, // desfaz a seleção visual do <select>
  });
}

function renderAbaAtual() {
  const box = el("#dex-conteudo");
  if (!box || !dex.dadosMes) return;
  destruirGraficosDashboardExecutivo();
  if (dex.aba === "visao") return renderVisaoGeral(box);
  if (dex.aba === "lancamentos") return renderLancamentos(box);
  if (dex.aba === "indicadores") return renderIndicadores(box);
  if (dex.aba === "historico") return renderHistorico(box);
}

// ---------------------------------------------------------------------------
// ABA 1 — VISÃO GERAL
// ---------------------------------------------------------------------------
function renderVisaoGeral(box) {
  const d = dex.dadosMes;

  if (d.agregado) {
    box.innerHTML = `
      <div class="dex-aviso">${icon("building", { size: 15 })} ${escapeHtml(d.aviso)}</div>
      <div class="dex-cards">${cardsPrincipais(d.cards, d.modeloPeriodo)}</div>
      <div class="dex-graficos">
        ${graficoBox("comparativo", `${icon("trending-up", { size: 15 })} Comparativo de percentuais`, "dex-chart-comp")}
        ${graficoBox("composicao", `${icon("pie-chart", { size: 15 })} Composição das deduções (R$)`, "dex-chart-comp2")}
      </div>
      ${desempenhoBox(d.desempenhoOperacional)}`;
    barraComparativaMeta("dex-chart-comp", d.graficos.comparativoPercentuais);
    roscaDeducoes("dex-chart-comp2", d.graficos.composicaoDeducoes);
    linhaEvolucao("dex-chart-desemp", d.desempenhoOperacional.evolucaoDiaria, "diario", "Desempenho");
    return;
  }

  const r = d.resumoPreenchimento;
  const proj = d.projecao;
  box.innerHTML = `
    <div id="dex-sim-container"></div>
    <section class="dex-resumo">
      <h3>${MESES[d.periodo.mes - 1]} de ${d.periodo.ano}</h3>
      <p><b>${r.diasPreenchidos}</b> de <b>${r.totalDias}</b> dias resolvidos · ${r.diasPendentes} pendente(s) · ${fmtPct(r.percentualConclusao)} do mês concluído</p>
      <div class="dex-progress"><div style="width:${Math.min(100, r.percentualConclusao)}%"></div></div>
      <p class="dex-resumo-sub">Última atualização: ${r.ultimoLancamento ? fmtDataBr(r.ultimoLancamento) : "—"}</p>
      ${r.primeiroDiaPendente && podeLancar() ? `<button class="btn btn-primary btn-sm" id="dex-preencher-primeiro">Preencher primeiro dia pendente (${fmtDataBr(r.primeiroDiaPendente)})</button>` : ""}
    </section>
    <div class="dex-cards">${cardsPrincipais(d.cards, d.modeloPeriodo)}</div>
    ${conciliacaoPeriodoHtml(d)}
    ${comparativoRegimesHtml(d)}
    <div class="dex-graficos">
      ${graficoComparativoHtml(d)}
      ${graficoBox("composicao", `${icon("pie-chart", { size: 15 })} Composição das deduções (R$)`, "dex-chart-comp2")}
    </div>
    <section class="dex-projecao">
      <h3>${icon("trending-up", { size: 15 })} Projeção do faturamento — ${MESES[d.periodo.mes - 1]}/${d.periodo.ano}</h3>
      <div class="dex-projecao-grid">
        <div><span>Média diária atual</span><b>${fmtMoeda(proj.mediaDiaria)}</b></div>
        <div><span>Dias considerados</span><b>${proj.diasConsiderados}</b></div>
        <div><span>Dias resolvidos</span><b>${proj.diasResolvidos}</b></div>
        <div><span>Dias pendentes</span><b>${proj.diasPendentes}</b></div>
        <div><span>Dias previstos no mês</span><b>${proj.diasPrevistos}</b></div>
        <div class="dex-projecao-destaque"><span>Projeção mensal</span><b>${fmtMoeda(proj.projecaoMensal)}</b></div>
      </div>
      <p class="dex-confiabilidade dex-conf-${proj.confiabilidade}"><b>Confiabilidade: ${rotuloConfiabilidade(proj.confiabilidade)}</b> — ${escapeHtml(proj.justificativa)}</p>
      ${proj.parcial ? `<p class="dex-projecao-parcial">${icon("alert-triangle", { size: 13 })} PROJEÇÃO PARCIAL — existem dias pendentes neste período. Regularize os lançamentos para uma projeção mais confiável.</p>` : ""}
    </section>
    <div class="dex-diag-grid">
      <section class="dex-diag">
        <h3>${icon("clipboard-list", { size: 15 })} Diagnóstico via Crescer c/ Delivery
          <span class="vd-tip" data-tip="Análise automática baseada nos dados financeiros e operacionais registrados no Dashboard. Recomendações podem variar conforme a completude das informações." tabindex="0">i</span>
        </h3>
        ${confiabilidadeDadosHtml(d.diagnostico.confiabilidade)}
        ${diagnosticoHtml(d.diagnostico)}
      </section>
      <section class="dex-recom">
        <h3>${icon("list-checks", { size: 15 })} Plano de Ação</h3>
        ${planoAcaoHtml(d.diagnostico, { botaoDiagnosticoHtml })}
      </section>
    </div>`;

  barraComparativaMeta("dex-chart-comp", d.graficos.comparativoPercentuais);
  roscaDeducoes("dex-chart-comp2", d.graficos.composicaoDeducoes);
  // Evolução diária do Desempenho, do Financeiro acumulado e das deduções
  // agora moram na aba Lançamentos (perto do calendário que elas explicam
  // dia a dia) — ver renderLancamentos.
  montarSimuladorPreco("dex-sim-container", dex.unidadeId, d.periodo.mes, d.periodo.ano, d);
  el("#dex-preencher-primeiro")?.addEventListener("click", () => abrirLancamentoModal({
    data: r.primeiroDiaPendente, unidadeId: dex.unidadeId, modeloLogistico: modeloDaData(d.modeloPeriodo, r.primeiroDiaPendente, d.modeloLogistico), ehTeste: d.ehTeste, onSalvo: carregarConteudo,
  }));
  wirePlanoAcao();
}

/** Troca de aba a partir de um CTA do Plano de Ação (sem sair do Dashboard). */
function irParaAba(aba) {
  dex.aba = aba;
  document.querySelectorAll(".dex-tab").forEach((t) => t.classList.toggle("ativo", t.dataset.aba === aba));
  renderAbaAtual();
}

function wirePlanoAcao() {
  document.querySelectorAll("[data-cta-aba]").forEach((btn) => btn.addEventListener("click", () => irParaAba(btn.dataset.ctaAba)));
  document.querySelectorAll("[data-cta-expandir]").forEach((btn) => btn.addEventListener("click", () => {
    const bloco = btn.closest(".dex-acao").querySelector(".dex-acao-detalhe");
    if (bloco) bloco.hidden = !bloco.hidden;
  }));
  // Etapa H — botões "✦ Diagnosticar..." de cada card (ligarBotoesContextuais
  // já ignora quem já foi ligado, então é seguro chamar de novo a cada render).
  ligarBotoesContextuais();
}

// Severidade sempre como bolinha colorida (mesmo padrão de .alerta-dot já
// usado no Dashboard principal — ver views.js), nunca emoji.
const pontoSeveridade = (classe) => `<span class="alerta-dot ${classe}"></span>`;

function diagnosticoHtml(diag) {
  if (diag.semDadosSuficientes) {
    return `<p class="dex-diag-vazio">Ainda não há lançamentos suficientes neste mês para gerar um diagnóstico confiável.</p>`;
  }
  // Cada achado é um objeto {titulo, descricao} — texto sempre com número
  // real quando os dados permitem (não frase genérica). Nunca afirma causa
  // que os dados não sustentam.
  const bloco = (titulo, itens, classe) => !itens.length ? "" : `
    <div class="dex-diag-bloco ${classe}"><h4>${titulo}</h4><ul>${itens.map((a) => `<li><b>${escapeHtml(a.titulo)}</b> — ${escapeHtml(a.descricao)}</li>`).join("")}</ul></div>`;
  const conteudo = [
    bloco(`${pontoSeveridade("ok")} Pontos fortes`, diag.pontosFortes, "forte"),
    bloco(`${pontoSeveridade("warn")} Pontos de atenção`, diag.pontosAtencao, "atencao"),
    bloco(`${pontoSeveridade("bad")} Alertas`, diag.alertas, "alerta"),
  ].join("");
  return conteudo || `<p class="dex-diag-vazio">Nenhum ponto relevante identificado.</p>`;
}

const CONFIABILIDADE_ROTULO = {
  alta: `${pontoSeveridade("ok")} Alta`, media: `${pontoSeveridade("warn")} Média`,
  baixa: `${pontoSeveridade("bad")} Baixa`, indisponivel: "— Indisponível",
};

function confiabilidadeDadosHtml(conf) {
  if (!conf) return "";
  return `<p class="dex-confiabilidade-dados"><b>Confiabilidade dos dados: ${CONFIABILIDADE_ROTULO[conf.nivel] ?? conf.nivel}</b> — ${escapeHtml(conf.motivo)}</p>`;
}

// PLANO DE AÇÃO — renderização em dashboardExecutivoPlano.js (módulo puro,
// testável). Aqui só a fiação de eventos (wirePlanoAcao, acima).

function rotuloConfiabilidade(nivel) {
  return { alta: "Alta", media: "Média", baixa: "Baixa", indisponivel: "Indisponível" }[nivel] ?? nivel;
}

function graficoBox(chave, titulo, canvasId) {
  return `<section class="dex-painel"><h3>${titulo}</h3><div class="dex-chart-wrap"><canvas id="${canvasId}"></canvas></div></section>`;
}

// Mesmo limiar do backend (LIMIARES_DIAGNOSTICO.diasSegmentoParaAmostraPequena
// — dashboardExecutivo.diagnostico.js). O NARRATIVE de amostra pequena mora
// no Diagnóstico (backend, fonte única do critério); aqui é só o rótulo
// discreto ao lado de cada regime na Conciliação/Comparativo.
const DIAS_AMOSTRA_PEQUENA = 5;

/** Badge + contexto (nunca "valor oficial") de um registro {texto,contexto,badge}. */
function campoConciliacaoHtml(label, campo, comPercentual = null) {
  const badge = campo.badge ? `<span class="pill ${campo.badge.classe}">${escapeHtml(campo.badge.label)}</span>` : "";
  const pct = comPercentual && comPercentual.texto !== "—" ? ` <span class="dex-conc-pct">${comPercentual.texto === "Não aplicável" ? "" : comPercentual.texto}</span>` : "";
  return `<div class="dex-conc-linha">
    <span class="dex-conc-label">${label}</span>
    <span class="dex-conc-valor">${campo.texto}${pct}</span>
    ${badge}
    ${campo.contexto ? `<small class="dex-conc-contexto">${icon("info", { size: 11 })} ${escapeHtml(campo.contexto)}</small>` : ""}
  </div>`;
}

/**
 * CONCILIAÇÃO DO PERÍODO — Marketplace / Full Service / Consolidado, só em
 * período misto (item do pedido). Reaproveita `montarConciliacao` (pura,
 * testada) — aqui só monta o HTML. Cards compactos, nunca uma tabela pesada.
 */
function conciliacaoPeriodoHtml(d) {
  if (!d.modeloPeriodo?.misto) return "";
  const c = montarConciliacao(d.comparativoSegmentos, d.modeloPeriodo.conciliacao?.consolidado);
  if (!c) return "";
  const blocoRegime = (seg, dias) => `
    <div class="dex-conc-bloco">
      <h4>${escapeHtml(seg.rotulo)}<span class="dex-conc-intervalo">${seg.intervalo}${dias != null && dias > 0 && dias < DIAS_AMOSTRA_PEQUENA ? ` · ${dias} dia(s)` : ""}</span></h4>
      ${campoConciliacaoHtml("Faturamento", seg.faturamento)}
      ${campoConciliacaoHtml("Taxas e Comissões", seg.taxasComissoes.valor, seg.taxasComissoes.percentual)}
      ${campoConciliacaoHtml("Serviços e Promoções", seg.servicosPromocoes.valor, seg.servicosPromocoes.percentual)}
      ${campoConciliacaoHtml("Taxas de Entregadores", seg.taxasEntregadores.valor, seg.taxasEntregadores.percentual)}
      ${campoConciliacaoHtml("Total de Deduções", seg.totalDeducoes.valor, seg.totalDeducoes.percentual)}
      ${campoConciliacaoHtml("Receita Líquida", seg.receitaLiquida.valor, seg.receitaLiquida.percentual)}
    </div>`;
  const nota = notaAmostraPequena(d.comparativoSegmentos, DIAS_AMOSTRA_PEQUENA);
  return `
    <section class="dex-painel dex-conciliacao">
      <h3>${icon("git-merge", { size: 15 })} Conciliação do Período
        <span class="vd-tip" data-tip="Marketplace e Full Service calculados separadamente, cada um com suas próprias regras, e depois consolidados. Campos com status diferente de conciliado mostram o último valor confiável como contexto, nunca como valor oficial." tabindex="0">i</span>
      </h3>
      <div class="dex-conc-grid">
        ${d.comparativoSegmentos.map((seg, i) => blocoRegime(c.segmentos[i], seg.diasComDados)).join("")}
        <div class="dex-conc-bloco dex-conc-consolidado">
          <h4>Consolidado do Mês</h4>
          ${campoConciliacaoHtml("Faturamento", c.consolidado.faturamento)}
          ${campoConciliacaoHtml("Deduções", c.consolidado.deducoes, c.consolidado.deducoesPercentual)}
          ${campoConciliacaoHtml("Receita Líquida", c.consolidado.receitaLiquida)}
        </div>
      </div>
      ${nota ? `<p class="dex-conc-aviso">${icon("info", { size: 13 })} ${escapeHtml(nota)}</p>` : ""}
    </section>`;
}

/**
 * COMPARATIVO Marketplace × Full Service — tabela compacta com variação
 * (p.p. para percentuais, % relativa pra valores/médias — nunca confundir
 * as duas). Só em período misto; só linhas onde a comparação é sustentada.
 */
function comparativoRegimesHtml(d) {
  if (!d.modeloPeriodo?.misto || !d.comparativoSegmentos?.length) return "";
  const linhasPct = linhasComparativoIndicadores(d.comparativoSegmentos);
  const linhasOp = linhasComparativoOperacional(d.comparativoSegmentos);
  const linhas = [...linhasPct, ...linhasOp];
  if (!linhas.length) return "";
  const [rotuloA, rotuloB] = [d.comparativoSegmentos[0], d.comparativoSegmentos[d.comparativoSegmentos.length - 1]]
    .map((s) => ROTULO_MODELO_COMPARATIVO[s.modelo] ?? s.modelo);
  // Linhas percentuais trazem `{texto, contexto, badge}` (valorDoRegistro); as operacionais, string.
  const celula = (v) => escapeHtml(v != null && typeof v === "object" ? v.texto : v);
  const linha = (l) => `<tr><td>${escapeHtml(l.rotulo)}</td><td class="num">${celula(l.a)}</td><td class="num">${celula(l.b)}</td><td class="num">${escapeHtml(l.variacaoTexto)}</td></tr>`;
  return `
    <section class="dex-painel">
      <h3>${icon("trending-up", { size: 15 })} Comparativo — ${escapeHtml(rotuloA)} × ${escapeHtml(rotuloB)}</h3>
      <div class="tabela-wrap"><table class="grid">
        <thead><tr><th>Indicador</th><th class="num">${escapeHtml(rotuloA)}</th><th class="num">${escapeHtml(rotuloB)}</th><th class="num">Variação</th></tr></thead>
        <tbody>${linhas.map(linha).join("")}</tbody>
      </table></div>
    </section>`;
}
const ROTULO_MODELO_COMPARATIVO = { marketplace: "Marketplace", full_service: "Full Service" };

/**
 * Gráfico comparativo de percentuais — Atual/Meta/Limite CONSOLIDADOS quando
 * há referência válida. Em período misto sem referência consolidável
 * (nenhum indicador com meta composta disponível), nunca inventa uma barra —
 * mostra uma nota e mantém só o gráfico com o que existir.
 */
function graficoComparativoHtml(d) {
  const semReferencia = d.modeloPeriodo?.misto && !(d.graficos?.comparativoPercentuais ?? []).some((g) => g.metaIdeal != null || g.limite != null);
  const nota = semReferencia
    ? `<p class="dex-grafico-nota">${icon("info", { size: 12 })} Meta/Limite consolidados indisponíveis neste período — veja Marketplace e Full Service separadamente na Conciliação do Período, acima.</p>`
    : "";
  return `<section class="dex-painel"><h3>${icon("trending-up", { size: 15 })} Comparativo de percentuais</h3>${nota}<div class="dex-chart-wrap"><canvas id="dex-chart-comp"></canvas></div></section>`;
}

// Desempenho também é acumulado do mês agora (mesma lógica do Financeiro),
// mas continua um dado OPERACIONAL, nunca a fonte oficial de faturamento —
// o card oficial é `cards.faturamento` (cardsPrincipais). O gráfico plota
// o delta ("dia sozinho", calculado pelo backend — ver linhaEvolucao),
// nunca o acumulado bruto.
function desempenhoBox(op) {
  if (!op) return "";
  const stats = [
    op.mediaDiaria != null ? `Média do período: <b>${fmtMoeda(op.mediaDiaria)}</b>` : "Sem dados suficientes para média",
    op.acumulado != null ? `Desempenho acumulado: <b>${fmtMoeda(op.acumulado)}</b>${op.dataAtualizacao ? ` (até ${fmtDataBr(op.dataAtualizacao)})` : ""}` : null,
  ].filter(Boolean).join(" · ");
  return `<section class="dex-painel dex-desempenho">
    <h3>${icon("bar-chart", { size: 15 })} Evolução diária do Desempenho</h3>
    <div class="dex-chart-wrap"><canvas id="dex-chart-desemp"></canvas></div>
    <p class="dex-desemp-stats">${stats}</p>
    <p class="dex-resumo-sub">ℹ️ ${escapeHtml(op.aviso)}</p>
  </section>`;
}

// Sem ícone por card (rebrand visual — item 1 do pedido): label + valor já
// carregam a hierarquia sozinhos, um ícone por métrica só adicionava peso.
const cardDef = (label, valor, sub, tip, cls = "", extra = "") => `
  <div class="card ${cls}">
    <div class="dex-card-topo">${label}${tip ? `<span class="vd-tip" data-tip="${escapeHtml(tip)}" tabindex="0">i</span>` : ""}</div>
    <b class="dex-card-val">${valor}</b>
    ${sub ? `<span class="dex-card-sub">${sub}</span>` : ""}
    ${extra}
  </div>`;

// Status vem PRONTO do backend — aqui só traduz a chave pra classe de CSS do
// pill. Cards da Visão Geral usam `statusIndicador` (dentro_da_meta / atencao /
// fora_da_meta); a tabela de Indicadores usa `statusIndicadorRentabilidade`
// (dentro_da_meta / dentro_do_limite / atencao). Ambos mapeados aqui.
const CLASSE_STATUS = { dentro_da_meta: "ok", dentro_do_limite: "ok", atencao: "warn", fora_da_meta: "bad", sem_dados: "muted" };
// fmtPp vem de dashboardExecutivoPlano.js (fonte única de "p.p.").

/**
 * Barra de "quanto do limite já foi usado" + linha de saldo disponível.
 * Só aparece quando o backend manda meta + status (ver saldoMeta). Sem dado
 * suficiente, o card mostra só o pill "Dados insuficientes" — nunca uma
 * barra vazia fingindo 0%.
 */
function metaBarraHtml(cardIndicador) {
  const { meta, saldo, status, percentual: atual } = cardIndicador;
  if (!meta || !status || status.chave === "sem_dados" || !saldo) return "";
  const classe = CLASSE_STATUS[status.chave] ?? "muted";
  const pctUsado = Math.min(100, Math.max(0, (Number(atual) / Number(meta.limite)) * 100));
  let linhaSaldo;
  if (saldo.status === "disponivel") {
    linhaSaldo = `Restam <b>${fmtPp(saldo.disponivelPp)}</b>${saldo.disponivelReais != null ? ` · <b>${fmtMoeda(saldo.disponivelReais)}</b> disponível` : ""}`;
  } else if (saldo.status === "limite_atingido") {
    linhaSaldo = `<b>Limite atingido</b>`;
  } else {
    linhaSaldo = `Acima do limite em <b>${fmtPp(Math.abs(saldo.disponivelPp))}</b>${saldo.disponivelReais != null ? ` · <b>${fmtMoeda(Math.abs(saldo.disponivelReais))}</b>` : ""}`;
  }
  return `
    <div class="dex-meta-bar"><div class="${classe}" style="width:${pctUsado}%"></div></div>
    <span class="dex-card-saldo${saldo.status === "acima_do_limite" ? " acima" : ""}">${linhaSaldo}</span>`;
}

// `modeloPeriodo` (opcional): em período misto o card de Taxas de Entregadores
// continua visível (existiu Marketplace no período) e diz que a base é só a dos
// dias de Marketplace.
function cardsPrincipais(cards, modeloPeriodo = null) {
  const s1 = cards.taxasComissoes.status ?? { label: "Dados insuficientes", chave: "sem_dados" };
  const s2 = cards.servicosPromocoes.status ?? { label: "Dados insuficientes", chave: "sem_dados" };
  // Taxas de Entregadores some do TODO (não só "dados insuficientes") quando
  // `naoAplicavel` vem true do backend — Full Service não usa entregadores
  // próprios do iFood, então o card nem existe pra esse modelo (na visão
  // agregada, só some se NENHUMA unidade com dado no mês for Marketplace).
  //
  // "Ajustes a favor" e "Ajustes contra" são PURAMENTE INFORMATIVOS — sem
  // meta, sem pill "dentro/fora da meta", sem barra. Nenhum dos dois entra no
  // indicador "Total de Deduções" (que é só a soma das parcelas de dedução
  // aplicáveis ao modelo — ver calc.js#totalDeducoesIndicador); os dois
  // entram na Receita líquida: a favor soma, contra subtrai.
  const s4 = cards.taxasEntregadores?.status ?? { label: "Dados insuficientes", chave: "sem_dados" };
  const s3 = cards.totalDeducoes.status ?? { label: "Dados insuficientes", chave: "sem_dados" };
  return [
    cardDef("Financeiro oficial (iFood)", fmtMoeda(cards.faturamento.valor),
      cards.faturamento.periodoFim ? `Consolidado pelo iFood até ${fmtDataBr(cards.faturamento.periodoFim)}` : "Nenhum financeiro consolidado ainda neste mês",
      "Snapshot acumulado do extrato do iFood (dia 1 até a data mais recente informada) — a fonte oficial de faturamento (não o Desempenho)."),
    cardDef("Ticket Médio", fmtMoeda(cards.ticketMedio.valor),
      cards.ticketMedio.valor != null ? "Calculado a partir do Desempenho" : "Dados não informados",
      "Valor bruto de vendas ÷ quantidade de pedidos do mês (Desempenho — indicador operacional). Nunca deriva do Financeiro nem soma tickets médios diários."),
    cardDef("Novos Clientes", cards.novosClientes?.valor ?? "—",
      cards.novosClientes?.valor != null ? "Acumulado no período selecionado" : "Dados não informados",
      "Quantidade acumulada de novos clientes identificados no período selecionado (Desempenho — indicador operacional)."),
    cardDef("Taxas e Comissões", fmtMoeda(cards.taxasComissoes.valor), `${fmtPct(cards.taxasComissoes.percentual)} das vendas · <span class="pill ${CLASSE_STATUS[s1.chave]}">${s1.label}</span>`, "Comissão iFood + taxa de transação de pagamento online.", "", metaBarraHtml(cards.taxasComissoes)),
    cardDef("Serviços e Promoções", fmtMoeda(cards.servicosPromocoes.valor), `${fmtPct(cards.servicosPromocoes.percentual)} das vendas · <span class="pill ${CLASSE_STATUS[s2.chave]}">${s2.label}</span>`, "Custo de campanhas e promoções ativas no iFood.", "", metaBarraHtml(cards.servicosPromocoes)),
    cards.taxasEntregadores?.naoAplicavel ? "" : cardDef("Taxas de Entregadores", fmtMoeda(cards.taxasEntregadores?.valor), `${fmtPct(cards.taxasEntregadores?.percentual)} das vendas · <span class="pill ${CLASSE_STATUS[s4.chave]}">${s4.label}</span>`, (modeloPeriodo?.misto ? "Repasse aos entregadores parceiros — apurado só nos dias de Marketplace do período (o % é sobre o faturamento desses dias)." : "Repasse aos entregadores parceiros — só se aplica ao modelo logístico Marketplace."), "", metaBarraHtml(cards.taxasEntregadores ?? {})),
    cardDef("Ajustes a favor", fmtMoeda(cards.ajustesFavor?.valor), `${fmtPct(cards.ajustesFavor?.percentual)} das vendas`, "Créditos, reembolsos e correções financeiras a favor da loja.", "ajuste-favor"),
    cardDef("Ajustes contra", fmtMoeda(cards.ajustesContra?.valor), `${fmtPct(cards.ajustesContra?.percentual)} das vendas`, "Débitos, descontos e correções financeiras contra a loja."),
    cardDef("Total de Deduções", fmtMoeda(cards.totalDeducoes.valor), `${fmtPct(cards.totalDeducoes.percentual)} das vendas · <span class="pill ${CLASSE_STATUS[s3.chave]}">${s3.label}</span>`, "Soma das deduções aplicáveis ao modelo: taxas e comissões + serviços e promoções + taxas de entregadores (só no Marketplace). Não inclui ajustes contra a loja.", "", metaBarraHtml(cards.totalDeducoes)),
    cardDef("Receita líquida", fmtMoeda(cards.receitaLiquida.valor), `${fmtPct(cards.receitaLiquida.percentual)} das vendas`, "Faturamento menos taxas e comissões, serviços e promoções, taxas de entregadores e ajustes contra a loja; mais os ajustes a favor da loja.", "destaque"),
  ].join("");
}

// ---------------------------------------------------------------------------
// ABA 2 — LANÇAMENTOS (calendário)
// ---------------------------------------------------------------------------
function renderLancamentos(box) {
  const d = dex.dadosMes;
  if (d.agregado) {
    box.innerHTML = vazio("building", "Visão consolidada", "O calendário de lançamentos só está disponível para uma unidade específica. Selecione uma unidade no filtro acima.");
    return;
  }

  box.innerHTML = `
    ${lancamentoMensalBanner(d.lancamentoMensal)}
    ${resumoFinanceiroBanner(d)}
    <section class="dex-cal-wrap">
      <div class="dex-cal">${d.calendario.map((dia) => diaHtml(dia)).join("")}</div>
      <div class="dex-legenda">
        <div class="dex-legenda-grupo">
          <span class="dex-legenda-titulo">Status do dia</span>
          <div class="dex-legenda-itens">
            ${STATUS_LEGENDA.map((s) => `<span class="dex-leg-item"><span class="pill ${s.classe}">${s.label}</span></span>`).join("")}
            <span class="dex-leg-item"><span class="pill ok estimado">12 ~</span> Estimado (distribuição mensal)</span>
          </div>
        </div>
        <div class="dex-legenda-grupo">
          <span class="dex-legenda-titulo">Informações financeiras</span>
          <div class="dex-legenda-itens">
            <span class="dex-leg-item"><span class="dex-cal-badge dex-cal-badge-fin-ok">Financeiro ✓</span> Tem snapshot financeiro</span>
            <span class="dex-leg-item"><span class="dex-cal-badge dex-cal-badge-fin-disp">Financeiro disponível</span> Dia elegível, snapshot ainda não lançado</span>
          </div>
        </div>
      </div>
    </section>
    <div class="dex-graficos">
      ${desempenhoDiarioBox(d.desempenhoOperacional)}
      ${financeiroAcumuladoBox(d.snapshotsFinanceiros)}
      ${deducoesAcumuladasBox(d)}
    </div>`;

  linhaEvolucao("dex-chart-desemp-lanc", d.desempenhoOperacional.evolucaoDiaria, "diario", "Desempenho");
  const pontosFinReais = d.snapshotsFinanceiros.filter((p) => p.valor != null);
  if (pontosFinReais.length >= 2) linhaFinanceiroAcumulado("dex-chart-fin-acum", d.snapshotsFinanceiros);
  const pontosDedReais = d.snapshotsFinanceiros.filter((p) => p.percentualTotalDeducoes != null);
  if (pontosDedReais.length >= 2) {
    linhaDeducoesAcumuladas("dex-chart-ded-acum", d.snapshotsFinanceiros, d.cards.totalDeducoes?.meta?.metaIdeal ?? null, d.cards.totalDeducoes?.meta?.limite ?? null);
  }

  el("#dex-lote-ver")?.addEventListener("click", () => abrirLancamentoMensalModal({
    unidadeId: dex.unidadeId, mes: dex.mes, ano: dex.ano, modeloLogistico: d.modeloLogistico, onSalvo: carregarConteudo, modoInicial: "ver",
  }));
  el("#dex-lote-editar")?.addEventListener("click", () => abrirLancamentoMensalModal({
    unidadeId: dex.unidadeId, mes: dex.mes, ano: dex.ano, modeloLogistico: d.modeloLogistico, onSalvo: carregarConteudo, modoInicial: "editar",
  }));
  el("#dex-lote-excluir")?.addEventListener("click", () => abrirLancamentoMensalModal({
    unidadeId: dex.unidadeId, mes: dex.mes, ano: dex.ano, modeloLogistico: d.modeloLogistico, onSalvo: carregarConteudo, modoInicial: "excluir",
  }));

  // Dia "estimado" (originado da distribuição mensal) nunca abre o formulário
  // diário normal — item 7 do pedido: não é um lançamento manual
  // independente, é uma fatia do lançamento mensal. Abre o gerenciamento dele.
  box.querySelectorAll(".dex-cal-dia[data-clicavel]").forEach((elDia) => elDia.addEventListener("click", () => {
    if (elDia.dataset.estimado) {
      abrirLancamentoMensalModal({ unidadeId: dex.unidadeId, mes: dex.mes, ano: dex.ano, modeloLogistico: d.modeloLogistico, onSalvo: carregarConteudo, modoInicial: "ver" });
      return;
    }
    abrirLancamentoModal({ data: elDia.dataset.data, unidadeId: dex.unidadeId, modeloLogistico: modeloDaData(d.modeloPeriodo, elDia.dataset.data, d.modeloLogistico), ehTeste: d.ehTeste, onSalvo: carregarConteudo });
  }));
}

// Faixa compacta acima do calendário (item 4 do pedido de UX) — 3 números,
// nunca um card gigante: até onde o Financeiro oficial está consolidado, a
// data do último dado de Desempenho, e se o dia elegível de hoje já recebeu
// o próximo snapshot. Tudo derivado do que a Visão Geral já usa — nenhuma
// regra nova, só reapresentação compacta pra quem está na aba Lançamentos.
function resumoFinanceiroBanner(d) {
  const fin = d.cards.faturamento;
  const desemp = d.desempenhoOperacional;
  const diaElegivel = d.calendario.find((x) => x.elegivelFinanceiro);
  const temSnapshotElegivel = situacaoOperou(diaElegivel?.lancamento?.situacao)
    && diaElegivel?.lancamento?.origem_lancamento !== "distribuicao_mensal"
    && diaElegivel?.lancamento?.valor_vendas_ifood != null;

  const item = (label, valor, sub) => `
    <div class="dex-resumo-fin-item">
      <span class="dex-resumo-fin-label">${label}</span>
      <b>${valor}</b>
      <span class="dex-resumo-fin-sub">${sub}</span>
    </div>`;

  return `<section class="dex-resumo-fin">
    ${item(`${icon("banknote", { size: 13 })} Último Financeiro oficial`, fin.valor != null ? fmtMoeda(fin.valor) : "—",
      fin.periodoFim ? `Consolidado de ${fmtDataBr(fin.periodoInicio)} até ${fmtDataBr(fin.periodoFim)}` : "Nenhum snapshot financeiro informado ainda.")}
    ${item(`${icon("bar-chart", { size: 13 })} Desempenho acumulado`, desemp.acumulado != null ? fmtMoeda(desemp.acumulado) : "—",
      desemp.dataAtualizacao ? `Acumulado até ${fmtDataBr(desemp.dataAtualizacao)} · dado operacional, não oficial` : "Nenhum dado de Desempenho lançado neste mês.")}
    ${item(`${icon("bell", { size: 13 })} Próximo snapshot financeiro`, diaElegivel ? (temSnapshotElegivel ? "Atualizado" : "Disponível") : "—",
      diaElegivel
        ? (temSnapshotElegivel ? `Financeiro atualizado até ${fmtDataBr(diaElegivel.data)}` : `Disponível para ${fmtDataBr(diaElegivel.data)}`)
        : "O dia elegível deste recorte é de outro mês")}
  </section>`;
}

// Estado vazio compacto (item 8 do pedido) — nunca um gráfico grande em
// branco.
function painelVazio(titulo, texto) {
  return `<section class="dex-painel dex-painel-vazio"><h3>${titulo}</h3><p class="dex-vazio-texto">${escapeHtml(texto)}</p></section>`;
}

// Indicador compacto pra quando só existe 1 ponto real — um gráfico de
// linha com um ponto só não mostra evolução nenhuma (item 8).
function painelIndicador(titulo, valor, sub) {
  return `<section class="dex-painel dex-painel-indicador">
    <h3>${titulo}</h3>
    <p class="dex-indicador-valor">${valor}</p>
    <p class="dex-resumo-sub">${sub}</p>
  </section>`;
}

function desempenhoDiarioBox(op) {
  // Checa `acumuladoValorVendasBruto` (o dado bruto salvo), não `valor` (o
  // delta) — o primeiro dia real do mês pode ter acumulado sem ter delta
  // calculável (ver listaDesempenhoDiario), e isso não é "sem dado".
  if (!op.evolucaoDiaria.some((p) => p.acumuladoValorVendasBruto != null)) {
    return painelVazio(`${icon("bar-chart", { size: 15 })} Evolução diária do Desempenho`, "Nenhum dado de Desempenho lançado neste mês.");
  }
  const stats = [
    op.mediaDiaria != null ? `Média do período: <b>${fmtMoeda(op.mediaDiaria)}</b>` : null,
    op.acumulado != null ? `Desempenho acumulado: <b>${fmtMoeda(op.acumulado)}</b>${op.dataAtualizacao ? ` (até ${fmtDataBr(op.dataAtualizacao)})` : ""}` : null,
  ].filter(Boolean).join(" · ");
  return `<section class="dex-painel">
    <h3>${icon("bar-chart", { size: 15 })} Evolução diária do Desempenho</h3>
    <div class="dex-chart-wrap"><canvas id="dex-chart-desemp-lanc"></canvas></div>
    ${stats ? `<p class="dex-desemp-stats">${stats}</p>` : ""}
    <p class="dex-resumo-sub">ℹ️ ${escapeHtml(op.aviso)}</p>
  </section>`;
}

// Financeiro é sempre snapshot acumulado — NUNCA chamado de "faturamento
// diário" (item 5 do pedido). Com 0 pontos reais, estado vazio; com 1,
// indicador (gráfico de 1 ponto não mostra evolução); com 2+, o gráfico de
// linha sem interpolar entre dias sem snapshot.
function financeiroAcumuladoBox(snapshots) {
  const titulo = `${icon("banknote", { size: 15 })} Evolução do Financeiro acumulado`;
  const reais = snapshots.filter((p) => p.valor != null);
  if (!reais.length) return painelVazio(titulo, "Nenhum snapshot financeiro informado ainda.");
  if (reais.length === 1) {
    const p = reais[0];
    return painelIndicador(titulo, fmtMoeda(p.valor),
      `Consolidado até ${fmtDataBr(p.data)} — a evolução aparece a partir do 2º snapshot do mês.`);
  }
  return `<section class="dex-painel">
    <h3>${titulo}</h3>
    <div class="dex-chart-wrap"><canvas id="dex-chart-fin-acum"></canvas></div>
    <p class="dex-resumo-sub">Cada ponto é o snapshot acumulado daquele dia — nunca interpola dias sem lançamento.</p>
  </section>`;
}

function deducoesAcumuladasBox(d) {
  const titulo = `${icon("trending-down", { size: 15 })} Deduções acumuladas`;
  const reais = d.snapshotsFinanceiros.filter((p) => p.percentualTotalDeducoes != null);
  if (!reais.length) return painelVazio(titulo, "Nenhum snapshot financeiro informado ainda.");
  if (reais.length === 1) {
    const p = reais[0];
    return painelIndicador(titulo, fmtPct(p.percentualTotalDeducoes), `Consolidado até ${fmtDataBr(p.data)}`);
  }
  return `<section class="dex-painel">
    <h3>${titulo}</h3>
    <div class="dex-chart-wrap"><canvas id="dex-chart-ded-acum"></canvas></div>
    <p class="dex-resumo-sub">% do total de deduções em cada snapshot — nunca interpola dias sem lançamento.</p>
  </section>`;
}

// Faixa discreta no topo da aba Lançamentos quando o mês já tem um
// lançamento mensal (item 6 do pedido) — dá acesso direto a
// visualizar/editar/excluir sem precisar clicar num dia estimado.
function lancamentoMensalBanner(lote) {
  if (!lote) return "";
  const pendente = lote.camposPendentes?.length > 0;
  return `
    <div class="dex-lote-banner">
      <div class="dex-lote-banner-txt">
        <span class="dex-lote-banner-label">${icon("calendar", { size: 13 })} Faturamento mensal lançado</span>
        <b>${fmtMoeda(lote.valorTotalMensal)}</b>
        <span class="dex-lote-banner-meta">${lote.diasDistribuidos} dia(s) distribuído(s)${pendente ? ` · <span class="pill warn">Dados complementares pendentes</span>` : ""}</span>
      </div>
      <div class="dex-lote-banner-acoes">
        <button class="btn btn-ghost btn-sm" id="dex-lote-ver" type="button">Visualizar</button>
        ${pode("dashboard_executivo.corrigir") ? `<button class="btn btn-ghost btn-sm" id="dex-lote-editar" type="button">Editar</button>` : ""}
        ${pode("dashboard_executivo.excluir") ? `<button class="btn btn-ghost btn-sm dex-lote-btn-excluir" id="dex-lote-excluir" type="button">Excluir</button>` : ""}
      </div>
    </div>`;
}

/**
 * Badge complementar do Financeiro dentro do dia — nunca muda a cor/status
 * principal do dia (isso é papel do STATUS_DIA). "Financeiro ✓" quando o
 * dia tem um snapshot real (nunca fatia de distribuição mensal — essa já
 * tem seu próprio sinal "~"); "Financeiro disponível" só no dia elegível
 * (`dia.elegivelFinanceiro`, vindo pronto do backend) que ainda não recebeu
 * o snapshot.
 */
function badgeFinanceiro(dia) {
  const temSnapshot = situacaoOperou(dia.lancamento?.situacao)
    && dia.lancamento?.origem_lancamento !== "distribuicao_mensal"
    && dia.lancamento?.valor_vendas_ifood != null;
  if (temSnapshot) return { texto: "Financeiro ✓", classe: "fin-ok", titulo: "Este dia tem um snapshot financeiro do iFood" };
  if (dia.elegivelFinanceiro) return { texto: "Financeiro disponível", classe: "fin-disp", titulo: "O Financeiro do iFood já pode ser lançado para este dia" };
  return null;
}

function diaHtml(dia) {
  const s = STATUS_ROTULO[statusVisual(dia.status)] ?? { label: dia.status, classe: "muted" };
  const numero = Number(dia.data.slice(8, 10));
  // FINANCEIRO_PENDENTE é clicável igual RASCUNHO — precisa continuar
  // aberto pra completar o Financeiro assim que a data virar "ontem".
  const clicavel = dia.status === "PENDENTE" || dia.status === "RASCUNHO" || dia.status === "FINANCEIRO_PENDENTE"
    || ((dia.status === "PREENCHIDO" || dia.status === "SEM_OPERACAO" || dia.status === "ZERO_VENDAS") && pode("dashboard_executivo.corrigir"));
  // Dia originado de "Lançar faturamento mensal": mesma cor de status (é um
  // dado financeiro válido), mas com um sinal discreto (~) de que o valor é
  // uma distribuição estimada, não um lançamento diário real.
  const estimado = dia.lancamento?.origem_lancamento === "distribuicao_mensal";
  const tituloEstimado = estimado ? " · Origem: distribuição mensal (clique para ver o lançamento mensal)" : "";
  const badge = badgeFinanceiro(dia);
  const tituloBadge = badge ? ` · ${badge.titulo}` : "";
  return `<div class="dex-cal-dia pill ${s.classe}${estimado ? " estimado" : ""}" ${clicavel ? `data-clicavel data-data="${dia.data}" role="button" tabindex="0"` : ""}${estimado ? " data-estimado=\"1\"" : ""} title="${fmtDataBr(dia.data)} · ${s.label}${tituloBadge}${tituloEstimado}">
    <span class="dex-cal-num">${numero}${estimado ? ' <span class="dex-cal-estimado" aria-label="Distribuição mensal estimada">~</span>' : ""}</span><span class="dex-cal-status">${s.label}</span>
    ${badge ? `<span class="dex-cal-badge dex-cal-badge-${badge.classe}">${badge.texto}</span>` : ""}
  </div>`;
}

// ---------------------------------------------------------------------------
// ABA 3 — INDICADORES
// ---------------------------------------------------------------------------
function renderIndicadores(box) {
  const d = dex.dadosMes;
  if (d.agregado) {
    box.innerHTML = vazio("building", "Visão consolidada", "Os indicadores de rentabilidade dependem do modelo logístico (Marketplace/Full Service) de cada unidade e não são exibidos nesta visão. Selecione uma unidade específica no filtro acima.");
    return;
  }
  const misto = d.modeloPeriodo?.misto && d.indicadoresPorSegmento?.length;
  const linhas = Object.entries(d.indicadoresRentabilidade).map(([chave, v]) => {
    const composicao = misto ? composicaoIndicadorHtml(chave, d.indicadoresPorSegmento) : "";
    const podeExpandir = misto && composicao;
    if (v.naoAplicavel) {
      return `<tr class="dex-linha-na">
        <td>${rotuloIndicador(chave)}${podeExpandir ? botaoExpandirIndicador(chave) : ""}</td>
        <td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td>
        <td><span class="pill muted">Não se aplica a este modelo</span></td>
      </tr>${podeExpandir ? linhaComposicaoHtml(chave, composicao) : ""}`;
    }
    const s = v.status ?? { label: "Dados insuficientes", chave: "sem_dados" };
    const saldo = v.saldo;
    // 2 casas decimais APENAS nesta tabela (fmtPctRentabilidade / fmtPpRentabilidade).
    let disponivel = "—";
    if (saldo?.status === "disponivel") disponivel = `${fmtPpRentabilidade(saldo.disponivelPp)}${saldo.disponivelReais != null ? ` (${fmtMoeda(saldo.disponivelReais)})` : ""}`;
    else if (saldo?.status === "limite_atingido") disponivel = "Limite atingido";
    else if (saldo?.status === "acima_do_limite") disponivel = `−${fmtPpRentabilidade(Math.abs(saldo.disponivelPp))}${saldo.disponivelReais != null ? ` (−${fmtMoeda(Math.abs(saldo.disponivelReais))})` : ""}`;
    return `<tr>
      <td>${rotuloIndicador(chave)}${podeExpandir ? botaoExpandirIndicador(chave) : ""}</td>
      <td class="num">${fmtPctRentabilidade(v.atual)}</td>
      <td class="num">${fmtPctRentabilidade(v.metaIdeal)}</td>
      <td class="num">${fmtPctRentabilidade(v.limite)}</td>
      <td class="num">${disponivel}</td>
      <td><span class="pill ${CLASSE_STATUS[s.chave] ?? "muted"}">${s.label}</span></td>
    </tr>${podeExpandir ? linhaComposicaoHtml(chave, composicao) : ""}`;
  }).join("");

  box.innerHTML = `
    <section class="dex-painel">
      <h3>${icon("target", { size: 15 })} Indicadores de Rentabilidade</h3>
      ${misto ? `<p class="dex-resumo-sub">${icon("info", { size: 12 })} "Atual" é o valor CONSOLIDADO do período. Clique em <b>Composição</b> pra ver Marketplace e Full Service separadamente.</p>` : ""}
      <div class="tabela-wrap"><table class="grid">
        <thead><tr><th>Indicador</th><th class="num">Atual</th><th class="num">Meta ideal</th><th class="num">Limite</th><th class="num">Disponível</th><th>Status</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table></div>
    </section>
    <div class="dex-graficos">${graficoComparativoIndicadoresHtml(d)}</div>`;
  barraComparativaMeta("dex-chart-ind", d.graficos.comparativoPercentuais);
  els(".dex-ind-expandir").forEach((btn) => btn.addEventListener("click", () => {
    const linha = document.getElementById(`dex-ind-comp-${btn.dataset.chave}`);
    if (linha) linha.hidden = !linha.hidden;
  }));
}

const botaoExpandirIndicador = (chave) => ` <button type="button" class="btn btn-ghost btn-xs dex-ind-expandir" data-chave="${chave}">Composição</button>`;

/** Marketplace/Full Service lado a lado pra UM indicador — nunca uma 3ª tabela gigante, só uma linha expansível. */
function composicaoIndicadorHtml(chave, indicadoresPorSegmento) {
  const partes = indicadoresPorSegmento
    .map((seg) => ({ rotulo: seg.rotulo, ind: seg.indicadores[chave] }))
    .filter((p) => p.ind && !p.ind.naoAplicavel && p.ind.atual != null);
  if (!partes.length) return "";
  return partes.map((p) => `<div class="dex-ind-comp-item">
    <span class="dex-ind-comp-rotulo">${escapeHtml(p.rotulo)}</span>
    <span>${fmtPctRentabilidade(p.ind.atual)}</span>
    <span class="dex-conc-pct">Meta ${fmtPctRentabilidade(p.ind.meta?.metaIdeal ?? null)} · Limite ${fmtPctRentabilidade(p.ind.meta?.limite ?? null)}</span>
  </div>`).join("");
}

function linhaComposicaoHtml(chave, conteudo) {
  return `<tr class="dex-ind-comp-linha" id="dex-ind-comp-${chave}" hidden><td colspan="6"><div class="dex-ind-comp">${conteudo}</div></td></tr>`;
}

/** Mesmo tratamento de `graficoComparativoHtml` (Visão Geral), pro canvas próprio da aba Indicadores. */
function graficoComparativoIndicadoresHtml(d) {
  const semReferencia = d.modeloPeriodo?.misto && !(d.graficos?.comparativoPercentuais ?? []).some((g) => g.metaIdeal != null || g.limite != null);
  const nota = semReferencia
    ? `<p class="dex-grafico-nota">${icon("info", { size: 12 })} Meta/Limite consolidados indisponíveis neste período — veja a composição de cada indicador na tabela acima.</p>`
    : "";
  return `<section class="dex-painel"><h3>${icon("trending-up", { size: 15 })} Comparativo de percentuais</h3>${nota}<div class="dex-chart-wrap"><canvas id="dex-chart-ind"></canvas></div></section>`;
}

function rotuloIndicador(chave) {
  return {
    taxas_comissoes: "Taxas e comissões", servicos_promocoes: "Serviços e promoções",
    taxas_entregadores: "Taxas de entregadores", total_deducoes: "Total de deduções",
  }[chave] ?? chave;
}

// ---------------------------------------------------------------------------
// ABA 4 — HISTÓRICO
// ---------------------------------------------------------------------------
async function renderHistorico(box, { silencioso = false } = {}) {
  marcarAtualizacaoAgora();
  if (!silencioso) box.innerHTML = carregando();
  try {
    const { data } = await dashExecHistorico({ unidadeId: dex.unidadeId || undefined, ano: dex.ano });
    dex.historico = data;
  } catch (e) {
    box.innerHTML = vazio("alert-triangle", "Erro ao carregar histórico", e.message);
    return;
  }
  const meses = dex.historico.meses;
  const linha = (m) => `<tr class="dex-hist-${m.status}">
    <td>${MESES[m.mes - 1]}</td>
    <td><span class="pill ${{ completo: "ok", incompleto: "warn", sem_dados: "muted", futuro: "muted" }[m.status]}">${{ completo: "Completo", incompleto: "Incompleto", sem_dados: "Sem dados", futuro: "Futuro" }[m.status]}</span></td>
    <td class="num">${m.diasPreenchidos}</td>
    <td class="num">${m.diasPendentes}</td>
    <td class="num">${fmtMoeda(m.faturamento)}</td>
    <td class="num">${m.qtdVendas ?? "—"}</td>
    <td class="num">${fmtMoeda(m.ticketMedio)}</td>
    <td class="num">${fmtMoeda(m.totalDeducoes)}</td>
    <td class="num">${fmtPct(m.percentualDeducoes)}</td>
    <td class="num">${fmtMoeda(m.receitaLiquida)}</td>
    <td class="num">${m.comparativoMesAnteriorPct != null ? (m.comparativoMesAnteriorPct >= 0 ? "▲ " : "▼ ") + fmtPct(Math.abs(m.comparativoMesAnteriorPct)) : "—"}</td>
  </tr>`;

  box.innerHTML = `
    <section class="dex-painel">
      <h3>${icon("archive", { size: 15 })} Histórico de ${dex.ano}</h3>
      <div class="tabela-wrap"><table class="grid">
        <thead><tr><th>Mês</th><th>Status</th><th class="num">Preenchidos</th><th class="num">Pendentes</th><th class="num">Faturamento</th><th class="num">Vendas</th><th class="num">Ticket médio</th><th class="num">Deduções</th><th class="num">% Deduções</th><th class="num">Receita líquida</th><th class="num">vs mês ant.</th></tr></thead>
        <tbody>${meses.map(linha).join("")}</tbody>
      </table></div>
    </section>
    <div class="dex-graficos">
      ${graficoBox("comparativo-mensal", `${icon("bar-chart", { size: 15 })} Comparativo mensal`, "dex-chart-mensal")}
      ${graficoBox("visao-anual", `${icon("calendar", { size: 15 })} Visão anual`, "dex-chart-anual")}
    </div>`;

  barraComparativoMensal("dex-chart-mensal", meses.filter((m) => m.status !== "futuro"));
  visaoAnual("dex-chart-anual", meses);
}

// ---------------------------------------------------------------------------
function fmtDataBr(iso) {
  if (!iso) return "—";
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}
