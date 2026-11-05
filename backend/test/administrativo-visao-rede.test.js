// PAINEL ADMINISTRATIVO — motor puro da VISÃO GERAL DA REDE.
//
// Protege:
//  1. a classificação de 4 estados (SEM_DADOS/EM_DIA/ATENÇÃO/CRÍTICA), com a
//     reutilizando o status homologado dos Indicadores de Rentabilidade;
//  2. o impacto financeiro estimado — só o excedente sobre o LIMITE, nunca
//     sobre a meta ideal, e nunca negativo;
//  3. a composição das deduções (taxas/comissões x serviços/promoções) sem
//     dupla contagem — a soma dos componentes sempre reconcilia com o total;
//  4. os filtros globais e a ordem de prioridade de intervenção.
//
// Rodar: node --test test/administrativo-visao-rede.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classificarAtencaoFinanceira, impactoFinanceiroEstimado,
  composicaoDeducoesDoBloco, somarComposicaoDeducoes,
  filtrarUnidadesRede, ordenarPrioridadeIntervencao, contagemPorSituacao,
} from "../src/modules/administrativo/administrativo.visaoRede.js";

describe("classificarAtencaoFinanceira — Total de deduções, meta ideal e limite", () => {
  const meta = { metaIdeal: 20, limite: 28 };
  for (const [valor, esperado] of [[0, "em_dia"], [15, "em_dia"], [20, "em_dia"], [20.001, "atencao"], [24, "atencao"], [28, "atencao"], [28.001, "critica"], [36, "critica"], [60, "critica"], [null, "sem_dados"], [NaN, "sem_dados"], [Infinity, "sem_dados"]]) {
    test(`${valor} -> ${esperado}`, () => assert.equal(classificarAtencaoFinanceira(valor, meta).chave, esperado));
  }
  test("sem limite ou sem meta -> Sem dados", () => {
    assert.equal(classificarAtencaoFinanceira(25, null).chave, "sem_dados");
    assert.equal(classificarAtencaoFinanceira(25, { metaIdeal: 20, limite: null }).chave, "sem_dados");
  });
  test("sem ideal segue o status homologado Dentro do Limite (Atenção), sem inventar ideal", () => {
    assert.equal(classificarAtencaoFinanceira(25, { limite: 30 }).chave, "atencao");
    assert.equal(classificarAtencaoFinanceira(31, { limite: 30 }).chave, "critica");
  });
  test("limite tem precedência mesmo quando a meta ideal dinâmica supera o limite", () => {
    assert.equal(classificarAtencaoFinanceira(31, { metaIdeal: 35, limite: 30 }).chave, "critica");
  });
});

describe("impactoFinanceiroEstimado — só o excedente sobre o LIMITE", () => {
  const meta = { metaIdeal: 20, limite: 28 };

  test("dentro do limite -> impacto zero (nunca negativo)", () => {
    assert.equal(impactoFinanceiroEstimado(100000, 15, meta), 0);
    assert.equal(impactoFinanceiroEstimado(100000, 28, meta), 0);
  });

  test("acima do limite -> excedente em reais sobre o faturamento", () => {
    // 30% de dedução com limite 28% -> 2 p.p. de excesso sobre R$ 100.000 = R$ 2.000
    assert.equal(impactoFinanceiroEstimado(100000, 30, meta), 2000);
  });

  test("sem faturamento/percentual/limite -> null (nunca 0 fabricado)", () => {
    assert.equal(impactoFinanceiroEstimado(null, 30, meta), null);
    assert.equal(impactoFinanceiroEstimado(100000, null, meta), null);
    assert.equal(impactoFinanceiroEstimado(100000, 30, null), null);
  });
});

describe("composicaoDeducoesDoBloco — sem dupla contagem", () => {
  const linha = (data, { fat, taxas, servicos, entregadores = 0, ajustes = 0 }) => ({
    data_lancamento: data, status: "finalizado", situacao: "normal", origem_lancamento: "diario",
    valor_vendas_ifood: fat, taxas_comissoes: taxas, servicos_promocoes: servicos,
    taxas_entregadores: entregadores, ajustes_favor_loja: 0, ajustes_contra_loja: ajustes,
  });

  test("mês inteiro (base 0) — componentes somam exatamente o total", () => {
    const linhas = [linha("2026-09-30", { fat: 100000, taxas: 18000, servicos: 5000, entregadores: 1000, ajustes: 200 })];
    const c = composicaoDeducoesDoBloco(linhas, "2026-09-01", "2026-09-30");
    assert.equal(c.taxasComissoes, 19000); // taxas + entregadores
    assert.equal(c.servicosPromocoes, 5000);
    assert.equal(c.outrosAjustes, 200);
    assert.equal(c.total, 24200, "reconcilia com totalDeducoes (sem perder nem duplicar nenhuma parte)");
  });

  test("sem snapshot no fim do bloco -> tudo null (nunca 0 fabricado)", () => {
    const c = composicaoDeducoesDoBloco([], "2026-09-01", "2026-09-30");
    assert.equal(c.total, null);
  });
});

describe("somarComposicaoDeducoes — aditivo entre unidades", () => {
  test("soma só quem informou aquele componente", () => {
    const c = somarComposicaoDeducoes([
      { taxasComissoes: 1000, servicosPromocoes: 200, outrosAjustes: null },
      { taxasComissoes: 500, servicosPromocoes: null, outrosAjustes: 10 },
    ]);
    assert.equal(c.taxasComissoes, 1500);
    assert.equal(c.servicosPromocoes, 200);
    assert.equal(c.outrosAjustes, 10);
  });
  test("nenhuma unidade informou -> null", () => {
    assert.deepEqual(somarComposicaoDeducoes([{ taxasComissoes: null, servicosPromocoes: null, outrosAjustes: null }]),
      { taxasComissoes: null, servicosPromocoes: null, outrosAjustes: null });
  });
});

describe("filtrarUnidadesRede — filtros globais da tela", () => {
  const unidades = [
    { unidadeId: "u1", nome: "Loja Centro", empresaNome: "Açaí Saci", organizacaoId: "org1", modeloLogistico: "marketplace", situacaoFinanceira: { chave: "critica" } },
    { unidadeId: "u2", nome: "Loja Norte", empresaNome: "Açaí Saci", organizacaoId: "org1", modeloLogistico: "full_service", situacaoFinanceira: { chave: "em_dia" } },
    { unidadeId: "u3", nome: "Subway Centro", empresaNome: "Subway Saci", organizacaoId: "org2", modeloLogistico: "marketplace", situacaoFinanceira: { chave: "atencao" } },
  ];

  test("por empresa", () => assert.equal(filtrarUnidadesRede(unidades, { organizacaoId: "org1" }).length, 2));
  test("por unidade", () => assert.equal(filtrarUnidadesRede(unidades, { unidadeId: "u3" }).length, 1));
  test("por modalidade", () => assert.equal(filtrarUnidadesRede(unidades, { modalidade: "marketplace" }).length, 2));
  test("por situação", () => assert.equal(filtrarUnidadesRede(unidades, { situacao: "critica" }).length, 1));
  test("busca por nome (sem acento/caixa)", () => assert.equal(filtrarUnidadesRede(unidades, { busca: "ACAI" }).length, 2));
  test("busca por nome da unidade", () => assert.equal(filtrarUnidadesRede(unidades, { busca: "centro" }).length, 2));
  test("combinando filtros", () => assert.equal(filtrarUnidadesRede(unidades, { organizacaoId: "org1", modalidade: "marketplace" }).length, 1));
});

describe("ordenarPrioridadeIntervencao — gravidade, depois impacto, depois desvio", () => {
  test("crítica sempre antes de atenção, mesmo com impacto menor", () => {
    const unidades = [
      { nome: "A", situacaoFinanceira: { chave: "atencao" }, impactoFinanceiroEstimado: 9000, folgaLimitePp: -1 },
      { nome: "B", situacaoFinanceira: { chave: "critica" }, impactoFinanceiroEstimado: 100, folgaLimitePp: -10 },
    ];
    const [primeiro] = ordenarPrioridadeIntervencao(unidades);
    assert.equal(primeiro.nome, "B");
  });
  test("dentro da mesma gravidade, maior impacto financeiro primeiro", () => {
    const unidades = [
      { nome: "A", situacaoFinanceira: { chave: "critica" }, impactoFinanceiroEstimado: 500, folgaLimitePp: -5 },
      { nome: "B", situacaoFinanceira: { chave: "critica" }, impactoFinanceiroEstimado: 5000, folgaLimitePp: -2 },
    ];
    const [primeiro] = ordenarPrioridadeIntervencao(unidades);
    assert.equal(primeiro.nome, "B");
  });
});

describe("contagemPorSituacao — distribuição para o card e o gráfico", () => {
  test("conta as 4 chaves, mesmo quando uma não aparece", () => {
    const unidades = [
      { situacaoFinanceira: { chave: "em_dia" } },
      { situacaoFinanceira: { chave: "em_dia" } },
      { situacaoFinanceira: { chave: "critica" } },
    ];
    assert.deepEqual(contagemPorSituacao(unidades), { sem_dados: 0, em_dia: 2, atencao: 0, critica: 1 });
  });
});
