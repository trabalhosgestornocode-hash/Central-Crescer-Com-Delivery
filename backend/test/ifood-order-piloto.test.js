// Piloto do app Order: as credenciais IFOOD_ORDER_CLIENT_* NÃO liberam o Order; só a unidade listada em
// IFOOD_ORDER_PILOT_UNITS pode vê-lo no status e iniciar/concluir o OAuth `order`. Fail-closed, checado no
// BACKEND (service do OAuth), antes de qualquer chamada ao iFood. Independente do Events. Sem rede, sem banco.
import test from "node:test";
import assert from "node:assert/strict";

const PILOTO = "00000000-0000-4000-8000-0000000000a1";
const OUTRA = "00000000-0000-4000-8000-0000000000b2";

process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_HOMOLOGATION_MODE = "false";
process.env.IFOOD_CENTRALIZED_TEST_MODE = "false";
process.env.IFOOD_ANALYTICS_CLIENT_ID = "analytics-id";
process.env.IFOOD_ANALYTICS_CLIENT_SECRET = "analytics-secret";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "financial-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "financial-secret";
process.env.IFOOD_TEST_CLIENT_ID = "teste-d-id";
process.env.IFOOD_TEST_CLIENT_SECRET = "teste-d-secret";
process.env.IFOOD_ORDER_CLIENT_ID = "order-prod-id";
process.env.IFOOD_ORDER_CLIENT_SECRET = "order-prod-secret";
// Lista com lixo de propósito: um UUID válido em maiúsculas + valores inválidos (ignorados, nunca ecoados).
process.env.IFOOD_ORDER_PILOT_UNITS = ` ${PILOTO.toUpperCase()} ; nome-da-loja, 123 ,, `;

const { config } = await import("../src/config/env.js");
const { parsearUnidadesPiloto, unidadeNoPilotoOrder } = await import("../src/modules/ifood/ifoodOrderPiloto.js");
const tokenService = await import("../src/modules/ifood/ifoodToken.service.js");
const auth = await import("../src/modules/ifood/ifoodAuth.service.js");
const conn = await import("../src/modules/ifood/ifoodConnection.service.js");
const { validarAppType } = await import("../src/modules/ifood/ifood.validators.js");
const { IFOOD_ERROS } = await import("../src/modules/ifood/ifood.errors.js");

async function com(ajuste, fn) {
  const antes = JSON.parse(JSON.stringify(config.ifood));
  Object.assign(config.ifood, ajuste);
  try { return await fn(); } finally { Object.assign(config.ifood, antes); }
}
const SEM_SECRETS = { order: { clientId: null, clientSecret: null } };

// ---------------------------------------------------------------------------
// Parsing (puro)
// ---------------------------------------------------------------------------
test("parsing: vazio/ausente/não-string = nenhuma unidade (fail-closed)", () => {
  for (const v of [undefined, null, "", "   ", 42, {}]) assert.deepEqual(parsearUnidadesPiloto(v), { unidades: [], ignorados: 0 });
});

test("parsing: só UUIDs válidos entram, normalizados e sem repetição; o resto é contado e descartado", () => {
  const r = parsearUnidadesPiloto(`${PILOTO.toUpperCase()},${PILOTO} ${OUTRA};loja-centro,123,${PILOTO}x`);
  assert.deepEqual(r.unidades, [PILOTO, OUTRA]);
  assert.equal(r.ignorados, 3);
});

test("config real do processo: a lista com lixo virou só a unidade piloto (nome de loja nunca é chave)", () => {
  assert.deepEqual(config.ifood.orderPilotoUnidades, [PILOTO]);
  assert.deepEqual(config.ifood.order, { clientId: "order-prod-id", clientSecret: "order-prod-secret" }, "credenciais não mudam de forma");
});

test("unidadeNoPilotoOrder: comparação exata do id; lista/unidade vazias = false", () => {
  assert.equal(unidadeNoPilotoOrder([PILOTO], PILOTO), true);
  assert.equal(unidadeNoPilotoOrder([PILOTO], ` ${PILOTO.toUpperCase()} `), true);
  assert.equal(unidadeNoPilotoOrder([PILOTO], OUTRA), false);
  assert.equal(unidadeNoPilotoOrder([PILOTO], PILOTO.slice(0, 30)), false, "prefixo não vale");
  assert.equal(unidadeNoPilotoOrder([], PILOTO), false);
  assert.equal(unidadeNoPilotoOrder(undefined, PILOTO), false);
  assert.equal(unidadeNoPilotoOrder([PILOTO], null), false);
  assert.equal(unidadeNoPilotoOrder([PILOTO], ""), false);
});

// ---------------------------------------------------------------------------
// Decisão por unidade
// ---------------------------------------------------------------------------
test("matriz: secrets x piloto — só (secrets presentes E unidade piloto) libera o Order", async () => {
  assert.equal(tokenService.orderLiberadoParaUnidade(PILOTO), true, "secrets + piloto");
  assert.equal(tokenService.orderLiberadoParaUnidade(OUTRA), false, "secrets + não piloto");
  assert.equal(tokenService.orderLiberadoParaUnidade(null), false, "sem unidade no contexto");
  await com(SEM_SECRETS, () => {
    assert.equal(tokenService.orderLiberadoParaUnidade(PILOTO), false, "sem secrets + piloto");
    assert.equal(tokenService.orderLiberadoParaUnidade(OUTRA), false, "sem secrets + não piloto");
  });
  await com({ orderPilotoUnidades: [] }, () => {
    assert.equal(tokenService.orderLiberadoParaUnidade(PILOTO), false, "lista vazia: nenhuma unidade");
  });
});

test("homologação também é fail-closed: o app de teste existe, mas o Order só libera para a unidade piloto", async () => {
  await com({ homologacao: true }, () => {
    assert.ok(tokenService.appTypesDoOAuth().includes("order"));
    assert.equal(tokenService.orderLiberadoParaUnidade(PILOTO), true);
    assert.equal(tokenService.orderLiberadoParaUnidade(OUTRA), false);
  });
});

test("as credenciais continuam dizendo só se o app EXISTE (appTypesDoOAuth), não quem pode usá-lo", async () => {
  assert.deepEqual(tokenService.appTypesDoOAuth(), ["analytics", "financial", "order"]);
  assert.equal(validarAppType("order"), "order", "validador HTTP só checa o app; o piloto é checado no service");
  await com(SEM_SECRETS, () => {
    assert.throws(() => validarAppType("order"), (e) => e.codigo === IFOOD_ERROS.IFOOD_APP_TYPE_INVALIDO);
  });
});

// ---------------------------------------------------------------------------
// OAuth (service) — chamada DIRETA, sem passar pela interface
// ---------------------------------------------------------------------------
function repoFalso() {
  const estado = { sessao: null, credenciais: [], chamadas: [] };
  const anota = (n) => estado.chamadas.push(n);
  return {
    estado,
    async expirarSessoesVencidas() { anota("expirar"); return []; },
    async criarSessaoOAuth(a) { anota("criarSessao"); estado.sessao = { id: "sess-1", status: "pending", app_type: a.appType, authorization_code_verifier_cifrado: a.verifierCifrado, expira_em: a.expiraEm }; return estado.sessao; },
    async obterSessaoOAuth() { anota("obterSessao"); return estado.sessao ? { ...estado.sessao } : null; },
    async reivindicarSessaoOAuth() { anota("reivindicar"); return { id: "sess-1" }; },
    async fecharSessaoOAuth({ status }) { anota("fechar"); estado.sessao = { ...estado.sessao, status }; return estado.sessao; },
    async obterOuCriarConexao() { anota("conexao"); return { id: "conx-1", status: "ativa" }; },
    async salvarCredencial(a) { anota("salvarCredencial"); estado.credenciais.push(a); return a; },
  };
}
function httpFalso() {
  const chamadas = [];
  return {
    chamadas,
    async postForm(caminho, campos) {
      chamadas.push({ caminho, campos });
      if (caminho.endsWith("/oauth/userCode")) return { userCode: "ABCD-1234", authorizationCodeVerifier: "verif-1", verificationUrl: "https://portal", expiresIn: 600 };
      return { accessToken: "AT", refreshToken: "RT", expiresIn: 21600 };
    },
  };
}
const naoHabilitado = (e) => e.codigo === IFOOD_ERROS.IFOOD_ORDER_PILOTO_NAO_HABILITADO && e.statusCode === 403;

test("iniciar OAuth 'order' em unidade NÃO piloto (chamada direta): 403 ORDER_PILOTO_NAO_HABILITADO, ZERO chamada ao iFood e ao banco", async () => {
  const repo = repoFalso(); const http = httpFalso();
  await assert.rejects(auth.iniciarConexao({ organizacaoId: "org-b", unidadeId: OUTRA, appType: "order", usuarioId: "u", deps: { repo, http } }), naoHabilitado);
  assert.equal(http.chamadas.length, 0, "nenhuma requisição ao iFood");
  assert.deepEqual(repo.estado.chamadas, [], "nenhuma sessão criada");
});

test("concluir OAuth 'order' em unidade NÃO piloto: 403 antes de ler a sessão; nada trocado, nada gravado", async () => {
  const repo = repoFalso(); const http = httpFalso();
  await assert.rejects(auth.concluirAutorizacao({ organizacaoId: "org-b", unidadeId: OUTRA, appType: "order", sessaoId: "sess-1", authorizationCode: "CODE-1", usuarioId: "u", deps: { repo, http } }), naoHabilitado);
  assert.equal(http.chamadas.length, 0);
  assert.deepEqual(repo.estado.chamadas, []);
});

test("sem secrets: 'order' é recusado como app inválido (comportamento de antes), mesmo na unidade piloto", async () => {
  await com(SEM_SECRETS, async () => {
    const repo = repoFalso(); const http = httpFalso();
    await assert.rejects(auth.iniciarConexao({ organizacaoId: "org-a", unidadeId: PILOTO, appType: "order", usuarioId: "u", deps: { repo, http } }),
      (e) => e.codigo === IFOOD_ERROS.IFOOD_APP_TYPE_INVALIDO);
    assert.equal(http.chamadas.length, 0);
  });
});

test("unidade piloto: OAuth 'order' segue normal (userCode com o app de Order) — e isso NÃO liga o Events", async () => {
  const repo = repoFalso(); const http = httpFalso();
  const r = await auth.iniciarConexao({ organizacaoId: "org-a", unidadeId: PILOTO, appType: "order", usuarioId: "u", deps: { repo, http } });
  assert.equal(r.appType, "order");
  assert.equal(http.chamadas.length, 1);
  assert.equal(http.chamadas[0].campos.clientId, "order-prod-id");
  const { eventsEmbutidoHabilitado } = await import("../src/worker-ifood/embedded.js");
  assert.equal(eventsEmbutidoHabilitado(process.env), false, "piloto Order e Events são flags diferentes");
});

test("Analytics e Financial NÃO mudam: continuam liberados em qualquer unidade (inclusive fora do piloto)", async () => {
  for (const appType of ["analytics", "financial"]) {
    const repo = repoFalso(); const http = httpFalso();
    const r = await auth.iniciarConexao({ organizacaoId: "org-b", unidadeId: OUTRA, appType, usuarioId: "u", deps: { repo, http } });
    assert.equal(r.appType, appType);
    assert.equal(http.chamadas[0].campos.clientId, `${appType}-id`);
  }
});

// ---------------------------------------------------------------------------
// Status — o bloco Order só aparece para a unidade piloto (ou com credencial já existente)
// ---------------------------------------------------------------------------
function repoStatus({ credenciais = [] } = {}) {
  const chamadas = [];
  return {
    chamadas,
    async obterConexaoViva() { return { id: "conx-1", status: "ativa", merchant_id: "55c8f464-e65f-4340-b2c7-62d143027040", merchant_nome: "Loja", merchant_razao_social: "Loja LTDA", conectada_em: new Date().toISOString() }; },
    async listarCredenciaisDaConexao() { return credenciais; },
    async obterObservabilidadeOrder(a) { chamadas.push("obs"); return { disponivel: false }; },
    async obterUltimaAutorizacao() { chamadas.push("aut"); return null; },
  };
}
const credFin = { app_type: "financial", status: "ativa", expira_em: new Date(Date.now() + 3e6).toISOString(), atualizado_em: new Date().toISOString() };

test("status: unidade NÃO piloto, com secrets presentes -> `order` null (o painel não oferece nada; não revela o app)", async () => {
  const s = await conn.obterStatus({ organizacaoId: "org-b", unidadeId: OUTRA, deps: { repo: repoStatus({ credenciais: [credFin] }) } });
  assert.equal(s.order, null);
  assert.ok(!JSON.stringify(s).includes("order-prod"), "nenhuma credencial no status");
});

test("status: unidade piloto -> bloco Order 'não conectado' (configurado = true), sem consultar Events", async () => {
  const repo = repoStatus({ credenciais: [credFin] });
  const s = await conn.obterStatus({ organizacaoId: "org-a", unidadeId: PILOTO, deps: { repo } });
  assert.equal(s.order.configurado, true);
  assert.equal(s.order.conectado, false);
  assert.ok(!repo.chamadas.includes("obs"), "sem credencial Order não há leitura de Events");
});

test("status: unidade que SAIU do piloto mas tem credencial Order continua vendo o bloco (para reconectar/desconectar)", async () => {
  const credOrder = { app_type: "order", status: "ativa", expira_em: new Date(Date.now() + 3e6).toISOString(), atualizado_em: new Date().toISOString() };
  const s = await conn.obterStatus({ organizacaoId: "org-b", unidadeId: OUTRA, deps: { repo: repoStatus({ credenciais: [credFin, credOrder] }) } });
  assert.equal(s.order.configurado, false);
  assert.equal(s.order.conectado, true);
});

// ---------------------------------------------------------------------------
// HTTP real (ifoodRouter + requireModulo/requirePermissao + errorHandler reais) — chamada direta à API,
// sem interface. Só os caminhos de RECUSA: nenhum deles chega ao iFood nem ao banco.
// ---------------------------------------------------------------------------
const express = (await import("express")).default;
const httpNode = await import("node:http");
const { ifoodRouter } = await import("../src/modules/ifood/ifood.routes.js");
const { requireModulo } = await import("../src/middlewares/auth.js");
const { errorHandler } = await import("../src/middlewares/errorHandler.js");
const { MODULOS } = await import("../src/shared/modulos.js");
const { permissoesDoPapel } = await import("../src/shared/permissoes.js");

// Espelha a cadeia de produção: o tenant vem do CONTEXTO (req.tenant), nunca do corpo.
function appHttp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", (req, _res, next) => {
    req.user = { id: String(req.headers["x-teste-user"]) };
    const papel = String(req.headers["x-teste-papel"]);
    req.acesso = { papel, permissoes: permissoesDoPapel(papel), modulos: [MODULOS.IFOOD], impersonando: false };
    req.tenant = { organizacaoId: "org-x", unidadeId: String(req.headers["x-teste-unidade"]) };
    next();
  }, requireModulo(MODULOS.IFOOD), ifoodRouter);
  app.use(errorHandler);
  return app;
}
function post(server, url, corpo, headers) {
  return new Promise((resolve, reject) => {
    const req = httpNode.request({ host: "127.0.0.1", port: server.address().port, method: "POST", path: url, headers: { "content-type": "application/json", ...headers } }, (res) => {
      let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(b || "null") }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(corpo));
  });
}

test("HTTP: chamadas DIRETAS a /oauth/start e /oauth/complete com appType 'order' fora do piloto são recusadas no backend", async (t) => {
  const server = httpNode.createServer(appHttp());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const fetchOriginal = globalThis.fetch;
  let saidas = 0;
  globalThis.fetch = async () => { saidas += 1; throw new Error("nenhuma chamada ao iFood é permitida aqui"); };
  t.after(() => { globalThis.fetch = fetchOriginal; });
  const h = (papel, unidade) => ({ "x-teste-user": `u-${papel}`, "x-teste-papel": papel, "x-teste-unidade": unidade });

  // 1. sem `integracoes.gerenciar` (viewer/operations/finance): 403 de permissão, mesmo na unidade piloto
  for (const papel of ["viewer", "operations", "finance"]) {
    const r = await post(server, "/api/v1/oauth/start", { appType: "order" }, h(papel, PILOTO));
    assert.equal(r.status, 403, papel);
    assert.notEqual(r.json?.codigo, IFOOD_ERROS.IFOOD_ORDER_PILOTO_NAO_HABILITADO, `${papel}: barrado antes, pela permissão`);
  }
  // 2. com permissão, mas a unidade do CONTEXTO não está no piloto: 403 ORDER_PILOTO_NAO_HABILITADO
  for (const papel of ["unit_manager", "organization_admin"]) {
    const r = await post(server, "/api/v1/oauth/start", { appType: "order" }, h(papel, OUTRA));
    assert.equal(r.status, 403, papel);
    assert.equal(r.json?.codigo, IFOOD_ERROS.IFOOD_ORDER_PILOTO_NAO_HABILITADO, papel);
  }
  // 3. tentativa cross-tenant: mandar a unidade piloto no CORPO não muda nada — vale a do contexto
  const cross = await post(server, "/api/v1/oauth/start", { appType: "order", unidadeId: PILOTO, organizacaoId: "org-a" }, h("organization_admin", OUTRA));
  assert.equal(cross.status, 403);
  assert.equal(cross.json?.codigo, IFOOD_ERROS.IFOOD_ORDER_PILOTO_NAO_HABILITADO);
  // 4. conclusão direta também é recusada (sem ler sessão, sem trocar código)
  const fim = await post(server, "/api/v1/oauth/complete",
    { appType: "order", sessionId: "00000000-0000-4000-8000-0000000000c3", authorizationCode: "CODE-1234" }, h("unit_manager", OUTRA));
  assert.equal(fim.status, 403);
  assert.equal(fim.json?.codigo, IFOOD_ERROS.IFOOD_ORDER_PILOTO_NAO_HABILITADO);
  // nunca 500, nunca uma requisição ao iFood
  assert.equal(saidas, 0);
});
