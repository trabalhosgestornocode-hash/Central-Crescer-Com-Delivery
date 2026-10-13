// OAuth da loja adicional (Saladas) PELA INTERFACE — o que o backend entrega à tela e aceita dela. Sem rede, sem banco, iFood simulado.
//
// Prova: o /status lista as lojas adicionais SEM segredo e sem o merchant inteiro (e some quando não há lojas); o início do OAuth aceita
// `lojaId` (da lista) e prende a sessão àquela loja; loja de outra unidade / ids em conflito / app errado são recusados antes de chamar o iFood;
// só `integracoes.gerenciar` consegue iniciar; concluir a autorização não muda o estado da loja (não liga o polling).
import test from "node:test";
import assert from "node:assert/strict";

const UNIDADE = "00000000-0000-4000-8000-0000000000a1";
const OUTRA_UNIDADE = "00000000-0000-4000-8000-0000000000b2";
const ORG = "00000000-0000-4000-8000-0000000000f1";
const LOJA_ID = "22222222-2222-4222-8222-2222222222a1";
const LOJA_OUTRA = "22222222-2222-4222-8222-2222222222b1";
const M_SAND = "a6e54f00-1111-4111-8111-0000000039b9";
const SALADAS = "04a17bf5-b9e6-4693-a862-a5715e9f9374";

process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_HOMOLOGATION_MODE = "false";
process.env.IFOOD_CENTRALIZED_TEST_MODE = "false";
process.env.IFOOD_ORDER_CLIENT_ID = "order-prod-id";
process.env.IFOOD_ORDER_CLIENT_SECRET = "order-prod-secret";
process.env.IFOOD_ORDER_PILOT_UNITS = UNIDADE;

const conn = await import("../src/modules/ifood/ifoodConnection.service.js");
const auth = await import("../src/modules/ifood/ifoodAuth.service.js");
const tokenReal = await import("../src/modules/ifood/ifoodToken.service.js");
const { validarLojaId } = await import("../src/modules/ifood/ifood.validators.js");
const { cifrar } = await import("../src/shared/cripto.js");
const ERRO = (codigo) => (e) => e?.codigo === codigo;
const daquiA = (ms) => new Date(Date.now() + ms).toISOString();

// ---------------------------------------------------------------------------
// /status: lojas adicionais para o painel
// ---------------------------------------------------------------------------
function repoStatus({ lojas, lojasFalha = false, semFuncao = false } = {}) {
  const base = {
    async obterConexaoViva() { return { id: "con-1", status: "ativa", merchant_id: M_SAND, merchant_nome: "Subway Sanduíches", merchant_razao_social: "X LTDA", conectada_em: daquiA(-1e9) }; },
    async listarCredenciaisDaConexao() { return [{ app_type: "order", status: "ativa", expira_em: daquiA(3e6), atualizado_em: daquiA(-1e6) }]; },
    async obterObservabilidadeOrder() { return { disponivel: false }; },
    async obterUltimaAutorizacao() { return null; },
  };
  if (!semFuncao) {
    base.listarLojasAdicionaisDaUnidade = async () => { if (lojasFalha) throw new Error("db fora"); return lojas ?? []; };
  }
  return base;
}
const linhaSaladas = (extra = {}) => ({ id: LOJA_ID, merchant_id: SALADAS, rotulo: "Saladas", estado: "pendente", credencial_status: null, ...extra });

test("status: lista as lojas adicionais SEM segredo e sem o merchant inteiro", async () => {
  const s = await conn.obterStatus({ organizacaoId: ORG, unidadeId: UNIDADE, deps: { repo: repoStatus({ lojas: [linhaSaladas()] }) } });
  assert.deepEqual(s.lojasAdicionais, [{ id: LOJA_ID, rotulo: "Saladas", idMascarado: s.lojasAdicionais[0].idMascarado, estado: "pendente", credencial: null }]);
  assert.match(s.lojasAdicionais[0].idMascarado, /\*|…/);
  const texto = JSON.stringify(s);
  assert.ok(!texto.includes(SALADAS), "o merchant da Saladas nunca vai inteiro para a tela");
  assert.ok(!/access_token|refresh_token|verifier|secret/i.test(JSON.stringify(s.lojasAdicionais)));
});

test("status: reflete a credencial própria (`ativa` / `reauth_required`) e o estado do polling", async () => {
  const s = await conn.obterStatus({ organizacaoId: ORG, unidadeId: UNIDADE, deps: { repo: repoStatus({ lojas: [linhaSaladas({ estado: "ativa", credencial_status: "ativa" }), linhaSaladas({ id: LOJA_OUTRA, rotulo: null, estado: "bloqueada", credencial_status: "reauth_required" })] }) } });
  assert.deepEqual(s.lojasAdicionais.map((l) => [l.estado, l.credencial]), [["ativa", "ativa"], ["bloqueada", "reauth_required"]]);
});

test("status: sem lojas, com erro ao ler ou sem a função (versão anterior): a resposta é IDÊNTICA à de antes (sem a chave) e nunca falha", async () => {
  for (const cenario of [{ lojas: [] }, { lojasFalha: true }, { semFuncao: true }]) {
    const s = await conn.obterStatus({ organizacaoId: ORG, unidadeId: UNIDADE, deps: { repo: repoStatus(cenario) } });
    assert.ok(!("lojasAdicionais" in s), JSON.stringify(cenario));
    assert.equal(s.order.conectado, true);
  }
});

test("status: unidade fora do piloto e sem credencial (`order` null) não lista lojas", async () => {
  const repo = { ...repoStatus({ lojas: [linhaSaladas()] }), async listarCredenciaisDaConexao() { return []; } };
  const s = await conn.obterStatus({ organizacaoId: ORG, unidadeId: OUTRA_UNIDADE, deps: { repo } });
  assert.equal(s.order, null);
  assert.ok(!("lojasAdicionais" in s));
});

// ---------------------------------------------------------------------------
// Início do OAuth escolhendo a loja pelo `lojaId`
// ---------------------------------------------------------------------------
function amb({ lojaDe = UNIDADE } = {}) {
  const e = { sessao: null, posts: 0, chamadas: [], loja: { id: LOJA_ID, conexao_id: "con-1", organizacao_id: ORG, unidade_id: UNIDADE, merchant_id: SALADAS, estado: "pendente" } };
  const chama = (nome) => e.chamadas.push(nome);
  const repo = {
    async expirarSessoesVencidas() {},
    async obterLojaAdicionalDaUnidade({ unidadeId, lojaId, merchantId }) {
      chama("obterLoja");
      const bate = (lojaId && lojaId === LOJA_ID) || (merchantId && merchantId.toLowerCase() === SALADAS);
      return bate && unidadeId === lojaDe ? e.loja : null;
    },
    async criarSessaoOAuth(d) { e.sessao = { id: "sess-1", status: "pending", unidade_id: d.unidadeId, organizacao_id: d.organizacaoId, app_type: d.appType, loja_id: d.lojaId ?? null, authorization_code_verifier_cifrado: d.verifierCifrado, expira_em: d.expiraEm }; return e.sessao; },
    async obterSessaoOAuth() { return e.sessao; },
    async reivindicarSessaoOAuth() { return true; },
    async fecharSessaoOAuth({ status }) { chama(`fechar:${status}`); e.sessao.status = status; },
    async obterConexaoViva() { return { id: "con-1", organizacao_id: ORG, unidade_id: UNIDADE, status: "ativa", merchant_id: M_SAND }; },
    async obterOuCriarConexao() { chama("OBTER_OU_CRIAR_CONEXAO"); return { id: "con-1", status: "ativa" }; },
    async obterCredencial() { return null; },
    async listarLojasExtrasVivasDaConexao() { return []; },
    async atualizarCredencial() { chama("ATUALIZAR_CREDENCIAL"); return { ok: true }; },
    async marcarLojaAtiva() { chama("MARCAR_LOJA_ATIVA"); return true; },
    async bloquearLoja() { chama("BLOQUEAR_LOJA"); return true; },
    async iniciarVerificacaoLoja() { chama("INICIAR_VERIFICACAO"); return "ok"; },
  };
  const http = { async postForm() { e.posts += 1; return { userCode: "SIMU-LADO", authorizationCodeVerifier: "v", verificationUrl: "u", verificationUrlComplete: "uc", expiresIn: 600 }; } };
  const salvos = [];
  const token = { ...tokenReal, async trocarAuthorizationCodePorToken() { return { accessToken: tokenJwt([SALADAS]), refreshToken: "RT", expiraEm: daquiA(6 * 3.6e6) }; }, async salvarTokens(a) { salvos.push({ lojaId: a.lojaId ?? null }); } };
  e.salvos = salvos;
  return { e, deps: { repo, http, token } };
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const tokenJwt = (ids) => `${b64({ alg: "RS256" })}.${b64({ merchant_scope: ids.flatMap((i) => [`${i}:order`, `${i}:events`]), exp: Math.floor((Date.now() + 6 * 3.6e6) / 1000) })}.assinatura-falsa`;
const iniciar = (a, extra = {}, unidadeId = UNIDADE) => auth.iniciarConexao({ organizacaoId: ORG, unidadeId, appType: "order", usuarioId: "u", deps: a.deps, ...extra });

test("início com `lojaId` da lista: a sessão fica presa àquela loja; o iFood só é chamado depois de validar a loja", async () => {
  const a = amb();
  const r = await iniciar(a, { lojaId: LOJA_ID });
  assert.equal(a.e.sessao.loja_id, LOJA_ID);
  assert.equal(r.userCode, "SIMU-LADO");
  assert.deepEqual(a.e.chamadas.slice(0, 1), ["obterLoja"]);
  assert.ok(!JSON.stringify(r).includes("verifier"));
});

test("sem `lojaId`/`merchantId`: fluxo da conexão, idêntico ao de antes (sessão sem loja)", async () => {
  const a = amb();
  await iniciar(a);
  assert.equal(a.e.sessao.loja_id, null);
  assert.ok(!a.e.chamadas.includes("obterLoja"));
});

test("loja de OUTRA unidade, inexistente, ou `lojaId`+`merchantId` juntos: recusado ANTES de chamar o iFood", async () => {
  const a = amb({ lojaDe: OUTRA_UNIDADE });
  await assert.rejects(iniciar(a, { lojaId: LOJA_ID }), ERRO("IFOOD_LOJA_NAO_ENCONTRADA"));
  await assert.rejects(iniciar(a, { lojaId: LOJA_OUTRA }), ERRO("IFOOD_LOJA_NAO_ENCONTRADA"));
  const b = amb();
  await assert.rejects(iniciar(b, { lojaId: LOJA_ID, merchantId: SALADAS }), ERRO("IFOOD_LOJA_OAUTH_INVALIDO"));
  assert.equal(a.e.posts + b.e.posts, 0);
  assert.equal(a.e.sessao, null);
});

test("`lojaId` só vale para o app Order", async () => {
  const a = amb();
  await assert.rejects(auth.iniciarConexao({ organizacaoId: ORG, unidadeId: UNIDADE, appType: "financial", usuarioId: "u", lojaId: LOJA_ID, deps: a.deps }), (e) => ["IFOOD_LOJA_OAUTH_INVALIDO", "IFOOD_APP_TYPE_INVALIDO", "IFOOD_APP_SEM_CREDENCIAL"].includes(e?.codigo));
  assert.equal(a.e.posts, 0);
});

test("validador: `lojaId` precisa ser um uuid (nada digitado livremente)", () => {
  assert.equal(validarLojaId(LOJA_ID), LOJA_ID);
  for (const ruim of ["", "saladas", "04a17bf5", "<script>", 123, null]) assert.throws(() => validarLojaId(ruim), `valor: ${String(ruim)}`);
});

// ---------------------------------------------------------------------------
// Concluir NÃO liga o polling
// ---------------------------------------------------------------------------
test("concluir a autorização grava só a credencial da loja e NÃO altera o estado da loja (nenhuma ativação, bloqueio ou verificação)", async () => {
  const a = amb();
  const ini = await iniciar(a, { lojaId: LOJA_ID });
  await auth.concluirAutorizacao({ organizacaoId: ORG, unidadeId: UNIDADE, appType: "order", sessaoId: ini.sessionId, authorizationCode: "codigo-do-portal", usuarioId: "u", deps: a.deps });
  assert.deepEqual(a.e.salvos, [{ lojaId: LOJA_ID }]);
  assert.equal(a.e.loja.estado, "pendente");
  for (const proibida of ["MARCAR_LOJA_ATIVA", "BLOQUEAR_LOJA", "INICIAR_VERIFICACAO", "OBTER_OU_CRIAR_CONEXAO", "ATUALIZAR_CREDENCIAL"]) assert.ok(!a.e.chamadas.includes(proibida), proibida);
});

test("erro de escopo (token só da Sanduíches) na loja-alvo: nenhuma credencial é gravada ou substituída; sessão `failed`", async () => {
  const a = amb();
  a.deps.token.trocarAuthorizationCodePorToken = async () => ({ accessToken: tokenJwt([M_SAND]), refreshToken: "RT", expiraEm: daquiA(6 * 3.6e6) });
  const ini = await iniciar(a, { lojaId: LOJA_ID });
  await assert.rejects(auth.concluirAutorizacao({ organizacaoId: ORG, unidadeId: UNIDADE, appType: "order", sessaoId: ini.sessionId, authorizationCode: "codigo", usuarioId: "u", deps: a.deps }), ERRO("IFOOD_CREDENCIAL_SEM_COBERTURA"));
  assert.equal(a.e.salvos.length, 0);
  assert.ok(!a.e.chamadas.includes("ATUALIZAR_CREDENCIAL"));
  assert.equal(a.e.sessao.status, "failed");
});

test("sessão expirada: recusada sem trocar código (o painel oferece gerar outro)", async () => {
  const a = amb();
  const ini = await iniciar(a, { lojaId: LOJA_ID });
  a.e.sessao.expira_em = daquiA(-1000);
  await assert.rejects(auth.concluirAutorizacao({ organizacaoId: ORG, unidadeId: UNIDADE, appType: "order", sessaoId: ini.sessionId, authorizationCode: "codigo", usuarioId: "u", deps: a.deps }), ERRO("IFOOD_OAUTH_SESSAO_EXPIRADA"));
  assert.equal(a.e.salvos.length, 0);
  assert.equal(a.e.sessao.status, "expired");
});

// ---------------------------------------------------------------------------
// HTTP real: só `integracoes.gerenciar` inicia
// ---------------------------------------------------------------------------
const express = (await import("express")).default;
const httpNode = await import("node:http");
const { ifoodRouter } = await import("../src/modules/ifood/ifood.routes.js");
const { requireModulo } = await import("../src/middlewares/auth.js");
const { errorHandler } = await import("../src/middlewares/errorHandler.js");
const { MODULOS } = await import("../src/shared/modulos.js");
const { permissoesDoPapel } = await import("../src/shared/permissoes.js");

function appHttp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", (req, _res, next) => {
    req.user = { id: String(req.headers["x-teste-user"]) };
    const papel = String(req.headers["x-teste-papel"]);
    req.acesso = { papel, permissoes: permissoesDoPapel(papel), modulos: [MODULOS.IFOOD], impersonando: false };
    req.tenant = { organizacaoId: ORG, unidadeId: String(req.headers["x-teste-unidade"]) };
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

test("HTTP: sem `integracoes.gerenciar` não há como iniciar a autorização de uma loja (403); `lojaId` inválido nunca chega ao serviço (400); nada vai ao iFood", async (t) => {
  const server = httpNode.createServer(appHttp());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const fetchOriginal = globalThis.fetch;
  let saidas = 0;
  globalThis.fetch = async () => { saidas += 1; throw new Error("nenhuma chamada ao iFood é permitida aqui"); };
  t.after(() => { globalThis.fetch = fetchOriginal; });
  const h = (papel, unidade = UNIDADE) => ({ "x-teste-user": `u-${papel}`, "x-teste-papel": papel, "x-teste-unidade": unidade });

  for (const papel of ["viewer", "operations", "finance"]) {
    const r = await post(server, "/api/v1/oauth/start", { appType: "order", lojaId: LOJA_ID }, h(papel));
    assert.equal(r.status, 403, papel);
  }
  for (const ruim of ["saladas", "<script>", "04a17bf5"]) {
    const r = await post(server, "/api/v1/oauth/start", { appType: "order", lojaId: ruim }, h("unit_manager"));
    assert.equal(r.status, 400, ruim);
  }
  // unidade fora do piloto (tenant do contexto): recusado antes de olhar a loja
  const fora = await post(server, "/api/v1/oauth/start", { appType: "order", lojaId: LOJA_ID }, h("unit_manager", OUTRA_UNIDADE));
  assert.equal(fora.status, 403);
  assert.equal(saidas, 0);
});

test("a rota do /status segue com `integracoes.ver` (a lista de lojas não tem segredo) e o início segue com `integracoes.gerenciar`", async () => {
  const { readFileSync } = await import("node:fs");
  const fonte = readFileSync(new URL("../src/modules/ifood/ifood.routes.js", import.meta.url), "utf8");
  assert.match(fonte, /"\/oauth\/start",\s*gerenciar/);
  assert.match(fonte, /"\/status", requirePermissao\(PERMISSOES\.INTEGRACOES_VER\)/);
  assert.ok(cifrar("x"));   // o módulo de cifra carrega (sem token em claro neste arquivo)
});
