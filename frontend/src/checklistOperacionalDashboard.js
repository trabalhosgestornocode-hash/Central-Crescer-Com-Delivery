// Checklist Operacional — DASHBOARD OPERACIONAL: controlador (terceira opção da seleção).
//
// Abre DENTRO da Central (sem tela cheia, sem tique de 1 s, sem pulso): é uma tela de análise, não de parede.
// Dados: GET /checklist-operacional/dashboard com o filtro (período + etapa); a unidade é a do contexto (seletor
// global do topo) — nada de unidade vem daqui. Uma consulta por vez: resposta antiga ou de outro contexto é
// descartada. Falha mantém os últimos números na tela, com o erro escrito.
//
// Tempo real: metas alteradas em qualquer aparelho da unidade (`checklist_metas.atualizadas`) recarregam o Dashboard;
// com um período que inclui hoje, pedidos novos também (agrupados: no máximo uma consulta a cada 15 s).
//
// Relatórios: PDF (impressão do navegador, mesmos componentes da tela) e Excel (backend, mesmo cálculo), sempre com o
// filtro que gerou os números EXIBIDOS — nunca o que está digitado e ainda não foi aplicado.

import { state } from "./state.js";
import { obterDashboardChecklist, exportarDashboardChecklistExcel } from "./api.js";
import { geracaoContexto, contextoMudou } from "./contextoEscopo.js";
import { registrarInteresse } from "./realtime/realtimeBus.js";
import { EVENTOS_CHECKLIST, EVENTOS_IFOOD_PEDIDOS } from "./realtime/realtimeEvents.js";
import { avisoDaMinhaUnidade } from "./checklistOperacionalSincronizacao.js";
import { telaDashboard, dialogoRelatorio, SECOES_RELATORIO } from "./checklistOperacionalDashboardVisual.js";
import { gerarPdfDashboard } from "./checklistOperacionalRelatorio.js";

const CHAVE_FILTRO = "ckd:filtro";     // conveniência por aparelho (sessionStorage); nunca dado
const INTERVALO_MIN_RECARGA_MS = 15_000;

const est = {
  raiz: null, view: null, voltar: null,
  filtro: { periodo: "hoje", inicio: "", fim: "", etapa: "todas" },
  aplicado: null,  // filtro que gerou `dados`
  dados: null, carregando: false, erro: null,
  seq: 0, ultimaCargaMs: 0, recargaPendente: null,
  secoes: SECOES_RELATORIO.map((s) => s.id),
};

/** Data de hoje (AAAA-MM-DD) no fuso da operação. */
export const hojeOperacao = (agora = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(agora);

/** Valida o filtro antes de consultar. @returns {string|null} mensagem de erro */
export function validarFiltro(f, hoje = hojeOperacao()) {
  if (f.periodo !== "personalizado") return null;
  if (!f.inicio || !f.fim) return "Informe as duas datas do período personalizado.";
  if (f.inicio > f.fim) return "A data inicial é depois da final.";
  if (f.fim > hoje) return "O período não pode terminar no futuro.";
  return null;
}

/** Só os campos que vão para a API. */
export const paraConsulta = (f) => (f.periodo === "personalizado"
  ? { periodo: f.periodo, inicio: f.inicio, fim: f.fim, etapa: f.etapa }
  : { periodo: f.periodo, etapa: f.etapa });

function lerFiltroSalvo() {
  try { const f = JSON.parse(sessionStorage.getItem(CHAVE_FILTRO) ?? "null"); return f && typeof f === "object" ? f : null; } catch { return null; }
}
function salvarFiltro(f) { try { sessionStorage.setItem(CHAVE_FILTRO, JSON.stringify(f)); } catch { /* sem storage: segue */ } }

export const dashboardNaTela = () => est.raiz?.isConnected === true;

/** Período exibido inclui hoje? (só então pedidos novos mudam os números) */
const incluiHoje = () => est.dados?.periodo?.fim === hojeOperacao();

// Registrado UMA vez (como o aviso do Checklist): só age com o Dashboard na tela e para a unidade do contexto.
registrarInteresse({
  eventos: [EVENTOS_CHECKLIST.METAS_ATUALIZADAS, EVENTOS_IFOOD_PEDIDOS.ESTADO_ATUALIZADO],
  relevante: (evento) => state.rota === "checklist-operacional" && dashboardNaTela()
    && avisoDaMinhaUnidade(evento, { organizacaoId: state.sessao?.empresa?.id, unidadeId: state.sessao?.unidade?.id })
    && (evento.tipo === EVENTOS_CHECKLIST.METAS_ATUALIZADAS || incluiHoje()),
  aoReceber: () => agendarRecarga(),
});

function agendarRecarga() {
  if (est.recargaPendente) return;
  const espera = Math.max(0, est.ultimaCargaMs + INTERVALO_MIN_RECARGA_MS - Date.now());
  est.recargaPendente = setTimeout(() => { est.recargaPendente = null; if (dashboardNaTela() && est.aplicado) carregar(est.aplicado); }, espera);
}

export function abrirDashboardOperacional({ view, voltar }) {
  est.view = view;
  est.voltar = voltar;
  est.filtro = { ...est.filtro, ...(lerFiltroSalvo() ?? {}) };
  est.dados = null;
  est.erro = null;
  desenhar();
  carregar(est.filtro);
}

/** Fecha (troca de unidade, logout, voltar). `remover`: tira os números da página (fim de sessão). */
export function encerrarDashboardOperacional({ remover = false } = {}) {
  est.seq += 1; // invalida resposta em voo
  if (est.recargaPendente) { clearTimeout(est.recargaPendente); est.recargaPendente = null; }
  if (remover) est.raiz?.remove();
  est.raiz = null;
  est.dados = null;
  est.aplicado = null;
}

async function carregar(filtro) {
  const erroFiltro = validarFiltro(filtro);
  if (erroFiltro) { est.erro = erroFiltro; desenhar(); return; }
  const seq = ++est.seq;
  const g = geracaoContexto();
  est.carregando = true;
  est.erro = null;
  desenhar();
  try {
    const { data } = await obterDashboardChecklist(paraConsulta(filtro));
    if (seq !== est.seq || contextoMudou(g) || !dashboardNaTela()) return;
    est.dados = data;
    est.aplicado = { ...filtro };
    salvarFiltro(filtro);
  } catch (erro) {
    if (seq !== est.seq || contextoMudou(g) || !dashboardNaTela()) return;
    est.erro = erro?.status === 403 ? "Este perfil não tem acesso ao Dashboard Operacional desta unidade."
      : erro?.status === 400 || erro?.status === 422 ? (erro.message || "Filtro inválido.")
        : est.dados ? "Sem conexão com a Central. Mostrando os últimos números calculados." : "Não foi possível calcular os indicadores agora. Tente de novo.";
  } finally {
    if (seq === est.seq) { est.carregando = false; est.ultimaCargaMs = Date.now(); if (dashboardNaTela()) desenhar(); }
  }
}

function desenhar() {
  // Diálogo do relatório aberto: o redesenho espera ele fechar (senão some no meio da escolha).
  const dlg = est.raiz?.querySelector("dialog[open]");
  if (dlg) {
    if (!dlg.dataset.redesenhoPendente) {
      dlg.dataset.redesenhoPendente = "1";
      dlg.addEventListener("close", () => { delete dlg.dataset.redesenhoPendente; if (dashboardNaTela()) desenhar(); }, { once: true });
    }
    return;
  }
  const foco = est.raiz?.contains(document.activeElement) ? document.activeElement.getAttribute("name") ?? document.activeElement.dataset?.acao : null;
  const html = telaDashboard({ dados: est.dados, filtro: est.filtro, unidadeNome: state.sessao?.unidade?.nome, carregando: est.carregando, erro: est.erro, hoje: hojeOperacao() });
  if (est.raiz?.isConnected) {
    const novo = document.createRange().createContextualFragment(html).firstElementChild;
    est.raiz.replaceWith(novo);
    est.raiz = novo;
  } else {
    est.view.innerHTML = html;
    est.raiz = est.view.querySelector("[data-ckd]");
  }
  ligar(est.raiz);
  if (foco) (est.raiz.querySelector(`[name="${foco}"]`) ?? est.raiz.querySelector(`[data-acao="${foco}"]`))?.focus({ preventScroll: true });
}

function lerFormulario(form) {
  const f = Object.fromEntries(new FormData(form).entries());
  return { periodo: f.periodo ?? "hoje", inicio: f.inicio ?? "", fim: f.fim ?? "", etapa: f.etapa ?? "todas" };
}

function ligar(raiz) {
  const form = raiz.querySelector("[data-ckd-filtros]");
  form.addEventListener("submit", (ev) => { ev.preventDefault(); est.filtro = lerFormulario(form); carregar(est.filtro); });
  form.querySelector('[name="periodo"]').addEventListener("change", (ev) => {
    const pers = ev.target.value === "personalizado";
    for (const n of ["inicio", "fim"]) {
      const i = form.querySelector(`[name="${n}"]`);
      i.closest("label").hidden = !pers;
      i.required = pers;
    }
    est.filtro = lerFormulario(form);
    if (!pers) carregar(est.filtro); // presets aplicam na hora; o personalizado espera as datas
  });
  form.querySelector('[name="etapa"]').addEventListener("change", () => { est.filtro = lerFormulario(form); carregar(est.filtro); });
  raiz.addEventListener("click", (ev) => {
    const acao = ev.target.closest("[data-acao]")?.dataset.acao;
    if (acao === "voltar-checklist") est.voltar?.();
    else if (acao === "relatorio") abrirRelatorio();
  });
  ligarTooltip(raiz);
}

/** Tooltip dos gráficos: um só, posicionado pelo alvo (as barras/dias têm alvos maiores que a marca). */
function ligarTooltip(raiz) {
  const tip = raiz.querySelector("[data-ckd-tooltip]");
  if (!tip) return;
  const esconder = () => { tip.hidden = true; };
  raiz.addEventListener("pointermove", (ev) => {
    const alvo = ev.target.closest?.("[data-tip]");
    if (!alvo) { esconder(); return; }
    tip.textContent = alvo.getAttribute("data-tip");
    tip.hidden = false;
    const caixa = raiz.getBoundingClientRect();
    const x = Math.min(ev.clientX - caixa.left + 14, caixa.width - tip.offsetWidth - 8);
    tip.style.transform = `translate(${Math.max(8, x)}px, ${ev.clientY - caixa.top + 14}px)`;
  });
  raiz.addEventListener("pointerleave", esconder);
}

function abrirRelatorio() {
  if (!est.dados) return;
  est.raiz.querySelector("dialog.ckd-dialogo")?.remove(); // sempre um novo: nunca dois ouvintes no mesmo botão
  const dlg = document.createElement("dialog");
  dlg.className = "ckd-dialogo";
  dlg.setAttribute("aria-labelledby", "ckd-t-rel");
  est.raiz.appendChild(dlg);
  dlg.innerHTML = dialogoRelatorio(est.secoes);
  const lerSecoes = () => [...dlg.querySelectorAll('[name="secao"]:checked')].map((i) => i.value);
  const erro = (t) => { const p = dlg.querySelector("[data-rel-erro]"); p.textContent = t ?? ""; p.hidden = !t; };
  dlg.addEventListener("click", async (ev) => {
    const acao = ev.target.closest("[data-acao]")?.dataset.acao;
    if (acao === "rel-cancelar") { dlg.close(); return; }
    if (acao !== "rel-pdf" && acao !== "rel-excel") return;
    const secoes = lerSecoes();
    if (!secoes.length) { erro("Escolha pelo menos uma seção."); return; }
    est.secoes = secoes;
    if (acao === "rel-pdf") {
      dlg.close();
      await gerarPdfDashboard(est.dados, secoes, { unidadeNome: state.sessao?.unidade?.nome, geradoEm: est.dados.servidorEm });
      return;
    }
    const botao = ev.target.closest("button");
    botao.disabled = true;
    try {
      const { blob, nomeArquivo } = await exportarDashboardChecklistExcel({ ...paraConsulta(est.aplicado), secoes: secoes.join(",") });
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: nomeArquivo });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      dlg.close();
    } catch (e) {
      erro(e?.message ? `Não foi possível gerar o Excel: ${e.message}` : "Não foi possível gerar o Excel agora.");
    } finally { botao.disabled = false; }
  });
  dlg.showModal();
}
