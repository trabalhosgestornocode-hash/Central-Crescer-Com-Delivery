// Tutorial "Como lançar Sanduíches + Saladas" do Dashboard iFood.
// Sem jsdom — DOM mínimo (test/helpers/domMinimo.js).
//
// Rodar: node --test frontend/test/dashboardExecutivoTutorial.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { instalarDomMinimo } from "./helpers/domMinimo.js";

const doc = instalarDomMinimo();
const memoria = new Map();
globalThis.localStorage = {
  getItem: (k) => (memoria.has(k) ? memoria.get(k) : null),
  setItem: (k, v) => memoria.set(k, String(v)),
  removeItem: (k) => memoria.delete(k),
};
const tut = await import("../src/dashboardExecutivoTutorial.js");

const MULTICANAL = { periodo: { mes: 10, ano: 2026 }, composicaoCanais: { estruturaUnidade: "multicanal" } };
const PADRAO = { periodo: { mes: 10, ano: 2026 } };
// Unidade que VOLTOU para o padrão mas tem dias multicanal no mês: campo presente, estrutura padrão.
const PADRAO_COM_HISTORICO = { periodo: { mes: 10, ano: 2026 }, composicaoCanais: { estruturaUnidade: "padrao" } };

function cabecalho() {
  doc.body.filhos = [];
  const c = doc.createElement("div");
  c.setAttribute("class", "dex-head-txt");
  c.insertAdjacentHTML = (_pos, html) => {
    const tmp = doc.createElement("div");
    tmp.innerHTML = html;
    for (const f of tmp.filhos) c.appendChild(f);
  };
  doc.body.appendChild(c);
  return c;
}
const overlay = () => doc.querySelector(".dex-tut-overlay");
const botaoTutorial = () => doc.querySelector("#dex-tutorial-abrir");
const atualizar = (dadosMes, extra = {}) =>
  tut.atualizarTutorialDashboard({ dadosMes, unidadeId: "u1", usuarioId: "usr1", cabecalho: cabecalho(), ...extra });
const fecharSeAberto = () => { if (tut.tutorialAberto()) overlay()?.querySelector("#dex-tut-fechar")?.click(); };

beforeEach(() => { fecharSeAberto(); memoria.clear(); tut._reiniciarTutorialParaTeste(); });

describe("regra de exibição", () => {
  test("unidade padrão: nenhum botão e nenhum modal (markup intocado)", () => {
    const r = atualizar(PADRAO);
    assert.deepEqual(r, { elegivel: false, abriu: false });
    assert.equal(botaoTutorial(), null);
    assert.equal(overlay(), null);
  });

  test("unidade que voltou ao padrão (só histórico multicanal): tutorial não aparece", () => {
    assert.equal(atualizar(PADRAO_COM_HISTORICO).elegivel, false);
    assert.equal(overlay(), null);
  });

  test("visão agregada (todas as unidades): nunca mostra", () => {
    assert.equal(tut.unidadeUsaSanduichesSaladas({ ...MULTICANAL, agregado: true }), false);
  });

  test("Sanduíches + Saladas: 1ª visita abre sozinho e mostra o botão 'Como preencher'", () => {
    const r = atualizar(MULTICANAL);
    assert.deepEqual(r, { elegivel: true, abriu: true });
    assert.ok(overlay());
    assert.match(botaoTutorial().textContent, /Como preencher/);
  });

  test("depois de fechado: não abre de novo sozinho (localStorage por usuário + unidade)", () => {
    atualizar(MULTICANAL);
    overlay().querySelector("#dex-tut-fechar").click();
    assert.equal(memoria.get(tut.chaveTutorial("usr1", "u1")), "1");
    assert.equal(atualizar(MULTICANAL).abriu, false);
    assert.equal(overlay(), null);
  });

  test("outro usuário ou outra unidade: ainda não viu, então abre", () => {
    atualizar(MULTICANAL);
    overlay().querySelector("#dex-tut-fechar").click();
    assert.equal(atualizar(MULTICANAL, { usuarioId: "usr2" }).abriu, true);
    fecharSeAberto();
    assert.equal(atualizar(MULTICANAL, { unidadeId: "u2" }).abriu, true);
  });

  test("não abre por cima de outro modal (ex.: formulário de lançamento aberto)", () => {
    const c = cabecalho();
    const outro = doc.createElement("div");
    outro.setAttribute("class", "modal-overlay");
    doc.body.appendChild(outro);
    const r = tut.atualizarTutorialDashboard({ dadosMes: MULTICANAL, unidadeId: "u1", usuarioId: "usr1", cabecalho: c });
    assert.deepEqual(r, { elegivel: true, abriu: false });
    assert.equal(overlay(), null);
  });

  test("recarregar o mês com o tutorial aberto não abre um segundo", () => {
    atualizar(MULTICANAL);
    const r = tut.atualizarTutorialDashboard({ dadosMes: MULTICANAL, unidadeId: "u1", usuarioId: "usr1", cabecalho: doc.querySelector(".dex-head-txt") });
    assert.equal(r.abriu, false);
    assert.equal(doc.querySelectorAll(".dex-tut-overlay").length, 1);
  });

  test("storage indisponível: não quebra e não reabre na mesma sessão", () => {
    const original = globalThis.localStorage;
    globalThis.localStorage = { getItem() { throw new Error("bloqueado"); }, setItem() { throw new Error("bloqueado"); } };
    try {
      const r1 = tut.atualizarTutorialDashboard({ dadosMes: MULTICANAL, unidadeId: "u9", usuarioId: "usr9", cabecalho: cabecalho() });
      assert.equal(r1.abriu, true);
      overlay().querySelector("#dex-tut-fechar").click();
      const r2 = tut.atualizarTutorialDashboard({ dadosMes: MULTICANAL, unidadeId: "u9", usuarioId: "usr9", cabecalho: cabecalho() });
      assert.equal(r2.abriu, false);
    } finally { globalThis.localStorage = original; }
  });
});

describe("reabrir manualmente", () => {
  test("'Como preencher' reabre o tutorial mesmo depois de visto", () => {
    atualizar(MULTICANAL);
    overlay().querySelector("#dex-tut-fechar").click();
    atualizar(MULTICANAL);
    assert.equal(overlay(), null);
    botaoTutorial().click();
    assert.ok(overlay());
    assert.match(overlay().querySelector("#dex-tut-progresso").textContent, /^1 de 7$/);
  });
});

describe("navegação e acessibilidade", () => {
  test("título, subtítulo, X acessível e diálogo modal", () => {
    tut.abrirTutorialSanduichesSaladas();
    const dlg = overlay().querySelector(".dex-tut");
    assert.equal(dlg.getAttribute("role"), "dialog");
    assert.equal(dlg.getAttribute("aria-modal"), "true");
    assert.match(overlay().innerHTML, /Como lançar Sanduíches \+ Saladas no Dashboard iFood/);
    assert.match(overlay().innerHTML, /Entenda como preencher corretamente os dados da unidade\./);
    assert.equal(overlay().querySelector("#dex-tut-fechar").getAttribute("aria-label"), "Fechar tutorial");
  });

  test("Próximo/Anterior percorrem os 7 slides; 1º sem Anterior ativo; último com 'Começar lançamento'", () => {
    tut.abrirTutorialSanduichesSaladas();
    assert.equal(overlay().querySelector("#dex-tut-anterior").disabled, true);
    const vistos = [];
    for (let k = 0; k < tut.SLIDES.length; k++) {
      vistos.push(overlay().querySelector(".dex-tut-slide").getAttribute("data-slide"));
      assert.match(overlay().querySelector("#dex-tut-progresso").textContent, new RegExp(`^${k + 1} de 7$`));
      if (k < tut.SLIDES.length - 1) overlay().querySelector("#dex-tut-proximo").click();
    }
    assert.deepEqual(vistos, ["visao", "situacao", "desempenho", "financeiro", "conferencia", "interpretacao", "final"]);
    assert.equal(overlay().querySelector("#dex-tut-proximo"), null);
    assert.match(overlay().querySelector("#dex-tut-comecar").textContent, /Começar lançamento/);
    overlay().querySelector("#dex-tut-anterior").click();
    assert.equal(overlay().querySelector(".dex-tut-slide").getAttribute("data-slide"), "interpretacao");
  });

  test("teclado: setas navegam, Esc fecha e chama aoFechar uma vez", () => {
    let fechou = 0;
    tut.abrirTutorialSanduichesSaladas({ aoFechar: () => fechou++ });
    doc.teclar("ArrowRight");
    assert.equal(overlay().querySelector(".dex-tut-slide").getAttribute("data-slide"), "situacao");
    doc.teclar("ArrowLeft");
    assert.equal(overlay().querySelector(".dex-tut-slide").getAttribute("data-slide"), "visao");
    doc.teclar("Escape");
    assert.equal(overlay(), null);
    doc.teclar("Escape");
    assert.equal(fechou, 1);
  });

  test("'Começar lançamento' fecha e marca como visto", () => {
    atualizar(MULTICANAL);
    for (let k = 0; k < 6; k++) doc.teclar("ArrowRight");
    overlay().querySelector("#dex-tut-comecar").click();
    assert.equal(overlay(), null);
    assert.equal(tut.tutorialJaVisto("usr1", "u1"), true);
  });

  test("foco vai para o botão principal ao abrir", () => {
    tut.abrirTutorialSanduichesSaladas();
    assert.equal(doc.activeElement?.getAttribute("id"), "dex-tut-proximo");
  });
});

describe("conteúdo", () => {
  const texto = () => tut.SLIDES.map((s) => [s.titulo, s.texto, s.chave, s.nota, ...(s.itens ?? []).flat()].join(" ")).join(" ");
  test("cobre situação por fonte, acumulado do mês, financeiro separado e entregadores uma vez na unidade", () => {
    const t = texto();
    for (const trecho of ["Com vendas", "Sem vendas", "Não informado", "acumulados do mês, não apenas do dia",
      "o acumulado dela se repete", "Financeiro Oficial", "Ajustes Contra", "informada apenas uma vez",
      "Sanduíches + Saladas = resultado final da unidade", "O Dashboard sempre avalia o resultado total da unidade"]) {
      assert.ok(t.includes(trecho), `faltou: ${trecho}`);
    }
  });
  test("exemplo didático 20.000 + 5.000 = 25.000 no slide de interpretação", () => {
    const s = tut.SLIDES.find((x) => x.id === "interpretacao");
    assert.match(s.ilustracao, /R\$ 20\.000[\s\S]*R\$ 5\.000[\s\S]*R\$ 25\.000/);
  });
  test("integração: o Dashboard chama o tutorial só DEPOIS de renderizar o mês, sem slot fixo no layout", () => {
    const src = readFileSync(new URL("../src/dashboardExecutivo.js", import.meta.url), "utf8");
    assert.match(src, /dex\.dadosMes = data;\s*renderModeloBox\(\);\s*renderAbaAtual\(\);[\s\S]{0,200}atualizarTutorialDashboard\(\{/);
    assert.doesNotMatch(src, /dex-tutorial-abrir|dex-tut-/, "nenhum markup do tutorial no layout de sempre");
  });

  test("tutorial é só informativo: não importa API nem formulário de lançamento", () => {
    const src = readFileSync(new URL("../src/dashboardExecutivoTutorial.js", import.meta.url), "utf8");
    assert.doesNotMatch(src, /from "\.\/api\.js"|dashboardExecutivoForm|fetch\(/);
  });
});
