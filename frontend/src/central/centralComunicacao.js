// CENTRAL DE COMUNICAÇÃO — controlador da aba "Comunicação" do Painel Administrativo: estado, chamadas de API, eventos (delegação), atualização ao vivo
// (cursor barato, sem recarregar listas), navegação responsiva e menus. O HTML vem de centralUi.js (puro); o modelo, de centralModelo.js (puro).
//
// ATUALIZAÇÃO AO VIVO: o Realtime do projeto é por tenant e o Painel Administrativo não tem esse contexto; por isso consultamos `centralAtualizacoes(cursor)`
// (só ids e totais) a cada ~8 s com a aba visível na Visão geral/Conversas, ~30 s nas demais e NADA com a aba do navegador oculta. Só quando algo mudou
// recarregamos a lista e/ou a conversa aberta.
//
// PRIVACIDADE: quem aparece é decidido pelo backend (roster). Este arquivo nunca monta telefone e nunca pesquisa por telefone.

import * as ui from "./centralUi.js";
import { htmlVisaoGeral } from "./centralVisao.js";
import * as M from "./centralModelo.js";
import { executarEnvio, criarTrava } from "./centralEnvio.js";
import { criarControleConexao } from "./centralConexao.js";

const POLL_ATIVO_MS = 8000;
const POLL_LENTO_MS = 30000;
const ROLAGEM_FIM_PX = 90;

let instancia = null;

/** Encerra a Central montada (timers, listeners). Chamado por quem troca de tela e no logout. */
export function pararCentral() { instancia?.destruir(); instancia = null; }

/**
 * @param {HTMLElement} raiz  container da tela (#padm-view)
 * @param {object} api        painelAdmApi
 * @param {object} [ganchos]  costuras com o restante do painel (legado): abrirEmpresa, abrirDetalheMensagem, htmlAtivacao, htmlTeste, ligarLegado, irParaTela, aoAcessoRevogado, operadorNome
 */
export function renderCentral(raiz, api, ganchos = {}, opcoes = {}) {
  pararCentral();
  instancia = criarCentral(raiz, api, ganchos, opcoes);
  return instancia.iniciar();
}

export function criarCentral(raiz, api, ganchos = {}, { abaInicial = "visao-geral", agora = () => new Date() } = {}) {
  const doc = raiz.ownerDocument ?? document;
  const janela = doc.defaultView ?? window;
  const host = doc.createElement("div");
  host.className = "cc-host";

  const S = {
    aba: abaInicial, estado: null, naoLidas: 0, cursor: null,
    conv: { itens: [], totais: {}, filtro: "todas", busca: "", carregando: true, erro: null },
    sel: null, thread: null, threadCarregando: false, horas: 24, tela: "lista", detalhes: false,
    rascunhos: new Map(), travas: new Map(), idsVistos: new Set(), ultimaLidaEm: new Map(),
    visao: null, auto: null, ativ: null, dest: null, destBusca: "", hist: { pacote: null, filtros: { organizacaoId: "", unidadeId: "", origem: "", status: "", desde: "", ate: "", operador: "", busca: "" }, pagina: 1 },
    config: null, diag: null, erros: [], cfgExtras: null,
    seq: { lista: 0, thread: 0, aba: 0, dest: 0 }, empurrados: 0, timer: null, pollando: false, vivo: true, menu: null,
  };
  const timers = new Set();
  // Aba Conexão (sub-controlador): mantém o estado da conta, o assistente e os modais; o topo da Central reflete o que ele descobre.
  const conexao = criarControleConexao({
    api, host, doc, janela, toast: (t) => toast(t), vivo: () => vivo(),
    aoEstado: (topo) => { if (!topo) return; S.estado = { ...(S.estado ?? {}), gateway: topo.gateway, identidade: topo.identidade }; S.visao = null; S.auto = null; pintarTopo(); },
    aoAcessoRevogado: (msg) => ganchos.aoAcessoRevogado?.(msg),
    ganchos: { aoConectar: () => { S.thread = S.thread ? { ...S.thread } : S.thread; }, aoDesconectar: () => {} },
  });
  const q = (sel, ctx = host) => ctx.querySelector(sel);
  const qa = (sel, ctx = host) => [...ctx.querySelectorAll(sel)];
  const vivo = () => S.vivo && raiz.contains(host);
  const ehMobile = () => janela.matchMedia?.("(max-width: 820px)")?.matches === true;
  const ehNotebook = () => janela.matchMedia?.("(max-width: 1279px)")?.matches === true;
  S.detalhes = !ehNotebook();   // tela larga: a coluna de contexto já nasce aberta; notebook/celular: fechada (gaveta)

  // ---------------------------------------------------------------------
  // Erros e utilidades
  // ---------------------------------------------------------------------
  function falhou(err) {
    if (err?.status === 403) { ganchos.aoAcessoRevogado?.(err.message || "Seu acesso ao Painel Administrativo não está mais disponível."); return true; }
    return false;
  }

  function toast(texto) {
    const t = doc.createElement("div"); t.className = "cc-toast"; t.setAttribute("role", "status"); t.textContent = texto;
    host.appendChild(t);
    const id = janela.setTimeout(() => { t.remove(); timers.delete(id); }, 2600); timers.add(id);
  }

  const rasc = (id) => { if (!S.rascunhos.has(id)) S.rascunhos.set(id, { texto: "", envioId: null, erro: "" }); return S.rascunhos.get(id); };
  const trava = (id) => { if (!S.travas.has(id)) S.travas.set(id, criarTrava()); return S.travas.get(id); };
  const itemDaLista = (id) => S.conv.itens.find((c) => c.contatoId === id);

  // ---------------------------------------------------------------------
  // Casca e abas
  // ---------------------------------------------------------------------
  function pintarCasca() {
    host.innerHTML = ui.htmlCasca({ aba: S.aba, estado: S.estado, naoLidas: S.naoLidas, corpo: "" });
    marcarAba();
    pintarCorpo();
  }

  // o traço da aba ativa é medido no layout: refaz quando a fonte terminar de carregar (a medida inicial usa a fonte reserva)
  try { doc.fonts?.ready?.then(() => { if (vivo()) marcarAba(); }); } catch { /* sem Font Loading API */ }

  function marcarAba() {
    const nav = q(".cc-abas"); const ativa = q(`[data-cc-aba="${S.aba}"]`);
    if (nav && ativa) {
      nav.style.setProperty("--x", `${ativa.offsetLeft}px`); nav.style.setProperty("--w", `${ativa.offsetWidth}px`);
      if (ativa.offsetLeft < nav.scrollLeft) nav.scrollLeft = ativa.offsetLeft;
      else if (ativa.offsetLeft + ativa.offsetWidth > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = ativa.offsetLeft + ativa.offsetWidth - nav.clientWidth;
    }
  }

  function pintarTopo() {
    const p = q("[data-cc-pills]"); if (p) p.innerHTML = ui.htmlPillsEstado(S.estado);
    const aba = q('[data-cc-aba="conversas"]');
    if (aba) {
      aba.querySelector(".cc-badge")?.remove();
      if (S.naoLidas > 0) aba.insertAdjacentHTML("beforeend", `<span class="cc-badge" aria-label="${S.naoLidas} conversas não lidas">${S.naoLidas > 99 ? "99+" : S.naoLidas}</span>`);
    }
  }

  const corpo = () => q("[data-cc-corpo]");

  function trocarAba(aba, params = {}) {
    if (!M.ABAS.some(([id]) => id === aba)) return;
    // Não se sai da Conexão no meio de uma operação (assistente/modal aberto): concluir ou cancelar primeiro.
    if (conexao.temModalAberto() && aba !== S.aba) { toast("Conclua ou cancele a conexão antes de mudar de aba."); return; }
    if (S.aba === "conexao" && aba !== "conexao") conexao.sairDaAba();
    S.aba = aba; S.seq.aba += 1;
    fecharMenu();
    if (aba === "conversas" && params.filtro && M.FILTROS_CONVERSA.some(([id]) => id === params.filtro)) { S.conv.filtro = params.filtro; S.conv.carregando = true; }
    if (aba === "historico" && params.status) { S.hist.filtros.status = params.status; S.hist.pagina = 1; S.hist.pacote = null; }
    pintarCasca();
    agendarPoll();
  }

  function pintarCorpo() {
    const c = corpo(); if (!c) return;
    const agoraD = agora();
    switch (S.aba) {
      case "conversas": {
        c.innerHTML = ui.htmlEspacoConversas({ tela: S.tela, detalhes: S.detalhes });
        pintarLista(); pintarChat(); pintarContexto();
        if (S.conv.carregando || !S.conv.itens.length) carregarConversas({ silencioso: false });
        break;
      }
      case "visao-geral": {
        if (!S.visao) { c.innerHTML = ui.skeletonPainel(); carregarVisao(); } else c.innerHTML = htmlVisaoGeral(S.visao, { agora: agoraD });
        break;
      }
      case "automacoes": {
        if (!S.auto) { c.innerHTML = ui.skeletonPainel(); carregarAutomacoes(); } else { c.innerHTML = ui.htmlAutomacoes(S.auto, { ativacaoHtml: ganchos.htmlAtivacao?.(S.ativ) ?? "", agora: agoraD }); ligarLegado(); }
        break;
      }
      case "historico": {
        c.innerHTML = ui.htmlHistorico(S.hist.pacote, S.hist.filtros, opcoesHistorico(), { agora: agoraD });
        if (!S.hist.pacote) carregarHistorico();
        if (!S.dest) carregarDestinatarios({ paraOpcoes: true });
        break;
      }
      case "destinatarios": {
        c.innerHTML = ui.htmlDestinatarios(S.dest, { busca: S.destBusca, agora: agoraD });
        if (!S.dest) carregarDestinatarios({});
        break;
      }
      case "conexao": { conexao.pintar(c); break; }
      case "configuracoes": {
        if (!S.config) { c.innerHTML = ui.skeletonPainel(); carregarConfiguracoes(); } else pintarConfiguracoes();
        break;
      }
      default: c.innerHTML = "";
    }
    marcarAba();
  }

  const opcoesHistorico = () => {
    const itens = S.dest?.itens ?? [];
    const empresas = new Map(); const unidades = new Map();
    for (const d of itens) { for (const o of d.empresas) empresas.set(o.organizacaoId, o); for (const u of d.unidades) unidades.set(u.unidadeId, u); }
    return { empresas: [...empresas.values()].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")), unidades: [...unidades.values()].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")) };
  };

  function ligarLegado() { ganchos.ligarLegado?.(host, { aoAtualizar: () => { S.auto = null; S.config = null; S.ativ = null; pintarCorpo(); } }); }

  // ---------------------------------------------------------------------
  // Carregamentos
  // ---------------------------------------------------------------------
  async function guardado(secao, fn) {
    const t = ++S.seq[secao];
    try { const r = await fn(); return vivo() && t === S.seq[secao] ? { r } : null; }
    catch (err) { if (!falhou(err) && vivo()) { const c = corpo(); if (c && secao === "aba") c.innerHTML = ui.erroCentral(err?.message); } return null; }
  }

  async function carregarVisao() {
    // A Visão Geral mostra a conta conectada: pede também o estado da aba Conexão (contrato existente). Falhou/inexistente ⇒ o cartão usa só os cards.
    const res = await guardado("aba", async () => {
      const [visao, estadoConexao] = await Promise.all([
        api.centralVisaoGeral(), Promise.resolve().then(() => api.conexaoEstado?.()).catch(() => null),
      ]);
      return { ...visao, conexao: estadoConexao ?? null };
    });
    if (!res) return;
    S.visao = res.r; S.cursor = res.r.cursor ?? S.cursor;
    S.estado = { gateway: res.r.cards.whatsapp.estado, modo: res.r.cards.automacao.modo }; S.naoLidas = res.r.cards.conversasNaoLidas;
    pintarTopo(); if (S.aba === "visao-geral") pintarCorpo();
  }

  async function carregarAutomacoes() {
    const res = await guardado("aba", async () => {
      const [auto, ativ] = await Promise.all([api.centralAutomacoes(), Promise.resolve().then(() => api.comunicacaoAtivacao?.()).catch(() => null)]);
      return { auto, ativ };
    });
    if (!res) return;
    S.auto = res.r.auto; S.ativ = res.r.ativ ?? null;
    S.estado = { ...(S.estado ?? {}), modo: res.r.auto.modo }; pintarTopo();
    if (S.aba === "automacoes") pintarCorpo();
  }

  async function carregarHistorico() {
    const f = S.hist.filtros;
    const dia = (x, fim) => (x ? new Date(`${x}T${fim ? "23:59:59.999" : "00:00:00"}`).toISOString() : "");
    const res = await guardado("aba", () => api.centralHistorico({ ...f, desde: dia(f.desde, false), ate: dia(f.ate, true), pagina: S.hist.pagina }));
    if (!res) return;
    S.hist.pacote = res.r; if (S.aba === "historico") pintarCorpo();
  }

  async function carregarDestinatarios({ paraOpcoes = false }) {
    const res = await guardado(paraOpcoes ? "dest" : "aba", () => api.centralDestinatarios({ busca: S.destBusca }));
    if (!res) return;
    S.dest = res.r;
    if (S.aba === "destinatarios") pintarCorpo();
    else if (S.aba === "historico") { const f = q("#cc-hist-filtros"); if (f) { const novo = ui.htmlFiltrosHistorico(S.hist.filtros, opcoesHistorico()); f.outerHTML = novo; } }
  }

  async function carregarConfiguracoes() {
    const res = await guardado("aba", async () => {
      const sem = (p) => Promise.resolve().then(p).catch(() => null);
      const [config, auto, ativ, resumo, orgs, testes] = await Promise.all([
        api.comunicacaoConfiguracaoOperacional(), sem(() => api.centralAutomacoes()), sem(() => api.comunicacaoAtivacao?.()),
        sem(() => api.comunicacaoResumo()), sem(() => api.comunicacaoOrganizacoes({})), sem(() => api.comunicacaoMensagens({ origem: "teste_controlado", porPagina: 10 })),
      ]);
      return { config, auto, ativ, resumo, orgs, testes };
    });
    if (!res) return;
    S.config = res.r.config; S.ativ = res.r.ativ; S.cfgExtras = res.r;
    if (S.aba === "configuracoes") pintarCorpo();
  }

  function pintarConfiguracoes() {
    const x = S.cfgExtras ?? {};
    const c = corpo(); if (!c) return;
    const aberto = q("[data-cc-tecnico]")?.open === true;
    c.innerHTML = ui.htmlConfiguracoes({
      config: S.config, diagnostico: S.diag ?? undefined, erros: S.erros,
      ativacaoHtml: ganchos.htmlAtivacao?.(S.ativ) ?? "", testeHtml: ganchos.htmlTeste?.({ resumo: x.resumo, orgs: x.orgs ?? [], testes: x.testes }) ?? "",
      empresasHabilitadas: x.auto?.empresasHabilitadas?.itens ?? [],
    });
    if (aberto) { const d = q("[data-cc-tecnico]"); if (d) d.open = true; }
    ligarLegado();
  }

  async function carregarDiagnostico() {
    if (S.diag) return;
    const d = q("[data-cc-tecnico]"); if (d) d.insertAdjacentHTML("beforeend", ui.skeletonTabela());
    const res = await guardado("aba", () => api.centralDiagnostico()); if (!res) return;
    S.diag = res.r; S.erros = res.r.ultimosErros ?? [];
    const aberto = q("[data-cc-tecnico]");
    if (aberto) { aberto.querySelector(".cc-skel-tabela")?.remove(); aberto.querySelector(".cc-cfg")?.remove(); aberto.insertAdjacentHTML("beforeend", ui.htmlDiagnostico(S.diag, S.erros)); }
  }

  // ---------------------------------------------------------------------
  // Conversas: lista
  // ---------------------------------------------------------------------
  function pintarLista() {
    const el = q("[data-cc-lista]"); if (!el) return;
    const tinhaFoco = doc.activeElement?.id === "cc-busca"; const pos = doc.activeElement?.selectionStart;
    el.innerHTML = ui.htmlListaConversas({ itens: S.conv.itens, totais: S.conv.totais, filtro: S.conv.filtro, busca: S.conv.busca, selecionada: S.sel, carregando: S.conv.carregando, agora: agora() });
    if (S.conv.erro) el.querySelector(".cc-itens, .cc-vazio, .cc-skel-lista")?.insertAdjacentHTML("beforebegin", ui.erroCentral(S.conv.erro));
    if (tinhaFoco) { const i = q("#cc-busca"); i?.focus(); if (pos != null) i?.setSelectionRange?.(pos, pos); }
  }

  async function carregarConversas({ silencioso }) {
    if (!silencioso) { S.conv.carregando = true; pintarLista(); }
    const res = await guardado("lista", () => api.conversas({ filtro: S.conv.filtro, busca: S.conv.busca }));
    if (!res) return;
    S.conv.itens = res.r.itens; S.conv.totais = res.r.totais; S.conv.carregando = false; S.conv.erro = null; S.cursor = res.r.cursor ?? S.cursor;
    S.naoLidas = totalNaoLidas(); pintarTopo();
    if (S.aba === "conversas") pintarLista();
  }
  // "Não lidas" do topo sempre reflete o total real (sem filtro/busca) quando o servidor o informa; senão, soma da lista.
  const totalNaoLidas = () => (S.conv.filtro === "todas" && !S.conv.busca ? S.conv.itens.filter((c) => c.naoLidas > 0).length : S.conv.totais.naoLidas ?? S.naoLidas);

  let debounceBusca = null;
  function aoBuscar(valor) {
    S.conv.busca = valor;
    janela.clearTimeout(debounceBusca);
    debounceBusca = janela.setTimeout(() => carregarConversas({ silencioso: false }), 220); timers.add(debounceBusca);
  }

  // ---------------------------------------------------------------------
  // Conversas: uma conversa
  // ---------------------------------------------------------------------
  function pintarChat({ rolar = "manter" } = {}) {
    const cab = q("[data-cc-chat-cab]"); const fluxo = q("[data-cc-fluxo]"); const area = q("[data-cc-composer-area]");
    if (!cab || !fluxo || !area) return;
    if (!S.sel) { pintarSe(cab, ""); fluxo.innerHTML = ui.htmlChatVazio(); area.innerHTML = ""; return; }
    if (S.threadCarregando || !S.thread) { pintarSe(cab, ""); fluxo.innerHTML = ui.skeletonChat(); area.innerHTML = ""; return; }
    pintarSe(cab, ui.htmlChatCabecalho(S.thread.contato, S.thread.envio, { detalhesAberto: S.detalhes }));
    // Composer ANTES do fluxo: o scroll ao fim é medido com a altura FINAL do composer (senão as últimas mensagens ficam abaixo da dobra).
    pintarComposer();
    pintarFluxo({ rolar });
  }

  /** Repintar HTML idêntico só destruiria o foco do teclado (o "+N", o título dos detalhes): escreve apenas se o conteúdo mudou desde a última escrita neste elemento. */
  const ultimoHtml = new WeakMap();
  function pintarSe(el, html) { if (ultimoHtml.get(el) === html) return false; el.innerHTML = html; ultimoHtml.set(el, html); return true; }

  /** Executa `fn` (que pode mudar a altura do composer/cabeçalho) e, se o fluxo estava no fim, o mantém no fim: a última bolha nunca fica escondida. */
  function preservarFim(fn) {
    const f = q("[data-cc-fluxo]");
    const noFim = M.estaNoFim(f, ROLAGEM_FIM_PX);
    fn();
    if (f && noFim) f.scrollTop = f.scrollHeight;
  }

  /** "+N" do cabeçalho: abre o painel de detalhes (coluna, gaveta ou tela) já na lista completa de empresas e unidades. */
  function verAssociacoes() {
    if (!S.detalhes) alternarDetalhes(true);
    // Síncrono: pintarContexto já rodou e getBoundingClientRect força o layout (só o eixo X da gaveta anima). Rola SÓ o painel (scrollIntoView moveria a página
    // inteira) e leva o foco ao título da lista, para teclado e leitor de tela.
    const sec = q("[data-cc-ctx-associacoes]"); if (!sec) return;
    const cont = sec.closest(".cc-contexto"); if (cont) cont.scrollTop += sec.getBoundingClientRect().top - cont.getBoundingClientRect().top;
    sec.querySelector("h4")?.focus?.({ preventScroll: true });
  }

  function pintarFluxo({ rolar = "manter" } = {}) {
    const fluxo = q("[data-cc-fluxo]"); if (!fluxo || !S.thread) return;
    const noFim = M.estaNoFim(fluxo, ROLAGEM_FIM_PX);
    const antes = fluxo.scrollHeight - fluxo.scrollTop;
    fluxo.innerHTML = ui.htmlFluxo({ mensagens: S.thread.mensagens, janelaHoras: S.thread.janelaHoras, temMaisAntigas: S.thread.temMaisAntigas, agora: agora() });
    const primeira = S.idsVistos.size === 0;
    for (const m of qa("[data-cc-msg]", fluxo)) { const id = m.dataset.ccMsg; if (!S.idsVistos.has(id)) { if (!primeira) m.classList.add("is-nova"); S.idsVistos.add(id); } }
    if (rolar === "fim" || (rolar === "manter" && noFim)) fluxo.scrollTop = fluxo.scrollHeight;
    else if (rolar === "manter") fluxo.scrollTop = fluxo.scrollHeight - antes;
  }

  function pintarComposer() {
    const area = q("[data-cc-composer-area]"); if (!area || !S.thread || !S.sel) return;
    const r = rasc(S.sel);
    const env = S.thread.envio ?? { podeEnviar: true, bloqueios: [] };
    preservarFim(() => {
      area.innerHTML = ui.htmlComposer({ podeEnviar: env.podeEnviar, bloqueios: env.bloqueios, texto: r.texto, enviando: trava(S.sel).ativa(), erro: r.erro });
      ajustarAltura(q("#cc-texto"));
    });
  }

  function pintarContexto() {
    const el = q("[data-cc-contexto]"); if (!el) return;
    pintarSe(el, S.thread?.contato ? ui.htmlContexto(S.thread.contato) : "");
    const esp = q("[data-cc-espaco]"); if (esp) { esp.dataset.ccTela = S.tela; esp.dataset.ccDetalhesAberto = String(S.detalhes); }
    const veu = q("[data-cc-veu]"); if (veu) veu.hidden = !(S.detalhes && ehNotebook() && !ehMobile());
    // O botão de detalhes vive no cabeçalho (memoizado por pintarSe): todo caminho que muda S.detalhes (alternar, voltar) passa por aqui e o mantém em sincronia.
    const b = q("[data-cc-detalhes].cc-btn-detalhes"); if (b) { b.classList.toggle("is-ativo", S.detalhes); b.setAttribute("aria-pressed", String(S.detalhes)); }
  }

  function definirTela(tela) {
    S.tela = tela; const esp = q("[data-cc-espaco]"); if (esp) esp.dataset.ccTela = tela;
  }

  async function abrirConversa(id, { foco = true, empurrar = true } = {}) {
    if (!id) return;
    if (S.aba !== "conversas") { S.aba = "conversas"; pintarCasca(); }
    S.sel = id; S.horas = 24; S.thread = null; S.threadCarregando = true; S.idsVistos = new Set();
    definirTela("chat");
    if (ehMobile() && empurrar) empurrarHistorico("chat");
    pintarLista(); pintarChat(); pintarContexto();
    await carregarThread({ silencioso: true, rolar: "fim" });
    if (foco && !ehMobile()) q("#cc-texto")?.focus();
  }

  async function carregarThread({ silencioso = true, rolar = "manter", antes = null } = {}) {
    const id = S.sel; if (!id) return;
    const res = await guardado("thread", () => api.conversa(id, { horas: S.horas, ...(antes ? { antes } : {}) }));
    if (!res || id !== S.sel) return;
    const novo = res.r;
    const cursor = novo.cursor ?? S.cursor; S.cursor = cursor;
    const jaTinha = !!S.thread;
    const gatingMudou = jaTinha && JSON.stringify(S.thread.envio?.bloqueios ?? []) !== JSON.stringify(novo.envio?.bloqueios ?? []);
    const antigas = S.thread?.mensagens ?? [];
    const paginacao = jaTinha && !antes ? { proximaPagina: S.thread.proximaPagina, temMaisAntigas: S.thread.temMaisAntigas } : {};
    S.thread = { ...novo, ...paginacao, mensagens: jaTinha ? M.mesclarMensagens(antigas, novo.mensagens) : novo.mensagens };
    S.threadCarregando = false;
    if (!jaTinha) pintarChat({ rolar }); else { pintarFluxo({ rolar }); if (gatingMudou) pintarComposer(); const cab = q("[data-cc-chat-cab]"); if (cab) preservarFim(() => { pintarSe(cab, ui.htmlChatCabecalho(S.thread.contato, S.thread.envio, { detalhesAberto: S.detalhes })); }); }
    pintarContexto();
    marcarComoLida();
  }

  /** Marca lida até a última mensagem RECEBIDA que a tela mostra (e só com a aba do navegador visível). */
  async function marcarComoLida() {
    const id = S.sel; if (!id || !S.thread || doc.visibilityState === "hidden") return;
    const ultimas = S.thread.mensagens.filter((m) => m.direcao === "entrada");
    const ate = ultimas.length ? ultimas[ultimas.length - 1].em : null;
    const item = itemDaLista(id);
    if (!ate || (S.ultimaLidaEm.get(id) ?? "") >= ate) return;   // sem mensagem recebida na janela, ou já marcada até aqui
    S.ultimaLidaEm.set(id, ate);
    if (item && item.naoLidas > 0) { item.naoLidas = 0; S.naoLidas = S.conv.itens.filter((c) => c.naoLidas > 0).length; pintarLista(); pintarTopo(); }
    try { await api.conversaMarcarLida(id, { ate }); } catch (err) { S.ultimaLidaEm.delete(id); falhou(err); }
  }

  /** No celular o botão Voltar do navegador precisa fazer o que a tela promete: cada passo (conversa, detalhes) empurra uma entrada no histórico. */
  function empurrarHistorico(passo) { try { janela.history.pushState({ cc: passo }, ""); S.empurrados += 1; } catch { /* sem history: segue */ } }

  /** Voltar pela interface: no celular delega ao history (que dispara o popstate e volta um passo); fora dele, volta direto. */
  function voltarUI() { if (ehMobile() && S.empurrados > 0) { try { janela.history.back(); return; } catch { /* segue */ } } voltar(); }

  function voltar() {
    if (S.tela === "detalhes") { definirTela("chat"); S.detalhes = false; pintarContexto(); return; }
    if (S.tela === "chat") { definirTela("lista"); S.sel = null; S.thread = null; pintarLista(); pintarChat(); pintarContexto(); }
  }

  function alternarDetalhes(forcar) {
    S.detalhes = typeof forcar === "boolean" ? forcar : !S.detalhes;
    if (ehMobile()) { definirTela(S.detalhes ? "detalhes" : "chat"); if (S.detalhes) empurrarHistorico("detalhes"); }
    pintarContexto();
  }

  // ---------------------------------------------------------------------
  // Envio
  // ---------------------------------------------------------------------
  function ajustarAltura(ta) { if (!ta) return; ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 132)}px`; }

  function atualizarBotaoEnviar() {
    const ta = q("#cc-texto"); const b = q("[data-cc-enviar]"); if (!ta || !b || !S.sel) return;
    b.disabled = !(S.thread?.envio?.podeEnviar !== false) || trava(S.sel).ativa() || !M.textoEnviavel(ta.value);
    const dica = q(".cc-composer-dica"); const n = M.caracteres(ta.value);
    if (dica) { dica.querySelector(".cc-contador-txt")?.remove(); if (n > M.TEXTO_MAX * 0.8) dica.insertAdjacentHTML("beforeend", `<span class="cc-contador-txt${n > M.TEXTO_MAX ? " is-excedeu" : ""}">${n}/${M.TEXTO_MAX}</span>`); }
  }

  async function enviar({ texto: textoForcado = null, envioForcado = null } = {}) {
    const id = S.sel; if (!id || !S.thread) return;
    const ta = q("#cc-texto"); const r = rasc(id);
    const texto = textoForcado ?? ta?.value ?? r.texto;
    if (!M.textoEnviavel(texto) || S.thread.envio?.podeEnviar === false) return;
    const t = trava(id);
    if (!t.tentar()) return;                                            // duplo clique: recusado aqui
    const envioId = envioForcado ?? r.envioId ?? (r.envioId = M.novoEnvioId());
    r.texto = ""; r.erro = "";
    if (ta) { ta.value = ""; ajustarAltura(ta); }
    atualizarBotaoEnviar();
    // bolha "enviando…" imediata
    const otim = M.mensagemOtimista({ envioId, texto: texto.trim(), operador: ganchos.operadorNome?.() ?? null, agora: agora() });
    S.thread.mensagens = M.mesclarMensagens(S.thread.mensagens.filter((m) => !(m.local && m.envioId === envioId)), [otim]);
    pintarFluxo({ rolar: "fim" });
    const res = await executarEnvio({ api, contatoId: id, texto, envioId, operador: otim.operador, agora: agora(), organizacaoId: null, unidadeId: null });
    t.liberar();
    if (id !== S.sel) return;                                            // o operador trocou de conversa no meio: nada a pintar aqui
    if (res.tipo === "ok") {
      r.envioId = null;
      const outras = S.thread.mensagens.filter((m) => !(m.local && m.envioId === envioId));
      S.thread.mensagens = res.mensagem ? M.mesclarMensagens(outras, [res.mensagem]) : outras;
      if (!res.mensagem) carregarThread({ silencioso: true, rolar: "fim" });
    } else if (res.tipo === "recusado") {
      S.thread.mensagens = S.thread.mensagens.filter((m) => !(m.local && m.envioId === envioId));
      r.texto = texto; r.erro = res.erro;                                 // nada foi criado: o texto volta ao composer (mesmo envioId, sem duplicar)
    } else if (res.tipo === "ambiguo") {
      S.thread.mensagens = M.mesclarMensagens(S.thread.mensagens.filter((m) => !(m.local && m.envioId === envioId)), [{ ...res.falha, texto: texto.trim() }]);
    }
    pintarFluxo({ rolar: "fim" }); pintarComposer();
    if (res.tipo === "recusado") q("#cc-texto")?.focus();
  }

  async function reenviar(envioId) {
    const m = S.thread?.mensagens.find((x) => x.local && x.envioId === envioId && x.falhaLocal);
    if (!m) return;
    await enviar({ texto: m.texto, envioForcado: envioId });
  }

  // ---------------------------------------------------------------------
  // Menus contextuais
  // ---------------------------------------------------------------------
  function fecharMenu() { host.querySelector(".cc-menu-flut")?.remove(); S.menu = null; }

  function abrirMenu(chave, ancora, ponto) {
    fecharMenu();
    const [tipo, id] = chave.split(/:(.+)/);
    let itens = [];
    if (tipo === "conversa") {
      const c = itemDaLista(id);
      itens = [
        { id: "lida", rotulo: "Marcar como lida", icone: "mail-open", desabilitado: !(c?.naoLidas > 0) },
        { id: "historico", rotulo: "Ver histórico", icone: "history" },
        { id: "empresa", rotulo: "Ver empresa", icone: "building", desabilitado: !c?.empresas?.length },
      ];
    } else if (tipo === "msg") {
      const m = S.thread?.mensagens.find((x) => x.id === id);
      itens = [
        { id: "copiar", rotulo: "Copiar texto", icone: "copy", desabilitado: !m?.texto },
        { id: "detalhes", rotulo: "Detalhes do envio", icone: "info", desabilitado: !(m && m.direcao === "saida" && !m.local) },
      ];
    }
    if (!itens.length) return;
    const flut = doc.createElement("div"); flut.className = "cc-menu-flut"; flut.innerHTML = ui.htmlMenu(itens);
    host.appendChild(flut);
    const r = (ancora ?? host).getBoundingClientRect(); const h = host.getBoundingClientRect();
    const x = ponto?.x ?? r.right; const y = ponto?.y ?? r.bottom;
    flut.style.left = `${Math.max(8, Math.min(x - h.left - flut.offsetWidth, h.width - flut.offsetWidth - 8))}px`;
    flut.style.top = `${Math.max(8, y - h.top + 4)}px`;
    S.menu = { tipo, id };
    flut.querySelector(".cc-menu-item:not([disabled])")?.focus();
  }

  async function executarMenu(acao) {
    const m = S.menu; fecharMenu(); if (!m) return;
    if (m.tipo === "conversa") {
      if (acao === "lida") {
        const item = itemDaLista(m.id); if (!item) return;
        item.naoLidas = 0; S.naoLidas = S.conv.itens.filter((c) => c.naoLidas > 0).length; pintarLista(); pintarTopo();
        try { await api.conversaMarcarLida(m.id, {}); } catch (err) { falhou(err); carregarConversas({ silencioso: true }); }
      } else if (acao === "historico") verHistoricoDe(m.id);
      else if (acao === "empresa") { const c = itemDaLista(m.id); if (c?.empresas?.[0]) ganchos.abrirEmpresa?.(c.empresas[0].organizacaoId); }
    } else if (m.tipo === "msg") {
      const msg = S.thread?.mensagens.find((x) => x.id === m.id); if (!msg) return;
      if (acao === "copiar") { try { await janela.navigator.clipboard.writeText(msg.texto ?? ""); toast("Texto copiado"); } catch { toast("Não foi possível copiar"); } }
      else if (acao === "detalhes") ganchos.abrirDetalheMensagem?.(msg.id);
    }
  }

  function verHistoricoDe(contatoId) {
    const c = itemDaLista(contatoId) ?? (S.thread?.contato?.contatoId === contatoId ? S.thread.contato : null);
    S.hist.filtros = { organizacaoId: "", unidadeId: "", origem: "", status: "", desde: "", ate: "", operador: "", busca: c?.nome ?? "" };
    S.hist.pagina = 1; S.hist.pacote = null;
    trocarAba("historico");
  }

  // ---------------------------------------------------------------------
  // Atualização ao vivo (cursor)
  // ---------------------------------------------------------------------
  function agendarPoll() {
    janela.clearTimeout(S.timer);
    if (!vivo() || doc.visibilityState === "hidden") return;
    const ms = S.aba === "conversas" || S.aba === "visao-geral" ? POLL_ATIVO_MS : POLL_LENTO_MS;
    S.timer = janela.setTimeout(poll, ms);
  }

  async function poll() {
    if (!vivo()) return;
    if (S.pollando) return;                                  // uma consulta por vez: visibilidade + timer nunca disparam duas
    S.pollando = true;
    try {
      const r = await api.centralAtualizacoes({ cursor: S.cursor ?? undefined });
      if (!vivo()) return;
      const mudouEstado = r.gateway !== S.estado?.gateway || (r.modo && r.modo !== S.estado?.modo);
      S.estado = { gateway: r.gateway, modo: r.modo ?? S.estado?.modo, identidade: S.estado?.identidade };
      const mudouNaoLidas = r.naoLidas !== S.naoLidas; S.naoLidas = r.naoLidas;
      if (mudouEstado || mudouNaoLidas) pintarTopo();
      if (!S.cursor) S.cursor = r.cursor;
      else if (r.mudou) { S.cursor = M.avancarCursor(S.cursor, r.cursor); await aoMudar(r.contatosAlterados ?? []); }
    } catch (err) { falhou(err); } finally { S.pollando = false; }
    agendarPoll();
  }

  async function aoMudar(ids) {
    if (S.aba === "conversas") {
      await carregarConversas({ silencioso: true });
      if (S.sel && ids.includes(S.sel)) await carregarThread({ silencioso: true, rolar: "manter" });
    } else if (S.aba === "visao-geral") { S.visao = null; carregarVisao(); }
    else if (S.aba === "historico") carregarHistorico();
  }

  // ---------------------------------------------------------------------
  // Eventos (delegação)
  // ---------------------------------------------------------------------
  function ir(alvo) {
    const [aba, param] = String(alvo).split(":");
    if (aba === "conversas") trocarAba("conversas", { filtro: param });
    else if (aba === "historico") trocarAba("historico", { status: param });
    else trocarAba(aba);
  }

  function aoClicar(ev) {
    const t = ev.target; if (!t.closest) return;
    if (conexao.aoClicar(ev)) return;                       // cliques da aba Conexão (assistente, modais, identidade)
    const menuAcao = t.closest("[data-cc-menu-acao]");
    if (menuAcao) { executarMenu(menuAcao.dataset.ccMenuAcao); return; }
    const maisBtn = t.closest("[data-cc-menu]");
    if (maisBtn) { ev.stopPropagation(); abrirMenu(maisBtn.dataset.ccMenu, maisBtn); return; }
    if (!t.closest(".cc-menu-flut")) fecharMenu();

    const aba = t.closest("[data-cc-aba]"); if (aba) { trocarAba(aba.dataset.ccAba); return; }
    const alvo = t.closest("[data-cc-ir]"); if (alvo) { ir(alvo.dataset.ccIr); return; }
    const filtro = t.closest("[data-cc-filtro]");
    if (filtro) { S.conv.filtro = filtro.dataset.ccFiltro; carregarConversas({ silencioso: false }); return; }
    const conv = t.closest("[data-cc-conversa]"); if (conv) { abrirConversa(conv.dataset.ccConversa); return; }
    if (t.closest("[data-cc-voltar]")) { voltarUI(); return; }
    if (t.closest("[data-cc-ver-associacoes]")) { verAssociacoes(); return; }
    if (t.closest("[data-cc-detalhes]")) { alternarDetalhes(); return; }
    if (t.closest("[data-cc-veu]")) { alternarDetalhes(false); return; }
    const re = t.closest("[data-cc-reenviar]"); if (re) { reenviar(re.dataset.ccReenviar); return; }
    const pag = t.closest("[data-cc-pag]");
    if (pag) { const [, dir] = pag.dataset.ccPag.split(":"); S.hist.pagina = Math.max(1, S.hist.pagina + (dir === "proximo" ? 1 : -1)); S.hist.pacote = null; pintarCorpo(); return; }

    const acao = t.closest("[data-cc-acao]");
    if (!acao) return;
    const a = acao.dataset.ccAcao; const org = acao.dataset.ccOrg; const id = acao.dataset.ccId;
    if (a === "mais-antigas") {
      const antes = S.thread?.proximaPagina;
      if (!antes) S.horas = S.horas < 168 ? 168 : 720;
      carregarThread({ silencioso: true, rolar: "manter", antes });
    }
    else if (a === "ver-empresa") ganchos.abrirEmpresa?.(org);
    else if (a === "configurar-empresa") ganchos.abrirEmpresa?.(org);
    else if (a === "ver-pendencias") ganchos.irParaTela?.("pendencias");
    else if (a === "ver-historico") verHistoricoDe(S.sel);
    else if (a === "abrir-conversa") abrirConversa(id);
    else if (a === "detalhe-mensagem") ganchos.abrirDetalheMensagem?.(id);
    else if (a === "limpar-filtros") { S.hist.filtros = { organizacaoId: "", unidadeId: "", origem: "", status: "", desde: "", ate: "", operador: "", busca: "" }; S.hist.pagina = 1; S.hist.pacote = null; pintarCorpo(); }
    else if (a === "recarregar") { S.visao = S.auto = S.config = null; S.hist.pacote = null; S.dest = null; carregarConversas({ silencioso: false }); pintarCorpo(); }
  }

  function aoInput(ev) {
    const t = ev.target;
    if (t.id === "cc-busca") { aoBuscar(t.value); return; }
    if (t.id === "cc-dest-busca") { S.destBusca = t.value; janela.clearTimeout(debounceBusca); debounceBusca = janela.setTimeout(() => { S.dest = null; carregarDestinatarios({}); }, 250); timers.add(debounceBusca); return; }
    if (t.id === "cc-texto") {
      if (S.sel) { const r = rasc(S.sel); r.texto = t.value; if (r.erro) { r.erro = ""; q(".cc-composer-erro")?.remove(); } }
      preservarFim(() => ajustarAltura(t)); atualizarBotaoEnviar();
    }
  }

  function aoTecla(ev) {
    const t = ev.target;
    if (conexao.aoTecla(ev)) return;
    if (ev.key === "Escape") {
      if (S.menu) { fecharMenu(); return; }
      if (S.detalhes) { alternarDetalhes(false); return; }
    }
    if (t.id === "cc-texto" && ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); enviar(); return; }
    if (t.closest?.(".cc-item") && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); abrirConversa(t.closest(".cc-item").dataset.ccConversa); return; }
    if (t.closest?.(".cc-itens") && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) {
      ev.preventDefault();
      const itens = qa(".cc-itens .cc-item"); const i = itens.indexOf(t.closest(".cc-item"));
      itens[Math.max(0, Math.min(itens.length - 1, i + (ev.key === "ArrowDown" ? 1 : -1)))]?.focus();
      return;
    }
    if (t.closest?.(".cc-menu-flut") && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) {
      ev.preventDefault();
      const its = qa(".cc-menu-item:not([disabled])"); const i = its.indexOf(doc.activeElement);
      its[(i + (ev.key === "ArrowDown" ? 1 : -1) + its.length) % its.length]?.focus();
    }
    if (t.closest?.(".cc-abas") && (ev.key === "ArrowRight" || ev.key === "ArrowLeft")) {
      const ids = M.ABAS.map(([id]) => id); const i = ids.indexOf(S.aba);
      const novo = ids[(i + (ev.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length];
      trocarAba(novo); q(`[data-cc-aba="${novo}"]`)?.focus();
    }
  }

  function aoEnviarForm(ev) {
    const f = ev.target;
    if (f.matches?.("[data-cc-composer]")) { ev.preventDefault(); enviar(); return; }
    if (f.id === "cc-hist-filtros") {
      ev.preventDefault();
      const dados = new FormData(f);
      for (const k of Object.keys(S.hist.filtros)) S.hist.filtros[k] = String(dados.get(k) ?? "").trim();
      S.hist.pagina = 1; S.hist.pacote = null; pintarCorpo();
    }
  }

  function aoMudarCampo(ev) {
    const t = ev.target;
    if (conexao.aoMudar(ev)) return;
    if (t.matches?.("#cc-hist-filtros select[name=organizacaoId]")) {
      const dados = new FormData(t.form);
      for (const k of Object.keys(S.hist.filtros)) S.hist.filtros[k] = String(dados.get(k) ?? "").trim();
      S.hist.filtros.unidadeId = ""; pintarCorpo();
    }
  }

  function aoMenuContexto(ev) {
    const alvo = ev.target.closest?.("[data-cc-conversa], [data-cc-msg]"); if (!alvo) return;
    ev.preventDefault();
    const chave = alvo.dataset.ccConversa ? `conversa:${alvo.dataset.ccConversa}` : `msg:${alvo.dataset.ccMsg}`;
    abrirMenu(chave, alvo, { x: ev.clientX, y: ev.clientY });
  }

  function aoToggleDetails(ev) { if (ev.target.matches?.("[data-cc-tecnico]") && ev.target.open) carregarDiagnostico(); }
  function aoErroImagem(ev) { const t = ev.target; if (t?.matches?.("img[data-cc-foto]")) t.remove(); }   // a foto falhou: as iniciais (por baixo) aparecem
  function aoVisibilidade() { if (doc.visibilityState === "visible") { janela.clearTimeout(S.timer); poll(); if (S.sel) marcarComoLida(); } else janela.clearTimeout(S.timer); }
  function aoPopState() { if (S.empurrados > 0) S.empurrados -= 1; if (S.aba === "conversas" && (S.tela === "chat" || S.tela === "detalhes")) voltar(); }
  function aoRedimensionar() { marcarAba(); }

  const ouvintes = [
    [host, "click", aoClicar], [host, "input", aoInput], [host, "keydown", aoTecla], [host, "submit", aoEnviarForm], [host, "change", aoMudarCampo],
    [host, "contextmenu", aoMenuContexto], [host, "toggle", aoToggleDetails, true], [host, "error", aoErroImagem, true],
    [doc, "visibilitychange", aoVisibilidade], [janela, "popstate", aoPopState], [janela, "resize", aoRedimensionar],
  ];

  // ---------------------------------------------------------------------
  // Ciclo de vida
  // ---------------------------------------------------------------------
  async function iniciar() {
    raiz.replaceChildren(host);
    for (const [alvo, tipo, fn, cap] of ouvintes) alvo.addEventListener(tipo, fn, cap === true);
    doc.addEventListener("app:logout", pararCentral);
    pintarCasca();
    // ancora o cursor e o estado do topo logo de cara (sem esperar a aba carregar)
    try {
      const r = await api.centralAtualizacoes({});
      if (vivo()) { S.cursor = S.cursor ?? r.cursor; S.estado = { gateway: r.gateway, modo: r.modo ?? null }; S.naoLidas = r.naoLidas; pintarTopo(); }
    } catch (err) { falhou(err); }
    agendarPoll();
  }

  function destruir() {
    S.vivo = false; janela.clearTimeout(S.timer); janela.clearTimeout(debounceBusca); conexao.destruir();
    for (const id of timers) janela.clearTimeout(id);
    for (const [alvo, tipo, fn, cap] of ouvintes) alvo.removeEventListener(tipo, fn, cap === true);
    doc.removeEventListener("app:logout", pararCentral);
    host.remove();
  }

  return { iniciar, destruir, _estado: S, _abrirConversa: abrirConversa, _trocarAba: trocarAba, _poll: poll, _enviar: enviar };
}
