// "Nenhuma rota financeira funciona sem autorização efetiva do backend" — prova ESTRUTURAL sobre os routers REAIS.
// Enumera TODAS as rotas do domínio (Agente 2) + /status (Agente 1), monta-as exatamente como routes.js (gate à frente) e
// chama cada uma por HTTP em loopback com: (a) sem concessão, (b) concessão que não cobre a ação. Tudo tem de ser 403,
// e nenhum repositório/Supabase pode ser tocado (o gate nega antes). Uma rota nova sem autorização reprova aqui.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { requireFinanceiro } from "../src/middlewares/financeiro.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";

const { gestaoFinanceiraRouter } = await import("../src/modules/gestao-financeira/index.js");
const aqui = path.dirname(fileURLToPath(import.meta.url));
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = U(1), UNI = U(2);

/** Percorre a pilha do express e devolve [{metodo, caminho}] de cada rota. */
function rotasDe(router, prefixo = "") {
  const saida = [];
  for (const camada of router.stack) {
    if (camada.route) {
      for (const m of Object.keys(camada.route.methods)) saida.push({ metodo: m.toUpperCase(), caminho: prefixo + camada.route.path });
    } else if (camada.handle?.stack) {
      saida.push(...rotasDe(camada.handle, prefixo));   // sub-router montado com use() sem prefixo
    }
  }
  return saida;
}

const rotas = rotasDe(gestaoFinanceiraRouter);
const concreta = (c) => c.replace(/:[A-Za-z]+/g, U(9));

async function servir(leitor, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: U(6) }; req.tenant = { organizacaoId: ORG, unidadeId: UNI }; req.acesso = { perfilId: U(5), papel: "organization_admin", impersonando: false }; next(); });
  app.use("/gestao-financeira", requireFinanceiro(leitor), gestaoFinanceiraRouter);
  app.use(errorHandler);
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/gestao-financeira`;
  try { return await fn((metodo, caminho) => fetch(base + caminho, { method: metodo, headers: { "Content-Type": "application/json" }, ...(metodo === "GET" ? {} : { body: "{}" }) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }))); }
  finally { srv.close(); }
}
const leitor = (c) => ({ moduloEmpresa: async () => true, moduloUnidade: async () => true, concessao: async () => c });
const conc = (nivel) => ({ organizacao_id: ORG, unidade_id: UNI, nivel, somente_financeiro: false, revogada_em: null, expira_em: null });

describe("rotas financeiras reais", () => {
  test("há rotas do domínio montadas (a prova não é vazia) e o /status do Agente 1", () => {
    assert.ok(rotas.length >= 20, `rotas encontradas: ${rotas.length}`);
    assert.ok(rotas.some((r) => r.caminho === "/status"));
  });
  test("SEM concessão: TODAS as rotas, todos os métodos, respondem 403 FINANCEIRO_SEM_CONCESSAO", () =>
    servir(leitor(null), async (chamar) => {
      for (const r of rotas) {
        const res = await chamar(r.metodo, concreta(r.caminho));
        assert.equal(res.status, 403, `${r.metodo} ${r.caminho}`);
        assert.equal(res.json?.details?.codigo, "FINANCEIRO_SEM_CONCESSAO", `${r.metodo} ${r.caminho}`);
      }
    }));
  test("concessão de LEITURA: toda rota que não é de leitura é recusada com PERMISSAO_INSUFICIENTE (e o gate nega antes de qualquer acesso ao repositório)", () =>
    servir(leitor(conc("leitura")), async (chamar) => {
      for (const r of rotas.filter((x) => x.metodo !== "GET")) {
        const res = await chamar(r.metodo, concreta(r.caminho));
        assert.equal(res.status, 403, `${r.metodo} ${r.caminho}`);
        assert.equal(res.json?.details?.codigo, "FINANCEIRO_PERMISSAO_INSUFICIENTE", `${r.metodo} ${r.caminho}`);
      }
    }));
  test("routes.js monta /gestao-financeira DEPOIS de requireContexto e restringirPerfilExibicao, com requireFinanceiro() à frente", () => {
    const src = readFileSync(path.join(aqui, "..", "src", "routes.js"), "utf8");
    const iCtx = src.indexOf("tenant.use(requireContexto)");
    const iExib = src.indexOf("tenant.use(restringirPerfilExibicao)");
    const iFin = src.indexOf('tenant.use("/gestao-financeira", requireFinanceiro(), gestaoFinanceiraRouter)');
    assert.ok(iCtx > -1 && iExib > iCtx && iFin > iExib, `ordem: ctx=${iCtx} exib=${iExib} fin=${iFin}`);
    assert.ok(!/requireModulo|requirePermissao|requirePapel|requireAlgumaPermissao/.test(src.slice(iFin, src.indexOf("\n", iFin))), "o gate financeiro não pode usar helpers com bypass");
  });
  test("o domínio não importa helpers com bypass de impersonação", () => {
    const dir = path.join(aqui, "..", "src", "modules", "gestao-financeira");
    const proibido = /\b(requirePermissao|requireModulo|requirePapel|requireAlgumaPermissao)\b/;
    for (const f of ["index.js", "concessoes.routes.js", "dominio/rotas.js", "dominio/index.js"]) {
      assert.ok(!proibido.test(readFileSync(path.join(dir, f), "utf8").replace(/\/\/.*$/gm, "")), f);
    }
  });
});
