// classificarErroEnvio — 100% função pura, sem banco. É a peça central da
// distinção "idempotência de job lógico" × "exactly-once de entrega física"
// (Checkpoint B.1): decide se um erro de envio pode ter retry automático.
// Rodar: node --test test/comunicacao-entrega.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classificarErroEnvio, permiteRetryAutomatico } from "../src/modules/comunicacao/comunicacao.entrega.js";
import { CLASSIFICACAO_ERRO } from "../src/modules/comunicacao/comunicacao.constants.js";

describe("comunicacao.entrega — classificarErroEnvio", () => {
  test("teste H — erro marcado preEnvio (comprovadamente antes do efeito externo) é RETRYAVEL", () => {
    const erro = Object.assign(new Error("timeout de conexão"), { preEnvio: true });
    assert.equal(classificarErroEnvio(erro), CLASSIFICACAO_ERRO.RETRYAVEL);
    assert.equal(permiteRetryAutomatico(classificarErroEnvio(erro)), true);
  });

  test("preEnvio + permanente -> PERMANENTE (nunca retry, mesmo sabendo que não saiu)", () => {
    const erro = Object.assign(new Error("formato de número inválido"), { preEnvio: true, permanente: true });
    assert.equal(classificarErroEnvio(erro), CLASSIFICACAO_ERRO.PERMANENTE);
    assert.equal(permiteRetryAutomatico(classificarErroEnvio(erro)), false);
  });

  test("permanente sem preEnvio (resposta definitiva e CONHECIDA do provider) -> PERMANENTE", () => {
    const erro = Object.assign(new Error("número não existe no WhatsApp"), { permanente: true });
    assert.equal(classificarErroEnvio(erro), CLASSIFICACAO_ERRO.PERMANENTE);
  });

  test("teste G — erro SEM nenhuma marcação (ambíguo/timeout no meio da chamada) -> INCERTO, nunca retry automático", () => {
    const erro = new Error("conexão caiu durante o envio");
    assert.equal(classificarErroEnvio(erro), CLASSIFICACAO_ERRO.INCERTO);
    assert.equal(permiteRetryAutomatico(classificarErroEnvio(erro)), false);
  });

  test("erro sem propriedades (nem Error de verdade) ainda cai em INCERTO, nunca lança", () => {
    assert.equal(classificarErroEnvio({}), CLASSIFICACAO_ERRO.INCERTO);
    assert.equal(classificarErroEnvio(undefined), CLASSIFICACAO_ERRO.INCERTO);
  });
});
