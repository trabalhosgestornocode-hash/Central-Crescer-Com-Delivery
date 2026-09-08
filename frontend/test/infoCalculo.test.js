// Transparência de cálculo: helper infoCalculoTip + comportamento do tooltip
// central (tooltip.js) — abertura/fechamento por hover, foco e toque.
// Nenhum destes testes recalcula nada de domínio.
//
// Rodar: node --test frontend/test/infoCalculo.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { infoCalculoTip, moedaLonga, pctLongo, numLongo, NOTA_PRECISAO_SIMULADOR } from "../src/infoCalculo.js";

test("infoCalculoTip: ícone .vd-tip com data-tip-html e aria-label lineares", () => {
  const html = infoCalculoTip({
    linhas: [["Preço iFood", "R$ 35,00"], ["Preço Balcão", "R$ 24,00"], ["Diferença", "R$ 11,00"]],
    formula: "(Preço iFood − Preço Balcão) ÷ Preço iFood × 100",
    calculo: "(35,00 − 24,00) ÷ 35,00 × 100 = 31,428571",
    resultado: "31,43%",
    observacao: "Proteção da Precificação não é meta nem limite logístico.",
  });
  assert.match(html, /class="vd-tip vd-tip-calc"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /role="button"/);
  assert.match(html, /aria-label="[^"]*Preço iFood: R\$ 35,00[^"]*Valor exibido: 31,43%/);
  assert.match(html, /data-tip-html="/);
  // conteúdo estruturado dentro do atributo (escapado 1x)
  assert.match(html, /&lt;div class=&quot;vd-tipc&quot;&gt;/);
  assert.match(html, /Como este valor foi calculado/);
  assert.match(html, /31,428571/);
});

test("infoCalculoTip: escapa conteúdo hostil, nunca injeta HTML cru", () => {
  const html = infoCalculoTip({ linhas: [["<img src=x onerror=alert(1)>", "\"'&<>"]], resultado: "R$ 1,00" });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("formatos longos: 4–6 casas para explicar o arredondamento", () => {
  assert.equal(moedaLonga(47.33265555), "R$ 47,332656");
  assert.equal(numLongo(32.45667809), "32,456678");
  assert.equal(pctLongo(31.42857142), "31,428571%");
  for (const f of [moedaLonga, numLongo, pctLongo]) assert.equal(f(null), f(NaN));
});

test("nota de precisão padrão", () => {
  assert.match(NOTA_PRECISAO_SIMULADOR, /valores não arredondados.*2 casas decimais/);
});

// --- comportamento do tooltip central -----------------------------------
function ambienteDom() {
  const listeners = {};
  const mk = (tag = "div") => {
    const el = {
      tag, className: "", _attrs: {}, _classes: new Set(), hidden: true, style: { setProperty() {} },
      dataset: {}, textContent: "", innerHTML: "", children: [],
      setAttribute(k, v) { this._attrs[k] = String(v); }, getAttribute(k) { return this._attrs[k] ?? null; },
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      getBoundingClientRect: () => ({ top: 100, bottom: 116, left: 100, right: 300, width: 200, height: 16 }),
      contains(n) { return n === this || this.children.includes(n); },
      closest() { return this._classes.has("vd-tip") ? this : null; },
    };
    el.classList = { add: (c) => el._classes.add(c), remove: (c) => el._classes.delete(c), contains: (c) => el._classes.has(c) };
    return el;
  };
  const body = mk("body");
  globalThis.document = {
    createElement: mk, body,
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
  };
  globalThis.window = { innerWidth: 1200, innerHeight: 800, addEventListener() {} };
  const fireLater = globalThis.setInterval; globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
  const icone = mk("span");
  icone._classes.add("vd-tip"); icone._classes.add("vd-tip-calc");
  icone._attrs["data-tip-html"] = "<div class='vd-tipc'>conteúdo rico</div>";
  icone.closest = (sel) => (/vd-tip/.test(sel) ? icone : null);
  return {
    listeners, body, icone,
    fire: (t, target) => (listeners[t] || []).forEach((fn) => fn({ target, relatedTarget: null, key: undefined })),
    fireKey: (key, target) => (listeners.keydown || []).forEach((fn) => fn({ target, key, preventDefault() {} })),
    restore: () => { globalThis.setInterval = fireLater; delete globalThis.document; delete globalThis.window; },
  };
}

test("tooltip central: hover/foco/toque abrem; sair, clicar fora e Esc fecham; usa innerHTML no modo rico", async () => {
  const env = ambienteDom();
  const { initTooltips } = await import("../src/tooltip.js");
  try {
    initTooltips();
    const tip = () => globalThis.document.body.children[0];

    env.fire("mouseover", env.icone);
    assert.ok(tip(), "balão criado");
    assert.equal(tip().hidden, false, "abre no hover");
    assert.equal(tip().innerHTML, "<div class='vd-tipc'>conteúdo rico</div>", "modo rico usa innerHTML");
    assert.equal(tip().classList.contains("vd-tip-flutuante--rico"), true);
    assert.equal(tip()._attrs.role, "tooltip");

    env.fire("mouseout", env.icone);
    assert.equal(tip().hidden, true, "fecha ao sair");

    env.fire("focusin", env.icone);
    assert.equal(tip().hidden, false, "abre por foco (teclado / toque)");
    env.fireKey("Escape", env.icone);
    assert.equal(tip().hidden, true, "Esc fecha");

    env.fire("click", env.icone);
    assert.equal(tip().hidden, false, "toque no ícone abre");
    env.fire("click", env.body); // clique fora
    assert.equal(tip().hidden, true, "toque fora fecha");
  } finally {
    env.restore();
  }
});
