// Testes do logger no-op passado explicitamente a makeWASocket() —
// Checkpoint C3 (achado: o Baileys tem logger interno próprio que escreve
// direto no stdout, fora do nosso logsafe.js).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { criarLoggerBaileysSilencioso } from "../src/logger-baileys-silencioso.js";

describe("logger-baileys-silencioso — contrato ILogger exigido pelo Baileys", () => {
  test("implementa exatamente o contrato (level: string; child(obj); trace/debug/info/warn/error(obj, msg?))", () => {
    const logger = criarLoggerBaileysSilencioso();
    assert.equal(typeof logger.level, "string");
    assert.equal(typeof logger.child, "function");
    for (const nivel of ["trace", "debug", "info", "warn", "error", "fatal"]) {
      assert.equal(typeof logger[nivel], "function", `esperava ${nivel} como função`);
    }
  });

  test("nenhum método lança, mesmo com argumentos variados (obj só, obj+msg, undefined, sem argumento nenhum)", () => {
    const logger = criarLoggerBaileysSilencioso();
    for (const nivel of ["trace", "debug", "info", "warn", "error", "fatal"]) {
      assert.doesNotThrow(() => logger[nivel]({ algo: 1 }, "mensagem"));
      assert.doesNotThrow(() => logger[nivel]({ algo: 1 }));
      assert.doesNotThrow(() => logger[nivel]());
      assert.doesNotThrow(() => logger[nivel](undefined, undefined));
    }
  });

  test("child(obj) devolve outro logger com o MESMO contrato — encadeável indefinidamente (Baileys faz logger.child({class:'baileys'}).child({...}) internamente)", () => {
    const logger = criarLoggerBaileysSilencioso();
    let atual = logger;
    for (let i = 0; i < 5; i++) {
      atual = atual.child({ nivel: i });
      assert.equal(typeof atual.child, "function");
      assert.equal(typeof atual.info, "function");
      assert.equal(typeof atual.level, "string");
    }
  });

  test("nenhum nível (nem child) imprime nada no console, mesmo recebendo payloads com a FORMA de segredos reais do Baileys", (t) => {
    const logger = criarLoggerBaileysSilencioso();
    const chamadasConsole = [];
    for (const metodo of ["log", "error", "warn", "info", "debug"]) {
      t.mock.method(console, metodo, () => chamadasConsole.push(metodo));
    }

    const payloadsSensiveis = [
      { creds: { noiseKey: { private: "AAAAaaaaAAAAaaaaAAAAaaaa==" }, signedIdentityKey: { private: "BBBBbbbbBBBBbbbbBBBBbbbb==" } } },
      { signedPreKey: { keyId: 1, keyPair: { private: "CCCCccccCCCCccccCCCCcccc==" } } },
      { devicePairingData: { eIdent: "xxxxXXXXxxxxXXXX==", eSkeyVal: "yyyyYYYYyyyyYYYY==", eSkeySig: "zzzzZZZZzzzzZZZZ==" } },
      { qr: "2@2b3c4d5e6f7g8h9i0j==,fakequerealparecido==" },
      { telefone: "+5511999990000" },
      { conteudo: "mensagem em texto claro que nao pode vazar" },
    ];

    for (const payload of payloadsSensiveis) {
      for (const nivel of ["trace", "debug", "info", "warn", "error", "fatal"]) {
        logger[nivel](payload, "mensagem qualquer");
      }
      logger.child({ class: "baileys" }).info(payload);
    }

    assert.equal(chamadasConsole.length, 0, "o logger silencioso nunca deveria chamar nenhum método do console, para nenhum payload");
  });
});
