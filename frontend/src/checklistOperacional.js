// Checklist Operacional — CONTROLADOR da tela.
//
// Monta a tela a partir de um `ResumoChecklist` (contrato em
// checklistOperacionalModelo.js) e mantém viva só a parte que depende do
// relógio: hora, idade da sincronização, contadores dos cards ("Agora"),
// contadores dos pedidos em andamento e o card de status. Nada é redesenhado
// inteiro a cada segundo — só texto, largura, classe e o ritmo do pulso.
//
// PULSO (urgência progressiva): cada contador vivo tem um `.cko-pulso` animado
// pela Web Animations API com período-base de 1 s; o ritmo real vem de
// `ritmoPulso()` (modelo) e é aplicado com `updatePlaybackRate`, que troca a
// velocidade SEM reiniciar a animação (sem salto de fase). Fora da meta o
// pulso para e o card fica estável; a passagem para "fora da meta" ganha UM
// destaque breve (`cko-ultrapassou`). Com `prefers-reduced-motion`, nada
// anima: o estado fica no texto, na faixa e na régua.
//
// Origem dos dados: GET /api/v1/checklist-operacional/resumo (só leitura; o
// tenant vem do Context Token). Quem decide QUANDO consultar é o sincronizador
// (checklistOperacionalSincronizacao.js): uma consulta por vez, polling de
// segurança no intervalo do servidor (`atualizarEmS`) com recuo em falha, e
// resposta antiga nunca sobrescreve a nova. Resposta igual à anterior não
// redesenha a tela.
//
// TEMPO REAL: o aviso `ifood_pedido.estado_atualizado` (tópico privado da
// unidade, via realtimeBus — esta tela nunca fala com o Supabase Realtime) e a
// resincronização depois de reconectar só ANTECIPAM a mesma consulta. Aviso de
// outra unidade/empresa é ignorado. Sem Realtime, o polling mantém a tela certa;
// o cabeçalho diz qual dos dois está valendo ("tempo real" / "atualiza a cada 30 s").
//
// RELÓGIO: os contadores usam a hora do SERVIDOR (`servidorEm` corrige o
// relógio do aparelho) — uma TV com o relógio errado não mostra tempo errado.
//
// MODOS DE EXIBIÇÃO: a página do menu mostra a escolha entre Televisão e Tablet (telaSelecaoModos). Os dois
// modos são o MESMO dashboard — mesmo resumo, mesmo sincronizador, mesmo aviso do Realtime, mesmo HTML de
// conteúdo; o modo só troca a classe da raiz (CSS) e o encaixe das listas (checklistOperacionalExibicao.js).
// A consulta e o Realtime só rodam com um modo aberto: voltar à seleção para tudo (sincronizador, tique,
// observador, wake lock, tela cheia, foco isolado). Entrar de novo cria UM sincronizador novo — nunca dois.
//
// PAGINAÇÃO (só TV): listas que não cabem viram páginas que alternam a cada 10 s, sobre os dados JÁ recebidos
// (nenhuma consulta nova). Quem vira a página é o próprio tique de 1 s — sem timer extra para duplicar ou
// esquecer. Dado novo mantém a página (ou a última válida); com movimento reduzido nada vira sozinho e as
// setas do paginador trocam a página. No Tablet a lista é completa e a tela rola.
//
// FOCO: com um modo aberto, o resto da Central fica `inert` (isolarFoco) e o foco vai para a raiz; o Tab só
// percorre os controles visíveis. Redesenho mantém o foco no mesmo controle. Voltar desfaz o inert.
//
// DEMONSTRAÇÃO: só quando pedida EXPLICITAMENTE (?checklist=demonstracao na
// URL) e sempre identificada pela faixa e pelo selo. Nunca é usada como
// substituta de dado real ausente.
//
// Ciclo de vida: o tique e a consulta param sozinhos quando a tela sai do DOM
// (troca de rota) e são zerados na troca de unidade/empresa
// (registrarResetDeContexto); resposta que chega depois de uma troca de
// contexto é descartada (geracaoContexto/contextoMudou).

import { state } from "./state.js";
import { el } from "./utils.js";
import { pode } from "./sessao.js";
import { icon } from "./icons.js";
import { obterResumoChecklist } from "./api.js";
import { registrarResetDeContexto, geracaoContexto, contextoMudou } from "./contextoEscopo.js";
import { registrarInteresse, statusCanal } from "./realtime/realtimeBus.js";
import { EVENTOS_IFOOD_PEDIDOS, RESINCRONIZACAO, topicoUnidade } from "./realtime/realtimeEvents.js";
import { criarSincronizador, avisoDaMinhaUnidade, textoModoAtualizacao } from "./checklistOperacionalSincronizacao.js";
import {
  METAS_EXEMPLO, ROTULO_NIVEL, TETO_REGUA, estadoDoCard, derivarPedidoAtivo, ordenarPorUrgencia,
  derivarStatusOperacao, validarMetas, rotuloPedido,
} from "./checklistOperacionalModelo.js";
import { amostraDemonstracao } from "./checklistOperacionalAmostra.js";
import {
  resumoCarregando, adaptarResumo, marcarFalha, envelhecido, marcarEnvelhecido, assinaturaDados,
} from "./checklistOperacionalDados.js";
import {
  montarTela, conteudoTela, telaSemUnidade, telaSelecaoModos, cardTempo, cardStatus, painelPedidosAtivos, assinaturaStatus,
  textoSincronizacao, textoQuantidade, textoVida, dialogoMetas,
} from "./checklistOperacionalVisual.js";
import {
  MODOS_EXIBICAO, modoValido, pedirTelaCheia, sairDaTelaCheia, telaCheiaAtiva, avisoTelaCheia,
  INTERVALO_PAGINA_MS, montarPaginas, paginaValida, girarPagina, textoPagina, isolarFoco,
} from "./checklistOperacionalExibicao.js";

const NIVEIS = ["ok", "atencao", "critico", "neutro"];
const CHAVES = ["preparo", "entrega", "vida"];
const DURACAO_DESTAQUE_MS = 1800;

const clonarMetas = (m) => JSON.parse(JSON.stringify(m));

const estado = {
  resumo: null,
  metas: null,      // metas desta TELA (memória da aba; nunca enviadas ao servidor — persistir exige migration)
  tique: null,
  raiz: null,
  observador: null, // ResizeObserver: refaz o encaixe das listas quando a área muda (tela cheia, rotação do tablet)
  wakeLock: null,
  sincronizador: null, // só existe com um modo aberto em dado real (nunca na demonstração nem na seleção)
  assinatura: "",
  modo: null,       // "tv" | "tablet" com o dashboard aberto; null = página de seleção
  tentativaTelaCheia: null, // última recusa do navegador ("recusado" | "sem_suporte"), para o aviso discreto
  paginas: new Map(), // painel ("ativos" | "ultimos" | "avaliacoes") -> índice da página visível (só TV)
  proximaPaginaEm: null, // Date.now() em que as páginas viram; null = ciclo parado
  restaurarFoco: null, // desfaz o `inert` aplicado ao resto da Central
};

registrarResetDeContexto(() => {
  parar();
  estado.modo = null; // outra unidade/empresa: volta à seleção
  estado.resumo = null;
  estado.metas = null;
  estado.assinatura = "";
});

// Aviso do Realtime: registrado UMA vez; só age com a tela aberta, em dado real, e se o aviso for da
// organização + unidade do contexto ATUAL. O manager já descarta mensagens de contexto antigo; aqui é a
// segunda trava (nunca confia só no canal).
registrarInteresse({
  eventos: [EVENTOS_IFOOD_PEDIDOS.ESTADO_ATUALIZADO, RESINCRONIZACAO],
  relevante: (evento) => state.rota === "checklist-operacional" && estado.sincronizador?.ativo === true
    && avisoDaMinhaUnidade(evento, { organizacaoId: state.sessao?.empresa?.id, unidadeId: state.sessao?.unidade?.id }),
  aoReceber: () => estado.sincronizador?.avisar(),
});

function parar() {
  if (estado.tique) { clearInterval(estado.tique); estado.tique = null; }
  estado.sincronizador?.parar();
  estado.sincronizador = null;
  document.removeEventListener("visibilitychange", aoVoltarVisivel);
  estado.observador?.disconnect();
  estado.observador = null;
  liberarWakeLock();
  estado.restaurarFoco?.();
  estado.restaurarFoco = null;
  estado.proximaPaginaEm = null;
  estado.raiz = null;
}

/** Quem pode abrir a configuração de metas (provisório — ver pendências do B1). */
const podeEditarMetas = () => pode("configuracoes.gerenciar") || pode("integracoes.gerenciar");

/** Demonstração só por pedido explícito na URL. */
const demonstracaoPedida = () =>
  typeof location !== "undefined" && new URLSearchParams(location.search).get("checklist") === "demonstracao";

/** "Agora" no relógio do servidor (o do aparelho corrigido pela última resposta). */
const agoraServidor = () => Date.now() + (estado.resumo?.relogioOffsetMs ?? 0);

export function renderChecklistOperacional() {
  parar();
  const view = el("#view");
  const unidade = state.sessao?.unidade;
  if (!unidade?.id) {
    estado.modo = null;
    view.innerHTML = telaSemUnidade();
    return;
  }
  estado.metas ??= clonarMetas(METAS_EXEMPLO);
  if (modoValido(estado.modo)) abrirModo(estado.modo); // redesenho da rota com um modo aberto: continua nele
  else desenharSelecao(unidade);
}

// ---------------------------------------------------------------------------
// Seleção do modo e ciclo de vida do modo aberto
// ---------------------------------------------------------------------------

function desenharSelecao(unidade, focarModo = null) {
  estado.modo = null;
  const view = el("#view");
  view.innerHTML = telaSelecaoModos({ unidadeNome: unidade.nome, demonstracao: demonstracaoPedida() });
  const pagina = view.querySelector("[data-ckm]");
  pagina.addEventListener("click", (ev) => {
    const modo = ev.target.closest('[data-acao="iniciar-modo"]')?.dataset.modo;
    if (modoValido(modo)) iniciarModo(modo);
  });
  if (focarModo) pagina.querySelector(`[data-acao="iniciar-modo"][data-modo="${focarModo}"]`)?.focus();
}

/** Clique em "Iniciar Modo ...": abre o modo e pede a tela cheia AINDA dentro do gesto do usuário. */
function iniciarModo(modo) {
  estado.tentativaTelaCheia = null;
  abrirModo(modo);
  entrarEmTelaCheia();
}

/** Abre o dashboard no modo pedido. Sempre parte de tudo parado: nunca há dois sincronizadores. */
function abrirModo(modo) {
  parar();
  const unidade = state.sessao?.unidade;
  estado.modo = modo;
  estado.paginas = new Map(); // cada abertura começa na primeira página
  document.addEventListener("visibilitychange", aoVoltarVisivel);
  if (demonstracaoPedida()) {
    estado.resumo = amostraDemonstracao({ unidadeNome: unidade.nome, metas: estado.metas });
    desenhar();
    pedirWakeLock();
    return;
  }
  estado.assinatura = "";
  estado.resumo = resumoCarregando({ unidade, metas: estado.metas });
  desenhar();
  estado.sincronizador = criarSincronizadorDaTela(unidade);
  estado.sincronizador.iniciar();
  pedirWakeLock();
}

/** "Voltar ao Checklist": sai da tela cheia, para consulta/tique/listeners e volta à seleção (mesma unidade). */
function voltarParaSelecao() {
  const modoAnterior = estado.modo;
  sairDaTelaCheia(); // pedido enquanto a raiz ainda está no DOM (removê-la também encerra a tela cheia)
  parar();
  estado.tentativaTelaCheia = null;
  const unidade = state.sessao?.unidade;
  if (unidade?.id) desenharSelecao(unidade, modoAnterior);
  else renderChecklistOperacional();
}

// ---------------------------------------------------------------------------
// Consulta ao resumo — sincronizador (Realtime antecipa, polling garante)
// ---------------------------------------------------------------------------

function criarSincronizadorDaTela(unidade) {
  const g = geracaoContexto();
  const daTela = () => !contextoMudou(g) && estado.raiz?.isConnected; // saiu da tela / trocou de unidade: descarta
  const sinc = criarSincronizador({
    buscar: obterResumoChecklist,
    intervaloMs: (estado.resumo?.atualizarEmS ?? 30) * 1000,
    aplicar: ({ data }) => {
      if (!daTela()) return;
      const novo = adaptarResumo(data, { unidade, metas: estado.metas, recebidoEmMs: Date.now() });
      const assinatura = assinaturaDados(data);
      const mudouVisivel = assinatura !== estado.assinatura || estado.resumo?.conexao?.estado !== novo.conexao.estado;
      estado.resumo = novo;
      estado.assinatura = assinatura;
      sinc.definirIntervalo(novo.atualizarEmS * 1000);
      if (mudouVisivel) redesenharQuandoPuder();
    },
    falhou: (erro) => {
      if (!daTela()) return;
      const antes = estado.resumo;
      estado.resumo = marcarFalha(antes, erro);
      estado.assinatura = "";
      if (antes?.conexao?.estado !== "indisponivel" || antes?.aviso?.titulo !== estado.resumo.aviso.titulo) redesenharQuandoPuder();
    },
  });
  return sinc;
}

/** Com o diálogo de metas aberto, o redesenho espera ele fechar (senão apagaria o que a pessoa digita). */
function redesenharQuandoPuder() {
  const dlg = estado.raiz?.querySelector("dialog.cko-dialogo[open]");
  if (!dlg) { desenhar(); return; }
  if (dlg.dataset.redesenhoPendente) return;
  dlg.dataset.redesenhoPendente = "1";
  dlg.addEventListener("close", () => { delete dlg.dataset.redesenhoPendente; if (estado.raiz?.isConnected) desenhar(); }, { once: true });
}

/** Aba/TV voltou a ficar visível: consulta já, sem esperar o próximo ciclo, e retoma o wake lock. */
function aoVoltarVisivel() {
  if (document.visibilityState !== "visible" || !estado.raiz?.isConnected) return;
  estado.sincronizador?.agora();
  pedirWakeLock();
}

function desenhar() {
  const opcoes = { podeEditarMetas: podeEditarMetas(), modo: estado.modo };
  const agora = agoraServidor();
  if (estado.raiz?.isConnected) {
    // Redesenho DENTRO da raiz: a tela cheia (presa ao elemento raiz) continua ativa, e o foco volta
    // para o mesmo controle (o botão antigo some com o innerHTML).
    const foco = seletorDoFoco(estado.raiz);
    estado.raiz.innerHTML = conteudoTela(estado.resumo, agora, opcoes);
    aoMudarTelaCheia();
    paginarPaineis(estado.raiz);
    devolverFoco(estado.raiz, foco);
  } else {
    const view = el("#view");
    view.innerHTML = montarTela(estado.resumo, agora, opcoes);
    estado.raiz = view.querySelector("[data-cko]");
    ligarEventos(estado.raiz);
    aoMudarTelaCheia();
    paginarPaineis(estado.raiz);
    if (modoValido(estado.modo)) {
      // O resto da Central sai da ordem do Tab e da árvore de acessibilidade enquanto o modo estiver aberto.
      estado.restaurarFoco = isolarFoco(estado.raiz);
      estado.raiz.focus({ preventScroll: true });
    }
  }
  if (!estado.observador && typeof ResizeObserver === "function") {
    estado.observador = new ResizeObserver(() => paginarPaineis(estado.raiz));
    estado.observador.observe(estado.raiz);
  }
  tique(); // liga os pulsos já no primeiro quadro
  if (!estado.tique) estado.tique = setInterval(tique, 1000);
}

// ---------------------------------------------------------------------------
// Estado visual: classe de nível, destaque ao ultrapassar e pulso
// ---------------------------------------------------------------------------

const reduzMovimento = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Troca o nível de um card/linha; ao CRUZAR para fora da meta, um destaque breve (uma vez). */
function aplicarNivel(no, nivel) {
  const anterior = no.dataset.nivel;
  if (anterior === nivel) return;
  NIVEIS.forEach((n) => no.classList.remove(`cko-nivel--${n}`));
  no.classList.add(`cko-nivel--${nivel}`);
  no.dataset.nivel = nivel;
  if (nivel === "critico" && anterior && anterior !== "critico" && !reduzMovimento()) {
    no.classList.add("cko-ultrapassou");
    setTimeout(() => no.classList.remove("cko-ultrapassou"), DURACAO_DESTAQUE_MS);
  }
}

/**
 * Ritmo do pulso de um contador vivo. `pulso` null (fora da meta, sem medição)
 * = borda estável, sem animar. O período muda por `updatePlaybackRate` só
 * quando varia mais de 2% — sem trabalho a cada segundo à toa.
 */
function aplicarPulso(no, pulso) {
  const anel = no.querySelector(":scope > .cko-faixa > [data-pulso]");
  if (!anel) return;
  anel.style.setProperty("--int", String(pulso ? pulso.intensidade : 1));
  if (!pulso || reduzMovimento() || typeof anel.animate !== "function") {
    anel._anim?.cancel();
    anel._anim = null;
    anel.dataset.estatico = "";
    return;
  }
  delete anel.dataset.estatico;
  const taxa = 1 / pulso.periodoS;
  if (!anel._anim) {
    anel._anim = anel.animate([{ opacity: 0.3 }, { opacity: 1, offset: 0.5 }, { opacity: 0.3 }], { duration: 1000, iterations: Infinity, easing: "ease-in-out" });
    anel._anim.playbackRate = taxa;
    anel._taxa = taxa;
  } else if (Math.abs(anel._taxa - taxa) / taxa > 0.02) {
    anel._anim.updatePlaybackRate(taxa);
    anel._taxa = taxa;
  }
}

const texto = (no, valor) => { if (no && no.textContent !== valor) no.textContent = valor; };

function largura(no, razao) {
  if (!no) return;
  no.style.width = `${(razao == null ? 0 : Math.min(1, razao / TETO_REGUA) * 100).toFixed(1)}%`;
}

function restante(no, r) {
  if (!no) return;
  texto(no, r.texto);
  no.classList.toggle("cko-restante--excedido", r.excedido);
}

// ---------------------------------------------------------------------------
// Tique de 1 s
// ---------------------------------------------------------------------------

function tique() {
  const raiz = estado.raiz;
  if (!raiz || !raiz.isConnected) { parar(); estado.modo = null; return; } // saiu da tela: a volta começa na seleção
  // Sem resposta boa há tempo demais (rede lenta, aba congelada): a tela se declara desatualizada sozinha.
  if (estado.resumo?.origem === "api" && estado.resumo.conexao?.estado !== "indisponivel"
    && estado.resumo.conexao?.estado !== "desatualizado" && envelhecido(estado.resumo, Date.now())) {
    estado.resumo = marcarEnvelhecido(estado.resumo);
    estado.assinatura = "";
    desenhar();
    return;
  }
  const agora = agoraServidor();
  const resumo = estado.resumo;

  texto(raiz.querySelector("[data-relogio]"), new Date(agora).toLocaleTimeString("pt-BR"));
  // Em dado real, diz também COMO a tela se atualiza: "tempo real" só se o servidor emite avisos (flag ligada
  // E recebimento ao vivo) E o canal privado da unidade está assinado; senão = polling de segurança.
  const modo = resumo.origem === "api" && estado.sincronizador
    ? ` · ${textoModoAtualizacao(statusCanal(topicoUnidade(state.sessao?.unidade?.id)), resumo.atualizarEmS, resumo.avisosTempoReal)}` : "";
  texto(raiz.querySelector("[data-sinc]"), textoSincronizacao(resumo.conexao, agora) + modo);

  for (const chave of CHAVES) atualizarCard(raiz, chave, resumo, agora);
  atualizarPedidos(raiz, resumo, agora);

  const slot = raiz.querySelector("[data-slot-status]");
  const atual = slot?.firstElementChild;
  if (slot && atual) {
    const s = derivarStatusOperacao(resumo, agora);
    if (atual.dataset.assinatura !== assinaturaStatus(s)) {
      const nivelAnterior = atual.dataset.nivel;
      slot.innerHTML = cardStatus(resumo, agora);
      const novo = slot.firstElementChild;
      novo.dataset.nivel = nivelAnterior;              // deixa aplicarNivel detectar a virada
      aplicarNivel(novo, s.nivel);
    }
  }
  if (paginando()) virarPaginasNoTempo(raiz);
}

function atualizarCard(raiz, chave, resumo, agora) {
  let card = raiz.querySelector(`[data-card="${chave}"]`);
  if (!card) return;
  const e = estadoDoCard(chave, resumo, agora);
  const temVivo = card.querySelector('[data-agora="vivo"]') != null;
  if (temVivo !== (e.vivo != null)) {
    // Entrou ou saiu um pedido da etapa: só este card é remontado.
    const nivelAnterior = card.dataset.nivel;
    card.outerHTML = cardTempo(chave, resumo, agora);
    card = raiz.querySelector(`[data-card="${chave}"]`);
    card.dataset.nivel = nivelAnterior;
  }
  aplicarNivel(card, e.nivel);
  texto(card.querySelector("[data-estado-rot]"), ROTULO_NIVEL[e.nivel]);
  if (e.vivo) {
    texto(card.querySelector("[data-agora-crono]"), e.vivo.cronometro);
    texto(card.querySelector("[data-agora-pedido]"), rotuloPedido(e.vivo.pedido.displayId));
    texto(card.querySelector("[data-agora-qtd]"), textoQuantidade(chave, e.vivo.quantidade));
    largura(card.querySelector("[data-regua]"), e.vivo.razao);
    restante(card.querySelector("[data-agora-restante]"), e.vivo.restante);
  }
  aplicarPulso(card, e.pulso);
}

function atualizarPedidos(raiz, resumo, agora) {
  const painel = raiz.querySelector(".cko-painel--ativos");
  if (!painel) return;
  const derivados = ordenarPorUrgencia((resumo.pedidosAtivos ?? []).map((p) => derivarPedidoAtivo(p, resumo.metas, agora)));
  const ordem = derivados.map((p) => p.id).join(",");
  if (painel.dataset.assinaturaAtivos !== ordem) {
    // Um pedido mudou de estado e precisa subir na lista: remonta SÓ este painel,
    // preservando o nível anterior de cada linha para o destaque de virada.
    const anteriores = new Map([...painel.querySelectorAll("[data-pedido]")].map((l) => [l.dataset.pedido, l.dataset.nivel]));
    const foco = painel.contains(document.activeElement) ? seletorDoFoco(raiz) : null;
    painel.outerHTML = painelPedidosAtivos(resumo, agora);
    const novo = raiz.querySelector(".cko-painel--ativos");
    novo.querySelectorAll("[data-pedido]").forEach((l) => {
      const nivel = l.dataset.nivel;
      if (anteriores.has(l.dataset.pedido)) { l.dataset.nivel = anteriores.get(l.dataset.pedido); aplicarNivel(l, nivel); }
    });
    paginarPainel(novo); // mesma página (ou a última que ainda existe), mesmo ciclo
    devolverFoco(raiz, foco);
  }
  const porId = new Map(derivados.map((p) => [p.id, p]));
  raiz.querySelectorAll(".cko-painel--ativos [data-pedido]").forEach((linha) => {
    const p = porId.get(linha.dataset.pedido);
    if (!p) return;
    const crono = linha.querySelector("[data-crono]");
    texto(crono, p.daEtapa.cronometro);
    if (crono && !crono.classList.contains(`cko-crono--${p.daEtapa.nivel}`)) {
      NIVEIS.forEach((n) => crono.classList.remove(`cko-crono--${n}`));
      crono.classList.add(`cko-crono--${p.daEtapa.nivel}`);
    }
    restante(linha.querySelector("[data-restante]"), p.daEtapa.restante);
    largura(linha.querySelector("[data-regua]"), p.daEtapa.razao);
    const vida = linha.querySelector("[data-vida]");
    if (vida) { vida.hidden = !p.governadoPelaVida; texto(vida, textoVida(p)); }
    aplicarNivel(linha, p.nivel);
    aplicarPulso(linha, p.pulso);
  });
}

// ---------------------------------------------------------------------------
// Paginação das listas (só Modo Televisão). Todas as linhas estão no DOM; aqui
// se decide quais aparecem. Páginas = linhas que cabem INTEIRAS no painel, na
// ordem, sem pular nenhuma. No Tablet: tudo visível e o paginador escondido.
// ---------------------------------------------------------------------------

const paginando = () => MODOS_EXIBICAO[estado.modo]?.paginarListas === true;

function paginarPaineis(raiz) {
  if (!raiz?.isConnected) return;
  raiz.querySelectorAll("[data-painel]").forEach(paginarPainel);
}

function paginarPainel(painel) {
  const lista = painel?.querySelector("[data-cabe]");
  const nav = painel?.querySelector("[data-paginacao]");
  if (!lista || !nav) return;
  const itens = [...lista.children];
  itens.forEach((i) => { i.hidden = false; });
  if (!paginando()) { esconderPaginador(nav); painel._paginas = null; return; }
  // Mede com o paginador visível (o espaço dele é reservado); se tudo couber numa página, ele some depois.
  nav.hidden = false;
  const cssPainel = getComputedStyle(painel);
  const fundo = painel.getBoundingClientRect().bottom - parseFloat(cssPainel.paddingBottom)
    - nav.getBoundingClientRect().height - (parseFloat(cssPainel.rowGap) || 0);
  const disponivel = fundo - lista.getBoundingClientRect().top;
  const paginas = montarPaginas(itens.map((i) => i.getBoundingClientRect().height), disponivel, parseFloat(getComputedStyle(lista).rowGap) || 0);
  painel._paginas = paginas;
  mostrarPagina(painel, estado.paginas.get(nav.dataset.paginacao) ?? 0);
}

function mostrarPagina(painel, pedida) {
  const nav = painel.querySelector("[data-paginacao]");
  const itens = [...painel.querySelector("[data-cabe]").children];
  const paginas = painel._paginas ?? [[0, itens.length]];
  const pagina = paginaValida(pedida, paginas.length);
  estado.paginas.set(nav.dataset.paginacao, pagina);
  const [ini, fim] = paginas[pagina];
  itens.forEach((item, i) => { item.hidden = i < ini || i >= fim; });
  if (paginas.length <= 1) { esconderPaginador(nav); return; }
  nav.hidden = false;
  texto(nav.querySelector("[data-pagina-rot]"), textoPagina({
    pagina, paginas: paginas.length, total: Number(nav.dataset.total) || itens.length, singular: nav.dataset.singular, plural: nav.dataset.plural,
  }));
}

/** Paginador some (uma página só ou Tablet); se o foco estava nele, volta para a raiz — nunca para o vazio. */
function esconderPaginador(nav) {
  const tinhaFoco = nav.contains(document.activeElement);
  nav.hidden = true;
  if (tinhaFoco) estado.raiz?.focus({ preventScroll: true });
}

/** Chamado pelo tique: vira todas as listas juntas a cada 10 s; reage também a linha que cresceu. */
function virarPaginasNoTempo(raiz) {
  raiz.querySelectorAll("[data-painel]").forEach((painel) => {
    // Linha que ganhou o aviso de vida (ou trocou de etapa) e passou do fundo: refaz as páginas deste painel.
    if (painel._paginas && painel.scrollHeight > painel.clientHeight + 1) paginarPainel(painel);
  });
  if (reduzMovimento()) { estado.proximaPaginaEm = null; return; } // sem virada automática: setas do paginador
  const agoraLocal = Date.now(); // cadência da virada: relógio do aparelho (não é um tempo exibido)
  if (estado.proximaPaginaEm == null) { estado.proximaPaginaEm = agoraLocal + INTERVALO_PAGINA_MS; return; }
  if (agoraLocal < estado.proximaPaginaEm) return;
  estado.proximaPaginaEm = agoraLocal + INTERVALO_PAGINA_MS;
  raiz.querySelectorAll("[data-painel]").forEach((painel) => virarPagina(painel, 1));
}

function virarPagina(painel, passo) {
  const paginas = painel._paginas;
  if (!paginas || paginas.length <= 1) return;
  const chave = painel.querySelector("[data-paginacao]").dataset.paginacao;
  mostrarPagina(painel, girarPagina(estado.paginas.get(chave) ?? 0, paginas.length, passo));
}

// ---------------------------------------------------------------------------
// Foco nos redesenhos: o controle focado é recriado; o foco vai para o novo
// ---------------------------------------------------------------------------

function seletorDoFoco(raiz) {
  const foco = document.activeElement;
  if (!foco || foco === raiz || !raiz.contains(foco)) return null;
  const acao = foco.closest("[data-acao]")?.dataset.acao;
  if (!acao) return null;
  const pag = foco.closest("[data-paginacao]")?.dataset.paginacao;
  return pag ? `[data-paginacao="${pag}"] [data-acao="${acao}"]` : `[data-acao="${acao}"]`;
}

function devolverFoco(raiz, seletor) {
  if (!seletor) return;
  const alvo = raiz.querySelector(seletor);
  if (alvo && !alvo.closest("[hidden]")) alvo.focus({ preventScroll: true });
  else raiz.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Tela cheia — o elemento do Checklist ocupa a tela. Sem ela (recusa, Esc,
// navegador sem a API) o modo continua imersivo DENTRO da página (CSS
// .cko--imersivo cobre o menu) e o botão "Tela cheia" tenta de novo.
// ---------------------------------------------------------------------------

async function entrarEmTelaCheia() {
  const raiz = estado.raiz;
  if (!raiz) return;
  const r = await pedirTelaCheia(raiz);
  if (estado.raiz !== raiz) return; // voltou à seleção enquanto o navegador decidia
  estado.tentativaTelaCheia = r.ok ? null : r.motivo;
  aoMudarTelaCheia();
}

function alternarTelaCheia() {
  if (telaCheiaAtiva(estado.raiz)) sairDaTelaCheia();
  else entrarEmTelaCheia();
}

async function pedirWakeLock() {
  // Mantém a TV/tablet acordada enquanto um modo estiver aberto (o navegador solta ao esconder a aba).
  const raiz = estado.raiz;
  if (!raiz || (estado.wakeLock && !estado.wakeLock.released)) return;
  try {
    const trava = await navigator.wakeLock?.request("screen");
    if (estado.raiz !== raiz) { trava?.release?.().catch(() => {}); return; } // já saiu do modo
    estado.wakeLock = trava ?? null;
  } catch { estado.wakeLock = null; }
}

function liberarWakeLock() {
  estado.wakeLock?.release?.().catch(() => {});
  estado.wakeLock = null;
}

function aoMudarTelaCheia() {
  const raiz = estado.raiz;
  if (!raiz) return;
  const ativa = telaCheiaAtiva(raiz);
  if (ativa) estado.tentativaTelaCheia = null;
  raiz.classList.toggle("cko--tela-cheia", ativa);
  const btn = raiz.querySelector('[data-acao="tela-cheia"]');
  if (btn && btn.getAttribute("aria-pressed") !== String(ativa)) {
    btn.setAttribute("aria-pressed", String(ativa));
    btn.querySelector("[data-rotulo-tela]").textContent = ativa ? "Sair da tela cheia" : "Tela cheia";
    btn.querySelector("[data-icone-tela]").innerHTML = icon(ativa ? "minimize" : "maximize", { size: 18 });
  }
  // Esc ou recusa: continua no modo, dentro da página, com o motivo escrito (nunca finge estar em tela cheia).
  const aviso = raiz.querySelector("[data-aviso-tela]");
  if (aviso) {
    const t = avisoTelaCheia({ ativa, ultimaTentativa: estado.tentativaTelaCheia });
    texto(aviso, t);
    aviso.hidden = !t;
  }
}

// ---------------------------------------------------------------------------
// Metas (demonstração)
// ---------------------------------------------------------------------------

function abrirMetas() {
  const raiz = estado.raiz;
  let dlg = raiz.querySelector("dialog.cko-dialogo");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.className = "cko-dialogo";
    dlg.setAttribute("aria-labelledby", "cko-t-metas");
    raiz.appendChild(dlg);
  }
  preencherMetas(dlg, estado.metas);
  dlg.showModal();
}

function preencherMetas(dlg, metas, erros = {}) {
  dlg.innerHTML = dialogoMetas(metas, { erros, demonstracao: estado.resumo?.origem === "demonstracao" });
  const form = dlg.querySelector("form");
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const campos = Object.fromEntries(new FormData(form).entries());
    const r = validarMetas(campos);
    if (!r.ok) {
      preencherMetas(dlg, lerParcial(campos), r.erros);
      dlg.querySelector('[aria-invalid="true"]')?.focus();
      return;
    }
    dlg.close();
    estado.metas = r.metas;
    estado.resumo = { ...estado.resumo, metas: r.metas };
    desenhar();
  });
  dlg.querySelector('[data-acao="metas-cancelar"]').addEventListener("click", () => dlg.close());
  dlg.querySelector('[data-acao="metas-exemplo"]').addEventListener("click", () => preencherMetas(dlg, clonarMetas(METAS_EXEMPLO)));
}

/** Mantém o que a pessoa digitou ao reexibir o formulário com erro. */
function lerParcial(c) {
  return Object.fromEntries(CHAVES.map((k) => [k, { meta: c[`${k}Meta`], avisoPct: c[`${k}Aviso`] }]));
}

function ligarEventos(raiz) {
  raiz.addEventListener("click", (ev) => {
    const acao = ev.target.closest("[data-acao]")?.dataset.acao;
    if (acao === "tela-cheia") alternarTelaCheia();
    else if (acao === "voltar") voltarParaSelecao();
    else if (acao === "metas") abrirMetas();
    else if (acao === "pagina-anterior" || acao === "pagina-proxima") {
      // Página escolhida à mão fica os 10 s inteiros na tela antes da próxima virada automática.
      virarPagina(ev.target.closest("[data-painel]"), acao === "pagina-proxima" ? 1 : -1);
      estado.proximaPaginaEm = Date.now() + INTERVALO_PAGINA_MS;
    }
  });
  // fullscreenchange borbulha do elemento até o document: ouvir na raiz evita
  // listener global que sobreviveria à troca de rota.
  raiz.addEventListener("fullscreenchange", aoMudarTelaCheia);
}
