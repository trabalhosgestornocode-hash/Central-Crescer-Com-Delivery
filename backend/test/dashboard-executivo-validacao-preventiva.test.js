// Validação PREVENTIVA de queda de acumulado (item E, investigação real
// Subway Feiraguay — 2026-09-22). `normalizarDadosLancamento` é pura, sem
// I/O — testa direto, sem banco fake.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizarDadosLancamento } from "../src/modules/dashboard-executivo/dashboardExecutivo.service.js";

const corpoBase = (extra = {}) => ({
  situacao: "normal", status: "finalizado",
  qtdVendas: 1798, valorVendasBruto: 76910.32, novosClientes: 546,
  valorVendasIfood: 76910.32, taxasComissoes: 10735.94, servicosPromocoes: 14299.39, taxasEntregadores: 0,
  ...extra,
});

const ctx = (financeiroAnterior) => ({ exigirFinanceiro: true, desempenhoAnterior: null, financeiroAnterior });

describe("Queda leve de acumulado: vira aviso comum, bloqueia só sem confirmarAvisos", () => {
  const financeiroAnterior = { porCampo: { valorVendasIfood: { valor: 76920.32, data: "2026-09-20" } }, linhasDoMes: [], dataIso: "2026-09-21" };
  test("sem confirmarAvisos: 400 com o aviso", () => {
    assert.throws(() => normalizarDadosLancamento(corpoBase(), ctx(financeiroAnterior)), (e) => {
      assert.match(e.message, /Valor menor que o acumulado anterior/);
      return true;
    });
  });
  test("com confirmarAvisos: passa normalmente", () => {
    const dados = normalizarDadosLancamento(corpoBase({ confirmarAvisos: true }), ctx(financeiroAnterior));
    assert.equal(dados.valorVendasIfood, 76910.32);
    assert.equal(dados.sinaisQuedaMaterialConfirmados.length, 0);
  });
});

describe("CASO REAL Feiraguay — queda MATERIAL (84.736,88 -> 76.910,32): confirmarAvisos sozinho NÃO basta", () => {
  const financeiroAnterior = { porCampo: { valorVendasIfood: { valor: 84736.88, data: "2026-09-20" } }, linhasDoMes: [], dataIso: "2026-09-21" };

  test("sem nenhuma confirmação: 400 pedindo confirmação", () => {
    assert.throws(() => normalizarDadosLancamento(corpoBase(), ctx(financeiroAnterior)), (e) => {
      assert.equal(e.status ?? e.statusCode, 400);
      assert.match(e.message, /Valor menor que o acumulado anterior/);
      return true;
    });
  });

  test("só confirmarAvisos (sem confirmarQuedaMaterial): AINDA bloqueia — queda material exige confirmação REFORÇADA", () => {
    assert.throws(() => normalizarDadosLancamento(corpoBase({ confirmarAvisos: true }), ctx(financeiroAnterior)), (e) => {
      assert.equal(e.status ?? e.statusCode, 400);
      assert.match(e.message, /confirmação reforçada e justificativa/);
      assert.equal(e.details?.confirmacaoReforcadaNecessaria, true);
      assert.equal(e.details?.sinaisQuedaMaterial?.[0]?.campo, "valorVendasIfood");
      return true;
    });
  });

  test("confirmarQuedaMaterial=true mas SEM justificativa: bloqueia (a justificativa é obrigatória, não só o checkbox)", () => {
    assert.throws(() => normalizarDadosLancamento(
      corpoBase({ confirmarAvisos: true, confirmarQuedaMaterial: true }), ctx(financeiroAnterior),
    ), /Justificativa da queda de acumulado/);
  });

  test("confirmarQuedaMaterial=true + justificativa por escrito: passa e grava o rastro de auditoria", () => {
    const dados = normalizarDadosLancamento(corpoBase({
      confirmarAvisos: true, confirmarQuedaMaterial: true,
      justificativaQuedaAcumulado: "Confirmado com o franqueado: o iFood aplicou um estorno retroativo neste dia.",
    }), ctx(financeiroAnterior));
    assert.equal(dados.valorVendasIfood, 76910.32);
    assert.equal(dados.sinaisQuedaMaterialConfirmados.length, 1);
    assert.equal(dados.sinaisQuedaMaterialConfirmados[0].campo, "valorVendasIfood");
    assert.equal(dados.sinaisQuedaMaterialConfirmados[0].valorAnterior, 84736.88);
    assert.match(dados.sinaisQuedaMaterialConfirmados[0].justificativa, /estorno retroativo/);
  });

  test("rascunho (não finalizado): NUNCA bloqueia, mesmo com queda material — só ao finalizar", () => {
    const dados = normalizarDadosLancamento(corpoBase({ status: "rascunho" }), ctx(financeiroAnterior));
    assert.equal(dados.valorVendasIfood, 76910.32);
    assert.equal(dados.statusAlvo, "rascunho");
  });
});

describe("Sem financeiroAnterior (mês novo / campo nunca antes preenchido): nunca bloqueia", () => {
  test("financeiroAnterior null: passa normalmente", () => {
    const dados = normalizarDadosLancamento(corpoBase({ confirmarAvisos: undefined }), ctx(null));
    assert.equal(dados.valorVendasIfood, 76910.32);
  });
  test("financeiroAnterior.porCampo sem o campo específico: passa normalmente", () => {
    const dados = normalizarDadosLancamento(corpoBase(), ctx({ porCampo: {}, linhasDoMes: [], dataIso: "2026-09-21" }));
    assert.equal(dados.valorVendasIfood, 76910.32);
  });
});

describe("Valor igual/maior que o anterior: nunca gera aviso de queda", () => {
  test("crescimento normal: sem avisos", () => {
    const financeiroAnterior = { porCampo: { valorVendasIfood: { valor: 70000, data: "2026-09-20" } }, linhasDoMes: [], dataIso: "2026-09-21" };
    const dados = normalizarDadosLancamento(corpoBase(), ctx(financeiroAnterior));
    assert.equal(dados.avisos.length, 0);
  });
});

describe("Igualdade suspeita com valor bruto — sinal combinado com o histórico (nunca bloqueio isolado)", () => {
  const linhasDoMes = [
    { data_lancamento: "2026-09-19", situacao: "normal", origem_lancamento: "diario", valor_vendas_ifood: 82760.95, valor_vendas_bruto: 72798.34 },
    { data_lancamento: "2026-09-20", situacao: "normal", origem_lancamento: "diario", valor_vendas_ifood: 84736.88, valor_vendas_bruto: 75163.84 },
  ];
  test("valor_vendas_ifood == valor_vendas_bruto quebrando o padrão histórico: vira aviso comum (não bloqueio isolado)", () => {
    const financeiroAnterior = { porCampo: {}, linhasDoMes, dataIso: "2026-09-21" };
    const dados = normalizarDadosLancamento(
      corpoBase({ confirmarAvisos: true, valorVendasIfood: 76910.32, valorVendasBruto: 76910.32 }), ctx(financeiroAnterior),
    );
    assert.ok(dados.avisos.some((a) => /incomum nesta unidade/.test(a)));
  });
});
