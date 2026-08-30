// Limites de CMV por unidade — cmvConfig.js + utils.js#statusCmv.
//
// Garante:
//   * unidade A (30/35) e unidade B (32/40) classificam o MESMO % diferente;
//   * sem unidade_config → defaults oficiais 32/40;
//   * trocar de contexto (resetarEscopoDeContexto) volta ao default e NÃO
//     reaproveita a config da unidade anterior.
//
// Rodar: node --test frontend/test/cmvConfig.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { limitesCmv, definirLimitesCmv, resetarLimitesCmv } = await import("../src/cmvConfig.js");
const { statusCmv } = await import("../src/utils.js");
const { resetarEscopoDeContexto } = await import("../src/contextoEscopo.js");

describe("cmvConfig — limites por unidade", () => {
  beforeEach(() => resetarLimitesCmv());

  test("default do sistema = 32/40 quando nada foi definido", () => {
    assert.deepEqual(limitesCmv(), { saudavel: 32, atencao: 40 });
    assert.equal(statusCmv(31).chave, "saudavel");
    assert.equal(statusCmv(36).chave, "atencao");
    assert.equal(statusCmv(41).chave, "critico");
  });

  test("config ausente/parcial cai no default, nunca quebra", () => {
    definirLimitesCmv({ persistido: false });
    assert.deepEqual(limitesCmv(), { saudavel: 32, atencao: 40 });
    definirLimitesCmv({ cmvSaudavel: null, cmvAtencao: undefined });
    assert.deepEqual(limitesCmv(), { saudavel: 32, atencao: 40 });
  });

  test("mesmo % → status diferente conforme a unidade", () => {
    // Unidade A: 30/35
    definirLimitesCmv({ cmvSaudavel: 30, cmvAtencao: 35 });
    assert.equal(statusCmv(33).chave, "atencao", "33% é 'atenção' na unidade A (>30)");
    assert.equal(statusCmv(38).chave, "critico", "38% é 'crítico' na unidade A (>35)");

    // Unidade B: 32/40
    definirLimitesCmv({ cmvSaudavel: 32, cmvAtencao: 40 });
    assert.equal(statusCmv(33).chave, "atencao", "33% ainda é 'atenção' na unidade B");
    assert.equal(statusCmv(38).chave, "atencao", "38% é só 'atenção' na unidade B (<40) — DIFERENTE da A");
  });

  test("troca de contexto reseta para o default e não reaproveita a unidade anterior", () => {
    definirLimitesCmv({ cmvSaudavel: 20, cmvAtencao: 25 });
    assert.equal(statusCmv(30).chave, "critico");
    resetarEscopoDeContexto(); // cmvConfig registrou seu reset aqui
    assert.deepEqual(limitesCmv(), { saudavel: 32, atencao: 40 });
    assert.equal(statusCmv(30).chave, "saudavel", "voltou ao default, config da unidade anterior sumiu");
  });

  test("statusCmv aceita limites explícitos sem tocar no estado global", () => {
    definirLimitesCmv({ cmvSaudavel: 32, cmvAtencao: 40 });
    assert.equal(statusCmv(33, { saudavel: 30, atencao: 35 }).chave, "atencao");
    assert.deepEqual(limitesCmv(), { saudavel: 32, atencao: 40 }, "estado global intacto");
  });
});
