// Dashboard Operacional 2.0 — integrações: ORDER_PATCHED no processamento de Events (sem mexer em estado oficial nem ACK),
// agendador do fechamento (travado fora de ambiente isolado) e permissões HTTP das rotas novas.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.SUPABASE_URL ??= "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "teste";
process.env.SUPABASE_ANON_KEY ??= "teste";

const { default: express } = await import("express");
const { processarLote, extrasDePedidoAlterado } = await import("../src/modules/ifood/ifoodEvents.service.js");
const { buscarEPersistirDetalhes, detalhesDevidos } = await import("../src/modules/ifood/ifoodOrder.service.js");
const { criarRepoEmMemoria, ev, CONEXAO_A, CONEXAO_B } = await import("./helpers/ifood-events-fakes.js");
const { criarAgendadorFechamento, executarCiclo, agendamentoPermitido } = await import("../src/modules/checklist-operacional/checklistOperacional.agendador.js");
const { checklistOperacionalRouter } = await import("../src/modules/checklist-operacional/checklistOperacional.routes.js");
const { requireModulo } = await import("../src/middlewares/auth.js");
const { errorHandler } = await import("../src/middlewares/errorHandler.js");
const { MODULOS } = await import("../src/shared/modulos.js");
const { permissoesDoPapel } = await import("../src/shared/permissoes.js");
const { rotaPermitidaAoPerfilExibicao } = await import("../src/middlewares/perfilExibicao.js");
const { bancoSintetico, repoFake, opFake, TENANT_A1 } = await import("./helpers/operacional-sintetico.js");

const silencio = () => {};
const conexoes = () => new Map([CONEXAO_A, CONEXAO_B].map((c) => [c.merchant_id, c]));

describe("ORDER_PATCHED reabre a leitura dos detalhes (achado D-8)", () => {
  test("regra pura: só reabre detalhes JÁ lidos e mais antigos que a alteração", () => {
    assert.deepEqual(extrasDePedidoAlterado({ details_status: "OK", details_atualizado_em: "2026-10-27T15:00:00Z" }, { createdAt: "2026-10-27T15:05:00Z" }),
      { details_status: "PENDENTE", details_tentativas: 0, details_ultima_tentativa_em: null });
    assert.deepEqual(extrasDePedidoAlterado({ details_status: "OK", details_atualizado_em: "2026-10-27T15:10:00Z" }, { createdAt: "2026-10-27T15:05:00Z" }), {}, "lido depois da alteração");
    assert.deepEqual(extrasDePedidoAlterado({ details_status: "PENDENTE" }, { createdAt: "2026-10-27T15:05:00Z" }), {}, "ainda não lido: o ciclo de detalhes já vai buscar");
    assert.deepEqual(extrasDePedidoAlterado({}, { createdAt: "x" }), {}, "banco sem a 102");
  });

  test("no lote: OPA reabre os detalhes, NÃO muda o estado oficial e continua indo para o ACK", async () => {
    const repo = criarRepoEmMemoria();
    await processarLote({ eventosBrutos: [ev("e1", "PLC", { min: 0 }), ev("e2", "CFM", { min: 1 })], conexoesPorMerchant: conexoes(), repo, agora: repo.relogio.agora, log: silencio });
    const p = repo.pedidos.get("order-1");
    Object.assign(p, { details_status: "OK", details_tentativas: 1, details_atualizado_em: new Date(Date.parse(p.primeiro_evento_em) + 60_000).toISOString() });
    const r = await processarLote({ eventosBrutos: [ev("e3", "OPA", { min: 5 })], conexoesPorMerchant: conexoes(), repo, agora: repo.relogio.agora, log: silencio });
    assert.deepEqual(r.idsParaAck, ["e3"], "ACK inalterado");
    const depois = repo.pedidos.get("order-1");
    assert.equal(depois.status_oficial, "CONFIRMED", "estado oficial intacto");
    assert.equal(depois.details_status, "PENDENTE");
    assert.equal(depois.details_tentativas, 0);
    assert.equal(repo.eventos.get("e3").processing_status, "PROCESSADO");
    assert.equal(detalhesDevidos(depois, Date.parse(depois.primeiro_evento_em) + 10 * 60_000), true, "o ciclo de detalhes vai rebuscar");
  });

  test("rebusca é idempotente: mesmo payload volta a OK sem mudar o primeiro carimbo de detalhes", async () => {
    const repo = criarRepoEmMemoria();
    await processarLote({ eventosBrutos: [ev("e1", "PLC", { min: 0 })], conexoesPorMerchant: conexoes(), repo, agora: repo.relogio.agora, log: silencio });
    const corpo = { id: "order-1", displayId: "77", orderType: "DELIVERY", merchant: { id: CONEXAO_A.merchant_id }, items: [{ quantity: 1 }], total: { orderAmount: 10 } };
    const token = { comAccessTokenValido: async ({ fn }) => fn("tok") };
    const client = { buscarDetalhesPedido: async () => structuredClone(corpo) };
    const p0 = repo.pedidos.get("order-1");
    await buscarEPersistirDetalhes({ pedido: { ...p0 }, conexaoId: CONEXAO_A.id, repo, token, client, agora: repo.relogio.agora, log: silencio });
    const primeiro = repo.pedidos.get("order-1").details_fetched_at;
    Object.assign(repo.pedidos.get("order-1"), { details_status: "PENDENTE", details_tentativas: 0 });   // reaberto pelo OPA
    const r = await buscarEPersistirDetalhes({ pedido: { ...repo.pedidos.get("order-1") }, conexaoId: CONEXAO_A.id, repo, token, client, agora: repo.relogio.agora, log: silencio });
    assert.equal(r.resultado, "GRAVADO");
    assert.equal(repo.pedidos.get("order-1").details_status, "OK");
    assert.equal(repo.pedidos.get("order-1").details_fetched_at, primeiro, "1ª leitura (SLA) preservada");
  });
});

describe("agendador do fechamento (só ambiente isolado)", () => {
  test("travado sem as DUAS variáveis (fail-closed)", () => {
    assert.equal(agendamentoPermitido({}), false);
    assert.equal(agendamentoPermitido({ OPERACIONAL_FECHAMENTO_AGENDADO_ENABLED: "true" }), false);
    assert.equal(agendamentoPermitido({ OPERACIONAL_AMBIENTE_ISOLADO: "true" }), false);
    const ag = criarAgendadorFechamento({ unidades: [], env: {} });
    assert.throws(() => ag.iniciar(), /recusado/);
    assert.equal(ag.ativo, false);
  });

  test("ciclo: fecha ONTEM de cada unidade; repetir não cria versão nova; uma unidade com erro não derruba as outras", async () => {
    const b = bancoSintetico();
    const deps = { repo: repoFake(b.db), op: opFake(b.db), ia: {} };
    const agora = () => new Date("2026-10-28T12:00:00.000Z");
    const unidades = [TENANT_A1, { organizacaoId: TENANT_A1.organizacaoId, unidadeId: "nao-e-uuid" }];
    const gerar = async (p) => { if (p.unidadeId === "nao-e-uuid") throw new Error("falha simulada"); const m = await import("../src/modules/checklist-operacional/checklistOperacional.operacional.service.js"); return m.gerarFechamento(p); };
    const r1 = await executarCiclo({ unidades, agora, gerar, deps });
    assert.equal(r1[0].competencia, "2026-10-27");
    assert.equal(r1[0].resultado, "REGISTRADO");
    assert.match(r1[1].erro, /falha simulada/);
    const r2 = await executarCiclo({ unidades, agora, gerar, deps });
    assert.equal(r2[0].resultado, "SEM_MUDANCA");
    assert.equal(b.db.fechamentos.length, 1);
    assert.equal(b.db.fechamentos[0].origem, "agendado");
    assert.equal(b.db.simulacoes?.length ?? 0, 0, "o agendador nunca gera nem simula WhatsApp");
  });

  test("em ambiente isolado liga, roda um ciclo pelo temporizador e para", async () => {
    const chamadas = [];
    const fila = [];
    const ag = criarAgendadorFechamento({
      unidades: () => [TENANT_A1], env: { OPERACIONAL_FECHAMENTO_AGENDADO_ENABLED: "true", OPERACIONAL_AMBIENTE_ISOLADO: "true" },
      agora: () => new Date("2026-10-28T12:00:00.000Z"), gerar: async (p) => { chamadas.push(p.competencia); return { resultado: "REGISTRADO", fechamento: { status: "CONSOLIDADO", versao: 1 } }; },
      temporizador: { set: (fn) => { fila.push(fn); return fila.length; }, clear: () => {} },
    });
    ag.iniciar();
    await fila.shift()();
    assert.deepEqual(chamadas, ["2026-10-27"]);
    ag.parar();
    assert.equal(ag.ativo, false);
  });
});

describe("HTTP — permissões das rotas do Dashboard 2.0", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", (req, _res, next) => {
    const papel = req.headers["x-teste-papel"];
    req.user = { id: `u-${papel}` };
    req.acesso = { papel, permissoes: permissoesDoPapel(papel), modulos: [MODULOS.IFOOD], impersonando: false };
    req.tenant = { organizacaoId: TENANT_A1.organizacaoId, unidadeId: null };   // sem unidade: o controller para ANTES do banco (400)
    next();
  }, requireModulo(MODULOS.IFOOD), checklistOperacionalRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  after(() => server.close());
  const chamar = (metodo, url, papel, corpo) => new Promise((resolve, reject) => {
    const dados = corpo ? JSON.stringify(corpo) : null;
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path: `/api/v1${url}`, method: metodo,
      headers: { "x-teste-papel": papel, ...(dados ? { "content-type": "application/json", "content-length": Buffer.byteLength(dados) } : {}) } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.end(dados);
  });
  const ID = "11111111-1111-4111-8111-111111111111";

  test("leitura (pedidos, ficha, fechamentos, Excel, prévia): quem já vê o Dashboard", async () => {
    for (const papel of ["organization_admin", "unit_manager", "finance", "operations", "viewer"]) {
      for (const url of ["/pedidos?periodo=hoje", "/pedidos/0123456789abcdef", "/fechamentos", `/fechamentos/${ID}`, `/fechamentos/${ID}/exportar.xlsx`, `/fechamentos/${ID}/whatsapp`]) {
        assert.equal(await chamar("GET", url, papel), 400, `${papel} ${url}`);
      }
    }
  });

  test("gerar/revisar fechamento e simular WhatsApp: só quem gerencia (mesma régua das metas)", async () => {
    for (const [papel, esperado] of [["organization_admin", 400], ["unit_manager", 400], ["finance", 403], ["operations", 403], ["viewer", 403], ["display_operator", 403]]) {
      assert.equal(await chamar("POST", "/fechamentos", papel, { competencia: "2026-10-27" }), esperado, `gerar ${papel}`);
      assert.equal(await chamar("POST", `/fechamentos/${ID}/whatsapp/simular`, papel), esperado, `simular ${papel}`);
    }
  });

  test("perfil de exibição (TV) continua vendo SÓ o resumo", () => {
    for (const [m, c] of [["GET", "/checklist-operacional/pedidos"], ["GET", "/checklist-operacional/pedidos/0123456789abcdef"], ["GET", "/checklist-operacional/fechamentos"],
      ["POST", "/checklist-operacional/fechamentos"], ["GET", `/checklist-operacional/fechamentos/${ID}/whatsapp`], ["POST", `/checklist-operacional/fechamentos/${ID}/whatsapp/simular`]]) {
      assert.equal(rotaPermitidaAoPerfilExibicao(m, c), false, `${m} ${c}`);
    }
    assert.equal(rotaPermitidaAoPerfilExibicao("GET", "/checklist-operacional/resumo"), true);
  });
});
