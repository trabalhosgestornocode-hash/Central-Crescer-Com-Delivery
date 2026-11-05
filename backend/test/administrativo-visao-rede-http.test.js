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

import { visaoGeralRede } from "../src/modules/administrativo/administrativo.service.js";

const MOD = "ifood_dashboard";
const HOJE = "2026-10-05"; // setembro/2026 já fechado (30 dias)
const UUID = (l) => {
  const h = Buffer.from(String(l)).toString("hex").padEnd(32, "0").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function fakeDb(estado) {
  function from(tabela) {
    const ctx = { eq: [], inF: null, gte: null, lte: null };
    const casa = (r) =>
      ctx.eq.every(([c, v]) => r[c] === v) &&
      (!ctx.inF || ctx.inF.vals.includes(r[ctx.inF.col])) &&
      (ctx.gte == null || r[ctx.gte.col] >= ctx.gte.v) &&
      (ctx.lte == null || r[ctx.lte.col] <= ctx.lte.v);
    const run = (single) => {
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
 *   JV Loja B  (Grupo JV, MP)  1000/dia fat, deduções 30%   -> CRÍTICA (limite 15% + banda 3pp = 18%)
 *   Beta Sul   (Beta, FS)       500/dia fat, deduções 27%   -> ATENÇÃO (limite FS 25% + banda 5pp = 30%)
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
      ...mesCompleto(UUID("c"), 500, 135),      // 27%
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
  test("deducoesPct da rede não é a média simples dos 3 percentuais (7,5 / 30 / 27 -> média ingênua 21,5)", async () => {
    const r = await rede();
    // faturamento: A=31000(1..30*1000=465000? ver abaixo) — o que importa é
    // que o percentual da rede vem de Σdeduções/Σfaturamento.
    const somaFat = r.unidades.reduce((s, u) => s + u.faturamento, 0);
    const somaDed = r.unidades.reduce((s, u) => s + u.deducoes, 0);
    const esperado = Math.round((somaDed / somaFat) * 100 * 100) / 100;
    assert.equal(r.rede.deducoesPct, esperado);
    assert.notEqual(Math.round(r.rede.deducoesPct), 22, "nunca a média simples (21,5 ~ 22) dos 3 percentuais");
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
