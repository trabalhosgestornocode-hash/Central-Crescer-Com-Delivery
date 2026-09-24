// QR → SVG: renderização no Gateway (sem biblioteca de terceiros no navegador). O SVG só descreve módulos; nunca script nem referência externa.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import QRCode from "qrcode";
import { qrParaSvg } from "../src/qrSvg.js";

const TEXTO = "2@qr-de-teste-com-tamanho-parecido-com-o-real,AbCdEf0123456789+/=,GhIjKl9876543210+/=,MnOpQr";

describe("qrParaSvg", () => {
  test("gera um SVG bem formado com viewBox quadrado (matriz + margem) e a matriz REAL do qrcode", () => {
    const svg = qrParaSvg(TEXTO);
    const n = QRCode.create(TEXTO, { errorCorrectionLevel: "M" }).modules.size;
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 (\d+) (\d+)"/);
    const [, w, h] = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    assert.deepEqual([Number(w), Number(h)], [n + 4, n + 4]);
    assert.ok(svg.endsWith("</svg>"));
  });

  test("os módulos escuros do SVG batem EXATAMENTE com a matriz (cada 'h' da trilha soma os módulos contíguos)", () => {
    const { modules } = QRCode.create(TEXTO, { errorCorrectionLevel: "M" });
    const escuros = Array.from(modules.data).filter(Boolean).length;
    const d = qrParaSvg(TEXTO).match(/<path d="([^"]+)"/)[1];
    const soma = [...d.matchAll(/h(\d+)v1/g)].reduce((s, m) => s + Number(m[1]), 0);
    assert.equal(soma, escuros);
  });

  test("determinístico; textos diferentes geram imagens diferentes", () => {
    assert.equal(qrParaSvg(TEXTO), qrParaSvg(TEXTO));
    assert.notEqual(qrParaSvg(TEXTO), qrParaSvg(TEXTO + "x"));
  });

  test("SEGURO: sem <script>, sem handlers, sem href/xlink, sem referência externa e sem o texto cru do QR dentro do SVG", () => {
    const svg = qrParaSvg(TEXTO);
    assert.ok(!/<script|on\w+=|href|xlink|<image|<foreignObject|javascript:|url\(/i.test(svg));
    assert.ok(!svg.includes("qr-de-teste"), "o SVG só tem módulos, nunca o texto");
  });

  test("entrada inválida ⇒ null, nunca lança (vazio, não-string, gigante, cor inválida)", () => {
    for (const x of ["", null, undefined, 5, {}, [], "x".repeat(5000)]) assert.equal(qrParaSvg(x), null);
    assert.equal(qrParaSvg(TEXTO, { escuro: "red" }), null);
    assert.equal(qrParaSvg(TEXTO, { claro: 'url(javascript:alert(1))' }), null);
  });
});
