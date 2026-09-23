// dashboardExecutivo.periodoMisto.js — reconciliação GRANULAR (2026-09-22).
// Casos A/B (puro) + misto limpo + o caso REAL Subway Feiraguay (setembro/2026)
// ponta a ponta: valida que a arquitetura granular resolve exatamente o
// sintoma reportado em produção ("Dados insuficientes" no mês inteiro) sem
// inventar nenhum valor financeiro oficial.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SourceTextModule, SyntheticModule } from "node:vm";
import { dividirFinanceiroPorSegmento, consolidarSegmentos, comporMetas, MOTIVOS_INDISPONIVEL } from "../src/modules/dashboard-executivo/dashboardExecutivo.periodoMisto.js";
import { STATUS_CONCILIACAO } from "../src/modules/dashboard-executivo/dashboardExecutivo.confiabilidade.js";
import { montarLinhaDoTempo, segmentosDoPeriodo } from "../src/modules/dashboard-executivo/dashboardExecutivo.modeloTemporal.js";
import { metasComProtecaoPrecificacao } from "../src/modules/dashboard-executivo/dashboardExecutivo.calc.js";

const row = (dia, valor, extra = {}) => ({
  data_lancamento: `2026-09-${dia}`, situacao: "normal", origem_lancamento: "diario",
  valor_vendas_ifood: valor, taxas_comissoes: valor * 0.13, servicos_promocoes: valor * 0.05,
  taxas_entregadores: valor * 0.12, ajustes_favor_loja: 0, ajustes_contra_loja: 0, ...extra,
});
const SEG_MP_FS = [
  { modelo: "marketplace", inicio: "2026-09-01", fim: "2026-09-12" },
  { modelo: "full_service", inicio: "2026-09-13", fim: "2026-09-30" },
];
const SEG_UNICO = (modelo) => [{ modelo, inicio: "2026-09-01", fim: "2026-09-30" }];

describe("Caso A — 100% Marketplace: tudo conciliado, comportamento equivalente ao mês simples", () => {
  const linhas = [row("30", 20000)];
  test("faturamento e componentes conciliados", () => {
    const d = dividirFinanceiroPorSegmento(linhas, SEG_UNICO("marketplace"));
    assert.equal(d.fonte, "snapshot");
    assert.equal(d.segmentos[0].campos.valorVendasIfood.status, STATUS_CONCILIACAO.CONCILIADO);
    assert.equal(d.segmentos[0].campos.valorVendasIfood.valorOficial, 20000);
    const c = consolidarSegmentos(d);
    assert.equal(c.campos.valorVendasIfood.valor, 20000);
    assert.equal(c.totalDeducoes.status, STATUS_CONCILIACAO.CONCILIADO);
    assert.equal(c.receitaLiquida.status, STATUS_CONCILIACAO.CONCILIADO);
  });
});

describe("Caso B — 100% Full Service: entregadores não aplicável, resto conciliado", () => {
  const linhas = [row("30", 20000)];
  test("taxasEntregadores é NÃO APLICÁVEL (nunca 'dados insuficientes')", () => {
    const d = dividirFinanceiroPorSegmento(linhas, SEG_UNICO("full_service"));
    assert.equal(d.segmentos[0].campos.taxasEntregadores.status, STATUS_CONCILIACAO.NAO_APLICAVEL);
    const c = consolidarSegmentos(d);
    assert.equal(c.campos.taxasEntregadores.status, STATUS_CONCILIACAO.NAO_APLICAVEL);
    assert.equal(c.baseEntregadores.status, STATUS_CONCILIACAO.NAO_APLICAVEL);
    assert.equal(c.totalDeducoes.status, STATUS_CONCILIACAO.CONCILIADO); // só taxas+serviços, ambos ok
  });
});

describe("Caso misto LIMPO (01–12 MP, 13–30 FS, sem nenhuma anomalia)", () => {
  const linhas = [row("12", 20000), row("30", 80000)];
  test("todos os campos conciliados nos dois segmentos e no consolidado", () => {
    const d = dividirFinanceiroPorSegmento(linhas, SEG_MP_FS);
    for (const seg of d.segmentos) {
      assert.equal(seg.campos.valorVendasIfood.status, STATUS_CONCILIACAO.CONCILIADO);
    }
    const c = consolidarSegmentos(d);
    assert.equal(c.campos.valorVendasIfood.valor, 80000); // MP 20000 (ponto absoluto) + FS 60000 (delta)
    assert.equal(c.totalDeducoes.status, STATUS_CONCILIACAO.CONCILIADO);
    assert.equal(c.receitaLiquida.status, STATUS_CONCILIACAO.CONCILIADO);
  });
  test("comporMetas pondera pelo faturamento de cada regime quando o peso é conciliado", () => {
    const metasMP = { total_deducoes: { metaIdeal: 30, limite: 32 } };
    const metasFS = { total_deducoes: { metaIdeal: 20.5, limite: 20.5 } };
    const r = comporMetas([
      { modelo: "marketplace", peso: 20000, pesoConciliado: true, metas: metasMP },
      { modelo: "full_service", peso: 60000, pesoConciliado: true, metas: metasFS },
    ], ["total_deducoes"]);
    // (30*20000 + 20.5*60000) / 80000 = 22.875
    assert.equal(r.total_deducoes.metaIdeal, 22.875);
  });
  test("comporMetas NUNCA inventa peso: se algum regime tem faturamento não conciliado, a meta composta fica indisponível", () => {
    const r = comporMetas([
      { modelo: "marketplace", peso: 20000, pesoConciliado: true, metas: { total_deducoes: { metaIdeal: 30, limite: 32 } } },
      { modelo: "full_service", peso: null, pesoConciliado: false, metas: { total_deducoes: { metaIdeal: 20.5, limite: 20.5 } } },
    ], ["total_deducoes"]);
    assert.equal(r.total_deducoes, undefined);
  });
});

// ---------------------------------------------------------------------------
// CASO REAL — Subway Feiraguay, setembro/2026 (investigação de 2026-09-22).
// Marketplace até 19/09, Full Service desde 20/09. valor_vendas_ifood de 21/09
// foi preenchido igual ao valor bruto (erro de digitação comprovado via
// auditoria) — queda de R$84.736,88 para R$76.910,32. taxas_entregadores
// zerou em 18/09 (2 dias antes da vigência registrada, 20/09).
// ---------------------------------------------------------------------------
const LINHAS_FEIRAGUAY = [
  { data_lancamento: "2026-09-17", situacao: "normal", origem_lancamento: "diario", valor_vendas_ifood: 73300.67, taxas_comissoes: 8274.08, servicos_promocoes: 11556.48, taxas_entregadores: 9253.00, ajustes_favor_loja: 306.52, ajustes_contra_loja: null },
  { data_lancamento: "2026-09-18", situacao: "normal", origem_lancamento: "diario", valor_vendas_ifood: 78924.58, taxas_comissoes: 9242.01, servicos_promocoes: 13212.65, taxas_entregadores: 0.00, ajustes_favor_loja: 306.52, ajustes_contra_loja: null },
  { data_lancamento: "2026-09-19", situacao: "normal", origem_lancamento: "diario", valor_vendas_ifood: 82760.95, taxas_comissoes: 10016.61, servicos_promocoes: 14000.02, taxas_entregadores: 0.00, ajustes_favor_loja: 358.53, ajustes_contra_loja: null },
  { data_lancamento: "2026-09-20", situacao: "normal", origem_lancamento: "diario", valor_vendas_ifood: 84736.88, taxas_comissoes: 10429.15, servicos_promocoes: 14106.45, taxas_entregadores: 0.00, ajustes_favor_loja: 373.55, ajustes_contra_loja: null },
  { data_lancamento: "2026-09-21", situacao: "normal", origem_lancamento: "diario", valor_vendas_ifood: 76910.32, taxas_comissoes: 10735.94, servicos_promocoes: 14299.39, taxas_entregadores: 0.00, ajustes_favor_loja: 373.55, ajustes_contra_loja: null },
];
const SEG_FEIRAGUAY = [
  { modelo: "marketplace", inicio: "2026-09-01", fim: "2026-09-19" },
  { modelo: "full_service", inicio: "2026-09-20", fim: "2026-09-21" },
];

describe("CASO REAL — Subway Feiraguay: granularidade em vez de 'Dados insuficientes' no mês inteiro", () => {
  const divisao = dividirFinanceiroPorSegmento(LINHAS_FEIRAGUAY, SEG_FEIRAGUAY);
  const consolidado = consolidarSegmentos(divisao);

  test("Marketplace: taxas e serviços conciliados; entregadores SUSPEITO com último valor válido 9.253,00 em 17/09 (nunca 0,00 nem 9.253,00 como oficial)", () => {
    const mp = divisao.segmentos[0].campos;
    assert.equal(mp.taxasComissoes.status, STATUS_CONCILIACAO.CONCILIADO);
    assert.equal(mp.taxasComissoes.valorOficial, 10016.61);
    assert.equal(mp.taxasEntregadores.status, STATUS_CONCILIACAO.SUSPEITO);
    assert.equal(mp.taxasEntregadores.valorOficial, null);
    assert.equal(mp.taxasEntregadores.ultimoValorValido.valor, 9253.00);
    assert.equal(mp.taxasEntregadores.ultimoValorValido.data, "2026-09-17");
  });

  test("Full Service: faturamento NÃO CONCILIÁVEL (queda real); taxas e serviços continuam conciliados (campos independentes)", () => {
    const fs = divisao.segmentos[1].campos;
    assert.equal(fs.valorVendasIfood.status, STATUS_CONCILIACAO.NAO_CONCILIAVEL);
    assert.equal(fs.taxasComissoes.status, STATUS_CONCILIACAO.CONCILIADO);
    assert.ok(Math.abs(fs.taxasComissoes.valorOficial - 719.33) < 0.01); // 10735.94 - 10016.61
    assert.equal(fs.servicosPromocoes.status, STATUS_CONCILIACAO.CONCILIADO);
    assert.ok(Math.abs(fs.servicosPromocoes.valorOficial - 299.37) < 0.01);
    assert.equal(fs.taxasEntregadores.status, STATUS_CONCILIACAO.NAO_APLICAVEL); // regra C, nunca "dados insuficientes"
  });

  test("CONSOLIDADO — Taxas e Comissões e Serviços e Promoções continuam calculáveis (R$) mesmo com o faturamento quebrado", () => {
    assert.equal(consolidado.campos.taxasComissoes.status, STATUS_CONCILIACAO.CONCILIADO);
    assert.ok(Math.abs(consolidado.campos.taxasComissoes.valor - 10735.94) < 0.01); // = valor do último dia, cadeia intacta
    assert.equal(consolidado.campos.servicosPromocoes.status, STATUS_CONCILIACAO.CONCILIADO);
  });

  test("CONSOLIDADO — faturamento e receita líquida ficam não conciliáveis (dependem do campo quebrado) — mas com contexto, nunca silêncio total", () => {
    assert.equal(consolidado.campos.valorVendasIfood.status, STATUS_CONCILIACAO.NAO_CONCILIAVEL);
    assert.equal(consolidado.campos.valorVendasIfood.valor, null);
    assert.equal(consolidado.receitaLiquida.status, STATUS_CONCILIACAO.NAO_CONCILIAVEL);
  });

  test("CONSOLIDADO — Total de Deduções: suspeito (herda do Marketplace/entregadores), mas com estimativa de contexto, nunca 'zero' nem oculto", () => {
    assert.equal(consolidado.totalDeducoes.status, STATUS_CONCILIACAO.SUSPEITO);
    assert.equal(consolidado.totalDeducoes.valor, null); // nunca um valor OFICIAL sem confirmação
    assert.ok(consolidado.totalDeducoes.ultimoValorValido.valor > 30000); // contexto: soma de melhor esforço, não zero
  });

  test("POR SEGMENTO — Full Service tem Total de Deduções e Receita Líquida do SEU regime, mesmo com o Marketplace suspeito", () => {
    const fs = consolidado.porSegmento[1];
    assert.equal(fs.modelo, "full_service");
    assert.equal(fs.totalDeducoes.status, STATUS_CONCILIACAO.CONCILIADO);
    assert.ok(Math.abs(fs.totalDeducoes.valor - 1018.70) < 0.01); // 719,33 + 299,37 — nunca entregadores (não aplicável)
  });

  test("POR SEGMENTO — Marketplace: Total de Deduções e Receita Líquida ficam suspeitos (dependem de Entregadores), com contexto", () => {
    const mp = consolidado.porSegmento[0];
    assert.equal(mp.modelo, "marketplace");
    assert.equal(mp.totalDeducoes.status, STATUS_CONCILIACAO.SUSPEITO);
    assert.equal(mp.totalDeducoes.valor, null);
    assert.equal(mp.receitaLiquida.status, STATUS_CONCILIACAO.SUSPEITO);
  });

  test("POR SEGMENTO — Full Service: Receita Líquida fica não conciliável (herda do PRÓPRIO faturamento quebrado, não do Marketplace)", () => {
    const fs = consolidado.porSegmento[1];
    assert.equal(fs.receitaLiquida.status, STATUS_CONCILIACAO.NAO_CONCILIAVEL);
  });
});

describe("Lote mensal que atravessa a troca — granular: campos ficam nao_conciliavel, mas não é um novo apagão global escondido", () => {
  const lote = [
    { data_lancamento: "2026-09-05", situacao: "normal", origem_lancamento: "distribuicao_mensal", valor_vendas_ifood: 1000, taxas_comissoes: 100 },
    { data_lancamento: "2026-09-20", situacao: "normal", origem_lancamento: "distribuicao_mensal", valor_vendas_ifood: 1000, taxas_comissoes: 100 },
  ];
  test("todos os campos aplicáveis marcados nao_conciliavel com o motivo correto", () => {
    const d = dividirFinanceiroPorSegmento(lote, SEG_FEIRAGUAY);
    assert.equal(d.fonte, "lancamento_mensal");
    assert.equal(d.segmentos[0].campos.valorVendasIfood.status, STATUS_CONCILIACAO.NAO_CONCILIAVEL);
    assert.equal(d.segmentos[0].campos.valorVendasIfood.motivo, MOTIVOS_INDISPONIVEL.LOTE_MENSAL_ATRAVESSA_TROCA);
  });
});

describe("Sem nenhum dado no mês: tudo 'sem_dado' (nunca 'não conciliável' — não há nem base pra suspeitar)", () => {
  test("segmentos vazios", () => {
    const d = dividirFinanceiroPorSegmento([], SEG_MP_FS);
    assert.equal(d.fonte, "sem_dado");
    assert.equal(d.segmentos[0].campos.valorVendasIfood.status, STATUS_CONCILIACAO.SEM_DADO);
  });
});

// ---------------------------------------------------------------------------
// PARTE 2 — service (obterMes / lançamento mensal), com banco e metas FAKE.
//
// Cenário-base (Unidade X, setembro/2026): Marketplace 01–12, Full Service 13–30.
//   Snapshot acumulado em 12/09 (fim do Marketplace):
//     faturamento 10.000 · taxas e comissões 1.300 (13%) · serviços 500 (5%) · entregadores 1.200 (12%)
//   Snapshot acumulado em 18/09 (mais recente):
//     faturamento 16.000 · taxas 2.530 · serviços 1.100 · entregadores 1.500
//   => Marketplace (01–12): 10.000 | taxas 1.300 | serv 500 | entreg 1.200 -> deduções 3.000 (30,00%)
//      Full Service (13–18): 6.000  | taxas 1.230 | serv 600 | entreg N/A  -> deduções 1.830 (30,50%)
//      Período: deduções 3.000 + 1.830 = 4.830 sobre 16.000 = 30,1875%   (média simples de % daria 30,25%)
//   Receita Líquida: os 1.500 de entregadores acumulados em 18/09 já incluem
//   os 1.200 do Marketplace — o excedente (300) NÃO é atribuído ao Full
//   Service (regra C: não aplicável) porque não há evidência de que
//   pertença de fato a esse regime — a Receita Líquida usa só a parte
//   RECONCILIADA (1.200), nunca o resíduo bruto do snapshot sem checagem.
// ---------------------------------------------------------------------------
const dirSrc = new URL("../src/modules/dashboard-executivo/", import.meta.url);

async function carregar(nome, mocks) {
  const url = new URL(nome, dirSrc);
  const m = new SourceTextModule(readFileSync(url, "utf8"), { identifier: url.href });
  await m.link(async (spec) => {
    const ns = mocks[spec] ?? await import(new URL(spec, url));
    return new SyntheticModule(Object.keys(ns), function () { for (const [k, v] of Object.entries(ns)) this.setExport(k, v); });
  });
  await m.evaluate();
  return m.namespace;
}

function banco({ lancamentos = [], lote = null }) {
  return {
    from(tabela) {
      const f = { eq: {}, gte: null, lte: null };
      let unico = false;
      const resposta = () => {
        if (tabela === "unidades") return { data: { id: f.eq.id ?? "u1", organizacao_id: "org", eh_teste: false }, error: null };
        if (tabela === "lancamentos_financeiros_distribuicao_mensal") return { data: unico ? lote : [], error: null };
        if (tabela === "lancamentos_financeiros_diarios") {
          const achadas = lancamentos.filter((r) =>
            (f.eq.unidade_id == null || r.unidade_id === f.eq.unidade_id)
            && (f.eq.distribuicao_mensal_id == null || r.distribuicao_mensal_id === f.eq.distribuicao_mensal_id)
            && (!f.gte || r.data_lancamento >= f.gte) && (!f.lte || r.data_lancamento <= f.lte));
          return { data: unico ? (achadas[0] ?? null) : achadas, error: null };
        }
        return { data: unico ? null : [], error: null };
      };
      const q = {
        select: () => q, order: () => q, limit: () => q, in: () => q,
        eq: (k, v) => ((f.eq[k] = v), q),
        gte: (k, v) => ((f.gte = v), q), lte: (k, v) => ((f.lte = v), q),
        maybeSingle: () => ((unico = true), Promise.resolve(resposta())),
        then: (a, b) => Promise.resolve(resposta()).then(a, b),
      };
      return q;
    },
  };
}

const PRECOS = {
  oficiais: { tabelaBalcao: "E", tabelaIfood: "Z4" }, tabelas: { balcao: "E", ifood: "Z4" },
  produto: { id: "p1", nome: "Churrasco 15cm" }, balcao: { preco: 24, custo: 6 }, ifood: { preco: 35, custo: 6 },
};

const TROCA_X = { vigenciaInicio: "2026-09-13", modeloAnterior: "marketplace", modeloNovo: "full_service" };
const LINHA_MISTA = montarLinhaDoTempo({ modeloAtual: "full_service", trocas: [TROCA_X] });
const SEGS = segmentosDoPeriodo(LINHA_MISTA, "2026-09-01", "2026-09-30");

const snap = (data, fat, tc, sp, te, extra = {}) => ({
  id: `l-${data}`, unidade_id: "u1", data_lancamento: data, situacao: "normal", status: "finalizado", origem_lancamento: "diario",
  valor_vendas_ifood: fat, taxas_comissoes: tc, servicos_promocoes: sp, taxas_entregadores: te,
  ajustes_favor_loja: 0, ajustes_contra_loja: 0, ...extra,
});
const LINHAS_BASE = [snap("2026-09-12", 10000, 1300, 500, 1200), snap("2026-09-18", 16000, 2530, 1100, 1500)];

const METAS = {
  marketplace: {
    taxas_comissoes: { metaIdeal: 13, limite: 13 }, servicos_promocoes: { metaIdeal: 5, limite: 7 },
    taxas_entregadores: { metaIdeal: 12, limite: 15 }, total_deducoes: { metaIdeal: 30, limite: 32 },
  },
  full_service: {
    taxas_comissoes: { metaIdeal: 20.5, limite: 20.5 }, servicos_promocoes: { metaIdeal: 10, limite: 14.5 },
    taxas_entregadores: { metaIdeal: 15, limite: 15 }, // linha existe no banco, mas NÃO se aplica ao Full Service
    total_deducoes: { metaIdeal: 30.5, limite: 32 },
  },
};

const perto = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `esperado ${b}, veio ${a}`);

/** Service com a unidade `u1` numa linha do tempo e metas por modelo (resolverMetas respeita o modelo pedido). */
async function servico({ lancamentos = [], lote = null, trocas = [], modeloAtual }) {
  const linhaDoTempo = montarLinhaDoTempo({ modeloAtual, trocas });
  const modeloHoje = trocas.length ? trocas[trocas.length - 1].modeloNovo : modeloAtual;
  return carregar("dashboardExecutivo.service.js", {
    "../../config/supabase.js": { supabase: banco({ lancamentos, lote }) },
    "../../shared/desbloqueiosIfood.js": { carregarDatasLiberadas: async () => new Set() },
    "./dashboardExecutivo.precos.service.js": { carregarPrecosRentabilidade: async () => PRECOS },
    "./dashboardExecutivo.metas.service.js": {
      resolverMetas: async ({ modeloLogistico }) => structuredClone(METAS[modeloLogistico]),
      obterModeloLogistico: async () => ({
        unidadeId: "u1", modeloLogistico: modeloHoje, modeloLogisticoRotulo: modeloHoje === "marketplace" ? "Marketplace" : "Full Service",
        ehTeste: false, linhaDoTempo,
      }),
      definirModeloLogistico() {}, historicoModeloLogistico() {},
    },
  });
}
const PEDIDO_SET = { organizacaoId: "org", unidadeIdSessao: null, unidadeIdSolicitado: "u1", mes: 9, ano: 2026 };

describe("Caso A — 01–30 Marketplace: comportamento igual ao anterior", () => {
  test("indicadores, metas e aplicabilidade do Marketplace (nenhuma troca registrada)", async () => {
    const svc = await servico({ modeloAtual: "marketplace", lancamentos: [snap("2026-09-18", 16000, 2530, 1100, 1500)] });
    const d = await svc.obterMes(PEDIDO_SET);
    assert.equal(d.modeloLogistico, "marketplace");
    assert.equal(d.modeloPeriodo.misto, false);
    assert.equal(d.modeloPeriodo.divisaoDisponivel, true);
    assert.equal(d.cards.taxasEntregadores.naoAplicavel, false);
    assert.equal(d.cards.taxasEntregadores.valor, 1500);
    perto(d.cards.taxasEntregadores.percentual, 9.375); // 1.500 / 16.000
    assert.equal(d.cards.totalDeducoes.valor, 2530 + 1100 + 1500); // Marketplace inclui entregadores
    perto(d.cards.totalDeducoes.percentual, 32.0625);
    assert.equal(d.cards.totalDeducoes.status.chave, "atencao"); // 32,06% > limite 32%
    // metas do Marketplace, sem composição
    assert.equal(d.indicadoresRentabilidade.taxas_comissoes.metaIdeal, 13);
    assert.equal(d.indicadoresRentabilidade.taxas_entregadores.limite, 15);
    assert.equal(d.indicadoresRentabilidade.total_deducoes.limite, 32);
  });
});

describe("Caso B — 01–30 Full Service: comportamento igual ao anterior", () => {
  test("entregadores 'não se aplica' e Total de Deduções só com taxas + serviços", async () => {
    const svc = await servico({ modeloAtual: "full_service", lancamentos: [snap("2026-09-18", 16000, 2530, 1100, 1500)] });
    const d = await svc.obterMes(PEDIDO_SET);
    assert.equal(d.modeloLogistico, "full_service");
    assert.equal(d.modeloPeriodo.misto, false);
    assert.equal(d.cards.taxasEntregadores.naoAplicavel, true);
    assert.equal(d.indicadoresRentabilidade.taxas_entregadores.naoAplicavel, true);
    assert.equal(d.cards.totalDeducoes.valor, 2530 + 1100);
    perto(d.cards.totalDeducoes.percentual, 22.6875);
    assert.equal(d.indicadoresRentabilidade.taxas_comissoes.metaIdeal, 20.5);
    // A "Taxa dos Entregadores" informada continua no caixa real (Receita líquida), como sempre foi.
    assert.equal(d.cards.receitaLiquida.valor, 16000 - (2530 + 1100 + 1500));
  });
});

describe("Caso C — 01–12 Marketplace, 13–30 Full Service (setembro inteiro)", () => {
  test("detecta 'operação mista' e devolve os dois intervalos", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: LINHAS_BASE });
    const d = await svc.obterMes(PEDIDO_SET);
    assert.equal(d.modeloLogistico, "misto", "estado derivado do período (nunca persistido)");
    assert.equal(d.modeloLogisticoRotulo, "Operação mista");
    assert.equal(d.modeloPeriodo.misto, true);
    assert.equal(d.modeloPeriodo.divisaoDisponivel, true);
    assert.deepEqual(d.modeloPeriodo.segmentos.map((s) => [s.modelo, s.inicio, s.fim, s.emAberto]), [
      ["marketplace", "2026-09-01", "2026-09-12", false],
      ["full_service", "2026-09-13", "2026-09-30", true],
    ]);
    // O modelo de HOJE continua Full Service (é o que o seletor de troca mostra).
    assert.equal(d.modeloAtual.modeloLogistico, "full_service");
  });

  test("todos os cards aparecem, inclusive Taxas de Entregadores (existiu Marketplace no período)", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: LINHAS_BASE });
    const d = await svc.obterMes(PEDIDO_SET);
    assert.equal(d.cards.taxasEntregadores.naoAplicavel, false);
    assert.equal(d.indicadoresRentabilidade.taxas_entregadores.naoAplicavel, false);
    assert.equal(d.cards.taxasEntregadores.valor, 1200, "só os entregadores dos dias de Marketplace");
    perto(d.cards.taxasEntregadores.percentual, 12, 1e-9); // 1.200 / 10.000 (faturamento do Marketplace)
    assert.equal(d.graficos.comparativoPercentuais.some((g) => g.indicador === "taxas_entregadores"), true);
  });

  test("Total de Deduções: soma em reais dos dois regimes sobre o faturamento do período — sem média de percentuais", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: LINHAS_BASE });
    const d = await svc.obterMes(PEDIDO_SET);
    assert.equal(d.cards.faturamento.valor, 16000);
    assert.equal(d.cards.totalDeducoes.valor, 4830);
    perto(d.cards.totalDeducoes.percentual, 30.1875);
    assert.notEqual(d.cards.totalDeducoes.percentual, 30.25);
    perto(d.cards.taxasComissoes.percentual, 15.8125);
    perto(d.cards.servicosPromocoes.percentual, 6.875);
  });

  test("Receita líquida usa o total RECONCILIADO (nunca o resíduo bruto do snapshot sem checagem)", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: LINHAS_BASE });
    const d = await svc.obterMes(PEDIDO_SET);
    // Os 1.500 de entregadores acumulados em 18/09 incluem 1.200 confirmados
    // do Marketplace + 300 de origem não comprovada (Full Service não usa
    // entregadores próprios — não há evidência de que os 300 pertençam
    // mesmo a esse regime). A Receita Líquida usa só a parte reconciliada.
    assert.equal(d.cards.receitaLiquida.valor, 16000 - (2530 + 1100 + 1200));
  });

  test("metas: composição ponderada, nunca a meta de um regime aplicada ao mês inteiro", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: LINHAS_BASE });
    const d = await svc.obterMes(PEDIDO_SET);
    const ind = d.indicadoresRentabilidade;
    perto(ind.taxas_comissoes.metaIdeal, (13 * 10000 + 20.5 * 6000) / 16000);
    perto(ind.taxas_comissoes.limite, (13 * 10000 + 20.5 * 6000) / 16000);
    // Entregadores: só a meta do Marketplace.
    assert.equal(ind.taxas_entregadores.metaIdeal, 12);
    assert.equal(ind.taxas_entregadores.limite, 15);
    // Serviços e Total: metas ideais derivadas (proteção da precificação) POR regime, depois compostas.
    const pct = d.protecaoPrecificacao.protecaoPrecificacaoPct;
    const mp = metasComProtecaoPrecificacao(METAS.marketplace, pct, "marketplace").metas;
    const fs = metasComProtecaoPrecificacao(METAS.full_service, pct, "full_service").metas;
    perto(ind.servicos_promocoes.metaIdeal, (mp.servicos_promocoes.metaIdeal * 10000 + fs.servicos_promocoes.metaIdeal * 6000) / 16000);
    perto(ind.total_deducoes.metaIdeal, (mp.total_deducoes.metaIdeal * 10000 + fs.total_deducoes.metaIdeal * 6000) / 16000);
    perto(ind.total_deducoes.limite, 32);
    assert.equal(ind.total_deducoes.status.chave, "dentro_da_meta"); // 30,19% <= ~31,43%
  });

  test("sem o snapshot da véspera da troca: faturamento/taxas/serviços continuam calculáveis (período direto); só o que DEPENDE da fronteira (Entregadores/Total/Receita) fica sem dado", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: [snap("2026-09-18", 16000, 2530, 1100, 1500)] });
    const d = await svc.obterMes(PEDIDO_SET);
    assert.equal(d.modeloPeriodo.misto, true);
    assert.equal(d.modeloPeriodo.divisaoDisponivel, false);
    assert.equal(d.modeloPeriodo.divisaoMotivo, STATUS_CONCILIACAO.SEM_DADO);
    // Granular: faturamento, taxas e serviços NÃO dependem de fronteira de
    // segmento (aplicam-se aos dois modelos) — continuam calculáveis mesmo
    // sem o snapshot exato de 12/09 (era isto que "SNAPSHOT_DE_VIRADA_AUSENTE"
    // apagava por inteiro antes).
    assert.equal(d.cards.faturamento.valor, 16000);
    perto(d.cards.taxasComissoes.percentual, 15.8125);
    assert.equal(d.cards.taxasComissoes.meta, null, "sem meta única enganosa (peso do Marketplace não conciliado)");
    // O que REALMENTE depende da fronteira (Entregadores só existe no
    // Marketplace; Total de Deduções e Receita Líquida dependem dele) fica sem dado.
    assert.equal(d.cards.taxasEntregadores.valor, null);
    assert.equal(d.cards.totalDeducoes.valor, null);
    assert.equal(d.cards.totalDeducoes.status.chave, "sem_dados");
    assert.equal(d.cards.totalDeducoes.meta, null);
  });

  test("dashboard só 01–12 = Marketplace puro; só 13–30 = Full Service puro (não misto)", async () => {
    // Um mês inteiro em cada regime, com a MESMA linha do tempo: agosto (MP) e outubro (FS).
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: [] });
    const ago = await svc.obterMes({ ...PEDIDO_SET, mes: 8 });
    const out = await svc.obterMes({ ...PEDIDO_SET, mes: 10 });
    assert.equal(ago.modeloLogistico, "marketplace");
    assert.equal(ago.modeloPeriodo.misto, false);
    assert.equal(ago.cards.taxasEntregadores.naoAplicavel, false, "agosto ainda era Marketplace, mesmo hoje sendo Full Service");
    assert.equal(out.modeloLogistico, "full_service");
    assert.equal(out.cards.taxasEntregadores.naoAplicavel, true);
  });
});

describe("Caso G — lançamento mensal atravessando a mudança de regime", () => {
  const dadosLote = { mes: 9, ano: 2026, valorTotalMensal: 20000, unidadeId: "u1" };
  const pedidoLote = { organizacaoId: "org", unidadeIdSessao: null, usuario: { id: "x" }, dados: dadosLote, confirmar: false };

  test("criar lote cujos dias atravessam a troca é BLOQUEADO (409), com orientação — sem gambiarra", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X] });
    await assert.rejects(svc.lancamentoMensal(pedidoLote), (e) => {
      assert.equal(e.status ?? e.statusCode, 409);
      assert.match(e.message, /atravessam a troca de modelo/);
      assert.equal(e.details?.atravessaTrocaDeModelo, true);
      return true;
    });
  });

  test("com os dias de Marketplace já lançados individualmente, o lote só cobre Full Service e é permitido", async () => {
    const individuais = Array.from({ length: 12 }, (_, i) => snap(`2026-09-${String(i + 1).padStart(2, "0")}`, (i + 1) * 800, 100, 40, 90));
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: individuais });
    const preview = await svc.lancamentoMensal(pedidoLote);
    assert.equal(preview.diasComLancamento, 12);
    assert.ok(preview.diasParaDistribuir >= 1);
  });

  test("unidade sem troca: o lote continua funcionando como antes (preview)", async () => {
    const svc = await servico({ modeloAtual: "marketplace" });
    const preview = await svc.lancamentoMensal(pedidoLote);
    assert.ok(preview.diasParaDistribuir >= 13);
  });

  const loteRow = { id: "lote1", unidade_id: "u1", mes: 9, ano: 2026, valor_total_centavos: 2000000, dias_distribuidos: 3, created_at: "2026-09-19T00:00:00Z" };
  const fatia = (data) => ({
    id: `f-${data}`, unidade_id: "u1", data_lancamento: data, situacao: "normal", origem_lancamento: "distribuicao_mensal", distribuicao_mensal_id: "lote1",
    valor_vendas_ifood: 100, taxas_entregadores: null,
  });

  test("resumo do lote: em dias Full Service, Taxas de Entregadores é 'não aplicável' (nunca pendência)", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lote: loteRow, lancamentos: ["2026-09-14", "2026-09-15", "2026-09-16"].map(fatia) });
    const r = await svc.obterLancamentoMensal({ organizacaoId: "org", unidadeIdSessao: null, unidadeIdSolicitado: "u1", mes: 9, ano: 2026 });
    assert.deepEqual(r.modelosDoLote, ["full_service"]);
    assert.equal(r.atravessaTrocaDeModelo, false);
    assert.ok(r.camposNaoAplicaveis.includes("taxasEntregadoresTotal"));
    assert.ok(!r.camposPendentes.includes("taxasEntregadoresTotal"));
  });

  test("resumo do lote: em dias Marketplace, Taxas de Entregadores continua sendo cobrada quando falta", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lote: loteRow, lancamentos: ["2026-09-03", "2026-09-04", "2026-09-05"].map(fatia) });
    const r = await svc.obterLancamentoMensal({ organizacaoId: "org", unidadeIdSessao: null, unidadeIdSolicitado: "u1", mes: 9, ano: 2026 });
    assert.deepEqual(r.modelosDoLote, ["marketplace"]);
    assert.ok(r.camposPendentes.includes("taxasEntregadoresTotal"));
    assert.ok(!r.camposNaoAplicaveis.includes("taxasEntregadoresTotal"));
  });

  test("lote LEGADO que já atravessa a troca é sinalizado (não classificado cegamente como um regime só)", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lote: loteRow, lancamentos: ["2026-09-05", "2026-09-14"].map(fatia) });
    const r = await svc.obterLancamentoMensal({ organizacaoId: "org", unidadeIdSessao: null, unidadeIdSolicitado: "u1", mes: 9, ano: 2026 });
    assert.equal(r.atravessaTrocaDeModelo, true);
    assert.deepEqual(r.modelosDoLote, ["marketplace", "full_service"]);
    assert.ok(r.camposPendentes.includes("taxasEntregadoresTotal"), "existe nos dias Marketplace: não some");
  });

  test("Dashboard do mês com lote que atravessa a troca: campos que dependem da fronteira ficam sem dado; faturamento (período direto) continua calculável", async () => {
    const dias = Array.from({ length: 18 }, (_, i) => fatia(`2026-09-${String(i + 1).padStart(2, "0")}`));
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lote: loteRow, lancamentos: dias });
    const d = await svc.obterMes(PEDIDO_SET);
    assert.equal(d.modeloPeriodo.divisaoDisponivel, false);
    assert.equal(d.modeloPeriodo.divisaoMotivo, STATUS_CONCILIACAO.NAO_CONCILIAVEL);
    assert.equal(d.cards.totalDeducoes.valor, null);
  });
});

describe("Preservação do histórico — a troca não altera dados já lançados", () => {
  test("os MESMOS lançamentos, lidos antes e depois de registrar a troca, dão o mesmo resultado por regime", async () => {
    const antes = await servico({ modeloAtual: "marketplace", lancamentos: [snap("2026-09-12", 10000, 1300, 500, 1200)] });
    const depois = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: [snap("2026-09-12", 10000, 1300, 500, 1200)] });
    // 01–12 lido isoladamente: a linha do tempo mista recorta o período 01–12 como Marketplace.
    const dAntes = await antes.obterMes(PEDIDO_SET);
    const dDepois = await depois.obterMes(PEDIDO_SET);
    // Mês só com dados até 12/09: o regime Full Service ainda não tem snapshot -> período = Marketplace do dia 1 ao 12.
    assert.equal(dDepois.cards.faturamento.valor, dAntes.cards.faturamento.valor);
    assert.equal(dDepois.cards.taxasEntregadores.valor, dAntes.cards.taxasEntregadores.valor);
    assert.equal(dDepois.cards.totalDeducoes.valor, dAntes.cards.totalDeducoes.valor);
    perto(dDepois.cards.totalDeducoes.percentual, dAntes.cards.totalDeducoes.percentual);
  });
});

describe("Divergência de transição operacional — caso real Subway Feiraguay (Entregadores para antes da vigência registrada)", () => {
  // Vigência registrada: 13/09 (TROCA_X). Taxas de Entregadores para de
  // acumular em 11/09 — 2 dias ANTES da data administrativa.
  const LINHAS_DIVERGENTES = [
    snap("2026-09-10", 9000, 900, 300, 1000),
    snap("2026-09-11", 9500, 950, 320, 0), // reset — 2 dias antes da vigência
    snap("2026-09-12", 10000, 1000, 340, 0), // véspera da troca (MP)
    snap("2026-09-18", 16000, 1600, 500, 0), // dado dentro do Full Service
  ];

  test("gera achado de atenção 'divergência na data de transição', sem alterar a vigência", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: LINHAS_DIVERGENTES });
    const d = await svc.obterMes(PEDIDO_SET);
    const achado = [...d.diagnostico.pontosAtencao, ...d.diagnostico.alertas].find((a) => a.id === "divergencia_transicao_modelo");
    assert.ok(achado, "esperava o achado de divergência de transição");
    assert.match(achado.descricao, /11\/09/);
    assert.match(achado.descricao, /13\/09/);
    assert.match(achado.descricao, /Verifique/);
    const acao = d.diagnostico.acoes.find((a) => a.diagnosticoId === "divergencia_transicao_modelo");
    assert.ok(acao, "esperava a ação correspondente no Plano de Ação");
    assert.equal(acao.tipo, "DATA_PENDING");
    // A vigência (TROCA_X = 13/09) continua intacta — o segmento Marketplace ainda vai até 12/09.
    assert.equal(d.modeloPeriodo.segmentos[0].fim, "2026-09-12");
  });

  test("sem divergência real (dados limpos, TROCA_X): o achado NÃO aparece", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: LINHAS_BASE });
    const d = await svc.obterMes(PEDIDO_SET);
    const achado = [...d.diagnostico.pontosAtencao, ...d.diagnostico.alertas].find((a) => a.id === "divergencia_transicao_modelo");
    assert.equal(achado, undefined);
  });
});

describe("comparativoSegmentos — operacional (Ticket Médio/Pedidos/Novos Clientes) por regime, nunca passa pela reconciliação financeira", () => {
  const LINHAS_COM_OPERACIONAL = [
    snap("2026-09-01", 1000, 130, 50, 120, { valor_vendas_bruto: 1000, qtd_vendas: 20, novos_clientes: 10 }),
    snap("2026-09-12", 10000, 1300, 500, 1200, { valor_vendas_bruto: 10000, qtd_vendas: 200, novos_clientes: 100 }),
    snap("2026-09-18", 16000, 2530, 1100, 1500, { valor_vendas_bruto: 16000, qtd_vendas: 300, novos_clientes: 160 }),
  ];

  test("Marketplace: 10.000/200 pedidos (ticket 50); Full Service: 6.000/100 pedidos (ticket 60) — nunca dia isolado, sempre soma de deltas", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: LINHAS_COM_OPERACIONAL });
    const d = await svc.obterMes(PEDIDO_SET);
    const [mp, fs] = d.comparativoSegmentos;
    assert.equal(mp.modelo, "marketplace");
    assert.equal(mp.valorVendasBruto, 10000);
    assert.equal(mp.qtdVendas, 200);
    assert.equal(mp.novosClientes, 100);
    assert.equal(mp.ticketMedio, 50);
    assert.equal(fs.modelo, "full_service");
    assert.equal(fs.valorVendasBruto, 6000);
    assert.equal(fs.qtdVendas, 100);
    assert.equal(fs.ticketMedio, 60);
  });

  test("financeiro reconciliado por segmento vem junto (mesma forma de consolidado.porSegmento)", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: LINHAS_COM_OPERACIONAL });
    const d = await svc.obterMes(PEDIDO_SET);
    const [mp, fs] = d.comparativoSegmentos;
    assert.equal(mp.financeiro.campos.valorVendasIfood.valor, 10000);
    assert.equal(fs.financeiro.campos.valorVendasIfood.valor, 6000);
    assert.equal(fs.financeiro.campos.taxasEntregadores.status, "nao_aplicavel");
  });

  test("percentuais por segmento — cada regime sobre o SEU faturamento (nunca a base do período inteiro)", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: LINHAS_COM_OPERACIONAL });
    const d = await svc.obterMes(PEDIDO_SET);
    const [mp, fs] = d.comparativoSegmentos;
    perto(mp.percentuais.taxasComissoes.valor, 13);
    perto(mp.percentuais.taxasEntregadores.valor, 12);
    perto(mp.percentuais.totalDeducoes.valor, 30);
    perto(mp.percentuais.receitaLiquida.valor, 70);
    perto(fs.percentuais.taxasComissoes.valor, 20.5);
    assert.equal(fs.percentuais.taxasEntregadores.status, "nao_aplicavel");
    perto(fs.percentuais.totalDeducoes.valor, 30.5);
    perto(fs.percentuais.receitaLiquida.valor, 69.5);
  });

  test("dias com dado financeiro por segmento (amostra) — 3 dias no total, cada um no segmento correto", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: LINHAS_COM_OPERACIONAL });
    const d = await svc.obterMes(PEDIDO_SET);
    const [mp, fs] = d.comparativoSegmentos;
    assert.equal(mp.diasComDados, 2); // 01/09 e 12/09
    assert.equal(fs.diasComDados, 1); // 18/09
  });

  test("mês simples (não misto): comparativoSegmentos é null", async () => {
    const svc = await servico({ modeloAtual: "marketplace", lancamentos: [snap("2026-09-18", 16000, 2530, 1100, 1500)] });
    const d = await svc.obterMes(PEDIDO_SET);
    assert.equal(d.comparativoSegmentos, null);
  });

  test("indicadoresPorSegmento exposto no topo do payload (drawer de composição da aba Indicadores)", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: LINHAS_COM_OPERACIONAL });
    const d = await svc.obterMes(PEDIDO_SET);
    assert.equal(d.indicadoresPorSegmento.length, 2);
    const [mp, fs] = d.indicadoresPorSegmento;
    assert.equal(mp.modelo, "marketplace");
    assert.equal(mp.indicadores.taxas_comissoes.atual, 13);
    assert.equal(mp.indicadores.taxas_comissoes.meta.metaIdeal, 13);
    assert.equal(fs.modelo, "full_service");
    assert.equal(fs.indicadores.taxas_entregadores.naoAplicavel, true);
  });
});
