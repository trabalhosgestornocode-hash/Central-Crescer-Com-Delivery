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
  montarTela, conteudoTela, telaSemUnidade, cardTempo, cardStatus, painelPedidosAtivos, assinaturaStatus,
  textoSincronizacao, textoQuantidade, textoVida, dialogoMetas,
} from "./checklistOperacionalVisual.js";

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
  sincronizador: null, // só existe com a tela aberta em dado real (nunca na demonstração)
  assinatura: "",
};

registrarResetDeContexto(() => {
  parar();
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
    view.innerHTML = telaSemUnidade();
    return;
  }
  estado.metas ??= clonarMetas(METAS_EXEMPLO);
  if (demonstracaoPedida()) {
    estado.resumo = amostraDemonstracao({ unidadeNome: unidade.nome, metas: estado.metas });
    desenhar();
    return;
  }
  estado.assinatura = "";
  estado.resumo = resumoCarregando({ unidade, metas: estado.metas });
  desenhar();
  document.addEventListener("visibilitychange", aoVoltarVisivel);
  estado.sincronizador = criarSincronizadorDaTela(unidade);
  estado.sincronizador.iniciar();
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

/** Aba/TV voltou a ficar visível: consulta já, sem esperar o próximo ciclo. */
function aoVoltarVisivel() {
  if (document.visibilityState !== "visible" || !estado.raiz?.isConnected) return;
  estado.sincronizador?.agora();
}

function desenhar() {
  const opcoes = { podeEditarMetas: podeEditarMetas() };
  const agora = agoraServidor();
  if (estado.raiz?.isConnected) {
    // Redesenho DENTRO da raiz: a tela cheia (presa ao elemento raiz) continua ativa.
    estado.raiz.innerHTML = conteudoTela(estado.resumo, agora, opcoes);
    aoMudarTelaCheia();
  } else {
    const view = el("#view");
    view.innerHTML = montarTela(estado.resumo, agora, opcoes);
    estado.raiz = view.querySelector("[data-cko]");
    ligarEventos(estado.raiz);
  }
  ajustarAoEspaco(estado.raiz);
  if (!estado.observador && typeof ResizeObserver === "function") {
    estado.observador = new ResizeObserver(() => ajustarAoEspaco(estado.raiz));
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
  if (!raiz || !raiz.isConnected) { parar(); return; }
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
    painel.outerHTML = painelPedidosAtivos(resumo, agora);
    const novo = raiz.querySelector(".cko-painel--ativos");
    novo.querySelectorAll("[data-pedido]").forEach((l) => {
      const nivel = l.dataset.nivel;
      if (anteriores.has(l.dataset.pedido)) { l.dataset.nivel = anteriores.get(l.dataset.pedido); aplicarNivel(l, nivel); }
    });
    ajustarAoEspaco(raiz);
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
// Encaixe sem rolagem: em painel de altura limitada (tela cheia), esconde as
// linhas que não cabem INTEIRAS e conta o excedente em "E mais N". Fora da
// tela cheia o painel cresce com o conteúdo e nada é escondido.
// ---------------------------------------------------------------------------

function ajustarAoEspaco(raiz) {
  if (!raiz?.isConnected) return;
  raiz.querySelectorAll(".cko-painel").forEach((painel) => {
    const lista = painel.querySelector("[data-cabe]");
    const mais = painel.querySelector("[data-mais]");
    if (!lista || !mais) return;
    const itens = [...lista.children];
    itens.forEach((i) => { i.hidden = false; });
    const extra = Number(mais.dataset.extra) || 0;
    let ocultos = 0;
    const escrever = () => {
      const n = ocultos + extra;
      mais.hidden = n === 0;
      mais.textContent = n ? `E mais ${n} ${n === 1 ? mais.dataset.singular : mais.dataset.plural}` : "";
    };
    escrever();
    for (let i = itens.length - 1; i > 0 && painel.scrollHeight > painel.clientHeight + 1; i--) {
      itens[i].hidden = true;
      ocultos++;
      escrever();
    }
  });
}

// ---------------------------------------------------------------------------
// Tela cheia (modo TV) — o elemento do Checklist ocupa a tela, sem o menu
// ---------------------------------------------------------------------------

async function alternarTelaCheia() {
  const raiz = estado.raiz;
  if (!raiz) return;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await raiz.requestFullscreen({ navigationUI: "hide" });
  } catch { /* navegador recusou (ex.: iframe sem permissão) — segue na janela */ }
}

async function pedirWakeLock() {
  // Mantém a TV/tablet acordada enquanto o Checklist estiver em tela cheia.
  try { estado.wakeLock = await navigator.wakeLock?.request("screen"); } catch { estado.wakeLock = null; }
}

function liberarWakeLock() {
  estado.wakeLock?.release?.().catch(() => {});
  estado.wakeLock = null;
}

function aoMudarTelaCheia() {
  const raiz = estado.raiz;
  if (!raiz) return;
  const ativa = document.fullscreenElement === raiz;
  raiz.classList.toggle("cko--tela-cheia", ativa);
  const btn = raiz.querySelector('[data-acao="tela-cheia"]');
  if (btn) {
    btn.setAttribute("aria-pressed", String(ativa));
    btn.querySelector("[data-rotulo-tela]").textContent = ativa ? "Sair da tela cheia" : "Tela cheia";
    btn.querySelector("[data-icone-tela]").innerHTML = icon(ativa ? "minimize" : "maximize", { size: 18 });
  }
  if (ativa) pedirWakeLock(); else liberarWakeLock();
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
    else if (acao === "metas") abrirMetas();
  });
  // fullscreenchange borbulha do elemento até o document: ouvir na raiz evita
  // listener global que sobreviveria à troca de rota.
  raiz.addEventListener("fullscreenchange", aoMudarTelaCheia);
}
