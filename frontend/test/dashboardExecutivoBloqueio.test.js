// Bloqueio dos "Indicadores de Rentabilidade" sem as duas tabelas comerciais
// oficiais (ver dashboardExecutivoBloqueio.js).
//
// Executa o código REAL: `renderIndicadores` (via `_renderIndicadoresParaTeste`)
// e `abrirSecaoConfiguracoes` com um fake mínimo de DOM — sem jsdom no projeto,
// mesma técnica de dashboardExecutivoRealtime.test.js / configuracoes.test.js.
//
// Rodar: node --test frontend/test/dashboardExecutivoBloqueio.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// --- fake DOM/storage/fetch mínimos -------------------------------------
function elementoFake() {
  return {
    _html: "", _ouvintes: {}, hidden: false,
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener(tipo, fn) { (this._ouvintes[tipo] ??= []).push(fn); },
    click() { (this._ouvintes.click ?? []).forEach((fn) => fn()); },
    textContent: "", classList: { toggle: () => {}, add: () => {}, remove: () => {} }, style: {}, dataset: {},
  };
}
const elementos = new Map();
const pegar = (sel) => { if (!elementos.has(sel)) elementos.set(sel, elementoFake()); return elementos.get(sel); };
const eventosDisparados = [];
globalThis.document = {
  querySelector: (sel) => pegar(sel), querySelectorAll: () => [], createElement: () => elementoFake(),
  getElementById: () => null, addEventListener: () => {},
  dispatchEvent: (ev) => { eventosDisparados.push({ tipo: ev.type, detail: ev.detail }); return true; },
  documentElement: { setAttribute: () => {} },
};
globalThis.window = globalThis;
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.fetch = async (url) => {
  if (String(url).includes("/api/config")) return { ok: true, status: 200, json: async () => ({ supabaseUrl: "https://x.example", supabaseAnonKey: "anon" }) };
  return { ok: true, status: 200, json: async () => ({ data: {} }) };
};
globalThis.window.supabase = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }) };

const { state } = await import("../src/state.js");
const { _renderIndicadoresParaTeste } = await import("../src/dashboardExecutivo.js");
const { abrirSecaoConfiguracoes } = await import("../src/configuracoes.js");
const {
  indicadoresRentabilidadeLiberados, tabelasOficiaisDoMes, EVENTO_ABRIR_TABELAS_OFICIAIS,
} = await import("../src/dashboardExecutivoBloqueio.js");

const fonte = (arq) => readFileSync(fileURLToPath(new URL(`../src/${arq}`, import.meta.url)), "utf8");

// --- payloads de GET /dashboard-executivo/mes ----------------------------
const ind = (atual, status) => ({ atual, metaIdeal: 13, limite: 13, naoAplicavel: false, status, saldo: null });
const INDICADORES_COMPLETOS = {
  taxas_comissoes: ind(11.52, { label: "Dentro da Meta", chave: "dentro_da_meta" }),
  servicos_promocoes: ind(12.63, { label: "Atenção", chave: "atencao" }),
  taxas_entregadores: ind(14.9, { label: "Dentro do Limite", chave: "dentro_do_limite" }),
  total_deducoes: ind(39.05, { label: "Atenção", chave: "atencao" }),
};
// "Dados insuficientes": tabelas existem, mas o mês não tem lançamento (atual/status null).
const INDICADORES_SEM_DADOS = Object.fromEntries(
  Object.keys(INDICADORES_COMPLETOS).map((k) => [k, { atual: null, metaIdeal: 13, limite: 13, naoAplicavel: false, status: null, saldo: null }]),
);
/** `oficiais` = configuração persistida; `tabelas` = o que o backend usou no cálculo
 * (igual à oficial, ou a de comparação quando o pedido trouxe tabelaBalcao/tabelaIfood). */
/** `protecaoPct` = Proteção da Precificação calculada pelo backend (null sem tabela/preço). */
function payload({ balcao, ifood, tabelasUsadas, indicadores = INDICADORES_COMPLETOS, unidadeId = "uni-1", protecaoPct }) {
  const pct = protecaoPct !== undefined ? protecaoPct : (balcao && ifood ? 31.43 : null);
  return {
    agregado: false, unidadeId, modeloPeriodo: { misto: false }, graficos: { comparativoPercentuais: [] },
    indicadoresRentabilidade: indicadores,
    protecaoPrecificacao: { protecaoPrecificacaoPct: pct, precos: { oficiais: { tabelaBalcao: balcao, tabelaIfood: ifood }, tabelas: tabelasUsadas ?? { balcao, ifood } } },
  };
}
function render(dadosMes) {
  const box = elementoFake();
  const cta = elementoFake();
  box.querySelector = (sel) => (sel === "[data-abrir-tabelas-oficiais]" ? cta : null);
  _renderIndicadoresParaTeste(box, dadosMes);
  return { html: box.innerHTML, cta };
}
const bloqueado = (html) => html.includes("Tabelas oficiais não selecionadas") && html.includes("data-abrir-tabelas-oficiais");

beforeEach(() => { eventosDisparados.length = 0; state.tabelaComparacao = null; });

describe("Indicadores de Rentabilidade — regra das tabelas oficiais", () => {
  test("Caso 1: Balcão E + iFood Z4 → indicadores visíveis com valores reais", () => {
    const { html } = render(payload({ balcao: "E", ifood: "Z4" }));
    assert.equal(bloqueado(html), false);
    assert.match(html, /11,52%/);
    assert.match(html, /Dentro da Meta/);
  });

  test("Caso 2: Balcão E + iFood ausente → bloqueado, sem valores reais no DOM", () => {
    const { html } = render(payload({ balcao: "E", ifood: null }));
    assert.ok(bloqueado(html));
    assert.match(html, /Pendente: tabela oficial do iFood/);
    for (const v of ["11,52", "12,63", "14,90", "39,05", "Dentro da Meta", "Atenção"]) assert.ok(!html.includes(v), `vazou ${v}`);
    assert.ok(!html.includes("Dados insuficientes"), "bloqueio por configuração não é 'Dados insuficientes'");
  });

  test("Caso 3: Balcão ausente + iFood Z4 → bloqueado", () => {
    const { html } = render(payload({ balcao: null, ifood: "Z4" }));
    assert.ok(bloqueado(html));
    assert.match(html, /Pendente: tabela oficial de Balcão/);
    assert.ok(!html.includes("11,52"));
  });

  test("Caso 4: ambas ausentes → bloqueado", () => {
    const { html } = render(payload({ balcao: null, ifood: null }));
    assert.ok(bloqueado(html));
    assert.match(html, /Balcão e iFood/);
  });

  test("Caso 5: tabelas configuradas, sem dados → NÃO bloqueia; mostra 'Dados insuficientes'", () => {
    const { html } = render(payload({ balcao: "E", ifood: "Z4", indicadores: INDICADORES_SEM_DADOS }));
    assert.equal(bloqueado(html), false);
    assert.equal(html.match(/Dados insuficientes/g)?.length, 4);
  });

  test("Caso 6: iFood oficial ausente + 'Comparar: Z4' / tabela temporária Z4 → continua bloqueado", () => {
    state.tabelaComparacao = "Z4"; // seletor global "Comparar"
    // backend calculou com Z4 (parâmetro temporário), mas a oficial persistida segue null
    const d = payload({ balcao: "E", ifood: null, tabelasUsadas: { balcao: "E", ifood: "Z4" } });
    assert.equal(indicadoresRentabilidadeLiberados(d), false);
    assert.deepEqual(tabelasOficiaisDoMes(d), { balcao: "E", ifood: null });
    assert.ok(bloqueado(render(d).html));
  });

  test("fail-closed: payload sem `oficiais`, string vazia ou formato inesperado → bloqueado", () => {
    assert.equal(indicadoresRentabilidadeLiberados(null), false);
    assert.equal(indicadoresRentabilidadeLiberados({}), false);
    assert.equal(indicadoresRentabilidadeLiberados(payload({ balcao: "E", ifood: "  " })), false);
    assert.equal(indicadoresRentabilidadeLiberados(payload({ balcao: "E", ifood: 4 })), false);
  });

  test("visão consolidada continua com a mensagem própria (não é o bloqueio de tabelas)", () => {
    const { html } = render({ agregado: true });
    assert.match(html, /Visão consolidada/);
    assert.equal(bloqueado(html), false);
  });
});

describe("Troca de unidade — estado vem só do payload da unidade atual", () => {
  const unidadeA = payload({ balcao: "E", ifood: "Z4" });
  const unidadeB = payload({ balcao: "E", ifood: null });

  test("Caso 7: unidade configurada → não configurada bloqueia imediatamente", () => {
    assert.equal(bloqueado(render(unidadeA).html), false);
    const { html } = render(unidadeB);
    assert.ok(bloqueado(html));
    assert.ok(!html.includes("11,52"), "nada da unidade anterior pode sobrar");
  });

  test("Caso 8: unidade não configurada → configurada libera", () => {
    assert.ok(bloqueado(render(unidadeB).html));
    assert.equal(bloqueado(render(unidadeA).html), false);
  });

  test("reset de contexto zera dadosMes e o Dashboard não lê tabelas da sessão/comparação", () => {
    const src = fonte("dashboardExecutivo.js");
    assert.match(src, /registrarResetDeContexto\(\(\) => \{[\s\S]*?dex\.dadosMes = null;/);
    assert.ok(!/tabelasOficiais|tabelaComparacao/.test(src), "fonte única: payload do backend");
    // fetch principal do mês nunca envia tabela temporária → backend usa sempre a oficial
    assert.match(src, /dashExecMes\(\{ unidadeId: dex\.unidadeId \|\| undefined, mes: mesPedido, ano: anoPedido \}\)/);
  });
});

describe("CTA 'Selecionar tabelas oficiais'", () => {
  test("Caso 9: clique dispara a navegação levando a unidade ANALISADA (do payload)", () => {
    const { html, cta } = render(payload({ balcao: null, ifood: null, unidadeId: "uni-B" }));
    assert.match(html, /<button type="button" class="btn btn-primary dex-bloqueio-cta"/);
    assert.match(html, /aria-label="Selecionar tabelas oficiais/);
    assert.match(html, /class="dex-bloqueio-fundo" aria-hidden="true" inert/);
    cta.click();
    assert.deepEqual(eventosDisparados, [{ tipo: EVENTO_ABRIR_TABELAS_OFICIAIS, detail: { unidadeId: "uni-B" } }]);
    // destino (troca autorizada + seção "precos"): frontend/test/abrirTabelasComerciais.test.js
  });

  test("Caso 9: a seção 'precos' de Configurações é a tela Tabelas Comerciais existente", () => {
    state.sessao.unidade = null; // sem unidade: a tela mostra o aviso próprio, sem fetch
    abrirSecaoConfiguracoes("precos");
    assert.match(pegar("#view").innerHTML, /Tabelas Comerciais/);
    assert.match(pegar("#view").innerHTML, /id="cfg-detalhe"/);
  });

  test("Caso 10: após salvar, o novo payload (oficial persistida) libera; voltar ao Dashboard rebusca o mês", () => {
    assert.ok(bloqueado(render(payload({ balcao: "E", ifood: null })).html));
    assert.equal(bloqueado(render(payload({ balcao: "E", ifood: "Z4" })).html), false);
    const src = fonte("dashboardExecutivo.js");
    // entrar na rota sempre refaz o fetch (sem cache do mês entre visitas)
    assert.match(src, /export async function renderDashboardExecutivo\(\) \{[\s\S]*?montarLayout\(\);\s*await carregarConteudo\(\);/);
  });
});

describe("Gráfico 'Comparativo de percentuais' — estado próprio, nunca herda o bloqueio", () => {
  const grafico = (html) => html.includes('id="dex-chart-ind"') && html.includes("Comparativo de percentuais");
  const notaMeta = (html) => html.includes("data-nota-meta-sem-protecao");

  test("tabela bloqueada (iFood oficial ausente) → gráfico continua renderizado, com nota da Meta ideal", () => {
    const { html } = render(payload({ balcao: "E", ifood: null }));
    assert.ok(bloqueado(html));
    assert.ok(grafico(html));
    assert.ok(notaMeta(html));
    assert.match(html, /Meta ideal de Serviços e promoções e de Total de deduções depende das tabelas oficiais/);
  });

  test("tabelas configuradas + proteção calculável → gráfico sem nota", () => {
    const { html } = render(payload({ balcao: "E", ifood: "Z4" }));
    assert.equal(bloqueado(html), false);
    assert.ok(grafico(html));
    assert.equal(notaMeta(html), false);
  });

  test("independência: tabelas configuradas mas sem preço (proteção null) → tabela LIBERADA, gráfico COM nota", () => {
    const { html } = render(payload({ balcao: "E", ifood: "Z4", protecaoPct: null }));
    assert.equal(bloqueado(html), false);
    assert.ok(notaMeta(html));
  });

  test("bloqueio da tabela + gráfico: nenhum valor real da tabela vai como texto no DOM", () => {
    const { html } = render(payload({ balcao: null, ifood: "Z4" }));
    for (const v of ["11,52", "12,63", "14,90", "39,05"]) assert.ok(!html.includes(v), `vazou ${v}`);
  });
});
