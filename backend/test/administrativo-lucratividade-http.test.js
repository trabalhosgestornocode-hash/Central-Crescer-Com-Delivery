// PAINEL ADMINISTRATIVO — endpoint /relatorios/lucratividade, ponta a ponta.
//
// Fake do Supabase (sem rede). A regra central desta suíte: a UNIDADE é a
// entidade ranqueada — cada unidade da frota iFood monitorada disputa posição
// individualmente. A empresa viaja em cada linha só como contexto e NUNCA soma
// suas unidades para competir. Só os indicadores globais de REDE consolidam.
//
// Rodar: node --test test/administrativo-lucratividade-http.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { lucratividadeSemanal } from "../src/modules/administrativo/administrativo.service.js";

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
const uni = (id, orgId, nome, modelo = null) => ({ id, organizacao_id: orgId, nome, ativo: true, eh_teste: false, created_at: "2025-01-01T00:00:00Z", modelo_logistico_ifood: modelo });
const metaGlobal = (modelo, indicador, metaIdeal, limite) => ({ organizacao_id: null, unidade_id: null, modelo_logistico: modelo, indicador, meta_ideal: metaIdeal, limite });

/** Linhas diárias com acumulado do mês crescendo (fat/ded por dia). */
function acumulado(unidadeId, mes, ate, fatDia, dedDia) {
  const out = [];
  for (let d = 1; d <= ate; d++) {
    out.push({
      unidade_id: unidadeId,
      data_lancamento: `${mes}-${String(d).padStart(2, "0")}`,
      valor_vendas_ifood: d * fatDia,
      taxas_comissoes: d * dedDia,
      servicos_promocoes: 0, taxas_entregadores: 0, ajustes_favor_loja: 0, ajustes_contra_loja: 0,
      status: "finalizado", situacao: "normal", origem_lancamento: "diario",
    });
  }
  return out;
}

/**
 * Frota — Semana 2 de setembro/2026 (08–14, 7 dias; fim − véspera do dia 07):
 *   Grupo JV / JV Loja A  (MP)  800/dia -> 5.600 ; deduções  60/dia (7,5%)
 *   Grupo JV / JV Loja B  (MP)  700/dia -> 4.900 ; deduções 210/dia (30%)
 *   Alfa    / Alfa Centro (MP) 1000/dia -> 7.000 ; deduções 100/dia (10%)
 *   Beta    / Beta Sul   (FS)   500/dia -> 3.500 ; deduções 150/dia (30%)
 *   Gama    / Gama Praia (sem modelo)   300/dia -> 2.100
 *
 * A SOMA das duas unidades do Grupo JV (10.500) é maior que a maior unidade
 * isolada (Alfa Centro, 7.000) — de propósito: é o caso "injusto" que a
 * mudança para ranking por unidade resolve.
 * Agosto tem ritmo próprio (para comparar a Semana 1 de setembro com a Semana 4
 * de agosto, que tem 10 dias — comparação de valores reais, sem normalizar).
 * Metas globais: MP total_deducoes 12%/15% ; FS 20%/25%.
 */
function cenario() {
  const st = {
    organizacoes: [org(UUID("jv"), "Grupo JV"), org(UUID("o1"), "Alfa"), org(UUID("o2"), "Beta"), org(UUID("o3"), "Gama")],
    unidades: [
      uni(UUID("a"), UUID("jv"), "JV Loja A", "marketplace"),
      uni(UUID("b"), UUID("jv"), "JV Loja B", "marketplace"),
      uni(UUID("u1"), UUID("o1"), "Alfa Centro", "marketplace"),
      uni(UUID("u2"), UUID("o2"), "Beta Sul", "full_service"),
      uni(UUID("u3"), UUID("o3"), "Gama Praia", null),
    ],
    organizacao_modulos: [UUID("jv"), UUID("o1"), UUID("o2"), UUID("o3")].map((organizacao_id) => ({ organizacao_id, modulo_id: MOD })),
    unidade_modulos: [UUID("a"), UUID("b"), UUID("u1"), UUID("u2"), UUID("u3")].map((unidade_id) => ({ unidade_id, modulo_id: MOD })),
    metas_indicadores: [
      metaGlobal("marketplace", "total_deducoes", 0.12, 0.15),
      metaGlobal("full_service", "total_deducoes", 0.20, 0.25),
    ],
    lancamentos_financeiros_diarios: [],
  };
  const L = st.lancamentos_financeiros_diarios;
  // agosto (para a semana anterior, que cruza a virada) com ritmo levemente menor
  L.push(...acumulado(UUID("a"), "2026-08", 31, 720, 54), ...acumulado(UUID("a"), "2026-09", 20, 800, 60));
  L.push(...acumulado(UUID("b"), "2026-08", 31, 630, 189), ...acumulado(UUID("b"), "2026-09", 20, 700, 210));
  L.push(...acumulado(UUID("u1"), "2026-08", 31, 900, 90), ...acumulado(UUID("u1"), "2026-09", 20, 1000, 100));
  L.push(...acumulado(UUID("u2"), "2026-08", 31, 450, 135), ...acumulado(UUID("u2"), "2026-09", 20, 500, 150));
  L.push(...acumulado(UUID("u3"), "2026-08", 31, 300, 30), ...acumulado(UUID("u3"), "2026-09", 20, 300, 30));
  return st;
}

// Semana 2 de setembro (08–14) — bloco totalmente vencido (D-1 = 15/09).
const semana = (extra = {}) => lucratividadeSemanal({ hojeIso: HOJE, semana: "2026-09-09", ...extra }, { supabase: fakeDb(cenario()) });

describe("contrato do payload", () => {
  test("o ranking é por UNIDADE: `unidades` é sempre um array; nada de `empresas`/`lojas`", async () => {
    const r = await semana();
    assert.ok(Array.isArray(r.unidades), "`unidades` precisa ser um array");
    assert.ok(!("empresas" in r), "contrato antigo `empresas` não pode voltar");
    assert.ok(!("lojas" in r), "contrato antigo `lojas` não pode voltar");
    // frota vazia também respeita o contrato
    const vazio = await lucratividadeSemanal({ hojeIso: HOJE, semana: "2026-09-09" },
      { supabase: fakeDb({ organizacoes: [], unidades: [], organizacao_modulos: [], unidade_modulos: [], metas_indicadores: [], lancamentos_financeiros_diarios: [] }) });
    assert.ok(Array.isArray(vazio.unidades) && vazio.unidades.length === 0);
    assert.ok(!("empresas" in vazio) && !("lojas" in vazio));
  });
});

describe("ranking POR UNIDADE (não consolida empresa)", () => {
  test("cada unidade ocupa posição própria; a empresa nunca soma para competir", async () => {
    const r = await semana();
    const nomes = r.unidades.map((u) => u.nome);
    // nenhuma linha é a empresa consolidada
    assert.ok(!nomes.includes("Grupo JV"));
    // ordem por faturamento da unidade: Alfa Centro (7000) > JV Loja A (5600) > JV Loja B (4900) > Beta Sul (3500) > Gama Praia (2100)
    assert.deepEqual(nomes, ["Alfa Centro", "JV Loja A", "JV Loja B", "Beta Sul", "Gama Praia"]);
    assert.deepEqual(r.unidades.map((u) => u.faturamento), [7000, 5600, 4900, 3500, 2100]);
    // a soma do Grupo JV (10.500) NÃO vira uma posição no topo
    assert.notEqual(r.unidades[0].faturamento, 10500);
  });

  test("as duas unidades do Grupo JV aparecem separadas, cada uma com seu contexto de empresa", async () => {
    const r = await semana();
    const jv = r.unidades.filter((u) => u.organizacaoId === UUID("jv"));
    assert.equal(jv.length, 2);
    for (const u of jv) {
      assert.equal(u.empresaNome, "Grupo JV");
      assert.equal(u.organizacaoId, UUID("jv"));
      assert.ok(u.unidadeId);
    }
    assert.deepEqual(jv.map((u) => u.nome).sort(), ["JV Loja A", "JV Loja B"]);
  });

  test("faturamento/receita líquida por unidade = delta do snapshot do bloco", async () => {
    const r = await semana();
    const alfa = r.unidades.find((u) => u.nome === "Alfa Centro");
    // Semana 2 (08–14): snapshot(14) − snapshot(07) = 14000 − 7000 = 7000
    assert.equal(alfa.faturamento, 7000);
    assert.equal(alfa.deducoes, 700);
    assert.equal(alfa.receitaLiquida, 6300);
    assert.equal(Math.round(alfa.rentabilidadePct), 90);
    assert.equal(alfa.modeloLogisticoRotulo, "Marketplace");
  });
});

describe("comparação com o BLOCO anterior (mesma régua, valores reais)", () => {
  test("Semana 2 (08–14) compara com a Semana 1 (01–07) do mesmo mês", async () => {
    const r = await semana();
    const s = r.semana;
    assert.equal(s.indice, 2);
    assert.equal(s.inicio, "2026-09-08");
    assert.equal(s.fim, "2026-09-14");
    assert.deepEqual(
      { indice: s.anterior.indice, inicio: s.anterior.inicio, fim: s.anterior.fim },
      { indice: 1, inicio: "2026-09-01", fim: "2026-09-07" },
    );
    const alfa = r.unidades.find((u) => u.nome === "Alfa Centro");
    // Semana 1 de setembro = snapshot(07) − 0 = 7000 ; atual 7000 -> variação 0
    assert.equal(alfa.faturamentoAnterior, 7000);
    assert.equal(alfa.variacaoFaturamento, 0);
  });

  test("Semana 1 (01–07) compara com a Semana 4 (22–31) do mês anterior — 10 dias, sem normalizar", async () => {
    const r = await lucratividadeSemanal({ hojeIso: HOJE, semana: "2026-09-03" }, { supabase: fakeDb(cenario()) });
    const s = r.semana;
    assert.equal(s.indice, 1);
    assert.deepEqual(
      { indice: s.anterior.indice, mes: s.anterior.mes, inicio: s.anterior.inicio, fim: s.anterior.fim },
      { indice: 4, mes: 8, inicio: "2026-08-22", fim: "2026-08-31" },
    );
    const alfa = r.unidades.find((u) => u.nome === "Alfa Centro");
    // atual (Semana 1 set) = 7 × 1000 = 7000
    assert.equal(alfa.faturamento, 7000);
    // anterior (Semana 4 ago, 10 dias) = snapshot(31) − snapshot(21) = 31×900 − 21×900 = 9000
    assert.equal(alfa.faturamentoAnterior, 9000);
    assert.ok(alfa.variacaoFaturamento < 0, "queda real, sem média diária");
  });
});

describe("indicadores GLOBAIS de rede (aqui SIM soma todas as unidades)", () => {
  test("faturamento e receita líquida da rede = soma de TODAS as unidades", async () => {
    const r = await semana();
    // 7000 + 5600 + 4900 + 3500 + 2100 = 23100
    assert.equal(r.rede.faturamento, 23100);
    assert.equal(r.rede.unidadesMonitoradas, 5);
    assert.equal(r.rede.empresasMonitoradas, 4);
    assert.ok(r.rede.rentabilidadeMediaRede > 0 && r.rede.rentabilidadeMediaRede < 100);
    // soma das receitas líquidas das unidades
    const somaRL = r.unidades.reduce((s, u) => s + (u.receitaLiquida ?? 0), 0);
    assert.equal(r.rede.receitaLiquida, somaRL);
  });
});

describe("eficiência de deduções — modelo-aware, por unidade", () => {
  test("cada unidade é medida frente ao limite do SEU modelo", async () => {
    const r = await semana();
    const a = r.unidades.find((u) => u.nome === "JV Loja A");
    const beta = r.unidades.find((u) => u.nome === "Beta Sul");
    assert.equal(a.meta.limite, 15);
    assert.equal(Math.round(a.deducoesPct * 10) / 10, 7.5);
    assert.equal(a.folgaLimitePp, 7.5);
    assert.equal(a.status.chave, "dentro_da_meta");

    assert.equal(beta.meta.limite, 25);
    assert.equal(Math.round(beta.deducoesPct), 30);
    assert.equal(beta.status.chave, "atencao");
  });

  test("destaques melhor/pior eficiência são UNIDADES (só entre as com meta)", async () => {
    const r = await semana();
    assert.equal(r.destaques.melhorEficiencia.nome, "JV Loja A");
    assert.equal(r.destaques.melhorEficiencia.empresaNome, "Grupo JV");
    assert.equal(r.destaques.piorEficiencia.nome, "JV Loja B");
  });

  test("unidade sem modelo -> sem_dados, fora dos destaques", async () => {
    const r = await semana();
    const gama = r.unidades.find((u) => u.nome === "Gama Praia");
    assert.equal(gama.status.chave, "sem_dados");
    assert.equal(gama.folgaLimitePp, null);
    assert.notEqual(r.destaques.melhorEficiencia.nome, "Gama Praia");
  });
});

describe("destaque 'maior rentabilidade' e recortes 'menores' — por unidade", () => {
  test("maior rentabilidade aponta a UNIDADE líder, com contexto de empresa", async () => {
    const r = await semana();
    assert.ok(r.destaques.maiorRentabilidade.unidadeId);
    assert.ok(r.destaques.maiorRentabilidade.empresaNome);
    // JV Loja A: deduções 7,5% -> rentabilidade ~92,5%, a maior
    assert.equal(r.destaques.maiorRentabilidade.nome, "JV Loja A");
  });

  test("10 menores em faturamento / rentabilidade são UNIDADES, com posição geral por unidade", async () => {
    const r = await semana();
    for (const linha of [...r.atencao.menorFaturamento, ...r.atencao.menorRentabilidade]) {
      assert.ok(linha.unidadeId, "cada recorte é uma unidade");
      assert.ok(linha.empresaNome, "mantém o contexto da empresa");
    }
    // menor faturamento da frota = Gama Praia (2100)
    assert.equal(r.atencao.menorFaturamento[0].nome, "Gama Praia");
    assert.equal(r.atencao.menorFaturamento[0].posicaoGeral, 5, "última das 5 unidades por faturamento");
  });
});

describe("navegação por bloco (nunca cruza mês, nunca Semana 5)", () => {
  test("bloco de D-1: podeAvancar só quando o próximo bloco já começou", async () => {
    // D-1 = 15/09 -> Semana 3 (15–21)
    const s3 = await lucratividadeSemanal({ hojeIso: HOJE, semana: "2026-09-15" }, { supabase: fakeDb(cenario()) });
    assert.equal(s3.semana.indice, 3);
    assert.equal(s3.semana.inicio, "2026-09-15");
    assert.equal(s3.semana.ehSemanaCorrente, true);
    assert.equal(s3.podeAvancar, false, "Semana 4 (22+) ainda não começou");
    // Semana 2 (08–14) já tem a Semana 3 iniciada em D-1
    assert.equal((await semana()).podeAvancar, true);
  });

  test("sem `semana` usa o bloco que contém D-1", async () => {
    const r = await lucratividadeSemanal({ hojeIso: HOJE }, { supabase: fakeDb(cenario()) });
    assert.equal(r.semana.indice, 3);
    assert.equal(r.semana.inicio, "2026-09-15");
  });

  test("dias 22+ são sempre Semana 4 — nunca Semana 5", async () => {
    const r = await lucratividadeSemanal({ hojeIso: "2026-10-02", semana: "2026-09-29" }, { supabase: fakeDb(cenario()) });
    assert.equal(r.semana.indice, 4);
    assert.equal(r.semana.inicio, "2026-09-22");
    assert.equal(r.semana.fim, "2026-09-30");
  });

  test("Semana 4 -> Semana 1 do mês seguinte é o `anterior` na volta", async () => {
    // Semana 1 de outubro tem como anterior a Semana 4 de setembro
    const r = await lucratividadeSemanal({ hojeIso: "2026-10-10", semana: "2026-10-03" }, { supabase: fakeDb(cenario()) });
    assert.equal(r.semana.indice, 1);
    assert.equal(r.semana.mes, 10);
    assert.deepEqual(
      { indice: r.semana.anterior.indice, mes: r.semana.anterior.mes, fim: r.semana.anterior.fim },
      { indice: 4, mes: 9, fim: "2026-09-30" },
    );
  });

  test("bloco inteiramente futuro -> 400", async () => {
    await assert.rejects(
      () => lucratividadeSemanal({ hojeIso: HOJE, semana: "2026-10-05" }, { supabase: fakeDb(cenario()) }),
      /ainda não começou/i,
    );
  });
});

describe("recorte 'operações que exigem atenção' com muitas unidades", () => {
  test("no máximo 10 UNIDADES em cada lista, com posição geral por unidade", async () => {
    const st = { organizacoes: [], unidades: [], organizacao_modulos: [], unidade_modulos: [], metas_indicadores: [], lancamentos_financeiros_diarios: [] };
    // 6 empresas × 2 unidades = 12 unidades
    for (let e = 0; e < 6; e++) {
      const o = UUID(`o${e}`);
      st.organizacoes.push(org(o, `Org ${e}`));
      st.organizacao_modulos.push({ organizacao_id: o, modulo_id: MOD });
      for (let k = 0; k < 2; k++) {
        const idx = e * 2 + k;
        const u = UUID(`u${idx}`);
        st.unidades.push(uni(u, o, `Uni ${idx}`, "marketplace"));
        st.unidade_modulos.push({ unidade_id: u, modulo_id: MOD });
        st.lancamentos_financeiros_diarios.push(
          ...acumulado(u, "2026-08", 31, 100 + idx * 8, 10),
          ...acumulado(u, "2026-09", 20, 100 + idx * 8, 10),
        );
      }
    }
    const r = await lucratividadeSemanal({ hojeIso: HOJE, semana: "2026-09-09" }, { supabase: fakeDb(st) });
    assert.equal(r.unidades.length, 12, "o ranking principal traz TODAS as unidades");
    assert.equal(r.atencao.menorFaturamento.length, 10);
    assert.equal(r.atencao.menorRentabilidade.length, 10);
    assert.equal(r.atencao.menorFaturamento[0].nome, "Uni 0", "a menor faturamento encabeça");
    assert.equal(r.atencao.menorFaturamento[0].posicaoGeral, 12);
  });
});

describe("custo em queries", () => {
  test("não cresce com o número de unidades (sem N+1)", async () => {
    const db = fakeDb(cenario());
    await lucratividadeSemanal({ hojeIso: HOJE, semana: "2026-09-09" }, { supabase: db });
    assert.ok(db.__contador.queries <= 8, `esperado <= 8, veio ${db.__contador.queries}`);
  });
});
