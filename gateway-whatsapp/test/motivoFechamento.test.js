// C.9.1 — motivo estrutural do fechamento. Usa o helper REAL do Baileys 6.7.24 para montar o mesmo
// Boom que o socket monta em CB:stream:error, garantindo que o parsing acompanha o formato real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getErrorCodeFromStreamError } from "baileys";
import { motivoFechamento } from "../src/motivoFechamento.js";
import { sanitizar } from "../src/logsafe.js";

// Mesma forma da Boom do Baileys (message, output.statusCode, data) — sem depender de @hapi/boom (transitivo).
class Boom extends Error { constructor(msg, { statusCode, data }) { super(msg); this.output = { statusCode }; this.data = data; } }
const noStream = (attrs, filhos) => ({ tag: "stream:error", attrs, content: filhos.map((tag) => ({ tag, attrs: {}, content: undefined })) });
const comoBaileys = (node) => { const { reason, statusCode } = getErrorCodeFromStreamError(node); return new Boom(`Stream Errored (${reason})`, { statusCode, data: node }); };

test("stream:error sem code e sem 'conflict' => 500 badSession, e o motivo (tag) fica visível", () => {
  const e = comoBaileys(noStream({}, ["ack"]));
  assert.equal(e.output.statusCode, 500);
  assert.deepEqual(motivoFechamento(e), { origemFechamento: "stream_error", motivoStream: "ack", atributosStream: [], codigoAtributoStream: null });
});

test("conflict vira 440 (connectionReplaced) — é o sinal de OUTRO consumidor e aparece com nome", () => {
  const e = comoBaileys(noStream({}, ["conflict"]));
  assert.equal(e.output.statusCode, 440);
  assert.equal(motivoFechamento(e).motivoStream, "conflict");
});

test("515 restart required e code numérico do atributo", () => {
  const e = comoBaileys(noStream({ code: "515" }, ["xml-not-well-formed"]));
  assert.equal(e.output.statusCode, 515);
  assert.deepEqual(motivoFechamento(e), { origemFechamento: "stream_error", motivoStream: "restart_required", atributosStream: ["code"], codigoAtributoStream: 515 });
});

test("filho ausente => 'unknown'", () => {
  assert.equal(motivoFechamento(comoBaileys(noStream({}, []))).motivoStream, "unknown");
});

test("CB:failure: origem 'failure' e só o código numérico", () => {
  const e = new Boom("Connection Failure", { statusCode: 401, data: { reason: "401", location: "prn" } });
  assert.deepEqual(motivoFechamento(e), { origemFechamento: "failure", codigoAtributoStream: 401 });
});

test("NUNCA vaza conteúdo: valores de atributo, texto do filho, tag fora do padrão, atributo com nome estranho", () => {
  const node = { tag: "stream:error", attrs: { code: "500", jid: "5511999990000@s.whatsapp.net", "Nome Estranho": "x" }, content: [{ tag: "TAG COM ESPAÇO 5511999990000", attrs: {}, content: Buffer.from("segredo-conteudo") }] };
  const e = new Boom("Stream Errored (TAG COM ESPAÇO 5511999990000)", { statusCode: 500, data: node });
  const r = motivoFechamento(e);
  const s = JSON.stringify(r);
  assert.ok(!/5511999990000|segredo-conteudo|Nome Estranho|s\.whatsapp\.net/.test(s), s);
  assert.equal(r.motivoStream, null);
  assert.deepEqual(r.atributosStream, ["code", "jid"], "só NOMES de atributo dentro do padrão, nunca os valores");
});

test("outros erros e entradas malformadas não lançam e não acrescentam campos", () => {
  for (const e of [undefined, null, new Error("boom"), { message: 5 }, new Boom("Connection Closed", { statusCode: 428 })]) assert.deepEqual(motivoFechamento(e), {});
});

test("os campos passam pelo logsafe sem mascaramento", () => {
  const r = motivoFechamento(comoBaileys(noStream({ code: "500" }, ["ack"])));
  assert.deepEqual(sanitizar(r), r);
});
