// Visão Geral da Rede — construtor puro (htmlVisaoGeralRede) + a orquestração
// de filtros/busca (renderViewPadm -> pintarVisaoRede -> ligarVisaoRede).
//
// Mesma convenção de frontend/test/painelAdmViews.test.js: um fake DOM mínimo
// que só entende o que esta tela usa (data-vr-filtro, #vr-busca, data-padm-nav).
//
// Rodar: node --test frontend/test/painelAdmViews-visaoRede.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

function attr(tag, nome) {
  const m = new RegExp(`${nome}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}
function fakeNode(tag) {
  return {
    _tag: tag, value: attr(tag, "value") ?? "",
    dataset: {
      padmNav: attr(tag, "data-padm-nav") ?? undefined,
      vrFiltro: attr(tag, "data-vr-filtro") ?? undefined,
      id: attr(tag, "data-id") ?? undefined,
      nome: attr(tag, "data-nome") ?? undefined,
    },
    id: attr(tag, "id") ?? "",
    _l: {},
    addEventListener(ev, fn) { (this._l[ev] ||= []).push(fn); },
    dispatch(ev) { (this._l[ev] ?? []).forEach((f) => f()); },
  };
}
let padmView;
function makeView() {
  const store = { nav: [], filtros: [], busca: null };
  return {
    _html: "",
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      store.nav = []; store.filtros = []; store.busca = null;
      const tags = this._html.match(/<[a-zA-Z][^>]*>/g) ?? [];
      for (const t of tags) {
        const n = fakeNode(t);
        if (n.dataset.padmNav) store.nav.push(n);
        if (n.dataset.vrFiltro) store.filtros.push(n);
        if (n.id === "vr-busca") store.busca = n;
      }
    },
    _store: store,
  };
}
let nodes = {};
globalThis.document = {
  querySelector: (sel) => {
    if (sel === "#padm-view") return padmView;
    if (sel === "#vr-busca") return padmView._store.busca;
    return nodes[sel] ?? null;
  },
  querySelectorAll: (sel) => {
    if (sel === "[data-padm-nav]") return padmView._store.nav;
    if (sel === "[data-vr-filtro]") return padmView._store.filtros;
    return [];
  },
};
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const V = await import("../src/painelAdmViews.js");

beforeEach(() => {
  padmView = makeView(); nodes = {};
  V.ligarNavegacao({ abrirEmpresa: () => {}, abrirUnidade: () => {}, voltar: () => {} });
  V.resetFiltrosVisaoRede();
});

// ===========================================================================
// Fixtures — espelham o formato devolvido por administrativo.service.js
// (visaoGeralRede), com 2 empresas / 3 unidades: JV Loja A (marketplace, em
// dia), JV Loja B (marketplace, crítica) e Beta Sul (full_service, atenção).
// ===========================================================================
const UNI_A = {
  organizacaoId: "org-jv", empresaNome: "JV Alimentos", unidadeId: "uni-a", nome: "JV Loja A",
  modeloLogistico: "marketplace", faturamento: 12000, faturamentoAnterior: 11000, variacaoFaturamento: 0.0909,
  deducoes: 1200, deducoesPct: 10, composicaoDeducoes: { taxasComissoes: 1000, servicosPromocoes: 200, outrosAjustes: 0 },
  meta: { metaIdeal: 1000, limite: 1200 }, folgaLimitePp: 200, impactoFinanceiroEstimado: 0,
  situacaoFinanceira: { chave: "em_dia", rotulo: "Em dia" }, incluiProvisorio: false, provisorio: 0,
};
const UNI_B = {
  organizacaoId: "org-jv", empresaNome: "JV Alimentos", unidadeId: "uni-b", nome: "JV Loja B",
  modeloLogistico: "marketplace", faturamento: 9000, faturamentoAnterior: 9500, variacaoFaturamento: -0.0526,
  deducoes: 1980, deducoesPct: 22, composicaoDeducoes: { taxasComissoes: 1600, servicosPromocoes: 380, outrosAjustes: 0 },
  meta: { metaIdeal: 1000, limite: 1200 }, folgaLimitePp: -1000, impactoFinanceiroEstimado: 720,
  situacaoFinanceira: { chave: "critica", rotulo: "Crítica" }, incluiProvisorio: true, provisorio: 150,
};
const UNI_C = {
  organizacaoId: "org-beta", empresaNome: "Beta Sul", unidadeId: "uni-c", nome: "Beta Centro",
  modeloLogistico: "full_service", faturamento: 7500, faturamentoAnterior: 7400, variacaoFaturamento: 0.0135,
  deducoes: 1125, deducoesPct: 15, composicaoDeducoes: { taxasComissoes: 900, servicosPromocoes: 225, outrosAjustes: 0 },
  meta: { metaIdeal: 1000, limite: 1300 }, folgaLimitePp: -200, impactoFinanceiroEstimado: 0,
  situacaoFinanceira: { chave: "atencao", rotulo: "Atenção" }, incluiProvisorio: false, provisorio: 0,
};
const EMPRESAS = [
  { organizacaoId: "org-jv", empresaNome: "JV Alimentos", modeloLogistico: "marketplace", unidadesMonitoradas: 2, faturamento: 21000, deducoes: 3180, deducoesPct: 15.14, impactoFinanceiroEstimado: 720, situacaoFinanceira: { chave: "critica", rotulo: "Crítica" } },
  { organizacaoId: "org-beta", empresaNome: "Beta Sul", modeloLogistico: "full_service", unidadesMonitoradas: 1, faturamento: 7500, deducoes: 1125, deducoesPct: 15, impactoFinanceiroEstimado: 0, situacaoFinanceira: { chave: "atencao", rotulo: "Atenção" } },
];

const REDE_CHEIA = {
  periodo: "2026-09", mesCorrente: true,
  rede: {
    faturamento: 28500, taxasComissoes: 3500, servicosPromocoes: 805, deducoes: 4305, deducoesPct: 15.11,
    receitaLiquida: 24195, unidadesMonitoradas: 3, unidadesEmAtencao: 1, unidadesCriticas: 1,
    variacaoFaturamento: 0.0411, impactoFinanceiroTotalEstimado: 720,
  },
  distribuicaoSituacoes: { sem_dados: 0, em_dia: 1, atencao: 1, critica: 1 },
  composicaoDeducoes: { taxasComissoes: 3500, servicosPromocoes: 805, outrosAjustes: 0 },
  evolucaoMensal: [
    { mes: "2026-07", faturamento: 26000, deducoes: 3900, deducoesPct: 15, receitaLiquida: 22100, unidadesComDado: 3 },
    { mes: "2026-08", faturamento: 27200, deducoes: 4080, deducoesPct: 15, receitaLiquida: 23120, unidadesComDado: 3 },
    { mes: "2026-09", faturamento: 28500, deducoes: 4305, deducoesPct: 15.11, receitaLiquida: 24195, unidadesComDado: 3 },
  ],
  rankingPorModalidade: {
    marketplace: { melhores: [UNI_A, UNI_B], atencao: [UNI_B] },
    full_service: { melhores: [UNI_C], atencao: [UNI_C] },
  },
  unidades: [UNI_A, UNI_B, UNI_C],
  empresas: EMPRESAS,
};

const REDE_VAZIA = { periodo: "2026-09", mesCorrente: true, rede: { unidadesMonitoradas: 0 }, unidades: [], empresas: [] };

// ===========================================================================
describe("htmlVisaoGeralRede — cartões", () => {
  test("mostra os 10 indicadores com rótulo e valor formatado", () => {
    const h = V.htmlVisaoGeralRede(REDE_CHEIA);
    assert.match(h, /Faturamento bruto da rede/);
    assert.match(h, /R\$\s?28\.500,00/);
    assert.match(h, /Taxas e comissões/);
    assert.match(h, /Serviços e promoções/);
    assert.match(h, /Deduções totais/);
    assert.match(h, /% de deduções sobre faturamento/);
    assert.match(h, /Receita após deduções/);
    assert.match(h, /Unidades analisadas/);
    assert.match(h, /Unidades em atenção/);
    assert.match(h, /Unidades críticas/);
    assert.match(h, /Evolução vs\. mês anterior/);
  });

  test("cartões de atenção/crítica só ganham tom de alerta quando > 0", () => {
    const comAlerta = V.htmlVisaoGeralRede(REDE_CHEIA);
    assert.match(comAlerta, /padm-card--atencao/);
    assert.match(comAlerta, /padm-card--critico/);
    const semAlerta = V.htmlVisaoGeralRede({
      ...REDE_CHEIA,
      rede: { ...REDE_CHEIA.rede, unidadesEmAtencao: 0, unidadesCriticas: 0 },
    });
    assert.ok(!/padm-card--atencao/.test(semAlerta) && !/padm-card--critico/.test(semAlerta));
  });

  test("cada cartão tem uma nota explicando o que mostra (Fase 2.1)", () => {
    const h = V.htmlVisaoGeralRede(REDE_CHEIA);
    assert.match(h, /Deduções totais ÷ faturamento bruto da rede \(nunca a média/);
    assert.match(h, /deduções acima do limite homologado do seu modelo/);
  });
});

// ===========================================================================
describe("htmlVisaoGeralRede — filtros", () => {
  test("empresa e unidade são deduzidas de d.unidades, sem repetir", () => {
    const h = V.htmlVisaoGeralRede(REDE_CHEIA);
    assert.match(h, /<option value="org-jv"[^>]*>JV Alimentos<\/option>/);
    assert.match(h, /<option value="org-beta"[^>]*>Beta Sul<\/option>/);
    // a empresa "JV Alimentos" aparece 2x no select (2 unidades não duplicariam a opção)
    assert.equal((h.match(/<option value="org-jv"/g) ?? []).length, 1, "não duplica a opção da empresa no filtro");
  });

  test("unidade do select é restrita à empresa selecionada no filtro", () => {
    V.viewVisaoRede.organizacaoId = "org-beta";
    const h = V.htmlVisaoGeralRede(REDE_CHEIA);
    assert.match(h, /Beta Centro/);
    assert.ok(!/JV Loja A/.test(h.slice(h.indexOf('data-vr-filtro="unidadeId"'), h.indexOf("</select>", h.indexOf('data-vr-filtro="unidadeId"')))));
  });

  test("modalidade e situação têm as 2 e 4 opções fixas do motor", () => {
    const h = V.htmlVisaoGeralRede(REDE_CHEIA);
    assert.match(h, /data-vr-filtro="modalidade"/);
    assert.match(h, /<option value="marketplace"[^>]*>Marketplace<\/option>/);
    assert.match(h, /<option value="full_service"[^>]*>Full Service<\/option>/);
    assert.match(h, /data-vr-filtro="situacao"/);
    for (const v of ["em_dia", "atencao", "critica", "sem_dados"]) {
      assert.match(h, new RegExp(`<option value="${v}"`));
    }
  });
});

// ===========================================================================
describe("htmlVisaoGeralRede — distribuição de situações", () => {
  test("barra de 4 segmentos só desenha os segmentos com contagem > 0", () => {
    const h = V.htmlVisaoGeralRede(REDE_CHEIA);
    assert.match(h, /padm-saude--ok/);
    assert.match(h, /padm-saude--atencao/);
    assert.match(h, /padm-saude--critico/);
    // sem_dados = 0 no fixture -> nenhum 4º segmento cinza desenhado
    assert.ok(!/background:var\(--padm-cinza/.test(h));
  });

  test("legenda mostra as 4 contagens, mesmo quando zero", () => {
    const h = V.htmlVisaoGeralRede(REDE_CHEIA);
    assert.match(h, /padm-legenda-situacoes/);
    assert.match(h, /<i>0<\/i>sem dados/);
  });
});

// ===========================================================================
describe("htmlVisaoGeralRede — composição das deduções", () => {
  const blocoComposicao = (h) => h.slice(h.indexOf("Composição das deduções"), h.indexOf("Evolução financeira"));

  test("taxas + serviços + outros reconciliam com o total, sem dupla contagem", () => {
    const h = V.htmlVisaoGeralRede(REDE_CHEIA);
    const { taxasComissoes, servicosPromocoes, outrosAjustes } = REDE_CHEIA.composicaoDeducoes;
    const total = taxasComissoes + servicosPromocoes + outrosAjustes;
    assert.equal(total, REDE_CHEIA.rede.deducoes, "fixture consistente: composição soma o total de deduções");
    assert.match(h, /padm-composicao-barra/);
    const bloco = blocoComposicao(h);
    assert.match(bloco, /Taxas e comissões/);
    assert.match(bloco, /Serviços e promoções/);
    assert.ok(!/outros ajustes/.test(bloco), "outrosAjustes = 0 não aparece na legenda da composição");
  });

  test("outrosAjustes > 0 aparece como 3º segmento e na legenda", () => {
    const h = V.htmlVisaoGeralRede({
      ...REDE_CHEIA,
      composicaoDeducoes: { taxasComissoes: 3000, servicosPromocoes: 700, outrosAjustes: 300 },
    });
    assert.match(h, /outros ajustes/);
    assert.equal((h.match(/<i style="width:/g) ?? []).length >= 3, true);
  });

  test("sem nenhuma dedução no período -> estado vazio, sem dividir por zero", () => {
    const h = V.htmlVisaoGeralRede({ ...REDE_CHEIA, composicaoDeducoes: { taxasComissoes: 0, servicosPromocoes: 0, outrosAjustes: 0 } });
    assert.match(h, /Dados insuficientes no período/);
    assert.ok(!/NaN/.test(h));
  });
});

// ===========================================================================
describe("htmlVisaoGeralRede — evolução financeira", () => {
  test("com >= 2 meses de dado, desenha o gráfico + a tabela de precisão", () => {
    const h = V.htmlVisaoGeralRede(REDE_CHEIA);
    assert.match(h, /padm-grafico/);
    assert.match(h, /<table class="padm-tabela padm-tabela-compacta">/);
    // 3 meses no fixture -> 3 linhas na tabela de precisão
    assert.equal((h.match(/<tr><td>(Jan|Fev|Mar|Abr|Mai|Jun|Jul|Ago|Set|Out|Nov|Dez)<\/td>/g) ?? []).length, 3);
  });

  test("com menos de 2 meses de dado, mostra o aviso de histórico insuficiente (não um gráfico vazio)", () => {
    const h = V.htmlVisaoGeralRede({ ...REDE_CHEIA, evolucaoMensal: [REDE_CHEIA.evolucaoMensal[0]] });
    assert.match(h, /Dados insuficientes para montar a evolução/);
    assert.ok(!/<table class="padm-tabela padm-tabela-compacta">/.test(h));
  });

  test("meses sem nenhuma unidade com dado são descartados do gráfico", () => {
    const h = V.htmlVisaoGeralRede({
      ...REDE_CHEIA,
      evolucaoMensal: [...REDE_CHEIA.evolucaoMensal, { mes: "2026-10", faturamento: 0, deducoes: 0, deducoesPct: null, receitaLiquida: 0, unidadesComDado: 0 }],
    });
    assert.equal((h.match(/<tr><td>(Jan|Fev|Mar|Abr|Mai|Jun|Jul|Ago|Set|Out|Nov|Dez)<\/td>/g) ?? []).length, 3, "o mês com unidadesComDado=0 não entra na tabela");
  });
});

// ===========================================================================
describe("htmlVisaoGeralRede — ranking por modalidade", () => {
  test("Marketplace e Full Service nunca se misturam na mesma lista", () => {
    const h = V.htmlVisaoGeralRede(REDE_CHEIA);
    const iniMkt = h.indexOf("<h3>Marketplace</h3>");
    const iniFull = h.indexOf("<h3>Full Service</h3>");
    assert.ok(iniMkt > -1 && iniFull > -1);
    const blocoMkt = h.slice(iniMkt, iniFull > iniMkt ? iniFull : h.length);
    assert.ok(!/Beta Centro/.test(blocoMkt), "unidade full_service não aparece no bloco marketplace");
  });

  test("cada bloco tem 'Melhores desempenhos' e 'Maior necessidade de atenção'", () => {
    const h = V.htmlVisaoGeralRede(REDE_CHEIA);
    assert.match(h, /Melhores desempenhos/);
    assert.match(h, /Maior necessidade de atenção/);
  });

  test("sem nenhuma loja em atenção/crítica na modalidade, mostra estado positivo (não vazio genérico)", () => {
    const h = V.htmlVisaoGeralRede({
      ...REDE_CHEIA,
      rankingPorModalidade: { ...REDE_CHEIA.rankingPorModalidade, full_service: { melhores: [UNI_C], atencao: [] } },
    });
    assert.match(h, /Todas as lojas desta modalidade estão em dia/);
  });

  test("linha do ranking mostra o impacto financeiro estimado só quando > 0", () => {
    const h = V.htmlVisaoGeralRede(REDE_CHEIA);
    assert.match(h, /impacto estimado R\$\s?720,00/);
    const liA = /<li[^>]*data-id="uni-a"[\s\S]*?<\/li>/.exec(h)[0];
    assert.ok(!/impacto estimado/.test(liA), "unidade sem impacto (JV Loja A) não mostra a nota");
  });
});

// ===========================================================================
describe("htmlVisaoGeralRede — tabela gerencial", () => {
  test("uma linha por empresa (consolidado) e uma linha por unidade", () => {
    const h = V.htmlVisaoGeralRede(REDE_CHEIA);
    assert.match(h, /Monitoramento por empresa e unidade/);
    assert.match(h, /<td>JV Alimentos<\/td>/);
    assert.match(h, /<td>Beta Sul<\/td>/);
    assert.match(h, /Todas as unidades elegíveis \(3\)/);
  });

  test("unidade com provisório ganha o selo; sem provisório, não ganha", () => {
    const h = V.htmlVisaoGeralRede(REDE_CHEIA);
    const liB = /<tr[^>]*data-id="uni-b"[\s\S]*?<\/tr>/.exec(h)[0];
    const liA = /<tr[^>]*data-id="uni-a"[\s\S]*?<\/tr>/.exec(h)[0];
    assert.match(liB, /não finalizados/, "JV Loja B tem provisório -> selo aparece");
    assert.ok(!/não finalizados/.test(liA), "JV Loja A sem provisório -> sem selo");
  });

  test("sem unidades no recorte (filtro restritivo), mostra placeholder nas duas tabelas", () => {
    const h = V.htmlVisaoGeralRede({ ...REDE_CHEIA, unidades: [], empresas: [] });
    assert.match(h, /Nenhuma empresa no recorte atual/);
    assert.match(h, /Nenhuma unidade no recorte atual/);
  });
});

// ===========================================================================
describe("htmlVisaoGeralRede — estado vazio da rede", () => {
  test("zero unidades monitoradas -> estado vazio dedicado, filtros continuam visíveis", () => {
    const h = V.htmlVisaoGeralRede(REDE_VAZIA);
    assert.match(h, /Nenhuma unidade monitorada neste recorte/);
    assert.match(h, /data-vr-filtro="organizacaoId"/, "filtros seguem renderizados mesmo sem dado, para o gestor poder limpar o recorte");
    assert.ok(!/Monitoramento por empresa e unidade/.test(h));
  });
});

// ===========================================================================
// Orquestração: renderViewPadm -> pintarVisaoRede -> ligarVisaoRede.
// ===========================================================================
describe("Visão Geral da Rede — filtros server-side (wiring)", () => {
  test("abrir a tela chama a API com o mês ativo e sem filtros", async () => {
    const chamadas = [];
    const api = { visaoGeralRede: async (f) => { chamadas.push(f); return REDE_CHEIA; } };
    await V.renderViewPadm({ tipo: "tela", id: "visao-geral-rede" }, { api, mes: "2026-09" });
    assert.deepEqual(chamadas[0], { mes: "2026-09" });
  });

  test("trocar a empresa recarrega com organizacaoId e ZERA a unidade selecionada", async () => {
    const chamadas = [];
    const api = { visaoGeralRede: async (f) => { chamadas.push(f); return REDE_CHEIA; } };
    await V.renderViewPadm({ tipo: "tela", id: "visao-geral-rede" }, { api, mes: "2026-09" });
    V.viewVisaoRede.unidadeId = "uni-a"; // simula seleção anterior
    const selEmpresa = padmView._store.filtros.find((f) => f.dataset.vrFiltro === "organizacaoId");
    selEmpresa.value = "org-beta";
    selEmpresa.dispatch("change");
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(chamadas.at(-1), { mes: "2026-09", organizacaoId: "org-beta" });
    assert.equal(V.viewVisaoRede.unidadeId, "", "unidade da empresa anterior não sobrevive à troca de empresa");
  });

  test("trocar modalidade e situação recarrega com os dois filtros combinados", async () => {
    const chamadas = [];
    const api = { visaoGeralRede: async (f) => { chamadas.push(f); return REDE_CHEIA; } };
    await V.renderViewPadm({ tipo: "tela", id: "visao-geral-rede" }, { api, mes: "2026-09" });
    const selModalidade = padmView._store.filtros.find((f) => f.dataset.vrFiltro === "modalidade");
    selModalidade.value = "marketplace";
    selModalidade.dispatch("change");
    await new Promise((r) => setTimeout(r, 0));
    const selSituacao = padmView._store.filtros.find((f) => f.dataset.vrFiltro === "situacao");
    selSituacao.value = "critica";
    selSituacao.dispatch("change");
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(chamadas.at(-1), { mes: "2026-09", modalidade: "marketplace", situacao: "critica" });
  });

  test("busca tem debounce: não chama a API antes de ~350ms, chama depois com o termo", async () => {
    const chamadas = [];
    const api = { visaoGeralRede: async (f) => { chamadas.push(f); return REDE_CHEIA; } };
    await V.renderViewPadm({ tipo: "tela", id: "visao-geral-rede" }, { api, mes: "2026-09" });
    const totalAntes = chamadas.length;
    const inputBusca = padmView._store.busca;
    inputBusca.value = "beta";
    inputBusca.dispatch("input");
    assert.equal(chamadas.length, totalAntes, "não chama de imediato");
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(chamadas.at(-1), { mes: "2026-09", busca: "beta" });
  });

  test("403 ao recarregar dispara aoAcessoRevogado, sem quebrar a tela", async () => {
    const revogados = [];
    V.ligarNavegacao({ abrirEmpresa: () => {}, abrirUnidade: () => {}, voltar: () => {}, aoAcessoRevogado: (m) => revogados.push(m) });
    let chamada = 0;
    const api = {
      visaoGeralRede: async () => {
        chamada += 1;
        if (chamada === 1) return REDE_CHEIA;
        throw Object.assign(new Error("Acesso revogado."), { status: 403 });
      },
    };
    await V.renderViewPadm({ tipo: "tela", id: "visao-geral-rede" }, { api, mes: "2026-09" });
    const selSituacao = padmView._store.filtros.find((f) => f.dataset.vrFiltro === "situacao");
    selSituacao.value = "atencao";
    selSituacao.dispatch("change");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(revogados.length, 1);
    assert.match(revogados[0], /revogado/i);
  });
});
