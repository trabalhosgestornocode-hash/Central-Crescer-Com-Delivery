// FakeProvider — em memória, sem banco/rede. Prova o contrato
// WhatsAppProvider e a idempotência do LADO DO PROVIDER (defesa extra além
// da UNIQUE de comunicacao_mensagens.idempotency_key).
// Rodar: node --test test/comunicacao-fake-provider.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { criarFakeProvider } from "../src/modules/comunicacao/providers/fake.provider.js";
import { validarProvider } from "../src/modules/comunicacao/whatsapp.provider.js";

describe("providers/fake.provider — contrato e comportamento", () => {
  test("implementa a forma completa de WhatsAppProvider", () => {
    assert.doesNotThrow(() => validarProvider(criarFakeProvider()));
  });

  test("getStatus reflete conectado por padrão", async () => {
    const p = criarFakeProvider();
    const s = await p.getStatus();
    assert.equal(s.conectado, true);
    assert.equal(s.provider, "fake");
  });

  test("sendText com a MESMA idempotencyKey não gera um segundo envio", async () => {
    const p = criarFakeProvider();
    const a = await p.sendText({ telefoneE164: "+5511999990000", texto: "oi", idempotencyKey: "k1" });
    const b = await p.sendText({ telefoneE164: "+5511999990000", texto: "oi de novo", idempotencyKey: "k1" });
    assert.equal(a.providerMessageId, b.providerMessageId);
    assert.equal(p.mensagensEnviadas.length, 1);
  });

  test("teste 13 — provider offline recusa ANTES de qualquer efeito (preEnvio: true — job fica recuperável)", async () => {
    const p = criarFakeProvider({ conectado: false });
    await assert.rejects(
      () => p.sendText({ telefoneE164: "+5511999990000", texto: "oi", idempotencyKey: "k2" }),
      (e) => /PROVIDER_OFFLINE/.test(e.message) && e.preEnvio === true,
    );
    assert.equal(p.mensagensEnviadas.length, 0); // nada foi "enviado" de verdade
  });

  test("teste 14 — falha injetada com preEnvio:true é comprovadamente anterior ao efeito externo (retryável)", async () => {
    const p = criarFakeProvider();
    p.falharProximoEnvio({ mensagem: "timeout antes de contatar o WhatsApp", preEnvio: true });
    await assert.rejects(
      () => p.sendText({ telefoneE164: "+5511999990000", texto: "oi", idempotencyKey: "k3" }),
      (e) => e.preEnvio === true && !e.permanente,
    );
    // a falha é consumida — a PRÓXIMA chamada com outra chave funciona normalmente.
    const r = await p.sendText({ telefoneE164: "+5511999990000", texto: "oi", idempotencyKey: "k4" });
    assert.ok(r.providerMessageId);
  });

  test("teste G — falha injetada SEM nenhuma marcação é ambígua (nem preEnvio, nem permanente) — o fake não decide sozinho, quem classifica é comunicacao.entrega.js", async () => {
    const p = criarFakeProvider();
    p.falharProximoEnvio({ mensagem: "conexão caiu no meio do envio" });
    await assert.rejects(
      () => p.sendText({ telefoneE164: "+5511999990000", texto: "oi", idempotencyKey: "k3b" }),
      (e) => e.preEnvio === false && !e.permanente,
    );
  });

  test("teste 15 — falha injetada permanente carrega o sinal `permanente`", async () => {
    const p = criarFakeProvider();
    p.falharProximoEnvio({ mensagem: "número inválido", permanente: true });
    await assert.rejects(
      () => p.sendText({ telefoneE164: "+5511999990000", texto: "oi", idempotencyKey: "k5" }),
      (e) => e.permanente === true,
    );
  });

  test("onMessage registra handler e simularRecebimento dispara todos", () => {
    const p = criarFakeProvider();
    const recebidas = [];
    p.onMessage((m) => recebidas.push(m));
    p.simularRecebimento({ texto: "cheguei" });
    assert.equal(recebidas.length, 1);
    assert.equal(recebidas[0].texto, "cheguei");
  });
});
