// PAINEL ADMINISTRATIVO — motor puro de LUCRATIVIDADE SEMANAL.
//
// Protege o RECORTE DE PERÍODO: como o financeiro do iFood é snapshot mensal
// acumulado, o valor da semana é a diferença entre o acumulado no fim e o
// acumulado na véspera do início — por segmento de mês, tratando a semana que
// cruza a virada. Unidade sem lançamento diário fica `null`, nunca 0.
//
// Rodar: node --test test/administrativo-lucratividade.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  semanaDe, deslocarSemana, somarDias, segmentosPorMes,
  lucratividadeDaUnidade, agregarRede, folgaLimite, percentual,
} from "../src/modules/administrativo/administrativo.lucratividade.js";

// snapshot ACUMULADO do mês: valor_vendas_ifood cresce dia a dia.
const linha = (data, acumFat, acumDed, status = "finalizado") => ({
  data_lancamento: data,
  status,
  situacao: "normal",
  origem_lancamento: "diario",
  valor_vendas_ifood: acumFat,
  taxas_comissoes: acumDed,
  servicos_promocoes: 0,
  taxas_entregadores: 0,
  ajustes_favor_loja: 0,
  ajustes_contra_loja: 0,
});

describe("semanaDe / deslocarSemana", () => {
  test("segunda a domingo contendo a data", () => {
    assert.deepEqual(semanaDe("2026-09-09"), { inicio: "2026-09-07", fim: "2026-09-13" });
    assert.deepEqual(semanaDe("2026-09-07"), { inicio: "2026-09-07", fim: "2026-09-13" });
    assert.deepEqual(semanaDe("2026-09-13"), { inicio: "2026-09-07", fim: "2026-09-13" });
  });
  test("semana anterior", () => {
    assert.equal(deslocarSemana("2026-09-07", -1), "2026-08-31");
    assert.equal(somarDias("2026-08-31", 6), "2026-09-06");
  });
});

describe("segmentosPorMes", () => {
  test("semana dentro de um mês = 1 segmento", () => {
    assert.deepEqual(segmentosPorMes("2026-09-07", "2026-09-13"), [
      { ym: "2026-09", de: "2026-09-07", ate: "2026-09-13" },
    ]);
  });
  test("semana cruzando a virada = 2 segmentos", () => {
    assert.deepEqual(segmentosPorMes("2026-08-31", "2026-09-06"), [
      { ym: "2026-08", de: "2026-08-31", ate: "2026-08-31" },
      { ym: "2026-09", de: "2026-09-01", ate: "2026-09-06" },
    ]);
  });
});

describe("lucratividadeDaUnidade — recorte de snapshot", () => {
  test("semana no meio do mês = fim − véspera do início", () => {
    // acumulado: dia 6 -> 600/60 ; dia 13 -> 1300/130
    const linhas = [linha("2026-09-06", 600, 60), linha("2026-09-13", 1300, 130)];
    const r = lucratividadeDaUnidade(linhas, { inicio: "2026-09-07", fim: "2026-09-13", ateDataIso: "2026-09-13" });
    assert.equal(r.faturamento, 700);          // 1300 − 600
    assert.equal(r.deducoes, 70);              // 130 − 60
    assert.equal(r.receitaLiquida, 630);
    assert.equal(Math.round(r.deducoesPct), 10);
    assert.equal(Math.round(r.rentabilidadePct), 90);
  });

  test("semana começando no dia 1 usa base 0 (acumulado reinicia no mês)", () => {
    const linhas = [linha("2026-09-06", 500, 50)];
    const r = lucratividadeDaUnidade(linhas, { inicio: "2026-09-01", fim: "2026-09-07", ateDataIso: "2026-09-06" });
    assert.equal(r.faturamento, 500);
    assert.equal(r.deducoes, 50);
  });

  test("semana cruzando a virada do mês soma os dois segmentos", () => {
    const linhas = [
      linha("2026-08-30", 3000, 300),   // véspera do início (31/08)
      linha("2026-08-31", 3100, 310),   // fim do segmento de agosto
      linha("2026-09-06", 800, 80),     // fim do segmento de setembro (acumulado de setembro)
    ];
    const r = lucratividadeDaUnidade(linhas, { inicio: "2026-08-31", fim: "2026-09-06", ateDataIso: "2026-09-06" });
    // agosto: 3100 − 3000 = 100 ; setembro: 800 − 0 = 800
    assert.equal(r.faturamento, 900);
    assert.equal(r.deducoes, 90);
  });

  test("corte em D-1: só conta o que já venceu", () => {
    const linhas = [linha("2026-09-08", 200, 20), linha("2026-09-13", 1300, 130)];
    const r = lucratividadeDaUnidade(linhas, { inicio: "2026-09-07", fim: "2026-09-13", ateDataIso: "2026-09-08" });
    assert.equal(r.faturamento, 200);         // ignora o snapshot do dia 13
  });

  test("confirmado x provisório: rascunho não é confirmado", () => {
    const linhas = [
      linha("2026-09-08", 300, 30, "finalizado"),
      linha("2026-09-12", 900, 90, "rascunho"),
    ];
    const r = lucratividadeDaUnidade(linhas, { inicio: "2026-09-07", fim: "2026-09-13", ateDataIso: "2026-09-13" });
    assert.equal(r.faturamento, 900);
    assert.equal(r.confirmado, 300);
    assert.equal(r.provisorio, 600);
    assert.equal(r.incluiProvisorio, true);
  });

  test("unidade só com distribuição mensal -> semDado (null, nunca 0)", () => {
    const linhas = [{
      data_lancamento: "2026-09-30", status: "finalizado", situacao: "normal",
      origem_lancamento: "distribuicao_mensal", valor_vendas_ifood: 9000, taxas_comissoes: 900,
    }];
    const r = lucratividadeDaUnidade(linhas, { inicio: "2026-09-07", fim: "2026-09-13", ateDataIso: "2026-09-13" });
    assert.equal(r.semDado, true);
    assert.equal(r.faturamento, null);
  });

  test("semana inteiramente futura -> semDado", () => {
    const r = lucratividadeDaUnidade([linha("2026-09-13", 100, 10)], { inicio: "2026-09-14", fim: "2026-09-20", ateDataIso: "2026-09-10" });
    assert.equal(r.semDado, true);
  });
});

describe("agregarRede (único ponto que consolida unidades — nunca ranking)", () => {
  test("faturamento/receita somam; rentabilidade % recalcula sobre o total", () => {
    const u1 = { semDado: false, faturamento: 1000, deducoes: 200, receitaLiquida: 800 };
    const u2 = { semDado: false, faturamento: 3000, deducoes: 300, receitaLiquida: 2700 };
    const r = agregarRede([u1, u2]);
    assert.equal(r.faturamento, 4000);
    assert.equal(r.receitaLiquida, 3500);
    assert.equal(r.rentabilidadeReais, 3500);
    assert.equal(Math.round(r.rentabilidadePct), 88);   // 3500/4000
  });
  test("sem unidade com dado -> tudo null", () => {
    const r = agregarRede([{ semDado: true, faturamento: null }]);
    assert.equal(r.faturamento, null);
    assert.equal(r.rentabilidadePct, null);
  });
});

describe("folgaLimite (eficiência modelo-aware)", () => {
  test("limite − % real: positivo = dentro do limite", () => {
    assert.equal(folgaLimite(22, { limite: 25 }), 3);
    assert.equal(folgaLimite(30, { limite: 25 }), -5);
  });
  test("sem meta -> null", () => {
    assert.equal(folgaLimite(22, null), null);
    assert.equal(folgaLimite(null, { limite: 25 }), null);
  });
});

describe("percentual", () => {
  test("null quando base ausente ou <= 0", () => {
    assert.equal(percentual(10, 0), null);
    assert.equal(percentual(null, 100), null);
    assert.equal(percentual(50, 200), 25);
  });
});
