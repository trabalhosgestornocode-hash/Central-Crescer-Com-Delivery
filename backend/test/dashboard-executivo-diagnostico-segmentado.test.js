// Diagnóstico SEGMENTADO — período misto Marketplace × Full Service.
// Comparativo entre regimes, Plano de Ação por segmento e amostra pequena.
// Puro, sem rede. Rodar: node --test test/dashboard-executivo-diagnostico-segmentado.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { gerarDiagnostico, LIMIARES_DIAGNOSTICO } from "../src/modules/dashboard-executivo/dashboardExecutivo.diagnostico.js";
import { saldoMeta } from "../src/modules/dashboard-executivo/dashboardExecutivo.calc.js";

const indicador = ({ atual, valor, metaIdeal, limite, faturamentoBase, naoAplicavel = false }) => {
  const meta = metaIdeal != null ? { metaIdeal, limite } : null;
  return {
    atual, valor, meta, naoAplicavel,
    saldo: meta ? saldoMeta({ valorUtilizado: valor, percentualUtilizado: atual, limitePct: limite, faturamentoBase }) : null,
  };
};
const pct = (valor, status = "conciliado") => ({ valor, status });

const indicadoresBase = () => ({
  taxas_comissoes: indicador({ atual: null, valor: null }),
  servicos_promocoes: indicador({ atual: null, valor: null }),
  taxas_entregadores: indicador({ atual: null, valor: null }),
  total_deducoes: indicador({ atual: null, valor: null }),
});

const entradaBase = () => ({
  indicadores: indicadoresBase(), faturamentoBase: null, diasComDados: 21, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0,
  comparativo: null, recuperacao: null,
});

describe("Comparativo Marketplace × Full Service — PIORA aparente (Total de Deduções sobe)", () => {
  test("gera achado de ATENÇÃO com pontos percentuais, nunca causalidade afirmada", () => {
    const comparativoSegmentos = [
      { modelo: "marketplace", diasComDados: 19, percentuais: { taxasComissoes: pct(13), servicosPromocoes: pct(5), taxasEntregadores: pct(12), totalDeducoes: pct(30), receitaLiquida: pct(70) } },
      { modelo: "full_service", diasComDados: 11, percentuais: { taxasComissoes: pct(20.5), servicosPromocoes: pct(10), taxasEntregadores: pct(null, "nao_aplicavel"), totalDeducoes: pct(36), receitaLiquida: pct(64) } },
    ];
    const d = gerarDiagnostico({ ...entradaBase(), comparativoSegmentos });
    const achado = [...d.pontosAtencao, ...d.alertas, ...d.pontosFortes].find((a) => a.id === "comparativo_total_deducoes");
    assert.ok(achado);
    assert.equal(achado.severidade, "atencao"); // maior dedução = pior
    assert.match(achado.descricao, /Após a transição de Marketplace para Full Service/);
    assert.match(achado.descricao, /30.0% para 36.0%/);
    assert.match(achado.descricao, /\+6.0 p.p./);
    assert.doesNotMatch(achado.descricao, /-6%/); // nunca "-6%" pra uma diferença em p.p.
    assert.doesNotMatch(achado.descricao, /causou|fez com que|responsável por/i); // nunca causalidade
  });
});

describe("Comparativo Marketplace × Full Service — MELHORA aparente (Total de Deduções cai)", () => {
  test("gera achado de PONTO FORTE, ainda sem afirmar causalidade", () => {
    const comparativoSegmentos = [
      { modelo: "marketplace", diasComDados: 19, percentuais: { taxasComissoes: pct(13), servicosPromocoes: pct(5), taxasEntregadores: pct(12), totalDeducoes: pct(34.2), receitaLiquida: pct(65.8) } },
      { modelo: "full_service", diasComDados: 11, percentuais: { taxasComissoes: pct(20.5), servicosPromocoes: pct(10), taxasEntregadores: pct(null, "nao_aplicavel"), totalDeducoes: pct(30.8), receitaLiquida: pct(69.2) } },
    ];
    const d = gerarDiagnostico({ ...entradaBase(), comparativoSegmentos });
    const achado = d.pontosFortes.find((a) => a.id === "comparativo_total_deducoes");
    assert.ok(achado);
    assert.match(achado.descricao, /34.2% para 30.8%/);
    assert.match(achado.descricao, /-3.4 p.p./);
    assert.doesNotMatch(achado.descricao, /reduziu as deduções|causou|melhorou por causa/i);
  });

  test("Receita Líquida sobe -> ponto forte; Receita Líquida cai -> atenção (maior é MELHOR aqui)", () => {
    const subindo = [
      { modelo: "marketplace", diasComDados: 19, percentuais: { taxasComissoes: pct(null, "sem_dado"), servicosPromocoes: pct(null, "sem_dado"), taxasEntregadores: pct(null, "sem_dado"), totalDeducoes: pct(null, "sem_dado"), receitaLiquida: pct(65) } },
      { modelo: "full_service", diasComDados: 11, percentuais: { taxasComissoes: pct(null, "sem_dado"), servicosPromocoes: pct(null, "sem_dado"), taxasEntregadores: pct(null, "nao_aplicavel"), totalDeducoes: pct(null, "sem_dado"), receitaLiquida: pct(70) } },
    ];
    const d1 = gerarDiagnostico({ ...entradaBase(), comparativoSegmentos: subindo });
    assert.ok(d1.pontosFortes.find((a) => a.id === "comparativo_receita_liquida"));

    const caindo = subindo.map((s, i) => ({ ...s, percentuais: { ...s.percentuais, receitaLiquida: pct(i === 0 ? 70 : 65) } }));
    const d2 = gerarDiagnostico({ ...entradaBase(), comparativoSegmentos: caindo });
    assert.ok([...d2.pontosAtencao, ...d2.alertas].find((a) => a.id === "comparativo_receita_liquida"));
  });
});

describe("Amostra pequena — reusa o limiar de confiabilidade existente (LIMIARES_DIAGNOSTICO)", () => {
  test("Full Service com poucos dias: números aparecem, mas o texto avisa que a base é inicial", () => {
    assert.ok(LIMIARES_DIAGNOSTICO.diasSegmentoParaAmostraPequena > 0, "reusa um limiar já existente, não hardcode solto");
    const comparativoSegmentos = [
      { modelo: "marketplace", diasComDados: 19, percentuais: { taxasComissoes: pct(13), servicosPromocoes: pct(5), taxasEntregadores: pct(12), totalDeducoes: pct(30), receitaLiquida: pct(70) } },
      { modelo: "full_service", diasComDados: 2, percentuais: { taxasComissoes: pct(20.5), servicosPromocoes: pct(10), taxasEntregadores: pct(null, "nao_aplicavel"), totalDeducoes: pct(30.5), receitaLiquida: pct(69.5) } },
    ];
    const d = gerarDiagnostico({ ...entradaBase(), comparativoSegmentos });
    const achado = [...d.pontosAtencao, ...d.alertas, ...d.pontosFortes].find((a) => a.id === "comparativo_taxas_comissoes");
    assert.ok(achado);
    assert.match(achado.descricao, /Amostra inicial/);
    assert.match(achado.descricao, /Full Service tem 2 dia\(s\)/);
    assert.match(achado.descricao, /ainda não há base suficiente para concluir uma tendência/);
    assert.equal(achado.metricas.amostraPequenaAtual, true);
    assert.equal(achado.metricas.amostraPequenaAnterior, false);
  });

  test("os dois regimes com dias suficientes: sem nota de amostra pequena", () => {
    const comparativoSegmentos = [
      { modelo: "marketplace", diasComDados: 15, percentuais: { taxasComissoes: pct(13), servicosPromocoes: pct(5), taxasEntregadores: pct(12), totalDeducoes: pct(30), receitaLiquida: pct(70) } },
      { modelo: "full_service", diasComDados: 15, percentuais: { taxasComissoes: pct(20.5), servicosPromocoes: pct(10), taxasEntregadores: pct(null, "nao_aplicavel"), totalDeducoes: pct(30.5), receitaLiquida: pct(69.5) } },
    ];
    const d = gerarDiagnostico({ ...entradaBase(), comparativoSegmentos });
    const achado = [...d.pontosAtencao, ...d.alertas, ...d.pontosFortes].find((a) => a.id === "comparativo_taxas_comissoes");
    assert.doesNotMatch(achado.descricao, /Amostra inicial/);
  });
});

describe("Componente NÃO APLICÁVEL — Full Service sem Entregadores nunca vira alerta de ausência", () => {
  test("indicador 'nao_aplicavel' é simplesmente pulado na comparação (nenhum achado 'comparativo_taxas_entregadores')", () => {
    const comparativoSegmentos = [
      { modelo: "marketplace", diasComDados: 19, percentuais: { taxasComissoes: pct(13), servicosPromocoes: pct(5), taxasEntregadores: pct(12), totalDeducoes: pct(30), receitaLiquida: pct(70) } },
      { modelo: "full_service", diasComDados: 11, percentuais: { taxasComissoes: pct(20.5), servicosPromocoes: pct(10), taxasEntregadores: pct(null, "nao_aplicavel"), totalDeducoes: pct(30.5), receitaLiquida: pct(69.5) } },
    ];
    const d = gerarDiagnostico({ ...entradaBase(), comparativoSegmentos });
    const todos = [...d.pontosFortes, ...d.pontosAtencao, ...d.alertas];
    assert.equal(todos.find((a) => a.id === "comparativo_taxas_entregadores"), undefined);
  });
});

describe("Plano de Ação SEGMENTADO — problema em UM regime só gera ação com o nome do regime", () => {
  test("Full Service com Serviços e Promoções acima do limite: ação 'Full Service', nunca genérica do mês inteiro", () => {
    const indicadoresPorSegmento = [
      {
        modelo: "marketplace", rotulo: "Marketplace", diasComDados: 19, faturamentoBase: 20000,
        indicadores: {
          taxas_comissoes: indicador({ atual: 13, valor: 2600, metaIdeal: 13, limite: 13, faturamentoBase: 20000 }),
          servicos_promocoes: indicador({ atual: 5, valor: 1000, metaIdeal: 5, limite: 7, faturamentoBase: 20000 }),
          taxas_entregadores: indicador({ atual: 12, valor: 2400, metaIdeal: 12, limite: 15, faturamentoBase: 20000 }),
          total_deducoes: indicador({ atual: 30, valor: 6000, metaIdeal: 30, limite: 32, faturamentoBase: 20000 }),
        },
      },
      {
        modelo: "full_service", rotulo: "Full Service", diasComDados: 11, faturamentoBase: 12000,
        indicadores: {
          taxas_comissoes: indicador({ atual: 20.5, valor: 2460, metaIdeal: 20.5, limite: 20.5, faturamentoBase: 12000 }),
          // 18.6% > limite 14,5% -> CRITICAL só neste segmento.
          servicos_promocoes: indicador({ atual: 18.6, valor: 2232, metaIdeal: 10, limite: 14.5, faturamentoBase: 12000 }),
          taxas_entregadores: indicador({ atual: null, valor: null, naoAplicavel: true }),
          total_deducoes: indicador({ atual: 39.1, valor: 4692, metaIdeal: 30.5, limite: 32, faturamentoBase: 12000 }),
        },
      },
    ];
    const d = gerarDiagnostico({ ...entradaBase(), indicadoresPorSegmento });
    const acaoFS = d.acoes.find((a) => a.diagnosticoId === "servicos_promocoes_full_service_fora_da_meta");
    assert.ok(acaoFS, "esperava a ação segmentada de Full Service");
    assert.equal(acaoFS.tipo, "CRITICAL");
    assert.match(acaoFS.titulo, /Full Service/);
    assert.match(acaoFS.situacao, /18.6%/);
    // NÃO pode existir uma ação genérica de "Serviços e Promoções" (sem sufixo) pro mês inteiro nesta chamada
    // (só passamos indicadoresPorSegmento, sem `indicadores` consolidado preenchido).
    assert.equal(d.acoes.find((a) => a.diagnosticoId === "servicos_promocoes_fora_da_meta"), undefined);
    // Marketplace, dentro da meta em tudo: vira manutenção (HEALTHY) com o nome do regime.
    const manutencaoMP = d.manutencao.find((m) => m.diagnosticoId === "taxas_comissoes_marketplace_dentro_da_meta");
    assert.ok(manutencaoMP);
    assert.match(manutencaoMP.titulo, /Marketplace/);
  });
});

describe("Sem período misto (comparativoSegmentos/indicadoresPorSegmento null): nenhum achado segmentado aparece", () => {
  test("mês simples continua exatamente como antes (só o pré-existente 'detalhamento ausente', nada de comparativo/segmentado)", () => {
    const d = gerarDiagnostico(entradaBase());
    const todos = [...d.pontosFortes, ...d.pontosAtencao, ...d.alertas];
    assert.equal(todos.some((a) => a.id.startsWith("comparativo_")), false);
    assert.equal(todos.some((a) => a.id.includes("marketplace") || a.id.includes("full_service")), false);
    // achado pré-existente (não relacionado a período misto), continua ocorrendo normalmente:
    assert.ok(todos.find((a) => a.id === "detalhamento_financeiro_ausente"));
    assert.equal(d.pontosFortes.length, 0);
    assert.equal(d.alertas.length, 0);
  });
});
