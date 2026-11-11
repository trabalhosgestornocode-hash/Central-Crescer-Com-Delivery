// Permissões e módulo das rotas novas (catálogo, homologação, condições comerciais, CMV teórico) — wiring REAL dos routers.
// Monta cada router num app Express com um "contexto" falso (papel -> permissões reais de shared/permissoes.js). Uma rota
// recusada devolve 403 ANTES de qualquer acesso a banco; uma permitida passa da autorização (aqui falha depois, sem banco: 500).
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);

const { produtosRouter } = await import("../src/modules/produtos/produtos.routes.js");
const { cmvRouter } = await import("../src/modules/cmv/cmv.routes.js");
const { dashboardExecutivoRouter } = await import("../src/modules/dashboard-executivo/dashboardExecutivo.routes.js");
const { requireModulo } = await import("../src/middlewares/auth.js");
const { permissoesDoPapel } = await import("../src/shared/permissoes.js");
const { MODULOS } = await import("../src/shared/modulos.js");

function app(papel, modulos) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.acesso = { papel, permissoes: permissoesDoPapel(papel), modulos, impersonando: false }; req.tenant = { organizacaoId: "org-1", unidadeId: "und-1" }; next(); });
  a.use("/produtos", requireModulo(MODULOS.PRODUTOS_CMV), produtosRouter);
  a.use("/cmv", requireModulo(MODULOS.PRODUTOS_CMV), cmvRouter);
  a.use("/dashboard-executivo", requireModulo(MODULOS.IFOOD_DASHBOARD), dashboardExecutivoRouter);
  a.use((err, _req, res, _next) => res.status(err.status ?? err.statusCode ?? 500).json({ error: err.message }));
  return a;
}
async function chamar(papel, modulos, metodo, caminho, corpo) {
  const srv = app(papel, modulos).listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}${caminho}`, { method: metodo, headers: { "Content-Type": "application/json" }, body: corpo ? JSON.stringify(corpo) : undefined });
    return r.status;
  } finally { await new Promise((ok) => srv.close(ok)); }
}
const TODOS = [MODULOS.PRODUTOS_CMV, MODULOS.IFOOD_DASHBOARD];
const ID = "11111111-1111-4111-8111-111111111111";

// Só administrador (configuracoes.gerenciar) grava decisões comerciais e homologa.
const SO_ADMIN = [
  ["PUT", "/cmv/condicoes-comerciais", { canal: "ifood", comissao: 0.2 }],
  ["PATCH", `/produtos/${ID}/homologacao`, { acao: "homologar" }],
  ["POST", "/produtos/catalogo/homologar-lote", { ids: [ID] }],
];
for (const [metodo, caminho, corpo] of SO_ADMIN) {
  test(`${metodo} ${caminho.replace(ID, ":id")}: consulta, financeiro e operação são RECUSADOS (403); administrador passa da autorização`, async () => {
    for (const papel of ["viewer", "finance", "operations"]) assert.equal(await chamar(papel, TODOS, metodo, caminho, corpo), 403, `${papel} deveria ser recusado`);
    assert.notEqual(await chamar("organization_admin", TODOS, metodo, caminho, corpo), 403);
  });
}
test("editar rendimento (PUT /produtos/:id) exige produtos.editar: consulta e financeiro recusados", async () => {
  for (const papel of ["viewer", "finance"]) assert.equal(await chamar(papel, TODOS, "PUT", `/produtos/${ID}`, { rendimento: 2 }), 403);
  for (const papel of ["operations", "organization_admin"]) assert.notEqual(await chamar(papel, TODOS, "PUT", `/produtos/${ID}`, { rendimento: 2 }), 403);
});
test("leituras novas liberadas à consulta (catálogo, pendências, condições, histórico)", async () => {
  for (const c of ["/produtos/catalogo/fichas", "/produtos/catalogo/pendencias", "/cmv/condicoes-comerciais", "/cmv/condicoes-comerciais/historico"]) {
    assert.notEqual(await chamar("viewer", TODOS, "GET", c), 403, `viewer deveria ler ${c}`);
  }
});
test("SEM o módulo contratado nada responde: Produtos/CMV e Dashboard iFood são gates da empresa (403)", async () => {
  for (const c of ["/produtos/catalogo/fichas", "/produtos/catalogo/pendencias", "/cmv/condicoes-comerciais"]) assert.equal(await chamar("organization_admin", [MODULOS.IFOOD_DASHBOARD], "GET", c), 403, c);
  assert.equal(await chamar("organization_admin", [], "PUT", "/cmv/condicoes-comerciais", { canal: "ifood", comissao: 0.1 }), 403);
});
