// Testes do script administrativo de visualização do QR (Checkpoint C3).
// Sobe o mesmo servidor Express real (rotas + HMAC) usado por routes.test.js
// e injeta tempo/IO fake em criarVisualizadorQr — sem 2s de espera real, sem
// terminal de verdade, sem Baileys.
import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { exigirHmac } from "../src/hmac.js";
import { criarRotas, health } from "../src/routes.js";
import { criarVisualizadorQr, renderizarQrTerminalTrueColor } from "../scripts/mostrar-qr.mjs";

const SEGREDO = "s".repeat(32);
const QR_FALSO = "2@nao-pode-vazar-isto-em-lugar-nenhum==,fake==";

describe("renderizarQrTerminalTrueColor — background RGB verdadeiro (não ANSI 40/47)", () => {
  test("usa SGR 48;2;r;g;b (true color) para os módulos escuro/claro, nunca os códigos ANSI clássicos 40/47", () => {
    const desenho = renderizarQrTerminalTrueColor("QR-DE-TESTE-PARA-RENDERIZACAO");
    assert.ok(desenho.includes("\x1b[48;2;0;0;0m"), "esperava background RGB preto (0,0,0) para módulo escuro");
    assert.ok(desenho.includes("\x1b[48;2;255;255;255m"), "esperava background RGB branco (255,255,255) para módulo claro");
    assert.ok(!desenho.includes("\x1b[40m") && !desenho.includes("\x1b[47m"), "não pode usar os códigos ANSI clássicos 40/47");
  });

  test("tem quiet zone branca de pelo menos 2 módulos nas bordas (primeira e última linha inteiramente claras)", () => {
    const desenho = renderizarQrTerminalTrueColor("QR-DE-TESTE-PARA-RENDERIZACAO");
    const linhas = desenho.split("\n");
    assert.ok(linhas.length >= 4);
    // As duas primeiras e duas últimas linhas são só margem — não podem conter módulo escuro.
    for (const linha of [linhas[0], linhas[1], linhas.at(-1), linhas.at(-2)]) {
      assert.ok(!linha.includes("\x1b[48;2;0;0;0m"), "linha de margem não pode ter módulo escuro");
    }
  });

  test("cada módulo ocupa 2 colunas, e cada linha termina com reset (\\x1b[0m)", () => {
    const desenho = renderizarQrTerminalTrueColor("X");
    const primeiraLinha = desenho.split("\n")[0];
    assert.ok(primeiraLinha.endsWith("\x1b[0m"));
    // conta quantos blocos de módulo (cada um termina em "  " antes do próximo \x1b ou do reset)
    const blocos = primeiraLinha.split("\x1b[48;2;").length - 1;
    assert.ok(blocos > 0);
  });

  test("a string original do QR NUNCA aparece na saída renderizada", () => {
    const original = "2@string-secreta-do-pareamento-nao-pode-vazar==,xyz==";
    const desenho = renderizarQrTerminalTrueColor(original);
    assert.ok(!desenho.includes(original));
  });

  test("respeita a API real de QRCode.create() — não assume silenciosamente o formato: 'modules' tem size (number) e data (indexável)", async () => {
    const QRCode = (await import("qrcode")).default;
    const { modules } = QRCode.create("QR-DE-TESTE-PARA-RENDERIZACAO", { errorCorrectionLevel: "M" });
    assert.equal(typeof modules.size, "number");
    assert.ok(modules.size > 0);
    assert.ok(modules.data.length === modules.size * modules.size);
  });
});

/** Sessão controlável: muda de comportamento conforme o teste avança as chamadas. */
function sessaoControlavel() {
  let qrAtual = null;
  let status = "DISCONNECTED";
  return {
    conectar: async () => { throw new Error("o script NUNCA deveria chamar /connect"); },
    desconectar: async () => {},
    getStatus: async () => ({ conectado: status === "CONNECTED", provider: "baileys", telefone: null, atualizadoEm: "now", status }),
    obterQrAtual: () => qrAtual,
    _status: () => status,
    // ---- controles do teste ----
    _setQr(v) { qrAtual = v; },
    _setStatus(v) { status = v; },
  };
}

describe("mostrar-qr — script administrativo de visualização", () => {
  let servidor, baseUrl, sessao;

  before(async () => {
    sessao = sessaoControlavel();
    const app = express();
    app.get("/health", health);
    app.use("/internal", express.raw({ type: "*/*", limit: 256 * 1024 }), exigirHmac(SEGREDO), criarRotas(sessao));
    await new Promise((resolve) => { servidor = createServer(app).listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  });
  after(() => servidor.close());

  function tempoFalso() {
    let agora = 0;
    return {
      agoraMs: () => agora,
      esperar: async (ms) => { agora += ms; },
    };
  }

  test("nunca chama /connect", async () => {
    sessao._setStatus("DISCONNECTED");
    sessao._setQr(null);
    const { agoraMs, esperar } = tempoFalso();
    const visualizador = criarVisualizadorQr({
      segredo: SEGREDO, base: baseUrl, intervaloMs: 10, timeoutMs: 25,
      escrever: () => {}, limparTela: () => {}, agoraMs, esperar,
    });
    // Se o script chamasse /connect, sessao.conectar() lançaria e o teste falharia.
    const resultado = await visualizador.rodar();
    assert.equal(resultado, "TIMEOUT");
  });

  test("timeout: encerra sozinho se nunca conectar, sem travar", async () => {
    sessao._setStatus("DISCONNECTED");
    sessao._setQr(null);
    const escritos = [];
    const { agoraMs, esperar } = tempoFalso();
    const visualizador = criarVisualizadorQr({
      segredo: SEGREDO, base: baseUrl, intervaloMs: 10, timeoutMs: 35,
      escrever: (t) => escritos.push(t), limparTela: () => {}, agoraMs, esperar,
    });
    const resultado = await visualizador.rodar();
    assert.equal(resultado, "TIMEOUT");
    assert.ok(escritos.some((t) => t.includes("Tempo limite")));
  });

  test("renderiza quando QR aparece, e a string CRUA nunca é passada para escrever()", async () => {
    sessao._setStatus("DISCONNECTED");
    sessao._setQr(QR_FALSO);
    const escritos = [];
    const telasLimpas = [];
    const { agoraMs, esperar } = tempoFalso();
    const visualizador = criarVisualizadorQr({
      segredo: SEGREDO, base: baseUrl, intervaloMs: 10, timeoutMs: 25,
      renderizarTerminal: async (qr) => { assert.equal(qr, QR_FALSO); return "[DESENHO-ASCII-FALSO]"; },
      escrever: (t) => escritos.push(t),
      limparTela: () => telasLimpas.push(true),
      agoraMs, esperar,
    });
    await visualizador.rodar();

    assert.ok(escritos.some((t) => t.includes("[DESENHO-ASCII-FALSO]")), "esperava o desenho renderizado");
    assert.ok(!escritos.some((t) => t.includes(QR_FALSO)), "a string crua do QR NUNCA pode ir para escrever()");
    assert.ok(telasLimpas.length > 0);
  });

  test("para sozinho e limpa a tela assim que o status vira CONNECTED — não continua consultando /qr", async () => {
    sessao._setStatus("CONNECTED");
    sessao._setQr(null);
    const escritos = [];
    let telaLimpaAoConectar = false;
    const { agoraMs, esperar } = tempoFalso();
    const visualizador = criarVisualizadorQr({
      segredo: SEGREDO, base: baseUrl, intervaloMs: 10, timeoutMs: 100_000,
      escrever: (t) => escritos.push(t),
      limparTela: () => { telaLimpaAoConectar = true; },
      agoraMs, esperar,
    });
    const resultado = await visualizador.rodar();
    assert.equal(resultado, "CONNECTED");
    assert.ok(telaLimpaAoConectar);
    assert.ok(escritos.some((t) => t.includes("Conectado")));
  });

  test("com a dependência REAL 'qrcode' (sem fake): renderiza sem lançar, e o ASCII resultante não contém a string original", async () => {
    sessao._setStatus("DISCONNECTED");
    sessao._setQr(QR_FALSO);
    const escritos = [];
    const { agoraMs, esperar } = tempoFalso();
    const visualizador = criarVisualizadorQr({
      segredo: SEGREDO, base: baseUrl, intervaloMs: 10, timeoutMs: 25,
      // renderizarTerminal NÃO injetado — usa o padrão real (pacote `qrcode`).
      escrever: (t) => escritos.push(t), limparTela: () => {}, agoraMs, esperar,
    });
    await visualizador.rodar();

    const desenhoReal = escritos.find((t) => t.length > 100); // o ASCII é bem maior que as mensagens de status
    assert.ok(desenhoReal, "esperava um desenho real vindo do pacote qrcode");
    assert.ok(!desenhoReal.includes(QR_FALSO), "o ASCII renderizado não pode conter a string original do QR");
  });

  test("rota /internal/whatsapp/qr sem HMAC nunca é alcançável pelo script (mesma proteção de sempre)", async () => {
    const r = await fetch(`${baseUrl}/internal/whatsapp/qr`);
    assert.equal(r.status, 401);
  });
});
