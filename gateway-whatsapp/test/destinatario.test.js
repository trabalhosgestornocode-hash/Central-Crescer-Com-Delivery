// H.4-B.4 — pré-validação do destinatário (onWhatsApp): JID canônico do PRÓPRIO WhatsApp, fail-closed. Sem rede, sem envio.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolverJidCanonico, TIMEOUT_CONSULTA_DESTINATARIO_MS } from "../src/destinatario.js";
import { CODIGOS } from "../src/errors.js";

const socketCom = (onWhatsApp) => ({ onWhatsApp });
const bloqueia = async (socket, codigo, telefoneE164 = "+5511987654321", extra = {}) => {
  await assert.rejects(resolverJidCanonico({ socket, telefoneE164, ...extra }), (e) => {
    assert.equal(e.codigo, codigo);
    assert.equal(e.preEnvio, true, "nada saiu: preEnvio");
    return true;
  });
};

describe("existe -> JID canônico devolvido pelo WhatsApp", () => {
  test("usa o jid da RESPOSTA (não o concatenado) e consulta só os dígitos do E.164", async () => {
    let chamadaCom;
    const r = await resolverJidCanonico({ socket: socketCom(async (...a) => { chamadaCom = a; return [{ jid: "5511987654321@s.whatsapp.net", exists: true, lid: "999@lid" }]; }), telefoneE164: "+5511987654321" });
    assert.deepEqual(chamadaCom, ["5511987654321"]);
    assert.equal(r.jid, "5511987654321@s.whatsapp.net");
    assert.equal(r.jidDifereDoPedido, false);
  });
  test("BRASIL/9º dígito: o WhatsApp responde SEM o 9 -> usa o JID dele (nenhuma heurística nossa) e sinaliza a diferença", async () => {
    const r = await resolverJidCanonico({ socket: socketCom(async () => [{ jid: "551187654321@s.whatsapp.net", exists: true }]), telefoneE164: "+5511987654321" });
    assert.equal(r.jid, "551187654321@s.whatsapp.net");
    assert.equal(r.jidDifereDoPedido, true);
  });
  test("o inverso (pedido sem 9, WhatsApp COM 9) também é aceito — quem decide é a resposta", async () => {
    const r = await resolverJidCanonico({ socket: socketCom(async () => [{ jid: "5511987654321@s.whatsapp.net", exists: true }]), telefoneE164: "+551187654321" });
    assert.equal(r.jid, "5511987654321@s.whatsapp.net");
  });
});

describe("não confirmado -> NÃO envia", () => {
  test("número que não existe: lista vazia (é assim que o Baileys filtra `contact=out`) e exists=false", async () => {
    await bloqueia(socketCom(async () => []), CODIGOS.DESTINATARIO_INEXISTENTE);
    await bloqueia(socketCom(async () => [{ jid: "5511987654321@s.whatsapp.net", exists: false }]), CODIGOS.DESTINATARIO_INEXISTENTE);
  });
  test("erro/rejeição da consulta e resposta vazia (undefined/null): falha TRANSITÓRIA de consulta", async () => {
    await bloqueia(socketCom(async () => { throw new Error("Connection Closed"); }), CODIGOS.CONSULTA_DESTINATARIO_FALHOU);
    await bloqueia(socketCom(async () => undefined), CODIGOS.CONSULTA_DESTINATARIO_FALHOU);
    await bloqueia(socketCom(async () => null), CODIGOS.CONSULTA_DESTINATARIO_FALHOU);
  });
  test("timeout da consulta: a promise pendurada NÃO deixa o envio prosseguir", async () => {
    let dispara;
    const agendar = (fn) => { dispara = fn; return 1; };
    const p = resolverJidCanonico({ socket: socketCom(() => new Promise(() => {})), telefoneE164: "+5511987654321", agendar, cancelar() {} });
    await Promise.resolve(); dispara();
    await assert.rejects(p, (e) => e.codigo === CODIGOS.CONSULTA_DESTINATARIO_FALHOU && e.preEnvio === true && e.detalheInterno === "timeout");
    assert.equal(TIMEOUT_CONSULTA_DESTINATARIO_MS, 10_000);
  });
  test("retorno inesperado: não-lista, mais de 1 item, item inválido, exists não-booleano, jid ausente/LID/com dispositivo/incoerente", async () => {
    const U = CODIGOS.DESTINATARIO_NAO_VERIFICADO;
    await bloqueia(socketCom(async () => ({ jid: "5511987654321@s.whatsapp.net", exists: true })), U);
    await bloqueia(socketCom(async () => "ok"), U);
    await bloqueia(socketCom(async () => [{ jid: "5511987654321@s.whatsapp.net", exists: true }, { jid: "5511987654322@s.whatsapp.net", exists: true }]), U);
    await bloqueia(socketCom(async () => [null]), U);
    await bloqueia(socketCom(async () => ["x"]), U);
    await bloqueia(socketCom(async () => [{ jid: "5511987654321@s.whatsapp.net", exists: "true" }]), U);
    await bloqueia(socketCom(async () => [{ jid: "5511987654321@s.whatsapp.net" }]), U);
    await bloqueia(socketCom(async () => [{ exists: true }]), U);
    await bloqueia(socketCom(async () => [{ jid: "999888777666@lid", exists: true }]), U);
    await bloqueia(socketCom(async () => [{ jid: "5511987654321:12@s.whatsapp.net", exists: true }]), U);
    await bloqueia(socketCom(async () => [{ jid: "1203630000@g.us", exists: true }]), U);
    await bloqueia(socketCom(async () => [{ jid: "5599123456789@s.whatsapp.net", exists: true }]), U);   // OUTRA pessoa: últimos 8 dígitos divergem
  });
  test("socket sem onWhatsApp e E.164 inválido nunca chegam ao envio", async () => {
    await bloqueia({}, CODIGOS.DESTINATARIO_NAO_VERIFICADO);
    await bloqueia(null, CODIGOS.DESTINATARIO_NAO_VERIFICADO);
    for (const tel of ["5511987654321", "+0511987654321", "+55", "", null, 5511987654321, "+55 11 98765-4321"]) await bloqueia(socketCom(async () => [{ jid: "5511987654321@s.whatsapp.net", exists: true }]), CODIGOS.DESTINATARIO_NAO_VERIFICADO, tel);
  });
  test("os códigos são os que o backend classifica (paridade com providers/baileysGateway.provider.js)", () => {
    assert.equal(CODIGOS.DESTINATARIO_INEXISTENTE, "WHATSAPP_GATEWAY_RECIPIENT_NOT_ON_WHATSAPP");
    assert.equal(CODIGOS.DESTINATARIO_NAO_VERIFICADO, "WHATSAPP_GATEWAY_RECIPIENT_UNVERIFIED");
    assert.equal(CODIGOS.CONSULTA_DESTINATARIO_FALHOU, "WHATSAPP_GATEWAY_RECIPIENT_LOOKUP_FAILED");
  });
});
