// PAINEL ADMINISTRATIVO — motor puro de LUCRATIVIDADE SEMANAL.
//
// Protege:
//  1. o BLOCO SEMANAL FIXO DO MÊS (1: 01–07 · 2: 08–14 · 3: 15–21 · 4: 22–fim) —
//     nunca cruza meses, nunca há Semana 5, Semana 4 tem 7..10 dias;
//  2. o RECORTE DE PERÍODO: como o financeiro do iFood é snapshot mensal
//     acumulado, o valor do bloco é a diferença entre o acumulado no fim e o
//     acumulado na véspera do início (0 na Semana 1). Unidade sem lançamento
//     diário fica `null`, nunca 0.
//
// Rodar: node --test test/administrativo-lucratividade.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  semanaDe, deslocarSemana, indiceBloco,
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

describe("semanaDe — bloco fixo do mês (nunca cruza mês, nunca Semana 5)", () => {
  test("as 4 faixas de setembro/2026", () => {
    assert.deepEqual(semanaDe("2026-09-01"), { ano: 2026, mes: 9, indice: 1, inicio: "2026-09-01", fim: "2026-09-07" });
    assert.deepEqual(semanaDe("2026-09-07"), { ano: 2026, mes: 9, indice: 1, inicio: "2026-09-01", fim: "2026-09-07" });
    assert.deepEqual(semanaDe("2026-09-08"), { ano: 2026, mes: 9, indice: 2, inicio: "2026-09-08", fim: "2026-09-14" });
    assert.deepEqual(semanaDe("2026-09-15"), { ano: 2026, mes: 9, indice: 3, inicio: "2026-09-15", fim: "2026-09-21" });
    assert.deepEqual(semanaDe("2026-09-22"), { ano: 2026, mes: 9, indice: 4, inicio: "2026-09-22", fim: "2026-09-30" });
    assert.equal(semanaDe("2026-09-29").indice, 4, "dia 29 é Semana 4, nunca 5");
    assert.equal(semanaDe("2026-09-30").indice, 4);
  });
  test("Semana 4 = 22–último dia do mês (30 / 31 / 28 / 29 bissexto)", () => {
    assert.equal(semanaDe("2026-09-25").fim, "2026-09-30");
    assert.equal(semanaDe("2026-08-25").fim, "2026-08-31");
    assert.equal(semanaDe("2026-02-25").fim, "2026-02-28");
    assert.equal(semanaDe("2024-02-25").fim, "2024-02-29", "fevereiro bissexto");
  });
  test("indiceBloco: 1..7 -> 1 ; 8..14 -> 2 ; 15..21 -> 3 ; 22..31 -> 4", () => {
    assert.deepEqual([1, 7, 8, 14, 15, 21, 22, 31].map(indiceBloco), [1, 1, 2, 2, 3, 3, 4, 4]);
  });
});

describe("deslocarSemana — navegação entre blocos", () => {
  test("Semana 4 -> Semana 1 do mês seguinte; Semana 1 -> Semana 4 do mês anterior", () => {
    assert.equal(deslocarSemana("2026-09-22", 1), "2026-10-01");
    assert.equal(deslocarSemana("2026-09-05", -1), "2026-08-22");
  });
  test("dentro do mês", () => {
    assert.equal(deslocarSemana("2026-09-08", -1), "2026-09-01");
    assert.equal(deslocarSemana("2026-09-15", 1), "2026-09-22");
  });
  test("virada de ano", () => {
    assert.equal(deslocarSemana("2026-01-03", -1), "2025-12-22");
    assert.equal(deslocarSemana("2026-12-28", 1), "2027-01-01");
  });
});

describe("lucratividadeDaUnidade — recorte de snapshot (bloco)", () => {
  test("bloco no meio do mês = fim − véspera do início", () => {
    // Semana 2 (08–14): acumulado dia 7 -> 700/70 ; dia 14 -> 2100/210
    const linhas = [linha("2026-09-07", 700, 70), linha("2026-09-14", 2100, 210)];
    const r = lucratividadeDaUnidade(linhas, { inicio: "2026-09-08", fim: "2026-09-14", ateDataIso: "2026-09-14" });
    assert.equal(r.faturamento, 1400);         // 2100 − 700
    assert.equal(r.deducoes, 140);             // 210 − 70
    assert.equal(r.receitaLiquida, 1260);
    assert.equal(Math.round(r.deducoesPct), 10);
    assert.equal(Math.round(r.rentabilidadePct), 90);
  });

  test("Semana 1 usa base 0 (acumulado reinicia no dia 1)", () => {
    const linhas = [linha("2026-09-06", 500, 50)];
    const r = lucratividadeDaUnidade(linhas, { inicio: "2026-09-01", fim: "2026-09-07", ateDataIso: "2026-09-06" });
    assert.equal(r.faturamento, 500);
    assert.equal(r.deducoes, 50);
  });

  test("bloco nunca cruza mês: só as linhas do mês do bloco entram", () => {
    const linhas = [
      linha("2026-08-31", 9999, 999),   // mês anterior — NÃO entra
      linha("2026-09-06", 600, 60),
      linha("2026-09-07", 800, 80),
    ];
    // Semana 1 de setembro: 800 − 0 = 800 (o acumulado de agosto é ignorado)
    const r = lucratividadeDaUnidade(linhas, { inicio: "2026-09-01", fim: "2026-09-07", ateDataIso: "2026-09-07" });
    assert.equal(r.faturamento, 800);
    assert.equal(r.deducoes, 80);
  });

  test("corte em D-1: só conta o que já venceu", () => {
    const linhas = [linha("2026-09-09", 200, 20), linha("2026-09-14", 1300, 130)];
    const r = lucratividadeDaUnidade(linhas, { inicio: "2026-09-08", fim: "2026-09-14", ateDataIso: "2026-09-09" });
    assert.equal(r.faturamento, 200);         // ignora o snapshot do dia 14
  });

  test("confirmado x provisório: rascunho não é confirmado", () => {
    const linhas = [
      linha("2026-09-09", 300, 30, "finalizado"),
      linha("2026-09-12", 900, 90, "rascunho"),
    ];
    const r = lucratividadeDaUnidade(linhas, { inicio: "2026-09-08", fim: "2026-09-14", ateDataIso: "2026-09-14" });
    assert.equal(r.faturamento, 900);
    assert.equal(r.confirmado, 300);
    assert.equal(r.provisorio, 600);
    assert.equal(r.incluiProvisorio, true);
  });

  test("unidade só com distribuição mensal -> semDado (null, nunca 0)", () => {
    const linhas = [{
      data_lancamento: "2026-09-14", status: "finalizado", situacao: "normal",
      origem_lancamento: "distribuicao_mensal", valor_vendas_ifood: 9000, taxas_comissoes: 900,
    }];
    const r = lucratividadeDaUnidade(linhas, { inicio: "2026-09-08", fim: "2026-09-14", ateDataIso: "2026-09-14" });
    assert.equal(r.semDado, true);
    assert.equal(r.faturamento, null);
  });

  test("bloco inteiramente futuro -> semDado", () => {
    const r = lucratividadeDaUnidade([linha("2026-09-14", 100, 10)], { inicio: "2026-09-15", fim: "2026-09-21", ateDataIso: "2026-09-10" });
    assert.equal(r.semDado, true);
  });

  test("Semana 1 comparada com a Semana 4 do mês anterior — valores reais, sem normalizar", () => {
    // Semana 4 de agosto (22–31, 10 dias) e Semana 1 de setembro (01–07, 7 dias).
    const linhas = [
      linha("2026-08-21", 2100, 210), linha("2026-08-31", 5100, 510),  // ago: 5100 − 2100 = 3000
      linha("2026-09-07", 1400, 140),                                   // set: 1400 − 0 = 1400
    ];
    const s4ago = lucratividadeDaUnidade(linhas, { inicio: "2026-08-22", fim: "2026-08-31", ateDataIso: "2026-08-31" });
    const s1set = lucratividadeDaUnidade(linhas, { inicio: "2026-09-01", fim: "2026-09-07", ateDataIso: "2026-09-07" });
    assert.equal(s4ago.faturamento, 3000, "10 dias reais, sem média");
    assert.equal(s1set.faturamento, 1400, "7 dias reais, sem média");
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
