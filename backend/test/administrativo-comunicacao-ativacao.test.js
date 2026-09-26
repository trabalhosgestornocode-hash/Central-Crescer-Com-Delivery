// PAINEL ADMINISTRATIVO — Comunicação (Checkpoint H.4-B.1): as ÚNICAS alavancas de envio.
//   GET  /administrativo/comunicacao/ativacao
//   PUT  /administrativo/comunicacao/organizacoes/:id/habilitacao   { habilitado, confirmacaoExplicita }
//   PUT  /administrativo/comunicacao/modo                          { modo, confirmacaoExplicita }
// Rotas HTTP reais sobre o `administrativoRouter` REAL, banco FALSO em memória, SEM rede.
// O piloto é lido do `env` injetado em `adminDeps.env` (em produção é o process.env real do backend).
// O comportamento do banco (RPC 093 atômica, auditoria real) está em comunicacao-ativacao-integracao.test.js.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { administrativoRouter } from "../src/modules/administrativo/administrativo.routes.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";

const uuid = (l) => { const h = Buffer.from(l).toString("hex").padEnd(32, "0").slice(0, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const ORG_A = uuid("orgA");
const ORG_B = uuid("orgB");
const CONTATO_A = uuid("contatoA");
const PERFIL_A = uuid("perfil1");
const TEL_A = "+5548999990088";
const TEL_B = "+5511988887777";

function fakeDb(estado, { rpc } = {}) {
  const chamadasRpc = [];
  function from(tabela) {
    const ctx = { eq: [], inF: null, count: null, limitN: null };
    const casa = (r) => ctx.eq.every(([c, v]) => r[c] === v) && (!ctx.inF || ctx.inF.vals.includes(r[ctx.inF.col]));
    const linhas = () => (estado[tabela] ?? []).filter(casa).map((r) => ({ ...r }));
    const run = (single) => {
      const todas = linhas();
      const pagina = ctx.limitN != null ? todas.slice(0, ctx.limitN) : todas;
      return Promise.resolve(single ? { data: pagina[0] ?? null, error: null } : { data: pagina, error: null, count: ctx.count ? todas.length : undefined });
    };
    const b = {
      select: (_c, opts) => { if (opts?.count) ctx.count = true; return b; },
      eq: (c, v) => (ctx.eq.push([c, v]), b),
      in: (c, vals) => (ctx.inF = { col: c, vals }, b),
      ilike: () => b, gte: () => b, lte: () => b, order: () => b, range: () => b,
      limit: (n) => (ctx.limitN = n, b),
      maybeSingle: () => run(true), single: () => run(true),
      then: (res, rej) => run(false).then(res, rej),
      insert: (obj) => { estado[tabela] = [...(estado[tabela] ?? []), { ...obj }]; return { select: () => ({ single: () => Promise.resolve({ data: obj, error: null }) }) }; },
      upsert: (obj, { onConflict } = {}) => {
        const lista = estado[tabela] ?? [];
        const chave = onConflict || "id";
        const i = lista.findIndex((r) => r[chave] === obj[chave]);
        if (i >= 0) lista[i] = { ...lista[i], ...obj }; else lista.push({ ...obj });
        estado[tabela] = lista;
        return { select: () => ({ single: () => Promise.resolve({ data: obj, error: null }) }) };
      },
      update: (obj) => ({
        eq: (c, v) => { estado[tabela] = (estado[tabela] ?? []).map((r) => (r[c] === v ? { ...r, ...obj } : r)); return Promise.resolve({ error: null }); },
      }),
    };
    return b;
  }
  const rpcFn = async (nome, args) => { chamadasRpc.push({ nome, args }); return rpc ? rpc(nome, args, estado) : { data: { acao: "HABILITADA" }, error: null }; };
  return { from, rpc: rpcFn, chamadasRpc };
}

const AGORA_ISO = () => new Date().toISOString();
function estadoBase({ habilitadaA = false, contatoTel = TEL_A, gateway = "CONNECTED", modo = "DISABLED", orgBHabilitada = false } = {}) {
  return {
    organizacoes: [{ id: ORG_A, nome: "Grupo Jailton e Vanessa", status: "ativa" }, { id: ORG_B, nome: "Outra", status: "ativa" }],
    comunicacao_habilitacoes: [
      { organizacao_id: ORG_A, habilitado: habilitadaA, tipos_permitidos: ["dashboard_ifood_d1"], timezone: "America/Sao_Paulo", destinatario_contato_id: CONTATO_A, destinatario_contato_empresa_id: uuid("ceA"), destinatario_perfil_id: PERFIL_A },
      ...(orgBHabilitada ? [{ organizacao_id: ORG_B, habilitado: true, tipos_permitidos: ["dashboard_ifood_d1"], timezone: "America/Sao_Paulo", destinatario_contato_id: uuid("contatoB"), destinatario_contato_empresa_id: uuid("ceB"), destinatario_perfil_id: uuid("perfilB") }] : []),
    ],
    // migration 100: o destinatário é o RESPONSÁVEL DA EMPRESA (WhatsApp validado)
    comunicacao_contatos_empresa: [
      { id: uuid("ceA"), organizacao_id: ORG_A, nome: "Jailton Matos", telefone_e164: contatoTel, tipo: "principal", ativo: true, contato_whatsapp_id: CONTATO_A, whatsapp_status: "VALIDADO", whatsapp_validado_em: AGORA_ISO() },
      ...(orgBHabilitada ? [{ id: uuid("ceB"), organizacao_id: ORG_B, nome: "Resp B", telefone_e164: TEL_B, tipo: "principal", ativo: true, contato_whatsapp_id: uuid("contatoB"), whatsapp_status: "VALIDADO", whatsapp_validado_em: AGORA_ISO() }] : []),
    ],
    contatos_whatsapp: [
      { id: CONTATO_A, telefone_e164: contatoTel, verificado: true, consentimento: true, opt_out: false },
      { id: uuid("contatoB"), telefone_e164: TEL_B, verificado: true, consentimento: true, opt_out: false },
    ],
    perfis_operacionais: [{ id: PERFIL_A, nome: "Jailton Matos", ativo: true }],
    whatsapp_conexoes: gateway ? [{ status: gateway, last_seen_at: AGORA_ISO(), updated_at: AGORA_ISO() }] : [],
    comunicacao_mensagens: [],
    comunicacao_configuracoes: [{ chave: "modo", valor: modo }],
    plataforma_auditoria: [],
  };
}

const ENV_OK = { COMUNICACAO_PILOTO_ENABLED: "true", COMUNICACAO_PILOTO_TELEFONES_E164: TEL_A };
const USUARIO_COMUM = { id: uuid("u1"), email: "comum@teste.com", nome: "Comum", painelAdministrativo: false };
const USUARIO_PAINEL = { id: uuid("u2"), email: "painel@teste.com", nome: "Painel", painelAdministrativo: true };

function makeApp({ user = USUARIO_PAINEL, estado, env = ENV_OK, rpc } = {}) {
  const db = fakeDb(estado, { rpc });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use("/administrativo", administrativoRouter);
  app.use(errorHandler);
  app.locals.adminDeps = { supabase: db, env };
  return { app, db, estado };
}

function chamar(app, metodo, path, corpo) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const req = http.request({ host: "127.0.0.1", port, path, method: metodo, headers: corpo ? { "Content-Type": "application/json" } : {} }, (res) => {
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
const GET = (app, p) => chamar(app, "GET", p);
const PUT = (app, p, c) => chamar(app, "PUT", p, c);
const HAB = (org = ORG_A) => `/administrativo/comunicacao/organizacoes/${org}/habilitacao`;
const MODO = "/administrativo/comunicacao/modo";
const ATIV = "/administrativo/comunicacao/ativacao";
const modoDe = (estado) => estado.comunicacao_configuracoes.find((c) => c.chave === "modo").valor;
const habDe = (estado, org = ORG_A) => estado.comunicacao_habilitacoes.find((h) => h.organizacao_id === org).habilitado;

describe("H.4-B.1 — autorização: só o Painel Administrativo autenticado", () => {
  test("usuário comum -> 403 nas três rotas, e nada é alterado", async () => {
    const { app, estado } = makeApp({ user: USUARIO_COMUM, estado: estadoBase() });
    assert.equal((await GET(app, ATIV)).status, 403);
    assert.equal((await PUT(app, HAB(), { habilitado: true, confirmacaoExplicita: true })).status, 403);
    assert.equal((await PUT(app, MODO, { modo: "NORMAL", confirmacaoExplicita: true })).status, 403);
    assert.equal(habDe(estado), false);
    assert.equal(modoDe(estado), "DISABLED");
  });
});

describe("H.4-B.1 — GET /ativacao (prova do runtime, sem telefone)", () => {
  test("piloto ativo + 1 destino: contagens/booleanos apenas; nunca telefone nem a lista", async () => {
    const { app } = makeApp({ estado: estadoBase() });
    const r = await GET(app, ATIV);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data.piloto, { ativo: true, quantidadeDestinos: 1 });
    assert.equal(r.json.data.modo, "DISABLED");
    assert.equal(r.json.data.organizacoesHabilitadas, 0);
    assert.equal(r.json.data.gateway, "conectado");
    const texto = JSON.stringify(r.json);
    assert.doesNotMatch(texto, /5548999990088|999990088|COMUNICACAO_PILOTO_TELEFONES/);
  });
  test("piloto desligado / allowlist malformada / 2 destinos são refletidos (fail-closed)", async () => {
    for (const [env, ativo, qtd] of [
      [{}, false, 0],
      [{ COMUNICACAO_PILOTO_ENABLED: "true" }, true, 0],
      [{ COMUNICACAO_PILOTO_ENABLED: "true", COMUNICACAO_PILOTO_TELEFONES_E164: `${TEL_A},abc` }, true, 0],
      [{ COMUNICACAO_PILOTO_ENABLED: "true", COMUNICACAO_PILOTO_TELEFONES_E164: `${TEL_A},${TEL_B}` }, true, 2],
    ]) {
      const { app } = makeApp({ estado: estadoBase(), env });
      const r = await GET(app, ATIV);
      assert.deepEqual(r.json.data.piloto, { ativo, quantidadeDestinos: qtd }, JSON.stringify(env));
    }
  });
});

describe("H.4-B.1 — PUT /habilitacao", () => {
  test("`habilitado` não booleano -> 400", async () => {
    const { app } = makeApp({ estado: estadoBase() });
    for (const habilitado of [undefined, "true", 1, null]) {
      assert.equal((await PUT(app, HAB(), { habilitado, confirmacaoExplicita: true })).status, 400, String(habilitado));
    }
  });
  test("habilitar SEM confirmacaoExplicita=true -> 400 e nada muda (nem chama o banco)", async () => {
    const { app, db, estado } = makeApp({ estado: estadoBase() });
    for (const confirmacaoExplicita of [undefined, false, "true", 1]) {
      const r = await PUT(app, HAB(), { habilitado: true, confirmacaoExplicita });
      assert.equal(r.status, 400);
      assert.equal(r.json.error?.details?.codigo ?? r.json.details?.codigo ?? r.json.codigo, "CONFIRMACAO_OBRIGATORIA");
    }
    assert.equal(db.chamadasRpc.length, 0);
    assert.equal(habDe(estado), false);
  });
  test("gates do piloto no runtime REAL: inativo / allowlist != 1 / destinatário fora -> 409, RPC nunca chamada", async () => {
    const casos = [
      [{}, "PILOTO_INATIVO"],
      [{ COMUNICACAO_PILOTO_ENABLED: "true" }, "ALLOWLIST_INVALIDA"],
      [{ COMUNICACAO_PILOTO_ENABLED: "true", COMUNICACAO_PILOTO_TELEFONES_E164: `${TEL_A},${TEL_B}` }, "ALLOWLIST_INVALIDA"],
      [{ COMUNICACAO_PILOTO_ENABLED: "true", COMUNICACAO_PILOTO_TELEFONES_E164: TEL_B }, "DESTINATARIO_FORA_DA_ALLOWLIST"],
    ];
    for (const [env, codigo] of casos) {
      const { app, db, estado } = makeApp({ estado: estadoBase(), env });
      const r = await PUT(app, HAB(), { habilitado: true, confirmacaoExplicita: true });
      assert.equal(r.status, 409, JSON.stringify(env));
      assert.match(JSON.stringify(r.json), new RegExp(codigo));
      assert.equal(db.chamadasRpc.length, 0);
      assert.equal(habDe(estado), false);
    }
  });
  test("tudo válido -> chama a RPC atômica com a organização e o perfil do ATOR; 200 alterou=true", async () => {
    const { app, db } = makeApp({ estado: estadoBase() });
    const r = await PUT(app, HAB(), { habilitado: true, confirmacaoExplicita: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.data, { organizacaoId: ORG_A, habilitado: true, alterou: true });
    assert.equal(db.chamadasRpc.length, 1);
    assert.equal(db.chamadasRpc[0].nome, "comunicacao_habilitar_organizacao_piloto");
    assert.equal(db.chamadasRpc[0].args.p_organizacao_id, ORG_A);
  });
  test("recusas do banco (outra organização habilitada, modo != DISABLED, destinatário inelegível...) viram 409 com o código", async () => {
    for (const acao of ["OUTRA_ORGANIZACAO_HABILITADA", "MODO_NAO_DESABILITADO", "DESTINATARIO_INELEGIVEL", "SEM_DESTINATARIO", "TIMEZONE_AUSENTE"]) {
      const { app } = makeApp({ estado: estadoBase(), rpc: async () => ({ data: { acao }, error: null }) });
      const r = await PUT(app, HAB(), { habilitado: true, confirmacaoExplicita: true });
      assert.equal(r.status, 409, acao);
      assert.match(JSON.stringify(r.json), new RegExp(acao));
    }
  });
  test("já habilitada -> 200 alterou=false (idempotente)", async () => {
    const { app } = makeApp({ estado: estadoBase(), rpc: async () => ({ data: { acao: "JA_HABILITADA" }, error: null }) });
    const r = await PUT(app, HAB(), { habilitado: true, confirmacaoExplicita: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.alterou, false);
  });
  test("DESABILITAR é sempre permitido: sem confirmação, piloto desligado, sem allowlist — e não chama a RPC de habilitar", async () => {
    const { app, db, estado } = makeApp({ estado: estadoBase({ habilitadaA: true }), env: {} });
    const r = await PUT(app, HAB(), { habilitado: false });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data, { organizacaoId: ORG_A, habilitado: false, alterou: true });
    assert.equal(habDe(estado), false);
    assert.equal(db.chamadasRpc.length, 0);
    const de_novo = await PUT(app, HAB(), { habilitado: false });
    assert.equal(de_novo.json.data.alterou, false, "idempotente");
  });
  test("organização inexistente -> 404", async () => {
    const { app } = makeApp({ estado: estadoBase() });
    assert.equal((await PUT(app, HAB(uuid("naoexiste")), { habilitado: false })).status, 404);
  });
});

describe("H.4-B.1 — PUT /modo", () => {
  test("só DISABLED|NORMAL: REACTIVE_ONLY, lixo e ausente -> 400", async () => {
    const { app, estado } = makeApp({ estado: estadoBase({ habilitadaA: true }) });
    for (const modo of ["REACTIVE_ONLY", "normal", "", undefined, 1, null]) {
      assert.equal((await PUT(app, MODO, { modo, confirmacaoExplicita: true })).status, 400, String(modo));
    }
    assert.equal(modoDe(estado), "DISABLED");
  });
  test("NORMAL sem confirmacaoExplicita=true -> 400 e o modo não muda", async () => {
    const { app, estado } = makeApp({ estado: estadoBase({ habilitadaA: true }) });
    for (const confirmacaoExplicita of [undefined, false, "true"]) {
      assert.equal((await PUT(app, MODO, { modo: "NORMAL", confirmacaoExplicita })).status, 400);
    }
    assert.equal(modoDe(estado), "DISABLED");
  });
  test("NORMAL: gates — piloto inativo, allowlist != 1, nenhuma/duas organizações habilitadas, destinatário fora, Gateway fora", async () => {
    const casos = [
      [estadoBase({ habilitadaA: true }), {}, "PILOTO_INATIVO"],
      [estadoBase({ habilitadaA: true }), { COMUNICACAO_PILOTO_ENABLED: "true", COMUNICACAO_PILOTO_TELEFONES_E164: `${TEL_A},${TEL_B}` }, "ALLOWLIST_INVALIDA"],
      [estadoBase({ habilitadaA: false }), ENV_OK, "EXATAMENTE_UMA_ORGANIZACAO"],
      [estadoBase({ habilitadaA: true, orgBHabilitada: true }), ENV_OK, "EXATAMENTE_UMA_ORGANIZACAO"],
      [estadoBase({ habilitadaA: true, contatoTel: TEL_B }), ENV_OK, "DESTINATARIO_FORA_DA_ALLOWLIST"],
      [estadoBase({ habilitadaA: true, gateway: "DISCONNECTED" }), ENV_OK, "GATEWAY_INDISPONIVEL"],
      [estadoBase({ habilitadaA: true, gateway: null }), ENV_OK, "GATEWAY_INDISPONIVEL"],
    ];
    for (const [estado, env, codigo] of casos) {
      const { app } = makeApp({ estado, env });
      const r = await PUT(app, MODO, { modo: "NORMAL", confirmacaoExplicita: true });
      assert.equal(r.status, 409, codigo);
      assert.match(JSON.stringify(r.json), new RegExp(codigo));
      assert.equal(modoDe(estado), "DISABLED", codigo);
    }
  });
  test("NORMAL com tudo válido -> 200, modo=NORMAL, anterior=DISABLED", async () => {
    const { app, estado } = makeApp({ estado: estadoBase({ habilitadaA: true }) });
    const r = await PUT(app, MODO, { modo: "NORMAL", confirmacaoExplicita: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.data, { modo: "NORMAL", anterior: "DISABLED", alterou: true });
    assert.equal(modoDe(estado), "NORMAL");
    const de_novo = await PUT(app, MODO, { modo: "NORMAL", confirmacaoExplicita: true });
    assert.equal(de_novo.json.data.alterou, false, "idempotente");
  });
  test("NORMAL -> DISABLED é SEMPRE permitido: sem confirmação, piloto desligado, Gateway fora, nenhuma organização", async () => {
    const { app, estado } = makeApp({ estado: estadoBase({ habilitadaA: false, gateway: null, modo: "NORMAL" }), env: {} });
    const r = await PUT(app, MODO, { modo: "DISABLED" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data, { modo: "DISABLED", anterior: "NORMAL", alterou: true });
    assert.equal(modoDe(estado), "DISABLED");
  });
});

describe("H.4-B.1 — guarda estática: só o fluxo administrativo dedicado chama definirModo", () => {
  test("em todo src/, o único arquivo (fora de comunicacao.config.js) que importa/chama definirModo é administrativo.comunicacao.service.js", async () => {
    const fs = await import("node:fs"), path = await import("node:path"), { fileURLToPath } = await import("node:url");
    const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
    const usam = [];
    const varrer = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { varrer(p); continue; }
      if (!e.name.endsWith(".js") || e.name === "comunicacao.config.js") continue;
      if (/import[^;]*\bdefinirModo\b|\bdefinirModo\s*\(/.test(fs.readFileSync(p, "utf8"))) usam.push(e.name);
    } };
    varrer(raiz);
    assert.deepEqual(usam, ["administrativo.comunicacao.service.js"]);
  });
  test("repo e controller nunca referenciam definirModo (o service é o único ponto)", async () => {
    const fs = await import("node:fs"), path = await import("node:path"), { fileURLToPath } = await import("node:url");
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "modules", "administrativo");
    for (const arquivo of ["administrativo.comunicacao.repo.js", "administrativo.comunicacao.controller.js"]) {
      assert.doesNotMatch(fs.readFileSync(path.join(dir, arquivo), "utf8"), /definirModo/, arquivo);
    }
  });
  test("as quatro ações de auditoria existem e o service nunca grava telefone nelas", async () => {
    const fs = await import("node:fs"), path = await import("node:path"), { fileURLToPath } = await import("node:url");
    const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
    const aud = fs.readFileSync(path.join(src, "shared", "auditoria.js"), "utf8");
    for (const a of ["COMUNICACAO_ORGANIZACAO_HABILITADA", "COMUNICACAO_ORGANIZACAO_DESABILITADA", "COMUNICACAO_MODO_ATIVADO", "COMUNICACAO_MODO_DESATIVADO"]) assert.match(aud, new RegExp(a));
    const svc = fs.readFileSync(path.join(src, "modules", "administrativo", "administrativo.comunicacao.service.js"), "utf8");
    const bloco = svc.slice(svc.indexOf("CHECKPOINT H.4-B.1"), svc.indexOf("/** GET /administrativo/comunicacao/fila */"));
    assert.doesNotMatch(bloco, /telefone_e164[^\n]*detalhes|detalhes[^\n]*telefone/i);
    for (const a of ["COMUNICACAO_ORGANIZACAO_HABILITADA", "COMUNICACAO_ORGANIZACAO_DESABILITADA", "COMUNICACAO_MODO_ATIVADO", "COMUNICACAO_MODO_DESATIVADO"]) assert.match(bloco, new RegExp(`ACOES\\.${a}`));
  });
});
