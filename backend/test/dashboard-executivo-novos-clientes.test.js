import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  novosClientesAcumulados,
  distribuirQuantidadeMensal,
} from "../src/modules/dashboard-executivo/dashboardExecutivo.calc.js";

// Agosto tem 31 dias — o mês do cenário real relatado (Agosto/2026).
const diasAgosto = Array.from({ length: 31 }, (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`);

/** Linhas de "Lançamento Mensal": uma fatia por dia, origem distribuicao_mensal. */
function fatiasMensais(dias, totalNovosClientes) {
  const fatias = totalNovosClientes == null ? null : distribuirQuantidadeMensal(totalNovosClientes, dias.length);
  return dias.map((data, i) => ({
    data_lancamento: data,
    origem_lancamento: "distribuicao_mensal",
    distribuicao_mensal_id: "lote-1",
    novos_clientes: fatias ? fatias[i] : null,
  }));
}

describe("Dashboard Executivo — novos clientes na Visão Geral", () => {
  const dias = ["2026-08-01", "2026-08-02", "2026-08-03"];

  // ---- Cenário A: lançamentos diários (comportamento que já funcionava) ----
  test("Teste 1 — lançamentos diários: usa o último acumulado do período", () => {
    const linhas = [
      { data_lancamento: dias[0], novos_clientes: 4 },
      { data_lancamento: dias[2], novos_clientes: 9 },
    ];
    assert.equal(novosClientesAcumulados(dias, linhas), 9);
  });

  test("Teste 1 — lançamentos diários: zero informado é preservado; sem linha é ausência", () => {
    assert.equal(novosClientesAcumulados(dias, [{ data_lancamento: dias[0], novos_clientes: 0 }]), 0);
    assert.equal(novosClientesAcumulados(dias, []), null);
  });

  // ---- Cenário B: lançamento mensal (o bug corrigido) ----
  test("Teste 2 — lançamento mensal com novos_clientes = 856: Visão Geral retorna 856", () => {
    const linhas = fatiasMensais(diasAgosto, 856);
    assert.equal(novosClientesAcumulados(diasAgosto, linhas), 856);
  });

  test("Teste 3 — lançamento mensal com novos_clientes = 0: retorna 0, não ausência", () => {
    const linhas = fatiasMensais(diasAgosto, 0);
    assert.equal(novosClientesAcumulados(diasAgosto, linhas), 0);
  });

  test("Teste 4 — lançamento mensal sem novos clientes informados: retorna null", () => {
    const linhas = fatiasMensais(diasAgosto, null);
    assert.equal(novosClientesAcumulados(diasAgosto, linhas), null);
  });

  // ---- Não duplicar dados da distribuição mensal ----
  test("Teste 5 — fatias do monthly_distribution somam o total oficial, nunca 856 × dias", () => {
    const linhas = fatiasMensais(diasAgosto, 856);
    const resultado = novosClientesAcumulados(diasAgosto, linhas);
    assert.equal(resultado, 856);
    assert.notEqual(resultado, 856 * diasAgosto.length);
    // A soma bruta das fatias também é exatamente o total (garante que a
    // distribuição não perde nem inventa cliente).
    const somaBruta = linhas.reduce((s, r) => s + Number(r.novos_clientes), 0);
    assert.equal(somaBruta, 856);
  });

  // ---- Precedência: diário real vence a distribuição estimada ----
  test("precedência — havendo lançamento diário real, ignora as fatias distribuídas", () => {
    const linhas = [
      ...fatiasMensais(diasAgosto, 856),
      { data_lancamento: "2026-08-20", origem_lancamento: null, novos_clientes: 40 },
    ];
    assert.equal(novosClientesAcumulados(diasAgosto, linhas), 40);
  });

  // ---- Isolamento por unidade (mesma semântica agregada de antes) ----
  test("Teste 6 — agregado mantém a semântica por unidade e não deduplica clientes", () => {
    const unidadeA = [{ data_lancamento: dias[2], novos_clientes: 7 }];
    const unidadeB = fatiasMensais(diasAgosto, 5);
    const valores = [unidadeA, unidadeB].map((linhas) => novosClientesAcumulados(diasAgosto, linhas));
    assert.deepEqual(valores, [7, 5]);
    assert.equal(valores.reduce((soma, valor) => soma + valor, 0), 12);
  });
});
