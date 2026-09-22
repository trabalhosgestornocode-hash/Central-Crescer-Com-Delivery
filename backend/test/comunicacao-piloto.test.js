// Checkpoint H.4-A — allowlist do piloto (comunicacao.piloto.js). Testa a
// função pura (env injetado) — sem rede, sem banco. Cobre exatamente os
// itens A-F do checkpoint (item 26).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pilotoHabilitado, lerAllowlistPiloto, telefoneAutorizadoNoPiloto } from "../src/modules/comunicacao/comunicacao.piloto.js";

const TEL_PILOTO = "+5586988846788";
const TEL_OUTRO = "+5511999998888";

describe("Checkpoint H.4-A — pilotoHabilitado()", () => {
  test("só a string exata 'true' habilita (mesmo padrão de COMUNICACAO_WORKER_ENABLED)", () => {
    assert.equal(pilotoHabilitado({ COMUNICACAO_PILOTO_ENABLED: "true" }), true);
    for (const v of [undefined, "", "false", "TRUE", "1", "yes"]) {
      assert.equal(pilotoHabilitado({ COMUNICACAO_PILOTO_ENABLED: v }), false, `"${v}" deveria ser false`);
    }
  });
});

describe("Checkpoint H.4-A — lerAllowlistPiloto()", () => {
  test("ausente/vazia -> lista vazia", () => {
    assert.deepEqual(lerAllowlistPiloto({}), []);
    assert.deepEqual(lerAllowlistPiloto({ COMUNICACAO_PILOTO_TELEFONES_E164: "" }), []);
    assert.deepEqual(lerAllowlistPiloto({ COMUNICACAO_PILOTO_TELEFONES_E164: "   " }), []);
  });
  test("um telefone válido -> lista com 1 item", () => {
    assert.deepEqual(lerAllowlistPiloto({ COMUNICACAO_PILOTO_TELEFONES_E164: TEL_PILOTO }), [TEL_PILOTO]);
  });
  test("vários telefones separados por vírgula (com espaços) -> todos normalizados", () => {
    assert.deepEqual(
      lerAllowlistPiloto({ COMUNICACAO_PILOTO_TELEFONES_E164: ` ${TEL_PILOTO} , ${TEL_OUTRO} ` }),
      [TEL_PILOTO, TEL_OUTRO],
    );
  });
  test("E. formato inválido -> a lista INTEIRA vira vazia (fail-closed, nunca aceita parcialmente)", () => {
    const original = console.error;
    console.error = () => {}; // esperado logar um aviso; silenciado só neste teste
    try {
      assert.deepEqual(lerAllowlistPiloto({ COMUNICACAO_PILOTO_TELEFONES_E164: `${TEL_PILOTO},numero-invalido` }), []);
      assert.deepEqual(lerAllowlistPiloto({ COMUNICACAO_PILOTO_TELEFONES_E164: "11999998888" }), []); // sem "+"
      assert.deepEqual(lerAllowlistPiloto({ COMUNICACAO_PILOTO_TELEFONES_E164: "+0123" }), []); // DDI não pode começar com 0
    } finally {
      console.error = original;
    }
  });
  test("o aviso de formato inválido nunca inclui o valor bruto completo", () => {
    const linhas = [];
    const original = console.error;
    console.error = (msg) => linhas.push(String(msg));
    try {
      lerAllowlistPiloto({ COMUNICACAO_PILOTO_TELEFONES_E164: "+5586988846788,xxx-invalido-yyy" });
    } finally {
      console.error = original;
    }
    assert.ok(linhas.length > 0);
    assert.ok(!linhas.some((l) => l.includes("xxx-invalido-yyy")), "o log não pode ecoar o valor bruto malformado");
  });
});

describe("Checkpoint H.4-A — telefoneAutorizadoNoPiloto() (itens 26 A-F)", () => {
  test("piloto desligado (ausente) -> SEMPRE true (gate não aplicável fora da janela do piloto)", () => {
    assert.equal(telefoneAutorizadoNoPiloto(TEL_PILOTO, {}), true);
    assert.equal(telefoneAutorizadoNoPiloto(TEL_OUTRO, {}), true);
    assert.equal(telefoneAutorizadoNoPiloto(null, {}), true);
  });

  test("A. telefone piloto autorizado -> passa (true)", () => {
    const env = { COMUNICACAO_PILOTO_ENABLED: "true", COMUNICACAO_PILOTO_TELEFONES_E164: TEL_PILOTO };
    assert.equal(telefoneAutorizadoNoPiloto(TEL_PILOTO, env), true);
  });

  test("B. telefone diferente -> BLOCKED (false)", () => {
    const env = { COMUNICACAO_PILOTO_ENABLED: "true", COMUNICACAO_PILOTO_TELEFONES_E164: TEL_PILOTO };
    assert.equal(telefoneAutorizadoNoPiloto(TEL_OUTRO, env), false);
  });

  test("C. allowlist ausente (piloto ligado) -> ninguém passa", () => {
    const env = { COMUNICACAO_PILOTO_ENABLED: "true" };
    assert.equal(telefoneAutorizadoNoPiloto(TEL_PILOTO, env), false);
  });

  test("D. allowlist vazia (piloto ligado) -> ninguém passa", () => {
    const env = { COMUNICACAO_PILOTO_ENABLED: "true", COMUNICACAO_PILOTO_TELEFONES_E164: "" };
    assert.equal(telefoneAutorizadoNoPiloto(TEL_PILOTO, env), false);
  });

  test("E. formato inválido na allowlist -> fail-closed, ninguém passa (nem o telefone que seria válido)", () => {
    const original = console.error;
    console.error = () => {};
    try {
      const env = { COMUNICACAO_PILOTO_ENABLED: "true", COMUNICACAO_PILOTO_TELEFONES_E164: `${TEL_PILOTO},invalido` };
      assert.equal(telefoneAutorizadoNoPiloto(TEL_PILOTO, env), false);
    } finally {
      console.error = original;
    }
  });

  test("F. duas 'organizações' (dois telefones), só um permitido -> o segundo continua bloqueado", () => {
    const env = { COMUNICACAO_PILOTO_ENABLED: "true", COMUNICACAO_PILOTO_TELEFONES_E164: TEL_PILOTO };
    assert.equal(telefoneAutorizadoNoPiloto(TEL_PILOTO, env), true, "org do piloto passa");
    assert.equal(telefoneAutorizadoNoPiloto(TEL_OUTRO, env), false, "outra org continua bloqueada");
  });

  test("telefone ausente/nulo -> sempre false quando o piloto está ligado", () => {
    const env = { COMUNICACAO_PILOTO_ENABLED: "true", COMUNICACAO_PILOTO_TELEFONES_E164: TEL_PILOTO };
    assert.equal(telefoneAutorizadoNoPiloto(null, env), false);
    assert.equal(telefoneAutorizadoNoPiloto(undefined, env), false);
    assert.equal(telefoneAutorizadoNoPiloto("", env), false);
  });
});
