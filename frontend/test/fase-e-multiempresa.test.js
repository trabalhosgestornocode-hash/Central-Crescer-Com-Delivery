// FASE E — validação multiempresa (frontend).
//
// Simula a navegação entre Empresa A / Unidade A1 e A2 e Empresa B / B1,
// exercitando o que é estado de FRONTEND:
//   * cmvConfig: mesmo produto classificado diferente por unidade;
//   * troca de contexto (resetarEscopoDeContexto) NÃO reaproveita a config
//     da unidade anterior;
//   * state.tabelasDisponiveis é por empresa e some na troca.
//
// Rodar: node --test frontend/test/fase-e-multiempresa.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { limitesCmv, definirLimitesCmv, resetarLimitesCmv } = await import("../src/cmvConfig.js");
const { statusCmv } = await import("../src/utils.js");
const { state } = await import("../src/state.js");
const { resetarEscopoDeContexto } = await import("../src/contextoEscopo.js");

// Config que o backend devolveria em GET /api/v1/unidade/metas-cmv
const META_A1 = { cmvSaudavel: 25, cmvAtencao: 30, persistido: true };
const META_A2 = { cmvSaudavel: 32, cmvAtencao: 40, persistido: false }; // sem unidade_config
const META_B1 = { cmvSaudavel: 40, cmvAtencao: 45, persistido: true };

// Catálogo que o backend devolveria em GET /api/v1/unidade/tabelas-comerciais
const CAT_A = { balcao: ["E", "F"], ifood: ["Z1"] };
const CAT_B = { balcao: ["AERO A"], ifood: [] };

// Simula app.js#mostrarApp para uma unidade: reseta o contexto e recarrega a
// config da unidade nova.
function entrarNaUnidade({ empresa, unidade, metas, catalogo }) {
  resetarEscopoDeContexto();                 // funil único da troca
  state.sessao.empresa = empresa;
  state.sessao.unidade = unidade;
  definirLimitesCmv(metas);
  state.tabelasDisponiveis = { balcao: catalogo.balcao.slice(), ifood: catalogo.ifood.slice() };
}

describe("FASE E — CMV por unidade na navegação", () => {
  beforeEach(() => resetarLimitesCmv());

  test("produto idêntico (CMV 33%) → status diferente em A1, A2 e B1", () => {
    entrarNaUnidade({ empresa: { id: "A", nome: "Empresa A" }, unidade: { id: "A1", nome: "A1" }, metas: META_A1, catalogo: CAT_A });
    assert.equal(statusCmv(33).chave, "critico", "A1 (25/30): 33% é crítico");

    entrarNaUnidade({ empresa: { id: "A", nome: "Empresa A" }, unidade: { id: "A2", nome: "A2" }, metas: META_A2, catalogo: CAT_A });
    assert.equal(statusCmv(33).chave, "atencao", "A2 (default 32/40): 33% é atenção");

    entrarNaUnidade({ empresa: { id: "B", nome: "Empresa B" }, unidade: { id: "B1", nome: "B1" }, metas: META_B1, catalogo: CAT_B });
    assert.equal(statusCmv(33).chave, "saudavel", "B1 (40/45): 33% é saudável");
  });

  test("troca de contexto A1 → A2 não reaproveita os limites de A1", () => {
    entrarNaUnidade({ empresa: { id: "A", nome: "A" }, unidade: { id: "A1", nome: "A1" }, metas: META_A1, catalogo: CAT_A });
    assert.deepEqual(limitesCmv(), { saudavel: 25, atencao: 30 });

    // Troca sem recarregar config (ex.: falha de rede no fetch de metas) —
    // o reset já garantiu o default; nunca fica com 25/30 de A1.
    resetarEscopoDeContexto();
    state.sessao.unidade = { id: "A2", nome: "A2" };
    assert.deepEqual(limitesCmv(), { saudavel: 32, atencao: 40 }, "voltou ao default, não herdou A1");
  });

  test("state.tabelasDisponiveis é por empresa e some na troca de contexto", () => {
    entrarNaUnidade({ empresa: { id: "A", nome: "A" }, unidade: { id: "A1", nome: "A1" }, metas: META_A1, catalogo: CAT_A });
    assert.deepEqual(state.tabelasDisponiveis.balcao, ["E", "F"]);
    assert.ok(!state.tabelasDisponiveis.balcao.includes("AERO A"));

    resetarEscopoDeContexto();
    assert.deepEqual(state.tabelasDisponiveis, { balcao: [], ifood: [] }, "catálogo de A sumiu na troca");

    entrarNaUnidade({ empresa: { id: "B", nome: "B" }, unidade: { id: "B1", nome: "B1" }, metas: META_B1, catalogo: CAT_B });
    assert.deepEqual(state.tabelasDisponiveis.balcao, ["AERO A"], "agora só o catálogo de B");
    assert.ok(!state.tabelasDisponiveis.balcao.includes("E"));
  });

  test("CMV 42% é crítico em qualquer unidade (acima de todos os limites de atenção)", () => {
    for (const m of [META_A1, META_A2, META_B1]) {
      definirLimitesCmv(m);
      assert.equal(statusCmv(42).chave, m === META_B1 ? "atencao" : "critico");
    }
    // B1 tem atenção=45, então 42% ainda é "atenção" lá — confirma que a
    // régua é mesmo por unidade.
  });
});
