// "Dados complementares pendentes" do lançamento mensal — a lista só pode
// conter campos que (1) se aplicam ao modelo logístico da unidade e (2) não
// foram informados. Full Service não tem entregadores próprios do iFood:
// "taxas de entregadores" é NÃO APLICÁVEL nesse modelo, nunca "pendente".
//
// Regra pura em dashboardExecutivo.calc.js; o service (montarResumoLoteMensal)
// só repassa. Rodar: node --test test/dashboard-executivo-lancamento-mensal-pendencias.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classificarCamposExtrasMensal,
  campoExtraMensalAplicavel,
  INDICADOR_DO_CAMPO_EXTRA_MENSAL,
  indicadorAplicavel,
} from "../src/modules/dashboard-executivo/dashboardExecutivo.calc.js";

// Mesma ordem/keys de CAMPOS_EXTRAS_MENSAL (dashboardExecutivo.service.js).
const CAMPOS_EXTRAS_MENSAL = [
  ["qtdVendasTotal", "Quantidade de pedidos do mês"],
  ["valorVendasBrutoTotal", "Valor bruto de vendas do mês"],
  ["novosClientesTotal", "Novos clientes do mês"],
  ["taxasComissoesTotal", "Taxas e comissões do mês"],
  ["servicosPromocoesTotal", "Serviços e promoções do mês"],
  ["taxasEntregadoresTotal", "Taxas de entregadores do mês"],
  ["ajustesFavorLojaTotal", "Ajustes a favor da loja no mês"],
  ["ajustesContraLojaTotal", "Ajustes contra a loja no mês"],
];

// Cenário real reportado (Agosto/2026): tudo informado menos entregadores
// (não aplicável — Full Service) e ajustes contra (não informado).
const EXTRAS_CENARIO_REAL = {
  qtdVendasTotal: 1200,
  valorVendasBrutoTotal: 84000,
  novosClientesTotal: 856,
  taxasComissoesTotal: 9800,
  servicosPromocoesTotal: 1500,
  taxasEntregadoresTotal: null,
  ajustesFavorLojaTotal: 120,
  ajustesContraLojaTotal: null,
};

describe("classificarCamposExtrasMensal — dados complementares pendentes", () => {
  test("Teste 1 — Full Service + taxas de entregadores null: NÃO é pendência, é não aplicável", () => {
    const { pendentes, naoAplicaveis } = classificarCamposExtrasMensal(
      CAMPOS_EXTRAS_MENSAL, { taxasEntregadoresTotal: null }, "full_service",
    );
    assert.ok(!pendentes.includes("taxasEntregadoresTotal"));
    assert.ok(naoAplicaveis.includes("taxasEntregadoresTotal"));
  });

  test("Teste 2 — Marketplace + taxas de entregadores null: continua pendência", () => {
    const { pendentes, naoAplicaveis } = classificarCamposExtrasMensal(
      CAMPOS_EXTRAS_MENSAL, { taxasEntregadoresTotal: null }, "marketplace",
    );
    assert.ok(pendentes.includes("taxasEntregadoresTotal"));
    assert.ok(!naoAplicaveis.includes("taxasEntregadoresTotal"));
  });

  test("Teste 3 — Full Service + ajustes contra null: ajustes contra continua pendência (aplicável a todo modelo)", () => {
    const { pendentes } = classificarCamposExtrasMensal(
      CAMPOS_EXTRAS_MENSAL, { ajustesContraLojaTotal: null }, "full_service",
    );
    assert.ok(pendentes.includes("ajustesContraLojaTotal"));
  });

  test("Teste 4 — campo com valor 0 não é 'não informado'", () => {
    const { pendentes } = classificarCamposExtrasMensal(
      CAMPOS_EXTRAS_MENSAL,
      { taxasEntregadoresTotal: 0, ajustesContraLojaTotal: 0, taxasComissoesTotal: 0 },
      "marketplace",
    );
    assert.deepEqual(pendentes.filter((c) => ["taxasEntregadoresTotal", "ajustesContraLojaTotal", "taxasComissoesTotal"].includes(c)), []);
  });

  test("Teste 5 — todos os campos aplicáveis preenchidos: sem pendência", () => {
    const extras = Object.fromEntries(CAMPOS_EXTRAS_MENSAL.map(([c]) => [c, 10]));
    const fs = classificarCamposExtrasMensal(CAMPOS_EXTRAS_MENSAL, extras, "full_service");
    const mp = classificarCamposExtrasMensal(CAMPOS_EXTRAS_MENSAL, extras, "marketplace");
    assert.deepEqual(fs.pendentes, []);
    assert.deepEqual(mp.pendentes, []);
  });

  test("cenário real reportado — Full Service: pendência é só 'ajustes contra a loja'", () => {
    const { pendentes, naoAplicaveis } = classificarCamposExtrasMensal(
      CAMPOS_EXTRAS_MENSAL, EXTRAS_CENARIO_REAL, "full_service",
    );
    assert.deepEqual(pendentes, ["ajustesContraLojaTotal"]);
    assert.deepEqual(naoAplicaveis, ["taxasEntregadoresTotal"]);
  });

  test("mesmo cenário em Marketplace: entregadores volta a ser pendência", () => {
    const { pendentes, naoAplicaveis } = classificarCamposExtrasMensal(
      CAMPOS_EXTRAS_MENSAL, EXTRAS_CENARIO_REAL, "marketplace",
    );
    assert.deepEqual(pendentes, ["taxasEntregadoresTotal", "ajustesContraLojaTotal"]);
    assert.deepEqual(naoAplicaveis, []);
  });

  test("modelo desconhecido/ausente cai no default Full Service (mesma regra de indicadorAplicavel)", () => {
    const { pendentes, naoAplicaveis } = classificarCamposExtrasMensal(
      CAMPOS_EXTRAS_MENSAL, { taxasEntregadoresTotal: null }, undefined,
    );
    assert.ok(!pendentes.includes("taxasEntregadoresTotal"));
    assert.ok(naoAplicaveis.includes("taxasEntregadoresTotal"));
  });

  test("não muta o objeto extras recebido", () => {
    const extras = { taxasEntregadoresTotal: null };
    const copia = { ...extras };
    classificarCamposExtrasMensal(CAMPOS_EXTRAS_MENSAL, extras, "full_service");
    assert.deepEqual(extras, copia);
  });
});

describe("campoExtraMensalAplicavel — só entregadores é condicional ao modelo", () => {
  test("apenas taxasEntregadoresTotal é governado por modelo", () => {
    assert.deepEqual(Object.keys(INDICADOR_DO_CAMPO_EXTRA_MENSAL), ["taxasEntregadoresTotal"]);
    assert.equal(INDICADOR_DO_CAMPO_EXTRA_MENSAL.taxasEntregadoresTotal, "taxas_entregadores");
  });

  test("segue a regra canônica INDICADORES_POR_MODELO (indicadorAplicavel)", () => {
    assert.equal(campoExtraMensalAplicavel("taxasEntregadoresTotal", "full_service"), indicadorAplicavel("full_service", "taxas_entregadores"));
    assert.equal(campoExtraMensalAplicavel("taxasEntregadoresTotal", "marketplace"), indicadorAplicavel("marketplace", "taxas_entregadores"));
    assert.equal(campoExtraMensalAplicavel("taxasEntregadoresTotal", "full_service"), false);
    assert.equal(campoExtraMensalAplicavel("taxasEntregadoresTotal", "marketplace"), true);
  });

  test("campos não-condicionais valem para qualquer modelo", () => {
    for (const campo of ["qtdVendasTotal", "novosClientesTotal", "taxasComissoesTotal", "servicosPromocoesTotal", "ajustesFavorLojaTotal", "ajustesContraLojaTotal"]) {
      assert.equal(campoExtraMensalAplicavel(campo, "full_service"), true, campo);
      assert.equal(campoExtraMensalAplicavel(campo, "marketplace"), true, campo);
    }
  });
});
