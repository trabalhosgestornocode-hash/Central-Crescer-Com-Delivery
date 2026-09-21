// Checkpoint G.0.1 — guarda de auth headroom (src/authHeadroom.js): pura, fail-closed, sem Baileys/rede.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { criarGuardaAuthHeadroom, LIMITE_BYTES_1MIB, MAX_USAGE_PCT_PADRAO } from "../src/authHeadroom.js";

describe("validação de construção", () => {
  test("obterUltimoTamanho é obrigatório", () => {
    assert.throws(() => criarGuardaAuthHeadroom({}), TypeError);
  });
  test("limiteBytes deve ser > 0", () => {
    assert.throws(() => criarGuardaAuthHeadroom({ obterUltimoTamanho: () => null, limiteBytes: 0 }), RangeError);
  });
  for (const pct of [0, 100, -1, 101]) {
    test(`maxUsagePct=${pct} lança (precisa estar entre 0 e 100 exclusivo)`, () => {
      assert.throws(() => criarGuardaAuthHeadroom({ obterUltimoTamanho: () => null, maxUsagePct: pct }), RangeError);
    });
  }
  test("default MAX_USAGE_PCT_PADRAO é 85 e LIMITE_BYTES_1MIB é exatamente 1 MiB", () => {
    assert.equal(MAX_USAGE_PCT_PADRAO, 85);
    assert.equal(LIMITE_BYTES_1MIB, 1024 * 1024);
  });
});

describe("Parte Q — desconhecido/inválido NUNCA é seguro (fail-closed)", () => {
  test("obterUltimoTamanho() devolve null (nunca gravou nesta sessão) ⇒ ok()=false", () => {
    const g = criarGuardaAuthHeadroom({ obterUltimoTamanho: () => null });
    assert.equal(g.ok(), false);
    assert.deepEqual(g.estado().corpoBytesConhecido, false);
  });
  test("obterUltimoTamanho() lança ⇒ ok()=false, nunca propaga a exceção", () => {
    const g = criarGuardaAuthHeadroom({ obterUltimoTamanho: () => { throw new Error("boom"); } });
    assert.doesNotThrow(() => assert.equal(g.ok(), false));
    assert.doesNotThrow(() => g.estado());
  });
  for (const invalido of [NaN, -1, Infinity, "756000", null, undefined, {}]) {
    test(`corpoBytes=${JSON.stringify(invalido)} (inválido) ⇒ ok()=false`, () => {
      const g = criarGuardaAuthHeadroom({ obterUltimoTamanho: () => ({ corpoBytes: invalido }) });
      assert.equal(g.ok(), false);
    });
  }
});

describe("limiar (percentual do limite de 1 MiB)", () => {
  test("abaixo do limiar ⇒ ok(); no limiar exato ou acima ⇒ não-ok", () => {
    const g = criarGuardaAuthHeadroom({ obterUltimoTamanho: () => ({ corpoBytes: 0 }), maxUsagePct: 80 });
    const limiteUso = LIMITE_BYTES_1MIB * 0.8;
    const casos = [
      [0, true], [Math.floor(limiteUso) - 1, true], [Math.floor(limiteUso), true],
      [Math.ceil(limiteUso), false], [limiteUso, false], [LIMITE_BYTES_1MIB, false], [LIMITE_BYTES_1MIB * 2, false],
    ];
    for (const [corpoBytes, esperado] of casos) {
      const gg = criarGuardaAuthHeadroom({ obterUltimoTamanho: () => ({ corpoBytes }), maxUsagePct: 80 });
      assert.equal(gg.ok(), esperado, `corpoBytes=${corpoBytes}`);
    }
    void g; // só para reaproveitar o import acima sem lint de não-uso
  });

  test("dado real conhecido (~756-762 KB, ~72-73% de 1 MiB): com o default de 85%, ok(); com 70%, não-ok", () => {
    for (const corpoBytes of [756_140, 762_020]) {
      assert.equal(criarGuardaAuthHeadroom({ obterUltimoTamanho: () => ({ corpoBytes }) }).ok(), true, "default 85%");
      assert.equal(criarGuardaAuthHeadroom({ obterUltimoTamanho: () => ({ corpoBytes }), maxUsagePct: 70 }).ok(), false, "70% já é ultrapassado pela baseline conhecida");
    }
  });

  test("estado(): usagePct/headroomBytes corretos, nunca o corpo em si", () => {
    const g = criarGuardaAuthHeadroom({ obterUltimoTamanho: () => ({ corpoBytes: 524_288 }) }); // exatos 50%
    const e = g.estado();
    assert.equal(e.usagePct, 50);
    assert.equal(e.headroomBytes, LIMITE_BYTES_1MIB - 524_288);
    assert.equal(e.limiteUsoBytes, Math.round(LIMITE_BYTES_1MIB * 0.85));
    assert.equal(e.maxUsagePct, 85);
    assert.deepEqual(Object.keys(e).sort(), ["corpoBytesConhecido", "headroomBytes", "limiteBytes", "limiteUsoBytes", "maxUsagePct", "usagePct"]);
  });
});

describe("GUARDA ESTRUTURAL: nunca acessa ev/ws/socket/rede; nunca lança", () => {
  test("chamadas repetidas nunca lançam mesmo com fontes hostis", () => {
    const fontes = [() => null, () => undefined, () => ({}), () => ({ corpoBytes: "x" }), () => { throw new Error("x"); }];
    for (const obterUltimoTamanho of fontes) {
      const g = criarGuardaAuthHeadroom({ obterUltimoTamanho });
      assert.doesNotThrow(() => { g.ok(); g.estado(); });
    }
  });
});
