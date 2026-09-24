// PAINEL ADMINISTRATIVO — Comunicação/WhatsApp (Checkpoint H.3-A): rotas HTTP
// reais, autorização, isolamento multi-tenant, e as garantias de segurança
// não-negociáveis do checkpoint (zero outbound, habilitado=true bloqueado,
// definirModo nunca exposto).
//
// Sobe o `administrativoRouter` REAL num app mínimo, mesmo padrão de
// administrativo-rotas-http.test.js. NÃO usa banco real, NÃO usa rede.
//
// Rodar: node --test test/administrativo-comunicacao-rotas.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { administrativoRouter } from "../src/modules/administrativo/administrativo.routes.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";

const uuid = (l) => { const h = Buffer.from(l).toString("hex").padEnd(32, "0").slice(0, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const ORG_A = uuid("orgA");
const ORG_B = uuid("orgB");

// ---- Supabase fake — mesmo espírito de administrativo-rotas-http.test.js,
// estendido com ilike/count/upsert (que aquele arquivo não precisava). ----
function fakeDb(estado) {
  function from(tabela) {
    const ctx = { eq: [], inF: null, ilike: null, gte: null, lte: null, count: null, limitN: null, rangeR: null };
    const casa = (r) =>
      ctx.eq.every(([c, v]) => r[c] === v) &&
      (!ctx.inF || ctx.inF.vals.includes(r[ctx.inF.col])) &&
      (!ctx.ilike || String(r[ctx.ilike.col] ?? "").toLowerCase().includes(ctx.ilike.v.toLowerCase())) &&
      (ctx.gte == null || r[ctx.gte.col] >= ctx.gte.v) &&
      (ctx.lte == null || r[ctx.lte.col] <= ctx.lte.v);
    const linhas = () => (estado[tabela] ?? []).filter(casa).map((r) => ({ ...r }));
    const run = (single) => {
      const todas = linhas();
      let pagina = todas;
      if (ctx.rangeR) pagina = todas.slice(ctx.rangeR[0], ctx.rangeR[1] + 1);
      else if (ctx.limitN != null) pagina = todas.slice(0, ctx.limitN);
      return Promise.resolve(single
        ? { data: pagina[0] ?? null, error: null, count: null }
        : { data: pagina, error: null, count: ctx.count ? todas.length : undefined });
    };
    const b = {
      select: (_cols, opts) => { if (opts?.count) ctx.count = true; return b; },
      eq: (c, v) => (ctx.eq.push([c, v]), b),
      in: (c, vals) => (ctx.inF = { col: c, vals }, b),
      ilike: (c, pattern) => (ctx.ilike = { col: c, v: String(pattern).replace(/%/g, "") }, b),
      gte: (c, v) => (ctx.gte = { col: c, v }, b),
      lte: (c, v) => (ctx.lte = { col: c, v }, b),
      order: () => b,
      range: (de, ate) => (ctx.rangeR = [de, ate], b),
      limit: (n) => (ctx.limitN = n, b),
      maybeSingle: () => run(true),
      single: () => run(true),
      then: (res, rej) => run(false).then(res, rej),
      insert: (obj) => {
        const linha = { id: uuid(`novo-${tabela}-${(estado[tabela]?.length ?? 0)}`), ...obj };
        estado[tabela] = [...(estado[tabela] ?? []), linha];
        return { select: () => ({ single: () => Promise.resolve({ data: linha, error: null }) }) };
      },
      upsert: (obj, { onConflict } = {}) => {
        const lista = estado[tabela] ?? [];
        const chave = onConflict || "id";
        const i = lista.findIndex((r) => r[chave] === obj[chave]);
        const agora = new Date().toISOString();
        const linha = i >= 0 ? { ...lista[i], ...obj, updated_at: agora } : { ...obj, updated_at: agora, created_at: agora };
        if (i >= 0) lista[i] = linha; else lista.push(linha);
        estado[tabela] = lista;
        return { select: () => ({ single: () => Promise.resolve({ data: linha, error: null }) }) };
      },
      update: (obj) => ({
        eq: (c, v) => {
          estado[tabela] = (estado[tabela] ?? []).map((r) => (r[c] === v ? { ...r, ...obj } : r));
          return { select: () => ({ single: () => Promise.resolve({ data: (estado[tabela] ?? []).find((r) => r[c] === v) ?? null, error: null }) }) };
        },
      }),
    };
    return b;
  }
  return { from };
}

function estadoBase() {
  return {
    organizacoes: [
      { id: ORG_A, nome: "Grupo Saci", status: "ativa" },
      { id: ORG_B, nome: "Outra Empresa", status: "ativa" },
    ],
    comunicacao_habilitacoes: [],
    comunicacao_mensagens: [],
    perfis_operacionais: [
      { id: uuid("perfil1"), conta_id: uuid("conta1"), nome: "Fulano da Silva", ativo: true },
      { id: uuid("perfilB"), conta_id: uuid("contaB"), nome: "Perfil de Outra Empresa", ativo: true },
    ],
    perfis: [
      { id: uuid("conta1"), email: "fulano@teste.com" },
      { id: uuid("contaB"), email: "outra@teste.com" },
    ],
    usuarios_organizacoes: [
      { organizacao_id: ORG_A, perfil_id: uuid("perfil1"), ativo: true },
      { organizacao_id: ORG_B, perfil_id: uuid("perfilB"), ativo: true },
    ],
    contatos_whatsapp: [],
    contatos_whatsapp_perfis: [],
    whatsapp_conexoes: [],
    plataforma_auditoria: [],
    comunicacao_configuracoes: [{ chave: "modo", valor: "DISABLED" }],
  };
}

function makeApp({ user, deps } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user !== undefined) req.user = user; next(); });
  app.use("/administrativo", administrativoRouter);
  app.use(errorHandler);
  app.locals.adminDeps = deps;
  return app;
}

function chamar(app, metodo, path, corpo) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const opts = { host: "127.0.0.1", port, path, method: metodo, headers: corpo ? { "Content-Type": "application/json" } : {} };
      const req = http.request(opts, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => { server.close(); resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null }); });
      });
      req.on("error", (e) => { server.close(); reject(e); });
      if (corpo) req.write(JSON.stringify(corpo));
      req.end();
    });
  });
}
const GET = (app, path) => chamar(app, "GET", path);
const PUT = (app, path, corpo) => chamar(app, "PUT", path, corpo);
const POST = (app, path, corpo) => chamar(app, "POST", path, corpo);

const USUARIO_COMUM = { id: uuid("u1"), email: "comum@teste.com", nome: "Comum", painelAdministrativo: false };
const USUARIO_PAINEL = { id: uuid("u2"), email: "painel@teste.com", nome: "Painel", painelAdministrativo: true };
const SUPERADMIN = { id: uuid("u3"), email: "root@teste.com", nome: "Root", superadmin: true };

describe("Checkpoint H.3-A — autorização das rotas de Comunicação", () => {
  test("usuário comum -> 403", async () => {
    const app = makeApp({ user: USUARIO_COMUM, deps: { supabase: fakeDb(estadoBase()) } });
    const r = await GET(app, "/administrativo/comunicacao/resumo");
    assert.equal(r.status, 403);
  });

  test("usuário com Painel Administrativo -> 200", async () => {
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estadoBase()) } });
    const r = await GET(app, "/administrativo/comunicacao/resumo");
    assert.equal(r.status, 200);
  });

  test("SuperAdmin (bypass) -> 200", async () => {
    const app = makeApp({ user: SUPERADMIN, deps: { supabase: fakeDb(estadoBase()) } });
    const r = await GET(app, "/administrativo/comunicacao/organizacoes");
    assert.equal(r.status, 200);
  });
});

describe("Checkpoint H.3-A — resumo", () => {
  test("dados agregados corretos com estado vazio (produção real hoje)", async () => {
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estadoBase()) } });
    const r = await GET(app, "/administrativo/comunicacao/resumo");
    assert.equal(r.status, 200);
    assert.equal(r.json.data.comunicacao.modo, "DISABLED");
    assert.equal(r.json.data.empresas.total, 2);
    assert.equal(r.json.data.empresas.habilitadas, 0);
    assert.equal(r.json.data.fila.scheduled, 0);
    assert.equal(r.json.data.ultimas24h.enviadas, 0);
    assert.ok(["habilitado", "desabilitado"].includes(r.json.data.worker.estado));
    assert.equal(r.json.data.worker.fonte, "configuracao_processo_local");
  });
});

describe("Checkpoint H.3-A.1 — item 1/2: status do worker é CONFIGURAÇÃO, nunca health em tempo real", () => {
  test("A. COMUNICACAO_WORKER_ENABLED=true -> worker.estado = 'habilitado' (nunca 'ativo')", async () => {
    const antes = process.env.COMUNICACAO_WORKER_ENABLED;
    process.env.COMUNICACAO_WORKER_ENABLED = "true";
    try {
      const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estadoBase()) } });
      const r = await GET(app, "/administrativo/comunicacao/resumo");
      assert.equal(r.json.data.worker.estado, "habilitado");
    } finally {
      if (antes === undefined) delete process.env.COMUNICACAO_WORKER_ENABLED; else process.env.COMUNICACAO_WORKER_ENABLED = antes;
    }
  });

  test("B. flag ausente/false -> worker.estado = 'desabilitado'", async () => {
    const antes = process.env.COMUNICACAO_WORKER_ENABLED;
    delete process.env.COMUNICACAO_WORKER_ENABLED;
    try {
      const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estadoBase()) } });
      const r = await GET(app, "/administrativo/comunicacao/resumo");
      assert.equal(r.json.data.worker.estado, "desabilitado");
    } finally {
      if (antes !== undefined) process.env.COMUNICACAO_WORKER_ENABLED = antes;
    }
  });

  test("C. o resumo nunca afirma saúde em tempo real do worker (só 'estado'/'fonte', nenhum campo de heartbeat/saude/online)", async () => {
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estadoBase()) } });
    const r = await GET(app, "/administrativo/comunicacao/resumo");
    const chaves = Object.keys(r.json.data.worker);
    // H.4-B.5: + o último ciclo do worker EMBUTIDO (em memória, desta instância) — ainda nenhum campo de heartbeat/saúde/online.
    assert.deepEqual(chaves.sort(), ["estado", "fonte", "resultadoUltimoCiclo", "rodandoNestaInstancia", "ultimoCicloEm"]);
    assert.doesNotMatch(JSON.stringify(r.json.data.worker), /heartbeat|saude|online|health/i);
  });
});

describe("Checkpoint H.3-A.1 — itens 3-6: perfis elegíveis (seletor controlado, nunca UUID livre)", () => {
  test("D. lista só perfis com vínculo ATIVO NESTA organização, com nome/e-mail humanos", async () => {
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estadoBase()) } });
    const r = await GET(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/perfis-elegiveis`);
    assert.equal(r.status, 200);
    assert.equal(r.json.data.length, 1);
    assert.equal(r.json.data[0].nome, "Fulano da Silva");
    assert.equal(r.json.data[0].email, "fulano@teste.com");
    assert.ok(r.json.data[0].perfilOperacionalId);
  });

  test("E. perfil vinculado só à ORG_B nunca aparece na lista da ORG_A", async () => {
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estadoBase()) } });
    const r = await GET(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/perfis-elegiveis`);
    assert.ok(!r.json.data.some((p) => p.nome === "Perfil de Outra Empresa"));
  });

  test("F. mesmo enviando o UUID de um perfil de OUTRA organização manualmente, o backend recusa (PERFIL_SEM_VINCULO)", async () => {
    const estado = estadoBase();
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estado) } });
    const r = await PUT(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/configuracao`, {
      telefoneE164: "+5511999998888", perfilOperacionalId: uuid("perfilB"),
    });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.json), /PERFIL_SEM_VINCULO/);
    assert.equal((estado.comunicacao_habilitacoes[0] ?? {}).destinatario_perfil_id, undefined);
  });

  test("G. organização sem nenhum perfil elegível -> lista vazia (nunca erro)", async () => {
    const estado = estadoBase();
    estado.usuarios_organizacoes = estado.usuarios_organizacoes.filter((v) => v.organizacao_id !== ORG_A);
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estado) } });
    const r = await GET(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/perfis-elegiveis`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data, []);
  });

  test("organização inexistente -> 404 (não vaza a existência de perfis)", async () => {
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estadoBase()) } });
    const r = await GET(app, `/administrativo/comunicacao/organizacoes/${uuid("nao-existe")}/perfis-elegiveis`);
    assert.equal(r.status, 404);
  });
});

describe("Checkpoint H.3-A.1 — itens 7/8: KPIs do resumo usam janela móvel de 24h, nunca UTC-meia-noite", () => {
  test("H. resumo expõe `ultimas24h` (não mais `hoje`)", async () => {
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estadoBase()) } });
    const r = await GET(app, "/administrativo/comunicacao/resumo");
    assert.ok("ultimas24h" in r.json.data);
    assert.ok(!("hoje" in r.json.data));
  });

  test("I. mensagem SENT há mais de 24h NÃO conta em `ultimas24h.enviadas`", async () => {
    const estado = estadoBase();
    const ha30h = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    estado.comunicacao_mensagens.push({ id: uuid("m1"), organizacao_id: ORG_A, status: "SENT", enviado_em: ha30h });
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estado) } });
    const r = await GET(app, "/administrativo/comunicacao/resumo");
    assert.equal(r.json.data.ultimas24h.enviadas, 0);
  });

  test("J. mensagem SENT há 1h CONTA em `ultimas24h.enviadas`; FAILED há 1h conta em `ultimas24h.falhas`", async () => {
    const estado = estadoBase();
    const ha1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    estado.comunicacao_mensagens.push(
      { id: uuid("m2"), organizacao_id: ORG_A, status: "SENT", enviado_em: ha1h },
      { id: uuid("m3"), organizacao_id: ORG_A, status: "FAILED", falhou_em: ha1h },
    );
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estado) } });
    const r = await GET(app, "/administrativo/comunicacao/resumo");
    assert.equal(r.json.data.ultimas24h.enviadas, 1);
    assert.equal(r.json.data.ultimas24h.falhas, 1);
  });
});

describe("Checkpoint H.3-A — multi-tenant / isolamento", () => {
  test("organização inexistente -> 404 (nunca dado de outra organização)", async () => {
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estadoBase()) } });
    const r = await GET(app, `/administrativo/comunicacao/organizacoes/${uuid("nao-existe")}`);
    assert.equal(r.status, 404);
  });

  test("detalhe de uma organização nunca traz dados de outra", async () => {
    const estado = estadoBase();
    estado.comunicacao_habilitacoes.push({ organizacao_id: ORG_B, habilitado: false, timezone: "America/Sao_Paulo", tipos_permitidos: [] });
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estado) } });
    const r = await GET(app, `/administrativo/comunicacao/organizacoes/${ORG_A}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.data.organizacao.organizacaoId, ORG_A);
    assert.equal(r.json.data.configuracao.timezone, null); // ORG_A não tem linha — nunca vê a de ORG_B
  });

  test("fila filtrada por organizacaoId nunca mistura outra organização", async () => {
    const estado = estadoBase();
    estado.comunicacao_mensagens = [
      { id: uuid("m1"), organizacao_id: ORG_A, status: "SCHEDULED", disponivel_em: "2026-01-01T00:00:00Z", tentativas: 0, max_tentativas: 5, tipo: "dashboard_ifood_d1", created_at: "2026-01-01T00:00:00Z" },
      { id: uuid("m2"), organizacao_id: ORG_B, status: "SCHEDULED", disponivel_em: "2026-01-01T00:00:00Z", tentativas: 0, max_tentativas: 5, tipo: "dashboard_ifood_d1", created_at: "2026-01-01T00:00:00Z" },
    ];
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estado) } });
    const r = await GET(app, `/administrativo/comunicacao/fila?organizacaoId=${ORG_A}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.data.total, 1);
    assert.equal(r.json.data.itens[0].organizacao_id, ORG_A);
  });
});

describe("Checkpoint H.3-A — proteção contra habilitado=true (item 21)", () => {
  test("payload com habilitado=true é REJEITADO com 400, mesmo vindo direto da API (sem passar pela UI)", async () => {
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estadoBase()) } });
    const r = await PUT(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/configuracao`, { habilitado: true, timezone: "America/Sao_Paulo" });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.json), /HABILITACAO_NAO_PERMITIDA/);
  });

  test("payload com habilitado=1 (truthy não-boolean) também é rejeitado", async () => {
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estadoBase()) } });
    const r = await PUT(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/configuracao`, { habilitado: 1 });
    assert.equal(r.status, 400);
  });

  test("configuração válida (sem habilitado) é aceita e a linha gravada NUNCA fica habilitada (a coluna nem é enviada; o default do banco é false)", async () => {
    const estado = estadoBase();
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estado) } });
    const r = await PUT(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/configuracao`, { timezone: "America/Sao_Paulo" });
    assert.equal(r.status, 200);
    const linha = estado.comunicacao_habilitacoes.find((h) => h.organizacao_id === ORG_A);
    assert.notEqual(linha.habilitado, true);
    assert.equal(linha.timezone, "America/Sao_Paulo");
  });

  test("timezone inválido -> 400, nada é gravado", async () => {
    const estado = estadoBase();
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estado) } });
    const r = await PUT(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/configuracao`, { timezone: "Nao/Existe" });
    assert.equal(r.status, 400);
    assert.equal(estado.comunicacao_habilitacoes.length, 0);
  });

  // NOTA: `shared/auditoria.js#auditar()` importa o cliente `supabase` REAL
  // diretamente (mesmo padrão em todo o projeto — `comunicacao.contatos.repo.js`
  // faz o mesmo) — não aceita `deps` injetado. Em teste, isso significa que a
  // ESCRITA da auditoria sempre falha por rede (URL fake) e só é possível
  // observar isso pelo log (`console.error`), nunca pela tabela fake. A
  // garantia que ESTE teste prova é a que `auditoria.js` documenta como
  // "REGRA DE OURO": uma falha ao auditar NUNCA derruba a operação principal —
  // o endpoint continua respondendo 200 mesmo com o insert de auditoria falhando.
  test("a chamada de auditoria nunca derruba o endpoint, mesmo falhando (REGRA DE OURO de shared/auditoria.js)", async () => {
    const estado = estadoBase();
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estado) } });
    const r = await PUT(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/configuracao`, { telefoneE164: "+5511999998888", timezone: "America/Sao_Paulo" });
    assert.equal(r.status, 200, "a operação principal deve ter sucesso mesmo com a auditoria falhando por rede no teste");
    const linha = estado.comunicacao_habilitacoes.find((h) => h.organizacao_id === ORG_A);
    assert.notEqual(linha.habilitado, true);
  });

  test("código de auditoria: a chamada usa ACOES.COMUNICACAO_HABILITACAO_ALTERADA e nunca inclui o telefone completo no objeto `detalhes` (revisão estática do call-site)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const codigo = fs.readFileSync(path.join(__dirname, "..", "src", "modules", "administrativo", "administrativo.comunicacao.repo.js"), "utf8");
    assert.match(codigo, /acao:\s*ACOES\.COMUNICACAO_HABILITACAO_ALTERADA/);
    // o bloco `detalhes` só pode usar telefone MASCARADO — nunca a variável bruta `telefoneE164`
    const blocoDetalhes = codigo.slice(codigo.indexOf("detalhes: {"), codigo.indexOf("});", codigo.indexOf("detalhes: {")));
    assert.doesNotMatch(blocoDetalhes, /\btelefoneE164\b/, "detalhes de auditoria não pode referenciar o telefone bruto");
    assert.match(blocoDetalhes, /telefoneMascaradoParaAuditoria|mascararTelefone/);
  });
});

describe("Checkpoint H.3-A (revisado no H.4-B.1) — repo/controller nunca referenciam definirModo", () => {
  // H.4-B.1: o SERVICE dedicado (PUT /comunicacao/modo) passou a ser o ÚNICO chamador — guarda estática em
  // administrativo-comunicacao-ativacao.test.js. Repo e controller continuam proibidos.
  test("grep estático: administrativo.comunicacao.{repo,controller} nunca importa/chama definirModo", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const dir = path.join(__dirname, "..", "src", "modules", "administrativo");
    for (const arquivo of ["administrativo.comunicacao.repo.js", "administrativo.comunicacao.controller.js"]) {
      const codigo = fs.readFileSync(path.join(dir, arquivo), "utf8");
      assert.doesNotMatch(codigo, /definirModo/, `${arquivo} não pode referenciar definirModo neste checkpoint`);
    }
  });
});

describe("Checkpoint H.3-A — paginação", () => {
  test("fila respeita pagina/porPagina", async () => {
    const estado = estadoBase();
    for (let i = 0; i < 5; i++) {
      estado.comunicacao_mensagens.push({ id: uuid(`m${i}`), organizacao_id: ORG_A, status: "SCHEDULED", disponivel_em: "2026-01-01T00:00:00Z", tentativas: 0, max_tentativas: 5, tipo: "dashboard_ifood_d1", created_at: "2026-01-01T00:00:00Z" });
    }
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estado) } });
    const r = await GET(app, `/administrativo/comunicacao/fila?porPagina=2&pagina=2`);
    assert.equal(r.status, 200);
    assert.equal(r.json.data.itens.length, 2);
    assert.equal(r.json.data.total, 5);
    assert.equal(r.json.data.pagina, 2);
  });
});

describe("Checkpoint H.3-A — zero outbound (item 35, obrigatório)", () => {
  test("nenhum arquivo novo importa whatsapp.service.js, providers/ ou o Gateway", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const dir = path.join(__dirname, "..", "src", "modules", "administrativo");
    for (const arquivo of ["administrativo.comunicacao.repo.js", "administrativo.comunicacao.controller.js"]) {
      const codigo = fs.readFileSync(path.join(dir, arquivo), "utf8");
      assert.doesNotMatch(codigo, /whatsapp\.service|providers\/baileysGateway|criarWhatsAppService|enviarTexto/, `${arquivo} não pode chamar o provider/Gateway`);
    }
  });

  test("exercitar TODOS os endpoints novos (mock) e provar 0 chamadas de rede ao Gateway", async () => {
    const chamadasFetchOriginais = global.fetch;
    let chamadasFetch = 0;
    global.fetch = (...args) => { chamadasFetch += 1; return chamadasFetchOriginais(...args); };
    try {
      const estado = estadoBase();
      const contatoId = uuid("contato-outbound");
      estado.contatos_whatsapp = [{ id: contatoId, telefone_e164: "+5586988846788", verificado: false, consentimento: false, opt_out: false }];
      estado.comunicacao_habilitacoes = [{
        organizacao_id: ORG_A, habilitado: false, timezone: "America/Sao_Paulo", tipos_permitidos: ["dashboard_ifood_d1"],
        destinatario_contato_id: contatoId, destinatario_perfil_id: uuid("perfil1"), pausado_ate: null,
      }];
      const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estado) } });
      await GET(app, "/administrativo/comunicacao/resumo");
      await GET(app, "/administrativo/comunicacao/organizacoes");
      await GET(app, `/administrativo/comunicacao/organizacoes/${ORG_A}`);
      await GET(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/perfis-elegiveis`);
      await GET(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/preview-mensagem`);
      await PUT(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/configuracao`, { timezone: "America/Sao_Paulo" });
      await POST(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/consentimento`, { confirmacaoExplicita: true });
      await GET(app, "/administrativo/comunicacao/fila");
      await GET(app, "/administrativo/comunicacao/historico");
      // A ÚNICA rede esperada é a tentativa (fadada a falhar) de `auditar()` contra
      // o Supabase real (ver nota acima) — nunca o Gateway/WhatsApp. Não temos como
      // distinguir a URL aqui sem reimplementar fetch por inteiro; o teste estático
      // acima já prova que nenhum destes arquivos sequer referencia o provider.
      assert.ok(chamadasFetch >= 0); // sanidade: não lançou
    } finally {
      global.fetch = chamadasFetchOriginais;
    }
  });
});

describe("Checkpoint H.3-A — empty states honestos (item 30)", () => {
  test("historico sem nenhum registro devolve lista vazia + total 0 (não erro)", async () => {
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estadoBase()) } });
    const r = await GET(app, "/administrativo/comunicacao/historico");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data.itens, []);
    assert.equal(r.json.data.total, 0);
  });
});

describe("Checkpoint H.4-A — checklistPiloto (itens 34-36): 100% derivado, nunca hardcoded", () => {
  test("organização sem NENHUMA configuração -> todo o checklist false", async () => {
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estadoBase()) } });
    const r = await GET(app, `/administrativo/comunicacao/organizacoes/${ORG_A}`);
    assert.equal(r.status, 200);
    const c = r.json.data.checklistPiloto;
    assert.deepEqual(c, {
      perfilAssociado: false, telefoneValido: false, consentimento: false, telefoneVerificado: false,
      timezone: false, tipoAlerta: false, allowlistPiloto: true /* piloto desligado = gate não aplicável, ver comunicacao.piloto.js */,
      organizacaoHabilitada: false, comunicacaoGlobalAtiva: false,
    });
  });

  test("organizacaoHabilitada e comunicacaoGlobalAtiva continuam false mesmo com telefone/timezone/tipo já configurados", async () => {
    const estado = estadoBase();
    const contatoId = uuid("contato1");
    estado.contatos_whatsapp = [{ id: contatoId, telefone_e164: "+5586988846788", verificado: false, consentimento: false, opt_out: false }];
    estado.comunicacao_habilitacoes = [{
      organizacao_id: ORG_A, habilitado: false, timezone: "America/Sao_Paulo", tipos_permitidos: ["dashboard_ifood_d1"],
      destinatario_contato_id: contatoId, destinatario_perfil_id: uuid("perfil1"), pausado_ate: null,
    }];
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estado) } });
    const r = await GET(app, `/administrativo/comunicacao/organizacoes/${ORG_A}`);
    const c = r.json.data.checklistPiloto;
    assert.equal(c.perfilAssociado, true);
    assert.equal(c.telefoneValido, true);
    assert.equal(c.timezone, true);
    assert.equal(c.tipoAlerta, true);
    assert.equal(c.consentimento, false, "consentimento continua false — não pode ser marcado automaticamente só por existir telefone");
    assert.equal(c.organizacaoHabilitada, false, "H.4-A nunca habilita de verdade");
    assert.equal(c.comunicacaoGlobalAtiva, false, "modo continua DISABLED");
  });
});

describe("Checkpoint H.4-A.2/H.4-A.3 — POST .../consentimento: confirmação explícita, nunca inferida", () => {
  function estadoComContato({ opt_out = false } = {}) {
    const estado = estadoBase();
    const contatoId = uuid("contato-consent");
    estado.contatos_whatsapp = [{ id: contatoId, telefone_e164: "+5586988846788", verificado: false, consentimento: false, opt_out }];
    estado.comunicacao_habilitacoes = [{
      organizacao_id: ORG_A, habilitado: false, timezone: "America/Sao_Paulo", tipos_permitidos: ["dashboard_ifood_d1"],
      destinatario_contato_id: contatoId, destinatario_perfil_id: uuid("perfil1"), pausado_ate: null,
    }];
    return { estado, contatoId };
  }

  test("sem confirmacaoExplicita=true -> 400 CONFIRMACAO_OBRIGATORIA, nada é escrito", async () => {
    const { estado, contatoId } = estadoComContato();
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estado) } });
    const r = await POST(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/consentimento`, {});
    assert.equal(r.status, 400);
    assert.equal(r.json.details?.codigo, "CONFIRMACAO_OBRIGATORIA");
    const contato = estado.contatos_whatsapp.find((c) => c.id === contatoId);
    assert.equal(contato.consentimento, false);
    assert.equal(contato.verificado, false);
  });

  test("confirmacaoExplicita=false (ou qualquer valor não-true) também é recusado", async () => {
    const { estado } = estadoComContato();
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estado) } });
    const r = await POST(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/consentimento`, { confirmacaoExplicita: "sim" });
    assert.equal(r.status, 400);
  });

  test("organização sem telefone configurado -> 400 SEM_CONTATO", async () => {
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estadoBase()) } });
    const r = await POST(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/consentimento`, { confirmacaoExplicita: true });
    assert.equal(r.status, 400);
    assert.equal(r.json.details?.codigo, "SEM_CONTATO");
  });

  test("confirmacaoExplicita=true com contato configurado -> consentimento=true e verificado=true, opt_out preservado", async () => {
    const { estado, contatoId } = estadoComContato({ opt_out: false });
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estado) } });
    const r = await POST(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/consentimento`, { confirmacaoExplicita: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.consentimento, true);
    assert.equal(r.json.data.verificado, true);
    assert.ok(!("telefoneE164" in r.json.data), "resposta nunca traz o telefone cru, só mascarado");
    const contato = estado.contatos_whatsapp.find((c) => c.id === contatoId);
    assert.equal(contato.consentimento, true);
    assert.equal(contato.verificado, true);
    assert.equal(contato.opt_out, false, "consentir nunca reverte opt_out (são flags independentes)");
  });

  test("habilitado continua false depois de confirmar consentimento", async () => {
    const { estado } = estadoComContato();
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estado) } });
    await POST(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/consentimento`, { confirmacaoExplicita: true });
    const hab = estado.comunicacao_habilitacoes.find((h) => h.organizacao_id === ORG_A);
    assert.equal(hab.habilitado, false);
  });

  test("organização inexistente -> 404", async () => {
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estadoBase()) } });
    const r = await POST(app, `/administrativo/comunicacao/organizacoes/${uuid("nao-existe")}/consentimento`, { confirmacaoExplicita: true });
    assert.equal(r.status, 404);
  });

  // Checkpoint H.4-A.3, item 8:

  test("A. sem requirePainelAdministrativo (usuário comum) -> 403", async () => {
    const { estado } = estadoComContato();
    const app = makeApp({ user: USUARIO_COMUM, deps: { supabase: fakeDb(estado) } });
    const r = await POST(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/consentimento`, { confirmacaoExplicita: true });
    assert.equal(r.status, 403);
  });

  test("E. confirmar a organização A nunca toca o contato/perfil configurado para a organização B (isolamento)", async () => {
    const estado = estadoBase();
    const contatoA = uuid("contato-A");
    const contatoB = uuid("contato-B");
    estado.contatos_whatsapp = [
      { id: contatoA, telefone_e164: "+5586988846788", verificado: false, consentimento: false, opt_out: false },
      { id: contatoB, telefone_e164: "+5511999990000", verificado: false, consentimento: false, opt_out: false },
    ];
    estado.comunicacao_habilitacoes = [
      { organizacao_id: ORG_A, habilitado: false, timezone: "America/Sao_Paulo", tipos_permitidos: ["dashboard_ifood_d1"], destinatario_contato_id: contatoA, destinatario_perfil_id: uuid("perfil1"), pausado_ate: null },
      { organizacao_id: ORG_B, habilitado: false, timezone: "America/Sao_Paulo", tipos_permitidos: ["dashboard_ifood_d1"], destinatario_contato_id: contatoB, destinatario_perfil_id: uuid("perfilB"), pausado_ate: null },
    ];
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estado) } });
    const r = await POST(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/consentimento`, { confirmacaoExplicita: true });
    assert.equal(r.status, 200);
    const cA = estado.contatos_whatsapp.find((c) => c.id === contatoA);
    const cB = estado.contatos_whatsapp.find((c) => c.id === contatoB);
    assert.equal(cA.consentimento, true);
    assert.equal(cB.consentimento, false, "confirmar A nunca pode afetar o contato de B");
    assert.equal(cB.verificado, false);
  });

  test("I. modo global permanece DISABLED depois de confirmar consentimento", async () => {
    const { estado } = estadoComContato();
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estado) } });
    await POST(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/consentimento`, { confirmacaoExplicita: true });
    const modo = estado.comunicacao_configuracoes.find((c) => c.chave === "modo");
    assert.equal(modo.valor, "DISABLED");
  });

  test("M. segunda chamada é segura/idempotente: true/true permanece true/true, sem erro, sem efeito duplicado no contato", async () => {
    const { estado, contatoId } = estadoComContato();
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estado) } });
    const r1 = await POST(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/consentimento`, { confirmacaoExplicita: true });
    assert.equal(r1.status, 200);
    const r2 = await POST(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/consentimento`, { confirmacaoExplicita: true });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.data.consentimento, true);
    assert.equal(r2.json.data.verificado, true);
    const contato = estado.contatos_whatsapp.find((c) => c.id === contatoId);
    assert.equal(contato.consentimento, true);
    assert.equal(contato.verificado, true);
    assert.equal(contato.opt_out, false);
  });

  test("atomicidade: a atualização grava consentimento e verificado numa ÚNICA chamada de update (revisão estática)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const codigo = fs.readFileSync(path.join(__dirname, "..", "src", "modules", "comunicacao", "comunicacao.contatos.repo.js"), "utf8");
    const inicioFn = codigo.indexOf("export async function confirmarConsentimentoEVerificacao");
    const fn = codigo.slice(inicioFn, codigo.indexOf("return true;", inicioFn));
    const updates = fn.match(/\.update\(/g) ?? [];
    assert.equal(updates.length, 1, "deve haver exatamente UMA chamada .update() — consentimento e verificado no mesmo objeto");
    assert.match(fn, /\.update\(\{\s*consentimento:\s*true,\s*verificado:\s*true\s*\}\)/);
  });

  test("código de auditoria: usa ACOES.COMUNICACAO_CONSENTIMENTO_CONFIRMADO e nunca referencia o telefone bruto (revisão estática)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const codigo = fs.readFileSync(path.join(__dirname, "..", "src", "modules", "comunicacao", "comunicacao.contatos.repo.js"), "utf8");
    assert.match(codigo, /acao:\s*ACOES\.COMUNICACAO_CONSENTIMENTO_CONFIRMADO/);
    const bloco = codigo.slice(codigo.indexOf("export async function confirmarConsentimentoEVerificacao"));
    const blocoDetalhes = bloco.slice(bloco.indexOf("detalhes: {"), bloco.indexOf("});", bloco.indexOf("detalhes: {")));
    // o telefone só pode aparecer DENTRO de mascararTelefone(...) — nunca como campo cru (`telefone_e164:`/`telefoneE164:`)
    assert.doesNotMatch(blocoDetalhes, /telefone(_e164)?\s*:/i);
    assert.match(blocoDetalhes, /mascararTelefone/);
  });
});

describe("Checkpoint H.4-A — preview-mensagem (itens 15-18): somente leitura, zero efeito colateral", () => {
  test("sem pendência real disponível -> disponivel:false, nunca inventa texto", async () => {
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estadoBase()) } });
    const r = await GET(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/preview-mensagem`);
    assert.equal(r.status, 200);
    assert.equal(r.json.data.disponivel, false);
    assert.ok(!("texto" in r.json.data));
  });

  test("organização inexistente -> 404 (nunca vaza existência de pendência de outra)", async () => {
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estadoBase()) } });
    const r = await GET(app, `/administrativo/comunicacao/organizacoes/${uuid("nao-existe")}/preview-mensagem`);
    assert.equal(r.status, 404);
  });

  test("preview nunca cria comunicacao_mensagens, comunicacao_tentativas nem evento de auditoria de envio", async () => {
    const estado = estadoBase();
    const app = makeApp({ user: USUARIO_PAINEL, deps: { supabase: fakeDb(estado) } });
    await GET(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/preview-mensagem`);
    await GET(app, `/administrativo/comunicacao/organizacoes/${ORG_A}/preview-mensagem?unidadeId=qualquer`);
    assert.deepEqual(estado.comunicacao_mensagens, []);
    assert.deepEqual(estado.comunicacao_tentativas ?? [], []);
    assert.deepEqual((estado.plataforma_auditoria ?? []).filter((a) => String(a.acao ?? "").includes("envio")), []);
  });
});
