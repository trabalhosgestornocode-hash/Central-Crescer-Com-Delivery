// Testes da fórmula pura de margem estimada do iFood (Balcão x iFood),
// auditada e corrigida em 19/08: a margem do iFood desconta Taxas e Comissões
// + Serviços e Promoções, e ausência de dado nunca vira 0. Sem rede — mesmo
// espírito de dashboard-executivo-calc.test.js.
//
// As antigas referências do modelo logístico (referenciaModeloPct /
// limiteCombinadoPct / situacaoDiferencaPreco) foram removidas junto com o
// simulador antigo — a proteção da precificação vem agora do motor
// dashboardExecutivo.rentabilidade.js, parametrizada por combinação de tabelas
// (ver dashboard-executivo-rentabilidade.test.js).
//
// Rodar: node --test test/dashboard-executivo-simulador-calc.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { margemEstimadaIfood } from "../src/modules/dashboard-executivo/dashboardExecutivo.calc.js";

const perto = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
describe("margemEstimadaIfood — caso auditado (Churrasco 15cm, tabela Z4)", () => {
  const base = { preco: 35, custo: 6.07, taxaComissoesPct: 19.9, servicosPromocoesPct: 3.9 };

  test("taxas e serviços em R$, receita após deduções consideradas e margem batem com a auditoria", () => {
    const r = margemEstimadaIfood(base);
    assert.ok(perto(r.taxaComissoesReais, 6.965, 0.001));
    assert.ok(perto(r.servicosPromocoesReais, 1.365, 0.001));
    assert.ok(perto(r.deducoesConsideradasPct, 23.8, 0.001));
    assert.ok(perto(r.receitaAposDeducoesConsideradas, 26.67, 0.01));
    assert.ok(perto(r.margemEstimada, 20.6, 0.01));
    assert.ok(perto(r.margemEstimadaPct, 58.86, 0.01));
  });

  test("margem cai em relação à fórmula antiga (só Taxas e Comissões) — R$ 20,60 < R$ 21,97", () => {
    const r = margemEstimadaIfood(base);
    const margemAntiga = (base.preco - (base.preco * base.taxaComissoesPct) / 100) - base.custo;
    assert.ok(perto(margemAntiga, 21.965, 0.01)); // R$ 21,97 arredondado — a margem exibida antes da correção
    assert.ok(r.margemEstimada < margemAntiga);
  });
});

describe("margemEstimadaIfood — ausência de dado nunca vira 0", () => {
  test("Taxas e Comissões ainda não apurada → margem inteira null, nunca calculada com taxa=0", () => {
    const r = margemEstimadaIfood({ preco: 35, custo: 6.07, taxaComissoesPct: null, servicosPromocoesPct: 3.9 });
    assert.equal(r.margemEstimada, null);
    assert.equal(r.margemEstimadaPct, null);
    assert.equal(r.receitaAposDeducoesConsideradas, null);
  });

  test("Serviços e Promoções ainda não apurados → margem inteira null (não soma só a Taxa)", () => {
    const r = margemEstimadaIfood({ preco: 35, custo: 6.07, taxaComissoesPct: 19.9, servicosPromocoesPct: null });
    assert.equal(r.margemEstimada, null);
    assert.equal(r.servicosPromocoesReais, null);
  });

  test("Serviços e Promoções apurado como 0 de verdade (mês sem campanha) é DIFERENTE de null — calcula normalmente", () => {
    const r = margemEstimadaIfood({ preco: 35, custo: 6.07, taxaComissoesPct: 19.9, servicosPromocoesPct: 0 });
    assert.notEqual(r.margemEstimada, null);
    assert.ok(perto(r.servicosPromocoesReais, 0, 1e-9));
    assert.ok(perto(r.margemEstimada, 21.965, 0.01));
  });
});
