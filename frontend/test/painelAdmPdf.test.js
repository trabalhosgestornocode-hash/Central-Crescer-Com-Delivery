// RELATÓRIO EXECUTIVO EM PDF — template, modal e geração.
//
// O PDF é camada de APRESENTAÇÃO: não recalcula status, pendência nem
// faturamento. Estes testes protegem isso (nenhum número é derivado aqui,
// todos vêm do contrato) e cobrem os itens 28.1–28.15 do pedido.
//
// Rodar: node --test frontend/test/painelAdmPdf.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---- fake DOM --------------------------------------------------------------
function attr(tag, nome) {
  const m = new RegExp(`${nome}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}
function fakeNode(tag) {
  return {
    _tag: tag, hidden: false, disabled: /\sdisabled/.test(tag), checked: /\schecked/.test(tag),
    dataset: {
      padmAcao: attr(tag, "data-padm-acao") ?? undefined,
      padmSecao: attr(tag, "data-padm-secao") ?? undefined,
      padmAba: attr(tag, "data-padm-aba") ?? undefined,
    },
    id: attr(tag, "id") ?? "",
    style: { cssText: "" },
    _l: {},
    addEventListener(ev, fn) { (this._l[ev] ||= []).push(fn); },
    dispatch(ev, arg) { (this._l[ev] ?? []).forEach((f) => f(arg ?? {})); },
    setAttribute() {}, remove() { this._removido = true; }, focus() {}, click() { this.dispatch("click"); },
    closest() { return null; },
  };
}
function caixa(id) {
  const store = { nodes: [] };
  return {
    id, hidden: true, _html: "",
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      store.nodes = (this._html.match(/<[a-zA-Z][^>]*>/g) ?? []).map(fakeNode);
    },
    _store: store,
  };
}
let padmView, padmModal;
const iframes = [];
const abertas = [];
globalThis.document = {
  querySelector: (sel) => {
    if (sel === "#padm-view") return padmView;
    if (sel === "#padm-modal") return padmModal;
    const a = /\[data-padm-acao="([^"]+)"\]/.exec(sel);
    if (a) return padmModal._store.nodes.find((n) => n.dataset.padmAcao === a[1])
      ?? padmView._store?.nodes?.find((n) => n.dataset.padmAcao === a[1]) ?? null;
    return null;
  },
  querySelectorAll: (sel) => {
    const a = /\[data-padm-acao="([^"]+)"\]/.exec(sel);
    if (a) return padmModal._store.nodes.filter((n) => n.dataset.padmAcao === a[1]);
    if (sel === "[data-padm-secao]") return padmModal._store.nodes.filter((n) => n.dataset.padmSecao);
    return [];
  },
  createElement: (t) => {
    const n = fakeNode(`<${t}>`);
    if (t === "iframe") iframes.push(n);
    return n;
  },
  body: { appendChild() {} },
};
globalThis.window = { open: () => { const d = { write(h) { abertas.push(h); }, close() {} }; return { document: d }; } };
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.Blob = class { constructor(p, o) { this.partes = p; this.type = o?.type; } };
globalThis.URL = { createObjectURL: () => "blob:x", revokeObjectURL: () => {} };

const PDF = await import("../src/painelAdmPdf.js");
const V = await import("../src/painelAdmViews.js");

beforeEach(() => {
  padmView = caixa("padm-view"); padmView._store = { nodes: [] };
  padmView.innerHTML = "";
  padmModal = caixa("padm-modal");
  iframes.length = 0; abertas.length = 0;
  V.resetSecoesPdf();
});

// ---- fixture: o contrato de /relatorios/executivo --------------------------
const fat = (t, p = 0) => ({ total: t, confirmado: t - p, provisorio: p, incluiProvisorio: p !== 0 });
const cob = (c, e) => ({ completos: c, esperados: e, taxa: e ? c / e : null });

const PASTEL = {
  organizacaoId: "o9", empresaNome: "Pastel Di Féra Sim - Feira de Santana - BA",
  unidadesMonitoradas: 1, unidadesPendentes: 0, criticas: 0, atencao: 0, emDia: 1,
  conformidadeD1: 1, conformidadeMes: 1, d1Ok: true, severidade: 2,
  pendenciaMaisAntiga: null, piorUnidade: null, pendentes: [],
  historicoAnterior: { existe: true, desde: "2026-08-29", unidades: 1 },
  faturamento: fat(212400), cobertura: cob(15, 15),
};
const MOGI = {
  organizacaoId: "o1", empresaNome: "Subway Mogi Mirim",
  unidadesMonitoradas: 4, unidadesPendentes: 2, criticas: 1, atencao: 1, emDia: 2,
  conformidadeD1: 0.5, conformidadeMes: 0.67, d1Ok: false, severidade: 0,
  pendenciaMaisAntiga: "2026-09-01",
  piorUnidade: { unidadeId: "u1", unidadeNome: "Mogi Centro" },
  historicoAnterior: { existe: false, desde: null, unidades: 0 },
  pendentes: [
    { unidadeId: "u1", unidadeNome: "Mogi Centro", criticidade: "critico", d1Status: "sequencia_bloqueada", diasPendentes: 2, pendenciaMaisAntiga: "2026-09-01", pendenciaHerdada: true, pendenciaHerdadaDesde: "2026-08-26", conformidadeMes: 0.5 },
    { unidadeId: "u2", unidadeNome: "Mogi Shopping", criticidade: "atencao", d1Status: "em_preenchimento", diasPendentes: 1, pendenciaMaisAntiga: "2026-09-04", pendenciaHerdada: false, pendenciaHerdadaDesde: null, conformidadeMes: 0.9 },
  ],
  faturamento: fat(1412350, 185430), cobertura: cob(58, 60),
};

const DADOS = {
  monitor: "dashboard_ifood", monitorNome: "Dashboard iFood",
  periodo: "2026-09", mesCorrente: true, d1: "2026-09-15", dataReferencia: "2026-09-16",
  geradoEm: "2026-09-16T14:32:00.000Z",
  operacao: {
    empresasMonitoradas: 2, unidadesMonitoradas: 5, empresasComPendencia: 1, empresasEmDia: 1,
    unidadesComPendencia: 2, criticas: 1, atencao: 1, emDia: 3,
  },
  conformidade: { d1: 0.6, mes: 0.82, mesCompleto: 60, mesEsperado: 73, d1Concluidas: 3, d1Elegiveis: 5 },
  faturamento: {
    total: 1624750, confirmado: 1439320, provisorio: 185430, incluiProvisorio: true,
    cobertura: cob(73, 75),
    liderEmpresa: { organizacaoId: "o1", nome: "Subway Mogi Mirim", total: 1412350 },
    liderUnidade: { unidadeId: "u1", nome: "Mogi Centro", empresaNome: "Subway Mogi Mirim", total: 487200 },
  },
  comparacao: {
    periodo: "2026-08", ate: "2026-08-15", diasEquivalentes: 15,
    faturamento: { anterior: 1512000, variacao: 0.0745, incluiProvisorio: true },
    conformidadeMes: { anterior: 0.78, variacaoPP: 0.04 },
    pendencias: { anterior: 4, variacao: -2 },
  },
  evolucao: [
    { data: "2026-09-01", acumulado: 100000, valor: 100000 },
    { data: "2026-09-02", acumulado: 210000, valor: 110000 },
    { data: "2026-09-03", acumulado: null, valor: null },
    { data: "2026-09-04", acumulado: 300000, valor: 90000 },
  ],
  empresas: { emDia: [PASTEL], comPendencia: [MOGI], todas: [MOGI, PASTEL] },
  unidades: [
    { organizacaoId: "o1", empresaNome: "Subway Mogi Mirim", unidadeId: "u1", unidadeNome: "Mogi Centro", d1Status: "sequencia_bloqueada", criticidade: "critico", diasPendentes: 2, pendenciaMaisAntiga: "2026-09-01", conformidadeMes: 0.5, faturamento: fat(487200), cobertura: cob(14, 15), historicoAnterior: { existe: true, desde: "2026-08-26" } },
    { organizacaoId: "o9", empresaNome: "Pastel Di Féra Sim - Feira de Santana - BA", unidadeId: "u9", unidadeNome: "Feira de Santana", d1Status: "concluido", criticidade: "em_dia", diasPendentes: 0, pendenciaMaisAntiga: null, conformidadeMes: 1, faturamento: fat(212400), cobertura: cob(15, 15), historicoAnterior: { existe: true, desde: "2026-08-29" } },
  ],
  prioridades: [
    { organizacaoId: "o1", empresaNome: "Subway Mogi Mirim", unidadeId: "u1", unidadeNome: "Mogi Centro", criticidade: "critico", d1Status: "sequencia_bloqueada", diasPendentes: 2, pendenciaMaisAntiga: "2026-09-01", pendenciaHerdada: true, pendenciaHerdadaDesde: "2026-08-26" },
  ],
  rankings: {
    faturamentoEmpresas: [
      { posicao: 1, id: "o1", nome: "Subway Mogi Mirim", faturamento: fat(1412350, 185430), cobertura: cob(58, 60), conformidadeMes: 0.67 },
      { posicao: 2, id: "o9", nome: "Pastel Di Féra Sim - Feira de Santana - BA", faturamento: fat(212400), cobertura: cob(15, 15), conformidadeMes: 1 },
    ],
    faturamentoUnidades: [
      { posicao: 1, id: "u1", nome: "Mogi Centro", empresaNome: "Subway Mogi Mirim", faturamento: fat(487200), cobertura: cob(14, 15), conformidadeMes: 0.5 },
    ],
    conformidadeEmpresas: [{ posicao: 1, id: "o9", nome: "Pastel Di Féra Sim - Feira de Santana - BA", conformidadeMes: 1, unidadesPendentes: 0, cobertura: cob(15, 15), faturamento: fat(212400) }],
    atencaoEmpresas: [{ posicao: 1, id: "o1", nome: "Subway Mogi Mirim", conformidadeMes: 0.67, unidadesPendentes: 2, cobertura: cob(58, 60), faturamento: fat(1412350, 185430) }],
  },
};

const doc = (sec) => PDF.documentoPdf(DADOS, sec ?? PDF.secoesPadrao());
const antesDe = (h, a, b) => h.indexOf(a) > -1 && h.indexOf(b) > -1 && h.indexOf(a) < h.indexOf(b);

// ===========================================================================
// 1) período
// ===========================================================================
describe("1) o relatório usa o período selecionado", () => {
  test("capa e cabeçalho trazem o período por extenso", () => {
    const h = doc();
    assert.match(h, /Setembro 2026/);
    assert.match(h, /Relatório Executivo/);
    assert.match(h, /Dashboard iFood/);
  });

  test("mostra o fechamento monitorado e a data de geração", () => {
    const h = doc();
    assert.match(h, /Fechamento monitorado:.*15\/09\/2026/s);
    assert.match(h, /Gerado em 16\/09\/2026/);
  });

  test("mês fechado é sinalizado na capa", () => {
    const h = PDF.documentoPdf({ ...DADOS, mesCorrente: false }, PDF.secoesPadrao());
    assert.match(h, /mês fechado/);
  });

  test("a capa usa a LOGO OFICIAL, o mesmo asset do favicon", () => {
    const h = doc();
    assert.match(h, /assets\/logo-crescercomdeliverylogin\.png/);
    assert.match(h, /class="capa-logo"/);
    // object-fit: contain -> nunca deforma
    assert.match(PDF.cssRelatorioPdf(), /\.capa-logo\s*\{[^}]*object-fit:\s*contain/s);
  });

  test("a URL da logo sai pela ORIGEM — nunca um localhost fixo", () => {
    assert.ok(!/localhost|127\.0\.0\.1|:5599/.test(PDF.LOGO_URL), "nada de host fixo");
    assert.match(PDF.LOGO_URL, /\/assets\/logo-crescercomdeliverylogin\.png$/);
  });

  test("a impressão espera as imagens carregarem", () => {
    const h = doc();
    assert.match(h, /document\.images/);
    assert.match(h, /sairia em[\s\S]{0,40}branco/);
  });

  test("o título do documento define o nome sugerido do arquivo", () => {
    assert.match(doc(), /<title>Crescer-com-Delivery_Relatorio-Executivo_2026-09<\/title>/);
  });
});

// ===========================================================================
// 2/3/4) empresas em dia × com pendência
// ===========================================================================
describe("2/3/4) empresas na seção correta", () => {
  test("a empresa com pendência entra em 'Empresas com pendências'", () => {
    const h = doc();
    const sec = h.slice(h.indexOf("Empresas com pendências"), h.indexOf("Empresas em dia"));
    assert.match(sec, /Subway Mogi Mirim/);
    assert.ok(!sec.includes("Pastel Di Féra"), "a saudável não entra na seção de problema");
    assert.match(sec, /2 de 4 unidade\(s\) com pendência/);
  });

  test("a empresa saudável entra em 'Empresas em dia', com badge positivo", () => {
    const h = doc();
    const sec = h.slice(h.indexOf("Empresas em dia"));
    assert.match(sec, /Pastel Di Féra/);
    assert.match(sec, /badge--ok">Em dia/);
  });

  test("4) pendência histórica NÃO tira a empresa de 'Empresas em dia'", () => {
    const h = doc();
    const pend = h.slice(h.indexOf("Empresas com pendências"), h.indexOf("Empresas em dia"));
    assert.ok(!pend.includes("Pastel Di Féra"), "setembro 100% continua em dia");
    // e o histórico aparece como nota, sem tom crítico
    assert.match(h, /Há histórico anterior ao período \(desde 29\/08\/2026\)/);
    assert.match(h, /não afeta a saúde deste mês/);
  });

  test("a empresa em dia mostra conformidade, faturamento e cobertura", () => {
    const h = doc();
    const sec = h.slice(h.indexOf("Empresas em dia"));
    assert.match(sec, /100%/);
    assert.match(sec, /212\.400/);
    assert.match(sec, /15\/15 dias/);
  });
});

// ===========================================================================
// 5) unidades pendentes sob a empresa correta
// ===========================================================================
describe("5) unidades pendentes detalhadas dentro da empresa", () => {
  test("as unidades aparecem dentro do bloco da própria empresa", () => {
    const h = doc();
    const bloco = h.slice(h.indexOf("Subway Mogi Mirim"), h.indexOf("Empresas em dia"));
    assert.match(bloco, /Unidades com pendência \(2\)/);
    assert.match(bloco, /Mogi Centro/);
    assert.match(bloco, /Mogi Shopping/);
    assert.match(bloco, /Sequência travada/);
    assert.match(bloco, /Em aberto/);
    assert.match(bloco, /2 dias no período/);
    assert.match(bloco, /desde 01\/09/);
  });

  test("a unidade prioritária é destacada", () => {
    assert.match(doc(), /Unidade prioritária: <b>Mogi Centro<\/b>/);
  });

  test("o histórico da unidade é secundário e diz que NÃO conta nos dias", () => {
    const h = doc();
    assert.match(h, /Pendência histórica iniciada em 26\/08/);
    assert.match(h, /não contada nos dias do período/);
  });

  test("desligar o detalhe some com as unidades, mas mantém a empresa", () => {
    const h = doc({ ...PDF.secoesPadrao(), unidadesPendentes: false });
    assert.match(h, /Subway Mogi Mirim/);
    assert.ok(!/Unidades com pendência \(2\)/.test(h));
  });
});

// ===========================================================================
// 6/7/8) faturamento e rankings
// ===========================================================================
describe("6/7/8) faturamento e rankings", () => {
  test("6) o faturamento vem pronto do contrato — o PDF não soma nada", () => {
    const h = doc();
    assert.match(h, /1\.624\.750/, "total da rede exatamente como veio");
    assert.match(h, /1\.439\.320/, "confirmado");
    assert.match(h, /73\/75 dias/, "cobertura");
  });

  test("7) ranking de empresas na ordem recebida, com posição, cobertura e conformidade", () => {
    const h = doc();
    const sec = h.slice(h.indexOf("Top empresas por faturamento"), h.indexOf("Top unidades"));
    assert.ok(antesDe(sec, "Subway Mogi Mirim", "Pastel Di Féra"));
    assert.match(sec, />01</);
    assert.match(sec, /58\/60 dias/);
    assert.match(sec, /67%/);
    assert.match(sec, /snapshot financeiro mais recente/, "a regra fica explícita no documento");
  });

  test("8) ranking de unidades traz a empresa dona", () => {
    const h = doc();
    const sec = h.slice(h.indexOf("Top unidades por faturamento"));
    assert.match(sec, /Mogi Centro/);
    assert.match(sec, /Subway Mogi Mirim/);
    assert.match(sec, /487\.200/);
  });

  test("ranking de conformidade usa linguagem gerencial", () => {
    const h = doc();
    assert.match(h, /Melhores em conformidade/);
    assert.match(h, /Maior atenção necessária/);
    assert.ok(!/piores/i.test(h));
  });
});

// ===========================================================================
// 9) provisório positivo e negativo
// ===========================================================================
describe("9) ajuste provisório com sinal", () => {
  test("positivo -> 'inclui R$ X provisórios' (com centavos)", () => {
    const h = doc();
    assert.match(h, /inclui R\$\s*185\.430,00 provisórios/);
  });

  test("negativo -> 'ajuste provisório de -R$ X', nunca 'não finalizado'", () => {
    const neg = {
      ...DADOS,
      faturamento: { ...DADOS.faturamento, total: 1400000, confirmado: 1439320, provisorio: -39320, incluiProvisorio: true },
    };
    const h = PDF.documentoPdf(neg, PDF.secoesPadrao());
    assert.match(h, /ajuste provisório de -R\$\s*39\.320/);
    assert.ok(!/-R\$\s*39\.320 provisórios/.test(h), "correção para baixo não é 'provisório a mais'");
  });

  test("sem provisório, nenhum selo", () => {
    const semProv = (f) => ({ ...f, confirmado: f.total, provisorio: 0, incluiProvisorio: false });
    const zero = {
      ...DADOS,
      faturamento: semProv(DADOS.faturamento),
      empresas: { ...DADOS.empresas, comPendencia: [{ ...MOGI, faturamento: semProv(MOGI.faturamento) }] },
      rankings: {
        ...DADOS.rankings,
        faturamentoEmpresas: DADOS.rankings.faturamentoEmpresas.map((i) => ({ ...i, faturamento: semProv(i.faturamento) })),
        atencaoEmpresas: DADOS.rankings.atencaoEmpresas.map((i) => ({ ...i, faturamento: semProv(i.faturamento) })),
      },
    };
    const h = PDF.documentoPdf(zero, PDF.secoesPadrao());
    assert.ok(!/provisórios|ajuste provisório/.test(h));
  });

  test("o gráfico desenha delta negativo abaixo da linha zero", () => {
    const comNeg = { ...DADOS, evolucao: [
      { data: "2026-09-01", acumulado: 100000, valor: 100000 },
      { data: "2026-09-02", acumulado: 60000, valor: -40000 },
    ] };
    const h = PDF.documentoPdf(comNeg, PDF.secoesPadrao());
    assert.match(h, /g-barra-neg/, "barra negativa tem classe própria");
    assert.match(h, /g-zero/, "há linha de zero");
  });

  test("dia sem lançamento vira vazio, nunca interpolado", () => {
    const h = doc();
    assert.match(h, /g-vazio/);
    assert.match(h, /nunca estimado/);
  });
});

// ===========================================================================
// 10/11) conformidade e comparação equivalente
// ===========================================================================
describe("10/11) conformidade e comparação", () => {
  test("10) conformidade D-1 e do mês com os denominadores", () => {
    const h = doc();
    assert.match(h, /60%/);
    assert.match(h, /3 de 5/);
    assert.match(h, /82%/);
    assert.match(h, /60 de 73 dias/);
  });

  test("11) a comparação é de período EQUIVALENTE, e diz isso", () => {
    const h = doc();
    assert.match(h, /Agosto 2026 \(1–15\)/);
    assert.match(h, /mesmos 15 dias/);
    assert.match(h, /\+7,4%/);   // 0.0745 -> 7,4: arredondamento de float, nao bug
    assert.match(h, /\+4,0 p\.p\./);
    assert.match(h, /inclui dados não finalizados/);
  });

  test("sem comparação, a seção não inventa variação", () => {
    const h = PDF.documentoPdf({ ...DADOS, comparacao: null }, PDF.secoesPadrao());
    assert.ok(!/mesmos \d+ dias/.test(h));
    assert.match(h, /1\.624\.750/, "o faturamento do período continua");
  });
});

// ===========================================================================
// 12) seções opcionais do modal
// ===========================================================================
describe("12) seções opcionais", () => {
  test("a tabela de unidades vem DESLIGADA por padrão", () => {
    assert.equal(PDF.secoesPadrao().tabelaUnidades, false);
    assert.ok(!/Resumo por unidade/.test(doc()));
  });

  test("ligando, a tabela completa de unidades aparece", () => {
    const h = doc({ ...PDF.secoesPadrao(), tabelaUnidades: true });
    assert.match(h, /Resumo por unidade/);
    assert.match(h, /Feira de Santana/);
  });

  test("desligar uma seção a remove sem quebrar o resto", () => {
    const h = doc({ ...PDF.secoesPadrao(), rankFaturamento: false, evolucao: false });
    assert.ok(!/Top empresas por faturamento/.test(h));
    assert.ok(!/Evolução do faturamento/.test(h));
    assert.match(h, /Resumo executivo/);
    assert.match(h, /Empresas com pendências/);
  });

  test("todas desligadas -> documento válido, só capa", () => {
    const nada = Object.fromEntries(PDF.SECOES_PDF.map((s) => [s.id, false]));
    const h = PDF.documentoPdf(DADOS, nada);
    assert.match(h, /Relatório Executivo/);
    assert.match(h, /<div id="fonte">\s*<\/div>/);
  });
});

// ===========================================================================
// 13) nome do arquivo
// ===========================================================================
describe("13) nome do arquivo", () => {
  test("segue o padrão pedido", () => {
    assert.equal(PDF.nomeArquivoPdf("2026-09"), "Crescer-com-Delivery_Relatorio-Executivo_2026-09.pdf");
  });
  test("sem período, não gera nome quebrado", () => {
    assert.equal(PDF.nomeArquivoPdf(null), "Crescer-com-Delivery_Relatorio-Executivo_periodo.pdf");
  });
});

// ===========================================================================
// 14) privacidade
// ===========================================================================
describe("14) o PDF não vaza campo sensível", () => {
  test("nenhum token, PIN, e-mail, credencial ou id interno impresso", () => {
    const h = doc({ ...PDF.secoesPadrao(), tabelaUnidades: true });
    for (const proibido of [/token/i, /\bpin\b/i, /senha/i, /credencial/i, /@[\w.-]+\.\w+/, /authorization/i, /bearer/i]) {
      assert.ok(!proibido.test(h), `vazou: ${proibido}`);
    }
  });

  test("ids internos não são impressos como texto", () => {
    const h = doc({ ...PDF.secoesPadrao(), tabelaUnidades: true });
    // os ids do fixture ("o1", "u9"…) não podem aparecer como conteúdo
    assert.ok(!/>o1</.test(h) && !/>u9</.test(h));
  });

  test("o rodapé marca o documento como uso interno", () => {
    assert.match(doc(), /Uso interno — Crescer com Delivery/);
  });
});

// ===========================================================================
// 15) paginação estrutural
// ===========================================================================
describe("15) quebra de página não destrói blocos", () => {
  test("card, empresa, unidade e gráfico têm break-inside: avoid", () => {
    const css = PDF.cssRelatorioPdf();
    for (const sel of [".k", ".emp", ".uni", ".graf", ".saude", "tr"]) {
      const alvo = sel.startsWith(".") ? "\\" + sel : sel;
      const bloco = new RegExp(alvo + "[^{]*\\{[^}]*break-inside:\\s*avoid", "s");
      assert.ok(bloco.test(css), sel + " precisa de break-inside: avoid");
    }
  });

  test("o título de seção nunca fica órfão no fim da página", () => {
    const css = PDF.cssRelatorioPdf();
    assert.match(css, /\.sec > h2[^{]*\{[^}]*break-after:\s*avoid/s);
    assert.match(css, /\.sec-sub[^{]*\{[^}]*break-after:\s*avoid/s);
  });

  test("o cabeçalho da tabela repete em cada página", () => {
    assert.match(PDF.cssRelatorioPdf(), /thead\s*\{[^}]*display:\s*table-header-group/s);
  });

  test("cada página tem altura A4 exata e força quebra", () => {
    const css = PDF.cssRelatorioPdf();
    assert.match(css, /\.pagina\s*\{[^}]*height:\s*297mm/s);
    assert.match(css, /\.pagina\s*\{[^}]*page-break-after:\s*always/s);
    assert.match(css, /@page\s*\{[^}]*size:\s*A4 portrait/s);
    // margem ZERO no @page: o recuo vive dentro da .pagina, que é o que
    // permite reservar altura física para cabeçalho e rodapé
    assert.match(css, /@page\s*\{[^}]*margin:\s*0/s);
  });

  test("cabeçalho e rodapé ocupam altura própria — NUNCA position: fixed", () => {
    const css = PDF.cssRelatorioPdf();
    // A causa raiz do PDF anterior: `position: fixed` é ancorado pelo Chrome
    // DENTRO da área de conteúdo ao imprimir, e o cabeçalho cobria as tabelas.
    assert.ok(!/\.pg-cab[^{]*\{[^}]*position:\s*fixed/s.test(css));
    assert.ok(!/\.pg-rod[^{]*\{[^}]*position:\s*fixed/s.test(css));
    assert.match(css, /\.pg-cab\s*\{[^}]*height:\s*8mm/s, "altura reservada");
    assert.match(css, /\.pg-rod\s*\{[^}]*height:\s*7mm/s, "altura reservada");
    // a página é flex-column: o miolo ocupa o que sobra, sem invadir nada
    assert.match(css, /\.pagina\s*\{[^}]*flex-direction:\s*column/s);
    assert.match(css, /\.pg-corpo\s*\{[^}]*flex:\s*1 1 auto/s);
  });

  test("a numeração NÃO usa counter(pages) — o Chrome devolve 0 fora do @page", () => {
    const h = doc();
    assert.ok(!/counter\(pages\)/.test(h), "era a origem do 'Página 0 de 0'");
    assert.ok(!/counter\(page\)/.test(h));
    // quem numera é o paginador, com o total real
    assert.match(h, /"Página " \+ \(i \+ 1\) \+ " de " \+ total/);
  });

  test("a CAPA não recebe cabeçalho, rodapé nem número de página", () => {
    const h = doc();
    const capa = h.slice(h.indexOf('class="pagina pagina--capa"'), h.indexOf("</section>"));
    assert.ok(!/pg-cab|pg-rod|pg-n/.test(capa), "capa limpa");
    assert.ok(!/Página 0 de 0/.test(h));
  });

  test("o paginador reparte tabela longa repetindo o <thead>", () => {
    const h = doc();
    assert.match(h, /function moldeTabela/, "clona a tabela só com o cabeçalho");
    assert.match(h, /sec-cont/, "marca a continuação da seção");
    assert.match(h, /continuação/);
  });

  test("o paginador evita a linha órfã na página seguinte", () => {
    const h = doc();
    assert.match(h, /nunca deixar UMA linha órfã/);
    assert.match(h, /restantes\.length === 1/);
  });
});

// ===========================================================================
// Modal + geração
// ===========================================================================
describe("modal de geração", () => {
  test("lista todas as seções, com as padrão marcadas", () => {
    const h = V.htmlModalPdf({ periodo: "2026-09" }, PDF.secoesPadrao());
    for (const s of PDF.SECOES_PDF) assert.match(h, new RegExp(`data-padm-secao="${s.id}"`));
    assert.match(h, /data-padm-secao="resumo"[^>]*checked/);
    assert.ok(!/data-padm-secao="tabelaUnidades"[^>]*checked/.test(h), "unidades desligada por padrão");
  });

  test("mostra o período e o nome sugerido do arquivo", () => {
    const h = V.htmlModalPdf({ periodo: "2026-09" });
    assert.match(h, /Setembro 2026/);
    assert.match(h, /Crescer-com-Delivery_Relatorio-Executivo_2026-09\.pdf/);
    assert.match(h, /Salvar como PDF/);
  });

  test("enquanto carrega, os botões ficam desabilitados", () => {
    const h = V.htmlModalPdf({ periodo: "2026-09", carregando: true });
    assert.match(h, /data-padm-acao="pdf-gerar"[^>]*disabled/);
    assert.match(h, /Preparando…/);
  });

  test("abrir busca o pacote e habilita a geração", async () => {
    const chamadas = [];
    const api = { relatorioExecutivo: async (a) => { chamadas.push(a); return DADOS; } };
    await V.abrirModalPdf({ api, mes: "2026-09" });
    assert.deepEqual(chamadas, [{ mes: "2026-09" }]);
    assert.equal(padmModal.hidden, false);
    assert.match(padmModal.innerHTML, /Gerar PDF/);
    assert.ok(!/disabled/.test(padmModal.innerHTML.match(/data-padm-acao="pdf-gerar"[^>]*/)[0]));
  });

  test("marcar/desmarcar uma seção altera o estado", async () => {
    await V.abrirModalPdf({ api: { relatorioExecutivo: async () => DADOS }, mes: "2026-09" });
    const opt = padmModal._store.nodes.find((n) => n.dataset.padmSecao === "evolucao");
    opt.checked = false;
    opt.dispatch("change");
    assert.equal(V.secoesPdf.evolucao, false);
  });

  test("gerar monta um iframe com o documento (sem biblioteca externa)", async () => {
    await V.abrirModalPdf({ api: { relatorioExecutivo: async () => DADOS }, mes: "2026-09" });
    document.querySelector('[data-padm-acao="pdf-gerar"]').dispatch("click");
    assert.equal(iframes.length, 1);
    assert.match(iframes[0].srcdoc, /Relatório Executivo/);
    assert.match(iframes[0].srcdoc, /Setembro 2026/);
  });

  test("visualizar abre o documento numa aba", async () => {
    await V.abrirModalPdf({ api: { relatorioExecutivo: async () => DADOS }, mes: "2026-09" });
    document.querySelector('[data-padm-acao="pdf-preview"]').dispatch("click");
    assert.equal(abertas.length, 1);
    assert.match(abertas[0], /Relatório Executivo/);
  });

  test("fechar limpa o modal", async () => {
    await V.abrirModalPdf({ api: { relatorioExecutivo: async () => DADOS }, mes: "2026-09" });
    V.fecharModalPdf();
    assert.equal(padmModal.hidden, true);
    assert.equal(padmModal.innerHTML, "");
  });

  test("erro de rede vira mensagem no modal, não tela branca", async () => {
    await V.abrirModalPdf({ api: { relatorioExecutivo: async () => { throw new Error("Failed to fetch"); } }, mes: "2026-09" });
    assert.match(padmModal.innerHTML, /Falha de conexão/);
  });

  test("403 fecha o modal e devolve à seleção de ambiente", async () => {
    let msg = null;
    V.ligarNavegacao({ abrirEmpresa: () => {}, abrirUnidade: () => {}, voltar: () => {}, aoAcessoRevogado: (m) => { msg = m; } });
    const err = Object.assign(new Error("Acesso restrito ao Painel Administrativo."), { status: 403 });
    await V.abrirModalPdf({ api: { relatorioExecutivo: async () => { throw err; } }, mes: "2026-09" });
    assert.match(msg, /Painel Administrativo/);
    assert.equal(padmModal.hidden, true);
  });
});

// ---------------------------------------------------------------------------
// CSP — o <script> inline do paginador tem hash fixado no backend.
// Se SCRIPT_PAGINADOR mudar, o hash em backend/src/config/seguranca.js
// (script-src 'sha256-...') PRECISA ser atualizado ou a CSP em enforce
// quebra o PDF. Este teste falha de propósito quando isso acontece.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("CSP hash do paginador do PDF", () => {
  test("sha256(SCRIPT_PAGINADOR) bate com o declarado no backend", () => {
    const hash = "sha256-" + crypto.createHash("sha256").update(PDF.SCRIPT_PAGINADOR, "utf8").digest("base64");
    const seg = readFileSync(path.join(import.meta.dirname, "..", "..", "backend", "src", "config", "seguranca.js"), "utf8");
    assert.ok(
      seg.includes(`'${hash}'`),
      `O hash do SCRIPT_PAGINADOR mudou.\n  Novo: '${hash}'\n  Atualize scriptSrc em backend/src/config/seguranca.js.`,
    );
  });
});
