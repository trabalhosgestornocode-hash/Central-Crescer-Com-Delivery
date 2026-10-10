// Perfil de EXIBIÇÃO — isolamento no backend (sem banco).
//
// A pergunta: um computador de TV com a conta de exibição consegue chamar QUALQUER coisa além do Checklist da sua
// unidade? Aqui a resposta é medida rota por rota, com os routers REAIS do tenant (ver helpers/rotas-tenant.js):
//
//   * o bloqueio `restringirPerfilExibicao` nega tudo, exceto GET /checklist-operacional/resumo e a credencial de
//     Realtime — inclusive rota futura que esqueça de exigir permissão;
//   * o CONTROLE prova que só a permissão NÃO basta: sem o bloqueio, o perfil (que só tem checklist.visualizar)
//     ainda alcançaria rotas que hoje só exigem módulo + contexto. Por isso o bloqueio existe;
//   * os demais papéis passam pelo bloqueio sem nenhuma diferença;
//   * a credencial de Realtime do perfil autoriza só o canal da UNIDADE (nunca o da empresa).
process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  restringirPerfilExibicao, rotaPermitidaAoPerfilExibicao, ROTAS_PERFIL_EXIBICAO,
} from "../src/middlewares/perfilExibicao.js";
import { PAPEL_EXIBICAO } from "../src/shared/permissoes.js";
import { parametrosGrantDoRequest } from "../src/modules/realtime/realtime.controller.js";
import { renovarGrantsRealtime } from "../src/modules/realtime/realtime.grants.service.js";
import {
  MONTAGENS_TENANT, prefixosMontadosEmRoutesJs, todasAsRotasDoTenant, montarAppDeIsolamento, chamarStatus,
} from "./helpers/rotas-tenant.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const UNI = "bbbbbbbb-0000-4000-8000-0000000000b1";

describe("bloqueio do perfil de exibição — função pura", () => {
  const casos = [
    // [método, caminho, esperado]
    ["GET", "/checklist-operacional/resumo", true],
    ["POST", "/realtime/credencial", true],
    ["HEAD", "/checklist-operacional/resumo", true],              // HEAD cai no handler do GET
    ["get", "/checklist-operacional/resumo", true],
    ["GET", "/checklist-operacional/resumo/", true],              // barra final: o Express roteia para o MESMO handler
    ["GET", "/CHECKLIST-OPERACIONAL/RESUMO", true],               // caixa: idem
    // métodos errados para as rotas permitidas
    ["POST", "/checklist-operacional/resumo", false],
    ["PUT", "/checklist-operacional/resumo", false],
    ["PATCH", "/checklist-operacional/resumo", false],
    ["DELETE", "/checklist-operacional/resumo", false],
    ["GET", "/realtime/credencial", false],
    ["DELETE", "/realtime/credencial", false],
    // caminhos parecidos, mas diferentes
    ["GET", "/checklist-operacional", false],
    ["GET", "/checklist-operacional/", false],
    ["GET", "/checklist-operacional/resumo/extra", false],
    ["GET", "/checklist-operacional/resumo/../vendas/visao-geral", false],
    ["GET", "/checklist-operacional/./resumo", false],
    ["GET", "/checklist-operacional//resumo", false],
    ["GET", "//checklist-operacional/resumo", false],
    ["GET", "/checklist-operacional/resumo%2f..%2fvendas", false],
    ["GET", "/checklist-operacional/%72esumo", false],            // codificado: não é a rota permitida
    ["GET", "/checklist-operacional/resumo;x=1", false],
    ["GET", "/checklist-operacional/resumo.json", false],
    ["GET", "/checklist-operacionalx/resumo", false],
    ["GET", "/x/checklist-operacional/resumo", false],
    ["GET", "/realtime", false],
    ["GET", "", false],
    ["GET", "/", false],
    // o que o perfil NUNCA pode chamar
    ["GET", "/vendas/visao-geral", false],
    ["POST", "/vendas/importar", false],
    ["GET", "/produtos", false],
    ["GET", "/cmv", false],
    ["GET", "/dashboard-executivo/mes", false],
    ["GET", "/bonificacao-mensal/mes", false],
    ["GET", "/parser-food-delivery/periodo", false],
    ["GET", "/usuarios", false],
    ["GET", "/unidade/tabelas-comerciais", false],
    ["GET", "/integracoes/ifood/pedidos", false],
    ["GET", "/integracoes/ifood/status", false],
    ["POST", "/agente/mensagem", false],
    ["GET", "/inteligencia/integracoes", false],
  ];
  for (const [metodo, caminho, esperado] of casos) {
    test(`${metodo} ${JSON.stringify(caminho)} -> ${esperado ? "permitido" : "negado"}`, () => {
      assert.equal(rotaPermitidaAoPerfilExibicao(metodo, caminho), esperado);
    });
  }

  test("a lista é EXATAMENTE estas duas rotas (qualquer rota nova exige decisão consciente aqui)", () => {
    assert.deepEqual(ROTAS_PERFIL_EXIBICAO.map((r) => `${r.metodo} ${r.caminho}`), ["GET /checklist-operacional/resumo", "POST /realtime/credencial"]);
    assert.ok(Object.isFrozen(ROTAS_PERFIL_EXIBICAO));
  });
});

describe("bloqueio do perfil de exibição — middleware", () => {
  const rodar = (papel, metodo, path) => {
    let resultado = "next";
    restringirPerfilExibicao({ acesso: papel ? { papel } : undefined, method: metodo, path }, {}, (e) => { if (e) resultado = e; });
    return resultado;
  };

  test("papel de exibição em rota não permitida: 403 (ApiError) com mensagem genérica", () => {
    const e = rodar(PAPEL_EXIBICAO, "GET", "/vendas/visao-geral");
    assert.equal(e.statusCode, 403);
    assert.match(e.message, /Permissão insuficiente/);
    assert.doesNotMatch(e.message, /vendas|exib/i, "a mensagem não revela o que existe nem o motivo");
  });

  test("papel de exibição em rota permitida: passa", () => {
    assert.equal(rodar(PAPEL_EXIBICAO, "GET", "/checklist-operacional/resumo"), "next");
    assert.equal(rodar(PAPEL_EXIBICAO, "POST", "/realtime/credencial"), "next");
  });

  test("os OUTROS papéis passam em qualquer rota (o bloqueio só atua sobre o papel de exibição)", () => {
    for (const papel of ["organization_admin", "unit_manager", "finance", "operations", "viewer", "papel_qualquer"]) {
      for (const [m, p] of [["GET", "/vendas/visao-geral"], ["POST", "/vendas/importar"], ["DELETE", "/usuarios/x"], ["GET", "/qualquer"]]) {
        assert.equal(rodar(papel, m, p), "next", `${papel} ${m} ${p}`);
      }
    }
  });

  test("sem contexto (req.acesso ausente) não decide nada — quem barra é o requireContexto, que vem antes", () => {
    assert.equal(rodar(undefined, "GET", "/vendas/visao-geral"), "next");
  });
});

describe("matriz de isolamento — routers REAIS do tenant", () => {
  test("trava de cobertura: todo router montado em routes.js está na matriz (e vice-versa)", () => {
    const emRoutes = prefixosMontadosEmRoutesJs().sort();
    const naMatriz = MONTAGENS_TENANT.map(([p]) => p).sort();
    assert.deepEqual(emRoutes, naMatriz, "router novo em routes.js: inclua em MONTAGENS_TENANT (test/helpers/rotas-tenant.js)");
    assert.ok(todasAsRotasDoTenant().length >= 100, "a matriz enumerou rotas de verdade");
  });

  test("routes.js liga o bloqueio logo depois do requireContexto e ANTES de qualquer router de módulo", () => {
    const src = readFileSync(join(aqui, "..", "src", "routes.js"), "utf8");
    const iCtx = src.indexOf("tenant.use(requireContexto)");
    const iBloqueio = src.indexOf("tenant.use(restringirPerfilExibicao)");
    const iPrimeiro = src.indexOf('tenant.use("/produtos"');
    assert.ok(iCtx >= 0 && iBloqueio > iCtx && iPrimeiro > iBloqueio, "ordem: requireContexto -> restringirPerfilExibicao -> módulos");
    assert.match(src, /import \{ restringirPerfilExibicao \} from "\.\/middlewares\/perfilExibicao\.js"/);
  });

  describe("com o bloqueio ligado", () => {
    let server;
    before(async () => {
      const app = montarAppDeIsolamento({ papel: PAPEL_EXIBICAO, antes: restringirPerfilExibicao, unidade: null });
      server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    });
    after(() => server.close());

    test("TODA rota do tenant, exceto as duas permitidas, responde 403 ao perfil de exibição", async () => {
      const rotas = todasAsRotasDoTenant();
      const permitidas = new Set(["GET /checklist-operacional/resumo", "POST /realtime/credencial"]);
      const naoPermitidas = rotas.filter((r) => !permitidas.has(`${r.metodo} ${r.modelo}`));
      assert.ok(naoPermitidas.length >= 100);
      const falhas = [];
      for (const r of naoPermitidas) {
        const st = await chamarStatus(server, r);
        if (st !== 403) falhas.push(`${st} ${r.metodo} ${r.modelo}`);
      }
      assert.deepEqual(falhas, [], "rota alcançável pelo perfil de exibição");
    });

    test("as duas rotas permitidas passam do bloqueio (e do requirePermissao do Checklist)", async () => {
      // Sem unidade no contexto o Checklist responde 400 ("selecione a unidade") — já depois de autorizado.
      assert.equal(await chamarStatus(server, { metodo: "GET", caminho: "/checklist-operacional/resumo" }), 400);
      const cred = await chamarStatus(server, { metodo: "POST", caminho: "/realtime/credencial" });
      assert.notEqual(cred, 403); assert.notEqual(cred, 401);
    });

    test("as rotas permitidas só aceitam o MÉTODO permitido", async () => {
      for (const r of [{ metodo: "POST", caminho: "/checklist-operacional/resumo" }, { metodo: "DELETE", caminho: "/checklist-operacional/resumo" },
        { metodo: "GET", caminho: "/realtime/credencial" }]) {
        assert.equal(await chamarStatus(server, r), 403, `${r.metodo} ${r.caminho}`);
      }
    });

    test("caminhos disfarçados não passam (403, nunca chegam a um módulo)", async () => {
      for (const caminho of ["/vendas/visao-geral", "/checklist-operacional/resumo/../../vendas/visao-geral", "/checklist-operacional/%2e%2e/vendas",
        "//vendas/visao-geral", "/checklist-operacional/resumo%2f..%2f..%2fvendas%2fvisao-geral", "/produtos?x=/checklist-operacional/resumo"]) {
        assert.equal(await chamarStatus(server, { metodo: "GET", caminho }), 403, caminho);
      }
    });
  });

  describe("CONTROLE — sem o bloqueio, só a permissão NÃO protege", () => {
    // Rotas que respondem rápido (sem esperar banco). Hoje elas só exigem módulo + contexto no roteador.
    const ROTAS_RAPIDAS = [
      { metodo: "GET", caminho: "/inteligencia/integracoes" },
      { metodo: "POST", caminho: "/agente/mensagem" },
      { metodo: "POST", caminho: "/vendas/importar" },
      { metodo: "POST", caminho: "/vendas/vincular" },
    ];

    test("perfil de exibição SEM o bloqueio alcança rotas fora do Checklist (prova de que o bloqueio é necessário)", async () => {
      const app = montarAppDeIsolamento({ papel: PAPEL_EXIBICAO });
      const s = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
      try {
        const alcancadas = [];
        for (const r of ROTAS_RAPIDAS) if ((await chamarStatus(s, r)) !== 403) alcancadas.push(`${r.metodo} ${r.caminho}`);
        assert.ok(alcancadas.length >= 3, `só a permissão não bloqueou: ${alcancadas.join(", ")}`);
      } finally { s.close(); }
    });

    test("COM o bloqueio, as mesmas rotas dão 403 para o perfil de exibição", async () => {
      const app = montarAppDeIsolamento({ papel: PAPEL_EXIBICAO, antes: restringirPerfilExibicao });
      const s = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
      try {
        for (const r of ROTAS_RAPIDAS) assert.equal(await chamarStatus(s, r), 403, `${r.metodo} ${r.caminho}`);
      } finally { s.close(); }
    });

    test("o bloqueio NÃO muda nada para os demais papéis (viewer responde igual com e sem ele)", async () => {
      const [a, b] = [montarAppDeIsolamento({ papel: "viewer" }), montarAppDeIsolamento({ papel: "viewer", antes: restringirPerfilExibicao })];
      const [sa, sb] = await Promise.all([a, b].map((app) => new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); })));
      try {
        for (const r of ROTAS_RAPIDAS) assert.equal(await chamarStatus(sb, r), await chamarStatus(sa, r), `${r.metodo} ${r.caminho}`);
        // e o viewer realmente alcança as rotas (200/400), não 403
        assert.notEqual(await chamarStatus(sb, ROTAS_RAPIDAS[0]), 403);
      } finally { sa.close(); sb.close(); }
    });
  });
});

describe("Realtime — a credencial do perfil de exibição só autoriza o canal da UNIDADE", () => {
  const reqDe = (papel, unidadeId = UNI) => ({
    user: { id: "u1" }, acesso: { sessionId: "s1", papel }, tenant: { organizacaoId: ORG, unidadeId },
    body: { organizacaoId: "outra", unidadeId: "outra", topicos: ["empresa:outra"] }, query: { unidadeId: "outra" },
  });

  /** Banco falso: registra o que seria gravado/apagado em realtime_channel_grants. */
  const dbFalso = () => {
    const reg = { upserts: [], deletes: [] };
    return {
      reg,
      from: () => ({
        upsert: async (linhas) => { reg.upserts.push(...linhas); return { error: null }; },
        delete: () => { const cadeia = { eq: () => cadeia, not: (...a) => { reg.deletes.push(a); return cadeia; }, then: (ok) => ok({ error: null }) }; return cadeia; },
      }),
    };
  };

  test("parâmetros do grant: o perfil de exibição ganha somenteUnidade; os demais não (e nada vem do corpo/query)", () => {
    const p = parametrosGrantDoRequest(reqDe(PAPEL_EXIBICAO));
    assert.deepEqual(p, { usuarioId: "u1", sessaoContextoId: "s1", organizacaoId: ORG, unidadeId: UNI, somenteUnidade: true });
    for (const papel of ["organization_admin", "unit_manager", "viewer"]) {
      assert.deepEqual(parametrosGrantDoRequest(reqDe(papel)), { usuarioId: "u1", sessaoContextoId: "s1", organizacaoId: ORG, unidadeId: UNI });
    }
  });

  test("grants gravados: exibição = só unidade:<id>; gestor = empresa + unidade", async () => {
    const d1 = dbFalso();
    const r1 = await renovarGrantsRealtime(parametrosGrantDoRequest(reqDe(PAPEL_EXIBICAO)), { db: d1 });
    assert.deepEqual(r1.topicos, [`unidade:${UNI}`]);
    assert.deepEqual(d1.reg.upserts.map((l) => l.topico), [`unidade:${UNI}`]);
    assert.ok(!d1.reg.upserts.some((l) => l.topico.startsWith("empresa:")), "nenhum grant do canal da empresa");

    const d2 = dbFalso();
    const r2 = await renovarGrantsRealtime(parametrosGrantDoRequest(reqDe("unit_manager")), { db: d2 });
    assert.deepEqual(r2.topicos, [`empresa:${ORG}`, `unidade:${UNI}`], "comportamento dos demais papéis intacto");
  });

  test("exibição sem unidade no contexto: nenhum canal", async () => {
    const d = dbFalso();
    const r = await renovarGrantsRealtime(parametrosGrantDoRequest(reqDe(PAPEL_EXIBICAO, null)), { db: d });
    assert.deepEqual(r.topicos, []);
    assert.deepEqual(d.reg.upserts, []);
  });
});
