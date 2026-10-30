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
const { requireAuth, requireAlgumModulo } = await import("../src/middlewares/auth.js");
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

  test("unidade SEM integração iFood: modo sem_integracao, nenhuma chamada obrigatória ao iFood, nada inventado", async () => {
    const ifood = ifoodRepoFalso({ conexao: null });
    const { r } = await resumoCom({ ifood });
    assert.equal(r.modo, "sem_integracao");
    assert.equal(r.semPedidosNoDia, true);
    assert.deepEqual(ifood.chamadas.map(([k]) => k), ["conexao"], "só consulta o vínculo local; nem credencial nem observabilidade");
    assert.equal(r.pedidosAtivos.length, 0);
    assert.equal(r.ultimosPedidos.length, 0);
    for (const k of ["preparo", "entrega", "vida"]) {
      assert.equal(r.indicadores[k].mediaDia, null, k);
      assert.equal(r.indicadores[k].ultimo, null, k);
      assert.equal(r.indicadores[k].amostras, 0, k);
    }
    assert.equal(r.lojas, undefined, "sem lojas adicionais a resposta não ganha o campo");
  });

  test("conexão com loja mas SEM credencial de pedidos: integrado (o motivo específico aparece); com credencial (mesmo parada): integrado", async () => {
    const semCred = await resumoCom({ ifood: ifoodRepoFalso({ credenciais: [] }) });
    assert.equal(semCred.r.modo, "integrado");
    assert.equal(semCred.r.integracao.motivo, "sem_credencial_order");
    // Sem loja vinculada MAS com pedidos persistidos (já houve conexão): os números existem, então não é "sem integração".
    const comPedidos = await resumoCom({ ifood: ifoodRepoFalso({ conexao: null }), linhas: [linha(UN_A)] });
    assert.equal(comPedidos.r.modo, "integrado");
    assert.equal(service.derivarModo({ estado: "nao_ativada", motivo: "sem_loja_vinculada" }), "sem_integracao");
    assert.equal(service.derivarModo({ estado: "nao_ativada", motivo: "sem_loja_vinculada" }, { temPedidos: true }), "integrado");
    assert.equal(service.derivarModo({ estado: "nao_ativada", motivo: "recebimento_desligado" }), "integrado");
    assert.equal(service.derivarModo({ estado: "desatualizado", motivo: "recebimento_parado" }), "integrado");
    assert.equal((await resumoCom()).r.modo, "integrado");
  });

  test("duas unidades da MESMA empresa: a sem integração não enxerga os pedidos da integrada (consultas sempre por org + unidade)", async () => {
    const linhas = [linha(UN_A, { order_id: "so-da-A" })];
    const A = await resumoCom({ linhas, unidade: UN_A });
    const B = await resumoCom({ linhas, unidade: UN_B, ifood: ifoodRepoFalso({ conexao: null }) });
    assert.equal(A.r.modo, "integrado");
    assert.equal(A.r.contagemDia.recebidos, 1);
    assert.equal(B.r.modo, "sem_integracao");
    assert.equal(B.r.contagemDia.recebidos, 0);
    assert.equal(B.r.ultimosPedidos.length, 0);
    for (const f of B.db.filtros) {
      if (f[0] === "eq" && f[1] === "unidade_id") assert.equal(f[2], UN_B);
    }
    assert.ok(B.db.filtros.some((f) => f[0] === "eq" && f[1] === "unidade_id" && f[2] === UN_B));
    assert.ok(B.db.filtros.some((f) => f[0] === "eq" && f[1] === "organizacao_id" && f[2] === ORG));
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

describe("multi-conexão iFood: o Checklist consulta SÓ a conexão de pedidos", () => {
  const agoraMs = AGORA.getTime();
  const financeira = { id: "c-fin", status: "ativa", merchant_id: "m-teste", finalidade: "financeiro_homologacao" };

  test("unidade só com o Financial de homologação: integração de pedidos NÃO ativada (e não \"sem integração com o iFood\")", () => {
    const e = service.derivarEstadoIntegracao({ conexao: null, outraConexaoViva: true, agoraMs });
    assert.equal(e.estado, "nao_ativada");
    assert.equal(e.motivo, "sem_credencial_order");
    assert.equal(service.derivarModo(e, { temPedidos: false }), "integrado");
    // sem NENHUMA conexão continua sendo "sem loja vinculada" (comportamento anterior)
    assert.equal(service.derivarEstadoIntegracao({ conexao: null, agoraMs }).motivo, "sem_loja_vinculada");
  });

  test("obterResumo pede a conexão de finalidade pedidos_producao; a financeira de teste não a substitui nem aparece como loja", async () => {
    const ifood = { ...ifoodRepoFalso({ conexao: null }), listarConexoesVivas: async () => [financeira] };
    const { r } = await resumoCom({ unidade: UN_B, ifood });
    assert.deepEqual(ifood.chamadas.find(([k]) => k === "conexao")[1], { organizacaoId: ORG, unidadeId: UN_B, finalidade: "pedidos_producao" });
    assert.equal(r.integracao.estado, "nao_ativada");
    assert.equal(r.integracao.motivo, "sem_credencial_order");
    assert.equal(r.modo, "integrado");
    assert.ok(!ifood.chamadas.some(([k]) => k === "obs"), "não consulta observabilidade do merchant de teste");
  });

  test("com a conexão de pedidos ativa ao lado da financeira, o Checklist usa a de pedidos (merchant dela)", async () => {
    const pedidos = { id: "c-ped", status: "ativa", merchant_id: "m-real", finalidade: "pedidos_producao" };
    const ifood = { ...ifoodRepoFalso({ conexao: pedidos }), listarConexoesVivas: async () => [financeira, pedidos] };
    const { r } = await resumoCom({ unidade: UN_B, ifood });
    assert.equal(r.integracao.estado, "ao_vivo");
    assert.equal(ifood.chamadas.find(([k]) => k === "obs")[1].merchantId, "m-real");
    assert.equal(ifood.chamadas.find(([k]) => k === "credenciais")[1].conexaoId, "c-ped");
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
    assert.deepEqual(arg, { organizacaoId: ORG, unidadeId: UN_B, finalidade: "pedidos_producao" });   // só a conexão de pedidos
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
      const modulos = String(req.headers["x-teste-modulos"] ?? MODULOS.CHECKLIST_OPERACIONAL).split(",").filter(Boolean);
      // `x-teste-sem`: retira permissões do papel (lista separada por vírgula; prova o 403 de PERMISSÃO, não só o de módulo).
      const sem = String(req.headers["x-teste-sem"] ?? "").split(",").filter(Boolean);
      const permissoes = permissoesDoPapel(papel).filter((p) => !sem.includes(p));
      req.acesso = { papel, permissoes, modulos, impersonando: false };
      req.tenant = { organizacaoId: ORG, unidadeId: null }; // sem unidade: o controller para ANTES de qualquer banco
    }
    next();
  }, requireAlgumModulo(MODULOS.CHECKLIST_OPERACIONAL, MODULOS.IFOOD), checklistOperacionalRouter);   // a MESMA régua de routes.js
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

  test("empresa sem o módulo do Checklist nem o iFood: 403 (o Dashboard iFood sozinho não basta)", async () => {
    const r = await chamar(server, "/api/v1/resumo", h("unit_manager", { "x-teste-modulos": MODULOS.IFOOD_DASHBOARD }));
    assert.equal(r.status, 403);
    assert.equal((await chamar(server, "/api/v1/resumo", h("unit_manager", { "x-teste-modulos": "dashboard,products_cmv" }))).status, 403);
  });

  test("o módulo checklist_operacional SOZINHO abre o Checklist, sem o módulo iFood (empresa sem integração)", async () => {
    const r = await chamar(server, "/api/v1/resumo", h("unit_manager", { "x-teste-modulos": MODULOS.CHECKLIST_OPERACIONAL }));
    assert.equal(r.status, 400);   // passou módulo e permissão; para no "selecione a unidade"
  });

  test("transição: sessão aberta antes da migration (só o módulo ifood) continua abrindo o Checklist", async () => {
    const r = await chamar(server, "/api/v1/resumo", h("unit_manager", { "x-teste-modulos": MODULOS.IFOOD }));
    assert.equal(r.status, 400);
  });

  test("sessão da TV (perfil de exibição) aberta ANTES da migration — só o módulo ifood — continua abrindo; com o módulo novo também; sem nenhum, 403", async () => {
    assert.equal((await chamar(server, "/api/v1/resumo", h("display_operator", { "x-teste-modulos": MODULOS.IFOOD }))).status, 400);
    assert.equal((await chamar(server, "/api/v1/resumo", h("display_operator", { "x-teste-modulos": MODULOS.CHECKLIST_OPERACIONAL }))).status, 400);
    assert.equal((await chamar(server, "/api/v1/resumo", h("display_operator", { "x-teste-modulos": "dashboard" }))).status, 403);
  });

  test("o módulo NÃO substitui a permissão: com módulo, sem checklist.visualizar nem integracoes.ver, 403", async () => {
    const r = await chamar(server, "/api/v1/resumo", h("unit_manager", { "x-teste-modulos": MODULOS.CHECKLIST_OPERACIONAL, "x-teste-sem": "integracoes.ver,checklist.visualizar" }));
    assert.equal(r.status, 403);
  });

  test("todo papel com checklist.visualizar OU integracoes.ver passa a autorização (para no 'selecione a unidade')", async () => {
    for (const papel of ["organization_admin", "unit_manager", "finance", "operations", "viewer", "display_operator"]) {
      const perms = permissoesDoPapel(papel);
      const pode = perms.includes("checklist.visualizar") || perms.includes("integracoes.ver");
      const r = await chamar(server, "/api/v1/resumo", h(papel));
      assert.equal(r.status, pode ? 400 : 403, `papel ${papel}`);
    }
  });

  test("sem checklist.visualizar NEM integracoes.ver: 403, mesmo com o módulo iFood contratado", async () => {
    const r = await chamar(server, "/api/v1/resumo", h("unit_manager", { "x-teste-sem": "integracoes.ver,checklist.visualizar" }));
    assert.equal(r.status, 403);
    assert.ok(!JSON.stringify(r.json).match(/pedido|merchant|order/i), "403 não traz dado nenhum");
  });

  test("perfil de exibição: só checklist.visualizar já basta (e é a ÚNICA permissão dele)", async () => {
    assert.deepEqual(permissoesDoPapel("display_operator"), ["checklist.visualizar"]);
    assert.equal((await chamar(server, "/api/v1/resumo", h("display_operator"))).status, 400); // passou a autorização
  });

  test("sessão aberta ANTES da mudança (só integracoes.ver, sem a permissão nova) continua abrindo o Checklist", async () => {
    const r = await chamar(server, "/api/v1/resumo", h("unit_manager", { "x-teste-sem": "checklist.visualizar" }));
    assert.equal(r.status, 400);
  });

  test("o tenant vem SÓ do contexto: unidade/empresa na query ou em cabeçalhos são ignoradas (sem unidade no contexto = 400, nunca a do pedido)", async () => {
    const qs = `?unidadeId=${UN_B}&organizacaoId=99999999-9999-4999-8999-999999999999&unidade_id=${UN_B}`;
    const r = await chamar(server, `/api/v1/resumo${qs}`, h("unit_manager", { "x-unidade-id": UN_B, "x-organizacao-id": ORG, "x-teste-unidade": UN_B }));
    assert.equal(r.status, 400);
    assert.ok(!JSON.stringify(r.json).match(/pedido|merchant|order/i));
  });

  test("o tenant vem SÓ de req.tenant: /resumo não lê query, corpo, parâmetros nem cabeçalhos; as rotas 2.0 leem só filtro/metas", () => {
    const fonte = readFileSync(path.join(AQUI, "../src/modules/checklist-operacional/checklistOperacional.controller.js"), "utf8");
    const codigo = fonte.replace(/^\s*\/\/.*$/gm, "");
    // O handler do resumo (a tela de parede) continua sem ler NADA da requisição além do contexto.
    const resumo = codigo.slice(codigo.indexOf("export const resumo"), codigo.indexOf("});", codigo.indexOf("export const resumo")));
    assert.doesNotMatch(resumo, /req\.(query|body|params|headers)/);
    assert.match(codigo, /req\.tenant/);
    // Checklist 2.0: query = só os filtros conhecidos; corpo = só as metas (o service valida e ignora qualquer id).
    // Nenhum id de unidade/empresa vem de query, corpo, parâmetros ou cabeçalhos.
    assert.doesNotMatch(codigo, /req\.(query|body)\??\.?\[?["']?(unidade|organizacao|org|empresa|tenant)/i);
    assert.doesNotMatch(codigo, /req\.headers|req\.header\(/);
    // Dashboard 2.0: os ÚNICOS parâmetros de rota são a chave OPACA do pedido e o id do fechamento — nenhum identifica tenant
    // (o service sempre filtra pelo req.tenant; pedido/fechamento de outra unidade = 404).
    const params = [...new Set([...codigo.matchAll(/req\.params\??\.?(\w+)/g)].map((m) => m[1]))].sort();
    assert.deepEqual(params, ["chave", "id"]);
    assert.match(codigo, /\["periodo", "inicio", "fim", "etapa"\]/);
  });

  test("métodos de escrita não existem: POST/PUT/DELETE em /resumo = 404", async () => {
    const { port } = server.address();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const status = await new Promise((resolve, reject) => {
        const rq = http.request({ host: "127.0.0.1", port, path: "/api/v1/resumo", method, headers: h("unit_manager") }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
        rq.on("error", reject); rq.end();
      });
      assert.equal(status, 404, method);
    }
  });

  test("rotas do Checklist 2.0: escritas só em metas, fechamento e SIMULAÇÃO de WhatsApp (pedidos continuam só leitura)", () => {
    const rotas = checklistOperacionalRouter.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route.path}`));
    assert.deepEqual(rotas, ["GET /resumo", "GET /metas", "PUT /metas", "GET /metas/historico", "GET /dashboard", "GET /dashboard/exportar.xlsx",
      "GET /pedidos", "GET /pedidos/:chave", "GET /fechamentos", "POST /fechamentos", "GET /fechamentos/:id", "GET /fechamentos/:id/exportar.xlsx",
      "GET /fechamentos/:id/whatsapp", "POST /fechamentos/:id/whatsapp/simular"]);
    const escritas = rotas.filter((r) => !r.startsWith("GET "));
    assert.deepEqual(escritas, ["PUT /metas", "POST /fechamentos", "POST /fechamentos/:id/whatsapp/simular"]);
    assert.equal(escritas.some((r) => r.includes("/pedidos")), false, "nenhuma escrita em pedidos");
  });

  test("routes.js monta o Checklist depois do gate de contexto, com o módulo próprio (e o iFood só na transição)", () => {
    const ROUTES = readFileSync(path.join(AQUI, "../src/routes.js"), "utf8");
    assert.match(ROUTES, /tenant\.use\(\s*["']\/checklist-operacional["']\s*,\s*requireAlgumModulo\(MODULOS\.CHECKLIST_OPERACIONAL,\s*MODULOS\.IFOOD\)\s*,\s*checklistOperacionalRouter\s*\)/);
    assert.ok(ROUTES.indexOf("tenant.use(requireContexto)") < ROUTES.indexOf('tenant.use("/checklist-operacional"'));
  });
});
