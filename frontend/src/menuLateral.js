// MENU LATERAL RETRÁTIL — componente único para TODOS os menus laterais da plataforma.
//
// Usado pelos três shells (`#app` da empresa, `#admin` SuperAdmin, `#painel-adm-screen` Painel Administrativo)
// e pela navegação de categorias das Configurações. Cada um continua montando o próprio menu do jeito que
// sempre montou; este módulo só:
//   * injeta o botão "Recolher/Expandir menu" (com `aria-expanded`, `aria-controls` e rótulo que diz a AÇÃO);
//   * liga/desliga a classe `menu-recolhido` no contêiner — o CSS (styles.css, "MENU LATERAL RETRÁTIL")
//     encolhe a coluna e a área principal ocupa o espaço liberado (grid/flex, nunca uma faixa vazia);
//   * torna os itens operáveis por teclado (Tab, Enter/Espaço, setas, Home/End) e expõe `aria-current`;
//   * mostra uma dica com o nome completo no hover e no FOCO quando recolhido (o nome continua no item,
//     só visualmente oculto — leitores de tela leem o mesmo texto de sempre).
//
// Preferência: UMA chave em localStorage para os shells (vale ao recarregar e ao trocar de ambiente).
// Sem preferência salva, telas estreitas de desktop/tablet (< 1280 px) começam recolhidas.
// No celular/tablet em retrato (gaveta: ≤ 900/980 px) o CSS ignora o recolhido: a gaveta abre sempre completa,
// sobreposta ao conteúdo — comportamento móvel existente preservado.
// localStorage é só conveniência: falhar (aba privada, bloqueio) nunca quebra o menu.

export const CHAVE_PREFERENCIA = "ccd:menu-lateral";
export const CLASSE_RECOLHIDO = "menu-recolhido";
export const LARGURA_AUTO_RECOLHER = 1280;
const ITENS = "[data-rota], [data-tela], [data-cat]";

/** @returns {"recolhido"|"expandido"|null} */
export function lerPreferencia(storage = armazenamento(), chave = CHAVE_PREFERENCIA) {
  try {
    const v = storage?.getItem(chave);
    return v === "recolhido" || v === "expandido" ? v : null;
  } catch { return null; }
}

export function salvarPreferencia(valor, storage = armazenamento(), chave = CHAVE_PREFERENCIA) {
  try { storage?.setItem(chave, valor); } catch { /* conveniência: segue sem persistir */ }
}

/** Decisão pura: a preferência explícita sempre vence; sem ela, recolhe em telas estreitas. */
export function deveRecolher({ preferencia = null, largura = Infinity } = {}) {
  if (preferencia === "recolhido") return true;
  if (preferencia === "expandido") return false;
  return largura < LARGURA_AUTO_RECOLHER;
}

/** Rótulo do botão: descreve a AÇÃO disponível, não o estado. */
export const rotuloAlternar = (recolhido) => (recolhido ? "Expandir menu lateral" : "Recolher menu lateral");

function armazenamento() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

const SVG_CHEVRON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/></svg>';

const instancias = new Set();
let dica = null;          // um único balão para a página inteira
let dicaDono = null;

function largura() {
  const w = globalThis.innerWidth;
  return Number.isFinite(w) ? w : Infinity;
}

/** Nome visível do item (o mesmo que o leitor de tela lê). */
export function nomeDoItem(item) {
  const rotulo = item.querySelector?.(".m-label, .cfg2-nav-txt b");
  const tag = item.querySelector?.(".m-tag");
  const base = (rotulo?.textContent ?? item.textContent ?? "").replace(/\s+/g, " ").trim();
  const extra = tag?.textContent?.trim();
  return extra ? `${base} (${extra})` : base;
}

/**
 * Deixa os itens do menu operáveis por teclado e com estado anunciado. Idempotente: pode rodar a cada re-render.
 * Itens que já são <button> (Configurações) não recebem role/tabindex — já são nativos.
 */
export function prepararItens(menu) {
  if (!menu?.querySelectorAll) return;
  for (const item of menu.querySelectorAll(ITENS)) {
    const nativo = item.tagName === "BUTTON" || item.tagName === "A";
    if (!nativo) {
      if (!item.hasAttribute("tabindex")) item.setAttribute("tabindex", "0");
      if (!item.hasAttribute("role")) item.setAttribute("role", "link");
    }
    sincronizarAtual(item);
  }
}

function sincronizarAtual(item) {
  const ativo = item.classList?.contains("ativo");
  if (ativo && item.getAttribute("aria-current") !== "page") item.setAttribute("aria-current", "page");
  else if (!ativo && item.getAttribute("aria-current") === "page") item.removeAttribute("aria-current");
}

function teclado(menu, e) {
  const item = e.target.closest?.(ITENS);
  if (!item || !menu.contains(item)) return;
  const nativo = item.tagName === "BUTTON" || item.tagName === "A";
  if ((e.key === "Enter" || e.key === " ") && !nativo) { e.preventDefault(); item.click(); return; }
  if (e.key === "Escape") { esconderDica(); return; }
  const lista = [...menu.querySelectorAll(ITENS)].filter((n) => !n.hidden && n.offsetParent !== null);
  const i = lista.indexOf(item);
  let alvo = null;
  if (e.key === "ArrowDown") alvo = lista[(i + 1) % lista.length];
  else if (e.key === "ArrowUp") alvo = lista[(i - 1 + lista.length) % lista.length];
  else if (e.key === "Home") alvo = lista[0];
  else if (e.key === "End") alvo = lista[lista.length - 1];
  if (alvo) { e.preventDefault(); alvo.focus(); }
}

// ---------- dica (tooltip) ----------
function garantirDica(doc) {
  if (dica && dica.isConnected) return dica;
  dica = doc.createElement("div");
  dica.className = "ml-dica";
  dica.setAttribute("role", "tooltip");
  dica.setAttribute("aria-hidden", "true"); // o nome já é o conteúdo do item: não duplicar a leitura
  dica.hidden = true;
  doc.body.appendChild(dica);
  return dica;
}

function mostrarDica(inst, alvo) {
  if (!inst.recolhido || !inst.desktop()) return;
  const texto = alvo.dataset?.mlDica || nomeDoItem(alvo);
  if (!texto) return;
  const d = garantirDica(alvo.ownerDocument);
  d.textContent = texto;
  d.dataset.tema = inst.tema;
  d.hidden = false;
  const r = alvo.getBoundingClientRect();
  d.style.left = `${Math.round(r.right + 10)}px`;
  d.style.top = `${Math.round(r.top + r.height / 2)}px`;
  dicaDono = alvo;
}

export function esconderDica() {
  if (dica) dica.hidden = true;
  dicaDono = null;
}

// ---------- instalação ----------
/**
 * @param {{ shell: Element, sidebar: Element, menu: Element, ancora?: Element|null, chave?: string,
 *           tema?: string, desktopMin?: number, autoRecolher?: boolean, teclas?: boolean }} opts
 *   - shell: elemento que recebe a classe `menu-recolhido` (o grid/flex que contém sidebar + conteúdo);
 *   - sidebar: onde o botão é inserido; menu: a lista de itens;
 *   - ancora: o botão entra ANTES deste nó (padrão: fim da sidebar);
 *   - desktopMin: largura mínima em que o modo recolhido vale (abaixo é gaveta/lista e o botão some);
 *   - autoRecolher: sem preferência salva, recolhe em telas estreitas; teclas: liga Enter/Espaço/setas nos itens.
 */
export function instalarMenuRetratil({
  shell, sidebar, menu, ancora = null, chave = CHAVE_PREFERENCIA, tema = "escuro", desktopMin = 901, autoRecolher = true, teclas = true,
} = {}) {
  if (!shell || !sidebar || !menu) return null;
  if (shell.__menuRetratil) { prepararItens(menu); return shell.__menuRetratil; }
  const doc = shell.ownerDocument ?? globalThis.document;
  // Contêineres re-renderizados (Configurações recria a navegação a cada categoria) deixam instâncias órfãs.
  for (const i of instancias) if (i.shell.isConnected === false) instancias.delete(i);

  if (!menu.id) menu.id = `ml-menu-${instancias.size + 1}`;
  const botao = doc.createElement("button");
  botao.type = "button";
  botao.className = "ml-alternar";
  botao.setAttribute("aria-controls", menu.id);
  botao.innerHTML = `${SVG_CHEVRON}<span class="ml-alternar-txt">Recolher menu</span>`;
  if (ancora && ancora.parentNode === sidebar) sidebar.insertBefore(botao, ancora);
  else sidebar.appendChild(botao);

  const inst = {
    shell, sidebar, menu, botao, chave, tema, recolhido: false,
    desktop: () => largura() >= desktopMin,
    aplicar(recolher) {
      inst.recolhido = !!recolher;
      shell.classList.toggle(CLASSE_RECOLHIDO, inst.recolhido);
      // aria-expanded descreve o MENU (expandido = true), não o botão.
      botao.setAttribute("aria-expanded", inst.recolhido ? "false" : "true");
      const rot = rotuloAlternar(inst.recolhido);
      botao.setAttribute("aria-label", rot);
      botao.dataset.mlDica = rot;
      const txt = botao.querySelector(".ml-alternar-txt");
      if (txt) txt.textContent = inst.recolhido ? "Expandir menu" : "Recolher menu";
      if (!inst.recolhido && dicaDono && sidebar.contains(dicaDono)) esconderDica();
    },
    sincronizar() {
      const pref = lerPreferencia(armazenamento(), chave);
      inst.aplicar(autoRecolher ? deveRecolher({ preferencia: pref, largura: largura() }) : pref === "recolhido");
    },
  };

  botao.addEventListener("click", () => {
    const novo = !inst.recolhido;
    salvarPreferencia(novo ? "recolhido" : "expandido", armazenamento(), chave);
    for (const i of instancias) if (i.chave === chave) i.aplicar(novo);   // preferência GLOBAL: todos os shells juntos
    avisarRedimensionamento();
  });

  // `teclas: false` quando o dono já trata as setas (Configurações) — evita mover o foco duas vezes.
  menu.addEventListener("keydown", (e) => (teclas ? teclado(menu, e) : e.key === "Escape" && esconderDica()));
  const alvoDica = (e) => e.target.closest?.(`${ITENS}, .ml-alternar`);
  sidebar.addEventListener("mouseover", (e) => { const a = alvoDica(e); if (a && sidebar.contains(a)) mostrarDica(inst, a); });
  sidebar.addEventListener("mouseout", (e) => { if (dicaDono && !dicaDono.contains(e.relatedTarget ?? null)) esconderDica(); });
  sidebar.addEventListener("focusin", (e) => { const a = alvoDica(e); if (a) mostrarDica(inst, a); });
  sidebar.addEventListener("focusout", () => esconderDica());
  menu.addEventListener("scroll", esconderDica, { passive: true });
  botao.addEventListener("keydown", (e) => { if (e.key === "Escape") esconderDica(); });

  // Itens são re-renderizados (troca de setor, módulos, categoria): reprepara e acompanha o `.ativo`.
  if (typeof MutationObserver === "function") {
    new MutationObserver((muts) => {
      let refazer = false;
      for (const m of muts) {
        if (m.type === "childList") refazer = true;
        else if (m.type === "attributes" && m.target.matches?.(ITENS)) sincronizarAtual(m.target);
      }
      if (refazer) prepararItens(menu);
    }).observe(menu, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  }
  prepararItens(menu);

  instancias.add(inst);
  shell.__menuRetratil = inst;
  // Estado inicial SEM animação: abrir a página já recolhida não pode "encolher" o menu diante do usuário.
  shell.classList.add("ml-sem-transicao");
  inst.sincronizar();
  const liberar = () => shell.classList.remove("ml-sem-transicao");
  if (typeof globalThis.requestAnimationFrame === "function") globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(liberar));
  else liberar();
  ligarGlobais();
  return inst;
}

function avisarRedimensionamento() {
  esconderDica();
  // Gráficos (Chart.js usa ResizeObserver) se ajustam sozinhos; o evento cobre componentes que medem no resize.
  const disparar = () => { try { globalThis.dispatchEvent?.(new Event("resize")); } catch { /* sem window */ } };
  globalThis.setTimeout?.(disparar, 260);
}

let globaisLigados = false;
function ligarGlobais() {
  if (globaisLigados || typeof globalThis.addEventListener !== "function") return;
  globaisLigados = true;
  // Outra aba mudou a preferência → acompanha.
  globalThis.addEventListener("storage", (e) => {
    if (![...instancias].some((i) => i.chave === e.key)) return;
    for (const i of instancias) if (i.chave === e.key) i.sincronizar();
  });
  // Sem preferência explícita, o recolhimento automático acompanha a largura (ex.: zoom, janela redimensionada).
  let pendente = null;
  globalThis.addEventListener("resize", () => {
    if (pendente) return;
    pendente = globalThis.setTimeout(() => {
      pendente = null;
      esconderDica();
      for (const i of instancias) if (lerPreferencia(armazenamento(), i.chave) == null) i.sincronizar();
    }, 150);
  });
  globalThis.document?.addEventListener?.("keydown", (e) => { if (e.key === "Escape") esconderDica(); });
}

/** Só para testes: zera o estado do módulo. */
export function _resetarParaTestes() {
  instancias.clear();
  dica = null;
  dicaDono = null;
  globaisLigados = false;
}
