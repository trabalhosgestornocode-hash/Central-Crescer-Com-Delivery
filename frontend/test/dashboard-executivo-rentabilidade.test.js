// PROTEÇÃO DA PRECIFICAÇÃO — apresentação (só no Simulador) + recolher/expandir.
// Sem jsdom, sem --experimental-vm-modules: fake mínimo de document + injeção de
// dashExecMes.
//
// Rodar: node --test frontend/test/dashboard-executivo-rentabilidade.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as visual from "../src/dashboardExecutivoRentabilidade.js";
import { montarSimuladorPreco } from "../src/dashboardExecutivoSimulador.js";
import { calcularProtecaoPrecificacao, calcularComparacaoProduto } from "../../backend/src/modules/dashboard-executivo/dashboardExecutivo.rentabilidade.js";
import { state } from "../src/state.js";
import { invalidarGeracaoDeContexto } from "../src/contextoEscopo.js";

const dados = (b = "E", ticket = 47.33) => {
  const precos = {
    oficiais: { tabelaBalcao: b, tabelaIfood: "Z4" }, tabelas: { balcao: b, ifood: "Z4" },
    produto: { id: "p1", nome: "Churrasco 15cm" },
    balcao: { preco: b === "E" ? 24 : b === "F" ? 24.5 : 23.5, custo: 6 }, ifood: { preco: 35, custo: 6 },
  };
  const pp = calcularProtecaoPrecificacao({ precoBalcao: precos.balcao.preco, precoIfood: 35, ticketMedioIfood: ticket });
  return { protecaoPrecificacao: { ...pp, precos, comparacao: calcularComparacaoProduto(precos, { taxasComissoesPct: 11.52, servicosPromocoesPct: 12.63 }) } };
};

// --- fake DOM mínimo para o Simulador -------------------------------------
function fakeContainer() {
  const corpo = { hidden: true, _h: "", set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; } };
  const label = { textContent: "" };
  const toggle = {
    _attrs: {}, _clicks: [],
    setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k]; },
    addEventListener(ev, fn) { if (ev === "click") this._clicks.push(fn); },
    click() { this._clicks.forEach((f) => f()); },
    querySelector() { return label; },
  };
  const reset = { _clicks: [], addEventListener(ev, fn) { if (ev === "click") this._clicks.push(fn); }, click() { this._clicks.forEach((f) => f()); } };
  let selects = [];
  return {
    isConnected: true, _h: "",
    set innerHTML(v) { this._h = v; corpo._h = v; toggle._attrs = { "aria-expanded": /aria-expanded="true"/.test(v) ? "true" : "false" };
      selects = ["balcao", "ifood"].map((canal) => ({ dataset: { canal }, value: "", onchange: null })); },
    get innerHTML() { return this._h; },
    querySelector(s) { return s === "#dex-sim-corpo" ? corpo : s === "[data-toggle]" ? toggle : s === "[data-reset]" ? reset : null; },
    querySelectorAll(s) { return s === "[data-canal]" ? selects : []; },
    get text() { return this._h + " ~ " + corpo._h; },
    get selects() { return selects; },
    corpo, toggle, reset, label,
  };
}

test("formatação pt-BR com duas casas", () => {
  assert.equal(visual.fmtPctRentabilidade(11 / 35 * 100), "31,43%");
  for (const v of [null, undefined, NaN, Infinity]) assert.equal(visual.fmtPctRentabilidade(v), "—");
});

test("resultado da simulação: só precificação, sem meta/limite logístico, sem status", () => {
  const html = visual.resultadoSimulacaoHtml(dados().protecaoPrecificacao, dados().protecaoPrecificacao);
  assert.match(html, /Resultado da simulação/);
  assert.match(html, /Proteção da precificação/);
  assert.match(html, /31,43%/);
  assert.match(html, /Diferença de preço/);
  assert.match(html, /Ticket Médio equivalente/);
  assert.doesNotMatch(html, /Limite|Meta ideal|pill (ok|warn|bad)|Dentro do Limite|Atenção/);
  assert.doesNotMatch(html, /<table/);
});

test("E / F / D × Z4: proteção 31,43 / 30,00 / 32,86", () => {
  assert.match(visual.resultadoSimulacaoHtml(dados("E").protecaoPrecificacao, dados("E").protecaoPrecificacao), /31,43%/);
  assert.match(visual.resultadoSimulacaoHtml(dados("F").protecaoPrecificacao, dados("F").protecaoPrecificacao), /30,00%/);
  assert.match(visual.resultadoSimulacaoHtml(dados("D").protecaoPrecificacao, dados("D").protecaoPrecificacao), /32,86%/);
});

test("Ticket Médio equivalente: usa valor bruto, arredonda só na exibição (42599,39 / 900)", () => {
  const bruto = 42599.39 / 900;                       // 47.332655…
  const r = calcularProtecaoPrecificacao({ precoBalcao: 24, precoIfood: 35, ticketMedioIfood: bruto });
  assert.equal(bruto.toFixed(2), "47.33");            // exibido
  assert.equal(r.ticketMedioEquivalenteBalcao.toFixed(2), "32.46"); // 47.3327 × 24/35 = 32.4567
  // com o ticket já arredondado daria 32,45 — não é o que o sistema faz:
  assert.equal((47.33 * 24 / 35).toFixed(2), "32.45");
});

test("Simulador: faixa recolhível (padrão recolhido); expandir/recolher sem reconstruir; recalcula ao trocar tabela", async () => {
  const container = fakeContainer();
  const anterior = globalThis.document;
  globalThis.document = { getElementById: () => container };
  state.tabelasDisponiveis = { balcao: ["D", "E", "F"], ifood: ["Z4"] };
  const pedidos = [];
  const deps = { dashExecMes: (p) => new Promise((resolve) => pedidos.push({ p, resolve })) };
  try {
    const original = dados();
    montarSimuladorPreco("sim", "u1", 9, 2026, original, deps);
    // faixa sempre visível, com título + combinação + proteção
    assert.match(container.text, /Simulador de preço/);
    assert.match(container.text, /E × Z4/);
    assert.match(container.text, /Proteção 31,43%/);
    // padrão RECOLHIDO
    assert.equal(container.corpo.hidden, true);
    assert.equal(container.toggle.getAttribute("aria-expanded"), "false");

    // expandir — só troca hidden, sem reconstruir (corpo._h continua o mesmo)
    const htmlAntes = container.innerHTML;
    container.toggle.click();
    assert.equal(container.corpo.hidden, false);
    assert.equal(container.toggle.getAttribute("aria-expanded"), "true");
    assert.equal(container.label.textContent, "Recolher");
    assert.equal(container.innerHTML, htmlAntes); // nenhuma reconstrução

    // recolher de novo
    container.toggle.click();
    assert.equal(container.corpo.hidden, true);
    assert.equal(container.label.textContent, "Expandir");

    // trocar tabela → recalcula; a seleção do Dashboard não muda
    container.selects[0].value = "D";
    const troca = container.selects[0].onchange();
    assert.match(container.corpo.innerHTML, /Recalculando/);
    assert.equal(pedidos[0].p.tabelaBalcao, "D");
    pedidos[0].resolve({ data: dados("D") });
    await troca;
    assert.match(container.text, /Proteção 32,86%/);
    assert.equal(original.protecaoPrecificacao.precos.tabelas.balcao, "E");

    container.reset.click();
    assert.match(container.text, /Proteção 31,43%/);

    // resposta que volta após nova montagem é descartada
    container.selects[0].value = "D";
    const antiga = container.selects[0].onchange();
    montarSimuladorPreco("sim", "u2", 8, 2026, dados("D", 70), deps);
    const novo = container.innerHTML;
    pedidos[1].resolve({ data: dados("E") });
    await antiga;
    assert.equal(container.innerHTML, novo);

    // troca de contexto no meio do voo também descarta
    container.selects[0].value = "E";
    const ctx = container.selects[0].onchange();
    invalidarGeracaoDeContexto();
    pedidos[2].resolve({ data: dados("E") });
    await ctx;
    assert.match(container.corpo.innerHTML, /Recalculando/);
  } finally {
    globalThis.document = anterior;
  }
});
