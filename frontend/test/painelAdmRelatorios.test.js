// PAINEL ADMINISTRATIVO — área Relatórios: resumo executivo, rankings,
// evolução e exportação CSV.
//
// A regra que esta suíte protege na interface: o faturamento inclui
// lançamentos em rascunho (decisão do gestor), mas NUNCA aparece como se
// estivesse confirmado — total, confirmado e provisório são visíveis e
// distintos, e a cobertura fica ao lado para dizer se o dado está completo.
//
// Rodar: node --test frontend/test/painelAdmRelatorios.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---- fake DOM --------------------------------------------------------------
function attr(tag, nome) {
  const m = new RegExp(`${nome}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}
function fakeNode(tag) {
  return {
    _tag: tag, hidden: false, disabled: /\sdisabled/.test(tag), value: attr(tag, "value") ?? "",
    dataset: {
      padmNav: attr(tag, "data-padm-nav") ?? undefined,
      padmAba: attr(tag, "data-padm-aba") ?? undefined,
      padmEscopo: attr(tag, "data-padm-escopo") ?? undefined,
      padmAcao: attr(tag, "data-padm-acao") ?? undefined,
      padmIr: attr(tag, "data-padm-ir") ?? undefined,
      id: attr(tag, "data-id") ?? undefined,
      nome: attr(tag, "data-nome") ?? undefined,
    },
    id: attr(tag, "id") ?? "",
    _l: {},
    addEventListener(ev, fn) { (this._l[ev] ||= []).push(fn); },
    dispatch(ev, arg) { (this._l[ev] ?? []).forEach((f) => f(arg ?? { preventDefault() {} })); },
    focus() {}, setSelectionRange() {}, remove() {}, click() { this.dispatch("click"); },
    closest() { return null; },
  };
}
let padmView;
function makeView() {
  const store = { nav: [], abas: [], escopos: [], acao: [], ir: [] };
  return {
    _html: "",
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      store.nav = []; store.abas = []; store.escopos = []; store.acao = []; store.ir = [];
      for (const t of this._html.match(/<[a-zA-Z][^>]*>/g) ?? []) {
        const n = fakeNode(t);
        if (n.dataset.padmNav) store.nav.push(n);
        if (n.dataset.padmAba) store.abas.push(n);
        if (n.dataset.padmEscopo) store.escopos.push(n);
        if (n.dataset.padmAcao) store.acao.push(n);
        if (n.dataset.padmIr) store.ir.push(n);
      }
    },
    _store: store,
  };
}
const criados = [];
globalThis.document = {
  querySelector: (sel) => {
    if (sel === "#padm-view") return padmView;
    const a = /\[data-padm-acao="([^"]+)"\]/.exec(sel);
    if (a) return padmView._store.acao.find((n) => n.dataset.padmAcao === a[1]) ?? null;
    return null;
  },
  querySelectorAll: (sel) => {
    if (sel === "[data-padm-nav]") return padmView._store.nav;
    if (sel === "[data-padm-aba]") return padmView._store.abas;
    if (sel === "[data-padm-escopo]") return padmView._store.escopos;
    if (sel === "[data-padm-ir]") return padmView._store.ir;
    return [];
  },
  createElement: () => { const n = fakeNode("<a>"); criados.push(n); return n; },
  body: { appendChild() {} },
};
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
// Blob/URL para o CSV
const blobs = [];
globalThis.Blob = class { constructor(partes, o) { this.partes = partes; this.type = o?.type; blobs.push(this); } };
globalThis.URL = { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} };

const V = await import("../src/painelAdmViews.js");
const UI = await import("../src/painelAdmUi.js");

beforeEach(() => { padmView = makeView(); blobs.length = 0; criados.length = 0; V.resetFiltrosIdentificacao(); });

// ---- fixtures --------------------------------------------------------------
const fatur = (total, provisorio = 0) => ({
  total, confirmado: total - provisorio, provisorio, incluiProvisorio: provisorio > 0,
});
const cob = (c, e) => ({ completos: c, esperados: e, taxa: e ? c / e : null });

const RELATORIO = {
  periodo: "2026-09", mesCorrente: true, d1: "2026-09-15", dataReferencia: "2026-09-16",
  operacao: { empresasMonitoradas: 3, unidadesMonitoradas: 3, empresasComPendencia: 1, unidadesComPendencia: 1, criticas: 1, atencao: 0, emDia: 2 },
  conformidade: { d1: 0.66, mes: 0.94, mesCompleto: 44, mesEsperado: 45 },
  faturamento: {
    total: 28500, confirmado: 28200, provisorio: 300, incluiProvisorio: true,
    cobertura: cob(44, 45),
    liderEmpresa: { organizacaoId: "o1", nome: "Alfa", total: 15000 },
    liderUnidade: { unidadeId: "u1", nome: "Alfa Centro", empresaNome: "Alfa", total: 15000 },
  },
  comparacao: {
    periodo: "2026-08", ate: "2026-08-15", diasEquivalentes: 15,
    faturamento: { anterior: 25500, variacao: 0.11764705882352941, incluiProvisorio: true },
    conformidadeMes: { anterior: 0.9, variacaoPP: 0.04 },
    pendencias: { anterior: 3, variacao: -2 },
  },
  prioridades: {
    empresas: [{ organizacaoId: "o3", empresaNome: "Gama", unidadesPendentes: 1, criticas: 1, atencao: 0, pendenciaMaisAntiga: "2026-09-10", piorUnidade: { unidadeNome: "Gama Praia" } }],
    unidades: [],
  },
  rankings: {
    faturamentoEmpresas: [
      { posicao: 1, id: "o1", nome: "Alfa", faturamento: fatur(15000), cobertura: cob(15, 15), conformidadeMes: 1 },
      { posicao: 2, id: "o2", nome: "Beta", faturamento: fatur(9000), cobertura: cob(15, 15), conformidadeMes: 0.61 },
      { posicao: 3, id: "o3", nome: "Gama", faturamento: fatur(4500, 300), cobertura: cob(14, 15), conformidadeMes: 0.93 },
    ],
    faturamentoUnidades: [
      { posicao: 1, id: "u1", nome: "Alfa Centro", empresaNome: "Alfa", faturamento: fatur(15000), cobertura: cob(15, 15), conformidadeMes: 1 },
    ],
    conformidadeEmpresas: [
      { posicao: 1, id: "o1", nome: "Alfa", conformidadeMes: 1, cobertura: cob(15, 15), faturamento: fatur(15000) },
      { posicao: 2, id: "o3", nome: "Gama", conformidadeMes: 0.93, cobertura: cob(14, 15), faturamento: fatur(4500, 300) },
    ],
    atencaoEmpresas: [
      { posicao: 1, id: "o2", nome: "Beta", conformidadeMes: 0.61, cobertura: cob(9, 15), faturamento: fatur(9000) },
    ],
  },
};

const EVOLUCAO = {
  periodo: "2026-09",
  serie: [
    { data: "2026-09-01", acumulado: 1900, valor: 1900 },
    { data: "2026-09-02", acumulado: 3800, valor: 1900 },
    { data: "2026-09-03", acumulado: null, valor: null },
    { data: "2026-09-04", acumulado: 7600, valor: 3800 },
  ],
};

// ===========================================================================
// 1) confirmado x provisório — a decisão do gestor, visível
// ===========================================================================
describe("separação confirmado / provisório", () => {
  test("o resumo mostra total, confirmado e provisório, os três — SEMPRE com centavos", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, { aba: "resumo", escopo: "empresas" });
    assert.match(h, /R\$\s*28\.500,00/);
    assert.match(h, /Confirmado/);
    assert.match(h, /R\$\s*28\.200,00/);
    assert.match(h, /Provisório/);
    assert.match(h, /R\$\s*300,00/);
  });

  test("o selo de provisório aparece com valor exato (2 casas), sem tom de erro", () => {
    const h = UI.seloProvisorio({ provisorio: 18200, incluiProvisorio: true });
    assert.match(h, /padm-provisorio/);
    assert.match(h, /não finalizados/i);
    assert.match(h, /R\$\s*18\.200,00/);
    assert.ok(!/erro|falha|inválid/i.test(h), "rascunho é estado operacional, não erro");
  });

  test("sem rascunho, nenhum selo é renderizado", () => {
    assert.equal(UI.seloProvisorio({ provisorio: 0, incluiProvisorio: false }), "");
    assert.equal(UI.seloProvisorio(null), "");
  });

  test("o ranking sinaliza a parte provisória do item", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, { aba: "faturamento", escopo: "empresas" });
    assert.match(h, /Gama/);
    assert.match(h, /padm-provisorio/, "a Gama tem R$ 300 em rascunho");
  });
});

// ===========================================================================
// 2) ranking: ordem por total, cobertura ao lado
// ===========================================================================
describe("ranking de faturamento", () => {
  test("mantém a ordem recebida do backend e numera as posições", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, { aba: "faturamento", escopo: "empresas" });
    assert.ok(h.indexOf("Alfa") < h.indexOf("Beta"));
    assert.ok(h.indexOf("Beta") < h.indexOf("Gama"));
    assert.match(h, />01</);
    assert.match(h, />02</);
  });

  test("cobertura aparece junto do valor — dado incompleto não fica escondido", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, { aba: "faturamento", escopo: "empresas" });
    assert.match(h, /14\/15 dias · 93%/, "a Gama lançou 14 de 15 dias");
    assert.match(h, /15\/15 dias · 100%/);
  });

  test("faturamento e conformidade lado a lado, sem score misto", () => {
    const h = UI.linhaRanking(RELATORIO.rankings.faturamentoEmpresas[1], { tipo: "faturamento" });
    assert.match(h, /R\$\s*9\.000/);
    assert.match(h, /61% conformidade/, "vende bem, administra pior — os dois visíveis");
  });

  test("escopo=unidades mostra a empresa dona da unidade", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, { aba: "faturamento", escopo: "unidades" });
    assert.match(h, /Alfa Centro/);
    assert.match(h, /<small>Alfa<\/small>/);
  });

  test("trocar o escopo repinta sem nova chamada de rede", async () => {
    let chamadas = 0;
    V.ligarNavegacao({ abrirEmpresa: () => {}, abrirUnidade: () => {}, voltar: () => {}, irParaTela: () => {} });
    const api = {
      relatorioResumo: async () => { chamadas++; return RELATORIO; },
      relatorioEvolucao: async () => EVOLUCAO,
    };
    await V.renderViewPadm({ tipo: "tela", id: "relatorios" }, { api, mes: "2026-09" });
    assert.equal(chamadas, 1);
    padmView._store.abas.find((b) => b.dataset.padmAba === "faturamento").dispatch("click");
    padmView._store.escopos.find((b) => b.dataset.padmEscopo === "unidades").dispatch("click");
    assert.equal(chamadas, 1, "abas e escopo são leitura local");
    assert.equal(V.viewRelatorios.escopo, "unidades");
    assert.match(padmView.innerHTML, /Alfa Centro/);
  });

  test("cada linha do ranking navega para a empresa/unidade", () => {
    padmView.innerHTML = V.htmlRelatorios(RELATORIO, EVOLUCAO, { aba: "faturamento", escopo: "empresas" });
    const alvos = padmView._store.nav.filter((n) => n.dataset.padmNav === "empresa");
    assert.ok(alvos.some((n) => n.dataset.id === "o1"));
  });
});

// ===========================================================================
// 3) conformidade: melhores e "maior atenção" (sem humilhação)
// ===========================================================================
describe("ranking de conformidade", () => {
  test("mostra melhores e maior atenção necessária", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, { aba: "conformidade", escopo: "empresas" });
    assert.match(h, /Melhores em conformidade/);
    assert.match(h, /Maior atenção necessária/);
    assert.ok(!/pior|piores|humilha/i.test(h), "linguagem gerencial, não punitiva");
  });

  test("a conformidade é o valor principal e o faturamento o secundário", () => {
    const h = UI.linhaRanking(RELATORIO.rankings.conformidadeEmpresas[0], { tipo: "conformidade" });
    assert.match(h, /<b>100%<\/b>/);
    assert.match(h, /R\$\s*15\.000/);
  });
});

// ===========================================================================
// 4) comparação com o período equivalente
// ===========================================================================
describe("comparação com o mês anterior", () => {
  test("mostra a variação e deixa claro que são os mesmos dias", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, { aba: "resumo", escopo: "empresas" });
    assert.match(h, /\+11,8%/);
    assert.match(h, /Agosto 2026/);
    assert.match(h, /mesmos 15 dias/);
  });

  test("a variação de PENDÊNCIAS é contagem, não percentual", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, { aba: "resumo", escopo: "empresas" });
    // comparacao.pendencias.variacao = -2  ->  "-2", jamais "-200%"
    assert.match(h, /↓ -2 vs Agosto 2026/);
    assert.ok(!/-200,0%/.test(h), "contagem formatada como percentual seria absurda");
  });

  test("avisa quando a comparação inclui dado não finalizado", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, { aba: "resumo", escopo: "empresas" });
    assert.match(h, /inclui dados não finalizados/i);
  });

  test("sem comparação possível, nenhuma variação é inventada", () => {
    const h = V.htmlRelatorios({ ...RELATORIO, comparacao: null }, EVOLUCAO, { aba: "resumo", escopo: "empresas" });
    assert.ok(!/vs Agosto/.test(h));
    assert.match(h, /R\$\s*28\.500/, "o valor do período continua lá");
  });

  test("fmtVariacao / tomVariacao: null nunca vira 0%", () => {
    assert.equal(UI.fmtVariacao(null), "");
    assert.equal(UI.fmtVariacao(0.073), "+7,3%");
    assert.equal(UI.fmtVariacao(-0.05), "-5,0%");
    assert.equal(UI.tomVariacao(null).classe, "neutro");
    assert.equal(UI.tomVariacao(0.1).classe, "ok");
    assert.equal(UI.tomVariacao(-0.1).classe, "critico");
    // para pendências, cair é bom
    assert.equal(UI.tomVariacao(-2, { maiorEhMelhor: false }).classe, "ok");
  });
});

// ===========================================================================
// 5) evolução
// ===========================================================================
describe("evolução do faturamento", () => {
  test("desenha uma barra por dia e marca o dia sem lançamento como vazio", () => {
    const h = UI.barrasEvolucao(EVOLUCAO.serie);
    assert.equal((h.match(/class="padm-barra"/g) ?? []).length, 3, "3 dias com valor");
    assert.equal((h.match(/padm-barra--vazia/g) ?? []).length, 1, "1 dia sem lançamento");
    assert.match(h, /sem lançamento/);
  });

  test("a aba resume acumulado, média por dia lançado e melhor dia", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, { aba: "evolucao", escopo: "empresas" });
    assert.match(h, /Faturamento acumulado/);
    assert.match(h, /Média por dia lançado/);
    assert.match(h, /3 dia\(s\) com lançamento/, "a média ignora o dia vazio");
    assert.match(h, /Melhor dia/);
    assert.match(h, /04\/09\/2026/);
  });

  test("série vazia não quebra", () => {
    const h = V.htmlRelatorios(RELATORIO, { serie: [] }, { aba: "evolucao", escopo: "empresas" });
    assert.match(h, /Sem série no período/i);
  });
});

// ===========================================================================
// 6) CSV
// ===========================================================================
describe("exportação CSV", () => {
  test("monta as seções do relatório, com separador ';'", () => {
    const csv = V.csvDoRelatorio(RELATORIO);
    assert.match(csv, /Relatório Executivo/);
    assert.match(csv, /OPERAÇÃO/);
    assert.match(csv, /CONFORMIDADE/);
    assert.match(csv, /FINANCEIRO/);
    assert.match(csv, /RANKING — FATURAMENTO \(EMPRESAS\)/);
    assert.match(csv, /MAIOR ATENÇÃO NECESSÁRIA/);
    assert.match(csv, /Empresas monitoradas;3/);
  });

  test("o CSV separa total, confirmado e provisório", () => {
    const csv = V.csvDoRelatorio(RELATORIO);
    assert.match(csv, /Faturamento total;/);
    assert.match(csv, /Faturamento confirmado;/);
    assert.match(csv, /Faturamento provisório \(não finalizado\);/);
    assert.match(csv, /Aviso;A comparação inclui dados não finalizados/);
  });

  test("campos com ';' ou aspas são escapados", () => {
    assert.equal(V.csvCampo("Alfa; Beta"), '"Alfa; Beta"');
    assert.equal(V.csvCampo('Diz "oi"'), '"Diz ""oi"""');
    assert.equal(V.csvCampo("simples"), "simples");
    assert.equal(V.csvCampo(null), "");
  });

  test("o botão gera um Blob de CSV, sem biblioteca externa", async () => {
    V.ligarNavegacao({ abrirEmpresa: () => {}, abrirUnidade: () => {}, voltar: () => {}, irParaTela: () => {} });
    const api = { relatorioResumo: async () => RELATORIO, relatorioEvolucao: async () => EVOLUCAO };
    await V.renderViewPadm({ tipo: "tela", id: "relatorios" }, { api, mes: "2026-09" });
    document.querySelector('[data-padm-acao="csv"]').dispatch("click");
    assert.equal(blobs.length, 1);
    assert.match(blobs[0].type, /text\/csv/);
    assert.match(String(blobs[0].partes[0]), /Relatório Executivo/);
    assert.equal(criados[criados.length - 1]._tag, "<a>");
  });
});

// ===========================================================================
// 7) Visão Geral — faixa financeira
// ===========================================================================
describe("faixa financeira na Visão Geral", () => {
  const VISAO = {
    periodo: "2026-09", mesCorrente: true, dataReferencia: "2026-09-16", d1: "2026-09-15",
    resumo: {
      unidadesMonitoradas: 3, empresasMonitoradas: 3, concluidasD1: 2, emPreenchimentoD1: 1,
      naoRealizadasD1: 0, sequenciaBloqueadaD1: 0, criticas: 1, atencao: 0, emDia: 2,
      conformidadeD1: 0.66, conformidadeMes: 0.94, mesCompleto: 44, mesEsperado: 45,
      empresasComPendencia: 1, unidadesComPendencia: 1, empresasSaudaveis: 2,
    },
    acaoNecessariaHoje: [], empresas: [],
    faturamento: RELATORIO.faturamento,
  };

  test("mostra o total, a cobertura e os líderes", () => {
    const h = V.htmlVisaoGeral(VISAO);
    assert.match(h, /Faturamento da rede/);
    assert.match(h, /R\$\s*28\.500/);
    assert.match(h, /44\/45 dias/);
    assert.match(h, /Empresa líder/);
    assert.match(h, /Alfa/);
    assert.match(h, /Unidade líder/);
  });

  test("a pendência continua ACIMA do dinheiro (o painel é de monitoramento)", () => {
    const h = V.htmlVisaoGeral(VISAO);
    assert.ok(h.indexOf("Unidades com pendência") < h.indexOf("Faturamento da rede"));
  });

  test("sinaliza o provisório também na home", () => {
    assert.match(V.htmlVisaoGeral(VISAO), /padm-provisorio/);
  });

  test("sem faturamento no período, a faixa some (não mostra R$ 0)", () => {
    const h = V.htmlVisaoGeral({ ...VISAO, faturamento: { total: null } });
    assert.ok(!/Faturamento da rede/.test(h));
  });

  test("o atalho 'Ver relatórios' leva para a área de relatórios", () => {
    padmView.innerHTML = V.htmlVisaoGeral(VISAO);
    const ir = padmView._store.ir.find((n) => n.dataset.padmIr === "relatorios");
    assert.ok(ir, "há um atalho para Relatórios");
  });
});

// ===========================================================================
// 8) formatação de dinheiro
// ===========================================================================
describe("formatação de dinheiro — fmtDinheiro, helper ÚNICO da área Relatórios", () => {
  test("sempre 2 casas decimais no padrão pt-BR (só apresentação, não arredonda o dado)", () => {
    assert.equal(UI.fmtDinheiro(153632), "R$ 153.632,00");
    assert.equal(UI.fmtDinheiro(153632.47), "R$ 153.632,47");
    assert.equal(UI.fmtDinheiro(228320), "R$ 228.320,00");
    assert.equal(UI.fmtDinheiro(25584.37), "R$ 25.584,37");
  });

  test("zero real -> R$ 0,00 ; null/vazio/NaN -> '—' (nunca R$ 0,00 artificial)", () => {
    assert.equal(UI.fmtDinheiro(0), "R$ 0,00");
    assert.equal(UI.fmtDinheiro(null), "—");
    assert.equal(UI.fmtDinheiro(undefined), "—");
    assert.equal(UI.fmtDinheiro(""), "—");
    assert.equal(UI.fmtDinheiro("abc"), "—");
  });

  test("fmtDinheiroExato foi consolidado em fmtDinheiro (não existe mais)", () => {
    assert.equal(UI.fmtDinheiroExato, undefined);
  });

  test("forma curta (só Visão Geral) continua abreviando", () => {
    assert.equal(UI.fmtDinheiroCurto(null), "—");
    assert.equal(UI.fmtDinheiroCurto(4287430), "R$ 4,3 mi");
    assert.equal(UI.fmtDinheiroCurto(412350), "R$ 412,4 mil");
  });

  test("cobertura em texto", () => {
    assert.equal(UI.textoCobertura(cob(28, 30)), "28/30 dias · 93%");
    assert.equal(UI.textoCobertura(cob(0, 0)), "");
    assert.equal(UI.textoCobertura(null), "");
  });
});
