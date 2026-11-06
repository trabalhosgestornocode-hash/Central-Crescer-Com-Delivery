// AVISO DE VERSÃO ANTIGA — regra pura de decisão + contrato de integração (boot chama uma vez).
// O ciclo de rede/DOM/timers (fetch de /health, criar o aviso, recarregar) é side-effect demais para valer
// a pena mockar aqui; a regra que decide "esta aba ficou para trás?" é o que precisa estar certo.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ehVersaoNova, INTERVALO_MS, ESPERA_RECARGA_MS } from "../src/versaoApp.js";

const ler = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("ehVersaoNova", () => {
  test("mesma versão → não é nova", () => assert.equal(ehVersaoNova("abc1234", "abc1234"), false));
  test("versão diferente → é nova", () => assert.equal(ehVersaoNova("abc1234", "def5678"), true));
  test("ainda sem referência (1ª resposta desta aba) → nunca 'nova'", () => {
    assert.equal(ehVersaoNova(null, "abc1234"), false);
    assert.equal(ehVersaoNova(undefined, "abc1234"), false);
  });
  test("servidor sem versão informada (local/PR preview) → nunca 'nova'", () => {
    assert.equal(ehVersaoNova("abc1234", null), false);
    assert.equal(ehVersaoNova("abc1234", ""), false);
    assert.equal(ehVersaoNova("abc1234", undefined), false);
  });
});

test("intervalo de verificação e espera de recarga têm os valores documentados", () => {
  assert.equal(INTERVALO_MS, 5 * 60_000);
  assert.equal(ESPERA_RECARGA_MS, 5_000);
});

describe("integração: boot liga a verificação uma vez", () => {
  test("app.js importa e chama iniciarVerificacaoVersao() no boot", () => {
    const src = ler("../src/app.js");
    assert.match(src, /import \{ iniciarVerificacaoVersao \} from "\.\/versaoApp\.js";/);
    assert.match(src, /async function boot\(\) \{[\s\S]*iniciarVerificacaoVersao\(\);[\s\S]*^\}/m);
  });
});

describe("integração: /health do backend expõe a versão publicada", () => {
  test("versaoPublicada() entra no corpo de /health", () => {
    const src = ler("../../backend/src/app.js");
    assert.match(src, /const versaoPublicada = \(\)/);
    assert.match(src, /app\.get\("\/health",[\s\S]*\.\.\.versaoPublicada\(\)/);
  });
});
