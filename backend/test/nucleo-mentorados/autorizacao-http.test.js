// Núcleo Mentorados — autorização HTTP de TODAS as rotas (listadas a partir do próprio router).
//   usuário de empresa / sem usuário -> 403 sem tocar no banco
//   SuperAdmin e Painel Administrativo -> passam da autorização
// Rodar: node --test test/nucleo-mentorados/autorizacao-http.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { administrativoRouter } from "../../src/modules/administrativo/administrativo.routes.js";
import { nucleoMentoradosRouter } from "../../src/modules/nucleo-mentorados/routes.js";
import { errorHandler } from "../../src/middlewares/errorHandler.js";
import { fakeSupabase } from "./fakeSupabase.js";

const ID = "11111111-1111-4111-8111-111111111111";
const ROTAS = nucleoMentoradosRouter.stack.filter((l) => l.route).flatMap((l) =>
  Object.keys(l.route.methods).map((m) => [m.toUpperCase(), "/administrativo/nucleo-mentorados" + l.route.path.replace(/:[A-Za-z]+/g, ID).replace(/\/$/, "")]));

const SUPERADMIN = { id: "u-sa", email: "sa@teste.invalid", nome: "SA", superadmin: true, painelAdministrativo: false };
const PAINEL = { id: "u-padm", email: "padm@teste.invalid", nome: "Painel", superadmin: false, painelAdministrativo: true };
const EMPRESA = { id: "u-emp", email: "emp@teste.invalid", nome: "Franqueado", superadmin: false, painelAdministrativo: false };

function app(user, sb) {
  const a = express();
  a.use(express.json());
  a.use((req, _r, next) => { if (user) req.user = user; next(); });
  a.use("/administrativo", administrativoRouter);
  a.use(errorHandler);
  a.locals.nucleoDeps = { supabase: sb, auditar: async () => {} };
  a.locals.adminHoje = "2026-11-26";
  return a;
}

function chamar(a, metodo, path, corpo) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(a).listen(0, "127.0.0.1", () => {
      const req = http.request({ host: "127.0.0.1", port: srv.address().port, path, method: metodo, headers: corpo ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(JSON.stringify(corpo)) } : {} }, (res) => {
        let b = ""; res.on("data", (c) => { b += c; });
        res.on("end", () => { srv.close(); resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }); });
      });
      req.on("error", (e) => { srv.close(); reject(e); });
      if (corpo) req.write(JSON.stringify(corpo));
      req.end();
    });
  });
}

describe("autorização", () => {
  test("o router tem as rotas esperadas", () => assert.ok(ROTAS.length >= 11, String(ROTAS.length)));
  for (const [quem, user] of [["usuário de empresa", EMPRESA], ["sem usuário", null]]) {
    test(`${quem}: 403 em todas as rotas, sem tocar no banco`, async () => {
      const sb = fakeSupabase({});
      for (const [m, p] of ROTAS) {
        const r = await chamar(app(user, sb), m, p, m === "GET" ? null : {});
        assert.ok(r.status === 403 || r.status === 401, `${m} ${p} -> ${r.status}`);
      }
      assert.equal(sb.log.length, 0);
    });
  }
  for (const [quem, user] of [["SuperAdmin", SUPERADMIN], ["Painel Administrativo", PAINEL]]) {
    test(`${quem}: passa da autorização`, async () => {
      const sb = fakeSupabase({ mentoria_participantes: [], organizacoes: [] });
      const r = await chamar(app(user, sb), "GET", "/administrativo/nucleo-mentorados");
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.data.mentorados, []);
      const p = await chamar(app(user, sb), "GET", `/administrativo/nucleo-mentorados/${ID}`);
      assert.equal(p.status, 404);
    });
  }
});
