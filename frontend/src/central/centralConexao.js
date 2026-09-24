// CENTRAL DE COMUNICAÇÃO — sub-controlador da aba CONEXÃO: estado da conta, assistente de conexão (QR), confirmação da conta, desconexão e troca de número.
// Plugável no controlador principal (que delega cliques, teclas e mudanças de campo). A lógica de FASES é pura e testada em centralModelo.js (proximaFase/passosDoAssistente).
//
// SEGURANÇA DE TELA
//   * O QR chega só como SVG e é exibido em <img> (data URL). Ele some da memória da tela (resp.svg = null) no instante em que a conta conecta e ao fechar o assistente.
//   * Nunca vai para localStorage/sessionStorage, nunca para console, nunca para o histórico. O telefone é sempre mascarado (o backend nem manda o número).
//   * Um 403 aqui é, na maioria das vezes, FALTA DE PERMISSÃO de gerenciar a conexão — e NÃO acesso revogado ao painel (que deslogaria).
//
// ATUALIZAÇÃO AO VIVO: com o assistente aberto, consultamos o QR a cada 2 s (só com a aba visível) e a contagem corre a cada 1 s; sem assistente, o estado é relido a cada ~10 s
// enquanto a aba Conexão está ativa. (O Realtime do projeto é por tenant; ver a decisão registrada nas Conversas.)

import * as ui from "./centralConexaoUi.js";
import { proximaFase, progressoQr, novoEnvioId, etapaDaFase } from "./centralModelo.js";

const POLL_QR_MS = 2000;
const POLL_ESTADO_MS = 10000;
const RESPIRO_VALIDANDO_MS = 1100;
const RESPIRO_PERFIL_MS = 900;

const ehPermissao = (err) => err?.status === 403 && /gerenciar a conex/i.test(String(err?.message ?? ""));

/** O que o topo da Central precisa saber da conexão (gateway em vocabulário do topo + identidade interna). */
export function resumoParaTopo(c) {
  if (!c) return null;
  const gateway = c.estado === "CONNECTED" ? "conectado" : ["CONNECTING", "WAITING_QR", "RECONNECTING"].includes(c.estado) ? "instavel" : "desconectado";
  return { gateway, identidade: { status: c.identidade?.status ?? "SEM_CONTA", ambiente: c.identidade?.ambiente ?? "TESTE", nomeOperacional: c.identidade?.nomeOperacional ?? null } };
}

export function criarControleConexao({ api, host, doc, janela, ganchos = {}, toast = () => {}, agora = () => Date.now(), vivo = () => true, aoEstado = () => {}, aoAcessoRevogado = () => {} }) {
  const K = { estado: null, wiz: null, modal: null, timerEstado: null, timerQr: null, timerTempo: null, timeouts: new Set(), ativo: false, container: null, assinatura: "" };
  const q = (sel, ctx = host) => ctx.querySelector(sel);

  function tratar(err) {
    if (err?.status === 403 && !ehPermissao(err)) { aoAcessoRevogado(err.message || "Seu acesso ao Painel Administrativo não está mais disponível."); return true; }
    return false;
  }
  const mensagem = (err, padrao) => (err?.status && err.status < 500 && err.message ? err.message : padrao);
  const depois = (fn, ms) => { const id = janela.setTimeout(() => { K.timeouts.delete(id); fn(); }, ms); K.timeouts.add(id); return id; };

  // ---------------------------------------------------------------------
  // Aba: estado da conta
  // ---------------------------------------------------------------------
  function pintar(container) {
    K.container = container ?? K.container; K.ativo = true;
    if (!K.container) return;
    const aberto = q("[data-cc-tecnico-conexao]", K.container)?.open === true;
    K.container.innerHTML = ui.htmlConexao(K.estado, { agora: new Date(agora()) });
    if (aberto) { const d = q("[data-cc-tecnico-conexao]", K.container); if (d) d.open = true; }
    if (!K.estado) carregar();
    agendarEstado();
  }

  async function carregar() {
    try {
      const e = await api.conexaoEstado();
      if (!vivo()) return;
      K.estado = e; aoEstado(resumoParaTopo(e), e);
      if (K.ativo && !K.wiz) pintar();
    } catch (err) {
      if (!tratar(err) && K.container && !K.estado) K.container.innerHTML = `<div class="cc-erro" role="alert"><div><strong>Não foi possível carregar a conexão.</strong><p>${mensagem(err, "Tente novamente em instantes.")}</p></div><button type="button" class="btn btn-ghost btn-sm" data-cc-acao="recarregar">Tentar de novo</button></div>`;
    }
  }

  function agendarEstado() {
    janela.clearTimeout(K.timerEstado);
    if (!K.ativo || !vivo() || doc.visibilityState === "hidden") return;
    K.timerEstado = janela.setTimeout(async () => { if (!K.wiz && !K.modal) await carregar(); agendarEstado(); }, POLL_ESTADO_MS);
  }

  /** A aba saiu de cena: para os timers de estado (o assistente aberto continua o seu próprio ciclo). */
  function sairDaAba() { K.ativo = false; janela.clearTimeout(K.timerEstado); }

  // ---------------------------------------------------------------------
  // Modais (assistente / desconectar / trocar)
  // ---------------------------------------------------------------------
  function montarModal(html) {
    const havia = !!q("[data-cc-modal-raiz]");   // repintar um modal aberto NÃO repete a animação de entrada
    if (!havia) K.focoAnterior = doc.activeElement;
    fecharModalEl(false);
    const wrap = doc.createElement("div"); wrap.innerHTML = html;
    const el = wrap.firstElementChild; el.dataset.ccModalRaiz = "1"; if (havia) el.classList.add("is-reposto");
    host.appendChild(el);
    janela.setTimeout(() => (q("[data-cc-modal-wrap] input, [data-cc-modal-wrap] .btn-primary, [data-cc-modal-wrap] .btn") ?? el).focus?.(), 30);
    return el;
  }
  function fecharModalEl(restaurar = true) {
    host.querySelector("[data-cc-modal-raiz]")?.remove();
    if (restaurar) { if (K.focoAnterior?.isConnected) K.focoAnterior.focus?.(); K.focoAnterior = null; }
  }

  function restaurarFocoAssistente(anterior) {
    const campos = ["data-cc-conexao", "data-cc-valor", "data-cc-agente"];
    const candidatos = [...host.querySelectorAll('[data-cc-modal-wrap] button:not(:disabled), [data-cc-modal-wrap] input:not(:disabled)')];
    const equivalente = anterior && candidatos.find((el) => campos.some((a) => anterior.hasAttribute(a)) && campos.every((a) => el.getAttribute(a) === anterior.getAttribute(a)));
    (equivalente ?? candidatos.find((el) => el.classList.contains("btn-primary")) ?? candidatos[0])?.focus?.({ preventScroll: true });
  }

  function pintarModalSimples() {
    const m = K.modal; if (!m) return;
    const conta = K.estado?.conta ?? null;
    const html = m.tipo === "desconectar" ? ui.htmlModalDesconectar({ conta, marcado: m.marcado, enviando: m.enviando, erro: m.erro }) : ui.htmlModalTrocar({ conta, marcado: m.marcado, enviando: m.enviando, erro: m.erro });
    montarModal(html);   // recria o modal e devolve o foco ao primeiro campo (a caixa de confirmação)
  }

  function abrirModalSimples(tipo) { K.modal = { tipo, marcado: false, enviando: false, erro: "" }; pintarModalSimples(); }
  function fecharModalSimples() { K.modal = null; fecharModalEl(); }

  async function confirmarDesconexao() {
    const m = K.modal; if (!m || !m.marcado || m.enviando) return;
    m.enviando = true; m.erro = ""; pintarModalSimples();
    try {
      const e = await api.conexaoDesconectar();
      K.estado = e; aoEstado(resumoParaTopo(e), e); fecharModalSimples(); toast("WhatsApp desconectado"); ganchos.aoDesconectar?.(); if (K.ativo) pintar();
    } catch (err) { if (tratar(err)) return; m.enviando = false; m.erro = mensagem(err, "Não foi possível desconectar agora."); pintarModalSimples(); }
  }

  async function confirmarTroca() {
    const m = K.modal; if (!m || !m.marcado || m.enviando) return;
    m.enviando = true; m.erro = ""; pintarModalSimples();
    try {
      const r = await api.conexaoTrocar();
      fecharModalSimples();
      await abrirAssistente("trocar", { operacaoId: r.operacaoId });
    } catch (err) { if (tratar(err)) return; m.enviando = false; m.erro = mensagem(err, "Não foi possível iniciar a troca agora."); pintarModalSimples(); }
  }

  // ---------------------------------------------------------------------
  // Assistente
  // ---------------------------------------------------------------------
  const assinaturaDe = (w) => [w.fase, w.resp?.ordem ?? 0, w.resp?.geradoEm ?? "", !!w.resp?.svg, w.erro ?? "", w.enviando, w.agente, w.ambiente, w.svgIndisponivel].join("|");

  function pintarAssistente({ forcar = false } = {}) {
    const w = K.wiz; if (!w) return;
    const sig = assinaturaDe(w);
    if (!forcar && sig === K.assinatura && q("[data-cc-modal-wrap]")) { pintarTempo(); return; }
    K.assinatura = sig;
    const antes = q("[data-cc-modal-raiz]");
    if (!antes) K.progAnterior = null;                                                                       // assistente novo: o trilho parte do zero
    w.progDe = K.progAnterior ?? ui.progressoDoAssistente(w); K.progAnterior = ui.progressoDoAssistente(w);   // ...e nas trocas de fase anima do ponto anterior até o atual
    const html = ui.htmlAssistente(w, agora());
    if (antes) {
      const ativo = antes.contains(doc.activeElement) ? doc.activeElement : null;
      const scroll = q(".cc-modal", antes)?.scrollTop ?? 0;
      const t = doc.createElement("div"); t.innerHTML = html; const novo = t.firstElementChild; novo.dataset.ccModalRaiz = "1"; novo.classList.add("is-reposto"); antes.replaceWith(novo);
      restaurarFocoAssistente(ativo);
      const modal = q(".cc-modal", novo); if (modal) modal.scrollTop = scroll;
    }
    else montarModal(html);
    pintarTempo();
  }

  /** Contagem do QR: só o texto e o anel (a imagem não é recriada a cada segundo). */
  function pintarTempo() {
    const w = K.wiz; if (!w || w.fase !== "aguardando") return;
    const r = w.resp ?? {}; const { restante, fracao } = progressoQr(r.expiraEm, r.ordem, agora());
    const alvo = q("[data-cc-qr-tempo] span"); if (alvo) alvo.innerHTML = `Expira em <b>${restante} s</b>`;
    const anel = q(".cc-anel-prog"); if (anel) { anel.style.strokeDasharray = `${(fracao * 100.5).toFixed(1)} 100.5`; anel.classList.toggle("is-fim", restante <= 8); }
  }

  function pararCiclos() {
    janela.clearTimeout(K.timerQr); janela.clearInterval(K.timerTempo); K.timerQr = null; K.timerTempo = null;
    for (const id of K.timeouts) janela.clearTimeout(id); K.timeouts.clear();
  }

  function erroFase(err, padrao) {
    const w = K.wiz; if (!w) return;
    pararCiclos();
    const indice = etapaDaFase(w.fase);
    w.fase = "erro"; w.falhouEm = indice; w.erro = mensagem(err, padrao); w.resp = null;
    pintarAssistente({ forcar: true });
  }

  async function abrirAssistente(modo, { operacaoId = null } = {}) {
    fecharModalSimples(); pararCiclos();
    const est = K.estado;
    const w = K.wiz = { modo, fase: modo === "revisar" ? "identificado" : "iniciando", operacaoId, resp: null, conta: modo === "revisar" ? est?.conta ?? null : null, agente: false, ambiente: est?.identidade?.ambiente ?? "TESTE", erro: null, enviando: false, desde: agora(), falhouEm: null, svgIndisponivel: false };
    pintarAssistente({ forcar: true });
    if (modo === "revisar") { w.operacaoId = est?.operacao?.id ?? novoEnvioId(); return; }
    try {
      if (modo === "conectar") { const r = await api.conexaoIniciar(); if (K.wiz !== w) return; w.operacaoId = r.operacaoId; }
      else if (modo === "retomar") w.operacaoId = operacaoId ?? est?.operacao?.id;
      if (!w.operacaoId) throw Object.assign(new Error("Não há uma conexão em andamento para continuar."), { status: 409 });
    } catch (err) { if (tratar(err)) return; erroFase(err, "Não foi possível iniciar a conexão agora."); return; }
    w.fase = "gerando"; w.desde = agora(); pintarAssistente({ forcar: true });
    iniciarCiclos();
  }

  function iniciarCiclos() {
    pararCiclos();
    K.timerTempo = janela.setInterval(pintarTempo, 1000);
    tickQr();
  }

  async function tickQr() {
    const w = K.wiz;
    if (!w || !vivo() || !["gerando", "aguardando", "expirado"].includes(w.fase)) return;
    if (doc.visibilityState === "hidden") { K.timerQr = janela.setTimeout(tickQr, POLL_QR_MS); return; }
    try {
      const resp = await api.conexaoQr(w.operacaoId);
      if (K.wiz !== w) return;
      w.resp = resp; w.svgIndisponivel = resp.disponivel === true && !resp.svg;
      const nova = proximaFase(w.fase, resp, { agora: agora(), desde: w.desde });
      if (nova !== w.fase) { w.fase = nova; w.desde = agora(); }
      if (nova === "validando") {
        // O QR SOME da memória da tela no mesmo instante em que a conta conecta.
        w.conta = resp.conta ?? K.estado?.conta ?? null; w.resp = { ...resp, svg: null, disponivel: false };
        pintarAssistente({ forcar: true });
        depois(() => avancarPerfil(w), RESPIRO_VALIDANDO_MS);
        janela.clearInterval(K.timerTempo);
        return;
      }
      pintarAssistente();
    } catch (err) {
      if (tratar(err)) return;
      if (err?.status && err.status >= 400 && err.status < 500) { erroFase(err, "A conexão não está mais disponível."); return; }
      /* falha de rede momentânea: tenta de novo no próximo ciclo */
    }
    K.timerQr = janela.setTimeout(tickQr, POLL_QR_MS);
  }

  async function avancarPerfil(w) {
    if (K.wiz !== w) return;
    w.fase = "perfil"; pintarAssistente({ forcar: true });
    if (!w.conta) { try { const e = await api.conexaoEstado(); K.estado = e; aoEstado(resumoParaTopo(e), e); w.conta = e.conta ?? null; } catch (err) { if (tratar(err)) return; } }
    depois(() => { if (K.wiz !== w) return; w.fase = "identificado"; pintarAssistente({ forcar: true }); }, RESPIRO_PERFIL_MS);
  }

  async function novoQr() {
    const w = K.wiz; if (!w?.operacaoId) return;
    w.fase = "gerando"; w.desde = agora(); w.resp = null; w.erro = null; pintarAssistente({ forcar: true });
    try { await api.conexaoNovoQr(w.operacaoId); } catch (err) { if (tratar(err)) return; erroFase(err, "Não foi possível gerar um novo QR Code agora."); return; }
    iniciarCiclos();
  }

  async function confirmarConta() {
    const w = K.wiz; if (!w || w.fase !== "identificado" || w.enviando) return;
    w.enviando = true; w.erro = null; pintarAssistente({ forcar: true });
    try {
      const e = await api.conexaoConfirmar({ operacaoId: w.operacaoId, utilizarComoAgente: w.agente, ambiente: w.ambiente });
      if (K.wiz !== w) return;
      K.estado = e; aoEstado(resumoParaTopo(e), e); w.conta = e.conta ?? w.conta; w.fase = "concluida"; w.enviando = false; w.resp = null;
      ganchos.aoConectar?.();
      pintarAssistente({ forcar: true });
    } catch (err) { if (tratar(err)) return; w.enviando = false; w.erro = mensagem(err, "Não foi possível confirmar agora. Tente de novo."); pintarAssistente({ forcar: true }); }
  }

  /** Encerra o assistente. `cancelar`: desfaz o que estiver em andamento no servidor (pareamento aberto ou conta ainda não confirmada). */
  async function fecharAssistente({ cancelar = false } = {}) {
    const w = K.wiz; if (!w) return;
    pararCiclos(); K.wiz = null; K.assinatura = ""; fecharModalEl();
    const preciso = cancelar && w.operacaoId && !["concluida"].includes(w.fase);
    if (preciso) { try { const e = await api.conexaoCancelar(w.operacaoId); K.estado = e; aoEstado(resumoParaTopo(e), e); } catch (err) { if (!tratar(err)) toast("Não foi possível cancelar agora. Verifique o estado da conexão."); } }
    if (K.ativo) { pintar(); carregar(); }
  }

  async function cancelarOperacao() {
    const op = K.estado?.operacao?.id; if (!op) return;
    try { const e = await api.conexaoCancelar(op); K.estado = e; aoEstado(resumoParaTopo(e), e); toast("Conexão cancelada"); } catch (err) { if (!tratar(err)) toast(mensagem(err, "Não foi possível cancelar agora.")); }
    if (K.ativo) pintar();
  }

  async function alterarIdentidade(campos) {
    try { const e = await api.conexaoIdentidade(campos); K.estado = e; aoEstado(resumoParaTopo(e), e); if (K.ativo) pintar(); }
    catch (err) { if (!tratar(err)) toast(mensagem(err, "Não foi possível salvar agora.")); }
  }

  // ---------------------------------------------------------------------
  // Eventos delegados
  // ---------------------------------------------------------------------
  /** @returns {boolean} true se o clique era da Conexão (o controlador principal não deve tratá-lo). */
  function aoClicar(ev) {
    const t = ev.target; if (!t?.closest) return false;
    const fundo = t.matches?.("[data-cc-modal-wrap]") ? t : null;
    if (fundo) {
      if (K.modal) { fecharModalSimples(); return true; }
      if (K.wiz && !["identificado", "concluida"].includes(K.wiz.fase)) { fecharAssistente({ cancelar: true }); return true; }
      return true;
    }
    const b = t.closest("[data-cc-conexao]"); if (!b) return false;
    const a = b.dataset.ccConexao; const v = b.dataset.ccValor;
    switch (a) {
      case "conectar": abrirAssistente("conectar"); break;
      case "retomar": abrirAssistente("retomar", { operacaoId: K.estado?.operacao?.id }); break;
      case "revisar": abrirAssistente("revisar"); break;
      case "trocar": abrirModalSimples("trocar"); break;
      case "desconectar": abrirModalSimples("desconectar"); break;
      case "cancelar-operacao": cancelarOperacao(); break;
      case "agente": alterarIdentidade({ agenteCrescer: !(K.estado?.identidade?.agenteCrescer === true) }); break;
      case "ambiente": alterarIdentidade({ ambiente: v }); break;
      case "ambiente-assistente": if (K.wiz) { K.wiz.ambiente = v; pintarAssistente(); } break;
      case "novo-qr": novoQr(); break;
      case "assistente-cancelar": fecharAssistente({ cancelar: true }); break;
      case "assistente-fechar": fecharAssistente({ cancelar: false }); break;
      case "assistente-confirmar": confirmarConta(); break;
      case "assistente-tentar": { const modo = K.wiz?.modo === "trocar" || K.wiz?.modo === "revisar" ? "conectar" : (K.wiz?.modo ?? "conectar"); fecharAssistente({ cancelar: true }).then(() => abrirAssistente(modo)); break; }
      case "modal-fechar": fecharModalSimples(); break;
      case "desconectar-confirmar": confirmarDesconexao(); break;
      case "trocar-confirmar": confirmarTroca(); break;
      default: return false;
    }
    return true;
  }

  /** Checkboxes dos modais. @returns {boolean} tratado */
  function aoMudar(ev) {
    const t = ev.target;
    if (t?.matches?.("[data-cc-confirma]") && K.modal) { K.modal.marcado = t.checked; pintarModalSimples(); q("[data-cc-modal-wrap] input[data-cc-confirma]")?.focus?.(); return true; }
    if (t?.matches?.("[data-cc-agente]") && K.wiz) { K.wiz.agente = t.checked; pintarAssistente(); return true; }
    return false;
  }

  /** Escape: fecha modais simples; no assistente cancela (exceto quando a conta já foi identificada — aí só os botões decidem). @returns {boolean} tratado */
  function aoTecla(ev) {
    const modal = q("[data-cc-modal-wrap]");
    if (modal && ev.key === "Tab") {
      const itens = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
      const i = itens.indexOf(doc.activeElement);
      if (itens.length && (i < 0 || (ev.shiftKey ? i === 0 : i === itens.length - 1))) {
        ev.preventDefault(); itens[ev.shiftKey ? itens.length - 1 : 0].focus();
      }
      return true;
    }
    const radio = ev.target?.closest?.('[role="radio"]');
    if (radio && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(ev.key)) {
      const opcoes = [...radio.closest('[role="radiogroup"]').querySelectorAll('[role="radio"]')];
      ev.preventDefault();
      opcoes[(opcoes.indexOf(radio) + (["ArrowLeft", "ArrowUp"].includes(ev.key) ? -1 : 1) + opcoes.length) % opcoes.length]?.click();
      return true;
    }
    if (ev.key !== "Escape") return false;
    if (K.modal) { fecharModalSimples(); return true; }
    if (K.wiz) { if (!["identificado", "concluida"].includes(K.wiz.fase)) fecharAssistente({ cancelar: true }); else if (K.wiz.fase === "concluida") fecharAssistente({}); return true; }
    return false;
  }

  /** Destruição da Central: para tudo e, se um assistente estava aberto, desfaz o pareamento (best-effort) para não deixar trava nem sessão pendente. */
  function destruir() {
    const w = K.wiz; pararCiclos(); janela.clearTimeout(K.timerEstado); K.ativo = false; K.wiz = null; K.modal = null; fecharModalEl();
    if (w?.operacaoId && !["concluida"].includes(w.fase)) api.conexaoCancelar(w.operacaoId).catch(() => {});
  }

  /** Há assistente ou modal de conexão aberto? (a Central não deixa trocar de aba no meio de uma operação) */
  const temModalAberto = () => !!K.wiz || !!K.modal;
  return { temModalAberto, pintar, carregar, sairDaAba, aoClicar, aoMudar, aoTecla, destruir, abrirAssistente, _estado: K };
}
