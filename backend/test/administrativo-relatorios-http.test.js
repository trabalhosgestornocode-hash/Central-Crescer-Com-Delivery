// PAINEL ADMINISTRATIVO — endpoints de ranking e relatório, ponta a ponta.
//
// Fake do Supabase (sem rede). Prova que a regra do snapshot acumulado
// sobrevive à travessia service -> repo -> consolidação, e que o custo em
// queries não cresce com o número de empresas.
//
// Rodar: node --test test/administrativo-relatorios-http.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  rankingDeFaturamento, rankingDeConformidade, relatorioExecutivo,
  evolucaoFaturamento, visaoGeral,
} from "../src/modules/administrativo/administrativo.service.js";

const MOD = "ifood_dashboard";
const HOJE = "2026-09-16";   // D-1 = 15/09
const UUID = (l) => {
  const h = Buffer.from(String(l)).toString("hex").padEnd(32, "0").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function fakeDb(estado) {
  const contador = { queries: 0 };
  function from(tabela) {
    const ctx = { eq: [], inF: null, gte: null, lte: null };
    const casa = (r) =>
      ctx.eq.every(([c, v]) => r[c] === v) &&
      (!ctx.inF || ctx.inF.vals.includes(r[ctx.inF.col])) &&
      (ctx.gte == null || r[ctx.gte.col] >= ctx.gte.v) &&
      (ctx.lte == null || r[ctx.lte.col] <= ctx.lte.v);
    const run = (single) => {
      contador.queries += 1;
      const achados = (estado[tabela] ?? []).filter(casa).map((r) => ({ ...r }));
      return Promise.resolve(single ? { data: achados[0] ?? null, error: null } : { data: achados, error: null });
    };
    const b = {
      select: () => b, eq: (c, v) => (ctx.eq.push([c, v]), b), in: (c, vals) => ((ctx.inF = { col: c, vals }), b),
      gte: (c, v) => ((ctx.gte = { col: c, v }), b), lte: (c, v) => ((ctx.lte = { col: c, v }), b),
      order: () => b, range: (de, ate) => run(false).then((r) => ({ ...r, data: (r.data ?? []).slice(de, ate + 1) })),
      maybeSingle: () => run(true), then: (res, rej) => run(false).then(res, rej),
    };
    return b;
  }
  return { from, __contador: contador };
}

const org = (id, nome) => ({ id, nome, status: "ativa", eh_modelo: false, created_at: "2025-01-01T00:00:00Z" });
const uni = (id, orgId, nome) => ({ id, organizacao_id: orgId, nome, ativo: true, eh_teste: false, created_at: "2025-01-01T00:00:00Z" });

/** Uma linha por dia, com o acumulado crescendo `porDia` a cada dia. */
function acumulado(unidadeId, mes, ate, porDia, over = {}) {
  const out = [];
  for (let d = 1; d <= ate; d++) {
    out.push({
      unidade_id: unidadeId,
      data_lancamento: `${mes}-${String(d).padStart(2, "0")}`,
      valor_vendas_ifood: d * porDia,
      status: "finalizado", situacao: "normal", origem_lancamento: "diario",
      taxas_comissoes: null, servicos_promocoes: null, taxas_entregadores: null, ajustes_favor_loja: null, ajustes_contra_loja: null,
      ...over,
    });
  }
  return out;
}

/**
 * 3 empresas, 1 unidade cada, com acumulado até 15/09:
 *   Alfa  R$ 1.000/dia -> 15.000
 *   Beta  R$   600/dia ->  9.000
 *   Gama  R$   300/dia ->  4.500  (último dia em rascunho)
 * Agosto completo em todas (para a comparação e a sequência).
 */
function cenario() {
  const st = {
    organizacoes: [org(UUID("o1"), "Alfa"), org(UUID("o2"), "Beta"), org(UUID("o3"), "Gama")],
    unidades: [uni(UUID("u1"), UUID("o1"), "Alfa Centro"), uni(UUID("u2"), UUID("o2"), "Beta Sul"), uni(UUID("u3"), UUID("o3"), "Gama Praia")],
    organizacao_modulos: [UUID("o1"), UUID("o2"), UUID("o3")].map((organizacao_id) => ({ organizacao_id, modulo_id: MOD })),
    unidade_modulos: [UUID("u1"), UUID("u2"), UUID("u3")].map((unidade_id) => ({ unidade_id, modulo_id: MOD })),
    lancamentos_financeiros_diarios: [],
  };
  const L = st.lancamentos_financeiros_diarios;
  L.push(...acumulado(UUID("u1"), "2026-08", 31, 900), ...acumulado(UUID("u1"), "2026-09", 15, 1000));
  L.push(...acumulado(UUID("u2"), "2026-08", 31, 500), ...acumulado(UUID("u2"), "2026-09", 15, 600));
  L.push(...acumulado(UUID("u3"), "2026-08", 31, 300), ...acumulado(UUID("u3"), "2026-09", 14, 300));
  // último dia da Gama em rascunho: 15 * 300 = 4.500, confirmado 4.200
  L.push({
    unidade_id: UUID("u3"), data_lancamento: "2026-09-15", valor_vendas_ifood: 4500,
    status: "rascunho", situacao: "normal", origem_lancamento: "diario",
    taxas_comissoes: null, servicos_promocoes: null, taxas_entregadores: null, ajustes_favor_loja: null, ajustes_contra_loja: null,
  });
  return st;
}

// ===========================================================================
describe("ranking de faturamento (endpoint)", () => {
  test("ordena por total e NUNCA soma os snapshots acumulados", async () => {
    const r = await rankingDeFaturamento({ hojeIso: HOJE }, { supabase: fakeDb(cenario()) });
    assert.deepEqual(r.itens.map((i) => i.nome), ["Alfa", "Beta", "Gama"]);
    assert.deepEqual(r.itens.map((i) => i.faturamento.total), [15000, 9000, 4500]);
    // a soma ingênua das 15 linhas da Alfa seria 120.000
    assert.notEqual(r.itens[0].faturamento.total, 120000);
    assert.equal(r.rede.total, 28500);
    assert.equal(r.periodo, "2026-09");
  });

  test("a parte provisória chega ao ranking, separada", async () => {
    const r = await rankingDeFaturamento({ hojeIso: HOJE }, { supabase: fakeDb(cenario()) });
    const gama = r.itens.find((i) => i.nome === "Gama");
    assert.equal(gama.faturamento.total, 4500);
    assert.equal(gama.faturamento.confirmado, 4200);
    assert.equal(gama.faturamento.provisorio, 300);
    assert.equal(gama.faturamento.incluiProvisorio, true);

    assert.equal(r.rede.provisorio, 300);
    assert.equal(r.rede.incluiProvisorio, true);
    assert.equal(r.rede.confirmado + r.rede.provisorio, r.rede.total);
  });

  test("escopo=unidades ranqueia unidades e traz a empresa junto", async () => {
    const r = await rankingDeFaturamento({ hojeIso: HOJE, escopo: "unidades" }, { supabase: fakeDb(cenario()) });
    assert.equal(r.escopo, "unidades");
    assert.deepEqual(r.itens.map((i) => i.nome), ["Alfa Centro", "Beta Sul", "Gama Praia"]);
    assert.equal(r.itens[0].empresaNome, "Alfa");
  });

  test("cobertura viaja junto e é separada do valor", async () => {
    const r = await rankingDeFaturamento({ hojeIso: HOJE }, { supabase: fakeDb(cenario()) });
    assert.equal(r.itens[0].cobertura.esperados, 15, "01..15/09");
    assert.equal(r.itens[0].cobertura.completos, 15);
    assert.equal(r.itens[0].cobertura.taxa, 1);
  });

  test("limite corta o topo", async () => {
    const r = await rankingDeFaturamento({ hojeIso: HOJE, limite: 2 }, { supabase: fakeDb(cenario()) });
    assert.equal(r.itens.length, 2);
    assert.equal(r.total, 3, "o total continua sendo o universo");
  });

  test("período passado usa o mês fechado inteiro", async () => {
    const r = await rankingDeFaturamento({ hojeIso: HOJE, mes: "2026-08" }, { supabase: fakeDb(cenario()) });
    assert.equal(r.periodo, "2026-08");
    assert.equal(r.mesCorrente, false);
    assert.equal(r.d1, "2026-08-31");
    assert.deepEqual(r.itens.map((i) => i.faturamento.total), [31 * 900, 31 * 500, 31 * 300]);
  });
});

describe("ranking de conformidade (endpoint)", () => {
  test("desc traz os melhores; asc traz quem precisa de atenção", async () => {
    const st = cenario();
    // Beta deixa de lançar 5 dias -> conformidade menor
    st.lancamentos_financeiros_diarios = st.lancamentos_financeiros_diarios
      .filter((r) => !(r.unidade_id === UUID("u2") && r.data_lancamento >= "2026-09-11"));

    const melhores = await rankingDeConformidade({ hojeIso: HOJE }, { supabase: fakeDb(st) });
    const atencao = await rankingDeConformidade({ hojeIso: HOJE, ordem: "asc" }, { supabase: fakeDb(st) });
    assert.equal(atencao.itens[0].nome, "Beta", "a menor conformidade encabeça a lista de atenção");
    assert.equal(melhores.itens[melhores.itens.length - 1].nome, "Beta");
    assert.ok(atencao.itens[0].conformidadeMes < 1);
  });
});

describe("evolução diária (endpoint)", () => {
  test("devolve o delta por dia, não o acumulado", async () => {
    const r = await evolucaoFaturamento({ hojeIso: HOJE }, { supabase: fakeDb(cenario()) });
    assert.equal(r.serie.length, 15, "só até o D-1; dia futuro não entra");
    assert.equal(r.serie[0].valor, 1900, "1000 + 600 + 300 no dia 1");
    assert.equal(r.serie[14].acumulado, 28500);
    assert.ok(r.serie.every((p) => p.valor === 1900), "acumulado linear -> delta constante");
  });

  test("filtro por empresa isola a série daquela organização", async () => {
    const r = await evolucaoFaturamento({ hojeIso: HOJE, organizacaoId: UUID("o1") }, { supabase: fakeDb(cenario()) });
    assert.equal(r.unidades, 1);
    assert.equal(r.serie[14].acumulado, 15000);
  });
});

describe("relatório executivo (endpoint)", () => {
  test("reúne operação, conformidade, faturamento, prioridades e rankings", async () => {
    const r = await relatorioExecutivo({ hojeIso: HOJE }, { supabase: fakeDb(cenario()) });
    assert.equal(r.periodo, "2026-09");
    assert.equal(r.operacao.empresasMonitoradas, 3);
    assert.equal(r.operacao.unidadesMonitoradas, 3);
    assert.equal(r.faturamento.total, 28500);
    assert.equal(r.faturamento.confirmado, 28200);
    assert.equal(r.faturamento.provisorio, 300);
    assert.equal(r.faturamento.liderEmpresa.nome, "Alfa");
    assert.equal(r.faturamento.liderUnidade.nome, "Alfa Centro");
    assert.equal(r.rankings.faturamentoEmpresas[0].nome, "Alfa");
    assert.ok(Array.isArray(r.rankings.atencaoEmpresas));
  });

  test("compara com o mês anterior no PERÍODO EQUIVALENTE (1..15/ago, não agosto inteiro)", async () => {
    const r = await relatorioExecutivo({ hojeIso: HOJE }, { supabase: fakeDb(cenario()) });
    const c = r.comparacao;
    assert.equal(c.periodo, "2026-08");
    assert.equal(c.ate, "2026-08-15", "mesmo número de dias corridos");
    assert.equal(c.diasEquivalentes, 15);
    // agosto até o dia 15: 15*(900+500+300) = 25.500  vs  setembro 28.500
    assert.equal(c.faturamento.anterior, 25500);
    assert.ok(Math.abs(c.faturamento.variacao - (28500 - 25500) / 25500) < 1e-9);
    assert.notEqual(c.faturamento.anterior, 31 * (900 + 500 + 300), "nunca compara 15 dias com 31");
  });

  test("a comparação avisa quando qualquer lado inclui valor provisório", async () => {
    const r = await relatorioExecutivo({ hojeIso: HOJE }, { supabase: fakeDb(cenario()) });
    assert.equal(r.comparacao.faturamento.incluiProvisorio, true);
  });
});

describe("Visão Geral — consolidado financeiro", () => {
  test("traz total, confirmado, provisório, cobertura e líderes", async () => {
    const vg = await visaoGeral({ hojeIso: HOJE }, { supabase: fakeDb(cenario()) });
    assert.equal(vg.faturamento.total, 28500);
    assert.equal(vg.faturamento.provisorio, 300);
    assert.equal(vg.faturamento.incluiProvisorio, true);
    // 44/45: o dia 15 da Gama está em rascunho -> conta como INCOMPLETO na
    // cobertura, mesmo com o valor entrando no faturamento. As duas medidas
    // são separadas de propósito.
    assert.equal(vg.faturamento.cobertura.completos, 44);
    assert.equal(vg.faturamento.cobertura.esperados, 45);
    assert.equal(vg.faturamento.liderEmpresa.nome, "Alfa");
  });
});

describe("performance", () => {
  test("o ranking não cria query por empresa (20 empresas = mesmo custo que 3)", async () => {
    const mk = (nOrgs) => {
      const st = { organizacoes: [], unidades: [], organizacao_modulos: [], unidade_modulos: [], lancamentos_financeiros_diarios: [] };
      for (let i = 0; i < nOrgs; i++) {
        const o = UUID(`org${i}`), u = UUID(`uni${i}`);
        st.organizacoes.push(org(o, `Org ${i}`));
        st.unidades.push(uni(u, o, `Uni ${i}`));
        st.organizacao_modulos.push({ organizacao_id: o, modulo_id: MOD });
        st.unidade_modulos.push({ unidade_id: u, modulo_id: MOD });
        st.lancamentos_financeiros_diarios.push(...acumulado(u, "2026-08", 31, 100 + i), ...acumulado(u, "2026-09", 15, 100 + i));
      }
      return st;
    };
    const db3 = fakeDb(mk(3));
    const db20 = fakeDb(mk(20));
    await rankingDeFaturamento({ hojeIso: HOJE }, { supabase: db3 });
    await rankingDeFaturamento({ hojeIso: HOJE }, { supabase: db20 });
    assert.equal(db3.__contador.queries, db20.__contador.queries, "N+1 no ranking");
    assert.ok(db3.__contador.queries <= 6, `esperado <= 6, veio ${db3.__contador.queries}`);
  });

  test("o relatório executivo custa 2 avaliações de frota (período + equivalente), não N", async () => {
    const db = fakeDb(cenario());
    const t0 = performance.now();
    await relatorioExecutivo({ hojeIso: HOJE }, { supabase: db });
    const ms = performance.now() - t0;
    assert.ok(db.__contador.queries <= 12, `esperado <= 12 (2 frotas), veio ${db.__contador.queries}`);
    assert.ok(ms < 500, `levou ${ms.toFixed(0)}ms`);
  });
});
