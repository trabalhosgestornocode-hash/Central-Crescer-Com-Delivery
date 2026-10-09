// Checklist Operacional — service, isolamento entre unidades, estado da integração e rota HTTP.
//
// Sem banco e sem rede: repositórios falsos injetados; a rota usa auth/módulo/permissão REAIS com um gate
// de contexto falso (mesmo padrão de ifood-rotas-montagem.test.js). Nenhuma chamada ao iFood.
//
// Rodar: node --experimental-vm-modules --test test/checklist-operacional-service.test.js

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.SUPABASE_URL ??= "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "teste";
process.env.SUPABASE_ANON_KEY ??= "teste";

const { default: express } = await import("express");
const service = await import("../src/modules/checklist-operacional/checklistOperacional.service.js");
const repoChecklist = await import("../src/modules/checklist-operacional/checklistOperacional.repository.js");
const { checklistOperacionalRouter } = await import("../src/modules/checklist-operacional/checklistOperacional.routes.js");
const { requireAuth, requireModulo } = await import("../src/middlewares/auth.js");
const { errorHandler } = await import("../src/middlewares/errorHandler.js");
const { MODULOS } = await import("../src/shared/modulos.js");
const { permissoesDoPapel } = await import("../src/shared/permissoes.js");

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const AGORA = new Date("2026-10-09T15:00:00.000Z");
const iso = (minAntes) => new Date(AGORA.getTime() - minAntes * 60_000).toISOString();

const ORG = "11111111-1111-4111-8111-111111111111";
const UN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const linha = (unidade, over = {}) => ({
  organizacao_id: ORG, unidade_id: unidade,
  order_id: `o-${unidade.slice(0, 4)}-${Math.random()}`, display_id: unidade === UN_A ? "A1" : "B1",
  status_oficial: "CONCLUDED", status_oficial_em: iso(20), order_type: "DELIVERY", delivery_by: "IFOOD", order_timing: "IMMEDIATE",
  is_test: false, order_created_at: iso(60), placed_event_created_at: iso(60), confirmed_event_at: iso(59), ready_event_at: iso(49),
  dispatch_event_at: iso(45), cancel_event_at: null, primeiro_evento_em: iso(60), criado_em: iso(60),
  customer: { name: "Cliente Sigiloso" },
  ...over,
});

/** Uma condição de `.or()` do PostgREST usada pelo repositório: "col.is.null", "col.eq.false", "col.not.in.(A,B)". */
function condicaoOr(cond) {
  const m = cond.match(/^(\w+)\.(not\.in|is|eq)\.(.+)$/);
  const [, col, op, val] = m;
  if (op === "is") return (l) => l[col] == null;
  if (op === "eq") return (l) => String(l[col]) === val;
  const lista = val.replace(/[()]/g, "").split(",");
  return (l) => l[col] != null && !lista.includes(l[col]);
}

/** Banco falso de `ifood_pedidos`: aplica os filtros que o repositório REAL pede (cada consulta isolada). */
function dbFalso(linhas) {
  const filtros = []; // registro de TODAS as consultas, para os testes de isolamento
  const from = () => {
    const meus = [];
    const add = (f) => { meus.push(f); filtros.push(f); return q; };
    const aplicar = () => linhas.filter((l) => meus.every(([op, c, v]) =>
      op === "eq" ? l[c] === v : op === "gte" ? l[c] >= v : op === "lt" ? l[c] < v : v.split(/,(?![^(]*\))/).map(condicaoOr).some((f) => f(l))));
    const q = {
      select(colunas, opcoes) { q.colunas = colunas; q.head = opcoes?.head === true; return q; },
      eq: (c, v) => add(["eq", c, v]),
      gte: (c, v) => add(["gte", c, v]),
      lt: (c, v) => add(["lt", c, v]),
      or: (expr) => add(["or", null, expr]),
      not: (c, op, v) => add(["or", null, op === "is" && v === true ? `${c}.is.null,${c}.eq.false` : "?"]),
      order: () => q,
      limit() {
        const cols = q.colunas.split(",").map((s) => s.trim());
        return Promise.resolve({ data: aplicar().map((l) => Object.fromEntries(cols.map((c) => [c, l[c]]))), error: null });
      },
      then(ok, erro) { return Promise.resolve({ count: aplicar().length, error: null }).then(ok, erro); }, // consulta só de contagem
    };
    return q;
  };
  return { from, filtros };
}

const leaseFresco = { leaseAte: iso(-60), atualizadoEm: iso(0.2) };
function ifoodRepoFalso({ conexao = { id: "c1", status: "ativa", merchant_id: "m-1" }, credenciais = [{ app_type: "order", status: "ativa" }], obs } = {}) {
  const chamadas = [];
  return {
    chamadas,
    obterConexaoViva: async (a) => { chamadas.push(["conexao", a]); return conexao; },
    listarCredenciaisDaConexao: async (a) => { chamadas.push(["credenciais", a]); return credenciais; },
    obterObservabilidadeOrder: async (a) => {
      chamadas.push(["obs", a]);
      return obs ?? { disponivel: true, ultimoEvento: iso(1), ultimoAck: iso(1), eventosComFalha: 0, ultimoPedido: iso(1), lease: leaseFresco };
    },
  };
}

const resumoCom = ({ linhas = [], unidade = UN_A, ifood = ifoodRepoFalso(), env = {} } = {}) => {
  const db = dbFalso(linhas);
  const repo = {
    ...repoChecklist,
    listarPedidosDaJanela: (a) => repoChecklist.listarPedidosDaJanela({ ...a, db }),
    contarAbertosAntesDe: (a) => repoChecklist.contarAbertosAntesDe({ ...a, db }),
  };
  return service.obterResumo({ organizacaoId: ORG, unidadeId: unidade, agora: () => AGORA, deps: { repo, ifoodRepo: ifood, pilotoOrder: () => false, env } })
    .then((r) => ({ r, db, ifood }));
};

describe("estado da integração (puro)", () => {
  const agoraMs = AGORA.getTime();
  const conexao = { status: "ativa", merchant_id: "m-1" };
  const cred = { app_type: "order", status: "ativa" };

  test("sem loja vinculada / sem credencial Order: não ativada", () => {
    assert.equal(service.derivarEstadoIntegracao({ conexao: null, agoraMs }).estado, "nao_ativada");
    assert.equal(service.derivarEstadoIntegracao({ conexao: { status: "pendente", merchant_id: null }, agoraMs }).motivo, "sem_loja_vinculada");
    assert.equal(service.derivarEstadoIntegracao({ conexao, credencialOrder: null, agoraMs }).motivo, "sem_credencial_order");
  });

  test("credencial Order, mas o recebimento nunca rodou: não ativada (recebimento desligado)", () => {
    const e = service.derivarEstadoIntegracao({ conexao, credencialOrder: cred, observabilidade: { disponivel: true, ultimoEvento: null, lease: null }, agoraMs });
    assert.equal(e.estado, "nao_ativada");
    assert.equal(e.motivo, "recebimento_desligado");
  });

  test("lease renovado há pouco: ao vivo, com o horário da última sincronização", () => {
    const e = service.derivarEstadoIntegracao({ conexao, credencialOrder: cred, observabilidade: { disponivel: true, ultimoEvento: iso(3), lease: leaseFresco }, agoraMs });
    assert.equal(e.estado, "ao_vivo");
    assert.equal(e.ultimaSincronizacao, leaseFresco.atualizadoEm);
  });

  test("lease parado com eventos anteriores: desatualizado", () => {
    const lease = { leaseAte: iso(5), atualizadoEm: iso(6) };
    const e = service.derivarEstadoIntegracao({ conexao, credencialOrder: cred, observabilidade: { disponivel: true, ultimoEvento: iso(7), lease }, agoraMs });
    assert.equal(e.estado, "desatualizado");
    assert.equal(e.motivo, "recebimento_parado");
  });

  test("lease vigente mas sem renovação além do limite: desatualizado", () => {
    const lease = { leaseAte: iso(-1), atualizadoEm: iso(service.LIMITE_SINCRONIZACAO_S / 60 + 1) };
    assert.equal(service.derivarEstadoIntegracao({ conexao, credencialOrder: cred, observabilidade: { disponivel: true, ultimoEvento: iso(9), lease }, agoraMs }).estado, "desatualizado");
  });

  test("reautorização pendente: desatualizado", () => {
    assert.equal(service.derivarEstadoIntegracao({ conexao, credencialOrder: { status: "reauth_required" }, agoraMs }).motivo, "reautorizacao_necessaria");
  });
});

describe("resumo do service", () => {
  test("integração desligada: estado correto, sem erro e sem valor inventado", async () => {
    const ifood = ifoodRepoFalso({ conexao: null });
    const { r } = await resumoCom({ ifood });
    assert.equal(r.integracao.estado, "nao_ativada");
    assert.equal(r.origem, "api");
    assert.equal(r.semPedidosNoDia, true);
    assert.equal(r.indicadores.preparo.mediaDia, null);
    assert.equal(r.avaliacoes.disponivel, false);
    assert.equal(ifood.chamadas.some(([k]) => k === "obs"), false, "sem conexão não consulta observabilidade");
  });

  test("integração ativa sem pedidos: ao vivo + sem pedidos no dia (estados distintos)", async () => {
    const { r } = await resumoCom();
    assert.equal(r.integracao.estado, "ao_vivo");
    assert.equal(r.semPedidosNoDia, true);
  });

  test("traz horário do servidor, contrato e intervalo", async () => {
    const { r } = await resumoCom();
    assert.equal(r.servidorEm, AGORA.toISOString());
    assert.equal(r.versao, 1);
    assert.equal(r.atualizarEmS, 30);
    assert.equal(r.diaOperacional.data, "2026-10-09");
  });

  test("tempoReal separa flag (habilitado) de avisos de fato (flag + recebimento ao vivo)", async () => {
    const LIGADA = { IFOOD_CHECKLIST_REALTIME_ENABLED: "true" };
    const base = { topico: `unidade:${UN_A}`, evento: "ifood_pedido.estado_atualizado" };
    // flag ausente: nada de aviso, mesmo com o recebimento ao vivo
    assert.deepEqual((await resumoCom()).r.tempoReal, { habilitado: false, avisosAtivos: false, ...base });
    assert.deepEqual((await resumoCom({ env: { IFOOD_CHECKLIST_REALTIME_ENABLED: "false" } })).r.tempoReal, { habilitado: false, avisosAtivos: false, ...base });
    // flag ligada + recebimento ao vivo: avisos ativos
    assert.deepEqual((await resumoCom({ env: LIGADA })).r.tempoReal, { habilitado: true, avisosAtivos: true, ...base });
    // flag ligada, mas integração não ativada: habilitado, porém sem avisos para chegar
    const { r } = await resumoCom({ env: LIGADA, ifood: ifoodRepoFalso({ conexao: null }) });
    assert.deepEqual(r.tempoReal, { habilitado: true, avisosAtivos: false, ...base });
  });

  test("eventos com falha viram alerta", async () => {
    const ifood = ifoodRepoFalso({ obs: { disponivel: true, ultimoEvento: iso(1), eventosComFalha: 2, lease: leaseFresco } });
    const { r } = await resumoCom({ ifood });
    assert.ok(r.alertas.some((a) => a.codigo === "eventos_com_falha" && a.quantidade === 2));
  });

  test("tabelas do Events ausentes: não ativada, sem consultar pedidos", async () => {
    let consultou = false;
    const repo = { ...repoChecklist, listarPedidosDaJanela: async () => { consultou = true; return []; } };
    const r = await service.obterResumo({ organizacaoId: ORG, unidadeId: UN_A, agora: () => AGORA, deps: { repo, ifoodRepo: ifoodRepoFalso({ obs: { disponivel: false } }), pilotoOrder: () => false } });
    assert.equal(r.integracao.motivo, "tabelas_ausentes");
    assert.equal(consultou, false);
  });
});

describe("isolamento entre unidades", () => {
  const linhas = [linha(UN_A), linha(UN_A, { status_oficial: "CONFIRMED", ready_event_at: null, dispatch_event_at: null, placed_event_created_at: iso(3) }), linha(UN_B), linha(UN_B), linha(UN_B)];

  test("a unidade A só vê os próprios pedidos (filtro de organização E unidade no banco)", async () => {
    const { r, db } = await resumoCom({ linhas, unidade: UN_A });
    assert.equal(r.contagemDia.recebidos, 2);
    assert.ok(r.pedidosAtivos.every((p) => p.displayId === "A1"));
    assert.ok(r.ultimosPedidos.every((p) => p.displayId === "A1"));
    assert.ok(db.filtros.some(([op, c, v]) => op === "eq" && c === "organizacao_id" && v === ORG));
    assert.ok(db.filtros.some(([op, c, v]) => op === "eq" && c === "unidade_id" && v === UN_A));
  });

  test("a unidade B não enxerga os ativos de A", async () => {
    const { r } = await resumoCom({ linhas, unidade: UN_B });
    assert.equal(r.contagemDia.recebidos, 3);
    assert.equal(r.pedidosAtivos.length, 0);
  });

  test("o vínculo iFood é resolvido pelo tenant do contexto, nunca por merchant vindo de fora", async () => {
    const ifood = ifoodRepoFalso();
    await resumoCom({ unidade: UN_B, ifood });
    const [, arg] = ifood.chamadas.find(([k]) => k === "conexao");
    assert.deepEqual(arg, { organizacaoId: ORG, unidadeId: UN_B });
    const [, obs] = ifood.chamadas.find(([k]) => k === "obs");
    assert.equal(obs.merchantId, "m-1"); // o da conexão da própria unidade
  });

  test("repositório recusa consulta sem tenant", async () => {
    await assert.rejects(() => repoChecklist.listarPedidosDaJanela({ organizacaoId: ORG, unidadeId: null, desdeIso: iso(0), db: dbFalso([]) }));
  });

  test("o SELECT é por lista positiva: nenhuma coluna de cliente/pagamento/endereço", () => {
    for (const c of ["customer", "delivery", "payments", "items", "customer_document_number", "pickup_code", "total_order_amount"]) {
      assert.ok(!repoChecklist.COLUNAS_PEDIDO_CHECKLIST.split(", ").includes(c), `coluna ${c} não pode ser lida`);
    }
  });

  test("resposta sem dado pessoal mesmo com a linha do banco trazendo", async () => {
    const { r } = await resumoCom({ linhas, unidade: UN_A });
    assert.ok(!JSON.stringify(r).includes("Cliente Sigiloso"));
    assert.ok(!JSON.stringify(r).includes("m-1"), "merchantId não sai na resposta");
    for (const l of linhas) assert.ok(!JSON.stringify(r).includes(l.order_id), "orderId do iFood não sai na resposta");
  });

  test("pedido aberto de ANTES da janela continua contado como ativo, com alerta crítico (só da própria unidade)", async () => {
    const antigo = (unidade, over = {}) => linha(unidade, { status_oficial: "CONFIRMED", criado_em: "2026-10-05T12:00:00.000Z", placed_event_created_at: "2026-10-05T12:00:00.000Z", ...over });
    const base = [
      antigo(UN_A),                                           // conta
      antigo(UN_A, { status_oficial: "CONCLUDED" }),          // terminal: não conta
      antigo(UN_A, { is_test: true }),                        // teste: não conta
      antigo(UN_B),                                           // outra unidade: não conta
    ];
    const { r } = await resumoCom({ linhas: base, unidade: UN_A });
    assert.equal(r.contagemDia.abertosForaDaJanela, 1);
    assert.equal(r.contagemDia.emAndamento, 1);
    assert.equal(r.semPedidosNoDia, false);
    const a = r.alertas.find((x) => x.codigo === "pedidos_sem_conclusao");
    assert.equal(a.nivel, "critico");
    assert.equal(a.quantidade, 1);
  });
});

// ---------------------------------------------------------------------------
// HTTP — auth, módulo e permissão reais
// ---------------------------------------------------------------------------
function montarApp() {
  const app = express();
  app.use("/api/v1", (req, res, next) => {
    if (req.headers["x-teste-user"]) { req.user = { id: String(req.headers["x-teste-user"]) }; return next(); }
    return requireAuth(req, res, next);
  }, (req, _res, next) => {
    const papel = req.headers["x-teste-papel"];
    if (papel) {
      const modulos = String(req.headers["x-teste-modulos"] ?? MODULOS.IFOOD).split(",").filter(Boolean);
      // `x-teste-sem`: retira uma permissão do papel (prova o 403 de PERMISSÃO, não só o de módulo).
      const sem = req.headers["x-teste-sem"];
      const permissoes = permissoesDoPapel(papel).filter((p) => p !== sem);
      req.acesso = { papel, permissoes, modulos, impersonando: false };
      req.tenant = { organizacaoId: ORG, unidadeId: null }; // sem unidade: o controller para ANTES de qualquer banco
    }
    next();
  }, requireModulo(MODULOS.IFOOD), checklistOperacionalRouter);
  app.use(errorHandler);
  return app;
}

function chamar(server, url, headers = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: url, headers }, (res) => {
      let corpo = ""; res.on("data", (c) => { corpo += c; });
      res.on("end", () => resolve({ status: res.statusCode, json: corpo ? JSON.parse(corpo) : null }));
    }).on("error", reject);
  });
}

describe("HTTP — permissões do Checklist", async () => {
  const server = montarApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  after(() => server.close());
  const h = (papel, extra = {}) => ({ "x-teste-user": `u-${papel}`, "x-teste-papel": papel, ...extra });

  test("sem autenticação: 401", async () => {
    assert.equal((await chamar(server, "/api/v1/resumo")).status, 401);
  });

  test("empresa sem o módulo iFood: 403 (o Dashboard iFood sozinho não basta)", async () => {
    const r = await chamar(server, "/api/v1/resumo", h("unit_manager", { "x-teste-modulos": MODULOS.IFOOD_DASHBOARD }));
    assert.equal(r.status, 403);
  });

  test("todo papel com INTEGRACOES_VER passa a autorização (para no 'selecione a unidade')", async () => {
    for (const papel of ["organization_admin", "unit_manager", "finance", "operations", "viewer"]) {
      const pode = permissoesDoPapel(papel).includes("integracoes.ver");
      const r = await chamar(server, "/api/v1/resumo", h(papel));
      assert.equal(r.status, pode ? 400 : 403, `papel ${papel}`);
    }
  });

  test("sem a permissão integracoes.ver: 403, mesmo com o módulo iFood contratado", async () => {
    const r = await chamar(server, "/api/v1/resumo", h("unit_manager", { "x-teste-sem": "integracoes.ver" }));
    assert.equal(r.status, 403);
    assert.ok(!JSON.stringify(r.json).match(/pedido|merchant|order/i), "403 não traz dado nenhum");
  });

  test("só GET /resumo existe — nenhuma rota de escrita", () => {
    const rotas = checklistOperacionalRouter.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route.path}`));
    assert.deepEqual(rotas, ["GET /resumo"]);
  });

  test("routes.js monta o Checklist depois do gate de contexto, com requireModulo(IFOOD)", () => {
    const ROUTES = readFileSync(path.join(AQUI, "../src/routes.js"), "utf8");
    assert.match(ROUTES, /tenant\.use\(\s*["']\/checklist-operacional["']\s*,\s*requireModulo\(MODULOS\.IFOOD\)\s*,\s*checklistOperacionalRouter\s*\)/);
    assert.ok(ROUTES.indexOf("tenant.use(requireContexto)") < ROUTES.indexOf('tenant.use("/checklist-operacional"'));
  });
});
