// Headers de segurança HTTP (P0.9) + estado da CSP (P0.8).
//
// O que protegem: clickjacking (X-Frame-Options DENY + frame-ancestors 'none'),
// MIME sniffing (nosniff), vazamento de referer, e recursos do navegador que o
// app não usa (Permissions-Policy). Confere também que a CSP NÃO tem
// 'unsafe-inline'/'unsafe-eval' em script-src e que continua Report-Only nesta
// fase (a virada para enforce é manual, em staging — ver docs/seguranca-fase-p0.md).

process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const { createApp } = await import("../src/app.js");

async function headers(path = "/health") {
  const srv = http.createServer(createApp()).listen(0);
  await new Promise((r) => srv.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}${path}`);
    return { status: res.status, h: Object.fromEntries(res.headers.entries()) };
  } finally {
    srv.close();
  }
}

test("clickjacking: X-Frame-Options DENY + frame-ancestors 'none'", async () => {
  const { h } = await headers();
  assert.equal(h["x-frame-options"], "DENY");
  const csp = h["content-security-policy"] || h["content-security-policy-report-only"] || "";
  assert.match(csp, /frame-ancestors 'none'/);
});

test("nosniff, referrer-policy e sem x-powered-by", async () => {
  const { h } = await headers();
  assert.equal(h["x-content-type-options"], "nosniff");
  assert.equal(h["referrer-policy"], "strict-origin-when-cross-origin");
  assert.equal(h["x-powered-by"], undefined);
});

test("Permissions-Policy nega câmera/microfone/geoloc/pagamento", async () => {
  const { h } = await headers();
  const pp = h["permissions-policy"] || "";
  for (const rec of ["camera=()", "microphone=()", "geolocation=()", "payment=()", "usb=()"]) {
    assert.ok(pp.includes(rec), `Permissions-Policy deveria conter ${rec} — veio: ${pp}`);
  }
});

test("Permissions-Policy: tela acesa (screen-wake-lock) só para a própria origem; o resto inalterado", async () => {
  const { h } = await headers();
  const diretivas = (h["permissions-policy"] || "").split(",").map((d) => d.trim());
  assert.deepEqual(diretivas, [
    "accelerometer=()", "autoplay=()", "camera=()", "display-capture=()",
    "encrypted-media=()", "fullscreen=(self)", "geolocation=()", "gyroscope=()",
    "magnetometer=()", "microphone=()", "midi=()", "payment=()",
    "picture-in-picture=()", "usb=()", "screen-wake-lock=(self)",
  ]);
  assert.ok(!diretivas.some((d) => d.includes("*")), "nenhuma diretiva liberada para qualquer origem");
});

test("CSP: script-src sem 'unsafe-inline'/'unsafe-eval'; object-src 'none'", async () => {
  const { h } = await headers();
  const csp = h["content-security-policy"] || h["content-security-policy-report-only"] || "";
  const scriptSrc = (csp.split(";").find((d) => d.trim().startsWith("script-src")) || "").trim();
  assert.ok(scriptSrc, "script-src deve existir");
  assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
});

test("CSP continua Report-Only nesta fase (virada é manual em staging)", async () => {
  const { h } = await headers();
  // com CSP_ENFORCE ausente/false, sai o header Report-Only e NÃO o de bloqueio
  if (process.env.CSP_ENFORCE !== "true") {
    assert.ok(h["content-security-policy-report-only"], "esperado Report-Only");
    assert.equal(h["content-security-policy"], undefined);
  }
});

test("HSTS presente", async () => {
  const { h } = await headers();
  assert.match(h["strict-transport-security"] || "", /max-age=\d+/);
});
