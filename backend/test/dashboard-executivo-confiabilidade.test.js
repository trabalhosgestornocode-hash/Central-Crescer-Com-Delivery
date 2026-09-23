import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  caminharSequenciaAcumulada, reconciliarCampoSegmento, piorStatus, STATUS_CONCILIACAO,
  detectarDivergenciaTransicao, ultimoValorConciliadoAntesDe, avaliarQuedaAcumulado, avisoIgualdadeSuspeitaComBruto,
} from "../src/modules/dashboard-executivo/dashboardExecutivo.confiabilidade.js";

// Dados REAIS (setembro/2026, Matriz Subway Feiraguay) — investigação de
// 2026-09-22. Só os campos relevantes; datas 01-16 resumidas em progressão
// simples (não afetam os casos testados), 17-21 exatamente como no banco.
const row = (dia, extra) => ({
  data_lancamento: `2026-09-${dia}`, situacao: "normal", origem_lancamento: "diario", ...extra,
});
const LINHAS_FEIRAGUAY = [
  row("01", { valor_vendas_ifood: 6692.41, valor_vendas_bruto: 5000, taxas_entregadores: 798.00 }),
  row("17", { valor_vendas_ifood: 73300.67, valor_vendas_bruto: 64105.64, taxas_entregadores: 9253.00 }),
  row("18", { valor_vendas_ifood: 78924.58, valor_vendas_bruto: 69199.40, taxas_entregadores: 0.00 }),
  row("19", { valor_vendas_ifood: 82760.95, valor_vendas_bruto: 72798.34, taxas_entregadores: 0.00 }),
  row("20", { valor_vendas_ifood: 84736.88, valor_vendas_bruto: 75163.84, taxas_entregadores: 0.00 }),
  row("21", { valor_vendas_ifood: 76910.32, valor_vendas_bruto: 76910.32, taxas_entregadores: 0.00 }),
];

describe("Caso real Subway Feiraguay — valor_vendas_ifood (regra A: queda inesperada)", () => {
  test("caminhada: 17-20 conciliados; 21 não-conciliável (queda -7826,56 vs 20/09)", () => {
    const seq = caminharSequenciaAcumulada(LINHAS_FEIRAGUAY, "valor_vendas_ifood");
    assert.equal(seq.get("2026-09-20").status, STATUS_CONCILIACAO.CONCILIADO);
    const d21 = seq.get("2026-09-21");
    assert.equal(d21.status, STATUS_CONCILIACAO.NAO_CONCILIAVEL);
    assert.equal(d21.ultimoValido.valor, 84736.88);
    assert.equal(d21.ultimoValido.data, "2026-09-20");
  });

  test("segmento Full Service (20→21, vigência 20/09): não conciliável, último valor válido = 84.736,88 em 20/09", () => {
    const seq = caminharSequenciaAcumulada(LINHAS_FEIRAGUAY, "valor_vendas_ifood");
    const r = reconciliarCampoSegmento(seq, "2026-09-20", "2026-09-21");
    assert.equal(r.valorOficial, null);
    assert.equal(r.status, STATUS_CONCILIACAO.NAO_CONCILIAVEL);
    assert.equal(r.ultimoValorValido.data, "2026-09-20");
  });

  test("segmento Marketplace (até 19/09) continua CONCILIADO — a queda de 21/09 não contamina o passado", () => {
    const seq = caminharSequenciaAcumulada(LINHAS_FEIRAGUAY, "valor_vendas_ifood");
    const r = reconciliarCampoSegmento(seq, null, "2026-09-19", true);
    assert.equal(r.valorOficial, 82760.95);
    assert.equal(r.status, STATUS_CONCILIACAO.CONCILIADO);
  });
});

describe("Caso real Subway Feiraguay — taxas_entregadores (regra B: reset/zeragem)", () => {
  test("caminhada: 17 conciliado (9253,00); 18-21 suspeitos, último válido continua 9253,00 em 17/09", () => {
    const seq = caminharSequenciaAcumulada(LINHAS_FEIRAGUAY, "taxas_entregadores");
    assert.equal(seq.get("2026-09-17").status, STATUS_CONCILIACAO.CONCILIADO);
    const d18 = seq.get("2026-09-18");
    assert.equal(d18.status, STATUS_CONCILIACAO.SUSPEITO);
    assert.equal(d18.motivo, "reset_zeragem");
    assert.equal(d18.ultimoValido.valor, 9253.00);
    const d21 = seq.get("2026-09-21");
    assert.equal(d21.status, STATUS_CONCILIACAO.SUSPEITO);
    assert.equal(d21.ultimoValido.valor, 9253.00); // nunca "esquece" o último ponto confiável
  });

  test("segmento Marketplace (até 19/09): suspeito, NUNCA vira R$0,00 nem 'confirmado' — só evidência", () => {
    const seq = caminharSequenciaAcumulada(LINHAS_FEIRAGUAY, "taxas_entregadores");
    const r = reconciliarCampoSegmento(seq, null, "2026-09-19", true);
    assert.equal(r.valorOficial, null); // NUNCA silenciosamente 0,00 nem 9.253,00
    assert.equal(r.status, STATUS_CONCILIACAO.SUSPEITO);
    assert.equal(r.ultimoValorValido.valor, 9253.00);
    assert.equal(r.ultimoValorValido.data, "2026-09-17");
  });

  test("divergência de transição: reset em 18/09, vigência registrada 20/09 -> sinaliza (2 dias de diferença)", () => {
    const seq = caminharSequenciaAcumulada(LINHAS_FEIRAGUAY, "taxas_entregadores");
    const d = detectarDivergenciaTransicao(seq, "2026-09-20", "2026-09-19");
    assert.equal(d.divergente, true);
    assert.equal(d.dataMudancaOperacional, "2026-09-18");
    assert.equal(d.diasDeDivergencia, 2);
  });

  test("sem divergência real (reset no mesmo dia da vigência, ou 1 dia antes): não sinaliza", () => {
    const seq = caminharSequenciaAcumulada(LINHAS_FEIRAGUAY, "taxas_entregadores");
    assert.equal(detectarDivergenciaTransicao(seq, "2026-09-18", "2026-09-17").divergente, false);
    assert.equal(detectarDivergenciaTransicao(seq, "2026-09-19", "2026-09-18").divergente, false);
  });
});

describe("piorStatus — dependência mínima real, não_aplicável é sempre neutro", () => {
  test("conciliado + conciliado = conciliado", () => {
    assert.equal(piorStatus("conciliado", "conciliado"), "conciliado");
  });
  test("conciliado + não_conciliável = não_conciliável (nunca esconde o pior lado)", () => {
    assert.equal(piorStatus("conciliado", "nao_conciliavel"), "nao_conciliavel");
  });
  test("não_aplicavel nunca arrasta o resultado para baixo", () => {
    assert.equal(piorStatus("conciliado", "nao_aplicavel"), "conciliado");
    assert.equal(piorStatus("nao_aplicavel", "nao_aplicavel"), "nao_aplicavel");
  });
  test("suspeito é pior que sem_dado, e não_conciliável é o pior de todos", () => {
    assert.equal(piorStatus("sem_dado", "suspeito"), "suspeito");
    assert.equal(piorStatus("suspeito", "nao_conciliavel"), "nao_conciliavel");
  });
});

describe("Auto-cura: acumulado que cai e depois RECUPERA acima do último ponto confiável volta a 'conciliado'", () => {
  const linhas = [
    row("01", { valor_vendas_ifood: 1000 }),
    row("02", { valor_vendas_ifood: 1500 }), // conciliado, ultimoValido=1500
    row("03", { valor_vendas_ifood: 200 }),  // queda -> não conciliável, ultimoValido continua 1500@02
    row("04", { valor_vendas_ifood: 1600 }), // >= 1500 -> volta a conciliado, ultimoValido=1600@04
  ];
  test("dia 3 é não-conciliável; dia 4 (recupera acima do último válido) volta a conciliado", () => {
    const seq = caminharSequenciaAcumulada(linhas, "valor_vendas_ifood");
    assert.equal(seq.get("2026-09-03").status, STATUS_CONCILIACAO.NAO_CONCILIAVEL);
    assert.equal(seq.get("2026-09-04").status, STATUS_CONCILIACAO.CONCILIADO);
    assert.equal(seq.get("2026-09-04").valor, 1600);
  });
  test("segmento até o dia 4 usa o valor recuperado (1600), não fica preso ao dia 3 ruim", () => {
    const seq = caminharSequenciaAcumulada(linhas, "valor_vendas_ifood");
    const r = reconciliarCampoSegmento(seq, null, "2026-09-04", true);
    assert.equal(r.valorOficial, 1600);
    assert.equal(r.status, STATUS_CONCILIACAO.CONCILIADO);
  });
});

describe("Segmento NÃO-primeiro sem nenhum ponto de corte anterior: SEM_DADO, nunca 'o valor do fim é o total'", () => {
  // Só existe UM lançamento no mês inteiro, dentro do 2º segmento (Full
  // Service) — sem NENHUM dado nos dias do 1º segmento (Marketplace) nem na
  // véspera da troca. Atribuir o valor de 18/09 inteiro ao Full Service
  // inventaria quanto pertenceria ao Marketplace (equivalente ao antigo
  // "snapshot da véspera ausente").
  const linhas = [row("18", { valor_vendas_ifood: 16000 })];
  test("1º segmento (Marketplace, sem nenhum dado): SEM_DADO", () => {
    const seq = caminharSequenciaAcumulada(linhas, "valor_vendas_ifood");
    const mp = reconciliarCampoSegmento(seq, null, "2026-09-12", true);
    assert.equal(mp.status, STATUS_CONCILIACAO.SEM_DADO);
    assert.equal(mp.valorOficial, null);
  });
  test("2º segmento (Full Service, tem dado mas SEM ponto de corte na véspera da troca): SEM_DADO, NUNCA o valor de 18/09 como total", () => {
    const seq = caminharSequenciaAcumulada(linhas, "valor_vendas_ifood");
    const fs = reconciliarCampoSegmento(seq, "2026-09-13", "2026-09-30", false);
    assert.equal(fs.status, STATUS_CONCILIACAO.SEM_DADO);
    assert.equal(fs.valorOficial, null); // NUNCA 16000 — não há como provar que pertence só ao Full Service
  });
});

describe("Queda ignorável (arredondamento) nunca vira status degradado", () => {
  const linhas = [row("01", { valor_vendas_ifood: 39.89 }), row("02", { valor_vendas_ifood: 38.90 })]; // -0,99, caso real (outra unidade)
  test("diferença menor que o limiar continua conciliado", () => {
    const seq = caminharSequenciaAcumulada(linhas, "valor_vendas_ifood");
    assert.equal(seq.get("2026-09-02").status, STATUS_CONCILIACAO.CONCILIADO);
  });
});

describe("avaliarQuedaAcumulado — validação preventiva (item E)", () => {
  test("sem ponto anterior: nada a avaliar", () => {
    assert.equal(avaliarQuedaAcumulado({ campo: "valorVendasIfood", rotulo: "Faturamento", valorNovo: 100, ultimoConhecido: null }), null);
  });
  test("sem queda (valor igual ou maior): null", () => {
    assert.equal(avaliarQuedaAcumulado({ campo: "x", rotulo: "X", valorNovo: 100, ultimoConhecido: { valor: 100, data: "2026-09-01" } }), null);
    assert.equal(avaliarQuedaAcumulado({ campo: "x", rotulo: "X", valorNovo: 150, ultimoConhecido: { valor: 100, data: "2026-09-01" } }), null);
  });
  test("queda ignorável (< R$1): null", () => {
    assert.equal(avaliarQuedaAcumulado({ campo: "x", rotulo: "X", valorNovo: 99.5, ultimoConhecido: { valor: 100, data: "2026-09-01" } }), null);
  });
  test("queda leve (< R$50): nível 'leve'", () => {
    const r = avaliarQuedaAcumulado({ campo: "x", rotulo: "Taxas", valorNovo: 970, ultimoConhecido: { valor: 1000, data: "2026-09-01" } });
    assert.equal(r.nivel, "leve");
  });
  test("caso real Feiraguay (84.736,88 -> 76.910,32): nível 'material', mensagem cita os dois valores e a data", () => {
    const r = avaliarQuedaAcumulado({
      campo: "valorVendasIfood", rotulo: "Valor das vendas (iFood)", valorNovo: 76910.32,
      ultimoConhecido: { valor: 84736.88, data: "2026-09-20" },
    });
    assert.equal(r.nivel, "material");
    assert.match(r.mensagem, /84\.736,88/);
    assert.match(r.mensagem, /76\.910,32/);
    assert.match(r.mensagem, /20\/09\/2026/);
  });
});

describe("ultimoValorConciliadoAntesDe", () => {
  test("caso real: antes de 21/09, o último conciliado é 20/09 (84.736,88)", () => {
    const r = ultimoValorConciliadoAntesDe(LINHAS_FEIRAGUAY, "valor_vendas_ifood", "2026-09-21");
    assert.deepEqual(r, { valor: 84736.88, data: "2026-09-20" });
  });
  test("mês sem nenhum lançamento anterior: null", () => {
    assert.equal(ultimoValorConciliadoAntesDe([], "valor_vendas_ifood", "2026-09-01"), null);
  });
});

describe("avisoIgualdadeSuspeitaComBruto", () => {
  test("caso real: 21/09 ifood===bruto quebra o padrão dos dias anteriores (iFood sempre > bruto) -> sinaliza", () => {
    const aviso = avisoIgualdadeSuspeitaComBruto({
      valorVendasIfood: 76910.32, valorVendasBruto: 76910.32, linhasDoMes: LINHAS_FEIRAGUAY, dataAtualIso: "2026-09-21",
    });
    assert.match(aviso, /incomum nesta unidade/);
  });
  test("unidade cujo padrão histórico já tem ifood ~= bruto: não sinaliza (não é regra absoluta)", () => {
    const linhas = [row("01", { valor_vendas_ifood: 100, valor_vendas_bruto: 100 }), row("02", { valor_vendas_ifood: 200, valor_vendas_bruto: 200 })];
    assert.equal(avisoIgualdadeSuspeitaComBruto({ valorVendasIfood: 300, valorVendasBruto: 300, linhasDoMes: linhas }), null);
  });
  test("amostra pequena demais (< 2 dias anteriores completos): não sinaliza", () => {
    assert.equal(avisoIgualdadeSuspeitaComBruto({ valorVendasIfood: 100, valorVendasBruto: 100, linhasDoMes: [] }), null);
  });
  test("valores diferentes: sem sinal (a checagem é só sobre igualdade)", () => {
    assert.equal(avisoIgualdadeSuspeitaComBruto({ valorVendasIfood: 100, valorVendasBruto: 90, linhasDoMes: LINHAS_FEIRAGUAY }), null);
  });
});
