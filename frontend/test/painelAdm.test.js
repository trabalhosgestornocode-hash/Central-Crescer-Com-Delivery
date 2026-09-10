// Shell do Painel Administrativo (painelAdm.js).
// Abre só com acesso REAL (ping), volta para a seleção em "Trocar ambiente",
// navega por pilha interna (aba → empresa → calendário) sem tocar contexto
// tenant, e trata 403 em qualquer view como acesso revogado.
//
// Sem jsdom — fake mínimo de DOM (mesma abordagem de selecaoAmbiente.test.js).
//
// Rodar: node --test frontend/test/painelAdm.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// --- fake DOM ------------------------------------------------------------
function fakeEl(id) {
  const el = {
    id, _html: "", textContent: "", hidden: false, disabled: false, value: "",
    dataset: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    _listeners: {},
    addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); },
    click() { (this._listeners.click ?? []).forEach((f) => f({ target: { closest: () => null } })); },
    closest() { return null; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return el;
}
/**
 * O cabeçalho é HTML montado por painelAdm.js — este nó "entende" a própria
 * innerHTML e expõe os selects/botões do seletor de período, para os testes
 * poderem interagir com ele sem jsdom.
 */
function fakeCabecalho() {
  const n = fakeEl("#padm-cabecalho");
  n._selects = {};
  n._botoes = [];
  const setar = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(n) ?? {}, "innerHTML");
  Object.defineProperty(n, "innerHTML", {
    get() { return n._html; },
    set(v) {
      n._html = String(v);
      n._selects = {}; n._botoes = [];
      for (const tag of n._html.match(/<(select|button)[^>]*>/g) ?? []) {
        const el = fakeEl();
        const id = /id="([^"]+)"/.exec(tag)?.[1];
        const per = /data-padm-per="([^"]+)"/.exec(tag)?.[1];
        el.id = id ?? "";
        el.disabled = /\sdisabled/.test(tag);
        el.hidden = /\shidden/.test(tag);
        el.dataset = per ? { padmPer: per } : {};
        // valor inicial = <option ... selected>
        const sel = /<option value="(\d+)"[^>]*selected/.exec(n._html.slice(n._html.indexOf(tag)));
        if (id?.startsWith("padm-per-") && sel) el.value = sel[1];
        if (id) n._selects[id] = el;
        if (per) n._botoes.push(el);
      }
      void setar; // silencia lint: o descritor original não é reaproveitado
    },
  });
  return n;
}

let nodes = {};
globalThis.document = {
  querySelector: (sel) => {
    if (sel.startsWith("#padm-per-")) return nodes["#padm-cabecalho"]?._selects?.[sel.slice(1)] ?? null;
    return nodes[sel] ?? null;
  },
  querySelectorAll: (sel) => {
    if (sel.includes("#padm-menu li")) return nodes["#padm-menu"]?._itens ?? [];
    if (sel === "[data-padm-per]") return nodes["#padm-cabecalho"]?._botoes ?? [];
    return [];
  },
  createElement: () => fakeEl(),
  body: { appendChild() {} },
};
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.sessionStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.requestAnimationFrame ??= (fn) => fn();

const {
  abrirPainelAdministrativo, sairDoPainelAdministrativo, irParaPadm,
  abrirDetalheEmpresa, abrirCalendarioUnidade, definirPeriodo, irParaMesAtual, mudarPeriodo, periodoDe,
} = await import("../src/painelAdm.js");
const { TELAS_PADM } = await import("../src/painelAdmViews.js");
const { state } = await import("../src/state.js");

/** Mês corrente / mês anterior calculados como o painel calcula (sem hardcode). */
const YM_ATUAL = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; })();
const YM_ANTERIOR = (() => {
  const [a, m] = YM_ATUAL.split("-").map(Number);
  return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, "0")}`;
})();

function resetDom() {
  nodes = {};
  for (const id of ["#painel-adm-screen", "#padm-menu", "#padm-view", "#padm-titulo", "#padm-nome", "#padm-email", "#padm-avatar", "#padm-trocar", "#padm-btn-menu", "#padm-backdrop"]) {
    nodes[id] = fakeEl(id);
  }
  nodes["#padm-cabecalho"] = fakeCabecalho();
  nodes["#padm-menu"]._itens = TELAS_PADM.map((t) => {
    const li = fakeEl();
    li.dataset = { tela: t.id };
    return li;
  });
  state.telaPainelAdm = null;
  state.painelAdm = { periodo: periodoDe(YM_ATUAL) };   // cada teste começa no mês atual
}

beforeEach(resetDom);

const VISAO_GERAL_FAKE = {
  monitor: "dashboard_ifood", dataReferencia: "2026-09-15", d1: "2026-09-14",
  resumo: {
    unidadesMonitoradas: 3, empresasMonitoradas: 2, concluidasD1: 2, emPreenchimentoD1: 0,
    naoRealizadasD1: 1, sequenciaBloqueadaD1: 0, criticas: 0, atencao: 1, emDia: 2,
    conformidadeD1: 0.6667, conformidadeMes: 0.94, mesCompleto: 79, mesEsperado: 84,
  },
  acaoNecessariaHoje: [], resumoAcao: {}, empresas: [],
};

/** Fake da API que REGISTRA os argumentos — é assim que provamos o período. */
const apiFake = (over = {}) => {
  const chamadas = [];
  const reg = (nome, valor) => (...args) => { chamadas.push([nome, ...args]); return Promise.resolve(valor); };
  return {
    chamadas,
    ping: async () => ({ ok: true }),
    visaoGeral: reg("visaoGeral", VISAO_GERAL_FAKE),
    monitoramentoDiario: reg("monitoramentoDiario", { referencia: "2026-09-14", unidades: [] }),
    pendencias: reg("pendencias", { d1: "2026-09-14", unidades: [] }),
    empresas: reg("empresas", { empresas: [] }),
    detalheEmpresa: reg("detalheEmpresa", { organizacao: { nome: "Alfa", status: "ativa" }, consolidado: {}, unidades: [], pendencias: [] }),
    calendarioUnidade: reg("calendarioUnidade", { mes: YM_ATUAL, dataReferencia: `${YM_ATUAL}-15`, dias: [], unidade: {} }),
    relatorioResumo: reg("relatorioResumo", {
      periodo: YM_ATUAL, mesCorrente: true, d1: `${YM_ATUAL}-14`,
      operacao: { empresasMonitoradas: 2, unidadesMonitoradas: 3, empresasComPendencia: 1, unidadesComPendencia: 1, criticas: 0, atencao: 1, emDia: 2 },
      conformidade: { d1: 0.66, mes: 0.94, mesCompleto: 79, mesEsperado: 84 },
      faturamento: { total: 28500, confirmado: 28200, provisorio: 300, incluiProvisorio: true, cobertura: { completos: 44, esperados: 45, taxa: 0.977 }, liderEmpresa: null, liderUnidade: null },
      comparacao: null, prioridades: { empresas: [], unidades: [] },
      rankings: { faturamentoEmpresas: [], faturamentoUnidades: [], conformidadeEmpresas: [], atencaoEmpresas: [] },
    }),
    relatorioEvolucao: reg("relatorioEvolucao", { periodo: YM_ATUAL, serie: [] }),
    ...over,
  };
};
/** Última chamada de um método, como array [nome, ...args]. */
const ultima = (api, nome) => [...api.chamadas].reverse().find((c) => c[0] === nome);

const ganchosFake = () => {
  const chamadas = [];
  return {
    mostrarTela: (t) => chamadas.push(["mostrarTela", t]),
    aoTrocarAmbiente: () => chamadas.push(["aoTrocarAmbiente"]),
    aoAcessoRevogado: (m) => chamadas.push(["aoAcessoRevogado", m]),
    usuario: { nome: "João Pedro", email: "joao@x.com" },
    chamadas,
  };
};

describe("abrirPainelAdministrativo", () => {
  test("ping 200 -> troca para o shell e renderiza a Visão Geral real", async () => {
    const g = ganchosFake();
    const ok = await abrirPainelAdministrativo({ ...g, api: apiFake() });
    assert.equal(ok, true);
    assert.deepEqual(g.chamadas.find((c) => c[0] === "mostrarTela"), ["mostrarTela", "painelAdm"]);
    assert.equal(state.telaPainelAdm, "visao-geral");
    // A Visão Geral real mostra os cartões de indicador (não mais o placeholder).
    assert.match(nodes["#padm-view"].innerHTML, /Unidades com pendência/);
    assert.match(nodes["#padm-view"].innerHTML, /Ação necessária/i);
  });

  test("ping 403 -> NÃO abre o shell; chama aoAcessoRevogado", async () => {
    const g = ganchosFake();
    const err = Object.assign(new Error("Seu acesso não está mais disponível."), { status: 403 });
    const ok = await abrirPainelAdministrativo({ ...g, api: apiFake({ ping: async () => { throw err; } }) });
    assert.equal(ok, false);
    assert.ok(!g.chamadas.some((c) => c[0] === "mostrarTela"), "nunca troca de shell");
    assert.match(g.chamadas.find((c) => c[0] === "aoAcessoRevogado")[1], /disponível/);
  });

  test("erro de rede no ping -> não abre, não chama aoAcessoRevogado", async () => {
    const g = ganchosFake();
    const ok = await abrirPainelAdministrativo({ ...g, api: apiFake({ ping: async () => { throw new Error("Failed to fetch"); } }) });
    assert.equal(ok, false);
    assert.ok(!g.chamadas.some((c) => c[0] === "mostrarTela"));
    assert.ok(!g.chamadas.some((c) => c[0] === "aoAcessoRevogado"));
  });

  test("403 numa VIEW (após aberto) -> aoAcessoRevogado", async () => {
    const g = ganchosFake();
    const err403 = Object.assign(new Error("Acesso revogado."), { status: 403 });
    await abrirPainelAdministrativo({ ...g, api: apiFake({ pendencias: async () => { throw err403; } }) });
    g.chamadas.length = 0;
    irParaPadm("pendencias");
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(g.chamadas.some((c) => c[0] === "aoAcessoRevogado"), "403 em view vira acesso revogado");
  });

  test("erro de rede numa VIEW -> estado de erro, NÃO acesso revogado", async () => {
    const g = ganchosFake();
    await abrirPainelAdministrativo({ ...g, api: apiFake({ empresas: async () => { throw new Error("Failed to fetch"); } }) });
    g.chamadas.length = 0;
    irParaPadm("empresas");
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(!g.chamadas.some((c) => c[0] === "aoAcessoRevogado"));
    assert.match(nodes["#padm-view"].innerHTML, /sem conexão com o servidor/i);
  });
});

describe("sairDoPainelAdministrativo (Trocar ambiente)", () => {
  test("chama aoTrocarAmbiente e limpa a tela ativa", async () => {
    const g = ganchosFake();
    await abrirPainelAdministrativo({ ...g, api: apiFake() });
    sairDoPainelAdministrativo();
    assert.ok(g.chamadas.some((c) => c[0] === "aoTrocarAmbiente"));
    assert.equal(state.telaPainelAdm, null);
  });
});

describe("TELAS_PADM", () => {
  test("áreas existentes preservadas, seguidas da agenda de desenvolvimento", () => {
    assert.deepEqual(TELAS_PADM.map((t) => t.id), ["visao-geral", "performance", "diario", "pendencias", "empresas", "mentorados", "relatorios", "desenvolvimento"]);
  });

  test("irParaPadm abre Relatórios com o período ativo", async () => {
    const g = ganchosFake();
    const api = apiFake();
    await abrirPainelAdministrativo({ ...g, api });
    await irParaPadm("relatorios");
    assert.equal(state.telaPainelAdm, "relatorios");
    assert.equal(nodes["#padm-titulo"].textContent, "Relatórios");
    // a área consome os endpoints de relatório, levando o mês do painel
    assert.deepEqual(ultima(api, "relatorioResumo"), ["relatorioResumo", { mes: YM_ATUAL }]);
    assert.deepEqual(ultima(api, "relatorioEvolucao"), ["relatorioEvolucao", { mes: YM_ATUAL }]);
    assert.match(nodes["#padm-view"].innerHTML, /Resumo executivo/i);
  });
});

// ===========================================================================
// PERÍODO ATIVO (mês/ano) — itens 20.1 a 20.6
// ===========================================================================
describe("seletor de período (mês/ano)", () => {
  const abrir = async (over) => {
    const g = ganchosFake();
    const api = apiFake(over);
    await abrirPainelAdministrativo({ ...g, api });
    return { g, api };
  };

  test("1) o cabeçalho renderiza o seletor de mês, de ano e as setas", async () => {
    await abrir();
    const cab = nodes["#padm-cabecalho"].innerHTML;
    assert.match(cab, /Painel Administrativo/);
    assert.match(cab, /Crescer com Delivery/);
    assert.match(cab, /id="padm-per-mes"/);
    assert.match(cab, /id="padm-per-ano"/);
    assert.match(cab, /data-padm-per="anterior"/);
    assert.match(cab, /data-padm-per="proximo"/);
    assert.match(cab, /Período analisado/i);
    // no mês atual, "próximo" fica desabilitado e o atalho de voltar some
    assert.ok(nodes["#padm-cabecalho"]._selects["padm-per-mes"]);
    assert.equal(nodes["#padm-cabecalho"]._botoes.find((b) => b.dataset.padmPer === "proximo").disabled, true);
  });

  test("2) trocar o período refaz a chamada da API com mes=AAAA-MM", async () => {
    const { api } = await abrir();
    assert.deepEqual(ultima(api, "visaoGeral"), ["visaoGeral", { mes: YM_ATUAL }]);

    await definirPeriodo(YM_ANTERIOR);
    assert.deepEqual(ultima(api, "visaoGeral"), ["visaoGeral", { mes: YM_ANTERIOR }]);
    assert.equal(state.painelAdm.periodo.ym, YM_ANTERIOR);
  });

  test("2b) as setas ‹ › andam um mês; o futuro é recusado", async () => {
    const { api } = await abrir();
    await mudarPeriodo(-1);
    assert.equal(state.painelAdm.periodo.ym, YM_ANTERIOR);
    await mudarPeriodo(+1);
    assert.equal(state.painelAdm.periodo.ym, YM_ATUAL);
    await mudarPeriodo(+1);                                  // tentar ir para o futuro
    assert.equal(state.painelAdm.periodo.ym, YM_ATUAL, "nunca navega para um mês futuro");
    assert.deepEqual(ultima(api, "visaoGeral"), ["visaoGeral", { mes: YM_ATUAL }]);
  });

  test("3) o período persiste ao trocar de aba", async () => {
    const { api } = await abrir();
    await definirPeriodo(YM_ANTERIOR);
    await irParaPadm("pendencias");
    assert.deepEqual(ultima(api, "pendencias"), ["pendencias", { mes: YM_ANTERIOR }]);
    await irParaPadm("empresas");
    assert.deepEqual(ultima(api, "empresas"), ["empresas", { mes: YM_ANTERIOR }]);
    await irParaPadm("diario");
    assert.deepEqual(ultima(api, "monitoramentoDiario"), ["monitoramentoDiario", { mes: YM_ANTERIOR }]);
  });

  test("4) o detalhe da empresa mantém o período selecionado", async () => {
    const { api } = await abrir();
    await definirPeriodo(YM_ANTERIOR);
    await irParaPadm("empresas");
    await abrirDetalheEmpresa("org-1", "Alfa");
    assert.deepEqual(ultima(api, "detalheEmpresa"), ["detalheEmpresa", "org-1", { mes: YM_ANTERIOR }]);
  });

  test("5) o calendário da unidade abre no mês selecionado", async () => {
    const { api } = await abrir();
    await definirPeriodo(YM_ANTERIOR);
    await abrirDetalheEmpresa("org-1", "Alfa");
    await abrirCalendarioUnidade("uni-1", "Alfa Centro");
    assert.deepEqual(ultima(api, "calendarioUnidade"), ["calendarioUnidade", "uni-1", YM_ANTERIOR]);
  });

  test("5b) voltar do calendário preserva o período e volta ao detalhe", async () => {
    const { api } = await abrir();
    await definirPeriodo(YM_ANTERIOR);
    await abrirDetalheEmpresa("org-1", "Alfa");
    await abrirCalendarioUnidade("uni-1", "Alfa Centro");
    const { voltarPadm } = await import("../src/painelAdm.js");
    await voltarPadm();
    assert.deepEqual(ultima(api, "detalheEmpresa"), ["detalheEmpresa", "org-1", { mes: YM_ANTERIOR }]);
    assert.equal(state.painelAdm.periodo.ym, YM_ANTERIOR);
  });

  test("6) 'Voltar ao mês atual' volta ao mês corrente e recarrega", async () => {
    const { api } = await abrir();
    await definirPeriodo(YM_ANTERIOR);
    assert.match(nodes["#padm-cabecalho"].innerHTML, /Voltar ao mês atual/);
    await irParaMesAtual();
    assert.equal(state.painelAdm.periodo.ym, YM_ATUAL);
    assert.deepEqual(ultima(api, "visaoGeral"), ["visaoGeral", { mes: YM_ATUAL }]);
  });

  test("o período vive em state.painelAdm.periodo = { ano, mes, ym }", async () => {
    await abrir();
    await definirPeriodo(YM_ANTERIOR);
    const p = state.painelAdm.periodo;
    assert.deepEqual(Object.keys(p).sort(), ["ano", "mes", "ym"]);
    assert.equal(p.ym, YM_ANTERIOR);
    assert.equal(p.ano, Number(YM_ANTERIOR.slice(0, 4)));
    assert.equal(p.mes, Number(YM_ANTERIOR.slice(5, 7)));
  });
});
