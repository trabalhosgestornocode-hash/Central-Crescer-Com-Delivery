// PAINEL ADMINISTRATIVO — Mentorados: consolidação de contas + vínculos e a
// AUTORIZAÇÃO da rota, via Express real. Sem banco, sem rede.
//
// Prova:
//   * usuário comum -> 403 ; usuário com Painel Administrativo / SuperAdmin -> 200 ;
//   * só contas COM vínculo entram ("mentorado" = quem está vinculado) ;
//   * vínculos consolidados por empresa, com as unidades sob a empresa ;
//   * multi-perfil na mesma conta não quebra e marca o nome do perfil ;
//   * custo em queries NÃO cresce com o número de contas (6 fixas).
//
// Rodar: node --test test/administrativo-mentorados.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { administrativoRouter } from "../src/modules/administrativo/administrativo.routes.js";
import { listarMentorados } from "../src/modules/administrativo/administrativo.mentorados.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";

const uuid = (l) => { const h = Buffer.from(String(l)).toString("hex").padEnd(32, "0").slice(0, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

function fakeDb(estado) {
  const contador = { queries: 0 };
  function from(tabela) {
    const ctx = { eq: [], inF: null };
    const casa = (r) =>
      ctx.eq.every(([c, v]) => r[c] === v) &&
      (!ctx.inF || ctx.inF.vals.includes(r[ctx.inF.col]));
    const run = (single) => {
      contador.queries += 1;
      const achados = (estado[tabela] ?? []).filter(casa).map((r) => ({ ...r }));
      return Promise.resolve(single ? { data: achados[0] ?? null, error: null } : { data: achados, error: null });
    };
    const b = {
      select: () => b,
      eq: (c, v) => (ctx.eq.push([c, v]), b),
      in: (c, vals) => ((ctx.inF = { col: c, vals }), b),
      maybeSingle: () => run(true),
      then: (res, rej) => run(false).then(res, rej),
    };
    return b;
  }
  return { from, __contador: contador };
}

// --- Fixture -------------------------------------------------------------
// Grupo Saci (o1) com 2 unidades (ua Matriz, ub Laranjeiras); Grupo MC (o2)
// com 1 unidade (uc).
//   João  -> vínculo de empresa o1 + unidades ua, ub
//   Maria -> só vínculo de empresa o2
//   Ana   -> conta com 2 perfis (Ana / Bea): Ana em o1, Bea em o2
//   Zed   -> conta SEM vínculo nenhum (não deve aparecer)
function fixture() {
  return {
    perfis: [
      { id: uuid("joao"), nome: "João da Silva", email: "joao@ex.com", ativo: true },
      { id: uuid("maria"), nome: "Maria Oliveira", email: "maria@ex.com", ativo: true },
      { id: uuid("ana"), nome: "Ana", email: "ana@ex.com", ativo: true },
      { id: uuid("zed"), nome: "Zed Sem Vínculo", email: "zed@ex.com", ativo: true },
    ],
    perfis_operacionais: [
      { id: uuid("joao"), conta_id: uuid("joao"), nome: "João da Silva", ativo: true },
      { id: uuid("maria"), conta_id: uuid("maria"), nome: "Maria Oliveira", ativo: true },
      { id: uuid("ana"), conta_id: uuid("ana"), nome: "Ana", ativo: true },
      { id: uuid("bea"), conta_id: uuid("ana"), nome: "Bea", ativo: true },
      { id: uuid("zed"), conta_id: uuid("zed"), nome: "Zed Sem Vínculo", ativo: true },
    ],
    organizacoes: [
      { id: uuid("o1"), nome: "Grupo Saci", status: "ativa" },
      { id: uuid("o2"), nome: "Grupo Montes Claros", status: "ativa" },
    ],
    unidades: [
      { id: uuid("ua"), nome: "Subway Saci — Matriz", organizacao_id: uuid("o1") },
      { id: uuid("ub"), nome: "Subway Laranjeiras", organizacao_id: uuid("o1") },
      { id: uuid("uc"), nome: "Subway Avenida MC", organizacao_id: uuid("o2") },
    ],
    usuarios_organizacoes: [
      { usuario_id: uuid("joao"), perfil_id: uuid("joao"), organizacao_id: uuid("o1"), papel: "organization_admin", ativo: true },
      { usuario_id: uuid("maria"), perfil_id: uuid("maria"), organizacao_id: uuid("o2"), papel: "viewer", ativo: true },
      { usuario_id: uuid("ana"), perfil_id: uuid("ana"), organizacao_id: uuid("o1"), papel: "finance", ativo: true },
      { usuario_id: uuid("ana"), perfil_id: uuid("bea"), organizacao_id: uuid("o2"), papel: "viewer", ativo: true },
    ],
    usuarios_unidades: [
      { usuario_id: uuid("joao"), perfil_id: uuid("joao"), unidade_id: uuid("ua"), papel: "unit_manager", ativo: true },
      { usuario_id: uuid("joao"), perfil_id: uuid("joao"), unidade_id: uuid("ub"), papel: null, ativo: true },
    ],
    painel_administrativo_usuarios: [],
    plataforma_admins: [],
  };
}

// Fixture + 3 contas administrativas, TODAS com vínculo de empresa:
//   gestor          -> painel_administrativo_usuarios ativo   -> EXCLUÍDO
//   raiz            -> plataforma_admins ativo (SuperAdmin)   -> EXCLUÍDO
//   gestorRevogado  -> painel_administrativo_usuarios ativo=false -> APARECE (acesso revogado)
function fixtureComAdmins() {
  const f = fixture();
  f.perfis.push(
    { id: uuid("gestor"), nome: "Gestor Crescer", email: "gestor@ex.com", ativo: true },
    { id: uuid("raiz"), nome: "Raiz", email: "raiz@ex.com", ativo: true },
    { id: uuid("gestorRevogado"), nome: "Ex Gestor", email: "exgestor@ex.com", ativo: true },
  );
  f.perfis_operacionais.push(
    { id: uuid("gestor"), conta_id: uuid("gestor"), nome: "Gestor Crescer", ativo: true },
    { id: uuid("raiz"), conta_id: uuid("raiz"), nome: "Raiz", ativo: true },
    { id: uuid("gestorRevogado"), conta_id: uuid("gestorRevogado"), nome: "Ex Gestor", ativo: true },
  );
  for (const c of ["gestor", "raiz", "gestorRevogado"]) {
    f.usuarios_organizacoes.push({ usuario_id: uuid(c), perfil_id: uuid(c), organizacao_id: uuid("o1"), papel: "viewer", ativo: true });
  }
  f.painel_administrativo_usuarios.push(
    { usuario_id: uuid("gestor"), ativo: true },
    { usuario_id: uuid("gestorRevogado"), ativo: false },
  );
  f.plataforma_admins.push({ usuario_id: uuid("raiz"), ativo: true });
  return f;
}

describe("listarMentorados (consolidação)", () => {
  test("só contas com vínculo; João consolida empresa + 2 unidades", async () => {
    const db = fakeDb(fixture());
    const { mentorados, total } = await listarMentorados({}, { supabase: db });

    assert.equal(total, 3);                                  // João, Maria, Ana — nunca Zed
    assert.deepEqual(mentorados.map((m) => m.nome), ["Ana", "João da Silva", "Maria Oliveira"]);

    const joao = mentorados.find((m) => m.email === "joao@ex.com");
    assert.equal(joao.totalVinculos, 3);                     // 1 empresa + 2 unidades
    assert.equal(joao.multiPerfil, false);
    assert.equal(joao.vinculos.length, 1);
    assert.equal(joao.vinculos[0].empresaNome, "Grupo Saci");
    assert.equal(joao.vinculos[0].associacaoDireta, true);
    assert.equal(joao.vinculos[0].papelRotulo, "Administrador");
    assert.deepEqual(joao.vinculos[0].unidades.map((u) => u.unidadeNome), ["Subway Laranjeiras", "Subway Saci — Matriz"]);
    // unidade com papel NULL herda
    assert.equal(joao.vinculos[0].unidades.find((u) => u.unidadeNome === "Subway Laranjeiras").papelRotulo, "herda da empresa");
  });

  test("Maria: só empresa, sem unidade", async () => {
    const { mentorados } = await listarMentorados({}, { supabase: fakeDb(fixture()) });
    const maria = mentorados.find((m) => m.email === "maria@ex.com");
    assert.equal(maria.totalVinculos, 1);
    assert.equal(maria.vinculos[0].empresaNome, "Grupo Montes Claros");
    assert.equal(maria.vinculos[0].unidades.length, 0);
  });

  test("conta multi-perfil: vínculos dos 2 perfis juntos, marcados pelo nome", async () => {
    const { mentorados } = await listarMentorados({}, { supabase: fakeDb(fixture()) });
    const ana = mentorados.find((m) => m.email === "ana@ex.com");
    assert.equal(ana.multiPerfil, true);
    assert.deepEqual(ana.perfis.map((p) => p.nome).sort(), ["Ana", "Bea"]);
    assert.equal(ana.vinculos.length, 2);                    // Grupo Saci (Ana) + Grupo MC (Bea)
    const saci = ana.vinculos.find((v) => v.empresaNome === "Grupo Saci");
    assert.deepEqual(saci.perfilNomes, ["Ana"]);
    const mc = ana.vinculos.find((v) => v.empresaNome === "Grupo Montes Claros");
    assert.deepEqual(mc.perfilNomes, ["Bea"]);
  });

  test("custo fixo: 8 queries independente do nº de contas", async () => {
    const db = fakeDb(fixture());
    await listarMentorados({}, { supabase: db });
    assert.equal(db.__contador.queries, 8);
  });

  test("sem contas -> vazio", async () => {
    const { mentorados, total } = await listarMentorados({}, { supabase: fakeDb({}) });
    assert.equal(total, 0);
    assert.deepEqual(mentorados, []);
  });
});

describe("listarMentorados — exclui quem tem acesso ao Painel Administrativo", () => {
  test("acesso explícito e SuperAdmin não aparecem; acesso revogado volta a aparecer", async () => {
    const { mentorados } = await listarMentorados({}, { supabase: fakeDb(fixtureComAdmins()) });
    const emails = mentorados.map((m) => m.email);

    assert.ok(!emails.includes("gestor@ex.com"), "acesso explícito ao Painel Administrativo -> fora");
    assert.ok(!emails.includes("raiz@ex.com"), "SuperAdmin (bypass no requirePainelAdministrativo) -> fora");
    assert.ok(emails.includes("exgestor@ex.com"), "acesso revogado (ativo=false) -> mentorado normal");

    // os mentorados comuns continuam intactos
    assert.deepEqual(
      emails.filter((e) => e.endsWith("@ex.com")).sort(),
      ["ana@ex.com", "exgestor@ex.com", "joao@ex.com", "maria@ex.com"],
    );
  });

  test("o filtro é por CONTA, não por vínculo — vale com N empresas/unidades", async () => {
    const f = fixtureComAdmins();
    // gestor ganha mais vínculos (empresa + unidade); ainda assim não é mentorado
    f.usuarios_organizacoes.push({ usuario_id: uuid("gestor"), perfil_id: uuid("gestor"), organizacao_id: uuid("o2"), papel: "viewer", ativo: true });
    f.usuarios_unidades.push({ usuario_id: uuid("gestor"), perfil_id: uuid("gestor"), unidade_id: uuid("ua"), papel: null, ativo: true });
    const { mentorados } = await listarMentorados({}, { supabase: fakeDb(f) });
    assert.ok(!mentorados.some((m) => m.email === "gestor@ex.com"));
  });
});

// ---- Autorização da rota, Express real --------------------------------
function makeApp({ user, deps }) {
  const app = express();
  app.use((req, _res, next) => { if (user !== undefined) req.user = user; next(); });
  app.use("/administrativo", administrativoRouter);
  app.use(errorHandler);
  app.locals.adminDeps = deps;
  return app;
}
function GET(app, path) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      http.get({ host: "127.0.0.1", port, path }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => { server.close(); resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null }); });
      }).on("error", (e) => { server.close(); reject(e); });
    });
  });
}

describe("GET /administrativo/mentorados (autorização)", () => {
  const comum = { id: uuid("comum"), nome: "Comum", superadmin: false, painelAdministrativo: false };
  const gestor = { id: uuid("gestor"), nome: "Gestor", superadmin: false, painelAdministrativo: true };
  const root = { id: uuid("root"), nome: "Root", superadmin: true, painelAdministrativo: false };

  test("usuário comum -> 403", async () => {
    const app = makeApp({ user: comum, deps: { supabase: fakeDb(fixture()) } });
    assert.equal((await GET(app, "/administrativo/mentorados")).status, 403);
  });

  test("Painel Administrativo -> 200 com a lista consolidada", async () => {
    const app = makeApp({ user: gestor, deps: { supabase: fakeDb(fixture()) } });
    const r = await GET(app, "/administrativo/mentorados");
    assert.equal(r.status, 200);
    assert.equal(r.json.data.total, 3);
  });

  test("SuperAdmin -> 200 por bypass", async () => {
    const app = makeApp({ user: root, deps: { supabase: fakeDb(fixture()) } });
    assert.equal((await GET(app, "/administrativo/mentorados")).status, 200);
  });
});
