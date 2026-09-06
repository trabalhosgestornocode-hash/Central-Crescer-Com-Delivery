// Reabertura do fechamento mensal (frontend). Rota já existente:
//   POST /api/v1/bonificacao-mensal/fechamento-mensal/reabrir  { ano, mes, motivo }
//
// Sem jsdom no projeto — fake DOM mínimo suficiente para o modal (mesma
// abordagem do resto de frontend/test/).
//
// Rodar: node --test frontend/test/bonificacaoMensalReabrir.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// --------- fake DOM (flat: querySelector busca todos os nós do mesmo innerHTML) ---
const attr = (tag, name) => { const m = new RegExp(`${name}="([^"]*)"`).exec(tag); return m ? m[1] : ""; };
function match(n, sel) {
  if (sel.startsWith("#")) return n.id === sel.slice(1);
  if (sel.startsWith(".")) return ` ${n.className} `.includes(` ${sel.slice(1)} `);
  return n.tag === sel;
}
function fakeNode(tag = "div") {
  return {
    tag, _html: "", _all: [], _listeners: {}, className: "", id: "", value: "",
    textContent: "", hidden: false, disabled: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      const all = [];
      for (const tagStr of String(v).match(/<(button|div|textarea|input|span|p|h2|label)\b[^>]*>/g) || []) {
        const c = fakeNode(tagStr.match(/^<(\w+)/)[1]);
        c.id = attr(tagStr, "id"); c.className = attr(tagStr, "class");
        c.disabled = /\sdisabled/.test(tagStr); c._all = all;
        all.push(c);
      }
      this._all = all;
    },
    addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); },
    removeEventListener() {},
    async dispatch(ev, arg) { for (const f of this._listeners[ev] || []) await f(arg || {}); },
    remove() { this._removed = true; },
    appendChild(c) { return c; },
    prepend() {},
    querySelector(sel) { return this._all.find((n) => match(n, sel)) || null; },
    querySelectorAll(sel) { return this._all.filter((n) => match(n, sel)); },
    focus() {}, click() { return this.dispatch("click"); },
  };
}

let bodyChildren = [];
globalThis.document = {
  createElement: (t) => fakeNode(t),
  body: { appendChild(n) { bodyChildren.push(n); return n; } },
  addEventListener() {}, removeEventListener() {},
  querySelector: () => null, // toast() -> el("#toast") == null -> no-op
};
globalThis.requestAnimationFrame = () => {};

const { abrirReabrirFechamentoModal, podeConfirmarReabertura } = await import("../src/bonificacaoMensalReabrirModal.js");

const MENSAL_SRC = readFileSync(fileURLToPath(new URL("../src/bonificacaoMensal.js", import.meta.url)), "utf8");
const API_SRC = readFileSync(fileURLToPath(new URL("../src/api.js", import.meta.url)), "utf8");
const MODAL_SRC = readFileSync(fileURLToPath(new URL("../src/bonificacaoMensalReabrirModal.js", import.meta.url)), "utf8");
const noComments = (s) => s.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

beforeEach(() => { bodyChildren = []; });

// ---------------------------------------------------------------------------
describe("1) competência fechada mostra botão de reabrir", () => {
  const CODIGO = noComments(MENSAL_SRC);
  test("fechamentoMensalHtml renderiza #bm-fm-reabrir só p/ competência fechada + permissão de excluir", () => {
    assert.match(CODIGO, /const podeReabrir = fechada && d\.fechamentoStatus === "fechado" && podeExcluir\(\)/);
    assert.match(CODIGO, /id="bm-fm-reabrir"/);
    assert.match(CODIGO, /Reabrir fechamento/);
  });
  test("o botão é ligado ao modal de reabertura, com onReaberto = carregarConteudo", () => {
    assert.match(CODIGO, /#bm-fm-reabrir"\)\?\.addEventListener\("click", \(\) => abrirReabrirFechamentoModal\(\{/);
    assert.match(CODIGO, /onReaberto: carregarConteudo/);
  });
});

describe("2) sem motivo não permite confirmar", () => {
  test("podeConfirmarReabertura exige >= 3 caracteres (mesma regra do backend)", () => {
    assert.equal(podeConfirmarReabertura(""), false);
    assert.equal(podeConfirmarReabertura("  "), false);
    assert.equal(podeConfirmarReabertura("ok"), false);
    assert.equal(podeConfirmarReabertura("  ab "), false);
    assert.equal(podeConfirmarReabertura("erro no PDF"), true);
    assert.equal(podeConfirmarReabertura(null), false);
  });

  test("o modal abre com o botão Confirmar DESABILITADO e só habilita com motivo válido", () => {
    const m = abrirReabrirFechamentoModal({ ano: 2026, mes: 8, competenciaLabel: "Agosto/2026", onReaberto() {}, _reabrir: async () => ({ data: {} }) });
    const motivo = m.querySelector("#bm-reabrir-motivo");
    const confirmar = m.querySelector("#bm-reabrir-confirmar");
    assert.equal(confirmar.disabled, true, "começa desabilitado");

    motivo.value = "xx"; motivo.dispatch("input");
    assert.equal(confirmar.disabled, true, "2 chars: ainda desabilitado");

    motivo.value = "erro no relatório"; motivo.dispatch("input");
    assert.equal(confirmar.disabled, false, "motivo válido: habilita");
  });

  test("clicar Confirmar sem motivo válido não chama a API", async () => {
    let chamado = 0;
    const m = abrirReabrirFechamentoModal({ ano: 2026, mes: 8, competenciaLabel: "Agosto/2026", onReaberto() {}, _reabrir: async () => { chamado++; return { data: {} }; } });
    const confirmar = m.querySelector("#bm-reabrir-confirmar");
    await confirmar.dispatch("click");
    assert.equal(chamado, 0);
  });
});

describe("3) com motivo chama a API correta", () => {
  test("api.js: bonifFechamentoMensalReabrir -> POST /fechamento-mensal/reabrir { ano, mes, motivo }", () => {
    assert.match(API_SRC, /bonifFechamentoMensalReabrir\s*=\s*\(\{ ano, mes, motivo \}\)\s*=>\s*postJson\(`\$\{BM\}\/fechamento-mensal\/reabrir`, \{ ano, mes, motivo \}\)/);
  });

  test("confirmar com motivo chama _reabrir({ ano, mes, motivo }) com o motivo aparado", async () => {
    const chamadas = [];
    const m = abrirReabrirFechamentoModal({
      ano: 2026, mes: 8, competenciaLabel: "Agosto/2026", onReaberto() {},
      _reabrir: async (p) => { chamadas.push(p); return { data: { reaberta: true } }; },
    });
    const motivo = m.querySelector("#bm-reabrir-motivo");
    const confirmar = m.querySelector("#bm-reabrir-confirmar");
    motivo.value = "  PDF de vendas com período errado  "; motivo.dispatch("input");
    await confirmar.dispatch("click");

    assert.equal(chamadas.length, 1);
    assert.deepEqual(chamadas[0], { ano: 2026, mes: 8, motivo: "PDF de vendas com período errado" });
  });
});

describe("4) após sucesso, atualiza o estado da competência", () => {
  test("onReaberto é chamado com os dados e o overlay é removido", async () => {
    let reabertoCom = "NAO CHAMOU";
    const m = abrirReabrirFechamentoModal({
      ano: 2026, mes: 8, competenciaLabel: "Agosto/2026",
      onReaberto: (data) => { reabertoCom = data; },
      _reabrir: async () => ({ data: { competencia: { status: "reaberta" }, reaberta: true } }),
    });
    const motivo = m.querySelector("#bm-reabrir-motivo");
    motivo.value = "refazer fechamento"; motivo.dispatch("input");
    await m.querySelector("#bm-reabrir-confirmar").dispatch("click");

    assert.deepEqual(reabertoCom, { competencia: { status: "reaberta" }, reaberta: true });
    assert.equal(bodyChildren[0]._removed, true, "overlay removido após sucesso");
  });

  test("onReaberto do wiring da tela é carregarConteudo -> refaz obterMes e re-renderiza", () => {
    // carregarConteudo(): bonifMes() -> bm.dadosMes = ... -> renderAbaAtual()
    assert.match(MENSAL_SRC, /bm\.dadosMes = mesData;[\s\S]*renderAbaAtual\(\);/);
  });

  test("erro do backend NÃO fecha o modal e reabilita o Confirmar", async () => {
    const m = abrirReabrirFechamentoModal({
      ano: 2026, mes: 8, competenciaLabel: "Agosto/2026", onReaberto() {},
      _reabrir: async () => { throw new Error("competência não está fechada"); },
    });
    const motivo = m.querySelector("#bm-reabrir-motivo");
    motivo.value = "motivo qualquer"; motivo.dispatch("input");
    await m.querySelector("#bm-reabrir-confirmar").dispatch("click");

    assert.notEqual(bodyChildren[0]._removed, true, "modal continua aberto no erro");
    assert.equal(m.querySelector("#bm-reabrir-confirmar").disabled, false, "Confirmar reabilitado");
    assert.match(m.querySelector("#bm-reabrir-msg").textContent, /Erro: competência não está fechada/);
  });
});

describe("garantias — sem migration, sem tocar cálculo, snapshot preservado", () => {
  const cod = noComments(MODAL_SRC);
  test("o modal só importa a rota de reabertura e monta { ano, mes, motivo }", () => {
    // única coisa importada de api.js
    assert.match(cod, /import \{ bonifFechamentoMensalReabrir \} from "\.\/api\.js"/);
    assert.doesNotMatch(cod, /mixMensalPonderado|montarResultado|Consolidar|Confirmar fechamento|apply_migration|execute_sql|from\("bonificacao/);
    // o payload enviado é exatamente { ano, mes, motivo }
    assert.match(cod, /_reabrir\(\{ ano, mes, motivo: motivoEl\.value\.trim\(\) \}\)/);
  });
  test("o texto do modal deixa claro que o snapshot NÃO é apagado", () => {
    assert.match(MODAL_SRC, /não é apagado|continua no histórico/);
  });
});
