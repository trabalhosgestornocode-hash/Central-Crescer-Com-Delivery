// D.3-A — classificação de resultado de envio: RETRYAVEL × PERMANENTE × INCERTO.
//
// REGRA: só é RETRYAVEL o que se PROVA que não chegou ao `socket.sendMessage()`
// do Gateway. Na dúvida, INCERTO -> DELIVERY_UNKNOWN, NUNCA retry automático.
//
// Sem WhatsApp real, sem Gateway real: servidores TCP/HTTP locais em
// 127.0.0.1 reproduzem cada situação de transporte, e um "Gateway falso" que
// registra se o seu `sendMessage` simulado foi chamado prova o lado de lá.
// Rodar: node --test test/comunicacao-classificacao-envio.test.js
import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createServer } from "node:http";
import express from "express";
import { criarBaileysGatewayProvider, falhaProvaQueNadaSaiu, MAX_TEXTO_ENVIO, MARCAS_POR_CODIGO_GATEWAY } from "../src/modules/comunicacao/providers/baileysGateway.provider.js";
import { exigirHmac } from "../src/modules/comunicacao/gateway/whatsappGateway.hmac.js";
import { classificarErroEnvio, permiteRetryAutomatico, backoffRetrySegundos } from "../src/modules/comunicacao/comunicacao.entrega.js";
import { CLASSIFICACAO_ERRO } from "../src/modules/comunicacao/comunicacao.constants.js";
// Só o CONTRATO de erros do Gateway (módulo puro, sem dependências): garante que
// os códigos que o provider trata como "pré-envio" continuam existindo lá.
import { CODIGOS as CODIGOS_GATEWAY } from "../../gateway-whatsapp/src/errors.js";

const SEGREDO = "s".repeat(32);
const PEDIDO = { telefoneE164: "+5511999990000", texto: "oi", idempotencyKey: "k-teste" };

/** Porta livre que, depois de fechada, recusa conexão de verdade (ECONNREFUSED). */
async function portaFechada() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

/** Servidor TCP cru: `aoReceber(socket, bytesAteAgora)` decide o que fazer com a conexão. */
async function servidorTcp(aoReceber) {
  const conexoes = [];
  const srv = net.createServer((socket) => {
    conexoes.push(socket);
    let buf = "";
    socket.on("data", (d) => { buf += d.toString("utf8"); aoReceber(socket, buf); });
    socket.on("error", () => {});
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, fechar: () => { conexoes.forEach((s) => s.destroy()); srv.close(); } };
}

const requisicaoCompleta = (buf) => buf.includes("\r\n\r\n") && buf.includes("idempotencyKey");
const classificar = (e) => classificarErroEnvio(e);

async function erroDe(promessa) {
  try { await promessa; } catch (e) { return e; }
  assert.fail("esperava que o envio rejeitasse");
}

describe("D.3-A — Caso A: o Gateway NEM recebeu a requisição -> RETRYAVEL", () => {
  test("conexão recusada (ECONNREFUSED, porta livre fechada) -> preEnvio -> RETRYAVEL", async () => {
    const porta = await portaFechada();
    const p = criarBaileysGatewayProvider({ gatewayUrl: `http://127.0.0.1:${porta}`, segredoHmac: SEGREDO, timeoutMs: 3000 });
    const e = await erroDe(p.sendText(PEDIDO));
    assert.equal(e.preEnvio, true);
    assert.equal(classificar(e), CLASSIFICACAO_ERRO.RETRYAVEL);
    assert.equal(permiteRetryAutomatico(classificar(e)), true);
  });

  test("DNS que não resolve (ENOTFOUND) -> RETRYAVEL", async () => {
    const p = criarBaileysGatewayProvider({ gatewayUrl: "http://gateway-que-nao-existe.invalid", segredoHmac: SEGREDO, timeoutMs: 5000 });
    const e = await erroDe(p.sendText(PEDIDO));
    // ENOTFOUND (ou EAI_AGAIN sem resolver DNS no ambiente) — ambos provam "nada saiu".
    assert.equal(classificar(e), CLASSIFICACAO_ERRO.RETRYAVEL, `causa inesperada: ${e.message}`);
  });

  test('porta proibida pelo fetch ("bad port", ex.: 1) é barrada ANTES de conectar -> RETRYAVEL', async () => {
    const p = criarBaileysGatewayProvider({ gatewayUrl: "http://127.0.0.1:1", segredoHmac: SEGREDO, timeoutMs: 3000 });
    const e = await erroDe(p.sendText(PEDIDO));
    assert.equal(classificar(e), CLASSIFICACAO_ERRO.RETRYAVEL);
  });

  test("Gateway responde 409 NOT_CONNECTED (emitido ANTES do sendMessage) -> RETRYAVEL", async () => {
    const app = express();
    app.use(express.raw({ type: "*/*" }), exigirHmac(SEGREDO), (_req, res) => res.status(409).json({ error: "WHATSAPP_GATEWAY_NOT_CONNECTED" }));
    const srv = await new Promise((r) => { const s = createServer(app).listen(0, "127.0.0.1", () => r(s)); });
    const p = criarBaileysGatewayProvider({ gatewayUrl: `http://127.0.0.1:${srv.address().port}`, segredoHmac: SEGREDO });
    const e = await erroDe(p.sendText(PEDIDO));
    srv.close();
    assert.equal(classificar(e), CLASSIFICACAO_ERRO.RETRYAVEL);
  });

  test("gatewayUrl/segredo ausentes: nenhuma rede é tocada -> RETRYAVEL", async () => {
    const p = criarBaileysGatewayProvider({ gatewayUrl: "", segredoHmac: "" });
    const e = await erroDe(p.sendText(PEDIDO));
    assert.equal(classificar(e), CLASSIFICACAO_ERRO.RETRYAVEL);
  });
});

describe("D.3-A — Caso B: a requisição CHEGOU e a conexão morreu antes da resposta -> INCERTO", () => {
  test("servidor lê a requisição inteira e derruba o socket (UND_ERR_SOCKET) -> INCERTO, nunca retry", async () => {
    const srv = await servidorTcp((socket, buf) => { if (requisicaoCompleta(buf)) socket.destroy(); });
    const p = criarBaileysGatewayProvider({ gatewayUrl: srv.url, segredoHmac: SEGREDO, timeoutMs: 3000 });
    const e = await erroDe(p.sendText(PEDIDO));
    srv.fechar();
    assert.notEqual(e.preEnvio, true, "conexão que existiu e caiu NÃO é prova de pré-envio");
    assert.equal(classificar(e), CLASSIFICACAO_ERRO.INCERTO);
    assert.equal(permiteRetryAutomatico(classificar(e)), false);
  });

  test("servidor responde só o começo da resposta e derruba (corpo truncado) -> INCERTO", async () => {
    const srv = await servidorTcp((socket, buf) => {
      if (requisicaoCompleta(buf)) socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{\"providerMes");
      setTimeout(() => socket.destroy(), 20);
    });
    const p = criarBaileysGatewayProvider({ gatewayUrl: srv.url, segredoHmac: SEGREDO, timeoutMs: 3000 });
    const e = await erroDe(p.sendText(PEDIDO));
    srv.fechar();
    assert.equal(classificar(e), CLASSIFICACAO_ERRO.INCERTO);
  });

  test("servidor aceita e NUNCA responde (timeout com a requisição já entregue) -> INCERTO", async () => {
    const srv = await servidorTcp(() => { /* lê e silencia */ });
    const p = criarBaileysGatewayProvider({ gatewayUrl: srv.url, segredoHmac: SEGREDO, timeoutMs: 150 });
    const e = await erroDe(p.sendText(PEDIDO));
    srv.fechar();
    assert.equal(classificar(e), CLASSIFICACAO_ERRO.INCERTO);
    assert.match(e.message, /TIMEOUT/);
  });

  test("falhaProvaQueNadaSaiu: reset/socket/'fetch failed' sem causa reconhecível NUNCA prova pré-envio", () => {
    const comCausa = (c) => Object.assign(new TypeError("fetch failed"), { cause: c });
    assert.equal(falhaProvaQueNadaSaiu(comCausa({ code: "ECONNRESET" })), false);
    assert.equal(falhaProvaQueNadaSaiu(comCausa({ code: "UND_ERR_SOCKET" })), false);
    assert.equal(falhaProvaQueNadaSaiu(comCausa({ code: "EPIPE" })), false);
    assert.equal(falhaProvaQueNadaSaiu(comCausa({ code: "ETIMEDOUT", syscall: "read" })), false, "ETIMEDOUT numa conexão estabelecida não é pré-envio");
    assert.equal(falhaProvaQueNadaSaiu(new TypeError("fetch failed")), false, "sem `cause`: dúvida -> INCERTO");
    assert.equal(falhaProvaQueNadaSaiu(new Error("qualquer coisa")), false);
    assert.equal(falhaProvaQueNadaSaiu(undefined), false);
    // happy-eyeballs: TODOS os sub-erros precisam ser de conexão não estabelecida
    assert.equal(falhaProvaQueNadaSaiu(comCausa({ errors: [{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }] })), true);
    assert.equal(falhaProvaQueNadaSaiu(comCausa({ errors: [{ code: "ECONNREFUSED" }, { code: "ECONNRESET" }] })), false);
    assert.equal(falhaProvaQueNadaSaiu(comCausa({ code: "ETIMEDOUT", syscall: "connect" })), true);
  });
});

describe("D.3-A — Caso C: o Gateway chamou socket.sendMessage() e DEPOIS houve erro -> INCERTO", () => {
  /**
   * "Gateway falso" com o MESMO contrato de erro do real (server.js#errorHandler):
   * qualquer erro não tratado -> `500 {"error":"WHATSAPP_GATEWAY_UNAVAILABLE"}`. Registra
   * se o sendMessage simulado rodou — o status HTTP é idêntico nos dois casos.
   */
  async function gatewayFalso({ falharAntesDoSend }) {
    const estado = { sendMessageChamado: 0 };
    const app = express();
    app.use(express.raw({ type: "*/*" }), exigirHmac(SEGREDO), (_req, res) => {
      if (falharAntesDoSend) return res.status(500).json({ error: "WHATSAPP_GATEWAY_UNAVAILABLE" });
      estado.sendMessageChamado += 1; // socket.sendMessage() rodou...
      return res.status(500).json({ error: "WHATSAPP_GATEWAY_UNAVAILABLE" }); // ...e algo quebrou depois
    });
    const srv = await new Promise((r) => { const s = createServer(app).listen(0, "127.0.0.1", () => r(s)); });
    return { estado, url: `http://127.0.0.1:${srv.address().port}`, fechar: () => srv.close() };
  }

  test("500 depois do sendMessage -> INCERTO (o provider não vê diferença para 'antes'; por isso é INCERTO nos DOIS casos)", async () => {
    const depois = await gatewayFalso({ falharAntesDoSend: false });
    const antes = await gatewayFalso({ falharAntesDoSend: true });
    const pDepois = criarBaileysGatewayProvider({ gatewayUrl: depois.url, segredoHmac: SEGREDO });
    const pAntes = criarBaileysGatewayProvider({ gatewayUrl: antes.url, segredoHmac: SEGREDO });
    const eDepois = await erroDe(pDepois.sendText(PEDIDO));
    const eAntes = await erroDe(pAntes.sendText(PEDIDO));
    depois.fechar(); antes.fechar();

    assert.equal(depois.estado.sendMessageChamado, 1, "no cenário C o sendMessage simulado DE FATO rodou");
    assert.equal(classificar(eDepois), CLASSIFICACAO_ERRO.INCERTO);
    // idêntico ao 500 "antes": é isso que impede usar o status HTTP como prova.
    assert.equal(classificar(eAntes), CLASSIFICACAO_ERRO.INCERTO);
    assert.equal(permiteRetryAutomatico(classificar(eDepois)), false);
  });

  test("502 SEND_FAILED, 503 UNAVAILABLE, 404, 401 e corpo não-JSON: nenhum status fora do contrato prova pré-envio -> INCERTO", async () => {
    for (const [status, corpo] of [[502, { error: "WHATSAPP_GATEWAY_SEND_FAILED" }], [503, { error: "WHATSAPP_GATEWAY_UNAVAILABLE" }],
      [404, { error: "not_found" }], [401, { error: "unauthorized" }], [423, { error: "WHATSAPP_GATEWAY_NOT_LEADER" }]]) {
      const app = express();
      app.use(express.raw({ type: "*/*" }), (_req, res) => res.status(status).json(corpo));
      const srv = await new Promise((r) => { const s = createServer(app).listen(0, "127.0.0.1", () => r(s)); });
      const p = criarBaileysGatewayProvider({ gatewayUrl: `http://127.0.0.1:${srv.address().port}`, segredoHmac: SEGREDO });
      const e = await erroDe(p.sendText(PEDIDO));
      srv.close();
      assert.equal(classificar(e), CLASSIFICACAO_ERRO.INCERTO, `HTTP ${status} ${corpo.error} deveria ser INCERTO`);
    }
    const srvHtml = createServer((_req, res) => { res.statusCode = 502; res.setHeader("content-type", "text/html"); res.end("<html>Bad Gateway</html>"); });
    await new Promise((r) => srvHtml.listen(0, "127.0.0.1", r));
    const p = criarBaileysGatewayProvider({ gatewayUrl: `http://127.0.0.1:${srvHtml.address().port}`, segredoHmac: SEGREDO });
    assert.equal(classificar(await erroDe(p.sendText(PEDIDO))), CLASSIFICACAO_ERRO.INCERTO);
    srvHtml.close();
  });

  test("200 com corpo ILEGÍVEL numa chamada de ENVIO -> INCERTO (o envio pode ter acontecido)", async () => {
    for (const corpo of ["{ isso nao é json", "[]", "null", "\"texto\""]) {
      const srv = createServer((_req, res) => { res.statusCode = 200; res.setHeader("content-type", "application/json"); res.end(corpo); });
      await new Promise((r) => srv.listen(0, "127.0.0.1", r));
      const p = criarBaileysGatewayProvider({ gatewayUrl: `http://127.0.0.1:${srv.address().port}`, segredoHmac: SEGREDO });
      const e = await erroDe(p.sendText(PEDIDO));
      srv.close();
      assert.equal(classificar(e), CLASSIFICACAO_ERRO.INCERTO, `corpo ${JSON.stringify(corpo)}`);
    }
  });
});

describe("D.3-A — Caso D: o Gateway CONFIRMOU o envio -> SENT", () => {
  test("200 + providerMessageId -> resolve com o id (nenhum erro a classificar)", async () => {
    const app = express();
    app.use(express.raw({ type: "*/*" }), exigirHmac(SEGREDO), (_req, res) => res.json({ providerMessageId: "wa-123", enviadoEm: "2026-09-18T00:00:00Z" }));
    const srv = await new Promise((r) => { const s = createServer(app).listen(0, "127.0.0.1", () => r(s)); });
    const p = criarBaileysGatewayProvider({ gatewayUrl: `http://127.0.0.1:${srv.address().port}`, segredoHmac: SEGREDO });
    const r = await p.sendText(PEDIDO);
    srv.close();
    assert.equal(r.providerMessageId, "wa-123");
  });
});

describe("D.3-A — Caso E: destino/payload inválido -> PERMANENTE, sem tocar a rede", () => {
  let chamadas = 0;
  let srv;
  let url;
  before(async () => {
    const s = await servidorTcp(() => { chamadas += 1; });
    srv = s; url = s.url;
  });
  after(() => srv.fechar());

  const invalidos = [
    ["telefone sem +", { ...PEDIDO, telefoneE164: "5511999990000" }],
    ["telefone com letras", { ...PEDIDO, telefoneE164: "+55abc" }],
    ["telefone curto demais", { ...PEDIDO, telefoneE164: "+551234" }],
    ["telefone ausente", { ...PEDIDO, telefoneE164: undefined }],
    ["telefone com DDI 0", { ...PEDIDO, telefoneE164: "+0511999990000" }],
    ["texto vazio", { ...PEDIDO, texto: "   " }],
    ["texto ausente", { ...PEDIDO, texto: undefined }],
    ["texto não-string", { ...PEDIDO, texto: 123 }],
    [`texto maior que ${MAX_TEXTO_ENVIO}`, { ...PEDIDO, texto: "x".repeat(MAX_TEXTO_ENVIO + 1) }],
    ["idempotencyKey ausente", { ...PEDIDO, idempotencyKey: "" }],
  ];

  for (const [nome, pedido] of invalidos) {
    test(`${nome} -> PERMANENTE + pré-envio; nenhuma conexão aberta`, async () => {
      const antes = chamadas;
      const p = criarBaileysGatewayProvider({ gatewayUrl: url, segredoHmac: SEGREDO, timeoutMs: 500 });
      const e = await erroDe(p.sendText(pedido));
      assert.equal(e.preEnvio, true);
      assert.equal(e.permanente, true);
      assert.equal(classificar(e), CLASSIFICACAO_ERRO.PERMANENTE);
      assert.equal(permiteRetryAutomatico(classificar(e)), false);
      assert.equal(chamadas, antes, "um pedido inválido NÃO pode gerar tráfego para o Gateway");
    });
  }

  test("Gateway responde 400 INVALID_MESSAGE / 410 LOGGED_OUT (contrato) -> PERMANENTE", async () => {
    for (const [status, error] of [[400, "WHATSAPP_GATEWAY_INVALID_MESSAGE"], [410, "WHATSAPP_GATEWAY_LOGGED_OUT"]]) {
      const app = express();
      app.use(express.raw({ type: "*/*" }), exigirHmac(SEGREDO), (_req, res) => res.status(status).json({ error }));
      const s = await new Promise((r) => { const x = createServer(app).listen(0, "127.0.0.1", () => r(x)); });
      const p = criarBaileysGatewayProvider({ gatewayUrl: `http://127.0.0.1:${s.address().port}`, segredoHmac: SEGREDO });
      const e = await erroDe(p.sendText(PEDIDO));
      s.close();
      assert.equal(classificar(e), CLASSIFICACAO_ERRO.PERMANENTE, error);
    }
  });
});

describe("D.3-A — contrato com o Gateway e backoff", () => {
  test("os códigos que o provider trata como 'pré-envio' existem no contrato de erros do Gateway", () => {
    for (const cod of ["WHATSAPP_GATEWAY_NOT_CONNECTED", "WHATSAPP_GATEWAY_LOGGED_OUT", "WHATSAPP_GATEWAY_INVALID_MESSAGE"]) {
      assert.ok(Object.values(CODIGOS_GATEWAY).includes(cod), `${cod} não existe mais em gateway-whatsapp/src/errors.js — o provider ficou dessincronizado`);
    }
  });

  test("backoffRetrySegundos: exponencial, com teto, e robusto a entrada ruim", () => {
    assert.equal(backoffRetrySegundos(1), 30);
    assert.equal(backoffRetrySegundos(2), 60);
    assert.equal(backoffRetrySegundos(3), 120);
    assert.equal(backoffRetrySegundos(50), 1800);
    assert.equal(backoffRetrySegundos(0), 30);
    assert.equal(backoffRetrySegundos(NaN), 30);
  });
});

// ---------------------------------------------------------------------------
// TABELA DEFINITIVA (D.3-R) — uma linha por cenário; o resultado esperado é o
// contrato. RETRYAVEL só com PROVA de que sendMessage() não pôde rodar;
// PERMANENTE só para o determinístico; TUDO o mais é INCERTO.
// ---------------------------------------------------------------------------
const R = CLASSIFICACAO_ERRO.RETRYAVEL, P = CLASSIFICACAO_ERRO.PERMANENTE, I = CLASSIFICACAO_ERRO.INCERTO;

/** Sobe um HTTP simples que responde `status`/`corpo` e devolve o erro do provider. */
async function erroComResposta(status, corpo, { cru = false } = {}) {
  const srv = createServer((_req, res) => {
    res.statusCode = status; res.setHeader("content-type", cru ? "text/html" : "application/json");
    res.end(cru ? corpo : JSON.stringify(corpo));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try { await criarBaileysGatewayProvider({ gatewayUrl: `http://127.0.0.1:${srv.address().port}`, segredoHmac: SEGREDO }).sendText(PEDIDO); }
  catch (e) { return e; } finally { srv.close(); }
  assert.fail("esperava erro");
}
const comFetchQueLanca = async (erro) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw erro; };
  try { await criarBaileysGatewayProvider({ gatewayUrl: "http://127.0.0.1:9", segredoHmac: SEGREDO }).sendText(PEDIDO); }
  catch (e) { return e; } finally { globalThis.fetch = original; }
  assert.fail("esperava erro");
};
const tcpQue = (aoReceber, { timeoutMs = 3000 } = {}) => async () => {
  const srv = await servidorTcp(aoReceber);
  try { await criarBaileysGatewayProvider({ gatewayUrl: srv.url, segredoHmac: SEGREDO, timeoutMs }).sendText(PEDIDO); }
  catch (e) { return e; } finally { srv.fechar(); }
  assert.fail("esperava erro");
};
const invalido = (campos) => criarBaileysGatewayProvider({ gatewayUrl: "http://127.0.0.1:9", segredoHmac: SEGREDO })
  .sendText({ ...PEDIDO, ...campos }).then(() => assert.fail("esperava erro"), (e) => e);
const fetchFalhou = (causa) => comFetchQueLanca(Object.assign(new TypeError("fetch failed"), { cause: causa }));
const causaSistema = (mensagem, code, syscall) => Object.assign(new Error(mensagem), { code, syscall });

const TABELA = [
  // ---- RETRYAVEL: prova de que nada saiu ----
  [R, "Gateway 409 WHATSAPP_GATEWAY_NOT_CONNECTED (emitido antes do sendMessage)", () => erroComResposta(409, { error: "WHATSAPP_GATEWAY_NOT_CONNECTED" })],
  [R, "ECONNREFUSED — conexão recusada antes de qualquer requisição", async () => { const p = await portaFechada(); return criarBaileysGatewayProvider({ gatewayUrl: `http://127.0.0.1:${p}`, segredoHmac: SEGREDO, timeoutMs: 3000 }).sendText(PEDIDO).catch((e) => e); }],
  [R, "ENOTFOUND/EAI_AGAIN — DNS não resolve", async () => criarBaileysGatewayProvider({ gatewayUrl: "http://gateway-que-nao-existe.invalid", segredoHmac: SEGREDO, timeoutMs: 5000 }).sendText(PEDIDO).catch((e) => e)],
  [R, 'porta proibida pelo fetch ("bad port") — barrada antes de conectar', async () => criarBaileysGatewayProvider({ gatewayUrl: "http://127.0.0.1:1", segredoHmac: SEGREDO, timeoutMs: 3000 }).sendText(PEDIDO).catch((e) => e)],
  [R, "URL inválida — o fetch lança antes de qualquer rede", async () => criarBaileysGatewayProvider({ gatewayUrl: "http://", segredoHmac: SEGREDO }).sendText(PEDIDO).catch((e) => e)],
  [R, "gatewayUrl/segredo ausentes — nenhuma rede é tocada", async () => criarBaileysGatewayProvider({ gatewayUrl: "", segredoHmac: "" }).sendText(PEDIDO).catch((e) => e)],
  [R, "timeout de CONEXÃO (UND_ERR_CONNECT_TIMEOUT)", () => fetchFalhou(causaSistema("Connect Timeout Error", "UND_ERR_CONNECT_TIMEOUT"))],
  [R, "connect ETIMEDOUT (syscall connect)", () => fetchFalhou(causaSistema("connect ETIMEDOUT", "ETIMEDOUT", "connect"))],
  // ---- PERMANENTE: determinístico ----
  [P, "Gateway 410 WHATSAPP_GATEWAY_LOGGED_OUT", () => erroComResposta(410, { error: "WHATSAPP_GATEWAY_LOGGED_OUT" })],
  [P, "Gateway 400 WHATSAPP_GATEWAY_INVALID_MESSAGE", () => erroComResposta(400, { error: "WHATSAPP_GATEWAY_INVALID_MESSAGE" })],
  [P, "telefone fora de E.164 (barrado no provider, sem rede)", () => invalido({ telefoneE164: "5511999990000" })],
  [P, "texto vazio (barrado no provider, sem rede)", () => invalido({ texto: "  " })],
  [P, "texto acima do limite", () => invalido({ texto: "x".repeat(MAX_TEXTO_ENVIO + 1) })],
  [P, "idempotencyKey ausente", () => invalido({ idempotencyKey: "" })],
  // ---- INCERTO: não dá para provar que o envio não ocorreu ----
  [I, "TIMEOUT depois de a requisição ser entregue", tcpQue(() => {}, { timeoutMs: 150 })],
  [I, "conexão derrubada depois de LER a requisição inteira (UND_ERR_SOCKET)", tcpQue((s, buf) => { if (requisicaoCompleta(buf)) s.destroy(); })],
  [I, "resposta truncada — socket fechado no meio da resposta", tcpQue((s, buf) => { if (requisicaoCompleta(buf)) s.write("HTTP/1.1 200 OK\r\nContent-Length: 500\r\n\r\n{\"a"); setTimeout(() => s.destroy(), 20); })],
  [I, "ECONNRESET com conexão estabelecida", () => fetchFalhou(causaSistema("read ECONNRESET", "ECONNRESET", "read"))],
  [I, "ETIMEDOUT numa conexão já estabelecida (syscall read)", () => fetchFalhou(causaSistema("read ETIMEDOUT", "ETIMEDOUT", "read"))],
  [I, "'terminated' (undici) sem código reconhecível", () => comFetchQueLanca(Object.assign(new TypeError("terminated"), { cause: new Error("other side closed") }))],
  [I, "erro DESCONHECIDO do Node/fetch (sem cause)", () => comFetchQueLanca(new Error("algo inesperado"))],
  [I, "TypeError 'fetch failed' sem cause", () => comFetchQueLanca(new TypeError("fetch failed"))],
  [I, "500 WHATSAPP_GATEWAY_UNAVAILABLE (idêntico antes/depois do sendMessage)", () => erroComResposta(500, { error: "WHATSAPP_GATEWAY_UNAVAILABLE" })],
  [I, "HTTP 5xx com corpo HTML de proxy", () => erroComResposta(502, "<html>Bad Gateway</html>", { cru: true })],
  [I, "HTTP 401 (fora do contrato: não provamos onde caiu)", () => erroComResposta(401, { error: "unauthorized" })],
  [I, "HTTP 404 (fora do contrato)", () => erroComResposta(404, { error: "not_found" })],
  [I, "2xx com corpo ILEGÍVEL numa chamada de envio", () => erroComResposta(200, "{ nao é json", { cru: true })],
];

describe("D.3-R — TABELA DEFINITIVA de classificação (RETRYAVEL × PERMANENTE × INCERTO)", () => {
  for (const [esperado, cenario, produzir] of TABELA) {
    test(`${esperado.padEnd(10)} <- ${cenario}`, async () => {
      const e = await produzir();
      assert.ok(e instanceof Error, "o cenário deveria produzir um erro");
      assert.equal(classificar(e), esperado, `${cenario}: ${e.message}`);
      assert.equal(permiteRetryAutomatico(classificar(e)), esperado === R, "só RETRYAVEL permite retry automático");
    });
  }

  test("a tabela cobre as três classes com múltiplos cenários (não pode encolher em silêncio)", () => {
    const conta = (c) => TABELA.filter(([x]) => x === c).length;
    assert.ok(conta(R) >= 8 && conta(P) >= 6 && conta(I) >= 12, `R=${conta(R)} P=${conta(P)} I=${conta(I)}`);
  });

  test("CADA código do contrato de erros do Gateway tem classificação decidida — código novo no Gateway exige decisão explícita", async () => {
    const ESPERADO = {
      WHATSAPP_GATEWAY_NOT_CONNECTED: [409, R],
      WHATSAPP_GATEWAY_LOGGED_OUT: [410, P],
      WHATSAPP_GATEWAY_INVALID_MESSAGE: [400, P],
      WHATSAPP_GATEWAY_ALREADY_CONNECTED: [409, I],
      WHATSAPP_GATEWAY_SEND_FAILED: [502, I],
      WHATSAPP_GATEWAY_AUTH_STATE_UNAVAILABLE: [503, I],
      WHATSAPP_GATEWAY_UNAVAILABLE: [503, I],
      WHATSAPP_GATEWAY_NOT_LEADER: [423, I],
      // H.4-B.4 — pré-validação do destinatário no Gateway (onWhatsApp ANTES do sendMessage): em todos, nada saiu.
      WHATSAPP_GATEWAY_RECIPIENT_NOT_ON_WHATSAPP: [422, P],
      WHATSAPP_GATEWAY_RECIPIENT_UNVERIFIED: [422, P],
      WHATSAPP_GATEWAY_RECIPIENT_LOOKUP_FAILED: [503, R],
    };
    for (const codigo of Object.values(CODIGOS_GATEWAY)) {
      assert.ok(ESPERADO[codigo], `o Gateway ganhou o código ${codigo}: decida sua classificação (RETRYAVEL só com prova de pré-envio)`);
      const [status, classe] = ESPERADO[codigo];
      assert.equal(classificar(await erroComResposta(status, { error: codigo })), classe, codigo);
    }
  });

  test("MARCAS_POR_CODIGO_GATEWAY: exatamente NOT_CONNECTED -> preEnvio, LOGGED_OUT/INVALID_MESSAGE -> permanente e os 3 códigos de destinatário da H.4-B.4 (mais nada)", () => {
    assert.deepEqual(Object.keys(MARCAS_POR_CODIGO_GATEWAY).sort(), [
      "WHATSAPP_GATEWAY_INVALID_MESSAGE", "WHATSAPP_GATEWAY_LOGGED_OUT", "WHATSAPP_GATEWAY_NOT_CONNECTED",
      "WHATSAPP_GATEWAY_RECIPIENT_LOOKUP_FAILED", "WHATSAPP_GATEWAY_RECIPIENT_NOT_ON_WHATSAPP", "WHATSAPP_GATEWAY_RECIPIENT_UNVERIFIED",
    ]);
    assert.deepEqual(MARCAS_POR_CODIGO_GATEWAY.WHATSAPP_GATEWAY_RECIPIENT_NOT_ON_WHATSAPP, { preEnvio: true, permanente: true });
    assert.deepEqual(MARCAS_POR_CODIGO_GATEWAY.WHATSAPP_GATEWAY_RECIPIENT_UNVERIFIED, { preEnvio: true, permanente: true });
    assert.deepEqual(MARCAS_POR_CODIGO_GATEWAY.WHATSAPP_GATEWAY_RECIPIENT_LOOKUP_FAILED, { preEnvio: true });
    assert.deepEqual(MARCAS_POR_CODIGO_GATEWAY.WHATSAPP_GATEWAY_NOT_CONNECTED, { preEnvio: true });
    assert.deepEqual(MARCAS_POR_CODIGO_GATEWAY.WHATSAPP_GATEWAY_LOGGED_OUT, { permanente: true });
    assert.deepEqual(MARCAS_POR_CODIGO_GATEWAY.WHATSAPP_GATEWAY_INVALID_MESSAGE, { permanente: true });
  });

  test("LOGGED_OUT e INVALID_MESSAGE são PERMANENTES e NÃO alegam pré-envio (o Gateway não garante); NOT_CONNECTED é o único RETRYAVEL do contrato", async () => {
    const eLogged = await erroComResposta(410, { error: "WHATSAPP_GATEWAY_LOGGED_OUT" });
    const eInvalid = await erroComResposta(400, { error: "WHATSAPP_GATEWAY_INVALID_MESSAGE" });
    const eNaoConectado = await erroComResposta(409, { error: "WHATSAPP_GATEWAY_NOT_CONNECTED" });
    assert.equal(eLogged.preEnvio, undefined); assert.equal(eLogged.permanente, true);
    assert.equal(eInvalid.preEnvio, undefined); assert.equal(eInvalid.permanente, true);
    assert.equal(eNaoConectado.preEnvio, true); assert.equal(eNaoConectado.permanente, undefined);
    assert.equal(classificar(eLogged), P); assert.equal(classificar(eInvalid), P); assert.equal(classificar(eNaoConectado), R);
  });
});
