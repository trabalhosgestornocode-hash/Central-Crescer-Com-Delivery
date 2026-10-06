// DOM MÍNIMO para testes de telas montadas por innerHTML (sem jsdom).
// Faz o suficiente para dirigir um formulário de verdade: parse de HTML com
// hierarquia, querySelector/All com seletores compostos simples (tag, #id,
// .classe, [atributo], [atributo="valor"], :checked) e descendente (espaço),
// listeners/dispatch, value/checked/disabled/hidden, dataset, focus.
// Não é um navegador: CSS/layout não existem aqui.
const VAZIOS = new Set(["input", "br", "img", "hr", "meta", "link", "source", "wbr"]);

function atributos(texto) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(texto))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return attrs;
}

const desescapar = (s) => s.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export class Elemento {
  constructor(tag = "div", attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.filhos = [];
    this.pai = null;
    this._ouvintes = {};
    this._html = "";
    this._texto = "";
    this.value = attrs.value != null ? desescapar(attrs.value) : "";
    this.checked = "checked" in attrs;
    this.disabled = "disabled" in attrs;
    this.hidden = "hidden" in attrs;
    this.style = {};
    const self = this;
    this.classList = {
      add: (...c) => { const s = new Set(self.classes()); c.forEach((x) => s.add(x)); self.attrs.class = [...s].join(" "); },
      remove: (...c) => { self.attrs.class = self.classes().filter((x) => !c.includes(x)).join(" "); },
      toggle: (c, on) => { const tem = self.classes().includes(c); const quer = on ?? !tem; if (quer) self.classList.add(c); else self.classList.remove(c); return quer; },
      contains: (c) => self.classes().includes(c),
    };
  }
  classes() { return (this.attrs.class ?? "").split(/\s+/).filter(Boolean); }
  get id() { return this.attrs.id ?? ""; }
  get className() { return this.attrs.class ?? ""; }
  set className(v) { this.attrs.class = v; }
  get dataset() {
    const ds = {};
    for (const [k, v] of Object.entries(this.attrs)) if (k.startsWith("data-")) ds[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    return ds;
  }
  getAttribute(n) { return this.attrs[n.toLowerCase()] ?? null; }
  setAttribute(n, v) { this.attrs[n.toLowerCase()] = String(v); }
  get textContent() { return this._texto + this.filhos.map((f) => f.textContent).join(""); }
  set textContent(v) { this.filhos = []; this._texto = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(html) {
    this._html = String(html);
    this.filhos = [];
    this._texto = "";
    const pilha = [this];
    const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[^>]*?)?)(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(this._html))) {
      const topo = pilha[pilha.length - 1];
      if (m[1]) {
        const tag = m[1].toUpperCase();
        for (let i = pilha.length - 1; i > 0; i--) {
          if (pilha[i].tagName === tag) {
            // Trecho interno original do elemento (o que innerHTML devolve).
            pilha[i]._html = this._html.slice(pilha[i]._inicio, m.index);
            pilha.length = i;
            break;
          }
        }
      } else if (m[2]) {
        const tag = m[2].toLowerCase();
        const el = new Elemento(tag, atributos(m[3] ?? ""));
        el.pai = topo;
        el._inicio = re.lastIndex;
        topo.filhos.push(el);
        if (!VAZIOS.has(tag) && !m[4]) pilha.push(el);
      } else if (m[5] != null) {
        topo._texto += desescapar(m[5]);
        if (topo.tagName === "TEXTAREA") topo.value = topo._texto;
      }
    }
    for (const s of this.querySelectorAll("select")) {
      const op = s.filhos.find((o) => "selected" in o.attrs) ?? s.filhos[0];
      s.value = op ? (op.attrs.value ?? op.textContent) : "";
    }
  }
  appendChild(el) { el.pai = this; this.filhos.push(el); return el; }
  remove() { if (this.pai) this.pai.filhos = this.pai.filhos.filter((f) => f !== this); this.pai = null; }
  descendentes() { const out = []; const walk = (e) => { for (const f of e.filhos) { out.push(f); walk(f); } }; walk(this); return out; }
  querySelectorAll(sel) {
    const grupos = sel.split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.split(/\s+/).map(compilar));
    return this.descendentes().filter((e) => grupos.some((partes) => casaCadeia(e, partes, this)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  closest(sel) { const c = compilar(sel); let e = this; while (e && e.tagName) { if (c(e)) return e; e = e.pai; } return null; }
  addEventListener(tipo, fn) { (this._ouvintes[tipo] ??= []).push(fn); }
  removeEventListener(tipo, fn) { this._ouvintes[tipo] = (this._ouvintes[tipo] ?? []).filter((f) => f !== fn); }
  dispatch(tipo, extra = {}) {
    const ev = { type: tipo, target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
    for (const fn of [...(this._ouvintes[tipo] ?? [])]) fn(ev);
    return ev;
  }
  click() { if (this.disabled) return; if (this.attrs.type === "radio") { this.marcar(); return; } if (this.attrs.type === "checkbox") { this.checked = !this.checked; this.dispatch("change"); } this.dispatch("click"); }
  marcar() {
    const raiz = raizDe(this);
    for (const r of raiz.querySelectorAll(`input[name="${this.attrs.name}"]`)) r.checked = r === this;
    this.dispatch("change");
  }
  digitar(texto) { this.value = texto; this.dispatch("input"); this.dispatch("blur"); this.dispatch("change"); }
  focus() { globalThis.document && (globalThis.document.activeElement = this); }
  setSelectionRange() {}
}

function raizDe(e) { while (e.pai) e = e.pai; return e; }

function compilar(simples) {
  const testes = [];
  let resto = simples;
  const tag = /^[a-zA-Z][a-zA-Z0-9]*/.exec(resto);
  if (tag) { const t = tag[0].toUpperCase(); testes.push((e) => e.tagName === t); resto = resto.slice(tag[0].length); }
  const re = /#([-\w]+)|\.([-\w]+)|\[([-\w:]+)(?:="([^"]*)")?\]|:checked|:not\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(resto))) {
    if (m[1]) { const id = m[1]; testes.push((e) => e.attrs.id === id); }
    else if (m[2]) { const c = m[2]; testes.push((e) => e.classes().includes(c)); }
    else if (m[3]) { const a = m[3].toLowerCase(); const v = m[4]; testes.push((e) => (a === "disabled" ? e.disabled : a in e.attrs) && (v == null || e.attrs[a] === v)); }
    else if (m[0] === ":checked") testes.push((e) => e.checked);
    else if (m[5]) { const neg = compilar(m[5]); testes.push((e) => !neg(e)); }
  }
  return (e) => testes.every((t) => t(e));
}

function casaCadeia(e, partes, raiz) {
  if (!partes[partes.length - 1](e)) return false;
  let i = partes.length - 2;
  let anc = e.pai;
  while (i >= 0 && anc && anc !== raiz.pai) {
    if (partes[i](anc)) i--;
    anc = anc.pai;
  }
  return i < 0;
}

/** Instala `document`/`window`/storages globais mínimos. Devolve o `document`. */
export function instalarDomMinimo() {
  const body = new Elemento("body");
  const ouvintes = {};
  const doc = {
    body,
    activeElement: null,
    documentElement: new Elemento("html"),
    createElement: (tag) => new Elemento(tag),
    querySelector: (s) => body.querySelector(s),
    querySelectorAll: (s) => body.querySelectorAll(s),
    getElementById: (id) => body.querySelector(`#${id}`),
    addEventListener: (t, fn) => { (ouvintes[t] ??= []).push(fn); },
    removeEventListener: (t, fn) => { ouvintes[t] = (ouvintes[t] ?? []).filter((f) => f !== fn); },
    dispatchEvent: (ev) => { for (const fn of ouvintes[ev.type] ?? []) fn(ev); return true; },
    teclar: (key) => { for (const fn of [...(ouvintes.keydown ?? [])]) fn({ key, preventDefault() {} }); },
  };
  globalThis.document = doc;
  globalThis.window ??= globalThis;
  globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.sessionStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.CustomEvent ??= class { constructor(type, o = {}) { this.type = type; this.detail = o.detail; } };
  globalThis.requestAnimationFrame ??= (fn) => fn();
  globalThis.window.supabase ??= { createClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }) };
  return doc;
}
