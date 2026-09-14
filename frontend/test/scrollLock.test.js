// Trava de scroll do body — scrollLock.js.
//
// Cobre o bug corrigido: uma tela que trava o scroll e é substituída sem
// passar pelo seu próprio "fechar" (ex.: navegação para outra tela por um
// link de dentro do próprio painel) não pode deixar o body preso em
// `overflow: hidden` até o F5 — ver o comentário no topo de scrollLock.js.
//
// Rodar: node --test frontend/test/scrollLock.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---- fake DOM: só o suficiente pra observar a classe do body ----
function fakeClassList(set) {
  return {
    toggle(nome, on) { on ? set.add(nome) : set.delete(nome); },
    contains(nome) { return set.has(nome); },
  };
}
let bodyClasses;
globalThis.document = {
  get body() { return { classList: fakeClassList(bodyClasses) }; },
};

const { travarScroll, destravarScroll, resetScrollLock, _travasAtivas } =
  await import("../src/scrollLock.js");

beforeEach(() => {
  bodyClasses = new Set();
  resetScrollLock(); // garante contador zerado entre casos (módulo é singleton)
  bodyClasses = new Set(); // resetScrollLock acima já mexeu na classList antiga
});

describe("scrollLock — travar/destravar simples", () => {
  test("travar aplica a classe; destravar remove", () => {
    travarScroll();
    assert.equal(bodyClasses.has("scroll-travado"), true);
    destravarScroll();
    assert.equal(bodyClasses.has("scroll-travado"), false);
  });

  test("destravar sem travar correspondente é no-op seguro (nunca fica negativo)", () => {
    destravarScroll();
    destravarScroll();
    assert.equal(_travasAtivas(), 0);
    assert.equal(bodyClasses.has("scroll-travado"), false);
    // uma trava real ainda funciona normalmente depois
    travarScroll();
    assert.equal(bodyClasses.has("scroll-travado"), true);
  });
});

describe("scrollLock — travas concorrentes (dois overlays abertos)", () => {
  test("dois travarScroll(); só destrava depois dos dois destravarScroll()", () => {
    travarScroll(); // overlay A abre
    travarScroll(); // overlay B abre (aninhado/concorrente)
    assert.equal(bodyClasses.has("scroll-travado"), true);

    destravarScroll(); // overlay B fecha
    assert.equal(bodyClasses.has("scroll-travado"), true, "A ainda está aberto — não pode destravar");

    destravarScroll(); // overlay A fecha
    assert.equal(bodyClasses.has("scroll-travado"), false, "os dois fecharam — agora destrava");
  });
});

describe("scrollLock — resetScrollLock (rede de segurança na troca de tela)", () => {
  test("zera mesmo com trava(s) abandonada(s) sem destravar", () => {
    travarScroll();
    travarScroll();
    assert.equal(bodyClasses.has("scroll-travado"), true);

    resetScrollLock(); // ex.: renderViewPadm / renderRotaAtual / sairDoPainelAdministrativo
    assert.equal(_travasAtivas(), 0);
    assert.equal(bodyClasses.has("scroll-travado"), false, "scroll tem que estar livre, sem precisar de F5");
  });

  test("depois de um reset, uma trava nova funciona normalmente", () => {
    travarScroll();
    resetScrollLock();
    travarScroll();
    assert.equal(bodyClasses.has("scroll-travado"), true);
    destravarScroll();
    assert.equal(bodyClasses.has("scroll-travado"), false);
  });
});
