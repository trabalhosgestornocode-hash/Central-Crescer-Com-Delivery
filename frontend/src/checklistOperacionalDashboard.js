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
//
// DASHBOARD 2.0 — quatro abas: Visão Geral e Desempenho · Pedidos e Ficha 360° · Ocorrências e Diagnóstico · Fechamentos e
// Relatórios. Cada aba nova carrega SÓ os seus dados (lista de pedidos do período; fechamentos da competência + prévia do
// WhatsApp), com a mesma regra de "uma consulta por vez / descarta resposta de outro contexto". O WhatsApp é SOMENTE
// simulado: nenhuma ação desta tela envia mensagem.

import { state } from "./state.js";
import {
  obterDashboardChecklist, exportarDashboardChecklistExcel, obterPedidosOperacionais, obterFichaPedido, listarFechamentosOperacionais,
  obterFechamentoOperacional, gerarFechamentoOperacional, obterPreviaWhatsappFechamento, simularWhatsappFechamento, exportarFechamentoExcel,
} from "./api.js";
import { pode } from "./sessao.js";
import { geracaoContexto, contextoMudou } from "./contextoEscopo.js";
import { registrarInteresse } from "./realtime/realtimeBus.js";
import { EVENTOS_CHECKLIST, EVENTOS_IFOOD_PEDIDOS } from "./realtime/realtimeEvents.js";
import { avisoDaMinhaUnidade } from "./checklistOperacionalSincronizacao.js";
import { telaDashboard, dialogoRelatorio, SECOES_RELATORIO } from "./checklistOperacionalDashboardVisual.js";
import { gerarPdfDashboard, imprimirDocumento } from "./checklistOperacionalRelatorio.js";
import { navegacaoAbas, painelPedidos, fichaPedido, painelFechamentos, documentoFechamento, ABAS_DASHBOARD } from "./checklistOperacionalOperacional.js";

const CHAVE_FILTRO = "ckd:filtro";     // conveniência por aparelho (sessionStorage); nunca dado
const CHAVE_ABA = "ckd:aba";
const INTERVALO_MIN_RECARGA_MS = 15_000;

const est = {
  raiz: null, view: null, voltar: null,
  filtro: { periodo: "hoje", inicio: "", fim: "", etapa: "todas" },
  aplicado: null,  // filtro que gerou `dados`
  dados: null, carregando: false, erro: null,
  seq: 0, ultimaCargaMs: 0, recargaPendente: null,
  secoes: SECOES_RELATORIO.map((s) => s.id),
  aba: "visao",
  pedidos: { lista: null, carregando: false, erro: null, busca: "", seq: 0 },
  ficha: { chave: null, dados: null, carregando: false, erro: null, seq: 0 },
  fech: { competencia: null, lista: null, atual: null, previa: null, carregando: false, erro: null, aviso: null, motivo: "", seq: 0 },
};

/** Data de hoje (AAAA-MM-DD) no fuso da operação. */
export const hojeOperacao = (agora = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(agora);
/** Ontem (AAAA-MM-DD) no fuso da operação — competência padrão do fechamento. */
export const ontemOperacao = (agora = new Date()) => hojeOperacao(new Date(agora.getTime() - 86_400_000));
/** Quem gera/revisa fechamento e registra simulação (mesma régua das metas; o backend confere de novo). */
const podeGerarFechamento = () => pode("configuracoes.gerenciar") || pode("integracoes.gerenciar");

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
function lerAba() { try { const a = sessionStorage.getItem(CHAVE_ABA); return ABAS_DASHBOARD.some((x) => x.id === a) ? a : "visao"; } catch { return "visao"; } }
function salvarAba(a) { try { sessionStorage.setItem(CHAVE_ABA, a); } catch { /* sem storage: segue */ } }

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
  est.aba = lerAba();
  est.pedidos = { ...est.pedidos, lista: null, erro: null };
  est.fech = { ...est.fech, competencia: est.fech.competencia ?? ontemOperacao(), lista: null, atual: null, previa: null, erro: null, aviso: null };
  desenhar();
  carregar(est.filtro);
  carregarAba();
}

/** Fecha (troca de unidade, logout, voltar). `remover`: tira os números da página (fim de sessão). */
export function encerrarDashboardOperacional({ remover = false } = {}) {
  est.seq += 1; // invalida resposta em voo
  est.pedidos.seq += 1; est.ficha.seq += 1; est.fech.seq += 1;
  if (est.recargaPendente) { clearTimeout(est.recargaPendente); est.recargaPendente = null; }
  if (remover) est.raiz?.remove();
  est.raiz = null;
  est.dados = null;
  est.aplicado = null;
  est.pedidos.lista = null;
  est.fech = { ...est.fech, lista: null, atual: null, previa: null };
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
    if (est.aba === "pedidos") carregarPedidos();
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
  // Diálogo aberto (relatório ou ficha): o redesenho espera ele fechar (senão some no meio da leitura/escolha).
  const dlg = est.raiz?.querySelector("dialog[open]");
  if (dlg) {
    if (!dlg.dataset.redesenhoPendente) {
      dlg.dataset.redesenhoPendente = "1";
      dlg.addEventListener("close", () => { delete dlg.dataset.redesenhoPendente; if (dashboardNaTela()) desenhar(); }, { once: true });
    }
    return;
  }
  // Foco devolvido após o redesenho: id primeiro (as abas compartilham data-acao="aba"), depois name, depois data-acao.
  const ativo = est.raiz?.contains(document.activeElement) ? document.activeElement : null;
  const foco = ativo ? { id: ativo.id || null, nome: ativo.getAttribute("name"), acao: ativo.dataset?.acao } : null;
  const conteudoAba = est.aba === "pedidos" ? painelPedidos({ lista: est.pedidos.lista, carregando: est.pedidos.carregando, erro: est.pedidos.erro, busca: est.pedidos.busca })
    : est.aba === "fechamentos" ? painelFechamentos({ ...est.fech, hoje: hojeOperacao(), podeGerar: podeGerarFechamento() }) : "";
  const html = telaDashboard({
    dados: est.dados, filtro: est.filtro, unidadeNome: state.sessao?.unidade?.nome, carregando: est.carregando, erro: est.erro, hoje: hojeOperacao(),
    aba: est.aba, abas: navegacaoAbas(est.aba), conteudoAba,
  });
  if (est.raiz?.isConnected) {
    const novo = document.createRange().createContextualFragment(html).firstElementChild;
    est.raiz.replaceWith(novo);
    est.raiz = novo;
  } else {
    est.view.innerHTML = html;
    est.raiz = est.view.querySelector("[data-ckd]");
  }
  ligar(est.raiz);
  if (foco) {
    const alvo = (foco.id && est.raiz.querySelector(`#${CSS.escape(foco.id)}`))
      || (foco.nome && est.raiz.querySelector(`[name="${CSS.escape(foco.nome)}"]`))
      || (foco.acao && est.raiz.querySelector(`[data-acao="${CSS.escape(foco.acao)}"]`));
    alvo?.focus({ preventScroll: true });
  }
}

function lerFormulario(form) {
  const f = Object.fromEntries(new FormData(form).entries());
  return { periodo: f.periodo ?? "hoje", inicio: f.inicio ?? "", fim: f.fim ?? "", etapa: f.etapa ?? "todas" };
}

function ligar(raiz) {
  const form = raiz.querySelector("[data-ckd-filtros]");
  if (form) {
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
  }
  raiz.addEventListener("click", (ev) => {
    const alvo = ev.target.closest("[data-acao]");
    const acao = alvo?.dataset.acao;
    if (acao === "voltar-checklist") est.voltar?.();
    else if (acao === "relatorio") abrirRelatorio();
    else if (acao === "aba") trocarAba(alvo.dataset.aba);
    else if (acao === "ficha") abrirFicha(alvo.dataset.chave);
    else if (acao === "versao") abrirVersao(alvo.dataset.id);
    else if (acao === "fech-excel") baixarExcelFechamento(alvo);
    else if (acao === "fech-pdf" && est.fech.atual) imprimirDocumento(documentoFechamento(est.fech.atual, { unidadeNome: state.sessao?.unidade?.nome }));
    else if (acao === "wa-copiar") copiarMensagem();
    else if (acao === "wa-regenerar" && est.fech.atual) carregarPrevia(est.fech.atual.id);
    else if (acao === "wa-simular") simular(alvo);
  });
  // Teclado nas abas (setas, Home/End) — padrão WAI-ARIA de abas.
  raiz.querySelector(".ckd-abas")?.addEventListener("keydown", (ev) => {
    const ids = ABAS_DASHBOARD.map((a) => a.id);
    const i = ids.indexOf(est.aba);
    const prox = ev.key === "ArrowRight" ? ids[(i + 1) % ids.length] : ev.key === "ArrowLeft" ? ids[(i - 1 + ids.length) % ids.length]
      : ev.key === "Home" ? ids[0] : ev.key === "End" ? ids[ids.length - 1] : null;
    if (!prox) return;
    ev.preventDefault();
    trocarAba(prox);
    est.raiz?.querySelector(`#ckd-aba-${prox}`)?.focus();
  });
  raiz.querySelector('[name="busca-pedido"]')?.addEventListener("input", (ev) => {
    est.pedidos.busca = ev.target.value.slice(0, 20);
    const pos = ev.target.selectionStart;
    desenhar();
    const campo = est.raiz?.querySelector('[name="busca-pedido"]');
    if (campo) { campo.focus(); try { campo.setSelectionRange(pos, pos); } catch { /* input search sem seleção */ } }
  });
  const formFech = raiz.querySelector("[data-ckd-fechamento]");
  formFech?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const dados = Object.fromEntries(new FormData(formFech).entries());
    est.fech.motivo = String(dados.motivo ?? "");
    gerarFechamento(String(dados.competencia ?? ""));
  });
  formFech?.querySelector('[name="competencia"]')?.addEventListener("change", (ev) => {
    est.fech.competencia = ev.target.value;
    est.fech.atual = null; est.fech.previa = null; est.fech.aviso = null;
    carregarFechamentos();
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
      baixar(blob, nomeArquivo);
      dlg.close();
    } catch (e) {
      erro(e?.message ? `Não foi possível gerar o Excel: ${e.message}` : "Não foi possível gerar o Excel agora.");
    } finally { botao.disabled = false; }
  });
  dlg.showModal();
}

function baixar(blob, nomeArquivo) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: nomeArquivo });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Dashboard 2.0 — abas, pedidos/ficha e fechamento
// ---------------------------------------------------------------------------------------------------------------------------

const mensagemDeErro = (erro, padrao) => (erro?.status === 403 ? "Este perfil não tem acesso a esta parte do Dashboard nesta unidade."
  : erro?.status === 503 ? "Recurso ainda não disponível neste ambiente (atualização do banco pendente)."
    : erro?.status === 400 || erro?.status === 404 || erro?.status === 422 ? (erro.message || padrao) : padrao);

function trocarAba(aba) {
  if (!ABAS_DASHBOARD.some((a) => a.id === aba) || aba === est.aba) return;
  est.aba = aba;
  salvarAba(aba);
  desenhar();
  carregarAba();
}

function carregarAba() {
  if (est.aba === "pedidos") carregarPedidos();
  else if (est.aba === "fechamentos" && !est.fech.lista) carregarFechamentos();
}

async function carregarPedidos() {
  const filtro = est.aplicado ?? est.filtro;
  if (validarFiltro(filtro)) return;
  const seq = ++est.pedidos.seq;
  const g = geracaoContexto();
  est.pedidos.carregando = true; est.pedidos.erro = null; desenhar();
  try {
    const { data } = await obterPedidosOperacionais(paraConsulta(filtro));
    if (seq !== est.pedidos.seq || contextoMudou(g) || !dashboardNaTela()) return;
    est.pedidos.lista = data;
  } catch (erro) {
    if (seq !== est.pedidos.seq || contextoMudou(g) || !dashboardNaTela()) return;
    est.pedidos.erro = mensagemDeErro(erro, est.pedidos.lista ? "Sem conexão com a Central. Mostrando a última lista." : "Não foi possível carregar os pedidos agora.");
  } finally {
    if (seq === est.pedidos.seq) { est.pedidos.carregando = false; if (dashboardNaTela()) desenhar(); }
  }
}

function abrirFicha(chave) {
  if (!chave) return;
  est.raiz.querySelector("dialog.ckd-dialogo")?.remove();
  const dlg = document.createElement("dialog");
  dlg.className = "ckd-dialogo ckd-dialogo--ficha";
  dlg.setAttribute("aria-labelledby", "ckd-t-ficha");
  est.raiz.appendChild(dlg);
  const pintar = () => { dlg.innerHTML = fichaPedido({ ficha: est.ficha.dados, carregando: est.ficha.carregando, erro: est.ficha.erro }); };
  const seq = ++est.ficha.seq;
  est.ficha = { ...est.ficha, chave, dados: null, carregando: true, erro: null };
  pintar();
  dlg.addEventListener("click", (ev) => { if (ev.target.closest('[data-acao="fechar-ficha"]') || ev.target === dlg) dlg.close(); });
  dlg.addEventListener("close", () => { est.ficha.seq += 1; dlg.remove(); }, { once: true });
  dlg.showModal();
  const g = geracaoContexto();
  obterFichaPedido(chave).then(({ data }) => {
    if (seq !== est.ficha.seq || contextoMudou(g)) return;
    est.ficha.dados = data.ficha;
  }).catch((erro) => {
    if (seq !== est.ficha.seq || contextoMudou(g)) return;
    est.ficha.erro = mensagemDeErro(erro, "Não foi possível abrir a ficha agora.");
  }).finally(() => {
    if (seq !== est.ficha.seq) return;
    est.ficha.carregando = false;
    if (dlg.isConnected) { pintar(); dlg.querySelector("h2, button")?.focus(); }
  });
}

async function carregarFechamentos({ manterAtual = false } = {}) {
  const seq = ++est.fech.seq;
  const g = geracaoContexto();
  est.fech.carregando = true; est.fech.erro = null; desenhar();
  try {
    const { data } = await listarFechamentosOperacionais(est.fech.competencia);
    if (seq !== est.fech.seq || contextoMudou(g) || !dashboardNaTela()) return;
    est.fech.lista = data.itens;
    const ultima = data.itens.filter((x) => x.competencia === est.fech.competencia).sort((a, b) => b.versao - a.versao)[0];
    if (ultima && (!manterAtual || !est.fech.atual)) await abrirVersao(ultima.id, { semRedesenho: true });
    else if (!ultima) { est.fech.atual = null; est.fech.previa = null; }
  } catch (erro) {
    if (seq !== est.fech.seq || contextoMudou(g) || !dashboardNaTela()) return;
    est.fech.erro = mensagemDeErro(erro, "Não foi possível carregar os fechamentos agora.");
  } finally {
    if (seq === est.fech.seq) { est.fech.carregando = false; if (dashboardNaTela()) desenhar(); }
  }
}

async function abrirVersao(id, { semRedesenho = false } = {}) {
  const g = geracaoContexto();
  try {
    const { data } = await obterFechamentoOperacional(id);
    if (contextoMudou(g) || !dashboardNaTela()) return;
    est.fech.atual = data;
    est.fech.previa = null;
    if (!semRedesenho) desenhar();
    carregarPrevia(id);
  } catch (erro) {
    if (contextoMudou(g)) return;
    est.fech.erro = mensagemDeErro(erro, "Não foi possível abrir o fechamento.");
    if (!semRedesenho) desenhar();
  }
}

async function carregarPrevia(id) {
  const g = geracaoContexto();
  try {
    const { data } = await obterPreviaWhatsappFechamento(id);
    if (contextoMudou(g) || !dashboardNaTela() || est.fech.atual?.id !== id) return;
    est.fech.previa = data;
  } catch (erro) {
    if (contextoMudou(g)) return;
    est.fech.previa = { status: "ERROR", mensagem: null, validacao: { problemas: [{ mensagem: mensagemDeErro(erro, "Não foi possível montar a prévia.") }] }, fechamento: { versao: est.fech.atual?.versao } };
  }
  if (dashboardNaTela()) desenhar();
}

async function gerarFechamento(competencia) {
  if (!podeGerarFechamento()) return;
  const g = geracaoContexto();
  est.fech.competencia = competencia;
  est.fech.carregando = true; est.fech.erro = null; est.fech.aviso = null; desenhar();
  try {
    const { data } = await gerarFechamentoOperacional({ competencia, motivo: est.fech.motivo.trim() || undefined });
    if (contextoMudou(g) || !dashboardNaTela()) return;
    est.fech.aviso = data.resultado === "REGISTRADO" ? `Versão ${data.fechamento.versao} registrada (${data.fechamento.status.toLowerCase()}).`
      : "Nada mudou desde a última versão: nenhuma versão nova foi criada.";
    est.fech.motivo = "";
    est.fech.atual = data.fechamento;
    est.fech.previa = null;
    est.fech.carregando = false;
    await carregarFechamentos({ manterAtual: true });
    carregarPrevia(data.fechamento.id);
  } catch (erro) {
    if (contextoMudou(g)) return;
    est.fech.erro = mensagemDeErro(erro, "Não foi possível gerar o fechamento agora.");
    est.fech.carregando = false;
    if (dashboardNaTela()) desenhar();
  }
}

async function baixarExcelFechamento(botao) {
  if (!est.fech.atual) return;
  botao.disabled = true;
  try {
    const { blob, nomeArquivo } = await exportarFechamentoExcel(est.fech.atual.id);
    baixar(blob, nomeArquivo);
  } catch (erro) {
    est.fech.erro = mensagemDeErro(erro, "Não foi possível gerar o Excel agora.");
    desenhar();
  } finally { botao.disabled = false; }
}

async function copiarMensagem() {
  const texto = est.fech.previa?.mensagem;
  if (!texto) return;
  try {
    await navigator.clipboard.writeText(texto);
    est.fech.aviso = "Mensagem copiada. Nada foi enviado.";
  } catch {
    est.fech.aviso = "Não foi possível copiar automaticamente: selecione o texto da prévia e copie.";
  }
  desenhar();
  est.raiz?.querySelector('[data-acao="wa-copiar"]')?.focus();
}

async function simular(botao) {
  if (!podeGerarFechamento() || !est.fech.atual) return;
  botao.disabled = true;
  const g = geracaoContexto();
  try {
    const { data } = await simularWhatsappFechamento(est.fech.atual.id);
    if (contextoMudou(g) || !dashboardNaTela()) return;
    est.fech.aviso = data.duplicada ? "Esta mensagem já tinha sido simulada para esta versão: nada foi duplicado." : "Simulação registrada. Nenhuma mensagem foi enviada.";
    await carregarPrevia(est.fech.atual.id);
  } catch (erro) {
    if (contextoMudou(g)) return;
    est.fech.erro = mensagemDeErro(erro, "Não foi possível registrar a simulação.");
    desenhar();
  } finally { botao.disabled = false; }
}
