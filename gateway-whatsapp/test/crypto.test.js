import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encriptar, decriptar, normalizarChave, VERSAO_FORMATO } from "../src/crypto.js";

const CHAVE = randomBytes(32);
const CHAVE_ENV_B64 = CHAVE.toString("base64");

describe("crypto — AES-256-GCM do auth state", () => {
  test("round-trip: encriptar então decriptar devolve o plaintext original", () => {
    const original = JSON.stringify({ creds: { x: 1 }, keys: { "pre-key": { 1: "abc" } } });
    const cifrado = encriptar(original, CHAVE);
    const decifrado = decriptar(cifrado, CHAVE);
    assert.equal(decifrado, original);
  });

  test("formato tem o prefixo de versão esperado", () => {
    const cifrado = encriptar("x", CHAVE);
    assert.ok(cifrado.startsWith(`${VERSAO_FORMATO}:`));
    assert.equal(cifrado.split(":").length, 4);
  });

  test("dois IVs de chamadas diferentes nunca são iguais", () => {
    const c1 = encriptar("mesmo texto", CHAVE);
    const c2 = encriptar("mesmo texto", CHAVE);
    const iv1 = c1.split(":")[1];
    const iv2 = c2.split(":")[1];
    assert.notEqual(iv1, iv2);
    assert.notEqual(c1, c2); // ciphertext também difere por causa do IV
  });

  test("rejeita auth tag alterada", () => {
    const cifrado = encriptar("segredo", CHAVE);
    const [v, iv, tag, ct] = cifrado.split(":");
    const tagAdulterada = Buffer.from(tag, "base64");
    tagAdulterada[0] ^= 0xff;
    const adulterado = [v, iv, tagAdulterada.toString("base64"), ct].join(":");
    assert.throws(() => decriptar(adulterado, CHAVE));
  });

  test("rejeita ciphertext alterado", () => {
    const cifrado = encriptar("segredo", CHAVE);
    const [v, iv, tag, ct] = cifrado.split(":");
    const ctBuf = Buffer.from(ct, "base64");
    ctBuf[0] ^= 0xff;
    const adulterado = [v, iv, tag, ctBuf.toString("base64")].join(":");
    assert.throws(() => decriptar(adulterado, CHAVE));
  });

  test("rejeita chave errada", () => {
    const cifrado = encriptar("segredo", CHAVE);
    const outraChave = randomBytes(32);
    assert.throws(() => decriptar(cifrado, outraChave));
  });

  test("rejeita versão de formato desconhecida", () => {
    const cifrado = encriptar("segredo", CHAVE);
    const partes = cifrado.split(":");
    partes[0] = "v99";
    assert.throws(() => decriptar(partes.join(":"), CHAVE), /Versão de auth state desconhecida/);
  });

  test("rejeita formato malformado (segmentos faltando)", () => {
    assert.throws(() => decriptar("v1:so-duas:partes", CHAVE));
  });

  test("normalizarChave aceita base64 de 32 bytes", () => {
    const chave = normalizarChave(CHAVE_ENV_B64);
    assert.equal(chave.length, 32);
  });

  test("normalizarChave aceita hex de 32 bytes", () => {
    const chave = normalizarChave(CHAVE.toString("hex"));
    assert.equal(chave.length, 32);
  });

  test("normalizarChave rejeita chave de tamanho errado", () => {
    assert.throws(() => normalizarChave(Buffer.alloc(16).toString("base64")));
  });

  test("normalizarChave rejeita ausência de chave", () => {
    assert.throws(() => normalizarChave(undefined));
  });
});
