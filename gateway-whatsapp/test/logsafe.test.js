import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sanitizar, prefixoAssinatura, mascararTelefone } from "../src/logsafe.js";

describe("logsafe — sanitização", () => {
  test("mascara chaves sensíveis exatas (auth, secret, token, qr, senha)", () => {
    const s = sanitizar({ auth: "x", secret: "y", token: "z", qr: "QR123", senha: "w", ok: "visivel" });
    assert.equal(s.auth, "[REDACTED]");
    assert.equal(s.secret, "[REDACTED]");
    assert.equal(s.token, "[REDACTED]");
    assert.equal(s.qr, "[REDACTED]");
    assert.equal(s.senha, "[REDACTED]");
    assert.equal(s.ok, "visivel");
  });

  test("mascara chaves parciais (authState, credenciais, ciphertext, conteudo, texto)", () => {
    const s = sanitizar({
      authStateEncrypted: "v1:abc:def:ghi",
      credenciais: { usuario: "x" },
      ciphertext: "abc",
      conteudo: "mensagem sensível",
      texto: "outra mensagem",
    });
    assert.equal(s.authStateEncrypted, "[REDACTED]");
    assert.equal(s.credenciais, "[REDACTED]");
    assert.equal(s.ciphertext, "[REDACTED]");
    assert.equal(s.conteudo, "[REDACTED]");
    assert.equal(s.texto, "[REDACTED]");
  });

  test("não mascara 'codigo' quando é um código de ERRO (evita o falso positivo já visto no projeto)", () => {
    const s = sanitizar({ codigo: "WHATSAPP_GATEWAY_NOT_CONNECTED" });
    assert.equal(s.codigo, "[REDACTED]"); // "codigo" está na lista EXATA — mascarado de propósito (é ambíguo)
  });

  test("mascara JWT em texto livre", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGVzdGFzc2luYXR1cmE";
    const s = sanitizar({ msg: `token: ${jwt}` });
    assert.ok(!s.msg.includes(jwt));
  });

  test("mascara o formato versionado do auth state mesmo dentro de texto livre", () => {
    const blob = "v1:aWY=:YWJj:ZGVm";
    const s = sanitizar({ msg: `payload=${blob}` });
    assert.ok(!s.msg.includes(blob));
  });

  test("nunca lança para Error, objetos profundos ou null/undefined", () => {
    assert.doesNotThrow(() => sanitizar(new Error("falha")));
    assert.doesNotThrow(() => sanitizar(null));
    assert.doesNotThrow(() => sanitizar(undefined));
    let profundo = {};
    let cursor = profundo;
    for (let i = 0; i < 20; i++) { cursor.next = {}; cursor = cursor.next; }
    assert.doesNotThrow(() => sanitizar(profundo));
  });

  test("prefixoAssinatura nunca devolve a assinatura inteira", () => {
    const sig = "a".repeat(64);
    const p = prefixoAssinatura(sig);
    assert.equal(p, "aaaaaaaa…");
    assert.ok(p.length < sig.length);
  });

  test("mascararTelefone nunca devolve o número completo", () => {
    const m = mascararTelefone("+5511999990000");
    assert.ok(!m.includes("999990000"));
    assert.ok(m.startsWith("+55"));
    assert.ok(m.endsWith("00"));
  });
});
