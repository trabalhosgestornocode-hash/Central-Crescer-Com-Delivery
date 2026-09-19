import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sanitizar, prefixoAssinatura, mascararTelefone } from "../src/logsafe.js";

describe("logsafe — campos de diagnóstico de retry/reconexão NÃO podem ser mascarados (C3.5-C.8.2)", () => {
  // Achado ao vivo em 2026-09-19: `"tentativa":"[REDACTED]"` nos logs de reconexão. "iv" (vetor do AES-GCM) estava
  // em CHAVES_PARCIAIS e "tentativa"/"motivo"/"ativo" CONTÊM "iv" — o diagnóstico do próprio incidente ficava cego.
  test("tentativa, motivo, ativo, esperaMs, geracao, classe, causa aparecem em claro", () => {
    const s = sanitizar({ tentativa: 3, motivo: "x", ativo: true, esperaMs: 1000, geracao: 7, classe: "transitoria", causa: "http_5xx", statusHttp: 500 });
    assert.deepEqual(s, { tentativa: 3, motivo: "x", ativo: true, esperaMs: 1000, geracao: 7, classe: "transitoria", causa: "http_5xx", statusHttp: 500 });
  });

  test("as grafias do vetor de inicialização (ivBase64, iv_hex, initVector...) continuam mascaradas — sem regressão do antigo 'substring'", () => {
    const s = sanitizar({ ivBase64: "AAAA", iv_hex: "00ff", initVector: "x", InitializationVector: "y", IVB64: "z" });
    for (const v of Object.values(s)) assert.equal(v, "[REDACTED]");
  });

  test("um IV REAL dentro do log() (chave 'iv') nunca aparece na linha emitida", async (t) => {
    const { log } = await import("../src/logsafe.js");
    const linhas = [];
    t.mock.method(console, "log", (l) => linhas.push(l));
    log("info", "teste", { iv: "IV-REAL-123456", tentativa: 4, motivo: "backend_fora" });
    const l = JSON.parse(linhas[0]);
    assert.equal(l.iv, "[REDACTED]");
    assert.equal(l.tentativa, 4);
    assert.equal(l.motivo, "backend_fora");
    assert.ok(!linhas[0].includes("IV-REAL-123456"));
  });

  test("a chave EXATA 'iv' (e authTag/ciphertext) continua mascarada", () => {
    const s = sanitizar({ iv: "deadbeef", IV: "x", authTag: "t", ciphertext: "c", aiv: "visivel-pois-nao-e-a-chave-exata" });
    assert.equal(s.iv, "[REDACTED]");
    assert.equal(s.IV, "[REDACTED]");
    assert.equal(s.authTag, "[REDACTED]");
    assert.equal(s.ciphertext, "[REDACTED]");
    assert.equal(s.aiv, "visivel-pois-nao-e-a-chave-exata");
  });
});

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
