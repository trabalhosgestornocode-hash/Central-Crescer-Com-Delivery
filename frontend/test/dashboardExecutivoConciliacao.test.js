// Helpers PUROS da Conciliação do Período + Comparativo Marketplace × Full
// Service (dashboardExecutivoConciliacao.js). Sem DOM.
// Rodar: node --test frontend/test/dashboardExecutivoConciliacao.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  badgeStatus, valorDoRegistro, percentualDoRegistro, variacaoPp, variacaoRelativa, mediaPorDia,
  montarConciliacao, linhasComparativoIndicadores, linhasComparativoOperacional, notaAmostraPequena,
} from "../src/dashboardExecutivoConciliacao.js";

describe("badgeStatus — silencioso quando conciliado, nunca polui a UI", () => {
  test("conciliado / undefined: sem badge", () => {
    assert.equal(badgeStatus("conciliado"), null);
    assert.equal(badgeStatus(undefined), null);
  });
  test("cada status ruim tem rótulo e classe própria", () => {
    assert.deepEqual(badgeStatus("suspeito"), { classe: "warn", label: "Conciliação pendente" });
    assert.deepEqual(badgeStatus("nao_conciliavel"), { classe: "bad", label: "Não conciliável" });
    assert.deepEqual(badgeStatus("nao_aplicavel"), { classe: "muted", label: "Não aplicável" });
    assert.deepEqual(badgeStatus("sem_dado"), { classe: "muted", label: "Sem dado" });
  });
});

describe("valorDoRegistro — o contrato central: ultimoValorValido NUNCA vira 'valor oficial'", () => {
  test("conciliado: mostra o valor, sem contexto nem badge", () => {
    const r = valorDoRegistro({ valor: 10000, status: "conciliado", ultimoValorValido: null });
    assert.match(r.texto, /10.000,00/);
    assert.equal(r.contexto, null);
    assert.equal(r.badge, null);
  });
  test("não aplicável: texto próprio, nunca 'R$ 0,00' nem 'Dados insuficientes'", () => {
    const r = valorDoRegistro({ valor: null, status: "nao_aplicavel", ultimoValorValido: null });
    assert.equal(r.texto, "Não aplicável");
    assert.equal(r.contexto, null);
  });
  test("CASO REAL Feiraguay — Taxas de Entregadores suspeito: texto '—', contexto com o último valor válido, badge 'Conciliação pendente'", () => {
    const r = valorDoRegistro({ valor: null, status: "suspeito", ultimoValorValido: { valor: 9253, data: "2026-09-17" } });
    assert.equal(r.texto, "—");
    assert.match(r.contexto, /Último valor confiável/);
    assert.match(r.contexto, /9\.253,00/);
    assert.match(r.contexto, /17\/09\/2026/);
    assert.doesNotMatch(r.contexto, /oficial/i);
    assert.deepEqual(r.badge, { classe: "warn", label: "Conciliação pendente" });
  });
  test("sem_dado sem nenhum ultimoValorValido: texto '—', sem contexto", () => {
    const r = valorDoRegistro({ valor: null, status: "sem_dado", ultimoValorValido: null });
    assert.equal(r.texto, "—");
    assert.equal(r.contexto, null);
  });
  test("percentualDoRegistro usa fmtPct em vez de fmtMoeda", () => {
    const r = percentualDoRegistro({ valor: 13, status: "conciliado", ultimoValorValido: null });
    assert.equal(r.texto, "13.0%");
  });
});

describe("variacaoPp vs variacaoRelativa — nunca confundir p.p. com %", () => {
  test("34% -> 30% = -4.0 p.p., nunca '-4%'", () => {
    const v = variacaoPp(34, 30);
    assert.equal(v.diff, -4);
    assert.match(v.texto, /p\.p\./);
    assert.doesNotMatch(v.texto, /%$/);
  });
  test("R$ 40 -> R$ 44 = variação relativa +10%, nunca p.p.", () => {
    const v = variacaoRelativa(40, 44);
    assert.ok(Math.abs(v.pct - 10) < 0.001);
    assert.match(v.texto, /%$/);
    assert.doesNotMatch(v.texto, /p\.p\./);
  });
  test("de === 0: variação relativa indisponível (não inventa divisão por zero)", () => {
    assert.equal(variacaoRelativa(0, 10), null);
  });
  test("qualquer lado null: ambas ficam null", () => {
    assert.equal(variacaoPp(null, 10), null);
    assert.equal(variacaoRelativa(10, null), null);
  });
});

describe("mediaPorDia — nunca compara faturamento absoluto sem considerar os dias", () => {
  test("R$ 20.000 em 5 dias vs R$ 40.000 em 15 dias: médias revertem a leitura ingênua", () => {
    assert.equal(mediaPorDia(20000, 5), 4000);
    assert.equal(mediaPorDia(40000, 15), 40000 / 15);
    assert.ok(mediaPorDia(20000, 5) > mediaPorDia(40000, 15), "por dia, o período de 5 dias rendeu MAIS, ao contrário do total absoluto");
  });
  test("sem dias ou sem total: null (nunca 0 nem Infinity)", () => {
    assert.equal(mediaPorDia(1000, 0), null);
    assert.equal(mediaPorDia(null, 10), null);
  });
});

// ---------------------------------------------------------------------------
// CASO REAL — Subway Feiraguay, setembro/2026 (mesmos números do backend).
// ---------------------------------------------------------------------------
const pct = (valor, status = "conciliado") => ({ valor, status });
const reg = (valor, status = "conciliado", ultimoValorValido = null) => ({ valor, status, ultimoValorValido });

const COMPARATIVO_FEIRAGUAY = [
  {
    modelo: "marketplace", inicio: "2026-09-01", fim: "2026-09-19", diasComDados: 19,
    valorVendasBruto: 72798.34, qtdVendas: 1723, novosClientes: 530, ticketMedio: 72798.34 / 1723,
    financeiro: {
      campos: {
        valorVendasIfood: reg(82760.95), taxasComissoes: reg(10016.61), servicosPromocoes: reg(14000.02),
        taxasEntregadores: reg(null, "suspeito", { valor: 9253, data: "2026-09-17" }),
        ajustesFavorLoja: reg(358.53), ajustesContraLoja: reg(0),
      },
      totalDeducoes: reg(null, "suspeito", { valor: 33269.63, data: "2026-09-19" }),
      receitaLiquida: reg(null, "suspeito", null),
    },
    percentuais: {
      taxasComissoes: pct(12.1), servicosPromocoes: pct(16.9), taxasEntregadores: pct(null, "suspeito"),
      totalDeducoes: pct(null, "suspeito"), receitaLiquida: pct(null, "suspeito"),
    },
  },
  {
    modelo: "full_service", inicio: "2026-09-20", fim: "2026-09-21", diasComDados: 2,
    valorVendasBruto: 4111.98, qtdVendas: 75, novosClientes: 16, ticketMedio: 4111.98 / 75,
    financeiro: {
      campos: {
        valorVendasIfood: reg(null, "nao_conciliavel", { valor: 1975.93, data: "2026-09-20" }),
        taxasComissoes: reg(719.33), servicosPromocoes: reg(299.37), taxasEntregadores: reg(null, "nao_aplicavel"),
        ajustesFavorLoja: reg(0), ajustesContraLoja: reg(0),
      },
      totalDeducoes: reg(1018.70), receitaLiquida: reg(null, "nao_conciliavel", null),
    },
    percentuais: {
      taxasComissoes: pct(20.5), servicosPromocoes: pct(10), taxasEntregadores: pct(null, "nao_aplicavel"),
      totalDeducoes: pct(30.5), receitaLiquida: pct(null, "nao_conciliavel"),
    },
  },
];
const CONSOLIDADO_FEIRAGUAY = {
  campos: { valorVendasIfood: reg(null, "nao_conciliavel", null) },
  totalDeducoes: reg(null, "suspeito", { valor: 34288.33, data: "2026-09-19" }),
  receitaLiquida: reg(null, "nao_conciliavel", null),
};

describe("CASO REAL Feiraguay — montarConciliacao", () => {
  const c = montarConciliacao(COMPARATIVO_FEIRAGUAY, CONSOLIDADO_FEIRAGUAY);

  test("Marketplace: faturamento e taxas conciliados; Entregadores suspeito com contexto (nunca 0,00 nem 9.253,00 como oficial)", () => {
    const mp = c.segmentos[0];
    assert.equal(mp.rotulo, "Marketplace");
    assert.equal(mp.intervalo, "01/09 a 19/09");
    assert.match(mp.faturamento.texto, /82\.760,95/);
    assert.equal(mp.taxasEntregadores.valor.texto, "—");
    assert.match(mp.taxasEntregadores.valor.contexto, /9\.253,00/);
    assert.deepEqual(mp.taxasEntregadores.valor.badge, { classe: "warn", label: "Conciliação pendente" });
  });

  test("Full Service: Entregadores 'Não aplicável' (nunca 0% nem Dados insuficientes); faturamento não conciliável", () => {
    const fs = c.segmentos[1];
    assert.equal(fs.taxasEntregadores.valor.texto, "Não aplicável");
    assert.equal(fs.taxasEntregadores.percentual.texto, "Não aplicável");
    assert.equal(fs.faturamento.texto, "—");
    assert.match(fs.faturamento.contexto, /1\.975,93/);
  });

  test("Consolidado: faturamento e receita líquida indisponíveis (nunca inventados); Deduções mostra a badge do problema", () => {
    assert.equal(c.consolidado.faturamento.texto, "—");
    assert.equal(c.consolidado.receitaLiquida.texto, "—");
    assert.equal(c.consolidado.deducoesPercentual.texto, "—");
    assert.ok(c.consolidado.deducoesPercentual.badge);
  });
});

describe("CASO REAL Feiraguay — comparativo (só compara o que os dois lados sustentam)", () => {
  test("Taxas e Comissões e Serviços e Promoções aparecem (ambos conciliados); Entregadores e Receita Líquida ficam de fora", () => {
    const linhas = linhasComparativoIndicadores(COMPARATIVO_FEIRAGUAY);
    const rotulos = linhas.map((l) => l.rotulo);
    assert.ok(rotulos.includes("Taxas e Comissões"));
    assert.ok(rotulos.includes("Serviços e Promoções"));
    assert.ok(!rotulos.includes("Taxas de Entregadores")); // FS é 'nao_aplicavel'
    assert.ok(!rotulos.includes("Total de Deduções")); // MP está 'suspeito'
    assert.ok(!rotulos.includes("Receita Líquida")); // os dois lados indisponíveis
    const taxas = linhas.find((l) => l.rotulo === "Taxas e Comissões");
    assert.equal(taxas.a.texto, "12.1%");
    assert.equal(taxas.b.texto, "20.5%");
    assert.match(taxas.variacaoTexto, /p\.p\./);
  });

  test("amostra pequena: Full Service tem só 2 dias -> nota gerada", () => {
    const nota = notaAmostraPequena(COMPARATIVO_FEIRAGUAY, 5);
    assert.match(nota, /Full Service tem 2 dia\(s\)/);
    assert.doesNotMatch(nota, /Marketplace tem/); // MP tem 19 dias, não é pequena
  });

  test("operacional: ticket médio e faturamento médio/dia calculáveis independente do Financeiro Oficial estar quebrado", () => {
    const linhas = linhasComparativoOperacional(COMPARATIVO_FEIRAGUAY);
    const ticket = linhas.find((l) => l.rotulo === "Ticket médio");
    assert.ok(ticket);
    assert.notEqual(ticket.a, "—");
    assert.notEqual(ticket.b, "—");
  });
});

describe("Sem período misto: helpers devolvem estruturas vazias, nunca quebram", () => {
  test("montarConciliacao/linhas* com null ou array curto", () => {
    assert.equal(montarConciliacao(null, null), null);
    assert.deepEqual(linhasComparativoIndicadores(null), []);
    assert.deepEqual(linhasComparativoOperacional([{ modelo: "marketplace" }]), []);
    assert.equal(notaAmostraPequena(null, 5), null);
  });
});
