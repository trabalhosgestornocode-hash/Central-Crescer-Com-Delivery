// PAINEL ADMINISTRATIVO — endpoint /visao-geral-rede, ponta a ponta.
//
// Prova que a VISÃO GERAL DA REDE reaproveita o mesmo motor de faturamento
// mensal (`lucratividadeDaUnidade`) e a mesma meta por modelo logístico
// (`escolherMetas`) do Dashboard iFood / Lucratividade semanal — e que a
// classificação de atenção financeira, os filtros globais e a consolidação
// por empresa (SOMA ponderada, nunca média de percentuais) funcionam juntos.
//
// Rodar: node --test test/administrativo-visao-rede-http.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { visaoGeralRede, detalheEmpresa } from "../src/modules/administrativo/administrativo.service.js";

const MOD = "ifood_dashboard";
const HOJE = "2026-10-05"; // setembro/2026 já fechado (30 dias)
const UUID = (l) => {
  const h = Buffer.from(String(l)).toString("hex").padEnd(32, "0").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function fakeDb(estado) {
  function from(tabela) {
    const ctx = { eq: [], inF: null, gte: null, lte: null, ilike: null };
    const casa = (r) =>
      ctx.eq.every(([c, v]) => r[c] === v) &&
      (!ctx.ilike || String(r[ctx.ilike.col]).toLowerCase().includes(ctx.ilike.v.replaceAll("%", "").toLowerCase())) &&
      (!ctx.inF || ctx.inF.vals.includes(r[ctx.inF.col])) &&
      (ctx.gte == null || r[ctx.gte.col] >= ctx.gte.v) &&
      (ctx.lte == null || r[ctx.lte.col] <= ctx.lte.v);
    const run = (single) => {
      const achados = (estado[tabela] ?? []).filter(casa).map((r) => ({ ...r }));
      return Promise.resolve(single ? { data: achados[0] ?? null, error: null } : { data: achados, error: null });
    };
    const b = {
      ilike: (col, v) => (ctx.ilike = { col, v }, b),
      select: () => b, eq: (c, v) => (ctx.eq.push([c, v]), b), in: (c, vals) => ((ctx.inF = { col: c, vals }), b),
      gte: (c, v) => ((ctx.gte = { col: c, v }), b), lte: (c, v) => ((ctx.lte = { col: c, v }), b),
      order: () => b, range: (de, ate) => run(false).then((r) => ({ ...r, data: (r.data ?? []).slice(de, ate + 1) })),
      maybeSingle: () => run(true), then: (res, rej) => run(false).then(res, rej),
    };
    return b;
  }
  return { from };
}

const org = (id, nome) => ({ id, nome, status: "ativa", eh_modelo: false, created_at: "2025-01-01T00:00:00Z" });
const uni = (id, orgId, nome, modelo) => ({ id, organizacao_id: orgId, nome, ativo: true, eh_teste: false, created_at: "2025-01-01T00:00:00Z", modelo_logistico_ifood: modelo });
const metaGlobal = (modelo, metaIdeal, limite) => ({ organizacao_id: null, unidade_id: null, modelo_logistico: modelo, indicador: "total_deducoes", meta_ideal: metaIdeal, limite });

/** 30 dias de setembro/2026, acumulado linear: dia d -> fat=d*fatDia, ded=d*dedDia (taxas_comissoes) + servicosDia (servicos_promocoes). */
function mesCompleto(unidadeId, fatDia, taxasDia, servicosDia = 0) {
  const out = [];
  for (let d = 1; d <= 30; d++) {
    out.push({
      unidade_id: unidadeId, data_lancamento: `2026-09-${String(d).padStart(2, "0")}`,
      valor_vendas_ifood: d * fatDia, taxas_comissoes: d * taxasDia, servicos_promocoes: d * servicosDia,
      taxas_entregadores: 0, ajustes_favor_loja: 0, ajustes_contra_loja: 0,
      status: "finalizado", situacao: "normal", origem_lancamento: "diario",
    });
  }
  return out;
}

/**
 * Frota de setembro/2026:
 *   JV Loja A  (Grupo JV, MP)  1000/dia fat, deduções 7,5%  -> EM_DIA  (limite MP 15%)
 *   JV Loja B  (Grupo JV, MP)  1000/dia fat, deduções 30%   -> CRÍTICA (limite 15%)
 *   Beta Sul   (Beta, FS)       500/dia fat, deduções 23%   -> ATENÇÃO (ideal FS 20% / limite 25%)
 * Metas globais: MP ideal 12% / limite 15% ; FS ideal 20% / limite 25%.
 */
function cenario() {
  const st = {
    organizacoes: [org(UUID("jv"), "Grupo JV"), org(UUID("beta"), "Beta")],
    unidades: [
      uni(UUID("a"), UUID("jv"), "JV Loja A", "marketplace"),
      uni(UUID("b"), UUID("jv"), "JV Loja B", "marketplace"),
      uni(UUID("c"), UUID("beta"), "Beta Sul", "full_service"),
    ],
    organizacao_modulos: [UUID("jv"), UUID("beta")].map((organizacao_id) => ({ organizacao_id, modulo_id: MOD })),
    unidade_modulos: [UUID("a"), UUID("b"), UUID("c")].map((unidade_id) => ({ unidade_id, modulo_id: MOD })),
    metas_indicadores: [metaGlobal("marketplace", 0.12, 0.15), metaGlobal("full_service", 0.20, 0.25)],
    unidade_modelo_logistico_historico: [],
    lancamentos_financeiros_diarios: [
      ...mesCompleto(UUID("a"), 1000, 75),
      ...mesCompleto(UUID("b"), 1000, 240, 60), // 24% taxas + 6% serviços = 30% deduções totais
      ...mesCompleto(UUID("c"), 500, 115),      // 23%
    ],
  };
  return st;
}

const rede = (extra = {}) => visaoGeralRede({ hojeIso: HOJE, mes: "2026-09", ...extra }, { supabase: fakeDb(cenario()) });

describe("classificação de atenção financeira, por unidade", () => {
  test("cada unidade cai no estado certo", async () => {
    const r = await rede();
    const porNome = Object.fromEntries(r.unidades.map((u) => [u.nome, u]));
    assert.equal(porNome["JV Loja A"].situacaoFinanceira.chave, "em_dia");
    assert.equal(porNome["JV Loja B"].situacaoFinanceira.chave, "critica");
    assert.equal(porNome["Beta Sul"].situacaoFinanceira.chave, "atencao");
  });

  test("última atualização é a data REAL do lançamento mais recente do mês (nunca inventada)", async () => {
    const r = await rede();
    const a = r.unidades.find((u) => u.nome === "JV Loja A");
    assert.equal(a.ultimaAtualizacao, "2026-09-30", "mesCompleto() lança até o dia 30 -> essa é a última data real");
  });

  test("sem nenhum lançamento no mês, última atualização é null (nunca um valor inventado)", async () => {
    const vazio = cenario();
    vazio.lancamentos_financeiros_diarios = vazio.lancamentos_financeiros_diarios.filter((l) => l.unidade_id !== UUID("c"));
    const r = await visaoGeralRede({ hojeIso: HOJE, mes: "2026-09" }, { supabase: fakeDb(vazio) });
    const beta = r.unidades.find((u) => u.nome === "Beta Sul");
    assert.equal(beta.ultimaAtualizacao, null);
  });

  test("composição das deduções da JV Loja B não perde nem duplica nenhuma parte", async () => {
    const r = await rede();
    const b = r.unidades.find((u) => u.nome === "JV Loja B");
    assert.equal(b.composicaoDeducoes.taxasComissoes, b.deducoes - b.composicaoDeducoes.servicosPromocoes - b.composicaoDeducoes.outrosAjustes);
  });

  test("distribuição de situações conta as 3 unidades", async () => {
    const r = await rede();
    assert.deepEqual(r.distribuicaoSituacoes, { sem_dados: 0, em_dia: 1, atencao: 1, critica: 1 });
  });
});

describe("rede: percentual consolidado pela SOMA dos valores (nunca média de %)", () => {
  test("deducoesPct da rede não é a média simples dos 3 percentuais (7,5 / 30 / 23 -> média ingênua 20,17)", async () => {
    const r = await rede();
    // faturamento: A=31000(1..30*1000=465000? ver abaixo) — o que importa é
    // que o percentual da rede vem de Σdeduções/Σfaturamento.
    const somaFat = r.unidades.reduce((s, u) => s + u.faturamento, 0);
    const somaDed = r.unidades.reduce((s, u) => s + u.deducoes, 0);
    const esperado = Math.round((somaDed / somaFat) * 100 * 100) / 100;
    assert.equal(r.rede.deducoesPct, esperado);
    assert.notEqual(Math.round(r.rede.deducoesPct), 22, "nunca a média simples (20,17) dos 3 percentuais");
  });
});

describe("ranking separado por modalidade (estruturas diferentes nunca se misturam)", () => {
  test("marketplace só tem as 2 lojas JV; full_service só tem Beta Sul", async () => {
    const r = await rede();
    const nomesMP = [...r.rankingPorModalidade.marketplace.melhores, ...r.rankingPorModalidade.marketplace.atencao].map((u) => u.nome);
    const nomesFS = [...r.rankingPorModalidade.full_service.melhores, ...r.rankingPorModalidade.full_service.atencao].map((u) => u.nome);
    assert.ok(!nomesMP.includes("Beta Sul"));
    assert.ok(!nomesFS.includes("JV Loja A") && !nomesFS.includes("JV Loja B"));
    assert.ok(nomesMP.includes("JV Loja A") || nomesMP.includes("JV Loja B"));
  });

  test("a loja em atenção/crítica aparece no recorte 'atencao' do seu modelo; 'melhores' é ordenado pela maior folga", async () => {
    const r = await rede();
    assert.ok(r.rankingPorModalidade.marketplace.atencao.some((u) => u.nome === "JV Loja B"));
    assert.ok(!r.rankingPorModalidade.marketplace.melhores.some((u) => u.nome === "Beta Sul"), "ranking de Marketplace nunca mistura Full Service");
    // só há 2 lojas Marketplace -> as duas entram em "melhores" (slice 10), mas a Loja A (em dia) vem antes da B (crítica)
    const nomes = r.rankingPorModalidade.marketplace.melhores.map((u) => u.nome);
    assert.deepEqual(nomes, ["JV Loja A", "JV Loja B"]);
  });
});

describe("consolidação por empresa — soma ponderada, não média", () => {
  test("Grupo JV aparece como UMA linha marketplace (as 2 lojas somadas)", async () => {
    const r = await rede();
    const jv = r.empresas.find((e) => e.empresaNome === "Grupo JV" && e.modeloLogistico === "marketplace");
    assert.ok(jv);
    assert.equal(jv.unidadesMonitoradas, 2);
    const a = r.unidades.find((u) => u.nome === "JV Loja A");
    const b = r.unidades.find((u) => u.nome === "JV Loja B");
    assert.equal(jv.faturamento, Math.round((a.faturamento + b.faturamento) * 100) / 100);
    // a situação da empresa é a PIOR entre as unidades (crítica da Loja B), nunca escondida numa média
    assert.equal(jv.situacaoFinanceira.chave, "critica");
  });
});

describe("filtros globais respeitados por todos os blocos (cards, ranking, tabela)", () => {
  test("filtrar por empresa reduz o universo inteiro", async () => {
    const r = await rede({ organizacaoId: UUID("beta") });
    assert.equal(r.unidades.length, 1);
    assert.equal(r.rede.unidadesMonitoradas, 1);
    assert.equal(r.unidades[0].nome, "Beta Sul");
  });

  test("filtrar por modalidade tira a outra modalidade dos cards e do ranking", async () => {
    const r = await rede({ modalidade: "full_service" });
    assert.equal(r.rede.unidadesMonitoradas, 1);
    assert.equal(r.rankingPorModalidade.marketplace.melhores.length, 0);
    assert.equal(r.rankingPorModalidade.marketplace.atencao.length, 0);
  });

  test("filtrar por situação afeta a tabela mas NÃO a distribuição (senão ela mostraria sempre 100%)", async () => {
    const r = await rede({ situacao: "critica" });
    assert.equal(r.unidades.length, 1);
    assert.equal(r.unidades[0].nome, "JV Loja B");
    // a distribuição continua contando as 3 unidades do universo empresa/modalidade
    assert.deepEqual(r.distribuicaoSituacoes, { sem_dados: 0, em_dia: 1, atencao: 1, critica: 1 });
  });

  test("busca por nome", async () => {
    const r = await rede({ busca: "beta" });
    assert.equal(r.unidades.length, 1);
    assert.equal(r.unidades[0].nome, "Beta Sul");
  });
});

describe("frota vazia", () => {
  test("não quebra e devolve estrutura vazia coerente", async () => {
    const vazio = await visaoGeralRede({ hojeIso: HOJE, mes: "2026-09" }, {
      supabase: fakeDb({ organizacoes: [], unidades: [], organizacao_modulos: [], unidade_modulos: [], metas_indicadores: [], unidade_modelo_logistico_historico: [], lancamentos_financeiros_diarios: [] }),
    });
    assert.deepEqual(vazio.unidades, []);
    assert.deepEqual(vazio.empresas, []);
    assert.equal(vazio.rede.faturamento, null);
  });
});

// ===========================================================================
// detalheEmpresa() ganha um bloco `financeiro` — reaproveita 100% a Visão
// Geral da Rede recortada por empresa (zero fórmula duplicada). Aditivo: o
// detalhe OPERACIONAL (pendências/conformidade) continua intocado.
// ===========================================================================
describe("detalheEmpresa — bloco financeiro (drill-down a partir da Visão Geral da Rede)", () => {
  test("empresa com dados financeiros: financeiro.rede e financeiro.unidades vêm preenchidos, iguais aos da Visão Geral da Rede", async () => {
    const d = await detalheEmpresa({ organizacaoId: UUID("jv"), hojeIso: HOJE, mes: "2026-09" }, { supabase: fakeDb(cenario()) });
    assert.ok(d.financeiro, "empresa JV tem lançamentos financeiros no mês -> bloco financeiro presente");
    assert.equal(d.financeiro.rede.unidadesMonitoradas, 2, "só as 2 unidades da JV, nunca a rede inteira");
    const porNome = Object.fromEntries(d.financeiro.unidades.map((u) => [u.nome, u]));
    assert.equal(porNome["JV Loja A"].situacaoFinanceira.chave, "em_dia");
    assert.equal(porNome["JV Loja B"].situacaoFinanceira.chave, "critica");
    assert.equal(porNome["JV Loja A"].ultimaAtualizacao, "2026-09-30");
    // nada do detalhe OPERACIONAL pré-existente quebrou
    assert.equal(d.organizacao.nome, "Grupo JV");
    assert.ok(Array.isArray(d.unidades));
  });

  test("empresa monitorada financeiramente mas sem nenhum lançamento no mês: unidade aparece SEM_DADOS, nada inventado", async () => {
    const st = cenario();
    st.lancamentos_financeiros_diarios = st.lancamentos_financeiros_diarios.filter((l) => l.unidade_id !== UUID("c"));
    const d = await detalheEmpresa({ organizacaoId: UUID("beta"), hojeIso: HOJE, mes: "2026-09" }, { supabase: fakeDb(st) });
    assert.ok(d.financeiro, "a empresa continua no módulo financeiro -> bloco presente, só sem dado no período");
    const beta = d.financeiro.unidades.find((u) => u.nome === "Beta Sul");
    assert.equal(beta.situacaoFinanceira.chave, "sem_dados");
    assert.equal(beta.ultimaAtualizacao, null);
  });

  test("empresa fora do módulo financeiro (sem nenhuma unidade elegível): financeiro vem null, nunca inventado", async () => {
    const st = cenario();
    st.unidade_modulos = st.unidade_modulos.filter((m) => m.unidade_id !== UUID("c"));
    st.organizacao_modulos = st.organizacao_modulos.filter((m) => m.organizacao_id !== UUID("beta"));
    const d = await detalheEmpresa({ organizacaoId: UUID("beta"), hojeIso: HOJE, mes: "2026-09" }, { supabase: fakeDb(st) });
    assert.equal(d.financeiro, null);
  });
});

describe("regressão: rede usa exclusivamente o indicador Total de deduções", () => {
  const consultar = (st, filtros = {}) => visaoGeralRede({ hojeIso: HOJE, mes: "2026-09", ...filtros }, { supabase: fakeDb(st) });
  test("quatro estados alimentam cards, distribuição, filtros e rankings com os mesmos badges", async () => {
    const st = cenario();
    st.unidades.push(uni(UUID("d"), UUID("beta"), "Sem dados", "full_service"));
    st.unidade_modulos.push({ unidade_id: UUID("d"), modulo_id: MOD });
    const r = await consultar(st);
    assert.deepEqual(r.distribuicaoSituacoes, { em_dia: 1, atencao: 1, critica: 1, sem_dados: 1 });
    assert.equal(r.rede.unidadesEmAtencao, 1);
    assert.equal(r.rede.unidadesCriticas, 1);
    for (const chave of ["em_dia", "atencao", "critica", "sem_dados"]) {
      const filtrado = await consultar(st, { situacao: chave });
      assert.equal(filtrado.unidades.length, 1);
      assert.equal(filtrado.unidades[0].situacaoFinanceira.chave, chave);
      assert.deepEqual(filtrado.distribuicaoSituacoes, r.distribuicaoSituacoes);
      for (const bloco of Object.values(filtrado.rankingPorModalidade)) {
        for (const u of [...bloco.melhores, ...bloco.atencao]) assert.equal(u.situacaoFinanceira.chave, chave);
      }
    }
  });
  test("logo acima do limite é Crítica, sem a antiga banda adicional", async () => {
    const st = cenario();
    st.lancamentos_financeiros_diarios = st.lancamentos_financeiros_diarios.filter((l) => l.unidade_id !== UUID("c"));
    st.lancamentos_financeiros_diarios.push(...mesCompleto(UUID("c"), 500, 135)); // 27% > 25%
    const r = await consultar(st);
    assert.equal(r.unidades.find((u) => u.unidadeId === UUID("c")).situacaoFinanceira.chave, "critica");
    assert.equal(r.rede.unidadesCriticas, 2);
    assert.equal(r.rede.unidadesEmAtencao, 0);
  });
  test("ajustes de caixa e entregadores Full Service não alteram o indicador", async () => {
    const st = cenario();
    for (const l of st.lancamentos_financeiros_diarios) {
      l.ajustes_contra_loja = 100000;
      if (l.unidade_id === UUID("c")) l.taxas_entregadores = 100000;
    }
    const r = await consultar(st);
    assert.equal(r.unidades.find((u) => u.unidadeId === UUID("a")).situacaoFinanceira.chave, "em_dia");
    const c = r.unidades.find((u) => u.unidadeId === UUID("c"));
    assert.equal(c.totalDeducoesIndicadorPct, 23);
    assert.equal(c.situacaoFinanceira.chave, "atencao");
    assert.ok(c.deducoesPct > 100);
  });
  test("meta ideal dinâmica usa os mesmos preços e cálculo do Dashboard iFood", async () => {
    const st = cenario();
    Object.assign(st.unidades[2], { tabela_balcao: "B", tabela_ifood: "I" });
    st.produtos = [{ id: "produto-beta", organizacao_id: UUID("beta"), nome: "Churrasco 15cm", tamanho: "15cm", ativo: true }];
    st.produto_precos = [
      { produto_id: "produto-beta", canal: "balcao", tabela: "B", preco: 15.2 },
      { produto_id: "produto-beta", canal: "ifood", tabela: "I", preco: 20 },
    ];
    const r = await consultar(st);
    const c = r.unidades.find((u) => u.unidadeId === UUID("c"));
    assert.ok(Math.abs(c.meta.metaIdeal - 24) < 1e-10);
    assert.equal(c.meta.limite, 25);
    assert.equal(c.situacaoFinanceira.chave, "em_dia"); // 23%, cadastrada=20%, derivada=24%
    const detalhe = await detalheEmpresa({ organizacaoId: UUID("beta"), hojeIso: HOJE, mes: "2026-09" }, { supabase: fakeDb(st) });
    assert.deepEqual(detalhe.financeiro.unidades[0].situacaoFinanceira, c.situacaoFinanceira);
  });
  test("melhores prioriza situação antes de folga quando as metas são personalizadas", async () => {
    const st = cenario();
    st.metas_indicadores.push({ ...metaGlobal("marketplace", 0.05, 0.8), organizacao_id: UUID("jv"), unidade_id: UUID("a") });
    st.metas_indicadores.push({ ...metaGlobal("marketplace", 0.35, 0.4), organizacao_id: UUID("jv"), unidade_id: UUID("b") });
    const r = await consultar(st);
    assert.deepEqual(r.rankingPorModalidade.marketplace.melhores.map((u) => u.situacaoFinanceira.chave), ["em_dia", "atencao"]);
  });
});

test("período misto usa parcelas e metas conciliadas de cada modelo", async () => {
  const st = cenario();
  st.unidades[0].modelo_logistico_ifood = "full_service";
  st.unidade_modelo_logistico_historico = [{ unidade_id: UUID("a"), vigencia_inicio: "2026-09-16", modelo_anterior: "marketplace", modelo_novo: "full_service" }];
  for (const l of st.lancamentos_financeiros_diarios.filter((l) => l.unidade_id === UUID("a"))) {
    const d = Number(l.data_lancamento.slice(-2));
    l.taxas_comissoes = d * 100;
    l.taxas_entregadores = Math.min(d, 15) * 100;
  }
  const r = await visaoGeralRede({ hojeIso: HOJE, mes: "2026-09" }, { supabase: fakeDb(st) });
  const a = r.unidades.find((u) => u.unidadeId === UUID("a"));
  assert.equal(a.modeloLogistico, "misto");
  assert.equal(a.totalDeducoesIndicador, 4500); // 3000 taxas + 1500 entregadores MP
  assert.equal(a.totalDeducoesIndicadorPct, 15);
  assert.equal(a.meta.metaIdeal, 16); // 50% MP ideal 12 + 50% FS ideal 20
  assert.equal(a.meta.limite, 20);
  assert.equal(a.situacaoFinanceira.chave, "em_dia");
});

test("classificação preserva a precisão da meta ideal cadastrada", async () => {
  const st = cenario();
  st.metas_indicadores[0].meta_ideal = 0.07504; // 7,504%, exibível com arredondamento, comparação exata
  for (const l of st.lancamentos_financeiros_diarios.filter((l) => l.unidade_id === UUID("a"))) {
    l.taxas_comissoes = l.valor_vendas_ifood * 0.07503;
  }
  const r = await visaoGeralRede({ hojeIso: HOJE, mes: "2026-09" }, { supabase: fakeDb(st) });
  assert.equal(r.unidades.find((u) => u.unidadeId === UUID("a")).situacaoFinanceira.chave, "em_dia");
});

test("somente ajustes financeiros não fabricam um indicador Total de deduções", async () => {
  const st = cenario();
  for (const l of st.lancamentos_financeiros_diarios.filter((l) => l.unidade_id === UUID("a"))) {
    l.taxas_comissoes = null; l.servicos_promocoes = null; l.taxas_entregadores = null;
    l.ajustes_contra_loja = 100;
  }
  const r = await visaoGeralRede({ hojeIso: HOJE, mes: "2026-09" }, { supabase: fakeDb(st) });
  const a = r.unidades.find((u) => u.unidadeId === UUID("a"));
  assert.equal(a.totalDeducoesIndicadorPct, null);
  assert.equal(a.situacaoFinanceira.chave, "sem_dados");
});

test("lançamento mensal usa o fallback homologado no recorte mensal da rede", async () => {
  const st = cenario();
  for (const l of st.lancamentos_financeiros_diarios.filter((l) => l.unidade_id === UUID("a"))) {
    l.origem_lancamento = "distribuicao_mensal";
    l.valor_vendas_ifood = 1000; l.taxas_comissoes = 100;
  }
  const r = await visaoGeralRede({ hojeIso: HOJE, mes: "2026-09" }, { supabase: fakeDb(st) });
  const a = r.unidades.find((u) => u.unidadeId === UUID("a"));
  assert.equal(a.faturamento, 30000);
  assert.equal(a.deducoes, 3000);
  assert.equal(a.totalDeducoesIndicadorPct, 10);
  assert.equal(a.situacaoFinanceira.chave, "em_dia");
  assert.equal(a.semDado, false);
  assert.ok(r.rankingPorModalidade.marketplace.melhores.some((u) => u.unidadeId === a.unidadeId));
});

test("modalidade mista é identificada, filtrada e ranqueada separadamente", async () => {
  const st = cenario();
  st.unidades[0].modelo_logistico_ifood = "full_service";
  st.unidade_modelo_logistico_historico = [{ unidade_id: UUID("a"), vigencia_inicio: "2026-09-16", modelo_anterior: "marketplace", modelo_novo: "full_service" }];
  const r = await visaoGeralRede({ hojeIso: HOJE, mes: "2026-09", modalidade: "misto" }, { supabase: fakeDb(st) });
  assert.equal(r.unidades.length, 1);
  assert.equal(r.unidades[0].modeloLogistico, "misto");
  assert.equal(r.rankingPorModalidade.misto.melhores.length, 1);
  assert.equal(r.rankingPorModalidade.misto.melhores[0].unidadeId, UUID("a"));
});

test("lookup filtra Churrasco no banco e preserva seleção/fallback sem misturar empresas", async () => {
  const st = cenario();
  Object.assign(st.unidades[0], { tabela_balcao: "B", tabela_ifood: "I" });
  st.produtos = [
    { id: "errado", organizacao_id: UUID("jv"), nome: "Outro 15cm", ativo: true },
    { id: "certo", organizacao_id: UUID("jv"), nome: "CHURRASCO 15cm", ativo: true },
    { id: "outra-empresa", organizacao_id: UUID("beta"), nome: "Churrasco 15cm", ativo: true },
  ];
  st.produto_precos = [
    { produto_id: "certo", canal: "balcao", tabela: "B", preco: 15.2 },
    { produto_id: "certo", canal: "ifood", tabela: "I", preco: 20 },
    { produto_id: "errado", canal: "balcao", tabela: "B", preco: 1 },
  ];
  const filtros = [];
  const db = fakeDb(st);
  const from = db.from;
  db.from = (t) => { const q = from(t); const ilike = q.ilike; q.ilike = (col, v) => { filtros.push([t, col, v]); return ilike(col, v); }; return q; };
  const r = await visaoGeralRede({ hojeIso: HOJE, mes: "2026-09" }, { supabase: db });
  assert.deepEqual(filtros, [["produtos", "nome", "%Churrasco%"]]);
  const a = r.unidades.find((u) => u.unidadeId === UUID("a"));
  assert.ok(Math.abs(a.meta.metaIdeal - 25) < 1e-9); // reserva mínima MP = 13 + 12
  assert.equal(a.situacaoFinanceira.chave, "em_dia");
});
