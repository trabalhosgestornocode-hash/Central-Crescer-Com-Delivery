// Comportamento (DOM) da composição dos números: popover do ícone (i) e painel lateral de detalhamento.
// Acessível por TECLADO (Enter/Espaço/Tab/Esc) e TOQUE (clique), não só por hover. O painel é um overlay: abrir/fechar não navega nem
// recarrega a página, então o mês, os filtros e a posição da tela do usuário permanecem como estavam.
import { htmlPopover, htmlPainel, htmlConciliacao, esc as escHtml } from "./detalheHtml.js";
import { explicacaoDe } from "./explicacoes.js";

let pop = null, popAlvo = null, popFixo = false;

function garantirPop() {
  if (pop?.isConnected) return pop;
  pop = Object.assign(document.createElement("div"), { className: "fin-popover", role: "dialog", hidden: true });
  pop.setAttribute("aria-label", "Explicação do indicador");
  pop.tabIndex = -1;
  document.body.appendChild(pop);
  return pop;
}
function posicionar(botao) {
  const r = botao.getBoundingClientRect(), p = pop, m = 8;
  p.style.maxWidth = `${Math.min(360, window.innerWidth - 2 * m)}px`;
  p.style.maxHeight = ""; p.style.overflowY = "";
  const alt = p.offsetHeight;
  const abaixo = window.innerHeight - r.bottom - m - 4, acima = r.top - m - 4;
  // nunca cobre o próprio ícone: abaixo se couber; senão acima; senão o lado com mais espaço, com rolagem interna
  let lado = alt <= abaixo ? "abaixo" : alt <= acima ? "acima" : abaixo >= acima ? "abaixo" : "acima";
  if (alt > (lado === "abaixo" ? abaixo : acima)) { p.style.maxHeight = `${Math.max(120, lado === "abaixo" ? abaixo : acima)}px`; p.style.overflowY = "auto"; }
  const h = Math.min(alt, parseInt(p.style.maxHeight || alt, 10));
  const top = lado === "abaixo" ? r.bottom + 4 : r.top - h - 4;
  const left = Math.max(m, Math.min(window.innerWidth - p.offsetWidth - m, r.left + r.width / 2 - p.offsetWidth / 2));
  p.style.left = `${left + window.scrollX}px`;
  p.style.top = `${Math.max(m, top) + window.scrollY}px`;
}
export function fecharPopover({ devolverFoco = false } = {}) {
  if (!pop || pop.hidden) return;
  pop.hidden = true; popFixo = false;
  if (popAlvo) { popAlvo.setAttribute("aria-expanded", "false"); if (devolverFoco) popAlvo.focus(); }
  popAlvo = null;
}
function abrirPopover(botao, html, fixo) {
  const p = garantirPop();
  if (popAlvo && popAlvo !== botao) popAlvo.setAttribute("aria-expanded", "false");
  p.innerHTML = html; p.hidden = false; popAlvo = botao; popFixo = fixo;
  botao.setAttribute("aria-expanded", "true");
  posicionar(botao);
}

/** Painel lateral. `comp` = composição do indicador; `extra` = HTML adicional (ex.: conciliação da categoria). */
export function abrirPainel(comp, { mes, titulo, extra = "", corpoLivre = null, aoFechar, largo = false, aoEscape } = {}) {
  fecharPopover();
  const anterior = document.activeElement;
  const nome = titulo ?? comp.rotulo ?? explicacaoDe(comp.id)?.nome ?? comp.id;
  const fundo = Object.assign(document.createElement("div"), { className: "fin-pn-fundo" });
  fundo.innerHTML = `<aside class="fin-pn${largo ? " fin-pn--largo" : ""}" role="dialog" aria-modal="true" aria-labelledby="fin-pn-titulo" tabindex="-1">
    <header class="fin-pn-cab"><h3 id="fin-pn-titulo">${escHtml(nome)}</h3><button type="button" class="btn btn-ghost btn-sm" data-fin-fechar-painel aria-label="Fechar detalhamento">Fechar ✕</button></header>
    <div class="fin-pn-corpo">${corpoLivre ?? htmlPainel(comp, { mes, extra })}</div></aside>`;
  document.body.appendChild(fundo);
  const painel = fundo.querySelector(".fin-pn");
  const fechar = () => { document.removeEventListener("keydown", tecla, true); fundo.remove(); anterior?.focus?.(); aoFechar?.(); };
  const focaveis = () => [...painel.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
  const tecla = (e) => {
    if (e.key === "Escape") { if (document.querySelector("dialog[open]")) return; e.preventDefault(); e.stopPropagation(); if (aoEscape?.() === true) return; fechar(); return; }   // diálogo aberto por cima: o Esc é dele; aoEscape → true = consumido (ex.: voltar do detalhe para a lista)
    if (e.key !== "Tab") return;
    const f = focaveis(); if (!f.length) return;
    const primeiro = f[0], ultimo = f[f.length - 1];
    if (e.shiftKey && document.activeElement === primeiro) { e.preventDefault(); ultimo.focus(); }
    else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primeiro.focus(); }
  };
  document.addEventListener("keydown", tecla, true);
  fundo.addEventListener("click", (e) => { if (e.target === fundo || e.target.closest("[data-fin-fechar-painel]")) fechar(); });
  ligarArvore(painel);
  painel.querySelector("[data-fin-fechar-painel]").focus();
  return { fechar };
}

/** Painel lateral com HTML livre (pendências, conciliação…): mesma acessibilidade do painel de composição. */
export function abrirPainelHtml({ titulo, html, aoFechar, largo = false, aoEscape }) {
  return abrirPainel({ id: "__livre__", componentes: [], situacao: "confirmado" }, { titulo, corpoLivre: html, aoFechar, largo, aoEscape });
}

/** Expandir/recolher níveis da árvore (botão ▸), com aria-expanded; delegado, funciona em qualquer container. */
export function ligarArvore(raiz) {
  raiz.addEventListener("click", (e) => {
    const b = e.target.closest("[data-fin-toggle]");
    if (!b || !raiz.contains(b)) return;
    const li = b.closest(".fin-arv-no"), sub = li.querySelector(":scope > .fin-arv-corpo > .fin-arv-sub");
    if (!sub) return;
    const abrir = sub.hidden;
    sub.hidden = !abrir;
    b.setAttribute("aria-expanded", String(abrir)); li.setAttribute("aria-expanded", String(abrir));
    b.firstElementChild.textContent = abrir ? "▾" : "▸";
    b.setAttribute("aria-label", `${abrir ? "Recolher" : "Expandir"} ${li.querySelector(".fin-arv-nome span")?.textContent ?? ""}`);
  });
}

/**
 * Liga o comportamento numa página. `obter()` devolve o estado atual: { composicao:{[id]:comp}, mes, extraPainel?(comp) }.
 * Elementos reconhecidos: [data-fin-info=id] (ícone), [data-fin-glossario=chave] (ícone só com glossário), [data-fin-valor=id] (valor clicável).
 */
export function ativarComposicao(raiz, obter) {
  garantirPop();
  const comp = (id) => obter()?.composicao?.[id] ?? null;
  const mostrar = (botao, fixo) => {
    const id = botao.dataset.finInfo ?? botao.dataset.finGlossario;
    const c = botao.dataset.finInfo ? comp(id) : null;
    abrirPopover(botao, htmlPopover(id, c ?? undefined), fixo);
  };
  raiz.addEventListener("click", (e) => {
    const cn = e.target.closest("[data-fin-conciliacao]");
    if (cn && raiz.contains(cn)) { const c = obter()?.conciliacao; if (c) abrirPainelHtml({ titulo: `Livro-caixa × DRE gerencial — ${c.categoria}`, html: htmlConciliacao(c) }); return; }
    const v = e.target.closest("[data-fin-valor]");
    if (v && raiz.contains(v)) { const c = comp(v.dataset.finValor); if (c) { const o = obter(); abrirPainel(c, { mes: o.mes, extra: o.extraPainel?.(c) ?? "" }); } return; }
    const b = e.target.closest("[data-fin-info], [data-fin-glossario]");
    if (!b || !raiz.contains(b)) return;
    e.preventDefault();
    if (popAlvo === b && !pop.hidden && popFixo) fecharPopover(); else mostrar(b, true);   // 1º clique FIXA o que o hover abriu; 2º clique fecha
  });
  // hover (apenas ponteiros com hover): pré-visualização; o clique fixa. Foco por teclado abre só com Enter/Espaço (clique).
  raiz.addEventListener("mouseover", (e) => { if (!window.matchMedia?.("(hover: hover)").matches) return; const b = e.target.closest("[data-fin-info], [data-fin-glossario]"); if (b && raiz.contains(b) && !popFixo) mostrar(b, false); });
  raiz.addEventListener("mouseout", (e) => { if (popFixo) return; const b = e.target.closest("[data-fin-info], [data-fin-glossario]"); if (b && !pop.contains(e.relatedTarget)) fecharPopover(); });
  pop.addEventListener("mouseleave", () => { if (!popFixo) fecharPopover(); });
  pop.addEventListener("click", (e) => {
    const a = e.target.closest("[data-fin-abrir-painel]"); if (!a) return;
    const c = comp(a.dataset.finAbrirPainel); if (!c) return;
    const o = obter(); abrirPainel(c, { mes: o.mes, extra: o.extraPainel?.(c) ?? "" });
  });
  const fora = (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest("[data-fin-info], [data-fin-glossario]")) fecharPopover(); };
  document.addEventListener("click", fora);
  const esc = (e) => { if (e.key === "Escape" && !pop.hidden) { e.stopPropagation(); fecharPopover({ devolverFoco: true }); } };
  document.addEventListener("keydown", esc);
  ligarArvore(raiz);
  // limpeza quando a página sai do DOM
  const obs = new MutationObserver(() => { if (!raiz.isConnected) { document.removeEventListener("click", fora); document.removeEventListener("keydown", esc); fecharPopover(); obs.disconnect(); } });
  obs.observe(document.body, { childList: true, subtree: true });
}

export { htmlConciliacao };
