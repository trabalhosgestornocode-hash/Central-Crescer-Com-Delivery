// Sincronização MANUAL Foody (piloto em sombra) — rotas REAIS (criarFoodySyncRouter + criarFoodyAdminRouter) sobre o banco
// FALSO da 147/148/149. Só a API Foody é falsa (e é a única "rede" permitida: qualquer outra chamada externa falha o teste).
// Cobre: flags (administração + coleta + allowlist), permissões, impersonação, isolamento entre empresas, limites, concorrência,
// idempotência, dias congelados, falha de autenticação, distribuição Subway/Açaí/triagem, fechamentos independentes e auditoria.
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { criarFoodyAdminRouter } from "../src/modules/foody-admin/foodyAdmin.routes.js";
import { criarFoodySyncRouter } from "../src/modules/foody-admin/foodyAdmin.sync.routes.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";
import { permissoesDoPapel } from "../src/shared/permissoes.js";
import { criarSegurancaFoody } from "../src/modules/foody/foody.seguranca.js";
import { criarClienteFoody } from "../src/modules/foody/foody.client.js";
import { criarRepositorioFoody } from "../src/modules/foody/foody.repository.js";
import { solicitarSyncManual, planejarCompetencias, criarEstadoSyncManual, LIMITES_SYNC_MANUAL } from "../src/modules/foody/foody.sync.manual.js";
import { criarFakeDb } from "./helpers/fake-db-foody.js";
import { SEGREDO_TESTE, pedidoApi } from "./helpers/foody-fixtures.js";

const ORG_T = "11111111-1111-4111-8111-111111111111", UNI_T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_D = "22222222-2222-4222-8222-222222222222", UNI_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ORG_X = "33333333-3333-4333-8333-333333333333", UNI_X = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ADM_T = "a1000000-0000-4000-8000-000000000001", ADM_D = "a2000000-0000-4000-8000-000000000002";
const GER_T = "a3000000-0000-4000-8000-000000000003", ADM_X = "a4000000-0000-4000-8000-000000000004";
const TOKEN = "foody_tok_TESTE_nao_real_0123456789";
const AGORA = new Date("2026-11-05T12:00:00Z");   // hoje (Brasília) = 05/11; D-1 = 04/11; congelado = antes de 02/11
const D1 = "2026-11-04", D2 = "2026-11-03";

const MEMBROS = { [ADM_T]: [ORG_T, ORG_D], [ADM_D]: [ORG_D], [GER_T]: [ORG_T], [ADM_X]: [ORG_X] };
const plataforma = {
  nomes: async ({ organizacoes, unidades }) => ({ organizacoes: new Map(organizacoes.map((o) => [o, "Org"])), unidades: new Map(unidades.map((u) => [u, "Uni"])) }),
  organizacoesDoPerfil: async (p) => (MEMBROS[p] ?? []).map((o) => ({ id: o, nome: "Org" })),
  unidadesDaOrganizacao: async (o) => ({ [ORG_T]: [UNI_T], [ORG_D]: [UNI_D], [ORG_X]: [UNI_X] }[o] ?? []).map((u) => ({ id: u, nome: "Uni" })),
};

/** Pedidos por dia: 2 Subway, 1 Açaí, 1 em triagem (item desconhecido), 1 cancelado Subway. Fictícios. */
function pedidosDoDia(dia, extra = []) {
  return [
    pedidoApi({ uid: `${dia}-s1`, orderDetails: "1x Sub Frango Teriyaki 15cm", courierFee: 10, orderTotal: 40, date: `${dia}T11:00:00-03:00` }),
    pedidoApi({ uid: `${dia}-s2`, orderDetails: "1x Sub Frango Teriyaki 30cm", courierFee: 8, orderTotal: 60, date: `${dia}T12:00:00-03:00` }),
    pedidoApi({ uid: `${dia}-a1`, orderDetails: "1x Açaí Premium 500ml", courierFee: 7, orderTotal: 30, date: `${dia}T13:00:00-03:00` }),
    pedidoApi({ uid: `${dia}-t1`, orderDetails: "1x Sub Frango Teriyaki 15cm\n1x Produto Novo Misterioso", courierFee: 9, orderTotal: 55, date: `${dia}T14:00:00-03:00` }),
    pedidoApi({ uid: `${dia}-c1`, status: "cancelled", cancellationReason: "other", orderDetails: "1x Sub Frango Teriyaki 15cm", courierFee: 10, orderTotal: 40,
      date: `${dia}T15:00:00-03:00`, cancelledDate: `${dia}T15:10:00-03:00` }),
    ...extra,
  ];
}

let rodada = 0, db, env, servidor, base, foodyChamadas, externas, auditorias, estado, atrasoMs, statusFoody, listaPorDia;
const fetchOriginal = globalThis.fetch;

// API Foody falsa: GET /orders?startDate&endDate → pedidos com `date` na janela pedida.
const fetchFoody = async (url, init) => {
  foodyChamadas.push({ url: String(url), method: init?.method, temCorpo: init?.body !== undefined, auth: init?.headers?.Authorization });
  if (atrasoMs) await new Promise((r) => setTimeout(r, atrasoMs));
  if (statusFoody !== 200) return { ok: false, status: statusFoody, json: async () => ({}) };
  const u = new URL(String(url));
  const ini = Date.parse(u.searchParams.get("startDate")), fim = Date.parse(u.searchParams.get("endDate"));
  const todos = Object.values(listaPorDia).flat().filter((o) => { const d = Date.parse(o.date); return d >= ini && d < fim; });
  return { ok: true, status: 200, json: async () => structuredClone(todos) };
};
const criarCliente = ({ token, ...resto }) => criarClienteFoody({ token, ...resto, fetch: fetchFoody, esperar: async () => {} });

function montar() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", (req, _res, next) => {
    const h = (k) => req.headers[`x-teste-${k}`];
    const papel = h("papel") ?? "organization_admin";
    req.user = { id: `conta-${rodada}-${h("perfil")}-${h("conta") ?? ""}` };
    req.tenant = { organizacaoId: h("org"), unidadeId: h("unidade") || null };
    req.acesso = { perfilId: h("impersonando") ? null : h("perfil"), papel, permissoes: permissoesDoPapel(papel), modulos: [],
      impersonando: Boolean(h("impersonando")), impersonadoPor: h("impersonando") ? "super" : null, empresa: { id: h("org"), nome: "x", status: "ativa" } };
    next();
  });
  const seguranca = () => criarSegurancaFoody(env.FOODY_CENTRAL_SECRET);
  const agora = () => AGORA;
  app.use("/api/v1/integracoes/foody/sincronizacoes", criarFoodySyncRouter({ db, env, agora, seguranca, criarCliente, estado,
    auditoria: async (e) => { auditorias.push(structuredClone(e)); } }));
  app.use("/api/v1/integracoes/foody", criarFoodyAdminRouter({ db, env, plataforma, seguranca, agora }));
  app.use(errorHandler);
  return app;
}

const comoT = { perfil: ADM_T, org: ORG_T, unidade: UNI_T };
const comoD = { perfil: ADM_D, org: ORG_D, unidade: UNI_D };
const comoX = { perfil: ADM_X, org: ORG_X, unidade: UNI_X };
async function api(metodo, caminho, { como = comoT, corpo, headers: extra = {} } = {}) {
  const headers = { "content-type": "application/json", ...extra };
  for (const [k, v] of Object.entries(como)) if (v !== undefined && v !== null) headers[`x-teste-${k}`] = String(v);
  const r = await fetchOriginal(`${base}/api/v1/integracoes/foody${caminho}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const texto = await r.text();
  assert.ok(!texto.includes(TOKEN), `${metodo} ${caminho}: token na resposta`);
  assert.doesNotMatch(texto, /Cliente Fictício|Entregador Ficticio|90000-0000|Maria Fictícia/, `${metodo} ${caminho}: dado pessoal na resposta`);
  let json = null; try { json = JSON.parse(texto); } catch { /* vazio */ }
  return { status: r.status, json, cache: r.headers.get("cache-control") };
}
const sync = (corpo, opcoes = {}) => api("POST", "/sincronizacoes", { corpo, ...opcoes });

async function prepararConexaoCompartilhada({ compartilhar = true } = {}) {
  assert.equal((await api("POST", "/conexao", { corpo: { token: TOKEN } })).status, 201);
  assert.equal((await api("POST", "/conexao/ativar")).status, 200);
  if (!compartilhar) return;
  const p = await api("POST", "/compartilhamentos", { corpo: { organizacaoId: ORG_D, unidadeId: UNI_D, operacao: "acai_no_grau" } });
  assert.equal(p.status, 201);
  assert.equal((await api("POST", `/compartilhamentos/${p.json.data.id}/aprovar`, { como: comoD })).status, 200);
}

before(() => {
  globalThis.fetch = (url, ...r) => {
    if (!String(url).startsWith("http://127.0.0.1:")) externas.push(String(url));
    return fetchOriginal(url, ...r);
  };
});
after(() => { globalThis.fetch = fetchOriginal; servidor?.close(); });
beforeEach(async () => {
  rodada += 1; foodyChamadas = []; externas = []; auditorias = []; atrasoMs = 0; statusFoody = 200;
  listaPorDia = { [D1]: pedidosDoDia(D1), [D2]: pedidosDoDia(D2) };
  estado = criarEstadoSyncManual();
  db = criarFakeDb({ unidades: { [UNI_T]: ORG_T, [UNI_D]: ORG_D, [UNI_X]: ORG_X }, admins: [[ADM_T, ORG_T], [ADM_D, ORG_D], [ADM_X, ORG_X]] });
  env = { FOODY_CENTRAL_ADMIN_ENABLED: "true", FOODY_CENTRAL_SECRET: SEGREDO_TESTE, FOODY_CENTRAL_ENABLED: "true",
    FOODY_CENTRAL_UNIDADES: UNI_T, FOODY_CENTRAL_COMPARTILHAMENTO_ENABLED: "true" };
  servidor?.close();
  servidor = montar().listen(0);
  await new Promise((r) => servidor.once("listening", r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

describe("flags — tudo fail-closed", () => {
  test("coleta desligada, unidade fora da allowlist ou administração desligada: 404 sem chamar a API nem abrir execução", async () => {
    await prepararConexaoCompartilhada();
    for (const mudanca of [{ FOODY_CENTRAL_ENABLED: "false" }, { FOODY_CENTRAL_ENABLED: "TRUE " + "x" }, { FOODY_CENTRAL_UNIDADES: UNI_D },
      { FOODY_CENTRAL_UNIDADES: "" }, { FOODY_CENTRAL_ADMIN_ENABLED: "false" }]) {
      const salvo = { ...env }; Object.assign(env, mudanca);
      const r = await sync({ competencias: [D1] });
      assert.equal(r.status, 404, JSON.stringify(mudanca)); assert.equal(r.json.codigo, "DESLIGADO");
      Object.assign(env, salvo);
    }
    assert.deepEqual(foodyChamadas, []); assert.equal(db.tabelas.foody_sync_execucoes.length, 0);
    assert.deepEqual(auditorias, [], "404 de flag não gera auditoria (nada foi tentado)");
  });
  test("sem a flag de compartilhamento a coleta segue a regra da 147: tudo na titular, Açaí minimizado, nenhum fechamento do destino", async () => {
    await prepararConexaoCompartilhada();
    env.FOODY_CENTRAL_COMPARTILHAMENTO_ENABLED = "false";
    const r = await sync({ competencias: [D1] });
    assert.equal(r.status, 200);
    const dia = r.json.data.dias[0];
    assert.equal(dia.distribuicao, null); assert.deepEqual(dia.fechamentosDestino, []);
    assert.ok(db.tabelas.foody_pedidos.every((p) => p.unidade_id === UNI_T));
    assert.equal(db.tabelas.foody_fechamentos_logisticos.filter((f) => f.unidade_id === UNI_D).length, 0);
  });
});

describe("permissões, impersonação e isolamento", () => {
  test("viewer/financeiro sem integracoes.gerenciar: 403; gestor de unidade: 403 SEM_PERMISSAO; impersonação: 403", async () => {
    await prepararConexaoCompartilhada();
    for (const papel of ["viewer", "finance"]) assert.equal((await sync({ competencias: [D1] }, { como: { ...comoT, papel } })).status, 403, papel);
    const g = await sync({ competencias: [D1] }, { como: { perfil: GER_T, org: ORG_T, unidade: UNI_T, papel: "unit_manager" } });
    assert.equal(g.status, 403);
    const i = await sync({ competencias: [D1] }, { como: { ...comoT, impersonando: "1" } });
    assert.equal(i.status, 403); assert.equal(i.json.codigo, "SEM_PERMISSAO");
    assert.deepEqual(foodyChamadas, []);
  });
  test("o destino (Açaí) não dispara a coleta da conta da titular — nem com a própria unidade na allowlist", async () => {
    await prepararConexaoCompartilhada();
    env.FOODY_CENTRAL_UNIDADES = `${UNI_T},${UNI_D}`;
    const r = await sync({ competencias: [D1] }, { como: comoD });
    assert.equal(r.status, 404); assert.equal(r.json.codigo, "SEM_CONEXAO");
    assert.deepEqual(foodyChamadas, []);
  });
  test("terceira empresa apontando a unidade da titular no contexto: não encontra conexão (o tenant inteiro filtra)", async () => {
    await prepararConexaoCompartilhada();
    const r = await sync({ competencias: [D1] }, { como: { ...comoX, unidade: UNI_T } });
    assert.ok([403, 404].includes(r.status), String(r.status));
    assert.deepEqual(foodyChamadas, []);
    const h = await api("GET", "/sincronizacoes", { como: comoX });
    assert.equal(h.status, 200); assert.deepEqual(h.json.data.execucoes, []);
  });
});

describe("validação de dias e limites", () => {
  test("hoje/futuro, data inválida, mais de 7 dias e congelado sem motivo: 400 sem chamar a API", async () => {
    await prepararConexaoCompartilhada();
    for (const [i, [corpo, codigo]] of [[{ competencias: ["2026-11-05"] }, "COMPETENCIA_ABERTA"], [{ competencias: ["2026-11-31"] }, "COMPETENCIA_INVALIDA"],
      [{ competencias: [] }, "COMPETENCIA_INVALIDA"], [{}, "COMPETENCIA_INVALIDA"],
      [{ competencias: ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"], motivo: "conferência do piloto" }, "LIMITE_DIAS"],
      [{ competencias: ["2026-10-20"] }, "MOTIVO_INVALIDO"], [{ competencias: ["2026-10-20"], motivo: "curto" }, "MOTIVO_INVALIDO"]].entries()) {
      const r = await sync(corpo, { como: { ...comoT, conta: String(i) } });
      assert.equal(r.status, 400, JSON.stringify(corpo)); assert.equal(r.json.codigo, codigo, JSON.stringify(corpo));
    }
    assert.deepEqual(foodyChamadas, []); assert.equal(db.tabelas.foody_sync_execucoes.length, 0);
    assert.ok(auditorias.length >= 1 && auditorias.every((a) => a.acao === "foody.sync_manual_recusada"));
  });
  test("dia congelado COM motivo vira reprocessamento explícito", () => {
    const p = planejarCompetencias(["2026-10-20", D1, D1], { motivo: "Conferência do piloto em sombra", agora: AGORA });
    assert.deepEqual(p.map((x) => [x.competencia, x.origem]), [["2026-10-20", "reprocessamento"], [D1, "manual"]]);
  });
  test("conexão PAUSADA: 409 CONEXAO_INATIVA", async () => {
    await prepararConexaoCompartilhada({ compartilhar: false });
    await api("POST", "/conexao/pausar", { corpo: { motivo: "pausa para teste" } });
    const r = await sync({ competencias: [D1] });
    assert.equal(r.status, 409); assert.equal(r.json.codigo, "CONEXAO_INATIVA");
    assert.deepEqual(foodyChamadas, []);
  });
  test("teto de pedidos por dia: nada é gravado e a execução fica FALHOU/LIMITE_PEDIDOS", async () => {
    await prepararConexaoCompartilhada();
    const repo = criarRepositorioFoody(db);
    const r = await solicitarSyncManual({ ator: { perfilId: ADM_T, papel: "organization_admin", impersonando: false, organizacaoId: ORG_T },
      tenant: { organizacaoId: ORG_T, unidadeId: UNI_T }, competencias: [D1] },
    { env, repo, seguranca: criarSegurancaFoody(SEGREDO_TESTE), agora: () => AGORA, criarCliente, limites: { ...LIMITES_SYNC_MANUAL, maxPedidosPorDia: 3 } });
    assert.equal(r.dias[0].erro, "LIMITE_PEDIDOS");
    assert.equal(db.tabelas.foody_pedidos.length, 0);
    assert.deepEqual(db.tabelas.foody_sync_execucoes.map((e) => [e.status, e.erro_codigo]), [["FALHOU", "LIMITE_PEDIDOS"]]);
  });
  test("o cliente da coleta manual recebe o limite de páginas (10)", async () => {
    await prepararConexaoCompartilhada();
    const vistos = [];
    const repo = criarRepositorioFoody(db);
    await solicitarSyncManual({ ator: { perfilId: ADM_T, papel: "organization_admin", impersonando: false, organizacaoId: ORG_T },
      tenant: { organizacaoId: ORG_T, unidadeId: UNI_T }, competencias: [D1] },
    { env, repo, seguranca: criarSegurancaFoody(SEGREDO_TESTE), agora: () => AGORA, criarCliente: (o) => { vistos.push(o.maxPaginas); return criarCliente(o); } });
    assert.deepEqual(vistos, [10]);
  });
});

describe("piloto: Subway + Açaí pela mesma coleta", () => {
  test("coleta só GET em /orders, distribui Subway/Açaí/triagem e fecha cada organização no próprio tenant", async () => {
    await prepararConexaoCompartilhada();
    const r = await sync({ competencias: [D1] });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.cache, "no-store");
    assert.deepEqual(externas, [], "nenhuma chamada fora da API Foody falsa");
    assert.ok(foodyChamadas.length >= 1);
    for (const c of foodyChamadas) {
      assert.equal(c.method, "GET"); assert.equal(c.temCorpo, false);
      assert.match(c.url, /^https:\/\/app\.foodydelivery\.com\/rest\/1\.2\/orders\?startDate=2026-11-04T00%3A00%3A00-03%3A00&endDate=2026-11-05T00%3A00%3A00-03%3A00$/);
    }
    const dia = r.json.data.dias[0];
    assert.equal(dia.competencia, D1); assert.equal(dia.origem, "manual");
    assert.equal(dia.contagens.unicos, 5); assert.equal(dia.contagens.inseridos, 5);
    assert.deepEqual(dia.distribuicao.destinos, { acai_no_grau: 1 }); assert.equal(dia.distribuicao.triagem, 1);
    assert.ok(dia.cobertura.pendencias.some((p) => p.codigo === "TRIAGEM_PENDENTE"));
    assert.equal(dia.fechamento.resultado, "REGISTRADO");
    assert.equal(dia.fechamentosDestino.length, 1); assert.equal(dia.fechamentosDestino[0].operacao, "acai_no_grau");
    assert.equal(dia.fechamentosDestino[0].resultado, "REGISTRADO");
    // Isolamento: o pedido de açaí está SÓ no tenant do Açaí; os da Subway e o da triagem, na titular.
    const ativos = db.tabelas.foody_pedidos.filter((p) => p.roteamento_ativo !== false);
    assert.deepEqual(ativos.filter((p) => p.unidade_id === UNI_D).map((p) => p.foody_uid), [`${D1}-a1`]);
    assert.ok(ativos.filter((p) => p.unidade_id === UNI_D).every((p) => p.organizacao_id === ORG_D));
    assert.deepEqual(ativos.filter((p) => p.unidade_id === UNI_T).map((p) => p.foody_uid).sort(), [`${D1}-c1`, `${D1}-s1`, `${D1}-s2`, `${D1}-t1`]);
    // Fechamentos independentes, um por organização, sem rateio.
    const f = db.tabelas.foody_fechamentos_logisticos;
    assert.deepEqual(f.map((x) => `${x.organizacao_id}|${x.unidade_id}`).sort(), [`${ORG_T}|${UNI_T}`, `${ORG_D}|${UNI_D}`].sort());
    // Fechamento do Açaí não carrega o volume da conta da titular.
    const fd = f.find((x) => x.unidade_id === UNI_D);
    assert.equal(fd.cobertura.pedidosUnicos, null); assert.equal(fd.cobertura.paginas, null);
    // O pedido ficou com o perfil que pediu como autor do fechamento.
    assert.ok(f.every((x) => x.gerado_por === undefined || x.gerado_por === ADM_T || x.gerado_por === null));
    // Auditoria: uma entrada EXECUTADA, sem token nem valores.
    assert.equal(auditorias.length, 1);
    assert.equal(auditorias[0].acao, "foody.sync_manual_executada"); assert.equal(auditorias[0].perfilId, ADM_T);
    assert.equal(auditorias[0].organizacaoId, ORG_T);
    const textoAud = JSON.stringify(auditorias);
    assert.ok(!textoAud.includes(TOKEN)); assert.doesNotMatch(textoAud, /valor|orderTotal|courierFee|taxa/i);
  });
  test("idempotência: repetir o dia não cria pedido nem versão; a mesma chave devolve a resposta anterior sem chamar a API", async () => {
    await prepararConexaoCompartilhada();
    const h = { "idempotency-key": "piloto-2026-11-04-a" };
    const a = await sync({ competencias: [D1] }, { headers: h });
    const chamadas = foodyChamadas.length;
    const b = await sync({ competencias: [D1] }, { headers: h });
    assert.equal(b.status, 200); assert.equal(b.json.data.repetida, true);
    assert.equal(foodyChamadas.length, chamadas, "chave repetida não chama a API");
    assert.deepEqual(b.json.data.dias, a.json.data.dias);
    const c = await sync({ competencias: [D1] });   // sem chave: chama a API, mas o conteúdo é o mesmo
    const dia = c.json.data.dias[0];
    assert.equal(dia.contagens.inseridos, 0); assert.equal(dia.contagens.atualizados, 0); assert.equal(dia.contagens.inalterados, 5);
    assert.equal(dia.fechamento.resultado, "SEM_MUDANCA"); assert.equal(dia.fechamentosDestino[0].resultado, "SEM_MUDANCA");
    assert.equal(db.tabelas.foody_pedidos.length, 5);
    assert.equal(db.tabelas.foody_fechamentos_logisticos.length, 2);
    assert.equal(auditorias.filter((x) => x.acao === "foody.sync_manual_executada").length, 2, "a repetição pela chave não audita de novo");
  });
  test("vários dias em ordem; pedido cancelado fica na titular; sem contagem dupla entre dias", async () => {
    await prepararConexaoCompartilhada();
    const r = await sync({ competencias: [D1, D2] });
    assert.deepEqual(r.json.data.dias.map((d) => d.competencia), [D2, D1]);
    assert.equal(r.json.data.totais.dias, 2); assert.equal(r.json.data.totais.falhas, 0);
    assert.equal(db.tabelas.foody_pedidos.length, 10);
    const uids = db.tabelas.foody_pedidos.map((p) => p.foody_uid);
    assert.equal(new Set(uids).size, uids.length, "cada uid uma única vez");
    for (const d of [D1, D2]) assert.ok(db.tabelas.foody_pedidos.some((p) => p.foody_uid === `${d}-c1` && p.unidade_id === UNI_T));
  });
  test("pedido de fronteira de fuso: 23:59 de D-1 em -03:00 é de D-1; 00:00 de hoje não entra", async () => {
    await prepararConexaoCompartilhada();
    listaPorDia[D1].push(pedidoApi({ uid: "borda-fim", date: `${D1}T23:59:59-03:00` }), pedidoApi({ uid: "borda-hoje", date: "2026-11-05T00:00:00-03:00" }));
    const r = await sync({ competencias: [D1] });
    assert.equal(r.json.data.dias[0].contagens.unicos, 6);
    assert.ok(db.tabelas.foody_pedidos.some((p) => p.foody_uid === "borda-fim"));
    assert.ok(!db.tabelas.foody_pedidos.some((p) => p.foody_uid === "borda-hoje"));
  });
});

describe("falhas e concorrência", () => {
  test("API recusa o token (401): o dia falha com AUTENTICACAO e os demais NÃO são tentados", async () => {
    await prepararConexaoCompartilhada();
    statusFoody = 401;
    const r = await sync({ competencias: [D2, D1] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data.dias.map((d) => d.erro), ["AUTENTICACAO", "NAO_EXECUTADO"]);
    assert.equal(r.json.data.interrompidoPor, "AUTENTICACAO");
    assert.equal(foodyChamadas.length, 1, "401 não é retentado");
    assert.equal(db.tabelas.foody_pedidos.length, 0);
    assert.equal(db.tabelas.foody_conexoes[0].ultimo_erro_codigo, "AUTENTICACAO");
  });
  test("execução EM_ANDAMENTO recente (outra instância/agendador): 409 sem chamar a API", async () => {
    await prepararConexaoCompartilhada();
    const c = db.tabelas.foody_conexoes[0];
    db.tabelas.foody_sync_execucoes.push({ id: "e0000000-0000-4000-8000-000000000001", organizacao_id: ORG_T, unidade_id: UNI_T, conexao_id: c.id,
      competencia: D2, origem: "agendado", status: "EM_ANDAMENTO", iniciado_em: new Date(AGORA.getTime() - 5 * 60_000).toISOString() });
    const r = await sync({ competencias: [D1] });
    assert.equal(r.status, 409); assert.equal(r.json.codigo, "CONCORRENCIA");
    assert.deepEqual(foodyChamadas, []);
  });
  test("execução EM_ANDAMENTO abandonada (> 1 h) é encerrada como FALHOU/ABANDONADA e a nova segue", async () => {
    await prepararConexaoCompartilhada();
    const c = db.tabelas.foody_conexoes[0];
    db.tabelas.foody_sync_execucoes.push({ id: "e0000000-0000-4000-8000-000000000002", organizacao_id: ORG_T, unidade_id: UNI_T, conexao_id: c.id,
      competencia: D2, origem: "agendado", status: "EM_ANDAMENTO", iniciado_em: new Date(AGORA.getTime() - 3 * 3600_000).toISOString() });
    const r = await sync({ competencias: [D1] });
    assert.equal(r.status, 200);
    const velha = db.tabelas.foody_sync_execucoes.find((e) => e.id === "e0000000-0000-4000-8000-000000000002");
    assert.equal(velha.status, "FALHOU"); assert.equal(velha.erro_codigo, "ABANDONADA");
  });
  test("dois pedidos simultâneos da mesma unidade: um roda, o outro recebe 409 (trava em memória)", async () => {
    await prepararConexaoCompartilhada();
    atrasoMs = 150;
    const [a, b] = await Promise.all([sync({ competencias: [D1] }), sync({ competencias: [D1] })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(db.tabelas.foody_sync_execucoes.length, 1);
  });
});

describe("limite de taxa", () => {
  test("mais de 6 pedidos em 10 min pelo mesmo usuário: 429", async () => {
    await prepararConexaoCompartilhada();
    const st = [];
    for (let i = 0; i < 7; i++) st.push((await sync({ competencias: ["2026-11-05"] })).status);
    assert.deepEqual(st, [400, 400, 400, 400, 400, 400, 429]);
  });
});

describe("histórico", () => {
  test("GET lista as execuções da titular (só contagens/códigos); o Açaí não vê o volume da conta da titular", async () => {
    await prepararConexaoCompartilhada();
    await sync({ competencias: [D1] });
    const t = await api("GET", "/sincronizacoes");
    assert.equal(t.status, 200); assert.equal(t.json.data.habilitada, true);
    assert.equal(t.json.data.execucoes.length, 1);
    assert.equal(t.json.data.execucoes[0].unicos, 5); assert.equal(t.json.data.execucoes[0].status, "CONCLUIDA");
    const d = await api("GET", "/sincronizacoes", { como: comoD });
    assert.equal(d.status, 200); assert.deepEqual(d.json.data.execucoes, []); assert.equal(d.json.data.habilitada, false);
    const v = await api("GET", "/sincronizacoes", { como: { ...comoT, papel: "viewer" } });
    assert.equal(v.status, 403);
  });
});
