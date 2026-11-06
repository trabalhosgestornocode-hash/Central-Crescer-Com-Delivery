// MENU LATERAL RETRÁTIL — regras puras + contrato de integração (cada menu lateral instala o componente) + CSS.
// O comportamento em navegador real (larguras, teclado, persistência) é verificado à parte no Chrome headless
// (ver docs/menu-lateral-retratil.md); aqui ficam as garantias que não dependem de layout.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CHAVE_PREFERENCIA, CLASSE_RECOLHIDO, LARGURA_AUTO_RECOLHER,
  lerPreferencia, salvarPreferencia, deveRecolher, rotuloAlternar, nomeDoItem,
} from "../src/menuLateral.js";

const ler = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

function memoria() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m };
}

describe("preferência", () => {
  let st;
  beforeEach(() => { st = memoria(); });

  test("sem valor salvo → null", () => assert.equal(lerPreferencia(st), null));
  test("salva e lê de volta, na chave global", () => {
    salvarPreferencia("recolhido", st);
    assert.equal(st._m.get(CHAVE_PREFERENCIA), "recolhido");
    assert.equal(lerPreferencia(st), "recolhido");
    salvarPreferencia("expandido", st);
    assert.equal(lerPreferencia(st), "expandido");
  });
  test("valor desconhecido é ignorado", () => {
    st.setItem(CHAVE_PREFERENCIA, "talvez");
    assert.equal(lerPreferencia(st), null);
  });
  test("chave própria não interfere na global", () => {
    salvarPreferencia("recolhido", st, "ccd:menu-lateral:configuracoes");
    assert.equal(lerPreferencia(st), null);
    assert.equal(lerPreferencia(st, "ccd:menu-lateral:configuracoes"), "recolhido");
  });
  test("storage que lança (aba privada/bloqueio) nunca quebra", () => {
    const ruim = { getItem() { throw new Error("bloqueado"); }, setItem() { throw new Error("cheio"); } };
    assert.equal(lerPreferencia(ruim), null);
    assert.doesNotThrow(() => salvarPreferencia("recolhido", ruim));
    assert.equal(lerPreferencia(null), null);
  });
});

describe("decisão recolher/expandir", () => {
  test("preferência explícita vence a largura", () => {
    assert.equal(deveRecolher({ preferencia: "recolhido", largura: 1920 }), true);
    assert.equal(deveRecolher({ preferencia: "expandido", largura: 1000 }), false);
  });
  test("sem preferência: recolhe abaixo de 1280 px, expande a partir dele", () => {
    assert.equal(LARGURA_AUTO_RECOLHER, 1280);
    assert.equal(deveRecolher({ largura: 1024 }), true);
    assert.equal(deveRecolher({ largura: 1279 }), true);
    assert.equal(deveRecolher({ largura: 1280 }), false);
    assert.equal(deveRecolher({ largura: 1920 }), false);
    assert.equal(deveRecolher(), false);
  });
  test("rótulo descreve a AÇÃO disponível", () => {
    assert.equal(rotuloAlternar(false), "Recolher menu lateral");
    assert.equal(rotuloAlternar(true), "Expandir menu lateral");
  });
});

describe("nome do item (dica e leitor de tela usam o mesmo texto)", () => {
  const item = (label, tag) => ({
    textContent: `${label} ${tag ?? ""}`,
    querySelector: (s) => (s.includes(".m-label") ? { textContent: `  ${label}\n ` } : s === ".m-tag" && tag ? { textContent: tag } : null),
  });
  test("usa o rótulo, sem espaços extras", () => assert.equal(nomeDoItem(item("Dashboard iFood")), "Dashboard iFood"));
  test("inclui a etiqueta (ex.: em breve)", () => assert.equal(nomeDoItem(item("Relatórios", "em breve")), "Relatórios (em breve)"));
});

describe("integração: todo menu lateral instala o componente", () => {
  const casos = [
    ["../src/app.js", /instalarMenuRetratil\(\{ shell: el\("#app"\), sidebar: el\("#sidebar"\), menu: el\("#menu"\)[\s\S]*?desktopMin: 901 \}\)/],
    ["../src/admin.js", /instalarMenuRetratil\(\{ shell: el\("#admin"\), sidebar: el\("#adm-sidebar"\), menu: el\("#adm-menu"\)[\s\S]*?desktopMin: 981 \}\)/],
    ["../src/painelAdm.js", /instalarMenuRetratil\(\{ shell: el\("#painel-adm-screen"\), sidebar: el\("#painel-adm-screen \.padm-sidebar"\), menu: el\("#padm-menu"\), desktopMin: 981 \}\)/],
    ["../src/configuracoes.js", /instalarMenuRetratil\(\{ shell: raiz, sidebar: nav[\s\S]*chave: "ccd:menu-lateral:configuracoes"[\s\S]*teclas: false \}\)/],
  ];
  for (const [arq, re] of casos) {
    test(arq, () => {
      const src = ler(arq);
      assert.match(src, /import \{ instalarMenuRetratil \} from "\.\/menuLateral\.js";/);
      assert.match(src, re);
    });
  }
  test("o index.html ainda tem as três sidebars e os ids que o componente usa", () => {
    const html = ler("../index.html");
    for (const id of ['id="sidebar"', 'id="menu"', 'id="adm-sidebar"', 'id="adm-menu"', 'class="padm-sidebar"', 'id="padm-menu"', 'id="painel-adm-screen"']) {
      assert.ok(html.includes(id), id);
    }
  });
  test("a gaveta móvel continua intacta (botão ☰ + backdrop)", () => {
    assert.match(ler("../src/app.js"), /el\("#btn-menu"\)\.addEventListener\("click", \(\) => el\("#app"\)\.classList\.toggle\("menu-aberto"\)\)/);
    assert.match(ler("../src/admin.js"), /el\("#adm-btn-menu"\)\?\.addEventListener/);
    assert.match(ler("../src/painelAdm.js"), /el\("#padm-btn-menu"\)\?\.addEventListener/);
  });
});

describe("CSS", () => {
  const css = ler("../src/styles.css");
  const cfg = ler("../src/configuracoes.css");
  test("recolhido só vale acima dos breakpoints de gaveta", () => {
    assert.equal(CLASSE_RECOLHIDO, "menu-recolhido");
    assert.match(css, /@media \(min-width: 901px\) \{\s*\.app\.menu-recolhido \{ --sidebar-w: var\(--sidebar-w-recolhido\); \}/);
    assert.match(css, /@media \(min-width: 981px\) \{\s*\.adm\.menu-recolhido, \.padm\.menu-recolhido \{ --sidebar-w: var\(--sidebar-w-recolhido\); \}/);
    assert.match(css, /--sidebar-w-recolhido: 68px;/);
    assert.match(cfg, /@media \(min-width: 900px\) \{\s*\.cfg2\.menu-recolhido \{ grid-template-columns: 64px minmax\(0, 1fr\); \}/);
  });
  test("textos ficam visualmente ocultos, nunca display:none (acessibilidade)", () => {
    const bloco = css.slice(css.indexOf("MENU LATERAL RETRÁTIL"));
    assert.doesNotMatch(bloco, /\.m-label[^{]*\{[^}]*display:\s*none/);
    assert.match(bloco, /\.app\.menu-recolhido \.menu li \.m-label[\s\S]*?clip-path: inset\(50%\)/);
  });
  test("movimento só com prefers-reduced-motion: no-preference", () => {
    const bloco = css.slice(css.indexOf("MENU LATERAL RETRÁTIL"));
    assert.match(bloco, /@media \(prefers-reduced-motion: no-preference\) \{\s*\.sidebar \{ transition: width/);
    assert.doesNotMatch(bloco.replace(/@media \(prefers-reduced-motion: no-preference\) \{[^}]*\}[^}]*\}[^}]*\}/, ""), /transition: (width|grid-template-columns)/);
  });
  test("na gaveta o botão de recolher some", () => {
    assert.match(css, /@media \(max-width: 900px\) \{ \.sidebar \.ml-alternar \{ display: none; \} \}/);
    assert.match(css, /@media \(max-width: 980px\) \{ \.adm-sidebar \.ml-alternar, \.padm-sidebar \.ml-alternar \{ display: none; \} \}/);
  });
});
