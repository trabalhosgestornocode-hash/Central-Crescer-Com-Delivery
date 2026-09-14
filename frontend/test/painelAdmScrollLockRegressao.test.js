// Regressão do bug de scroll travado: painel deslizante de cards (mobile) da
// Visão Geral do Painel Administrativo (ver `ligarCardsResumo` em
// painelAdmViews.js e o módulo scrollLock.js).
//
// Bug original: `travar(true)` (body.classList.add) só era desfeito por
// `fecharTodos()` — clicar no botão "fechar" ou fora do painel. Um clique num
// item DE DENTRO do próprio painel (ex.: "ir para a empresa") navega pra
// outra tela sem passar por `fecharTodos()`, deixando o body com
// `overflow: hidden` preso até o usuário dar F5 (que reinicia o estado do
// módulo). Corrigido centralizando a trava em scrollLock.js e zerando-a a
// cada `renderViewPadm` (toda troca de tela do painel passa por ali).
//
// Usa o mesmo estilo de fake DOM (regex sobre a innerHTML real) do resto da
// suíte do Painel Administrativo — ver frontend/test/painelAdmViews.test.js.
//
// Rodar: node --test frontend/test/painelAdmScrollLockRegressao.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetScrollLock } from "../src/scrollLock.js";

// ---- fake DOM ----
function attr(tag, nome) {
  const m = new RegExp(`${nome}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}
function boolAttr(tag, nome) {
  return new RegExp(`[\\s<]${nome}(?=[\\s>/]|$)`).test(tag);
}
function fakeNode(tag) {
  const classes = new Set((attr(tag, "class") ?? "").split(/\s+/).filter(Boolean));
  const node = {
    _tag: tag,
    id: attr(tag, "id") ?? "",
    dataset: {
      padmNav: attr(tag, "data-padm-nav") ?? undefined,
      padmCard: attr(tag, "data-padm-card") ?? undefined,
      padmCardPainel: attr(tag, "data-padm-card-painel") ?? undefined,
      id: attr(tag, "data-id") ?? undefined,
      nome: attr(tag, "data-nome") ?? undefined,
    },
    hidden: boolAttr(tag, "hidden"),
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    setAttribute() {},
    scrollIntoView() {},
    _l: {},
    addEventListener(ev, fn) { (node._l[ev] ||= []).push(fn); },
    dispatch(ev, arg) { (node._l[ev] ?? []).forEach((f) => f(arg ?? { target: node })); },
  };
  return node;
}
let padmView;
function makeView() {
  const store = { nav: [], card: [], cardPainel: [], cardFechar: [], caixa: null };
  return {
    _html: "",
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      store.nav = []; store.card = []; store.cardPainel = []; store.cardFechar = []; store.caixa = null;
      const tags = this._html.match(/<[a-zA-Z][^>]*>/g) ?? [];
      for (const t of tags) {
        const n = fakeNode(t);
        if (n.dataset.padmNav) store.nav.push(n);
        if (n.dataset.padmCard) store.card.push(n);
        if (n.dataset.padmCardPainel) store.cardPainel.push(n);
        if (boolAttr(t, "data-padm-card-fechar")) store.cardFechar.push(n);
        if (!store.caixa && /class="padm-cards-detalhes"/.test(t)) store.caixa = n;
      }
    },
    _store: store,
  };
}

let bodyClasses;
globalThis.document = {
  get body() {
    return { classList: { toggle: (c, on) => (on ? bodyClasses.add(c) : bodyClasses.delete(c)) } };
  },
  querySelector(sel) {
    if (sel === "#padm-view") return padmView;
    if (sel === ".padm-cards-detalhes") return padmView._store.caixa;
    const m = /^#padm-card-detalhe-(.+)$/.exec(sel);
    if (m) return padmView._store.cardPainel.find((n) => n.id === `padm-card-detalhe-${m[1]}`) ?? null;
    return null;
  },
  querySelectorAll(sel) {
    if (sel === "[data-padm-nav]") return padmView._store.nav;
    if (sel === "[data-padm-card]") return padmView._store.card;
    if (sel === "[data-padm-card-painel]") return padmView._store.cardPainel;
    if (sel === "[data-padm-card-fechar]") return padmView._store.cardFechar;
    return [];
  },
};
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const V = await import("../src/painelAdmViews.js");

const RESUMO_COM_PENDENCIA = {
  dataReferencia: "2026-09-15", d1: "2026-09-14",
  resumo: {
    unidadesMonitoradas: 6, empresasMonitoradas: 3, concluidasD1: 4, emPreenchimentoD1: 1,
    naoRealizadasD1: 1, sequenciaBloqueadaD1: 0, criticas: 1, atencao: 1, emDia: 4,
    conformidadeD1: 0.6667, conformidadeMes: 0.94, mesCompleto: 79, mesEsperado: 84,
  },
  acaoNecessariaHoje: [],
  empresas: [{ organizacaoId: "o1", empresaNome: "Alfa", criticas: 1, atencao: 0, unidadesMonitoradas: 3 }],
};

async function render() {
  await V.renderViewPadm(
    { tipo: "tela", id: "visao-geral" },
    { api: { visaoGeral: async () => RESUMO_COM_PENDENCIA } },
  );
}
const abrirCard = (id) => padmView._store.card.find((c) => c.dataset.padmCard === id)?.dispatch("click");

beforeEach(() => {
  padmView = makeView();
  bodyClasses = new Set();
  resetScrollLock();
  V.ligarNavegacao({ abrirEmpresa: () => {}, abrirUnidade: () => {}, voltar: () => {} });
});

describe("Painel deslizante de cards (mobile) — trava/destrava o scroll do body", () => {
  test("abrir o detalhe de um card trava o scroll do body", async () => {
    await render();
    abrirCard("empresas-pendencia");
    assert.equal(bodyClasses.has("scroll-travado"), true);
  });

  test("fechar pelo botão dedicado destrava o scroll", async () => {
    await render();
    abrirCard("empresas-pendencia");
    padmView._store.cardFechar[0].dispatch("click");
    assert.equal(bodyClasses.has("scroll-travado"), false);
  });

  test("fechar clicando fora (backdrop) destrava o scroll", async () => {
    await render();
    abrirCard("empresas-pendencia");
    padmView._store.caixa.dispatch("click", { target: padmView._store.caixa });
    assert.equal(bodyClasses.has("scroll-travado"), false);
  });

  test("trocar de card (fechar o anterior, abrir outro) nunca deixa a trava dobrada", async () => {
    await render();
    abrirCard("empresas-pendencia");
    abrirCard("unidades-pendencia"); // fecha o anterior e abre este, sem passar por fechar()
    assert.equal(bodyClasses.has("scroll-travado"), true, "ainda tem um painel aberto");
    padmView._store.cardFechar.find((b) => !b.hidden || true)?.dispatch("click"); // fecha o que estiver aberto
    assert.equal(bodyClasses.has("scroll-travado"), false, "os dois fecharam — scroll livre");
  });

  test("BUG CORRIGIDO: navegar por um link de dentro do painel, sem fechar, não deixa o scroll preso", async () => {
    let empresaAberta = null;
    V.ligarNavegacao({ abrirEmpresa: (id) => { empresaAberta = id; } });

    await render();
    abrirCard("empresas-pendencia");
    assert.equal(bodyClasses.has("scroll-travado"), true, "sheet aberto trava o scroll");

    // O gestor clica num item de DENTRO do próprio painel pra ir direto pra
    // empresa — não passa pelo botão "fechar" nem pelo clique fora do sheet.
    const linkEmpresa = padmView._store.nav.find((n) => n.dataset.padmNav === "empresa");
    assert.ok(linkEmpresa, "a lista de empresas do sheet deve ter um item navegável");
    linkEmpresa.dispatch("click");
    assert.equal(empresaAberta, "o1");
    assert.equal(bodyClasses.has("scroll-travado"), true, "ninguém chamou fecharTodos() — ainda travado aqui");

    // Antes da correção, era exatamente este ponto que ficava travado até o
    // F5: a navegação real (painelAdm.js#abrirDetalheEmpresa) chama de volta
    // renderViewPadm pra desenhar a tela nova.
    await render();
    assert.equal(bodyClasses.has("scroll-travado"), false, "renderViewPadm zera a trava — scroll livre sem precisar de F5");
  });
});
