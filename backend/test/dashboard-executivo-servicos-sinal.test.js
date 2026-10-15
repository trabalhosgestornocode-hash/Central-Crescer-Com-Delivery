// "Serviços e promoções" com sinal (migration 119). A coluna continua sendo
// CUSTO: positivo = dedução (como sempre), negativo = crédito a favor da loja
// (seletor "+" no formulário). O backend grava o número que recebe — nunca
// inverte — e as fórmulas de sempre tratam os dois sinais. Puro, sem rede.
// Rodar: node --test test/dashboard-executivo-servicos-sinal.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  normalizarDadosLancamento, validarEntradaLancamentoMensal,
} from "../src/modules/dashboard-executivo/dashboardExecutivo.service.js";
import {
  totalDeducoes, receitaLiquida, statusIndicador, statusIndicadorRentabilidade, distribuirValorMensal, LIMITES_SERVICOS_PROMOCOES,
} from "../src/modules/dashboard-executivo/dashboardExecutivo.calc.js";
import {
  ESCOPO_ENTREGADORES, SITUACAO_CANAL, normalizarCanais, consolidarCanais,
} from "../src/modules/dashboard-executivo/dashboardExecutivo.canais.js";
import { avaliarQuedaAcumulado } from "../src/modules/dashboard-executivo/dashboardExecutivo.confiabilidade.js";

const OPCOES = { exigirFinanceiro: true, desempenhoAnterior: null };
const BASE = {
  situacao: "normal", status: "finalizado",
  qtdVendas: 40, valorVendasBruto: 2000, novosClientes: 3,
  valorVendasIfood: 1000, taxasComissoes: 100, servicosPromocoes: 50, taxasEntregadores: 0,
};
const norm = (over, opcoes = OPCOES) => normalizarDadosLancamento({ ...BASE, ...over }, opcoes);
const totalDe = (d) => totalDeducoes({
  taxasComissoes: d.taxasComissoes, servicosPromocoes: d.servicosPromocoes,
  taxasEntregadores: d.taxasEntregadores, ajustesContraLoja: d.ajustesContraLoja,
});
const receitaDe = (d) => receitaLiquida(d.valorVendasIfood, totalDe(d), d.ajustesFavorLoja);

describe("validação de entrada — lançamento diário", () => {
  test("(−) custo: positivo continua aceito e gravado igual", () => {
    assert.equal(norm({}).servicosPromocoes, 50);
  });

  test("(+) crédito: negativo é aceito e gravado SEM inversão", () => {
    assert.equal(norm({ servicosPromocoes: -50 }).servicosPromocoes, -50);
    assert.equal(norm({ status: "rascunho", servicosPromocoes: -12.34 }, { exigirFinanceiro: false, desempenhoAnterior: null }).servicosPromocoes, -12.34);
  });

  test("os demais campos financeiros continuam recusando negativo", () => {
    assert.throws(() => norm({ taxasComissoes: -1 }), /Taxas e comissões/);
    assert.throws(() => norm({ valorVendasIfood: -1 }), /Valor das vendas/);
    assert.throws(() => norm({ taxasEntregadores: -1 }), /Taxas de entregadores/);
    assert.throws(() => norm({ ajustesContraLoja: -1 }), /Ajustes contra a loja/);
  });

  test("continua obrigatório ao finalizar e respeita a faixa", () => {
    assert.throws(() => norm({ servicosPromocoes: undefined }), /Serviços e promoções/);
    assert.throws(() => norm({ servicosPromocoes: LIMITES_SERVICOS_PROMOCOES.min - 1 }), /Serviços e promoções/);
  });
});

describe("consequências financeiras", () => {
  test("custo: deduções = 150 e receita líquida = 850 (fórmula de sempre)", () => {
    const d = norm({});
    assert.equal(totalDe(d), 150);
    assert.equal(receitaDe(d), 850);
  });

  test("crédito: deduções = 50 e receita líquida = 950 — o crédito soma na receita", () => {
    const d = norm({ servicosPromocoes: -50 });
    assert.equal(totalDe(d), 50);
    assert.equal(receitaDe(d), 950);
  });

  test("crédito maior que as taxas: total de deduções pode ficar negativo e a receita passa das vendas", () => {
    const d = norm({ taxasComissoes: 10, servicosPromocoes: -30 });
    assert.equal(totalDe(d), -20);
    assert.equal(receitaDe(d), 1020);
  });

  test("status de meta: percentual negativo é 'dentro da meta' nas duas réguas", () => {
    const meta = { metaIdeal: 5, limite: 7 };
    assert.equal(statusIndicador(-5, meta).chave, "dentro_da_meta");
    assert.equal(statusIndicadorRentabilidade(-5, meta).chave, "dentro_da_meta");
  });

  test("validação de queda do acumulado continua valendo (regra financeira preservada)", () => {
    const sinal = avaliarQuedaAcumulado({
      campo: "servicosPromocoes", rotulo: "Serviços e Promoções", valorNovo: -100,
      ultimoConhecido: { valor: 200, data: "2026-09-01" },
    });
    assert.equal(sinal?.nivel, "material");
    assert.equal(sinal.diferenca, -300);
  });
});

describe("lançamento mensal", () => {
  const entrada = (servicosPromocoesTotal, extra = {}) => validarEntradaLancamentoMensal({
    mesRaw: 9, anoRaw: 2026, valorRaw: 30000, extrasRaw: { servicosPromocoesTotal, ...extra },
  });

  test("Serviços e promoções do mês aceita crédito; os outros extras não", () => {
    assert.equal(entrada(-300).extras.servicosPromocoesTotal, -300);
    assert.equal(entrada(300).extras.servicosPromocoesTotal, 300);
    assert.throws(() => entrada(null, { taxasComissoesTotal: -1 }), /Taxas e comissões/);
  });

  test("rateio de um crédito mensal fecha exatamente no total, centavo a centavo", () => {
    const fatias = distribuirValorMensal(-100, 30);
    assert.equal(fatias.length, 30);
    assert.equal(Math.round(fatias.reduce((s, v) => s + v, 0) * 100), -10000);
    assert.ok(fatias.every((v) => v < 0));
  });
});

describe("multicanal (Sanduíches + Saladas)", () => {
  const SAND = { id: "11111111-1111-4111-8111-111111111111", nome: "Sanduíches", ordem: 0, ativo: true };
  const SAL = { id: "22222222-2222-4222-8222-222222222222", nome: "Saladas", ordem: 1, ativo: true };
  const CTX = {
    participantes: [SAND, SAL], situacaoUnidade: "normal", statusAlvo: "finalizado", exigirFinanceiro: true,
    escopoEntregadores: ESCOPO_ENTREGADORES.UNIDADE,
  };
  const canal = (c, servicosPromocoes, extra = {}) => ({
    canalId: c.id, situacaoCanal: SITUACAO_CANAL.COM_VENDAS, qtdVendas: 10, valorVendasBruto: 500, novosClientes: 1,
    valorVendasIfood: 1000, taxasComissoes: 100, servicosPromocoes, ...extra,
  });

  test("crédito num canal e custo no outro: consolidado soma com sinal, sem inverter", () => {
    const canais = normalizarCanais([canal(SAND, -60), canal(SAL, 20)], CTX);
    assert.deepEqual(canais.map((c) => c.servicosPromocoes), [-60, 20]);
    const c = consolidarCanais(canais, { escopoEntregadores: ESCOPO_ENTREGADORES.UNIDADE, taxasEntregadoresUnidade: 0 });
    assert.equal(c.servicosPromocoes, -40);
  });

  test("outros campos do canal continuam recusando negativo", () => {
    assert.throws(() => normalizarCanais([canal(SAND, 10, { taxasComissoes: -1 }), canal(SAL, 20)], CTX), /Sanduíches: Taxas e comissões/);
  });

  test("rascunho: crédito opcional por canal também é aceito", () => {
    const canais = normalizarCanais([canal(SAND, -5), canal(SAL, undefined)], { ...CTX, statusAlvo: "rascunho", exigirFinanceiro: false });
    assert.equal(canais[0].servicosPromocoes, -5);
    assert.equal(canais[1].servicosPromocoes, null);
  });
});
